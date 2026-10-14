#!/usr/bin/env bash
# =====================================================================
# e2e-reporting-ops.sh — ოპერაციული დაფები (0062): ნაკადი / სითბური რუკა, საწოლები, საოპერაციო, კვლევები, მარაგი, ექიმის ჭრილი
#   სატესტო განყოფილება (2 ჰოსპიტალიზაცია ერთ ექიმზე) — ზუსტი მნიშვნელობები; დანარჩენი — შეჯერება KPI-ებთან (მიმოხილვა).
#   bash scripts/e2e-reporting-ops.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-reporting-ops.sh
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
DOW=$(( $(date +%u) - 1 ))
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rops.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ოპ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rops.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_rops_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_rops_$1_$S"; }; }
refresh() {
  local R id st i; for i in $(seq 1 60); do [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; sleep 1; done
  R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty'); [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 120); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}
eqn() { [ "$1" = "$2" ] && echo eq || echo "$1≠$2"; }

step "0. პარამეტრები"
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
[ -n "$O_RPT" ] || die "მოდული reporting ვერ მოიძებნა"
chk "ნაგულისხმევი: doctor_breakdown = all_only, min_cases = 5" "$(echo "$O_RPT" | jq -r '.settings|"\(.doctor_breakdown):\(.min_cases)"')" "all_only:5"
chk "ვალიდაცია: doctor_breakdown=x / min_cases=0 / min_cases=51 → 400" "$(code PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_breakdown":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"min_cases":0},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"min_cases":51},"reason":"ტესტ-E2E"}')" "400:400:400"
api PUT /modules/reporting "$ADM" -d '{"enabled":true,"settings":{"doctor_breakdown":"all_only","min_cases":5},"reason":"ტესტ-E2E"}' >/dev/null
chk "meta: doctor_breakdown, min_cases" "$(api GET /reporting/meta "$ADM" | jq -r '.settings|"\(.doctor_breakdown):\(.min_cases)"')" "all_only:5"

step "1. სატესტო განყოფილება: 2 ჰოსპიტალიზაცია, ერთი მკურნალი ექიმი"
R_REP=$(mkrole rep "დაფა (განყ.)" '["reports"]'); R_ALL=$(mkrole all "დაფა (კლინიკა)" '["reports_all"]')
DR=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ოპერაციული $S\",\"code\":\"E2ERO$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DX=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ოპერაციული-2 $S\",\"code\":\"E2ERP$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DR" ] && [ -n "$DX" ] && [ -n "$R_REP" ] && [ -n "$R_ALL" ] || die "განყოფილებები / როლები ვერ შეიქმნა"
RC=$(mkuser '["receptionist"]' 21); NR=$(mkuser '["nurse"]' 22 ",\"department_id\":\"$DR\"")
DOC=$(mkuser '["doctor"]' 23 ",\"department_id\":\"$DR\""); DOCID=$(cat "$TMP/u23" 2>/dev/null)
T_REP=$(mkuser "[\"$R_REP\"]" 24 ",\"department_id\":\"$DR\""); T_ALL=$(mkuser "[\"$R_ALL\"]" 25)
[ -n "$RC" ] && [ -n "$NR" ] && [ -n "$DOC" ] && [ -n "$T_REP" ] && [ -n "$T_ALL" ] && ok "მომხმარებლები: რეგისტრატორი, ექთანი, ექიმი, reports, reports_all" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1968-08-08\",\"gender\":\"male\",\"phone_number\":\"593$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 11 "ოპ-ერთი"); P2=$(mkpat 12 "ოპ-ორი")
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DR\",\"attending_doctor_id\":\"$DOCID\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
HOUR=$((10#$(date +%H)))
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "2 ჰოსპიტალიზაცია (მკურნალი — სატესტო ექიმი)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
RUN=$(refresh "$TODAY" "$TODAY")
chk "გადათვლა: ok, ახალი ფაქტები (hourly / dx_dim / doctor)" "$(echo "$RUN" | jq -r '"\(.status):\(.facts|has("hourly")):\(.facts|has("dx_dim")):\(.facts|has("doctor"))"')" "ok:true:true:true"

step "2. ნაკადი და სითბური რუკა (სატესტო განყოფილება)"
Q="from=$TODAY&to=$TODAY&department_id=$DR"
chk "დღიური ნაკადი: სტაციონარი 2, სხვა 0" "$(api GET "/reporting/ops/flow?$Q" "$ADM" | jq -r '"\(.totals.inpatient):\(.totals.outpatient + .totals.lab + .totals.emergency):\(.days|length)"')" "2:0:1"
H=$(api GET "/reporting/ops/heatmap?$Q&layer=admission" "$ADM")
chk "რუკა (ჰოსპიტალიზაცია): სულ 2, დღეს / ამ საათში საშუალო 2 (კვირის დღე 1-ჯერ), პიკი — ეს საათი" "$(echo "$H" | jq -r --argjson d "$DOW" --argjson h "$HOUR" '"\(.sum):\(.avg[$d][$h]):\(.occurrences[$d]):\(.peak.hour == $h)"')" "2:2:1:true"
chk "რუკა (ვიზიტი, სტაციონარი) = 2; (ვიზიტი, ამბულატორია) = 0; ლაბ. აღება = 0" "$(api GET "/reporting/ops/heatmap?$Q&layer=visit&sub=inpatient" "$ADM" | jq -r .sum):$(api GET "/reporting/ops/heatmap?$Q&layer=visit&sub=outpatient" "$ADM" | jq -r .sum):$(api GET "/reporting/ops/heatmap?$Q&layer=lab_collect" "$ADM" | jq -r .sum)" "2:0:0"
H7=$(api GET "/reporting/ops/heatmap?from=$(date -d "$TODAY -13 day" +%F)&to=$TODAY&department_id=$DR&layer=admission" "$ADM")
chk "14 დღე: თითო კვირის დღე 2-ჯერ → საშუალო 1 (ჯამი უცვლელი 2)" "$(echo "$H7" | jq -r --argjson d "$DOW" --argjson h "$HOUR" '"\(.occurrences[$d]):\(.avg[$d][$h]):\(.sum)"')" "2:1:2"
chk "ვალიდაცია: layer=x / sub=x → 400" "$(code GET "/reporting/ops/heatmap?$Q&layer=x" "$ADM"):$(code GET "/reporting/ops/heatmap?$Q&layer=visit&sub=x" "$ADM")" "400:400"

step "3. საწოლები / ექიმები (სატესტო განყოფილება)"
chk "საწოლები: 1 ხაზი, მიღება 2, გაწერა 0, ALOS — null, დღიური მწკრივი" "$(api GET "/reporting/ops/beds?$Q" "$ADM" | jq -r '.rows[0]|"\(.department_id):\(.admissions):\(.discharges):\(.alos):\(.daily|length)"')" "$DR:2:0:null:1"
DA=$(api GET "/reporting/ops/doctors?$Q&role=attending" "$ADM")
chk "მკურნალი ექიმი: 1 ექიმი, მიღება 2, მცირე ნიმუში (გაწერა 0 < 5) → ALOS / ლეტალობა null" "$(echo "$DA" | jq -r '"\(.rows|length):\(.rows[0].doctor_id):\(.rows[0].admissions):\(.rows[0].small):\(.rows[0].alos):\(.rows[0].mortality_pct)"')" "1:$DOCID:2:true:null:null"
chk "აუდიტი: REPORT_DOCTORS" "$(api GET "/audit-logs?entity_name=rpt_fact_doctor&entity_id=attending&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_DOCTORS") != null')" "true"
chk "all_only: reports (განყ.) → 403 DOCTOR_BREAKDOWN_ALL_ONLY; reports_all → 200" "$(api GET "/reporting/ops/doctors?from=$TODAY&to=$TODAY&role=attending" "$T_REP" | jq -r .code):$(code GET "/reporting/ops/doctors?from=$TODAY&to=$TODAY&role=attending" "$T_ALL")" "DOCTOR_BREAKDOWN_ALL_ONLY:200"
api PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_breakdown":"scoped"},"reason":"ტესტ-E2E"}' >/dev/null
chk "scoped: reports (განყ.) — მხოლოდ თავისი განყოფილების ექიმი; სხვა განყოფილება → 403" "$(api GET "/reporting/ops/doctors?from=$TODAY&to=$TODAY&role=attending" "$T_REP" | jq -r '"\(.rows|length):\(.rows[0].doctor_id):\(.mode)"'):$(code GET "/reporting/ops/doctors?from=$TODAY&to=$TODAY&role=attending&department_id=$DX" "$T_REP")" "1:$DOCID:scoped:403"
api PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_breakdown":"off"},"reason":"ტესტ-E2E"}' >/dev/null
chk "off: admin-საც 403 DOCTOR_BREAKDOWN_OFF; ექსპორტიც 403" "$(api GET "/reporting/ops/doctors?$Q&role=attending" "$ADM" | jq -r .code):$(code GET "/reporting/ops/export?dataset=doctors&$Q&role=attending" "$ADM")" "DOCTOR_BREAKDOWN_OFF:403"
api PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_breakdown":"all_only"},"reason":"ტესტ-E2E"}' >/dev/null
chk "role=x → 400; ექთანი → 403" "$(code GET "/reporting/ops/doctors?$Q&role=x" "$ADM"):$(code GET "/reporting/ops/beds?$Q" "$NR")" "400:403"

step "4. შეჯერება KPI-ებთან (მთელი კლინიკა, $MONTH — $TODAY)"
refresh "$MONTH" "$TODAY" >/dev/null
M="from=$MONTH&to=$TODAY"
OV=$(api GET "/reporting/overview?$M&compare=none" "$ADM"); kv() { echo "$OV" | jq -r --arg c "$1" '.kpis[]|select(.code==$c)|.value'; }
chk "ნაკადი (ტიპების ჯამი) / რუკა (ვიზიტი) = ვიზიტები" "$(eqn "$(api GET "/reporting/ops/flow?$M" "$ADM" | jq '[.totals[]]|add')" "$(kv enc_total)"):$(eqn "$(api GET "/reporting/ops/heatmap?$M&layer=visit" "$ADM" | jq .sum)" "$(kv enc_total)")" "eq:eq"
chk "რუკა (ჰოსპიტალიზაცია) / საწოლები (მიღების ჯამი) = ჰოსპიტალიზაცია" "$(eqn "$(api GET "/reporting/ops/heatmap?$M&layer=admission" "$ADM" | jq .sum)" "$(kv admissions)"):$(eqn "$(api GET "/reporting/ops/beds?$M" "$ADM" | jq '[.rows[].admissions]|add // 0')" "$(kv admissions)")" "eq:eq"
chk "საწოლები (გაწერის ჯამი) = გაწერა" "$(eqn "$(api GET "/reporting/ops/beds?$M" "$ADM" | jq '[.rows[].discharges]|add // 0')" "$(kv discharges)")" "eq"
ORS=$(api GET "/reporting/ops/or?$M" "$ADM")
chk "საოპერაციო: განყოფილებების ჯამი = ოპერაციები; ოთახების გამოყენება % = KPI" "$(eqn "$(echo "$ORS" | jq '[.departments[].done]|add // 0')" "$(kv or_cases)"):$(eqn "$(echo "$ORS" | jq '([.rooms[].used]|add // 0) as $u | ([.rooms[].avail]|add // 0) as $a | if $a > 0 then ($u / $a * 1000 | round / 10) else null end')" "$(kv or_utilization_pct)")" "eq:eq"
chk "ექიმები (ქირურგი): დასრულებულის ჯამი = ოპერაციები" "$(eqn "$(api GET "/reporting/ops/doctors?$M&role=surgeon" "$ADM" | jq '[.rows[].done]|add // 0')" "$(kv or_cases)")" "eq"
chk "ლაბორატორია (ანალიზატორით / ჯგუფით) = ლაბ. კვლევები" "$(eqn "$(api GET "/reporting/ops/dx?$M&section=lab&by=device" "$ADM" | jq '[.rows[].ordered]|add // 0')" "$(kv lab_orders)"):$(eqn "$(api GET "/reporting/ops/dx?$M&section=lab&by=group" "$ADM" | jq '[.rows[].ordered]|add // 0')" "$(kv lab_orders)")" "eq:eq"
chk "ინსტრუმენტული (აპარატით / მოდალობით) = კვლევები; ერთეული — საათი" "$(eqn "$(api GET "/reporting/ops/dx?$M&section=imaging&by=device" "$ADM" | jq '[.rows[].ordered]|add // 0')" "$(kv dx_orders)"):$(eqn "$(api GET "/reporting/ops/dx?$M&section=imaging&by=modality" "$ADM" | jq '[.rows[].ordered]|add // 0')" "$(kv dx_orders)"):$(api GET "/reporting/ops/dx?$M&section=imaging" "$ADM" | jq -r .unit)" "eq:eq:hours"
chk "მარაგი: ლოკაციების ხარჯი = KPI; ყველაზე ხარჯვადი ≤ 20" "$(eqn "$(api GET "/reporting/ops/stock?$M" "$ADM" | jq '[.locations[].consumption]|add // 0 | . * 100 | round / 100')" "$(kv stock_consumption)"):$(api GET "/reporting/ops/stock?$M" "$ADM" | jq '.top_items|length <= 20')" "eq:true"
chk "ვალიდაცია: section=x / by=x / from > to → 400; reports — სხვა განყოფილება → 403" "$(code GET "/reporting/ops/dx?$M&section=x" "$ADM"):$(code GET "/reporting/ops/dx?$M&by=x" "$ADM"):$(code GET "/reporting/ops/beds?from=$TODAY&to=$MONTH" "$ADM" ):$(code GET "/reporting/ops/beds?$M&department_id=$DX" "$T_REP")" "400:400:$([ "$TODAY" = "$MONTH" ] && echo 200 || echo 400):403"

step "5. ექსპორტი"
for ds in beds or_rooms or_departments dx heatmap doctors; do
  curl -s -o "$TMP/$ds.xlsx" -w '%{http_code}' "$B/reporting/ops/export?dataset=$ds&$M&role=surgeon&layer=visit" -H "authorization: Bearer $ADM" > "$TMP/$ds.code"
done
chk "xlsx: beds / or_rooms / or_departments / dx / heatmap / doctors — 200, zip (PK)" "$(for ds in beds or_rooms or_departments dx heatmap doctors; do printf '%s%s ' "$(cat "$TMP/$ds.code")" "$(head -c 2 "$TMP/$ds.xlsx")"; done)" "200PK 200PK 200PK 200PK 200PK 200PK "
curl -s -o "$TMP/h.csv" "$B/reporting/ops/export?dataset=heatmap&format=csv&$M&layer=visit" -H "authorization: Bearer $ADM"
chk "csv (რუკა): BOM, სათაური + 7 დღე" "$(head -c 3 "$TMP/h.csv" | od -An -tx1 | tr -d ' '):$(wc -l < "$TMP/h.csv" | tr -d ' ')" "efbbbf:8"
chk "უცნობი dataset → 400; ექთანი → 403" "$(code GET "/reporting/ops/export?dataset=x&$M" "$ADM"):$(code GET "/reporting/ops/export?dataset=beds&$M" "$NR")" "400:403"
chk "აუდიტი: REPORT_EXPORT (ops_beds)" "$(api GET "/audit-logs?entity_name=rpt_reports&entity_id=ops_beds&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_EXPORT") != null')" "true"

step "6. აღდგენა"
api PUT /modules/reporting "$ADM" -d "{\"enabled\":$(echo "$O_RPT" | jq -c .enabled),\"settings\":$(echo "$O_RPT" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
for e in "$E1" "$E2"; do api POST "/inpatient/stays/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
while read -r u; do api PATCH "/users/$u" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/users"
while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
refresh "$TODAY" "$TODAY" >/dev/null
chk "მოდული აღდგა; გაუქმების შემდეგ რუკა (ჰოსპიტალიზაცია, სატესტო) = 0" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|.settings' | jq -S -c .):$(api GET "/reporting/ops/heatmap?$Q&layer=admission" "$ADM" | jq -r .sum)" "$(echo "$O_RPT" | jq -S -c .settings):0"
api PATCH "/departments/$DR" "$ADM" -d '{"is_active":false}' >/dev/null; api PATCH "/departments/$DX" "$ADM" -d '{"is_active":false}' >/dev/null

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
