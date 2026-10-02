#!/usr/bin/env bash
# =====================================================================
# e2e-stock-controlled.sh — აფთიაქი (0035): ნარკოტიკული და ფსიქოტროპული საშუალებები
#   ხარჯი პაციენტზე: მიღებული დოზა + ნარჩენი (ჯამი = რაოდენობა × აქტ. ნივთიერება), მოწმე (სხვა პირი, საკუთარი პაროლით, სამედიცინო/საწყობის როლი),
#   ცარიელი ამპულის დაბრუნება (ნარკოტიკული; აფთიაქი ადასტურებს), ჩამოწერა მოწმით, ჟურნალი (საწყისი → მოძრაობები → ნაშთი, მხარე, მოწმე),
#   ცვლის ჩაბარება (ორი პირი; სხვაობა → სასწრაფო შეტყობინება), შემაჯამებელი, უფლებები, აუდიტი
# ბოლოს სატესტო მარაგი ჩამოიწერება (ნაშთი 0), მონაცემები ითიშება.
# გამოყენება:  bash scripts/e2e-stock-controlled.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F)
bal()  { api GET "/stock/balances?location_id=$1&item_id=$2" "$ADM" | jq -r '[.rows[]|"\(.lot_no//"-"):\(.qty|tonumber+0)"]|sort|join(",")'; }
wit()  { echo "{\"username\":\"e2e.nrc.$1.$S@test.local\",\"password\":\"${2:-E2e-$S-pass-$1}\"}"; }

step "0. მომზადება"
DEP=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E რეანიმაცია $S\",\"code\":\"E2EN$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DEP2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E სხვა $S\",\"code\":\"E2EO$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DEP" ] && [ -n "$DEP2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json]
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.nrc.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ნარკ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.nrc.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole nsk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole nsm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 51); SM=$(mkuser "[\"$R_SM\"]" 52); PH=$(mkuser '["pharmacist"]' 53)
NR=$(mkuser '["nurse"]' 54 ",\"department_id\":\"$DEP\""); NR2=$(mkuser '["nurse"]' 55 ",\"department_id\":\"$DEP\""); NO=$(mkuser '["nurse"]' 56 ",\"department_id\":\"$DEP2\""); RC=$(mkuser '["receptionist"]' 57)
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && [ -n "$NR2" ] && [ -n "$NO" ] && [ -n "$RC" ] && ok "7 მომხმარებელი (საწყობი, ფარმაცევტი, ექთანი ×2, სხვა განყოფილების ექთანი, რეგისტრატორი)" || die "მომხმარებლები ვერ შეიქმნა"
REFS=$(api GET /stock/refs "$SM"); MEDC=$(echo "$REFS" | jq -r '.categories[]|select(.code=="MED").id')
PHL=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_NP_$S\",\"name\":\"ტესტ-E2E აფთიაქი $S\",\"kind\":\"pharmacy\"}" | jq -r '.id // empty')
SUB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_NS_$S\",\"name\":\"ტესტ-E2E რეანიმაციის ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\"}" | jq -r '.id // empty')
GM=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E მორფინი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ/მლ\",\"controlled_class\":\"narcotic\",\"dose_unit\":\"mg\",\"dose_per_unit\":10}" | jq -r '.id // empty')
GD=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E დიაზეპამი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ/2 მლ\",\"controlled_class\":\"psychotropic\",\"dose_unit\":\"mg\",\"dose_per_unit\":10}" | jq -r '.id // empty')
MOR=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Morphini 1% $S\",\"category_id\":\"$MEDC\",\"generic_id\":\"$GM\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty')
DIA=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Relanium $S\",\"category_id\":\"$MEDC\",\"generic_id\":\"$GD\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty')
[ -n "$PHL" ] && [ -n "$SUB" ] && [ -n "$MOR" ] && [ -n "$DIA" ] && ok "აფთიაქი, რეანიმაციის ქვესაწყობი, მორფინი (ნარკოტიკული, 10 მგ/ამპ.), დიაზეპამი (ფსიქოტროპული)" || die "მონაცემები ვერ შეიქმნა"
RC1=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$PHL\",\"lines\":[{\"item_id\":\"$MOR\",\"qty\":20,\"lot_no\":\"M$S\",\"expires_on\":\"$D2Y\",\"price\":2,\"vat_rate\":0},{\"item_id\":\"$DIA\",\"qty\":10,\"lot_no\":\"D$S\",\"expires_on\":\"$D2Y\",\"price\":1,\"vat_rate\":0}]}" | jq -r .id)
api POST "/stock/receipts/$RC1/post" "$SK" >/dev/null
LM=$(api GET "/stock/items/$MOR/lots" "$SK" | jq -r '.[0].id'); LD=$(api GET "/stock/items/$DIA/lots" "$SK" | jq -r '.[0].id')
T1=$(api POST /stock/transfers "$PH" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":10},{\"lot_id\":\"$LD\",\"qty_base\":5}]}" | jq -r '.id // empty')
api POST "/stock/docs/$T1/receive" "$NR" -d '{"action":"receive"}' >/dev/null
chk "მიღება აფთიაქში → გადაცემა რეანიმაციაში (მორფინი 10, დიაზეპამი 5)" "$(bal "$SUB" "$MOR")|$(bal "$SUB" "$DIA")" "M$S:10|D$S:5"
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"8$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ანალგეზია\",\"birth_date\":\"1970-05-05\",\"gender\":\"male\",\"phone_number\":\"596$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] && ok "სატესტო პაციენტი" || die "პაციენტი ვერ შეიქმნა"

step "1. ხარჯი პაციენტზე: დოზა, ნარჩენი, მოწმე"
CN() { api POST /stock/consumptions "$1" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[$2]${3:+,\"witness\":$3}}"; }
cc() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/stock/consumptions" -H "authorization: Bearer $1" -H "$J" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[$2]${3:+,\"witness\":$3}}"; }
L1="{\"item_id\":\"$MOR\",\"qty_base\":1,\"dose_given\":5,\"dose_wasted\":5}"
chk "დოზის გარეშე — 400" "$(cc "$NR" "{\"item_id\":\"$MOR\",\"qty_base\":1}" "$(wit 55)")" "400"
chk "მოწმის გარეშე — 400" "$(cc "$NR" "$L1")" "400"
chk "არასწორი პაროლი — 400; საკუთარი თავი — 400" "$(cc "$NR" "$L1" "$(wit 55 wrong-pass)"):$(cc "$NR" "$L1" "$(wit 54)")" "400:400"
chk "რეგისტრატორი მოწმედ — 403" "$(cc "$NR" "$L1" "$(wit 57)")" "403"
chk "მიღებული + ნარჩენი ≠ 10 მგ — 400" "$(cc "$NR" "{\"item_id\":\"$MOR\",\"qty_base\":1,\"dose_given\":5,\"dose_wasted\":2}" "$(wit 55)")" "400"
C1=$(CN "$NR" "$L1,{\"item_id\":\"$DIA\",\"qty_base\":1,\"dose_given\":10}" "$(wit 55)")
chk "მორფინი 5 მგ + ნარჩენი 5 მგ, დიაზეპამი 10 მგ — მოწმით; CN" "$(echo "$C1" | jq -r '"\(.doc_no|test("^CN")):\(.witness_name|test("ნარკ-55")):\([.lines[]|"\(.dose_given|tonumber+0)+\(.dose_wasted|tonumber+0)\(.dose_unit)"]|join(","))"')" "true:true:5+5mg,10+0mg"
chk "მოწმის დადასტურება აუდიტშია" "$(api GET "/audit-logs?action=WITNESS_CONFIRMED&limit=50" "$ADM" | jq -r '[.[]|select(.new_data.purpose=="consumption")]|length>0')" "true"
chk "ნაშთი: მორფინი 9, დიაზეპამი 4" "$(bal "$SUB" "$MOR")|$(bal "$SUB" "$DIA")" "M$S:9|D$S:4"

step "2. ცარიელი ამპულები"
chk "დასაბრუნებელი: 1 (მხოლოდ ნარკოტიკული)" "$(api GET "/stock/controlled/empties?location_id=$SUB" "$NR" | jq length)" "1"
EL=$(api GET "/stock/controlled/empties?location_id=$SUB" "$PH" | jq -c '[.[].id]')
chk "ექთანი ვერ ადასტურებს — 403" "$(code POST /stock/controlled/empties/confirm "$NR" -d "{\"line_ids\":$EL}")" "403"
chk "ფარმაცევტი იღებს ცარიელს → 0 დარჩა; მეორედ — 400" "$(api POST /stock/controlled/empties/confirm "$PH" -d "{\"line_ids\":$EL}" | jq -r .confirmed):$(api GET "/stock/controlled/empties?location_id=$SUB" "$NR" | jq length):$(code POST /stock/controlled/empties/confirm "$PH" -d "{\"line_ids\":$EL}")" "1:0:400"

step "3. ჩამოწერა მოწმით"
WB="{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E: ამპულა გატყდა\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":1}]"
chk "მოწმის გარეშე — 400" "$(code POST /stock/writeoffs "$NR" -d "$WB}")" "400"
W=$(api POST /stock/writeoffs "$NR" -d "$WB,\"witness\":$(wit 55)}")
chk "მოწმით → დასამტკიცებელი (კონტროლირებადი), მენეჯერი ამტკიცებს" "$(echo "$W" | jq -r '"\(.approval_status):\(.witness_name|test("ნარკ-55"))"'):$(api POST "/stock/writeoffs/$(echo "$W" | jq -r .id)/decide" "$SM" -d '{"approve":true}' | jq -r .status)" "pending:true:posted"

step "4. ჟურნალი"
RG=$(api GET "/stock/controlled/register?location_id=$SUB&from=$TODAY&to=$TODAY" "$NR")
chk "რეანიმაცია: 2 საქონელი; მორფინი: საწყისი 0 → +10 (აფთიაქიდან) → −1 (პაციენტი, მოწმე) → −1 (ჩამოწერა) = 8" \
  "$(echo "$RG" | jq -r --arg n "ტესტ-E2E Morphini 1% $S" '"\(.items|length):" + ([.items[]|select(.item.name==$n)|"\(.opening):\([.rows[]|"\(.in-.out)"]|join(",")):\(.closing)"]|join(""))')" "2:0:10,-1,-1:8"
chk "ჟურნალის ხაზზე: მხარე, მოწმე, დოზა" "$(echo "$RG" | jq -r --arg n "ტესტ-E2E Morphini 1% $S" '.items[]|select(.item.name==$n)|.rows[]|select(.move_type=="consumption")|"\(.party|test("ანალგეზია")):\(.witness_name!=null):\(.dose_given|tonumber+0)"')" "true:true:5"
chk "აფთიაქის ჟურნალი: +20 −10 = 10" "$(api GET "/stock/controlled/register?location_id=$PHL&item_id=$MOR&from=$TODAY&to=$TODAY" "$PH" | jq -r '.items[0]|"\([.rows[]|"\(.in-.out)"]|join(",")):\(.closing)"')" "20,-10:10"
chk "სხვა განყოფილების ექთანი — 403" "$(code GET "/stock/controlled/register?location_id=$SUB&from=$TODAY&to=$TODAY" "$NO")" "403"

step "5. ცვლის ჩაბარება"
TPL=$(api GET "/stock/controlled/shift/template?location_id=$SUB" "$NR")
chk "შაბლონი: 2 ლოტი (მორფინი 8, დიაზეპამი 4)" "$(echo "$TPL" | jq -r '[.[]|.expected_qty|tonumber+0]|sort|join(",")')" "4,8"
OKL=$(echo "$TPL" | jq -c '[.[]|{lot_id, counted_qty:(.expected_qty|tonumber)}]')
chk "ლოტი აკლია — 400; მოწმე — საკუთარი თავი — 400" \
  "$(code POST /stock/controlled/shift "$NR" -d "{\"location_id\":\"$SUB\",\"witness\":$(wit 55),\"lines\":$(echo "$OKL" | jq -c '.[0:1]')}"):$(code POST /stock/controlled/shift "$NR" -d "{\"location_id\":\"$SUB\",\"witness\":$(wit 54),\"lines\":$OKL}")" "400:400"
chk "ცვლა ჩაბარდა — სხვაობის გარეშე (ok)" "$(api POST /stock/controlled/shift "$NR" -d "{\"location_id\":\"$SUB\",\"witness\":$(wit 55),\"lines\":$OKL}" | jq -r '"\(.shift_no|test("^SH")):\(.status)"')" "true:ok"
BADL=$(echo "$TPL" | jq -c '[.[]|{lot_id, counted_qty:(if (.expected_qty|tonumber)==8 then 7 else (.expected_qty|tonumber) end)}]')
SH=$(api POST /stock/controlled/shift "$NR2" -d "{\"location_id\":\"$SUB\",\"witness\":$(wit 54),\"notes\":\"ტესტ-E2E\",\"lines\":$BADL}")
chk "სხვაობა (მორფინი 7 ≠ 8) → discrepancy + სასწრაფო შეტყობინება მენეჯერს" "$(echo "$SH" | jq -r .status):$(api GET "/notifications?unread=true" "$SM" | jq -r '[.[]|select(.kind=="stock_shift" and .urgent)]|length')" "discrepancy:1"
chk "ისტორია: 2 ჩაბარება" "$(api GET "/stock/controlled/shifts?location_id=$SUB" "$NR" | jq length)" "2"
chk "შემაჯამებელი: რეანიმაცია — მორფინი 8, დიაზეპამი 4; დაუბრუნებელი ცარიელი — 0" \
  "$(api GET /stock/controlled/summary "$NR" | jq -r "[.rows[]|select(.location_id==\"$SUB\")|.qty|tonumber+0]|sort|join(\",\")"):$(api GET "/stock/controlled/empties?location_id=$SUB" "$SM" | jq length)" "4,8:0"

step "6. შემობრუნება"
chk "ხარჯის შემობრუნება → მორფინი 9, დიაზეპამი 5" "$(api POST "/stock/docs/$(echo "$C1" | jq -r .id)/reverse" "$SM" -d '{"reason":"ტესტ-E2E: შეცდომით"}' | jq -r '.doc_no|test("^RV")'):$(bal "$SUB" "$MOR")|$(bal "$SUB" "$DIA")" "true:M$S:9|D$S:5"

step "გასუფთავება"
for L in "$SUB" "$PHL"; do
  LN=$(api GET "/stock/balances?location_id=$L" "$SM" | jq -c '[.rows[]|{lot_id, qty_base:(.qty|tonumber)}]')
  WC=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$L\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"witness\":$(wit 53),\"lines\":$LN}" | jq -r '.id // empty')
  [ -n "$WC" ] && api POST "/stock/writeoffs/$WC/decide" "$ADM" -d '{"approve":true}' >/dev/null
done
chk "სატესტო ნაშთი — 0" "$(api GET "/stock/balances?location_id=$SUB" "$SM" | jq '.rows|length'):$(api GET "/stock/balances?location_id=$PHL" "$SM" | jq '.rows|length')" "0:0"
for X in "$MOR" "$DIA"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$GM" "$GD"; do api PATCH "/pharmacy/generics/$X" "$PH" -d '{"is_active":false}' >/dev/null; done
for X in "$SUB" "$PHL"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$DEP" "$DEP2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (პაციენტი რჩება — „ტესტ-E2E“)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
