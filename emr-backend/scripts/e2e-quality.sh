#!/usr/bin/env bash
# =====================================================================
# e2e-quality.sh — ხარისხი და ინციდენტები, ეტაპი 1: შეტყობინება (ღია / კონფიდენციალური / ანონიმური), ცნობარები, წყარო,
#   ხედვის წესები (quality / quality_dept / ავტორი), ტრიაჟი (მიღება / უარყოფა / დუბლიკატი / ხელახლა გახსნა), რისკის მატრიცა,
#   კლასიფიკაციის შესწორება, კომენტარი / ფაილი, შეტყობინებები, შეთავაზებები (MAR), აუდიტი (0064)
#   bash scripts/e2e-quality.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-quality.sh
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
# multipart: data (JSON) + ფაილები
rep()  { local t=$1 d=$2; shift 2; curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $t" -F "data=$d" "$@"; }
repc() { local t=$1 d=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X POST "$B/quality/incidents" -H "authorization: Bearer $t" -F "data=$d" "$@"; }
repe() { local t=$1 d=$2; shift 2; curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $t" -F "data=$d" "$@" | jq -r '.code // empty'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '\x89PNG\r\n\x1a\nE2E-test-image' > "$TMP/photo.png"
printf 'not an image' > "$TMP/bad.txt"
NOW=$(date -u +%FT%TZ); H1=$(date -u -d '-1 hour' +%FT%TZ); FUT=$(date -u -d '+2 hours' +%FT%TZ)
uid()  { cat "$TMP/u$1"; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.qm.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QM-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.qm.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_qm_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_qm_$1_$S"; }
notes() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" --arg e "${3:-}" '[.[]|select(.kind==$k and ($e=="" or (.link // "" | contains($e))))]|length'; }

step "0. მოდული, პარამეტრები, უფლებები"
O_QM=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="quality")|{enabled, settings}')
[ -n "$O_QM" ] || die "მოდული quality ვერ მოიძებნა (0064 დაყენებულია?)"
O_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
chk "ნაგულისხმევი: 3 რეჟიმი, confidential, ტრიაჟი 72 / 24 სთ, რისკი 3 / 6 / 12, alert severe" \
  "$(echo "$O_QM" | jq -r '.settings|"\(.identity_modes|length):\(.identity_default):\(.triage_hours)/\(.sentinel_triage_hours):\(.risk_low_max)/\(.risk_medium_max)/\(.risk_high_max):\(.alert_harm)"')" "3:confidential:72/24:3/6/12:severe"
qmset() { api PUT /modules/quality "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
chk "ვალიდაცია: ნაგულისხმევი დაშვებულთა გარეთ / რისკის ზღვრების რიგი / სენტინელური > ჩვეულებრივი / უცნობი გასაღები / უცნობი მიმღები → 400" \
  "$(code PUT /modules/quality "$ADM" -d '{"settings":{"identity_modes":["open"],"identity_default":"anonymous"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"risk_low_max":8,"risk_medium_max":6},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"sentinel_triage_hours":100,"triage_hours":48},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"x":1},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"alert_user_ids":["00000000-0000-0000-0000-000000000000"]},"reason":"ტესტ-E2E"}')" "400:400:400:400:400"
qmset '{"identity_modes":["open","confidential","anonymous"],"identity_default":"confidential","alert_harm":"severe","alert_user_ids":[],"alert_sms":false,"alert_email":false,"event_prompts":true,"author_feedback":true,"anonymous_tracking":true,"ncc_merp":true,"risk_low_max":3,"risk_medium_max":6,"risk_high_max":12,"triage_hours":72,"sentinel_triage_hours":24}' >/dev/null
chk "39 უფლება (0064: + quality, quality_dept, quality_view; 0067: + infection, infection_dept, infection_view)" "$(api GET /roles/capabilities "$ADM" | jq length)" "39"
chk "როლი „ხარისხის მენეჯერი“ (quality + reports_all), რედაქტირებადი" "$(api GET /roles "$ADM" | jq -r '.[]|select(.code=="quality_manager")|"\(.capabilities|sort|join(",")):\(.is_system)"')" "quality,reports_all:false"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E QM თერაპია $S\",\"code\":\"E2EQA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E QM ქირურგია $S\",\"code\":\"E2EQB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
R_QM=$(mkrole qm "ხარისხის მენეჯერი" '["quality"]'); R_QD=$(mkrole qd "ინციდენტები განყოფილება" '["quality_dept"]'); R_HR=$(mkrole hr "HR" '["hr"]')
[ -n "$R_QM" ] && [ -n "$R_QD" ] && [ -n "$R_HR" ] || die "როლები ვერ შეიქმნა"
QM=$(mkuser "[\"$R_QM\"]" 71)
QD=$(mkuser "[\"$R_QD\"]" 72 ",\"department_id\":\"$DA\"")
NA=$(mkuser '["nurse"]' 73 ",\"department_id\":\"$DA\"")
NB=$(mkuser '["nurse"]' 74 ",\"department_id\":\"$DB\"")
DR=$(mkuser '["doctor"]' 75 ",\"department_id\":\"$DA\"")
XX=$(mkuser "[\"$R_HR\"]" 76)                                                    # პაციენტის ძებნის უფლების გარეშე
RC=$(mkuser '["receptionist"]' 77)
QB=$(mkuser "[\"$R_QD\"]" 78 ",\"department_id\":\"$DB\"")                  # სხვა განყოფილების განმხილველი
for t in QM QD NA NB DR XX RC QB; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: ხარისხის მენეჯერი, განმხილველი A / B, ექთანი A / B, ექიმი A, HR, რეგისტრატორი"
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"92$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QM-პაციენტი\",\"birth_date\":\"1960-02-02\",\"gender\":\"female\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
P2=$(api POST /patients "$ADM" -d "{\"personal_number\":\"93$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QM-სხვა\",\"birth_date\":\"1970-03-03\",\"gender\":\"male\",\"phone_number\":\"596$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
E1=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 75)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
[ -n "$E1" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
ok "2 პაციენტი, ჰოსპიტალიზაცია (განყოფილება A)"

step "1. მეტა, ცნობარები"
chk "მეტა: ექთანი — წვდომა null, ძებნა ✓, განყოფილება A; HR — ძებნა ✗; ხარისხის მენეჯერი — full; განმხილველი — dept" \
  "$(api GET /quality/meta "$NA" | jq -r --arg d "$DA" '"\(.access):\(.can_lookup):\(.my_department_id==$d)"'):$(api GET /quality/meta "$XX" | jq -r .can_lookup):$(api GET /quality/meta "$QM" | jq -r .access):$(api GET /quality/meta "$QD" | jq -r .access)" "null:true:true:false:full:dept"
CATS=$(api GET "/quality/classifiers?kind=category" "$NA")
cat_id() { echo "$CATS" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id'; }
C_MED=$(cat_id medication); C_OMIT=$(cat_id med_omission); C_FALL=$(cat_id fall); C_OTH=$(cat_id other); C_FALLD=$(cat_id fall_death); C_DOC=$(cat_id documentation); C_INF=$(cat_id inf_it)
chk "seed: 13 კატეგორია, ≥ 35 ქვეკატეგორია, სენტინელური ≥ 5; ფაქტორები 6 ჯგუფი" \
  "$(echo "$CATS" | jq -r '"\([.[]|select(.parent_id==null)]|length):\([.[]|select(.parent_id!=null)]|length>=35):\([.[]|select(.is_sentinel)]|length>=5)"'):$(api GET "/quality/classifiers?kind=factor" "$NA" | jq -r '[.[]|select(.parent_id==null)]|length')" "13:true:true:6"
chk "ცნობარის ცვლილება: ექთანი — 403; მშობელი სხვა სახის — 400; სენტინელური ძირეულზე — 400; დუბლიკატი კოდი — 409" \
  "$(code POST /quality/classifiers "$NA" -d "{\"kind\":\"category\",\"parent_id\":\"$C_FALL\",\"code\":\"e2e_x_$S\",\"name\":\"ტესტ\"}"):$(code POST /quality/classifiers "$QM" -d "{\"kind\":\"factor\",\"parent_id\":\"$C_FALL\",\"code\":\"e2e_x_$S\",\"name\":\"ტესტ\"}"):$(code POST /quality/classifiers "$QM" -d "{\"kind\":\"category\",\"code\":\"e2e_x_$S\",\"name\":\"ტესტ\",\"is_sentinel\":true}"):$(code POST /quality/classifiers "$QM" -d '{"kind":"category","parent_id":null,"code":"fall","name":"ტესტ"}')" "403:400:400:409"
C_NEW=$(api POST /quality/classifiers "$QM" -d "{\"kind\":\"category\",\"parent_id\":\"$C_OTH\",\"code\":\"e2e_qm_$S\",\"name\":\"ტესტ-E2E ქვეკატეგორია\"}" | jq -r '.id // empty')
chk "ქვეკატეგორია დაემატა; გათიშვა → ფორმის სიაში აღარ ჩანს, all=true — ჩანს" \
  "$([ -n "$C_NEW" ] && echo y):$(api PATCH "/quality/classifiers/$C_NEW" "$QM" -d '{"is_active":false}' | jq -r .is_active):$(api GET "/quality/classifiers?kind=category" "$NA" | jq -r --arg i "$C_NEW" '[.[]|select(.id==$i)]|length'):$(api GET "/quality/classifiers?kind=category&all=true" "$QM" | jq -r --arg i "$C_NEW" '[.[]|select(.id==$i)]|length')" "y:false:0:1"

step "2. შეტყობინება — ვალიდაცია"
base() { jq -nc --arg d "$DA" --arg c "${1:-$C_DOC}" --arg at "$H1" --arg p "${2:-}" --arg m "${3:-confidential}" \
  '{event_type:"no_harm",affected:"patient",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"none",description:"ტესტ-E2E: ჩანაწერში არასწორი დოზა იყო მითითებული",identity_mode:$m} + (if $p=="" then {patient_text:"პალატა 12, ტესტ"} else {patient_id:$p} end)'; }
chk "ზიანით + „არ არის“ / ზიანის გარეშე + ზიანი / მომავალი დრო / არავის (არა near-miss) / პაციენტი არ არის → 400" \
  "$(repe "$NA" "$(base | jq -c '.event_type="harm"')"):$(repe "$NA" "$(base | jq -c '.harm_reported="mild"')"):$(repe "$NA" "$(base | jq -c --arg f "$FUT" '.occurred_at=$f')"):$(repe "$NA" "$(base | jq -c '.affected="none"')"):$(repe "$NA" "$(base | jq -c 'del(.patient_text)')")" "HARM:HARM:OCCURRED_AT:AFFECTED:PATIENT_REQUIRED"
chk "MERP არამედიკამენტურზე / გათიშული კატეგორია / აღწერა < 10 / უცნობი ველი → 400" \
  "$(repe "$NA" "$(base | jq -c '.merp_category="C"')"):$(repe "$NA" "$(base "$C_NEW")"):$(repc "$NA" "$(base | jq -c '.description="მოკლე"')"):$(repc "$NA" "$(base | jq -c '.x=1')")" "MERP:CATEGORY:400:400"
chk "HR: პაციენტის არჩევა — 403 PATIENT_LOOKUP; ძებნა / წყაროები — 403" \
  "$(repe "$XX" "$(base "$C_DOC" "$P1")"):$(code GET "/quality/patients?q=te" "$XX"):$(code GET "/quality/sources?patient_id=$P1" "$XX")" "PATIENT_LOOKUP:403:403"
chk "წყარო სხვა პაციენტისაა → 400 SOURCE_PATIENT; არარსებული წყარო → 400" \
  "$(repe "$NA" "$(base "$C_DOC" "$P2" | jq -c --arg e "$E1" '.source_type="stay" | .source_id=$e')"):$(repe "$NA" "$(base | jq -c '.source_type="or_case" | .source_id="00000000-0000-0000-0000-000000000000"')")" "SOURCE_PATIENT:SOURCE_NOT_FOUND"
chk "ფაილი: არა JPG / PNG / PDF → 400 FILE_TYPE" "$(repe "$NA" "$(base)" -F "files=@$TMP/bad.txt")" "FILE_TYPE"
qmset '{"identity_modes":["open","confidential"],"identity_default":"confidential"}' >/dev/null
chk "ანონიმური გამორთულია → 400 IDENTITY_MODE" "$(repe "$XX" "$(base | jq -c '.identity_mode="anonymous"')")" "IDENTITY_MODE"
qmset '{"identity_modes":["open","confidential","anonymous"],"identity_default":"confidential"}' >/dev/null

step "3. შეტყობინება — სამი რეჟიმი"
chk "ძებნა / წყაროები (ექთანი): პაციენტი ნომრით; ჰოსპიტალიზაცია და ვიზიტი წყაროებში" \
  "$(api GET "/quality/patients?q=92$(printf '%09d' "$((10#$S))")" "$NA" | jq -r --arg p "$P1" '[.[]|select(.id==$p)]|length'):$(api GET "/quality/sources?patient_id=$P1" "$NA" | jq -r '[.[].type]|(index("stay")!=null) and (index("encounter")!=null)')" "1:true"
D1=$(base "$C_DOC" "$P1" | jq -c --arg e "$E1" --arg u "$(uid 75)" '.source_type="stay" | .source_id=$e | .location_text="პალატა 12" | .immediate_actions="ექიმს ეცნობა" | .people=[{role:"involved",user_id:$u},{role:"witness",name_text:"ტესტ-E2E სანიტარი"}]')
R=$(rep "$NA" "$D1" -F "files=@$TMP/photo.png;type=image/png")
I1=$(echo "$R" | jq -r '.id // empty'); N1=$(echo "$R" | jq -r '.inc_no // empty')
chk "კონფიდენციალური (ექთანი A): INCyy-NNNNNN, submitted, არა სასწრაფო, კოდის გარეშე" "$(echo "$R" | jq -r '"\(.inc_no|test("^INC[0-9]{2}-[0-9]{6}$")):\(.status):\(.urgent):\(.track_code)"')" "true:submitted:false:null"
[ -n "$I1" ] || die "შეტყობინება ვერ შეიქმნა: $R"
R=$(api GET "/quality/incidents/$I1" "$QM")
chk "ბარათი (QM): წყარო = ჰოსპიტალიზაცია, ვიზიტი შევსებულია, ავტორი ჩანს, 2 მონაწილე, 1 ფაილი, ქრონოლოგია, ტრიაჟის ვადა ~72 სთ" \
  "$(echo "$R" | jq -r --arg e "$E1" '"\(.source_label|test("^ჰოსპიტალიზაცია")):\(.encounter_id==$e):\(.reporter_name|test("QM-73")):\(.people|length):\(.files|length):\(.events[0].kind):\(((.triage_due_at|sub("\\.[0-9]+";"")|sub("\\+00:00$";"Z")|fromdateiso8601) - now)/3600|floor|. >= 70 and . <= 72)"')" "true:true:true:2:1:submitted:true"
D2=$(jq -nc --arg d "$DA" --arg c "$C_FALLD" --arg at "$H1" --arg p "$P1" '{event_type:"harm",affected:"patient",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"severe",description:"ტესტ-E2E: პაციენტი დაეცა საწოლიდან, თეძოს მოტეხილობა",patient_id:$p,identity_mode:"open"}')
R=$(rep "$DR" "$D2"); I2=$(echo "$R" | jq -r '.id // empty'); N2=$(echo "$R" | jq -r .inc_no)
chk "ღია, სენტინელური (ექიმი): სასწრაფო; ტრიაჟის ვადა ~24 სთ" \
  "$(echo "$R" | jq -r .urgent):$(api GET "/quality/incidents/$I2" "$QM" | jq -r '"\(.is_sentinel):\(((.triage_due_at|sub("\\.[0-9]+";"")|sub("\\+00:00$";"Z")|fromdateiso8601) - now)/3600|floor|. >= 22 and . <= 24)"')" "true:true:true"
D3=$(base "$C_INF" | jq -c '.event_type="hazard" | .affected="none" | .identity_mode="anonymous" | del(.patient_text) | .description="ტესტ-E2E: ღამით სისტემა 40 წუთი მიუწვდომელი იყო"')
R=$(rep "$XX" "$D3"); N3=$(echo "$R" | jq -r .inc_no); CODE=$(echo "$R" | jq -r '.track_code // empty')
chk "ანონიმური (HR): id = null, კოდი XXXX-XXXX-XXXX-XXXX" "$(echo "$R" | jq -r '.id'):$(echo "$CODE" | grep -cE '^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$')" "null:1"
I3=$(api GET "/quality/incidents?search=$N3" "$QM" | jq -r '.[0].id // empty')
R=$(api GET "/quality/incidents/$I3" "$QM")
chk "ანონიმური: ავტორი / ქრონოლოგიის ავტორი = null; აუდიტში (QM_REPORT) — მომხმარებელი და IP არ არის" \
  "$(echo "$R" | jq -r '"\(.reporter_id):\(.reporter_name):\(.events[0].user_id)"'):$(api GET "/audit-logs?entity_name=qm_incidents&entity_id=$I3&action=QM_REPORT" "$ADM" | jq -r '(if type=="array" then . else .items end)[0]|"\(.user_id):\(.ip_address)"')" "null:null:null:null:null"
chk "კოდით სტატუსი: ტრიაჟს ელოდება; სხვა კოდი — 404; ფორმატი — 400" \
  "$(api GET "/quality/track?code=$CODE" "$NA" | jq -r '"\(.inc_no==$n):\(.status)"' --arg n "$N3"):$(code GET "/quality/track?code=AAAA-BBBB-CCCC-DDDD" "$NA"):$(code GET "/quality/track?code=ABC" "$NA")" "true:submitted:404:400"
chk "„ჩემი“: ექთანი — 1 (I1); HR — 0 (ანონიმური არ ჩანს); ექიმი — 1" \
  "$(api GET /quality/incidents/mine "$NA" | jq -r --arg i "$I1" '"\(length):\(.[0].id==$i)"'):$(api GET /quality/incidents/mine "$XX" | jq length):$(api GET /quality/incidents/mine "$DR" | jq length)" "1:true:0:1"
chk "შეტყობინება QM-ს: 3 ახალი (qm_new), სენტინელური — სასწრაფო" \
  "$(api GET '/notifications?unread=true' "$QM" | jq -r '[.[]|select(.kind=="qm_new")]|"\(length):\([.[]|select(.urgent)]|length)"')" "3:1"

step "4. ხედვის წესები"
chk "ექთანი A (ავტორი): own; საბოლოო ზიანი / რისკი / სენტინელური — დამალულია; ექთანი B / განმხილველი A (ტრიაჟამდე) — 404" \
  "$(api GET "/quality/incidents/$I1" "$NA" | jq -r '"\(.access):\(.harm):\(.risk_level):\(.is_sentinel)"'):$(code GET "/quality/incidents/$I1" "$NB"):$(code GET "/quality/incidents/$I1" "$QD")" "own:null:null:false:404:404"
chk "რეესტრი: ექთანი — 403; QM — 3; განმხილველი A — 0 (ტრიაჟამდე არ ჩანს); შეჯამება QM: 3 ტრიაჟს ელოდება, 1 სასწრაფო" \
  "$(code GET /quality/incidents "$NA"):$(api GET "/quality/incidents?department_id=$DA" "$QM" | jq length):$(api GET /quality/incidents "$QD" | jq length):$(api GET /quality/incidents/summary "$QM" | jq -r '"\(.submitted >= 3):\(.urgent_open >= 1)"')" "403:3:0:true:true"
chk "ფილტრები: სენტინელური — I2; კატეგორია „დაცემა“ (ძირეული) — I2; ძებნა ნომრით — 1" \
  "$(api GET "/quality/incidents?sentinel=1&department_id=$DA" "$QM" | jq -r '.[0].id==$i' --arg i "$I2"):$(api GET "/quality/incidents?category_id=$C_FALL&department_id=$DA" "$QM" | jq -r '[.[].id]==[$i]' --arg i "$I2"):$(api GET "/quality/incidents?search=$N1" "$QM" | jq length)" "true:true:1"
chk "ნახვა აუდიტშია (QM_VIEW)" "$(api GET "/audit-logs?entity_name=qm_incidents&entity_id=$I1&action=QM_VIEW" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]]|length>=1')" "true"

step "5. ავტორის რედაქტირება"
R=$(api PATCH "/quality/incidents/$I1" "$NA" -d "$(echo "$D1" | jq -c 'del(.identity_mode) | .description="ტესტ-E2E: ჩანაწერში არასწორი დოზა — შესწორებული აღწერა"')")
chk "ავტორი ცვლის ტრიაჟამდე → edited (description); სხვა — 404; identity_mode ველი — 400" \
  "$(echo "$R" | jq -r '"\(.description|test("შესწორებული")):\([.events[].kind]|index("edited")!=null)"'):$(code PATCH "/quality/incidents/$I1" "$DR" -d "$(echo "$D1" | jq -c 'del(.identity_mode)')"):$(code PATCH "/quality/incidents/$I1" "$NA" -d "$D1")" "true:true:404:400"

step "6. ტრიაჟი"
chk "ექთანი / განმხილველი — 403; რისკის გარეშე — 400 RISK_REQUIRED; ზიანის გარეშე ტიპზე ზიანი — 400 HARM" \
  "$(code POST "/quality/incidents/$I1/triage" "$NA" -d '{"decision":"accept"}'):$(code POST "/quality/incidents/$I1/triage" "$QD" -d '{"decision":"accept"}'):$(ecode POST "/quality/incidents/$I1/triage" "$QM" -d '{"decision":"accept","harm":"none"}'):$(ecode POST "/quality/incidents/$I1/triage" "$QM" -d '{"decision":"accept","harm":"mild","likelihood":3,"consequence":2}')" "403:403:RISK_REQUIRED:HARM"
R=$(api POST "/quality/incidents/$I1/triage" "$QM" -d "{\"decision\":\"accept\",\"harm\":\"none\",\"likelihood\":3,\"consequence\":2,\"category_id\":\"$C_MED\",\"merp_category\":\"C\",\"note\":\"ტესტ-E2E: მედიკამენტური\"}")
chk "მიღება: investigation, რისკი 3×2 = 6 → საშუალო, კატეგორია → მედიკამენტი, MERP C" "$(echo "$R" | jq -r '"\(.status):\(.risk_score):\(.risk_level):\(.category_name):\(.merp_category)"')" "investigation:6:medium:მედიკამენტი:C"
chk "ხელახლა ტრიაჟი — 409; ავტორი ვეღარ ცვლის — 409 NOT_EDITABLE" \
  "$(code POST "/quality/incidents/$I1/triage" "$QM" -d '{"decision":"accept","harm":"none","likelihood":1,"consequence":1}'):$(ecode PATCH "/quality/incidents/$I1" "$NA" -d "$(echo "$D1" | jq -c 'del(.identity_mode)')")" "409:NOT_EDITABLE"
chk "შეტყობინება: ავტორს (qm_status), განმხილველ A-ს (qm_dept), განმხილველ B-ს — არა" "$(notes "$NA" qm_status):$(notes "$QD" qm_dept "$I1"):$(notes "$QB" qm_dept "$I1")" "1:1:0"
R=$(api GET "/quality/incidents/$I1" "$QD")
chk "განმხილველი A: dept; ავტორი (კონფიდენციალური) და მონაწილეები — დამალული; ავტორის სახელი ქრონოლოგიაში — „ავტორი“; B — 404" \
  "$(echo "$R" | jq -r '"\(.access):\(.reporter_name):\(.reporter_id):\(.people)"'):$(echo "$R" | jq -r '[.events[]|select(.kind=="submitted")][0].user_name'):$(code GET "/quality/incidents/$I1" "$QB")" "dept:null:null:null:ავტორი:404"
chk "განმხილველი A — რეესტრში 1, შეჯამება dept; კომენტარი ✓, შიდა — 403" \
  "$(api GET /quality/incidents "$QD" | jq length):$(api GET /quality/incidents/summary "$QD" | jq -r .scope):$(code POST "/quality/incidents/$I1/comments" "$QD" -d '{"text":"ტესტ-E2E: განყოფილებაში განვიხილეთ"}'):$(code POST "/quality/incidents/$I1/comments" "$QD" -d '{"text":"ტესტ-E2E","internal":true}')" "1:dept:201:403"
api POST "/quality/incidents/$I1/comments" "$QM" -d '{"text":"ტესტ-E2E: შიდა შენიშვნა","internal":true}' >/dev/null
chk "შიდა შენიშვნა: QM ხედავს, განმხილველი — არა; ავტორი ხედავს მხოლოდ ტრიაჟის შედეგს (ტექსტის გარეშე)" \
  "$(api GET "/quality/incidents/$I1" "$QM" | jq -r '[.events[]|select(.internal)]|length'):$(api GET "/quality/incidents/$I1" "$QD" | jq -r '[.events[]|select(.internal)]|length'):$(api GET "/quality/incidents/$I1" "$NA" | jq -r '"\([.events[].kind]|index("comment")):\([.events[]|select(.kind=="accepted")][0].text)"')" "1:0:null:null"
R=$(api POST "/quality/incidents/$I2/triage" "$QM" -d '{"decision":"accept","harm":"severe","likelihood":5,"consequence":5}')
chk "სენტინელური I2: 5×5 = 25 → ექსტრემალური, სასწრაფო რჩება" "$(echo "$R" | jq -r '"\(.risk_score):\(.risk_level):\(.urgent):\(.is_sentinel)"')" "25:extreme:true:true"
chk "ღია რეჟიმი (I2): განმხილველი ხედავს ავტორს" "$(api GET "/quality/incidents/$I2" "$QD" | jq -r '.reporter_name|test("QM-75")')" "true"

step "7. კლასიფიკაციის შესწორება"
chk "ცვლილების გარეშე — 400 NO_CHANGE; მიზეზის გარეშე — 400; ტრიაჟამდე (I3) — 409" \
  "$(ecode PATCH "/quality/incidents/$I1/classification" "$QM" -d '{"reason":"ტესტ-E2E"}'):$(code PATCH "/quality/incidents/$I1/classification" "$QM" -d '{"consequence":4}'):$(code PATCH "/quality/incidents/$I3/classification" "$QM" -d '{"consequence":4,"reason":"ტესტ-E2E"}')" "NO_CHANGE:400:409"
R=$(api PATCH "/quality/incidents/$I1/classification" "$QM" -d '{"consequence":4,"reason":"ტესტ-E2E: შედეგი გადაფასდა"}')
chk "შედეგი 2 → 4: რისკი 12 → მაღალი; ჩანაწერი reclassified (შიდა); აუდიტი QM_RECLASSIFY" \
  "$(echo "$R" | jq -r '"\(.risk_score):\(.risk_level):\([.events[]|select(.kind=="reclassified" and .internal)]|length)"'):$(api GET "/audit-logs?entity_name=qm_incidents&entity_id=$I1&action=QM_RECLASSIFY" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]]|length')" "12:high:1:1"
qmset '{"risk_high_max":11}' >/dev/null
chk "ზღვარი (კლინიკის პარამეტრი) იცვლება → ახალ შეფასებაზე: 12 → ექსტრემალური" \
  "$(api PATCH "/quality/incidents/$I1/classification" "$QM" -d '{"likelihood":4,"consequence":3,"reason":"ტესტ-E2E"}' | jq -r '"\(.risk_score):\(.risk_level)"')" "12:extreme"
qmset '{"risk_high_max":12}' >/dev/null

step "8. უარყოფა, დუბლიკატი, ხელახლა გახსნა"
chk "უარყოფა: მიზეზის გარეშე — 400; „არ არის ინციდენტი“ განმარტების გარეშე — 400; დუბლიკატი საკუთარ თავზე — 400" \
  "$(ecode POST "/quality/incidents/$I3/triage" "$QM" -d '{"decision":"reject"}'):$(ecode POST "/quality/incidents/$I3/triage" "$QM" -d '{"decision":"reject","reject_reason":"not_incident"}'):$(ecode POST "/quality/incidents/$I3/triage" "$QM" -d "{\"decision\":\"reject\",\"reject_reason\":\"duplicate\",\"duplicate_of\":\"$I3\"}")" "REJECT_REASON:NOTE_REQUIRED:DUPLICATE_OF"
R=$(api POST "/quality/incidents/$I3/triage" "$QM" -d "{\"decision\":\"reject\",\"reject_reason\":\"duplicate\",\"duplicate_of\":\"$I1\"}")
chk "დუბლიკატი → rejected, ორიგინალის ნომერი; კოდით — „უარყოფილი · დუბლიკატი“" \
  "$(echo "$R" | jq -r --arg n "$N1" '"\(.status):\(.duplicate_inc_no==$n)"'):$(api GET "/quality/track?code=$CODE" "$XX" | jq -r '"\(.status):\(.reject_label)"')" "rejected:true:rejected:დუბლიკატი"
R=$(api POST "/quality/incidents/$I3/reopen" "$QM" -d '{"reason":"ტესტ-E2E: არ არის დუბლიკატი"}')
chk "ხელახლა გახსნა → submitted, მიზეზი / დუბლიკატი გასუფთავდა; განმეორებით — 409" \
  "$(echo "$R" | jq -r '"\(.status):\(.reject_reason):\(.duplicate_of)"'):$(code POST "/quality/incidents/$I3/reopen" "$QM" -d '{"reason":"ტესტ-E2E"}')" "submitted:null:null:409"
api POST "/quality/incidents/$I3/triage" "$QM" -d '{"decision":"reject","reject_reason":"not_incident","note":"ტესტ-E2E: დაგეგმილი სამუშაო"}' >/dev/null
chk "უარყოფილი არ ჩანს განმხილველთან; კოდით — „არ არის ინციდენტი“" "$(api GET "/quality/incidents?status=rejected" "$QD" | jq length):$(api GET "/quality/track?code=$CODE" "$XX" | jq -r .reject_label)" "0:არ არის ინციდენტი"

step "9. კომენტარი, ფაილი"
chk "ავტორი (ექთანი A) — დამატებითი ინფორმაცია (author_note) → QM-ს შეტყობინება" \
  "$(api POST "/quality/incidents/$I1/comments" "$NA" -d '{"text":"ტესტ-E2E: დამატებითი დეტალები"}' | jq -r .kind):$(notes "$QM" qm_comment "$I1")" "author_note:1"
R=$(curl -s -X POST "$B/quality/incidents/$I1/files" -H "authorization: Bearer $QD" -F "files=@$TMP/photo.png;type=image/png")
FID=$(api GET "/quality/incidents/$I1" "$QM" | jq -r '.files[0].id')
chk "განმხილველი ტვირთავს ფაილს (სულ 2); ავტორი ხსნის — 200 image/png; ექთანი B — 404; ფაილი არ არის — 400" \
  "$(echo "$R" | jq -r '.files|length'):$(api GET "/quality/incidents/$I1" "$QM" | jq -r '.files|length'):$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B/quality/incidents/$I1/files/$FID" -H "authorization: Bearer $NA"):$(code GET "/quality/incidents/$I1/files/$FID" "$NB"):$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/quality/incidents/$I1/files" -H "authorization: Bearer $QM")" "1:2:200:image/png:404:400"
chk "ფაილის ნახვა აუდიტშია (QM_FILE_VIEW)" "$(api GET "/audit-logs?entity_name=qm_incident_files&entity_id=$FID&action=QM_FILE_VIEW" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]]|length>=1')" "true"

step "10. შეთავაზებები (MAR: გაფრთხილების გადალახვა)"
# ვერიფიკაცია „ყველა“ → ვერიფიკაციამდე მიცემა მოითხოვს override-ს (MAR_CHECKS) — სწორედ ეს არის შეთავაზების საფუძველი
api PUT /modules/inpatient "$ADM" -d '{"settings":{"med_verification":"all"},"reason":"ტესტ-E2E"}' >/dev/null
O1=$(api POST "/inpatient/stays/$E1/orders" "$DR" -d '{"category":"medication","drug_text":"ტესტ-E2E QM წამალი","order_type":"once","dose":1,"dose_unit":"tab","route_code":"PO","override_reason":"ტესტ-E2E"}' | jq -r '.id // empty')
SL=$(api GET "/inpatient/stays/$E1/mar" "$NA" | jq -r --arg o "$O1" '[.entries[]|select(.order_id==$o and .status=="due")][0].id // empty')
DOC=$(api POST "/inpatient/mar/$SL/document" "$NA" -d '{"outcome":"given","override_reason":"ტესტ-E2E: სკანერი არ მუშაობდა"}' | jq -r '.status // .code // empty')
if [ "$DOC" = "given" ]; then
  R=$(api GET /quality/prompts "$NA")
  chk "ექთანს ეთავაზება: MAR, override, კატეგორია „არასწორი მედიკამენტი“; სხვა ექთანს — არა" \
    "$(echo "$R" | jq -r --arg s "$SL" '[.[]|select(.id==$s)][0]|"\(.type):\(.reason):\(.category_id!=null)"'):$(api GET /quality/prompts "$NB" | jq -r --arg s "$SL" '[.[]|select(.id==$s)]|length')" "mar_entry:override:true:0"
  R=$(rep "$NA" "$(base "$C_MED" | jq -c --arg s "$SL" 'del(.patient_text) | .source_type="mar_entry" | .source_id=$s | .event_type="near_miss"')")
  chk "შეტყობინება MAR-ზე: პაციენტი წყაროდან; შეთავაზება ქრება" \
    "$(api GET "/quality/incidents/$(echo "$R" | jq -r .id)" "$QM" | jq -r --arg p "$P1" '"\(.patient_id==$p):\(.source_type):\(.source_label|test("^MAR"))"'):$(api GET /quality/prompts "$NA" | jq -r --arg s "$SL" '[.[]|select(.id==$s)]|length')" "true:mar_entry:true:0"
  O2=$(api POST "/inpatient/stays/$E1/orders" "$DR" -d '{"category":"medication","drug_text":"ტესტ-E2E QM წამალი 2","order_type":"once","dose":1,"dose_unit":"tab","route_code":"PO","override_reason":"ტესტ-E2E"}' | jq -r '.id // empty')
  SL2=$(api GET "/inpatient/stays/$E1/mar" "$NA" | jq -r --arg o "$O2" '[.entries[]|select(.order_id==$o and .status=="due")][0].id // empty')
  api POST "/inpatient/mar/$SL2/document" "$NA" -d '{"outcome":"given","override_reason":"ტესტ-E2E"}' >/dev/null
  chk "„არ არის ინციდენტი“ → შეთავაზება აღარ ჩანს" \
    "$(api GET /quality/prompts "$NA" | jq -r --arg s "$SL2" '[.[]|select(.id==$s)]|length'):$(api POST /quality/prompts/dismiss "$NA" -d "{\"source_type\":\"mar_entry\",\"source_id\":\"$SL2\"}" | jq -r .ok):$(api GET /quality/prompts "$NA" | jq -r --arg s "$SL2" '[.[]|select(.id==$s)]|length')" "1:true:0"
  qmset '{"event_prompts":false}' >/dev/null
  chk "event_prompts = false → შეთავაზებები არ არის" "$(api GET /quality/prompts "$NA" | jq length)" "0"
  qmset '{"event_prompts":true}' >/dev/null
else
  bad "MAR-ის მომზადება" "დოკუმენტირება: $DOC (სლოტი: $SL)"
fi
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$O_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null

step "11. მოდულის გამორთვა"
api PUT /modules/quality "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთული: მეტა / შეტყობინება / რეესტრი → 403 MODULE_DISABLED" \
  "$(ecode GET /quality/meta "$NA"):$(repe "$NA" "$(base)"):$(ecode GET /quality/incidents "$QM")" "MODULE_DISABLED:MODULE_DISABLED:MODULE_DISABLED"

step "12. აღდგენა"
api PUT /modules/quality "$ADM" -d "{\"enabled\":$(echo "$O_QM" | jq .enabled),\"settings\":$(echo "$O_QM" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="quality")|{enabled, settings}' | jq -S -c .)" "$(echo "$O_QM" | jq -S -c .)"
ok "სატესტო ინციდენტები რეესტრში რჩება (ნომრები: $N1, $N2, $N3) — შემოწმებისთვის; სატესტო ქვეკატეგორია გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
