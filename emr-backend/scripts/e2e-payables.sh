#!/usr/bin/env bash
# =====================================================================
# e2e-payables.sh — ფინანსები და შესყიდვები, ეტაპი 2 (0052): მომწოდებლის ინვოისი, გადახდა, ხარჯების ჟურნალი
#   ინვოისი: მიღებების (RC) მიბმა (მხოლოდ ამ მომწოდებლის, გატარებული, თავისუფალი), არა-მარაგის ხაზები, გადახდის ვადა მომწოდებლიდან,
#   გატარება (AP-ნომერი) + შეჯერება (rc / three_way / ტოლერანტობა), სხვაობა → გადახდის ბლოკი → დადასტურება მიზეზით;
#   გადახდა (ნაწილობრივი, ზედმეტი — 409, გაუქმება), კრედიტ-ნოტა (ხარჯი −), ვალუტა, ხარჯების ჟურნალი (on_invoice / on_payment,
#   სისტემური ჩანაწერი ხელით არ იცვლება), გაუქმება (გადახდით — 409; მიღებები თავისუფლდება), ხანდაზმულობა, ვადის შეტყობინება,
#   გადახდების რეესტრი, ფინანსური რეპორტი (ხარჯის ცენტრები), უფლებები, მოდულის გამორთვა, აუდიტი.
# ცალკე სატესტო ლოკაციაზე; ბოლოს ყველაფერი უქმდება / ბრუნდება (ნაშთი 0), პარამეტრები ბრუნდება.
# შენიშვნა: სატესტო დოკუმენტები იკავებს AP / RC / RV / PO ნომრებს — ეს ნორმაა.
# გამოყენება:  bash scripts/e2e-payables.sh [API_URL]
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
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F); D30=$(date -d "$TODAY +30 days" +%F)
DM45=$(date -d "$TODAY -45 days" +%F); DM40=$(date -d "$TODAY -40 days" +%F); DP2=$(date -d "$TODAY +2 days" +%F)

step "0. მომზადება"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ap.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ბუღალტერია-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.ap.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_AC=$(mkrole aac "ბუღალტერი" '["accountant"]'); R_SK=$(mkrole ask "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole asm "საწყობის მენეჯერი" '["stock_manager"]')
R_VW=$(mkrole avw "ხელმძღვანელობა" '["viewer"]')
ACC=$(mkuser "[\"$R_AC\"]" 91); SK=$(mkuser "[\"$R_SK\"]" 92); SM=$(mkuser "[\"$R_SM\"]" 93); VW=$(mkuser "[\"$R_VW\"]" 94); NR=$(mkuser '["nurse"]' 95)
[ -n "$ACC" ] && [ -n "$SK" ] && [ -n "$SM" ] && [ -n "$VW" ] && [ -n "$NR" ] && ok "როლები + 5 მომხმარებელი (ბუღალტერი, მესაწყობე, მენეჯერი, ხელმძღვანელობა, ექთანი)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="procurement")|.settings')
echo "$ORIG" | jq -e '.invoice_match' >/dev/null || die "0052-ის პარამეტრები ვერ მოიძებნა (მიგრაცია 0052?)"
rules(){ api PUT /modules/procurement "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }
rules '{"po_mode":"optional","invoice_match":"rc","match_tolerance":1,"expense_recognition":"on_invoice","ap_due_alert":true,"ap_due_days":3,"price_tolerance_pct":5}' >/dev/null
chk "პარამეტრი: უცნობი მნიშვნელობა — 400" "$(code PUT /modules/procurement "$ADM" -d '{"settings":{"expense_recognition":"on_order"},"reason":"ტესტ"}')" "400"
REFS=$(api GET /stock/refs "$SM"); cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_AP_$S\",\"name\":\"ტესტ-E2E ბუღალტერია-საწყობი $S\",\"kind\":\"central\",\"requires_approval\":false}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ხელთათმანი $S\",\"category_id\":\"$(cat_id HOUSE)\",\"base_unit\":\"piece\",\"packs\":[{\"name\":\"კოლოფი\",\"qty_base\":10,\"is_receipt_default\":true}]}" | jq -r '.id // empty')
BOX=$(api GET "/stock/items/$MED" "$SM" | jq -r '.packs[0].id')
SUP=$(api POST /stock/suppliers "$SM" -d "{\"name\":\"ტესტ-E2E შპს მედიმპორტი $S\",\"tax_id\":\"5$(printf '%08d' "$((10#$S))")\",\"vat_payer\":true,\"payment_terms_days\":30}" | jq -r '.id // empty')
SUP2=$(api POST /stock/suppliers "$SM" -d "{\"name\":\"ტესტ-E2E შპს ენერგო $S\",\"tax_id\":\"4$(printf '%08d' "$((10#$S))")\",\"vat_payer\":true}" | jq -r '.id // empty')
DEP=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ადმინისტრაცია $S\",\"code\":\"E2EAP$S\",\"type\":\"administrative\"}" | jq -r '.id // empty')
[ -n "$LOC" ] && [ -n "$MED" ] && [ -n "$SUP" ] && [ -n "$SUP2" ] && [ -n "$DEP" ] && ok "ლოკაცია, საქონელი, 2 მომწოდებელი (გადახდის ვადა 30 დღე), განყოფილება" || die "მონაცემები ვერ შეიქმნა"
# მიღება: N კოლოფი × ფასი (დღგ-ს გარეშე, 18%) → გატარებული RC
rc() { local id; id=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$1\",\"prices_include_vat\":false,\"invoice_no\":\"$4\",\"lines\":[{\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":$2,\"price\":$3,\"vat_rate\":18}]}" | jq -r '.id // empty')
  [ -n "$id" ] && api POST "/stock/receipts/$id/post" "$SK" | jq -r 'if .status=="posted" then .id else empty end'; }
RC1=$(rc "$SUP" 2 100 "F-$S"); RC2=$(rc "$SUP" 1 100 "F-$S"); RC3=$(rc "$SUP2" 1 100 ""); RC4=$(rc "$SUP" 1 100 "G-$S"); RC5=$(rc "$SUP" 1 100 ""); RC6=$(rc "$SUP" 2 100 "")
for X in "$RC1" "$RC2" "$RC3" "$RC4" "$RC5" "$RC6"; do echo "$X" >> "$TMP/rcs"; done
[ "$(wc -l < "$TMP/rcs")" = 6 ] && [ -n "$RC1$RC6" ] && ok "6 გატარებული მიღება (236 / 118 / … ₾ დღგ-ით)" || die "მიღებები ვერ გატარდა"

step "1. ინვოისი: მიბმა, ვადა, გატარება, შეჯერება"
chk "ბუღალტრისთვის მიუბმელი მიღებები: მომწოდებელი 1 — 5 (მომწოდებელი 2-ის არა)" "$(api GET "/payables/uninvoiced?supplier_id=$SUP" "$ACC" | jq -r "[.[]|select(.id==\"$RC1\" or .id==\"$RC2\" or .id==\"$RC4\" or .id==\"$RC5\" or .id==\"$RC6\")]|length"):$(api GET "/payables/uninvoiced?supplier_id=$SUP" "$ACC" | jq -r "[.[]|select(.id==\"$RC3\")]|length")" "5:0"
INVB="{\"supplier_id\":\"$SUP\",\"invoice_no\":\"F-$S\",\"invoice_date\":\"$TODAY\",\"total\":354,\"total_vat\":54,\"receipts\":[\"$RC1\",\"$RC2\"]}"
chk "მესაწყობე / ექთანი — 403; სხვა მომწოდებლის RC — 400; მომავალი თარიღი — 400" \
  "$(code POST /payables/invoices "$SK" -d "$INVB"):$(code POST /payables/invoices "$NR" -d "$INVB"):$(code POST /payables/invoices "$ACC" -d "$(echo "$INVB" | jq -c ".receipts=[\"$RC3\"]")"):$(code POST /payables/invoices "$ACC" -d "$(echo "$INVB" | jq -c ".invoice_date=\"$DP2\"")")" "403:403:400:400"
R=$(api POST /payables/invoices "$ACC" -d "$INVB"); INV1=$(echo "$R" | jq -r '.id // empty')
chk "მონახაზი: 2 მიღება, ვადა = თარიღი + 30 დღე" "$(echo "$R" | jq -r '"\(.status):\(.receipts|length):\(.due_date)"')" "draft:2:$D30"
chk "იგივე RC სხვა ინვოისზე — 409" "$(code POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"X-$S\",\"invoice_date\":\"$TODAY\",\"total\":236,\"receipts\":[\"$RC1\"]}")" "409"
R=$(api POST "/payables/invoices/$INV1/post" "$ACC")
chk "გატარება: AP-ნომერი, შეჯერება ok (354 = 236 + 118), ხარჯი არ იქმნება (მარაგი)" "$(echo "$R" | jq -r '"\(.status):\(.ap_no|test("^AP[0-9]{2}-[0-9]{6}$")):\(.match_status):\(.match_diff|tonumber+0):\(.stock_gel|tonumber+0):\(.expenses|length)"')" "posted:true:ok:0:354:0"
chk "გატარებულის რედაქტირება — 409; წაშლა — 409; იგივე ფაქტურა იმავე მომწოდებლისგან — 409" \
  "$(code PUT "/payables/invoices/$INV1" "$ACC" -d "$INVB"):$(code DELETE "/payables/invoices/$INV1" "$ACC"):$(code POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"f-$S\",\"invoice_date\":\"$TODAY\",\"total\":118,\"receipts\":[\"$RC5\"]}")" "409:409:409"
chk "მიბმული RC აღარ ჩანს მიუბმელებში; RC-ზე ჩანს AP-ნომერი" "$(api GET "/payables/uninvoiced?supplier_id=$SUP" "$ACC" | jq -r "[.[]|select(.id==\"$RC1\")]|length"):$(api GET "/stock/docs/$RC1" "$SK" | jq -r '.ap_no|test("^AP")')" "0:true"

step "2. სხვაობა → გადახდის ბლოკი → დადასტურება; ტოლერანტობა"
INV2=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"G-$S\",\"invoice_date\":\"$TODAY\",\"total\":130,\"receipts\":[\"$RC4\"]}" | jq -r '.id // empty')
chk "130 ≠ 118 → mismatch (+12)" "$(api POST "/payables/invoices/$INV2/post" "$ACC" | jq -r '"\(.match_status):\(.match_diff|tonumber+0)"')" "mismatch:12"
chk "გადახდა — 409; კრედიტ-ნოტა — დასაშვებია" "$(code POST "/payables/invoices/$INV2/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":10,\"method\":\"bank_transfer\"}"):$(api POST "/payables/invoices/$INV2/payments" "$ACC" -d "{\"kind\":\"credit_note\",\"pay_date\":\"$TODAY\",\"amount\":12,\"reference\":\"CN-$S\"}" | jq -r '.balance|tonumber+0')" "409:118"
chk "დადასტურება: მიზეზის გარეშე — 400; ხელმძღვანელობა — 403; ბუღალტერი → accepted" "$(code POST "/payables/invoices/$INV2/accept-match" "$ACC" -d '{}'):$(code POST "/payables/invoices/$INV2/accept-match" "$VW" -d '{"reason":"ტესტ"}'):$(api POST "/payables/invoices/$INV2/accept-match" "$ACC" -d '{"reason":"ტესტ-E2E: მიტანის ღირებულება"}' | jq -r .match_status)" "400:403:accepted"
chk "შემდეგ გადახდა მუშაობს → გადახდილი" "$(api POST "/payables/invoices/$INV2/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":118,\"method\":\"bank_transfer\",\"reference\":\"BK-$S-2\"}" | jq -r '.balance|tonumber+0')" "0"
INV3=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"H-$S\",\"invoice_date\":\"$TODAY\",\"total\":118.5,\"receipts\":[\"$RC5\"]}" | jq -r '.id // empty')
chk "სხვაობა 0.50 ≤ ტოლერანტობა 1 ₾ → ok" "$(api POST "/payables/invoices/$INV3/post" "$ACC" | jq -r '"\(.match_status):\(.match_diff|tonumber+0)"')" "ok:0.5"

step "3. არა-მარაგის ინვოისი → ხარჯების ჟურნალი (on_invoice)"
EB="{\"supplier_id\":\"$SUP2\",\"invoice_no\":\"E-$S\",\"invoice_date\":\"$TODAY\",\"total\":600,\"total_vat\":90,\"lines\":[{\"description\":\"ელექტროენერგია — ოქტომბერი\",\"category\":\"კომუნალური\",\"department_id\":\"$DEP\",\"amount\":590,\"vat_rate\":18}]}"
INVE=$(api POST /payables/invoices "$ACC" -d "$EB" | jq -r '.id // empty')
chk "ხაზების ჯამი (590) ≠ ინვოისი (600), RC-ის გარეშე — 400" "$(code POST "/payables/invoices/$INVE/post" "$ACC")" "400"
api PUT "/payables/invoices/$INVE" "$ACC" -d "$(echo "$EB" | jq -c '.total=590')" >/dev/null
R=$(api POST "/payables/invoices/$INVE/post" "$ACC")
chk "გატარება: შეჯერება none, ხარჯი 590 ₾ (განყოფილება, კატეგორია)" "$(echo "$R" | jq -r '"\(.match_status):\(.expenses|length):\(.expenses[0].amount|tonumber+0):\(.expenses[0].category):\(.expenses[0].source)"')" "none:1:590:კომუნალური:ap_invoice"
EX=$(api GET "/expenses?from=$TODAY&to=$TODAY" "$ACC" | jq -c "[.[]|select(.ap_invoice_id==\"$INVE\")][0]")
chk "ხარჯების ჟურნალში: AP-ნომერი, მომწოდებელი; ხელით შეცვლა / გაუქმება — 409" "$(echo "$EX" | jq -r '"\(.ap_no|test("^AP")):\(.supplier|test("ენერგო"))"'):$(code PATCH "/expenses/$(echo "$EX" | jq -r .id)" "$ACC" -d '{"amount":1}'):$(code PATCH "/expenses/$(echo "$EX" | jq -r .id)" "$ACC" -d '{"void":true,"void_reason":"ტესტ-E2E"}')" "true:true:409:409"
chk "კრედიტ-ნოტა 59 → ნაშთი 531, ხარჯი −59" "$(api POST "/payables/invoices/$INVE/payments" "$ACC" -d "{\"kind\":\"credit_note\",\"pay_date\":\"$TODAY\",\"amount\":59,\"reference\":\"CN-E-$S\"}" | jq -r '"\(.balance|tonumber+0):\([.expenses[]|select(.is_void|not)|.amount|tonumber]|add)"')" "531:531"
INVM=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"M-$S\",\"invoice_date\":\"$TODAY\",\"total\":256,\"receipts\":[\"$RC6\"],\"lines\":[{\"description\":\"მიტანა\",\"category\":\"ტრანსპორტი\",\"amount\":20}]}" | jq -r '.id // empty')
chk "შერეული (RC 236 + მიტანა 20): შეჯერება ok, ხარჯი მხოლოდ 20" "$(api POST "/payables/invoices/$INVM/post" "$ACC" | jq -r '"\(.match_status):\(.expenses|length):\(.expenses[0].amount|tonumber+0)"')" "ok:1:20"

step "4. გადახდა: ნაწილობრივი, ზედმეტი, გაუქმება"
chk "მეთოდის გარეშე — 400; მომავალი თარიღი — 400" "$(code POST "/payables/invoices/$INV1/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":10}"):$(code POST "/payables/invoices/$INV1/payments" "$ACC" -d "{\"pay_date\":\"$DP2\",\"amount\":10,\"method\":\"cash\"}")" "400:400"
R=$(api POST "/payables/invoices/$INV1/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":200,\"method\":\"bank_transfer\",\"reference\":\"BK-$S-1\"}")
chk "200 / 354 → ნაშთი 154; სიაში „ღია“" "$(echo "$R" | jq -r '.balance|tonumber+0'):$(api GET "/payables/invoices?state=open&supplier_id=$SUP" "$ACC" | jq -r "[.[]|select(.id==\"$INV1\")]|length")" "154:1"
chk "ნაშთზე მეტი (200 > 154) — 409" "$(code POST "/payables/invoices/$INV1/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":200,\"method\":\"bank_transfer\"}")" "409"
P2=$(api POST "/payables/invoices/$INV1/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":154,\"method\":\"bank_transfer\",\"reference\":\"BK-$S-3\"}" | jq -r '.payments[-1].id')
chk "სრულად გადახდილი — „გადახდილი“ სიაში" "$(api GET "/payables/invoices?state=paid&supplier_id=$SUP" "$ACC" | jq -r "[.[]|select(.id==\"$INV1\")]|length")" "1"
chk "გადახდის გაუქმება: მიზეზის გარეშე — 400; მიზეზით → ნაშთი 154; მეორედ — 409" "$(code POST "/payables/payments/$P2/void" "$ACC" -d '{}'):$(api POST "/payables/payments/$P2/void" "$ACC" -d '{"reason":"ტესტ-E2E: არასწორი თანხა"}' | jq -r '.balance|tonumber+0'):$(code POST "/payables/payments/$P2/void" "$ACC" -d '{"reason":"კიდევ"}')" "400:154:409"
chk "ინვოისის გაუქმება გადახდით — 409" "$(code POST "/payables/invoices/$INV1/void" "$ACC" -d '{"reason":"ტესტ-E2E"}')" "409"

step "5. ხარჯი გადახდისას (on_payment), ვალუტა"
rules '{"expense_recognition":"on_payment"}' >/dev/null
INVP=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP2\",\"invoice_no\":\"P-$S\",\"invoice_date\":\"$TODAY\",\"total\":100,\"lines\":[{\"description\":\"დასუფთავება\",\"category\":\"მომსახურება\",\"department_id\":\"$DEP\",\"amount\":100}]}" | jq -r '.id // empty')
chk "გატარებისას ხარჯი არ იქმნება" "$(api POST "/payables/invoices/$INVP/post" "$ACC" | jq -r '.expenses|length')" "0"
R=$(api POST "/payables/invoices/$INVP/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":40,\"method\":\"cash\"}")
PP=$(echo "$R" | jq -r '.payments[0].id')
chk "გადახდა 40 → ხარჯი 40 (ap_payment)" "$(echo "$R" | jq -r '"\(.expenses|length):\(.expenses[0].amount|tonumber+0):\(.expenses[0].source)"')" "1:40:ap_payment"
chk "გადახდის გაუქმება → ხარჯიც უქმდება" "$(api POST "/payables/payments/$PP/void" "$ACC" -d '{"reason":"ტესტ-E2E"}' | jq -r '[.expenses[]|select(.is_void|not)]|length')" "0"
rules '{"expense_recognition":"on_invoice"}' >/dev/null
chk "USD კურსის გარეშე — 400" "$(code POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP2\",\"invoice_no\":\"U-$S\",\"invoice_date\":\"$TODAY\",\"currency\":\"USD\",\"total\":100,\"lines\":[{\"description\":\"ლიცენზია\",\"category\":\"პროგრამული უზრუნველყოფა\",\"amount\":100}]}")" "400"
INVU=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP2\",\"invoice_no\":\"U-$S\",\"invoice_date\":\"$TODAY\",\"currency\":\"USD\",\"fx_rate\":2.7,\"total\":100,\"lines\":[{\"description\":\"ლიცენზია\",\"category\":\"პროგრამული უზრუნველყოფა\",\"amount\":100}]}" | jq -r '.id // empty')
chk "100 $ × 2.7 = 270 ₾; ხარჯი 270 ₾" "$(api POST "/payables/invoices/$INVU/post" "$ACC" | jq -r '"\(.total_gel|tonumber+0):\(.expenses[0].amount|tonumber+0)"')" "270:270"
chk "გადახდა სხვა კურსით (2.75) → 275 ₾" "$(api POST "/payables/invoices/$INVU/payments" "$ACC" -d "{\"pay_date\":\"$TODAY\",\"amount\":100,\"fx_rate\":2.75,\"method\":\"bank_transfer\"}" | jq -r '"\(.balance|tonumber+0):\(.payments[0].amount_gel|tonumber+0)"')" "0:275"

step "6. three_way: შეკვეთის ფასით"
rules '{"invoice_match":"three_way"}' >/dev/null
PO=$(api POST /procurement/orders "$SM" -d "{\"supplier_id\":\"$SUP\",\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":1,\"price\":100,\"vat_rate\":18}]}" | jq -r '.id // empty')
api POST "/procurement/orders/$PO/send" "$SM" >/dev/null
RC7=$(api POST "/procurement/orders/$PO/receipt" "$SK" | jq -r '.id // empty'); PL=$(api GET "/procurement/orders/$PO" "$SM" | jq -r '.lines[0].id')
api PUT "/stock/receipts/$RC7" "$SK" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"po_id\":\"$PO\",\"prices_include_vat\":false,\"lines\":[{\"item_id\":\"$MED\",\"pack_id\":\"$BOX\",\"qty\":1,\"price\":110,\"vat_rate\":18,\"po_line_id\":\"$PL\",\"price_reason\":\"ტესტ-E2E\"}]}" >/dev/null
api POST "/stock/receipts/$RC7/post" "$SK" >/dev/null; echo "$RC7" >> "$TMP/rcs"
INVT=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"T-$S\",\"invoice_date\":\"$TODAY\",\"total\":129.8,\"receipts\":[\"$RC7\"]}" | jq -r '.id // empty')
R=$(api POST "/payables/invoices/$INVT/post" "$ACC")
chk "ინვოისი = RC (129.80), მაგრამ PO-ს ფასით 118 → mismatch" "$(echo "$R" | jq -r '"\(.match_status):\(.match_diff|tonumber+0):\(.match_note|test("შეკვეთის ფასით"))"')" "mismatch:0:true"
rules '{"invoice_match":"rc"}' >/dev/null

step "7. გაუქმება, ხანდაზმულობა, ვადის შეტყობინება"
chk "INV3-ის გაუქმება → void, RC5 ისევ მიუბმელია" "$(api POST "/payables/invoices/$INV3/void" "$ACC" -d '{"reason":"ტესტ-E2E: შეცდომით"}' | jq -r .status):$(api GET "/payables/uninvoiced?supplier_id=$SUP" "$ACC" | jq -r "[.[]|select(.id==\"$RC5\")]|length")" "void:1"
CN=$(api GET "/payables/invoices/$INVE" "$ACC" | jq -r '.payments[0].id'); api POST "/payables/payments/$CN/void" "$ACC" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "არა-მარაგის ინვოისის გაუქმება → ხარჯის ჩანაწერები უქმდება" "$(api POST "/payables/invoices/$INVE/void" "$ACC" -d '{"reason":"ტესტ-E2E"}' | jq -r '[.expenses[]|select(.is_void|not)]|length')" "0"
INVO=$(api POST /payables/invoices "$ACC" -d "{\"supplier_id\":\"$SUP2\",\"invoice_no\":\"O-$S\",\"invoice_date\":\"$DM45\",\"due_date\":\"$DM40\",\"total\":50,\"lines\":[{\"description\":\"წყალი\",\"category\":\"კომუნალური\",\"amount\":50}]}" | jq -r '.id // empty')
api POST "/payables/invoices/$INVO/post" "$ACC" >/dev/null
chk "ხანდაზმულობა: მომწოდებელი 2 — 31–60 დღე: 50 ₾, ვადამდე 100 (USD ინვოისი გადახდილია)" "$(api GET /payables/aging "$VW" | jq -r ".rows[]|select(.supplier_id==\"$SUP2\")|\"\(.d31_60):\(.total):\(.invoices)\"")" "50:150:2"
chk "სიაში ვადაგადაცილებული (40 დღე)" "$(api GET "/payables/invoices?state=overdue&supplier_id=$SUP2" "$ACC" | jq -r ".[]|select(.id==\"$INVO\")|.days_overdue")" "40"
chk "დილის შემოწმება: ბუღალტერს — შეტყობინება (სასწრაფო); მეორედ — აღარ" "$(api POST /stock/alerts/run "$ADM" | jq -r '.ap_due.invoices>=1'):$(api GET /notifications "$ACC" | jq -r "[.[]|select(.kind==\"ap_due\" and .urgent and (.title|contains(\"O-$S\")))]|length"):$(api POST /stock/alerts/run "$ADM" | jq -r '.ap_due.invoices')" "true:1:0"

step "8. რეესტრი, მიმოხილვა, ფინანსური რეპორტი, უფლებები"
chk "გადახდების რეესტრი (დღეს, მომწოდებელი 1): 200 + 118 + კრედიტ-ნოტა 12 (გაუქმებულის გარეშე)" "$(api GET "/payables/payments?from=$TODAY&to=$TODAY" "$VW" | jq -r "[.[]|select(.reference!=null and (.reference|test(\"$S\")) and (.supplier_name|test(\"მედიმპორტი\")))|.amount|tonumber]|add")" "330"
chk "მიმოხილვა: სხვაობა ≥ 1, ვადაგადაცილებული ≥ 1" "$(api GET /payables/summary "$ACC" | jq -r '"\(.mismatch>=1):\(.overdue>=1)"')" "true:true"
F=$(api GET "/reports/finance?from=$TODAY&to=$TODAY" "$ACC")
chk "ფინანსური რეპორტი: ხარჯი განყოფილებით (ტესტ-E2E ადმინისტრაცია — 0, გაუქმდა); მომწოდებლებისთვის გადახდილი ≥ 593" "$(echo "$F" | jq -r "[.expenses_by_department[]|select(.department|test(\"ტესტ-E2E ადმინისტრაცია $S\"))]|length"):$(echo "$F" | jq -r '.totals.supplier_payments|tonumber>=593')" "0:true"
chk "ხელმძღვანელობა: ნახვა — 200, შექმნა — 403; ექთანი ნახვა — 403" "$(code GET /payables/invoices "$VW"):$(code POST /payables/invoices "$VW" -d "$INVB"):$(code GET /payables/invoices "$NR")" "200:403:403"
api PUT /modules/procurement "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთული მოდული — 403" "$(code GET /payables/invoices "$ACC")" "403"
api PUT /modules/procurement "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "აუდიტი: შექმნა, გატარება, დადასტურება, გადახდა" "$(api GET "/audit-logs?entity_name=ap_invoices&entity_id=$INV2&limit=20" "$ADM" | jq -r '[.[].action]|(index("CREATE_AP_INVOICE")!=null) and (index("POST_AP_INVOICE")!=null) and (index("ACCEPT_AP_MATCH")!=null) and (index("CREATE_AP_PAYMENT")!=null)')" "true"

step "გასუფთავება"
for I in "$INV1" "$INV2" "$INVM" "$INVP" "$INVU" "$INVT" "$INVO"; do
  for P in $(api GET "/payables/invoices/$I" "$ACC" | jq -r '.payments[]|select(.is_void|not)|.id'); do api POST "/payables/payments/$P/void" "$ACC" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
  api POST "/payables/invoices/$I/void" "$ACC" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
done
chk "ყველა სატესტო ინვოისი გაუქმებულია, ხარჯის ჩანაწერებიც" "$(api GET "/payables/invoices?supplier_id=$SUP&status=draft,posted" "$ACC" | jq length):$(api GET "/payables/invoices?supplier_id=$SUP2&status=draft,posted" "$ACC" | jq length):$(api GET "/expenses?from=$DM45&to=$TODAY" "$ACC" | jq -r "[.[]|select(.supplier!=null and (.supplier|test(\"$S\")))]|length")" "0:0:0"
for X in $(cat "$TMP/rcs"); do api POST "/stock/docs/$X/reverse" "$SM" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
api POST "/procurement/orders/$PO/close" "$SM" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "მიღებები შემობრუნებულია — ნაშთი 0" "$(api GET "/stock/balances?location_id=$LOC" "$SM" | jq -r '.rows|length')" "0"
api PUT /modules/procurement "$ADM" -d "$(jq -nc --argjson s "$ORIG" '{settings:$s,reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="procurement")|.settings' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"
api PATCH "/stock/items/$MED" "$SM" -d '{"is_active":false}' >/dev/null
api PATCH "/stock/locations/$LOC" "$SM" -d '{"is_active":false}' >/dev/null
for X in "$SUP" "$SUP2"; do api PATCH "/stock/suppliers/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/departments/$DEP" "$ADM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (ჟურნალები უცვლელი რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
