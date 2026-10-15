#!/usr/bin/env bash
# =====================================================================
# e2e-reporting-fin.sh — ფინანსური დაფა, შემოსავალი ექიმზე, მენეჯერული ანგარიში (xlsx / PDF), განრიგით გაგზავნა, „ყურადღების“ შეტყობინებები (0063)
#   შეჯერება: ფინანსური KPI-ები (მიმოხილვა), /finance/receivables, /payables/aging; წვდომის წესები — სატესტო მომხმარებლებით.
#   ელფოსტა რეალურად არ იგზავნება — განრიგი მოწმდება სატესტო გაშვებით (dry_run).
#   bash scripts/e2e-reporting-fin.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-reporting-fin.sh
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
command -v python3 >/dev/null || die "python3 არ არის დაყენებული (xlsx-ის შემოწმებისთვის)"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r '.code // .error.code // .message.code // empty'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(date +%F); MONTH=$(date +%Y-%m-01)
PM_END=$(date -d "$MONTH -1 day" +%F); PM=$(date -d "$PM_END" +%Y-%m-01)
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rfin.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ფინ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rfin.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_rfin_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_rfin_$1_$S"; }; }
refresh() {
  local R id st i; for i in $(seq 1 60); do [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; sleep 1; done
  R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty'); [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 180); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}
# რიცხვების შედარება 0.01 სიზუსტით
eqn() { if [ "$(jq -n --argjson a "${1:-null}" --argjson b "${2:-null}" 'if $a == null or $b == null then ($a == $b) else ((($a - $b) | fabs) < 0.011) end')" = "true" ]; then echo eq; else echo "$1≠$2"; fi; }
sheets() { python3 -c "import sys,zipfile,re; z=zipfile.ZipFile(sys.argv[1]); print('|'.join(re.findall(r'<sheet name=\"([^\"]+)\"', z.read('xl/workbook.xml').decode())))" "$1" 2>/dev/null; }
has_sheet() { case "|$(sheets "$1")|" in *"|$2|"*) echo yes ;; *) echo no ;; esac; }

step "0. პარამეტრები"
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
O_FIN=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|{enabled, settings}')
[ -n "$O_RPT" ] && [ -n "$O_FIN" ] || die "მოდული reporting / finance ვერ მოიძებნა"
[ "$(echo "$O_FIN" | jq -r .enabled)" = "true" ] || die "ფინანსების მოდული გამორთულია — ფინანსური დაფა არ მუშაობს"
chk "ნაგულისხმევი: doctor_revenue = on, attention_notify = in_app, საათი 8, დონე red" \
  "$(echo "$O_RPT" | jq -r '.settings|"\(.doctor_revenue):\(.attention_notify):\(.attention_notify_hour):\(.attention_notify_level)"')" "on:in_app:8:red"
chk "ვალიდაცია: doctor_revenue=x / attention_notify=x / საათი 24 / დონე x → 400" \
  "$(code PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_revenue":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"attention_notify":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"attention_notify_hour":24},"reason":"ტესტ-E2E"}'):$(code PUT /modules/reporting "$ADM" -d '{"settings":{"attention_notify_level":"x"},"reason":"ტესტ-E2E"}')" "400:400:400:400"
# „ყურადღება“ — გამორთულია მე-8 ნაწილამდე (worker-მა სატესტო მომხმარებელს წინასწარ არ გაუგზავნოს)
api PUT /modules/reporting "$ADM" -d '{"enabled":true,"settings":{"doctor_breakdown":"all_only","doctor_revenue":"on","attention_notify":"off","attention_notify_level":"red"},"reason":"ტესტ-E2E"}' >/dev/null
chk "meta: doctor_revenue, attention_notify, scope.finance (admin)" "$(api GET /reporting/meta "$ADM" | jq -r '"\(.settings.doctor_revenue):\(.settings.attention_notify):\(.scope.finance)"')" "on:off:true"

step "1. სატესტო მომხმარებლები და გადათვლა"
R_REP=$(mkrole rep "დაფა (განყ.)" '["reports"]'); R_ALL=$(mkrole all "დაფა (კლინიკა)" '["reports_all"]')
DR=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ფინანსური $S\",\"code\":\"E2ERF$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DR" ] && [ -n "$R_REP" ] && [ -n "$R_ALL" ] || die "განყოფილება / როლები ვერ შეიქმნა"
T_REP=$(mkuser "[\"$R_REP\"]" 31 ",\"department_id\":\"$DR\""); T_ALL=$(mkuser "[\"$R_ALL\"]" 32); NR=$(mkuser '["nurse"]' 33 ",\"department_id\":\"$DR\"")
U_REP=$(cat "$TMP/u31" 2>/dev/null); U_ALL=$(cat "$TMP/u32" 2>/dev/null); U_NR=$(cat "$TMP/u33" 2>/dev/null)
[ -n "$T_REP" ] && [ -n "$T_ALL" ] && [ -n "$NR" ] && ok "მომხმარებლები: reports (განყოფილება), reports_all, ექთანი" || die "მომხმარებლები ვერ შეიქმნა"
RUN=$(refresh "$PM" "$TODAY")
chk "გადათვლა (წინა + ეს თვე): ok, ახალი ფაქტები (payer / doctor_rev / balance_snapshot)" \
  "$(echo "$RUN" | jq -r '"\(.status):\(.facts|has("payer")):\(.facts|has("doctor_rev")):\(.facts|has("balance_snapshot"))"')" "ok:true:true:true"

step "2. ფინანსური შეჯამება — შეჯერება KPI-ებთან (ეს თვე)"
M="from=$MONTH&to=$TODAY"
SUM=$(api GET "/reporting/fin/summary?$M" "$ADM"); OV=$(api GET "/reporting/overview?$M&compare=none" "$ADM")
kv() { echo "$OV" | jq -r --arg c "$1" '.kpis[]|select(.code==$c)|.value // "null"'; }
st() { echo "$SUM" | jq -r ".totals.$1"; }
chk "შემოსავალი / ხარჯი / შედეგი / გადახდები / უარი = KPI" \
  "$(eqn "$(st rev_net)" "$(kv rev_net)"):$(eqn "$(st costs)" "$(kv costs_total)"):$(eqn "$(st result)" "$(kv result)"):$(eqn "$(st payments)" "$(kv payments)"):$(eqn "$(st denied)" "$(kv denied_amount)")" "eq:eq:eq:eq:eq"
chk "მარჟა % და სახელმწიფოს / დაზღვევის წილი % = KPI" \
  "$(eqn "$(st margin_pct)" "$(kv margin_pct)"):$(eqn "$(echo "$SUM" | jq '.kinds[]|select(.kind=="state")|.share_pct')" "$(kv rev_state_pct)"):$(eqn "$(echo "$SUM" | jq '.kinds[]|select(.kind=="insurance")|.share_pct')" "$(kv rev_insurance_pct)")" "eq:eq:eq"
chk "განყოფილებების ჯამი = სულ; გადამხდელები + პაციენტი + დაუზუსტებელი = სულ; ბოლო თვე (13) = სულ" \
  "$(eqn "$(echo "$SUM" | jq '[.departments[].rev_net]|add // 0')" "$(st rev_net)"):$(eqn "$(echo "$SUM" | jq '([.payers[].amount]|add // 0) + (.kinds[]|select(.kind=="patient")|.amount) + (.kinds[]|select(.kind=="undetermined")|.amount)')" "$(st rev_net)"):$(eqn "$(echo "$SUM" | jq '.monthly[-1].rev_net')" "$(st rev_net)"):$(echo "$SUM" | jq '.monthly|length')" "eq:eq:eq:13"
chk "განყოფილებები: id / დასახელება — ტექსტი (UUID / null — „საერთო“)" "$(echo "$SUM" | jq -r '[.departments[]|((.department_id == null or (.department_id|type) == "string") and (.department_name|type) == "string")]|all')" "true"
chk "ფინანსების ხედვის გარეშე (ექთანი) → 403; from > to → 400" "$(code GET "/reporting/fin/summary?$M" "$NR"):$(code GET "/reporting/fin/summary?from=$TODAY&to=$PM" "$ADM")" "403:400"
api PUT /modules/finance "$ADM" -d '{"settings":{"dept_finance_visible":"off"},"reason":"ტესტ-E2E"}' >/dev/null
chk "dept_finance_visible = off → განყოფილების მომხმარებელი: FINANCE_HIDDEN (403), meta.scope.finance = false" \
  "$(code GET "/reporting/fin/summary?$M" "$T_REP"):$(ecode GET "/reporting/fin/summary?$M" "$T_REP"):$(api GET /reporting/meta "$T_REP" | jq -r .scope.finance)" "403:FINANCE_HIDDEN:false"
api PUT /modules/finance "$ADM" -d "{\"settings\":{\"dept_finance_visible\":$(echo "$O_FIN" | jq -c '.settings.dept_finance_visible // "heads"')},\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "heads → განყოფილების მომხმარებელი: 200, მხოლოდ თავისი განყოფილება" "$(code GET "/reporting/fin/summary?$M" "$T_REP"):$(api GET "/reporting/fin/summary?$M" "$T_REP" | jq -r --arg d "$DR" '[.departments[]|select(.department_id != $d)]|length')" "200:0"

step "3. დებიტორები / კრედიტორები"
BAL=$(api GET /reporting/fin/balances "$ADM"); RCV=$(api GET /finance/receivables "$ADM"); APA=$(api GET /payables/aging "$ADM")
chk "სურათი — დღეს; გადამხდელები = /finance/receivables (სულ, შეუტანელი, 90+)" \
  "$(echo "$BAL" | jq -r .snapshot_day):$(eqn "$(echo "$BAL" | jq .ar_payer.totals.total)" "$(echo "$RCV" | jq .totals.total)"):$(eqn "$(echo "$BAL" | jq .ar_payer.totals.unclaimed)" "$(echo "$RCV" | jq .totals.unclaimed)"):$(eqn "$(echo "$BAL" | jq .ar_payer.totals.d90)" "$(echo "$RCV" | jq .totals.d90)")" "$TODAY:eq:eq:eq"
chk "კრედიტორები = /payables/aging (სულ, 90+); თვის ბოლოს ტრენდი — ბოლო თვე = დღევანდელი" \
  "$(eqn "$(echo "$BAL" | jq .ap.totals.total)" "$(echo "$APA" | jq .totals.total)"):$(eqn "$(echo "$BAL" | jq .ap.totals.d90)" "$(echo "$APA" | jq .totals.d90)"):$(eqn "$(echo "$BAL" | jq '.trend[-1].ar_payer')" "$(echo "$BAL" | jq .ar_payer.totals.total)")" "eq:eq:eq"
chk "განყოფილების მომხმარებელი → BALANCES_ALL_ONLY (403); as_of=x → 400" "$(ecode GET /reporting/fin/balances "$T_REP"):$(code GET "/reporting/fin/balances?as_of=x" "$ADM")" "BALANCES_ALL_ONLY:400"

step "4. შემოსავალი ექიმზე"
DP=$(api GET "/reporting/fin/doctors?$M&basis=performer" "$ADM"); DF=$(api GET "/reporting/fin/doctors?$M&basis=referrer" "$ADM")
chk "შემსრულებელი = დამნიშნავი = შემოსავალი (წმინდა) — ჯამი იგივეა" \
  "$(eqn "$(echo "$DP" | jq .total_net)" "$(st rev_net)"):$(eqn "$(echo "$DF" | jq .total_net)" "$(st rev_net)"):$(eqn "$(echo "$DP" | jq '[.rows[].net]|add // 0')" "$(st rev_net)")" "eq:eq:eq"
chk "შემსრულებელი: ლაბორატორია ექიმზე არ მიეწერება (მხოლოდ „მითითებული არ არის“); რიგი — მიუწერელი ბოლოს" \
  "$(echo "$DP" | jq '[.rows[]|select(.unassigned|not)|.categories[]|select(.category=="lab")]|length'):$(echo "$DP" | jq '[.rows[]|.unassigned]|(index(true) // length) as $i | .[$i:]|all')" "0:true"
chk "reports_all → 200; განყოფილების მომხმარებელი (all_only) → DOCTOR_BREAKDOWN_ALL_ONLY; ექთანი → 403; basis=x → 400" \
  "$(code GET "/reporting/fin/doctors?$M" "$T_ALL"):$(ecode GET "/reporting/fin/doctors?$M" "$T_REP"):$(code GET "/reporting/fin/doctors?$M" "$NR"):$(code GET "/reporting/fin/doctors?$M&basis=x" "$ADM")" "200:DOCTOR_BREAKDOWN_ALL_ONLY:403:400"
api PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_breakdown":"scoped"},"reason":"ტესტ-E2E"}' >/dev/null
chk "scoped → განყოფილების მომხმარებელი 200 (თავისი განყოფილება); სხვა განყოფილება → 403" \
  "$(code GET "/reporting/fin/doctors?$M" "$T_REP"):$(code GET "/reporting/fin/doctors?$M&department_id=$(api GET "/reporting/fin/summary?$M" "$ADM" | jq -r --arg d "$DR" '[.departments[]|select(.department_id != null and .department_id != $d)][0].department_id // "00000000-0000-0000-0000-000000000000"')" "$T_REP")" "200:403"
api PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_revenue":"off","doctor_breakdown":"all_only"},"reason":"ტესტ-E2E"}' >/dev/null
chk "doctor_revenue = off → DOCTOR_REVENUE_OFF (admin-იც), ექსპორტიც 403" "$(ecode GET "/reporting/fin/doctors?$M" "$ADM"):$(code GET "/reporting/fin/export?dataset=doctors&$M" "$ADM")" "DOCTOR_REVENUE_OFF:403"
api PUT /modules/reporting "$ADM" -d '{"settings":{"doctor_revenue":"on"},"reason":"ტესტ-E2E"}' >/dev/null
chk "აუდიტი: REPORT_DOCTOR_REVENUE" "$(api GET "/audit-logs?entity_name=rpt_fact_doctor_rev&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_DOCTOR_REVENUE") != null')" "true"

step "5. ექსპორტი"
for ds in departments payers ar ap doctors; do
  curl -s -o "$TMP/$ds.xlsx" -w '%{http_code}' "$B/reporting/fin/export?dataset=$ds&$M&basis=performer" -H "authorization: Bearer $ADM" > "$TMP/$ds.code"
done
chk "xlsx: departments / payers / ar / ap / doctors — 200, zip (PK)" "$(for ds in departments payers ar ap doctors; do printf '%s%s ' "$(cat "$TMP/$ds.code")" "$(head -c 2 "$TMP/$ds.xlsx")"; done)" "200PK 200PK 200PK 200PK 200PK "
curl -s -o "$TMP/d.csv" "$B/reporting/fin/export?dataset=departments&format=csv&$M" -H "authorization: Bearer $ADM"
chk "csv: BOM, სათაური + განყოფილებები" "$(head -c 3 "$TMP/d.csv" | od -An -tx1 | tr -d ' '):$(( $(wc -l < "$TMP/d.csv") >= 2 ))" "efbbbf:1"
chk "უცნობი dataset → 400; ექთანი → 403; აუდიტი REPORT_EXPORT (fin_departments)" \
  "$(code GET "/reporting/fin/export?dataset=x&$M" "$ADM"):$(code GET "/reporting/fin/export?dataset=departments&$M" "$NR"):$(api GET "/audit-logs?entity_name=rpt_reports&entity_id=fin_departments&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_EXPORT") != null')" "400:403:true"

step "6. მენეჯერული ანგარიში (xlsx / PDF)"
P="from=$PM&to=$PM_END"
curl -s -o "$TMP/r.xlsx" -w '%{http_code}' "$B/reporting/report?$P&format=xlsx&doctors=1" -H "authorization: Bearer $ADM" > "$TMP/r.code"
chk "xlsx (წინა თვე, ექიმებით): 200, zip; ფურცლები — შეჯამება, ტრენდი, ფინანსები, დებიტორები, ექიმები — შემოსავალი" \
  "$(cat "$TMP/r.code")$(head -c 2 "$TMP/r.xlsx"):$(has_sheet "$TMP/r.xlsx" 'შეჯამება'):$(has_sheet "$TMP/r.xlsx" 'ტრენდი 13 თვე'):$(has_sheet "$TMP/r.xlsx" 'ფინანსები'):$(has_sheet "$TMP/r.xlsx" 'დებიტორები'):$(has_sheet "$TMP/r.xlsx" 'ექიმები — შემოსავალი')" "200PK:yes:yes:yes:yes:yes"
curl -s -o "$TMP/r2.xlsx" "$B/reporting/report?$P&format=xlsx" -H "authorization: Bearer $ADM"
chk "ექიმების გარეშე (doctors არ არის) — ექიმის ფურცელი არ არის; ფურცლების რაოდენობა ≥ 12" "$(has_sheet "$TMP/r2.xlsx" 'ექიმები — ქირურგი'):$(( $(sheets "$TMP/r2.xlsx" | tr '|' '\n' | wc -l) >= 12 ))" "no:1"
curl -s -o "$TMP/r.pdf" -w '%{http_code}' "$B/reporting/report?$P&format=pdf&doctors=1" -H "authorization: Bearer $ADM" > "$TMP/p.code"
PAGES=$(grep -a -c '/Type /Page$\|/Type /Page[^s]' "$TMP/r.pdf")
chk "PDF: 200, %PDF, 1–3 გვერდი, ექიმები PDF-ში არასოდეს" "$(cat "$TMP/p.code"):$(head -c 4 "$TMP/r.pdf"):$([ "$PAGES" -ge 1 ] && [ "$PAGES" -le 3 ] && echo ok || echo "$PAGES")" "200:%PDF:ok"
curl -s -o "$TMP/rd.xlsx" -w '%{http_code}' "$B/reporting/report?$P&format=xlsx&doctors=1" -H "authorization: Bearer $T_REP" > "$TMP/rd.code"
chk "განყოფილების მომხმარებელი: 200; ფინანსები (heads) — კი; დებიტორები / ექიმები (all_only) — არა" \
  "$(cat "$TMP/rd.code"):$(has_sheet "$TMP/rd.xlsx" 'ფინანსები'):$(has_sheet "$TMP/rd.xlsx" 'დებიტორები'):$(has_sheet "$TMP/rd.xlsx" 'ექიმები — მკურნალი')" "200:yes:no:no"
chk "ვალიდაცია: 1 წელზე მეტი / format=x → 400; ექთანი → 403" \
  "$(code GET "/reporting/report?from=$(date -d "$TODAY -400 day" +%F)&to=$TODAY&format=xlsx" "$ADM"):$(code GET "/reporting/report?$P&format=x" "$ADM"):$(code GET "/reporting/report?$P&format=pdf" "$NR")" "400:400:403"
chk "აუდიტი: REPORT_EXPORT (report)" "$(api GET "/audit-logs?entity_name=rpt_reports&entity_id=report&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|index("REPORT_EXPORT") != null')" "true"

step "7. განრიგით გაგზავნა (სატესტო გაშვება — ელფოსტის გარეშე)"
ME=$(api GET /auth/me "$ADM" | jq -r '.id // .user.id')
chk "ვალიდაცია: კვირის დღე 8 / უცნობი მიმღები → 400; განყოფილების მომხმარებელი → 403" \
  "$(code POST /reporting/schedules "$ADM" -d "{\"name\":\"ტესტ-E2E\",\"frequency\":\"weekly\",\"send_day\":8,\"recipients\":[\"$ME\"]}"):$(code POST /reporting/schedules "$ADM" -d '{"name":"ტესტ-E2E","frequency":"monthly","send_day":3,"recipients":["00000000-0000-0000-0000-000000000000"]}'):$(code GET /reporting/schedules "$T_REP")" "400:400:403"
SC=$(api POST /reporting/schedules "$ADM" -d "{\"name\":\"ტესტ-E2E განრიგი $S\",\"frequency\":\"monthly\",\"send_day\":3,\"send_hour\":9,\"include_doctors\":true,\"recipients\":[\"$U_ALL\",\"$U_REP\",\"$U_NR\"]}")
SID=$(echo "$SC" | jq -r '.id // empty'); [ -n "$SID" ] || die "განრიგი ვერ შეიქმნა: $SC"
# send_day 3 (სამუშაო დღე): ვადა გავიდა → პირველი ავტომატური — მომდევნო თვე (ეს თვე); თორემ — წინა თვე
DUE3=$(d=$MONTH; k=0; while :; do [ "$(date -d "$d" +%u)" -le 5 ] && k=$((k+1)); [ $k -eq 3 ] && break; d=$(date -d "$d +1 day" +%F); done; echo "$d")
NEXTP=$( { [ "$TODAY" \> "$DUE3" ] || { [ "$TODAY" = "$DUE3" ] && [ "$((10#$(date +%H)))" -ge 9 ]; }; } && echo "${MONTH:0:7}" || echo "${PM:0:7}")
chk "შეიქმნა: შემდეგი პერიოდი (ვადაგასული არ იგზავნება); 3 მიმღები; ფორმატი xlsx + pdf" "$(echo "$SC" | jq -r '"\(.next.period):\(.recipients|length):\(.formats|join("+"))"')" "$NEXTP:3:xlsx+pdf"
chk "მიმღებების სია: reports / reports_all — კი, ექთანი — არა" "$(api GET /reporting/recipients "$ADM" | jq -r --arg a "$U_ALL" --arg r "$U_REP" --arg n "$U_NR" '[map(.id)|index($a) != null, index($r) != null, index($n) != null]|map(tostring)|join(":")')" "true:true:false"
RUNR=$(api POST "/reporting/schedules/$SID/run" "$ADM" -d '{"dry_run":true}')
chk "სატესტო გაშვება: პერიოდი — წინა თვე; reports_all / reports — 2 ფაილი; ექთანი — გამოტოვდა (უფლება)" \
  "$(echo "$RUNR" | jq -r --arg a "$U_ALL" --arg r "$U_REP" --arg n "$U_NR" '"\(.period):\(.results[]|select(.user_id==$a)|.files|length):\(.results[]|select(.user_id==$r)|.files|length):\(.results[]|select(.user_id==$n)|.status)"')" "${PM:0:7}:2:2:skipped"
chk "მიწოდების ჟურნალი: 3 ჩანაწერი (ხელით, skipped)" "$(api GET "/reporting/deliveries?schedule_id=$SID" "$ADM" | jq -r '"\(length):\(map(.manual)|all):\(map(.status)|unique|join(","))"')" "3:true:skipped"
chk "ხელით გაშვება განრიგის მდგომარეობას (last_period) არ ცვლის" "$(api GET /reporting/schedules "$ADM" | jq -r --arg s "$SID" '.[]|select(.id==$s)|.last_period // "null"')" "$(echo "$SC" | jq -r '.last_period // "null"')"
chk "რედაქტირება (კვირეული, ორშაბათი) → შემდეგი პერიოდი — კვირა (YYYY-Www)" "$(api PATCH "/reporting/schedules/$SID" "$ADM" -d '{"frequency":"weekly","send_day":1,"is_active":false}' | jq -r '"\(.frequency):\(.is_active):\(.next.period|test("^[0-9]{4}-W[0-9]{2}$"))"')" "weekly:false:true"
chk "წაშლა → 200, მეორედ → 404; აუდიტი (შექმნა / გაშვება / წაშლა)" \
  "$(code DELETE "/reporting/schedules/$SID" "$ADM"):$(code DELETE "/reporting/schedules/$SID" "$ADM"):$(api GET "/audit-logs?entity_name=rpt_schedules&entity_id=$SID&limit=10" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|(index("REPORT_SCHEDULE_CREATE") != null and index("REPORT_SCHEDULE_RUN") != null and index("REPORT_SCHEDULE_DELETE") != null)')" "200:404:true"

step "8. „ყურადღების“ შეტყობინებები"
chk "attention_notify = off → 0" "$(api POST /reporting/attention/notify-me "$T_ALL" | jq -r .notified)" "0"
api PUT /modules/reporting "$ADM" -d '{"settings":{"attention_notify":"in_app","attention_notify_level":"all"},"reason":"ტესტ-E2E"}' >/dev/null
AT=$(api GET /reporting/attention "$T_ALL" | jq '.items|length'); N1=$(api POST /reporting/attention/notify-me "$T_ALL" | jq -r .notified)
NOT=$(api GET "/notifications?unread=true" "$T_ALL" | jq '[.[]|select(.kind=="rpt_attention")]|length')
chk "ჩართული (დონე all): „ყურადღების“ ელემენტი არის → 1 შეტყობინება (ზარი, rpt_attention, ≤ 1), არ არის → 0" "$NOT:$([ "$N1" -le 1 ] && echo ok)" "$([ "$AT" -gt 0 ] && echo 1 || echo 0):ok"
chk "იმავე დღეს მეორედ → 0 (დღეში ერთხელ); ექთანი → 403" "$(api POST /reporting/attention/notify-me "$T_ALL" | jq -r .notified):$(code POST /reporting/attention/notify-me "$NR")" "0:403"

step "9. აღდგენა"
api PUT /modules/reporting "$ADM" -d "{\"enabled\":$(echo "$O_RPT" | jq -c .enabled),\"settings\":$(echo "$O_RPT" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/finance "$ADM" -d "{\"enabled\":$(echo "$O_FIN" | jq -c .enabled),\"settings\":$(echo "$O_FIN" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
while read -r u; do api PATCH "/users/$u" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/users"
while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
api PATCH "/departments/$DR" "$ADM" -d '{"is_active":false}' >/dev/null
chk "მოდულები (reporting / finance) აღდგა" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|.settings' | jq -S -c .):$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings' | jq -S -c .)" \
  "$(echo "$O_RPT" | jq -S -c .settings):$(echo "$O_FIN" | jq -S -c .settings)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
