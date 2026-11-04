#!/usr/bin/env bash
# =====================================================================
# e2e-er-clinical.sh — გადაუდებელი დახმარება (ER), ეტაპი 2 / 4 (0088): კლინიკური ნაწილი (I)
#   • პარამეტრები (initial_note_min, doctor_write, dx_unpaid_check, dx_default_priority, consult_due_min, consult_billing) — ვალიდაცია;
#     რეესტრი: er → roster / lab / radiology / endoscopy (რბილი);
#   • ჩანაწერი: er_initial (ერთი მოქმედი) / er_progress, შავი ვერსია → ხელმოწერა → შესწორება (ვერსიები), სავალდებულო ველები, ვადა აყვანიდან,
#     doctor_write = team / attending, ER-ის შაბლონი (ER-ის განყოფილების — ყველა ER-ის ექიმს), PDF; სტაციონარის გზა ER-ზე — 404;
#   • ICD-10 (ბირთვი) ER-ის ექიმით (er_doctor, doctor-ის გარეშე); ტრიაჟის ექთანი / სხვა ექიმი — 403;
#   • დიაგნოსტიკა: dx-orders ER-ის შემთხვევაზე (emergency → er), დაფაზე „მოლოდინი“ ავტომატურად, ინვოისის ხაზი (გაუქმება 409),
#     UNPAID: skip → „exempt“ / დადასტურების გარეშე, ack → 409 UNPAID; radiology off → 403 + კატალოგში არ ჩანს (რბილი);
#   • კონსულტაცია: მოთხოვნა (ვადა წუთებში), კონსულტანტის სია (/clinical — ER + სტაციონარი), სამუშაო სია (er_consult), პასუხი / ხელმოწერა,
#     ბილინგი (ტარიფის გარეშე — გაფრთხილება), გაუქმება;
#   • ER სტაციონარის გარეშე (inpatient + დამოკიდებულები off): ჩანაწერი / კონსულტაცია მუშაობს; er off: ისტორია ჩანს, ჩაწერა 403, მომიჯნავე არ ვარდება.
# ბოლოს: კვლევები / შემთხვევები გაუქმებულია, მომხმარებლები / როლები / განყოფილებები გათიშულია, მოდულები / პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-er-clinical.sh [API_URL]
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
S=$(date +%s | tail -c 7); TMP=$(mktemp -d)
ago() { date -u -d "-$1" +%FT%TZ; }
setm() { api PUT "/modules/$1" "$ADM" -d "{$2,\"reason\":\"ტესტ-E2E ER clinical\"}"; }
sets() { api PUT /modules/er "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E ER clinical\"}"; }
pid() { printf '%s%010d' "$1" "$(( (10#$S * 7 + $2) % 10000000000 ))"; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0088" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0088" | tostring)')" "ok:true"
MODS=$(api GET /modules "$ADM")
ORIG=$(echo "$MODS" | jq -c '[.[]|{code, enabled}]')
ORIG_ER=$(echo "$MODS" | jq -c '.[]|select(.code=="er")|{enabled, settings}')
[ -n "$ORIG_ER" ] || die "მოდული er ვერ მოიძებნა"
for c in er lab radiology inpatient; do
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
  [ -f "$TMP/dx" ] && while read -r i; do api POST "/dx-orders/$i/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done < "$TMP/dx"
  [ -f "$TMP/visits" ] && while read -r e; do api POST "/er/visits/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done < "$TMP/visits"
  [ -f "$TMP/tpl" ] && while read -r t; do api PATCH "/clinical/note-templates/$t" "$ADM" -d '{"kind":"er_initial","name":"ტესტ-E2E (გათიშული)","content":{},"is_active":false}' >/dev/null; done < "$TMP/tpl"
  [ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
  [ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
  [ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
  rm -rf "$TMP"
}
trap cleanup EXIT
dep() { local id; id=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/deps"; echo "$id"; }
DER=$(dep "ER კლინიკური" E2ECE emergency); DCN=$(dep "კარდიოლოგია ER" E2ECK outpatient); DOT=$(dep "სხვა ER" E2ECO outpatient)
[ -n "$DER" ] && [ -n "$DCN" ] && [ -n "$DOT" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_erc_$1_$S\",\"name\":\"ტესტ-E2E ER-C $1\",\"capabilities\":$2}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_erc_$1_$S"; }; }
R_TR=$(mkrole tr '["er_triage","nurse"]'); R_DR=$(mkrole dr '["er_doctor"]'); R_MG=$(mkrole mg '["er_manage"]')
[ -n "$R_TR" ] && [ -n "$R_DR" ] && [ -n "$R_MG" ] || die "როლები ვერ შეიქმნა"
mkuser() {   # <roles-json> <n> <department> → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.erc.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ERC-$2\",\"personal_number\":\"$(pid 6 "$2")\",\"roles\":$1,\"department_id\":\"$3\",\"specialty\":\"ტესტი\",\"license_number\":\"ERC$2$S\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.erc.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
read -r TRID TR <<< "$(mkuser "[\"$R_TR\"]" 21 "$DER")"
read -r DRID DR <<< "$(mkuser "[\"$R_DR\"]" 22 "$DER")"
read -r D2ID D2 <<< "$(mkuser "[\"$R_DR\"]" 23 "$DOT")"
read -r MGID MG <<< "$(mkuser "[\"$R_MG\"]" 24 "$DER")"
read -r CNID CN <<< "$(mkuser '["doctor"]' 25 "$DCN")"
read -r ODID OD <<< "$(mkuser '["doctor"]' 26 "$DOT")"
[ -n "${TR:-}" ] && [ -n "${DR:-}" ] && [ -n "${D2:-}" ] && [ -n "${MG:-}" ] && [ -n "${CN:-}" ] && [ -n "${OD:-}" ] || die "მომხმარებლები ვერ შეიქმნა"
ok "მომხმარებლები: ტრიაჟი, 2 ER-ის ექიმი (მხოლოდ er_doctor), ER-ის მენეჯერი, კონსულტანტი (doctor), სხვა ექიმი"
pat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
P1=$(pat "$(pid 4 1)" "ERC-ერთი" 1970-01-10 male); P2=$(pat "$(pid 4 2)" "ERC-ორი" 1985-06-06 female)
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
keep() { local e; e=$(echo "$1" | jq -r '.encounter_id // empty'); [ -n "$e" ] && echo "$e" >> "$TMP/visits"; echo "$e"; }
E1=$(keep "$(api POST /er/visits "$TR" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E გულმკერდის ტკივილი\",\"arrived_at\":\"$(ago '40 min')\"}")")
E2=$(keep "$(api POST /er/visits "$TR" -d "{\"patient_id\":\"$P2\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E თავბრუსხვევა\"}")")
[ -n "$E1" ] && [ -n "$E2" ] || die "ER-ის შემთხვევები ვერ შეიქმნა"
api POST "/er/visits/$E1/triage" "$TR" -d '{"level":2}' >/dev/null
PK=$(api POST "/er/visits/$E1/pickup" "$DR"); DAT=$(echo "$PK" | jq -r '.doctor_at // empty')
[ -n "$DAT" ] || die "აყვანა ვერ მოხერხდა"
ok "2 ER-ის შემთხვევა; E1 — ტრიაჟი + აყვანა (ER-ის ექიმი)"

step "1. მოდული / პარამეტრები"
M=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")')
chk "რეესტრი: er → roster, lab, radiology, endoscopy (რბილი; 0089: + stock, pharmacy); მკაცრი — არა" "$(echo "$M" | jq -r '(.hard|length|tostring) + ":" + ([.soft[]|select(.!="stock" and .!="pharmacy")]|sort|join(","))')" "0:endoscopy,lab,radiology,roster"
chk "ნაგულისხმევი: initial_note_min 60, doctor_write team, dx_unpaid_check skip, dx_default_priority urgent, consult_due_min 30/60/240, consult_billing" \
  "$(echo "$M" | jq -r '.settings|"\(.initial_note_min):\(.doctor_write):\(.dx_unpaid_check):\(.dx_default_priority):\(.consult_due_min.emergency)/\(.consult_due_min.urgent)/\(.consult_due_min.routine):\(.consult_billing)"')" "60:team:skip:urgent:30/60/240:true"
chk "არასწორი: doctor_write / dx_unpaid_check / initial_note_min 5 / consult_due_min (გასაღები აკლია) — 400" \
  "$(code PUT /modules/er "$ADM" -d '{"settings":{"doctor_write":"all"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"dx_unpaid_check":"no"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"initial_note_min":5},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"consult_due_min":{"urgent":60}},"reason":"ტესტ-E2E"}')" "400:400:400:400"
VS=$(api GET "/er/visits/$E1" "$DR")
chk "ბარათი: clinical.write (ER-ის ექიმი), dx_default_priority; ტრიაჟის ექთანს — write false" "$(echo "$VS" | jq -r '"\(.clinical.write):\(.clinical.dx_default_priority):\(.diagnoses|length)"'):$(api GET "/er/visits/$E1" "$TR" | jq -r .clinical.write)" "true:urgent:0:false"

step "2. ER-ის ჩანაწერი"
NL=$(api GET "/er/visits/$E1/notes" "$DR")
DUE=$(date -u -d "$DAT + 60 min" +%s)
chk "სია: type emergency, პირველადი = er_initial, სახეები er_initial / er_progress / consult; can.write" "$(echo "$NL" | jq -r '"\(.type):\(.initial_kind):\(.kinds|join(",")):\(.can.write):\(.can.consult)"')" "emergency:er_initial:er_initial,er_progress,consult:true:true"
chk "ვადა: აყვანიდან 60 წთ (initial_note_min), ჯერ არ გასულა" "$(echo "$NL" | jq -r --argjson d "$DUE" '"\((.admission.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - $d | fabs < 5):\(.admission.overdue)"')" "true:false"
chk "აყვანის გარეშე (E2) — ვადა არ ითვლება (due_at null)" "$(api GET "/er/visits/$E2/notes" "$DR" | jq -r '.admission.due_at')" "null"
chk "სტაციონარის გზა ER-ის შემთხვევაზე — 404 (ER-ის ექიმს — 403, უფლება)" "$(code GET "/inpatient/stays/$E1/notes" "$ADM"):$(code GET "/inpatient/stays/$E1/notes" "$DR")" "404:403"
chk "ტრიაჟის ექთანი — ჩანაწერი 403; სტაციონარის სახე (admission) ER-ზე — 400" "$(code POST "/er/visits/$E1/notes" "$TR" -d '{"kind":"er_initial"}'):$(code POST "/er/visits/$E1/notes" "$DR" -d '{"kind":"admission"}')" "403:400"
N1=$(api POST "/er/visits/$E1/notes" "$DR" -d '{"kind":"er_initial","content":{"complaints":"ტესტ-E2E ტკივილი მკერდში 1 სთ"}}'); N1ID=$(echo "$N1" | jq -r '.id // empty')
chk "შავი ვერსია (er_initial) — draft, ER-ის განყოფილება" "$(echo "$N1" | jq -r '"\(.status):\(.kind):\(.department_name|test("ER კლინიკური"))"')" "draft:er_initial:true"
chk "უცნობი ველი — 400" "$(code PUT "/clinical/notes/$N1ID" "$DR" -d '{"content":{"nope":"x"}}')" "400"
chk "ხელმოწერა სავალდებულო ველების გარეშე — 400 NOTE_REQUIRED" "$(api POST "/clinical/notes/$N1ID/sign" "$DR" -d '{}' | jq -r .code)" "NOTE_REQUIRED"
chk "სხვა ექიმის შავ ვერსიას ვერ ასწორებს — 403" "$(code PUT "/clinical/notes/$N1ID" "$D2" -d '{"content":{"plan":"x"}}')" "403"
api PUT "/clinical/notes/$N1ID" "$DR" -d '{"content":{"complaints":"ტესტ-E2E ტკივილი მკერდში 1 სთ","objective":"ტესტ-E2E AP 150/90, HR 98","assessment":"ტესტ-E2E ACS?","plan":"ტესტ-E2E ეკგ, ტროპონინი"}}' >/dev/null
chk "ხელმოწერა (ავტორი) — signed" "$(api POST "/clinical/notes/$N1ID/sign" "$DR" -d '{}' | jq -r .status)" "signed"
chk "მეორე er_initial — 409 ADMISSION_NOTE_EXISTS" "$(api POST "/er/visits/$E1/notes" "$DR" -d '{"kind":"er_initial"}' | jq -r .code)" "ADMISSION_NOTE_EXISTS"
chk "ხელმოწერილი არ რედაქტირდება — 409" "$(code PUT "/clinical/notes/$N1ID" "$DR" -d '{"content":{"plan":"x"}}')" "409"
N2=$(api POST "/er/visits/$E1/notes" "$D2" -d '{"kind":"er_progress","content":{"a":"ტესტ-E2E სტაბილური"},"sign":true}')
chk "doctor_write = team: სხვა ER-ის ექიმი (არა მკურნალი) — დინამიკა ხელმოწერით" "$(echo "$N2" | jq -r '"\(.status):\(.kind)"')" "signed:er_progress"
sets '{"doctor_write":"attending"}' >/dev/null
chk "doctor_write = attending: არა მკურნალი — 403; მკურნალი — 201" "$(code POST "/er/visits/$E1/notes" "$D2" -d '{"kind":"er_progress","content":{"a":"x"}}'):$(api POST "/er/visits/$E1/notes" "$DR" -d '{"kind":"er_progress","content":{"a":"x"}}' | tee "$TMP/n3" | jq -r .status)" "403:draft"
chk "attending: ბარათზე clinical.write — მკურნალს true, სხვას false" "$(api GET "/er/visits/$E1" "$DR" | jq -r .clinical.write):$(api GET "/er/visits/$E1" "$D2" | jq -r .clinical.write)" "true:false"
chk "შავი ვერსიის წაშლა (ავტორი)" "$(code DELETE "/clinical/notes/$(jq -r .id "$TMP/n3")" "$DR")" "200"
sets '{"doctor_write":"team"}' >/dev/null
AM=$(api POST "/clinical/notes/$N1ID/amend" "$D2" -d '{"reason":"ტესტ-E2E დაზუსტება"}'); AMID=$(echo "$AM" | jq -r '.id // empty')
api PUT "/clinical/notes/$AMID" "$D2" -d '{"content":{"complaints":"ტესტ-E2E ტკივილი მკერდში 1 სთ","objective":"ტესტ-E2E AP 150/90, HR 98","assessment":"ტესტ-E2E NSTEMI?","plan":"ტესტ-E2E ეკგ, ტროპონინი x2"}}' >/dev/null
chk "შესწორება (team — სხვა ER-ის ექიმი): ვ.2 ხელმოწერა, ვ.1 superseded, ისტორია 2" "$(api POST "/clinical/notes/$AMID/sign" "$D2" -d '{}' | jq -r '"\(.version):\(.status)"'):$(api GET "/clinical/notes/$N1ID" "$DR" | jq -r '.superseded_at != null'):$(api GET "/clinical/notes/$N1ID/history" "$DR" | jq -r length)" "2:signed:true:2"
BD=$(api GET "/er/board?department_id=$DER" "$TR" | jq -c --arg e "$E1" '.items[]|select(.encounter_id==$e)')
chk "დაფა: პირველადი ჩანაწერი ხელმოწერილია (initial_note.signed), ვადაგადაცილება — არა" "$(echo "$BD" | jq -r '"\(.initial_note.signed):\(.initial_note.overdue)"')" "true:false"
chk "PDF (ხელმოწერილი ჩანაწერები) — 200 application/pdf" "$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B/er/visits/$E1/notes/pdf" -H "authorization: Bearer $DR")" "200:application/pdf"
TP=$(api POST /clinical/note-templates "$MG" -d "{\"kind\":\"er_initial\",\"name\":\"ტესტ-E2E ER შაბლონი $S\",\"content\":{\"plan\":\"ეკგ, ტროპონინი\"},\"department_id\":\"$DER\"}"); TPID=$(echo "$TP" | jq -r '.id // empty')
[ -n "$TPID" ] && echo "$TPID" >> "$TMP/tpl"
chk "ER-ის შაბლონი (ER-ის მენეჯერი, ER-ის განყოფილება) — სხვა განყოფილების ER-ის ექიმიც ხედავს; სხვა ექიმი (doctor) — არა" \
  "$(api GET "/clinical/note-templates?kind=er_initial" "$D2" | jq -r --arg t "$TPID" '[.[]|select(.id==$t)]|length'):$(api GET "/clinical/note-templates?kind=er_initial" "$OD" | jq -r --arg t "$TPID" '[.[]|select(.id==$t)]|length')" "1:0"
chk "ER-ის მენეჯერი — სხვა (არა-ER) განყოფილების შაბლონი — 403" "$(code POST /clinical/note-templates "$MG" -d "{\"kind\":\"er_initial\",\"name\":\"ტესტ-E2E x\",\"content\":{},\"department_id\":\"$DOT\"}")" "403"

step "3. დიაგნოზი (ICD-10)"
chk "ER-ის ექიმი (er_doctor, doctor-ის გარეშე) — ძირითადი I20.0" "$(code POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"I20.0","diagnosis_type":"primary"}')" "201"
chk "ტრიაჟის ექთანი — 403; სხვა ექიმი (doctor, ER-ის გარეშე) — 403" "$(code POST "/encounters/$E1/diagnoses" "$TR" -d '{"icd10_code":"I10","diagnosis_type":"secondary"}'):$(code POST "/encounters/$E1/diagnoses" "$OD" -d '{"icd10_code":"I10","diagnosis_type":"secondary"}')" "403:403"
chk "ბარათზე დიაგნოზი ჩანს" "$(api GET "/er/visits/$E1" "$TR" | jq -r '[.diagnoses[]|.icd10_code + "/" + .diagnosis_type]|join(",")')" "I20.0/primary"

step "4. დიაგნოსტიკა"
LAB=$(api GET "/dx/catalog?section=lab&orderable=true" "$ADM" | jq -r '[.[]|select(.performed_by!="external" and (.is_micro|not))][0].id // empty')
RAD=$(api GET "/dx/catalog?section=radiology&orderable=true" "$ADM" | jq -r '[.[]|select(.contrast != "iodinated")][0].id // empty')
[ -n "$LAB" ] && [ -n "$RAD" ] || die "კატალოგში ლაბ. / რადიოლოგიური კვლევა ვერ მოიძებნა"
O1=$(api POST "/encounters/$E1/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$LAB\",\"priority\":\"urgent\"},{\"service_id\":\"$RAD\",\"priority\":\"urgent\"}]}")
echo "$O1" | jq -r '.[]?.id' >> "$TMP/dx"
chk "ER-ის ექიმი (doctor-ის გარეშე): ლაბ. + რადიოლოგია — 2 შეკვეთა, სასწრაფო" "$(echo "$O1" | jq -r 'length'):$(api GET "/encounters/$E1/dx-orders" "$TR" | jq -r '[.[]|.priority]|unique|join(",")')" "2:urgent"
chk "ტრიაჟის ექთანი / სხვა ექიმი — 403; ტრიაჟის ექთანი ხედავს (GET 200)" "$(code POST "/encounters/$E1/dx-orders" "$TR" -d "{\"items\":[{\"service_id\":\"$LAB\"}]}"):$(code POST "/encounters/$E1/dx-orders" "$OD" -d "{\"items\":[{\"service_id\":\"$LAB\"}]}"):$(code GET "/encounters/$E1/dx-orders" "$TR")" "403:403:200"
chk "დაფა: „მოლოდინი“ ავტომატურად — ანალიზი + კვლევა (ხელით მონიშვნის გარეშე)" "$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$E1" '.items[]|select(.encounter_id==$e)|"\(.waiting_auto|sort|join(",")):\(.waiting_for|length)"')" "imaging,lab:0"
chk "ინვოისში 2 ხაზი → ER-ის გაუქმება — 409" "$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r '(.line_items // .lines // .items // [])|length'):$(code POST "/er/visits/$E1/cancel" "$MG" -d '{"reason":"ტესტ-E2E"}')" "2:409"
RI=$(echo "$O1" | jq -r '.[]|select(.section=="radiology")|.id')
BOGUS=00000000-0000-4000-8000-000000000000
if [ "$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r '.paid_status')" = "unpaid" ]; then
  PEND=$(api GET /dx/collection "$ADM" | jq -c --arg e "$E1" '[.[]|select(.encounter_id==$e)][0] // empty')
  chk "dx_unpaid_check = skip: ნიმუშის აღების რიგში — exempt (UI დადასტურებას არ ითხოვს)" "$(echo "$PEND" | jq -r '.paid_status // "—"')" "exempt"
  chk "skip: აღება დადასტურების გარეშე — UNPAID არ ჩნდება (შემდეგი შემოწმება)" "$(api POST "/encounters/$E1/dx-collect" "$ADM" -d "{\"identity_confirmed\":true,\"item_ids\":[\"$BOGUS\"]}" | jq -r '.code // "no-code"')" "no-code"
  sets '{"dx_unpaid_check":"ack"}' >/dev/null
  chk "dx_unpaid_check = ack: აღება დადასტურების გარეშე — 409 UNPAID; რიგში — unpaid" "$(api POST "/encounters/$E1/dx-collect" "$ADM" -d "{\"identity_confirmed\":true,\"item_ids\":[\"$BOGUS\"]}" | jq -r .code):$(api GET /dx/collection "$ADM" | jq -r --arg e "$E1" '[.[]|select(.encounter_id==$e)][0].paid_status // "—"')" "UNPAID:unpaid"
  chk "ack: რადიოლოგიაში მისვლა დადასტურების გარეშე — 409 UNPAID" "$(api POST "/dx-orders/$RI/arrive" "$ADM" -d '{}' | jq -r .code)" "UNPAID"
  sets '{"dx_unpaid_check":"skip"}' >/dev/null
else
  echo "  ⚠ კვლევებს ფასი არ აქვს (ინვოისი 0 ₾) — UNPAID-ის შემოწმება გამოტოვებულია"
fi
modoff radiology
chk "radiology off (რბილი): ER-ის დაფა 200; რადიოლოგიის შეკვეთა — 403; კატალოგში (orderable) არ ჩანს; ლაბ. — 201" \
  "$(code GET /er/board "$TR"):$(code POST "/encounters/$E1/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$RAD\"}]}"):$(api GET "/dx/catalog?orderable=true" "$ADM" | jq -r '[.[]|select(.section=="radiology")]|length'):$(api POST "/encounters/$E2/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$LAB\"}]}" | tee "$TMP/o2" | jq -r 'if type=="array" then "201" else .statusCode end')" "200:403:0:201"
jq -r '.[]?.id' "$TMP/o2" >> "$TMP/dx"
restore_mods
chk "შეკვეთის გაუქმება (ER-ის ექიმი, team) — ინვოისიდან იშლება" "$(code POST "/dx-orders/$RI/cancel" "$D2" -d '{"reason":"ტესტ-E2E"}'):$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r '(.line_items // .lines // .items // [])|length')" "200:1"

step "5. კონსულტაცია"
T0=$(date +%s)
C1=$(api POST "/er/visits/$E1/consultations" "$DR" -d "{\"target_department_id\":\"$DCN\",\"urgency\":\"urgent\",\"question\":\"ტესტ-E2E ეკგ-ზე ST დეპრესია — კარდიოლოგი\"}"); C1ID=$(echo "$C1" | jq -r '.id // empty')
chk "მოთხოვნა: requested, ვადა ≈ 60 წთ (consult_due_min.urgent), გამგზავნი — ER" "$(echo "$C1" | jq -r --argjson t "$T0" '"\(.status):\(((.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - $t - 3600)|fabs < 30):\(.from_department_name|test("ER კლინიკური"))"')" "requested:true:true"
chk "ტრიაჟის ექთანი — 403; სტაციონარის გზა ER-ზე — 404" "$(code POST "/er/visits/$E1/consultations" "$TR" -d "{\"target_department_id\":\"$DCN\",\"urgency\":\"urgent\",\"question\":\"xxx\"}"):$(code POST "/inpatient/stays/$E1/consultations" "$ADM" -d "{\"target_department_id\":\"$DCN\",\"urgency\":\"urgent\",\"question\":\"xxx\"}")" "403:404"
chk "დაფა: „მოლოდინი“ — კონსულტაციაც" "$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$E1" '.items[]|select(.encounter_id==$e)|.waiting_auto|index("consult") != null')" "true"
IB=$(api GET /clinical/consultations/inbox "$CN" | jq -c --arg c "$C1ID" '[.[]|select(.id==$c)][0] // empty')
chk "კონსულტანტის სია (/clinical): ER-ის შემთხვევა (encounter_type, № ER…); ძველ /inpatient სიაში — არა" "$(echo "$IB" | jq -r '"\(.encounter_type):\(.adm_no|test("^ER"))"'):$(api GET /inpatient/consultations/inbox "$CN" | jq -r --arg c "$C1ID" '[.[]|select(.id==$c)]|length')" "emergency:true:0"
chk "სამუშაო სია: er_consult (კონსულტანტს)" "$(api GET "/worklist/mine?source=er_consult" "$CN" | jq -r --arg c "er_consult:$C1ID" '[.items[]|select(.key==$c)]|length')" "1"
chk "ER-ის ექიმი პასუხს ვერ წერს (არ არის კონსულტანტი) — 403" "$(code POST "/clinical/charts/$E1/notes" "$D2" -d "{\"kind\":\"consult\",\"consultation_id\":\"$C1ID\",\"content\":{\"assessment\":\"x\",\"recommendations\":\"y\"}}")" "403"
AN=$(api POST "/clinical/charts/$E1/notes" "$CN" -d "{\"kind\":\"consult\",\"consultation_id\":\"$C1ID\",\"content\":{\"assessment\":\"ტესტ-E2E NSTEMI\",\"recommendations\":\"ტესტ-E2E კორონაროგრაფია\"}}"); ANID=$(echo "$AN" | jq -r '.id // empty')
SG=$(api POST "/clinical/notes/$ANID/sign" "$CN" -d '{}')
chk "პასუხი (კონსულტანტი): ხელმოწერა; ბილინგი ტარიფის გარეშე — გაფრთხილება, ინვოისში არ დაემატა" "$(echo "$SG" | jq -r '"\(.status):\(.billed):\(.warning|test("ტარიფი"))"'):$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r '(.line_items // .lines // .items // [])|length')" "signed:null:true:1"
NL2=$(api GET "/er/visits/$E1/notes" "$DR")
chk "ER-ის ჩანაწერებში: კონსულტაცია answered + პასუხი (kind consult)" "$(echo "$NL2" | jq -r --arg c "$C1ID" '"\([.consultations[]|select(.id==$c)][0].status):\([.notes[]|select(.kind=="consult" and .status=="signed")]|length)"')" "answered:1"
C2ID=$(api POST "/er/visits/$E1/consultations" "$DR" -d "{\"target_doctor_id\":\"$CNID\",\"urgency\":\"emergency\",\"question\":\"ტესტ-E2E მეორე\"}" | jq -r '.id // empty')
chk "გაუქმება: სხვა — 403; მომთხოვნი — cancelled" "$(code POST "/clinical/consultations/$C2ID/cancel" "$D2" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/clinical/consultations/$C2ID/cancel" "$DR" -d '{"reason":"ტესტ-E2E აღარ სჭირდება"}' | jq -r .status)" "403:cancelled"

step "6. ER სტაციონარის გარეშე / er off"
modoff inpatient
chk "inpatient (+ დამოკიდებულები) off: ER-ის ჩანაწერი / ხელმოწერა — 201 / 200" "$(api POST "/er/visits/$E2/notes" "$DR" -d '{"kind":"er_progress","content":{"a":"ტესტ-E2E სტაციონარის გარეშე"}}' | tee "$TMP/n4" | jq -r .status):$(code POST "/clinical/notes/$(jq -r .id "$TMP/n4")/sign" "$DR" -d '{}')" "draft:200"
chk "inpatient off: ER-ის კონსულტაცია / კონსულტანტის სია — 201 / 200; /inpatient — 403" "$(code POST "/er/visits/$E2/consultations" "$DR" -d "{\"target_department_id\":\"$DCN\",\"urgency\":\"routine\",\"question\":\"ტესტ-E2E სტაც. გარეშე\"}"):$(code GET /clinical/consultations/inbox "$CN"):$(code GET /inpatient/consultations/inbox "$CN")" "201:200:403"
restore_mods
setm er '"enabled":false' >/dev/null
chk "er off: ჩანაწერები / ბარათი / დიაგნოსტიკა ჩანს (200); ჩანაწერი / კვლევა / დიაგნოზი / კონსულტაცია — 403" \
  "$(code GET "/er/visits/$E1/notes" "$DR"):$(code GET "/er/visits/$E1" "$DR"):$(code GET "/encounters/$E1/dx-orders" "$DR"):$(code POST "/er/visits/$E1/notes" "$DR" -d '{"kind":"er_progress","content":{"a":"x"}}'):$(code POST "/encounters/$E1/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$LAB\"}]}"):$(code POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"I10","diagnosis_type":"secondary"}'):$(code POST "/clinical/charts/$E1/notes" "$CN" -d '{"kind":"consult"}')" "200:200:200:403:403:403:403"
chk "er off: ბარათზე clinical.write = false; /clinical (სტაციონარი) — 200; მომიჯნავე არ ვარდება" "$(api GET "/er/visits/$E1" "$DR" | jq -r .clinical.write):$(code GET /clinical/consultations/inbox "$CN"):$(code GET /inpatient/census "$ADM"):$(code GET "/dx/catalog?orderable=true" "$ADM")" "false:200:200:200"
setm er '"enabled":true' >/dev/null
chk "er ჩართვა — აქტიური" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="er")|.state')" "active"

step "7. დასრულება"
cleanup; trap - EXIT
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")|{enabled, settings}')" "$ORIG_ER"
chk "მოდულები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '[.[]|{code, enabled}]')" "$ORIG"
chk "ER-ის დაფაზე სატესტო შემთხვევა აღარ არის" "$(api GET /er/board "$ADM" | jq -r --arg d "$DER" '[.items[]|select(.department_id==$d)]|length')" "0"
ok "სატესტო ჩანაწერები გაუქმებულია / გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
