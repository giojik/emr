#!/usr/bin/env bash
# =====================================================================
# e2e-stock-rules.sh — საწყობის წესები როგორც კლინიკის პარამეტრები (0038, მოდული „stock“)
#   მოდული არ ითიშება, ვალიდაცია, უფლება; გაცემა ცალმხრივი / ორმხრივი (პირდაპირი და მოთხოვნით); მოწმის კლასები (+ ჟურნალი);
#   დოზა სავალდებულო / არა; ცარიელი ამპულის კლასები; ინვენტარიზაციის ბლოკი და ბრმა ნაგულისხმევად; ფარმაცევტის ლოკაციები;
#   „დაკარგული“ — დამტკიცებით / ზღვრით; დილის შემოწმების შემადგენლობა
# პარამეტრები ბოლოს ბრუნდება საწყისზე; სატესტო მარაგი ჩამოიწერება, მონაცემები ითიშება.
# გამოყენება:  bash scripts/e2e-stock-rules.sh [API_URL]
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
rules(){ api PUT /modules/stock "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }
wit()  { echo "{\"username\":\"e2e.rul.$1.$S@test.local\",\"password\":\"E2e-$S-pass-$1\"}"; }

step "0. მომზადება"
DEP=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E თერაპია $S\",\"code\":\"E2ER$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DEP" ] || die "განყოფილება ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rul.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"წესი-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rul.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole rsk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole rsm "საწყობის მენეჯერი" '["stock_manager"]')
SK=$(mkuser "[\"$R_SK\"]" 21); SM=$(mkuser "[\"$R_SM\"]" 22); PH=$(mkuser '["pharmacist"]' 23)
NR=$(mkuser '["nurse"]' 24 ",\"department_id\":\"$DEP\""); NR2=$(mkuser '["nurse"]' 25 ",\"department_id\":\"$DEP\""); HD=$(mkuser '["nurse"]' 26 ",\"department_id\":\"$DEP\",\"is_section_head\":true")
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && [ -n "$NR2" ] && [ -n "$HD" ] && ok "6 მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="stock")|.settings')
[ -n "$ORIG" ] && [ "$ORIG" != "null" ] || die "მოდული stock ვერ მოიძებნა"
MEDC=$(api GET /stock/refs "$SM" | jq -r '.categories[]|select(.code=="MED").id')
PHL=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RP_$S\",\"name\":\"ტესტ-E2E აფთიაქი $S\",\"kind\":\"pharmacy\"}" | jq -r '.id // empty')
CEN=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RC_$S\",\"name\":\"ტესტ-E2E ცენტრალური $S\",\"kind\":\"central\"}" | jq -r '.id // empty')
SUB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RS_$S\",\"name\":\"ტესტ-E2E თერაპიის ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\",\"requires_approval\":false}" | jq -r '.id // empty')
gen() { api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E $1 $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ\"${2:+,\"controlled_class\":\"$2\"},\"dose_unit\":\"mg\",\"dose_per_unit\":10}" | jq -r '.id // empty'; }
item() { api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"category_id\":\"$MEDC\",\"generic_id\":\"$2\",\"base_unit\":\"ampoule\"}" | jq -r '.id // empty'; }
MED=$(item "Ordinary" "$(gen ჩვეულებრივი)"); PSY=$(item "Psycho" "$(gen ფსიქოტროპული psychotropic)"); PRE=$(item "Precursor" "$(gen პრეკურსორი precursor)"); NAR=$(item "Narco" "$(gen ნარკოტიკული narcotic)")
[ -n "$PHL" ] && [ -n "$CEN" ] && [ -n "$SUB" ] && [ -n "$MED" ] && [ -n "$PSY" ] && [ -n "$PRE" ] && [ -n "$NAR" ] && ok "ლოკაციები (აფთიაქი, ცენტრალური, ქვესაწყობი) + 4 საქონელი (ჩვეულებრივი, ფსიქოტროპული, პრეკურსორი, ნარკოტიკული)" || die "მონაცემები ვერ შეიქმნა"
rcv() { local id; id=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$1\",\"lines\":[$2]}" | jq -r .id); api POST "/stock/receipts/$id/post" "$SK" | jq -r .status; }
L() { echo "{\"item_id\":\"$1\",\"qty\":$2,\"lot_no\":\"$3$S\",\"expires_on\":\"$D2Y\",\"price\":2,\"vat_rate\":0}"; }
chk "მიღება: აფთიაქი (ჩვეულ. 20), ქვესაწყობი (ფსიქ. 5, პრეკ. 5, ნარკ. 5)" "$(rcv "$PHL" "$(L "$MED" 20 M)"):$(rcv "$SUB" "$(L "$PSY" 5 P),$(L "$PRE" 5 R),$(L "$NAR" 5 N)")" "posted:posted"
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"9$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"წესები\",\"birth_date\":\"1965-06-06\",\"gender\":\"female\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty')
CN() { api POST /stock/consumptions "$1" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[$2]${3:+,\"witness\":$3}}"; }
cc() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/stock/consumptions" -H "authorization: Bearer $1" -H "$J" -d "{\"location_id\":\"$SUB\",\"patient_id\":\"$PAT\",\"lines\":[$2]${3:+,\"witness\":$3}}"; }

step "1. მოდული „საწყობი და აფთიაქი“"
chk "ნაგულისხმევი = მიმდინარე ქცევა (ორმხრივი, ნარკ. + ფსიქ., ბლოკი, აფთიაქი)" "$(echo "$ORIG" | jq -r '"\(.issue_mode):\(.witness_classes|sort|join("+")):\(.count_lock):\(.pharmacist_scope)"')" "two_step:narcotic+psychotropic:true:pharmacy"
chk "გამორთვა — 400 (ძირითადი); უცნობი კლასი — 400; მენეჯერი — 403" "$(code PUT /modules/stock "$ADM" -d '{"enabled":false,"reason":"ტესტ"}'):$(code PUT /modules/stock "$ADM" -d '{"settings":{"witness_classes":["opioid"]},"reason":"ტესტ"}'):$(code PUT /modules/stock "$SM" -d '{"settings":{"count_lock":false},"reason":"ტესტ"}')" "400:400:403"

step "2. გაცემა: ცალმხრივი / ორმხრივი"
rules '{"issue_mode":"one_step"}' >/dev/null
LM=$(api GET "/stock/items/$MED/lots" "$SK" | jq -r '.[0].id')
T1=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":3}]}" | jq -r .id)
chk "ცალმხრივი: პირდაპირი გადაცემა → მაშინვე ჩაირიცხა" "$(api GET "/stock/docs/$T1" "$SK" | jq -r .receive_status):$(bal "$SUB" "$MED")" "received:M$S:3"
RQ=$(api POST /stock/requests "$NR" -d "{\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"item_id\":\"$MED\",\"qty\":2}]}" | jq -r .id)
api POST "/stock/requests/$RQ/submit" "$NR" >/dev/null
PK=$(api GET "/stock/requests/$RQ/pick" "$SK" | jq -c '{lines:[.lines[]|.request_line_id as $r|.alloc[]|{request_line_id:$r,lot_id,qty_base:.qty}]}')
chk "ცალმხრივი: მოთხოვნის გაცემა → issued, ნაშთი ქვესაწყობში, „გზაში“ არაფერი" "$(api POST "/stock/requests/$RQ/issue" "$SK" -d "$PK" | jq -r '"\(.status):\(.docs[0].receive_status)"'):$(bal "$SUB" "$MED"):$(api GET "/stock/transit?scope=incoming" "$NR" | jq length)" "issued:received:M$S:5:0"
rules '{"issue_mode":"two_step"}' >/dev/null
T2=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":1}]}" | jq -r .id)
chk "ორმხრივი: გზაშია, მიმღები ადასტურებს" "$(api GET "/stock/docs/$T2" "$SK" | jq -r '.receive_status // "pending"'):$(api POST "/stock/docs/$T2/receive" "$NR" -d '{"action":"receive"}' | jq -r .receive_status)" "pending:received"

step "3. მოწმის კლასები, დოზა"
chk "ნაგულისხმევი: ფსიქოტროპული მოწმის გარეშე — 400; პრეკურსორი — მოწმის გარეშე 201" "$(cc "$NR" "{\"item_id\":\"$PSY\",\"qty_base\":1,\"dose_given\":10}"):$(cc "$NR" "{\"item_id\":\"$PRE\",\"qty_base\":1}")" "400:201"
rules '{"witness_classes":["precursor"]}' >/dev/null
chk "კლასები = [პრეკურსორი]: ფსიქოტროპული — თავისუფლად; პრეკურსორი — მოწმის გარეშე 400, მოწმით 201" \
  "$(cc "$NR" "{\"item_id\":\"$PSY\",\"qty_base\":1}"):$(cc "$NR" "{\"item_id\":\"$PRE\",\"qty_base\":1,\"dose_given\":10}"):$(cc "$NR" "{\"item_id\":\"$PRE\",\"qty_base\":1,\"dose_given\":10}" "$(wit 25)")" "201:400:201"
chk "დოზა სავალდებულო: პრეკურსორი დოზის გარეშე — 400" "$(cc "$NR" "{\"item_id\":\"$PRE\",\"qty_base\":1}" "$(wit 25)")" "400"
rules '{"dose_required":false}' >/dev/null
chk "დოზა არასავალდებულო: მოწმით, დოზის გარეშე — 201" "$(cc "$NR" "{\"item_id\":\"$PRE\",\"qty_base\":1}" "$(wit 25)")" "201"
chk "ჟურნალი — მხოლოდ არჩეული კლასები (პრეკურსორი)" "$(api GET "/stock/controlled/register?location_id=$SUB&from=$TODAY&to=$TODAY" "$NR" | jq -r '[.items[].item.controlled_class]|unique|join(",")')" "precursor"

step "4. ცარიელი ამპულის კლასები"
rules '{"empty_return_classes":["psychotropic"],"witness_classes":[]}' >/dev/null
chk "მოწმე გამორთულია (კლასები ცარიელი) — ნარკოტიკული მოწმის გარეშე 201" "$(cc "$NR" "{\"item_id\":\"$NAR\",\"qty_base\":1}")" "201"
CN "$NR" "{\"item_id\":\"$PSY\",\"qty_base\":1}" >/dev/null
chk "დასაბრუნებელი: მხოლოდ ფსიქოტროპული (ნარკოტიკული — არა)" "$(api GET "/stock/controlled/empties?location_id=$SUB" "$PH" | jq -r '[.[].item_name|test("Psycho")]|unique|join(",")')" "true"
rules '{"empty_return_classes":[]}' >/dev/null
chk "ცარიელი ამპულა გამორთულია — სია ცარიელი" "$(api GET "/stock/controlled/empties?location_id=$SUB" "$PH" | jq length)" "0"

step "5. ინვენტარიზაცია: ბლოკი, ბრმა"
rules '{"count_lock":false,"count_blind_default":false}' >/dev/null
CT=$(api POST /stock/counts "$NR" -d "{\"location_id\":\"$SUB\"}")
chk "ბრმა ნაგულისხმევად — არა (რაოდენობა ჩანს)" "$(echo "$CT" | jq -r '"\(.blind):\(.lines[0].expected_qty!=null)"')" "false:true"
chk "ბლოკი გამორთულია — ხარჯი ინვენტარიზაციისას 201; გადაცემა + მიღება 200" \
  "$(cc "$NR" "{\"item_id\":\"$MED\",\"qty_base\":1}"):$(T=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LM\",\"qty_base\":1}]}" | jq -r .id); code POST "/stock/docs/$T/receive" "$NR" -d '{"action":"receive"}')" "201:200"
api POST "/stock/counts/$(echo "$CT" | jq -r .id)/cancel" "$SM" -d '{"reason":"ტესტ-E2E"}' >/dev/null
rules '{"count_lock":true,"count_blind_default":true}' >/dev/null
CT2=$(api POST /stock/counts "$NR" -d "{\"location_id\":\"$SUB\"}")
chk "ბლოკი ჩართულია — ხარჯი 409 (ბაზის ტრიგერიც); ბრმა ნაგულისხმევად" "$(cc "$NR" "{\"item_id\":\"$MED\",\"qty_base\":1}"):$(echo "$CT2" | jq -r .blind)" "409:true"
api POST "/stock/counts/$(echo "$CT2" | jq -r .id)/cancel" "$SM" -d '{"reason":"ტესტ-E2E"}' >/dev/null

step "6. ფარმაცევტი, „დაკარგული“"
chk "ფარმაცევტი ცენტრალურ საწყობში (აფთიაქის რეჟიმი) — 403" "$(code POST /stock/receipts "$PH" -d "{\"location_id\":\"$CEN\",\"lines\":[$(L "$MED" 1 C)]}")" "403"
rules '{"pharmacist_scope":"any"}' >/dev/null
chk "„ნებისმიერი ლოკაცია“ — მიღება ცენტრალურში 201; ცენტრალურის ლოკაციებში ჩანს" "$(code POST /stock/receipts "$PH" -d "{\"location_id\":\"$CEN\",\"lines\":[$(L "$MED" 1 C)]}"):$(api GET /stock/my-locations "$PH" | jq -r "[.[]|select(.id==\"$CEN\")]|length")" "201:1"
rules '{"pharmacist_scope":"pharmacy"}' >/dev/null
LMS=$(api GET "/stock/balances?location_id=$SUB&item_id=$MED" "$SK" | jq -r '.rows[0].lot_id')
chk "„დაკარგული“ (2 ₾) — ნაგულისხმევად დამტკიცებით" "$(api POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"lost\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"lot_id\":\"$LMS\",\"qty_base\":1}]}" | jq -r .approval_status)" "pending"
rules '{"lost_requires_approval":false}' >/dev/null
chk "გამორთვისას — ზღვრამდე მაშინვე გატარდა" "$(api POST /stock/writeoffs "$NR" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"lost\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"lot_id\":\"$LMS\",\"qty_base\":1}]}" | jq -r .status)" "posted"

step "7. დილის შემოწმების შემადგენლობა"
api PUT /stock/minmax "$HD" -d "{\"location_id\":\"$SUB\",\"item_id\":\"$MED\",\"min_qty\":100,\"max_qty\":200}" >/dev/null
rules '{"alert_minmax":false}' >/dev/null
chk "მინიმუმი გამორთულია — შემოწმებაში არ არის" "$(api POST /stock/alerts/run "$ADM" | jq -r 'has("minmax")')" "false"
rules '{"alert_minmax":true}' >/dev/null
chk "ჩართვისას — შეტყობინება ხელმძღვანელს" "$(api POST /stock/alerts/run "$ADM" | jq -r 'has("minmax")'):$(api GET "/notifications?unread=true" "$HD" | jq -r '[.[]|select(.kind=="stock_min")]|length')" "true:1"
api DELETE "/stock/minmax/$SUB/$MED" "$HD" >/dev/null

step "გასუფთავება"
api PUT /modules/stock "$ADM" -d "$(jq -nc --argjson s "$ORIG" '{settings:$s,reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "წესები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="stock")|.settings' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"
EL=$(api GET "/stock/controlled/empties?location_id=$SUB" "$PH" | jq -c '[.[].id]'); [ "$EL" != "[]" ] && api POST /stock/controlled/empties/confirm "$PH" -d "{\"line_ids\":$EL}" >/dev/null
for P in $(api GET "/stock/writeoffs?pending=true" "$SM" | jq -r ".[]|select(.location_name|test(\"$S\"))|.id"); do api POST "/stock/writeoffs/$P/decide" "$ADM" -d '{"approve":false,"reason":"ტესტ-E2E"}' >/dev/null; done
for X in "$SUB" "$PHL" "$CEN"; do
  LN=$(api GET "/stock/balances?location_id=$X" "$SM" | jq -c '[.rows[]|{lot_id, qty_base:(.qty|tonumber)}]')
  [ "$LN" != "[]" ] && { WC=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$X\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"witness\":$(wit 24),\"lines\":$LN}" | jq -r '.id // empty')
    [ -n "$WC" ] && api POST "/stock/writeoffs/$WC/decide" "$ADM" -d '{"approve":true}' >/dev/null; }
done
chk "სატესტო ნაშთი — 0" "$(for X in "$SUB" "$PHL" "$CEN"; do api GET "/stock/balances?location_id=$X" "$SM" | jq '.rows|length'; done | paste -sd:)" "0:0:0"
for X in "$MED" "$PSY" "$PRE" "$NAR"; do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in "$SUB" "$PHL" "$CEN"; do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
api PATCH "/departments/$DEP" "$ADM" -d '{"is_active":false}' >/dev/null
ok "სატესტო მონაცემები გათიშულია (პაციენტი რჩება — „ტესტ-E2E“)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
