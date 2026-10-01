#!/usr/bin/env bash
# =====================================================================
# e2e-stock-transfers.sh — საწყობი, ეტაპი 3 (0032): მოთხოვნა → დამტკიცება → გაცემა (FEFO, ნაწილობრივი) → მიღების დადასტურება (1A),
#   „გზაში“, უარი მიღებაზე (მარაგი ბრუნდება), დახურვა, კონტროლირებადი (დამტკიცება ყოველთვის) და „მხოლოდ პაციენტზე“ (პაციენტი სავალდებულო),
#   ავტომატური დამტკიცება, პირდაპირი გადაცემა, დაბრუნება, შეტყობინებები, უფლებები (განყოფილება / ხელმძღვანელი / საწყობი / ფარმაცევტი),
#   საშუალო ფასი არ იცვლება
# ყველაფერი სატესტო განყოფილებასა და ლოკაციებზე; ბოლოს მარაგი ბრუნდება აფთიაქში, მიღება შემობრუნდება (ნაშთი 0), მონაცემები ითიშება.
# გამოყენება:  bash scripts/e2e-stock-transfers.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); D1Y=$(date -d "$TODAY +1 year" +%F); D2Y=$(date -d "$TODAY +2 years" +%F)
bal()  { api GET "/stock/balances?location_id=$1&item_id=$2" "$ADM" | jq -r '[.rows[]|"\(.lot_no//"-"):\(.qty|tonumber+0)"]|sort|join(",")'; }

step "0. მომზადება"
DEP=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E განყოფილება $S\",\"code\":\"E2E$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DEP2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E სხვა $S\",\"code\":\"E2EO$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DEP" ] && [ -n "$DEP2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [department_id] [is_section_head]
  local dep=""; [ -n "${3:-}" ] && dep=",\"department_id\":\"$3\",\"is_section_head\":${4:-false}"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.trf.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"გადაცემა-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1$dep}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.trf.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole tsk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole tsm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 81); SM=$(mkuser "[\"$R_SM\"]" 82); PH=$(mkuser '["pharmacist"]' 83)
NR=$(mkuser '["nurse"]' 84 "$DEP"); HD=$(mkuser '["nurse"]' 85 "$DEP" true); NO=$(mkuser '["nurse"]' 86 "$DEP2"); HD2=$(mkuser '["nurse"]' 87 "$DEP2" true)
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && [ -n "$HD" ] && [ -n "$NO" ] && [ -n "$HD2" ] && ok "7 მომხმარებელი (საწყობი, ფარმაცევტი, ექთანი + ხელმძღვანელი, სხვა განყოფილების ექთანი + ხელმძღვანელი)" || die "მომხმარებლები ვერ შეიქმნა"
REFS=$(api GET /stock/refs "$SM"); cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
PHL=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_TP_$S\",\"name\":\"ტესტ-E2E აფთიაქი $S\",\"kind\":\"pharmacy\",\"requires_approval\":false}" | jq -r '.id // empty')
SUB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_TD_$S\",\"name\":\"ტესტ-E2E ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\",\"requires_approval\":true}" | jq -r '.id // empty')
SUB2=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_TO_$S\",\"name\":\"ტესტ-E2E საოპერაციო $S\",\"kind\":\"operating\",\"requires_approval\":false}" | jq -r '.id // empty')
TRANSIT=$(api GET /stock/locations "$SM" | jq -r '.[]|select(.code=="TRANSIT").id')
G1=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ცეფაზოლინი $S\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\"}" | jq -r '.id // empty')
G2=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ფენტანილი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"50 მკგ/მლ\",\"controlled_class\":\"narcotic\",\"patient_only\":true}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Cefazolin $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$G1\",\"base_unit\":\"vial\",\"packs\":[{\"name\":\"კოლოფი\",\"qty_base\":10,\"is_receipt_default\":true}]}" | jq -r '.id // empty')
BOX=$(api GET "/stock/items/$MED" "$SM" | jq -r '.packs[0].id')
CTL=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Fentanyl $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$G2\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty')
HOU=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ხელთათმანი $S\",\"category_id\":\"$(cat_id HOUSE)\",\"base_unit\":\"pair\"}" | jq -r '.id // empty')
[ -n "$PHL" ] && [ -n "$SUB" ] && [ -n "$SUB2" ] && [ -n "$TRANSIT" ] && [ -n "$MED" ] && [ -n "$CTL" ] && [ -n "$HOU" ] && ok "ლოკაციები (აფთიაქი, განყოფილება — დამტკიცებით, საოპერაციო — დამტკიცების გარეშე), „გზაში“, საქონელი" || die "მონაცემები ვერ შეიქმნა"
RC=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$PHL\",\"lines\":[
 {\"item_id\":\"$MED\",\"qty\":30,\"lot_no\":\"A$S\",\"expires_on\":\"$D1Y\",\"price\":2,\"vat_rate\":0},
 {\"item_id\":\"$MED\",\"qty\":50,\"lot_no\":\"B$S\",\"expires_on\":\"$D2Y\",\"price\":3,\"vat_rate\":0},
 {\"item_id\":\"$CTL\",\"qty\":10,\"lot_no\":\"C$S\",\"expires_on\":\"$D2Y\",\"price\":5,\"vat_rate\":0},
 {\"item_id\":\"$HOU\",\"qty\":20,\"price\":1,\"vat_rate\":0}]}" | jq -r '.id // empty')
chk "საწყისი მარაგი აფთიაქში (მიღება)" "$(api POST "/stock/receipts/$RC/post" "$SK" | jq -r .status)" "posted"
AVG0=$(api GET "/stock/items/$MED/moves" "$SK" | jq -r '.avg_cost|tonumber+0')
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"5$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"პაციენტი\",\"birth_date\":\"1980-05-05\",\"gender\":\"female\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] && ok "სატესტო პაციენტი" || bad "პაციენტი ვერ შეიქმნა"

step "1. მოთხოვნა (განყოფილება)"
RQB="{\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":4},{\"item_id\":\"$HOU\",\"qty\":5}]}"
chk "სხვა განყოფილების ექთანი — 403" "$(code POST /stock/requests "$NO" -d "$RQB")" "403"
R1=$(api POST /stock/requests "$NR" -d "$RQB"); RQ=$(echo "$R1" | jq -r '.id // empty')
chk "მონახაზი: 2 ხაზი, 4 კოლოფი = 40 ფლაკონი; ხელმისაწვდომი აფთიაქში 80" "$(echo "$R1" | jq -r '"\(.status):\(.lines|length):\(.lines[0].qty_base|tonumber+0):\(.lines[0].available|tonumber+0)"')" "draft:2:40:80"
S1=$(api POST "/stock/requests/$RQ/submit" "$NR")
chk "გაგზავნა: RQ-ნომერი, დამტკიცებას ელოდება" "$(echo "$S1" | jq -r '"\(.status):\(.req_no|test("^RQ[0-9]{2}-[0-9]{6}$")):\(.requires_approval)"')" "submitted:true:true"
chk "შეტყობინება ხელმძღვანელს" "$(api GET "/notifications?unread=true" "$HD" | jq -r "[.[]|select(.kind==\"stock_approve\")]|length")" "1"
chk "მეორედ გაგზავნა — 409; მონახაზის გარეშე რედაქტირება — 409" "$(code POST "/stock/requests/$RQ/submit" "$NR"):$(code PUT "/stock/requests/$RQ" "$NR" -d "$RQB")" "409:409"

step "2. დამტკიცება"
L1=$(echo "$S1" | jq -r '.lines[0].id'); L2=$(echo "$S1" | jq -r '.lines[1].id')
chk "ექთანი ვერ ამტკიცებს — 403; სხვა განყოფილების ხელმძღვანელი — 403" "$(code POST "/stock/requests/$RQ/approve" "$NR" -d '{}'):$(code POST "/stock/requests/$RQ/approve" "$HD2" -d '{}')" "403:403"
chk "მოთხოვნილზე მეტი — 400" "$(code POST "/stock/requests/$RQ/approve" "$HD" -d "{\"lines\":[{\"id\":\"$L1\",\"qty_approved\":50}]}")" "400"
A1=$(api POST "/stock/requests/$RQ/approve" "$HD" -d "{\"lines\":[{\"id\":\"$L1\",\"qty_approved\":35}]}")
chk "ხელმძღვანელი: ფლაკონი 35 (შემცირებით), ხელთათმანი 5" "$(echo "$A1" | jq -r '"\(.status):\([.lines[].qty_approved|tonumber+0]|join(","))"')" "approved:35,5"
chk "შეტყობინება მესაწყობეს" "$(api GET "/notifications?unread=true" "$SK" | jq -r "[.[]|select(.kind==\"stock_issue\")]|length")" "1"

step "3. გაცემა (FEFO, ნაწილობრივი)"
PK=$(api GET "/stock/requests/$RQ/pick" "$SK")
chk "FEFO: A 30 + B 5; ხელთათმანი 5" "$(echo "$PK" | jq -r '[.lines[]|[.alloc[]|"\(.lot_no//"-"):\(.qty)"]|join("+")]|join(",")')" "A$S:30+B$S:5,-:5"
LA=$(echo "$PK" | jq -r ".lines[0].lots[]|select(.lot_no==\"A$S\").lot_id"); LB=$(echo "$PK" | jq -r ".lines[0].lots[]|select(.lot_no==\"B$S\").lot_id"); LH=$(echo "$PK" | jq -r '.lines[1].lots[0].lot_id')
chk "ექთანი ვერ გასცემს — 403" "$(code POST "/stock/requests/$RQ/issue" "$NR" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LA\",\"qty_base\":1}]}")" "403"
chk "გვიანი ვადის ლოტი (B) მიზეზის გარეშე — 400" "$(code POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LB\",\"qty_base\":10}]}")" "400"
chk "დარჩენილზე მეტი — 400" "$(code POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LA\",\"qty_base\":30},{\"request_line_id\":\"$L1\",\"lot_id\":\"$LB\",\"qty_base\":10,\"override_reason\":\"x\"}]}")" "400"
chk "ლოტზე მეტი — 409" "$(code POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LA\",\"qty_base\":31}]}")" "409"
I1=$(api POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LA\",\"qty_base\":30},{\"request_line_id\":\"$L2\",\"lot_id\":\"$LH\",\"qty_base\":5}]}")
chk "ნაწილობრივი გაცემა: სტატუსი partial, TR-დოკუმენტი გზაშია" "$(echo "$I1" | jq -r '"\(.status):\(.docs|length):\(.docs[0].doc_no|test("^TR")):\(.docs[0].receive_status)"')" "partial:1:true:null"
TR1=$(echo "$I1" | jq -r '.docs[0].id')
chk "ნაშთი: აფთიაქი B 50; გზაში A 30; ქვესაწყობი — 0" "$(bal "$PHL" "$MED")|$(bal "$TRANSIT" "$MED")|$(bal "$SUB" "$MED")" "B$S:50|A$S:30|"
chk "მომთხოვნს — „დაადასტურეთ მიღება“" "$(api GET "/notifications?unread=true" "$NR" | jq -r "[.[]|select(.kind==\"stock_receive\")]|length")" "1"

step "4. მიღების დადასტურება (1A)"
chk "მისაღებში ჩანს (ექთანი)" "$(api GET "/stock/transit?scope=incoming" "$NR" | jq -r "[.[]|select(.id==\"$TR1\")|.can_receive]|join(\"\")")" "true"
chk "სხვა განყოფილება ვერ ადასტურებს — 403" "$(code POST "/stock/docs/$TR1/receive" "$NO" -d '{"action":"receive"}')" "403"
chk "მიღება" "$(api POST "/stock/docs/$TR1/receive" "$NR" -d '{"action":"receive"}' | jq -r .receive_status)" "received"
chk "ნაშთი: ქვესაწყობი A 30, ხელთათმანი 5; გზაში — 0" "$(bal "$SUB" "$MED")|$(bal "$SUB" "$HOU")|$(bal "$TRANSIT" "$MED")" "A$S:30|-:5|"
chk "მეორედ მიღება — 409" "$(code POST "/stock/docs/$TR1/receive" "$NR" -d '{"action":"receive"}')" "409"
chk "საშუალო ფასი არ შეცვლილა" "$(api GET "/stock/items/$MED/moves" "$SK" | jq -r '.avg_cost|tonumber+0')" "$AVG0"

step "5. დარჩენილის გაცემა → უარი მიღებაზე → დახურვა"
I2=$(api POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LB\",\"qty_base\":5}]}")
chk "სრულად გაცემული (issued)" "$(echo "$I2" | jq -r .status)" "issued"
TR2=$(echo "$I2" | jq -r '[.docs[]|select(.receive_status==null)][0].id')
chk "უარი მიზეზის გარეშე — 400" "$(code POST "/stock/docs/$TR2/receive" "$NR" -d '{"action":"return"}')" "400"
chk "უარი (დაზიანებული შეფუთვა) → მარაგი გამცემთან, მოთხოვნა — partial" \
  "$(api POST "/stock/docs/$TR2/receive" "$NR" -d '{"action":"return","note":"ტესტ-E2E: დაზიანებული შეფუთვა"}' | jq -r .receive_status):$(bal "$PHL" "$MED"):$(api GET "/stock/requests/$RQ" "$NR" | jq -r .status)" "returned:B$S:50:partial"
chk "გამგზავნს — შეტყობინება უარზე" "$(api GET "/notifications?unread=true" "$SK" | jq -r "[.[]|select(.kind==\"stock_receive\" and (.title|test(\"არ მიიღო\")))]|length")" "1"
chk "დახურვა მიზეზის გარეშე — 400; მიზეზით — closed" "$(code POST "/stock/requests/$RQ/cancel" "$NR" -d '{}'):$(api POST "/stock/requests/$RQ/cancel" "$NR" -d '{"reason":"ტესტ-E2E: დანარჩენი აღარ სჭირდება"}' | jq -r .status)" "400:closed"
chk "დახურულიდან გაცემა — 409" "$(code POST "/stock/requests/$RQ/issue" "$SK" -d "{\"lines\":[{\"request_line_id\":\"$L1\",\"lot_id\":\"$LB\",\"qty_base\":1}]}")" "409"

step "6. კონტროლირებადი, „მხოლოდ პაციენტზე“, ავტომატური დამტკიცება"
R2=$(api POST /stock/requests "$SK" -d "{\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB2\",\"lines\":[{\"item_id\":\"$CTL\",\"qty\":2}]}" | jq -r '.id // empty')
chk "პაციენტის გარეშე — 400" "$(code POST "/stock/requests/$R2/submit" "$SK")" "400"
api PUT "/stock/requests/$R2" "$SK" -d "{\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB2\",\"urgent\":true,\"lines\":[{\"item_id\":\"$CTL\",\"qty\":2,\"patient_id\":\"$PAT\"}]}" >/dev/null
chk "ნარკოტიკული: დამტკიცება სავალდებულოა (ლოკაციას არ სჭირდება)" "$(api POST "/stock/requests/$R2/submit" "$SK" | jq -r '"\(.status):\(.requires_approval):\(.lines[0].patient_name|test("ტესტ-E2E"))"')" "submitted:true:true"
chk "განყოფილების გარეშე ლოკაცია: ამტკიცებს საწყობის მენეჯერი (ექთანი — 403)" "$(code POST "/stock/requests/$R2/approve" "$HD" -d '{}'):$(api POST "/stock/requests/$R2/approve" "$SM" -d '{}' | jq -r .status)" "403:approved"
PK2=$(api GET "/stock/requests/$R2/pick" "$PH")
I3=$(api POST "/stock/requests/$R2/issue" "$PH" -d "{\"lines\":[{\"request_line_id\":\"$(echo "$PK2" | jq -r '.lines[0].request_line_id')\",\"lot_id\":\"$(echo "$PK2" | jq -r '.lines[0].alloc[0].lot_id')\",\"qty_base\":2}]}")
TR3=$(echo "$I3" | jq -r '.docs[0].id')
chk "ფარმაცევტი გასცემს აფთიაქიდან; ხაზზე — პაციენტი" "$(echo "$I3" | jq -r .status):$(api GET "/stock/docs/$TR3" "$SK" | jq -r '.lines[0].patient_name|test("ტესტ-E2E")')" "issued:true"
api POST "/stock/docs/$TR3/receive" "$SK" -d '{"action":"receive"}' >/dev/null
R3=$(api POST /stock/requests "$SK" -d "{\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB2\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":3}]}" | jq -r '.id // empty')
chk "ჩვეულებრივი საქონელი, ლოკაციას დამტკიცება არ სჭირდება → ავტომატურად დამტკიცებული" "$(api POST "/stock/requests/$R3/submit" "$SK" | jq -r '"\(.status):\(.requires_approval):\(.lines[0].qty_approved|tonumber+0)"')" "approved:false:3"
api POST "/stock/requests/$R3/cancel" "$SK" -d '{"reason":"ტესტ-E2E"}' >/dev/null

step "7. პირდაპირი გადაცემა და დაბრუნება"
T4=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB2\",\"lines\":[{\"lot_id\":\"$LH\",\"qty_base\":4}]}")
chk "გადაცემა აფთიაქი → საოპერაციო (TR), მიღება" "$(echo "$T4" | jq -r '.no|test("^TR")'):$(api POST "/stock/docs/$(echo "$T4" | jq -r .id)/receive" "$SK" -d '{"action":"receive"}' | jq -r .receive_status)" "true:received"
chk "ექთანი სხვისი ლოკაციიდან ვერ გადასცემს — 403" "$(code POST /stock/transfers "$NO" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$SUB\",\"to_location_id\":\"$PHL\",\"notes\":\"x x x\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":1}]}")" "403"
chk "დაბრუნება მიზეზის გარეშე — 400" "$(code POST /stock/transfers "$NR" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$SUB\",\"to_location_id\":\"$PHL\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":10}]}")" "400"
T5=$(api POST /stock/transfers "$NR" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$SUB\",\"to_location_id\":\"$PHL\",\"notes\":\"ტესტ-E2E: ზედმეტი მარაგი\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":10}]}")
chk "ექთანი აბრუნებს (RT) → ფარმაცევტი იღებს" "$(echo "$T5" | jq -r '.no|test("^RT")'):$(api POST "/stock/docs/$(echo "$T5" | jq -r .id)/receive" "$PH" -d '{"action":"receive"}' | jq -r .receive_status)" "true:received"
chk "ნაშთი: აფთიაქი A 10 + B 50; ქვესაწყობი A 20" "$(bal "$PHL" "$MED")|$(bal "$SUB" "$MED")" "A$S:10,B$S:50|A$S:20"
chk "ქვესაწყობის ნაშთზე მეტის დაბრუნება — 409" "$(code POST /stock/transfers "$NR" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$SUB\",\"to_location_id\":\"$PHL\",\"notes\":\"ზედმეტი\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":21}]}")" "409"
chk "დოკუმენტების სია (გადაცემა + დაბრუნება, ლოკაციით)" "$(api GET "/stock/docs?type=transfer,return&location_id=$SUB" "$SK" | jq -r '[.[].doc_type]|sort|unique|join(",")')" "return,transfer"
chk "აუდიტი: გაცემა, მიღება, დაბრუნება" "$(api GET "/audit-logs?entity_name=stock_requests&entity_id=$RQ&limit=20" "$ADM" | jq -r '[.[].action]|(index("ISSUE_STOCK_REQUEST")!=null) and (index("APPROVE_STOCK_REQUEST")!=null)'):$(api GET "/audit-logs?entity_name=stock_docs&entity_id=$TR2&limit=5" "$ADM" | jq -r '[.[].action]|index("REFUSE_STOCK_TRANSFER")!=null')" "true:true"
chk "საშუალო ფასი უცვლელია ყველა გადაადგილების შემდეგ" "$(api GET "/stock/items/$MED/moves" "$SK" | jq -r '.avg_cost|tonumber+0')" "$AVG0"

step "გასუფთავება"
for L in "$SUB" "$SUB2"; do
  api GET "/stock/balances?location_id=$L" "$SK" | jq -r '.rows[]|"\(.lot_id) \(.qty|tonumber)"' | while read -r LOT Q; do
    T=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$L\",\"to_location_id\":\"$PHL\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":[{\"lot_id\":\"$LOT\",\"qty_base\":$Q}]}" | jq -r .id)
    api POST "/stock/docs/$T/receive" "$SK" -d '{"action":"receive"}' >/dev/null
  done
done
api POST "/stock/docs/$RC/reverse" "$SM" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
chk "მარაგი დაბრუნდა და მიღება შემობრუნდა — ნაშთი 0 (აფთიაქი, ქვესაწყობები, გზაში)" \
  "$(for L in "$PHL" "$SUB" "$SUB2"; do api GET "/stock/balances?location_id=$L" "$SK" | jq -r '.rows|length'; done | paste -sd,):$(api GET "/stock/balances?location_id=$TRANSIT&search=$S" "$SK" | jq -r '.rows|length')" "0,0,0:0"
for X in "$MED" "$CTL" "$HOU"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$G1" "$G2"; do api PATCH "/pharmacy/generics/$X" "$PH" -d '{"is_active":false}' >/dev/null; done
for X in "$PHL" "$SUB" "$SUB2"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$DEP" "$DEP2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (პაციენტი რჩება — „ტესტ-E2E“)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
