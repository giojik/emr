#!/usr/bin/env bash
# =====================================================================
# e2e-ipc.sh — ინფექციის კონტროლი, ეტაპი 1 (0067): მოდული / პარამეტრები / უფლებები, ცნობარები, იზოლაციის ეპიზოდები
#   (დაყენება / მოხსნა / უმკაცრესი ტიპი / ძველი PATCH / ისტორია / კარის ნიშანი), პალატის კონფლიქტი (warn / block / კოჰორტა),
#   MDRO: მიკრობიოლოგიის საბოლოო პასუხი → ფლაგი (auto / suggest), მარკერები, განმეორებითი აღმოჩენა, შეძენის ადგილი,
#   ფლაგის მართვა (დადასტურება / ხელით / მოხსნა / გაუქმება), შეთავაზებული იზოლაცია, ხედვა (infection / infection_dept / კლინიცისტი),
#   დაფა, IPC სია, გაუქმება → ავტომატური დასრულება, მოდულის გამორთვა
#   bash scripts/e2e-ipc.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-ipc.sh
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
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r '.code // .error.code // .message.code // empty'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ipc.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"IPC-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.ipc.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
uid() { cat "$TMP/u$1"; }
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_ipc_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_ipc_$1_$S"; }
notes() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" --arg e "${3:-}" '[.[]|select(.kind==$k and ($e=="" or (.link // "" | contains($e))))]|length'; }
ipcset() { api PUT /modules/ipc "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }

step "0. მოდული, პარამეტრები, უფლებები, ცნობარები"
O_IPC=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')
[ -n "$O_IPC" ] || die "მოდული ipc ვერ მოიძებნა (0067 დაყენებულია?)"
O_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|{enabled, settings}')
chk "ნაგულისხმევი: MDRO-ს მოხსნა ipc, კონფლიქტი warn, ფლაგი auto, 3 სკრინინგი, მე-3 დღე, სამაჯური — არა, კარის ნიშანი — კი" \
  "$(echo "$O_IPC" | jq -r '.settings|"\(.isolation_remove_mdro):\(.ward_conflict):\(.mdro_flag_mode):\(.mdro_clear_negatives):\(.hospital_onset_day):\(.wristband_symbol):\(.door_sign)"')" "ipc:warn:auto:3:3:false:true"
chk "ვალიდაცია: უცნობი გასაღები / ward_conflict / onset 0 / სკრინინგი 11 → 400" \
  "$(code PUT /modules/ipc "$ADM" -d '{"settings":{"x":1},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"ward_conflict":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"hospital_onset_day":0},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"mdro_clear_negatives":11},"reason":"ტესტ-E2E"}')" "400:400:400:400"
ipcset '{"isolation_remove_mdro":"ipc","ward_conflict":"warn","wristband_symbol":false,"door_sign":true,"mdro_flag_mode":"auto","mdro_clear_negatives":3,"mdro_suggest_isolation":true,"hospital_onset_day":3,"alert_new_flag":true,"alert_sms":false,"alert_email":false}'
api PUT /modules/inpatient "$ADM" -d '{"enabled":true,"settings":{"bed_assign_mode":"two_step","sex_rule":"warn","cleaning_required":true},"reason":"ტესტ-E2E"}' >/dev/null
chk "47 უფლება (0067: + infection, infection_dept, infection_view; 0073: + bme_dept, bme_view; 0077: + roster, roster_all, roster_view; 0078: + absence_approve; 0081: + worklist_manage, worklist_all)" "$(api GET /roles/capabilities "$ADM" | jq length)" "47"
chk "როლი „ინფექციის კონტროლის სპეციალისტი“ (infection + reports_all), რედაქტირებადი" "$(api GET /roles "$ADM" | jq -r '.[]|select(.code=="ipc_specialist")|"\(.capabilities|sort|join(",")):\(.is_system)"')" "infection,reports_all:false"
CAT=$(api GET /ipc/catalog "$ADM")
chk "ცნობარი: 5 იზოლაციის ტიპი, 7 MDRO, 10 წესი, 6 მარკერი" "$(echo "$CAT" | jq -r '"\(.isolation_types|length):\([.mdro_types[]|select(.is_active)]|length):\([.rules[]|select(.mdro_code!=null and (.note // "" | startswith("ტესტ")|not))]|length >= 10):\(.markers|length)"')" "5:7:true:6"

step "1. მომზადება: განყოფილებები, პალატები, მომხმარებლები, პაციენტები"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E IPC თერაპია $S\",\"code\":\"E2EPA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E IPC ქირურგია $S\",\"code\":\"E2EPB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
W1=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"I$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
W2=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"J$S\",\"sex\":\"mixed\",\"isolation_capable\":true}" | jq -r '.id // empty')
W3=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DB\",\"code\":\"K$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
B1=$(api POST "/inpatient/wards/$W1/beds" "$ADM" -d '{"count":4}'); B11=$(echo "$B1" | jq -r '.[0].id'); B12=$(echo "$B1" | jq -r '.[1].id'); B13=$(echo "$B1" | jq -r '.[2].id'); B14=$(echo "$B1" | jq -r '.[3].id')
B21=$(api POST "/inpatient/wards/$W2/beds" "$ADM" -d '{"count":1}' | jq -r '.[0].id // empty')
B31=$(api POST "/inpatient/wards/$W3/beds" "$ADM" -d '{"count":1}' | jq -r '.[0].id')
[ -n "$B14" ] && [ -n "$B21" ] && [ -n "$B31" ] && ok "3 პალატა (A: 4-საწოლიანი + იზოლატორი; B: 1), 6 საწოლი" || die "საწოლები ვერ შეიქმნა"
R_IPC=$(mkrole ipc "ინფექციის კონტროლი" '["infection"]'); R_IPD=$(mkrole ipd "IPC განყ." '["infection_dept"]'); R_IPV=$(mkrole ipv "IPC ანგარიშები" '["infection_view"]')
[ -n "$R_IPC" ] && [ -n "$R_IPD" ] && [ -n "$R_IPV" ] || die "როლები ვერ შეიქმნა"
IC=$(mkuser "[\"$R_IPC\"]" 61)
ICN=$(mkuser "[\"$R_IPC\",\"nurse\"]" 62 ",\"department_id\":\"$DA\"")
ID=$(mkuser "[\"$R_IPD\"]" 63 ",\"department_id\":\"$DA\"")
IV=$(mkuser "[\"$R_IPV\"]" 64)
NA=$(mkuser '["nurse"]' 65 ",\"department_id\":\"$DA\"")
NB=$(mkuser '["nurse"]' 66 ",\"department_id\":\"$DB\"")
DR=$(mkuser '["doctor"]' 67 ",\"department_id\":\"$DA\""); DRID=$(uid 67)
RC=$(mkuser '["receptionist"]' 68)
LT=$(mkuser '["diagnostic"]' 69); LD=$(mkuser '["lab_doctor"]' 70); PH=$(mkuser '["phlebotomist"]' 71); LM=$(mkuser '["lab_manager"]' 72)
[ -n "$IC" ] && [ -n "$ICN" ] && [ -n "$ID" ] && [ -n "$IV" ] && [ -n "$NA" ] && [ -n "$NB" ] && [ -n "$DR" ] && [ -n "$RC" ] && [ -n "$LT" ] && [ -n "$LD" ] && [ -n "$PH" ] && [ -n "$LM" ] \
  && ok "12 მომხმარებელი (IPC, IPC + ექთანი A, IPC განყ. A, IPC ანგარიშები, ექთნები A / B, ექიმი A, რეგისტრატორი, ლაბ. ×4)" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"IPC-$2\",\"birth_date\":\"1970-02-02\",\"gender\":\"$3\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 51 "ერთი" male); P2=$(mkpat 52 "ორი" female); P3=$(mkpat 53 "სამი" male); P4=$(mkpat 54 "ოთხი" female); P5=$(mkpat 55 "ხუთი" male)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && [ -n "$P4" ] && [ -n "$P5" ] && ok "5 პაციენტი" || die "პაციენტები ვერ შეიქმნა"
ADMIT() { api POST /inpatient/admissions "$1" -d "{\"patient_id\":\"$2\",\"department_id\":\"$3\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"A41.9\"${4:-}}"; }

step "2. იზოლაციის ეპიზოდები"
E1=$(ADMIT "$DR" "$P1" "$DA" ",\"bed_id\":\"$B11\",\"isolation\":\"contact\",\"confirm\":true" | jq -r '.encounter_id // empty')
[ -n "$E1" ] && ok "P1 — ჰოსპიტალიზაცია კონტაქტური იზოლაციით (A, საწოლი 1; confirm — პალატა იზოლაციისთვის არ არის)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
IS=$(api GET "/ipc/stays/$E1/isolations" "$NA")
chk "ეპიზოდი: კონტაქტური, მიზეზი „სხვა“ (ჰოსპიტალიზაციისას); ექთანი A — can.edit" "$(echo "$IS" | jq -r '"\(.active|length):\(.active[0].type):\(.active[0].reason):\(.active[0].reason_text):\(.can.edit)"')" "1:contact:other:ჰოსპიტალიზაციისას:true"
chk "stays.isolation = contact" "$(api GET "/inpatient/stays/$E1" "$NA" | jq -r .isolation)" "contact"
R=$(api POST "/ipc/stays/$E1/isolations" "$NA" -d '{"type":"droplet","reason":"suspected","reason_text":"ტესტ-E2E გრიპი?"}')
chk "წვეთოვანი (ეჭვი) → 2 აქტიური; პალატაში მარტოა — გაფრთხილება: პალატა იზოლაციისთვის არ არის მონიშნული" "$(echo "$R" | jq -r '"\(.active|length):\(.warnings|length):\(.warnings[0]|contains("მონიშნული"))"')" "2:1:true"
chk "stays.isolation = droplet (უმკაცრესი)" "$(api GET "/inpatient/stays/$E1" "$NA" | jq -r .isolation)" "droplet"
chk "იგივე ტიპი მეორედ — 409 ISOLATION_ACTIVE; „სხვა“ ტექსტის გარეშე — 400; MDRO ფლაგის გარეშე — 400" \
  "$(ecode POST "/ipc/stays/$E1/isolations" "$NA" -d '{"type":"droplet","reason":"screening"}'):$(code POST "/ipc/stays/$E1/isolations" "$NA" -d '{"type":"airborne","reason":"other"}'):$(ecode POST "/ipc/stays/$E1/isolations" "$NA" -d '{"type":"airborne","reason":"mdro"}')" "ISOLATION_ACTIVE:400:FLAG_REQUIRED"
chk "ექთანი B (სხვა განყოფილება) — 403; რეგისტრატორი — 403; უცნობი ტიპი — 400" \
  "$(code POST "/ipc/stays/$E1/isolations" "$NB" -d '{"type":"airborne","reason":"screening"}'):$(code POST "/ipc/stays/$E1/isolations" "$RC" -d '{"type":"airborne","reason":"screening"}'):$(code POST "/ipc/stays/$E1/isolations" "$NA" -d '{"type":"xx","reason":"screening"}')" "403:403:400"
DROP=$(echo "$R" | jq -r '.active[]|select(.type=="droplet")|.id')
chk "მოხსნა მიზეზის გარეშე — 400; მკურნალი ექიმი ხსნის → stays.isolation = contact" \
  "$(code POST "/ipc/isolations/$DROP/end" "$DR" -d '{}'):$(api POST "/ipc/isolations/$DROP/end" "$DR" -d '{"reason":"ტესტ-E2E: PCR უარყოფითი"}' >/dev/null; api GET "/inpatient/stays/$E1" "$NA" | jq -r .isolation)" "400:contact"
chk "მოხსნილი მეორედ — 409 ENDED" "$(ecode POST "/ipc/isolations/$DROP/end" "$DR" -d '{"reason":"კიდევ ერთხელ"}')" "ENDED"
chk "ძველი API (PATCH isolation = airborne): კონტაქტური იხურება, საჰაერო იწყება" \
  "$(api PATCH "/inpatient/stays/$E1" "$NA" -d '{"isolation":"airborne","reason":"ტესტ-E2E: ტუბ. ეჭვი"}' >/dev/null; api GET "/ipc/stays/$E1/isolations" "$NA" | jq -r '"\([.active[].type]|join(",")):\(.history|length)"')" "airborne:2"
chk "ჰოსპიტალიზაციის ისტორია: isolation მოვლენები (≥ 3)" "$(api GET "/inpatient/stays/$E1" "$NA" | jq -r '[.events[]|select(.kind=="isolation")]|length >= 3')" "true"
H=$(curl -s -D - -o "$TMP/door.pdf" "$B/ipc/stays/$E1/door-sign" -H "authorization: Bearer $NA" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
chk "კარის ნიშანი — PDF" "$(head -c 5 "$TMP/door.pdf"):$H" "%PDF-:application/pdf"
ipcset '{"door_sign":false}'
chk "კარის ნიშანი გამორთულია — 403 DISABLED" "$(ecode GET "/ipc/stays/$E1/door-sign" "$NA")" "DISABLED"
ipcset '{"door_sign":true}'

step "3. პალატის კონფლიქტი (საჰაერო იზოლაცია — P1, პალატა A)"
E2R=$(ADMIT "$DR" "$P2" "$DA" ",\"bed_id\":\"$B12\"")
chk "P2 იმავე პალატაში → 409 CONFIRM_REQUIRED (იზოლაცია / MDRO)" "$(echo "$E2R" | jq -r '"\(.code):\(.warnings|map(select(contains("იზოლაცია")))|length)"')" "CONFIRM_REQUIRED:1"
E2=$(ADMIT "$DR" "$P2" "$DA" ",\"bed_id\":\"$B12\",\"confirm\":true" | jq -r '.encounter_id // empty')
[ -n "$E2" ] && ok "confirm → გაფორმდა (warn რეჟიმი)" || bad "P2 confirm-ით" "$E2"
ipcset '{"ward_conflict":"block"}'
E3=$(ADMIT "$RC" "$P3" "$DA" | jq -r '.encounter_id // empty')
[ -n "$E3" ] && ok "P3 — საწოლის გარეშე (რეგისტრატორი)" || die "P3 ჰოსპიტალიზაცია ვერ მოხერხდა"
chk "block: ექთანი A → 409 ISOLATION_WARD (confirm-ითაც)" "$(ecode POST "/inpatient/stays/$E3/bed" "$NA" -d "{\"bed_id\":\"$B13\",\"confirm\":true}")" "ISOLATION_WARD"
chk "block: ინფექციის კონტროლი (+ ექთანი) → მხოლოდ გაფრთხილება (CONFIRM_REQUIRED) → confirm-ით 200" \
  "$(ecode POST "/inpatient/stays/$E3/bed" "$ICN" -d "{\"bed_id\":\"$B13\"}"):$(code POST "/inpatient/stays/$E3/bed" "$ICN" -d "{\"bed_id\":\"$B13\",\"confirm\":true}")" "CONFIRM_REQUIRED:200"
ipcset '{"ward_conflict":"warn"}'
chk "სხვა პალატა (იზოლატორი J) — კონფლიქტი არ არის: P1 → იზოლატორი (გაფრთხილების გარეშე)" "$(code POST "/inpatient/stays/$E1/bed" "$NA" -d "{\"bed_id\":\"$B21\",\"reason\":\"ტესტ-E2E: იზოლატორში\"}")" "200"

step "4. MDRO: მიკრობიოლოგიის საბოლოო პასუხი → ფლაგი"
REF=$(api GET /lab/micro/refs "$LT")
ORG() { echo "$REF" | jq -r --arg c "$1" '.organisms[]|select(.code==$c)|.id'; }
ECO=$(ORG eco); KPN=$(ORG kpn); SAU=$(ORG sau); EFM=$(ORG efm)
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"MIC_IPC_$S\",\"name\":\"ტესტ-E2E IPC კულტურა $S\",\"group_name\":\"ტესტ-E2E მიკრობიოლოგია\",\"specimen_type\":\"urine\",\"container\":\"Sterile\"}" | jq -r '.id // empty')
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_micro":true}' >/dev/null
[ -n "$SVC" ] && ok "მიკრობიოლოგიური ანალიზი (კატალოგი)" || die "ანალიზი ვერ შეიქმნა"
# ლაბ. ვიზიტი (ამბულატორიული) ან სტაციონარის შეკვეთა → აღება → მიღება → item id
labitem() {
  local e sh bc; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$1\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  bc=$(api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty'
}
ipditem() {
  api POST "/encounters/$1/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$SVC\"}]}" >/dev/null
  local bc; bc=$(api POST "/encounters/$1/dx-collect" "$NA" -d '{"identity_confirmed":true}' | jq -r '[.[]?|.barcode][0] // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty'
}
# იზოლატი + R ანტიბიოტიკები (კოდები) + მარკერები → საბოლოო
grow() {
  local it=$1 org=$2 rs=$3 mk=${4:-[]} D iso rows
  api PUT "/lab/micro/items/$it/culture" "$LT" -d '{"stage":"growth"}' >/dev/null
  D=$(api POST "/lab/micro/items/$it/isolates" "$LT" -d "{\"organism_id\":\"$org\",\"quantity\":\"10^5\"}"); iso=$(echo "$D" | jq -r '.isolates[-1].id')
  rows=$(echo "$D" | jq -c --arg rs "$rs" '[.isolates[-1].ast[]|. as $a|{antibiotic_id, interp: (if (($rs|split(",")) | index($a.code)) != null then "R" else "S" end)}]')
  api PUT "/lab/micro/isolates/$iso/ast" "$LT" -d "{\"rows\":$rows}" >/dev/null
  [ "$mk" != "[]" ] && api PATCH "/lab/micro/isolates/$iso" "$LT" -d "{\"markers\":$mk}" >/dev/null
  echo "$iso"
}
fin() { api POST "/lab/micro/items/$1/complete" "$LT" >/dev/null; api POST "/lab/micro/items/$1/final" "$LD" | jq -r .status; }
flags() { api GET "/ipc/flags?status=all&q=$(jq -rn --arg q "$2" '$q|@uri')" "$1" | jq -c --arg p "$3" '[.[]|select(.patient_id==$p)]'; }
NIC0=$(notes "$IC" ipc_flag)

I4=$(labitem "$P4"); [ -n "$I4" ] || die "P4 ლაბ. შეკვეთა ვერ შეიქმნა"
grow "$I4" "$ECO" "AMP,MEM" >/dev/null
chk "P4 (ამბულატორია): E. coli, მეროპენემი R → საბოლოო" "$(fin "$I4")" "validated"
F4=$(flags "$IC" "IPC-ოთხი" "$P4")
chk "ფლაგი CRE: აქტიური (auto), micro, საზოგადოებრივი, ნიმუში მიბმულია" "$(echo "$F4" | jq -r '"\(length):\(.[0].mdro_code):\(.[0].status):\(.[0].source):\(.[0].onset):\(.[0].detections)"')" "1:cre:active:micro:community:1"
F4ID=$(echo "$F4" | jq -r '.[0].id')
chk "ინფექციის კონტროლს — შეტყობინება (ზარი), CRE — სასწრაფო" "$(( $(notes "$IC" ipc_flag) - NIC0 )):$(api GET "/notifications?unread=true" "$IC" | jq -r --arg f "$F4ID" '[.[]|select(.link=="/ipc/flags/"+$f)][0].urgent')" "1:true"
chk "ლაბ. ექიმის პასუხი არ შეფერხდა (წინასწარ / საბოლოო ხედი)" "$(api GET "/lab/micro/items/$I4/view" "$DR" | jq -r .kind)" "final"
I4B=$(labitem "$P4"); grow "$I4B" "$ECO" "AMP,ETP,MEM" >/dev/null; fin "$I4B" >/dev/null
chk "განმეორებითი CRE — ახალი ფლაგი არა, აღმოჩენა 2" "$(flags "$IC" "IPC-ოთხი" "$P4" | jq -r '"\(length):\(.[0].detections)"')" "1:2"
I4C=$(labitem "$P4"); grow "$I4C" "$KPN" "AMP" '["esbl"]' >/dev/null; fin "$I4C" >/dev/null
chk "K. pneumoniae + ESBL მარკერი (კარბაპენემი S) → ფლაგი ESBL (CRE არა)" "$(flags "$IC" "IPC-ოთხი" "$P4" | jq -r '[.[].mdro_code]|sort|join(",")')" "cre,esbl"
chk "ლაბ. პასუხში (snapshot) მარკერი ჩანს" "$(api GET "/lab/micro/items/$I4C/view" "$DR" | jq -r '.report.isolates[0].markers|join(",")')" "esbl"
chk "მარკერის ვალიდაცია: უცნობი — 400" "$(code PATCH "/lab/micro/isolates/$(api GET "/lab/micro/items/$I4C" "$LT" | jq -r '.isolates[0].id')" "$LT" -d '{"markers":["xx"]}')" "400"
I5=$(labitem "$P5"); grow "$I5" "$ECO" "AMP" >/dev/null; fin "$I5" >/dev/null
chk "MDRO არ არის (E. coli, მხოლოდ AMP R) → ფლაგი არა" "$(flags "$IC" "IPC-ხუთი" "$P5" | jq length)" "0"

step "5. სტაციონარი: MRSA → შეთავაზებული იზოლაცია"
ND0=$(notes "$DR" ipc_flag)
I1=$(ipditem "$E1")
if [ -n "$I1" ]; then
  grow "$I1" "$SAU" "OXA,PEN" >/dev/null; fin "$I1" >/dev/null
  F1=$(flags "$IC" "IPC-ერთი" "$P1")
  chk "P1 (სტაციონარი, მიღების დღე): MRSA — აქტიური, საზოგადოებრივი (< მე-3 დღე)" "$(echo "$F1" | jq -r '"\(.[0].mdro_code):\(.[0].status):\(.[0].onset)"')" "mrsa:active:community"
  chk "მკურნალ ექიმს — შეტყობინება (ბმული ჰოსპიტალიზაციაზე)" "$(( $(notes "$DR" ipc_flag "/inpatient/stay/$E1") ))" "1"
else
  bad "სტაციონარის ლაბ. შეკვეთა ვერ შეიქმნა" "dx-orders / dx-collect"
fi
F1ID=$(flags "$IC" "IPC-ერთი" "$P1" | jq -r '.[0].id // empty')
ST=$(api GET "/ipc/patients/$P1/status" "$DR")
chk "სტატუსი (ექიმი): ფლაგი MRSA, იზოლაცია საჰაერო, შეთავაზება — კონტაქტური MRSA-ს გამო" "$(echo "$ST" | jq -r '"\(.enabled):\([.flags[].mdro_code]|join(",")):\([.isolations[].type]|join(",")):\(.suggestions[0].isolation_type):\(.suggestions[0].flag_id == "'"$F1ID"'")"')" "true:mrsa:airborne:contact:true"
chk "სტატუსი — რეგისტრატორიც ხედავს (ბანერი); ლაბორანტი — 200" "$(code GET "/ipc/patients/$P1/status" "$RC"):$(code GET "/ipc/patients/$P1/status" "$LT")" "200:200"
R=$(api POST "/ipc/stays/$E1/isolations" "$NA" -d "{\"type\":\"contact\",\"reason\":\"mdro\",\"flag_id\":\"$F1ID\"}")
MISO=$(echo "$R" | jq -r '.active[]|select(.type=="contact")|.id')
chk "კონტაქტური (MDRO, ფლაგით) — შეთავაზება ქრება" "$(echo "$R" | jq -r '[.active[]|select(.type=="contact")][0].reason'):$(api GET "/ipc/patients/$P1/status" "$DR" | jq -r '.suggestions|length')" "mdro:0"
chk "სხვა პაციენტის ფლაგით — 400 FLAG" "$(ecode POST "/ipc/stays/$E2/isolations" "$NA" -d "{\"type\":\"contact\",\"reason\":\"mdro\",\"flag_id\":\"$F1ID\"}")" "FLAG"
chk "MDRO-ს იზოლაციას ექთანი ვერ ხსნის — 403 IPC_ONLY; ექთნის can.end_mdro = false" "$(ecode POST "/ipc/isolations/$MISO/end" "$NA" -d '{"reason":"ტესტ-E2E"}'):$(api GET "/ipc/stays/$E1/isolations" "$NA" | jq -r .can.end_mdro)" "IPC_ONLY:false"
chk "ძველი PATCH (isolation = null) MDRO-ს იზოლაციას ვერ ხურავს — 403" "$(code PATCH "/inpatient/stays/$E1" "$NA" -d '{"isolation":null}')" "403"
chk "დაფა: P1 — იზოლაციები (საჰაერო, კონტაქტური) + MDRO (mrsa)" "$(api GET "/inpatient/board?department_id=$DA" "$NA" | jq -r --arg e "$E1" '[.. | objects | select(.encounter_id? == $e and .mdro? != null)][0] | "\(.isolations|join(",")):\(.mdro|join(","))"')" "airborne,contact:mrsa"

step "6. შეთავაზების რეჟიმი (suggest), დადასტურება"
ipcset '{"mdro_flag_mode":"suggest"}'
I2=$(labitem "$P2"); grow "$I2" "$EFM" "AMP,VAN" >/dev/null; fin "$I2" >/dev/null
F2=$(flags "$IC" "IPC-ორი" "$P2"); F2ID=$(echo "$F2" | jq -r '.[0].id')
chk "P2: E. faecium, VAN R → VRE — შეთავაზება (suggested)" "$(echo "$F2" | jq -r '"\(.[0].mdro_code):\(.[0].status)"')" "vre:suggested"
chk "ექიმი შეთავაზებას ვერ ხედავს; IPC — ხედავს" "$(api GET "/ipc/patients/$P2/status" "$DR" | jq -r '.flags|length'):$(api GET "/ipc/patients/$P2/status" "$IC" | jq -r '.flags[0].status')" "0:suggested"
chk "განსახილველი (review=pending): CRE, ESBL, MRSA, VRE ≥ 4" "$(api GET '/ipc/flags?review=pending' "$IC" | jq -r --arg a "$P1" --arg b "$P2" --arg c "$P4" '[.[]|select(.patient_id==$a or .patient_id==$b or .patient_id==$c)]|length')" "4"
chk "დადასტურება: ექთანი — 403; IPC → active" "$(code POST "/ipc/flags/$F2ID/confirm" "$NA" -d '{}'):$(api POST "/ipc/flags/$F2ID/confirm" "$IC" -d '{"note":"ტესტ-E2E"}' | jq -r .status)" "403:active"
chk "მეორედ — 409 NO_CHANGE; ავტომატური (CRE) — reviewed" "$(ecode POST "/ipc/flags/$F2ID/confirm" "$IC" -d '{}'):$(api POST "/ipc/flags/$F4ID/confirm" "$IC" -d '{}' | jq -r '.reviewed_at != null')" "NO_CHANGE:true"
ipcset '{"mdro_flag_mode":"auto"}'

step "7. ფლაგის მართვა: ხელით / გარე, მოხსნა, გაუქმება, ხედვა"
FX=$(api POST /ipc/flags "$IC" -d "{\"patient_id\":\"$P3\",\"mdro_code\":\"crab\",\"source\":\"external\",\"specimen_at\":\"$(date -u +%FT%TZ)\",\"note\":\"ტესტ-E2E: გარე ლაბ. PDF\"}")
FXID=$(echo "$FX" | jq -r '.id // empty')
chk "გარე პასუხით CRAB (P3) — active, reviewed, onset unknown" "$(echo "$FX" | jq -r '"\(.status):\(.source):\(.reviewed_at != null):\(.onset)"')" "active:external:true:unknown"
chk "იგივე მეორედ — 409 FLAG_EXISTS; ექთანი — 403; უცნობი ტიპი — 400" \
  "$(ecode POST /ipc/flags "$IC" -d "{\"patient_id\":\"$P3\",\"mdro_code\":\"crab\",\"source\":\"manual\"}"):$(code POST /ipc/flags "$NA" -d "{\"patient_id\":\"$P3\",\"mdro_code\":\"cre\",\"source\":\"manual\"}"):$(ecode POST /ipc/flags "$IC" -d "{\"patient_id\":\"$P3\",\"mdro_code\":\"zz\",\"source\":\"manual\"}")" "FLAG_EXISTS:403:MDRO_TYPE"
chk "IPC განყ. A: სიაში P1, P2, P3 (განყ. A), P4 არა (ამბულატორია); infection_view / ექთანი — 403" \
  "$(api GET '/ipc/flags' "$ID" | jq -r --arg a "$P1" --arg b "$P2" --arg c "$P3" --arg d "$P4" '"\([.[]|select(.patient_id==$a or .patient_id==$b or .patient_id==$c)]|length):\([.[]|select(.patient_id==$d)]|length)"'):$(code GET /ipc/flags "$IV"):$(code GET /ipc/flags "$NA")" "3:0:403:403"
chk "IPC განყ. A: P4-ის ფლაგი — 403 OUT_OF_SCOPE; P1 — 200" "$(ecode GET "/ipc/flags/$F4ID" "$ID"):$(code GET "/ipc/flags/$F1ID" "$ID")" "OUT_OF_SCOPE:200"
D1=$(api GET "/ipc/flags/$F1ID" "$IC")
chk "ბარათი: აღმოჩენა (ნიმუში), იზოლაცია მიბმული, ჰოსპიტალიზაცია, საჭირო სკრინინგი 3" "$(echo "$D1" | jq -r '"\(.detections|length):\(.isolations|length):\(.stay.encounter_id == "'"$E1"'"):\(.clear_negatives_required)"')" "1:1:true:3"
chk "მოხსნა: < 3 სკრინინგი — 400 NEGATIVES; IPC განყ. — 403" "$(ecode POST "/ipc/flags/$F1ID/clear" "$IC" -d '{"reason":"ტესტ-E2E","negatives":2}'):$(code POST "/ipc/flags/$F1ID/clear" "$ID" -d '{"reason":"ტესტ-E2E","negatives":3}')" "NEGATIVES:403"
R=$(api POST "/ipc/flags/$F1ID/clear" "$IC" -d '{"reason":"ტესტ-E2E: 3 უარყოფითი სკრინინგი","negatives":3}')
chk "მოხსნა (3 სკრინინგი) → cleared; MDRO-ს იზოლაცია ავტომატურად დასრულდა (1)" "$(echo "$R" | jq -r '"\(.status):\(.isolations_ended)"'):$(api GET "/ipc/stays/$E1/isolations" "$NA" | jq -r '[.active[].type]|join(",")')" "cleared:1:airborne"
chk "მოხსნილის ხელახლა მოხსნა — 409; P1 სტატუსი — ფლაგი აღარ არის" "$(ecode POST "/ipc/flags/$F1ID/clear" "$IC" -d '{"reason":"ტესტ-E2E","negatives":3}'):$(api GET "/ipc/patients/$P1/status" "$DR" | jq -r '.flags|length')" "FLAG_STATE:0"
api POST "/ipc/stays/$E2/isolations" "$NA" -d "{\"type\":\"contact\",\"reason\":\"mdro\",\"flag_id\":\"$F2ID\"}" >/dev/null
chk "გაუქმება (შეცდომა): VRE → dismissed, იზოლაცია დასრულდა" "$(api POST "/ipc/flags/$F2ID/dismiss" "$IC" -d '{"reason":"ტესტ-E2E: კონტამინაცია"}' | jq -r '"\(.status):\(.isolations_ended)"')" "dismissed:1"
chk "სია (ღია): P1 / P2 აღარ არის; status=all — ჩანს" "$(api GET '/ipc/flags' "$IC" | jq -r --arg a "$P1" --arg b "$P2" '[.[]|select(.patient_id==$a or .patient_id==$b)]|length'):$(api GET '/ipc/flags?status=all' "$IC" | jq -r --arg a "$P1" --arg b "$P2" '[.[]|select(.patient_id==$a or .patient_id==$b)]|length')" "0:2"

step "8. ინფექციის კონტროლის პაციენტების სია, კოჰორტა"
L=$(api GET "/ipc/patients?department_id=$DA" "$IC")
chk "სია (განყ. A): P1 (იზოლაცია), P3 (CRAB, იზოლაციის გარეშე → missing contact_plus, საერთო პალატა)" \
  "$(echo "$L" | jq -r --arg a "$P1" --arg c "$P3" '"\([.[]|select(.patient_id==$a)]|length):\([.[]|select(.patient_id==$c)][0]|"\(.missing_isolation|join(",")):\(.shared_ward)")"')" "1:contact_plus:true"
chk "IPC განყ. A — 200; infection_view / ექთანი — 403" "$(code GET /ipc/patients "$ID"):$(code GET /ipc/patients "$IV"):$(code GET /ipc/patients "$NA")" "200:403:403"
api POST /ipc/flags "$IC" -d "{\"patient_id\":\"$P2\",\"mdro_code\":\"crab\",\"source\":\"manual\",\"note\":\"ტესტ-E2E კოჰორტა\"}" >/dev/null
chk "კოჰორტა: P2 (CRAB) → P3-ის პალატაში (CRAB) — 409 CONFIRM_REQUIRED, ერთადერთი გაფრთხილება „კოჰორტა“ (იზოლაციის კონფლიქტი — არა)" \
  "$(api POST "/inpatient/stays/$E2/bed" "$NA" -d "{\"bed_id\":\"$B14\"}" | jq -r '"\(.code):\(.warnings|length):\([.warnings[]|select(contains("კოჰორტა"))]|length)"')" "CONFIRM_REQUIRED:1:1"

step "9. ცნობარები"
chk "იზოლაციის ტიპის ტექსტი: IPC — 200; ექთანი — 403; ცარიელი — 400 NO_CHANGE" \
  "$(code PATCH /ipc/isolation-types/droplet "$IC" -d '{"door_text":"ტესტ-E2E: კარი შეიძლება იყოს ღია\nნიღაბი ტრანსპორტირებისას"}'):$(code PATCH /ipc/isolation-types/droplet "$NA" -d '{"name":"x"}'):$(ecode PATCH /ipc/isolation-types/droplet "$IC" -d '{}')" "200:403:NO_CHANGE"
chk "MDRO ტიპი: ახალი (ტესტ) — 201; იგივე კოდი — 409" \
  "$(code POST /ipc/mdro-types "$IC" -d "{\"code\":\"t$S\",\"name\":\"ტესტ-E2E MDRO\",\"isolation_type\":\"contact\",\"expiry_days\":365}"):$(ecode POST /ipc/mdro-types "$IC" -d "{\"code\":\"t$S\",\"name\":\"ტესტ-E2E MDRO\",\"isolation_type\":\"contact\"}")" "201:CODE_EXISTS"
chk "წესი: უცნობი კოდი — 400 UNKNOWN_CODE; ჯგუფი პირობის გარეშე — 400 RULE_COND" \
  "$(ecode POST /ipc/mdro-rules "$IC" -d "{\"mdro_code\":\"t$S\",\"organism_codes\":[\"zzz\"],\"abx_codes\":[\"VAN\"]}"):$(ecode POST /ipc/mdro-rules "$IC" -d "{\"mdro_code\":\"t$S\",\"group_codes\":[\"ENT\"]}")" "UNKNOWN_CODE:RULE_COND"
RID=$(api POST /ipc/mdro-rules "$IC" -d "{\"mdro_code\":\"t$S\",\"organism_codes\":[\"KPN\"],\"abx_codes\":[\"amk\"],\"note\":\"ტესტ-E2E წესი\"}" | jq -r '.id // empty')
chk "წესი: K. pneumoniae + AMK R (კოდები ნორმალიზდება)" "$(api GET /ipc/catalog "$IC" | jq -r --arg id "$RID" '.rules[]|select(.id==$id)|"\(.organism_codes|join(",")):\(.abx_codes|join(","))"')" "kpn:AMK"
I4D=$(labitem "$P4"); grow "$I4D" "$KPN" "AMK" >/dev/null; fin "$I4D" >/dev/null
chk "ახალი წესი მუშაობს: P4 → ტესტ MDRO (ვადით)" "$(flags "$IC" "IPC-ოთხი" "$P4" | jq -r --arg c "t$S" '[.[]|select(.mdro_code==$c)][0]|"\(.status):\(.expires_at != null)"')" "active:true"
api PATCH "/ipc/mdro-rules/$RID" "$IC" -d '{"is_active":false}' >/dev/null
api PATCH "/ipc/mdro-types/t$S" "$IC" -d '{"is_active":false}' >/dev/null
chk "წესი და ტიპი გაითიშა" "$(api GET /ipc/catalog "$IC" | jq -r --arg id "$RID" --arg c "t$S" '"\(.rules[]|select(.id==$id)|.is_active):\(.mdro_types[]|select(.code==$c)|.is_active)"')" "false:false"

step "10. სამაჯური, ჰოსპიტალიზაციის გაუქმება → ავტომატური დასრულება"
ipcset '{"wristband_symbol":true}'
api PUT /modules/inpatient "$ADM" -d '{"settings":{"wristband":true,"wristband_print":"pdf"},"reason":"ტესტ-E2E"}' >/dev/null
chk "სამაჯური (PDF, იზოლაციის ნიშნით) — 200" "$(curl -s -o "$TMP/wb.pdf" -w '%{http_code}' "$B/inpatient/stays/$E1/wristband.pdf" -H "authorization: Bearer $NA"):$(head -c 5 "$TMP/wb.pdf")" "200:%PDF-"
ipcset '{"wristband_symbol":false}'
api POST "/ipc/stays/$E3/isolations" "$ICN" -d "{\"type\":\"contact_plus\",\"reason\":\"mdro\",\"flag_id\":\"$FXID\"}" >/dev/null
chk "P3 — გაძლიერებული კონტაქტური (CRAB) → stays.isolation = contact_plus" "$(api GET "/inpatient/stays/$E3" "$NA" | jq -r .isolation)" "contact_plus"
api POST "/inpatient/stays/$E3/cancel" "$DR" -d '{"reason":"ტესტ-E2E: შეცდომით"}' >/dev/null
IS=$(api GET "/ipc/stays/$E3/isolations" "$IC")
chk "გაუქმება → იზოლაცია ავტომატურად დასრულდა (auto_ended, „გაუქმდა“), stays.isolation = null" \
  "$(echo "$IS" | jq -r '"\(.status):\(.active|length):\(.history[0].auto_ended):\(.history[0].end_reason|contains("გაუქმდა"))"'):$(api GET "/inpatient/stays/$E3" "$IC" | jq -r .isolation)" "cancelled:0:true:true:null"
chk "დასრულებულ ჰოსპიტალიზაციაზე დაყენება — 409" "$(code POST "/ipc/stays/$E3/isolations" "$IC" -d '{"type":"contact","reason":"screening"}')" "409"
chk "ფლაგი პაციენტზე რჩება (ჰოსპიტალიზაციის გარეშეც): P3 — CRAB" "$(api GET "/ipc/patients/$P3/status" "$RC" | jq -r '"\([.flags[].mdro_code]|join(",")):\(.stay)"')" "crab:null"

step "11. მოდულის გამორთვა / აღდგენა"
api PUT /modules/ipc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე: სია / ფლაგები — 403 MODULE_DISABLED; სტატუსი — enabled=false, ფლაგების გარეშე" \
  "$(ecode GET /ipc/flags "$IC"):$(code GET /ipc/patients "$IC"):$(api GET "/ipc/patients/$P4/status" "$DR" | jq -r '"\(.enabled):\(.flags|length)"')" "MODULE_DISABLED:403:false:0"
chk "იზოლაცია მოდულის გარეშეც მუშაობს (P2 — წვეთოვანი)" "$(api POST "/ipc/stays/$E2/isolations" "$NA" -d '{"type":"droplet","reason":"screening"}' | jq -r '[.active[].type]|index("droplet") != null')" "true"
chk "დაფა: MDRO ფლაგები დამალულია" "$(api GET "/inpatient/board?department_id=$DA" "$NA" | jq -r --arg e "$E2" '[.. | objects | select(.encounter_id? == $e and .mdro? != null)][0].mdro|length')" "0"
I5B=$(labitem "$P5"); grow "$I5B" "$ECO" "MEM" >/dev/null; fin "$I5B" >/dev/null
chk "გამორთულზე მიკრობიოლოგია ფლაგს არ ქმნის (worker მოგვიანებით შეამოწმებს — ჩართვის შემდეგ)" "$(api GET "/ipc/patients/$P5/status" "$IC" | jq -r .enabled)" "false"
api PUT /modules/ipc "$ADM" -d "{\"enabled\":$(echo "$O_IPC" | jq '.enabled'),\"settings\":$(echo "$O_IPC" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"enabled\":$(echo "$O_IPD" | jq '.enabled'),\"settings\":$(echo "$O_IPD" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია (ipc, inpatient)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}'):$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|{enabled, settings}')" "$O_IPC:$O_IPD"
AUD=$( (api GET "/audit-logs?entity_name=ipc_isolations&limit=200" "$ADM"; api GET "/audit-logs?entity_name=ipc_patient_flags&limit=200" "$ADM") | jq -s -r '[.[]|(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: IPC_ISOLATION_START / END, IPC_FLAG_AUTO / CREATE / CONFIRM / CLEAR / DISMISS" \
  "$(for a in IPC_ISOLATION_START IPC_ISOLATION_END IPC_FLAG_AUTO IPC_FLAG_CREATE IPC_FLAG_CONFIRM IPC_FLAG_CLEAR IPC_FLAG_DISMISS; do echo "$AUD" | tr ',' '\n' | grep -qx "$a" && echo y || echo "$a"; done | sort -u | tr '\n' ' ')" "y "

step "გასუფთავება"
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მომხმარებლები / ანალიზი გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
