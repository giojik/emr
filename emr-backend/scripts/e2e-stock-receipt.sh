#!/usr/bin/env bash
# =====================================================================
# e2e-stock-receipt.sh — საწყობი, ეტაპი 2 (0031): მოძრაობების ჟურნალი და მიღება
#   მონახაზი → შემოწმება (ვადაგასული, მოკლე ვადა + მიზეზი, ლოტი/ვადა/სერიული, ფასი, თარიღი) → გატარება (RC26-…),
#   ლოტები (ფასის შეწონვა ლოტის შიგნით, სხვა ვადა — ბლოკი), სერიული (ერთხელ), დღგ (ფასით / გარეშე), ნაშთები (ლოტის ფასი / საშუალო),
#   უცვლელობა, შემობრუნება (RV26-…; ნაშთი/ფასი/საშუალო ბრუნდება), ისტორია, უფლებები, აუდიტი
# ყველაფერი ცალკე სატესტო ლოკაციაზე; ბოლოს ყველა მიღება შემობრუნდება (ნაშთი = 0), მონაცემები ითიშება.
# შენიშვნა: სატესტო დოკუმენტები იკავებს RC/RV ნომრებს (ჟურნალი უცვლელია — ეს ნორმაა).
# გამოყენება:  bash scripts/e2e-stock-receipt.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F); D3M=$(date -d "$TODAY +3 months" +%F); DPAST=$(date -d "$TODAY -1 day" +%F); DFUT=$(date -d "$TODAY +2 days" +%F)
num()  { jq -n --arg a "$1" '$a|tonumber'; }

step "0. მომზადება"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rcpt.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მიღება-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rcpt.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole rsk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole rsm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 71); SM=$(mkuser "[\"$R_SM\"]" 72); PH=$(mkuser '["pharmacist"]' 73); NR=$(mkuser '["nurse"]' 74)
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && ok "როლები + 4 მომხმარებელი (მესაწყობე, მენეჯერი, ფარმაცევტი, ექთანი)" || die "მომხმარებლები ვერ შეიქმნა"
REFS=$(api GET /stock/refs "$SM")
cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RC_$S\",\"name\":\"ტესტ-E2E აფთიაქი $S\",\"kind\":\"pharmacy\",\"requires_approval\":false}" | jq -r '.id // empty')
LOC2=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RH_$S\",\"name\":\"ტესტ-E2E სამეურნეო $S\",\"kind\":\"household\",\"requires_approval\":false}" | jq -r '.id // empty')
GEN=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ამოქსიცილინი $S\",\"form_code\":\"CAP\",\"strength\":\"500 მგ\"}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Amoxil $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$GEN\",\"base_unit\":\"capsule\",\"packs\":[{\"name\":\"კოლოფი\",\"qty_base\":10,\"is_receipt_default\":true}]}" | jq -r '.id // empty')
BOX=$(api GET "/stock/items/$MED" "$NR" | jq -r '.packs[0].id')
HOU=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ხელსახოცი $S\",\"category_id\":\"$(cat_id HOUSE)\",\"base_unit\":\"roll\"}" | jq -r '.id // empty')
IMP=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ენდოპროთეზი $S\",\"category_id\":\"$(cat_id IMPLANT)\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
SUP=$(api POST /stock/suppliers "$SM" -d "{\"name\":\"ტესტ-E2E შპს მიმწოდებელი $S\",\"tax_id\":\"8$(printf '%08d' "$S")\",\"vat_payer\":true}" | jq -r '.id // empty')
[ -n "$LOC" ] && [ -n "$LOC2" ] && [ -n "$MED" ] && [ -n "$HOU" ] && [ -n "$IMP" ] && [ -n "$SUP" ] && ok "სატესტო ლოკაციები, საქონელი (მედიკამენტი, სამეურნეო, იმპლანტი), მომწოდებელი" || die "მონაცემები ვერ შეიქმნა"
chk "ახალ საქონელს ნაშთი არ აქვს" "$(api GET "/stock/balances?location_id=$LOC" "$NR" | jq -r '.rows|length')" "0"

step "1. მონახაზი და შემოწმება"
BODY1="{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"invoice_no\":\"INV-$S\",\"waybill_no\":\"WB$S\",\"prices_include_vat\":true,\"lines\":[
 {\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":5,\"lot_no\":\"l1-$S\",\"expires_on\":\"$D2Y\",\"price\":118,\"vat_rate\":18},
 {\"item_id\":\"$MED\",\"qty\":20,\"lot_no\":\"L2-$S\",\"expires_on\":\"$D3M\",\"price\":11.8,\"vat_rate\":18},
 {\"item_id\":\"$HOU\",\"qty\":3,\"lot_no\":\"ignored\",\"price\":5.9,\"vat_rate\":18}]}"
R1=$(api POST /stock/receipts "$SK" -d "$BODY1"); D1=$(echo "$R1" | jq -r '.id // empty'); echo "$D1" >> "$TMP/docs"
chk "მონახაზი: 3 ხაზი, ჯამი 715.00 + დღგ 128.70" "$(echo "$R1" | jq -r '"\(.status):\(.lines|length):\(.total_net|tonumber+0):\(.total_vat|tonumber+0)"')" "draft:3:715:128.7"
chk "საბაზო რაოდენობა და თვითღირებულება (კოლოფი 118 დღგ-ით → 10.00 / კაფსულა)" "$(echo "$R1" | jq -r '[.lines[]|"\(.qty_base|tonumber+0)@\(.unit_cost|tonumber+0)"]|join(",")')" "50@10,20@10,3@5"
chk "ლოტი — დიდი ასოებით; ლოტის გარეშე საქონელზე — იგნორდება" "$(echo "$R1" | jq -r '[.lines[].lot_no]|map(.//"-")|join(",")')" "L1-$S,L2-$S,-"
chk "შემოწმება: მოკლე ვადა მიზეზის გარეშე — შეცდომა" "$(echo "$R1" | jq -r '[.issues[]|select(.level=="error")|.code]|join(",")')" "short_expiry"
chk "გატარება — 400 (მოკლე ვადა)" "$(code POST "/stock/receipts/$D1/post" "$SK")" "400"
R1=$(api PUT "/stock/receipts/$D1" "$SK" -d "$(echo "$BODY1" | jq -c '.lines[1].short_expiry_reason="ტესტ-E2E: სწრაფი ხარჯვა"')")
chk "მიზეზით — გაფრთხილება (არა შეცდომა)" "$(echo "$R1" | jq -r '[.issues[]|"\(.level):\(.code)"]|join(",")')" "warn:short_expiry"
P1=$(api POST "/stock/receipts/$D1/post" "$SK")
chk "გატარება: RC-ნომერი, ლოტები მიბმულია" "$(echo "$P1" | jq -r '"\(.status):\(.doc_no|test("^RC[0-9]{2}-[0-9]{6}$")):\([.lines[].lot_id|select(.)]|length)"')" "posted:true:3"
DOCNO=$(echo "$P1" | jq -r .doc_no)
BAL=$(api GET "/stock/balances?location_id=$LOC" "$NR")
chk "ნაშთი: L1 50, L2 20, ხელსახოცი 3" "$(echo "$BAL" | jq -r '[.rows[]|"\(.lot_no//"-"):\(.qty|tonumber+0)"]|sort|join(",")')" "$(printf '%s\n' "-:3" "L1-$S:50" "L2-$S:20" | sort | paste -sd,)"
chk "ნაშთის ღირებულება (ლოტის ფასით): 715.00" "$(echo "$BAL" | jq -r '.total_value')" "715"
chk "ვადამდე დღეები (L2 ≈ 3 თვე) და გაფრთხილების ზღვარი (კატეგორია: 90)" "$(echo "$BAL" | jq -r "[.rows[]|select(.lot_no==\"L2-$S\")|\"\\(.days_left > 80 and .days_left < 100):\\(.warn_days)\"]|join(\"\")")" "true:90"

step "2. შემოწმების წესები"
mk() { api POST /stock/receipts "$1" -d "$2" | tee "$TMP/last" | jq -r '.id // empty'; }
D=$(mk "$SK" "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":1,\"lot_no\":\"X$S\",\"expires_on\":\"$DPAST\",\"price\":1}]}"); echo "$D" >> "$TMP/drafts"
chk "ვადაგასული — შეცდომა, გატარება 400" "$(jq -r '[.issues[].code]|join(",")' "$TMP/last"):$(code POST "/stock/receipts/$D/post" "$SK")" "expired:400"
D=$(mk "$SK" "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":1}]}"); echo "$D" >> "$TMP/drafts"
chk "ლოტი, ვადა, ფასი სავალდებულოა; მომწოდებლის გარეშე — გაფრთხილება" "$(jq -r '[.issues[]|"\(.level):\(.code)"]|sort|join(",")' "$TMP/last")" "error:expiry_required,error:lot_required,error:price_required,warn:no_supplier"
D=$(mk "$SK" "{\"location_id\":\"$LOC\",\"doc_date\":\"$DFUT\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":1,\"price\":1}]}"); echo "$D" >> "$TMP/drafts"
chk "მომავალი თარიღი — შეცდომა" "$(jq -r '[.issues[]|select(.level=="error")|.code]|join(",")' "$TMP/last")" "future_date"
D=$(mk "$SK" "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[{\"item_id\":\"$IMP\",\"qty\":2,\"lot_no\":\"I$S\",\"serial_no\":\"SN1-$S\",\"expires_on\":\"$D2Y\",\"price\":1000}]}"); echo "$D" >> "$TMP/drafts"
chk "სერიული: თითო ხაზი = 1 ერთეული" "$(jq -r '[.issues[]|select(.level=="error")|.code]|join(",")' "$TMP/last")" "serial_qty"
chk "ექთანი მიღებას ვერ ქმნის — 403" "$(code POST /stock/receipts "$NR" -d "{\"location_id\":\"$LOC\",\"lines\":[]}")" "403"
chk "ფარმაცევტი: სამეურნეოში — 403, აფთიაქში — 201" "$(code POST /stock/receipts "$PH" -d "{\"location_id\":\"$LOC2\",\"lines\":[]}"):$(api POST /stock/receipts "$PH" -d "{\"location_id\":\"$LOC\",\"lines\":[]}" | tee "$TMP/last" | jq -r '.status')" "403:draft"
jq -r .id "$TMP/last" >> "$TMP/drafts"
chk "უცნობი შეფუთვა (სხვისი) — 400" "$(code POST /stock/receipts "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$HOU\",\"pack_id\":\"$BOX\",\"qty\":1}]}")" "400"
chk "მონახაზის გაუქმება; გაუქმებული აღარ იცვლება — 409" "$(api POST "/stock/docs/$D/cancel" "$SK" -d '{"reason":"ტესტი"}' | jq -r .status):$(code PUT "/stock/receipts/$D" "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[]}")" "cancelled:409"

step "3. ლოტის ფასი და საშუალო (მეორე მიღება, დღგ-ს გარეშე ფასით)"
D2=$(mk "$SK" "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"prices_include_vat\":false,\"lines\":[{\"item_id\":\"$MED\",\"qty\":50,\"lot_no\":\"L1-$S\",\"expires_on\":\"$D2Y\",\"price\":12,\"vat_rate\":18}]}"); echo "$D2" >> "$TMP/docs"
chk "დღგ ზემოდან: 600.00 + 108.00" "$(jq -r '"\(.total_net|tonumber+0):\(.total_vat|tonumber+0)"' "$TMP/last")" "600:108"
chk "გატარება" "$(api POST "/stock/receipts/$D2/post" "$SK" | jq -r .status)" "posted"
LOTS=$(api GET "/stock/items/$MED/lots" "$NR")
chk "ლოტი L1: 100 ერთეული, ფასი შეწონილი 11.00" "$(echo "$LOTS" | jq -r "[.[]|select(.lot_no==\"L1-$S\")|\"\(.qty|tonumber+0):\(.unit_cost|tonumber+0)\"]|join(\"\")")" "100:11"
MV=$(api GET "/stock/items/$MED/moves" "$NR")
chk "საშუალო: (70×10 + 50×12) / 120 = 10.833333" "$(echo "$MV" | jq -r '"\(.qty_on_hand|tonumber+0):\(.avg_cost|tonumber+0)"')" "120:10.833333"
chk "ისტორია: 3 მოძრაობა, ბოლოს — cost_avg 10.833333" "$(echo "$MV" | jq -r '"\(.moves|length):\(.moves[0].cost_avg|tonumber+0)"')" "3:10.833333"
D=$(mk "$SK" "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":1,\"lot_no\":\"L1-$S\",\"expires_on\":\"$(date -d "$D2Y +1 month" +%F)\",\"price\":1}]}"); echo "$D" >> "$TMP/drafts"
chk "იგივე ლოტი სხვა ვადით — შეცდომა" "$(jq -r '[.issues[]|select(.level=="error")|.code]|join(",")' "$TMP/last")" "lot_expiry_mismatch"

step "4. სერიული (იმპლანტი)"
D3=$(mk "$SK" "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[{\"item_id\":\"$IMP\",\"qty\":1,\"lot_no\":\"I$S\",\"serial_no\":\"sn1-$S\",\"expires_on\":\"$D2Y\",\"price\":1180},{\"item_id\":\"$IMP\",\"qty\":1,\"lot_no\":\"I$S\",\"serial_no\":\"SN2-$S\",\"expires_on\":\"$D2Y\",\"price\":1180}]}"); echo "$D3" >> "$TMP/docs"
chk "ორი სერიული → გატარება, 2 ცალკე ლოტი" "$(api POST "/stock/receipts/$D3/post" "$SK" | jq -r .status):$(api GET "/stock/items/$IMP/lots" "$NR" | jq -r 'length')" "posted:2"
D=$(mk "$SK" "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[{\"item_id\":\"$IMP\",\"qty\":1,\"lot_no\":\"I$S\",\"serial_no\":\"SN1-$S\",\"expires_on\":\"$D2Y\",\"price\":1}]}"); echo "$D" >> "$TMP/drafts"
chk "იგივე სერიული მეორედ — შეცდომა" "$(jq -r '[.issues[]|select(.level=="error")|.code]|join(",")' "$TMP/last")" "serial_exists"
chk "ძებნა ნაშთებში სერიულით" "$(api GET "/stock/balances?search=SN2-$S" "$NR" | jq -r '.rows|length')" "1"

step "5. უცვლელობა და უფლებები"
chk "გატარებულის რედაქტირება — 409; გაუქმება — 409; ხელახლა გატარება — 409" \
  "$(code PUT "/stock/receipts/$D1" "$SK" -d "{\"location_id\":\"$LOC\",\"lines\":[]}"):$(code POST "/stock/docs/$D1/cancel" "$SK" -d '{}'):$(code POST "/stock/receipts/$D1/post" "$SK")" "409:409:409"
chk "საბაზო ერთეულის შეცვლა მოძრაობების შემდეგ — 400" "$(code PATCH "/stock/items/$MED" "$SM" -d '{"base_unit":"tablet"}')" "400"
chk "შემობრუნება: მესაწყობე — 403; მიზეზის გარეშე — 400" "$(code POST "/stock/docs/$D2/reverse" "$SK" -d '{"reason":"შეცდომა"}'):$(code POST "/stock/docs/$D2/reverse" "$SM" -d '{}')" "403:400"
chk "გატარება აუდიტშია" "$(api GET "/audit-logs?entity_name=stock_docs&entity_id=$D1&limit=10" "$ADM" | jq -r '[.[].action]|(index("POST_STOCK_RECEIPT")!=null) and (index("CREATE_STOCK_RECEIPT")!=null)')" "true"

step "6. თვითღირებულების მეთოდი (კლინიკის არჩევანი)"
ORIG=$(echo "$REFS" | jq -c '.settings|{costing_method,short_expiry_months}')
api PUT /stock/settings "$SM" -d '{"costing_method":"fifo","reason":"ტესტ-E2E"}' >/dev/null
V1=$(api GET "/stock/balances?location_id=$LOC&item_id=$MED" "$NR" | jq -r .total_value)
api PUT /stock/settings "$SM" -d '{"costing_method":"average","reason":"ტესტ-E2E"}' >/dev/null
V2=$(api GET "/stock/balances?location_id=$LOC&item_id=$MED" "$NR" | jq -r .total_value)
chk "FIFO: 100×11 + 20×10 = 1300; საშუალო: 120×10.833333 = 1300" "$V1:$V2" "1300:1300"
api PUT /stock/settings "$SM" -d "$(echo "$ORIG" | jq -c '. + {reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null

step "7. შემობრუნება"
RV=$(api POST "/stock/docs/$D2/reverse" "$SM" -d '{"reason":"ტესტ-E2E: ზედნადები შეცდომით გატარდა"}')
chk "RV-დოკუმენტი, უარყოფითი ჯამი, ბმა ორიგინალთან" "$(echo "$RV" | jq -r '"\(.doc_type):\(.doc_no|test("^RV")):\(.total_net|tonumber+0):\(.reversal_of_no!=null)"')" "reversal:true:-600:true"
chk "ორიგინალი: reversed_by" "$(api GET "/stock/docs/$D2" "$NR" | jq -r '.reversed_by_no|test("^RV")')" "true"
chk "ლოტი L1: 50 ერთეული, ფასი 10.00; საშუალო 10.00" \
  "$(api GET "/stock/items/$MED/lots" "$NR" | jq -r "[.[]|select(.lot_no==\"L1-$S\")|\"\(.qty|tonumber+0):\(.unit_cost|tonumber+0)\"]|join(\"\")"):$(api GET "/stock/items/$MED/moves" "$NR" | jq -r '.avg_cost|tonumber+0')" "50:10:10"
chk "მეორედ შემობრუნება — 409" "$(code POST "/stock/docs/$D2/reverse" "$SM" -d '{"reason":"კიდევ ერთხელ"}')" "409"
chk "მონახაზის შემობრუნება — 409" "$(code POST "/stock/docs/$(head -1 "$TMP/drafts")/reverse" "$SM" -d '{"reason":"მონახაზი"}')" "409"
chk "დოკუმენტების სია: მომწოდებლით — 3 მიღება + 1 შემობრუნება (გატარებული)" "$(api GET "/stock/docs?supplier_id=$SUP&status=posted" "$NR" | jq -r '[.[].doc_type]|sort|join(",")')" "receipt,receipt,receipt,reversal"
chk "ძებნა ნომრით" "$(api GET "/stock/docs?search=$DOCNO" "$NR" | jq -r "[.[]|select(.id==\"$D1\")]|length")" "1"

step "გასუფთავება"
for X in $(cat "$TMP/drafts"); do api POST "/stock/docs/$X/cancel" "$SK" -d '{"reason":"ტესტ-E2E"}' >/dev/null; done
for X in "$D1" "$D3"; do api POST "/stock/docs/$X/reverse" "$SM" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
chk "ყველა სატესტო მიღება შემობრუნებულია — ნაშთი 0" "$(api GET "/stock/balances?location_id=$LOC" "$NR" | jq -r '.rows|length')" "0"
chk "პარამეტრები დაბრუნებულია" "$(api GET /stock/refs "$NR" | jq -c '.settings|{costing_method,short_expiry_months}')" "$ORIG"
for X in "$MED" "$HOU" "$IMP"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/pharmacy/generics/$GEN" "$PH" -d '{"is_active":false}' >/dev/null
for X in "$LOC" "$LOC2"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/stock/suppliers/$SUP" "$SM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (ჟურნალი უცვლელი რჩება — ნაშთი 0)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
