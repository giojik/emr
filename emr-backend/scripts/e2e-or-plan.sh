#!/usr/bin/env bash
# =====================================================================
# e2e-or-plan.sh — საოპერაციო ბლოკი, ეტაპი 0048: დაგეგმვა
#   0. მომზადება (ბლოკი, ქირურგია, ICU; როლები or_schedule / anesthesiologist / or_nurse; მომხმარებლები; პაციენტები)
#   1. სტრუქტურა: ბლოკი + საწყობის ლოკაცია, ოთახები, სპეციალობა     2. პროცედურების კატალოგი + CSV იმპორტი
#   3. მოთხოვნა (ჰოსპიტალიზაციიდან / გეგმიური რიგიდან), უფლებები     4. დაგეგმვა: კოორდინატორი, გადაფარვა, საათები, გადადება
#   5. or_scheduling: surgeon_self / both (დასადასტურებელი) + გადაუდებელი   6. გუნდი (anesthesia_team_by), გადაფარვა, ოპერატორის შეცვლა
#   7. წინასაოპერაციო: გასინჯვა, თანხმობები, მზადყოფნა            8. WHO ჩეკლისტი
#   9. დროის ნიშნულები: მზადყოფნა (warn / block), Time out → განაკვეთი, შესწორება, გუნდი დაწყების შემდეგ, Sign out → დასრულება
#   10. ICU — წყარო „საოპერაციო“   11. გაუქმება, გეგმიური რიგი → ჰოსპიტალიზაცია   12. დაფა, „ჩემი ოპერაციები“   13. ადმინისტრირება   14. აღდგენა
# გამოყენება:  bash scripts/e2e-or-plan.sh [API_URL]
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
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
err()  { echo "$1" | jq -r 'if type=="object" then ((.code // "") + ":" + (.message|tostring)) else . end' 2>/dev/null | head -c 300; }
ecode() { echo "$1" | jq -r 'if type=="object" then (.code // .statusCode // "") else "" end' 2>/dev/null; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
ago() { date -u -d "-$1" +%FT%TZ; }
TOMORROW=$(TZ=Asia/Tbilisi date -d tomorrow +%F)
DAY2=$(TZ=Asia/Tbilisi date -d '+2 days' +%F)
at() { echo "${1}T${2}:00+04:00"; }                         # კლინიკის დრო (Asia/Tbilisi)
SIG=$(python3 -c "
import zlib,struct,random,base64
w,h=60,24; raw=b''.join(b'\x00'+bytes(random.randrange(256) for _ in range(w*3)) for _ in range(h))
c=lambda t,d: struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
print('data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b'')).decode())")

step "0. მომზადება"
ORIG_OR=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings')
[ -n "$ORIG_OR" ] && [ "$ORIG_OR" != "null" ] || die "მოდული „or“ ვერ მოიძებნა (migration 0048?)"
ORIG_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
ormod() { api PUT /modules/or "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
ormod '{"or_scheduling":"coordinator","anesthesia_team_by":"anesthesia_head","preop_readiness":"warn","turnover_min":30,"default_duration_min":60,"self_booking_days":30,"notify_requests":true}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"bed_assign_mode":"direct"},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /settings/clinic "$ADM" -d '{"consent_methods":["paper","electronic"]}' >/dev/null
DBK=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E საოპერაციო ბლოკი $S\",\"code\":\"E2EORB$S\",\"type\":\"or\"}" | jq -r '.id // empty')
DS=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქირურგია $S\",\"code\":\"E2EORS$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DT=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ტრავმატოლოგია $S\",\"code\":\"E2EORT$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DI=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E რეანიმაცია (OR) $S\",\"code\":\"E2EORI$S\",\"type\":\"inpatient\",\"care_level\":\"icu\"}" | jq -r '.id // empty')
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ანესთეზიოლოგია $S\",\"code\":\"E2EORA$S\",\"type\":\"administrative\"}" | jq -r '.id // empty')
[ -n "$DBK" ] && [ -n "$DS" ] && [ -n "$DT" ] && [ -n "$DI" ] && [ -n "$DA" ] || die "განყოფილებები ვერ შეიქმნა (ტიპი „or“ — migration 0048?)"
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -r '[.types[]?|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end')
arr() { echo "$1" | jq -r "if type==\"array\" then (.[$2].id // empty) else empty end"; }
WS=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DS\",\"code\":\"S1\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
WI=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DI\",\"code\":\"I1\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BS=$(api POST "/inpatient/wards/$WS/beds" "$ADM" -d "{\"count\":4,\"type_code\":\"$BT\"}"); BS1=$(arr "$BS" 0); BS2=$(arr "$BS" 1); BS3=$(arr "$BS" 2); BS4=$(arr "$BS" 3)
BI=$(api POST "/inpatient/wards/$WI/beds" "$ADM" -d "{\"count\":1,\"type_code\":\"$BT\"}"); BI1=$(arr "$BI" 0)
[ -n "$BS4" ] && [ -n "$BI1" ] || die "საწოლები ვერ შეიქმნა"
# როლები (უფლებების ნაკრები) — ერთხელ იქმნება, შემდეგ გაშვებებზე იგივე გამოიყენება
role() {
  local id; id=$(api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id' | head -1)
  [ -n "$id" ] || api POST /roles "$ADM" -d "{\"code\":\"$1\",\"name\":\"$2\",\"capabilities\":$3}" >/dev/null
  api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.code' | head -1
}
R1=$(role e2e_or_coord "ტესტ-E2E საოპერაციოს კოორდინატორი" '["or_schedule"]')
R2=$(role e2e_anesth "ტესტ-E2E ანესთეზიოლოგი" '["anesthesiologist"]')
R3=$(role e2e_or_nurse "ტესტ-E2E საოპერაციო ექთანი" '["or_nurse"]')
[ "$R1" = "e2e_or_coord" ] && [ "$R2" = "e2e_anesth" ] && [ "$R3" = "e2e_or_nurse" ] || die "როლები ვერ შეიქმნა (უფლებები or_schedule / anesthesiologist / or_nurse — migration 0048?)"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.or.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"OR-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.or.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 81)
SU1=$(mkuser '["doctor"]' 82 ",\"department_id\":\"$DS\"")
SU2=$(mkuser '["doctor"]' 83 ",\"department_id\":\"$DS\"")
HD=$(mkuser '["doctor"]' 84 ",\"department_id\":\"$DS\",\"is_section_head\":true")
SU3=$(mkuser '["doctor"]' 85 ",\"department_id\":\"$DT\"")
CO=$(mkuser '["e2e_or_coord"]' 86)
AN1=$(mkuser '["e2e_anesth"]' 87 ",\"department_id\":\"$DA\",\"is_section_head\":true")
AN2=$(mkuser '["e2e_anesth"]' 88 ",\"department_id\":\"$DA\"")
ON1=$(mkuser '["e2e_or_nurse"]' 89 ",\"department_id\":\"$DBK\"")
ON2=$(mkuser '["e2e_or_nurse"]' 90 ",\"department_id\":\"$DBK\"")
NS=$(mkuser '["nurse"]' 91 ",\"department_id\":\"$DS\"")
NI=$(mkuser '["nurse"]' 92 ",\"department_id\":\"$DI\"")
for t in RC SU1 SU2 HD SU3 CO AN1 AN2 ON1 ON2 NS NI; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: ქირურგები ×3 + ხელმძღვანელი, კოორდინატორი, ანესთეზიოლოგი ×2 (ერთი — ხელმძღვანელი), საოპერაციო ექთანი ×2, ექთნები"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 93 "OR-მუხლი" 1958-04-04 female); P2=$(mkpat 94 "OR-გეგმიური" 1980-06-06 male); P3=$(mkpat 95 "OR-გადაუდებელი" 1990-01-01 male); P4=$(mkpat 96 "OR-ბლოკი" 1970-07-07 female)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && [ -n "$P4" ] || die "პაციენტები ვერ შეიქმნა"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DS\",\"attending_doctor_id\":\"$(uid 82)\",\"source\":\"$2\",\"icd10_code\":\"M17.1\",\"chief_complaint\":\"ტესტ-E2E\",\"bed_id\":\"$3\"${4:-}}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" direct "$BS1"); E3=$(ADMIT "$P3" emergency "$BS3"); E4=$(ADMIT "$P4" direct "$BS4")
[ -n "$E1" ] && [ -n "$E3" ] && [ -n "$E4" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
PL=$(api POST /inpatient/planned "$RC" -d "{\"patient_id\":\"$P2\",\"department_id\":\"$DS\",\"doctor_id\":\"$(uid 82)\",\"planned_date\":\"$DAY2\",\"icd10_code\":\"K40.9\",\"reason\":\"ტესტ-E2E: თიაქარი\"}" | jq -r '.id // empty')
[ -n "$PL" ] || die "გეგმიური რიგის ჩანაწერი ვერ შეიქმნა"
ok "3 ჰოსპიტალიზაცია (ქირურგია) + გეგმიური რიგი ($DAY2)"

step "1. სტრუქტურა: ბლოკი, ოთახები"
chk "განყოფილების ტიპი „or“ — სიაში" "$(api GET /departments "$ADM" | jq -r --arg a "$DBK" '.[]|select(.id==$a)|.type')" "or"
LOC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EOR$S\",\"name\":\"ტესტ-E2E საოპერაციო ბლოკის საწყობი\",\"kind\":\"operating\",\"department_id\":\"$DBK\"}" | jq -r '.id // empty')
[ -n "$LOC" ] || LOC=$(api GET /or/setup "$ADM" | jq -r '.locations[0].id // empty')
chk "ბლოკი: საწყობის ლოკაცია (admin); ქირურგი → 403; არა-ბლოკი → 404" \
  "$(api PATCH "/or/blocks/$DBK" "$ADM" -d "{\"stock_location_id\":\"$LOC\"}" | jq -r '.stock_location_id==$l' --arg l "$LOC"):$(code PATCH "/or/blocks/$DBK" "$SU1" -d '{"stock_location_id":null}'):$(code PATCH "/or/blocks/$DS" "$ADM" -d '{"stock_location_id":null}')" "true:403:404"
chk "ოთახი სტაციონარულ განყოფილებაში → 400; არასწორი საათები → 400" \
  "$(code POST /or/rooms "$ADM" -d "{\"department_id\":\"$DS\",\"code\":\"X$S\",\"name\":\"ტესტ\"}"):$(code POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"X$S\",\"name\":\"ტესტ\",\"work_start\":\"18:00\",\"work_end\":\"08:00\"}")" "400:400"
RO1=$(api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"OR1\",\"name\":\"ოთახი 1 (ორთოპედია / ზოგადი)\",\"work_start\":\"07:00\",\"work_end\":\"21:00\",\"work_days\":[1,2,3,4,5,6,7],\"specialties\":[\"ortho\",\"general\"]}" | jq -r '.id // empty')
RO2=$(api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"OR2\",\"name\":\"ოთახი 2 (გინეკოლოგია)\",\"work_start\":\"08:00\",\"work_end\":\"12:00\",\"work_days\":[1,2,3,4,5,6,7],\"specialties\":[\"gyn\"]}" | jq -r '.id // empty')
RO3=$(api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"OR3\",\"name\":\"ოთახი 3 (უნივერსალური)\",\"work_start\":\"00:00\",\"work_end\":\"23:59\",\"work_days\":[1,2,3,4,5,6,7]}" | jq -r '.id // empty')
[ -n "$RO1" ] && [ -n "$RO2" ] && [ -n "$RO3" ] || die "ოთახები ვერ შეიქმნა"
chk "3 ოთახი; იგივე კოდი ბლოკში → 409; ქირურგი → 403" "$(api GET /or/setup "$SU1" | jq -r --arg b "$DBK" '[.rooms[]|select(.department_id==$b)]|length'):$(code POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"OR1\",\"name\":\"დუბლი\"}"):$(code POST /or/rooms "$SU1" -d "{\"department_id\":\"$DBK\",\"code\":\"OR9\",\"name\":\"x\"}")" "3:409:403"
chk "უცნობი სპეციალობა → 400; ახალი სპეციალობა (admin)" "$(code PATCH "/or/rooms/$RO2" "$ADM" -d '{"specialties":["nope_x"]}'):$(api POST /or/refs/specialties "$ADM" -d "{\"code\":\"e2e_sp$S\",\"name\":\"ტესტ-E2E სპეციალობა\"}" | jq -r '.code|startswith("e2e_sp")')" "400:true"

step "2. პროცედურების კატალოგი"
PR1=$(api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-TKA-$S\",\"ncsp_code\":\"NGB40\",\"name\":\"ტესტ-E2E მუხლის სახსრის ტოტალური ენდოპროთეზირება\",\"specialty_code\":\"ortho\",\"default_duration_min\":120,\"laterality\":true}" | jq -r '.id // empty')
PR2=$(api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-APP-$S\",\"ncsp_code\":\"JEA00\",\"name\":\"ტესტ-E2E აპენდექტომია\",\"specialty_code\":\"general\",\"default_duration_min\":60}" | jq -r '.id // empty')
PR3=$(api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-HYS-$S\",\"name\":\"ტესტ-E2E ჰისტერექტომია\",\"specialty_code\":\"gyn\",\"default_duration_min\":90}" | jq -r '.id // empty')
[ -n "$PR1" ] && [ -n "$PR2" ] && [ -n "$PR3" ] || die "პროცედურები ვერ შეიქმნა"
chk "დუბლი კოდი → 409; არასწორი NCSP → 400; ქირურგი → 403" \
  "$(code POST /or/procedures "$ADM" -d "{\"code\":\"E2E-TKA-$S\",\"name\":\"დუბლი დუბლი\"}"):$(code POST /or/procedures "$ADM" -d "{\"code\":\"E2E-X-$S\",\"ncsp_code\":\"12345\",\"name\":\"xxx xxx\"}"):$(code POST /or/procedures "$SU1" -d "{\"code\":\"E2E-Y-$S\",\"name\":\"yyy yyy\"}")" "409:400:403"
chk "ძებნა (ქირურგი): „ენდოპროთეზ“" "$(api GET "/or/procedures?q=$(jq -rn --arg q ენდოპროთეზ '$q|@uri')" "$SU1" | jq -r --arg c "E2E-TKA-$S" '[.[]|select(.code==$c)]|length')" "1"
CSV=$(printf 'code;name;duration;specialty;ncsp;laterality\nE2E-I1-%s;ტესტ-E2E იმპორტი ქოლეცისტექტომია;75;general;JKA20;\nE2E-I2-%s;ტესტ-E2E იმპორტი მენისკექტომია;45;ortho;NGD10;კი\n' "$S" "$S")
R=$(api POST /or/procedures/import "$ADM" -d "$(jq -nc --arg c "$CSV" '{csv:$c,dry_run:true}')")
chk "CSV იმპორტი — შემოწმება: 2 ახალი, არ ჩაიწერა" "$(echo "$R" | jq -r '"\(.added):\(.applied)"')" "2:false"
R=$(api POST /or/procedures/import "$ADM" -d "$(jq -nc --arg c "$CSV" '{csv:$c}')")
chk "CSV იმპორტი — ჩაიწერა; მენისკექტომია: მხარე სავალდებულო, 45 წთ" "$(echo "$R" | jq -r .applied):$(api GET "/or/procedures?q=E2E-I2-$S" "$ADM" | jq -r '.[0]|"\(.laterality):\(.default_duration_min)"')" "true:true:45"
chk "CSV: უცნობი სპეციალობა → შეცდომა, არ ჩაიწერა" "$(api POST /or/procedures/import "$ADM" -d "$(jq -nc --arg c "E2E-I3-$S;ტესტ-E2E სამი სამი;30;nope" '{csv:$c}')" | jq -r '"\(.errors|length>0):\(.applied)"')" "true:false"

step "3. მოთხოვნა"
REQ() { api POST /or/cases "$1" -d "$2"; }
BODY1="{\"encounter_id\":\"$E1\",\"urgency\":\"elective\",\"anesthesia_type\":\"spinal\",\"preferred_date\":\"$TOMORROW\",\"needs_implant\":true,\"needs_blood\":true,\"blood_note\":\"ერითროციტული მასა 2 ერთ.\",\"procedures\":[{\"procedure_id\":\"$PR1\",\"side\":\"left\"}]}"
chk "რეგისტრატორი → 403; ექთანი → 403" "$(code POST /or/cases "$RC" -d "$BODY1"):$(code POST /or/cases "$NS" -d "$BODY1")" "403:403"
chk "მხარის გარეშე (მუხლი) → 400; წყარო არ არის → 400; ორივე → 400" \
  "$(code POST /or/cases "$SU1" -d "{\"encounter_id\":\"$E1\",\"anesthesia_type\":\"spinal\",\"procedures\":[{\"procedure_id\":\"$PR1\"}]}"):$(code POST /or/cases "$SU1" -d "{\"anesthesia_type\":\"spinal\",\"procedures\":[{\"procedure_id\":\"$PR2\"}]}"):$(code POST /or/cases "$SU1" -d "{\"encounter_id\":\"$E1\",\"planned_id\":\"$PL\",\"anesthesia_type\":\"spinal\",\"procedures\":[{\"procedure_id\":\"$PR2\"}]}")" "400:400:400"
chk "სხვა განყოფილების ქირურგი სხვა ქირურგზე → 403" "$(code POST /or/cases "$SU3" -d "{\"encounter_id\":\"$E1\",\"surgeon_id\":\"$(uid 82)\",\"anesthesia_type\":\"general\",\"procedures\":[{\"procedure_id\":\"$PR2\"}]}")" "403"
C1J=$(REQ "$SU1" "$BODY1"); C1=$(echo "$C1J" | jq -r '.id // empty')
[ -n "$C1" ] || die "მოთხოვნა ვერ შეიქმნა: $(err "$C1J")"
chk "C1: OR-ნომერი, მოთხოვნა, ხანგრძლივობა 120 (კატალოგიდან), დიაგნოზი ჰოსპიტალიზაციიდან, განყოფილება" \
  "$(echo "$C1J" | jq -r '"\(.case_no|test("^OR[0-9]{2}-[0-9]{6}$")):\(.status):\(.duration_min):\(.icd10_code):\(.department_name|test("ქირურგია"))"')" "true:requested:120:M17.1:true"
chk "გუნდი: ოპერატორი ქირურგი ავტომატურად; ჰოსპიტალიზაციის ისტორიაში or_requested" \
  "$(echo "$C1J" | jq -r '[.team[]|select(.role_code=="surgeon")]|length'):$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="or_requested")]|length')" "1:1"
chk "კოორდინატორს — შეტყობინება (or_request)" "$(api GET /notifications "$CO" | jq -r --arg c "$C1" '[.[]|select(.kind=="or_request" and (.link|tostring|contains($c)))]|length')" "1"
chk "მზადყოფნა: სისხლი / იმპლანტი / ადგილის მონიშვნა — ეხება; თანხმობა — არა" \
  "$(echo "$C1J" | jq -r '[.readiness.items[]|select(.applies=="blood" or .applies=="implant" or .applies=="laterality")|.answer]|map(.=="pending")|all'):$(echo "$C1J" | jq -r '.readiness.items[]|select(.source=="consent_surgery")|.answer'):$(echo "$C1J" | jq -r .readiness.ready)" "true:no:false"
C2J=$(REQ "$HD" "{\"planned_id\":\"$PL\",\"surgeon_id\":\"$(uid 83)\",\"anesthesia_type\":\"general\",\"procedures\":[{\"procedure_id\":\"$PR2\",\"is_primary\":true},{\"procedure_id\":\"$PR1\",\"side\":\"right\"}],\"preferred_anesthesiologist_id\":\"$(uid 88)\"}")
C2=$(echo "$C2J" | jq -r '.id // empty')
chk "C2 (ხელმძღვანელი → ქირურგ 2-ზე, გეგმიური რიგიდან): ჰოსპიტ. არ არის, 180 წთ, ძირითადი — აპენდექტომია, K40.9, სასურველი ანესთეზიოლოგი" \
  "$(echo "$C2J" | jq -r '"\(.encounter_id):\(.duration_min):\(.procedures[0].code|startswith("E2E-APP")):\(.icd10_code):\(.preferred_anesthesiologist_name|test("OR-88"))"')" "null:180:true:K40.9:true"
chk "C2: გაფრთხილება — ჰოსპიტალიზაცია ჯერ არ არის (მხოლოდ დაგეგმვისას)" "$(echo "$C2J" | jq -r '.warnings|length')" "0"
chk "რედაქტირება: სხვა ქირურგი (C1) → 403; ოპერატორი — ხანგრძლივობა 100" "$(code PATCH "/or/cases/$C1" "$SU2" -d '{"duration_min":90}'):$(api PATCH "/or/cases/$C1" "$SU1" -d '{"duration_min":100,"reason":"ტესტ-E2E"}' | jq -r .duration_min)" "403:100"
chk "წყარო: P2 — გეგმიური რიგი; ქირურგი ხედავს" "$(api GET "/or/sources?patient_id=$P2" "$SU1" | jq -r '"\(.stays|length):\(.planned|length)"')" "0:1"

step "4. დაგეგმვა (კოორდინატორი)"
SCH() { api POST "/or/cases/$1/schedule" "$2" -d "$3"; }
chk "ქირურგი (coordinator რეჟიმი) → 403; ექთანი → 403" "$(code POST "/or/cases/$C1/schedule" "$SU1" -d "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 10:00)\"}"):$(code POST "/or/cases/$C1/schedule" "$NS" -d "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 10:00)\"}")" "403:403"
R=$(SCH "$C1" "$CO" "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 10:00)\"}")
chk "C1 → OR1 ხვალ 10:00–11:40 (100 წთ), დაგეგმილი" "$(echo "$R" | jq -r '"\(.status):\(.room_code):\(.scheduled_end|test("T07:40:00"))"')" "scheduled:OR1:true"
chk "ქირურგს — შეტყობინება (or_schedule); ისტორია or_scheduled" "$(api GET /notifications "$SU1" | jq -r --arg c "$C1" '[.[]|select(.kind=="or_schedule" and (.link|tostring|contains($c)))]|length'):$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="or_scheduled")]|length')" "1:1"
R=$(SCH "$C2" "$CO" "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 11:00)\"}")
chk "C2 იმავე ოთახში 11:00 (გადაფარვა) → 409 SLOT_UNAVAILABLE" "$(ecode "$R")" "SLOT_UNAVAILABLE"
R=$(SCH "$C2" "$CO" "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 11:55)\"}")
chk "11:55 — მომზადების 30 წთ-ში → 409" "$(ecode "$R")" "SLOT_UNAVAILABLE"
R=$(SCH "$C2" "$CO" "{\"room_id\":\"$RO2\",\"start\":\"$(at "$TOMORROW" 10:00)\"}")
chk "OR2 (გინეკოლოგია, 08–12) — სპეციალობა + საათები → გაფრთხილება (CONFIRM_REQUIRED, 2)" "$(ecode "$R"):$(echo "$R" | jq -r '.warnings|length')" "CONFIRM_REQUIRED:2"
R=$(SCH "$C2" "$CO" "{\"room_id\":\"$RO2\",\"start\":\"$(at "$TOMORROW" 10:00)\",\"confirm\":true}")
chk "დადასტურებით → დაგეგმილი, გაფრთხილებები შენახულია" "$(echo "$R" | jq -r '"\(.status):\(.schedule_warnings|length)"')" "scheduled:2"
chk "C2 — ახლა გაფრთხილება: პაციენტი ჯერ არ არის ჰოსპიტალიზებული" "$(echo "$R" | jq -r '[.warnings[]|select(test("ჰოსპიტალიზებული"))]|length')" "1"
R=$(SCH "$C2" "$CO" "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 12:10)\"}")
chk "გადატანა OR1 12:10 (11:40 + 30 წთ) → rescheduled" "$(echo "$R" | jq -r '"\(.status):\(.room_code):\(.events[0].kind)"')" "scheduled:OR1:rescheduled"
chk "გადადება: მიზეზის გარეშე → 400; მიზეზით → მოთხოვნა, ოთახი თავისუფალი, postpone 1" \
  "$(code POST "/or/cases/$C2/unschedule" "$CO" -d '{}'):$(api POST "/or/cases/$C2/unschedule" "$CO" -d '{"reason":"ტესტ-E2E: ქირურგი შვებულებაშია"}' | jq -r '"\(.status):\(.room_id):\(.postpone_count)"')" "400:requested:null:1"

step "5. ქირურგის ჯავშანი (surgeon_self / both) და გადაუდებელი"
ormod '{"or_scheduling":"surgeon_self"}' >/dev/null
R=$(SCH "$C2" "$SU2" "{\"room_id\":\"$RO2\",\"start\":\"$(at "$TOMORROW" 08:00)\",\"confirm\":true}")
chk "surgeon_self: OR2 (სხვა სპეციალობა) — ქირურგისთვის მკაცრი → 409 SLOT_UNAVAILABLE (confirm-ითაც)" "$(ecode "$R")" "SLOT_UNAVAILABLE"
R=$(SCH "$C2" "$SU2" "{\"room_id\":\"$RO3\",\"start\":\"$(at "$DAY2" 09:00)\"}")
chk "surgeon_self: ქირურგი 2 → OR3 ($DAY2 09:00) → დაგეგმილი" "$(echo "$R" | jq -r '"\(.status):\(.room_code)"')" "scheduled:OR3"
chk "surgeon_self: სხვა ქირურგი (C2-ზე) → 403" "$(code POST "/or/cases/$C2/schedule" "$SU1" -d "{\"room_id\":\"$RO3\",\"start\":\"$(at "$DAY2" 10:00)\"}")" "403"
chk "ქირურგის გადატანა მიზეზის გარეშე → 400" "$(code POST "/or/cases/$C2/schedule" "$SU2" -d "{\"room_id\":\"$RO3\",\"start\":\"$(at "$DAY2" 13:00)\"}")" "400"
ormod '{"or_scheduling":"both"}' >/dev/null
C4J=$(REQ "$SU1" "{\"encounter_id\":\"$E4\",\"anesthesia_type\":\"general\",\"procedures\":[{\"procedure_id\":\"$PR2\"}]}"); C4=$(echo "$C4J" | jq -r '.id // empty')
R=$(SCH "$C4" "$SU1" "{\"room_id\":\"$RO3\",\"start\":\"$(at "$TOMORROW" 15:00)\"}")
chk "both: ქირურგის ჯავშანი → დასადასტურებელი (tentative)" "$(echo "$R" | jq -r '"\(.status):\(.can.confirm)"')" "tentative:false"
chk "დაფის რიგში — დასადასტურებელი" "$(api GET "/or/board?date=$TOMORROW" "$CO" | jq -r --arg c "$C4" '[.queue[]|select(.id==$c)|.status]|join(",")')" "tentative"
chk "დადასტურება: ქირურგი → 403; კოორდინატორი → დაგეგმილი (confirmed)" "$(code POST "/or/cases/$C4/confirm" "$SU1" -d '{}'):$(api POST "/or/cases/$C4/confirm" "$CO" -d '{}' | jq -r '"\(.status):\(.events[0].kind)"')" "403:scheduled:confirmed"
ormod '{"or_scheduling":"coordinator"}' >/dev/null
C3J=$(REQ "$SU1" "{\"encounter_id\":\"$E3\",\"urgency\":\"emergency\",\"anesthesia_type\":\"general\",\"procedures\":[{\"procedure_id\":\"$PR2\"}]}"); C3=$(echo "$C3J" | jq -r '.id // empty')
chk "გადაუდებელი: კოორდინატორს — სასწრაფო შეტყობინება" "$(api GET /notifications "$CO" | jq -r --arg c "$C3" '[.[]|select(.link|tostring|contains($c))|.urgent]|join(",")')" "true"
R=$(SCH "$C3" "$SU1" "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 10:30)\"}")
chk "გადაუდებელი (coordinator რეჟიმშიც) — ქირურგი პირდაპირ; OR1 დაკავებულია → გაფრთხილება, არა ბლოკი" "$(ecode "$R")" "CONFIRM_REQUIRED"
R=$(SCH "$C3" "$SU1" "{\"room_id\":\"$RO1\",\"start\":\"$(at "$TOMORROW" 10:30)\",\"confirm\":true}")
chk "დადასტურებით → დაგეგმილი (რიგს გვერდს უვლის)" "$(echo "$R" | jq -r .status)" "scheduled"
api POST "/or/cases/$C3/schedule" "$CO" -d "{\"room_id\":\"$RO3\",\"start\":\"$(at "$TOMORROW" 18:00)\"}" >/dev/null

step "6. გუნდი"
TEAM() { api POST "/or/cases/$1/team" "$2" -d "$3"; }
chk "ასისტენტი: ქირურგი 1 (საკუთარი) → OK; სხვა განყოფილების ქირურგი → 403" \
  "$(TEAM "$C1" "$SU1" "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 83)\"}" | jq -r '[.team[]|select(.role_code=="assistant" and .removed_at==null)]|length'):$(code POST "/or/cases/$C1/team" "$SU3" -d "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 85)\"}")" "1:403"
chk "იგივე ქირურგი (C2-ის ოპერატორი არ არის) → 403; ხელმძღვანელი → OK" \
  "$(code POST "/or/cases/$C2/team" "$SU1" -d "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 82)\"}"):$(TEAM "$C2" "$HD" "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 82)\"}" | jq -r '[.team[]|select(.role_code=="assistant")]|length')" "403:1"
chk "უფლების გარეშე (რეგისტრატორი — ასისტენტად) → 400" "$(code POST "/or/cases/$C1/team" "$SU1" -d "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 81)\"}")" "400"
chk "anesthesia_head: ქირურგი ანესთეზიოლოგს → 403; რიგითი ანესთეზიოლოგი → 403; ხელმძღვანელი → OK" \
  "$(code POST "/or/cases/$C1/team" "$SU1" -d "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 88)\"}"):$(code POST "/or/cases/$C1/team" "$AN2" -d "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 88)\"}"):$(TEAM "$C1" "$AN1" "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 88)\"}" | jq -r '.team[]|select(.role_code=="anesthesiologist")|.name|test("OR-88")')" "403:403:true"
R=$(TEAM "$C1" "$AN1" "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 87)\"}")
chk "ანესთეზიოლოგი უკვე არის → 409 ROLE_TAKEN" "$(ecode "$R")" "ROLE_TAKEN"
OLDA=$(api GET "/or/cases/$C1" "$AN1" | jq -r '.team[]|select(.role_code=="anesthesiologist" and .removed_at==null)|.id')
R=$(TEAM "$C1" "$AN1" "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 87)\",\"replaces_id\":\"$OLDA\"}")
chk "შეცვლა (replaces_id): ძველი მოხსნილია, ახალი — ანესთეზიოლოგი 1" "$(echo "$R" | jq -r '[.team[]|select(.role_code=="anesthesiologist" and .removed_at==null)|.name|test("OR-87")]|join(",")'):$(echo "$R" | jq -r --arg o "$OLDA" '.team[]|select(.id==$o)|.remove_reason')" "true:შეიცვალა"
R=$(TEAM "$C3" "$AN1" "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 87)\"}")
chk "C3 (OR3 18:00) — სხვა დროს, გადაფარვა არ არის → OK" "$(echo "$R" | jq -r '[.team[]|select(.role_code=="anesthesiologist")]|length')" "1"
R=$(TEAM "$C4" "$AN1" "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$(uid 87)\"}")
chk "C4 (OR3 15:00) — არა-გადაფარვა" "$(echo "$R" | jq -r '[.team[]|select(.role_code=="anesthesiologist")]|length')" "1"
api POST "/or/cases/$C3/schedule" "$CO" -d "{\"room_id\":\"$RO3\",\"start\":\"$(at "$TOMORROW" 10:00)\",\"confirm\":true}" >/dev/null
R=$(SCH "$C3" "$CO" "{\"room_id\":\"$RO3\",\"start\":\"$(at "$TOMORROW" 10:15)\"}")
chk "ერთი ანესთეზიოლოგი ორ ოთახში ერთდროულად (C1 OR1 10:00 / C3 OR3 10:15) → გაფრთხილება" "$(ecode "$R"):$(echo "$R" | jq -r '[.warnings[]|select(test("OR-87"))]|length>0')" "CONFIRM_REQUIRED:true"
api POST "/or/cases/$C3/schedule" "$CO" -d "{\"room_id\":\"$RO3\",\"start\":\"$(at "$TOMORROW" 18:00)\",\"confirm\":true}" >/dev/null
chk "საოპერაციო ექთანი (სკრაბ) — ქირურგი; რამდენიმე დასაშვებია" \
  "$(TEAM "$C1" "$SU1" "{\"role_code\":\"scrub_nurse\",\"user_id\":\"$(uid 89)\"}" >/dev/null; TEAM "$C1" "$SU1" "{\"role_code\":\"circulating_nurse\",\"user_id\":\"$(uid 90)\"}" | jq -r '[.team[]|select(.grp=="nursing" and .removed_at==null)]|length')" "2"
ormod '{"anesthesia_team_by":"surgeon"}' >/dev/null
chk "anesthesia_team_by = surgeon: ქირურგი → ანესთეზიის ექთანი OK; ანესთეზიოლოგიის ხელმძღვანელი → 403" \
  "$(TEAM "$C1" "$SU1" "{\"role_code\":\"anesthesia_nurse\",\"user_id\":\"$(uid 89)\"}" | jq -r '[.team[]|select(.role_code=="anesthesia_nurse")]|length'):$(code POST "/or/cases/$C2/team" "$AN1" -d "{\"role_code\":\"anesthesia_nurse\",\"user_id\":\"$(uid 90)\"}")" "1:403"
ormod '{"anesthesia_team_by":"anesthesia_head"}' >/dev/null
AN_NURSE=$(api GET "/or/cases/$C1" "$SU1" | jq -r '.team[]|select(.role_code=="anesthesia_nurse" and .removed_at==null)|.id')
chk "მოხსნა (დაწყებამდე) — ანესთეზიის ექთანი (ხელმძღვანელი)" "$(api POST "/or/team/$AN_NURSE/remove" "$AN1" -d '{"reason":"ტესტ-E2E"}' | jq -r --arg t "$AN_NURSE" '.team[]|select(.id==$t)|.removed_at!=null')" "true"
chk "ოპერატორის შეცვლა: ქირურგი → 403; ხელმძღვანელი → ქირურგი 2 (ასისტენტიდან ამოიღება)" \
  "$(code POST "/or/cases/$C1/surgeon" "$SU1" -d "{\"surgeon_id\":\"$(uid 83)\",\"reason\":\"ტესტ-E2E\"}"):$(api POST "/or/cases/$C1/surgeon" "$HD" -d "{\"surgeon_id\":\"$(uid 83)\",\"reason\":\"ტესტ-E2E: გრაფიკი\"}" | jq -r '"\(.surgeon_name|test("OR-83")):\([.team[]|select(.role_code=="assistant" and .removed_at==null)]|length)"')" "403:true:0"
api POST "/or/cases/$C1/surgeon" "$HD" -d "{\"surgeon_id\":\"$(uid 82)\",\"reason\":\"ტესტ-E2E: დაბრუნება\"}" >/dev/null
chk "ოპერატორი დაბრუნდა (ქირურგი 1)" "$(api GET "/or/cases/$C1" "$SU1" | jq -r '"\(.surgeon_id==$u):\(.can.edit)"' --arg u "$(uid 82)")" "true:true"

step "7. წინასაოპერაციო"
chk "გასინჯვა: ქირურგი → 403; ექთანი → 403" "$(code PUT "/or/cases/$C1/preop" "$SU1" -d '{"asa_class":2}'):$(code PUT "/or/cases/$C1/preop" "$ON1" -d '{"asa_class":2}')" "403:403"
R=$(api PUT "/or/cases/$C1/preop" "$AN2" -d "{\"asa_class\":2,\"weight_kg\":82,\"height_cm\":165,\"fasting_solids_at\":\"$(ago '10 hours')\",\"risks\":[\"cardiac\",\"ponv\"],\"comorbidities\":\"ჰიპერტენზია\"}")
chk "შავი ვერსია (ანესთეზიოლოგი 2), გეგმა — მოთხოვნის ანესთეზია" "$(echo "$R" | jq -r '.preop[0]|"\(.status):\(.asa_class):\(.planned_anesthesia)"')" "draft:2:spinal"
chk "ხელმოწერა Mallampati-ის გარეშე → 400" "$(code POST "/or/cases/$C1/preop/sign" "$AN2")" "400"
api PUT "/or/cases/$C1/preop" "$AN2" -d '{"mallampati":2,"plan_notes":"სპინალური, ბუპივაკაინი"}' >/dev/null
R=$(api POST "/or/cases/$C1/preop/sign" "$AN2")
chk "ხელმოწერილი; მზადყოფნა: გასინჯვა = კი" "$(echo "$R" | jq -r '.preop[0].status'):$(echo "$R" | jq -r '.readiness.items[]|select(.source=="assessment")|.answer')" "signed:yes"
chk "ხელმოწერილის შეცვლა → 409" "$(code PUT "/or/cases/$C1/preop" "$AN2" -d '{"asa_class":3}')" "409"
for C in OR_SURGERY OR_ANESTHESIA; do
  api POST "/patients/$P1/consents" "$NS" -d "$(jq -nc --arg e "$E1" --arg s "$SIG" --arg c "$C" '{type_code:$c,decision:"granted",method:"electronic",signer_type:"patient",encounter_id:$e,signature_png:$s}')" >/dev/null
done
R=$(api GET "/or/cases/$C1" "$ON1")
chk "თანხმობები (ოპერაცია + ანესთეზია) → კი (ავტომატურად)" "$(echo "$R" | jq -r '[.readiness.items[]|select(.source|startswith("consent"))|.answer]|join(",")')" "yes,yes"
ITEM() { echo "$R" | jq -r --arg a "$1" '.readiness.items[]|select(.applies==$a and .source=="manual")|.id' | head -1; }
I_SITE=$(ITEM laterality); I_BLOOD=$(ITEM blood); I_IMPL=$(ITEM implant)
I_AUTO=$(echo "$R" | jq -r '.readiness.items[]|select(.source=="assessment")|.id')
chk "ავტომატური პუნქტი ხელით → 400; რეგისტრატორი → 403" "$(code PUT "/or/cases/$C1/readiness" "$ON1" -d "{\"item_id\":\"$I_AUTO\",\"answer\":\"yes\"}"):$(code PUT "/or/cases/$C1/readiness" "$RC" -d "{\"item_id\":\"$I_SITE\",\"answer\":\"yes\"}")" "400:403"
R=$(api PUT "/or/cases/$C1/readiness" "$ON1" -d "{\"item_id\":\"$I_SITE\",\"answer\":\"yes\"}")
chk "საოპერაციო ექთანი: ადგილი მონიშნულია → კი, ჯერ არ არის მზად" "$(echo "$R" | jq -r '.readiness.items[]|select(.applies=="laterality")|.answer'):$(echo "$R" | jq -r .readiness.ready)" "yes:false"

step "8. WHO ჩეკლისტი"
WHO_ITEMS() { api GET "/or/cases/$1" "$ON1" | jq -c --arg p "$2" --arg v "$3" '[.who_items[]|select(.phase==$p)|{key:.id,value:$v}]|from_entries'; }
chk "ოპერაცია დაუწყებელია, მაგრამ დაგეგმილი — Time out Sign in-მდე → 409" "$(ecode "$(api POST "/or/cases/$C1/who" "$ON1" -d "{\"phase\":\"time_out\",\"answers\":$(WHO_ITEMS "$C1" time_out yes)}")")" "WHO_ORDER"
A=$(WHO_ITEMS "$C1" sign_in yes); FIRST=$(echo "$A" | jq -r 'keys[0]')
chk "Sign in: ერთი პუნქტი „არა“ → 400 WHO_INCOMPLETE" "$(ecode "$(api POST "/or/cases/$C1/who" "$ON1" -d "{\"phase\":\"sign_in\",\"answers\":$(echo "$A" | jq -c --arg k "$FIRST" '.[$k]="no"')}")")" "WHO_INCOMPLETE"
chk "გუნდის გარეშე ექთანი (განყოფილების) → 403" "$(code POST "/or/cases/$C1/who" "$NS" -d "{\"phase\":\"sign_in\",\"answers\":$A}")" "403"
R=$(api POST "/or/cases/$C1/who" "$ON1" -d "{\"phase\":\"sign_in\",\"answers\":$(echo "$A" | jq -c --arg k "$FIRST" '.[$k]="na"')}")
chk "Sign in — შევსებული (საოპერაციო ექთანი)" "$(echo "$R" | jq -r '[.who[]|select(.phase=="sign_in" and .voided_at==null)]|length')" "1"
chk "იგივე ეტაპი მეორედ → 409" "$(code POST "/or/cases/$C1/who" "$ON1" -d "{\"phase\":\"sign_in\",\"answers\":$A}")" "409"

step "9. დროის ნიშნულები"
TM() { api POST "/or/cases/$1/times" "$2" -d "$3"; }
chk "განაკვეთი შემოსვლამდე → 409 TIME_ORDER" "$(ecode "$(TM "$C1" "$ON1" "{\"kind\":\"incision\"}")")" "TIME_ORDER"
R=$(TM "$C1" "$ON1" "{\"kind\":\"in_room\",\"at\":\"$(ago '70 minutes')\"}")
chk "შემოსვლა — მზადყოფნა არასრულია (warn) → 409 PREOP_OVERRIDE_REQUIRED (სისხლი, იმპლანტი, …)" "$(ecode "$R"):$(echo "$R" | jq -r '.missing|length>=2')" "PREOP_OVERRIDE_REQUIRED:true"
R=$(TM "$C1" "$ON1" "{\"kind\":\"in_room\",\"at\":\"$(ago '70 minutes')\",\"readiness_override\":\"ტესტ-E2E: სისხლი ბანკშია, იმპლანტი ოთახში\"}")
chk "დასაბუთებით → მიმდინარე; დასაბუთება შენახულია; გუნდს — შემოსვლის დრო" \
  "$(echo "$R" | jq -r '"\(.status):\(.readiness_override|test("ბანკ")):\([.team[]|select(.removed_at==null and .in_at==null)]|length)"')" "in_progress:true:0"
chk "ჰოსპიტალიზაციის ისტორიაში or_started" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="or_started")]|length')" "1"
chk "ანესთეზიის დაწყება (ანესთეზიოლოგი, გუნდში) — შემოსვლამდე → 400; სწორად → OK" \
  "$(code POST "/or/cases/$C1/times" "$AN1" -d "{\"kind\":\"anesthesia_start\",\"at\":\"$(ago '80 minutes')\"}"):$(TM "$C1" "$AN1" "{\"kind\":\"anesthesia_start\",\"at\":\"$(ago '65 minutes')\"}" | jq -r '[.times[]|select(.kind=="anesthesia_start")]|length')" "400:1"
chk "განაკვეთი Time out-ის გარეშე → 409 WHO_TIME_OUT" "$(ecode "$(TM "$C1" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(ago '50 minutes')\"}")")" "WHO_TIME_OUT"
R=$(api POST "/or/cases/$C1/who" "$SU1" -d "{\"phase\":\"time_out\",\"answers\":$(WHO_ITEMS "$C1" time_out yes)}")
chk "Time out (ქირურგი)" "$(echo "$R" | jq -r '[.who[]|select(.phase=="time_out")]|length')" "1"
R=$(TM "$C1" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(ago '50 minutes')\"}")
chk "განაკვეთი → OK; ფაზა = incision" "$(api GET "/or/cases?encounter_id=$E1" "$SU1" | jq -r --arg c "$C1" '.[]|select(.id==$c)|.phase')" "incision"
chk "Time out-ის გაუქმება განაკვეთის შემდეგ → 409" "$(code POST "/or/who/$(echo "$R" | jq -r '.who[]|select(.phase=="time_out")|.id')/void" "$SU1" -d '{"reason":"ტესტ-E2E"}')" "409"
chk "განაკვეთი მეორედ → 409 TIME_EXISTS; შესწორება მიზეზით → ძველი superseded" \
  "$(ecode "$(TM "$C1" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(ago '48 minutes')\"}")"):$(TM "$C1" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(ago '48 minutes')\",\"correction_reason\":\"ტესტ-E2E: დრო დაზუსტდა\"}" | jq -r '"\([.times[]|select(.kind=="incision")]|length):\([.times[]|select(.kind=="incision" and .superseded_by==null)]|length)"')" "TIME_EXISTS:2:1"
chk "შესწორება: განაკვეთი შემოსვლამდე → 400" "$(code POST "/or/cases/$C1/times" "$SU1" -d "{\"kind\":\"incision\",\"at\":\"$(ago '90 minutes')\",\"correction_reason\":\"ტესტ-E2E\"}")" "400"
R=$(TEAM "$C1" "$SU1" "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 85)\",\"at\":\"$(ago '40 minutes')\"}")
chk "გუნდი დაწყების შემდეგ: ასისტენტი შემოვიდა დროით (in_at)" "$(echo "$R" | jq -r '[.team[]|select(.role_code=="assistant" and (.name|test("OR-85")) and .in_at!=null)]|length')" "1"
SCRUB=$(echo "$R" | jq -r '.team[]|select(.role_code=="scrub_nurse" and .out_at==null and .removed_at==null)|.id')
R=$(TEAM "$C1" "$SU1" "{\"role_code\":\"scrub_nurse\",\"user_id\":\"$(uid 90)\",\"replaces_id\":\"$SCRUB\",\"at\":\"$(ago '30 minutes')\"}")
chk "სკრაბ ექთნის შეცვლა: ძველი — გავიდა (out_at), replaced_by" "$(echo "$R" | jq -r --arg t "$SCRUB" '.team[]|select(.id==$t)|"\(.out_at!=null):\(.replaced_by!=null):\(.removed_at)"')" "true:true:null"
TM "$C1" "$SU1" "{\"kind\":\"closure\",\"at\":\"$(ago '20 minutes')\"}" >/dev/null
chk "გასვლა ანესთეზიის დასრულებამდე → 409 TIME_ORDER" "$(ecode "$(TM "$C1" "$ON1" "{\"kind\":\"out_of_room\",\"at\":\"$(ago '10 minutes')\"}")")" "TIME_ORDER"
TM "$C1" "$AN1" "{\"kind\":\"anesthesia_end\",\"at\":\"$(ago '15 minutes')\"}" >/dev/null
chk "გასვლა Sign out-ის გარეშე → 409 WHO_SIGN_OUT" "$(ecode "$(TM "$C1" "$ON1" "{\"kind\":\"out_of_room\",\"at\":\"$(ago '10 minutes')\",\"destination\":\"icu\"}")")" "WHO_SIGN_OUT"
api POST "/or/cases/$C1/who" "$ON1" -d "{\"phase\":\"sign_out\",\"answers\":$(WHO_ITEMS "$C1" sign_out yes)}" >/dev/null
R=$(TM "$C1" "$ON1" "{\"kind\":\"out_of_room\",\"at\":\"$(ago '10 minutes')\",\"destination\":\"icu\"}")
chk "Sign out → გასვლა → დასრულებული; ისტორიაში or_completed" "$(echo "$R" | jq -r .status):$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="or_completed")]|length')" "completed:1"
chk "დასრულებულის გაუქმება / გადადება → 409" "$(code POST "/or/cases/$C1/cancel" "$CO" -d '{"reason_code":"other","note":"xxx"}'):$(code POST "/or/cases/$C1/unschedule" "$CO" -d '{"reason":"xxx"}')" "409:409"
chk "ნიშნულების რაოდენობა (მიმდინარე): 6" "$(echo "$R" | jq -r '[.times[]|select(.superseded_by==null)]|length')" "6"
ormod '{"preop_readiness":"block"}' >/dev/null
R=$(TM "$C4" "$ON1" "{\"kind\":\"in_room\",\"readiness_override\":\"ტესტ-E2E\"}")
chk "preop_readiness = block: მზადყოფნის გარეშე → 409 PREOP_NOT_READY (დასაბუთებითაც)" "$(ecode "$R")" "PREOP_NOT_READY"
ormod '{"preop_readiness":"warn"}' >/dev/null
chk "C2 (ჯერ ჰოსპიტალიზაცია არ არის) — შემოსვლა → 409 NOT_ADMITTED" "$(ecode "$(TM "$C2" "$ON1" "{\"kind\":\"in_room\",\"readiness_override\":\"ტესტ-E2E\"}")")" "NOT_ADMITTED"

step "10. რეანიმაცია: წყარო „საოპერაციო“"
T1=$(api POST "/inpatient/stays/$E1/transfer" "$SU1" -d "{\"to_department_id\":\"$DI\",\"reason\":\"ტესტ-E2E: ოპერაციის შემდეგ\"}" | jq -r '.id // empty')
R=$(api POST "/inpatient/transfers/$T1/accept" "$NI" -d "{\"attending_doctor_id\":\"$(uid 82)\",\"bed_id\":\"$BI1\"}")
chk "გადაყვანა ICU-ში ოპერაციიდან 10 წთ-ში → ეპიზოდის წყარო „or“" "$(echo "$R" | jq -r .status):$(api GET "/inpatient/stays/$E1/icu" "$NI" | jq -r '.episode.origin')" "accepted:or"

step "11. გაუქმება, გეგმიური რიგი → ჰოსპიტალიზაცია"
chk "გაუქმება: უცნობი მიზეზი → 400; „სხვა“ განმარტების გარეშე → 400; სხვა განყოფილების ქირურგი → 403" \
  "$(code POST "/or/cases/$C3/cancel" "$SU1" -d '{"reason_code":"nope"}'):$(code POST "/or/cases/$C3/cancel" "$SU1" -d '{"reason_code":"other"}'):$(code POST "/or/cases/$C3/cancel" "$SU3" -d '{"reason_code":"patient_refused"}')" "400:400:403"
R=$(api POST "/or/cases/$C3/cancel" "$SU1" -d '{"reason_code":"patient_refused","note":"ტესტ-E2E"}')
chk "გაუქმებული (პაციენტის უარი); ოთახი — თავისუფალი დაფაზე; ისტორია or_cancelled" "$(echo "$R" | jq -r '"\(.status):\(.cancel_reason_name|test("უარი"))"'):$(api GET "/or/board?date=$TOMORROW" "$CO" | jq -r --arg c "$C3" '[.cases[]|select(.id==$c)]|length'):$(api GET "/inpatient/stays/$E3" "$ADM" | jq -r '[.events[].kind|select(.=="or_cancelled")]|length')" "cancelled:true:0:1"
A2=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P2\",\"department_id\":\"$DS\",\"attending_doctor_id\":\"$(uid 82)\",\"source\":\"planned\",\"planned_id\":\"$PL\",\"icd10_code\":\"K40.9\",\"bed_id\":\"$BS2\"}")
E2=$(echo "$A2" | jq -r '.encounter_id // empty')
chk "გეგმიური რიგიდან ჰოსპიტალიზაცია → C2-ს ავტომატურად მიება ჰოსპიტალიზაცია, გაფრთხილება გაქრა" "$(api GET "/or/cases/$C2" "$SU2" | jq -r '"\(.encounter_id==$e):\(.adm_no!=null):\(.warnings|length)"' --arg e "$E2")" "true:true:0"

step "12. დაფა, „ჩემი ოპერაციები“"
BD=$(api GET "/or/board?date=$TOMORROW&block_id=$DBK" "$CO")
chk "დაფა (ხვალ, ბლოკი): 3 ოთახი; C4 OR3-ში; C1 (დასრულებული) — ხვალინდელ განრიგში" "$(echo "$BD" | jq -r '.rooms|length'):$(echo "$BD" | jq -r --arg c "$C4" '.cases[]|select(.id==$c)|.room_code'):$(echo "$BD" | jq -r --arg c "$C1" '.cases[]|select(.id==$c)|.status')" "3:OR3:completed"
chk "დაფა: მზადყოფნის შეჯამება C4-ზე; WHO ეტაპები C1-ზე" "$(echo "$BD" | jq -r --arg c "$C4" '.cases[]|select(.id==$c)|.readiness.ready'):$(echo "$BD" | jq -r --arg c "$C1" '.cases[]|select(.id==$c)|.who_done|length')" "false:3"
chk "კვირის ხედი (7 დღე) — C2 ($DAY2) ჩანს" "$(api GET "/or/board?date=$TOMORROW&days=7&block_id=$DBK" "$CO" | jq -r --arg c "$C2" '[.cases[]|select(.id==$c)]|length')" "1"
chk "„ჩემი ოპერაციები“: ქირურგი 1 — C1, C4 (ოპერატორი); ანესთეზიოლოგი 1 — C1 (როლით)" \
  "$(api GET /or/my "$SU1" | jq -r --arg a "$C1" --arg b "$C4" '[.[]|select(.id==$a or .id==$b)]|length'):$(api GET /or/my "$AN1" | jq -r --arg a "$C1" '.[]|select(.id==$a)|.my_roles|join(",")|test("ანესთეზიოლოგი")')" "2:true"
chk "დაფა: რეგისტრატორი → 403; მენეჯერი/ნახვა — თანამშრომლების სია (ანესთეზიოლოგები ≥ 2)" "$(code GET /or/board "$RC"):$(api GET "/or/staff?cap=anesthesiologist" "$CO" | jq -r 'length>=2')" "403:true"

step "13. ადმინისტრირება"
chk "მოდული: არასწორი რეჟიმი → 400; turnover 500 → 400; უცნობი გასაღები → 400" \
  "$(code PUT /modules/or "$ADM" -d '{"settings":{"or_scheduling":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"turnover_min":500},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"foo":1},"reason":"ტესტ-E2E"}')" "400:400:400"
WI1=$(api POST /or/who-items "$ADM" -d "{\"phase\":\"time_out\",\"label\":\"ტესტ-E2E დამატებითი პუნქტი $S\",\"sort_order\":99}" | jq -r '.id // empty')
chk "WHO პუნქტი დაემატა → Time out-ის ფორმაში ჩანს; გათიშვა" "$(api GET "/or/cases/$C4" "$ON1" | jq -r --arg i "$WI1" '[.who_items[]|select(.id==$i)]|length'):$(api PATCH "/or/who-items/$WI1" "$ADM" -d '{"is_active":false}' | jq -r .is_active)" "1:false"
RI=$(api POST /or/readiness-items "$ADM" -d "{\"label\":\"ტესტ-E2E ანტიკოაგულანტი შეწყვეტილია $S\",\"applies\":\"always\"}" | jq -r '.id // empty')
chk "მზადყოფნის პუნქტი დაემატა (ხელით) → C4-ზე „pending“; გათიშვა" "$(api GET "/or/cases/$C4" "$ON1" | jq -r --arg i "$RI" '.readiness.items[]|select(.id==$i)|.answer'):$(api PATCH "/or/readiness-items/$RI" "$ADM" -d '{"is_active":false}' | jq -r .is_active)" "pending:false"
chk "გაუქმების მიზეზი / გუნდის როლი: დამატება; სისტემური როლის გათიშვა → 400" \
  "$(api POST /or/refs/cancel-reasons "$ADM" -d "{\"code\":\"e2e_cr$S\",\"name\":\"ტესტ-E2E მიზეზი\"}" | jq -r '.code|startswith("e2e_cr")'):$(api POST /or/refs/team-roles "$ADM" -d "{\"code\":\"e2e_tr$S\",\"name\":\"ტესტ-E2E პერფუზიოლოგი\",\"grp\":\"surgical\",\"capability\":\"doctor\"}" | jq -r .grp):$(code PATCH /or/refs/team-roles/surgeon "$ADM" -d '{"is_active":false}')" "true:surgical:400"
api PATCH "/or/refs/team-roles/e2e_tr$S" "$ADM" -d '{"is_active":false}' >/dev/null; api PATCH "/or/refs/cancel-reasons/e2e_cr$S" "$ADM" -d '{"is_active":false}' >/dev/null
api PATCH "/or/refs/specialties/e2e_sp$S" "$ADM" -d '{"is_active":false}' >/dev/null
chk "ოთახის გათიშვა, როცა დაგეგმილია ოპერაცია → 409" "$(code PATCH "/or/rooms/$RO3" "$ADM" -d '{"is_active":false}')" "409"
chk "უფლებების კატალოგში: or_schedule, anesthesiologist, or_nurse" "$(api GET /roles/capabilities "$ADM" | jq -r '[.[]|select(.code=="or_schedule" or .code=="anesthesiologist" or .code=="or_nurse")]|length')" "3"

step "14. აღდგენა"
for C in "$C2" "$C4"; do api POST "/or/cases/$C/cancel" "$CO" -d '{"reason_code":"other","note":"ტესტ-E2E: დასრულება"}' >/dev/null; done
for R in "$RO1" "$RO2" "$RO3"; do api PATCH "/or/rooms/$R" "$ADM" -d '{"is_active":false}' >/dev/null; done
for P in "$PR1" "$PR2" "$PR3"; do api PATCH "/or/procedures/$P" "$ADM" -d '{"is_active":false}' >/dev/null; done
api POST /or/procedures/import "$ADM" -d "$(jq -nc --arg c "$(printf 'E2E-I1-%s;ტესტ-E2E იმპორტი ქოლეცისტექტომია\nE2E-I2-%s;ტესტ-E2E იმპორტი მენისკექტომია' "$S" "$S")" '{csv:$c}')" >/dev/null
for i in 1 2; do id=$(api GET "/or/procedures?q=E2E-I$i-$S" "$ADM" | jq -r '.[0].id // empty'); [ -n "$id" ] && api PATCH "/or/procedures/$id" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/or "$ADM" -d "{\"settings\":$ORIG_OR,\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG_IPD,\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings' | jq -S -c .)" "$(echo "$ORIG_OR" | jq -S -c .)"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
