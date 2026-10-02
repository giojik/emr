#!/usr/bin/env bash
# =====================================================================
# e2e-stock-lab.sh — ლაბორატორია ↔ საწყობი (0036, გადაწყვეტილება 7A)
#   ლაბორატორიის ქვესაწყობი (ლაბ. თანამშრომლები მუშაობენ; მოთხოვნას ამტკიცებს ლაბ. ხელმძღვანელი), საქონლის ლაბ. პარამეტრები,
#   ნაკრების გახსნა → ჩამოწერა (lab_use, დამტკიცების გარეშე), on-board ვადა = min(გახსნა + დღეები, ლოტის ვადა),
#   ვადაგასული / დაბლოკილი — არ იხსნება, დახურვა / გადაყრა (მიზეზით), შესრულებული ტესტები (QC შედეგებით),
#   ტესტის თვითღირებულება და ეფექტიანობა, QC მასალა ← საწყობის ლოტი, on-board შეტყობინება, უფლებები
# ბოლოს ნაშთი 0, მონაცემები ითიშება.
# გამოყენება:  bash scripts/e2e-stock-lab.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); D20=$(date -d "$TODAY +20 days" +%F); D2Y=$(date -d "$TODAY +2 years" +%F); D28=$(date -d "$TODAY +28 days" +%F)
bal()  { api GET "/stock/balances?location_id=$1&item_id=$2" "$ADM" | jq -r '[.rows[]|"\(.lot_no//"-"):\(.qty|tonumber+0)"]|sort|join(",")'; }

step "0. მომზადება"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.lst.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ლაბ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.lst.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole lsk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole lsm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 41); SM=$(mkuser "[\"$R_SM\"]" 42); LM=$(mkuser '["lab_manager"]' 43); LT=$(mkuser '["diagnostic"]' 44); NR=$(mkuser '["nurse"]' 45)
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$LM" ] && [ -n "$LT" ] && [ -n "$NR" ] && ok "5 მომხმარებელი (მესაწყობე, მენეჯერი, ლაბ. ხელმძღვანელი, ლაბორანტი, ექთანი)" || die "მომხმარებლები ვერ შეიქმნა"
REFS=$(api GET /stock/refs "$SM"); cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
PHL=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_LP_$S\",\"name\":\"ტესტ-E2E ცენტრალური $S\",\"kind\":\"central\"}" | jq -r '.id // empty')
LAB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_LL_$S\",\"name\":\"ტესტ-E2E ლაბორატორია $S\",\"kind\":\"lab\",\"default_source_id\":\"$PHL\",\"requires_approval\":true}" | jq -r '.id // empty')
M=$(api POST /lab/methods "$LM" -d "{\"name\":\"ტესტ-E2E ბიოქიმიური ანალიზატორი $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty')
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_ST_$S\",\"name\":\"ტესტ-E2E ბიოქიმია $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty')
GLU=$(api POST "/dx/catalog/$SVC/analytes" "$LM" -d "{\"code\":\"GLU$S\",\"name\":\"გლუკოზა\",\"unit\":\"mmol/L\",\"result_type\":\"numeric\",\"decimals\":1,\"sort_order\":0,\"ranges\":[{\"sex\":null,\"age_min_days\":0,\"age_max_days\":54750,\"low\":3.9,\"high\":6.1}]}" | jq -r ".analytes[]|select(.code==\"GLU$S\")|.id")
[ -n "$PHL" ] && [ -n "$LAB" ] && [ -n "$M" ] && [ -n "$GLU" ] && ok "ცენტრალური საწყობი, ლაბორატორიის ქვესაწყობი, ანალიზატორი, ანალიტი (გლუკოზა)" || die "მონაცემები ვერ შეიქმნა"
REA=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E GLU კასეტა $S\",\"category_id\":\"$(cat_id REAGENT)\",\"base_unit\":\"piece\",\"lab_tests_per_unit\":10,\"lab_onboard_days\":28,\"lab_method_id\":\"$M\",\"lab_analyte_id\":\"$GLU\"}")
REAID=$(echo "$REA" | jq -r '.id // empty')
chk "რეაგენტი: ლაბ. პარამეტრები (10 ტესტი, 28 დღე, ანალიზატორი, ანალიტი)" "$(echo "$REA" | jq -r "\"\(.lab_tests_per_unit):\(.lab_onboard_days):\(.lab_method_id==\"$M\"):\(.lab_analyte_id==\"$GLU\")\"")" "10:28:true:true"
QCI=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E კონტროლი L1 $S\",\"category_id\":\"$(cat_id QC)\",\"base_unit\":\"piece\",\"manufacturer\":\"Bio-Rad\",\"lab_onboard_days\":7}" | jq -r '.id // empty')
RC=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$PHL\",\"lines\":[{\"item_id\":\"$REAID\",\"qty\":3,\"lot_no\":\"R1$S\",\"expires_on\":\"$D20\",\"price\":50,\"vat_rate\":0,\"short_expiry_reason\":\"ტესტ-E2E\"},{\"item_id\":\"$REAID\",\"qty\":2,\"lot_no\":\"R2$S\",\"expires_on\":\"$D2Y\",\"price\":60,\"vat_rate\":0},{\"item_id\":\"$QCI\",\"qty\":4,\"lot_no\":\"Q$S\",\"expires_on\":\"$D2Y\",\"price\":30,\"vat_rate\":0}]}" | jq -r .id)
chk "მიღება ცენტრალურ საწყობში" "$(api POST "/stock/receipts/$RC/post" "$SK" | jq -r .status)" "posted"

step "1. ლაბორატორიის ქვესაწყობი: მოთხოვნა → დამტკიცება (ლაბ. ხელმძღვანელი) → მიღება"
chk "ლაბორანტის ლოკაციებში — ლაბორატორია; ექთანს — არა" "$(api GET /stock/my-locations "$LT" | jq -r "[.[]|select(.id==\"$LAB\")]|length"):$(api GET /stock/my-locations "$NR" | jq -r "[.[]|select(.id==\"$LAB\")]|length")" "1:0"
RQ=$(api POST /stock/requests "$LT" -d "{\"from_location_id\":\"$PHL\",\"to_location_id\":\"$LAB\",\"lines\":[{\"item_id\":\"$REAID\",\"qty\":5},{\"item_id\":\"$QCI\",\"qty\":2}]}" | jq -r '.id // empty')
chk "ლაბორანტი გზავნის → დასამტკიცებელი; შეტყობინება ლაბ. ხელმძღვანელს" "$(api POST "/stock/requests/$RQ/submit" "$LT" | jq -r .status):$(api GET "/notifications?unread=true" "$LM" | jq -r '[.[]|select(.kind=="stock_approve")]|length')" "submitted:1"
chk "ლაბორანტი ვერ ამტკიცებს — 403; ლაბ. ხელმძღვანელი ამტკიცებს" "$(code POST "/stock/requests/$RQ/approve" "$LT" -d '{}'):$(api POST "/stock/requests/$RQ/approve" "$LM" -d '{}' | jq -r .status)" "403:approved"
PICK=$(api GET "/stock/requests/$RQ/pick" "$SK" | jq -c '{lines:[.lines[]|.request_line_id as $r|.alloc[]|{request_line_id:$r,lot_id,qty_base:.qty}]}')
TR=$(api POST "/stock/requests/$RQ/issue" "$SK" -d "$PICK" | jq -r '.docs[-1].id')
chk "გაცემა (FEFO: R1 3 + R2 2) → ლაბორანტი იღებს" "$(api POST "/stock/docs/$TR/receive" "$LT" -d '{"action":"receive"}' | jq -r .receive_status):$(bal "$LAB" "$REAID")" "received:R1$S:3,R2$S:2"

step "2. ნაკრების გახსნა (7A)"
STK=$(api GET "/stock/lab/stock?location_id=$LAB" "$LT")
chk "გასახსნელი: 3 ლოტი (R1, R2, QC), ნაგულისხმევი ანალიზატორი" "$(echo "$STK" | jq -r '"\(length):\([.[]|select(.method_name!=null)]|length)"')" "3:2"
LR1=$(echo "$STK" | jq -r ".[]|select(.lot_no==\"R1$S\").lot_id"); LR2=$(echo "$STK" | jq -r ".[]|select(.lot_no==\"R2$S\").lot_id"); LQ=$(echo "$STK" | jq -r ".[]|select(.lot_no==\"Q$S\").lot_id")
chk "ექთანი — 403; არა-ლაბორატორიის ლოკაცია — 400" "$(code POST /stock/lab/kits "$NR" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LR1\"}"):$(code POST /stock/lab/kits "$SK" -d "{\"location_id\":\"$PHL\",\"lot_id\":\"$LR1\"}")" "403:400"
K1=$(api POST /stock/lab/kits "$LT" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LR1\"}")
K1ID=$(echo "$K1" | jq -r .id)
chk "გახსნა: ჩამოწერა WO (50 ₾), ანალიზატორი / ანალიტი — საქონლიდან, გეგმა 10 ტესტი" "$(echo "$K1" | jq -r "\"\(.doc_no|test(\"^WO\")):\(.cost|tonumber+0):\(.method_id==\"$M\"):\(.analyte_id==\"$GLU\"):\(.tests_planned)\"")" "true:50:true:true:10"
chk "on-board ვადა = ლოტის ვადა (20 დღე < 28)" "$(echo "$K1" | jq -r .onboard_expires_on)" "$D20"
chk "ნაშთი: R1 2" "$(bal "$LAB" "$REAID")" "R1$S:2,R2$S:2"
chk "ჩამოწერა „ლაბორატორიული ხარჯი“ — დამტკიცების გარეშე" "$(api GET "/stock/writeoffs" "$SM" | jq -r "[.[]|select(.doc_no==\"$(echo "$K1" | jq -r .doc_no)\")|\"\(.writeoff_reason):\(.status)\"]|join(\"\")")" "lab_use:posted"
K2=$(api POST /stock/lab/kits "$LM" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LR2\",\"onboard_days\":5,\"notes\":\"ტესტ-E2E\"}")
chk "R2: on-board 5 დღე (მითითებული)" "$(echo "$K2" | jq -r .onboard_expires_on)" "$(date -d "$TODAY +5 days" +%F)"
chk "ნაშთზე მეტი — 400" "$(code POST /stock/lab/kits "$LT" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LR2\",\"qty_base\":5}")" "400"
api POST "/stock/lots/$LR1/status" "$SM" -d '{"status":"quarantine","reason":"ტესტ-E2E"}' >/dev/null
chk "დაბლოკილი ლოტი — 400" "$(code POST /stock/lab/kits "$LT" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LR1\"}")" "400"
api POST "/stock/lots/$LR1/status" "$SM" -d '{"status":"active","reason":"ტესტ-E2E"}' >/dev/null

step "3. QC მასალა ← საწყობის ლოტი; შესრულებული ტესტები"
chk "QC ლოტები (საწყობიდან)" "$(api GET /stock/lab/qc-lots "$LM" | jq -r "[.[]|select(.id==\"$LQ\")]|length")" "1"
MAT=$(api POST /lab/qc/materials "$LM" -d "{\"level\":\"L1\",\"stock_lot_id\":\"$LQ\",\"barcode\":\"QC-E2E-$S\"}")
MATID=$(echo "$MAT" | jq -r '.id // empty')
chk "QC მასალა: ლოტი / ვადა / დასახელება / მწარმოებელი — საწყობიდან" "$(echo "$MAT" | jq -r '"\(.lot):\(.expires_on):\(.name|test("კონტროლი")):\(.manufacturer)"')" "Q$S:$D2Y:true:Bio-Rad"
KQ=$(api POST /stock/lab/kits "$LT" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LQ\",\"method_id\":\"$M\"}")
chk "QC ფლაკონის გახსნა: on-board 7 დღე" "$(echo "$KQ" | jq -r .onboard_expires_on)" "$(date -d "$TODAY +7 days" +%F)"
TG=$(api PUT "/lab/qc/materials/$MATID/targets" "$LM" -d "{\"targets\":[{\"analyte_id\":\"$GLU\",\"method_id\":\"$M\",\"mean\":5,\"sd\":0.2}]}" | jq -r '.[0].id')
for v in 5.0 5.1 4.9 5.05; do api POST /lab/qc/results "$LT" -d "{\"target_id\":\"$TG\",\"value\":$v}" >/dev/null; done
chk "შესრულებული ტესტები (4 QC) — გახსნილ ნაკრებზე" "$(api GET "/stock/lab/kits/$K1ID" "$LT" | jq -r .tests_done)" "4"

step "4. დახურვა და თვითღირებულება"
chk "გადაყრა მიზეზის გარეშე — 400; დასრულება" "$(code POST "/stock/lab/kits/$K1ID/close" "$LT" -d '{"discarded":true}'):$(api POST "/stock/lab/kits/$K1ID/close" "$LT" -d '{"reason":"კასეტა დამთავრდა"}' | jq -r .status)" "400:finished"
chk "მეორედ დახურვა — 409" "$(code POST "/stock/lab/kits/$K1ID/close" "$LT" -d '{}')" "409"
chk "გადაყრა (on-board ვადა) — მიზეზით" "$(api POST "/stock/lab/kits/$(echo "$K2" | jq -r .id)/close" "$LM" -d '{"discarded":true,"reason":"ტესტ-E2E: on-board ვადა"}' | jq -r .status)" "discarded"
CO=$(api GET "/stock/lab/cost?from=$TODAY&to=$TODAY" "$LM")
chk "თვითღირებულება (ანალიზატორი + გლუკოზა): 2 ნაკრები, 110 ₾, 4 QC ტესტი → 27.50 / ტესტი, გეგმა 20 → 20%" \
  "$(echo "$CO" | jq -r --arg m "$M" --arg a "$GLU" '[.rows[]|select(.method_id==$m and .analyte_id==$a)|"\(.kits):\(.cost):\(.qc_tests):\(.cost_per_test):\(.planned):\(.efficiency)"]|join("")')" "2:110:4:27.5:20:20"
chk "ექთანი — 403" "$(code GET "/stock/lab/cost?from=$TODAY&to=$TODAY" "$NR")" "403"
chk "აქტიური ნაკრებები: 1 (QC)" "$(api GET "/stock/lab/kits?location_id=$LAB&status=in_use" "$LT" | jq length)" "1"

step "5. on-board შეტყობინება (დილის შემოწმება)"
K3=$(api POST /stock/lab/kits "$LT" -d "{\"location_id\":\"$LAB\",\"lot_id\":\"$LR1\",\"onboard_days\":1}" | jq -r .id)
api POST /stock/alerts/run "$ADM" >/dev/null
chk "ლაბ. ხელმძღვანელს — on-board იწურება (≤ 1 დღე)" "$(api GET "/notifications?unread=true" "$LM" | jq -r --arg s "$S" '[.[]|select(.kind=="lab_onboard" and (.title|contains($s)))]|length')" "1"
api POST "/stock/lab/kits/$K3/close" "$LT" -d '{}' >/dev/null

step "გასუფთავება"
api POST "/stock/lab/kits/$(echo "$KQ" | jq -r .id)/close" "$LT" -d '{}' >/dev/null
for L in "$LAB" "$PHL"; do
  LN=$(api GET "/stock/balances?location_id=$L" "$SM" | jq -c '[.rows[]|{lot_id, qty_base:(.qty|tonumber)}]')
  [ "$LN" != "[]" ] && { WC=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$L\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":$LN}" | jq -r '.id // empty')
    [ -n "$WC" ] && api POST "/stock/writeoffs/$WC/decide" "$ADM" -d '{"approve":true}' >/dev/null; }
done
chk "სატესტო ნაშთი — 0" "$(api GET "/stock/balances?location_id=$LAB" "$SM" | jq '.rows|length'):$(api GET "/stock/balances?location_id=$PHL" "$SM" | jq '.rows|length')" "0:0"
api PATCH "/lab/qc/materials/$MATID" "$LM" -d '{"is_active":false}' >/dev/null; api PATCH "/lab/methods/$M" "$LM" -d '{"is_active":false}' >/dev/null; api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
for X in "$REAID" "$QCI"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$LAB" "$PHL"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false,"default_source_id":null}' >/dev/null; done
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
ok "სატესტო მონაცემები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
