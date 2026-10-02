#!/usr/bin/env bash
# =====================================================================
# e2e-stock-control.sh — საწყობი, ეტაპი 5 (0034): ქარანტინი / გაწვევა + მიკვლევა, ვადის და მინიმუმის შეტყობინებები, მინ/მაქს → მოთხოვნა, რეპორტები
#   ლოტის სტატუსი (ფარმაცევტი / მენეჯერი; ექთანი — 403), დაბლოკილი — ხარჯი / გაცემა აკრძალულია, დაბრუნება და ჩამოწერა — დასაშვებია,
#   მიკვლევა (ლოკაციები, პაციენტები, ისტორია), შეტყობინებები (ლოკაციის პასუხისმგებლებს; გაწვევა — სასწრაფო),
#   ყოველდღიური შემოწმება (POST /stock/alerts/run — იგივე, რასაც worker აკეთებს), მინ/მაქს (ხელმძღვანელი; ექთანი — 403), მოთხოვნის მონახაზი,
#   რეპორტები (ღირებულება, მოძრაობის უწყისი — ბალანსი იკვრება, ხარჯი / ჩამოწერა), უფლებები
# შენიშვნა: alerts/run ამოწმებს ყველა ლოკაციას — რეალურ პასუხისმგებლებსაც შეიძლება მოუვიდეთ ზარის შეტყობინება (იგივე, რაც დილის შემოწმებისას).
# ბოლოს სატესტო მარაგი ჩამოიწერება (ნაშთი 0), მონაცემები ითიშება.
# გამოყენება:  bash scripts/e2e-stock-control.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); D40=$(date -d "$TODAY +40 days" +%F); D2Y=$(date -d "$TODAY +2 years" +%F)
bal()  { api GET "/stock/balances?location_id=$1&item_id=$2" "$ADM" | jq -r '[.rows[]|"\(.lot_no//"-"):\(.qty|tonumber+0)"]|sort|join(",")'; }
ntf()  { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" --arg t "$3" '[.[]|select(.kind==$k and (.title|contains($t)))]|"\(length):\(map(.urgent)|any)"'; }

step "0. მომზადება"
DEP=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ტრავმატოლოგია $S\",\"code\":\"E2EK$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DEP" ] || die "განყოფილება ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json]
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ctl.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"კონტროლი-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.ctl.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole csk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole csm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 81); SM=$(mkuser "[\"$R_SM\"]" 82); PH=$(mkuser '["pharmacist"]' 83)
NR=$(mkuser '["nurse"]' 84 ",\"department_id\":\"$DEP\""); HD=$(mkuser '["nurse"]' 85 ",\"department_id\":\"$DEP\",\"is_section_head\":true")
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && [ -n "$HD" ] && ok "5 მომხმარებელი (მესაწყობე, მენეჯერი, ფარმაცევტი, ექთანი, ხელმძღვანელი)" || die "მომხმარებლები ვერ შეიქმნა"
REFS=$(api GET /stock/refs "$SM"); MEDC=$(echo "$REFS" | jq -r '.categories[]|select(.code=="MED").id')
ORIG=$(echo "$REFS" | jq -c '.settings|{costing_method,alert_hour}')
api PUT /stock/settings "$SM" -d '{"costing_method":"fifo","reason":"ტესტ-E2E"}' >/dev/null
PHL=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_CP_$S\",\"name\":\"ტესტ-E2E აფთიაქი $S\",\"kind\":\"pharmacy\"}" | jq -r '.id // empty')
chk "ნაგულისხმევი წყარო — არა-მომწოდებელი ლოკაცია — 400" "$(code POST /stock/locations "$SM" -d "{\"code\":\"E2E_CX_$S\",\"name\":\"x x\",\"kind\":\"other\",\"default_source_id\":\"$(api GET /stock/locations "$SM" | jq -r '[.[]|select(.kind=="department")][0].id // "00000000-0000-0000-0000-000000000000"')\"}")" "400"
SUB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_CS_$S\",\"name\":\"ტესტ-E2E ტრავმატოლოგიის ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\",\"default_source_id\":\"$PHL\",\"requires_approval\":false}" | jq -r '.id // empty')
GEN=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ცეფაზოლინი $S\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\"}" | jq -r '.id // empty')
MED=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E Cefazolin $S\",\"category_id\":\"$MEDC\",\"generic_id\":\"$GEN\",\"base_unit\":\"vial\"}" | jq -r '.id // empty')
[ -n "$PHL" ] && [ -n "$SUB" ] && [ -n "$MED" ] && ok "აფთიაქი, ქვესაწყობი (წყარო — აფთიაქი), საქონელი" || die "მონაცემები ვერ შეიქმნა"
RC=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$PHL\",\"lines\":[
 {\"item_id\":\"$MED\",\"qty\":20,\"lot_no\":\"A$S\",\"expires_on\":\"$D40\",\"price\":2,\"vat_rate\":0,\"short_expiry_reason\":\"ტესტ-E2E\"},
 {\"item_id\":\"$MED\",\"qty\":40,\"lot_no\":\"B$S\",\"expires_on\":\"$D2Y\",\"price\":3,\"vat_rate\":0}]}" | jq -r .id)
chk "მიღება აფთიაქში: A 20 (40 დღე), B 40" "$(api POST "/stock/receipts/$RC/post" "$SK" | jq -r .status):$(bal "$PHL" "$MED")" "posted:A$S:20,B$S:40"
LA=$(api GET "/stock/items/$MED/lots" "$SK" | jq -r ".[]|select(.lot_no==\"A$S\").id"); LB=$(api GET "/stock/items/$MED/lots" "$SK" | jq -r ".[]|select(.lot_no==\"B$S\").id")
T1=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":10}]}" | jq -r .id)
api POST "/stock/docs/$T1/receive" "$NR" -d '{"action":"receive"}' >/dev/null
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"7$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მიკვლევა\",\"birth_date\":\"1980-04-04\",\"gender\":\"female\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
chk "ქვესაწყობში A 10 → პაციენტზე 1" "$(api POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":1}]}" | jq -r '.lines[0].lot_no'):$(bal "$SUB" "$MED")" "A$S:A$S:9"

step "1. ქარანტინი / გაწვევა და მიკვლევა"
chk "ლოტის ძებნა ნომრით" "$(api GET "/stock/lots?search=A$S" "$NR" | jq -r "[.[]|select(.id==\"$LA\")|.patients]|join(\"\")")" "1"
chk "ექთანი სტატუსს ვერ ცვლის — 403; მიზეზის გარეშე — 400" "$(code POST "/stock/lots/$LA/status" "$NR" -d '{"status":"quarantine","reason":"ეჭვი"}'):$(code POST "/stock/lots/$LA/status" "$PH" -d '{"status":"quarantine"}')" "403:400"
Q=$(api POST "/stock/lots/$LA/status" "$PH" -d '{"status":"quarantine","reason":"ტესტ-E2E: ფლაკონზე ნალექი","reference":"QA-1"}')
chk "ფარმაცევტი: ქარანტინი; მიკვლევა — 2 ლოკაცია, 1 პაციენტი" "$(echo "$Q" | jq -r '"\(.lot.status):\(.locations|length):\(.patients|length):\(.patients[0].qty|tonumber+0)"')" "quarantine:2:1:1"
chk "შეტყობინება: ქვესაწყობის ხელმძღვანელს (არა სასწრაფო), აფთიაქის მესაწყობეს" "$(ntf "$HD" stock_recall "A$S"):$(ntf "$SK" stock_recall "A$S" | cut -d: -f1)" "1:false:1"
chk "იგივე სტატუსი — 409" "$(code POST "/stock/lots/$LA/status" "$PH" -d '{"status":"quarantine","reason":"კიდევ"}')" "409"
chk "დაბლოკილი: ხარჯი სკანირებით — 400; FEFO-თ — 409 (სხვა ლოტი არ არის)" \
  "$(code POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":1,\"lot_id\":\"$LA\"}]}"):$(code POST /stock/consumptions "$NR" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[{\"item_id\":\"$MED\",\"qty_base\":1}]}")" "400:409"
chk "დაბლოკილი: გადაცემა აფთიაქიდან — 400" "$(code POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":1}]}")" "400"
chk "დაბრუნებისთვის ლოტები (all=true) — დაბლოკილიც ჩანს; ჩვეულებრივ — არა" "$(api GET "/stock/locations/$SUB/lots?item_id=$MED&all=true" "$NR" | jq length):$(api GET "/stock/locations/$SUB/lots?item_id=$MED" "$NR" | jq length)" "1:0"
RT=$(api POST /stock/transfers "$NR" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$SUB\",\"to_location_id\":\"$PHL\",\"notes\":\"ტესტ-E2E: ქარანტინი — ვაბრუნებთ\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":9}]}" | jq -r '.id // empty')
chk "დაბლოკილის დაბრუნება აფთიაქში — დასაშვებია; მიღება" "$(api POST "/stock/docs/$RT/receive" "$SK" -d '{"action":"receive"}' | jq -r .receive_status):$(bal "$PHL" "$MED")" "received:A$S:19,B$S:40"
R=$(api POST "/stock/lots/$LA/status" "$SM" -d '{"status":"recalled","reason":"ტესტ-E2E: მწარმოებლის გაწვევა","reference":"RC-2026-77"}')
chk "მენეჯერი: გაწვევა — სასწრაფო შეტყობინება აფთიაქს" "$(echo "$R" | jq -r '.lot.status'):$(ntf "$SK" stock_recall "გაწვევა" | cut -d: -f2)" "recalled:true"
chk "ისტორია: 2 ცვლილება, მიზეზი და № ჩანს" "$(echo "$R" | jq -r '"\(.events|length):\(.events[0].reference)"')" "2:RC-2026-77"
W=$(api POST /stock/writeoffs "$SK" -d "{\"location_id\":\"$PHL\",\"writeoff_reason\":\"recall\",\"notes\":\"ტესტ-E2E: გაწვეულის განადგურება\",\"lines\":[{\"lot_id\":\"$LA\",\"qty_base\":19}]}")
chk "გაწვეულის ჩამოწერა (38 ₾ — ზღვრამდე) → აფთიაქში მხოლოდ B" "$(echo "$W" | jq -r .status):$(bal "$PHL" "$MED")" "posted:B$S:40"
chk "დაბლოკილი ლოტები (სია)" "$(api GET "/stock/lots?status=blocked" "$SK" | jq -r "[.[]|select(.id==\"$LA\")]|length")" "1"

step "2. მინ/მაქს"
chk "ექთანი — 403; მაქსიმუმი < მინიმუმი — 400" "$(code PUT /stock/minmax "$NR" -d "{\"location_id\":\"$SUB\",\"item_id\":\"$MED\",\"min_qty\":10,\"max_qty\":30}"):$(code PUT /stock/minmax "$HD" -d "{\"location_id\":\"$SUB\",\"item_id\":\"$MED\",\"min_qty\":10,\"max_qty\":5}")" "403:400"
MM=$(api PUT /stock/minmax "$HD" -d "{\"location_id\":\"$SUB\",\"item_id\":\"$MED\",\"min_qty\":10,\"max_qty\":30}")
chk "ხელმძღვანელი: მინ 10 / მაქს 30; ნაშთი 0 → ქვემოთ, შეთავაზება 30" "$(echo "$MM" | jq -r '.[0]|"\(.on_hand|tonumber+0):\(.below):\(.suggested)"')" "0:true:30"
api POST /stock/alerts/run "$ADM" >/dev/null
chk "შემოწმება: ხელმძღვანელს — „მინიმუმზე ქვემოთ“" "$(ntf "$HD" stock_min "$S" | cut -d: -f1)" "1"
chk "შემოწმება: აფთიაქს — „ვადები“ (A — ბლოკირებული, ნაშთი 0 → არა; B — 2 წ. → არა)" "$(ntf "$SK" stock_expiry "ტესტ-E2E აფთიაქი $S" | cut -d: -f1)" "0"
chk "შემოწმება admin-ის გარდა — 403" "$(code POST /stock/alerts/run "$SM")" "403"
RQ=$(api POST /stock/minmax/request "$NR" -d "{\"location_id\":\"$SUB\"}")
chk "ექთანი: მოთხოვნის მონახაზი (წყარო — ნაგულისხმევი აფთიაქი), 30" "$(echo "$RQ" | jq -r '"\(.status):\(.from_location_id=="'"$PHL"'"):\(.lines[0].qty_base|tonumber+0)"')" "draft:true:30"
chk "მოთხოვნა ითვლება — აღარ არის ქვემოთ; მეორედ — 409" "$(api GET "/stock/minmax?location_id=$SUB" "$NR" | jq -r '.[0].below'):$(code POST /stock/minmax/request "$NR" -d "{\"location_id\":\"$SUB\"}")" "false:409"
SUBMIT=$(api POST "/stock/requests/$(echo "$RQ" | jq -r .id)/submit" "$NR")
chk "გაგზავნა → ავტომატური დამტკიცება (ლოკაციას არ სჭირდება)" "$(echo "$SUBMIT" | jq -r .status)" "approved"
api POST "/stock/requests/$(echo "$RQ" | jq -r .id)/cancel" "$SK" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "მინ/მაქს წაშლა" "$(api DELETE "/stock/minmax/$SUB/$MED" "$HD" | jq length)" "0"

step "3. რეპორტები"
chk "ექთანი რეპორტებს ვერ ხედავს — 403" "$(code GET /stock/reports/value "$NR")" "403"
chk "ღირებულება: აფთიაქი (B 40 × 3 = 120.00)" "$(api GET /stock/reports/value "$SM" | jq -r "[.rows[]|select(.location_name==\"ტესტ-E2E აფთიაქი $S\")|.value|tonumber+0]|add")" "120"
TO=$(api GET "/stock/reports/turnover?from=$TODAY&to=$TODAY&location_id=$PHL" "$SM" | jq -c ".rows[]|select(.item_id==\"$MED\")")
chk "უწყისი (აფთიაქი): მიღება 60, გადაადგილება −10+9, ჩამოწერა −19, საბოლოო 40" "$(echo "$TO" | jq -r '"\(.receipt_qty):\(.transfer_qty):\(.writeoff_qty):\(.close_qty)"')" "60:-1:-19:40"
chk "უწყისი იკვრება: საწყისი + მოძრაობა = საბოლოო (რაოდენობა და ღირებულება)" \
  "$(echo "$TO" | jq -r '((.open_qty+.receipt_qty+.transfer_qty+.consumption_qty+.writeoff_qty+.adjustment_qty) == .close_qty) and ((((.open_value+.receipt_value+.transfer_value+.consumption_value+.writeoff_value+.adjustment_value)-.close_value)|fabs) < 0.01)')" "true"
CR=$(api GET "/stock/reports/consumption?from=$TODAY&to=$TODAY" "$SM")
chk "ხარჯი ლოკაციით: ქვესაწყობი — 1 პაციენტი, 2.00; ჩამოწერა: გაწვევა 38.00" \
  "$(echo "$CR" | jq -r "[.consumption[]|select(.name==\"ტესტ-E2E ტრავმატოლოგიის ქვესაწყობი $S\")|\"\(.patients):\(.cost|tonumber+0)\"]|join(\"\")"):$(echo "$CR" | jq -r "[.writeoffs[]|select(.location_name==\"ტესტ-E2E აფთიაქი $S\" and .reason==\"recall\")|.value|tonumber+0]|add")" "1:2:38"
chk "არასწორი პერიოდი — 400" "$(code GET "/stock/reports/turnover?from=$TODAY&to=2020-01-01" "$SM")" "400"

step "გასუფთავება"
WC=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$PHL\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":[{\"lot_id\":\"$LB\",\"qty_base\":40}]}" | jq -r .id)
api POST "/stock/writeoffs/$WC/decide" "$ADM" -d '{"approve":true}' >/dev/null
chk "სატესტო ნაშთი — 0" "$(api GET "/stock/balances?location_id=$PHL" "$SM" | jq '.rows|length'):$(api GET "/stock/balances?location_id=$SUB" "$SM" | jq '.rows|length')" "0:0"
api PUT /stock/settings "$SM" -d "$(echo "$ORIG" | jq -c '. + {reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
api PATCH "/stock/items/$MED" "$SM" -d '{"is_active":false}' >/dev/null; api PATCH "/pharmacy/generics/$GEN" "$PH" -d '{"is_active":false}' >/dev/null
for X in "$SUB" "$PHL"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false,"default_source_id":null}' >/dev/null; done
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
api PATCH "/departments/$DEP" "$ADM" -d '{"is_active":false}' >/dev/null
ok "სატესტო მონაცემები გათიშულია (პაციენტი რჩება — „ტესტ-E2E“)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
