#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-docs.sh — სტაციონარი, ეტაპი 0041
#   1. დოკუმენტების შაბლონები (admin): სია / ცვლადები → ახალი შაბლონი → draft (უცნობი ცვლადი — გაფრთხილება) → გამოქვეყნება (ბლოკი → OK)
#      → ვერსიები (archived) → სისტემური შაბლონის გათიშვა 400 → preview PDF (ეპიკრიზი / თანხმობა) → არა-admin 403
#   2. თანხმობები ახალ შაბლონებზე: /consent-types (refusal არ ჩანს; all=true — ჩანს) → ძველი PUT (ახალი ვერსია; ღია draft — 409)
#      → ბლანკი ცვლადებით → ელექტრონული თანხმობა (HOSPITALIZATION) → სტაციონარის დაფა: consent = granted
#   3. ეპიკრიზი: ექთანი ვერ ქმნის → ექიმი ქმნის (draft) → უცნობი სექცია 400 → ხელმოწერა არასრულზე (დიაგნოზი, სექციები) 400
#      → სხვა ექიმი ვერ აწერს 403 → ხელმოწერა: № + PDF + QR (ვერიფიკაცია) → რედაქტირება 409 → ხელახლა გახსნა (მიზეზი; წინა დოკ. revoked)
#      → თანახელმოწერის რეჟიმი: ექიმი → awaiting_cosign → ხელმძღვანელი → signed
#   4. გადაყვანა: უფლებები → მოთხოვნა (იგივე განყოფილება 400, მეორე 409) → დაფა (transfer_to / incoming) → უარყოფა / გაუქმება (მიზეზით)
#      → მიღება საწოლით + ახალი მკურნალი ექიმი (ძველი საწოლი — დასალაგებელი, ეპიზოდები, ვიზიტის განყოფილება) → მიღება საწოლის გარეშე (awaiting)
#   5. გაწერა: check → ბლოკი (დიაგნოზი / ეპიკრიზი) → გაფრთხილება (ღია შეკვეთა → მიზეზით) → „ხელმოწერა და გაწერა“ (თარიღი PDF-ში)
#      → გაუქმება (ხელმძღვანელი; ძველი საწოლი) → დროებითი გასვლა (დაფა, ბლოკები, დაბრუნება) → თვითნებური (მოწმეები) → დახურვა
#      → გარდაცვალება (საწოლი დაბლოკილი → გვამის გატანა → დასალაგებელი; პაციენტი გარდაცვლილი) → კლინიკების ცნობარი
# სატესტო შაბლონი რჩება გათიშული (სახელში „ტესტ-E2E“; ვერსიები არ იშლება); HOSPITALIZATION-ის ტექსტი ბოლოს აღდგება ახალ ვერსიად.
# გამოყენება:  bash scripts/e2e-ipd-docs.sh [API_URL]
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
command -v python3 >/dev/null || die "python3 არ არის დაყენებული (ხელმოწერის PNG)"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
pdf()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | head -c 4; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
SIG=$(python3 -c "
import zlib,struct,random,base64
w,h=60,24; raw=b''.join(b'\x00'+bytes(random.randrange(256) for _ in range(w*3)) for _ in range(h))
c=lambda t,d: struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
print('data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b'')).decode())")

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E დოკ. თერაპია $S\",\"code\":\"E2EDA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E დოკ. ქირურგია $S\",\"code\":\"E2EDB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.docs.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"დოკ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.docs.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 61)
NA=$(mkuser '["nurse"]' 62 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 63 ",\"department_id\":\"$DA\""); DRID=$(cat "$TMP/u63" 2>/dev/null)
D2=$(mkuser '["doctor"]' 64 ",\"department_id\":\"$DA\"")
HD=$(mkuser '["doctor"]' 65 ",\"department_id\":\"$DA\",\"is_section_head\":true")
NB=$(mkuser '["nurse"]' 66 ",\"department_id\":\"$DB\"")
DB2=$(mkuser '["doctor"]' 67 ",\"department_id\":\"$DB\""); DB2ID=$(cat "$TMP/u67" 2>/dev/null)
[ -n "$NB" ] && [ -n "$DB2" ] || die "B განყოფილების მომხმარებლები ვერ შეიქმნა"
[ -n "$RC" ] && [ -n "$NA" ] && [ -n "$DR" ] && [ -n "$D2" ] && [ -n "$HD" ] && ok "მომხმარებლები (რეგისტრატორი, ექთანი, 2 ექიმი, ხელმძღვანელი)" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1975-05-05\",\"gender\":\"$3\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 91 "დოკუმენტები" female); P2=$(mkpat 92 "ეპიკრიზი" male); P3=$(mkpat 93 "გადაყვანა" male); P4=$(mkpat 94 "უსაწოლო" female)
P5=$(mkpat 95 "ბინაზე" male); P6=$(mkpat 96 "თვითნებური" male); P7=$(mkpat 97 "გარდაცვალება" female)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && [ -n "$P4" ] && [ -n "$P5" ] && [ -n "$P6" ] && [ -n "$P7" ] && ok "პაციენტები" || die "პაციენტები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"epicrisis_cosign":false,"bed_assign_mode":"two_step","cleaning_required":true,"sex_rule":"warn"}'
WA=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"D1\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
WB=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DB\",\"code\":\"D2\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BA=$(api POST "/inpatient/wards/$WA/beds" "$ADM" -d '{"count":3}'); BA1=$(echo "$BA" | jq -r '.[0].id // empty'); BA2=$(echo "$BA" | jq -r '.[1].id // empty'); BA3=$(echo "$BA" | jq -r '.[2].id // empty')
BB=$(api POST "/inpatient/wards/$WB/beds" "$ADM" -d '{"count":2}'); BB1=$(echo "$BB" | jq -r '.[0].id // empty'); BB2=$(echo "$BB" | jq -r '.[1].id // empty')
[ -n "$BA1" ] && [ -n "$BB1" ] && ok "პალატები და საწოლები (A, B)" || die "საწოლები ვერ შეიქმნა"
bst()  { api GET "/inpatient/structure?all=true" "$ADM" | jq -r --arg id "$1" '[.departments[].wards[].beds[]|select(.id==$id)][0].status'; }
if [ "$(code GET /settings/clinic "$ADM")" != "200" ]; then
  api PUT /settings/clinic "$ADM" -d '{"name":"ტესტ კლინიკა","address":"თბილისი, ტესტის ქ. 1","director_name":"ტესტ დირექტორი","consent_methods":["paper","electronic"]}' >/dev/null
fi
METHODS=$(api GET /settings/clinic "$ADM" | jq -c '.consent_methods')
echo "$METHODS" | jq -e 'index("electronic")' >/dev/null || ELEC_OFF=1

step "1. დოკუმენტების შაბლონები"
L=$(api GET "/document-templates?all=true" "$ADM")
chk "სისტემური შაბლონები: EPICRISIS (epicrisis), SELF_DISCHARGE (refusal), HOSPITALIZATION (სავალდებულო)" \
  "$(echo "$L" | jq -r '[(.[]|select(.code=="EPICRISIS").kind), (.[]|select(.code=="SELF_DISCHARGE").kind), (.[]|select(.code=="HOSPITALIZATION").required_on_admission|tostring)]|join(",")')" "epicrisis,refusal,true"
chk "0010-ის თანხმობები გადმოვიდა (TREATMENT_INFORMED — consent, გამოქვეყნებული)" \
  "$(echo "$L" | jq -r '.[]|select(.code=="TREATMENT_INFORMED")|"\(.kind):\(.published_version>0)"')" "consent:true"
chk "ცვლადების კატალოგი (patient.full_name, stay.bed_days)" "$(api GET /document-templates/variables "$NA" | jq -r '[.[].key]|(index("patient.full_name")!=null) and (index("stay.bed_days")!=null)')" "true"
chk "არა-admin: შაბლონის ნახვა / შექმნა — 403" "$(code GET /document-templates/EPICRISIS "$DR"):$(code POST /document-templates "$DR" -d '{}')" "403:403"
TC="E2E_T$S"
chk "ახალი შაბლონი (refusal) — v1 draft" "$(api POST /document-templates "$ADM" -d "{\"code\":\"$TC\",\"kind\":\"refusal\",\"name\":\"ტესტ-E2E ხელწერილი $S\",\"scope\":\"encounter\"}" | jq -r '.versions[0]|"\(.version):\(.status)"')" "1:draft"
chk "იგივე კოდი — 409; ეპიკრიზის სახეობა — 400" "$(code POST /document-templates "$ADM" -d "{\"code\":\"$TC\",\"kind\":\"refusal\",\"name\":\"xxx\",\"scope\":\"encounter\"}"):$(code POST /document-templates "$ADM" -d "{\"code\":\"E2E_X$S\",\"kind\":\"epicrisis\",\"name\":\"xxx\",\"scope\":\"encounter\"}")" "409:400"
chk "draft: დაუშვებელი ბლოკი (field ხელწერილში) — 400" "$(code PUT "/document-templates/$TC/draft" "$ADM" -d '{"body":{"blocks":[{"type":"field","key":"aa","label":"ველი"}]}}')" "400"
R=$(api PUT "/document-templates/$TC/draft" "$ADM" -d '{"body":{"blocks":[{"type":"heading","text":"ხელწერილი"},{"type":"text","text":"მე, {{patient.full_name}}, {{patient.nonexistent}} ვადასტურებ, რომ ვტოვებ სტაციონარს."}]}}')
chk "draft უცნობი ცვლადით — ინახება, შეცდომა ჩანს" "$(echo "$R" | jq -r '.draft_errors|length>0 and (.[0]|test("nonexistent"))')" "true"
chk "გამოქვეყნება შეცდომით — 400 TEMPLATE_INVALID" "$(api POST "/document-templates/$TC/publish" "$ADM" -d '{}' | jq -r .code)" "TEMPLATE_INVALID"
api PUT "/document-templates/$TC/draft" "$ADM" -d '{"body":{"blocks":[{"type":"heading","text":"ხელწერილი"},{"type":"text","text":"მე, {{patient.full_name}} (პ/ნ {{patient.id_number}}), ვადასტურებ, რომ ვტოვებ სტაციონარს {{doc.date}}."}]},"text_approved":true}' >/dev/null
chk "გამოქვეყნება → v1 published" "$(api POST "/document-templates/$TC/publish" "$ADM" -d '{"change_note":"პირველი"}' | jq -r '.versions[0]|"\(.version):\(.status)"')" "1:published"
chk "ხელახლა გამოქვეყნება draft-ის გარეშე — 404" "$(code POST "/document-templates/$TC/publish" "$ADM" -d '{}')" "404"
api PUT "/document-templates/$TC/draft" "$ADM" -d '{"body":{"blocks":[{"type":"text","text":"ვერსია 2 — {{patient.full_name}} ვადასტურებ სტაციონარის დატოვებას."}]}}' >/dev/null
R=$(api POST "/document-templates/$TC/publish" "$ADM" -d '{}')
chk "v2 გამოქვეყნება → v1 archived, v2 published" "$(echo "$R" | jq -r '[.versions[]|"\(.version):\(.status)"]|join(",")')" "2:published,1:archived"
api PUT "/document-templates/$TC/draft" "$ADM" -d '{"body":{"blocks":[{"type":"text","text":"ვერსია 3 — დროებითი ტექსტი, რომელიც წაიშლება."}]}}' >/dev/null
chk "draft-ის წაშლა → რჩება v2 published" "$(api DELETE "/document-templates/$TC/draft" "$ADM" | jq -r '[.versions[]|.status]|join(",")')" "published,archived"
chk "სისტემური შაბლონის გათიშვა — 400; ჩვეულებრივის — OK" "$(code PATCH /document-templates/EPICRISIS "$ADM" -d '{"is_active":false}'):$(api PATCH "/document-templates/$TC" "$ADM" -d '{"is_active":false}' | jq -r .is_active)" "400:false"
chk "„სავალდებულო მიღებისას“ ხელწერილზე — 400" "$(code PATCH "/document-templates/$TC" "$ADM" -d '{"required_on_admission":true}')" "400"
chk "preview: ეპიკრიზი (ნიმუში) — PDF" "$(pdf POST /document-templates/EPICRISIS/preview "$ADM" -d '{}')" "%PDF"
chk "preview: თანხმობა — PDF; დაუმუშავებელი body — 400" "$(pdf POST /document-templates/HOSPITALIZATION/preview "$ADM" -d '{}'):$(code POST /document-templates/HOSPITALIZATION/preview "$ADM" -d '{"body":{"blocks":[]}}')" "%PDF:400"
chk "ეპიკრიზის draft: საბოლოო დიაგნოზის გარეშე — შეცდომა" \
  "$(api PUT /document-templates/EPICRISIS/draft "$ADM" -d '{"body":{"blocks":[{"type":"field","key":"anamnesis","label":"ანამნეზი"},{"type":"signatures","signers":["attending"]}]}}' | jq -r '.draft_errors|map(select(test("დიაგნოზ")))|length')" "1"
api DELETE /document-templates/EPICRISIS/draft "$ADM" >/dev/null

step "2. თანხმობები ახალ შაბლონებზე"
chk "/consent-types: ხელწერილი არ ჩანს; all=true — ჩანს" \
  "$(api GET /consent-types "$RC" | jq -r 'map(.code)|index("SELF_DISCHARGE")==null'):$(api GET "/consent-types?all=true" "$ADM" | jq -r 'map(.code)|index("SELF_DISCHARGE")!=null')" "true:true"
V0=$(api GET /consent-types "$RC" | jq -r '.[]|select(.code=="HOSPITALIZATION").version')
ORIG_H=$(api GET "/consent-types?all=true" "$ADM" | jq -c '.[]|select(.code=="HOSPITALIZATION")|{body_text, text_approved}')   # ბოლოს აღდგება
R=$(api PUT /consent-types/HOSPITALIZATION "$ADM" -d '{"body_text":"ტესტ-E2E '"$S"': მე, {{patient.full_name}}, ვეთანხმები ჰოსპიტალიზაციას {{clinic.name}}-ში; განყოფილება: {{stay.department}}.","text_approved":true}')
chk "ძველი PUT /consent-types — ახალი ვერსია (v+1), body_text ცვლადებით" "$(echo "$R" | jq -r --argjson v "${V0:-0}" '"\(.version==$v+1):\(.body_text|test("patient.full_name"))"')" "true:true"
chk "ძველი PUT უცნობი ცვლადით — 400" "$(code PUT /consent-types/HOSPITALIZATION "$ADM" -d '{"body_text":"ტესტ-E2E: {{patient.unknown_x}} ვეთანხმები ჰოსპიტალიზაციას."}')" "400"
api PUT /document-templates/HOSPITALIZATION/draft "$ADM" -d '{"body":{"blocks":[{"type":"text","text":"ტესტ-E2E: ღია draft — ძველი PUT უნდა დაიბლოკოს."}]}}' >/dev/null
chk "ღია draft-ისას ძველი PUT — 409" "$(code PUT /consent-types/HOSPITALIZATION "$ADM" -d '{"text_approved":false}')" "409"
api DELETE /document-templates/HOSPITALIZATION/draft "$ADM" >/dev/null

ADMIT=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I10\",\"chief_complaint\":\"ტესტ-E2E\"}")
E1=$(echo "$ADMIT" | jq -r '.encounter_id // .id // empty'); [ -n "$E1" ] && ok "ჰოსპიტალიზაცია" || die "ჰოსპიტალიზაცია ვერ მოხერხდა: $ADMIT"
chk "ბლანკი (HOSPITALIZATION, ცვლადებით) — PDF" "$(pdf GET "/patients/$P1/consents/HOSPITALIZATION/form?encounter_id=$E1" "$NA")" "%PDF"
BOARD() { api GET "/inpatient/board?department_id=$DA" "$NA" | jq -r --arg e "$E1" '[.. | objects | select(.encounter_id? == $e) | .consent | tostring][0] // empty'; }
chk "დაფა: თანხმობა არ არის" "$(BOARD)" "false"
if [ -z "${ELEC_OFF:-}" ]; then
  R=$(api POST "/patients/$P1/consents" "$NA" -d "$(jq -nc --arg e "$E1" --arg s "$SIG" '{type_code:"HOSPITALIZATION",decision:"granted",method:"electronic",signer_type:"patient",encounter_id:$e,signature_png:$s}')")
  chk "ელექტრონული თანხმობა (გამოქვეყნებულ ვერსიაზე)" "$(echo "$R" | jq -r '.decision // .message')" "granted"
  chk "დაფა: თანხმობა გაცემულია" "$(BOARD)" "true"
  chk "პაციენტის თანხმობები: HOSPITALIZATION — granted, outdated=false" "$(api GET "/patients/$P1/consents?encounter_id=$E1" "$NA" | jq -r '.[]|select(.code=="HOSPITALIZATION")|"\(.status):\(.outdated)"')" "granted:false"
  chk "ხელწერილი (SELF_DISCHARGE) ჩაწერადია API-თ — refusal" "$(api POST "/patients/$P1/consents" "$NA" -d "$(jq -nc --arg e "$E1" --arg s "$SIG" '{type_code:"SELF_DISCHARGE",decision:"granted",method:"electronic",signer_type:"patient",encounter_id:$e,signature_png:$s}')" | jq -r '.type_code // .message')" "SELF_DISCHARGE"
else
  ok "ელექტრონული ხელმოწერა კლინიკაში გათიშულია — თანხმობის ჩაწერის ტესტი გამოტოვებულია"
fi
api POST "/inpatient/stays/$E1/cancel" "$RC" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null

step "3. ეპიკრიზი"
E2=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P2\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"I20.0\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
[ -n "$E2" ] && ok "ჰოსპიტალიზაცია (ეპიკრიზისთვის)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
EP="/inpatient/stays/$E2/epicrisis"
chk "ექთანი: ნახვა OK (create=false), შექმნა — 403" "$(api GET "$EP" "$NA" | jq -r '.can.create'):$(code POST "$EP" "$NA")" "false:403"
R=$(api POST "$EP" "$DR")
chk "მკურნალი ექიმი ქმნის → draft, rev 1, შაბლონის სექციები" "$(echo "$R" | jq -r '"\(.epicrisis.status):\(.epicrisis.revision):\([.template.blocks[]|select(.type=="field")]|length>3)"')" "draft:1:true"
chk "მეორედ შექმნა — 409" "$(code POST "$EP" "$DR")" "409"
chk "უცნობი სექცია — 400; არავალიდური ლაბ. შედეგი — 400" "$(code PUT "$EP" "$DR" -d '{"content":{"xx":"y"}}'):$(code PUT "$EP" "$DR" -d "{\"selected_lab_ids\":[\"$(cat /proc/sys/kernel/random/uuid)\"]}")" "400:400"
chk "draft: აკლია (საბოლოო დიაგნოზი + სავალდებულო სექციები)" "$(api PUT "$EP" "$DR" -d '{"content":{"anamnesis":"ტესტ-E2E ანამნეზი"}}' | jq -r '[.missing[]|select(test("დიაგნოზ"))]|length')" "1"
chk "ხელმოწერა არასრულზე — 400 EPICRISIS_INCOMPLETE" "$(api POST "$EP/sign" "$DR" | jq -r .code)" "EPICRISIS_INCOMPLETE"
chk "საბოლოო დიაგნოზი (primary I21.4)" "$(api POST "/encounters/$E2/diagnoses" "$DR" -d '{"icd10_code":"I21.4","diagnosis_type":"primary"}' | jq -r '.diagnosis_type // .message')" "primary"
api PUT "$EP" "$DR" -d '{"content":{"course":"ტესტ-E2E მიმდინარეობა","treatment":"ტესტ-E2E მკურნალობა","state_on_discharge":"დამაკმაყოფილებელი","recommendations":"ტესტ-E2E რეკომენდაციები"}}' >/dev/null
chk "draft: არაფერი აკლია; preview — PDF" "$(api GET "$EP" "$DR" | jq -r '.missing|length'):$(pdf GET "$EP/preview" "$NA")" "0:%PDF"
chk "სხვა ექიმი (არა მკურნალი, არა ხელმძღვანელი) ხელს ვერ აწერს — 403; ხელმოწერილი PDF ჯერ არ არის — 404" "$(code POST "$EP/sign" "$D2"):$(code GET "$EP/pdf" "$DR")" "403:404"
R=$(api POST "$EP/sign" "$DR")
NUM=$(echo "$R" | jq -r '.epicrisis.document_number // empty')
chk "ხელმოწერა → signed + № EPI…" "$(echo "$R" | jq -r '.epicrisis.status'):$(echo "$NUM" | grep -cE '^EPI[0-9]{2}-[0-9]{6}$')" "signed:1"
chk "ხელმოწერილი PDF" "$(pdf GET "$EP/pdf" "$NA")" "%PDF"
DOC=$(api GET "/documents?encounter_id=$E2&type=epicrisis" "$DR" | jq -r '.[0].id // empty')
TOK=$(api GET "/documents/$DOC" "$DR" | jq -r '.verification_token // empty')
chk "QR ვერიფიკაცია: ნამდვილი, ეპიკრიზი" "$(curl -s "$B/public/verify/$TOK" | jq -r '"\(.valid):\(.document_type)"')" "true:ეპიკრიზი (სტაციონარი)"
chk "ხელმოწერილის რედაქტირება — 409; ხელმეორედ ხელმოწერა — 409" "$(code PUT "$EP" "$DR" -d '{"content":{"anamnesis":"x"}}'):$(code POST "$EP/sign" "$DR")" "409:409"
chk "ხელახლა გახსნა მოკლე მიზეზით — 400; ექთანი — 403" "$(code POST "$EP/reopen" "$DR" -d '{"reason":"x"}'):$(code POST "$EP/reopen" "$NA" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "400:403"
R=$(api POST "$EP/reopen" "$DR" -d '{"reason":"ტესტ-E2E: დიაგნოზის დაზუსტება"}')
chk "ხელახლა გახსნა → draft, rev 2, ისტორიაში 1 რედაქცია (№ $NUM)" "$(echo "$R" | jq -r '"\(.epicrisis.status):\(.epicrisis.revision):\(.revisions|length):\(.revisions[0].document_number)"')" "draft:2:1:$NUM"
chk "წინა დოკუმენტი — გაუქმებული (QR: valid=false)" "$(curl -s "$B/public/verify/$TOK" | jq -r '"\(.valid):\(.status)"')" "false:revoked"
mod '{"epicrisis_cosign":true}'
chk "თანახელმოწერის რეჟიმი: ექიმი → awaiting_cosign (№ ჯერ არ არის)" "$(api POST "$EP/sign" "$DR" | jq -r '"\(.epicrisis.status):\(.epicrisis.document_number)"')" "awaiting_cosign:null"
chk "თანახელმოწერა: ექიმი — 403; რედაქტირება — 409" "$(code POST "$EP/cosign" "$D2"):$(code PUT "$EP" "$DR" -d '{"content":{"anamnesis":"x"}}')" "403:409"
R=$(api POST "$EP/cosign" "$HD")
chk "ხელმძღვანელი თანახელს აწერს → signed + ახალი №" "$(echo "$R" | jq -r '"\(.epicrisis.status):\(.epicrisis.cosigned_by_name != null):\(.epicrisis.document_number != "'"$NUM"'")"')" "signed:true:true"
mod '{"epicrisis_cosign":false}'
EVK=$(api GET "/inpatient/stays/$E2" "$DR" | jq -r '[.events[].kind|select(startswith("epicrisis"))]|join(",")')
chk "ისტორია: created, signed, reopened, signed, cosigned" "$EVK" "epicrisis_created,epicrisis_signed,epicrisis_reopened,epicrisis_signed,epicrisis_cosigned"
api POST "/inpatient/stays/$E2/cancel" "$RC" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null

step "4. გადაყვანა განყოფილებებს შორის"
E3=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P3\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"K35.8\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
api POST "/inpatient/stays/$E3/bed" "$NA" -d "{\"bed_id\":\"$BA1\"}" >/dev/null
[ -n "$E3" ] && [ "$(bst "$BA1")" = "occupied" ] && ok "ჰოსპიტალიზაცია A-ში, საწოლი D1-1" || die "ჰოსპიტალიზაცია / საწოლი ვერ მოხერხდა"
TRQ() { api POST "/inpatient/stays/$1/transfer" "$2" -d "{\"to_department_id\":\"$3\",\"reason\":\"ტესტ-E2E: ქირურგიული კონსულტაცია\"}"; }
chk "რეგისტრატორი — 403; B-ს ექთანი (სხვა განყოფილება) — 403" "$(code POST "/inpatient/stays/$E3/transfer" "$RC" -d "{\"to_department_id\":\"$DB\",\"reason\":\"xxx\"}"):$(code POST "/inpatient/stays/$E3/transfer" "$NB" -d "{\"to_department_id\":\"$DB\",\"reason\":\"xxx\"}")" "403:403"
chk "იმავე განყოფილებაში — 400" "$(code POST "/inpatient/stays/$E3/transfer" "$NA" -d "{\"to_department_id\":\"$DA\",\"reason\":\"xxx\"}")" "400"
T1=$(TRQ "$E3" "$NA" "$DB" | jq -r '.id // empty')
chk "მოთხოვნა → requested; მეორე — 409" "$(api GET "/inpatient/transfers?encounter_id=$E3" "$NA" | jq -r '.[0].status'):$(code POST "/inpatient/stays/$E3/transfer" "$DR" -d "{\"to_department_id\":\"$DB\",\"reason\":\"xxx\"}")" "requested:409"
chk "დაფა A: პაციენტი თავის საწოლზე, transfer_to = B" "$(api GET "/inpatient/board?department_id=$DA" "$NA" | jq -r --arg e "$E3" '[.wards[].beds[].occupant|select(.encounter_id? == $e)][0].transfer_to|test("ქირურგია")')" "true"
chk "დაფა B: შემომავალი მოთხოვნა" "$(api GET "/inpatient/board?department_id=$DB" "$NB" | jq -r --arg e "$E3" '[.incoming_transfers[]|select(.encounter_id==$e)]|length')" "1"
chk "B-ს ზარი: გადმოყვანის მოთხოვნა" "$(api GET /notifications "$NB" | jq -r '[.. | objects | select(.kind? == "inpatient_transfer")]|length>0')" "true"
chk "A-ს ექთანი ვერ იღებს — 403; ექიმის გარეშე — 400" "$(code POST "/inpatient/transfers/$T1/accept" "$NA" -d "{\"attending_doctor_id\":\"$DRID\"}"):$(code POST "/inpatient/transfers/$T1/accept" "$NB" -d '{}')" "403:400"
chk "A-ს საწოლით მიღება — 400 (სხვა განყოფილების საწოლი)" "$(code POST "/inpatient/transfers/$T1/accept" "$NB" -d "{\"attending_doctor_id\":\"$DB2ID\",\"bed_id\":\"$BA1\"}")" "400"
chk "უარყოფა მიზეზის გარეშე — 400; A-ს მხრიდან — 403" "$(code POST "/inpatient/transfers/$T1/reject" "$NB" -d '{}'):$(code POST "/inpatient/transfers/$T1/reject" "$NA" -d '{"reason":"ტესტ"}')" "400:403"
chk "B უარყოფს (მიზეზით) → rejected; პაციენტი ისევ D1-1-ზე" "$(api POST "/inpatient/transfers/$T1/reject" "$NB" -d '{"reason":"ტესტ-E2E: თავისუფალი საწოლი არ არის"}' | jq -r .status):$(bst "$BA1")" "rejected:occupied"
chk "A-ს ზარი: უარყოფა" "$(api GET /notifications "$NA" | jq -r '[.. | objects | select(.kind? == "ipd_transfer_reject")]|length>0')" "true"
T2=$(TRQ "$E3" "$DR" "$DB" | jq -r '.id // empty')
chk "ახალი მოთხოვნა → გაუქმება (A-ს ექთანი, მიზეზით)" "$(api POST "/inpatient/transfers/$T2/cancel" "$NA" -d '{"reason":"ტესტ-E2E: მდგომარეობა გაუმჯობესდა"}' | jq -r .status)" "cancelled"
chk "გაუქმებულის მიღება — 409" "$(code POST "/inpatient/transfers/$T2/accept" "$NB" -d "{\"attending_doctor_id\":\"$DB2ID\",\"bed_id\":\"$BB1\"}")" "409"
T3=$(TRQ "$E3" "$NA" "$DB" | jq -r '.id // empty')
R=$(api POST "/inpatient/transfers/$T3/accept" "$NB" -d "{\"attending_doctor_id\":\"$DB2ID\",\"bed_id\":\"$BB1\"}")
chk "B იღებს საწოლით D2-1 → accepted" "$(echo "$R" | jq -r .status)" "accepted"
chk "საწოლები: D1-1 → დასალაგებელი, D2-1 → დაკავებული" "$(bst "$BA1"):$(bst "$BB1")" "cleaning:occupied"
SV=$(api GET "/inpatient/stays/$E3" "$NB")
chk "ჰოსპიტალიზაცია: განყოფილება B, მკურნალი — B-ს ექიმი, ეპიზოდები: transfer → მიმდინარე" \
  "$(echo "$SV" | jq -r --arg d "$DB" --arg doc "$DB2ID" '"\(.department_id==$d):\(.attending_doctor_id==$doc):\([.assignments[].end_kind]|map(.//"open")|join(","))"')" "true:true:transfer,open"
chk "ისტორია: requested, rejected, requested, cancelled, requested, accepted, attending_changed" \
  "$(echo "$SV" | jq -r '[.events[].kind|select(startswith("transfer") or .=="attending_changed")]|join(",")')" "transfer_requested,transfer_rejected,transfer_requested,transfer_cancelled,transfer_requested,transfer_accepted,attending_changed"
chk "A-ს ექთანი ახლა ვეღარ ითხოვს გადაყვანას (პაციენტი B-შია) — 403" "$(code POST "/inpatient/stays/$E3/transfer" "$NA" -d "{\"to_department_id\":\"$DA\",\"reason\":\"xxx\"}")" "403"
E4=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P4\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
T4=$(TRQ "$E4" "$NA" "$DB" | jq -r '.id // empty')
chk "საწოლის გარეშე პაციენტის გადაყვანა, მიღება საწოლის გარეშე → B-ს „ელოდება საწოლს“" \
  "$(api POST "/inpatient/transfers/$T4/accept" "$NB" -d "{\"attending_doctor_id\":\"$DB2ID\"}" | jq -r .status):$(api GET "/inpatient/board?department_id=$DB" "$NB" | jq -r --arg e "$E4" '[.awaiting[]|select(.encounter_id==$e)]|length')" "accepted:1"
chk "B-ს შემომავალი სია (accepted ≥ 2)" "$(api GET "/inpatient/transfers?department_id=$DB&direction=in&status=accepted" "$NB" | jq -r 'length>=2')" "true"
for E in "$E3" "$E4"; do api POST "/inpatient/stays/$E/cancel" "$RC" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done

step "5. გაწერა"
uid() { cat "$TMP/u$1" 2>/dev/null; }
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$3\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
FILL() {  # ეპიკრიზი + საბოლოო დიაგნოზი (ექიმი $2)
  api POST "/inpatient/stays/$1/epicrisis" "$2" >/dev/null
  api PUT "/inpatient/stays/$1/epicrisis" "$2" -d '{"content":{"anamnesis":"ტესტ-E2E","course":"ტესტ-E2E","treatment":"ტესტ-E2E","state_on_discharge":"დამაკმაყოფილებელი","recommendations":"ტესტ-E2E"}}' >/dev/null
  api POST "/encounters/$1/diagnoses" "$2" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' >/dev/null
}
E5=$(ADMIT "$P5" "$DA" "$DRID"); api POST "/inpatient/stays/$E5/bed" "$NA" -d "{\"bed_id\":\"$BA2\"}" >/dev/null
[ -n "$E5" ] && [ "$(bst "$BA2")" = "occupied" ] && ok "ჰოსპიტალიზაცია (ბინაზე გასაწერი), საწოლი D1-2" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
DC="/inpatient/stays/$E5/discharge"
chk "check: ექიმი — can_discharge, აკლია 2 (დიაგნოზი, ეპიკრიზი); ექთანი — can_discharge=false" \
  "$(api GET "$DC/check" "$DR" | jq -r '"\(.can_discharge):\(.closure_missing|length)"'):$(api GET "$DC/check" "$NA" | jq -r .can_discharge)" "true:2:false"
chk "ექთანი ვერ წერს — 403; ბინაზე ბლოკით — 409 DISCHARGE_BLOCKED" "$(code POST "$DC" "$NA" -d '{"type":"home"}'):$(api POST "$DC" "$DR" -d '{"type":"home"}' | jq -r .code)" "403:DISCHARGE_BLOCKED"
chk "სხვა კლინიკაში დაწესებულების გარეშე — 400" "$(code POST "$DC" "$DR" -d '{"type":"other_clinic"}')" "400"
FILL "$E5" "$DR"
chk "check: აკლია მხოლოდ ხელმოწერა → can_sign_with_discharge" "$(api GET "$DC/check" "$DR" | jq -r '"\(.closure_missing|length):\(.can_sign_with_discharge)"')" "1:true"
chk "ბინაზე ხელმოუწერელი ეპიკრიზით (sign_epicrisis გარეშე) — 409" "$(api POST "$DC" "$DR" -d '{"type":"home"}' | jq -r .code)" "DISCHARGE_BLOCKED"
SVC=$(api GET /dx/catalog "$ADM" | jq -r '[.[]|select(.section=="lab" and (.is_active // true))][0].id // empty')
ORD=$(api POST "/encounters/$E5/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$SVC\"}]}")
if echo "$ORD" | jq -e 'type=="array" or .items or .id' >/dev/null 2>&1; then
  chk "ღია ლაბ. შეკვეთა → გაფრთხილება 409 DISCHARGE_WARNINGS (OPEN_ORDERS)" "$(api POST "$DC" "$DR" -d '{"type":"home","sign_epicrisis":true}' | jq -r '"\(.code):\(.warnings[0].code)"')" "DISCHARGE_WARNINGS:OPEN_ORDERS"
  OVR=',"override_reason":"ტესტ-E2E: ანალიზი ამბულატორიულად"'
else ok "ლაბ. შეკვეთა ვერ შეიქმნა ამ გარემოში — გაფრთხილების ტესტი გამოტოვებულია ($(echo "$ORD" | jq -r '.message // empty' | head -c 60))"; OVR=''; fi
R=$(api POST "$DC" "$DR" -d "{\"type\":\"home\",\"sign_epicrisis\":true$OVR}")
chk "„ხელმოწერა და გაწერა“ → discharged, closed" "$(echo "$R" | jq -r '"\(.status):\(.closed)"')" "discharged:true"
SV=$(api GET "/inpatient/stays/$E5" "$DR")
chk "ჰოსპიტალიზაცია: discharged, ტიპი home, closed_at; საწოლი D1-2 → დასალაგებელი" "$(echo "$SV" | jq -r '"\(.status):\(.discharge_type):\(.closed_at!=null)"'):$(bst "$BA2")" "discharged:home:true:cleaning"
EDOC=$(api GET "/documents?encounter_id=$E5&type=epicrisis" "$DR" | jq -r '.[0].id // empty')
chk "ეპიკრიზი ხელმოწერილია გაწერის ტრანზაქციაში — გაწერის თარიღი დოკუმენტშია" "$(api GET "/inpatient/stays/$E5/epicrisis" "$DR" | jq -r '"\(.epicrisis.status):\(.epicrisis.document_has_discharge_date)"'):$([ -n "$EDOC" ] && echo doc)" "signed:true:doc"
chk "ისტორია: epicrisis_signed, discharged, bed_released, closed" "$(echo "$SV" | jq -r '[.events[].kind|select(.=="epicrisis_signed" or .=="discharged" or .=="bed_released" or .=="closed")]|join(",")')" "epicrisis_signed,discharged,bed_released,closed"
chk "მეორედ გაწერა — 409" "$(code POST "$DC" "$DR" -d '{"type":"home"}')" "409"
chk "გაწერის გაუქმება: ექთანი — 403; მიზეზის გარეშე — 400" "$(code POST "$DC/cancel" "$NA" -d '{"reason":"ტესტ-E2E შეცდომა"}'):$(code POST "$DC/cancel" "$HD" -d '{}')" "403:400"
R=$(api POST "$DC/cancel" "$HD" -d '{"reason":"ტესტ-E2E: შეცდომით გაეწერა"}')
chk "ხელმძღვანელი აუქმებს → active, ძველ საწოლზე D1-2 (იყო დასალაგებელი), შენიშვნა ეპიკრიზზე" "$(echo "$R" | jq -r '"\(.status):\(.notice!=null)"'):$(bst "$BA2")" "active:true:occupied"

LV="/inpatient/stays/$E5/leave"
IN2H=$(date -u -d '+2 hours' +%FT%TZ); IN600H=$(date -u -d '+600 hours' +%FT%TZ); AGO=$(date -u -d '-1 hour' +%FT%TZ)
chk "დროებითი გასვლა: წარსული დრო — 400; ლიმიტზე მეტი — 400" "$(code POST "$LV" "$NA" -d "{\"expected_return_at\":\"$AGO\",\"reason\":\"ოჯახური\",\"permitted_by\":\"$DRID\"}"):$(code POST "$LV" "$NA" -d "{\"expected_return_at\":\"$IN600H\",\"reason\":\"ოჯახური\",\"permitted_by\":\"$DRID\"}")" "400:400"
chk "ექთანი ექიმის მითითების გარეშე — 400; მითითებით → OK" "$(code POST "$LV" "$NA" -d "{\"expected_return_at\":\"$IN2H\",\"reason\":\"ოჯახური\"}"):$(api POST "$LV" "$NA" -d "{\"expected_return_at\":\"$IN2H\",\"reason\":\"ტესტ-E2E ოჯახური\",\"permitted_by\":\"$DRID\"}" | jq -r '.id!=null')" "400:true"
chk "დაფა: on_leave_until; საწოლი დაკავებული რჩება" "$(api GET "/inpatient/board?department_id=$DA" "$NA" | jq -r --arg e "$E5" '[.wards[].beds[].occupant|select(.encounter_id? == $e)][0].on_leave_until != null'):$(bst "$BA2")" "true:occupied"
chk "გასულზე: მეორე გასვლა 409, გადაყვანა 409, ბინაზე გაწერა 409" "$(code POST "$LV" "$NA" -d "{\"expected_return_at\":\"$IN2H\",\"reason\":\"xxx\",\"permitted_by\":\"$DRID\"}"):$(code POST "/inpatient/stays/$E5/transfer" "$NA" -d "{\"to_department_id\":\"$DB\",\"reason\":\"xxx\"}"):$(code POST "$DC" "$DR" -d '{"type":"home","override_reason":"ტესტ-E2E ტესტი"}')" "409:409:409"
chk "დაბრუნება → returned; მეორედ — 409" "$(api POST "$LV/return" "$NA" | jq -r .returned):$(code POST "$LV/return" "$NA")" "true:409"
chk "დროებითი გასვლების ისტორია" "$(api GET "/inpatient/stays/$E5/leaves" "$NA" | jq -r 'length')" "1"

E6=$(ADMIT "$P6" "$DA" "$DRID"); D6="/inpatient/stays/$E6/discharge"
chk "თვითნებური ხელწერილის / მოწმეების გარეშე — 400 REFUSAL_REQUIRED; ერთი მოწმე — 400" \
  "$(api POST "$D6" "$DR" -d '{"type":"against_advice"}' | jq -r .code):$(code POST "$D6" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 62)\"]}")" "REFUSAL_REQUIRED:400"
R=$(api POST "$D6" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 62)\",\"$(uid 64)\"],\"note\":\"ტესტ-E2E: უარი ხელმოწერაზე\"}")
chk "თვითნებური (2 მოწმე) → discharged, დოკუმენტაცია მოსალოდნელია (closed=false)" "$(echo "$R" | jq -r '"\(.status):\(.closed)"')" "discharged:false"
chk "ვიზიტი active რჩება (დიაგნოზის დამატება შესაძლებელია); დახურვა — 409 CLOSE_BLOCKED" "$(api POST "/encounters/$E6/diagnoses" "$DR" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' | jq -r .diagnosis_type):$(api POST "/inpatient/stays/$E6/close" "$DR" -d '{}' | jq -r .code)" "primary:CLOSE_BLOCKED"
api POST "/inpatient/stays/$E6/epicrisis" "$DR" >/dev/null
api PUT "/inpatient/stays/$E6/epicrisis" "$DR" -d '{"content":{"anamnesis":"ტესტ-E2E","course":"ტესტ-E2E","treatment":"ტესტ-E2E","state_on_discharge":"დატოვა თვითნებურად","recommendations":"ტესტ-E2E"}}' >/dev/null
chk "დახურვა „ხელმოწერით“ → closed; ვიზიტი discharged" "$(api POST "/inpatient/stays/$E6/close" "$DR" -d '{"sign_epicrisis":true}' | jq -r .closed):$(api GET "/inpatient/stays/$E6" "$DR" | jq -r '.closed_at!=null')" "true:true"

E7=$(ADMIT "$P7" "$DB" "$DB2ID"); api POST "/inpatient/stays/$E7/bed" "$NB" -d "{\"bed_id\":\"$BB2\"}" >/dev/null
D7="/inpatient/stays/$E7/discharge"; sleep 1; NOW=$(date -u +%FT%TZ); FUT=$(date -u -d '+1 hour' +%FT%TZ)
chk "გარდაცვალება: მიზეზის გარეშე — 400; მომავალი დრო — 400" "$(code POST "$D7" "$DB2" -d "{\"type\":\"death\",\"death_at\":\"$NOW\"}"):$(code POST "$D7" "$DB2" -d "{\"type\":\"death\",\"death_at\":\"$FUT\",\"death_icd10_code\":\"I21.9\",\"autopsy_required\":true}")" "400:400"
R=$(api POST "$D7" "$DB2" -d "{\"type\":\"death\",\"death_at\":\"$NOW\",\"death_icd10_code\":\"I21.9\",\"autopsy_required\":true}")
chk "გარდაცვალება → discharged (closed=false); საწოლი დაბლოკილი (გვამის გატანამდე)" "$(echo "$R" | jq -r '"\(.status):\(.closed)"'):$(bst "$BB2")" "discharged:false:blocked"
chk "პაციენტი — გარდაცვლილი" "$(api GET "/patients/$P7" "$ADM" | jq -r .is_deceased)" "true"
chk "გარდაცვალების გაუქმება ხელმძღვანელით (არა admin) — 403" "$(code POST "$D7/cancel" "$HD" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "403"
chk "გვამის გატანა → საწოლი დასალაგებელი; მეორედ — 409" "$(api POST "/inpatient/stays/$E7/body-released" "$NB" -d '{}' | jq -r .bed_released):$(bst "$BB2"):$(code POST "/inpatient/stays/$E7/body-released" "$NB" -d '{}')" "true:cleaning:409"
chk "გატანის შემდეგ გაუქმება (admin) — 409" "$(code POST "$D7/cancel" "$ADM" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "409"
chk "ისტორია: death, body_released" "$(api GET "/inpatient/stays/$E7" "$NB" | jq -r '[.events[].kind|select(.=="death" or .=="body_released")]|join(",")')" "death,body_released"

INS=$(api POST /inpatient/institutions "$ADM" -d "{\"name\":\"ტესტ-E2E საავადმყოფო $S\",\"address\":\"თბილისი\"}" | jq -r '.id // empty')
chk "ცნობარი: admin ამატებს; ექთანი — 403; დუბლიკატი — 409; სიაში ჩანს" "$([ -n "$INS" ] && echo ok):$(code POST /inpatient/institutions "$NA" -d '{"name":"xxx"}'):$(code POST /inpatient/institutions "$ADM" -d "{\"name\":\"ტესტ-E2E საავადმყოფო $S\"}"):$(api GET /inpatient/institutions "$NA" | jq -r --arg i "$INS" 'map(.id)|index($i)!=null')" "ok:403:409:true"
api PATCH "/inpatient/institutions/$INS" "$ADM" -d "{\"name\":\"ტესტ-E2E საავადმყოფო $S\",\"is_active\":false}" >/dev/null
api POST "$DC" "$DR" -d '{"type":"home","sign_epicrisis":true,"override_reason":"ტესტ-E2E დასრულება"}' >/dev/null

[ -n "$ORIG_H" ] && api PUT /consent-types/HOSPITALIZATION "$ADM" -d "$ORIG_H" >/dev/null && ok "HOSPITALIZATION-ის ტექსტი აღდგენილია (ახალი ვერსიით)"
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
