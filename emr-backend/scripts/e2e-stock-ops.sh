#!/usr/bin/env bash
# =====================================================================
# e2e-stock-ops.sh — საწყობი, ეტაპი 4 (0033): ჩამოწერა, ინვენტარიზაცია (4A), ხარჯი პაციენტზე (+ ინვოისი კონფიგურაციით)
#   ჩამოწერა: მიზეზები, აღწერა, ზღვარი → დამტკიცება (საკუთარს ვერ ამტკიცებს), კონტროლირებადი/დაკარგული — ყოველთვის დამტკიცებით, უარი, შემობრუნება
#   ხარჯი: FEFO / სკანირებული ლოტი, სერიული — მხოლოდ კონკრეტული, ნაშთზე მეტი — 409, ბილინგი (ფასნამატი / ფიქსირებული / მხოლოდ აღრიცხვა),
#          ვიზიტის გარეშე — გაფრთხილება, შემობრუნება → ინვოისის ხაზი იშლება
#   ინვენტარიზაცია: ბრმა, ლოკაციის ბლოკი (გაცემა/ხარჯი/ჩამოწერა/მიღება — 409), ნაპოვნი ზედმეტი (ახალი ლოტი), დასრულება (ყველა ხაზი),
#          ხელახალი დათვლა, დამტკიცება → AD-დოკუმენტი (დანაკლისი/ზედმეტობა), ბლოკის მოხსნა, უფლებები, აუდიტი
# ყველაფერი სატესტო ლოკაციებზე; ბოლოს მარაგი 0-მდე ჩამოიწერება / შემობრუნდება, მონაცემები ითიშება.
# გამოყენება:  bash scripts/e2e-stock-ops.sh [API_URL]
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
DEP=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქირურგია $S\",\"code\":\"E2EC$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DEP2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E სხვა $S\",\"code\":\"E2ED$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DEP" ] && [ -n "$DEP2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [department_id]
  local dep=""; [ -n "${3:-}" ] && dep=",\"department_id\":\"$3\""
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ops.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ოპერაცია-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1$dep}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.ops.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole osk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole osm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 91); SM=$(mkuser "[\"$R_SM\"]" 92); PH=$(mkuser '["pharmacist"]' 93); NR=$(mkuser '["nurse"]' 94 "$DEP"); NO=$(mkuser '["nurse"]' 95 "$DEP2")
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && [ -n "$NO" ] && ok "5 მომხმარებელი (მესაწყობე, მენეჯერი, ფარმაცევტი, ექთანი, სხვა განყოფილების ექთანი)" || die "მომხმარებლები ვერ შეიქმნა"
REFS=$(api GET /stock/refs "$SM"); cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
ORIG=$(echo "$REFS" | jq -c '.settings|{costing_method,short_expiry_months,writeoff_approval_threshold:(.writeoff_approval_threshold|tonumber)}')
api PUT /stock/settings "$SM" -d '{"costing_method":"fifo","writeoff_approval_threshold":100,"reason":"ტესტ-E2E"}' >/dev/null
SUB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_OS_$S\",\"name\":\"ტესტ-E2E ქირურგიის ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\"}" | jq -r '.id // empty')
CAT=$(api POST /stock/categories "$SM" -d "{\"code\":\"E2E_CN$S\",\"name\":\"ტესტ-E2E ბილინგი $S\",\"kind\":\"medical_supply\",\"billing_mode\":\"invoice\",\"markup_pct\":20}" | jq -r '.id // empty')
G1=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E კეტოროლაკი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"30 მგ/მლ\"}" | jq -r '.id // empty')
G2=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E მორფინი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ/მლ\",\"controlled_class\":\"narcotic\",\"patient_only\":true}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Ketorol $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$G1\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty')
CTL=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Morphine $S\",\"category_id\":\"$(cat_id MED)\",\"generic_id\":\"$G2\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty')
SUP=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E კათეტერი $S\",\"category_id\":\"$CAT\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
SUP2=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ნაკერი $S\",\"category_id\":\"$CAT\",\"base_unit\":\"piece\",\"sale_price\":7.5}" | jq -r '.id // empty')
IMP=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ბადე $S\",\"category_id\":\"$(cat_id IMPLANT)\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
[ -n "$SUB" ] && [ -n "$CAT" ] && [ -n "$MED" ] && [ -n "$CTL" ] && [ -n "$SUP" ] && [ -n "$SUP2" ] && [ -n "$IMP" ] && ok "ქვესაწყობი, კატეგორია (ინვოისში +20%), საქონელი (მედიკამენტი, ნარკოტიკული, მასალა ×2, იმპლანტი)" || die "მონაცემები ვერ შეიქმნა"
RC=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$SUB\",\"lines\":[
 {\"item_id\":\"$MED\",\"qty\":10,\"lot_no\":\"K1$S\",\"expires_on\":\"$D1Y\",\"price\":2,\"vat_rate\":0},
 {\"item_id\":\"$MED\",\"qty\":10,\"lot_no\":\"K2$S\",\"expires_on\":\"$D2Y\",\"price\":3,\"vat_rate\":0},
 {\"item_id\":\"$CTL\",\"qty\":5,\"lot_no\":\"M$S\",\"expires_on\":\"$D2Y\",\"price\":4,\"vat_rate\":0},
 {\"item_id\":\"$SUP\",\"qty\":20,\"lot_no\":\"C$S\",\"expires_on\":\"$D2Y\",\"price\":10,\"vat_rate\":0},
 {\"item_id\":\"$SUP2\",\"qty\":10,\"lot_no\":\"N$S\",\"expires_on\":\"$D2Y\",\"price\":3,\"vat_rate\":0},
 {\"item_id\":\"$IMP\",\"qty\":1,\"lot_no\":\"I$S\",\"serial_no\":\"S1-$S\",\"expires_on\":\"$D2Y\",\"price\":500,\"vat_rate\":0},
 {\"item_id\":\"$IMP\",\"qty\":1,\"lot_no\":\"I$S\",\"serial_no\":\"S2-$S\",\"expires_on\":\"$D2Y\",\"price\":500,\"vat_rate\":0}]}" | jq -r '.id // empty')
chk "საწყისი მარაგი ქვესაწყობში (მიღება)" "$(api POST "/stock/receipts/$RC/post" "$SK" | jq -r .status)" "posted"
lot() { api GET "/stock/items/$1/lots" "$SK" | jq -r ".[]|select(.lot_no==\"$2\" and ((.serial_no//\"\")==\"${3:-}\")).id"; }
LK1=$(lot "$MED" "K1$S"); LK2=$(lot "$MED" "K2$S"); LM=$(lot "$CTL" "M$S"); LC=$(lot "$SUP" "C$S"); LS1=$(lot "$IMP" "I$S" "S1-$S"); LS2=$(lot "$IMP" "I$S" "S2-$S")
TC=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2E_OPS_$S\",\"title\":\"ტესტ-E2E კონსულტაცია\",\"base_price\":0}" | jq -r '.id // empty')
DOC=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ops.doc.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ექიმი\",\"personal_number\":\"96$(printf '%09d' "$S")\",\"role\":\"doctor\",\"department_id\":\"$DEP\",\"specialty\":\"ქირურგი\",\"license_number\":\"MD-O$S\",\"consultation_tariff_id\":\"$TC\"}" | jq -r '.user.id // empty')
echo "$DOC" >> "$TMP/users"
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"6$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ხარჯი\",\"birth_date\":\"1975-03-03\",\"gender\":\"male\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty')
ENC=$(api POST /encounters/walk-in "$ADM" -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOC\"}" | jq -r '.encounter_id // empty')
INV0=$(api GET "/invoices/encounter/$ENC" "$ADM" | jq -r '.total_amount|tonumber+0')
[ -n "$PAT" ] && [ -n "$ENC" ] && ok "პაციენტი + ვიზიტი (ინვოისი: $INV0 ₾)" || die "პაციენტი / ვიზიტი ვერ შეიქმნა"

step "1. ჩამოწერა"
chk "აღწერის გარეშე (დაზიანებული) — 400" "$(code POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":1}]}")" "400"
chk "„ვადაგასული“ ვადიან ლოტზე — 400" "$(code POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"expired\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":1}]}")" "400"
chk "სხვა განყოფილების ექთანი — 403" "$(code POST /stock/writeoffs "$NO" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"გატყდა\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":1}]}")" "403"
W1=$(api POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E: ამპულა გატყდა\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":1}]}")
chk "ზღვარზე ნაკლები (2 ₾) → მაშინვე გატარდა (WO)" "$(echo "$W1" | jq -r '"\(.status):\(.doc_no|test("^WO")):\(.approval_status)"')" "posted:true:null"
chk "ნაშთი: K1 9" "$(bal "$SUB" "$MED")" "K1$S:9,K2$S:10"
W2=$(api POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E: ყუთი დასველდა\",\"lines\":[{\"lot_id\":\"$LC\",\"qty_base\":11}]}"); W2ID=$(echo "$W2" | jq -r .id)
chk "ზღვარზე მეტი (110 ₾) → დასამტკიცებელი, ნაშთი უცვლელი" "$(echo "$W2" | jq -r '"\(.status):\(.approval_status)"'):$(bal "$SUB" "$SUP")" "draft:pending:C$S:20"
chk "შეტყობინება საწყობის მენეჯერს" "$(api GET "/notifications?unread=true" "$SM" | jq -r '[.[]|select(.kind=="stock_writeoff")]|length')" "1"
chk "ექთანი ვერ ამტკიცებს — 403" "$(code POST "/stock/writeoffs/$W2ID/decide" "$NR" -d '{"approve":true}')" "403"
chk "უარი მიზეზის გარეშე — 400; მიზეზით — გაუქმდა" "$(code POST "/stock/writeoffs/$W2ID/decide" "$SM" -d '{"approve":false}'):$(api POST "/stock/writeoffs/$W2ID/decide" "$SM" -d '{"approve":false,"reason":"ტესტ-E2E: გადაამოწმეთ რაოდენობა"}' | jq -r '"\(.status):\(.approval_status)"')" "400:cancelled:rejected"
W3ID=$(api POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"lost\",\"notes\":\"ტესტ-E2E: ვერ მოიძებნა\",\"lines\":[{\"lot_id\":\"$LK2\",\"qty_base\":1}]}" | jq -r .id)
chk "დაკარგული — ყოველთვის დამტკიცებით; მენეჯერი ამტკიცებს → WO" "$(api GET "/stock/writeoffs?pending=true" "$SM" | jq -r "[.[]|select(.id==\"$W3ID\")]|length"):$(api POST "/stock/writeoffs/$W3ID/decide" "$SM" -d '{"approve":true}' | jq -r '"\(.status):\(.approval_status)"')" "1:posted:approved"
chk "ნარკოტიკული „განყოფილების ხარჯით“ — 400" "$(code POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"department_use\",\"notes\":\"x x x\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":1}]}")" "400"
W4=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E: ამპულა გატყდა\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":1}]}")
chk "ნარკოტიკული (4 ₾) — დამტკიცებით; საკუთარს ვერ ამტკიცებს — 403" "$(echo "$W4" | jq -r .approval_status):$(code POST "/stock/writeoffs/$(echo "$W4" | jq -r .id)/decide" "$SM" -d '{"approve":true}')" "pending:403"
api POST "/stock/writeoffs/$(echo "$W4" | jq -r .id)/decide" "$ADM" -d '{"approve":true}' >/dev/null
chk "ნაშთზე მეტი — 400" "$(code POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"x x x\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":99}]}")" "400"
W1ID=$(echo "$W1" | jq -r .id)
chk "შემობრუნება: ექთანი — 403; მენეჯერი → RV, ნაშთი K1 10" "$(code POST "/stock/docs/$W1ID/reverse" "$NR" -d '{"reason":"შეცდომა"}'):$(api POST "/stock/docs/$W1ID/reverse" "$SM" -d '{"reason":"ტესტ-E2E: არ გატეხილა"}' | jq -r '.doc_no|test("^RV")'):$(bal "$SUB" "$MED")" "403:true:K1$S:10,K2$S:9"

step "2. ხარჯი პაციენტზე"
C1=$(api POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"encounter_id\":\"$ENC\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":12},{\"item_id\":\"$SUP\",\"qty_base\":2},{\"item_id\":\"$SUP2\",\"qty_base\":3}]}")
chk "FEFO: K1 10 + K2 2; CN-ნომერი" "$(echo "$C1" | jq -r '[.lines[]|select(.item_name|test("Ketorol"))|"\(.lot_no):\(.qty_base|tonumber+0)"]|join(",")'):$(echo "$C1" | jq -r '.doc_no|test("^CN")')" "K1$S:10,K2$S:2:true"
chk "ბილინგი: მედიკამენტი — მხოლოდ აღრიცხვა; კათეტერი 10×1.2 = 12.00; ნაკერი — ფიქსირებული 7.50" \
  "$(echo "$C1" | jq -r '[.lines[]|"\(.invoiced):\(.sale_price//"-")"]|join(",")')" "false:-,false:-,true:12.00,true:7.50"
chk "ინვოისი: + 2×12.00 + 3×7.50 = +46.50" "$(api GET "/invoices/encounter/$ENC" "$ADM" | jq -r '.total_amount|tonumber+0')" "$(jq -n "$INV0 + 46.5")"
chk "ნაშთი: K1 — 0, K2 7; კათეტერი 18" "$(bal "$SUB" "$MED")|$(bal "$SUB" "$SUP")" "K2$S:7|C$S:18"
chk "სხვა განყოფილების ექთანი — 403; ნაშთზე მეტი — 409" "$(code POST /stock/consumptions "$NO" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":1}]}"):$(code POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":50}]}")" "403:409"
chk "იმპლანტი სერიულის გარეშე — 400" "$(code POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"encounter_id\":\"$ENC\",\"lines\":[{\"item_id\":\"$IMP\",\"qty_base\":1}]}")" "400"
C2=$(api POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"encounter_id\":\"$ENC\",\"lines\":[{\"item_id\":\"$IMP\",\"qty_base\":1,\"lot_id\":\"$LS2\"},{\"item_id\":\"$CTL\",\"qty_base\":1}]}")
chk "იმპლანტი (სკანირებული სერიული S2) + ნარკოტიკული → პაციენტზე" "$(echo "$C2" | jq -r '[.lines[]|.serial_no//.lot_no]|join(",")')" "S2-$S,M$S"
chk "ვიზიტის გარეშე, ინვოისის საქონელი → გაფრთხილება, ინვოისში არა" "$(api POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$SUP\",\"qty_base\":1}]}" | jq -r '"\(.warnings|length):\(.lines[0].invoiced)"')" "1:false"
chk "პაციენტის ხარჯები (სია): 3" "$(api GET "/stock/consumptions?patient_id=$PAT" "$NR" | jq length)" "3"
chk "ნაშთის ისტორიაში — პაციენტზე მიბმული მოძრაობა" "$(api GET "/stock/items/$IMP/moves" "$SK" | jq -r '[.moves[]|select(.qty|tonumber<0)]|length')" "1"
C1ID=$(echo "$C1" | jq -r .id)
chk "ხარჯის შემობრუნება → მარაგი უკან, ინვოისის ხაზები იშლება" "$(api POST "/stock/docs/$C1ID/reverse" "$SM" -d '{"reason":"ტესტ-E2E: სხვა პაციენტზე უნდა ყოფილიყო"}' | jq -r '.doc_no|test("^RV")'):$(bal "$SUB" "$MED"):$(api GET "/invoices/encounter/$ENC" "$ADM" | jq -r '.total_amount|tonumber+0')" "true:K1$S:10,K2$S:9:$INV0"

step "3. ინვენტარიზაცია (ბრმა, ლოკაციის ბლოკით — 4A)"
chk "სხვა განყოფილების ექთანი ვერ იწყებს — 403" "$(code POST /stock/counts "$NO" -d "{\"location_id\":\"$SUB\"}")" "403"
CT=$(api POST /stock/counts "$NR" -d "{\"location_id\":\"$SUB\",\"notes\":\"ტესტ-E2E\"}"); CTID=$(echo "$CT" | jq -r .id)
NL=$(echo "$CT" | jq -r '.lines|length')
chk "დაწყება: IC-ნომერი, ხაზები ნაშთიდან, ბრმა — სისტემური რაოდენობა არ ჩანს" "$(echo "$CT" | jq -r '"\(.count_no|test("^IC")):\(.status):\(.blind):\([.lines[].expected_qty]|unique|join(","))"'):$NL" "true:open:true::6"
chk "მეორე ინვენტარიზაცია იმავე ლოკაციაზე — 409" "$(code POST /stock/counts "$SK" -d "{\"location_id\":\"$SUB\"}")" "409"
chk "ბლოკი: ხარჯი / ჩამოწერა — 409" "$(code POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":1}]}"):$(code POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"x x x\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":1}]}")" "409:409"
RB=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$SUB\",\"lines\":[{\"item_id\":\"$SUP\",\"qty\":1,\"lot_no\":\"C$S\",\"expires_on\":\"$D2Y\",\"price\":10,\"vat_rate\":0}]}" | jq -r .id)
chk "ბლოკი: მიღების გატარება — 409 (ბაზის დონეზე)" "$(code POST "/stock/receipts/$RB/post" "$SK")" "409"
api POST "/stock/docs/$RB/cancel" "$SK" -d '{}' >/dev/null
chk "დასრულება დაუთვლელი ხაზებით — 400" "$(code POST "/stock/counts/$CTID/submit" "$NR")" "400"
# დათვლა: K1 10 (სწორი), K2 8 (−1), M 3 (სწორი), C 16 (−3; ნაშთი 19), N 10 (სწორი), S1 1 (სწორი)
BODY=$(echo "$CT" | jq -c --arg s "$S" '{lines:[.lines[]|{id, counted_qty:(if .lot_no==("K2"+$s) then 8 elif .lot_no==("C"+$s) then 16 elif .lot_no==("K1"+$s) then 10 elif .lot_no==("M"+$s) then 3 elif .lot_no==("N"+$s) then 10 else 1 end)}]}')
chk "დათვლა (ყველა ხაზი) — სისტემური ისევ არ ჩანს" "$(api PUT "/stock/counts/$CTID/lines" "$NR" -d "$BODY" | jq -r '"\([.lines[]|select(.counted_qty!=null)]|length):\(.totals)"')" "$NL:null"
chk "ნაპოვნი: ახალი ლოტი (K9, 2 ამპულა)" "$(api POST "/stock/counts/$CTID/extra" "$NR" -d "{\"item_id\":\"$MED\",\"lot_no\":\"K9$S\",\"expires_on\":\"$D1Y\",\"counted_qty\":2,\"note\":\"თაროს უკან\"}" | jq -r '[.lines[]|select(.is_extra)]|length')" "1"
chk "სიაში არსებული ლოტის დამატება — 409" "$(code POST "/stock/counts/$CTID/extra" "$NR" -d "{\"item_id\":\"$MED\",\"lot_id\":\"$LK1\",\"counted_qty\":1}")" "409"
chk "დასრულება → counted; ახლა სხვაობა ჩანს (დანაკლისი −1×3 −3×10 = −33, ზედმეტობა +2×K9)" \
  "$(api POST "/stock/counts/$CTID/submit" "$NR" | jq -r '"\(.status):\(.totals.shortage):\(.totals.lines_diff)"')" "counted:-33:3"
chk "დათვლილზე ცვლილება — 409; ექთანი ვერ ამტკიცებს — 403" "$(code PUT "/stock/counts/$CTID/lines" "$NR" -d "$BODY"):$(code POST "/stock/counts/$CTID/approve" "$NR")" "409:403"
chk "ხელახალი დათვლა (მენეჯერი, მიზეზით) → open" "$(api POST "/stock/counts/$CTID/recount" "$SM" -d '{"reason":"ტესტ-E2E: კათეტერი გადათვალეთ"}' | jq -r .status)" "open"
LCL=$(echo "$CT" | jq -r ".lines[]|select(.lot_no==\"C$S\").id")
api PUT "/stock/counts/$CTID/lines" "$NR" -d "{\"lines\":[{\"id\":\"$LCL\",\"counted_qty\":17}]}" >/dev/null
api POST "/stock/counts/$CTID/submit" "$NR" >/dev/null
AP=$(api POST "/stock/counts/$CTID/approve" "$SM")
chk "დამტკიცება → AD-დოკუმენტი, ლოკაცია განიბლოკა" "$(echo "$AP" | jq -r '"\(.status):\(.adjustment_no|test("^AD"))"'):$(code POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"lot_id\":\"$LK1\",\"qty_base\":1}]}")" "approved:true:201"
chk "ნაშთი: K1 9 (ჩამოწერის შემდეგ), K2 8, K9 2; კათეტერი 17" "$(bal "$SUB" "$MED")|$(bal "$SUB" "$SUP")" "K1$S:9,K2$S:8,K9$S:2|C$S:17"
chk "აუდიტი: დაწყება, დასრულება, დამტკიცება" "$(api GET "/audit-logs?entity_name=stock_counts&entity_id=$CTID&limit=20" "$ADM" | jq -r '[.[].action]|(index("START_STOCK_COUNT")!=null) and (index("SUBMIT_STOCK_COUNT")!=null) and (index("APPROVE_STOCK_COUNT")!=null)')" "true"
CT2=$(api POST /stock/counts "$SK" -d "{\"location_id\":\"$SUB\",\"blind\":false,\"category_id\":\"$CAT\"}"); CT2ID=$(echo "$CT2" | jq -r .id)
chk "კატეგორიით, არა-ბრმა: მხოლოდ მასალა, რაოდენობა ჩანს; გაუქმება (მიზეზით) → ბლოკი იხსნება" \
  "$(echo "$CT2" | jq -r '"\(.lines|length):\(.lines[0].expected_qty!=null)"'):$(api POST "/stock/counts/$CT2ID/cancel" "$SM" -d '{"reason":"ტესტ-E2E"}' | jq -r .status)" "2:true:cancelled"

step "გასუფთავება"
api GET "/stock/balances?location_id=$SUB" "$SM" | jq -r '.rows[]|"\(.lot_id) \(.qty|tonumber)"' > "$TMP/left"
LINES=$(awk '{printf "%s{\"lot_id\":\"%s\",\"qty_base\":%s}", (NR>1?",":""), $1, $2}' "$TMP/left")
WC=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":[$LINES]}" | jq -r '.id // empty')
[ -n "$WC" ] && api POST "/stock/writeoffs/$WC/decide" "$ADM" -d '{"approve":true}' >/dev/null
chk "სატესტო ქვესაწყობის ნაშთი — 0" "$(api GET "/stock/balances?location_id=$SUB" "$SM" | jq -r '.rows|length')" "0"
api PUT /stock/settings "$SM" -d "$(echo "$ORIG" | jq -c '. + {reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "პარამეტრები დაბრუნებულია" "$(api GET /stock/refs "$NR" | jq -c '.settings|{costing_method,short_expiry_months,writeoff_approval_threshold:(.writeoff_approval_threshold|tonumber)}')" "$ORIG"
for X in "$MED" "$CTL" "$SUP" "$SUP2" "$IMP"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$G1" "$G2"; do api PATCH "/pharmacy/generics/$X" "$PH" -d '{"is_active":false}' >/dev/null; done
api PATCH "/stock/locations/$SUB" "$SM" -d '{"is_active":false}' >/dev/null; api PATCH "/stock/categories/$CAT" "$SM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$DEP" "$DEP2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (პაციენტი და ვიზიტი რჩება — „ტესტ-E2E“)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
