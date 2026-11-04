#!/usr/bin/env bash
# =====================================================================
# e2e-er-triage.sh — გადაუდებელი დახმარება (ER), ეტაპი 1 / 4 (0087): მოდული (რეესტრი / უფლებები / პარამეტრები), რეგისტრაცია
#   (არსებული / სწრაფი საბუთით / უცნობი „#N“, შემოსვლის გზა, სასწრაფოს ველები, ერთი აქტიური ER-ი პაციენტზე, ადგილი), ტრიაჟი
#   (ESI, ვიტალები → encounter_vitals, NEWS2 — მინიშნება, 16 წლამდე — არა, განმეორებითი, MTS / საკუთარი შკალა), დაფა (რიგი,
#   ტაიმერები / ვადაგადაცილება, TV — ინიციალები), აყვანა (ექიმი, doctor_before_triage), მინიჭება (ადგილი / ექთანი / ექიმი / მოლოდინი),
#   გაუქმება (უფლებები), უცნობის იდენტიფიკაცია / გაერთიანება (MERGE_CONFLICT → არაფერი იცვლება), ცნობარები (ადგილები, გზები, შკალები),
#   მოდულის გამორთვა (403; ისტორია / იდენტიფიკაცია — კი; მომიჯნავე მოდული არ ვარდება), roster-ის გარეშე დაფა მუშაობს.
# ბოლოს: ER-ის შემთხვევები გაუქმებულია, მომხმარებლები / როლები / განყოფილება / ადგილები გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-er-triage.sh [API_URL]
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
setm() { api PUT "/modules/$1" "$ADM" -d "{$2,\"reason\":\"ტესტ-E2E ER\"}"; }
pid() { printf '%s%010d' "$1" "$(( (10#$S * 7 + $2) % 10000000000 ))"; }   # 11-ნიშნა პირადი ნომერი

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0087" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0087" | tostring)')" "ok:true"
MODS=$(api GET /modules "$ADM")
ORIG_ER=$(echo "$MODS" | jq -c '.[]|select(.code=="er")|{enabled, settings}')
ORIG_RO=$(echo "$MODS" | jq -c '.[]|select(.code=="roster")|{enabled}')
[ -n "$ORIG_ER" ] || die "მოდული er ვერ მოიძებნა"
[ "$(echo "$MODS" | jq -r '.[]|select(.code=="er")|.state')" = "active" ] || die "მოდული er არააქტიურია (ლიცენზია / ჩართვა) — e2e-ის წინ: ლიცენზიის მოხსნა ან er ლიცენზიაში"
cleanup() {
  [ -f "$TMP/visits" ] && while read -r e; do api POST "/er/visits/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done < "$TMP/visits"
  setm er "\"enabled\":true,\"settings\":$(echo "$ORIG_ER" | jq -c .settings)" >/dev/null
  [ "$(echo "$ORIG_RO" | jq -r .enabled)" = "true" ] && setm roster '"enabled":true' >/dev/null
  [ -f "$TMP/spots" ] && while read -r s; do api PATCH "/er/admin/spots/$s" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/spots"
  [ -n "${SC:-}" ] && api PATCH "/er/admin/scales/$SC" "$ADM" -d '{"is_active":false}' >/dev/null
  [ -n "${AMC:-}" ] && api PATCH "/er/admin/arrival-modes/$AMC" "$ADM" -d '{"is_active":false}' >/dev/null
  [ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
  [ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
  [ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
  rm -rf "$TMP"
}
trap cleanup EXIT
dep() { local id; id=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/deps"; echo "$id"; }
DER=$(dep "გადაუდებელი" E2EER emergency); DOP=$(dep "ამბულატორია ER" E2EEO outpatient)
[ -n "$DER" ] && [ -n "$DOP" ] || die "განყოფილებები ვერ შეიქმნა (type emergency — 0087)"
ok "ER-ის განყოფილება (type = emergency)"
spot() { local id; id=$(api POST /er/admin/spots "$ADM" -d "{\"department_id\":\"$DER\",\"code\":\"$1\",\"name\":\"ტესტ-E2E $2\",\"kind\":\"$3\"}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/spots"; echo "$id"; }
SP1=$(spot T1 "ტახტი 1" bed); SP2=$(spot R1 "რეანიმაციული 1" resus); SP3=$(spot C1 "სავარძელი 1" chair)
[ -n "$SP1" ] && [ -n "$SP2" ] && [ -n "$SP3" ] || die "ადგილები ვერ შეიქმნა"
chk "ადგილი: იგივე კოდი იმავე განყოფილებაში — 409" "$(code POST /er/admin/spots "$ADM" -d "{\"department_id\":\"$DER\",\"code\":\"T1\",\"name\":\"x\"}")" "409"
chk "ადგილი: არა-ER განყოფილებაში — 400" "$(code POST /er/admin/spots "$ADM" -d "{\"department_id\":\"$DOP\",\"code\":\"X1\",\"name\":\"x\"}")" "400"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_er_$1_$S\",\"name\":\"ტესტ-E2E ER $1\",\"capabilities\":$2}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_er_$1_$S"; }; }
R_TR=$(mkrole tr '["er_triage","nurse"]'); R_DR=$(mkrole dr '["er_doctor","doctor"]'); R_MG=$(mkrole mg '["er_manage"]')
[ -n "$R_TR" ] && [ -n "$R_DR" ] && [ -n "$R_MG" ] || die "როლები ვერ შეიქმნა (er_triage / er_doctor / er_manage — 0087)"
ok "როლები er_triage / er_doctor / er_manage"
mkuser() {   # <roles-json> <n> → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.er.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ER-$2\",\"personal_number\":\"$(pid 7 "$2")\",\"roles\":$1,\"department_id\":\"$DER\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.er.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
read -r TRID TR <<< "$(mkuser "[\"$R_TR\"]" 11)"
read -r DRID DR <<< "$(mkuser "[\"$R_DR\"]" 12)"
read -r D2ID D2 <<< "$(mkuser "[\"$R_DR\"]" 13)"
read -r MGID MG <<< "$(mkuser "[\"$R_MG\"]" 14)"
read -r RCID RC <<< "$(mkuser '["receptionist"]' 15)"
[ -n "${TR:-}" ] && [ -n "${DR:-}" ] && [ -n "${D2:-}" ] && [ -n "${MG:-}" ] && [ -n "${RC:-}" ] || die "მომხმარებლები ვერ შეიქმნა"
pat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty'; }
P1=$(pat "$(pid 5 1)" "ER-პაციენტი" 1980-05-05 male); P3=$(pat "$(pid 5 3)" "ER-ნამდვილი" 1975-03-03 female)
PCH=$(pat "$(pid 5 4)" "ER-ბავშვი" "$(date -d '-10 years' +%F)" female)
[ -n "$P1" ] && [ -n "$P3" ] && [ -n "$PCH" ] || die "პაციენტები ვერ შეიქმნა"
reg() { api POST /er/visits "$1" -d "$2"; }
keep() { local e; e=$(echo "$1" | jq -r '.encounter_id // empty'); [ -n "$e" ] && echo "$e" >> "$TMP/visits"; echo "$e"; }

step "1. მოდული, უფლებები, პარამეტრები"
M=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")')
chk "რეესტრი: er — clinical, მკაცრი წინაპირობა არ აქვს, რბილი → roster (0088: + lab / radiology / endoscopy)" "$(echo "$M" | jq -r '.group + ":" + (.hard|length|tostring) + ":" + (.soft|index("roster") != null|tostring)')" "clinical:0:true"
CAPS=$(api GET /roles/capabilities "$ADM")
chk "უფლებების კატალოგი: er_triage / er_doctor / er_manage → მოდული er" "$(echo "$CAPS" | jq -r '[.[]|select(.code|startswith("er_"))|.module|tostring]|join(",")')" "er,er,er"
chk "პარამეტრი: უცნობი გასაღები — 400" "$(code PUT /modules/er "$ADM" -d '{"settings":{"nope":1},"reason":"ტესტ-E2E"}')" "400"
chk "პარამეტრი: არასწორი მნიშვნელობა (triage_target_min = 0) — 400" "$(code PUT /modules/er "$ADM" -d '{"settings":{"triage_target_min":0},"reason":"ტესტ-E2E"}')" "400"
chk "პარამეტრი: უცნობი შკალა — 400" "$(code PUT /modules/er "$ADM" -d '{"settings":{"triage_scale":"NOPE"},"reason":"ტესტ-E2E"}')" "400"
chk "პარამეტრი: სწორი (ambulance_fields = required) — 200" "$(code PUT /modules/er "$ADM" -d '{"settings":{"ambulance_fields":"required","triage_scale":"ESI","triage_target_min":10,"doctor_before_triage":"allow"},"reason":"ტესტ-E2E"}')" "200"
chk "რეგისტრატორი (ER-ის უფლების გარეშე): დაფა — 403" "$(code GET /er/board "$RC")" "403"
chk "მეტა: ტრიაჟის თანამშრომელს — register + triage, pickup — არა" "$(api GET /er/meta "$TR" | jq -r '.perms|"\(.register):\(.triage):\(.pickup):\(.merge)"')" "true:true:false:false"
chk "მეტა: ESI + MTS (5 + 5 დონე), ESI — ნაგულისხმევი" "$(api GET /er/meta "$TR" | jq -r '[.scales[]|select(.code=="ESI" or .code=="MTS")|.levels|length]|join(",")'):$(api GET /er/meta "$TR" | jq -r .settings.triage_scale)" "5,5:ESI"

step "2. რეგისტრაცია"
R1=$(reg "$TR" "{\"patient_id\":\"$P1\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E გულმკერდის ტკივილი\",\"arrived_at\":\"$(ago '30 min')\",\"spot_id\":\"$SP1\"}")
E1=$(keep "$R1")
chk "არსებული პაციენტი: შემთხვევა + ადგილი + ნომერი ER<YY>-" "$(echo "$R1" | jq -r '"\(.status):\(.spot_id == "'"$SP1"'"):\(.visit_no|test("^ER[0-9]{2}-[0-9]{6}$"))"')" "waiting:true:true"
ENC=$(api GET "/encounters?patient_id=$P1" "$ADM" | jq -c --arg e "$E1" '.[]|select(.id==$e)')
chk "encounters.type = emergency, active; ინვოისი (0 ₾)" "$(echo "$ENC" | jq -r '.type + ":" + .status'):$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r '.total_amount|tonumber == 0')" "emergency:active:true"
chk "იგივე პაციენტი მეორედ — 409 ER_ALREADY_ACTIVE" "$(reg "$TR" "{\"patient_id\":\"$P1\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\"}" | jq -r .code)" "ER_ALREADY_ACTIVE"
chk "არა-ER განყოფილება — 400" "$(code POST /er/visits "$TR" -d "{\"patient_id\":\"$P3\",\"department_id\":\"$DOP\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\"}")" "400"
chk "სასწრაფო ბრიგადის №-ის გარეშე (ambulance_fields = required) — 400" "$(code POST /er/visits "$TR" -d "{\"patient_id\":\"$P3\",\"department_id\":\"$DER\",\"arrival_mode\":\"ambulance\",\"chief_complaint\":\"ტესტ\"}")" "400"
chk "დაკავებული ადგილი — 409" "$(code POST /er/visits "$TR" -d "{\"patient_id\":\"$P3\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\",\"spot_id\":\"$SP1\"}")" "409"
chk "patient_id და new_patient ერთად — 400" "$(code POST /er/visits "$TR" -d "{\"patient_id\":\"$P3\",\"new_patient\":{\"gender\":\"male\",\"age_years\":30},\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\"}")" "400"
chk "რეგისტრატორი (ER-ის უფლების გარეშე) — 403" "$(code POST /er/visits "$RC" -d "{\"patient_id\":\"$P3\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\"}")" "403"
RU=$(reg "$TR" "{\"new_patient\":{\"gender\":\"male\",\"age_years\":40},\"department_id\":\"$DER\",\"arrival_mode\":\"ambulance\",\"ambulance_crew\":\"E2E-$S\",\"ambulance_call_at\":\"$(ago '50 min')\",\"chief_complaint\":\"ტესტ-E2E უგონო, ქუჩაში\",\"arrived_at\":\"$(ago '20 min')\",\"spot_id\":\"$SP2\"}")
EU=$(keep "$RU"); PU=$(echo "$RU" | jq -r '.patient.id // empty'); UNO=$(echo "$RU" | jq -r '.patient.unknown_no // empty')
PUJ=$(api GET "/patients/$PU" "$ADM")
chk "უცნობი: „უცნობი #N“, is_unknown, დაბადება — 01.01 (შეფასებული), საბუთის გარეშე" \
  "$(echo "$PUJ" | jq -r '"\(.first_name):\(.last_name == "#\(.unknown_no)"):\(.is_unknown):\(.birth_date_estimated):\(.birth_date|endswith("-01-01")):\(.personal_number):\(.passport_number)"')" "უცნობი:true:true:true:true:null:null"
chk "ძებნა „#N“ / „უცნობი N“ — პოულობს" "$(api GET "/patients?search=%23$UNO" "$ADM" | jq -r --arg p "$PU" '[.[]|select(.id==$p)]|length'):$(api GET "/patients?search=$(jq -rn --arg s "უცნობი $UNO" '$s|@uri')" "$ADM" | jq -r --arg p "$PU" '[.[]|select(.id==$p)]|length')" "1:1"
RN=$(reg "$TR" "{\"new_patient\":{\"gender\":\"female\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ER-სწრაფი\",\"birth_date\":\"1990-01-02\",\"personal_number\":\"$(pid 5 2)\"},\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E მუცლის ტკივილი\",\"arrived_at\":\"$(ago '5 min')\"}")
EN=$(keep "$RN"); PN=$(echo "$RN" | jq -r '.patient.id // empty')
chk "სწრაფი (საბუთით) — ჩვეულებრივი პაციენტი (is_unknown = false, ტელეფონი — არასავალდებულო)" "$(echo "$RN" | jq -r '.patient.is_unknown'):$(api GET "/patients/$PN" "$ADM" | jq -r .personal_number)" "false:$(pid 5 2)"
chk "სწრაფი: იგივე პირადი ნომერი — 409 PATIENT_EXISTS" "$(reg "$TR" "{\"new_patient\":{\"gender\":\"male\",\"first_name\":\"ა\",\"last_name\":\"ბ\",\"birth_date\":\"1980-05-05\",\"personal_number\":\"$(pid 5 1)\"},\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\"}" | jq -r .code)" "PATIENT_EXISTS"
chk "სწრაფი: საბუთი, დაბადების თარიღის გარეშე — 400" "$(code POST /er/visits "$TR" -d "{\"new_patient\":{\"gender\":\"male\",\"first_name\":\"ა\",\"last_name\":\"ბ\",\"age_years\":30,\"personal_number\":\"$(pid 5 9)\"},\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ\"}")" "400"
RC1=$(reg "$TR" "{\"patient_id\":\"$PCH\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E ბავშვი, ცხელება\"}"); ECH=$(keep "$RC1")
[ -n "$E1" ] && [ -n "$EU" ] && [ -n "$EN" ] && [ -n "$ECH" ] || die "რეგისტრაცია ვერ მოხერხდა"

step "3. ტრიაჟი"
V7='{"respiratory_rate":22,"spo2":95,"o2_supplement":false,"systolic_bp":105,"diastolic_bp":70,"heart_rate":115,"consciousness":"A","temperature":38.5,"pain":6}'
T1=$(api POST "/er/visits/$EU/triage" "$TR" -d "{\"level\":2,\"vitals\":$V7,\"gcs\":13,\"discriminator\":\"ცნობიერების დარღვევა\"}")
chk "ტრიაჟი (ESI 2): NEWS2 = 7 (high) — მინიშნება; ფერი / დონე" "$(echo "$T1" | jq -r '"\(.scale_code):\(.level):\(.news2_score):\(.news2_level):\(.is_retriage):\(.color)"')" "ESI:2:7:high:false:#ef6c00"
VU=$(api GET "/er/visits/$EU" "$TR")
chk "შემთხვევა: triaged, ექთანი = ტრიაჟის თანამშრომელი, ვიტალები ისტორიაში (encounter_vitals)" "$(echo "$VU" | jq -r '"\(.status):\(.nurse_id == "'"$TRID"'"):\(.triage|length):\(.triage[0].heart_rate):\(.triage[0].gcs)"')" "triaged:true:1:115:13"
chk "დონე, რომელიც შკალაში არ არის (ESI 7) — 400" "$(code POST "/er/visits/$E1/triage" "$TR" -d '{"level":7}')" "400"
chk "ვიტალი საზღვრებს გარეთ (HR 400) — 400" "$(code POST "/er/visits/$E1/triage" "$TR" -d '{"level":3,"vitals":{"heart_rate":400}}')" "400"
chk "დიასტოლური ≥ სისტოლური — 400" "$(code POST "/er/visits/$E1/triage" "$TR" -d '{"level":3,"vitals":{"systolic_bp":90,"diastolic_bp":95}}')" "400"
chk "ტრიაჟი ვიტალების გარეშე (ESI 3) — 200, NEWS2 = null" "$(api POST "/er/visits/$E1/triage" "$TR" -d '{"level":3,"discriminator":"ტკივილი 6/10"}' | jq -r '"\(.level):\(.news2_score)"')" "3:null"
chk "16 წლამდე — NEWS2 არ ითვლება" "$(api POST "/er/visits/$ECH/triage" "$TR" -d "{\"level\":4,\"vitals\":$V7}" | jq -r '.news2_score')" "null"
RT=$(api POST "/er/visits/$EU/triage" "$DR" -d '{"level":1,"note":"გაუარესდა"}')
chk "განმეორებითი ტრიაჟი (ექიმი): is_retriage, ESI 1; ისტორია 2 ჩანაწერი" "$(echo "$RT" | jq -r '"\(.is_retriage):\(.level)"'):$(api GET "/er/visits/$EU" "$TR" | jq -r '.triage|length')" "true:1:2"
chk "რეგისტრატორი — ტრიაჟი 403" "$(code POST "/er/visits/$EN/triage" "$RC" -d '{"level":4}')" "403"

step "4. დაფა"
BD=$(api GET "/er/board?department_id=$DER" "$TR")
chk "დაფა: 4 შემთხვევა; ტრიაჟის მოლოდინში 1, ექიმის მოლოდინში 3" "$(echo "$BD" | jq -r '.counts|"\(.total):\(.waiting_triage):\(.waiting_doctor):\(.in_treatment)"')" "4:1:3:0"
chk "რიგი: ჯერ ტრიაჟის გარეშე, მერე დონით (ESI 1 → 3 → 4)" "$(echo "$BD" | jq -r '[.items[]|(.triage.level // 0)]|map(tostring)|join(",")')" "0,1,3,4"
I1=$(echo "$BD" | jq -c --arg e "$E1" '.items[]|select(.encounter_id==$e)')
chk "ტაიმერები: ESI 3 — ექიმამდე ≤ 30 წთ (ვადა ტრიაჟიდან), ჯერ არ გადაცილებულა; ტრიაჟის ვადა აღარ ითვლება" \
  "$(echo "$I1" | jq -r '"\(.timers.doctor_due_at != null):\(.timers.doctor_overdue):\(.timers.triage_due_at):\(.timers.wait_min >= 29)"')" "true:false:null:true"
IN=$(echo "$BD" | jq -c --arg e "$EN" '.items[]|select(.encounter_id==$e)')
chk "ტრიაჟის მოლოდინი < 10 წთ — ვადა ჯერ არ გასულა" "$(echo "$IN" | jq -r '"\(.status):\(.timers.triage_overdue)"')" "waiting:false"
api PUT /modules/er "$ADM" -d '{"settings":{"triage_target_min":2},"reason":"ტესტ-E2E"}' >/dev/null
chk "triage_target_min = 2 → 5 წთ-ის მოლოდინი ვადაგადაცილებულია; counts.overdue ≥ 1" "$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$EN" '"\([.items[]|select(.encounter_id==$e)][0].timers.triage_overdue):\(.counts.overdue >= 1)"')" "true:true"
api PUT /modules/er "$ADM" -d '{"settings":{"triage_target_min":10},"reason":"ტესტ-E2E"}' >/dev/null
IU=$(echo "$BD" | jq -c --arg e "$EU" '.items[]|select(.encounter_id==$e)')
chk "უცნობი დაფაზე: is_unknown, ასაკი ~40, NEWS2 ბოლო ტრიაჟიდან (null — ESI 1 ვიტალების გარეშე), სასწრაფოს №" "$(echo "$IU" | jq -r '"\(.patient.is_unknown):\(.patient.age_estimated):\(.news2):\(.ambulance_crew == "E2E-'"$S"'")"')" "true:true:null:true"
chk "ადგილები: 3, თავისუფალი 1" "$(echo "$BD" | jq -r '.counts|"\(.spots_total):\(.spots_free)"')" "3:1"
TV=$(api GET "/er/board?department_id=$DER&tv=1" "$TR")
chk "TV: ინიციალები (ტ. E.), ჩივილი / პირადი № არ ჩანს; უცნობი — „უცნობი #N“" \
  "$(echo "$TV" | jq -r --arg e "$E1" '[.items[]|select(.encounter_id==$e)][0]|"\(.patient.name):\(has("chief_complaint")):\(.patient|has("personal_number"))"'):$(echo "$TV" | jq -r --arg e "$EU" '[.items[]|select(.encounter_id==$e)][0].patient.name')" "ტ. E.:false:false:უცნობი #$UNO"

step "5. აყვანა / მინიჭება"
chk "ტრიაჟის თანამშრომელი — აყვანა 403" "$(code POST "/er/visits/$E1/pickup" "$TR")" "403"
PK=$(api POST "/er/visits/$E1/pickup" "$DR")
chk "ექიმმა აიყვანა: in_treatment, doctor_at; encounters.attending_doctor_id" "$(echo "$PK" | jq -r '"\(.status):\(.doctor_id == "'"$DRID"'"):\(.doctor_at != null)"'):$(api GET "/encounters?patient_id=$P1" "$ADM" | jq -r --arg e "$E1" '.[]|select(.id==$e)|.doctor_name // .attending_doctor_id // "—"' | grep -c ER-12)" "in_treatment:true:true:1"
DA=$(echo "$PK" | jq -r .doctor_at)
chk "გადაბარება სხვა ექიმზე: „კარი → ექიმი“ არ იცვლება" "$(api POST "/er/visits/$E1/pickup" "$D2" | jq -r '"\(.doctor_id == "'"$D2ID"'"):\(.doctor_at == "'"$DA"'")"')" "true:true"
api PUT /modules/er "$ADM" -d '{"settings":{"doctor_before_triage":"block"},"reason":"ტესტ-E2E"}' >/dev/null
chk "doctor_before_triage = block: ტრიაჟამდე აყვანა — 409 ER_TRIAGE_REQUIRED" "$(api POST "/er/visits/$EN/pickup" "$DR" | jq -r .code)" "ER_TRIAGE_REQUIRED"
api PUT /modules/er "$ADM" -d '{"settings":{"doctor_before_triage":"allow"},"reason":"ტესტ-E2E"}' >/dev/null
chk "ადგილი: დაკავებულზე — 409; თავისუფალზე — 200" "$(code PATCH "/er/visits/$EN" "$TR" -d "{\"spot_id\":\"$SP1\"}"):$(code PATCH "/er/visits/$EN" "$TR" -d "{\"spot_id\":\"$SP3\"}")" "409:200"
chk "მოლოდინი (ანალიზი + კონსულტაცია); უცნობი მნიშვნელობა — 400" "$(api PATCH "/er/visits/$EN" "$TR" -d '{"waiting_for":["lab","consult"]}' | jq -r '.waiting_for|join(",")'):$(code PATCH "/er/visits/$EN" "$TR" -d '{"waiting_for":["xray"]}')" "lab,consult:400"
chk "ექიმად — მომხმარებელი er_doctor-ის გარეშე — 400; ექთანი — 200" "$(code PATCH "/er/visits/$EN" "$TR" -d "{\"doctor_id\":\"$TRID\"}"):$(code PATCH "/er/visits/$EN" "$TR" -d "{\"nurse_id\":\"$TRID\"}")" "400:200"
chk "ექიმის მინიჭება (ჯერ არ აუყვანია) — doctor_id, doctor_at = null; სტატუსი უცვლელი" "$(api PATCH "/er/visits/$EN" "$TR" -d "{\"doctor_id\":\"$DRID\"}" | jq -r '"\(.doctor_id == "'"$DRID"'"):\(.doctor_at):\(.status)"')" "true:null:waiting"
chk "staff: ექიმები / ექთნები" "$(api GET /er/staff "$TR" | jq -r --arg d "$DRID" --arg n "$TRID" '"\([.doctors[].id]|index($d) != null):\([.nurses[].id]|index($n) != null)"')" "true:true"

step "6. გაუქმება (შეცდომით რეგისტრაცია)"
chk "ტრიაჟის თანამშრომელი: ტრიაჟის შემდეგ — 403" "$(code POST "/er/visits/$ECH/cancel" "$TR" -d '{"reason":"ტესტ-E2E"}')" "403"
X=$(reg "$TR" "{\"patient_id\":\"$P3\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E დუბლიკატი\",\"spot_id\":\"$SP1\"}" 2>/dev/null); EX=$(keep "$X")
[ -z "$EX" ] && { X=$(reg "$TR" "{\"patient_id\":\"$P3\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E დუბლიკატი\"}"); EX=$(keep "$X"); }
CX=$(api POST "/er/visits/$EX/cancel" "$TR" -d '{"reason":"ტესტ-E2E შეცდომით"}')
chk "ტრიაჟამდე — 200: cancelled, ended_at, ადგილი თავისუფალი; encounter cancelled" "$(echo "$CX" | jq -r '"\(.status):\(.ended_at != null):\(.spot_id)"'):$(api GET "/encounters?patient_id=$P3" "$ADM" | jq -r --arg e "$EX" '.[]|select(.id==$e)|.status')" "cancelled:true:null:cancelled"
chk "დახურულზე ტრიაჟი — 409" "$(code POST "/er/visits/$EX/triage" "$TR" -d '{"level":3}')" "409"
chk "მენეჯერი: ტრიაჟის შემდეგ — 200; ისტორია ჩანს (GET)" "$(code POST "/er/visits/$ECH/cancel" "$MG" -d '{"reason":"ტესტ-E2E"}'):$(api GET "/er/visits/$ECH" "$TR" | jq -r '.triage|length')" "200:1"
chk "პაციენტის ER-ისტორია" "$(api GET "/er/patients/$PCH/visits" "$TR" | jq -r '.[0].status')" "cancelled"

step "7. უცნობის იდენტიფიკაცია / გაერთიანება"
chk "იდენტიფიკაცია — არსებული პირადი ნომრით — 409 PATIENT_EXISTS" "$(api POST "/patients/$PU/identify" "$TR" -d "{\"first_name\":\"ა\",\"last_name\":\"ბ\",\"birth_date\":\"1984-04-04\",\"gender\":\"male\",\"personal_number\":\"$(pid 5 3)\"}" | jq -r '.code + ":" + (.patient.id == "'"$P3"'"|tostring)')" "PATIENT_EXISTS:true"
chk "იდენტიფიკაცია — ER-ის ექიმს (er_doctor) — 403" "$(code POST "/patients/$PU/identify" "$DR" -d "{\"first_name\":\"ა\",\"last_name\":\"ბ\",\"birth_date\":\"1984-04-04\",\"gender\":\"male\",\"personal_number\":\"$(pid 5 6)\"}")" "403"
# მეორე უცნობი (ალერგიით) → გაერთიანება ნამდვილ P3-თან
RU2=$(reg "$TR" "{\"new_patient\":{\"gender\":\"female\",\"age_years\":50,\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ER-დაუდასტ\"},\"department_id\":\"$DER\",\"arrival_mode\":\"police\",\"chief_complaint\":\"ტესტ-E2E ტრავმა\"}")
EU2=$(keep "$RU2"); PU2=$(echo "$RU2" | jq -r '.patient.id // empty')
chk "სახელით, საბუთის გარეშე — დაუდასტურებელი (is_unknown, სახელი რჩება)" "$(api GET "/patients/$PU2" "$ADM" | jq -r '"\(.is_unknown):\(.last_name)"')" "true:ER-დაუდასტ"
api POST "/er/visits/$EU2/triage" "$TR" -d "{\"level\":3,\"vitals\":$V7}" >/dev/null
api POST "/patients/$PU2/allergies" "$ADM" -d '{"substance":"ტესტ-E2E პენიცილინი","allergy_type":"allergy","severity":"severe"}' >/dev/null
PV=$(api GET "/patients/$PU2/merge-preview?target_id=$P1" "$MG")
chk "preview: გადავა encounters / er_visits (+ ალერგია), პრობლემა არ არის" "$(echo "$PV" | jq -r '"\(.counts.encounters):\(.counts.er_visits):\(.problems|length)"')" "1:1:0"
MC=$(api POST "/patients/$PU2/merge" "$MG" -d "{\"target_id\":\"$P1\",\"reason\":\"ტესტ-E2E\"}")
chk "გაერთიანება ნამდვილთან, რომელსაც უკვე აქვს აქტიური ER — 409 MERGE_CONFLICT (er_visits), არაფერი შეცვლილა" \
  "$(echo "$MC" | jq -r '.code + ":" + (.table // "")'):$(api GET "/patients/$PU2" "$ADM" | jq -r '.merged_into_id'):$(api GET "/er/visits/$EU2" "$TR" | jq -r '.patient_id == "'"$PU2"'"')" "MERGE_CONFLICT:er_visits:null:true"
chk "გაერთიანება — ტრიაჟის თანამშრომელს — 403" "$(code POST "/patients/$PU2/merge" "$TR" -d "{\"target_id\":\"$P3\",\"reason\":\"ტესტ-E2E\"}")" "403"
chk "გაერთიანება: წყარო არ არის უცნობი — 409" "$(api POST "/patients/$P1/merge" "$MG" -d "{\"target_id\":\"$P3\",\"reason\":\"ტესტ-E2E\"}" | jq -r .code)" "MERGE_SRC_NOT_UNKNOWN"
chk "გაერთიანება: სამიზნე უცნობია — 409" "$(api POST "/patients/$PU2/merge" "$MG" -d "{\"target_id\":\"$PU\",\"reason\":\"ტესტ-E2E\"}" | jq -r .code)" "MERGE_DST_UNKNOWN"
MG1=$(api POST "/patients/$PU2/merge" "$MG" -d "{\"target_id\":\"$P3\",\"reason\":\"ტესტ-E2E იდენტიფიცირდა\"}")
chk "გაერთიანება P3-თან: გადავიდა encounters / er_visits / ალერგია" "$(echo "$MG1" | jq -r '"\(.merged_into_id == "'"$P3"'"):\(.moved.encounters):\(.moved.er_visits):\(.moved.patient_allergies)"')" "true:1:1:1"
chk "ER-ის შემთხვევა + ტრიაჟი — ნამდვილ პაციენტზე; ალერგია ჩანს" "$(api GET "/er/visits/$EU2" "$TR" | jq -r '"\(.patient_id == "'"$P3"'"):\(.triage|length):\(.allergies|length)"')" "true:1:1"
chk "წყარო: merged_into_id, ძებნაში აღარ ჩანს; რედაქტირება — 409" "$(api GET "/patients/$PU2" "$ADM" | jq -r '.merged_into_id == "'"$P3"'"'):$(api GET "/patients?search=$(jq -rn '"ER-დაუდასტ"|@uri')" "$ADM" | jq -r --arg p "$PU2" '[.[]|select(.id==$p)]|length'):$(code PATCH "/patients/$PU2" "$ADM" -d '{"first_name":"x"}')" "true:0:409"
chk "აუდიტი: PATIENT_MERGE (+ რაოდენობები)" "$(api GET "/audit-logs?entity_name=patients&entity_id=$PU2" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|select(.action=="PATIENT_MERGE")]|length')" "1"
ID1=$(api POST "/patients/$PU/identify" "$TR" -d "{\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ER-იდენტ\",\"birth_date\":\"1984-04-04\",\"gender\":\"male\",\"personal_number\":\"$(pid 5 6)\"}")
chk "იდენტიფიკაცია (ახალი პირადი №): is_unknown = false, birth_date ზუსტი, unknown_no რჩება (ისტორია)" "$(echo "$ID1" | jq -r '"\(.is_unknown):\(.birth_date_estimated):\(.birth_date):\(.unknown_no == '"$UNO"')"')" "false:false:1984-04-04:true"
chk "მეორედ — 409" "$(code POST "/patients/$PU/identify" "$TR" -d "{\"first_name\":\"ა\",\"last_name\":\"ბ\",\"birth_date\":\"1984-04-04\",\"gender\":\"male\",\"personal_number\":\"$(pid 5 7)\"}")" "409"

step "8. ცნობარები: შემოსვლის გზა, საკუთარი შკალა"
AMC="e2e_am_$S"
chk "შემოსვლის გზა: დამატება / დუბლიკატი 409 / ტრიაჟის თანამშრომელს 403" "$(code POST /er/admin/arrival-modes "$MG" -d "{\"code\":\"$AMC\",\"name\":\"ტესტ-E2E ვერტმფრენი\",\"kind\":\"ambulance\"}"):$(code POST /er/admin/arrival-modes "$MG" -d "{\"code\":\"$AMC\",\"name\":\"ტესტ-E2E დუბლი\",\"kind\":\"other\"}"):$(code POST /er/admin/arrival-modes "$TR" -d '{"code":"e2e_x","name":"xx"}')" "201:409:403"
SC="E2E$S"
SCR=$(api POST /er/admin/scales "$MG" -d "{\"code\":\"$SC\",\"name\":\"ტესტ-E2E 3-დონიანი\",\"levels\":[{\"level\":1,\"name\":\"წითელი\",\"color\":\"#cc0000\",\"target_doctor_min\":0},{\"level\":2,\"name\":\"ყვითელი\",\"color\":\"#ffcc00\",\"target_doctor_min\":30,\"retriage_min\":30},{\"level\":3,\"name\":\"მწვანე\",\"color\":\"#00aa00\",\"target_doctor_min\":120}]}")
chk "საკუთარი შკალა: 3 დონე" "$(echo "$SCR" | jq -r '.levels|length')" "3"
chk "მოდულის პარამეტრი triage_scale = საკუთარი — 200; ტრიაჟი მის დონეებზე; დონე 4 — 400" "$(code PUT /modules/er "$ADM" -d "{\"settings\":{\"triage_scale\":\"$SC\"},\"reason\":\"ტესტ-E2E\"}"):$(api POST "/er/visits/$EN/triage" "$TR" -d '{"level":2}' | jq -r .scale_code):$(code POST "/er/visits/$EN/triage" "$TR" -d '{"level":4}')" "200:$SC:400"
chk "მოქმედი შკალის გათიშვა — 409" "$(code PATCH "/er/admin/scales/$SC" "$MG" -d '{"is_active":false}')" "409"
api PUT /modules/er "$ADM" -d '{"settings":{"triage_scale":"ESI"},"reason":"ტესტ-E2E"}' >/dev/null
chk "დონის რედაქტირება (სამიზნე 45 წთ) — დაფაზე ჩანს" "$(code PATCH "/er/admin/scales/$SC" "$MG" -d '{"levels":[{"level":2,"name":"ყვითელი","color":"#ffcc00","target_doctor_min":45}]}'):$(api GET "/er/board?department_id=$DER" "$TR" | jq -r --arg e "$EN" '.items[]|select(.encounter_id==$e)|.triage.target_doctor_min')" "200:45"
chk "დაკავებული ადგილის გათიშვა — 409" "$(code PATCH "/er/admin/spots/$SP3" "$MG" -d '{"is_active":false}')" "409"

step "9. მოდულის გამორთვა / რბილი კავშირი roster"
setm roster '"enabled":false' >/dev/null
chk "roster გამორთულია → დაფა 200, „მორიგე“ ცარიელი" "$(code GET "/er/board?department_id=$DER" "$TR"):$(api GET "/er/board?department_id=$DER" "$TR" | jq -r '.on_duty|length')" "200:0"
[ "$(echo "$ORIG_RO" | jq -r .enabled)" = "true" ] && setm roster '"enabled":true' >/dev/null
chk "er გამორთვა — 200" "$(setm er '"enabled":false' | jq -r '.enabled')" "false"
chk "er გამორთულია: დაფა / რეგისტრაცია — 403 MODULE_DISABLED" "$(api GET /er/board "$TR" | jq -r .code):$(code POST /er/visits "$TR" -d "{\"patient_id\":\"$P3\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"x\"}")" "MODULE_DISABLED:403"
chk "er გამორთულია: ისტორია ჩანს (@ClinicalHistory) — ბარათი / პაციენტის ER-ები 200; ტრიაჟი 403" "$(code GET "/er/visits/$EU" "$TR"):$(code GET "/er/patients/$P3/visits" "$TR"):$(code POST "/er/visits/$EN/triage" "$TR" -d '{"level":3}')" "200:200:403"
chk "er გამორთულია: მომიჯნავე — პაციენტები / შემთხვევები / სტაციონარი არ ვარდება" "$(code GET "/patients?search=ER-%E1%83%A1" "$ADM"):$(code GET "/encounters?patient_id=$P1" "$ADM"):$(code GET /inpatient/census "$ADM")" "200:200:200"
setm er '"enabled":true' >/dev/null
chk "er ჩართვა — აქტიური, დაფა 200" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="er")|.state'):$(code GET /er/board "$TR")" "active:200"

step "10. დასრულება"
cleanup; trap - EXIT
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")|{enabled, settings}')" "$ORIG_ER"
chk "ER-ის დაფაზე სატესტო შემთხვევა აღარ არის" "$(api GET /er/board "$ADM" | jq -r --arg d "$DER" '[.items[]|select(.department_id==$d)]|length')" "0"
ok "სატესტო ჩანაწერები გაუქმებულია / გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
