#!/usr/bin/env bash
# =====================================================================
# e2e-procurement.sh — ფინანსები და შესყიდვები, ეტაპი 1 (0051): შესყიდვები
#   მომწოდებლის პირობები (IBAN, ვადები), ფასთა ნუსხა (გადაფარვა, მინიშნებები), შესყიდვის მოთხოვნა (PR): მონახაზი → გაგზავნა → დამტკიცება
#   (დონე 1 / ფინანსური ზღვრით / ფარმაცევტი კონტროლირებადზე; საკუთარი — არა; დონე 1 და 2 — სხვადასხვა პირი), უარი, გაუქმება, დახურვა;
#   თავისუფალი ხაზი → კატალოგი; PR → PO; მინ/მაქს → PR (შეკვეთილის გათვალისწინებით); RQ-ის დეფიციტი → PR;
#   PO: პირდაპირი (ზღვარს ზემოთ — ფინანსური დამტკიცება / დაბრუნება), ვალუტა, გაგზავნა, გაუქმება, დახურვა;
#   მიღება PO-დან (ფასის გადახრა + მიზეზი, ზედმეტი რაოდენობა warn / block, მომწოდებელი / სტატუსი), ნაწილობრივი → მიღებული, შემობრუნება;
#   po_mode = required (მიზეზით — მხოლოდ მენეჯერი) / off; ვადაგადაცილება (შეტყობინება ერთხელ); მოდულის გამორთვა; აუდიტი
# ცალკე სატესტო ლოკაციებზე; ბოლოს მიღებები შემობრუნდება (ნაშთი 0), პარამეტრები ბრუნდება, მონაცემები ითიშება.
# შენიშვნა: სატესტო დოკუმენტები იკავებს PR / PO / RC / RV ნომრებს — ეს ნორმაა.
# გამოყენება:  bash scripts/e2e-procurement.sh [API_URL]
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
read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F); D5=$(date -d "$TODAY +5 days" +%F)
DM10=$(date -d "$TODAY -10 days" +%F); DM3=$(date -d "$TODAY -3 days" +%F)

step "0. მომზადება"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.proc.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"შესყიდვა-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.proc.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole psk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole psm "საწყობის მენეჯერი" '["stock_manager"]')
R_PR=$(mkrole ppr "შესყიდვები" '["procurement"]'); R_FN=$(mkrole pfn "ფინანსური დამტკიცება" '["procurement_approve"]')
R_BO=$(mkrole pbo "მენეჯერი + ფინანსური" '["stock_manager","procurement_approve"]')
SK=$(mkuser "[\"$R_SK\"]" 81); SM=$(mkuser "[\"$R_SM\"]" 82); PRC=$(mkuser "[\"$R_PR\"]" 83); FIN=$(mkuser "[\"$R_FN\"]" 84)
BOTH=$(mkuser "[\"$R_BO\"]" 85); PH=$(mkuser '["pharmacist"]' 86); NR=$(mkuser '["nurse"]' 87)
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PRC" ] && [ -n "$FIN" ] && [ -n "$BOTH" ] && [ -n "$PH" ] && [ -n "$NR" ] && ok "როლები (შესყიდვები, ფინანსური დამტკიცება — ახალი უფლებები) + 7 მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="procurement")|.settings')
[ -n "$ORIG" ] && [ "$ORIG" != "null" ] || die "მოდული procurement ვერ მოიძებნა (0051?)"
rules(){ api PUT /modules/procurement "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }
rules '{"po_mode":"optional","pr_approval_levels":2,"pr_finance_threshold":1000,"controlled_pharmacist":true,"price_tolerance_pct":5,"qty_over_delivery":"warn","po_overdue_alert":true}' >/dev/null
chk "პარამეტრი: უცნობი მნიშვნელობა — 400; მენეჯერი — 403" "$(code PUT /modules/procurement "$ADM" -d '{"settings":{"po_mode":"always"},"reason":"ტესტ"}'):$(code PUT /modules/procurement "$SM" -d '{"settings":{"po_mode":"off"},"reason":"ტესტ"}')" "400:403"
REFS=$(api GET /stock/refs "$SM")
cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_PC_$S\",\"name\":\"ტესტ-E2E ცენტრალური $S\",\"kind\":\"central\",\"requires_approval\":false}" | jq -r '.id // empty')
LOC2=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_PO_$S\",\"name\":\"ტესტ-E2E სხვა $S\",\"kind\":\"other\",\"requires_approval\":false}" | jq -r '.id // empty')
GEN=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ცეფტრიაქსონი $S\",\"form_code\":\"CAP\",\"strength\":\"1 გ\"}" | jq -r '.id // empty')
GNA=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ფენტანილი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"0.05 მგ/მლ\",\"controlled_class\":\"narcotic\",\"dose_unit\":\"mcg\",\"dose_per_unit\":100}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Ceftriaxone $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$GEN\",\"base_unit\":\"capsule\",\"packs\":[{\"name\":\"კოლოფი\",\"qty_base\":10,\"is_receipt_default\":true}]}" | jq -r '.id // empty')
BOX=$(api GET "/stock/items/$MED" "$SM" | jq -r '.packs[0].id')
NAR=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Fentanyl $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$GNA\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty')
HOU=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E კათეტერი $S\",\"category_id\":\"$(cat_id HOUSE)\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
SUP1=$(api POST /stock/suppliers "$SM" -d "{\"name\":\"ტესტ-E2E შპს ფარმა $S\",\"tax_id\":\"7$(printf '%08d' "$((10#$S))")\",\"vat_payer\":true}" | jq -r '.id // empty')
SUP2=$(api POST /stock/suppliers "$SM" -d "{\"name\":\"ტესტ-E2E შპს მედტექ $S\",\"tax_id\":\"6$(printf '%08d' "$((10#$S))")\",\"vat_payer\":false}" | jq -r '.id // empty')
[ -n "$LOC" ] && [ -n "$LOC2" ] && [ -n "$MED" ] && [ -n "$NAR" ] && [ -n "$HOU" ] && [ -n "$SUP1" ] && [ -n "$SUP2" ] && [ -n "$BOX" ] && ok "ლოკაციები, საქონელი (მედიკამენტი, ნარკოტიკული, სამეურნეო), 2 მომწოდებელი" || die "მონაცემები ვერ შეიქმნა"

step "1. მომწოდებლის პირობები"
chk "IBAN არასწორი — 400" "$(code PATCH "/stock/suppliers/$SUP1" "$SM" -d '{"iban":"GE12"}')" "400"
chk "გადახდის ვადა 30, მიწოდება 5 დღე, IBAN, ხელშეკრულება" "$(api PATCH "/stock/suppliers/$SUP1" "$SM" -d '{"payment_terms_days":30,"lead_time_days":5,"iban":"GE29NB0000000101904917","bank_name":"ტესტ ბანკი","contract_no":"C-'"$S"'"}' | jq -r '"\(.payment_terms_days):\(.lead_time_days):\(.iban)"')" "30:5:GE29NB0000000101904917"

step "2. მომწოდებლის ფასთა ნუსხა"
P1=$(api POST /procurement/prices "$PRC" -d "{\"supplier_id\":\"$SUP1\",\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"price\":100,\"vat_rate\":18,\"valid_from\":\"$TODAY\"}" | jq -r '.id // empty')
[ -n "$P1" ] && ok "ფასი: მომწოდებელი 1, კოლოფი = 100 ₾ (დღგ-ს გარეშე)" || bad "ფასი ვერ შეიქმნა"
chk "იგივე პერიოდში მეორე ფასი — 409; ვადა დაწყებამდე — 400; ექთანი — 403" \
  "$(code POST /procurement/prices "$PRC" -d "{\"supplier_id\":\"$SUP1\",\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"price\":90,\"valid_from\":\"$D5\"}"):$(code POST /procurement/prices "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"item_id\":\"$MED\",\"price\":9,\"valid_from\":\"$D5\",\"valid_to\":\"$TODAY\"}"):$(code POST /procurement/prices "$NR" -d "{\"supplier_id\":\"$SUP2\",\"item_id\":\"$MED\",\"price\":9,\"valid_from\":\"$TODAY\"}")" "409:400:403"
P2=$(api POST /procurement/prices "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"item_id\":\"$MED\",\"price\":9.5,\"vat_rate\":0,\"valid_from\":\"$TODAY\"}" | jq -r '.id // empty')
chk "მინიშნება: ორივე ფასი იაფიდან (საბაზოზე 9.5 → 10)" "$(api GET "/procurement/price-hints?item_id=$MED" "$SK" | jq -r '[.prices[]|.base_price|tonumber+0]|join(",")')" "9.5,10"
chk "მინიშნება მომწოდებლით — 1" "$(api GET "/procurement/price-hints?item_id=$MED&supplier_id=$SUP1" "$SK" | jq -r '.prices|length')" "1"
chk "ფასთა ნუსხა: მოქმედი, საქონლით" "$(api GET "/procurement/prices?item_id=$MED&current=true" "$PRC" | jq -r 'length')" "2"

step "3. შესყიდვის მოთხოვნა (PR): მონახაზი → გაგზავნა → დამტკიცება"
PRB="{\"location_id\":\"$LOC\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":3,\"est_price\":100,\"supplier_id\":\"$SUP1\"},{\"free_name\":\"ტესტ-E2E ახალი კათეტერი\",\"qty\":20}]}"
chk "ექთანი — 403; ხაზი დასახელების გარეშე — 400" "$(code POST /procurement/requisitions "$NR" -d "$PRB"):$(code POST /procurement/requisitions "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"qty\":1}]}")" "403:400"
PR1=$(api POST /procurement/requisitions "$SK" -d "$PRB" | jq -r '.id // empty')
chk "მონახაზი: 2 ხაზი (კოლოფი → 30 საბაზო; თავისუფალი)" "$(api GET "/procurement/requisitions/$PR1" "$SK" | jq -r '"\(.status):\(.lines|length):\(.lines[0].qty_base|tonumber+0):\(.lines[1].item_id)"')" "draft:2:30:null"
chk "გაგზავნა ფასის გარეშე — 400" "$(code POST "/procurement/requisitions/$PR1/submit" "$SK")" "400"
api PUT "/procurement/requisitions/$PR1" "$SK" -d "$(echo "$PRB" | jq -c '.lines[1].est_price=2')" >/dev/null
R=$(api POST "/procurement/requisitions/$PR1/submit" "$SK")
chk "გაგზავნა: PR-ნომერი, ჯამი 340, ფინანსური არ სჭირდება (≤ 1000)" "$(echo "$R" | jq -r '"\(.status):\(.pr_no|test("^PR[0-9]{2}-[0-9]{6}$")):\(.est_total|tonumber+0):\(.needs_finance):\(.needs_pharmacist):\(.pending|join(","))"')" "submitted:true:340:false:false:l1"
PR1NO=$(echo "$R" | jq -r .pr_no)
chk "გაგზავნილის რედაქტირება — 409; მეორედ გაგზავნა — 409" "$(code PUT "/procurement/requisitions/$PR1" "$SK" -d "$PRB"):$(code POST "/procurement/requisitions/$PR1/submit" "$SK")" "409:409"
chk "საწყობის მენეჯერს — შეტყობინება" "$(api GET /notifications "$SM" | jq -r "[.[]|select(.kind==\"proc_pr_approve\" and (.title|contains(\"$PR1NO\")))]|length")" "1"
chk "დასამტკიცებელი სია (მენეჯერი)" "$(api GET '/procurement/requisitions?to_approve=true' "$SM" | jq -r "[.[]|select(.id==\"$PR1\")]|length")" "1"
chk "მესაწყობე ვერ ამტკიცებს — 403; ფარმაცევტი (მისი ნაბიჯი არ არის) — 403" "$(code POST "/procurement/requisitions/$PR1/approve" "$SK" -d '{}'):$(code POST "/procurement/requisitions/$PR1/approve" "$PH" -d '{}')" "403:403"
chk "მენეჯერი ამტკიცებს → approved" "$(api POST "/procurement/requisitions/$PR1/approve" "$SM" -d '{}' | jq -r '"\(.status):\(.l1_by_name|test("შესყიდვა-82"))"')" "approved:true"
chk "ავტორს — შეტყობინება „დამტკიცდა“" "$(api GET /notifications "$SK" | jq -r "[.[]|select(.kind==\"proc_pr_done\" and (.title|contains(\"$PR1NO\")))]|length")" "1"

step "4. PR → PO (თავისუფალი ხაზი, მომწოდებელი)"
chk "თავისუფალი ხაზი კატალოგის გარეშე — 400" "$(code POST "/procurement/requisitions/$PR1/orders" "$PRC")" "400"
L2=$(api GET "/procurement/requisitions/$PR1" "$PRC" | jq -r '.lines[1].id')
chk "ხაზის რაოდენობის შეცვლა დამტკიცების შემდეგ — შეუძლებელია (მხოლოდ საქონელი / მომწოდებელი / ფასი)" "$(api PATCH "/procurement/requisitions/$PR1/lines/$L2" "$PRC" -d "{\"item_id\":\"$HOU\"}" | jq -r '"\(.lines[1].item_name|test("კათეტერი")):\(.lines[1].qty_base|tonumber+0)"')" "true:20"
chk "მომწოდებლის გარეშე — 400" "$(code POST "/procurement/requisitions/$PR1/orders" "$PRC")" "400"
api PATCH "/procurement/requisitions/$PR1/lines/$L2" "$PRC" -d "{\"supplier_id\":\"$SUP1\"}" >/dev/null
PO1=$(api POST "/procurement/requisitions/$PR1/orders" "$PRC" | jq -r '.orders[0] // empty')
R=$(api GET "/procurement/orders/$PO1" "$PRC")
chk "PO: მომწოდებელი 1, მონახაზი, 2 ხაზი, მოსალოდნელი = დღეს + 5" "$(echo "$R" | jq -r '"\(.status):\(.supplier_id):\(.lines|length):\(.expected_date)"')" "draft:$SUP1:2:$D5"
chk "ფასი ფასთა ნუსხიდან (კოლოფი 100 → 10/საბაზო), თავისუფალი — PR-ის 2 ₾; ჯამი 340 + დღგ 61.2" "$(echo "$R" | jq -r '"\(.lines[0].price|tonumber+0):\(.lines[0].unit_cost_gel|tonumber+0):\(.lines[1].price|tonumber+0):\(.total_net|tonumber+0):\(.total_vat|tonumber+0):\(.total_gel|tonumber+0)"')" "100:10:2:340:61.2:340"
chk "PR: შეკვეთილია სრულად, PO მიბმულია; ხელახლა — 409" "$(api GET "/procurement/requisitions/$PR1" "$PRC" | jq -r '"\([.lines[]|(.qty_ordered|tonumber+0)==(.qty_base|tonumber+0)]|all):\(.orders|length)"'):$(code POST "/procurement/requisitions/$PR1/orders" "$PRC")" "true:1:409"

step "5. ფინანსური დამტკიცება (ზღვარს ზემოთ), სხვადასხვა პირი, საკუთარი"
PR2=$(api POST /procurement/requisitions "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":600,\"est_price\":10,\"supplier_id\":\"$SUP2\"}]}" | jq -r '.id // empty')
chk "6000 ₾ > 1000 → ფინანსური საჭიროა" "$(api POST "/procurement/requisitions/$PR2/submit" "$SK" | jq -r '"\(.needs_finance):\(.pending|join(","))"')" "true:l1,finance"
chk "ფინანსური დონე 1-მდე — 403" "$(code POST "/procurement/requisitions/$PR2/approve" "$FIN" -d '{}')" "403"
chk "დონე 1 → ჯერ კიდევ გაგზავნილი; ფინანსურს — შეტყობინება" "$(api POST "/procurement/requisitions/$PR2/approve" "$SM" -d '{}' | jq -r '"\(.status):\(.pending|join(","))"'):$(api GET /notifications "$FIN" | jq -r '[.[]|select(.kind=="proc_pr_approve")]|length>0')" "submitted:finance:true"
chk "მენეჯერი ფინანსურს ვერ აწერს — 403" "$(code POST "/procurement/requisitions/$PR2/approve" "$SM" -d '{"step":"finance"}')" "403"
chk "ფინანსური → approved" "$(api POST "/procurement/requisitions/$PR2/approve" "$FIN" -d '{}' | jq -r '"\(.status):\(.finance_by_name|test("შესყიდვა-84"))"')" "approved:true"
PR2B=$(api POST /procurement/requisitions "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":200,\"est_price\":10}]}" | jq -r '.id // empty')
api POST "/procurement/requisitions/$PR2B/submit" "$SK" >/dev/null
api POST "/procurement/requisitions/$PR2B/approve" "$BOTH" -d '{}' >/dev/null
chk "ორივე უფლების მქონე: დონე 1 ხელმოწერილია, ფინანსური იმავე პირით — 403" "$(code POST "/procurement/requisitions/$PR2B/approve" "$BOTH" -d '{}')" "403"
chk "სხვა ფინანსური → approved" "$(api POST "/procurement/requisitions/$PR2B/approve" "$FIN" -d '{}' | jq -r .status)" "approved"
PR3=$(api POST /procurement/requisitions "$SM" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":5,\"est_price\":1}]}" | jq -r '.id // empty')
api POST "/procurement/requisitions/$PR3/submit" "$SM" >/dev/null
chk "საკუთარს ავტორი ვერ ამტკიცებს — 403" "$(code POST "/procurement/requisitions/$PR3/approve" "$SM" -d '{}')" "403"
chk "უარი მიზეზის გარეშე — 400; მიზეზით — rejected" "$(code POST "/procurement/requisitions/$PR3/reject" "$BOTH" -d '{}'):$(api POST "/procurement/requisitions/$PR3/reject" "$BOTH" -d '{"reason":"ტესტ-E2E: არ არის საჭირო"}' | jq -r .status)" "400:rejected"
chk "ავტორს — შეტყობინება უარზე" "$(api GET /notifications "$SM" | jq -r '[.[]|select(.kind=="proc_pr_done" and (.title|contains("უარყოფილია")))]|length')" "1"
rules '{"pr_approval_levels":1}' >/dev/null
PR4=$(api POST /procurement/requisitions "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":900,\"est_price\":10}]}" | jq -r '.id // empty')
chk "ერთი დონე (pr_approval_levels = 1): 9000 ₾ — ფინანსური არ სჭირდება" "$(api POST "/procurement/requisitions/$PR4/submit" "$SK" | jq -r .needs_finance)" "false"
rules '{"pr_approval_levels":2}' >/dev/null
chk "გაუქმება: მიზეზის გარეშე — 400; მიზეზით — cancelled" "$(code POST "/procurement/requisitions/$PR4/cancel" "$SK" -d '{}'):$(api POST "/procurement/requisitions/$PR4/cancel" "$SK" -d '{"reason":"ტესტ-E2E"}' | jq -r .status)" "400:cancelled"

step "6. კონტროლირებადი → ფარმაცევტის დადასტურება"
PR5=$(api POST /procurement/requisitions "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$NAR\",\"qty\":10,\"est_price\":5}]}" | jq -r '.id // empty')
chk "ნარკოტიკული → ფარმაცევტი საჭიროა" "$(api POST "/procurement/requisitions/$PR5/submit" "$SK" | jq -r '"\(.needs_pharmacist):\(.pending|join(","))"')" "true:l1,pharmacist"
chk "ფარმაცევტს — შეტყობინება" "$(api GET /notifications "$PH" | jq -r '[.[]|select(.kind=="proc_pr_approve" and (.title|contains("კონტროლირებადი")))]|length>0')" "true"
chk "მენეჯერის შემდეგ — ელოდება ფარმაცევტს; ფარმაცევტი → approved" "$(api POST "/procurement/requisitions/$PR5/approve" "$SM" -d '{}' | jq -r '"\(.status):\(.pending|join(","))"'):$(api POST "/procurement/requisitions/$PR5/approve" "$PH" -d '{}' | jq -r .status)" "submitted:pharmacist:approved"
chk "დახურვა: მესაწყობე — 403; შესყიდვები — closed" "$(code POST "/procurement/requisitions/$PR5/close" "$SK" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/procurement/requisitions/$PR5/close" "$PRC" -d '{"reason":"ტესტ-E2E: აღარ სჭირდება"}' | jq -r .status)" "403:closed"

step "7. მინ/მაქს → PR (შეკვეთილის გათვალისწინებით)"
api PUT /stock/minmax "$SM" -d "{\"location_id\":\"$LOC\",\"item_id\":\"$HOU\",\"min_qty\":50,\"max_qty\":100}" >/dev/null
MM=$(api GET "/stock/minmax?location_id=$LOC" "$SM" | jq -c ".[]|select(.item_id==\"$HOU\")")
chk "PO-ს მონახაზში 20 ცალი — „შეკვეთილი“; შეთავაზება 80" "$(echo "$MM" | jq -r '"\(.on_order|tonumber+0):\(.below):\(.suggested)"')" "20:true:80"
R=$(api POST /procurement/requisitions/from-minmax "$SK" -d "{\"location_id\":\"$LOC\"}")
PR6=$(echo "$R" | jq -r '.id // empty')
chk "PR მინ/მაქს-იდან: წყარო minmax, 80 ცალი" "$(echo "$R" | jq -r '"\(.source):\(.lines|length):\(.lines[0].qty_base|tonumber+0)"')" "minmax:1:80"
chk "PR-იც ითვლება — აღარ არის ქვემოთ; მეორედ — 409" "$(api GET "/stock/minmax?location_id=$LOC" "$SM" | jq -r ".[]|select(.item_id==\"$HOU\")|.below"):$(code POST /procurement/requisitions/from-minmax "$SK" -d "{\"location_id\":\"$LOC\"}")" "false:409"

step "8. განყოფილების მოთხოვნის (RQ) დეფიციტი → PR"
RQ=$(api POST /stock/requests "$SM" -d "{\"from_location_id\":\"$LOC\",\"to_location_id\":\"$LOC2\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":30}]}" | jq -r '.id // empty')
api POST "/stock/requests/$RQ/submit" "$SM" >/dev/null
R=$(api POST /procurement/requisitions/from-request "$SK" -d "{\"request_id\":\"$RQ\"}")
PR7=$(echo "$R" | jq -r '.id // empty')
chk "PR გამცემ ლოკაციაზე: წყარო request, 30 (მარაგი 0), RQ-ის ხაზთან ბმა" "$(echo "$R" | jq -r '"\(.source):\(.location_id):\(.lines[0].qty_base|tonumber+0):\(.lines[0].request_line_id!=null):\(.req_no|test("^RQ"))"')" "request:$LOC:30:true:true"
chk "მეორედ — 409 (უკვე გადაცემულია)" "$(code POST /procurement/requisitions/from-request "$SK" -d "{\"request_id\":\"$RQ\"}")" "409"

step "9. PO PR-ის გარეშე: ფინანსური დამტკიცება, დაბრუნება, ვალუტა"
POB="{\"supplier_id\":\"$SUP2\",\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":300,\"price\":9.5,\"vat_rate\":0}]}"
chk "მესაწყობე PO-ს ვერ ქმნის — 403" "$(code POST /procurement/orders "$SK" -d "$POB")" "403"
PO2=$(api POST /procurement/orders "$PRC" -d "$POB" | jq -r '.id // empty')
R=$(api POST "/procurement/orders/$PO2/send" "$PRC")
chk "2850 ₾ PR-ის გარეშე → დასამტკიცებელი (pending), PO-ნომერი" "$(echo "$R" | jq -r '"\(.status):\(.po_no|test("^PO[0-9]{2}-[0-9]{6}$")):\(.needs_approval):\(.total_gel|tonumber+0)"')" "pending:true:true:2850"
PO2NO=$(echo "$R" | jq -r .po_no)
chk "დასამტკიცებლის რედაქტირება — 409; შესყიდვები ვერ ამტკიცებს — 403" "$(code PUT "/procurement/orders/$PO2" "$PRC" -d "$POB"):$(code POST "/procurement/orders/$PO2/approve" "$PRC")" "409:403"
chk "ფინანსურს: მიმოხილვაში 1 PO + შეტყობინება" "$(api GET /procurement/summary "$FIN" | jq -r '.po_to_approve>=1'):$(api GET /notifications "$FIN" | jq -r "[.[]|select(.kind==\"proc_po_approve\" and (.title|contains(\"$PO2NO\")))]|length")" "true:1"
chk "დაბრუნება მიზეზის გარეშე — 400; მიზეზით → მონახაზი (ნომერი რჩება)" "$(code POST "/procurement/orders/$PO2/return" "$FIN" -d '{}'):$(api POST "/procurement/orders/$PO2/return" "$FIN" -d '{"reason":"ტესტ-E2E: ფასი გადაამოწმეთ"}' | jq -r '"\(.status):\(.po_no)"')" "400:draft:$PO2NO"
api POST "/procurement/orders/$PO2/send" "$PRC" >/dev/null
chk "ხელახლა გაგზავნა → pending → ფინანსური ამტკიცებს → sent" "$(api POST "/procurement/orders/$PO2/approve" "$FIN" | jq -r '"\(.status):\(.approved_by_name|test("შესყიდვა-84"))"')" "sent:true"
PO3=$(api POST /procurement/orders "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":10,\"price\":9.5,\"vat_rate\":0}]}" | jq -r '.id // empty')
chk "ზღვარს ქვემოთ (95 ₾) → მაშინვე sent" "$(api POST "/procurement/orders/$PO3/send" "$PRC" | jq -r '"\(.status):\(.needs_approval)"')" "sent:false"
chk "გაგზავნილის რედაქტირება — 409" "$(code PUT "/procurement/orders/$PO3" "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"location_id\":\"$LOC\",\"lines\":[]}")" "409"
chk "USD კურსის გარეშე — 400; კურსით 2.7: 10 × 10$ = 270 ₾" "$(code POST /procurement/orders "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"location_id\":\"$LOC\",\"currency\":\"USD\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":10,\"price\":10,\"vat_rate\":0}]}"):$(api POST /procurement/orders "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"location_id\":\"$LOC\",\"currency\":\"USD\",\"fx_rate\":2.7,\"lines\":[{\"item_id\":\"$MED\",\"qty\":10,\"price\":10,\"vat_rate\":0}]}" | tee "$TMP/usd" | jq -r '"\(.total_net|tonumber+0):\(.total_gel|tonumber+0):\(.lines[0].unit_cost_gel|tonumber+0)"')" "400:100:270:27"
api POST "/procurement/orders/$(jq -r .id "$TMP/usd")/cancel" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაგზავნილი, მიღების გარეშე — გაუქმება" "$(api POST "/procurement/orders/$PO3/cancel" "$PRC" -d '{"reason":"ტესტ-E2E: მომწოდებელმა უარი თქვა"}' | jq -r .status)" "cancelled"

step "10. მიღება შეკვეთიდან: ფასის გადახრა, ნაწილობრივი, ზედმეტი რაოდენობა"
chk "PO1 (PR-იდან, 340 ₾) → sent" "$(api POST "/procurement/orders/$PO1/send" "$PRC" | jq -r .status)" "sent"
chk "ექთანი — 403" "$(code POST "/procurement/orders/$PO1/receipt" "$NR")" "403"
RC=$(api POST "/procurement/orders/$PO1/receipt" "$SK")
RC1=$(echo "$RC" | jq -r '.id // empty')
chk "RC-ის მონახაზი: PO-ზე მიბმული, 2 ხაზი (კოლოფი 3 × 100, 20 × 2)" "$(echo "$RC" | jq -r '"\(.po_id):\(.supplier_id):\(.lines|length):\(.lines[0].qty|tonumber+0):\(.lines[0].price|tonumber+0):\(.lines[1].qty|tonumber+0):\(.lines[0].po_line_id!=null)"')" "$PO1:$SUP1:2:3:100:20:true"
PL1=$(echo "$RC" | jq -r '.lines[0].po_line_id'); PL2=$(echo "$RC" | jq -r '.lines[1].po_line_id')
RCB() { echo "{\"location_id\":\"$LOC\",\"supplier_id\":\"$1\",\"po_id\":\"$PO1\",\"prices_include_vat\":false,\"invoice_no\":\"INV-$S\",\"lines\":[$2]}"; }
LMED() { echo "{\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":$1,\"lot_no\":\"$2\",\"expires_on\":\"$D2Y\",\"price\":$3,\"vat_rate\":18,\"po_line_id\":\"$PL1\"${4:+,\"price_reason\":\"$4\"}}"; }
LHOU="{\"item_id\":\"$HOU\",\"qty\":20,\"price\":2,\"vat_rate\":18,\"po_line_id\":\"$PL2\"}"
R=$(api PUT "/stock/receipts/$RC1" "$SK" -d "$(RCB "$SUP1" "$(LMED 2 "PA$S" 112),$LHOU")")
chk "ფასი +12% (> 5%) — შეცდომა, გატარება 400" "$(echo "$R" | jq -r '[.issues[]|select(.code=="po_price")|.level]|join(",")'):$(code POST "/stock/receipts/$RC1/post" "$SK")" "error:400"
R=$(api PUT "/stock/receipts/$RC1" "$SK" -d "$(RCB "$SUP1" "$(LMED 2 "PA$S" 112 "ფასი გაიზარდა"),$LHOU")")
chk "მიზეზით — გაფრთხილება" "$(echo "$R" | jq -r '[.issues[]|select(.code=="po_price")|.level]|join(",")')" "warn"
chk "გატარება → PO ნაწილობრივ მიღებული (20 + 20)" "$(api POST "/stock/receipts/$RC1/post" "$SK" | jq -r .status):$(api GET "/procurement/orders/$PO1" "$PRC" | jq -r '"\(.status):\(.lines[0].qty_received|tonumber+0):\(.lines[1].qty_received|tonumber+0):\(.receipts|length)"')" "posted:partial:20:20:1"
RC2=$(api POST "/procurement/orders/$PO1/receipt" "$SK" | jq -r '.id // empty')
chk "მეორე RC: მხოლოდ დარჩენილი — 1 კოლოფი" "$(api GET "/stock/docs/$RC2" "$SK" | jq -r '"\(.lines|length):\(.lines[0].qty|tonumber+0)"')" "1:1"
R=$(api PUT "/stock/receipts/$RC2" "$SK" -d "$(RCB "$SUP1" "$(LMED 2 "PB$S" 100)")")
chk "შეკვეთილზე მეტი (40 > 30) — გაფრთხილება (warn)" "$(echo "$R" | jq -r '[.issues[]|select(.code=="po_over")|.level]|join(",")')" "warn"
chk "გატარება → PO მიღებული" "$(api POST "/stock/receipts/$RC2/post" "$SK" | jq -r .status):$(api GET "/procurement/orders/$PO1" "$PRC" | jq -r .status)" "posted:received"
chk "RC2-ის შემობრუნება → PO ისევ ნაწილობრივ" "$(api POST "/stock/docs/$RC2/reverse" "$SM" -d '{"reason":"ტესტ-E2E: ზედმეტი"}' | jq -r .doc_type):$(api GET "/procurement/orders/$PO1" "$PRC" | jq -r '"\(.status):\(.lines[0].qty_received|tonumber+0)"')" "reversal:partial:20"
rules '{"qty_over_delivery":"block"}' >/dev/null
RC3=$(api POST "/procurement/orders/$PO1/receipt" "$SK" | jq -r '.id // empty')
R=$(api PUT "/stock/receipts/$RC3" "$SK" -d "$(RCB "$SUP1" "$(LMED 2 "PC$S" 100)")")
chk "qty_over_delivery = block — შეცდომა" "$(echo "$R" | jq -r '[.issues[]|select(.code=="po_over")|.level]|join(",")')" "error"
api PUT "/stock/receipts/$RC3" "$SK" -d "$(RCB "$SUP1" "$(LMED 1 "PC$S" 100)")" >/dev/null
chk "1 კოლოფი → გატარება, PO მიღებული" "$(api POST "/stock/receipts/$RC3/post" "$SK" | jq -r .status):$(api GET "/procurement/orders/$PO1" "$PRC" | jq -r .status)" "posted:received"
rules '{"qty_over_delivery":"warn"}' >/dev/null
RC4=$(api POST /stock/receipts "$SK" -d "$(RCB "$SUP2" "$(LMED 1 "PD$S" 100)")" | jq -r '.id // empty'); echo "$RC4" >> "$TMP/drafts"
chk "სხვა მომწოდებელი PO-ზე — შეცდომა po_supplier" "$(api GET "/stock/docs/$RC4" "$SK" | jq -r '[.issues[]|select(.level=="error")|.code]|index("po_supplier")!=null')" "true"
RC5=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP2\",\"po_id\":\"$PO3\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":10,\"lot_no\":\"PE$S\",\"expires_on\":\"$D2Y\",\"price\":9.5,\"vat_rate\":0}]}" | jq -r '.id // empty'); echo "$RC5" >> "$TMP/drafts"
chk "გაუქმებულ PO-ზე — შეცდომა po_status; PO-ს ხაზის გარეშე — გაფრთხილება po_extra" "$(api GET "/stock/docs/$RC5" "$SK" | jq -r '[.issues[]|"\(.code)=\(.level)"]|map(select(test("po_status|po_extra")))|sort|join(",")')" "po_extra=warn,po_status=error"
chk "მიღებით PO: გაუქმება — 409; მიღებულის დახურვა — 409" "$(code POST "/procurement/orders/$PO1/cancel" "$PRC" -d '{"reason":"ტესტ-E2E"}'):$(code POST "/procurement/orders/$PO1/close" "$PRC" -d '{"reason":"ტესტ-E2E"}')" "409:409"
RC6=$(api POST "/procurement/orders/$PO2/receipt" "$SK" | jq -r '.id // empty')
api PUT "/stock/receipts/$RC6" "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP2\",\"po_id\":\"$PO2\",\"prices_include_vat\":false,\"lines\":[{\"item_id\":\"$MED\",\"qty\":100,\"lot_no\":\"PF$S\",\"expires_on\":\"$D2Y\",\"price\":9.5,\"vat_rate\":0,\"po_line_id\":\"$(api GET "/procurement/orders/$PO2" "$PRC" | jq -r '.lines[0].id')\"}]}" >/dev/null
chk "PO2: 100 / 300 → ნაწილობრივ; დახურვა → closed" "$(api POST "/stock/receipts/$RC6/post" "$SK" | jq -r .status):$(api GET "/procurement/orders/$PO2" "$PRC" | jq -r .status):$(api POST "/procurement/orders/$PO2/close" "$PRC" -d '{"reason":"ტესტ-E2E: დარჩენილი აღარ მოვა"}' | jq -r .status)" "posted:partial:closed"
chk "სია: მომწოდებელი 2, დახურული" "$(api GET "/procurement/orders?supplier_id=$SUP2&status=closed" "$PRC" | jq -r "[.[]|select(.id==\"$PO2\")]|length")" "1"
chk "მიღებების სია: PO-ს ნომერი ჩანს" "$(api GET "/stock/docs?supplier_id=$SUP1&status=posted" "$SK" | jq -r "[.[]|select(.id==\"$RC1\")|.po_no]|.[0]|test(\"^PO\")")" "true"

step "11. po_mode = required / off"
rules '{"po_mode":"required"}' >/dev/null
RC7=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP1\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":5,\"price\":1,\"vat_rate\":18}]}" | jq -r '.id // empty')
chk "PO-ს გარეშე — შეცდომა po_required, გატარება 400" "$(api GET "/stock/docs/$RC7" "$SK" | jq -r '[.issues[]|select(.code=="po_required")|.level]|join(",")'):$(code POST "/stock/receipts/$RC7/post" "$SK")" "error:400"
api PUT "/stock/receipts/$RC7" "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP1\",\"no_po_reason\":\"ტესტ-E2E: სასწრაფო შესყიდვა\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":5,\"price\":1,\"vat_rate\":18}]}" >/dev/null
chk "მიზეზით: მესაწყობე — 403; საწყობის მენეჯერი — posted" "$(code POST "/stock/receipts/$RC7/post" "$SK"):$(api POST "/stock/receipts/$RC7/post" "$SM" | jq -r .status)" "403:posted"
rules '{"po_mode":"off"}' >/dev/null
chk "po_mode = off: PO-ს შექმნა — 400; PR — კვლავ მუშაობს" "$(code POST /procurement/orders "$PRC" -d "$POB"):$(code GET /procurement/requisitions "$SK")" "400:200"
rules '{"po_mode":"optional"}' >/dev/null

step "12. ვადაგადაცილებული მიწოდება"
PO6=$(api POST /procurement/orders "$PRC" -d "{\"supplier_id\":\"$SUP1\",\"location_id\":\"$LOC\",\"order_date\":\"$DM10\",\"expected_date\":\"$DM3\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":1,\"price\":1}]}" | jq -r '.id // empty')
api POST "/procurement/orders/$PO6/send" "$PRC" >/dev/null
chk "სიაში: overdue = true" "$(api GET '/procurement/orders?overdue=true' "$PRC" | jq -r "[.[]|select(.id==\"$PO6\")|.overdue]|.[0]")" "true"
chk "ყოველდღიური შემოწმება: შეტყობინება შესყიდვებს; მეორედ — აღარ" "$(api POST /stock/alerts/run "$ADM" | jq -r '.po_overdue.orders>=1'):$(api GET /notifications "$PRC" | jq -r "[.[]|select(.kind==\"proc_po_overdue\")]|length>=1"):$(api POST /stock/alerts/run "$ADM" | jq -r '.po_overdue.orders')" "true:true:0"
api POST "/procurement/orders/$PO6/cancel" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null

step "13. მოდულის გამორთვა, აუდიტი"
api PUT /modules/procurement "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთული მოდული — 403; მიღება PO-ს გარეშე — შეცდომის გარეშე" "$(code GET /procurement/requisitions "$SK"):$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP1\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":1,\"price\":1,\"vat_rate\":18}]}" | tee "$TMP/rc8" | jq -r '[.issues[]|select(.level=="error")]|length')" "403:0"
jq -r .id "$TMP/rc8" >> "$TMP/drafts"
api PUT /modules/procurement "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "აუდიტი: PR — შექმნა, გაგზავნა, დამტკიცება, PO" "$(api GET "/audit-logs?entity_name=proc_requisitions&entity_id=$PR1&limit=20" "$ADM" | jq -r '[.[].action]|(index("CREATE_PROC_PR")!=null) and (index("SUBMIT_PROC_PR")!=null) and (index("APPROVE_PROC_PR")!=null) and (index("PROC_PR_TO_PO")!=null)')" "true"
chk "აუდიტი: PO — გაგზავნა, დაბრუნება, დამტკიცება, დახურვა" "$(api GET "/audit-logs?entity_name=proc_orders&entity_id=$PO2&limit=20" "$ADM" | jq -r '[.[].action]|(index("SUBMIT_PROC_PO")!=null) and (index("RETURN_PROC_PO")!=null) and (index("APPROVE_PROC_PO")!=null) and (index("CLOSE_PROC_PO")!=null)')" "true"

step "გასუფთავება"
for X in $(cat "$TMP/drafts"); do api POST "/stock/docs/$X/cancel" "$SK" -d '{"reason":"ტესტ-E2E"}' >/dev/null; done
for X in "$RC1" "$RC3" "$RC6" "$RC7"; do api POST "/stock/docs/$X/reverse" "$SM" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
chk "ყველა მიღება შემობრუნებულია — ნაშთი 0; PO1 → sent" "$(api GET "/stock/balances?location_id=$LOC" "$SM" | jq -r '.rows|length'):$(api GET "/procurement/orders/$PO1" "$PRC" | jq -r .status)" "0:sent"
api POST "/procurement/orders/$PO1/close" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
for X in "$PR6" "$PR7"; do api POST "/procurement/requisitions/$X/cancel" "$SK" -d '{"reason":"ტესტ-E2E"}' >/dev/null; done
for X in "$PR1" "$PR2" "$PR2B"; do api POST "/procurement/requisitions/$X/close" "$PRC" -d '{"reason":"ტესტ-E2E"}' >/dev/null; done
api POST "/stock/requests/$RQ/cancel" "$SM" -d '{"reason":"ტესტ-E2E"}' >/dev/null
api DELETE "/stock/minmax/$LOC/$HOU" "$SM" >/dev/null
api PUT "/procurement/prices/$P1" "$PRC" -d "{\"supplier_id\":\"$SUP1\",\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"price\":100,\"valid_from\":\"$TODAY\",\"is_active\":false}" >/dev/null
api PUT "/procurement/prices/$P2" "$PRC" -d "{\"supplier_id\":\"$SUP2\",\"item_id\":\"$MED\",\"price\":9.5,\"vat_rate\":0,\"valid_from\":\"$TODAY\",\"is_active\":false}" >/dev/null
chk "ღია PR / PO აღარ დარჩა" "$(api GET "/procurement/requisitions?location_id=$LOC&status=draft,submitted,approved" "$PRC" | jq -r length):$(api GET "/procurement/orders?location_id=$LOC&status=draft,pending,sent,partial" "$PRC" | jq -r length)" "0:0"
api PUT /modules/procurement "$ADM" -d "$(jq -nc --argjson s "$ORIG" '{settings:$s,reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="procurement")|.settings' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"
for X in "$MED" "$NAR" "$HOU"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$GEN" "$GNA"; do api PATCH "/pharmacy/generics/$X" "$PH" -d '{"is_active":false}' >/dev/null; done
for X in "$LOC" "$LOC2"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$SUP1" "$SUP2"; do api PATCH "/stock/suppliers/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (ჟურნალი უცვლელი რჩება — ნაშთი 0)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
