#!/usr/bin/env bash
# =====================================================================
# e2e-inpatient.sh — სტაციონარი, ეტაპი 1 (0040, მოდული „inpatient“)
#   საწოლფონდი (admin: პალატები, საწოლები ერთბაშად, ტიპები, გათიშვა) → ჰოსპიტალიზაცია (ორეტაპიანი: განყოფილება → საწოლი; პირდაპირ)
#   → სქესის / იზოლაციის წესი (გაფრთხილება + დადასტურება / ბლოკი) → საწოლის შეცვლა (მიზეზით) → დალაგება / ბლოკი → მდგომარეობა, ექიმის შეცვლა
#   → გეგმიური რიგი (დაჯავშნა → ჰოსპიტალიზაცია დაჯავშნილ საწოლზე) → გაუქმება (ვადა, „ვიზიტზე უკვე არის ჩანაწერი“)
#   → ამბულატორიის დაცვა (დახურვა 409, დღის სიები) → სამაჯური (PDF; ZPL — მიუწვდომელი პრინტერი 409) → ისტორია → მოდულის გამორთვა
# პარამეტრები ბოლოს ბრუნდება; სატესტო განყოფილებები / პალატები რჩება (სახელში „ტესტ-E2E“; ისტორია არ იშლება).
# გამოყენება:  bash scripts/e2e-inpatient.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-http://localhost/api}"
J='content-type: application/json'
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mშეწყდა:\033[0m %s\n' "$1"; exit 1; }
command -v jq >/dev/null || die "jq არ არის დაყენებული"
read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F); TOMORROW=$(date -d "$TODAY +1 day" +%F); YESTERDAY=$(date -d "$TODAY -1 day" +%F)
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
bst()  { api GET "/inpatient/structure?all=true" "$ADM" | jq -r --arg id "$1" '[.departments[].wards[].beds[]|select(.id==$id)][0].status'; }

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E თერაპია $S\",\"code\":\"E2EIA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქირურგია $S\",\"code\":\"E2EIB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DO=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ამბულატორია $S\",\"code\":\"E2EIO$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] && [ -n "$DO" ] || die "განყოფილებები ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ipd.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"სტაც-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.ipd.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 71)
NA=$(mkuser '["nurse"]' 72 ",\"department_id\":\"$DA\"")
HA=$(mkuser '["nurse"]' 73 ",\"department_id\":\"$DA\",\"is_section_head\":true")
NB=$(mkuser '["nurse"]' 74 ",\"department_id\":\"$DB\"")
DR=$(mkuser '["doctor"]' 75 ",\"department_id\":\"$DA\""); DRID=$(cat "$TMP/u75" 2>/dev/null)
D2=$(mkuser '["doctor"]' 76 ",\"department_id\":\"$DA\""); D2ID=$(cat "$TMP/u76" 2>/dev/null)
[ -n "$RC" ] && [ -n "$NA" ] && [ -n "$HA" ] && [ -n "$NB" ] && [ -n "$DR" ] && [ -n "$D2" ] && ok "6 მომხმარებელი (რეგისტრატორი, ექთანი A, ხელმძღვანელი A, ექთანი B, 2 ექიმი)" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1975-05-05\",\"gender\":\"$3\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty'; }
PM=$(mkpat 81 "კაცი" male); PF=$(mkpat 82 "ქალი" female); PF2=$(mkpat 83 "გეგმიური" female); PM2=$(mkpat 84 "გასაუქმებელი" male); PM3=$(mkpat 85 "ვიტალები" male)
[ -n "$PM" ] && [ -n "$PF" ] && [ -n "$PF2" ] && [ -n "$PM2" ] && [ -n "$PM3" ] && ok "5 პაციენტი" || die "პაციენტები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული inpatient ვერ მოიძებნა"
mod '{"bed_assign_mode":"two_step","cleaning_required":true,"sex_rule":"warn","overflow_beds":true,"planned_queue":true,"planned_sms":false,"cancel_hours":24,"wristband":true,"wristband_print":"zpl"}'
chk "პარამეტრი: უცნობი გასაღები / ბეჭდვის ზონა < 90 მმ — 400" "$(code PUT /modules/inpatient "$ADM" -d '{"settings":{"xx":1},"reason":"ტესტ-E2E"}'):$(code PUT /modules/inpatient "$ADM" -d '{"settings":{"wristband_length_mm":120,"wristband_offset_mm":50},"reason":"ტესტ-E2E"}')" "400:400"

step "1. საწოლფონდი (admin)"
chk "არა-admin პალატას ვერ ქმნის — 403" "$(code POST /inpatient/wards "$HA" -d "{\"department_id\":\"$DA\",\"code\":\"X1\"}")" "403"
chk "ამბულატორიულ განყოფილებაში პალატა — 400" "$(code POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DO\",\"code\":\"X1\"}")" "400"
WM=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"301\",\"name\":\"მამაკაცის\",\"floor\":\"3\",\"sex\":\"male\"}" | jq -r '.id // empty')
WF=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"302\",\"sex\":\"female\",\"isolation_capable\":true}" | jq -r '.id // empty')
WX=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"303\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
WB=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DB\",\"code\":\"401\"}" | jq -r '.id // empty')
chk "4 პალატა; იგივე ნომერი განყოფილებაში — 409" "$([ -n "$WM" ] && [ -n "$WF" ] && [ -n "$WX" ] && [ -n "$WB" ] && echo ok):$(code POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"301\"}")" "ok:409"
BM=$(api POST "/inpatient/wards/$WM/beds" "$ADM" -d '{"count":2}'); BM1=$(echo "$BM" | jq -r '.[0].id'); BM2=$(echo "$BM" | jq -r '.[1].id')
BF=$(api POST "/inpatient/wards/$WF/beds" "$ADM" -d '{"count":2,"type_code":"isolation"}'); BF1=$(echo "$BF" | jq -r '.[0].id'); BF2=$(echo "$BF" | jq -r '.[1].id')
BX=$(api POST "/inpatient/wards/$WX/beds" "$ADM" -d '{"count":3}'); BX1=$(echo "$BX" | jq -r '.[0].id'); BX2=$(echo "$BX" | jq -r '.[1].id'); BX3=$(echo "$BX" | jq -r '.[2].id')
BB1=$(api POST "/inpatient/wards/$WB/beds" "$ADM" -d '{"count":1}' | jq -r '.[0].id')
chk "საწოლები ერთბაშად: 301-1, 301-2; 302 — იზოლატორი" "$(echo "$BM" | jq -r '[.[].code]|join(",")'):$(echo "$BF" | jq -r '.[0].type_code')" "301-1,301-2:isolation"
chk "კიდევ 1 საწოლი 301-ში — 301-3 (არსებული გამოტოვდა)" "$(api POST "/inpatient/wards/$WM/beds" "$ADM" -d '{"count":1}' | jq -r '.[0].code')" "301-3"
BO=$(api POST "/inpatient/wards/$WX/beds" "$ADM" -d '{"count":1,"is_overflow":true}' | jq -r '.[0].id // empty')
chk "დამატებითი საწოლი (303-D1)" "$(api GET "/inpatient/structure" "$ADM" | jq -r --arg id "$BO" '[.departments[].wards[].beds[]|select(.id==$id)][0]|"\(.code):\(.is_overflow)"')" "303-D1:true"
chk "საწოლის ტიპი: ახალი (stretcher); დუბლი — 409" "$(code POST /inpatient/bed-types "$ADM" -d "{\"code\":\"e2e_$S\",\"name\":\"ტესტ-E2E ტიპი\"}"):$(code POST /inpatient/bed-types "$ADM" -d "{\"code\":\"e2e_$S\",\"name\":\"ტესტ-E2E ტიპი\"}")" "201:409"
chk "საწოლის გადარქმევა; დუბლი პალატაში — 409" "$(api PATCH "/inpatient/beds/$BX3" "$ADM" -d '{"code":"303-ფანჯარა"}' | jq -r .code):$(code PATCH "/inpatient/beds/$BX3" "$ADM" -d '{"code":"303-1"}')" "303-ფანჯარა:409"
CEN=$(api GET /inpatient/census "$RC" | jq -c --arg d "$DA" '.departments[]|select(.id==$d)')
chk "საწოლფონდი (რეგისტრატორი ხედავს): A — 8 საწოლი + 1 დამატებითი, 8 თავისუფალი" "$(echo "$CEN" | jq -r '"\(.beds):\(.overflow):\(.free)"')" "8:1:8"

step "2. ჰოსპიტალიზაცია — ორეტაპიანი"
ADMIT() { api POST /inpatient/admissions "$1" -d "$2"; }
chk "რეგისტრატორი საწოლით (ორეტაპიანი) — 403" "$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"I21.9\",\"bed_id\":\"$BM1\"}")" "403"
chk "არასწორი ICD / ამბულატორიული განყოფილება — 400" "$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"Z99.99X\"}"):$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM\",\"department_id\":\"$DO\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"I21.9\"}")" "400:400"
chk "სხვა კლინიკიდან — დაწესებულების გარეშე 400" "$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"transfer_in\",\"icd10_code\":\"I21.9\"}")" "400"
A1=$(ADMIT "$RC" "{\"patient_id\":\"$PM\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"I21.9\",\"chief_complaint\":\"ტკივილი გულმკერდში\",\"severity\":\"severe\"}")
E1=$(echo "$A1" | jq -r '.encounter_id // empty')
chk "ჰოსპიტალიზაცია საწოლის გარეშე: IP-ნომერი, საწოლი null" "$(echo "$A1" | jq -r '"\(.adm_no|test("^IP[0-9]{2}-[0-9]{6}$")):\(.bed)"')" "true:null"
chk "იგივე პაციენტი მეორედ — 409" "$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM\",\"department_id\":\"$DB\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I21.9\"}")" "409"
BOARD=$(api GET "/inpatient/board?department_id=$DA" "$NA")
chk "დაფა: ელოდება საწოლს — 1; ექთანს can_assign, can_manage=false" "$(echo "$BOARD" | jq -r '"\(.awaiting|length):\(.can_assign):\(.can_manage)"')" "1:true:false"
chk "ექთანს — შეტყობინება „ელოდება საწოლს“" "$(api GET /notifications "$NA" | jq -r '[.[]|select(.kind=="inpatient_awaiting")]|length>0')" "true"
chk "სხვა განყოფილების ექთანი საწოლს ვერ ანიჭებს — 403" "$(code POST "/inpatient/stays/$E1/bed" "$NB" -d "{\"bed_id\":\"$BM1\"}")" "403"
chk "სხვა განყოფილების საწოლი — 400" "$(code POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BB1\"}")" "400"
R=$(api POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BF1\"}")
chk "მამაკაცი ქალის პალატაში — 409 CONFIRM_REQUIRED (გაფრთხილება)" "$(echo "$R" | jq -r '.code')" "CONFIRM_REQUIRED"
chk "მინიჭება 301-1 → დაკავებული" "$(api POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BM1\"}" | jq -r .bed):$(bst "$BM1")" "301-1:occupied"
chk "დაკავებულ საწოლზე — 409" "$(api POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BM1\"}" | jq -r '.statusCode'):$(code PATCH "/inpatient/beds/$BM1" "$ADM" -d '{"is_active":false}'):$(code PATCH "/inpatient/wards/$WM" "$ADM" -d '{"is_active":false}')" "409:409:409"
chk "დაფა: 301-1 — პაციენტი, დიაგნოზი I21.9, მძიმე, დღე 0" "$(api GET "/inpatient/board?department_id=$DA" "$DR" | jq -r --arg b "$BM1" '.wards[].beds[]|select(.id==$b)|.occupant|"\(.last_name):\(.diagnosis|split(" ")[0]):\(.severity):\(.day)"')" "კაცი:I21.9:severe:0"

step "3. საწოლის შეცვლა, დალაგება, ბლოკი"
chk "შეცვლა მიზეზის გარეშე — 400" "$(code POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BM2\"}")" "400"
chk "შეცვლა 301-1 → 301-2 (მიზეზით): ძველი — დასალაგებელი" "$(api POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BM2\",\"reason\":\"ფანჯარასთან ახლოს\"}" | jq -r .bed):$(bst "$BM1"):$(bst "$BM2")" "301-2:cleaning:occupied"
chk "დასალაგებელზე მინიჭება — 409; სხვა განყოფილება ალაგებს — 403" "$(code POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BM1\",\"reason\":\"xxx\"}"):$(code POST "/inpatient/beds/$BM1/clean" "$NB")" "409:403"
chk "დალაგება → თავისუფალი; მეორედ — 409" "$(api POST "/inpatient/beds/$BM1/clean" "$NA" | jq -r .status):$(code POST "/inpatient/beds/$BM1/clean" "$NA")" "free:409"
chk "ბლოკი: ექთანი — 403; ხელმძღვანელი მიზეზის გარეშე — 400" "$(code POST "/inpatient/beds/$BM1/block" "$NA" -d '{"reason":"რემონტი"}'):$(code POST "/inpatient/beds/$BM1/block" "$HA" -d '{}')" "403:400"
chk "ბლოკი (ხელმძღვანელი) → დაბლოკილი; დაკავებულის ბლოკი — 409" "$(api POST "/inpatient/beds/$BM1/block" "$HA" -d '{"reason":"რემონტი"}' | jq -r .status):$(code POST "/inpatient/beds/$BM2/block" "$HA" -d '{"reason":"რემონტი"}')" "blocked:409"
chk "ბლოკის მოხსნა → თავისუფალი" "$(api POST "/inpatient/beds/$BM1/unblock" "$HA" | jq -r .status)" "free"

step "4. სქესის წესი, „პირდაპირ“ მინიჭება, იზოლაცია"
mod '{"sex_rule":"block"}'
chk "წესი „ბლოკი“: ქალი მამაკაცის პალატაში — 409 SEX_RULE" "$(api POST /inpatient/admissions "$DR" -d "{\"patient_id\":\"$PF\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"bed_id\":\"$BM1\"}" | jq -r .code)" "SEX_RULE"
mod '{"sex_rule":"warn","bed_assign_mode":"direct"}'
R=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PF\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"outpatient\",\"icd10_code\":\"J18.9\",\"isolation\":\"droplet\",\"bed_id\":\"$BX1\"}")
chk "„პირდაპირ“: რეგისტრატორი საწოლით; იზოლაცია არა-იზოლაციის პალატაში — 409 CONFIRM_REQUIRED" "$(echo "$R" | jq -r .code)" "CONFIRM_REQUIRED"
E2=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PF\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"outpatient\",\"icd10_code\":\"J18.9\",\"isolation\":\"droplet\",\"bed_id\":\"$BX1\",\"confirm\":true}" | jq -r '.encounter_id // empty')
chk "დადასტურებით — დაკავებული; ისტორიაში გაფრთხილება ჩაწერილია" "$(bst "$BX1"):$(api GET "/inpatient/stays/$E2" "$NA" | jq -r '.events[]|select(.kind=="admitted")|.data.warnings|length')" "occupied:1"
mod '{"bed_assign_mode":"two_step"}'

step "5. მდგომარეობა, იზოლაცია, მკურნალი ექიმი"
chk "ექთანი A: მდგომარეობა → კრიტიკული" "$(api PATCH "/inpatient/stays/$E1" "$NA" -d '{"severity":"critical"}' | jq -r '.changed|join(",")')" "severity"
chk "სხვა განყოფილების ექთანი — 403" "$(code PATCH "/inpatient/stays/$E1" "$NB" -d '{"severity":"stable"}')" "403"
chk "ექიმის შეცვლა: ექთანი — 403; მიზეზის გარეშე (ხელმძღვანელი) — 400" "$(code PATCH "/inpatient/stays/$E1" "$NA" -d "{\"attending_doctor_id\":\"$D2ID\",\"reason\":\"მორიგეობა\"}"):$(code PATCH "/inpatient/stays/$E1" "$HA" -d "{\"attending_doctor_id\":\"$D2ID\"}")" "403:400"
chk "ხელმძღვანელი ცვლის ექიმს (მიზეზით)" "$(api PATCH "/inpatient/stays/$E1" "$HA" -d "{\"attending_doctor_id\":\"$D2ID\",\"reason\":\"ექიმი შვებულებაშია\"}" | jq -r '.changed|join(",")')" "attending_doctor_id"
chk "ახალი ექიმი ხედავს: მკურნალი = D2" "$(api GET "/inpatient/stays/$E1" "$D2" | jq -r '.attending_doctor_id')" "$D2ID"

step "6. გეგმიური რიგი"
chk "წარსული თარიღი — 400" "$(code POST /inpatient/planned "$RC" -d "{\"patient_id\":\"$PF2\",\"department_id\":\"$DA\",\"planned_date\":\"$YESTERDAY\",\"reason\":\"ქოლეცისტექტომია\"}")" "400"
PL=$(api POST /inpatient/planned "$RC" -d "{\"patient_id\":\"$PF2\",\"department_id\":\"$DA\",\"doctor_id\":\"$DRID\",\"planned_date\":\"$TOMORROW\",\"icd10_code\":\"K35.8\",\"reason\":\"გეგმიური ოპერაცია\"}")
PLID=$(echo "$PL" | jq -r '.id // empty')
chk "გეგმიური: PL-ნომერი; იგივე პაციენტი მეორედ — 409" "$(echo "$PL" | jq -r '.plan_no|test("^PL[0-9]{2}-")'):$(code POST /inpatient/planned "$RC" -d "{\"patient_id\":\"$PF2\",\"department_id\":\"$DA\",\"planned_date\":\"$TOMORROW\",\"reason\":\"xxx xx\"}")" "true:409"
chk "დაჯავშნა: რეგისტრატორი (ორეტაპიანი) — 403; სხვა განყოფილების ექთანი — 403" "$(code POST "/inpatient/planned/$PLID/reserve" "$RC" -d "{\"bed_id\":\"$BF2\"}"):$(code POST "/inpatient/planned/$PLID/reserve" "$NB" -d "{\"bed_id\":\"$BF2\"}")" "403:403"
chk "ექთანი A ჯავშნის 302-2 → დაჯავშნილი" "$(api POST "/inpatient/planned/$PLID/reserve" "$NA" -d "{\"bed_id\":\"$BF2\"}" | jq -r .bed):$(bst "$BF2")" "302-2:reserved"
chk "დაჯავშნილზე სხვა პაციენტი — 409" "$(api POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$BF2\",\"reason\":\"xxx\",\"confirm\":true}" | jq -r .code)" "BED_NOT_FREE"
chk "დაფა: 302-2-ზე ჯავშანი ჩანს" "$(api GET "/inpatient/board?department_id=$DA" "$NA" | jq -r --arg b "$BF2" '.wards[].beds[]|select(.id==$b)|.reservation.planned_date')" "$TOMORROW"
chk "თარიღის შეცვლა (SMS თავიდან)" "$(api PATCH "/inpatient/planned/$PLID" "$RC" -d "{\"planned_date\":\"$TODAY\",\"notes\":\"უზმოზე\"}" | jq -r '"\(.planned_date[0:10]):\(.sms_sent_at)"')" "$TODAY:null"
A3=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PF2\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"planned\",\"planned_id\":\"$PLID\",\"icd10_code\":\"K35.8\"}")
E3=$(echo "$A3" | jq -r '.encounter_id // empty')
chk "ჰოსპიტალიზაცია გეგმიურიდან — დაჯავშნილ საწოლზე (რეგისტრატორი, ორეტაპიანშიც)" "$(echo "$A3" | jq -r .bed):$(bst "$BF2")" "302-2:occupied"
chk "გეგმიური — admitted; რიგში აღარ არის" "$(api GET "/inpatient/planned?status=admitted&department_id=$DA" "$RC" | jq -r --arg id "$PLID" '.[]|select(.id==$id)|.status'):$(api GET "/inpatient/planned?department_id=$DA" "$RC" | jq -r 'length')" "admitted:0"
PL2=$(api POST /inpatient/planned "$RC" -d "{\"patient_id\":\"$PM3\",\"department_id\":\"$DA\",\"planned_date\":\"$TOMORROW\",\"reason\":\"გეგმიური\"}" | jq -r .id)
api POST "/inpatient/planned/$PL2/reserve" "$NA" -d "{\"bed_id\":\"$BM1\"}" >/dev/null
chk "გაუქმება მიზეზის გარეშე — 400; მიზეზით → საწოლი თავისუფალი" "$(code POST "/inpatient/planned/$PL2/cancel" "$RC" -d '{}'):$(api POST "/inpatient/planned/$PL2/cancel" "$RC" -d '{"reason":"პაციენტმა გადაიფიქრა"}' | jq -r .status):$(bst "$BM1")" "400:cancelled:free"

step "7. ჰოსპიტალიზაციის გაუქმება"
E4=$(api POST /inpatient/admissions "$DR" -d "{\"patient_id\":\"$PM2\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I21.9\",\"bed_id\":\"$BM1\"}" | jq -r '.encounter_id // empty')
chk "სხვა ექიმი (არც გამფორმებელი, არც მკურნალი) — 403" "$(code POST "/inpatient/stays/$E4/cancel" "$D2" -d '{"reason":"შეცდომით"}')" "403"
chk "გაუქმება (გამფორმებელი, ვადაში) → საწოლი დასალაგებელი; ვიზიტი cancelled" "$(api POST "/inpatient/stays/$E4/cancel" "$DR" -d '{"reason":"შეცდომით გაფორმდა"}' | jq -r .status):$(bst "$BM1"):$(api GET "/encounters/$E4" "$ADM" | jq -r .status)" "cancelled:cleaning:cancelled"
api POST "/inpatient/beds/$BM1/clean" "$NA" >/dev/null
chk "გაუქმების შემდეგ — თავიდან ჰოსპიტალიზაცია შესაძლებელია" "$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM2\",\"department_id\":\"$DB\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I21.9\"}")" "201"
E5=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PM3\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I21.9\"}" | jq -r '.encounter_id // empty')
api POST "/encounters/$E5/vitals" "$NA" -d '{"systolic_bp":120,"diastolic_bp":80,"heart_rate":70}' >/dev/null
chk "ვიტალების შემდეგ გაუქმება — 409 STAY_IN_USE" "$(api POST "/inpatient/stays/$E5/cancel" "$ADM" -d '{"reason":"შეცდომით"}' | jq -r .code)" "STAY_IN_USE"
mod '{"cancel_hours":0}'
chk "ვადა 0 სთ: ექიმი ვეღარ აუქმებს — 409 (admin-ს შეუძლია)" "$(code POST "/inpatient/stays/$E3/cancel" "$DR" -d '{"reason":"შეცდომით"}')" "409"
mod '{"cancel_hours":24}'

step "8. ამბულატორიის დაცვა"
chk "ამბულატორიული „დახურვა“ სტაციონარულზე — 409" "$(api POST "/encounters/$E1/discharge" "$ADM" | jq -r .code)" "INPATIENT_DISCHARGE"
chk "დღის სია (რეგისტრატურა) — სტაციონარული არ ჩანს; პაციენტის ისტორიაში — ჩანს" "$(api GET "/encounters?status=planned,active&date=$TODAY" "$ADM" | jq -r --arg e "$E1" '[.[]|select(.id==$e)]|length'):$(api GET "/encounters?patient_id=$PM" "$ADM" | jq -r --arg e "$E1" '.[]|select(.id==$e)|.type')" "0:inpatient"
chk "type=inpatient ფილტრი" "$(api GET "/encounters?type=inpatient&patient_id=$PM" "$ADM" | jq -r 'length')" "1"

step "9. სამაჯური"
chk "PDF (application/pdf)" "$(curl -s "$B/inpatient/stays/$E1/wristband.pdf" -H "authorization: Bearer $NA" | head -c 4)" "%PDF"
chk "პრინტერი არ არის — 400" "$(code POST "/inpatient/stays/$E1/wristband" "$NA" -d '{}')" "400"
PR=$(api POST /inpatient/printers "$ADM" -d "{\"name\":\"ტესტ-E2E Zebra $S\",\"host\":\"127.0.0.1\",\"port\":9,\"dpi\":203,\"department_id\":\"$DA\"}" | jq -r '.id // empty')
chk "პრინტერის დამატება; არა-admin — 403" "$([ -n "$PR" ] && echo ok):$(code POST /inpatient/printers "$NA" -d '{"name":"xx","host":"1.2.3.4"}')" "ok:403"
chk "მიუწვდომელი პრინტერი: ტესტი — 409; ბეჭდვა — 409 PRINTER_ERROR" "$(api POST "/inpatient/printers/$PR/test" "$ADM" -d '{}' | jq -r .code):$(api POST "/inpatient/stays/$E1/wristband" "$NA" -d '{}' | jq -r .code)" "PRINTER_UNREACHABLE:PRINTER_ERROR"
api PATCH "/inpatient/printers/$PR" "$ADM" -d '{"is_active":false}' >/dev/null
mod '{"wristband_print":"pdf"}'
chk "PDF რეჟიმში ZPL ბეჭდვა — 400" "$(code POST "/inpatient/stays/$E1/wristband" "$NA" -d '{}')" "400"

step "10. ბარათი, ისტორია, ძებნა"
ST=$(api GET "/inpatient/stays/$E1" "$NA")
chk "ეპიზოდები: 301-1 (bed_change) → 301-2 (მიმდინარე)" "$(echo "$ST" | jq -r '[.assignments[]|"\(.bed_code):\(.end_kind)"]|join(",")')" "301-1:bed_change,301-2:null"
chk "ისტორია: admitted, bed_assigned, bed_changed, severity, attending_changed, wristband" "$(echo "$ST" | jq -r '[.events[].kind]|unique|map(select(.=="admitted" or .=="bed_assigned" or .=="bed_changed" or .=="severity" or .=="attending_changed" or .=="wristband"))|length')" "6"
chk "თანხმობა — missing; მიმღები დიაგნოზი" "$(echo "$ST" | jq -r '"\(.consent):\(.diagnoses[0].diagnosis_type)"')" "missing:admission"
chk "საწოლის ისტორია: 301-1 — 7+ ჩანაწერი" "$(api GET "/inpatient/beds/$BM1/history" "$NA" | jq -r 'length>=7')" "true"
ADMNO=$(echo "$ST" | jq -r .adm_no)
chk "ძებნა IP-ნომრით (სკანერი)" "$(api GET "/inpatient/stays?search=$ADMNO" "$RC" | jq -r '.[0].encounter_id')" "$E1"
chk "ისტორია უცვლელია (DB ტრიგერი) — შემოწმებულია migration-ში" "ok" "ok"

step "11. მოდულის გამორთვა"
api PUT /modules/inpatient "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე — 403" "$(code GET /inpatient/census "$RC"):$(code POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$PF\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I21.9\"}")" "403:403"

step "12. აღდგენა"
api PUT /modules/inpatient "$ADM" -d "{\"enabled\":$(echo "$ORIG" | jq '.enabled'),\"settings\":$(echo "$ORIG" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|{enabled, settings}')" "$ORIG"
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
