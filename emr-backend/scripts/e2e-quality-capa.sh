#!/usr/bin/env bash
# =====================================================================
# e2e-quality-capa.sh — ხარისხი და ინციდენტები, ეტაპი 2 (0065): გამომძიებელი, ანალიზის დონე (მიმოხილვა / RCA), ანალიზი + დამტკიცება / დაბრუნება,
#   RCA გუნდი, CAPA (შექმნა, საერთო რამდენიმე ინციდენტზე, პასუხისმგებლის ხედვა, დაწყება, ვადის შეცვლის მოთხოვნა, შესრულება მტკიცებულებით,
#   ეფექტიანობა, გაუქმება), ინფორმირება, დახურვა (პირობები, ავტორის უკუკავშირი, კოდით), PDF, ხელახლა გახსნა, აუდიტი
#   bash scripts/e2e-quality-capa.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-quality-capa.sh
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
rep()  { local t=$1 d=$2; shift 2; curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $t" -F "data=$d" "$@"; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '\x89PNG\r\n\x1a\nE2E-capa-evidence' > "$TMP/evidence.png"
H1=$(date -u -d '-1 hour' +%FT%TZ); NOW=$(date -u +%FT%TZ)
TODAY=$(TZ=Asia/Tbilisi date +%F); D10=$(TZ=Asia/Tbilisi date -d '+10 days' +%F); D20=$(TZ=Asia/Tbilisi date -d '+20 days' +%F); D90=$(TZ=Asia/Tbilisi date -d '+90 days' +%F)
YDAY=$(TZ=Asia/Tbilisi date -d '-1 day' +%F)
uid()  { cat "$TMP/u$1"; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.qc.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QC-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.qc.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_qc_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_qc_$1_$S"; }
notes() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" --arg e "${3:-}" '[.[]|select(.kind==$k and ($e=="" or (.link // "" | contains($e))))]|length'; }
days_to() { jq -r '((.'"$1"'|sub("\\.[0-9]+";"")|sub("\\+00:00$";"Z")|fromdateiso8601) - now)/86400|floor'; }
audit() { api GET "/audit-logs?entity_name=$1&entity_id=$2&action=$3" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]]|length'; }

step "0. მოდული, პარამეტრები, მომზადება"
O_QM=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="quality")|{enabled, settings}')
[ -n "$O_QM" ] || die "მოდული quality ვერ მოიძებნა"
chk "0065 ნაგულისხმევი: RCA — რისკი high / ზიანი severe, ვადა 14 / 45, შეხსენება 3, დამტკიცება ✓, ეფექტიანობა 90, ინფორმირება moderate" \
  "$(echo "$O_QM" | jq -r '.settings|"\(.rca_required_risk)/\(.rca_required_harm):\(.review_days)/\(.rca_days):\(.due_warn_days):\(.analysis_approval):\(.effectiveness_days):\(.disclosure_required_harm)"')" "high/severe:14/45:3:true:90:moderate"
chk "ვალიდაცია: მიმოხილვის ვადა > RCA-ს / არასწორი რისკი / ეფექტიანობა 5 დღე → 400" \
  "$(code PUT /modules/quality "$ADM" -d '{"settings":{"review_days":60,"rca_days":45},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"rca_required_risk":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"effectiveness_days":5},"reason":"ტესტ-E2E"}')" "400:400:400"
qmset() { api PUT /modules/quality "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
qmset '{"identity_modes":["open","confidential","anonymous"],"identity_default":"confidential","anonymous_tracking":true,"author_feedback":true,"alert_harm":"severe","alert_sms":false,"alert_email":false,"risk_low_max":3,"risk_medium_max":6,"risk_high_max":12,"rca_required_risk":"high","rca_required_harm":"severe","review_days":14,"rca_days":45,"due_warn_days":3,"analysis_approval":true,"capa_effectiveness":true,"effectiveness_days":90,"disclosure_required_harm":"moderate","closure_feedback":true,"investigator_at_triage":true}'
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E QC თერაპია $S\",\"code\":\"E2ECA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E QC ქირურგია $S\",\"code\":\"E2ECB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
R_QM=$(mkrole qm "ხარისხის მენეჯერი" '["quality"]'); R_QD=$(mkrole qd "ინციდენტები განყოფილება" '["quality_dept"]'); R_ST=$(mkrole st "სამეურნეო" '["hr"]')
[ -n "$R_QM" ] && [ -n "$R_QD" ] && [ -n "$R_ST" ] || die "როლები ვერ შეიქმნა"
QM=$(mkuser "[\"$R_QM\"]" 81)
QM2=$(mkuser "[\"$R_QM\"]" 82)
INV=$(mkuser '["nurse"]' 83 ",\"department_id\":\"$DA\"")                 # გამომძიებელი (ხარისხის უფლების გარეშე)
TM=$(mkuser '["doctor"]' 84 ",\"department_id\":\"$DA\"")                  # RCA გუნდის წევრი
OW=$(mkuser "[\"$R_ST\"]" 85)                                              # CAPA-ს პასუხისმგებელი (სამეურნეო)
NA=$(mkuser '["nurse"]' 86 ",\"department_id\":\"$DA\"")                   # ავტორი
XX=$(mkuser '["nurse"]' 87 ",\"department_id\":\"$DB\"")                   # უცხო
QD=$(mkuser "[\"$R_QD\"]" 88 ",\"department_id\":\"$DA\"")
for t in QM QM2 INV TM OW NA XX QD; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"94$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QC-პაციენტი\",\"birth_date\":\"1955-05-05\",\"gender\":\"female\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] || die "პაციენტი ვერ შეიქმნა"
CATS=$(api GET "/quality/classifiers?kind=category" "$NA"); cid() { echo "$CATS" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id'; }
FACS=$(api GET "/quality/classifiers?kind=factor" "$NA"); fid() { echo "$FACS" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id'; }
D1=$(jq -nc --arg d "$DA" --arg c "$(cid doc_record)" --arg at "$H1" --arg p "$P1" '{event_type:"no_harm",affected:"patient",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"none",description:"ტესტ-E2E: დანიშნულება ორჯერ ჩაიწერა",patient_id:$p,identity_mode:"confidential"}')
D2=$(jq -nc --arg d "$DA" --arg c "$(cid fall_bed)" --arg at "$H1" --arg p "$P1" '{event_type:"harm",affected:"patient",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"moderate",description:"ტესტ-E2E: დაცემა საწოლიდან, მოტეხილობა",patient_id:$p,identity_mode:"open"}')
D3=$(jq -nc --arg d "$DB" --arg c "$(cid surg_wrong_site)" --arg at "$H1" '{event_type:"near_miss",affected:"patient",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"none",description:"ტესტ-E2E: მარკირება არასწორ მხარეს — Time out-ზე გამოვლინდა",patient_text:"ტესტ, პალატა 3",identity_mode:"anonymous"}')
I1=$(rep "$NA" "$D1" | jq -r '.id // empty'); I2=$(rep "$NA" "$D2" | jq -r '.id // empty')
R=$(rep "$XX" "$D3"); CODE=$(echo "$R" | jq -r '.track_code // empty'); N3=$(echo "$R" | jq -r .inc_no)
I3=$(api GET "/quality/incidents?search=$N3" "$QM" | jq -r '.[0].id // empty')
I4=$(rep "$NA" "$D1" | jq -r '.id // empty')                                # ტრიაჟის გარეშე რჩება
[ -n "$I1" ] && [ -n "$I2" ] && [ -n "$I3" ] && [ -n "$I4" ] && [ -n "$CODE" ] || die "ინციდენტები ვერ შეიქმნა"
ok "განყოფილებები, 8 მომხმარებელი, პაციენტი, 4 ინციდენტი (კონფიდენციალური, ღია, ანონიმური სენტინელური, ტრიაჟის გარეშე)"

step "1. ტრიაჟი → დონე, ვადა, გამომძიებელი"
chk "გამომძიებელი — არარსებული → 400 USER" "$(ecode POST "/quality/incidents/$I1/triage" "$QM" -d '{"decision":"accept","harm":"none","likelihood":2,"consequence":2,"investigator_id":"00000000-0000-0000-0000-000000000000"}')" "USER"
R=$(api POST "/quality/incidents/$I1/triage" "$QM" -d "{\"decision\":\"accept\",\"harm\":\"none\",\"likelihood\":2,\"consequence\":2,\"investigator_id\":\"$(uid 83)\"}")
chk "I1 (რისკი 4 — საშუალო): მიმოხილვა, ვადა ~14 დღე, გამომძიებელი, ანალიზი — მონახაზი" \
  "$(echo "$R" | jq -r '"\(.analysis_level):\(.investigator_name|test("QC-83")):\(.analysis.status)"'):$(echo "$R" | days_to analysis_due_at)" "review:true:draft:13"
R=$(api POST "/quality/incidents/$I2/triage" "$QM" -d '{"decision":"accept","harm":"moderate","likelihood":3,"consequence":4}')
chk "I2 (რისკი 12 — მაღალი): RCA, ვადა ~45 დღე, გამომძიებლის გარეშე" "$(echo "$R" | jq -r '"\(.analysis_level):\(.investigator_id)"'):$(echo "$R" | days_to analysis_due_at)" "rca:null:44"
chk "I3 (სენტინელური, რისკი 1): RCA" "$(api POST "/quality/incidents/$I3/triage" "$QM" -d '{"decision":"accept","harm":"none","likelihood":1,"consequence":1}' | jq -r .analysis_level)" "rca"
chk "გამომძიებელს — შეტყობინება (qm_assign)" "$(notes "$INV" qm_assign "$I1")" "1"

step "2. წვდომა: გამომძიებელი, გუნდი, სხვები"
R=$(api GET "/quality/incidents/$I1" "$INV")
chk "გამომძიებელი (ექთანი, ხარისხის უფლების გარეშე): inv; მონაწილეები ხელმისაწვდომი; ავტორი (კონფიდენციალური) — დამალული; რედაქტირება / გაგზავნა ✓" \
  "$(echo "$R" | jq -r '"\(.access):\(.people!=null):\(.reporter_name):\(.can.edit_analysis):\(.can.submit):\(.can.add_capa)"')" "inv:true:null:true:true:true"
chk "გამომძიებელი: სხვა ინციდენტი (I2) — 404; რეესტრი — 403; „ჩემი ქმედებები“ — 1 ინციდენტი" \
  "$(code GET "/quality/incidents/$I2" "$INV"):$(code GET /quality/incidents "$INV"):$(api GET /quality/my-work "$INV" | jq -r '.incidents|length')" "404:403:1"
chk "უცხო ექთანი / ტრიაჟამდე შეხება — 404" "$(code GET "/quality/incidents/$I1" "$XX")" "404"

step "3. გამომძიებლის დანიშვნა, დონე"
chk "დანიშვნა: არა ხარისხის მენეჯერი — 403; ტრიაჟამდე (I4) — 409" \
  "$(code POST "/quality/incidents/$I2/investigator" "$INV" -d "{\"user_id\":\"$(uid 83)\"}"):$(code POST "/quality/incidents/$I4/investigator" "$QM" -d "{\"user_id\":\"$(uid 83)\"}")" "403:409"
chk "I2 → გამომძიებელი; შეტყობინება" "$(api POST "/quality/incidents/$I2/investigator" "$QM" -d "{\"user_id\":\"$(uid 83)\"}" | jq -r '.investigator_id==$u' --arg u "$(uid 83)"):$(notes "$INV" qm_assign "$I2")" "true:1"
api POST "/quality/incidents/$I3/investigator" "$QM" -d "{\"user_id\":\"$(uid 83)\"}" >/dev/null
chk "დონე: სენტინელური RCA → მიმოხილვა — 400 SENTINEL_RCA; დაწევა მიზეზის გარეშე — 400 REASON_REQUIRED; იგივე — 400 NO_CHANGE" \
  "$(ecode POST "/quality/incidents/$I3/level" "$QM" -d '{"level":"review","reason":"ტესტ-E2E"}'):$(ecode POST "/quality/incidents/$I2/level" "$QM" -d '{"level":"review"}'):$(ecode POST "/quality/incidents/$I2/level" "$QM" -d '{"level":"rca"}')" "SENTINEL_RCA:REASON_REQUIRED:NO_CHANGE"
chk "I1: მიმოხილვა → RCA (ვადა ~45) → მიმოხილვა მიზეზით (ვადა ~14); გამომძიებელს არ შეუძლია — 403" \
  "$(api POST "/quality/incidents/$I1/level" "$QM" -d '{"level":"rca"}' | days_to analysis_due_at):$(api POST "/quality/incidents/$I1/level" "$QM" -d '{"level":"review","reason":"ტესტ-E2E: მარტივი შემთხვევა"}' | jq -r .analysis_level):$(code POST "/quality/incidents/$I1/level" "$INV" -d '{"level":"rca"}')" "44:review:403"

step "4. მოკლე მიმოხილვა (I1): შევსება, გაგზავნა, დაბრუნება, დამტკიცება"
api PUT "/quality/incidents/$I1/analysis" "$INV" -d '{"what_happened":"ტესტ-E2E: ორი ექიმის ერთდროული ჩანაწერი"}' >/dev/null
chk "არასრული → 400 ANALYSIS_INCOMPLETE (ძირეული მიზეზი, მიღებული ზომა)" \
  "$(api POST "/quality/incidents/$I1/analysis/submit" "$INV" -d '{}' | jq -r '"\(.code):\(.missing|length)"')" "ANALYSIS_INCOMPLETE:2"
api PUT "/quality/incidents/$I1/analysis" "$INV" -d '{"root_cause":"ტესტ-E2E: დუბლირების შემოწმება არ არის","action_taken":"ტესტ-E2E: სისტემაში გაფრთხილება"}' >/dev/null
R=$(api POST "/quality/incidents/$I1/analysis/submit" "$INV" -d '{}')
chk "გამომძიებელი აგზავნის → analysis (დამტკიცებას ელოდება); ხარისხის მენეჯერებს — შეტყობინება (ორივეს)" \
  "$(echo "$R" | jq -r '"\(.status):\(.analysis.status)"'):$(notes "$QM" qm_analysis "$I1"):$(notes "$QM2" qm_analysis "$I1")" "analysis:submitted:1:1"
chk "გაგზავნის შემდეგ რედაქტირება — 409; განმეორებითი გაგზავნა — 409" \
  "$(ecode PUT "/quality/incidents/$I1/analysis" "$INV" -d '{"what_happened":"x"}'):$(code POST "/quality/incidents/$I1/analysis/submit" "$INV" -d '{}')" "NOT_EDITABLE:409"
chk "დაბრუნება: გამომძიებელი — 403; მიზეზის გარეშე — 400" "$(code POST "/quality/incidents/$I1/analysis/return" "$INV" -d '{"reason":"ტესტ"}'):$(code POST "/quality/incidents/$I1/analysis/return" "$QM" -d '{}')" "403:400"
R=$(api POST "/quality/incidents/$I1/analysis/return" "$QM" -d '{"reason":"ტესტ-E2E: დააზუსტეთ მიზეზი"}')
chk "დაბრუნდა → investigation, returned + მიზეზი; გამომძიებელს — სასწრაფო შეტყობინება" \
  "$(echo "$R" | jq -r '"\(.status):\(.analysis.status):\(.analysis.return_reason|test("დააზუსტეთ"))"'):$(api GET '/notifications?unread=true' "$INV" | jq -r '[.[]|select(.kind=="qm_returned" and .urgent)]|length')" "investigation:returned:true:1"
api PUT "/quality/incidents/$I1/analysis" "$INV" -d '{"root_cause":"ტესტ-E2E: დუბლირების შემოწმება არ არის, ორი ექიმი ერთ ცვლაში"}' >/dev/null
api POST "/quality/incidents/$I1/analysis/submit" "$INV" -d '{}' >/dev/null
R=$(api POST "/quality/incidents/$I1/analysis/approve" "$QM" -d '{}')
chk "დამტკიცება → capa; ანალიზი approved; დამტკიცება ხელახლა — 409" "$(echo "$R" | jq -r '"\(.status):\(.analysis.status):\(.analysis.approved_by_name|test("QC-81"))"'):$(code POST "/quality/incidents/$I1/analysis/approve" "$QM" -d '{}')" "capa:approved:true:409"
chk "აუდიტი: QM_ANALYSIS_SUBMIT ×2, QM_ANALYSIS_RETURN, QM_ANALYSIS_APPROVE" \
  "$(audit qm_incidents "$I1" QM_ANALYSIS_SUBMIT):$(audit qm_incidents "$I1" QM_ANALYSIS_RETURN):$(audit qm_incidents "$I1" QM_ANALYSIS_APPROVE)" "2:1:1"

step "5. RCA (I2): გუნდი, ქრონოლოგია, ფაქტორები, „5 რატომ“"
chk "გუნდის წევრი ჯერ ვერ ხედავს — 404" "$(code GET "/quality/incidents/$I2" "$TM")" "404"
R=$(api PUT "/quality/incidents/$I2/analysis" "$INV" -d "{\"team\":[{\"user_id\":\"$(uid 84)\",\"role_text\":\"ორთოპედი\"}]}")
chk "გამომძიებელი ამატებს გუნდში ექიმს → წვდომა inv; შეტყობინება (qm_team)" "$(echo "$R" | jq -r '.analysis.team|length'):$(api GET "/quality/incidents/$I2" "$TM" | jq -r .access):$(sleep 1; notes "$TM" qm_team "$I2")" "1:inv:1"
chk "გუნდის წევრი: გუნდის შეცვლა — 403; გაგზავნა — 403; არასწორი ფაქტორი — 400 FACTOR" \
  "$(code PUT "/quality/incidents/$I2/analysis" "$TM" -d '{"team":[]}'):$(code POST "/quality/incidents/$I2/analysis/submit" "$TM" -d '{}'):$(ecode PUT "/quality/incidents/$I2/analysis" "$TM" -d "{\"factors\":[{\"factor_id\":\"$(cid fall)\"}]}")" "403:403:FACTOR"
RCA=$(jq -nc --arg t1 "$H1" --arg f1 "$(fid pf_condition)" --arg f2 "$(fid env_staffing)" '{timeline:[{at:$t1,text:"პაციენტი დამოუკიდებლად ადგა"},{at:null,text:"ექთანი სხვა პალატაში იყო"}],
  factors:[{factor_id:$f1,comment:"ორთოსტატული ჰიპოტენზია"},{factor_id:$f2,comment:"ღამის ცვლაში 1 ექთანი 20 პაციენტზე"}],
  whys:["რატომ დაეცა? — თავბრუსხვევა","რატომ ადგა მარტო? — ზარი მიუწვდომელი იყო","რატომ? — ზარის ადგილმდებარეობა"],root_causes:"ტესტ-E2E: დაცემის რისკის შეფასება არ ჩატარდა; ზარი მიუწვდომელი",conclusion:"ტესტ-E2E: დაცემის პროტოკოლის განახლება"}')
R=$(api PUT "/quality/incidents/$I2/analysis" "$TM" -d "$RCA")
chk "გუნდის წევრი ავსებს: 2 ქრონოლოგია, 2 ფაქტორი, 3 „რატომ“; გუნდი უცვლელია" "$(echo "$R" | jq -r '.analysis|"\(.timeline|length):\(.factors|length):\(.whys|length):\(.team|length)"')" "2:2:3:1"
chk "RCA ყველა ველით → გაგზავნა (გამომძიებელი) → analysis; ხარისხის მენეჯერი ამტკიცებს → capa" \
  "$(api POST "/quality/incidents/$I2/analysis/submit" "$INV" -d '{}' | jq -r .status):$(api POST "/quality/incidents/$I2/analysis/approve" "$QM" -d '{}' | jq -r .status)" "analysis:capa"
qmset '{"analysis_approval":false}'
api PUT "/quality/incidents/$I3/analysis" "$INV" -d "$RCA" >/dev/null
chk "analysis_approval = false: გამომძიებლის გაგზავნა = დამტკიცება (I3 → capa)" "$(api POST "/quality/incidents/$I3/analysis/submit" "$INV" -d '{}' | jq -r '"\(.status):\(.analysis.status)"')" "capa:approved"
qmset '{"analysis_approval":true}'
chk "RCA მონახაზი ცარიელ ინციდენტზე: გაგზავნა → 400 (I4 — ტრიაჟამდე, 404 / 409)" "$(code POST "/quality/incidents/$I4/analysis/submit" "$QM" -d '{}')" "409"

step "6. CAPA: შექმნა, პასუხისმგებლის ხედვა"
CAPA() { jq -nc --arg t "$1" --arg o "$(uid 85)" --arg d "$2" --argjson ids "$3" --arg dep "$DA" '{title:$t,kind:"corrective",owner_id:$o,due_date:$d,department_id:$dep,incident_ids:$ids}'; }
chk "ავტორი (არც გამომძიებელი) — 403; ვადა წარსულში — 400 DUE_DATE; ტრიაჟამდე ინციდენტი — 409 INCIDENT_NOT_OPEN; ცარიელი სია — 400" \
  "$(code POST /quality/capas "$NA" -d "$(CAPA 'ტესტ-E2E ზარის გადატანა' "$D20" "[\"$I2\"]")"):$(ecode POST /quality/capas "$QM" -d "$(CAPA 'ტესტ-E2E ზარის გადატანა' "$YDAY" "[\"$I2\"]")"):$(ecode POST /quality/capas "$QM" -d "$(CAPA 'ტესტ-E2E ზარის გადატანა' "$D20" "[\"$I4\"]")"):$(code POST /quality/capas "$QM" -d "$(CAPA 'ტესტ-E2E ზარის გადატანა' "$D20" "[]")")" "403:DUE_DATE:INCIDENT_NOT_OPEN:400"
R=$(api POST /quality/capas "$INV" -d "$(CAPA 'ტესტ-E2E ზარის გადატანა საწოლთან' "$D20" "[\"$I2\"]")"); C1=$(echo "$R" | jq -r '.id // empty')
chk "გამომძიებელი ქმნის (I2): CAPAyy-NNNNNN, ღია, პასუხისმგებელს — შეტყობინება" "$(echo "$R" | jq -r '"\(.capa_no|test("^CAPA[0-9]{2}-[0-9]{6}$")):\(.status)"'):$(notes "$OW" qm_capa "$C1")" "true:open:1"
R=$(api POST /quality/capas "$INV" -d "$(CAPA 'ტესტ-E2E დაცემის რისკის შეფასების ფორმა' "$D20" "[\"$I1\",\"$I2\"]")"); C2=$(echo "$R" | jq -r '.id // empty')
chk "საერთო CAPA ორ ინციდენტზე (I1 + I2): ორივე ბარათზე ჩანს" \
  "$(echo "$R" | jq -r '.incidents|length'):$(api GET "/quality/incidents/$I1" "$QM" | jq -r --arg c "$C2" '[.capas[]|select(.id==$c)]|length'):$(api GET "/quality/incidents/$I2" "$QM" | jq -r --arg c "$C2" '[.capas[]|select(.id==$c)][0].incidents')" "2:1:2"
R=$(api GET "/quality/capas/$C1" "$OW")
chk "პასუხისმგებელი: owner; ინციდენტის შეჯამება (№, კატეგორია, ძირეული მიზეზი) — პაციენტის / ავტორის / აღწერის გარეშე; ინციდენტი — 404" \
  "$(echo "$R" | jq -r '"\(.access):\(.incidents[0].root_cause|test("დაცემის")):\(.incidents[0]|has("patient_id") or has("description") or has("reporter_name"))"'):$(code GET "/quality/incidents/$I2" "$OW")" "owner:true:false:404"
chk "„ჩემი ქმედებები“ (პასუხისმგებელი) — 2; CAPA რეესტრი: პასუხისმგებელი — მხოლოდ თავისი; უცხო — 404" \
  "$(api GET /quality/my-work "$OW" | jq -r '.capas|length'):$(api GET /quality/capas "$OW" | jq -r --arg o "$(uid 85)" '[.[]|select(.owner_id!=$o)]|length'):$(code GET "/quality/capas/$C1" "$XX")" "2:0:404"

step "7. CAPA: დაწყება, ვადა, შესრულება, ეფექტიანობა, გაუქმება"
chk "დაწყება: უცხო — 403; პასუხისმგებელი → in_progress; ხელახლა — 409" \
  "$(code POST "/quality/capas/$C1/start" "$XX" -d '{}'):$(api POST "/quality/capas/$C1/start" "$OW" -d '{}' | jq -r .status):$(code POST "/quality/capas/$C1/start" "$OW" -d '{}')" "403:in_progress:409"
R=$(api POST "/quality/capas/$C1/due-requests" "$OW" -d "{\"new_due\":\"$D10\",\"reason\":\"ტესტ-E2E: მომწოდებელი აგვიანებს\"}")
RID=$(echo "$R" | jq -r '.requests[0].id // empty')
chk "ვადის მოთხოვნა → pending; განმეორებით — 409; ხარისხის მენეჯერს — შეტყობინება" \
  "$(echo "$R" | jq -r '.requests[0].status'):$(ecode POST "/quality/capas/$C1/due-requests" "$OW" -d "{\"new_due\":\"$D90\",\"reason\":\"ტესტ-E2E\"}"):$(notes "$QM" qm_capa_due "$C1")" "pending:DUE_REQUEST_PENDING:1"
chk "უარი მიზეზის გარეშე — 400; პასუხისმგებელი ვერ წყვეტს — 403" \
  "$(ecode POST "/quality/capas/$C1/due-requests/$RID/decide" "$QM" -d '{"approve":false}'):$(code POST "/quality/capas/$C1/due-requests/$RID/decide" "$OW" -d '{"approve":true}')" "NOTE_REQUIRED:403"
chk "დამტკიცება → ვადა შეიცვალა; პასუხისმგებელს — შეტყობინება" \
  "$(api POST "/quality/capas/$C1/due-requests/$RID/decide" "$QM" -d '{"approve":true}' | jq -r '.due_date|.[0:10]'):$(api GET '/notifications?unread=true' "$OW" | jq -r --arg c "$C1" '[.[]|select(.kind=="qm_capa_due" and (.link|contains($c)))]|length')" "$D10:1"
chk "რედაქტირება (QM): ვადის შეცვლა მიზეზის გარეშე — 400 REASON_REQUIRED" "$(ecode PATCH "/quality/capas/$C1" "$QM" -d "{\"due_date\":\"$D20\"}")" "REASON_REQUIRED"
chk "შესრულება აღწერის გარეშე — 400; ეფექტიანობა დაუსრულებელზე — 409" \
  "$(ecode POST "/quality/capas/$C1/complete" "$OW" -d '{"note":""}'):$(ecode POST "/quality/capas/$C1/effectiveness" "$QM" -d '{"result":"effective","note":"ტესტ"}')" "NOTE_REQUIRED:NOT_DONE"
R=$(curl -s -X POST "$B/quality/capas/$C1/complete" -H "authorization: Bearer $OW" -F "note=ტესტ-E2E: ზარი გადატანილია ყველა საწოლთან" -F "files=@$TMP/evidence.png;type=image/png")
chk "შესრულება მტკიცებულებით → done, 1 ფაილი, ეფექტიანობის ვადა +90 დღე; ხარისხის მენეჯერს — შეტყობინება" \
  "$(echo "$R" | jq -r '"\(.status):\(.files|length):\(.effectiveness_due|.[0:10])"'):$(notes "$QM" qm_capa_done "$C1")" "done:1:$D90:1"
FID=$(echo "$R" | jq -r '.files[0].id')
chk "მტკიცებულება: პასუხისმგებელი / გამომძიებელი ხსნის — 200; უცხო — 404" \
  "$(code GET "/quality/capas/$C1/files/$FID" "$OW"):$(code GET "/quality/capas/$C1/files/$FID" "$INV"):$(code GET "/quality/capas/$C1/files/$FID" "$XX")" "200:200:404"
chk "ეფექტიანობა: პასუხისმგებელი — 403; QM → effective; ხელახლა — 409" \
  "$(code POST "/quality/capas/$C1/effectiveness" "$OW" -d '{"result":"effective","note":"ტესტ"}'):$(api POST "/quality/capas/$C1/effectiveness" "$QM" -d '{"result":"effective","note":"ტესტ-E2E: 3 თვე დაცემა არ ყოფილა"}' | jq -r .effectiveness_result):$(code POST "/quality/capas/$C1/effectiveness" "$QM" -d '{"result":"ineffective","note":"ტესტ"}')" "403:effective:409"
chk "გაუქმება: პასუხისმგებელი — 403; მიზეზის გარეშე — 400; QM → cancelled" \
  "$(code POST "/quality/capas/$C2/cancel" "$OW" -d '{"reason":"ტესტ"}'):$(code POST "/quality/capas/$C2/cancel" "$QM" -d '{}'):$(api POST "/quality/capas/$C2/cancel" "$QM" -d '{"reason":"ტესტ-E2E: სხვა ქმედებით დაიფარა"}' | jq -r .status)" "403:400:cancelled"
chk "აუდიტი: QM_CAPA_CREATE / START / DUE_REQUEST / DUE_DECIDE / DONE / EFFECTIVENESS" \
  "$(audit qm_capas "$C1" QM_CAPA_CREATE):$(audit qm_capas "$C1" QM_CAPA_START):$(audit qm_capas "$C1" QM_CAPA_DUE_REQUEST):$(audit qm_capas "$C1" QM_CAPA_DUE_DECIDE):$(audit qm_capas "$C1" QM_CAPA_DONE):$(audit qm_capas "$C1" QM_CAPA_EFFECTIVENESS)" "1:1:1:1:1:1"

step "8. ინფორმირება და დახურვა"
C3=$(api POST /quality/capas "$QM" -d "$(CAPA 'ტესტ-E2E პერსონალის ტრენინგი' "$D20" "[\"$I2\"]")" | jq -r '.id // empty')
R=$(api GET "/quality/incidents/$I2/close-check" "$QM")
chk "I2 დახურვის შემოწმება: ღია CAPA + ინფორმირება სავალდებულო (ზიანი საშუალო)" "$(echo "$R" | jq -r '"\(.ok):\([.blockers[].code]|sort|join(","))"')" "false:CAPA_OPEN,DISCLOSURE_REQUIRED"
chk "დახურვა → 409 CAPA_OPEN; დასკვნის გარეშე — 400" "$(ecode POST "/quality/incidents/$I2/close" "$QM" -d '{"summary":"ტესტ-E2E: დასკვნა დახურვისას"}'):$(code POST "/quality/incidents/$I2/close" "$QM" -d '{}')" "CAPA_OPEN:400"
curl -s -X POST "$B/quality/capas/$C3/complete" -H "authorization: Bearer $QM" -F "note=ტესტ-E2E: ტრენინგი ჩატარდა" >/dev/null
chk "ინფორმირება: ავტორი — 403; „არ ეცნობა“ მიზეზის გარეშე — 400; „ეცნობა“ დროის გარეშე — 400" \
  "$(code PUT "/quality/incidents/$I2/disclosure" "$NA" -d '{"status":"not_disclosed","note":"ტესტ"}'):$(ecode PUT "/quality/incidents/$I2/disclosure" "$INV" -d '{"status":"not_disclosed"}'):$(ecode PUT "/quality/incidents/$I2/disclosure" "$INV" -d '{"status":"done","method":"phone"}')" "403:DISCLOSURE_FIELDS:DISCLOSURE_FIELDS"
R=$(api PUT "/quality/incidents/$I2/disclosure" "$INV" -d "{\"status\":\"done\",\"at\":\"$NOW\",\"method\":\"in_person\",\"to\":\"ქალიშვილი\"}")
chk "გამომძიებელი აღრიცხავს: done, პირისპირ; დახურვის შემოწმება → ok" "$(echo "$R" | jq -r '"\(.disclosure_status):\(.disclosure_method):\(.disclosure_by_name|test("QC-83"))"'):$(api GET "/quality/incidents/$I2/close-check" "$QM" | jq -r .ok)" "done:in_person:true:true"
chk "დახურვა: გამომძიებელი — 403" "$(code POST "/quality/incidents/$I2/close" "$INV" -d '{"summary":"ტესტ-E2E: დასკვნა დახურვისას"}')" "403"
R=$(api POST "/quality/incidents/$I2/close" "$QM" -d '{"summary":"ტესტ-E2E: პროტოკოლი განახლდა, ზარები გადატანილია","feedback_text":"ზარები გადავიტანეთ საწოლებთან, ჩატარდა ტრენინგი."}')
chk "დახურულია: closed, დასკვნა, ავტორს — შეტყობინება უკუკავშირით; გამომძიებელს — qm_closed" \
  "$(echo "$R" | jq -r '"\(.status):\(.closure_summary!=null)"'):$(api GET '/notifications?unread=true' "$NA" | jq -r '[.[]|select(.kind=="qm_status" and (.body // "" | test("ზარები")))]|length'):$(notes "$INV" qm_closed "$I2")" "closed:true:1:1"
R=$(api GET "/quality/incidents/$I2" "$NA")
chk "ავტორის ხედვა: უკუკავშირი ჩანს; ანალიზი / CAPA / დასკვნა / ინფორმირება — არა" "$(echo "$R" | jq -r '"\(.access):\(.feedback_text|test("ზარები")):\(.analysis):\(.capas):\(.closure_summary):\(.disclosure_status)"')" "own:true:null:null:null:null"
chk "დახურულზე: კომენტარი / CAPA / ინფორმირება — 409" \
  "$(code POST "/quality/incidents/$I2/comments" "$QM" -d '{"text":"ტესტ"}'):$(code POST /quality/capas "$QM" -d "$(CAPA 'ტესტ-E2E გვიანი ქმედება' "$D20" "[\"$I2\"]")"):$(code PUT "/quality/incidents/$I2/disclosure" "$QM" -d '{"status":"not_disclosed","note":"ტესტ"}')" "409:409:409"
chk "I1 (ზიანის გარეშე, ქმედება გაუქმებული): ინფორმირება არ სჭირდება → დახურვა" "$(api POST "/quality/incidents/$I1/close" "$QM" -d '{"summary":"ტესტ-E2E: სისტემური გაფრთხილება დაემატა"}' | jq -r .status)" "closed"
api POST "/quality/incidents/$I3/close" "$QM" -d '{"summary":"ტესტ-E2E: Time out პროტოკოლი გაძლიერდა","feedback_text":"Time out-ზე დამატებითი შემოწმება შემოვიღეთ."}' >/dev/null
chk "ანონიმური (I3): კოდით — დახურული + უკუკავშირი" "$(api GET "/quality/track?code=$CODE" "$XX" | jq -r '"\(.status):\(.feedback|test("Time out"))"')" "closed:true"
chk "აუდიტი: QM_DISCLOSURE, QM_CLOSE" "$(audit qm_incidents "$I2" QM_DISCLOSURE):$(audit qm_incidents "$I2" QM_CLOSE)" "1:1"

step "9. ანგარიში (PDF), ხელახლა გახსნა"
chk "PDF: ხარისხის მენეჯერი / გამომძიებელი — application/pdf; ავტორი / განყოფილება — 403" \
  "$(curl -s -o "$TMP/r.pdf" -w '%{http_code}:%{content_type}' "$B/quality/incidents/$I2/report" -H "authorization: Bearer $QM"):$(head -c 5 "$TMP/r.pdf"):$(code GET "/quality/incidents/$I2/report?mask=0" "$INV"):$(code GET "/quality/incidents/$I2/report" "$NA"):$(code GET "/quality/incidents/$I2/report" "$QD")" "200:application/pdf:%PDF-:200:403:403"
chk "PDF აუდიტში (QM_REPORT_PDF)" "$(audit qm_incidents "$I2" QM_REPORT_PDF)" "2"
R=$(api POST "/quality/incidents/$I2/reopen" "$QM" -d '{"reason":"ტესტ-E2E: განმეორებითი დაცემა"}')
chk "დახურულის ხელახლა გახსნა → investigation, ანალიზი returned (რედაქტირებადი); მიზეზის გარეშე — 400" \
  "$(echo "$R" | jq -r '"\(.status):\(.analysis.status):\(.can.edit_analysis)"'):$(code POST "/quality/incidents/$I1/reopen" "$QM" -d '{}')" "investigation:returned:true:400"

step "10. მოდულის გამორთვა, აღდგენა"
api PUT /modules/quality "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთული: ჩემი ქმედებები / CAPA / ანალიზი → 403 MODULE_DISABLED" \
  "$(ecode GET /quality/my-work "$INV"):$(ecode GET "/quality/capas/$C1" "$OW"):$(ecode PUT "/quality/incidents/$I2/analysis" "$INV" -d '{}')" "MODULE_DISABLED:MODULE_DISABLED:MODULE_DISABLED"
api PUT /modules/quality "$ADM" -d "{\"enabled\":$(echo "$O_QM" | jq .enabled),\"settings\":$(echo "$O_QM" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="quality")|{enabled, settings}' | jq -S -c .)" "$(echo "$O_QM" | jq -S -c .)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
