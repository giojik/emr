#!/usr/bin/env bash
# =====================================================================
# e2e-worklist-admin.sh — სამუშაო სიები, ეტაპი 2 (0082): ადმინისტრაცია / ლოჯისტიკის სისტემური წყაროები
#   პარამეტრები (ვალიდაცია), კატალოგი (51 წყარო), მარაგი (RQ: დამტკიცება → გაცემა → მიღება, SLA / urgent, dept_side heads / all,
#   უხელმძღვანელო განყოფილება, ჩამოწერა, ინვენტარიზაცია, ვადა, მინიმუმი, კარანტინი), შესყიდვები (PR: L1 → ფინანსური → PO-ს გარეშე → PO;
#   PO დამტკიცება, ვადაგადაცილებული PO), მომწოდებლის ინვოისი (შეჯერება, ვადა), პერიოდის დახურვა (period_lock), ტარიფი / გადამხდელის წესი
#   (approval = required), CSSD (Bowie-Dick, BI, ვადა განყოფილებაში, გაწვევა), ინვენტარი (გადაადგილება: პასუხისმგებელი → ხელმძღვანელი →
#   საწყობის მენეჯერი; ჩამოწერის აქტი), რეგისტრატურა (დაუხურავი ჩაწერა, გეგმიური ჰოსპიტალიზაცია, reg_scope), სალარო (override-ის ვალი),
#   A1 (admin / საწყობის მენეჯერი — მფლობელის არსებობისას არა), წყაროს გამორთვა, ყველა წყარო — 200.
# ბოლოს: სატესტო ჩანაწერები გაუქმებულია / გათიშულია; მოდულების პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-worklist-admin.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); TOMORROW=$(date -d "$TODAY +1 day" +%F); D1Y=$(date -d "$TODAY +1 year" +%F); D10=$(date -d "$TODAY +10 days" +%F)
PREVM=$(date -d "$(date -d "$TODAY" +%Y-%m-01) -1 day" +%Y-%m)
# ჩანაწერი „ჩემს დავალებებში“: <key> <token> → JSON / რაოდენობა
it()   { api GET "/worklist/mine?source=${1%%:*}" "$2" | jq -c --arg k "$1" '[.items[]|select(.key==$k)][0] // empty'; }
inm()  { api GET "/worklist/mine?source=${1%%:*}" "$2" | jq -r --arg k "$1" '[.items[]|select(.key==$k)]|length'; }
hrs()  { echo "$1" | jq -r 'if . == "" or .due_at == null then "null" else (((.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - (.created_at|sub("\\.[0-9]+Z$";"Z")|fromdate)) / 3600 | round) end'; }
wl()   { api PUT /modules/worklist "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
modset() { api PUT "/modules/$1" "$ADM" -d "{\"settings\":$2,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0082" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0082" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WA თერაპია $S\",\"code\":\"E2EAA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WA ქირურგია $S\",\"code\":\"E2EAB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DC=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WA CSSD $S\",\"code\":\"E2EAC$S\",\"type\":\"administrative\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] && [ -n "$DC" ] || die "განყოფილებები ვერ შეიქმნა"
for d in "$D1" "$D2" "$DC"; do echo "$d" >> "$TMP/deps"; done
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.wa.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ადმ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.wa.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_SK=$(mkrole wask "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole wasm "საწყობის მენეჯერი" '["stock_manager"]')
R_PRC=$(mkrole waprc "შესყიდვები" '["procurement"]'); R_FIN=$(mkrole wafin "ფინანსური დამტკიცება" '["procurement_approve"]')
R_TE=$(mkrole wate "ტარიფები" '["tariffs"]'); R_TA=$(mkrole wata "ტარიფის დამტკიცება" '["tariffs_approve"]'); R_ACC=$(mkrole waacc "ბუღალტერი" '["accountant"]')
[ -n "$R_SK" ] && [ -n "$R_SM" ] && [ -n "$R_PRC" ] && [ -n "$R_FIN" ] && [ -n "$R_TE" ] && [ -n "$R_TA" ] && [ -n "$R_ACC" ] || die "როლები ვერ შეიქმნა"
read -r SKID SK  <<< "$(mkuser "[\"$R_SK\"]" 51)"
read -r SMID SM  <<< "$(mkuser "[\"$R_SM\"]" 52)"
read -r PHID PH  <<< "$(mkuser '["pharmacist"]' 53)"
read -r HDID HD  <<< "$(mkuser '["nurse"]' 54 ",\"department_id\":\"$D1\",\"is_section_head\":true")"
read -r NRID NR  <<< "$(mkuser '["nurse"]' 55 ",\"department_id\":\"$D1\"")"
read -r N2ID N2  <<< "$(mkuser '["nurse"]' 56 ",\"department_id\":\"$D2\"")"
read -r PRCID PRC <<< "$(mkuser "[\"$R_PRC\"]" 57)"
read -r FINID FIN <<< "$(mkuser "[\"$R_FIN\"]" 58)"
read -r ACCID ACC <<< "$(mkuser "[\"$R_ACC\"]" 59)"
read -r BLID BL  <<< "$(mkuser '["billing"]' 60)"
read -r TEID TE  <<< "$(mkuser "[\"$R_TE\"]" 61)"
read -r TAID TA  <<< "$(mkuser "[\"$R_TA\"]" 62)"
read -r RCID RC  <<< "$(mkuser '["receptionist"]' 63)"
read -r C1ID C1  <<< "$(mkuser '["nurse"]' 64 ",\"department_id\":\"$DC\"")"
TC=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2E_WA_$S\",\"title\":\"ტესტ-E2E კონსულტაცია (WA)\",\"base_price\":10}" | jq -r '.id // empty')
read -r DOCID DOC <<< "$(mkuser '["doctor"]' 65 ",\"department_id\":\"$D1\",\"specialty\":\"თერაპევტი\",\"license_number\":\"MD-WA$S\",\"consultation_tariff_id\":\"$TC\"")"
for t in SK SM PH HD NR N2 PRC FIN ACC BL TE TA RC C1 DOC; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "15 მომხმარებელი (საწყობი, ფარმაცევტი, D1: ხელმძღვანელი + ექთანი, D2: ექთანი — ხელმძღვანელის გარეშე, შესყიდვები, ფინანსები, ტარიფები, რეგისტრატურა, CSSD, ექიმი)"
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"5$(printf '%010d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ადმ-პაციენტი\",\"birth_date\":\"1979-03-03\",\"gender\":\"female\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] || die "პაციენტი ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM")
orig() { echo "$ORIG" | jq -c --arg c "$1" '.[]|select(.code==$c)|{enabled, settings}'; }
for m in worklist stock procurement finance tariffs cssd asset_register; do [ -n "$(orig $m)" ] || die "მოდული $m ვერ მოიძებნა"; done
api PUT /modules/worklist "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
wl '{"sources":{},"dept_side":"heads","stk_expiry_days":30,"sla_hours":{"stk_approve":24,"stk_issue":24,"stk_receive":24,"stk_urgent":4,"proc_approve":48,"asset_move":72},"period_close_day":10,"claim_build_day":5,"ipd_finalize_days":3,"appt_open_days":2,"debt_days":30,"reg_scope":"all","bi_due_hours":48}'

step "1. პარამეტრები, კატალოგი"
chk "dept_side / sla_hours (უცნობი გასაღები) / period_close_day 29 / reg_scope — 400" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"dept_side":"x"},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"sla_hours":{"foo":1}},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"period_close_day":29},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"reg_scope":"clinic"},"reason":"ტესტ"}')" "400:400:400:400"
REFS=$(api GET /worklist/refs "$NR")
chk "კატალოგი: 51 წყარო; ახალი ჯგუფები (მარაგი / შესყიდვები / ფინანსები / CSSD / ინვენტარი / რეგისტრატურა); core — ჩართული" "$(echo "$REFS" | jq -r '.sources|length'):$(echo "$REFS" | jq -r '[.sources[].group]|unique|map(select(.=="მარაგი" or .=="შესყიდვები" or .=="ფინანსები" or .=="CSSD" or .=="ინვენტარი" or .=="რეგისტრატურა / სალარო"))|length'):$(echo "$REFS" | jq -r '.sources[]|select(.code=="reg_appt").module_enabled')" "51:6:true"
chk "ყველა ახალი წყარო — ?source → 200" "$(for c in stk_approve stk_issue stk_receive stk_writeoff stk_count stk_expiry stk_min stk_empties stk_quarantine proc_pr_approve proc_pr_order proc_po_approve proc_po_overdue ap_match ap_due fin_claim_due fin_claim_resolve fin_claim_build fin_period bill_finalize tariff_approve cssd_recall cssd_expiry cssd_bi cssd_bd asset_move asset_writeoff reg_appt reg_planned cash_debt; do code GET "/worklist/mine?source=$c" "$ADM"; echo; done | sort -u | tr '\n' ' ')" "200 "

step "2. მარაგი: მოთხოვნა → დამტკიცება → გაცემა → მიღება"
modset stock '{"lost_requires_approval":true}' >/dev/null
SREFS=$(api GET /stock/refs "$SM"); cat_id() { echo "$SREFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
WC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_WAC_$S\",\"name\":\"ტესტ-E2E WA საწყობი $S\",\"kind\":\"central\",\"requires_approval\":false}" | jq -r '.id // empty')
SUB1=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_WA1_$S\",\"name\":\"ტესტ-E2E WA ქვესაწყობი D1 $S\",\"kind\":\"department\",\"department_id\":\"$D1\",\"requires_approval\":true}" | jq -r '.id // empty')
SUB2=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_WA2_$S\",\"name\":\"ტესტ-E2E WA ქვესაწყობი D2 $S\",\"kind\":\"department\",\"department_id\":\"$D2\",\"requires_approval\":false}" | jq -r '.id // empty')
G1=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E WA ცეფტრიაქსონი $S\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\"}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E WA Ceftriaxone $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$G1\",\"base_unit\":\"vial\"}" | jq -r '.id // empty')
for l in "$WC" "$SUB1" "$SUB2"; do echo "$l" >> "$TMP/locs"; done
RCP=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$WC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":50,\"lot_no\":\"WA$S\",\"expires_on\":\"$D1Y\",\"price\":4,\"vat_rate\":0},{\"item_id\":\"$MED\",\"qty\":5,\"lot_no\":\"WS$S\",\"expires_on\":\"$D10\",\"price\":4,\"vat_rate\":0,\"short_expiry_reason\":\"ტესტ-E2E: მოკლე ვადა\"}]}" | jq -r '.id // empty')
[ -n "$WC" ] && [ -n "$SUB1" ] && [ -n "$SUB2" ] && [ -n "$MED" ] && [ "$(api POST "/stock/receipts/$RCP/post" "$SK" | jq -r .status)" = "posted" ] \
  && ok "ლოკაციები (საწყობი, D1 — დამტკიცებით, D2 — დამტკიცების გარეშე), საქონელი, მიღება (2 ლოტი, ერთი — 10 დღის ვადით)" || die "მარაგის მონაცემები ვერ შეიქმნა"
RQ=$(api POST /stock/requests "$NR" -d "{\"from_location_id\":\"$WC\",\"to_location_id\":\"$SUB1\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":10}]}" | jq -r '.id // empty')
api POST "/stock/requests/$RQ/submit" "$NR" >/dev/null
X=$(it "stk_approve:$RQ" "$HD")
chk "stk_approve: D1-ის ხელმძღვანელს (ჩვეულებრივი, ვადა +24 სთ, ბმული); ექთანს / საწყობის მენეჯერს / მესაწყობეს — არა" "$(echo "$X" | jq -r '"\(.priority):\(.link|test("/stock/requests\\?req="))"'):$(hrs "$X"):$(inm "stk_approve:$RQ" "$NR"):$(inm "stk_approve:$RQ" "$SM"):$(inm "stk_approve:$RQ" "$SK")" "normal:true:24:0:0:0"
RQU=$(api POST /stock/requests "$NR" -d "{\"from_location_id\":\"$WC\",\"to_location_id\":\"$SUB1\",\"urgent\":true,\"notes\":\"ტესტ-E2E სასწრაფო\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":1}]}" | jq -r '.id // empty')
api POST "/stock/requests/$RQU/submit" "$NR" >/dev/null
X=$(it "stk_approve:$RQU" "$HD")
chk "სასწრაფო RQ: პრიორიტეტი სასწრაფო, ვადა +4 სთ (stk_urgent)" "$(echo "$X" | jq -r .priority):$(hrs "$X")" "urgent:4"
wl '{"sla_hours":{"stk_approve":0,"stk_urgent":0}}'
chk "sla_hours = 0 → ვადის გარეშე" "$(it "stk_approve:$RQ" "$HD" | jq -r .due_at)" "null"
wl '{"sla_hours":{"stk_approve":24,"stk_issue":24,"stk_receive":24,"stk_urgent":4,"proc_approve":48,"asset_move":72},"sources":{"stk_approve":false}}'
chk "წყარო გამორთულია (sources.stk_approve = false) → არ ჩანს" "$(inm "stk_approve:$RQ" "$HD")" "0"
wl '{"sources":{}}'
api POST "/stock/requests/$RQ/approve" "$HD" -d '{}' >/dev/null
chk "დამტკიცების შემდეგ: ხელმძღვანელთან ქრება; stk_issue — მესაწყობეს და საწყობის მენეჯერს (საწყობის მფლობელები); ფარმაცევტს — არა" "$(inm "stk_approve:$RQ" "$HD"):$(inm "stk_issue:$RQ" "$SK"):$(inm "stk_issue:$RQ" "$SM"):$(inm "stk_issue:$RQ" "$PH")" "0:1:1:0"
PK=$(api GET "/stock/requests/$RQ/pick" "$SK"); LN=$(echo "$PK" | jq -r '.lines[0].request_line_id // .lines[0].id'); LT=$(echo "$PK" | jq -r ".lines[0].lots[]|select(.lot_no==\"WS$S\").lot_id")
I1=$(api POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$LN\",\"lot_id\":\"$LT\",\"qty_base\":2}]}")
TR=$(echo "$I1" | jq -r '[.docs[]|select(.receive_status==null)][0].id // empty')
chk "ნაწილობრივი გაცემა: stk_issue რჩება („ნაწილობრივ გაცემული“)" "$(it "stk_issue:$RQ" "$SK" | jq -r '.detail|test("ნაწილობრივ")')" "true"
chk "stk_receive (heads): D1-ის ხელმძღვანელს; ექთანს / საწყობის მენეჯერს — არა" "$(inm "stk_receive:$TR" "$HD"):$(inm "stk_receive:$TR" "$NR"):$(inm "stk_receive:$TR" "$SM")" "1:0:0"
wl '{"dept_side":"all"}'
chk "dept_side = all → ექთანსაც" "$(inm "stk_receive:$TR" "$NR")" "1"
wl '{"dept_side":"heads"}'
chk "მიღება → ქრება" "$(api POST "/stock/docs/$TR/receive" "$NR" -d '{"action":"receive"}' | jq -r .receive_status):$(inm "stk_receive:$TR" "$HD")" "received:0"
api POST "/stock/requests/$RQ/cancel" "$NR" -d '{"reason":"ტესტ-E2E: დანარჩენი აღარ სჭირდება"}' >/dev/null
chk "მოთხოვნის დახურვა → stk_issue ქრება" "$(inm "stk_issue:$RQ" "$SK")" "0"
RQ2=$(api POST /stock/requests "$N2" -d "{\"from_location_id\":\"$WC\",\"to_location_id\":\"$SUB2\",\"notes\":\"ტესტ-E2E D2\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":1}]}" | jq -r '.id // empty')
api POST "/stock/requests/$RQ2/submit" "$N2" >/dev/null
PK=$(api GET "/stock/requests/$RQ2/pick" "$SK"); LN=$(echo "$PK" | jq -r '.lines[0].request_line_id // .lines[0].id'); LT=$(echo "$PK" | jq -r ".lines[0].lots[]|select(.lot_no==\"WS$S\").lot_id")
TR2=$(api POST "/stock/requests/$RQ2/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$LN\",\"lot_id\":\"$LT\",\"qty_base\":1}]}" | jq -r '[.docs[]|select(.receive_status==null)][0].id // empty')
chk "უხელმძღვანელო განყოფილება (D2): stk_receive — რიგით წევრს; საწყობის მენეჯერს — არა" "$(inm "stk_receive:$TR2" "$N2"):$(inm "stk_receive:$TR2" "$SM")" "1:0"
api POST "/stock/docs/$TR2/receive" "$N2" -d '{"action":"receive"}' >/dev/null

step "3. მარაგი: ჩამოწერა, ინვენტარიზაცია, ვადა, მინიმუმი, კარანტინი"
LOTA=$(api GET "/stock/balances?location_id=$SUB1&item_id=$MED" "$SM" | jq -r '.rows[0].lot_id // empty')
WO=$(api POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB1\",\"writeoff_reason\":\"lost\",\"notes\":\"ტესტ-E2E: ვერ მოიძებნა\",\"lines\":[{\"lot_id\":\"$LOTA\",\"qty_base\":1}]}" | jq -r '.id // empty')
X=$(it "stk_writeoff:$WO" "$SM")
chk "stk_writeoff (დაკარგული): საწყობის მენეჯერს (მაღალი); მესაწყობეს / ავტორს — არა" "$(echo "$X" | jq -r .priority):$(inm "stk_writeoff:$WO" "$SK"):$(inm "stk_writeoff:$WO" "$NR")" "high:0:0"
api POST "/stock/writeoffs/$WO/decide" "$SM" -d '{"approve":false,"reason":"ტესტ-E2E: მოიძებნა"}' >/dev/null
chk "უარი → ქრება" "$(inm "stk_writeoff:$WO" "$SM")" "0"
CT=$(api POST /stock/counts "$SK" -d "{\"location_id\":\"$WC\",\"notes\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
chk "stk_count (ღია): დამწყებს („დასასრულებელი“); საწყობის მენეჯერს — არა" "$(it "stk_count:$CT" "$SK" | jq -r '.title|test("დასასრულებელი")'):$(inm "stk_count:$CT" "$SM")" "true:0"
api POST "/stock/counts/$CT/cancel" "$SM" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაუქმება → ქრება" "$(inm "stk_count:$CT" "$SK")" "0"
X=$(it "stk_expiry:$WC" "$SK")
chk "stk_expiry (ლოკაციაზე): მესაწყობეს — „იწურება 30 დღეში: 1 ლოტი“, ჩვეულებრივი; D1-ის ხელმძღვანელს — არა" "$(echo "$X" | jq -r '"\(.detail|test("იწურება 30 დღეში: 1")):\(.priority):\(.due_date_only)"'):$(inm "stk_expiry:$WC" "$HD")" "true:normal:true:0"
wl '{"stk_expiry_days":5}'
chk "stk_expiry_days = 5 → ჯერ არ ჩანს (ვადა 10 დღეში)" "$(inm "stk_expiry:$WC" "$SK")" "0"
wl '{"stk_expiry_days":30}'
api PUT /stock/minmax "$HD" -d "{\"location_id\":\"$SUB1\",\"item_id\":\"$MED\",\"min_qty\":100,\"max_qty\":200}" >/dev/null
chk "stk_min: D1-ის ხელმძღვანელს (დილის შეტყობინების წესით); ექთანს / საწყობის მენეჯერს — არა" "$(inm "stk_min:$SUB1" "$HD"):$(inm "stk_min:$SUB1" "$NR"):$(inm "stk_min:$SUB1" "$SM")" "1:0:0"
LQ=$(api GET "/stock/balances?location_id=$WC&item_id=$MED" "$SM" | jq -r ".rows[]|select(.lot_no==\"WA$S\").lot_id")
api POST "/stock/lots/$LQ/status" "$PH" -d '{"status":"quarantine","reason":"ტესტ-E2E: ეჭვი ხარისხზე"}' >/dev/null
chk "stk_quarantine: საწყობის მენეჯერს და ფარმაცევტს; მესაწყობეს — არა" "$(inm "stk_quarantine:$LQ" "$SM"):$(inm "stk_quarantine:$LQ" "$PH"):$(inm "stk_quarantine:$LQ" "$SK")" "1:1:0"
api POST "/stock/lots/$LQ/status" "$SM" -d '{"status":"active","reason":"ტესტ-E2E: შემოწმდა"}' >/dev/null
chk "გააქტიურება → ქრება" "$(inm "stk_quarantine:$LQ" "$SM")" "0"

step "4. შესყიდვები"
modset procurement '{"po_mode":"optional","pr_approval_levels":2,"pr_finance_threshold":1000,"controlled_pharmacist":true,"po_overdue_alert":true}' >/dev/null
SUP=$(api POST /stock/suppliers "$SM" -d "{\"name\":\"ტესტ-E2E WA მომწოდებელი $S\",\"tax_id\":\"4$(printf '%08d' "$((10#$S))")\",\"vat_payer\":false,\"payment_terms_days\":1}" | jq -r '.id // empty')
PR=$(api POST /procurement/requisitions "$SK" -d "{\"location_id\":\"$WC\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":200,\"est_price\":10,\"supplier_id\":\"$SUP\"}]}" | jq -r '.id // empty')
api POST "/procurement/requisitions/$PR/submit" "$SK" >/dev/null
chk "proc_pr_approve: L1 — საწყობის მენეჯერს („დონე 1“); ფინანსურს (L1-მდე) / ავტორს — არა" "$(it "proc_pr_approve:$PR" "$SM" | jq -r '.title|test("დონე 1")'):$(inm "proc_pr_approve:$PR" "$FIN"):$(inm "proc_pr_approve:$PR" "$SK")" "true:0:0"
api POST "/procurement/requisitions/$PR/approve" "$SM" -d '{}' >/dev/null
X=$(it "proc_pr_approve:$PR" "$FIN")
chk "L1-ის შემდეგ: ფინანსურს („ფინანსური“, ვადა +48 სთ); საწყობის მენეჯერთან ქრება" "$(echo "$X" | jq -r '.title|test("ფინანსური")'):$(hrs "$X"):$(inm "proc_pr_approve:$PR" "$SM")" "true:48:0"
api POST "/procurement/requisitions/$PR/approve" "$FIN" -d '{}' >/dev/null
chk "დამტკიცებული, PO-ს გარეშე → proc_pr_order შესყიდვებს; ფინანსურთან ქრება" "$(inm "proc_pr_order:$PR" "$PRC"):$(inm "proc_pr_approve:$PR" "$FIN")" "1:0"
OS=$(api POST "/procurement/requisitions/$PR/orders" "$PRC")
chk "PR → PO (მონახაზი) → proc_pr_order ქრება" "$(inm "proc_pr_order:$PR" "$PRC")" "0"
for o in $(echo "$OS" | jq -r '(.orders // .)[]?.id? // empty' 2>/dev/null); do api POST "/procurement/orders/$o/cancel" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null; done
PO=$(api POST /procurement/orders "$PRC" -d "{\"supplier_id\":\"$SUP\",\"location_id\":\"$WC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":300,\"price\":9.5,\"vat_rate\":0}]}" | jq -r '.id // empty')
api POST "/procurement/orders/$PO/send" "$PRC" >/dev/null
chk "PO ზღვარს ზემოთ → proc_po_approve ფინანსურს; ავტორს — არა" "$(inm "proc_po_approve:$PO" "$FIN"):$(inm "proc_po_approve:$PO" "$PRC")" "1:0"
api POST "/procurement/orders/$PO/approve" "$FIN" >/dev/null
chk "დამტკიცება → ქრება" "$(inm "proc_po_approve:$PO" "$FIN")" "0"
api POST "/procurement/orders/$PO/cancel" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
PO3=$(api POST /procurement/orders "$PRC" -d "{\"supplier_id\":\"$SUP\",\"location_id\":\"$WC\",\"order_date\":\"$(date -d "$TODAY -5 days" +%F)\",\"expected_date\":\"$(date -d "$TODAY -1 day" +%F)\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":1,\"price\":9.5,\"vat_rate\":0}]}" | jq -r '.id // empty')
api POST "/procurement/orders/$PO3/send" "$PRC" >/dev/null
X=$(it "proc_po_overdue:$PO3" "$PRC")
chk "proc_po_overdue: ავტორს / შესყიდვებს (ვადაგადაცილებული); საწყობის მენეჯერს (შესყიდვები არსებობს) — არა" "$(echo "$X" | jq -r .overdue):$(inm "proc_po_overdue:$PO3" "$SM")" "true:0"
api POST "/procurement/orders/$PO3/cancel" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაუქმება → ქრება" "$(inm "proc_po_overdue:$PO3" "$PRC")" "0"

step "5. ფინანსები: მომწოდებლის ინვოისი, პერიოდი"
INV=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"WA-$S\",\"invoice_date\":\"$TODAY\",\"total\":118,\"total_vat\":18,\"lines\":[{\"description\":\"ტესტ-E2E მომსახურება\",\"category\":\"სხვა\",\"department_id\":\"$D1\",\"amount\":118,\"vat_rate\":18}]}" | jq -r '.id // empty')
api POST "/payables/invoices/$INV/post" "$ACC" >/dev/null
X=$(it "ap_due:$INV" "$ACC")
chk "ap_due: ბუღალტერს (ვადა — ხვალ, ნაშთი 118); ბილინგს — არა" "$(echo "$X" | jq -r '"\(.detail|test("118.00")):\(.due_date_only)"'):$(inm "ap_due:$INV" "$BL")" "true:true:0"
api POST "/payables/invoices/$INV/void" "$ACC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაუქმება → ქრება" "$(inm "ap_due:$INV" "$ACC")" "0"
RCM=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$WC\",\"supplier_id\":\"$SUP\",\"invoice_no\":\"WM-$S\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":10,\"lot_no\":\"WM$S\",\"expires_on\":\"$D1Y\",\"price\":10,\"vat_rate\":0}]}" | jq -r '.id // empty')
api POST "/stock/receipts/$RCM/post" "$SK" >/dev/null
INM=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"WM-$S\",\"invoice_date\":\"$TODAY\",\"total\":130,\"receipts\":[\"$RCM\"]}" | jq -r '.id // empty')
api POST "/payables/invoices/$INM/post" "$ACC" >/dev/null
chk "ap_match: შეჯერება არ ემთხვევა (130 ≠ 100) → ბუღალტერს, მაღალი" "$(it "ap_match:$INM" "$ACC" | jq -r .priority)" "high"
api POST "/payables/invoices/$INM/accept-match" "$ACC" -d '{"reason":"ტესტ-E2E: მიტანის ხარჯი"}' >/dev/null
chk "შეჯერების დადასტურება → ქრება" "$(inm "ap_match:$INM" "$ACC")" "0"
api POST "/payables/invoices/$INM/void" "$ACC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
modset finance '{"period_lock":"off"}' >/dev/null
chk "period_lock = off → fin_period არ ჩანს" "$(inm "fin_period:$PREVM" "$ACC")" "0"
modset finance '{"period_lock":"on"}' >/dev/null
EXP=$(api GET /finance/periods "$ACC" | jq -r --arg m "$PREVM" '[.periods[]|select(.month==$m and .status=="closed")]|if length>0 then 0 else 1 end')
chk "period_lock = on → წინა თვე ($PREVM), თუ ღიაა — ბუღალტერს; ბილინგს — არა" "$(inm "fin_period:$PREVM" "$ACC"):$(inm "fin_period:$PREVM" "$BL")" "$EXP:0"
api PUT /modules/finance "$ADM" -d "$(orig finance | jq -c '{settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null

step "6. ტარიფები: გადამხდელის წესის ვერსია (approval = required)"
INS=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EWA$S\",\"name\":\"ტესტ-E2E WA დაზღვევა $S\",\"kind\":\"insurance\",\"default_mode\":\"percent\",\"default_coverage_pct\":70,\"default_deductible\":0}" | jq -r '.id // empty')
modset tariffs '{"tariff_change_approval":"required"}' >/dev/null
VR=$(api POST "/payer-rules/$INS/versions" "$TE" -d "{\"valid_from\":\"$TOMORROW\",\"mode\":\"percent\",\"coverage_pct\":80,\"reason\":\"ტესტ-E2E ხვალიდან\"}")
CHG=$(api GET "/tariff-changes?status=pending" "$TA" | jq -r --arg n "$(echo "$VR" | jq -r .change_no)" '.[]|select(.change_no==$n)|.id')
X=$(it "tariff_approve:$CHG" "$TA")
chk "tariff_approve: დამმტკიცებელს (ვადა — valid_from-ის წინა დღე); ავტორს / admin-ს — არა" "$(echo "$X" | jq -r '"\(.title|test("გადამხდელის წესი")):\(.due_at != null)"'):$(inm "tariff_approve:$CHG" "$TE"):$(inm "tariff_approve:$CHG" "$ADM")" "true:true:0:0"
api POST "/tariff-changes/$CHG/reject" "$TA" -d '{"note":"ტესტ-E2E უარი"}' >/dev/null
chk "უარყოფა → ქრება" "$(inm "tariff_approve:$CHG" "$TA")" "0"
api PUT /modules/tariffs "$ADM" -d "$(orig tariffs | jq -c '{settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null

step "7. CSSD"
modset cssd '{"wash_record":false,"auto_consume":false,"bd_required":true,"bi_hold":"implant","shelf_life_mode":"time"}' >/dev/null
UNIT=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_WAZ_$S\",\"name\":\"ტესტ-E2E WA CSSD $S\",\"kind\":\"cssd\",\"department_id\":\"$DC\"}" | jq -r '.id // empty'); echo "$UNIT" >> "$TMP/locs"
PKG=$(api POST /cssd/packaging "$SM" -d "{\"name\":\"ტესტ-E2E WA პაკეტი $S\",\"shelf_days\":5}" | jq -r '.id // empty')
AUTO=$(api POST /cssd/machines "$SM" -d "{\"name\":\"ტესტ-E2E WA ავტოკლავი $S\",\"kind\":\"steam\",\"location_id\":\"$UNIT\",\"programs\":[{\"name\":\"134° 5 წთ\",\"temp\":134,\"minutes\":5}]}" | jq -r '.id // empty')
TL=$(api POST /cssd/templates "$SM" -d "{\"code\":\"E2E-WA-$S\",\"name\":\"ტესტ-E2E WA ნაკრები\",\"packaging_type_id\":\"$PKG\",\"items\":[{\"name\":\"მაკრატელი\",\"qty\":1}]}" | jq -r '.id // empty')
SETS=$(api POST /cssd/sets "$SM" -d "{\"template_id\":\"$TL\",\"home_location_id\":\"$UNIT\",\"count\":2}"); L1=$(echo "$SETS" | jq -r '.[0].id'); L2=$(echo "$SETS" | jq -r '.[1].id')
[ -n "$UNIT" ] && [ -n "$PKG" ] && [ -n "$AUTO" ] && [ -n "$TL" ] && [ -n "$L1" ] && ok "CSSD ერთეული (DC), შეფუთვა 5 დღე, ავტოკლავი, 2 ნაკრები" || bad "CSSD მონაცემები ვერ შეიქმნა" "$UNIT/$PKG/$AUTO/$TL/$L1"
chk "cssd_bd: ერთეულის თანამშრომელს (მაღალი); საწყობის მენეჯერს (stock_manager, განყოფილების გარეშე) — არა" "$(it "cssd_bd:$AUTO" "$C1" | jq -r .priority):$(inm "cssd_bd:$AUTO" "$SM")" "high:0"
api POST /cssd/cycles "$C1" -d "{\"machine_id\":\"$AUTO\",\"kind\":\"bowie_dick\",\"result\":\"pass\"}" >/dev/null
chk "Bowie-Dick გაიარა → ქრება" "$(inm "cssd_bd:$AUTO" "$C1")" "0"
api POST /cssd/receive "$C1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\",\"$L2\"]}" >/dev/null
P1=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$L1\"}" | jq -r '.id // empty'); P2=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$L2\"}" | jq -r '.id // empty')
CY=$(api POST /cssd/cycles "$C1" -d "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"bi_used\":true,\"pack_ids\":[\"$P1\",\"$P2\"]}" | jq -r '.id // empty')
X=$(it "cssd_bi:$CY" "$C1")
chk "cssd_bi: BI მოლოდინშია → ერთეულის თანამშრომელს (ვადა +48 სთ); D1-ის ხელმძღვანელს — არა" "$( [ -n "$X" ] && echo "$X" | jq -r '((.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - now) / 3600 | round' ):$(inm "cssd_bi:$CY" "$HD")" "48:0"
api POST /cssd/issue "$C1" -d "{\"location_id\":\"$UNIT\",\"department_id\":\"$D1\",\"pack_ids\":[\"$P1\",\"$P2\"]}" >/dev/null
chk "cssd_expiry: განყოფილებაში გაცემული, ვადა ≤ 7 დღე → D1-ის ხელმძღვანელს; ექთანს (heads) — არა" "$(inm "cssd_expiry:$P1" "$HD"):$(inm "cssd_expiry:$P1" "$NR")" "1:0"
api POST "/cssd/cycles/$CY/bi" "$C1" -d '{"result":"fail"}' >/dev/null
X=$(it "cssd_recall:$P1" "$HD")
chk "BI ჩავარდა → cssd_recall (სასწრაფო) D1-ის ხელმძღვანელს და CSSD-ს; cssd_expiry / cssd_bi ქრება" "$(echo "$X" | jq -r .priority):$(inm "cssd_recall:$P1" "$C1"):$(inm "cssd_expiry:$P1" "$HD"):$(inm "cssd_bi:$CY" "$C1")" "urgent:1:0:0"
api POST "/cssd/packs/$P1/return" "$HD" >/dev/null; api POST "/cssd/packs/$P2/return" "$HD" >/dev/null
chk "CSSD-ში დაბრუნება → ქრება" "$(inm "cssd_recall:$P1" "$HD")" "0"
api PUT /modules/cssd "$ADM" -d "$(orig cssd | jq -c '{settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null

step "8. ინვენტარი"
modset asset_register '{"move_mode":"confirm","writeoff_mode":"single","require_room":false,"require_responsible":false}' >/dev/null
api PUT /modules/asset_register "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
CAT=$(api GET /assets/refs "$SK" | jq -r '.categories[]|select(.code=="FURNITURE").id')
A1=$(api POST /assets "$SK" -d "{\"name\":\"ტესტ-E2E WA მაგიდა $S\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"101\",\"responsible_user_id\":\"$HDID\"}" | jq -r '.id // empty')
A2=$(api POST /assets "$SK" -d "{\"name\":\"ტესტ-E2E WA სკამი $S\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"101\"}" | jq -r '.id // empty')
[ -n "$A1" ] && [ -n "$A2" ] || bad "ინვენტარი ვერ შეიქმნა" "$CAT"
M1=$(api POST "/assets/$A1/move" "$SK" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"201\",\"to_responsible_id\":\"$N2ID\",\"reason\":\"ტესტ-E2E: გადატანა\"}" | jq -r '.move_id // empty')
X=$(it "asset_move:$M1" "$N2")
chk "asset_move: მიმღებ პასუხისმგებელს (ვადა +72 სთ); D1-ის ხელმძღვანელს / საწყობის მენეჯერს — არა" "$(hrs "$X"):$(inm "asset_move:$M1" "$HD"):$(inm "asset_move:$M1" "$SM")" "72:0:0"
api POST "/assets/moves/$M1/cancel" "$SK" >/dev/null
M2=$(api POST "/assets/$A2/move" "$SK" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"102\",\"reason\":\"ტესტ-E2E: ოთახი\"}" | jq -r '.move_id // empty')
chk "პასუხისმგებლის გარეშე → მიმღები განყოფილების ხელმძღვანელს; ექთანს / საწყობის მენეჯერს — არა" "$(inm "asset_move:$M2" "$HD"):$(inm "asset_move:$M2" "$NR"):$(inm "asset_move:$M2" "$SM")" "1:0:0"
api POST "/assets/moves/$M2/cancel" "$SK" >/dev/null
M3=$(api POST "/assets/$A2/move" "$SK" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"202\",\"reason\":\"ტესტ-E2E: D2\"}" | jq -r '.move_id // empty')
chk "უხელმძღვანელო განყოფილება (D2), პასუხისმგებლის გარეშე → საწყობის მენეჯერს; D2-ის წევრს — არა" "$(inm "asset_move:$M3" "$SM"):$(inm "asset_move:$M3" "$N2")" "1:0"
api POST "/assets/moves/$M3/cancel" "$SK" >/dev/null
chk "გაუქმება → ქრება" "$(inm "asset_move:$M3" "$SM")" "0"
AW=$(api POST /assets/writeoffs "$ADM" -d "{\"asset_ids\":[\"$A2\"],\"reason\":\"ტესტ-E2E: დაზიანდა\"}" | jq -r '.id // empty')
chk "asset_writeoff (single): საწყობის მენეჯერს; მესაწყობეს — არა" "$(inm "asset_writeoff:$AW" "$SM"):$(inm "asset_writeoff:$AW" "$SK")" "1:0"
api POST "/assets/writeoffs/$AW/vote" "$SM" -d '{"approve":false,"note":"ტესტ-E2E: არ ჩამოიწეროს"}' >/dev/null
chk "უარი → ქრება" "$(inm "asset_writeoff:$AW" "$SM")" "0"
api PUT /modules/asset_register "$ADM" -d "$(orig asset_register | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null

step "9. რეგისტრატურა / სალარო"
ST=$(TZ=Asia/Tbilisi date -d '-90 minutes' +%Y-%m-%dT%H:%M:00+04:00)
AP=$(api POST /appointments "$RC" -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOCID\",\"scheduled_start\":\"$ST\",\"duration_minutes\":20,\"reason\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
chk "reg_appt: დრო გავიდა, სტატუსი დაუხურავია → რეგისტრატორს (ვადაგადაცილებული); ექიმს / admin-ს — არა" "$(it "reg_appt:$AP" "$RC" | jq -r .overdue):$(inm "reg_appt:$AP" "$DOC"):$(inm "reg_appt:$AP" "$ADM")" "true:0:0"
wl '{"reg_scope":"department"}'
chk "reg_scope = department → განყოფილების გარეშე რეგისტრატორს — არა" "$(inm "reg_appt:$AP" "$RC")" "0"
wl '{"reg_scope":"all"}'
api PATCH "/appointments/$AP" "$RC" -d '{"status":"no_show"}' >/dev/null
chk "„არ გამოცხადდა“ → ქრება" "$(inm "reg_appt:$AP" "$RC")" "0"
PL=$(api POST /inpatient/planned "$RC" -d "{\"patient_id\":\"$PAT\",\"department_id\":\"$D1\",\"doctor_id\":\"$DOCID\",\"planned_date\":\"$TODAY\",\"reason\":\"ტესტ-E2E გეგმიური\"}" | jq -r '.id // empty')
chk "reg_planned (დღეს): რეგისტრატორს და D1-ის ხელმძღვანელს; ექთანს (heads) — არა" "$(it "reg_planned:$PL" "$RC" | jq -r '.title|test("დღეს")'):$(inm "reg_planned:$PL" "$HD"):$(inm "reg_planned:$PL" "$NR")" "true:1:0"
api POST "/inpatient/planned/$PL/cancel" "$RC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაუქმება → ქრება" "$(inm "reg_planned:$PL" "$RC")" "0"
ENC=$(api POST /encounters/walk-in "$RC" -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOCID\"}" | jq -r '.encounter_id // empty')
api POST "/encounters/$ENC/payment-override" "$ADM" -d '{"reason":"ტესტ-E2E: გადაიხდის მოგვიანებით"}' >/dev/null
X=$(it "cash_debt:$ENC" "$RC")
chk "cash_debt: გადახდის ნებართვით გახსნილი ვიზიტი (ვალი 10 ₾) → რეგისტრატორს და ბილინგს; ექთანს — არა" "$(echo "$X" | jq -r '"\(.title|test("10.00")):\(.link|test("/cashier/"))"'):$(inm "cash_debt:$ENC" "$BL"):$(inm "cash_debt:$ENC" "$NR")" "true:true:1:0"
INVE=$(api GET "/encounters/$ENC" "$RC" | jq -r '.invoice.id // empty')
api POST "/invoices/$INVE/payments" "$RC" -d '{"amount":10,"method":"cash"}' >/dev/null
chk "გადახდა → ქრება" "$(inm "cash_debt:$ENC" "$RC")" "0"

step "10. admin, მთვლელი"
chk "admin-ს (მხოლოდ admin) ახალ წყაროებში არაფერი" "$(api GET /worklist/mine "$ADM" | jq -r '[.items[]|select(.source|test("^(stk|proc|ap|fin|bill|tariff|cssd|asset|reg|cash)_"))]|length')" "0"
chk "მთვლელი ითვლის სისტემურ ჩანაწერებს (D1-ის ხელმძღვანელი: სასწრაფო RQ)" "$(api GET /worklist/count "$HD" | jq -r '.urgent >= 1')" "true"

step "11. გასუფთავება"
api POST "/stock/requests/$RQU/cancel" "$NR" -d '{"reason":"ტესტ-E2E"}' >/dev/null
api POST "/procurement/requisitions/$PR/close" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
api PUT /stock/minmax "$HD" -d "{\"location_id\":\"$SUB1\",\"item_id\":\"$MED\",\"min_qty\":0,\"max_qty\":0}" >/dev/null
for m in worklist stock procurement; do api PUT "/modules/$m" "$ADM" -d "$(orig $m | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null; done
chk "პარამეტრები აღდგენილია (worklist)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}')" "$(orig worklist)"
[ -f "$TMP/locs" ] && while read -r l; do api PATCH "/stock/locations/$l" "$SM" -d '{"is_active":false}' >/dev/null; done < "$TMP/locs"
[ -f "$TMP/users" ] && while read -r u; do api PATCH "/users/$u" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/users"
[ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
[ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
ok "სატესტო ჩანაწერები გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
