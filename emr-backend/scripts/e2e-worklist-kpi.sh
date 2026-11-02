#!/usr/bin/env bash
# =====================================================================
# e2e-worklist-kpi.sh — სამუშაო სიები, ეტაპი 4 (0084): ანგარიშები / KPI
#   KPI აღრიცხვა (run-jobs kpi): სისტემური ჩანაწერი (cash_debt) ჩნდება → „ღია ახლა“ → გადახდა → შემდეგ აღრიცხვაზე იხურება → წყაროთი / განყოფილებით;
#   ხელით დავალება (ვადით) → შესრულება → ვადაში %; ხედვა (worklist_all — ყველა, worklist_manage — თავისი განყოფილება, სხვა — 403); Excel;
#   მენეჯერული დაფა: KPI ჯგუფი worklist (4), გადათვლა → wl_late_pct / wl_response_median_h / wl_tasks_ontime_pct განყოფილებაზე; „ყურადღება“.
# ბოლოს: მომხმარებლები / როლები / განყოფილებები — გათიშული; პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-worklist-kpi.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
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
wl()   { api PUT /modules/worklist "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
kpi()  { api POST /worklist/run-jobs "$ADM" -d '{"kpi":true,"task_ids":["00000000-0000-0000-0000-000000000000"]}' | jq -c '.kpi // empty'; }
TODAY=$(TZ=Asia/Tbilisi date +%F)
refresh() {
  local R id st i; R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  if [ -z "$id" ]; then
    for i in $(seq 1 60); do sleep 1; [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; done
    R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  fi
  [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 120); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0084" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0084" | tostring)')" "ok:true"
ORIG=$(api GET /modules "$ADM"); orig() { echo "$ORIG" | jq -c --arg c "$1" '.[]|select(.code==$c)|{enabled, settings}'; }
RPT_EN=$(echo "$ORIG" | jq -r '.[]|select(.code=="reporting")|.enabled // empty')
api PUT /modules/worklist "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
wl '{"kpi_tracker":true,"kpi_interval_min":30,"sources":{}}'
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WK ამბულატორია $S\",\"code\":\"E2EWK1$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty'); echo "$D1" >> "$TMP/deps"
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WK სხვა $S\",\"code\":\"E2EWK2$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty'); echo "$D2" >> "$TMP/deps"
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
TC=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2E_WK_$S\",\"title\":\"ტესტ-E2E კონსულტაცია\",\"base_price\":10}" | jq -r .id)
R_MG=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_wkmg_$S\",\"name\":\"ტესტ-E2E ხელმძღვანელი\",\"capabilities\":[\"worklist_manage\"]}" | jq -r '.id // empty'); echo "$R_MG" >> "$TMP/roles"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.wk.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"KPI-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.wk.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
read -r RCID RC <<< "$(mkuser '["receptionist"]' 81 ",\"department_id\":\"$D1\"")"
read -r DRID DR <<< "$(mkuser '["doctor"]' 82 ",\"department_id\":\"$D1\",\"specialty\":\"თერაპევტი\",\"license_number\":\"MD-$S\",\"consultation_tariff_id\":\"$TC\"")"
read -r MGID MG <<< "$(mkuser "[\"e2e_wkmg_$S\"]" 83 ",\"department_id\":\"$D1\"")"
read -r NRID NR <<< "$(mkuser '["nurse"]' 84 ",\"department_id\":\"$D1\"")"
for t in RC DR MG NR; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"85$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"KPI\",\"birth_date\":\"1970-01-01\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] || die "პაციენტი ვერ შეიქმნა"
ok "განყოფილებები, რეგისტრატორი, ექიმი, ხელმძღვანელი (worklist_manage), ექთანი, პაციენტი"

step "1. აღრიცხვა: სისტემური ჩანაწერი ჩნდება → იხურება"
ENC=$(api POST /encounters/walk-in "$RC" -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DRID\"}" | jq -r '.encounter_id // empty')
api POST "/encounters/$ENC/payment-override" "$ADM" -d '{"reason":"ტესტ-E2E: გადაიხდის მოგვიანებით"}' >/dev/null
chk "cash_debt რეგისტრატორის სიაში" "$(api GET '/worklist/mine?source=cash_debt' "$RC" | jq -r --arg k "cash_debt:$ENC" '[.items[]|select(.key==$k)]|length')" "1"
K1=$(kpi)
chk "აღრიცხვა (kpi): გაშვება ჩაიწერა, მომხმარებლები > 0, ჩანაწერები ≥ 1" "$(echo "$K1" | jq -r '"\(.run_id > 0):\(.users > 0):\(.items >= 1)"')" "true:true:true"
R1=$(api GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&include_test=1&department_id=$D1" "$ADM")
chk "ანგარიში: „ღია ახლა“ — cash_debt (D1) 1; ბოლო აღრიცხვა ჩანს" "$(echo "$R1" | jq -r '[.open_now[]|select(.source=="cash_debt")|.open]|add // 0'):$(echo "$R1" | jq -r '.tracker.last_run != null')" "1:true"
chk "სატესტო განყოფილება ნაგულისხმევად გამორიცხულია (include_test-ის გარეშე)" "$(api GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&department_id=$D1" "$ADM" | jq -r '[.open_now[]|select(.source=="cash_debt")|.open]|add // 0')" "0"
INVE=$(api GET "/encounters/$ENC" "$RC" | jq -r '.invoice.id // empty')
api POST "/invoices/$INVE/payments" "$RC" -d '{"amount":10,"method":"cash"}' >/dev/null
kpi >/dev/null
R2=$(api GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&include_test=1&department_id=$D1" "$ADM")
chk "გადახდა → შემდეგ აღრიცხვაზე დაიხურა: წყაროთი 1 (ვადაში), ღია — 0; განყოფილებით — D1" \
  "$(echo "$R2" | jq -r '[.by_source[]|select(.source=="cash_debt")][0]|"\(.closed):\(.late):\(.median_h != null)"'):$(echo "$R2" | jq -r '[.open_now[]|select(.source=="cash_debt")|.open]|add // 0'):$(echo "$R2" | jq -r --arg d "$D1" '[.by_department[]|select(.department_id==$d)|.closed]|add // 0')" "1:0:true:0:1"

step "2. ხელით დავალება — ვადაში %"
DUE=$(date -u -d '+2 hours' +%FT%TZ)
T=$(api POST /worklist/tasks "$NR" -d "{\"title\":\"ტესტ-E2E WK დავალება\",\"due_at\":\"$DUE\"}" | jq -r '.id // empty')
api POST "/worklist/tasks/$T/done" "$NR" -d '{"note":"ტესტ-E2E"}' >/dev/null
R3=$(api GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&include_test=1&department_id=$D1" "$ADM")
chk "ხელით: შექმნილი 1, შესრულებული 1, ვადაში 100%" "$(echo "$R3" | jq -r --arg d "$D1" '[.tasks.by_department[]|select(.department_id==$d)][0]|"\(.created):\(.done):\(.on_time_pct)"')" "1:1:100"
chk "შემსრულებლით (worklist_all / admin): სატესტო — მხოლოდ include_test-ით" "$(api GET "/worklist/reports/summary?from=$TODAY&to=$TODAY" "$ADM" | jq -r --arg u "$NRID" '[.tasks.by_assignee[]|select(.user_id==$u)|.done]|add // 0'):$(echo "$R3" | jq -r --arg u "$NRID" '[.tasks.by_assignee[]|select(.user_id==$u)|.done]|add // 0')" "0:1"

step "3. ხედვა, Excel"
chk "ექთანი (worklist_manage-ის გარეშე) → 403; ხელმძღვანელი → 200 (D1); სხვა განყოფილება → 403" "$(code GET "/worklist/reports/summary?from=$TODAY&to=$TODAY" "$NR"):$(code GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&include_test=1" "$MG"):$(code GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&department_id=$D2" "$MG")" "403:200:403"
MGR=$(api GET "/worklist/reports/summary?from=$TODAY&to=$TODAY&include_test=1" "$MG")
chk "ხელმძღვანელს: არე = D1, სახელობითი ჭრილი არ არის" "$(echo "$MGR" | jq -r --arg d "$D1" '"\(.scope.departments|index($d) != null):\(.scope.named):\(.tasks.by_assignee|length)"')" "true:false:0"
chk "refs.can.reports: ხელმძღვანელს — true, ექთანს — false" "$(api GET /worklist/refs "$MG" | jq -r .can.reports):$(api GET /worklist/refs "$NR" | jq -r .can.reports)" "true:false"
chk "პერიოდი from > to → 400; 400 დღეზე მეტი → 400" "$(code GET "/worklist/reports/summary?from=$TODAY&to=2020-01-01" "$ADM"):$(code GET "/worklist/reports/summary?from=2020-01-01&to=$TODAY" "$ADM")" "400:400"
chk "Excel (xlsx)" "$(curl -s "$B/worklist/reports/export?from=$TODAY&to=$TODAY&include_test=1" -H "authorization: Bearer $ADM" | head -c 2)" "PK"

step "4. მენეჯერული დაფა"
chk "KPI ცნობარი: ჯგუფი worklist — 4 (განმარტებით / ფორმულით)" "$(api GET /reporting/kpis "$ADM" | jq -r '[.[]|select(.category=="worklist" and (.definition|length)>3 and (.formula|length)>3)]|length')" "4"
if [ "$RPT_EN" = "true" ]; then
  RR=$(refresh "$TODAY" "$TODAY")
  chk "გადათვლა — ok" "$(echo "$RR" | jq -r .status)" "ok"
  OV=$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$D1&compare=none" "$ADM")
  kv() { echo "$OV" | jq -r --arg c "$1" '.kpis[]|select(.code==$c)|.value'; }
  chk "D1: ვადის შემდეგ 0%, რეაგირების მედიანა არის, ხელით ვადაში 100%" "$(kv wl_late_pct):$( [ "$(kv wl_response_median_h)" != "null" ] && echo yes):$(kv wl_tasks_ontime_pct)" "0:yes:100"
  AT=$(api GET "/reporting/attention?department_id=$D1" "$ADM")
  chk "„ყურადღება“ — პასუხი მიიღება (worklist ჩართულია)" "$(echo "$AT" | jq -r '.items|type')" "array"
else ok "მენეჯერული რეპორტინგი გამორთულია — დაფის შემოწმება გამოტოვებულია"; fi

step "5. გასუფთავება"
api PUT /modules/worklist "$ADM" -d "$(orig worklist | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "პარამეტრები აღდგენილია (worklist)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}')" "$(orig worklist)"
[ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
[ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
[ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
ok "სატესტო ჩანაწერები გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
