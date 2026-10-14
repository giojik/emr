#!/usr/bin/env bash
# =====================================================================
# e2e-reporting.sh — მენეჯერული რეპორტინგი (0060): აგრეგაცია, KPI-ები, ხედვის არე, სამიზნეები, ჩაღრმავება, ექსპორტი
#   ცალკე სატესტო განყოფილება (2 ჰოსპიტალიზაცია, საწოლი, დაბლოკილი საწოლი) — ზუსტი მნიშვნელობები;
#   დანარჩენი — შეჯერება არსებულ რეპორტებთან (ფინანსები, მარაგი, საოპერაციო) ერთსა და იმავე პერიოდზე.
#   bash scripts/e2e-reporting.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-reporting.sh
#   საჭიროა: jq, python3 (xlsx შემოწმება)
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
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(date +%F); YDAY=$(date -d "$TODAY -1 day" +%F); MONTH=$(date +%Y-%m-01)
# KPI-ის მნიშვნელობა მიმოხილვიდან: kv <json> <code>
kv() { echo "$1" | jq -r --arg c "$2" '.kpis[]|select(.code==$c)|.value'; }
# მომხმარებელი: mkuser <roles-json> <n> [extra-json-fields] → access token; id → $TMP/u<n>
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rpt.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"რეპ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rpt.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_rpt_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_rpt_$1_$S"; }; }
# გადათვლა და დალოდება: refresh <from> <to> → run json
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

step "0. მოდული, უფლებები, პარამეტრები"
chk "უფლებების კატალოგში 33 უფლება (0060: + reports, reports_all, reports_phi)" "$(api GET /roles/capabilities "$ADM" | jq length)" "33"
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
[ -n "$O_RPT" ] || die "მოდული reporting ვერ მოიძებნა"
chk "ნაგულისხმევი: 15 წთ, 02 სთ, 35 დღე, საათებით, 30 / 7 დღე" "$(echo "$O_RPT" | jq -r '.settings|"\(.refresh_today_min):\(.nightly_hour):\(.recompute_days):\(.occupancy_basis):\(.stock_days_window):\(.stock_days_alert)"')" "15:2:35:hours:30:7"
chk "არასწორი პარამეტრი (refresh_today_min=1 / occupancy_basis=x / უცნობი) → 400" \
  "$(code PUT /modules/reporting "$ADM" -d '{"settings":{"refresh_today_min":1},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"occupancy_basis":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"xx":1},"reason":"ტესტ-E2E"}')" "400:400:400"
api PUT /modules/reporting "$ADM" -d '{"enabled":true,"settings":{"occupancy_basis":"hours","compare_default":"prev","lab_tat_start":"collected","freeze_closed_periods":true},"reason":"ტესტ-E2E"}' >/dev/null
R_REP=$(mkrole rep "დაფა (განყ.)" '["reports"]'); R_ALL=$(mkrole all "დაფა (კლინიკა)" '["reports_all"]'); R_PHI=$(mkrole phi "დაფა + PHI" '["reports","reports_phi"]')
[ -n "$R_REP" ] && [ -n "$R_ALL" ] && [ -n "$R_PHI" ] && ok "სატესტო როლები: reports, reports_all, reports + reports_phi" || die "როლები ვერ შეიქმნა"

step "1. სატესტო განყოფილება: 2 ჰოსპიტალიზაცია, საწოლი, 2 დაბლოკილი საწოლი"
DR=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E რეპორტინგი $S\",\"code\":\"E2ERP$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DX=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E რეპორტინგი-2 $S\",\"code\":\"E2ERQ$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DR" ] && [ -n "$DX" ] || die "განყოფილებები ვერ შეიქმნა"
RC=$(mkuser '["receptionist"]' 61); NR=$(mkuser '["nurse"]' 62 ",\"department_id\":\"$DR\"");
HN=$(mkuser '["nurse"]' 64 ",\"department_id\":\"$DR\",\"is_section_head\":true")
DOC=$(mkuser '["doctor"]' 65 ",\"department_id\":\"$DR\""); DOCID=$(cat "$TMP/u65" 2>/dev/null)
T_REP=$(mkuser "[\"$R_REP\"]" 66 ",\"department_id\":\"$DR\""); U_REP=$(cat "$TMP/u66" 2>/dev/null)
T_NOD=$(mkuser "[\"$R_REP\"]" 67); U_NOD=$(cat "$TMP/u67" 2>/dev/null)
T_ALL=$(mkuser "[\"$R_ALL\"]" 68)
T_PHI=$(mkuser "[\"$R_PHI\"]" 69 ",\"department_id\":\"$DR\"")
[ -n "$RC" ] && [ -n "$NR" ] && [ -n "$HN" ] && [ -n "$DOC" ] && [ -n "$T_REP" ] && [ -n "$T_NOD" ] && [ -n "$T_ALL" ] && [ -n "$T_PHI" ] && ok "მომხმარებლები: რეგისტრატორი, ექთანი, ხელმძღვანელი ექთანი, ექიმი, 4 დაფის მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
W=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DR\",\"code\":\"R$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BD=$(api POST "/inpatient/wards/$W/beds" "$ADM" -d '{"count":3}'); B1=$(echo "$BD" | jq -r '.[0].id'); B2=$(echo "$BD" | jq -r '.[1].id'); B3=$(echo "$BD" | jq -r '.[2].id')
[ -n "$W" ] && [ "$B3" != "null" ] || die "პალატა / საწოლები ვერ შეიქმნა"
# საწოლები 2 და 3 — მაშინვე დაბლოკილი: ხელმისაწვდომია მხოლოდ საწოლი 1 (დაბლოკილი მნიშვნელში რომ ითვლებოდეს, დატვირთვა ≤ 1/3 იქნებოდა)
chk "საწოლები 2, 3 — დაბლოკილი (ხელმძღვანელი ექთანი)" "$(api POST "/inpatient/beds/$B2/block" "$HN" -d '{"reason":"ტესტ-E2E რემონტი"}' | jq -r .status):$(api POST "/inpatient/beds/$B3/block" "$HN" -d '{"reason":"ტესტ-E2E რემონტი"}' | jq -r .status)" "blocked:blocked"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1970-04-04\",\"gender\":\"male\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 51 "რეპ-ერთი"); P2=$(mkpat 52 "რეპ-ორი"); PN1="51$(printf '%09d' "$S")"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DR\",\"attending_doctor_id\":\"$DOCID\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "2 ჰოსპიტალიზაცია" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
chk "საწოლის მინიჭება (E1 → საწოლი 1)" "$(api POST "/inpatient/stays/$E1/bed" "$NR" -d "{\"bed_id\":\"$B1\"}" | jq -r '.bed != null')" "true"
sleep 12   # დაკავებული საათები > ხელმისაწვდომის ნახევარი (საწოლი 1)

step "2. გადათვლა"
chk "არა-admin გადათვლას ვერ იწყებს (403)" "$(code POST /reporting/refresh "$T_ALL" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}")" "403"
chk "from > to / მომავალი / 400 დღეზე მეტი → 400" "$(code POST /reporting/refresh "$ADM" -d "{\"from\":\"$TODAY\",\"to\":\"$YDAY\"}"):$(code POST /reporting/refresh "$ADM" -d '{"from":"2099-01-01","to":"2099-01-02"}'):$(code POST /reporting/refresh "$ADM" -d "{\"from\":\"2020-01-01\",\"to\":\"$TODAY\"}")" "400:400:400"
RUN=$(refresh "$MONTH" "$TODAY")
chk "გადათვლა: შესრულდა (ok), ფაქტები (flow / beds / stock_snapshot)" "$(echo "$RUN" | jq -r '"\(.status):\(.facts.flow > 0):\(.facts.beds > 0):\(.facts|has("stock_snapshot"))"')" "ok:true:true:true"
chk "ჟურნალი: ბოლო — ხელით, ავტორი, ხანგრძლივობა" "$(api GET '/reporting/runs?limit=1' "$ADM" | jq -r '.rows[0]|"\(.kind):\(.requested_by != null):\(.duration_ms >= 0)"')" "manual:true:true"
chk "აუდიტი: REPORT_REFRESH" "$(api GET "/audit-logs?entity_name=rpt_refresh_runs&entity_id=$(echo "$RUN" | jq -r .id)&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_REFRESH") != null')" "true"

step "3. სატესტო განყოფილება — ზუსტი მნიშვნელობები"
OD=$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DR&compare=none" "$ADM")
chk "ჰოსპიტალიზაცია 2, ვიზიტები 2, ახალი პაციენტი 2, გაწერა 0" "$(kv "$OD" admissions):$(kv "$OD" enc_total):$(kv "$OD" new_patients):$(kv "$OD" discharges)" "2:2:2:0"
chk "დატვირთვა: მნიშვნელობა არის (> 0), ALOS — null (გაწერა არ არის)" "$(echo "$OD" | jq -r '.kpis[]|select(.code=="occupancy_pct")|.value > 0'):$(kv "$OD" alos)" "true:null"
chk "საწოლის სტატუსის ისტორია: დაბლოკილი მნიშვნელში არ ითვლება (დატვირთვა > 50%, 3-ვე საწოლით იქნებოდა ≤ 33%)" "$(echo "$OD" | jq -r '.kpis[]|select(.code=="occupancy_pct")|.value > 50 and .value <= 100')" "true"
chk "მიმოხილვა: პერიოდი, შედარების გარეშე, მონაცემების დრო" "$(echo "$OD" | jq -r '"\(.from):\(.compare):\(.data_as_of != null)"')" "$TODAY:null:true"

DD=$(api GET "/reporting/drilldown?kpi=admissions&from=$TODAY&to=$TODAY&department_id=$DR" "$ADM")
chk "ჩაღრმავება (admin): 2 ხაზი, პირადი № სვეტი, სახელი" "$(echo "$DD" | jq -r --arg p "$PN1" '"\(.rows|length):\(.phi):\(.columns|index("პირადი №") != null):\([.rows[]|select(.[7]==$p)]|length)"')" "2:true:true:1"

step "4. ხედვის არე"
chk "ექთანი → 403; განყოფილების გარეშე (reports) → 403 NO_SCOPE" "$(code GET "/reporting/overview?from=$TODAY&to=$TODAY" "$NR"):$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$T_NOD" | jq -r .code)" "403:NO_SCOPE"
MR=$(api GET /reporting/meta "$T_REP")
chk "reports: არე — 1 განყოფილება (თავისი), კლინიკა — არა, PHI — არა" "$(echo "$MR" | jq -r '"\(.scope.all):\(.scope.departments|length):\(.scope.departments[0].id):\(.scope.phi)"')" "false:1:$DR:false"
chk "reports: სხვა განყოფილება → 403 OUT_OF_SCOPE" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DX" "$T_REP" | jq -r .code)" "OUT_OF_SCOPE"
OR=$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=none" "$T_REP")
chk "reports (განყოფილების ფილტრის გარეშე) = თავისი განყოფილება: 2 ჰოსპიტალიზაცია" "$(kv "$OR" admissions):$(echo "$OR" | jq -r .scope_all)" "2:false"
chk "განყოფილებებით (reports): მხოლოდ თავისი" "$(api GET "/reporting/by-department?kpi=admissions&from=$TODAY&to=$TODAY" "$T_REP" | jq -r '"\(.rows|length):\(.rows[0].department_id):\(.total)"')" "1:$DR:2"
DDR=$(api GET "/reporting/drilldown?kpi=admissions&from=$TODAY&to=$TODAY" "$T_REP")
chk "ჩაღრმავება (reports, PHI-ს გარეშე): ინიციალები, პირადი № სვეტი არ არის" "$(echo "$DDR" | jq -r '"\(.rows|length):\(.phi):\(.columns|index("პირადი №")):\(.rows[0][6]|test("^.\\. .\\.$"))"')" "2:false:null:true"
chk "ჩაღრმავება (reports + reports_phi): სრული სახელი, პირადი №" "$(api GET "/reporting/drilldown?kpi=admissions&from=$TODAY&to=$TODAY" "$T_PHI" | jq -r '"\(.phi):\(.columns|length)"')" "true:8"
chk "ხედვის არე: admin-ის გარდა არავინ ცვლის (403); არარსებული განყოფილება → 400" "$(code PUT "/reporting/scopes/$U_NOD" "$T_ALL" -d "{\"department_ids\":[\"$DX\"],\"reason\":\"ტესტ-E2E\"}"):$(code PUT "/reporting/scopes/$U_NOD" "$ADM" -d '{"department_ids":["00000000-0000-0000-0000-000000000001"],"reason":"ტესტ-E2E"}')" "403:400"
chk "ხედვის არე: მომხმარებელს განყოფილების გარეშე + 2 განყოფილება" "$(api PUT "/reporting/scopes/$U_NOD" "$ADM" -d "{\"department_ids\":[\"$DR\",\"$DX\"],\"reason\":\"ტესტ-E2E\"}" | jq -r '"\(.departments|length):\(.effective|length)"')" "2:2"
chk "ახლა ხედავს: 2 განყოფილება, ჯამი 2 ჰოსპიტალიზაცია; ერთი განყოფილება (DX) — 0" "$(api GET /reporting/meta "$T_NOD" | jq -r '.scope.departments|length'):$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$T_NOD")" admissions):$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DX" "$T_NOD")" admissions)" "2:2:0"
chk "ხედვის არის სია (admin): მომხმარებელი, ძირითადი განყოფილება, მთელი კლინიკა (reports_all)" "$(api GET /reporting/scopes "$ADM" | jq -r --arg a "$U_REP" '.[]|select(.id==$a)|"\(.all):\(.primary_department.id)"'):$(api GET /reporting/scopes "$ADM" | jq -r --arg a "$(cat "$TMP/u68")" '.[]|select(.id==$a)|.all')" "false:$DR:true"
chk "აუდიტი: RPT_SCOPE_UPDATE" "$(api GET "/audit-logs?entity_name=users&entity_id=$U_NOD&limit=10" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("RPT_SCOPE_UPDATE") != null')" "true"
MA=$(api GET /reporting/meta "$T_ALL")
chk "reports_all: მთელი კლინიკა, ფინანსური KPI-ები ჩანს, კონფიგურაცია — კი" "$(echo "$MA" | jq -r '"\(.scope.all):\(.scope.finance):\([.kpis[]|select(.category=="finance")]|length > 0):\(.can_configure):\(.can_refresh)"')" "true:true:true:true:false"
O_FIN=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings')
api PUT /modules/finance "$ADM" -d '{"settings":{"dept_finance_visible":"off"},"reason":"ტესტ-E2E"}' >/dev/null
chk "dept_finance_visible = off → reports (განყ.) ფინანსურ KPI-ს ვერ ხედავს; reports_all — ხედავს" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$T_REP" | jq -r '[.kpis[]|select(.category=="finance")]|length'):$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$T_ALL" | jq -r '[.kpis[]|select(.category=="finance")]|length > 0')" "0:true"
chk "ფინანსური KPI დამალულზე: მწკრივი → 404" "$(code GET "/reporting/series?kpi=rev_net&from=$TODAY&to=$TODAY" "$T_REP")" "404"
api PUT /modules/finance "$ADM" -d "{\"settings\":$O_FIN,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "dept_finance_visible = heads (აღდგა) → ჩანს" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$T_REP" | jq -r '[.kpis[]|select(.category=="finance")]|length > 0')" "true"

step "5. შეჯერება არსებულ რეპორტებთან (მთელი კლინიკა, $MONTH — $TODAY)"
OA=$(api GET "/reporting/overview?from=$MONTH&to=$TODAY&compare=prev" "$ADM")
REV=$(api GET "/finance/revenue?from=$MONTH&to=$TODAY" "$ADM"); DRES=$(api GET "/finance/dept-result?from=$MONTH&to=$TODAY" "$ADM"); CONS=$(api GET "/finance/stock/consumption?from=$MONTH&to=$TODAY" "$ADM")
eqn() { python3 -c "import sys; a,b=sys.argv[1],sys.argv[2]; print('eq' if a==b or (a not in ('null','') and b not in ('null','') and abs(float(a)-float(b))<0.011) else f'{a}≠{b}')" "$1" "$2"; }
chk "შემოსავალი (წმინდა) = ფინანსები → შემოსავალი (net)" "$(eqn "$(kv "$OA" rev_net)" "$(echo "$REV" | jq -r .totals.net)")" "eq"
chk "ხარჯი = განყოფილების შედეგი (მარაგი + ხარჯები); შედეგი = result" "$(eqn "$(kv "$OA" costs_total)" "$(echo "$DRES" | jq -r '.totals.stock_cost + .totals.expenses')"):$(eqn "$(kv "$OA" result)" "$(echo "$DRES" | jq -r '.totals.revenue_net - .totals.stock_cost - .totals.expenses')")" "eq:eq"
chk "სახელმწიფოს წილი % = state / net" "$(eqn "$(kv "$OA" rev_state_pct)" "$(echo "$REV" | jq -r 'if .totals.net > 0 then (.totals.state / .totals.net * 1000 | round / 10) else null end')")" "eq"
chk "მარაგის ხარჯი / დანაკარგი = ფინანსები → მარაგი" "$(eqn "$(kv "$OA" stock_consumption)" "$(echo "$CONS" | jq -r .totals.consumption)"):$(eqn "$(kv "$OA" stock_loss)" "$(echo "$CONS" | jq -r .totals.loss)")" "eq:eq"
ORS=$(api GET "/or/stats?from=$MONTH&to=$TODAY" "$ADM")
chk "საოპერაციო: ოპერაციები, დატვირთვა %, პირველი დროული %, გაუქმება % = or/stats" \
  "$(eqn "$(kv "$OA" or_cases)" "$(echo "$ORS" | jq -r .totals.completed)"):$(eqn "$(kv "$OA" or_utilization_pct)" "$(echo "$ORS" | jq -r .utilization.utilization_pct)"):$(eqn "$(kv "$OA" or_first_on_time_pct)" "$(echo "$ORS" | jq -r .first_case.on_time_pct)"):$(eqn "$(kv "$OA" or_cancel_pct)" "$(echo "$ORS" | jq -r .cancellations.cancel_pct)")" "eq:eq:eq:eq"
chk "საოპერაციო: საშუალო ხანგრძლივობა = or/stats avg_surgery_min" "$(eqn "$(kv "$OA" or_surgery_min_avg)" "$(echo "$ORS" | jq -r .totals.avg_surgery_min)")" "eq"
BYD=$(api GET "/reporting/by-department?kpi=enc_total&from=$MONTH&to=$TODAY" "$ADM")
chk "განყოფილებებით: ჯამი = მიმოხილვის მნიშვნელობა (ვიზიტები)" "$(eqn "$(echo "$BYD" | jq -r '[.rows[].value]|add')" "$(kv "$OA" enc_total)"):$(eqn "$(echo "$BYD" | jq -r .total)" "$(kv "$OA" enc_total)")" "eq:eq"
SR=$(api GET "/reporting/series?kpi=enc_total&from=$MONTH&to=$TODAY&grain=day" "$ADM")
chk "დღიური მწკრივი: დღეების რაოდენობა, ჯამი = პერიოდის მნიშვნელობა" "$(echo "$SR" | jq -r '.points|length'):$(eqn "$(echo "$SR" | jq -r '[.points[].value]|add')" "$(kv "$OA" enc_total)")" "$(( ( $(date -d "$TODAY" +%s) - $(date -d "$MONTH" +%s) ) / 86400 + 1 )):eq"
chk "თვიური / კვირის მწკრივი; grain=x → 400; მომენტალური KPI-ს მწკრივი → 400" "$(api GET "/reporting/series?kpi=enc_total&from=$MONTH&to=$TODAY&grain=month" "$ADM" | jq -r '.points|length'):$(api GET "/reporting/series?kpi=enc_total&from=$MONTH&to=$TODAY&grain=week" "$ADM" | jq -r '.points[0].from'):$(code GET "/reporting/series?kpi=enc_total&from=$MONTH&to=$TODAY&grain=x" "$ADM"):$(code GET "/reporting/series?kpi=stock_low_items&from=$MONTH&to=$TODAY" "$ADM")" "1:$MONTH:400:400"
DE=$(api GET "/reporting/drilldown?kpi=enc_total&from=$MONTH&to=$TODAY" "$ADM")
chk "ჩაღრმავება: ხაზები = KPI (ვიზიტები, ≤ 2000)" "$(eqn "$(echo "$DE" | jq -r 'if .truncated then "trunc" else (.rows|length) end')" "$(kv "$OA" enc_total)")" "eq"
chk "აუდიტი: REPORT_DRILLDOWN" "$(api GET "/audit-logs?entity_name=rpt_kpis&entity_id=enc_total&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_DRILLDOWN") != null')" "true"
chk "ჩაღრმავება: KPI-ს გარეშე → 400; ჩაღრმავების გარეშე KPI (alos) → 400; უცნობი → 404" "$(code GET "/reporting/drilldown?from=$TODAY&to=$TODAY" "$ADM"):$(code GET "/reporting/drilldown?kpi=alos&from=$TODAY&to=$TODAY" "$ADM"):$(code GET "/reporting/drilldown?kpi=xx&from=$TODAY&to=$TODAY" "$ADM")" "400:400:404"
chk "შედარება prev: წინა პერიოდი იმავე სიგრძის" "$(echo "$OA" | jq -r '.compare|"\(.mode):\(.to)"')" "prev:$(date -d "$MONTH -1 day" +%F)"
chk "შედარება yoy: შარშან იგივე თარიღები" "$(api GET "/reporting/overview?from=$MONTH&to=$TODAY&compare=yoy" "$ADM" | jq -r '.compare.from')" "$(date -d "$MONTH -1 year" +%F)"
chk "პერიოდი: from > to / არასწორი თარიღი / compare=x → 400" "$(code GET "/reporting/overview?from=$TODAY&to=$YDAY" "$ADM"):$(code GET "/reporting/overview?from=x&to=$TODAY" "$ADM"):$(code GET "/reporting/overview?from=$TODAY&to=$TODAY&compare=x" "$ADM")" "400:400:400"
SD=$(api GET "/reporting/stock-days" "$ADM"); SDL=$(api GET "/reporting/stock-days?only_low=true" "$ADM")
chk "მარაგის დღეები: სურათი (computed_at), დაბალი ფილტრი — ყველა low, = KPI stock_low_items" "$(echo "$SD" | jq -r '.computed_at != null'):$(echo "$SDL" | jq -r '[.rows[]|select(.low|not)]|length'):$(eqn "$(echo "$SDL" | jq -r '.rows|length')" "$(kv "$OA" stock_low_items)")" "true:0:eq"
chk "მარაგის დღეები (reports): მხოლოდ თავისი განყოფილების ლოკაციები" "$(api GET "/reporting/stock-days" "$T_REP" | jq -r '[.rows[]|select(.department_name != null and (.department_name|test("რეპორტინგი") | not))]|length')" "0"

step "6. KPI ცნობარი და სამიზნეები"
chk "ცნობარი: 41 KPI, ყველას განმარტება / ფორმულა / წყარო" "$(api GET /reporting/kpis "$ADM" | jq -r '"\(length):\([.[]|select((.definition|length)>3 and (.formula|length)>3 and (.source|length)>2)]|length)"')" "41:41"
chk "reports (განყ.) ცნობარს ვერ ცვლის (403); მიზეზის გარეშე → 400" "$(code PATCH /reporting/kpis/enc_total "$T_REP" -d '{"name":"x","reason":"ტესტ-E2E"}'):$(code PATCH /reporting/kpis/enc_total "$ADM" -d '{"name":"x y"}')" "403:400"
chk "გადარქმევა + დამალვა (reports_all) → მიმოხილვაში არ ჩანს" "$(api PATCH /reporting/kpis/enc_emergency "$T_ALL" -d '{"name":"ტესტ-E2E გადაუდებელი","is_active":false,"reason":"ტესტ-E2E"}' | jq -r '"\(.name):\(.is_active)"'):$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$ADM" | jq -r '[.kpis[]|select(.code=="enc_emergency")]|length')" "ტესტ-E2E გადაუდებელი:false:0"
api PATCH /reporting/kpis/enc_emergency "$ADM" -d '{"name":"გადაუდებელი შემთხვევები","is_active":true,"reason":"ტესტ-E2E აღდგენა"}' >/dev/null
chk "აუდიტი: RPT_KPI_UPDATE" "$(api GET "/audit-logs?entity_name=rpt_kpis&entity_id=enc_emergency&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("RPT_KPI_UPDATE") != null')" "true"
O_TG=$(api GET /reporting/kpis "$ADM" | jq -c '[.[]|select(.code=="admissions" or .code=="occupancy_pct" or .code=="alos")|{code, targets:[.targets[]|{department_id,target,warn,note}]}]')
chk "სამიზნე: მიმართულების გარეშე KPI → 400; up-ზე warn > target → 400; ერთი განყოფილება ორჯერ → 400" \
  "$(code PUT /reporting/kpis/admissions/targets "$ADM" -d '{"targets":[{"target":1}],"reason":"ტესტ-E2E"}'):$(code PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d '{"targets":[{"target":80,"warn":90}],"reason":"ტესტ-E2E"}'):$(code PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d '{"targets":[{"target":80},{"target":70}],"reason":"ტესტ-E2E"}')" "400:400:400"
OCC=$(kv "$OD" occupancy_pct)
T_G=$(python3 -c "print(round(float('$OCC')-1, 2))"); T_Y=$(python3 -c "print(round(float('$OCC')+10, 2))"); W_Y=$(python3 -c "print(round(float('$OCC')-5, 2))")
api PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d "{\"targets\":[{\"target\":$T_G}],\"reason\":\"ტესტ-E2E\"}" >/dev/null
chk "სამიზნე (კლინიკა) დატვირთვა ≤ მნიშვნელობა → მწვანე" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DR&compare=none" "$ADM" | jq -r '.kpis[]|select(.code=="occupancy_pct")|"\(.status):\(.target_level)"')" "green:clinic"
api PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d "{\"targets\":[{\"target\":$T_G},{\"department_id\":\"$DR\",\"target\":$T_Y,\"warn\":$W_Y,\"note\":\"ტესტ-E2E\"}],\"reason\":\"ტესტ-E2E\"}" >/dev/null
chk "განყოფილების სამიზნე (მეტი, warn ქვემოთ) → ყვითელი, დონე: განყოფილება" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DR&compare=none" "$ADM" | jq -r '.kpis[]|select(.code=="occupancy_pct")|"\(.status):\(.target_level)"')" "yellow:department"
api PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d "{\"targets\":[{\"department_id\":\"$DR\",\"target\":$T_Y}],\"reason\":\"ტესტ-E2E\"}" >/dev/null
chk "warn-ის გარეშე → წითელი; by-department — სტატუსით" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DR&compare=none" "$ADM" | jq -r '.kpis[]|select(.code=="occupancy_pct")|.status'):$(api GET "/reporting/by-department?kpi=occupancy_pct&from=$TODAY&to=$TODAY" "$ADM" | jq -r --arg d "$DR" '.rows[]|select(.department_id==$d)|.status')" "red:red"
api PUT /reporting/kpis/alos/targets "$ADM" -d '{"targets":[{"target":5,"warn":7}],"reason":"ტესტ-E2E"}' >/dev/null
chk "down მიმართულება: ALOS სამიზნე 5 / 7 (null მნიშვნელობაზე სტატუსი არ არის)" "$(api GET /reporting/kpis "$ADM" | jq -r '.[]|select(.code=="alos")|.targets[0]|"\(.target):\(.warn)"'):$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DR" "$ADM" | jq -r '.kpis[]|select(.code=="alos")|.status')" "5:7:null"
for c in occupancy_pct alos; do api PUT "/reporting/kpis/$c/targets" "$ADM" -d "{\"targets\":$(echo "$O_TG" | jq -c --arg c "$c" '.[]|select(.code==$c)|.targets'),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null; done

step "7. ექსპორტი"
curl -s -D "$TMP/h1" -o "$TMP/o.xlsx" "$B/reporting/export?dataset=overview&format=xlsx&from=$MONTH&to=$TODAY" -H "authorization: Bearer $ADM"
XL=$(python3 - "$TMP/o.xlsx" <<'PY'
import sys, zipfile, re
z = zipfile.ZipFile(sys.argv[1]); s = z.read('xl/worksheets/sheet1.xml').decode()
print(f"{len(re.findall(r'<row ', s))}:{'occupancy_pct' in s}:{'სამიზნე' in s}")
PY
)
chk "xlsx: სათაური + 41 ხაზი, KPI კოდი, სვეტები" "$XL" "42:True:True"
chk "xlsx: Content-Type / ფაილის სახელი" "$(grep -ci 'spreadsheetml' "$TMP/h1"):$(grep -i 'content-disposition' "$TMP/h1" | grep -c 'rpt_overview')" "1:1"
curl -s -o "$TMP/s.csv" "$B/reporting/export?dataset=series&format=csv&kpi=enc_total&grain=day&from=$MONTH&to=$TODAY" -H "authorization: Bearer $ADM"
chk "csv: UTF-8 BOM, სათაური, დღეების ხაზები" "$(head -c 3 "$TMP/s.csv" | od -An -tx1 | tr -d ' '):$(( $(wc -l < "$TMP/s.csv") ))" "efbbbf:$(( ( $(date -d "$TODAY" +%s) - $(date -d "$MONTH" +%s) ) / 86400 + 2 ))"
curl -s -o "$TMP/d.csv" "$B/reporting/export?dataset=drilldown&format=csv&kpi=admissions&from=$TODAY&to=$TODAY" -H "authorization: Bearer $T_REP"
chk "ჩაღრმავების ექსპორტი (reports, PHI-ს გარეშე): პირადი ნომერი ფაილში არ არის" "$(grep -c "$PN1" "$TMP/d.csv"):$(grep -c 'ტესტ-E2E რეპ-ერთი' "$TMP/d.csv")" "0:0"
curl -s -o "$TMP/d2.csv" "$B/reporting/export?dataset=drilldown&format=csv&kpi=admissions&from=$TODAY&to=$TODAY" -H "authorization: Bearer $T_PHI"
chk "ჩაღრმავების ექსპორტი (reports_phi): პირადი ნომერი არის" "$(grep -c "$PN1" "$TMP/d2.csv")" "1"
chk "by_department / stock_days xlsx — 200" "$(code GET "/reporting/export?dataset=by_department&kpi=admissions&from=$MONTH&to=$TODAY" "$ADM"):$(code GET "/reporting/export?dataset=stock_days&format=xlsx" "$ADM")" "200:200"
chk "უცნობი dataset / format → 400; ექთანი → 403" "$(code GET "/reporting/export?dataset=x" "$ADM"):$(code GET "/reporting/export?dataset=overview&format=pdf&from=$TODAY&to=$TODAY" "$ADM"):$(code GET "/reporting/export?dataset=overview&from=$TODAY&to=$TODAY" "$NR")" "400:400:403"
chk "აუდიტი: REPORT_EXPORT (phi = false / true)" "$(api GET "/audit-logs?entity_name=rpt_reports&entity_id=drilldown&limit=10" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|select(.action=="REPORT_EXPORT")|.new_data.phi]|"\(index(false) != null):\(index(true) != null)"')" "true:true"

step "8. მოდულის გათიშვა"
api PUT /modules/reporting "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთული მოდული → 403 MODULE_DISABLED (მიმოხილვა, გადათვლა)" "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY" "$ADM" | jq -r .code):$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" | jq -r .code)" "MODULE_DISABLED:MODULE_DISABLED"

step "9. აღდგენა"
api PUT /modules/reporting "$ADM" -d "{\"enabled\":$(echo "$O_RPT" | jq -c .enabled),\"settings\":$(echo "$O_RPT" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api POST "/inpatient/beds/$B2/unblock" "$HN" >/dev/null; api POST "/inpatient/beds/$B3/unblock" "$HN" >/dev/null
for e in "$E1" "$E2"; do api POST "/inpatient/stays/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
api PUT "/reporting/scopes/$U_NOD" "$ADM" -d '{"department_ids":[],"reason":"ტესტ-E2E აღდგენა"}' >/dev/null
while read -r u; do api PATCH "/users/$u" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/users"
while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
RUN2=$(refresh "$TODAY" "$TODAY")
chk "მოდული აღდგა; გაუქმებული ჰოსპიტალიზაცია გადათვლის შემდეგ აღარ ითვლება" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}' | jq -S -c . ):$(kv "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DR&compare=none" "$ADM")" admissions)" "$(echo "$O_RPT" | jq -S -c .):0"
api PATCH "/departments/$DR" "$ADM" -d '{"is_active":false}' >/dev/null; api PATCH "/departments/$DX" "$ADM" -d '{"is_active":false}' >/dev/null

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
