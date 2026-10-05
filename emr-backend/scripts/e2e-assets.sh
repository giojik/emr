#!/usr/bin/env bash
# =====================================================================
# e2e-assets.sh — მოდულები და პარამეტრები + ინვენტარის რეესტრი (0037)
#   მოდულები (ნახვა ყველას, ცვლა — admin, ვალიდაცია, მიზეზი, გამორთვა → 403), საინვენტარო ნომრის ფორმატი, სავალდებულო ოთახი / პასუხისმგებელი,
#   ხილვადობა (პასუხისმგებელი / განყოფილების ხელმძღვანელი / რეესტრი), რედაქტირება და მდგომარეობის ისტორია,
#   გადაადგილება (დადასტურებით / პირდაპირ, უარი, გაუქმება, ხელმძღვანელის დადასტურება), ჩამოწერის აქტი (ერთი დამმტკიცებელი / კომისია კვორუმით / პირდაპირ),
#   ეტიკეტები (QR / Code128), Excel / CSV იმპორტი (შემოწმება → იმპორტი), შემაჯამებელი, ცნობარები
# მოდულის პარამეტრები ბოლოს უბრუნდება საწყისს; სატესტო ინვენტარი ჩამოიწერება, მომხმარებლები / განყოფილებები ითიშება.
# გამოყენება:  bash scripts/e2e-assets.sh [API_URL]
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
YY=$(TZ=Asia/Tbilisi date +%y)
enc()  { jq -rn --arg s "$1" '$s|@uri'; }
mod()  { api PUT /modules/asset_register "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }

step "0. მომზადება"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ადმინისტრაცია $S\",\"code\":\"E2EA$S\",\"type\":\"administrative\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ბუღალტერია $S\",\"code\":\"E2EB$S\",\"type\":\"administrative\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ast.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ინვ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.ast.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_SK=$(mkrole ask "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole asm "საწყობის მენეჯერი" '["stock_manager"]')
read -r _ SK <<< "$(mkuser "[\"$R_SK\"]" 31)"; read -r SMID SM <<< "$(mkuser "[\"$R_SM\"]" 32)"
read -r U1 T1 <<< "$(mkuser '["nurse"]' 33 ",\"department_id\":\"$D1\"")"; read -r U2 T2 <<< "$(mkuser '["nurse"]' 34 ",\"department_id\":\"$D2\"")"
read -r HD1 TH1 <<< "$(mkuser '["nurse"]' 35 ",\"department_id\":\"$D1\",\"is_section_head\":true")"
read -r C1 TC1 <<< "$(mkuser '["nurse"]' 36)"; read -r C2 TC2 <<< "$(mkuser '["nurse"]' 37)"; read -r C3 TC3 <<< "$(mkuser '["nurse"]' 38)"
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$T1" ] && [ -n "$T2" ] && [ -n "$TH1" ] && [ -n "$TC1" ] && [ -n "$TC2" ] && [ -n "$TC3" ] && ok "9 მომხმარებელი (საწყობი, 2 თანამშრომელი, ხელმძღვანელი, 3 კომისიის წევრი)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="asset_register")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული asset_register ვერ მოიძებნა"

step "1. მოდულები და პარამეტრები"
chk "მოდულების სია — ნებისმიერ თანამშრომელს; ინვენტარის რეესტრი" "$(api GET /modules "$T1" | jq -r '[.[]|select(.code=="asset_register")]|length')" "1"
chk "ცვლა: მენეჯერი — 403; მიზეზის გარეშე — 400" "$(code PUT /modules/asset_register "$SM" -d '{"enabled":true,"reason":"x x x"}'):$(code PUT /modules/asset_register "$ADM" -d '{"enabled":true}')" "403:400"
chk "უცნობი პარამეტრი — 400; არასწორი მნიშვნელობა — 400" "$(code PUT /modules/asset_register "$ADM" -d '{"settings":{"foo":1},"reason":"ტესტ"}'):$(code PUT /modules/asset_register "$ADM" -d '{"settings":{"move_mode":"maybe"},"reason":"ტესტ"}')" "400:400"
chk "კომისია: წევრები < კვორუმი — 400" "$(code PUT /modules/asset_register "$ADM" -d "{\"settings\":{\"writeoff_mode\":\"committee\",\"writeoff_committee\":[\"$C1\"],\"committee_quorum\":2},\"reason\":\"ტესტ\"}")" "400"
MOD=$(api PUT /modules/asset_register "$ADM" -d '{"enabled":true,"settings":{"inv_prefix":"E2E","inv_year":true,"inv_digits":5,"require_room":true,"require_responsible":true,"move_mode":"confirm","writeoff_mode":"single","track_value":true,"label_code":"qr","label_size":"50x25"},"reason":"ტესტ-E2E"}')
chk "პარამეტრები შეიცვალა (E2E, წელი, 5 ციფრი, დადასტურებით, ერთი დამმტკიცებელი)" "$(echo "$MOD" | jq -r '"\(.settings.inv_prefix):\(.settings.move_mode):\(.settings.writeoff_mode)"')" "E2E:confirm:single"
chk "ცვლილება აუდიტშია" "$(api GET "/audit-logs?entity_name=system_modules&entity_id=asset_register&limit=5" "$ADM" | jq -r '[.[]|select(.action=="UPDATE_MODULE")]|length>0')" "true"
REFS=$(api GET /assets/refs "$T1"); CAT=$(echo "$REFS" | jq -r '.categories[]|select(.code=="FURNITURE").id'); CIT=$(echo "$REFS" | jq -r '.categories[]|select(.code=="IT").id')
chk "ცნობარები: 5 კატეგორია, 3 მდგომარეობა" "$(echo "$REFS" | jq -r '"\([.categories[]|select(.is_active)]|length>=5):\([.conditions[]|select(.is_active)]|length>=3)"')" "true:true"

step "2. რეგისტრაცია"
NEW() { api POST /assets "$1" -d "$2"; }
chk "თანამშრომელი ვერ არეგისტრირებს — 403" "$(code POST /assets "$T1" -d "{\"name\":\"x x\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"1\",\"responsible_user_id\":\"$U1\"}")" "403"
chk "ოთახის გარეშე — 400; პასუხისმგებლის გარეშე — 400 (პარამეტრი)" "$(code POST /assets "$SK" -d "{\"name\":\"x x\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"responsible_user_id\":\"$U1\"}"):$(code POST /assets "$SK" -d "{\"name\":\"x x\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"1\"}")" "400:400"
A1J=$(NEW "$SK" "{\"name\":\"ტესტ-E2E საოფისე მაგიდა\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"101\",\"responsible_user_id\":\"$U1\",\"purchase_value\":350,\"purchase_date\":\"2024-05-01\"}")
A1=$(echo "$A1J" | jq -r '.id // empty')
chk "ავტომატური ნომერი: E2E-$YY-NNNNN; ისტორია — შექმნა" "$(echo "$A1J" | jq -r '"\(.inv_no|test("^E2E-'"$YY"'-[0-9]{5}$")):\(.events[0].kind):\(.purchase_value|tonumber+0)"')" "true:created:350"
A2=$(NEW "$SK" "{\"inv_no\":\"old-$S\",\"name\":\"ტესტ-E2E ლეპტოპი\",\"category_id\":\"$CIT\",\"manufacturer\":\"Dell\",\"serial_no\":\"SN$S\",\"department_id\":\"$D2\",\"room\":\"202\",\"responsible_user_id\":\"$U2\"}" | jq -r '.id // empty')
chk "ხელით ნომერი (არსებული ინვენტარი) — დიდი ასოებით" "$(api GET "/assets/$A2" "$SK" | jq -r .inv_no)" "OLD-$S"
chk "იგივე ნომერი — 409; იგივე სერიული (მწარმოებელი) — 409" "$(code POST /assets "$SK" -d "{\"inv_no\":\"OLD-$S\",\"name\":\"x x\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"1\",\"responsible_user_id\":\"$U1\"}"):$(code POST /assets "$SK" -d "{\"name\":\"x x\",\"category_id\":\"$CIT\",\"manufacturer\":\"Dell\",\"serial_no\":\"sn$S\",\"department_id\":\"$D1\",\"room\":\"1\",\"responsible_user_id\":\"$U1\"}")" "409:409"
A3=$(NEW "$SK" "{\"name\":\"ტესტ-E2E სავარძელი 1\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"101\",\"responsible_user_id\":\"$U1\"}" | jq -r .id)
A4=$(NEW "$SK" "{\"name\":\"ტესტ-E2E სავარძელი 2\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"101\",\"responsible_user_id\":\"$U1\"}" | jq -r .id)
A5=$(NEW "$SK" "{\"name\":\"ტესტ-E2E სავარძელი 3\",\"category_id\":\"$CAT\",\"department_id\":\"$D1\",\"room\":\"101\",\"responsible_user_id\":\"$U1\"}" | jq -r .id)
echo "$A1 $A2 $A3 $A4 $A5" | tr ' ' '\n' > "$TMP/assets"

step "3. ხილვადობა და რედაქტირება"
chk "თანამშრომელი ხედავს მხოლოდ საკუთარს (4); სხვისი — 403" "$(api GET "/assets?search=$(enc ტესტ-E2E)" "$T1" | jq length):$(code GET "/assets/$A2" "$T1")" "4:403"
chk "განყოფილების ხელმძღვანელი — განყოფილების (4); მენეჯერი — ყველა" "$(api GET "/assets?department_id=$D1" "$TH1" | jq length):$(api GET "/assets?department_id=$D2" "$SM" | jq length)" "4:1"
chk "მდგომარეობის შეცვლა → ისტორიაში" "$(api PATCH "/assets/$A1" "$SK" -d '{"condition_code":"repair","notes":"ფეხი მოტეხილია"}' | jq -r '"\(.condition_code):\([.events[].kind]|index("condition")!=null)"')" "repair:true"
chk "ადგილის შეცვლა რედაქტირებით — 400 (მხოლოდ გადაადგილებით)" "$(code PATCH "/assets/$A1" "$SK" -d "{\"department_id\":\"$D2\"}")" "400"

step "4. გადაადგილება"
MV=$(api POST "/assets/$A1/move" "$T1" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"202\",\"to_responsible_id\":\"$U2\",\"reason\":\"ტესტ-E2E: ოთახის შეცვლა\"}")
chk "პასუხისმგებელი გადასცემს → ელოდება მიმღებს; ადგილი ჯერ ძველია" "$(echo "$MV" | jq -r '"\(.status):\(.asset.department_id=="'"$D1"'")"')" "pending:true"
MID=$(echo "$MV" | jq -r .move_id)
chk "მეორე გადაადგილება — 409; შეტყობინება მიმღებს" "$(code POST "/assets/$A1/move" "$SK" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"105\",\"to_responsible_id\":\"$U1\"}"):$(api GET "/notifications?unread=true" "$T2" | jq -r '[.[]|select(.kind=="asset_move")]|length')" "409:1"
chk "მიმღებს ჩანს „მისაღებში“ და ბარათი (ჯერ არ არის მისი)" "$(api GET "/assets/moves?scope=incoming" "$T2" | jq -r "[.[]|select(.id==\"$MID\")]|length"):$(code GET "/assets/$A1" "$T2")" "1:200"
chk "გამგზავნი ვერ ადასტურებს — 403; უარი მიზეზის გარეშე — 400" "$(code POST "/assets/moves/$MID/decide" "$T1" -d '{"accept":true}'):$(code POST "/assets/moves/$MID/decide" "$T2" -d '{"accept":false}')" "403:400"
chk "მიმღები ადასტურებს → ახალი ადგილი და პასუხისმგებელი" "$(api POST "/assets/moves/$MID/decide" "$T2" -d '{"accept":true,"note":"მივიღე"}' | jq -r .status):$(api GET "/assets/$A1" "$T2" | jq -r '"\(.room):\(.responsible_user_id=="'"$U2"'"):\([.events[].kind]|index("moved")!=null)"')" "done:202:true:true"
chk "ძველი პასუხისმგებელი — აღარ ხედავს (403)" "$(code GET "/assets/$A1" "$T1")" "403"
mod '{"require_responsible":false}'
MV2=$(api POST "/assets/$A3/move" "$SK" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"110\"}" | jq -r .move_id)
chk "პასუხისმგებლის გარეშე (პარამეტრი გამორთულია) → ადასტურებს განყოფილების ხელმძღვანელი" "$(code POST "/assets/moves/$MV2/decide" "$T1" -d '{"accept":true}'):$(api POST "/assets/moves/$MV2/decide" "$TH1" -d '{"accept":true}' | jq -r .status)" "403:done"
MV3=$(api POST "/assets/$A4/move" "$SK" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"203\",\"to_responsible_id\":\"$U2\"}" | jq -r .move_id)
chk "გამგზავნის მიერ გაუქმება" "$(api POST "/assets/moves/$MV3/cancel" "$SK" | jq -r .status):$(api GET "/assets/$A4" "$SK" | jq -r .room)" "cancelled:101"
mod '{"move_mode":"direct","require_responsible":true}'
chk "რეჟიმი „პირდაპირ“ → მაშინვე" "$(api POST "/assets/$A4/move" "$SK" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"203\",\"to_responsible_id\":\"$U2\"}" | jq -r '"\(.status):\(.asset.room)"')" "done:203"
mod '{"move_mode":"confirm"}'

step "5. ჩამოწერის აქტი"
chk "მესაწყობე აქტს ვერ ქმნის — 403" "$(code POST /assets/writeoffs "$SK" -d "{\"asset_ids\":[\"$A2\"],\"reason\":\"ტესტ\"}")" "403"
W1=$(api POST /assets/writeoffs "$SM" -d "{\"asset_ids\":[\"$A2\"],\"reason\":\"ტესტ-E2E: ეკრანი დაზიანდა\",\"method\":\"disposal\"}")
W1ID=$(echo "$W1" | jq -r .id)
chk "ერთი დამმტკიცებელი: აქტი pending; ინვენტარი ჯერ აქტიურია; მეორე აქტში — 409" "$(echo "$W1" | jq -r '"\(.status):\(.mode)"'):$(api GET "/assets/$A2" "$SM" | jq -r .status):$(code POST /assets/writeoffs "$SM" -d "{\"asset_ids\":[\"$A2\"],\"reason\":\"ტესტ\"}")" "pending:single:active:409"
chk "საკუთარ აქტს ვერ ამტკიცებს — 403; admin ამტკიცებს → AW-ნომერი" "$(code POST "/assets/writeoffs/$W1ID/vote" "$SM" -d '{"approve":true}'):$(api POST "/assets/writeoffs/$W1ID/vote" "$ADM" -d '{"approve":true}' | jq -r '"\(.status):\(.act_no|test("^AW[0-9]{2}-"))"')" "403:approved:true"
chk "ჩამოწერილი: სტატუსი, რედაქტირება 409, გადაადგილება 409, სია" "$(api GET "/assets/$A2" "$SM" | jq -r .status):$(code PATCH "/assets/$A2" "$SK" -d '{"notes":"x"}'):$(code POST "/assets/$A2/move" "$SK" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"1\",\"to_responsible_id\":\"$U1\"}"):$(api GET "/assets?status=written_off&search=OLD-$S" "$SM" | jq length)" "written_off:409:409:1"
mod "{\"writeoff_mode\":\"committee\",\"writeoff_committee\":[\"$C1\",\"$C2\",\"$C3\"],\"committee_quorum\":2}"
W2=$(api POST /assets/writeoffs "$SM" -d "{\"asset_ids\":[\"$A3\"],\"reason\":\"ტესტ-E2E: გამოუსადეგარი\"}" | jq -r .id)
chk "კომისია: არაწევრი — 403; 1 ხმა → ჯერ pending; მეორედ — 409; 2-ე ხმა → approved" \
  "$(code POST "/assets/writeoffs/$W2/vote" "$SM" -d '{"approve":true}'):$(api POST "/assets/writeoffs/$W2/vote" "$TC1" -d '{"approve":true}' | jq -r .status):$(code POST "/assets/writeoffs/$W2/vote" "$TC1" -d '{"approve":true}'):$(api POST "/assets/writeoffs/$W2/vote" "$TC2" -d '{"approve":true,"note":"ვეთანხმები"}' | jq -r '"\(.status):\(.votes|length)"')" "403:pending:409:approved:2"
chk "კომისიის წევრებს — შეტყობინება" "$(api GET "/notifications?unread=true" "$TC3" | jq -r '[.[]|select(.kind=="asset_writeoff")]|length')" "1"
W3=$(api POST /assets/writeoffs "$SM" -d "{\"asset_ids\":[\"$A5\"],\"reason\":\"ტესტ-E2E: შემოწმება\"}" | jq -r .id)
chk "უარი მიზეზის გარეშე — 400; მიზეზით → rejected, ინვენტარი აქტიური რჩება" "$(code POST "/assets/writeoffs/$W3/vote" "$TC3" -d '{"approve":false}'):$(api POST "/assets/writeoffs/$W3/vote" "$TC3" -d '{"approve":false,"note":"ჯერ კიდევ ვარგისია"}' | jq -r .status):$(api GET "/assets/$A5" "$SM" | jq -r .status)" "400:rejected:active"
mod '{"writeoff_mode":"direct"}'
chk "რეჟიმი „პირდაპირ“ → მაშინვე approved" "$(api POST /assets/writeoffs "$SM" -d "{\"asset_ids\":[\"$A5\"],\"reason\":\"ტესტ-E2E\"}" | jq -r .status)" "approved"

step "6. ეტიკეტები, იმპორტი, შემაჯამებელი"
chk "ეტიკეტი QR — PDF; თანამშრომელი — 403" "$(curl -s "$B/assets/labels?ids=$A1,$A4" -H "authorization: Bearer $SK" | head -c 4):$(code GET "/assets/labels?ids=$A1" "$T1")" "%PDF:403"
mod '{"label_code":"code128","label_size":"70x35"}'
chk "ეტიკეტი Code128 70×35 — PDF" "$(curl -s "$B/assets/labels?ids=$A1" -H "authorization: Bearer $SK" | head -c 4)" "%PDF"
chk "იმპორტის შაბლონი — .xlsx" "$(curl -s "$B/assets/import/template" -H "authorization: Bearer $SM" | head -c 2)" "PK"
CSV="$TMP/a.csv"; DC1=$(api GET /departments "$ADM" | jq -r ".[]|select(.id==\"$D1\").code")
{ echo "საინვენტარო №;დასახელება;კატეგორია (კოდი);მწარმოებელი;მოდელი;სერიული №;განყოფილება (კოდი);ოთახი;პასუხისმგებელი (ელ-ფოსტა);მდგომარეობა (კოდი);შეძენის თარიღი;ღირებულება;შენიშვნა"
  echo "IMP-$S;ტესტ-E2E კარადა;FURNITURE;;;;$DC1;104;e2e.ast.33.$S@test.local;good;2023-01-15;420;"
  echo ";ტესტ-E2E პრინტერი;IT;HP;M404;;$DC1;104;e2e.ast.33.$S@test.local;repair;;;"
  echo ";ტესტ-E2E უცნობი;NOPE;;;;$DC1;104;e2e.ast.33.$S@test.local;good;;;"; } > "$CSV"
up() { curl -s -X POST "$B/assets/import?commit=$1" -H "authorization: Bearer $SM" -F "file=@$CSV;filename=a.csv"; }
chk "შემოწმება: 2 დაემატება, 1 შეცდომა; შეცდომით იმპორტი — 400" "$(up false | jq -r '"\(.commit):\(.created):\(.errors)"'):$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/assets/import?commit=true" -H "authorization: Bearer $SM" -F "file=@$CSV;filename=a.csv")" "false:2:1:400"
sed -i '$d' "$CSV"
chk "გასწორებული → იმპორტი: 2; განმეორებით — ხელით ნომერი გამოტოვდება" "$(up true | jq -r .created):$(sed -i '3d' "$CSV"; up true | jq -r '"\(.created):\(.skipped)"')" "2:0:1"
api GET "/assets?search=$(enc ტესტ-E2E)&department_id=$D1" "$SM" | jq -r '.[].id' >> "$TMP/assets"
chk "შემაჯამებელი (მენეჯერი); თანამშრომელი — 403" "$(api GET /assets/summary "$SM" | jq -r "[.[]|select(.department_name==\"ტესტ-E2E ადმინისტრაცია $S\")|.total]|add>0"):$(code GET /assets/summary "$T1")" "true:403"

step "7. ცნობარები და მოდულის გამორთვა"
chk "კატეგორია: მენეჯერი ქმნის; მესაწყობე — 403; მდგომარეობა" "$(api POST /assets/categories "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E კატეგორია\"}" | jq -r .code):$(code POST /assets/categories "$SK" -d "{\"code\":\"E2EX_$S\",\"name\":\"x x\"}"):$(api POST /assets/conditions "$SM" -d "{\"code\":\"e2e_$S\",\"name\":\"ტესტ-E2E\",\"usable\":false}" | jq -r .usable)" "E2E_$S:403:false"
api PUT /modules/asset_register "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → რეესტრი 403 (MODULE_DISABLED)" "$(code GET /assets "$SM"):$(api GET /assets/refs "$SM" | jq -r .code)" "403:MODULE_DISABLED"
api PUT /modules/asset_register "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "ჩართვა → ისევ მუშაობს" "$(code GET /assets "$SM")" "200"

step "გასუფთავება"
LEFT=$(for a in $(sort -u "$TMP/assets"); do api GET "/assets/$a" "$SM" | jq -r 'select(.status=="active")|.id'; done | jq -R . | jq -sc .)
[ "$LEFT" != "[]" ] && api POST /assets/writeoffs "$SM" -d "{\"asset_ids\":$LEFT,\"reason\":\"ტესტ-E2E: გასუფთავება\"}" >/dev/null
api PUT /modules/asset_register "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="asset_register")|{enabled, settings}')" "$ORIG"
chk "სატესტო ინვენტარი ჩამოწერილია" "$(for a in $(sort -u "$TMP/assets"); do api GET "/assets/$a" "$SM" | jq -r .status; done | sort -u | paste -sd,)" "written_off"
CID=$(api GET /assets/refs "$SM" | jq -r ".categories[]|select(.code==\"E2E_$S\").id"); api PATCH "/assets/categories/$CID" "$SM" -d '{"is_active":false}' >/dev/null
api PATCH "/assets/conditions/e2e_$S" "$SM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მომხმარებლები / განყოფილებები გათიშულია (ჩამოწერილი ინვენტარი და აქტები ისტორიაში რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
