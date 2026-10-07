#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-notes.sh — სტაციონარი, ეტაპი 0045: ექიმის ჩანაწერები, კონსულტაციები, ფორმა №IV-100/ა სტაციონარიდან
#   0. მომზადება   1. უფლებები   2. მიმღები გასინჯვა (შავი ვერსია → ხელმოწერა)   3. დღიური   4. შესწორება (ვერსიები)
#   5. შემოვლა, ჩასმა   6. კონსულტაცია (მოთხოვნა → პასუხი → ბილინგი)   7. მიმდინარეობა, შაბლონები, PDF
#   8. ფორმა 100 (ავტომატური შევსება, გაცემა, გაუქმება, ხელახლა)   9. გაწერის გაფრთხილებები, აღდგენა
# გამოყენება:  bash scripts/e2e-ipd-notes.sh [API_URL]
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
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F)

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ჩანაწ. თერაპია $S\",\"code\":\"E2EDA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ჩანაწ. კარდიოლოგია $S\",\"code\":\"E2EDB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
TAR=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2ECN$S\",\"title\":\"ტესტ-E2E კარდიოლოგის კონსულტაცია\",\"base_price\":45}" | jq -r '.id // empty')
[ -n "$TAR" ] || die "ტარიფი ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.dn.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ჩანაწ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.dn.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 21)
NA=$(mkuser '["nurse"]' 22 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 23 ",\"department_id\":\"$DA\"")                    # მკურნალი
D2=$(mkuser '["doctor"]' 24 ",\"department_id\":\"$DA\"")
HD=$(mkuser '["doctor"]' 25 ",\"department_id\":\"$DA\",\"is_section_head\":true")
DX=$(mkuser '["doctor"]' 26 ",\"department_id\":\"$DB\",\"consultation_tariff_id\":\"$TAR\"")   # კონსულტანტი
DY=$(mkuser '["doctor"]' 27 ",\"department_id\":\"$DB\"")
for t in RC NA DR D2 HD DX DY; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები (რეგისტრატორი, ექთანი, 3 ექიმი A + ხელმძღვანელი, 2 ექიმი B; კონსულტანტს — ტარიფი 45 ₾)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1958-05-05\",\"gender\":\"male\",\"phone_number\":\"596$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 61 "ჩანაწერები"); P2=$(mkpat 62 "ჩანაწერები-2")
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"admission_note_hours":24,"progress_note_daily":true,"consult_due_hours":{"routine":24,"urgent":2,"emergency":1},"consult_billing":true,"form100_on_discharge":"warn"}'
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 23)\",\"source\":\"direct\",\"icd10_code\":\"I10\",\"chief_complaint\":\"ტესტ-E2E თავის ტკივილი\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "2 ჰოსპიტალიზაცია" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
NL="/inpatient/stays/$E1/notes"

step "1. უფლებები"
chk "რეგისტრატორი — 403; ექთანი ხედავს (can.write=false), წერა — 403; სხვა განყოფილების ექიმი — 403" \
  "$(code GET "$NL" "$RC"):$(api GET "$NL" "$NA" | jq -r .can.write):$(code POST "$NL" "$NA" -d '{"kind":"progress"}'):$(code POST "$NL" "$DX" -d '{"kind":"progress"}')" "403:false:403:403"
chk "ველები / შეხსენება: მიმღები გასინჯვა — ჯერ არა ვადაგადაცილებული" "$(api GET "$NL" "$DR" | jq -r '"\(.fields.progress|map(.key)|join(",")):\(.admission.overdue)"')" "s,o,a,p:false"

step "2. მიმღები გასინჯვა"
R=$(api POST "$NL" "$DR" -d '{"kind":"admission","content":{"complaints":"ტესტ-E2E: თავის ტკივილი, თავბრუსხვევა"}}'); AD=$(echo "$R" | jq -r '.id // empty')
chk "შავი ვერსია (draft, v1)" "$(echo "$R" | jq -r '"\(.status):\(.version)"')" "draft:1"
chk "უცნობი ველი — 400" "$(code PUT "/inpatient/notes/$AD" "$DR" -d '{"content":{"xyz":"1"}}')" "400"
chk "სხვა ექიმი შავ ვერსიას ვერ ხედავს / ვერ ასწორებს" "$(api GET "$NL" "$D2" | jq -r --arg i "$AD" '[.notes[]|select(.id==$i)]|length'):$(code PUT "/inpatient/notes/$AD" "$D2" -d '{"content":{"plan":"x"}}')" "0:403"
chk "ხელმოწერა სავალდებულო ველების გარეშე — 400 NOTE_REQUIRED (ობიექტური, გეგმა)" "$(api POST "/inpatient/notes/$AD/sign" "$DR" | jq -r '"\(.code):\(.fields|length)"')" "NOTE_REQUIRED:2"
api PUT "/inpatient/notes/$AD" "$DR" -d '{"content":{"complaints":"ტესტ-E2E: თავის ტკივილი, თავბრუსხვევა","objective":"ტესტ-E2E: AD 170/100, გული — რიტმული","plan":"ანტიჰიპერტენზიული თერაპია, EKG"}}' >/dev/null
R=$(api POST "/inpatient/notes/$AD/sign" "$DR")
chk "ხელმოწერა → signed; ისტორიაში note_signed" "$(echo "$R" | jq -r .status):$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|index("note_signed")!=null')" "signed:true"
chk "ხელმოწერილის რედაქტირება — 409; წაშლა — 403; მეორე მიმღები გასინჯვა — 409" \
  "$(code PUT "/inpatient/notes/$AD" "$DR" -d '{"content":{"plan":"x"}}'):$(code DELETE "/inpatient/notes/$AD" "$DR"):$(api POST "$NL" "$D2" -d '{"kind":"admission","content":{}}' | jq -r .code)" "409:403:ADMISSION_NOTE_EXISTS"
chk "ექთანი ხედავს ხელმოწერილს" "$(api GET "$NL" "$NA" | jq -r --arg i "$AD" '[.notes[]|select(.id==$i)]|length')" "1"

step "3. დღიური"
chk "თარიღი ჰოსპიტალიზაციამდე — 400; მომავალში — 400" \
  "$(code POST "$NL" "$DR" -d "{\"kind\":\"progress\",\"note_date\":\"$(date -d "$TODAY -3 days" +%F)\"}"):$(code POST "$NL" "$DR" -d "{\"kind\":\"progress\",\"note_date\":\"$(date -d "$TODAY +1 day" +%F)\"}")" "400:400"
chk "პირდაპირ ხელმოწერა (sign:true) A-ს გარეშე — 400; A-თი — signed" \
  "$(code POST "$NL" "$D2" -d '{"kind":"progress","content":{"s":"უკეთ"},"sign":true}'):$(api POST "$NL" "$D2" -d '{"kind":"progress","content":{"s":"ტესტ-E2E: თავის ტკივილი შემცირდა","a":"ტესტ-E2E: მდგომარეობა სტაბილური, AD 145/90","p":"გაგრძელება"},"sign":true}' | jq -r .status)" "400:signed"
DD=$(api POST "$NL" "$DR" -d '{"kind":"progress","content":{"s":"დრაფტი"}}' | jq -r .id)
chk "შავი ვერსიის წაშლა (ავტორი) — OK; სხვისი — 403" "$(code DELETE "/inpatient/notes/$DD" "$D2"):$(api DELETE "/inpatient/notes/$DD" "$DR" | jq -r .deleted)" "403:true"

step "4. შესწორება"
chk "შესწორება: სხვა ექიმი (არა ავტორი / მკურნალი / ხელმძღვანელი) — 403; მიზეზის გარეშე — 400" \
  "$(code POST "/inpatient/notes/$AD/amend" "$D2" -d '{"reason":"ტესტ-E2E"}'):$(code POST "/inpatient/notes/$AD/amend" "$HD" -d '{}')" "403:400"
R=$(api POST "/inpatient/notes/$AD/amend" "$HD" -d '{"reason":"ტესტ-E2E: წნევის ციფრი დაზუსტდა"}'); A2=$(echo "$R" | jq -r '.id // empty')
chk "ხელმძღვანელი → v2 (draft, შიგთავსი დაკოპირდა); მეორე შესწორება პარალელურად — 409" \
  "$(echo "$R" | jq -r '"\(.version):\(.status):\(.content.plan|test("ანტიჰიპერტენზიული"))"'):$(code POST "/inpatient/notes/$AD/amend" "$DR" -d '{"reason":"ტესტ-E2E"}')" "2:draft:true:409"
api PUT "/inpatient/notes/$A2" "$HD" -d '{"content":{"complaints":"ტესტ-E2E: თავის ტკივილი, თავბრუსხვევა","objective":"ტესტ-E2E: AD 175/105, გული — რიტმული","plan":"ანტიჰიპერტენზიული თერაპია, EKG"}}' >/dev/null
api POST "/inpatient/notes/$A2/sign" "$HD" >/dev/null
chk "v2 ხელმოწერა → v1 superseded; ისტორია — 2 ვერსია; მიმდინარე მიმღები = v2; note_amended" \
  "$(api GET "/inpatient/notes/$AD/history" "$DR" | jq -r '"\(length):\(.[0].superseded_at!=null):\(.[1].superseded_at)"'):$(api GET "$NL" "$DR" | jq -r .admission.note_id):$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|index("note_amended")!=null')" \
  "2:true:null:$A2:true"

step "5. შემოვლა, ჩასმა"
chk "შემოვლა მონაწილეების გარეშე (არა ხელმძღვანელი) — 400; ხელმძღვანელი — OK, მონაწილეებით" \
  "$(code POST "$NL" "$D2" -d '{"kind":"rounds","content":{"findings":"x"}}'):$(api POST "$NL" "$HD" -d "{\"kind\":\"rounds\",\"content\":{\"findings\":\"ტესტ-E2E: დიაგნოზი დადასტურდა\"},\"participants\":[\"$(uid 23)\",\"$(uid 24)\"],\"sign\":true}" | jq -r '"\(.status):\(.participant_names|length)"')" "400:signed:2"
api POST "/inpatient/stays/$E1/vitals" "$NA" -d '{"respiratory_rate":18,"spo2":96,"o2_supplement":false,"systolic_bp":150,"diastolic_bp":95,"heart_rate":88,"consciousness":"A","temperature":36.9}' >/dev/null
api POST "/inpatient/stays/$E1/fluid" "$NA" -d '{"category":"po","volume_ml":800}' >/dev/null
chk "„O“ ჩასმა: ვიტალები + NEWS2 + ბალანსი" "$(api GET "$NL/insert" "$DR" | jq -r '.text|(test("ვიტალები") and test("NEWS2") and test("ბალანსი"))')" "true"

step "6. კონსულტაცია"
CN="/inpatient/stays/$E1/consultations"
chk "მიზნის გარეშე — 400; ექთანი — 403" "$(code POST "$CN" "$DR" -d '{"urgency":"urgent","question":"ტესტ"}'):$(code POST "$CN" "$NA" -d "{\"target_department_id\":\"$DB\",\"urgency\":\"urgent\",\"question\":\"ტესტ\"}")" "400:403"
R=$(api POST "$CN" "$DR" -d "{\"target_department_id\":\"$DB\",\"urgency\":\"urgent\",\"question\":\"ტესტ-E2E: EKG-ზე ცვლილებები, გთხოვთ შეფასება\"}"); C1=$(echo "$R" | jq -r '.id // empty')
chk "მოთხოვნა: urgent, ვადა ~2 სთ, from = A" "$(echo "$R" | jq -r '"\(.status):\(.urgency):\(((.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - now) / 3600 | floor)"'):$(echo "$R" | jq -r '.from_department_name|test("თერაპია")')" "requested:urgent:1:true"
chk "შეტყობინება B-ს ექიმებს (ორივეს)" "$(for t in DX DY; do api GET /notifications "${!t}" | jq -r '[.[]|select(.kind=="ipd_consult" and (.title|test("ჩანაწერები")))]|length'; done | tr '\n' ':')" "1:1:"
chk "inbox: კონსულტანტთან ჩანს; A-ს ექიმთან — არა" "$(api GET /inpatient/consultations/inbox "$DX" | jq -r --arg c "$C1" '[.[]|select(.id==$c)]|length'):$(api GET /inpatient/consultations/inbox "$D2" | jq -r --arg c "$C1" '[.[]|select(.id==$c)]|length')" "1:0"
chk "A-ს ექიმი პასუხს ვერ წერს — 403; consultation_id-ის გარეშე — 400" \
  "$(code POST "$NL" "$D2" -d "{\"kind\":\"consult\",\"consultation_id\":\"$C1\"}"):$(code POST "$NL" "$DX" -d '{"kind":"consult"}')" "403:400"
R=$(api POST "$NL" "$DX" -d "{\"kind\":\"consult\",\"consultation_id\":\"$C1\",\"content\":{\"assessment\":\"ტესტ-E2E: მარცხენა პარკუჭის ჰიპერტროფია\",\"recommendations\":\"ექოკარდიოგრაფია, ბისოპროლოლი\"},\"sign\":true}")
chk "პასუხი ხელმოწერილი → კონსულტაცია answered; ბილინგი 45 ₾" \
  "$(echo "$R" | jq -r '"\(.status):\((.billed.amount|tonumber)+0)"'):$(api GET "$NL" "$DR" | jq -r --arg c "$C1" '.consultations[]|select(.id==$c)|"\(.status):\(.answered_by_name|test("ჩანაწ-26"))"')" "signed:45:answered:true"
chk "ინვოისში ხაზი (consultation_id)" "$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r --arg c "$C1" '[.lines[]|select(.consultation_id==$c)][0].unit_price|tonumber')" "45"
chk "მომთხოვნს შეტყობინება (ipd_consult_done); მეორედ პასუხი — 409; გაუქმება — 409" \
  "$(api GET /notifications "$DR" | jq -r '[.[]|select(.kind=="ipd_consult_done")]|length>0'):$(code POST "$NL" "$DY" -d "{\"kind\":\"consult\",\"consultation_id\":\"$C1\"}"):$(code POST "/inpatient/consultations/$C1/cancel" "$DR" -d '{"reason":"ტესტ-E2E"}')" "true:409:409"
C2=$(api POST "$CN" "$DR" -d "{\"target_doctor_id\":\"$(uid 27)\",\"urgency\":\"routine\",\"question\":\"ტესტ-E2E: მეორე\"}" | jq -r '.id // empty')
chk "კონკრეტული ექიმი: სხვა ექიმი (იმავე განყ.) პასუხს ვერ წერს — 403; გაუქმება: არა მომთხოვნი — 403; მომთხოვნი — OK" \
  "$(code POST "$NL" "$DX" -d "{\"kind\":\"consult\",\"consultation_id\":\"$C2\"}"):$(code POST "/inpatient/consultations/$C2/cancel" "$D2" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/inpatient/consultations/$C2/cancel" "$DR" -d '{"reason":"ტესტ-E2E: აღარ სჭირდება"}' | jq -r .status)" "403:403:cancelled"

step "7. მიმდინარეობა, შაბლონები, PDF"
CO=$(api GET "$NL/course" "$DR" | jq -r .text)
chk "მიმდინარეობა (ეპიკრიზისთვის): დღიური + შემოვლა + კონსულტაცია" "$(echo "$CO" | grep -c 'ტესტ-E2E'):$(echo "$CO" | grep -c 'კონსულტაცია')" "3:1"
chk "პირადი შაბლონი — OK; განყოფილების (არა ხელმძღვანელი) — 403; ხელმძღვანელი — OK" \
  "$(api POST /inpatient/note-templates "$D2" -d '{"kind":"progress","name":"ტესტ-E2E ჩემი","content":{"s":"ჩივილები არ აქვს"}}' | jq -r '.id!=null'):$(code POST /inpatient/note-templates "$D2" -d "{\"kind\":\"progress\",\"name\":\"ტესტ-E2E x\",\"content\":{},\"department_id\":\"$DA\"}"):$(api POST /inpatient/note-templates "$HD" -d "{\"kind\":\"progress\",\"name\":\"ტესტ-E2E განყოფ.\",\"content\":{\"o\":\"გული — რიტმული\"},\"department_id\":\"$DA\"}" | jq -r '.id!=null')" "true:403:true"
chk "D2 ხედავს: პირადი + განყოფილების; DX — არცერთს" "$(api GET '/inpatient/note-templates?kind=progress' "$D2" | jq -r '[.[]|select(.name|test("ტესტ-E2E"))]|length'):$(api GET '/inpatient/note-templates?kind=progress' "$DX" | jq -r '[.[]|select(.name|test("ტესტ-E2E"))]|length')" "2:0"
chk "PDF (ყველა ხელმოწერილი ჩანაწერი)" "$(curl -s -o "$TMP/n.pdf" -w '%{http_code}:%{content_type}' "$B$NL/pdf" -H "authorization: Bearer $NA"):$(head -c 4 "$TMP/n.pdf")" "200:application/pdf:%PDF"

step "8. ფორმა №IV-100/ა სტაციონარიდან"
DF=$(api GET "/encounters/$E1/form100/draft" "$DR")
chk "მონახაზი: inpatient, თარიღები (მოთავსება / გაწერა — დღეს), მდგომარეობა შემოსვლისას = ობიექტური, ანამნეზი = ჩივილები, კვლევებში კონსულტაცია" \
  "$(echo "$DF" | jq -r '"\(.inpatient):\(.dates.admitted == .dates.discharged):\(.state_on_referral|test("175/105")):\(.anamnesis|test("ჩივილები")):\(.investigations|test("კონსულტაცია"))"')" "true:true:true:true:true"
chk "წყაროები: მიმღები გასინჯვა; დიაგნოზი — შემოსვლისას (I10)" "$(echo "$DF" | jq -r '"\(.sources[0]):\(.diagnosis.primary[0].code)"')" "მიმღები გასინჯვა:I10"
chk "გასცემს: განყოფილების ექიმი (არა მკურნალი / ხელმძღვანელი) — 403" "$(code POST "/encounters/$E1/form100" "$D2" -d '{}')" "403"
R=$(api POST "/encounters/$E1/form100" "$HD" -d '{"course":"chronic","state_on_discharge":"ტესტ-E2E: დამაკმაყოფილებელი","recommendations":"ტესტ-E2E: AD კონტროლი"}'); F1=$(echo "$R" | jq -r '.id // empty')
chk "ხელმძღვანელი გასცემს → № 100/ა-..., ისტორიაში form100_issued" "$(echo "$R" | jq -r '.document_number|test("^100/ა-")'):$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|index("form100_issued")!=null')" "true:true"
P=$(api GET "/encounters/$E1/form100/draft" "$DR" | jq -c .last_issued.payload)
chk "payload: თარიღები, მდგომარეობა გაწერისას, რეკომენდაცია (ექიმის შესწორებით)" "$(echo "$P" | jq -r '"\(.dates.admitted!=null):\(.state_on_discharge|test("დამაკმაყოფილებელი")):\(.recommendations|test("AD კონტროლი"))"')" "true:true:true"
chk "ჩასწორება: გაუქმება (გამცემი, მიზეზით) → revoked; მონახაზში last_issued" \
  "$(api POST "/documents/$F1/revoke" "$HD" -d '{"reason":"ტესტ-E2E: რეკომენდაცია დასაზუსტებელია"}' | jq -r .status):$(api GET "/encounters/$E1/form100/draft" "$DR" | jq -r '.last_issued.payload.recommendations|test("AD კონტროლი")')" "revoked:true"
R=$(api POST "/encounters/$E1/form100" "$DR" -d '{"course":"chronic","state_on_discharge":"ტესტ-E2E: დამაკმაყოფილებელი","recommendations":"ტესტ-E2E: AD კონტროლი დღეში 2-ჯერ, კარდიოლოგი 1 თვეში"}')
chk "ხელახლა (მკურნალი) → ახალი ნომერი, შესწორებული რეკომენდაცია" "$(echo "$R" | jq -r '.document_number|test("^100/ა-")'):$(api GET "/encounters/$E1/form100/draft" "$DR" | jq -r '.last_issued.payload.recommendations|test("1 თვეში")')" "true:true"

step "9. გაწერის გაფრთხილებები"
W1=$(api GET "/inpatient/stays/$E1/discharge/check" "$DR" | jq -r '[.warnings[].code]|join(",")')
W2=$(api GET "/inpatient/stays/$E2/discharge/check" "$DR" | jq -r '[.warnings[]|select(.code=="NOTES_MISSING" or .code=="FORM100_MISSING")|.code]|join(",")')
chk "E1 (ყველაფერი წერია): NOTES_MISSING / FORM100_MISSING — არა; E2: ორივე" "$(echo "$W1" | grep -c 'NOTES_MISSING\|FORM100_MISSING'):$W2" "0:NOTES_MISSING,FORM100_MISSING"
chk "E2: მიმღები გასინჯვის შეტყობინება" "$(api GET "/inpatient/stays/$E2/discharge/check" "$DR" | jq -r '.warnings[]|select(.code=="NOTES_MISSING")|.message|test("მიმღები")')" "true"
for E in "$E1" "$E2"; do api POST "/inpatient/stays/$E/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 22)\",\"$(uid 24)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null; done
chk "გაწერის შემდეგ (დოკუმენტაცია დაუხურავი) — დღიურის ჩაწერა შესაძლებელია; კონსულტაციის მოთხოვნა — 409" \
  "$(api POST "/inpatient/stays/$E2/notes" "$DR" -d '{"kind":"admission","content":{"complaints":"ტესტ","objective":"ტესტ","plan":"ტესტ"},"sign":true}' | jq -r .status):$(code POST "/inpatient/stays/$E2/consultations" "$DR" -d "{\"target_department_id\":\"$DB\",\"urgency\":\"routine\",\"question\":\"ტესტ\"}")" "signed:409"
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PATCH "/tariffs/$TAR" "$ADM" -d '{"is_active":false}' >/dev/null
ok "პარამეტრები აღდგენილია, სატესტო ტარიფი გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
