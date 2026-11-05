#!/usr/bin/env bash
# =====================================================================
# e2e-er-disposition.sh — გადაუდებელი დახმარება (ER), ეტაპი 3 / 4 (0090): გამოსავალი
#   • პარამეტრები (admit_mode, transfer_orders, require_initial_note / require_diagnosis / verbal_unconfirmed / open_items_check,
#     recommendations_required, ama_proof, doc_window_h, reopen_h, summary_mode, summary_sections) — ვალიდაცია; რეესტრი er → inpatient / ipd_orders;
#   • შემოწმებები: ექიმამდე — DOCTOR_REQUIRED; პირველადი ჩანაწერი / დიაგნოზი (block / warn / off); დაუდასტურებელი ზეპირი; მიმდინარე ინფუზია (warn → დასაბუთება);
#   • გაწერა სახლში: რეკომენდაციები, დანიშნულებები წყდება, ER-ის ფურცელი (ERS…), დაფიდან ქრება, „გასულები“;
#     დოკუმენტაციის ფანჯარა (ICD-10 / ჩანაწერი — კი, დანიშვნა — არა; doc_window_h = 0 → იხურება), ფურცლის განახლება (წინა → revoked);
#   • LWBS (ექიმამდე, ტრიაჟის ექთანი), გადაყვანა (დაწესებულება / მიზეზი), AMA (ხელწერილი ან 2 მოწმე; ama_proof = reason), გარდაცვალება (DOA, is_deceased);
#   • გაუქმება (reopen): ER-ის მენეჯერი, reopen_h, გარდაცვალება — admin, ჰოსპიტალიზაცია — 409;
#   • ჰოსპიტალიზაცია direct: inpatient_stays (source emergency), დანიშნულებების გადატანა (PRN → prn, ინფუზია → continuous, შეწყვეტა), შეტყობინება მკურნალს;
#     transfer_orders = stop_all; სტაციონარში ჰოსპიტალიზაციის გაუქმება → ER-ის შემთხვევა ისევ იხსნება;
#   • ჰოსპიტალიზაცია request: მოთხოვნა → განყოფილების სია → უარი (შეტყობინება) / მიღება (საწოლით, გეგმით); სხვა გამოსავალი — მოთხოვნა უქმდება;
#   • ER-ის ფურცელი: builtin (სექციები) / template (ER_SUMMARY); ფორმა 100 — ER-ის ექიმი;
#   • რბილი: inpatient off → ჰოსპიტალიზაცია 403 / INPATIENT_INACTIVE, სხვა გამოსავალი მუშაობს; ipd_orders off → დანიშნულებები წყდება;
#     er off → ისტორია / ფურცელი ჩანს, ჩაწერა 403, მომიჯნავე არ ვარდება.
# ბოლოს: მიმდინარე შემთხვევები გაუქმებულია, სატესტო ჰოსპიტალიზაციები გაწერილია, მომხმარებლები / როლები / განყოფილებები გათიშულია, მოდულები / პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-er-disposition.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
J='content-type: application/json'
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mშეწყდა:\033[0m %s\n' "$1"; exit 1; }
command -v jq >/dev/null || die "jq არ არის დაყენებული"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ctype() { curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B$1" -H "authorization: Bearer $2"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d)
ago() { date -u -d "-$1" +%FT%TZ; }
setm() { api PUT "/modules/$1" "$ADM" -d "{$2,\"reason\":\"ტესტ-E2E ER disposition\"}"; }
sets() { api PUT /modules/er "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E ER disposition\"}"; }
pid() { printf '%s%010d' "$1" "$(( (10#$S * 7 + $2) % 10000000000 ))"; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0090" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0090" | tostring)')" "ok:true"
MODS=$(api GET /modules "$ADM")
ORIG=$(echo "$MODS" | jq -c '[.[]|{code, enabled}]')
ORIG_ER=$(echo "$MODS" | jq -c '.[]|select(.code=="er")|{enabled, settings}')
[ -n "$ORIG_ER" ] || die "მოდული er ვერ მოიძებნა"
for c in er inpatient ipd_orders; do
  [ "$(echo "$MODS" | jq -r --arg c "$c" '.[]|select(.code==$c)|.state')" = "active" ] || die "მოდული $c არააქტიურია — e2e-ის წინ: ლიცენზიის მოხსნა („DEV — ყველა მოდული“)"
done
REG=$(echo "$MODS" | jq -c '[.[]|{code, dependents}]')
ORDER=$(echo "$MODS" | jq -r '[.[]|select(.core|not)|.code]|join(" ")')
mods() { api GET /modules "$ADM"; }
en()   { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.enabled'; }
closure() {
  local want="$1" prev=""
  while [ "$want" != "$prev" ]; do prev="$want"
    want=$(echo "$REG" | jq -r --arg w "$want" '($w|split(" ")) as $s | [ $s[], (.[]|select(.code as $c|$s|index($c))|.dependents[]) ] | unique | join(" ")')
  done
  local out=""; for c in $ORDER; do [[ " $want " == *" $c "* ]] && out="$c $out"; done; echo "$out"
}
modoff() { local c cl; cl=$(closure "$1"); for _ in 1 2 3 4 5 6; do for c in $cl; do [ "$(en "$c")" = "false" ] || setm "$c" '"enabled":false' >/dev/null; done; done; }
restore_mods() {
  local on c; on=$(echo "$ORIG" | jq -r '.[]|select(.enabled)|.code')
  for _ in 1 2 3 4 5; do for c in $on; do [ "$(en "$c")" = "true" ] || setm "$c" '"enabled":true' >/dev/null; done; done
}
cleanup() {
  restore_mods
  sets "$(echo "$ORIG_ER" | jq -c .settings)" >/dev/null
  # სატესტო ჰოსპიტალიზაციები — გაწერა (თვითნებური, 2 მოწმე: დოკუმენტაციის გარეშე)
  if [ -f "$TMP/stays" ]; then while read -r s; do
    api POST "/inpatient/stays/$s/discharge" "$ADM" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"${TRID:-x}\",\"${DRID:-x}\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
  done < "$TMP/stays"; fi
  if [ -f "$TMP/visits" ]; then while read -r e; do
    for a in $(api GET "/er/visits/$e/orders" "$ADM" | jq -r '.orders[]?.administrations[]|select(.voided_at==null)|.id'); do api POST "/er/administrations/$a/void" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
    api POST "/er/visits/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null
  done < "$TMP/visits"; fi
  [ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
  [ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
  [ -f "$TMP/wards" ] && while read -r w; do api PATCH "/inpatient/wards/$w" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/wards"
  [ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
  rm -rf "$TMP"
}
trap cleanup EXIT
BASE='{"doctor_write":"team","verbal_orders":true,"verbal_confirm_h":4,"prn_max_h":12,"admit_mode":"direct","transfer_orders":"reconcile","require_initial_note":"block","require_diagnosis":"block","verbal_unconfirmed":"block","open_items_check":"warn","recommendations_required":true,"ama_proof":"consent_or_witnesses","doc_window_h":24,"reopen_h":4,"summary_mode":"builtin","summary_sections":["arrival","triage","notes","diagnoses","lab","dx","consults","orders","disposition","recommendations"]}'
sets "$BASE" >/dev/null
dep() { local id; id=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/deps"; echo "$id"; }
DER=$(dep "ER გამოსავალი" E2EDE emergency); DIN=$(dep "სტაც. ER-D" E2EDI inpatient); DOT=$(dep "სხვა სტაც. ER-D" E2EDO inpatient)
[ -n "$DER" ] && [ -n "$DIN" ] && [ -n "$DOT" ] || die "განყოფილებები ვერ შეიქმნა"
WD=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DIN\",\"code\":\"D$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty'); [ -n "$WD" ] && echo "$WD" >> "$TMP/wards"
BED1=$(api POST "/inpatient/wards/$WD/beds" "$ADM" -d '{"count":2}' | jq -r '.[0].id // empty')
[ -n "$BED1" ] || die "პალატა / საწოლი ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_erd_$1_$S\",\"name\":\"ტესტ-E2E ER-D $1\",\"capabilities\":$2}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_erd_$1_$S"; }; }
R_TR=$(mkrole tr '["er_triage"]'); R_DR=$(mkrole dr '["er_doctor"]'); R_MG=$(mkrole mg '["er_manage"]')
[ -n "$R_TR" ] && [ -n "$R_DR" ] && [ -n "$R_MG" ] || die "როლები ვერ შეიქმნა"
mkuser() {   # <roles-json> <n> <department> → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.erd.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ERD-$2\",\"personal_number\":\"$(pid 7 "$2")\",\"roles\":$1,\"department_id\":\"$3\",\"specialty\":\"ტესტი\",\"license_number\":\"ERD$2$S\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.erd.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
read -r TRID TR <<< "$(mkuser "[\"$R_TR\"]" 41 "$DER")"
read -r DRID DR <<< "$(mkuser "[\"$R_DR\"]" 42 "$DER")"
read -r D2ID D2 <<< "$(mkuser "[\"$R_DR\"]" 43 "$DER")"
read -r MGID MG <<< "$(mkuser "[\"$R_MG\"]" 44 "$DER")"
read -r IDID ID <<< "$(mkuser '["doctor"]' 45 "$DIN")"
read -r ODID OD <<< "$(mkuser '["doctor"]' 46 "$DOT")"
[ -n "${TR:-}" ] && [ -n "${DR:-}" ] && [ -n "${D2:-}" ] && [ -n "${MG:-}" ] && [ -n "${ID:-}" ] && [ -n "${OD:-}" ] || die "მომხმარებლები ვერ შეიქმნა"
ok "მომხმარებლები: ER-ის ექთანი, 2 ER-ის ექიმი, ER-ის მენეჯერი, სტაციონარის ექიმი (მიმღები განყოფილება), სხვა განყოფილების ექიმი"

pat() {   # <n> <გვარი> [დაბადება] [სქესი]
  api POST /patients "$ADM" -d "{\"personal_number\":\"$(pid 6 "$1")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ERD-$2\",\"birth_date\":\"${3:-1970-05-05}\",\"gender\":\"${4:-male}\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
keep() { local e; e=$(echo "$1" | jq -r '.encounter_id // empty'); [ -n "$e" ] && echo "$e" >> "$TMP/visits"; echo "$e"; }
visit() {   # <patient> [pickup=1] → encounter_id (ტრიაჟით, ექიმის აყვანით)
  local e; e=$(keep "$(api POST /er/visits "$TR" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E ჩივილი\",\"arrived_at\":\"$(ago '40 min')\"}")")
  [ -n "$e" ] || return
  api POST "/er/visits/$e/triage" "$TR" -d '{"level":3,"vitals":{"systolic_bp":130,"diastolic_bp":80,"heart_rate":88}}' >/dev/null
  [ "${2:-1}" = 1 ] && api POST "/er/visits/$e/pickup" "$DR" >/dev/null
  echo "$e"
}
note() { api POST "/er/visits/$1/notes" "$DR" -d '{"kind":"er_initial","content":{"complaints":"ტესტ-E2E ჩივილი","objective":"ტესტ-E2E სტატუსი","plan":"ტესტ-E2E გეგმა"},"sign":true}' | jq -r .status; }
dx() { code POST "/encounters/$1/diagnoses" "$DR" -d "{\"icd10_code\":\"${2:-I10}\",\"diagnosis_type\":\"${3:-primary}\"}"; }
DISP() { api POST "/er/visits/$1/disposition" "$2" -d "$3"; }
INFO() { api GET "/er/visits/$1/disposition" "${2:-$DR}"; }
O() { api POST "/er/visits/$1/orders" "$DR" -d "$2" | jq -r '.id // empty'; }

step "1. პარამეტრები / რეესტრი"
chk "არასწორი admit_mode / summary_sections / doc_window_h — 400" \
  "$(code PUT /modules/er "$ADM" -d '{"settings":{"admit_mode":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"summary_sections":["nope"]},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"doc_window_h":200},"reason":"ტესტ-E2E"}')" "400:400:400"
chk "რეესტრი: er → inpatient, ipd_orders (რბილი)" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="er")|.soft|(index("inpatient") != null and index("ipd_orders") != null)')" "true"
chk "შაბლონები: ER_SUMMARY (er_summary) / ER_SELF_DISCHARGE (refusal) — გამოქვეყნებულია" \
  "$(api GET "/document-templates?all=true" "$ADM" | jq -r '[.[]|select(.code=="ER_SUMMARY" or .code=="ER_SELF_DISCHARGE")|"\(.code)=\(.kind)/\(.published_version)"]|sort|join(",")')" "ER_SELF_DISCHARGE=refusal/1,ER_SUMMARY=er_summary/1"

step "2. შემოწმებები / გაწერა სახლში"
P1=$(pat 1 ერთი); E1=$(visit "$P1" 0); [ -n "$E1" ] || die "ER-ის შემთხვევა ვერ შეიქმნა"
I=$(INFO "$E1" "$TR")
chk "ექიმამდე: home — DOCTOR_REQUIRED (block, პირველი); LWBS — ტრიაჟის ექთანს შეუძლია; dispose — არა" "$(echo "$I" | jq -r '"\([.checks.home[]|select(.level=="block")|.code][0]):\(.can.lwbs):\(.can.dispose)"')" "DOCTOR_REQUIRED:true:false"
api POST "/er/visits/$E1/pickup" "$DR" >/dev/null
chk "აყვანის შემდეგ: home — INITIAL_NOTE + DIAGNOSIS (block); LWBS — მიუწვდომელია" "$(INFO "$E1" | jq -r '"\([.checks.home[]|select(.level=="block")|.code]|sort|join(",")):\(.can.lwbs)"')" "DIAGNOSIS,INITIAL_NOTE:false"
chk "ტრიაჟის ექთანი — home 403; ექიმი — 409 ER_DISPOSITION_BLOCKED" "$(code POST "/er/visits/$E1/disposition" "$TR" -d '{"kind":"home"}'):$(DISP "$E1" "$DR" '{"kind":"home","recommendations":"ტესტ"}' | jq -r .code)" "403:ER_DISPOSITION_BLOCKED"
chk "პირველადი გასინჯვა ხელმოწერილია; ძირითადი დიაგნოზი — 201" "$(note "$E1"):$(dx "$E1")" "signed:201"
OV=$(api POST "/er/visits/$E1/orders" "$TR" -d "{\"kind\":\"procedure\",\"order_type\":\"stat\",\"text\":\"ტესტ-E2E ეკგ\",\"verbal_doctor_id\":\"$DRID\"}" | jq -r '.id // empty')
chk "დაუდასტურებელი ზეპირი — block (VERBAL_UNCONFIRMED)" "$(INFO "$E1" | jq -r '[.checks.home[]|select(.level=="block")|.code]|join(",")')" "VERBAL_UNCONFIRMED"
api POST "/er/orders/$OV/confirm" "$DR" >/dev/null
ONS=$(O "$E1" '{"kind":"infusion","order_type":"once","drug_text":"ტესტ-E2E NaCl 0.9% 500 მლ","volume_ml":500,"rate_ml_h":125,"route_code":"IV"}')
chk "ინფუზიის დაწყება — 201" "$(code POST "/er/orders/$ONS/administer" "$TR" -d '{"outcome":"given","infusion_action":"start","override_reason":"ტესტ-E2E"}')" "201"
I=$(INFO "$E1")
chk "მიმდინარე ინფუზია — warn (INFUSION_RUNNING); დანიშნულებები — info ORDERS_STOP" "$(echo "$I" | jq -r '"\([.checks.home[]|select(.level=="warn")|.code]|join(",")):\([.checks.home[]|select(.level=="info")|.code]|join(","))"')" "INFUSION_RUNNING:ORDERS_STOP"
chk "გაფრთხილება დასაბუთების გარეშე — 409 ER_DISPOSITION_WARNINGS" "$(DISP "$E1" "$DR" '{"kind":"home","recommendations":"ტესტ-E2E რეკ."}' | jq -r .code)" "ER_DISPOSITION_WARNINGS"
chk "რეკომენდაციების გარეშე (recommendations_required) — 400 RECOMMENDATIONS_REQUIRED" "$(DISP "$E1" "$DR" '{"kind":"home","override_reason":"ტესტ-E2E ინფუზია დასრულდა"}' | jq -r .code)" "RECOMMENDATIONS_REQUIRED"
chk "მომავალი გასვლის დრო — 400" "$(code POST "/er/visits/$E1/disposition" "$DR" -d "{\"kind\":\"home\",\"recommendations\":\"ტესტ\",\"override_reason\":\"ტესტ-E2E x\",\"departed_at\":\"$(date -u -d '+2 hours' +%FT%TZ)\"}")" "400"
R=$(DISP "$E1" "$D2" '{"kind":"home","recommendations":"ტესტ-E2E ოჯახის ექიმთან 3 დღეში","override_reason":"ტესტ-E2E ინფუზია დასრულდა","note":"ტესტ-E2E"}')
chk "გაწერა სახლში (team — მეორე ER-ის ექიმი) — 2 დანიშნულება შეწყდა" "$(echo "$R" | jq -r '"\(.disposition):\(.orders.stopped|length)"')" "home:2"
V=$(api GET "/er/visits/$E1" "$DR")
chk "ბარათი: departed / home, ended_at, doc_open, ICD-10 — doc_write, დანიშვნა — write false" "$(echo "$V" | jq -r '"\(.status):\(.disposition):\(.ended_at != null):\(.clinical.doc_open):\(.clinical.doc_write):\(.clinical.write)"')" "departed:home:true:true:true:false"
chk "დაფაზე აღარ არის; „გასულები“ — ჩანს (ფურცელი ERS…)" "$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$E1" '[.items[]|select(.encounter_id==$e)]|length'):$(api GET "/er/departed?department_id=$DER" "$TR" | jq -r --arg e "$E1" '.[]|select(.encounter_id==$e)|"\(.disposition):\(.summary_number|startswith("ERS"))"')" "0:home:true"
chk "დანიშნულებები: ორივე შეწყვეტილია (გამოსავალი)" "$(api GET "/er/visits/$E1/orders" "$DR" | jq -r '[.orders[]|select(.status=="stopped" and (.stop_reason|test("გამოსავალი")))]|length')" "2"
chk "ER-ის ფურცელი: PDF (DR / ტრიაჟი); პროექტი (preview) — PDF" "$(ctype "/er/visits/$E1/summary/pdf" "$DR"):$(ctype "/er/visits/$E1/summary/pdf" "$TR" | cut -d: -f1):$(ctype "/er/visits/$E1/summary/preview" "$DR")" "200:application/pdf:200:200:application/pdf"
chk "ხელმეორედ გამოსავალი — 409 ER_VISIT_CLOSED" "$(DISP "$E1" "$DR" '{"kind":"home","recommendations":"ტესტ"}' | jq -r .code)" "ER_VISIT_CLOSED"
chk "დოკუმენტაციის ფანჯარა: ICD-10 (თანმხლები) — 201; დინამიკა — ხელმოწერით; დანიშვნა — 409" \
  "$(dx "$E1" R07.4 secondary):$(api POST "/er/visits/$E1/notes" "$DR" -d '{"kind":"er_progress","content":{"a":"ტესტ-E2E გვიანი ჩანაწერი"},"sign":true}' | jq -r .status):$(code POST "/er/visits/$E1/orders" "$DR" -d '{"kind":"procedure","order_type":"stat","text":"ტესტ-E2E x"}')" "201:signed:409"
OLD=$(INFO "$E1" | jq -r .disposition.summary_number)
NEW=$(api POST "/er/visits/$E1/summary" "$DR" | jq -r '.number // empty')
chk "ფურცლის განახლება — ახალი ნომერი; წინა → revoked; ტრიაჟის ექთანი — 403" \
  "$([ -n "$NEW" ] && [ "$NEW" != "$OLD" ] && echo new):$(api GET "/documents?encounter_id=$E1&type=er_summary" "$ADM" | jq -r '[.[]|.status]|sort|join(",")'):$(code POST "/er/visits/$E1/summary" "$TR")" "new:issued,revoked:403"
chk "ფორმა 100: ER-ის ექიმი — მონახაზი 200" "$(code GET "/encounters/$E1/form100/draft" "$DR")" "200"

step "3. დოკუმენტაციის ფანჯარა = 0, გაუქმება (reopen)"
sets "$(echo "$BASE" | jq -c '. + {doc_window_h:0, require_initial_note:"off", require_diagnosis:"warn"}')" >/dev/null
P2=$(pat 2 ორი); E2=$(visit "$P2")
chk "require_diagnosis = warn: დიაგნოზის გარეშე — warn (DIAGNOSIS), require_initial_note = off — არ ჩანს" "$(INFO "$E2" | jq -r '[.checks.home[]|.level + "/" + .code]|join(",")')" "warn/DIAGNOSIS"
chk "გაწერა (დასაბუთებით) — 200; doc_window_h = 0 → ICD-10 — 409" "$(code POST "/er/visits/$E2/disposition" "$DR" -d '{"kind":"home","recommendations":"ტესტ-E2E","override_reason":"ტესტ-E2E დიაგნოზი მოგვიანებით"}'):$(dx "$E2")" "200:409"
chk "გაუქმება: ER-ის ექიმი — 403; ტრიაჟის ექთანი — 403" "$(code POST "/er/visits/$E2/reopen" "$DR" -d '{"reason":"ტესტ-E2E შეცდომა"}'):$(code POST "/er/visits/$E2/reopen" "$TR" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "403:403"
chk "გაუქმება — ER-ის მენეჯერი: in_treatment, დაფაზე ბრუნდება, ფურცელი revoked" \
  "$(api POST "/er/visits/$E2/reopen" "$MG" -d '{"reason":"ტესტ-E2E შეცდომით გაწერა"}' | jq -r .status):$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$E2" '[.items[]|select(.encounter_id==$e)]|length'):$(api GET "/documents?encounter_id=$E2&type=er_summary" "$ADM" | jq -r '[.[]|.status]|join(",")')" "in_treatment:1:revoked"
chk "მეორედ გაუქმება — 409; ისტორია (history) — 1" "$(code POST "/er/visits/$E2/reopen" "$MG" -d '{"reason":"ტესტ-E2E"}'):$(INFO "$E2" | jq -r '.history|length')" "409:1"
sets "$(echo "$BASE" | jq -c '. + {reopen_h:0}')" >/dev/null
note "$E2" >/dev/null; dx "$E2" >/dev/null
DISP "$E2" "$DR" '{"kind":"home","recommendations":"ტესტ-E2E"}' >/dev/null
chk "reopen_h = 0 — 409 ER_REOPEN_EXPIRED" "$(api POST "/er/visits/$E2/reopen" "$MG" -d '{"reason":"ტესტ-E2E"}' | jq -r .code)" "ER_REOPEN_EXPIRED"
sets "$BASE" >/dev/null

step "4. LWBS / გადაყვანა / AMA / გარდაცვალება"
P3=$(pat 3 სამი); E3=$(visit "$P3" 0)
chk "LWBS — ტრიაჟის ექთანი, ექიმამდე: 200; ბარათი departed / lwbs" "$(code POST "/er/visits/$E3/disposition" "$TR" -d '{"kind":"lwbs","note":"ტესტ-E2E გამოძახებაზე არ გამოჩნდა"}'):$(api GET "/er/visits/$E3" "$TR" | jq -r '"\(.status):\(.disposition)"')" "200:departed:lwbs"
P4=$(pat 4 ოთხი); E4=$(visit "$P4"); note "$E4" >/dev/null; dx "$E4" I21.4 >/dev/null
chk "LWBS ექიმის შემდეგ — 409 (LWBS_AFTER_DOCTOR)" "$(DISP "$E4" "$DR" '{"kind":"lwbs"}' | jq -r '"\(.code):\([.checks[]|select(.level=="block")|.code]|join(","))"')" "ER_DISPOSITION_BLOCKED:LWBS_AFTER_DOCTOR"
chk "გადაყვანა: მიზეზის გარეშე — 400; დაწესებულების გარეშე — 400" "$(code POST "/er/visits/$E4/disposition" "$DR" -d '{"kind":"transfer","destination_text":"ტესტ-E2E კლინიკა","recommendations":"ტესტ"}'):$(code POST "/er/visits/$E4/disposition" "$DR" -d '{"kind":"transfer","transfer_reason":"ტესტ-E2E PCI","recommendations":"ტესტ"}')" "400:400"
chk "გადაყვანა — 200 (დაწესებულება ტექსტით, სასწრაფო, მიმღები)" "$(DISP "$E4" "$DR" '{"kind":"transfer","destination_text":"ტესტ-E2E კარდიოცენტრი","transfer_reason":"ტესტ-E2E PCI","transport":"ambulance","receiver":"ტესტ-E2E დოქტორი, 555","recommendations":"ტესტ-E2E გადაყვანა"}' | jq -r .disposition):$(INFO "$E4" | jq -r '"\(.disposition.destination_text):\(.disposition.transport)"')" "transfer:ტესტ-E2E კარდიოცენტრი:ambulance"
P5=$(pat 5 ხუთი); E5=$(visit "$P5"); note "$E5" >/dev/null; dx "$E5" >/dev/null
chk "AMA: ხელწერილის ბლანკი (ER_SELF_DISCHARGE) — PDF" "$(ctype "/patients/$P5/consents/ER_SELF_DISCHARGE/form?encounter_id=$E5" "$DR")" "200:application/pdf"
chk "AMA: მტკიცების გარეშე — 400 REFUSAL_REQUIRED; 1 მოწმე — 400" "$(DISP "$E5" "$DR" '{"kind":"ama","recommendations":"ტესტ-E2E"}' | jq -r .code):$(code POST "/er/visits/$E5/disposition" "$DR" -d "{\"kind\":\"ama\",\"recommendations\":\"ტესტ\",\"refusal_witnesses\":[\"$TRID\"]}")" "REFUSAL_REQUIRED:400"
chk "AMA: 2 მოწმე — 200" "$(DISP "$E5" "$DR" "{\"kind\":\"ama\",\"recommendations\":\"ტესტ-E2E საფრთხე აეხსნა\",\"refusal_witnesses\":[\"$TRID\",\"$D2ID\"]}" | jq -r .disposition)" "ama"
sets "$(echo "$BASE" | jq -c '. + {ama_proof:"reason", recommendations_required:false}')" >/dev/null
P6=$(pat 6 ექვსი); E6=$(visit "$P6"); note "$E6" >/dev/null; dx "$E6" >/dev/null
chk "ama_proof = reason: მიზეზის გარეშე — 400 AMA_REASON_REQUIRED; მიზეზით (რეკომენდაციის გარეშე) — 200" "$(DISP "$E6" "$DR" '{"kind":"ama"}' | jq -r .code):$(DISP "$E6" "$DR" '{"kind":"ama","ama_reason":"ტესტ-E2E პირადი მიზეზი"}' | jq -r .disposition)" "AMA_REASON_REQUIRED:ama"
sets "$BASE" >/dev/null
P7=$(pat 7 შვიდი); E7=$(visit "$P7" 0)
chk "გარდაცვალება ექიმამდე: ჩანაწერი / დიაგნოზი — warn (არა block)" "$(INFO "$E7" | jq -r '[.checks.death[]|.level + "/" + .code]|sort|join(",")')" "warn/DIAGNOSIS,warn/INITIAL_NOTE"
chk "გარდაცვალება: მიზეზის / აუტოფსიის გარეშე — 400" "$(code POST "/er/visits/$E7/disposition" "$DR" -d "{\"kind\":\"death\",\"death_at\":\"$(ago '50 min')\",\"override_reason\":\"ტესტ-E2E DOA\"}")" "400"
chk "გარდაცვალება (DOA, შემოსვლამდე) — 200; patients.is_deceased" "$(DISP "$E7" "$DR" "{\"kind\":\"death\",\"death_at\":\"$(ago '50 min')\",\"death_icd10_code\":\"R99\",\"autopsy_required\":true,\"dead_on_arrival\":true,\"override_reason\":\"ტესტ-E2E შემოყვანილია გარდაცვლილი\"}" | jq -r .disposition):$(api GET "/patients/$P7" "$ADM" | jq -r .is_deceased)" "death:true"
chk "გარდაცვალების გაუქმება: ER-ის მენეჯერი — 403; admin — 200, is_deceased false" "$(code POST "/er/visits/$E7/reopen" "$MG" -d '{"reason":"ტესტ-E2E შეცდომა"}'):$(code POST "/er/visits/$E7/reopen" "$ADM" -d '{"reason":"ტესტ-E2E შეცდომა"}'):$(api GET "/patients/$P7" "$ADM" | jq -r .is_deceased)" "403:200:false"

step "5. ჰოსპიტალიზაცია (direct) + დანიშნულებების გადატანა"
P8=$(pat 8 რვა); E8=$(visit "$P8"); note "$E8" >/dev/null; dx "$E8" J18.9 >/dev/null
OPRN=$(O "$E8" '{"kind":"medication","order_type":"prn","drug_text":"ტესტ-E2E პარაცეტამოლი 500 მგ","dose":500,"dose_unit":"mg","route_code":"PO","prn_reason":"ტემპ. > 38.5","prn_min_interval_h":6,"prn_max_doses":4}')
OINF=$(O "$E8" '{"kind":"infusion","order_type":"once","drug_text":"ტესტ-E2E რინგერი 1000 მლ","volume_ml":1000,"rate_ml_h":100,"route_code":"IV"}')
OPR=$(O "$E8" '{"kind":"procedure","order_type":"once","text":"ტესტ-E2E შარდის ბუშტის კათეტერი"}')
api POST "/er/orders/$OINF/administer" "$TR" -d '{"outcome":"given","infusion_action":"start","override_reason":"ტესტ-E2E"}' >/dev/null
I=$(INFO "$E8")
chk "ჰოსპიტალიზაცია: info ORDERS_RECONCILE; 3 დანიშნულება, ნაგულისხმევი — გაგრძელება; ინფუზია — running" "$(echo "$I" | jq -r '"\([.checks.admitted[]|.code]|join(",")):\(.orders|length):\([.orders[]|.default]|unique|join(",")):\([.orders[]|select(.running)]|length)"')" "ORDERS_RECONCILE:3:continue:1"
chk "admit-request (direct რეჟიმში) — 400 ER_ADMIT_DIRECT_MODE; მკურნალის გარეშე — 400" "$(api POST "/er/visits/$E8/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"icd10_code\":\"J18.9\"}" | jq -r .code):$(code POST "/er/visits/$E8/disposition" "$DR" -d "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"icd10_code\":\"J18.9\"}}")" "ER_ADMIT_DIRECT_MODE:400"
chk "ფორმის მონაცემები: სტაციონარის განყოფილება + ექიმი" "$(api GET /er/admit/options "$DR" | jq -r --arg d "$DIN" --arg u "$IDID" '.departments[]|select(.id==$d)|[.doctors[]|select(.id==$u)]|length')" "1"
R=$(DISP "$E8" "$DR" "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"J18.9\",\"severity\":\"moderate\"},\"orders_plan\":{\"$OPRN\":\"continue\",\"$OINF\":\"continue\",\"$OPR\":\"stop\"}}")
IP8=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP8" ] && echo "$IP8" >> "$TMP/stays"
chk "ჰოსპიტალიზაცია — IP…; გაგრძელდა 2, შეწყდა 1" "$(echo "$R" | jq -r '"\(.disposition):\(.adm_no|startswith("IP")):\(.orders.continued|length):\(.orders.stopped|length)"')" "admitted:true:2:1"
ST=$(api GET "/inpatient/stays?patient_id=$P8" "$ADM")
chk "სტაციონარი: source emergency, განყოფილება, active" "$(echo "$ST" | jq -r --arg e "$IP8" '.[]|select(.encounter_id==$e)|"\(.source):\(.status):\(.department_name|test("ER-D"))"')" "emergency:active:true"
MO=$(api GET "/inpatient/stays/$IP8/orders" "$ADM")
chk "med_orders: PRN → prn (ინტერვალი 6, მაქს. 4), ინფუზია → continuous (100 მლ/სთ), er_order_id" \
  "$(echo "$MO" | jq -r --arg a "$OPRN" --arg b "$OINF" '[.orders[]|select(.er_order_id==$a)|"\(.order_type)/\(.prn_min_interval_h|tonumber|floor)/\(.prn_max_per_day)"][0] + ":" + ([.orders[]|select(.er_order_id==$b)|"\(.order_type)/\(.rate_ml_h|tonumber|floor)"][0])')" "prn/6/4:continuous/100"
chk "ER-ის დანიშნულებები: 2 — „გადატანილია“, 1 — „შეწყდა“" "$(api GET "/er/visits/$E8/orders" "$DR" | jq -r '"\([.orders[]|select(.stop_reason|test("გადატანილია"))]|length):\([.orders[]|select(.stop_reason|test("შეწყდა"))]|length)"')" "2:1"
chk "დიაგნოზი ჰოსპიტალიზაციისას (J18.9) — სტაციონარის შემთხვევაში" "$(api GET "/encounters/$IP8" "$ADM" | jq -r '[.diagnoses[]?|select(.diagnosis_type=="admission")|.icd10_code]|join(",")')" "J18.9"
chk "მკურნალ ექიმს — შეტყობინება er_admitted (urgent)" "$(api GET /notifications "$ID" | jq -r --arg e "$IP8" '[.[]|select(.kind=="er_admitted" and (.link|contains($e)))][0].urgent')" "true"
chk "ჰოსპიტალიზაციის გაუქმება ER-იდან — 409 ER_REOPEN_ADMITTED" "$(api POST "/er/visits/$E8/reopen" "$MG" -d '{"reason":"ტესტ-E2E"}' | jq -r .code)" "ER_REOPEN_ADMITTED"
chk "ER-ის ფურცელი: გამოსავალი ჰოსპიტალიზაცია — PDF; ბარათზე ბმული (adm_no)" "$(ctype "/er/visits/$E8/summary/pdf" "$DR" | cut -d: -f1):$(INFO "$E8" | jq -r '.disposition.adm_no|startswith("IP")')" "200:true"
# stop_all + სტაციონარში გაუქმება → ER-ის შემთხვევა იხსნება
sets "$(echo "$BASE" | jq -c '. + {transfer_orders:"stop_all"}')" >/dev/null
P9=$(pat 9 ცხრა); E9=$(visit "$P9"); note "$E9" >/dev/null; dx "$E9" >/dev/null
O9=$(O "$E9" '{"kind":"procedure","order_type":"once","text":"ტესტ-E2E პროცედურა"}')
chk "stop_all: info ORDERS_STOP" "$(INFO "$E9" | jq -r '[.checks.admitted[]|.code]|join(",")')" "ORDERS_STOP"
R=$(DISP "$E9" "$DR" "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"I10\"}}")
IP9=$(echo "$R" | jq -r '.inpatient_encounter_id // empty')
chk "stop_all: გაგრძელება 0, შეწყვეტა 1; med_orders — 0" "$(echo "$R" | jq -r '"\(.orders.continued|length):\(.orders.stopped|length)"'):$(api GET "/inpatient/stays/$IP9/orders" "$ADM" | jq -r '.orders|length')" "0:1:0"
chk "სტაციონარში ჰოსპიტალიზაციის გაუქმება → ER-ის შემთხვევა ისევ ღიაა (in_treatment, დაფაზე)" \
  "$(code POST "/inpatient/stays/$IP9/cancel" "$ADM" -d '{"reason":"ტესტ-E2E შეცდომით"}'):$(api GET "/er/visits/$E9" "$DR" | jq -r '"\(.status):\(.disposition)"'):$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$E9" '[.items[]|select(.encounter_id==$e)]|length')" "200:in_treatment:null:1"
sets "$BASE" >/dev/null

step "6. ჰოსპიტალიზაცია (request) — მოთხოვნა / უარი / მიღება"
sets "$(echo "$BASE" | jq -c '. + {admit_mode:"request"}')" >/dev/null
P10=$(pat 10 ათი); E10=$(visit "$P10"); note "$E10" >/dev/null; dx "$E10" J18.9 >/dev/null
O10=$(O "$E10" '{"kind":"medication","order_type":"prn","drug_text":"ტესტ-E2E იბუპროფენი 400 მგ","dose":400,"dose_unit":"mg","route_code":"PO","prn_reason":"ტკივილი"}')
chk "request რეჟიმი: პირდაპირი ჰოსპიტალიზაცია — 400 ER_ADMIT_REQUEST_MODE; can.request" "$(DISP "$E10" "$DR" "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"J18.9\"}}" | jq -r .code):$(INFO "$E10" | jq -r .can.request)" "ER_ADMIT_REQUEST_MODE:true"
RQ=$(api POST "/er/visits/$E10/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"icd10_code\":\"J18.9\",\"note\":\"ტესტ-E2E პნევმონია\",\"orders_plan\":{\"$O10\":\"continue\"}}" | jq -r '.id // empty')
chk "მოთხოვნა — 201; ხელმეორედ — 409; ბარათზე მოლოდინი „საწოლი“" "$([ -n "$RQ" ] && echo 201):$(api POST "/er/visits/$E10/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"icd10_code\":\"J18.9\"}" | jq -r .code):$(api GET "/er/visits/$E10" "$DR" | jq -r '.waiting_for|index("bed") != null')" "201:ER_ADMIT_REQUEST_EXISTS:true"
chk "განყოფილების სია (სტაციონარის ექიმი) — 1; განყოფილების ექიმებს — შეტყობინება" "$(api GET "/er/admit-requests?department_id=$DIN" "$ID" | jq -r --arg r "$RQ" '[.[]|select(.id==$r)]|length'):$(api GET /notifications "$ID" | jq -r --arg r "$RQ" '[.[]|select(.kind=="er_admit_request")]|length > 0')" "1:true"
chk "სხვა განყოფილების ექიმი — მიღება 403; ER-ის ექიმი — 403" "$(code POST "/er/admit-requests/$RQ/accept" "$OD" -d "{\"attending_doctor_id\":\"$IDID\"}"):$(code POST "/er/admit-requests/$RQ/accept" "$DR" -d "{\"attending_doctor_id\":\"$IDID\"}")" "403:403"
chk "უარი (მიზეზით) — rejected; ER-ის ექიმს — შეტყობინება; მოლოდინი „საწოლი“ მოიხსნა" \
  "$(api POST "/er/admit-requests/$RQ/reject" "$ID" -d '{"reason":"ტესტ-E2E საწოლი არ არის"}' | jq -r .status):$(api GET /notifications "$DR" | jq -r '[.[]|select(.kind=="er_admit_rejected")]|length > 0'):$(api GET "/er/visits/$E10" "$DR" | jq -r '.waiting_for|index("bed") == null')" "rejected:true:true"
RQ2=$(api POST "/er/visits/$E10/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"J18.9\",\"orders_plan\":{\"$O10\":\"continue\"}}" | jq -r '.id // empty')
chk "მიმღებისთვის: ER-ის დანიშნულება — გეგმით (continue)" "$(api GET "/er/admit-requests/$RQ2/orders" "$ID" | jq -r '[.orders[]|.default]|join(",")')" "continue"
R=$(api POST "/er/admit-requests/$RQ2/accept" "$ID" -d "{\"attending_doctor_id\":\"$IDID\",\"bed_id\":\"$BED1\"}")
IP10=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP10" ] && echo "$IP10" >> "$TMP/stays"
chk "მიღება — accepted, საწოლით; დანიშნულება გადატანილია (1)" "$(echo "$R" | jq -r '"\(.status):\(.bed != null):\(.orders.continued|length)"')" "accepted:true:1"
chk "ER: departed / admitted; გამოსავალი — ER-ის ექიმის სახელით (decided_by)" "$(api GET "/er/visits/$E10" "$DR" | jq -r '"\(.status):\(.disposition)"'):$(INFO "$E10" | jq -r '.disposition.decided_by_name|test("ERD-42")')" "departed:admitted:true"
chk "ER-ის ექიმს — შეტყობინება er_admit_accepted" "$(api GET /notifications "$DR" | jq -r '[.[]|select(.kind=="er_admit_accepted")]|length > 0')" "true"
P11=$(pat 11 თერთმეტი); E11=$(visit "$P11"); note "$E11" >/dev/null; dx "$E11" >/dev/null
RQ3=$(api POST "/er/visits/$E11/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"icd10_code\":\"I10\"}" | jq -r '.id // empty')
chk "ღია მოთხოვნისას სხვა გამოსავალი — info ADMIT_REQUEST_OPEN; გაწერა → მოთხოვნა cancelled" \
  "$(INFO "$E11" | jq -r '[.checks.home[]|.code]|join(",")'):$(DISP "$E11" "$DR" '{"kind":"home","recommendations":"ტესტ-E2E"}' | jq -r .disposition):$(api GET "/er/admit-requests?department_id=$DIN&status=cancelled" "$ID" | jq -r --arg r "$RQ3" '[.[]|select(.id==$r)]|length')" "ADMIT_REQUEST_OPEN:home:1"
sets "$BASE" >/dev/null

step "7. ER-ის ფურცელი: template / სექციები"
sets "$(echo "$BASE" | jq -c '. + {summary_mode:"template"}')" >/dev/null
chk "summary_mode = template: განახლება — 200 (ER_SUMMARY), PDF" "$(code POST "/er/visits/$E1/summary" "$DR"):$(ctype "/er/visits/$E1/summary/pdf" "$DR")" "200:200:application/pdf"
chk "შაბლონის preview (ER_SUMMARY) — PDF" "$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' -X POST "$B/document-templates/ER_SUMMARY/preview" -H "authorization: Bearer $ADM" -H "$J" -d '{}')" "200:application/pdf"
sets "$(echo "$BASE" | jq -c '. + {summary_sections:["disposition","recommendations"]}')" >/dev/null
chk "builtin, 2 სექცია — განახლება 200" "$(code POST "/er/visits/$E1/summary" "$DR")" "200"
sets "$BASE" >/dev/null

step "8. რბილი კავშირები / er off"
P12=$(pat 12 თორმეტი); E12=$(visit "$P12"); note "$E12" >/dev/null; dx "$E12" >/dev/null
modoff inpatient
I=$(INFO "$E12")
chk "inpatient off: modules.inpatient false; admitted — INPATIENT_INACTIVE (block); POST — 403" "$(echo "$I" | jq -r '"\(.modules.inpatient):\([.checks.admitted[]|select(.level=="block")|.code]|join(","))"'):$(code POST "/er/visits/$E12/disposition" "$DR" -d "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"I10\"}}")" "false:INPATIENT_INACTIVE:403"
chk "inpatient off: გადაყვანა სხვა კლინიკაში — 200" "$(DISP "$E12" "$DR" '{"kind":"transfer","destination_text":"ტესტ-E2E სხვა","transfer_reason":"ტესტ-E2E სტაციონარის გარეშე","recommendations":"ტესტ-E2E"}' | jq -r .disposition)" "transfer"
restore_mods
P13=$(pat 13 ცამეტი); E13=$(visit "$P13"); note "$E13" >/dev/null; dx "$E13" >/dev/null
O13=$(O "$E13" '{"kind":"procedure","order_type":"once","text":"ტესტ-E2E x"}')
modoff ipd_orders
R=$(DISP "$E13" "$DR" "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"I10\"},\"orders_plan\":{\"$O13\":\"continue\"}}")
IP13=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP13" ] && echo "$IP13" >> "$TMP/stays"
chk "ipd_orders off: ჰოსპიტალიზაცია — 200, დანიშნულება შეწყდა (გეგმის მიუხედავად)" "$(echo "$R" | jq -r '"\(.disposition):\(.orders.continued|length):\(.orders.stopped|length)"')" "admitted:0:1"
restore_mods
setm er '"enabled":false' >/dev/null
chk "er off: ბარათი / გამოსავალი / ფურცელი ჩანს (200); გამოსავალი / reopen / მოთხოვნა — 403" \
  "$(code GET "/er/visits/$E1" "$DR"):$(code GET "/er/visits/$E1/disposition" "$DR"):$(code GET "/er/visits/$E1/summary/pdf" "$DR"):$(code POST "/er/visits/$E9/disposition" "$DR" -d '{"kind":"home","recommendations":"x"}'):$(code POST "/er/visits/$E1/reopen" "$MG" -d '{"reason":"xxx"}'):$(code POST "/er/visits/$E9/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"icd10_code\":\"I10\"}")" "200:200:200:403:403:403"
chk "er off: can.* false; სტაციონარი / ჰოსპიტალიზაცია (ER-იდან) — 200" "$(INFO "$E9" | jq -r '"\(.can.dispose):\(.can.lwbs)"'):$(code GET /inpatient/census "$ADM"):$(code GET "/inpatient/stays/$IP8" "$ADM")" "false:false:200:200"
setm er '"enabled":true' >/dev/null
chk "er ჩართვა — აქტიური" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="er")|.state')" "active"

step "9. დასრულება"
cleanup; trap - EXIT
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")|{enabled, settings}')" "$ORIG_ER"
chk "მოდულები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '[.[]|{code, enabled}]')" "$ORIG"
chk "ER-ის დაფაზე სატესტო შემთხვევა აღარ არის" "$(api GET /er/board "$ADM" | jq -r --arg d "$DER" '[.items[]|select(.department_id==$d)]|length')" "0"
ok "სატესტო ჩანაწერები გაუქმებულია / გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
