#!/usr/bin/env bash
# =====================================================================
# e2e-quality-reports.sh — ხარისხი და ინციდენტები, ეტაპი 3: ანგარიშები და დაფა (0066)
#   მომსახურების ტიპი, rpt_fact_quality (გადათვლა), KPI ჯგუფი „ხარისხი“ (= ანგარიში), ინდიკატორები 1000 საწოლ-დღეზე (+ ცნობარი → KPI),
#   განაწილება (pivot), ვადები / შესრულება, CAPA, ხელშემწყობი ფაქტორები, ხედვა (quality / quality_dept / quality_view, view_min_cell),
#   dashboard_visibility, „ყურადღება“, თვიური ანგარიშის სექცია (monthly_section), ექსპორტი (xlsx / PDF / CSV), დეპერსონალიზებული რეესტრი,
#   report_date_basis, მოდულის გამორთვა.
#   bash scripts/e2e-quality-reports.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-quality-reports.sh
#   python3 სჭირდება (xlsx-ის ფურცლების შემოწმება).
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
command -v python3 >/dev/null || die "python3 არ არის დაყენებული"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r '.code // .error.code // .message.code // empty'; }
rep()  { local t=$1 d=$2; shift 2; curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $t" -F "data=$d" "$@"; }
dl()   { curl -s -o "$3" -w '%{http_code}' "$B$1" -H "authorization: Bearer $2"; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
M5=$(date -u -d '-5 minutes' +%FT%TZ); D3AGO=$(date -u -d '-3 days' +%FT%TZ)
TODAY=$(TZ=Asia/Tbilisi date +%F); D3=$(TZ=Asia/Tbilisi date -d '-3 days' +%F); D20=$(TZ=Asia/Tbilisi date -d '+20 days' +%F); MONTH="${TODAY:0:8}01"
uid()  { cat "$TMP/u$1"; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.qr.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QR-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.qr.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_qr_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_qr_$1_$S"; }
audit() { api GET "/audit-logs?entity_name=$1&entity_id=$2&action=$3" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]]|length'; }
qmset() { api PUT /modules/quality "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
kv() { echo "$1" | jq -r --arg c "$2" '.kpis[]|select(.code==$c)|.value'; }
refresh() {
  local R id st i; R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  if [ -z "$id" ]; then   # მიმდინარე (worker) — დაველოდოთ და ვცადოთ ხელახლა
    for i in $(seq 1 60); do sleep 1; [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; done
    R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  fi
  [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 120); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}
sheets() { python3 - "$1" <<'PY'
import sys, zipfile, re
z = zipfile.ZipFile(sys.argv[1]); w = z.read('xl/workbook.xml').decode('utf-8')
print('|'.join(re.findall(r'<sheet name="([^"]+)"', w)))
PY
}

step "0. მოდული, პარამეტრები, KPI ცნობარი"
O_QM=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="quality")|{enabled, settings}')
[ -n "$O_QM" ] || die "მოდული quality ვერ მოიძებნა"
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
[ "$(echo "$O_RPT" | jq -r .enabled)" = "true" ] || die "მოდული „მენეჯერული რეპორტინგი“ გამორთულია"
chk "ნაგულისხმევი (0066): occurred, view_min_cell 0, report_users, monthly_section" \
  "$(echo "$O_QM" | jq -r '.settings|"\(.report_date_basis):\(.view_min_cell):\(.dashboard_visibility):\(.monthly_section)"')" "occurred:0:report_users:true"
chk "ვალიდაცია: report_date_basis / view_min_cell 25 / dashboard_visibility → 400" \
  "$(code PUT /modules/quality "$ADM" -d '{"settings":{"report_date_basis":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"view_min_cell":25},"reason":"ტესტ-E2E"}'):$(code PUT /modules/quality "$ADM" -d '{"settings":{"dashboard_visibility":"all"},"reason":"ტესტ-E2E"}')" "400:400:400"
qmset '{"report_date_basis":"occurred","view_min_cell":0,"dashboard_visibility":"report_users","monthly_section":true}' >/dev/null
KP=$(api GET /reporting/kpis "$ADM")
chk "KPI ცნობარი: ჯგუფი quality — 11 (+ მომხმარებლის ინდიკატორები), ჩაღრმავების გარეშე; qm_capa_overdue — მომენტალური" \
  "$(echo "$KP" | jq -r '[.[]|select(.category=="quality" and (.code|test("^qm_ind_e2e")|not))]|"\(length):\([.[]|select(.drill!=null)]|length):\(.[]|select(.code=="qm_capa_overdue")|.snapshot)"')" "11:0:true"
chk "39 უფლება (0066 — ახალი უფლება არ არის; 0067: + infection, infection_dept, infection_view)" "$(api GET /roles/capabilities "$ADM" | jq length)" "39"

step "1. მომზადება: განყოფილებები, საწოლი, მომხმარებლები, პაციენტი"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E QR თერაპია $S\",\"code\":\"E2EQRA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E QR ქირურგია $S\",\"code\":\"E2EQRB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
W=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DA\",\"code\":\"QR$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BED=$(api POST "/inpatient/wards/$W/beds" "$ADM" -d '{"count":1}' | jq -r '.[0].id // empty')
[ -n "$BED" ] || die "საწოლი ვერ შეიქმნა"
R_QM=$(mkrole qm "ხარისხის მენეჯერი" '["quality"]'); R_QD=$(mkrole qd "ინციდენტები განყ." '["quality_dept"]'); R_QV=$(mkrole qv "ინციდენტების ანგარიშები" '["quality_view"]')
R_QVA=$(mkrole qva "ანგარიშები კლინიკა" '["quality_view","reports_all"]'); R_REP=$(mkrole rep "დაფა განყ." '["reports"]'); R_RA=$(mkrole ra "დაფა კლინიკა" '["reports_all"]')
for r in R_QM R_QD R_QV R_QVA R_REP R_RA; do [ -n "${!r}" ] || die "როლი $r ვერ შეიქმნა"; done
QM=$(mkuser "[\"$R_QM\"]" 61)
QD=$(mkuser "[\"$R_QD\"]" 62 ",\"department_id\":\"$DA\"")
QV=$(mkuser "[\"$R_QV\"]" 63 ",\"department_id\":\"$DA\"")
QVA=$(mkuser "[\"$R_QVA\"]" 64)
REP=$(mkuser "[\"$R_REP\"]" 65 ",\"department_id\":\"$DA\"")
RA=$(mkuser "[\"$R_RA\"]" 66)
NS=$(mkuser '["nurse"]' 67 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 68 ",\"department_id\":\"$DB\"")
RC=$(mkuser '["receptionist"]' 69)
for t in QM QD QV QVA REP RA NS DR RC; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"94$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QR-პაციენტი\",\"birth_date\":\"1955-05-05\",\"gender\":\"female\",\"phone_number\":\"594$S\"}" | jq -r '.id // empty')
E1=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 68)\",\"source\":\"direct\",\"icd10_code\":\"I10\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
[ -n "$E1" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
chk "საწოლის მინიჭება (განყოფილება A)" "$(api POST "/inpatient/stays/$E1/bed" "$NS" -d "{\"bed_id\":\"$BED\"}" | jq -r '.bed != null')" "true"
ok "მომხმარებლები: QM, განმხილველი A, ანგარიშები A / კლინიკა, დაფა A / კლინიკა, ექთანი A, ექიმი B"
CATS=$(api GET "/quality/classifiers?kind=category" "$NS"); cid() { echo "$CATS" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id'; }
FACS=$(api GET "/quality/classifiers?kind=factor" "$NS"); fid() { echo "$FACS" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id'; }
C_FALL=$(cid fall); C_FALLD=$(cid fall_death); C_MED=$(cid medication); C_DOC=$(cid documentation); C_INFRA=$(cid infrastructure)

step "2. ინციდენტები და მომსახურების ტიპი"
inc() { jq -nc --arg d "${5:-$DA}" --arg c "$1" --arg at "${6:-$M5}" --arg p "${4:-}" --arg e "$2" --arg h "$3" \
  '{event_type:$e,affected:(if $p=="" then "none" else "patient" end),occurred_at:$at,department_id:$d,category_id:$c,harm_reported:$h,
    description:"ტესტ-E2E: ანგარიშის სატესტო ინციდენტი",identity_mode:"confidential"} + (if $p=="" then {} else {patient_id:$p} end)'; }
I1=$(rep "$NS" "$(inc "$C_FALL" harm mild "$P1" | jq -c --arg e "$E1" '.source_type="stay" | .source_id=$e')" | jq -r '.id // empty')
I2=$(rep "$NS" "$(inc "$C_MED" no_harm none "$P1")" | jq -r '.id // empty')
I3=$(rep "$NS" "$(inc "$C_MED" near_miss none "$P1")" | jq -r '.id // empty')
I4=$(rep "$NS" "$(inc "$C_DOC" near_miss none "$P1")" | jq -r '.id // empty')
R=$(rep "$NS" "$(inc "$C_INFRA" hazard none | jq -c '.identity_mode="anonymous"')"); N5=$(echo "$R" | jq -r '.inc_no // empty')
I6=$(rep "$DR" "$(inc "$C_FALLD" harm severe "$P1" "$DB")" | jq -r '.id // empty')
I7=$(rep "$NS" "$(inc "$C_DOC" no_harm none "$P1")" | jq -r '.id // empty')
I8=$(rep "$NS" "$(inc "$C_DOC" no_harm none "$P1")" | jq -r '.id // empty')
I9=$(rep "$NS" "$(inc "$C_DOC" no_harm none "$P1" "$DA" "$D3AGO")" | jq -r '.id // empty')
I5=$(api GET "/quality/incidents?search=$N5" "$QM" | jq -r '.[0].id // empty')
for v in I1 I2 I3 I4 I5 I6 I7 I8 I9; do [ -n "${!v}" ] || die "ინციდენტი $v ვერ შეიქმნა"; done
chk "მომსახურების ტიპი: წყარო „ჰოსპიტალიზაცია“ → სტაციონარი; პაციენტი (სტაც. განყ.) → სტაციონარი; პაციენტის გარეშე („არავის“) → არაკლინიკური" \
  "$(api GET "/quality/incidents/$I1" "$QM" | jq -r .service_type):$(api GET "/quality/incidents/$I2" "$QM" | jq -r .service_type):$(api GET "/quality/incidents/$I5" "$QM" | jq -r .service_type)" "inpatient:inpatient:non_clinical"
acc() { api POST "/quality/incidents/$1/triage" "$QM" -d "{\"decision\":\"accept\",\"harm\":\"$2\",\"likelihood\":2,\"consequence\":2${3:-}}" | jq -r '.status // .code'; }
chk "ტრიაჟი: 7 მიღება (I1–I6, I9), I7 — უარყოფა, I8 — ტრიაჟს ელოდება" \
  "$(acc "$I1" mild):$(acc "$I2" none):$(acc "$I3" none):$(acc "$I4" none):$(acc "$I5" none):$(acc "$I6" death):$(acc "$I9" none):$(api POST "/quality/incidents/$I7/triage" "$QM" -d '{"decision":"reject","reject_reason":"not_incident","note":"ტესტ-E2E"}' | jq -r .status)" \
  "investigation:investigation:investigation:investigation:investigation:investigation:investigation:rejected"
chk "ტრიაჟზე მომსახურების ტიპის ველი: არასწორი მნიშვნელობა → 400" "$(code PATCH "/quality/incidents/$I4/classification" "$QM" -d '{"service_type":"spa","reason":"ტესტ-E2E"}')" "400"
chk "კლასიფიკაციის შესწორება: I4 → საოპერაციო (მიზეზით); რეესტრის ფილტრი service_type=or → I4" \
  "$(api PATCH "/quality/incidents/$I4/classification" "$QM" -d '{"service_type":"or","reason":"ტესტ-E2E: საოპერაციოში მოხდა"}' | jq -r .service_type):$(api GET "/quality/incidents?service_type=or&department_id=$DA" "$QM" | jq -r --arg i "$I4" '[.[].id]==[$i]')" "or:true"
sleep 3   # დაკავებული საწოლ-საათები > 0

step "3. გადათვლა → KPI = ანგარიში (განყოფილება A, დღეს)"
RUN=$(refresh "$D3" "$TODAY")
chk "გადათვლა: ok, ფაქტები quality > 0, quality_snapshot" "$(echo "$RUN" | jq -r '"\(.status):\(.facts.quality > 0):\(.facts|has("quality_snapshot"))"')" "ok:true:true"
OV=$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DA&compare=none&category=quality" "$RA")
chk "KPI (განყ. A): ინციდენტები 5, ზიანით 1, სენტინელური 0, near-miss თანაფარდობა 1, ტრიაჟი ვადაში 100" \
  "$(kv "$OV" qm_reported):$(kv "$OV" qm_harm):$(kv "$OV" qm_sentinel):$(kv "$OV" qm_near_miss_ratio):$(kv "$OV" qm_triage_on_time)" "5:1:0:1:100"
SM=$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY&department_id=$DA" "$QM")
chk "ანგარიში (QM): 5 = 1 ზიანით + 1 ზიანის გარეშე + 2 near-miss + 1 სახიფათო; ანონიმური 1; უარყოფილი / ტრიაჟამდე — არ ითვლება" \
  "$(echo "$SM" | jq -r '.totals|"\(.n):\(.harm):\(.no_harm):\(.near_miss):\(.hazard):\(.anonymous):\(.sentinel)"')" "5:1:1:2:1:1:0"
chk "ანგარიში = KPI: near-miss თანაფარდობა, შეტყობინება 1000 საწოლ-დღეზე, ტრიაჟი ვადაში" \
  "$(echo "$SM" | jq -r '.totals|"\(.near_miss_ratio):\(.report_rate):\(.triage_on_time_pct)"')" "$(kv "$OV" qm_near_miss_ratio):$(kv "$OV" qm_report_rate):$(kv "$OV" qm_triage_on_time)"
chk "ტრიაჟს ელოდება (მხოლოდ QM-ს): I8 — 1 (განყ. A)" "$(echo "$SM" | jq -r '.pending_triage.n')" "1"
chk "13 თვე: ბოლო თვე = მიმდინარე, ტიპებით ჯამი = ბოლო თვის სულ" \
  "$(echo "$SM" | jq -r '"\(.trend.months|length):\(.trend.months[-1]):\(([.trend.series[]|.[-1]]|add) == .trend.total[-1])"')" "13:${TODAY:0:7}:true"
SB=$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY&department_id=$DB" "$QM")
chk "განყ. B: სენტინელური 1 (= KPI qm_sentinel)" "$(echo "$SB" | jq -r .totals.sentinel):$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DB&compare=none&category=quality" "$RA")" qm_sentinel)" "1:1"
S3=$(api GET "/quality/reports/summary?from=$D3&to=$TODAY&department_id=$DA" "$QM")
chk "პერიოდი 3 დღე (მოვლენის თარიღით): + I9 → 6" "$(echo "$S3" | jq -r .totals.n)" "6"

step "4. განაწილება (pivot)"
DS=$(api GET "/quality/reports/distribution?from=$TODAY&to=$TODAY&department_id=$DA&rows=category&cols=harm" "$QM")
chk "კატეგორია × ზიანი: მედიკამენტი 2, დაცემა 1, დოკუმენტაცია 1, ინფრასტრუქტურა 1; სულ 5; უჯრები = მწკრივის ჯამი" \
  "$(echo "$DS" | jq -r '[.rows[]|{(.label):.total}]|add|"\(.["მედიკამენტი"]):\(.["დაცემა"]):\(.["დოკუმენტაცია / კომუნიკაცია"]):\(.["ინფრასტრუქტურა / გარემო"])"'):$(echo "$DS" | jq -r '"\(.total):\([range(0; .rows|length) as $i | (.cells[$i]|add) == .rows[$i].total]|all)"')" "2:1:1:1:5:true"
chk "ზიანის სვეტები ფიქსირებული რიგით (ზიანი არ არის → მსუბუქი)" "$(echo "$DS" | jq -r '[.cols[].key]|join(",")')" "none,mild"
DSV=$(api GET "/quality/reports/distribution?from=$TODAY&to=$TODAY&department_id=$DA&rows=service_type&cols=none" "$QM")
chk "მომსახურების ტიპით: სტაციონარი 3, საოპერაციო 1 (შესწორება), არაკლინიკური 1" "$(echo "$DSV" | jq -r '[.rows[]|"\(.key)=\(.total)"]|join(",")')" "inpatient=3,or=1,non_clinical=1"
chk "rows = cols / უცნობი განზომილება → 400" "$(code GET "/quality/reports/distribution?from=$TODAY&to=$TODAY&rows=harm&cols=harm" "$QM"):$(code GET "/quality/reports/distribution?from=$TODAY&to=$TODAY&rows=patient" "$QM")" "400:400"

step "5. ინდიკატორები 1000 საწოლ-დღეზე"
IN=$(api GET "/quality/reports/indicators?from=$TODAY&to=$TODAY&department_id=$DA" "$QM")
chk "seed: 3 ინდიკატორი; დაცემა — მრიცხველი 1, მედიკამენტი — 1 (near-miss არ ითვლება), ნაწოლი — 0" \
  "$(echo "$IN" | jq -r '[.rows[]|select(.code|test("^e2e")|not)]|"\(length):\(.[]|select(.code=="falls")|.numerator):\(.[]|select(.code=="medication")|.numerator):\(.[]|select(.code=="pressure_ulcer")|.numerator)"')" "3:1:1:0"
chk "მნიშვნელობა = მრიცხველი / საწოლ-დღე × 1000 (საწოლ-დღე > 0)" \
  "$(echo "$IN" | jq -r '.rows[]|select(.code=="falls")|"\(.denominator_value > 0):\((.numerator / .denominator_value * 1000) as $x | (.value - $x) * (.value - $x) <= (0.01 * $x) * (0.01 * $x))"')" "true:true"
chk "ინდიკატორი = დაფის KPI (qm_ind_falls, qm_ind_medication)" \
  "$(echo "$IN" | jq -r '[.rows[]|select(.code=="falls" or .code=="medication")|.value]|join(":")')" "$(kv "$OV" qm_ind_falls):$(kv "$OV" qm_ind_medication)"
chk "ცნობარი: ექთანი / განმხილველი → 403; უცნობი კატეგორია → 400; არსებული კოდი → 409" \
  "$(code POST /quality/indicators "$NS" -d '{}'):$(code POST /quality/indicators "$QD" -d '{}'):$(ecode POST /quality/indicators "$QM" -d '{"code":"e2e_bad","name":"ტესტ","category_ids":["00000000-0000-0000-0000-000000000000"]}'):$(code POST /quality/indicators "$QM" -d "{\"code\":\"falls\",\"name\":\"ტესტ\",\"category_ids\":[\"$C_FALL\"]}")" "403:403:CATEGORY:409"
NI=$(api POST /quality/indicators "$QM" -d "{\"code\":\"e2e_doc_$S\",\"name\":\"ტესტ-E2E დოკუმენტაცია\",\"category_ids\":[\"$C_DOC\"],\"event_types\":[\"harm\",\"no_harm\",\"near_miss\"],\"service_types\":[]}")
NID=$(echo "$NI" | jq -r '.id // empty')
chk "ახალი ინდიკატორი → KPI qm_ind_<code> (ჯგუფი quality, ↓); ყველა მომსახურება → მრიცხველი 1 (I4, საოპერაციო)" \
  "$(api GET /reporting/kpis "$ADM" | jq -r --arg c "qm_ind_e2e_doc_$S" '.[]|select(.code==$c)|"\(.category):\(.direction):\(.is_active)"'):$(api GET "/quality/reports/indicators?from=$TODAY&to=$TODAY&department_id=$DA" "$QM" | jq -r --arg c "e2e_doc_$S" '.rows[]|select(.code==$c)|.numerator')" "quality:down:true:1"
chk "ახალი ინდიკატორის KPI = ანგარიში (მაშინვე, გადათვლის გარეშე)" \
  "$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DA&compare=none&category=quality" "$RA")" "qm_ind_e2e_doc_$S")" \
  "$(api GET "/quality/reports/indicators?from=$TODAY&to=$TODAY&department_id=$DA" "$QM" | jq -r --arg c "e2e_doc_$S" '.rows[]|select(.code==$c)|.value')"
chk "გათიშვა (მიზეზით) → KPI გათიშულია, ანგარიშში აღარ ჩანს; მიზეზის გარეშე — 400; აუდიტი" \
  "$(code PATCH "/quality/indicators/$NID" "$QM" -d '{"is_active":false}'):$(api PATCH "/quality/indicators/$NID" "$QM" -d '{"is_active":false,"reason":"ტესტ-E2E"}' | jq -r .is_active):$(api GET /reporting/kpis "$ADM" | jq -r --arg c "qm_ind_e2e_doc_$S" '.[]|select(.code==$c)|.is_active'):$(api GET "/quality/reports/indicators?from=$TODAY&to=$TODAY" "$QM" | jq -r --arg c "e2e_doc_$S" '[.rows[]|select(.code==$c)]|length'):$(audit qm_indicators "$NID" QM_INDICATOR_UPDATE)" \
  "400:false:false:0:1"

step "6. ვადები / შესრულება, CAPA, ფაქტორები"
TL=$(api GET "/quality/reports/timeliness?from=$TODAY&to=$TODAY&department_id=$DA" "$QM")
chk "ვადები (განყ. A): 5 ინციდენტი, 5 ტრიაჟი, ვადაში 100% (= KPI), დახურული 0, მედიანა ≥ 0" \
  "$(echo "$TL" | jq -r '"\(.n):\(.triage.triaged):\(.triage.on_time_pct):\(.closure.closed):\(.triage.median_h >= 0)"')" "5:5:$(kv "$OV" qm_triage_on_time):0:true"
chk "ანალიზის დონე: მიმოხილვა + RCA = 5; განყოფილებების ცხრილი — 1 ხაზი" "$(echo "$TL" | jq -r '"\(.analysis.review.n + .analysis.rca.n):\(.by_department|length)"')" "5:1"
api PUT "/quality/incidents/$I1/analysis" "$QM" -d "{\"what_happened\":\"ტესტ-E2E: დაეცა\",\"root_cause\":\"ტესტ-E2E: ზარი შორს\",\"action_taken\":\"ტესტ-E2E: ზარი გადაიტანეს\",\"factors\":[{\"factor_id\":\"$(fid pf_condition)\"},{\"factor_id\":\"$(fid env_staffing)\"}]}" >/dev/null
chk "I1: ანალიზი (QM) → გაგზავნა = დამტკიცება (capa)" "$(api POST "/quality/incidents/$I1/analysis/submit" "$QM" -d '{}' | jq -r .status)" "capa"
FC=$(api GET "/quality/reports/factors?from=$TODAY&to=$TODAY&department_id=$DA" "$QM")
chk "ფაქტორები: 1 დამტკიცებული ანალიზი; „პაციენტის ფაქტორები“ 1 (100%), „სამუშაო გარემო“ 1; ფაქტორი „პერსონალის ნაკლებობა“ 1" \
  "$(echo "$FC" | jq -r '"\(.analyses):\(.groups[]|select(.name=="პაციენტის ფაქტორები")|"\(.n)/\(.pct)"):\(.groups[]|select(.name=="სამუშაო გარემო")|.n):\([.groups[].factors[]|select(.name=="პერსონალის ნაკლებობა")|.n][0])"')" "1:1/100:1:1"
C1=$(api POST /quality/capas "$QM" -d "$(jq -nc --arg o "$(uid 67)" --arg d "$D20" --arg dep "$DA" --arg i "$I1" '{title:"ტესტ-E2E ზარი საწოლთან",kind:"corrective",owner_id:$o,due_date:$d,department_id:$dep,incident_ids:[$i]}')" | jq -r '.id // empty')
[ -n "$C1" ] || die "CAPA ვერ შეიქმნა"
CP=$(api GET "/quality/reports/capa?from=$TODAY&to=$TODAY&department_id=$DA" "$QM")
chk "CAPA (განყ. A): ღია 1, შექმნილი 1 (მაკორექტირებელი), ვადაგადაცილებული 0" "$(echo "$CP" | jq -r '"\(.snapshot.open):\(.period.created):\(.period.corrective):\(.snapshot.overdue)"')" "1:1:1:0"
curl -s -X POST "$B/quality/capas/$C1/complete" -H "authorization: Bearer $QM" -F "note=ტესტ-E2E: ზარი გადატანილია" >/dev/null
api POST "/quality/capas/$C1/effectiveness" "$QM" -d '{"result":"effective","note":"ტესტ-E2E: დაცემა აღარ განმეორდა"}' >/dev/null
CP=$(api GET "/quality/reports/capa?from=$TODAY&to=$TODAY&department_id=$DA" "$QM")
chk "შესრულება + ეფექტიანობა: ღია 0, შესრულებული 1, ვადაში 100%, ეფექტიანი 100%" "$(echo "$CP" | jq -r '"\(.snapshot.open):\(.period.done):\(.period.on_time_pct):\(.period.effective_pct)"')" "0:1:100:100"
RUN=$(refresh "$TODAY" "$TODAY")
chk "ვადაგადაცილებული CAPA (მომენტალური KPI) = CAPA ანგარიში (კლინიკა)" \
  "$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=none&category=quality" "$RA")" qm_capa_overdue)" "$(api GET "/quality/reports/capa?from=$TODAY&to=$TODAY" "$QM" | jq -r .snapshot.overdue)"

step "7. ხედვა: quality_dept / quality_view / view_min_cell"
chk "ექთანი / დაფა (reports) → 403; quality_dept: მეტა dept, განყ. B → 403 OUT_OF_SCOPE" \
  "$(code GET "/quality/reports/summary?from=$TODAY&to=$TODAY" "$NS"):$(code GET "/quality/reports/meta" "$REP"):$(api GET /quality/reports/meta "$QD" | jq -r '"\(.access):\(.scope_all):\(.can_registry)"'):$(ecode GET "/quality/reports/summary?from=$TODAY&to=$TODAY&department_id=$DB" "$QD")" \
  "403:403:dept:false:false:OUT_OF_SCOPE"
chk "quality_dept (განყ. A) = QM-ის განყ. A; ტრიაჟს ელოდება — არ ჩანს" \
  "$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY" "$QD" | jq -r '"\(.totals.n):\(.pending_triage)"')" "5:null"
chk "quality_view (განყ. A): view, ჩაღრმავება არა; reports_all-ით — მთელი კლინიკა" \
  "$(api GET /quality/reports/meta "$QV" | jq -r '"\(.access):\(.can_drill):\(.scope_all)"'):$(api GET /quality/reports/meta "$QVA" | jq -r '"\(.access):\(.scope_all)"')" "view:false:false:view:true"
qmset '{"view_min_cell":3}' >/dev/null
SV=$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY" "$QV")
chk "view_min_cell = 3 → quality_view: 5 ჩანს, near-miss 2 / ზიანით 1 / ანონიმური 1 → „< 3“ (null), თანაფარდობა — null" \
  "$(echo "$SV" | jq -r '"\(.min_cell):\(.totals.n):\(.totals.near_miss):\(.totals.harm):\(.totals.anonymous):\(.totals.near_miss_ratio)"')" "3:5:null:null:null:null"
chk "იგივე QM-ს და quality_dept-ს — სრული რიცხვები; pivot (view): მცირე უჯრები null" \
  "$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY&department_id=$DA" "$QM" | jq -r .totals.near_miss):$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY" "$QD" | jq -r .totals.near_miss):$(api GET "/quality/reports/distribution?from=$TODAY&to=$TODAY&rows=category&cols=none" "$QV" | jq -r '[.cells[][]|select(. != null and . < 3)]|length')" "2:2:0"
qmset '{"view_min_cell":0}' >/dev/null

step "8. მენეჯერული დაფა: dashboard_visibility, „ყურადღება“"
chk "report_users: დაფის მომხმარებელი (reports, განყ. A) ხედავს ხარისხის KPI-ებს (11), ჩაღრმავება — 400" \
  "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=none&category=quality" "$REP" | jq -r '[.kpis[]|select(.code|test("^qm_ind_e2e")|not)]|length'):$(code GET "/reporting/drilldown?kpi=qm_reported&from=$TODAY&to=$TODAY" "$REP")" "11:400"
AT=$(api GET /reporting/attention "$RA")
chk "„ყურადღება“ (კლინიკა): სენტინელური ამ თვეში — წითელი, ბმულის გარეშე (არა ხარისხის მენეჯერი); განყ. A-ს მომხმარებელს — არა" \
  "$(echo "$AT" | jq -r '[.items[]|select(.kind=="qm_sentinel")][0]|"\(.severity):\(.value >= 1):\(has("link"))"'):$(api GET /reporting/attention "$REP" | jq -r '[.items[]|select(.kind=="qm_sentinel")]|length')" "red:true:false:0"
qmset '{"dashboard_visibility":"quality_only"}' >/dev/null
chk "quality_only: reports / reports_all — ხარისხის KPI და „ყურადღება“ ქრება; quality_view + reports_all — ჩანს" \
  "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=none&category=quality" "$REP" | jq -r '.kpis|length'):$(api GET /reporting/attention "$RA" | jq -r '[.items[]|select(.kind|startswith("qm_"))]|length'):$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=none&category=quality" "$QVA" | jq -r '[.kpis[]|select(.code|test("^qm_ind_e2e")|not)]|length')" "0:0:11"
qmset '{"dashboard_visibility":"report_users"}' >/dev/null

step "9. თვიური ანგარიში (0063): სექცია „ხარისხი“"
chk "Excel (reports_all): ფურცლები „ხარისხი — შეჯამება / კატეგორია × ზიანი / ინდიკატორები / ვადები / CAPA“" \
  "$(dl "/reporting/report?from=$MONTH&to=$TODAY&format=xlsx" "$RA" "$TMP/m1.xlsx"):$(sheets "$TMP/m1.xlsx" | tr '|' '\n' | grep -c '^ხარისხი — ')" "200:5"
chk "შეჯამების ფურცელში ხარისხის KPI-ები; PDF — 200" \
  "$(python3 - "$TMP/m1.xlsx" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); s = z.read('xl/sharedStrings.xml').decode('utf-8') if 'xl/sharedStrings.xml' in z.namelist() else ''.join(z.read(n).decode('utf-8') for n in z.namelist() if n.startswith('xl/worksheets/'))
print('ხარისხი და ინციდენტები' in s and 'near-miss თანაფარდობა' in s)
PY
):$(dl "/reporting/report?from=$MONTH&to=$TODAY&format=pdf" "$RA" "$TMP/m1.pdf")" "True:200"
qmset '{"monthly_section":false}' >/dev/null
chk "monthly_section = false → ხარისხის ფურცლები და KPI-ები ანგარიშში არ არის" \
  "$(dl "/reporting/report?from=$MONTH&to=$TODAY&format=xlsx" "$RA" "$TMP/m2.xlsx"):$(sheets "$TMP/m2.xlsx" | tr '|' '\n' | grep -c '^ხარისხი — ')" "200:0"
qmset '{"monthly_section":true}' >/dev/null

step "10. ექსპორტი, რეესტრი"
chk "Excel (QM): 9 ფურცელი (შეჯამება, ტრენდი, 3 განაწილება, ინდიკატორები, ვადები, CAPA, ფაქტორები)" "$(dl "/quality/reports/export?from=$TODAY&to=$TODAY&format=xlsx" "$QM" "$TMP/q.xlsx"):$(sheets "$TMP/q.xlsx" | tr '|' '\n' | wc -l)" "200:9"
chk "PDF (quality_view) — %PDF; CSV (distribution) — BOM; უცნობი ფორმატი / dataset → 400" \
  "$(dl "/quality/reports/export?from=$TODAY&to=$TODAY&format=pdf" "$QV" "$TMP/q.pdf"):$(head -c 4 "$TMP/q.pdf"):$(dl "/quality/reports/export?from=$TODAY&to=$TODAY&format=csv&dataset=distribution&rows=category&cols=harm" "$QM" "$TMP/q.csv"):$(head -c 3 "$TMP/q.csv" | od -An -tx1 | tr -d ' '):$(code GET "/quality/reports/export?from=$TODAY&to=$TODAY&format=doc" "$QM"):$(code GET "/quality/reports/export?from=$TODAY&to=$TODAY&format=csv&dataset=x" "$QM")" \
  "200:%PDF:200:efbbbf:400:400"
chk "აუდიტი: QM_REPORT_EXPORT (report, distribution)" "$(audit qm_reports report QM_REPORT_EXPORT | awk '{print ($1>=2)}'):$(audit qm_reports distribution QM_REPORT_EXPORT | awk '{print ($1>=1)}')" "1:1"
chk "რეესტრი (დეპერსონალიზებული): QM — 200 (xlsx / csv); quality_dept / quality_view — 403" \
  "$(dl "/quality/reports/registry?from=$D3&to=$TODAY&department_id=$DA&format=xlsx" "$QM" "$TMP/r.xlsx"):$(dl "/quality/reports/registry?from=$D3&to=$TODAY&department_id=$DA&format=csv" "$QM" "$TMP/r.csv"):$(code GET "/quality/reports/registry?from=$TODAY&to=$TODAY" "$QD"):$(code GET "/quality/reports/registry?from=$TODAY&to=$TODAY" "$QV")" "200:200:403:403"
chk "რეესტრი CSV: 6 ინციდენტი (უარყოფილი / ტრიაჟამდე — არა), პაციენტის სახელი / პირადი № / აღწერა — არ არის; აუდიტი" \
  "$(tail -n +3 "$TMP/r.csv" | grep -c '^INC'):$(grep -c 'QR-პაციენტი\|94'"$(printf '%09d' "$((10#$S))")"'\|ანგარიშის სატესტო' "$TMP/r.csv"):$(audit qm_incidents registry QM_REGISTRY_EXPORT | awk '{print ($1>=2)}')" "6:0:1"

step "11. report_date_basis"
qmset '{"report_date_basis":"reported"}' >/dev/null
refresh "$TODAY" "$TODAY" >/dev/null
chk "reported: I9 (მოვლენა 3 დღის წინ, შეტყობინება დღეს) ითვლება დღეს → 6 (KPI = ანგარიში)" \
  "$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY&department_id=$DA" "$QM" | jq -r .totals.n):$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DA&compare=none&category=quality" "$RA")" qm_reported)" "6:6"
qmset '{"report_date_basis":"occurred"}' >/dev/null
refresh "$TODAY" "$TODAY" >/dev/null
chk "occurred (აღდგა) → 5" "$(api GET "/quality/reports/summary?from=$TODAY&to=$TODAY&department_id=$DA" "$QM" | jq -r .totals.n)" "5"

step "12. მოდულის გამორთვა, აღდგენა"
api PUT /modules/quality "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთული: ანგარიშები / ინდიკატორები → 403 MODULE_DISABLED; დაფაზე ხარისხის KPI-ები არ ჩანს" \
  "$(ecode GET "/quality/reports/summary?from=$TODAY&to=$TODAY" "$QM"):$(ecode GET /quality/indicators "$QM"):$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=none&category=quality" "$RA" | jq -r '.kpis|length')" "MODULE_DISABLED:MODULE_DISABLED:0"
api PUT /modules/quality "$ADM" -d "{\"enabled\":$(echo "$O_QM" | jq .enabled),\"settings\":$(echo "$O_QM" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="quality")|{enabled, settings}' | jq -S -c .)" "$(echo "$O_QM" | jq -S -c .)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
