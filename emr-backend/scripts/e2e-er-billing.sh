#!/usr/bin/env bash
# =====================================================================
# e2e-er-billing.sh — გადაუდებელი დახმარება (ER), ეტაპი 4 / 5 (0091): ბილინგი, სამუშაო სიები, ER-ის ჯობები
#   • პარამეტრები (fee_mode / fee_at / fee_level_basis / fee_exempt / admit_invoice / admit_fee / invoice_close / unpaid_check /
#     payer_at_registration / reminders / remind_repeat_min / admit_wait_min / doc_close_warn_h / wl_to) — ვალიდაცია; რეესტრი er → worklist;
#   • ტარიფის წესები (er_fee_rules): ვიზიტი / დონე / ზოლი / საათი, განყოფილების წესი ფარავს საერთოს, დუბლი — 409;
#   • ვიზიტის ტარიფი გამოსავლისას + ინვოისის დახურვა; გადახდა სალაროში; გამოსავლის გაუქმება (გადახდილზე ტარიფი რჩება);
#     fee_at = doctor (აყვანისას; ER-ის გაუქმება — ხაზი იშლება); unpaid_check info / warn / off; fee_exempt (LWBS); invoice_close = manual;
#   • ტრიაჟის დონით (last / highest), ხანგრძლივობით (ზოლი + საათი), none;
#   • ჰოსპიტალიზაცია: merge (ხაზები → სტაციონარის ინვოისი; სტაციონარში გაუქმება → ბრუნდება), გადახდილი — ცალკე, ask + admit_fee = exempt,
#     request + ask (მოთხოვნის არჩევანი, მიღება);
#   • გადამხდელი რეგისტრაციისას (optional / required / self_pay);
#   • სამუშაო სიები: er_verbal (ordering / ordering_team), er_stat (nurses / nurses_doctor), er_admit_req, er_doc_open, er_unpaid;
#   • ჯობები: doc_close შეხსენება (ერთხელ), invoice_close = doc_close, reminders off; რბილი: worklist off / er off.
# ბოლოს: მიმდინარე შემთხვევები გაუქმებულია, სატესტო ჰოსპიტალიზაციები გაწერილია, წესები / ტარიფები / გადამხდელი — გათიშული, პარამეტრები — აღდგენილი.
# გამოყენება:  bash scripts/e2e-er-billing.sh [API_URL]
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
setm() { api PUT "/modules/$1" "$ADM" -d "{$2,\"reason\":\"ტესტ-E2E ER billing\"}"; }
sets() { api PUT /modules/er "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E ER billing\"}"; }
pid() { printf '%s%010d' "$1" "$(( (10#$S * 7 + $2) % 10000000000 ))"; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0091" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0091" | tostring)')" "ok:true"
MODS=$(api GET /modules "$ADM")
ORIG=$(echo "$MODS" | jq -c '[.[]|{code, enabled}]')
ORIG_ER=$(echo "$MODS" | jq -c '.[]|select(.code=="er")|{enabled, settings}')
[ -n "$ORIG_ER" ] || die "მოდული er ვერ მოიძებნა"
for c in er inpatient ipd_orders worklist; do
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
DER=$(dep "ER ბილინგი" E2EBE emergency); DIN=$(dep "სტაც. ER-B" E2EBI inpatient); DOT=$(dep "სხვა სტაც. ER-B" E2EBO inpatient)
[ -n "$DER" ] && [ -n "$DIN" ] && [ -n "$DOT" ] || die "განყოფილებები ვერ შეიქმნა"
WD=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DIN\",\"code\":\"B$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty'); [ -n "$WD" ] && echo "$WD" >> "$TMP/wards"
BED1=$(api POST "/inpatient/wards/$WD/beds" "$ADM" -d '{"count":2}' | jq -r '.[0].id // empty')
[ -n "$BED1" ] || die "პალატა / საწოლი ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_erb_$1_$S\",\"name\":\"ტესტ-E2E ER-B $1\",\"capabilities\":$2}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_erb_$1_$S"; }; }
R_TR=$(mkrole tr '["er_triage"]'); R_DR=$(mkrole dr '["er_doctor"]'); R_MG=$(mkrole mg '["er_manage"]')
[ -n "$R_TR" ] && [ -n "$R_DR" ] && [ -n "$R_MG" ] || die "როლები ვერ შეიქმნა"
mkuser() {   # <roles-json> <n> <department> → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.erb.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ERB-$2\",\"personal_number\":\"$(pid 8 "$2")\",\"roles\":$1,\"department_id\":\"$3\",\"specialty\":\"ტესტი\",\"license_number\":\"ERD$2$S\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.erb.$2.$S@test.local" "$tmp")
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
  api POST /patients "$ADM" -d "{\"personal_number\":\"$(pid 5 "$1")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ERB-$2\",\"birth_date\":\"${3:-1970-05-05}\",\"gender\":\"${4:-male}\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
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
BL_ROLE=$(mkrole bl '["billing"]'); [ -n "$BL_ROLE" ] || die "ბილინგის როლი ვერ შეიქმნა"
read -r BLID BL <<< "$(mkuser "[\"$BL_ROLE\"]" 47 "$DER")"
[ -n "${BL:-}" ] || die "ბილინგის მომხმარებელი ვერ შეიქმნა"
BILL() { api GET "/er/visits/$1/billing" "${2:-$DR}"; }
FEE() { BILL "$1" | jq -r '[.lines[]|select(.er_fee_rule_id!=null)|"\(.description|split(" (")[0])x\(.quantity)"]|join(",")'; }
INVST() { BILL "$1" | jq -r '"\(.invoice.finalized_at != null):\(.invoice.total):\(.invoice.due)"'; }
BB=$(echo "$BASE" | jq -c '. + {fee_mode:"visit",fee_at:"departure",fee_level_basis:"last",fee_exempt:["lwbs"],admit_invoice:"merge",admit_fee:"charge",invoice_close:"departure",unpaid_check:"info",payer_at_registration:"optional",reminders:{verbal:true,stat:true,consult:true,admit_wait:true,retriage:true,doc_close:true},remind_repeat_min:0,admit_wait_min:60,doc_close_warn_h:2,wl_to:{er_verbal:"ordering",er_stat:"nurses",er_admit_req:"doctors",er_retriage:"triage",er_doc_open:"attending",er_unpaid:"billing_reception"}}')
sets "$BB" >/dev/null
reg() {   # <patient> [arrived-ago] [extra-json] → encounter_id
  keep "$(api POST /er/visits "$TR" -d "$(jq -nc --arg p "$1" --arg d "$DER" --arg a "$(ago "${2:-40 min}")" --argjson x "${3:-{\}}" '{patient_id:$p,department_id:$d,arrival_mode:"walk_in",chief_complaint:"ტესტ-E2E ჩივილი",arrived_at:$a} + $x')")"; }
ready() { api POST "/er/visits/$1/triage" "$TR" -d "{\"level\":${2:-3},\"vitals\":{\"systolic_bp\":130,\"diastolic_bp\":80,\"heart_rate\":88}}" >/dev/null
  api POST "/er/visits/$1/pickup" "$DR" >/dev/null; note "$1" >/dev/null; dx "$1" >/dev/null; }
HOME='{"kind":"home","recommendations":"ტესტ-E2E რეკომენდაცია"}'

step "1. პარამეტრები / რეესტრი / ტარიფის წესები"
bad400() { code PUT /modules/er "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
chk "არასწორი fee_mode / admit_invoice / unpaid_check=block / remind_repeat_min=5 / wl_to / reminders — 400" \
  "$(bad400 '{"fee_mode":"x"}'):$(bad400 '{"admit_invoice":"always"}'):$(bad400 '{"unpaid_check":"block"}'):$(bad400 '{"remind_repeat_min":5}'):$(bad400 '{"wl_to":{"er_stat":"all"}}'):$(bad400 '{"reminders":{"nope":true}}')" \
  "400:400:400:400:400:400"
chk "რეესტრი: er → worklist (რბილი)" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="er")|.soft|index("worklist") != null')" "true"
chk "ნაგულისხმევი წესი: ვიზიტი → ER-VISIT (სისტემური ტარიფი)" "$(api GET /er/fee-rules "$ADM" | jq -r '[.rules[]|select(.kind=="visit" and .department_id==null and .tariff_code=="ER-VISIT")]|length >= 1')" "true"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"E2EB$1$S\",\"title\":\"ტესტ-E2E ER $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
TV=$(tar V ვიზიტი 50); TL3=$(tar L3 დონე-3 80); TL2=$(tar L2 დონე-2 120); TB1=$(tar B1 ზოლი-1 30); TB2=$(tar B2 ზოლი-2 60); TH=$(tar H საათი 10)
[ -n "$TV" ] && [ -n "$TL3" ] && [ -n "$TB2" ] && [ -n "$TH" ] || die "ტარიფები ვერ შეიქმნა"
rule() { api POST /er/fee-rules "$ADM" -d "$1" | jq -r '.id // .code // .message'; }
RV=$(rule "{\"kind\":\"visit\",\"tariff_id\":\"$TV\",\"department_id\":\"$DER\",\"note\":\"ტესტ-E2E\"}")
RL3=$(rule "{\"kind\":\"level\",\"tariff_id\":\"$TL3\",\"department_id\":\"$DER\",\"scale_code\":\"ESI\",\"level\":3}")
rule "{\"kind\":\"level\",\"tariff_id\":\"$TL2\",\"department_id\":\"$DER\",\"scale_code\":\"ESI\",\"level\":2}" >/dev/null
rule "{\"kind\":\"time_band\",\"tariff_id\":\"$TB1\",\"department_id\":\"$DER\",\"from_min\":0,\"to_min\":120}" >/dev/null
rule "{\"kind\":\"time_band\",\"tariff_id\":\"$TB2\",\"department_id\":\"$DER\",\"from_min\":120}" >/dev/null
rule "{\"kind\":\"time_hour\",\"tariff_id\":\"$TH\",\"department_id\":\"$DER\",\"from_min\":240}" >/dev/null
chk "წესები: განყოფილების (ვიზიტი, 2 დონე, 2 ზოლი, საათი)" "$(api GET /er/fee-rules "$ADM" | jq -r --arg d "$DER" '[.rules[]|select(.department_id==$d and .is_active)]|length')" "6"
chk "დუბლი (აქტიური) — 409; ზოლი to ≤ from — 400; დონე სკალის გარეშე — 400; ER-ის ექიმი — 403" \
  "$(code POST /er/fee-rules "$ADM" -d "{\"kind\":\"visit\",\"tariff_id\":\"$TL2\",\"department_id\":\"$DER\"}"):$(code POST /er/fee-rules "$ADM" -d "{\"kind\":\"time_band\",\"tariff_id\":\"$TB1\",\"from_min\":100,\"to_min\":50}"):$(code POST /er/fee-rules "$ADM" -d "{\"kind\":\"level\",\"tariff_id\":\"$TB1\"}"):$(code POST /er/fee-rules "$DR" -d "{\"kind\":\"visit\",\"tariff_id\":\"$TB1\"}")" \
  "409:400:400:403"

step "2. ვიზიტის ტარიფი — გამოსავლისას, ინვოისის დახურვა, გადახდა"
P1=$(pat 21 ერთი); E1=$(reg "$P1"); [ -n "$E1" ] || die "ER-ის შემთხვევა ვერ შეიქმნა"; ready "$E1"
BI=$(BILL "$E1")
chk "ანგარიში: წინასწარი ტარიფი — განყოფილების წესი (50, ER-VISIT-ის ნაცვლად); ხაზი ჯერ არ არის; ღიაა" \
  "$(echo "$BI" | jq -r '"\(.fee.estimate):\(.fee.lines[0].code|startswith("E2EBV")):\([.lines[]|select(.er_fee_rule_id!=null)]|length):\(.invoice.finalized_at==null)"')" "true:true:0:true"
chk "ანგარიში — ტრიაჟის ექთანი / ბილინგი: 200; სტაციონარის ექიმი — 403" "$(code GET "/er/visits/$E1/billing" "$TR"):$(code GET "/er/visits/$E1/billing" "$BL"):$(code GET "/er/visits/$E1/billing" "$ID")" "200:200:403"
chk "გამოსავალი: info UNPAID_BALANCE არ არის (ნაშთი 0)" "$(INFO "$E1" | jq -r '[.checks.home[]|select(.code=="UNPAID_BALANCE")]|length')" "0"
R=$(DISP "$E1" "$DR" "$HOME")
chk "გაწერა: ტარიფი დაემატა (1), ინვოისი დახურულია" "$(echo "$R" | jq -r '"\(.billing.fee.added):\(.billing.closed)"')" "1:true"
chk "ინვოისი: დახურული / 50 / ნაშთი 50; ხაზი — ტარიფი × 1" "$(INVST "$E1"):$(FEE "$E1")" "true:50.00:50.00:ტესტ-E2E ER ვიზიტიx1"
INV1=$(BILL "$E1" | jq -r .invoice.id)
chk "სალარო: გადახდა დახურულ ER-ის ინვოისზე — paid" "$(api POST "/invoices/$INV1/payments" "$BL" -d '{"amount":50,"method":"cash"}' | jq -r .paid_status)" "paid"
chk "სამუშაო სია er_unpaid: გადახდილი — არ ჩანს" "$(api GET '/worklist/mine?source=er_unpaid' "$BL" | jq -r --arg e "$E1" '[.items[]|select(.key|test($e))]|length')" "0"
chk "ბილინგი: დახურვა ხელმეორედ — 409; გახსნა — ER-ის ექიმი 403" "$(code POST "/er/visits/$E1/billing/close" "$BL"):$(code POST "/er/visits/$E1/billing/open" "$DR" -d '{"reason":"ტესტ-E2E"}')" "409:403"
chk "გამოსავლის გაუქმება გადახდილზე — 200; ინვოისი იხსნება, ტარიფი რჩება (გადახდილია)" \
  "$(code POST "/er/visits/$E1/reopen" "$MG" -d '{"reason":"ტესტ-E2E შეცდომა"}'):$(INVST "$E1"):$(FEE "$E1" | grep -c x1)" "200:false:50.00:0.00:1"
chk "ხელახლა გაწერა — ტარიფი იგივე (დუბლი არ ჩნდება), დახურულია" "$(DISP "$E1" "$DR" "$HOME" | jq -r '"\(.billing.fee.added):\(.billing.closed)"'):$(FEE "$E1")" "0:true:ტესტ-E2E ER ვიზიტიx1"

step "3. ტარიფი ექიმის აყვანისას, გადაუხდელი ნაშთი, გაუქმება"
sets "$(echo "$BB" | jq -c '. + {fee_at:"doctor"}')" >/dev/null
P2=$(pat 22 ორი); E2=$(reg "$P2"); api POST "/er/visits/$E2/triage" "$TR" -d '{"level":3}' >/dev/null
chk "ექიმამდე — ტარიფის ხაზი არ არის" "$(FEE "$E2")" ""
api POST "/er/visits/$E2/pickup" "$DR" >/dev/null
chk "აყვანისას — ტარიფი × 1, ინვოისი ღიაა" "$(FEE "$E2"):$(INVST "$E2")" "ტესტ-E2E ER ვიზიტიx1:false:50.00:50.00"
chk "ER-ის მენეჯერი: გაუქმება (მხოლოდ ტარიფის ხაზით) — 200, ხაზი იშლება" "$(code POST "/er/visits/$E2/cancel" "$MG" -d '{"reason":"ტესტ-E2E შეცდომით რეგისტრაცია"}'):$(BILL "$E2" "$ADM" | jq -r '.lines|length')" "200:0"
P3=$(pat 23 სამი); E3=$(reg "$P3"); ready "$E3"
chk "გამოსავალი: UNPAID_BALANCE — info (50 ₾)" "$(INFO "$E3" | jq -r '[.checks.home[]|select(.code=="UNPAID_BALANCE")|.level + ":" + ((.message|test("50.00"))|tostring)]|join(",")')" "info:true"
sets "$(echo "$BB" | jq -c '. + {fee_at:"doctor",unpaid_check:"warn"}')" >/dev/null
chk "unpaid_check = warn: დასაბუთების გარეშე — 409 ER_DISPOSITION_WARNINGS" "$(DISP "$E3" "$DR" "$HOME" | jq -r .code)" "ER_DISPOSITION_WARNINGS"
chk "დასაბუთებით — 200, ტარიფი არ დუბლირდება" "$(DISP "$E3" "$DR" '{"kind":"home","recommendations":"ტესტ-E2E","override_reason":"ტესტ-E2E გადაიხდის მოგვიანებით"}' | jq -r '"\(.disposition):\(.billing.fee.added)"'):$(FEE "$E3")" "home:0:ტესტ-E2E ER ვიზიტიx1"
chk "სამუშაო სია er_unpaid — ბილინგი ხედავს; ER-ის ექიმი — არა" \
  "$(api GET '/worklist/mine?source=er_unpaid' "$BL" | jq -r --arg e "$E3" '[.items[]|select(.link|test($e))]|length'):$(api GET '/worklist/mine?source=er_unpaid' "$DR" | jq -r --arg e "$E3" '[.items[]|select(.link|test($e))]|length')" "1:0"
sets "$(echo "$BB" | jq -c '. + {fee_at:"doctor",unpaid_check:"off"}')" >/dev/null
P3b=$(pat 24 სამიბ); E3b=$(reg "$P3b"); ready "$E3b"
chk "unpaid_check = off — შემოწმება არ ჩანს" "$(INFO "$E3b" | jq -r '[.checks.home[]|select(.code=="UNPAID_BALANCE")]|length')" "0"
DISP "$E3b" "$DR" "$HOME" >/dev/null

step "4. fee_exempt (LWBS), invoice_close = manual"
sets "$BB" >/dev/null
P4=$(pat 25 ოთხი); E4=$(reg "$P4"); api POST "/er/visits/$E4/triage" "$TR" -d '{"level":4}' >/dev/null
chk "LWBS — ტარიფი არ ერიცხება (fee_exempt), ინვოისი დახურულია (0)" "$(code POST "/er/visits/$E4/disposition" "$TR" -d '{"kind":"lwbs"}'):$(FEE "$E4"):$(INVST "$E4")" "200::true:0.00:0.00"
sets "$(echo "$BB" | jq -c '. + {invoice_close:"manual"}')" >/dev/null
P5=$(pat 26 ხუთი); E5=$(reg "$P5"); ready "$E5"
DISP "$E5" "$DR" "$HOME" >/dev/null
chk "manual: გამოსავლის შემდეგ ღიაა; can.close — ბილინგი true / ექიმი false" "$(INVST "$E5"):$(BILL "$E5" "$BL" | jq -r .can.close):$(BILL "$E5" "$DR" | jq -r .can.close)" "false:50.00:50.00:true:false"
chk "ბილინგი: დახურვა — 200; გახსნა (მიზეზით) — 200; ექიმი — 403" \
  "$(code POST "/er/visits/$E5/billing/close" "$BL"):$(INVST "$E5" | cut -d: -f1):$(code POST "/er/visits/$E5/billing/open" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}'):$(INVST "$E5" | cut -d: -f1):$(code POST "/er/visits/$E5/billing/close" "$DR")" \
  "200:true:200:false:403"

step "5. ტრიაჟის დონით / ხანგრძლივობით"
sets "$(echo "$BB" | jq -c '. + {fee_mode:"level"}')" >/dev/null
P6=$(pat 27 ექვსი); E6=$(reg "$P6"); ready "$E6" 3
api POST "/er/visits/$E6/triage" "$TR" -d '{"level":4}' >/dev/null
chk "level / last: ბოლო დონე 4 — წესი არ არის (შენიშვნით)" "$(BILL "$E6" | jq -r '"\(.fee.lines|length):\(.fee.note|test("ESI-4"))"')" "0:true"
sets "$(echo "$BB" | jq -c '. + {fee_mode:"level",fee_level_basis:"highest"}')" >/dev/null
chk "level / highest: დონე 3 → ტარიფი დონე-3" "$(BILL "$E6" | jq -r '.fee.lines[0].code|startswith("E2EBL3")')" "true"
DISP "$E6" "$DR" "$HOME" >/dev/null
chk "გაწერა — ხაზი დონე-3 (80), დასახელებაში ESI-3" "$(BILL "$E6" | jq -r '[.lines[]|select(.er_fee_rule_id!=null)|"\(.unit_price):\(.description|test("ESI-3"))"]|join(",")')" "80.00:true"
sets "$(echo "$BB" | jq -c '. + {fee_mode:"time"}')" >/dev/null
P7=$(pat 28 შვიდი); E7=$(reg "$P7" '40 min'); ready "$E7"
chk "time: 40 წთ — ზოლი 1 (30)" "$(BILL "$E7" | jq -r '[.fee.lines[]|.code[0:6]]|join(",")')" "E2EBB1"
DISP "$E7" "$DR" "$HOME" >/dev/null
P8=$(pat 29 რვა); E8=$(reg "$P8" '5 hours'); ready "$E8"
DISP "$E8" "$DR" "$HOME" >/dev/null
chk "time: 5 სთ — ზოლი 2 (60) + საათობრივი 240 წთ-დან × 1 (10) = 70" "$(FEE "$E8" | tr ',' '\n' | sort | tr '\n' ','):$(INVST "$E8" | cut -d: -f2)" "ტესტ-E2E ER ზოლი-2x1,ტესტ-E2E ER საათიx1,:70.00"
sets "$(echo "$BB" | jq -c '. + {fee_mode:"none"}')" >/dev/null
P9=$(pat 30 ცხრა); E9=$(reg "$P9"); ready "$E9"
chk "fee_mode = none — ტარიფი არ ერიცხება" "$(DISP "$E9" "$DR" "$HOME" | jq -r .billing.fee.added):$(FEE "$E9")" "0:"

step "6. ჰოსპიტალიზაცია — ინვოისის გაერთიანება"
sets "$BB" >/dev/null
ADMIT() { DISP "$1" "$DR" "{\"kind\":\"admitted\",\"admit\":{\"department_id\":\"$DIN\",\"attending_doctor_id\":\"$IDID\",\"icd10_code\":\"I10\"}${2:-}}"; }
P10=$(pat 31 ათი); E10=$(reg "$P10"); ready "$E10"
chk "ჰოსპიტალიზაცია: info INVOICE_MERGE" "$(INFO "$E10" | jq -r '[.checks.admitted[]|select(.code=="INVOICE_MERGE")]|length')" "1"
R=$(ADMIT "$E10"); IP10=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP10" ] && echo "$IP10" >> "$TMP/stays"
chk "merge: ხაზები გადავიდა (1 — ტარიფი), ER-ის ინვოისი დახურული / 0" "$(echo "$R" | jq -r '"\(.billing.merge.merged):\(.billing.merge.lines)"'):$(INVST "$E10")" "true:1:true:0.00:0.00"
BI=$(BILL "$E10")
chk "ER-ის ანგარიში: merged_into (IP…), ხაზი — „სტაციონარში“" "$(echo "$BI" | jq -r '"\(.invoice.merged_into.adm_no|startswith("IP")):\([.lines[]|select(.moved)]|length):\(.can.open)"')" "true:1:false"
chk "სტაციონარის ინვოისი: ER-ის ტარიფი (50) — ხაზებში" "$(api GET "/invoices/encounter/$IP10" "$ADM" | jq -r '[.lines[]|select(.er_fee_rule_id!=null)|(.unit_price|tonumber) == 50]|join(",")')" "true"
chk "სტაციონარში ჰოსპიტალიზაციის გაუქმება — 200 (გადატანილი ხაზი „გამოყენებად“ არ ითვლება)" "$(code POST "/inpatient/stays/$IP10/cancel" "$ADM" -d '{"reason":"ტესტ-E2E შეცდომით"}')" "200"
chk "ER იხსნება: ხაზი ბრუნდება ER-ის ინვოისში, გამოსავლის ტარიფი იშლება (fee_at = departure), merged_into — არა" \
  "$(api GET "/er/visits/$E10" "$DR" | jq -r .status):$(BILL "$E10" | jq -r '"\(.invoice.merged_into == null):\(.invoice.finalized_at == null):\([.lines[]|select(.er_fee_rule_id!=null)]|length)"')" "in_treatment:true:true:0"
sets "$(echo "$BB" | jq -c '. + {fee_at:"doctor"}')" >/dev/null
P11=$(pat 32 თერთმეტი); E11=$(reg "$P11"); ready "$E11"
INV11=$(BILL "$E11" | jq -r .invoice.id); api POST "/invoices/$INV11/payments" "$BL" -d '{"amount":20,"method":"cash"}' >/dev/null
chk "გადახდილ ER-ის ინვოისზე: info INVOICE_SEPARATE" "$(INFO "$E11" | jq -r '[.checks.admitted[]|.code]|index("INVOICE_SEPARATE") != null')" "true"
R=$(ADMIT "$E11"); IP11=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP11" ] && echo "$IP11" >> "$TMP/stays"
chk "merge შეუძლებელია (paid) — ცალკე, დახურული; ნაშთი 30" "$(echo "$R" | jq -r '"\(.billing.merge.merged):\(.billing.merge.reason)"'):$(INVST "$E11")" "false:paid:true:50.00:30.00"
sets "$(echo "$BB" | jq -c '. + {admit_invoice:"ask",admit_fee:"exempt"}')" >/dev/null
P12=$(pat 33 თორმეტი); E12=$(reg "$P12"); ready "$E12"
R=$(ADMIT "$E12" ',"invoice_merge":false'); IP12=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP12" ] && echo "$IP12" >> "$TMP/stays"
chk "ask + invoice_merge=false — ცალკე; admit_fee = exempt — ტარიფი არ არის" "$(echo "$R" | jq -r '"\(.billing.merge == null):\(.billing.fee.added)"'):$(FEE "$E12"):$(INVST "$E12" | cut -d: -f1)" "true:0::true"
sets "$(echo "$BB" | jq -c '. + {admit_invoice:"ask",admit_mode:"request"}')" >/dev/null
P13=$(pat 34 ცამეტი); E13=$(reg "$P13"); ready "$E13"
RQ=$(api POST "/er/visits/$E13/admit-request" "$DR" -d "{\"department_id\":\"$DIN\",\"icd10_code\":\"I10\",\"invoice_merge\":true}" | jq -r '.id // empty')
chk "request + ask: მოთხოვნის დანიშნულებები — admit_invoice ask, invoice_merge true" "$(api GET "/er/admit-requests/$RQ/orders" "$ID" | jq -r '"\(.admit_invoice):\(.invoice_merge):\(.invoice_mergeable)"')" "ask:true:true"
chk "სამუშაო სია er_admit_req — სტაციონარის ექიმი ხედავს; სხვა განყოფილება — არა" \
  "$(api GET '/worklist/mine?source=er_admit_req' "$ID" | jq -r --arg r "$RQ" '[.items[]|select(.key|test($r))]|length'):$(api GET '/worklist/mine?source=er_admit_req' "$OD" | jq -r --arg r "$RQ" '[.items[]|select(.key|test($r))]|length')" "1:0"
R=$(api POST "/er/admit-requests/$RQ/accept" "$ID" -d "{\"attending_doctor_id\":\"$IDID\"}"); IP13=$(echo "$R" | jq -r '.inpatient_encounter_id // empty'); [ -n "$IP13" ] && echo "$IP13" >> "$TMP/stays"
chk "მიღება — გაერთიანდა (მოთხოვნის არჩევანით), ტარიფი სტაციონარში" "$(echo "$R" | jq -r '"\(.status):\(.billing.merge.merged):\(.billing.merge.lines)"')" "accepted:true:1"
sets "$BB" >/dev/null

step "7. გადამხდელი რეგისტრაციისას"
INS=$(api POST /billing/payers "$ADM" -d "{\"code\":\"E2EERB$S\",\"name\":\"ტესტ-E2E ER დაზღვევა\",\"kind\":\"insurance\",\"default_mode\":\"percent\",\"default_coverage_pct\":50}" | jq -r '.id // empty')
[ -n "$INS" ] || die "გადამხდელი ვერ შეიქმნა"
chk "meta: payers (optional) — სიაშია" "$(api GET /er/meta "$TR" | jq -r --arg i "$INS" '"\(.settings.payer_at_registration):\([.payers[]|select(.id==$i)]|length)"')" "optional:1"
P14=$(pat 35 თოთხმეტი); E14=$(reg "$P14" '40 min' "{\"payer_id\":\"$INS\"}")
chk "რეგისტრაცია გადამხდელით — ინვოისზე insurance_payer" "$(BILL "$E14" | jq -r .invoice.insurance_payer.name)" "ტესტ-E2E ER დაზღვევა"
sets "$(echo "$BB" | jq -c '. + {payer_at_registration:"required"}')" >/dev/null
P15=$(pat 36 თხუთმეტი)
chk "required: გადამხდელის გარეშე — 400 ER_PAYER_REQUIRED; self_pay — 201" \
  "$(api POST /er/visits "$TR" -d "{\"patient_id\":\"$P15\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r .code):$(E15=$(reg "$P15" '10 min' '{"self_pay":true}'); [ -n "$E15" ] && echo 201)" "ER_PAYER_REQUIRED:201"
sets "$BB" >/dev/null

step "8. სამუშაო სიები (ER-ის წყაროები)"
P16=$(pat 37 თექვსმეტი); E16=$(reg "$P16"); ready "$E16"
OV=$(api POST "/er/visits/$E16/orders" "$TR" -d "{\"kind\":\"procedure\",\"order_type\":\"stat\",\"text\":\"ტესტ-E2E ეკგ\",\"verbal_doctor_id\":\"$DRID\"}" | jq -r '.id // empty')
OS=$(O "$E16" '{"kind":"procedure","order_type":"stat","text":"ტესტ-E2E გლუკოზა"}')
has() { api GET "/worklist/mine?source=$1" "$2" | jq -r --arg k "$3" '[.items[]|select(.key|test($k))]|length'; }
chk "er_verbal: დამნიშნავი ექიმი — 1, მეორე ER-ის ექიმი (ordering) — 0" "$(has er_verbal "$DR" "$OV"):$(has er_verbal "$D2" "$OV")" "1:0"
sets "$(echo "$BB" | jq -c '. + {wl_to:{er_verbal:"ordering_team",er_stat:"nurses",er_admit_req:"doctors",er_retriage:"triage",er_doc_open:"attending",er_unpaid:"billing_reception"}}')" >/dev/null
chk "er_verbal = ordering_team — მეორე ექიმიც ხედავს" "$(has er_verbal "$D2" "$OV")" "1"
chk "er_stat: ER-ის ექთანი — ხედავს (2 STAT); ექიმი (nurses) — არა" "$(has er_stat "$TR" "$OS"):$(has er_stat "$DR" "$OS")" "1:0"
sets "$(echo "$BB" | jq -c '. + {wl_to:{er_verbal:"ordering",er_stat:"nurses_doctor",er_admit_req:"doctors",er_retriage:"triage",er_doc_open:"attending",er_unpaid:"billing_reception"}}')" >/dev/null
chk "er_stat = nurses_doctor — მკურნალი ექიმიც ხედავს" "$(has er_stat "$DR" "$OS")" "1"
api POST "/er/orders/$OV/confirm" "$DR" >/dev/null
chk "ზეპირი დადასტურდა — er_verbal-დან ქრება" "$(has er_verbal "$DR" "$OV")" "0"
sets "$(echo "$BB" | jq -c '. + {require_diagnosis:"warn",doc_window_h:1,doc_close_warn_h:2}')" >/dev/null
P17=$(pat 38 ჩვიდმეტი); E17=$(reg "$P17"); api POST "/er/visits/$E17/triage" "$TR" -d '{"level":3}' >/dev/null; api POST "/er/visits/$E17/pickup" "$DR" >/dev/null; note "$E17" >/dev/null
DISP "$E17" "$DR" '{"kind":"home","recommendations":"ტესტ-E2E","override_reason":"ტესტ-E2E დიაგნოზი მოგვიანებით"}' >/dev/null
chk "er_doc_open: გასული, ICD-10 აკლია — მკურნალი ხედავს; სხვა ექიმი (attending) — არა" "$(has er_doc_open "$DR" "$E17"):$(has er_doc_open "$D2" "$E17")" "1:0"
chk "ER-ის წყაროების ჯგუფი — „გადაუდებელი (ER)“" "$(api GET '/worklist/mine?source=er_doc_open' "$DR" | jq -r '[.items[]|select(.source=="er_doc_open")|.group][0]')" "გადაუდებელი (ER)"

step "9. ER-ის ჯობები"
JR=$(api POST /er/jobs/run "$ADM" -d '{}')
chk "ჯობი: enabled; doc_close შეხსენება (ფანჯარა 1 სთ ≤ 2 სთ) — ≥ 1" "$(echo "$JR" | jq -r '"\(.enabled):\((.reminders.doc_close // 0) >= 1)"')" "true:true"
chk "ექიმს — ზარი er_remind_doc (ბმული ბარათზე)" "$(api GET '/notifications?unread=true' "$DR" | jq -r --arg e "$E17" '[.[]|select(.kind=="er_remind_doc" and (.link|test($e)))]|length')" "1"
chk "ხელმეორედ გაშვება — იგივე შეხსენება აღარ იგზავნება (ჟურნალი)" "$(api POST /er/jobs/run "$ADM" -d '{}' | jq -r '.reminders.doc_close // 0')" "0"
chk "ჯობი — მხოლოდ admin (ექიმი 403)" "$(code POST /er/jobs/run "$DR" -d '{}')" "403"
sets "$(echo "$BB" | jq -c '. + {invoice_close:"doc_close",doc_window_h:0}')" >/dev/null
P18=$(pat 39 თვრამეტი); E18=$(reg "$P18"); ready "$E18"
DISP "$E18" "$DR" "$HOME" >/dev/null
chk "doc_close: გამოსავლის შემდეგ ინვოისი ღიაა (ტარიფით)" "$(INVST "$E18")" "false:50.00:50.00"
chk "ჯობი: ფანჯარა დაიხურა (doc_window_h = 0) → ინვოისი დაიხურა" "$(api POST /er/jobs/run "$ADM" -d '{}' | jq -r '.invoices_closed >= 1'):$(INVST "$E18" | cut -d: -f1)" "true:true"
sets "$(echo "$BB" | jq -c '. + {reminders:{verbal:false,stat:false,consult:false,admit_wait:false,retriage:false,doc_close:false}}')" >/dev/null
chk "შეხსენებები გამორთულია — reminders {}" "$(api POST /er/jobs/run "$ADM" -d '{}' | jq -c .reminders)" "{}"
sets "$BB" >/dev/null

step "10. რბილი კავშირები"
modoff worklist
chk "worklist off: ER-ის დაფა / ანგარიში / გამოსავალი — 200" "$(code GET "/er/board?department_id=$DER" "$TR"):$(code GET "/er/visits/$E16/billing" "$DR"):$(code GET "/er/visits/$E16/disposition" "$DR")" "200:200:200"
restore_mods
modoff er
chk "er off: ანგარიში (ისტორია) — 200; დახურვა / წესი / ჯობი — 403; სალარო (ინვოისი) — 200" \
  "$(code GET "/er/visits/$E5/billing" "$BL"):$(code POST "/er/visits/$E5/billing/close" "$BL"):$(code POST /er/fee-rules "$ADM" -d "{\"kind\":\"visit\",\"tariff_id\":\"$TV\"}"):$(code POST /er/jobs/run "$ADM" -d '{}'):$(code GET "/invoices/encounter/$E5" "$BL")" \
  "200:403:403:403:200"
chk "er off: სამუშაო სიაში ER-ის წყაროები არ არის" "$(api GET /worklist/mine "$DR" | jq -r '[.items[]|select(.source|startswith("er_"))]|length')" "0"
restore_mods

step "11. დასრულება"
for r in $(api GET /er/fee-rules "$ADM" | jq -r --arg d "$DER" '.rules[]|select(.department_id==$d)|.id'); do api DELETE "/er/fee-rules/$r" "$ADM" >/dev/null; done
chk "სატესტო წესები — გათიშული / წაშლილი" "$(api GET /er/fee-rules "$ADM" | jq -r --arg d "$DER" '[.rules[]|select(.department_id==$d and .is_active)]|length')" "0"
for t in $TV $TL3 $TL2 $TB1 $TB2 $TH; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/billing/payers/$INS" "$ADM" -d '{"is_active":false}' >/dev/null
cleanup; trap - EXIT
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")|{enabled, settings}')" "$ORIG_ER"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
