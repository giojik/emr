#!/usr/bin/env bash
# =====================================================================
# e2e-reporting-dash.sh — თემატური დაფები (0061): ძირითადი KPI-ები, ტრენდი, „ახლა“, „ყურადღება“, დაფების კონფიგურაცია
#   ცალკე სატესტო განყოფილება (3 საწოლი: დაკავებული / დაბლოკილი / თავისუფალი; პაციენტი საწოლის გარეშე) — ზუსტი „ახლა“ მნიშვნელობები.
#   bash scripts/e2e-reporting-dash.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-reporting-dash.sh
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
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(date +%F); MONTH=$(date +%Y-%m-01)
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rdash.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"დაფა-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rdash.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_rdash_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_rdash_$1_$S"; }; }
refresh() {
  local R id st i; for i in $(seq 1 60); do [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; sleep 1; done
  R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty'); [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 120); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}

step "0. პარამეტრები"
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
[ -n "$O_RPT" ] || die "მოდული reporting ვერ მოიძებნა"
chk "ახალი ნაგულისხმევი: lab 120 წთ, კვლევა 24 სთ, მოძრაობის გარეშე 90 დღე, TV 5 წთ" "$(echo "$O_RPT" | jq -r '.settings|"\(.lab_overdue_min):\(.dx_overdue_hours):\(.dead_stock_days):\(.tv_refresh_min)"')" "120:24:90:5"
chk "ვალიდაცია: lab_overdue_min=5 / dx_overdue_hours=0 / dead_stock_days=10 / tv_refresh_min=61 → 400" \
  "$(code PUT /modules/reporting "$ADM" -d '{"settings":{"lab_overdue_min":5},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"dx_overdue_hours":0},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"dead_stock_days":10},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"tv_refresh_min":61},"reason":"ტესტ-E2E"}')" "400:400:400:400"
api PUT /modules/reporting "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "meta: ახალი პარამეტრები ჩანს" "$(api GET /reporting/meta "$ADM" | jq -r '.settings|"\(.tv_refresh_min):\(.lab_overdue_min)"')" "5:120"

step "1. დაფების კონფიგურაცია"
O_DASH=$(api GET /reporting/dashboards "$ADM")
chk "ნაგულისხმევი: ხელმძღვანელობა 8 (ვიზიტები … მარჟა), განყოფილება 8" "$(echo "$O_DASH" | jq -r '"\(.executive|length):\(.executive[0].code):\(.executive[7].code):\(.department|length)"')" "8:enc_total:margin_pct:8"
R_REP=$(mkrole rep "დაფა (განყ.)" '["reports"]'); R_ALL=$(mkrole all "დაფა (კლინიკა)" '["reports_all"]')
[ -n "$R_REP" ] && [ -n "$R_ALL" ] || die "როლები ვერ შეიქმნა"
DR=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E დაფა $S\",\"code\":\"E2ERD$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DX=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E დაფა-2 $S\",\"code\":\"E2ERE$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DR" ] && [ -n "$DX" ] || die "განყოფილებები ვერ შეიქმნა"
RC=$(mkuser '["receptionist"]' 41); NR=$(mkuser '["nurse"]' 42 ",\"department_id\":\"$DR\""); HN=$(mkuser '["nurse"]' 43 ",\"department_id\":\"$DR\",\"is_section_head\":true")
DOC=$(mkuser '["doctor"]' 44 ",\"department_id\":\"$DR\""); DOCID=$(cat "$TMP/u44" 2>/dev/null)
T_REP=$(mkuser "[\"$R_REP\"]" 45 ",\"department_id\":\"$DR\""); T_ALL=$(mkuser "[\"$R_ALL\"]" 46); T_NUR=$NR
[ -n "$RC" ] && [ -n "$NR" ] && [ -n "$HN" ] && [ -n "$DOC" ] && [ -n "$T_REP" ] && [ -n "$T_ALL" ] && ok "მომხმარებლები: რეგისტრატორი, ექთანი, ხელმძღვანელი ექთანი, ექიმი, reports, reports_all" || die "მომხმარებლები ვერ შეიქმნა"
chk "reports (განყ.) დაფას ვერ ცვლის (403); ექთანი ვერ კითხულობს (403)" "$(code PUT /reporting/dashboards/executive "$T_REP" -d '{"kpi_codes":["enc_total"],"reason":"ტესტ-E2E"}'):$(code GET /reporting/dashboards "$NR")" "403:403"
chk "ვალიდაცია: 9 KPI / დუბლი / უცნობი / ცარიელი / უცნობი დაფა → 400 / 404" \
  "$(code PUT /reporting/dashboards/executive "$ADM" -d '{"kpi_codes":["enc_total","admissions","discharges","alos","or_cases","lab_orders","dx_orders","rev_net","payments"],"reason":"ტესტ-E2E"}'):$(code PUT /reporting/dashboards/executive "$ADM" -d '{"kpi_codes":["enc_total","enc_total"],"reason":"ტესტ-E2E"}'):$(code PUT /reporting/dashboards/executive "$ADM" -d '{"kpi_codes":["xx_yy"],"reason":"ტესტ-E2E"}'):$(code PUT /reporting/dashboards/executive "$ADM" -d '{"kpi_codes":[],"reason":"ტესტ-E2E"}'):$(code PUT /reporting/dashboards/xx "$ADM" -d '{"kpi_codes":["enc_total"],"reason":"ტესტ-E2E"}')" "400:400:400:400:404"
chk "განყოფილების დაფა (reports_all): admissions, occupancy_pct, rev_net, stock_low_items — რიგით" "$(api PUT /reporting/dashboards/department "$T_ALL" -d '{"kpi_codes":["admissions","occupancy_pct","rev_net","stock_low_items"],"reason":"ტესტ-E2E"}' | jq -r '[.[].code]|join(",")')" "admissions,occupancy_pct,rev_net,stock_low_items"
chk "აუდიტი: RPT_DASHBOARD_UPDATE" "$(api GET "/audit-logs?entity_name=rpt_dashboard_kpis&entity_id=department&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("RPT_DASHBOARD_UPDATE") != null')" "true"

step "2. სატესტო განყოფილება: 3 საწოლი, 2 ჰოსპიტალიზაცია"
W=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DR\",\"code\":\"D$S\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BD=$(api POST "/inpatient/wards/$W/beds" "$ADM" -d '{"count":3}'); B1=$(echo "$BD" | jq -r '.[0].id'); B2=$(echo "$BD" | jq -r '.[1].id')
[ -n "$W" ] && [ "$B2" != "null" ] || die "პალატა / საწოლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1972-02-02\",\"gender\":\"female\",\"phone_number\":\"594$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 31 "დაფა-ერთი"); P2=$(mkpat 32 "დაფა-ორი")
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DR\",\"attending_doctor_id\":\"$DOCID\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "2 ჰოსპიტალიზაცია" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
chk "E1 → საწოლი 1; საწოლი 2 — დაბლოკილი; E2 — საწოლის გარეშე" "$(api POST "/inpatient/stays/$E1/bed" "$NR" -d "{\"bed_id\":\"$B1\"}" | jq -r '.bed != null'):$(api POST "/inpatient/beds/$B2/block" "$HN" -d '{"reason":"ტესტ-E2E"}' | jq -r .status)" "true:blocked"

step "3. „ახლა“ (ცოცხალი, 60 წმ ქეში)"
L=$(api GET "/reporting/live?department_id=$DR" "$ADM")
chk "საწოლები: 3 / დაკავებული 1 / თავისუფალი 1 / დაბლოკილი 1; საწოლის გარეშე 1" "$(echo "$L" | jq -r '.totals|"\(.beds):\(.occupied):\(.free):\(.blocked):\(.no_bed)"')" "3:1:1:1:1"
chk "დღეს: ჰოსპიტალიზაცია 2, ვიზიტი 2, გაწერა 0; დაკავება ახლა 33.3%" "$(echo "$L" | jq -r '.totals|"\(.admissions_today):\(.encounters_today):\(.discharges_today):\(.occupancy_now_pct)"')" "2:2:0:33.3"
chk "პირველი მოთხოვნა — არა ქეშიდან; მეორე — ქეშიდან (იგივე დრო)" "$(echo "$L" | jq -r .cached):$(api GET "/reporting/live?department_id=$DR" "$ADM" | jq -r --arg g "$(echo "$L" | jq -r .generated_at)" '"\(.cached):\(.generated_at==$g)"')" "false:true:true"
chk "reports (თავისი განყოფილება) — იგივე; სხვა განყოფილება → 403 OUT_OF_SCOPE; ექთანი → 403" "$(api GET /reporting/live "$T_REP" | jq -r '.totals|"\(.beds):\(.occupied)"'):$(api GET "/reporting/live?department_id=$DX" "$T_REP" | jq -r .code):$(code GET /reporting/live "$NR")" "3:1:OUT_OF_SCOPE:403"
# კლინიკის ხედი შეიძლება ქეშიდან იყოს (წინა გაშვებიდან, ≤ 60 წმ) — ველოდებით ახალ სურათს
for i in $(seq 1 14); do LA=$(api GET /reporting/live "$T_ALL"); [ "$(echo "$LA" | jq -r .cached)" = "false" ] && break; sleep 5; done
chk "კლინიკა: განყოფილებების ხაზები, ჯამი = ხაზების ჯამი, სატესტო განყოფილება შედის" "$(echo "$LA" | jq -r --arg d "$DR" '"\(.totals.beds == ([.departments[].beds]|add)):\(.totals.occupied == ([.departments[].occupied]|add)):\([.departments[]|select(.department_id==$d)]|length)"')" "true:true:1"
chk "department_id არასწორი → 400" "$(code GET "/reporting/live?department_id=xx" "$ADM")" "400"

step "4. „ყურადღება“"
api PUT /modules/reporting "$ADM" -d '{"settings":{"lab_overdue_min":15},"reason":"ტესტ-E2E"}' >/dev/null
AT=$(api GET "/reporting/attention?department_id=$DR" "$ADM")
chk "პაციენტი საწოლის გარეშე (1) — ყვითელი; პერიოდი — თვე დღემდე" "$(echo "$AT" | jq -r '[.items[]|select(.kind=="no_bed")][0]|"\(.value):\(.severity)"'):$(echo "$AT" | jq -r '"\(.from):\(.to)"')" "1:yellow:$MONTH:$TODAY"
O_TG=$(api GET /reporting/kpis "$ADM" | jq -c '.[]|select(.code=="occupancy_pct")|[.targets[]|{department_id,target,warn,note}]')
api PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d "{\"targets\":[{\"department_id\":\"$DR\",\"target\":99,\"warn\":98}],\"reason\":\"ტესტ-E2E\"}" >/dev/null
refresh "$TODAY" "$TODAY" >/dev/null
AT=$(api GET "/reporting/attention?department_id=$DR" "$ADM")
chk "წითელი KPI (დატვირთვა < სამიზნე 99) — პირველ ადგილზე, წითლები ყვითლებამდე" "$(echo "$AT" | jq -r '[.items[]|select(.kind=="kpi" and .code=="occupancy_pct")][0].severity'):$(echo "$AT" | jq -r '[.items[].severity]|(index("yellow") // 99) > (rindex("red") // -1)')" "red:true"
LIVE15=$(api GET "/reporting/live" "$T_ALL" | jq -r '.totals.lab_overdue')
chk "ლაბ. აგვიანებს: „ყურადღება“-ს მნიშვნელობა = „ახლა“-ს (კლინიკა)" "$(api GET /reporting/attention "$T_ALL" | jq -r --argjson n "$LIVE15" '([.items[]|select(.kind=="lab_overdue")][0].value // 0) == $n')" "true"
chk "reports (განყ.) — მხოლოდ თავისი; სხვა განყოფილება → 403" "$(api GET /reporting/attention "$T_REP" | jq -r '[.items[]|select(.kind=="no_bed")][0].value'):$(code GET "/reporting/attention?department_id=$DX" "$T_REP")" "1:403"

step "5. ძირითადი KPI-ები და ტრენდი"
H=$(api GET "/reporting/headline?dashboard=department&from=$TODAY&to=$TODAY&department_id=$DR&compare=prev" "$ADM")
chk "განყოფილების დაფა: 4 KPI რიგით, 13 თვე, sparkline 13 (ბოლო = დღევანდელი თვე)" "$(echo "$H" | jq -r '"\([.kpis[].code]|join(",")):\(.months|length):\(.months[-1]):\(.kpis[0].spark|length)"')" "admissions,occupancy_pct,rev_net,stock_low_items:13:${TODAY:0:7}:13"
chk "მნიშვნელობა = მიმოხილვის (ჰოსპიტალიზაცია 2); მომენტალურს sparkline არ აქვს; სტატუსი წითელი (დატვირთვა)" "$(echo "$H" | jq -r '.kpis[]|select(.code=="admissions")|.value'):$(echo "$H" | jq -r '.kpis[]|select(.code=="stock_low_items")|.spark'):$(echo "$H" | jq -r '.kpis[]|select(.code=="occupancy_pct")|.status')" "2:null:red"
HR=$(api GET "/reporting/headline?dashboard=department&from=$TODAY&to=$TODAY" "$T_REP")
chk "reports (dept_finance_visible = heads): ფინანსური ჩანს" "$(echo "$HR" | jq -r '[.kpis[].code]|index("rev_net") != null')" "true"
O_FIN=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings')
api PUT /modules/finance "$ADM" -d '{"settings":{"dept_finance_visible":"off"},"reason":"ტესტ-E2E"}' >/dev/null
chk "dept_finance_visible = off → reports-ს დაფიდან ფინანსური KPI ქრება (3)" "$(api GET "/reporting/headline?dashboard=department&from=$TODAY&to=$TODAY" "$T_REP" | jq -r '"\(.kpis|length):\([.kpis[].code]|index("rev_net"))"')" "3:null"
api PUT /modules/finance "$ADM" -d "{\"settings\":$O_FIN,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PATCH /reporting/kpis/stock_low_items "$ADM" -d '{"is_active":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "დამალული KPI დაფაზე არ ჩანს" "$(api GET "/reporting/headline?dashboard=department&from=$TODAY&to=$TODAY&department_id=$DR" "$ADM" | jq -r '[.kpis[].code]|index("stock_low_items")')" "null"
api PATCH /reporting/kpis/stock_low_items "$ADM" -d '{"is_active":true,"reason":"ტესტ-E2E აღდგენა"}' >/dev/null
chk "უცნობი დაფა → 404; ექთანი → 403" "$(code GET "/reporting/headline?dashboard=x&from=$TODAY&to=$TODAY" "$ADM"):$(code GET "/reporting/headline?dashboard=executive&from=$TODAY&to=$TODAY" "$NR")" "404:403"
TR=$(api GET "/reporting/trend?kpi=admissions&department_id=$DR" "$ADM")
chk "ტრენდი: 13 თვე, ბოლო — მიმდინარე (partial), მნიშვნელობა = თვე დღემდე (2), შარშან — null (მონაცემი არ არის)" "$(echo "$TR" | jq -r '"\(.points|length):\(.points[-1].month):\(.points[-1].partial):\(.points[-1].value):\(.points[-1].prev_year)"')" "13:${TODAY:0:7}:true:2:null"
chk "ტრენდი: months=24 → 24; months=99 → 24; მონაცემამდე თვეები — null" "$(api GET "/reporting/trend?kpi=admissions&months=24" "$ADM" | jq -r '.points|length'):$(api GET "/reporting/trend?kpi=admissions&months=99" "$ADM" | jq -r '.points|length'):$(echo "$TR" | jq -r --arg df "$(echo "$TR" | jq -r .data_from)" '[.points[]|select(.to < $df)|.value]|all(. == null)')" "24:24:true"
chk "ტრენდი: მომენტალური KPI → 400; უცნობი → 404" "$(code GET "/reporting/trend?kpi=stock_low_items" "$ADM"):$(code GET "/reporting/trend?kpi=xx" "$ADM")" "400:404"
chk "თვე დღემდე = მიმოხილვა ($MONTH — $TODAY, ვიზიტები, კლინიკა)" "$(api GET "/reporting/trend?kpi=enc_total" "$T_ALL" | jq -r '.points[-1].value'):$(api GET "/reporting/overview?from=$MONTH&to=$TODAY&compare=none" "$T_ALL" | jq -r '.kpis[]|select(.code=="enc_total")|.value')" "$(api GET "/reporting/overview?from=$MONTH&to=$TODAY&compare=none" "$T_ALL" | jq -r '.kpis[]|select(.code=="enc_total")|.value'):$(api GET "/reporting/overview?from=$MONTH&to=$TODAY&compare=none" "$T_ALL" | jq -r '.kpis[]|select(.code=="enc_total")|.value')"

step "6. აღდგენა"
api PUT /reporting/kpis/occupancy_pct/targets "$ADM" -d "{\"targets\":$O_TG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /reporting/dashboards/department "$ADM" -d "{\"kpi_codes\":$(echo "$O_DASH" | jq -c '[.department[].code]'),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/reporting "$ADM" -d "{\"enabled\":$(echo "$O_RPT" | jq -c .enabled),\"settings\":$(echo "$O_RPT" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api POST "/inpatient/beds/$B2/unblock" "$HN" >/dev/null
for e in "$E1" "$E2"; do api POST "/inpatient/stays/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
while read -r u; do api PATCH "/users/$u" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/users"
while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
refresh "$TODAY" "$TODAY" >/dev/null
chk "დაფა / მოდული / სამიზნე აღდგა" "$(api GET /reporting/dashboards "$ADM" | jq -c '[.department[].code]'):$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|.settings' | jq -S -c .)" "$(echo "$O_DASH" | jq -c '[.department[].code]'):$(echo "$O_RPT" | jq -S -c .settings)"
api PATCH "/departments/$DR" "$ADM" -d '{"is_active":false}' >/dev/null; api PATCH "/departments/$DX" "$ADM" -d '{"is_active":false}' >/dev/null

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
