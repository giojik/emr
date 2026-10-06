#!/usr/bin/env bash
# =====================================================================
# e2e-cssd.sh — სტერილიზაცია (0039, მოდული „cssd“)
#   ცნობარები (შეფუთვა + მასალა, აპარატები, ნაკრების ტიპები, ნაკრები) — CSSD-ის ხელმძღვანელი; დამუშავება — ერთეულის თანამშრომელი
#   მიღება → რეცხვა (აპარატით) → შეფუთვა (ჩეკლისტი, არასრული — შენიშვნით, მასალის ჩამოწერა) → Bowie-Dick → სტერილიზაცია
#   (ქიმიური ინდიკატორი თითოზე, BI — სიხშირით / იმპლანტზე, ქარანტინი) → გაცემა → გამოყენება პაციენტზე → დაბრუნება;
#   BI ჩავარდა → გაწვევა (სასწრაფო შეტყობინება, გამოყენება აკრძალულია); გაუხსნელის დაბრუნება; ეტიკეტი; რეპორტი; პარამეტრები; ინსტრუმენტები
# პარამეტრები ბოლოს ბრუნდება; სატესტო ცნობარები / ერთეული ითიშება (ისტორია რჩება).
# გამოყენება:  bash scripts/e2e-cssd.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); D180=$(date -d "$TODAY +180 days" +%F)
mod()  { api PUT /modules/cssd "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }

step "0. მომზადება"
DC=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E CSSD $S\",\"code\":\"E2EZ$S\",\"type\":\"auxiliary\"}" | jq -r '.id // empty')
[ -n "$DC" ] || DC=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E CSSD $S\",\"code\":\"E2EZ$S\",\"type\":\"administrative\"}" | jq -r '.id // empty')
DO=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქირურგია $S\",\"code\":\"E2EY$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DX=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E სხვა $S\",\"code\":\"E2EX$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DC" ] && [ -n "$DO" ] && [ -n "$DX" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.css.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"სტერ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.css.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
R_SM=$(mkrole csm2 "საწყობის მენეჯერი" '["stock_manager"]'); SM=$(mkuser "[\"$R_SM\"]" 61)
CH=$(mkuser '["nurse"]' 62 ",\"department_id\":\"$DC\",\"is_section_head\":true"); C1=$(mkuser '["nurse"]' 63 ",\"department_id\":\"$DC\"")
S1=$(mkuser '["nurse"]' 64 ",\"department_id\":\"$DO\""); X1=$(mkuser '["nurse"]' 65 ",\"department_id\":\"$DX\"")
[ -n "$SM" ] && [ -n "$CH" ] && [ -n "$C1" ] && [ -n "$S1" ] && [ -n "$X1" ] && ok "5 მომხმარებელი (საწყობის მენეჯერი, CSSD ხელმძღვანელი + თანამშრომელი, ქირურგია, სხვა)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="cssd")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული cssd ვერ მოიძებნა"
mod '{"instrument_tracking":false,"wash_record":true,"bd_required":true,"bi_frequency":"weekly","bi_hold":"implant","shelf_life_mode":"time","patient_trace":true,"auto_consume":true}'
UNIT=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_ZC_$S\",\"name\":\"ტესტ-E2E CSSD ერთეული $S\",\"kind\":\"cssd\",\"department_id\":\"$DC\"}" | jq -r '.id // empty')
HOUSE=$(api GET /stock/refs "$SM" | jq -r '.categories[]|select(.code=="HOUSE").id')
POUCH=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E სტერ. პაკეტი $S\",\"category_id\":\"$HOUSE\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
RC=$(api POST /stock/receipts "$SM" -d "{\"location_id\":\"$UNIT\",\"lines\":[{\"item_id\":\"$POUCH\",\"qty\":10,\"price\":0.5,\"vat_rate\":0}]}" | jq -r .id); api POST "/stock/receipts/$RC/post" "$SM" >/dev/null
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"5$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ოპერაცია\",\"birth_date\":\"1978-07-07\",\"gender\":\"male\",\"phone_number\":\"594$S\"}" | jq -r '.id // empty')
[ -n "$UNIT" ] && [ -n "$POUCH" ] && [ -n "$PAT" ] && ok "CSSD ერთეული (ლოკაცია → განყოფილება), პაკეტი 10 ცალი ერთეულის ქვესაწყობში, პაციენტი" || die "მონაცემები ვერ შეიქმნა"
pbal() { api GET "/stock/balances?location_id=$UNIT&item_id=$POUCH" "$SM" | jq -r '[.rows[].qty|tonumber+0]|add // 0'; }

step "1. ცნობარები"
chk "თანამშრომელი შეფუთვის ტიპს ვერ ქმნის — 403" "$(code POST /cssd/packaging "$C1" -d '{"name":"x x","shelf_days":10}')" "403"
PKG=$(api POST /cssd/packaging "$CH" -d "{\"name\":\"ტესტ-E2E პაკეტი $S\",\"shelf_days\":180,\"consumables\":[{\"item_id\":\"$POUCH\",\"qty\":1}]}" | jq -r '.id // empty')
AUTO=$(api POST /cssd/machines "$CH" -d "{\"name\":\"ტესტ-E2E ავტოკლავი $S\",\"kind\":\"steam\",\"location_id\":\"$UNIT\",\"manufacturer\":\"Tuttnauer\",\"programs\":[{\"name\":\"134° 5 წთ\",\"temp\":134,\"minutes\":5}]}" | jq -r '.id // empty')
WASH=$(api POST /cssd/machines "$CH" -d "{\"name\":\"ტესტ-E2E სარეცხი $S\",\"kind\":\"washer\",\"location_id\":\"$UNIT\"}" | jq -r '.id // empty')
chk "ხელმძღვანელი: შეფუთვა (180 დღე + პაკეტის ჩამოწერა), ავტოკლავი, სარეცხი" "$([ -n "$PKG" ] && [ -n "$AUTO" ] && [ -n "$WASH" ] && echo ok)" "ok"
TL=$(api POST /cssd/templates "$CH" -d "{\"code\":\"E2E-LAP-$S\",\"name\":\"ტესტ-E2E ლაპაროსკოპია\",\"owner_department_id\":\"$DO\",\"packaging_type_id\":\"$PKG\",\"items\":[{\"name\":\"მაკრატელი\",\"qty\":2},{\"name\":\"მომჭერი\",\"qty\":4},{\"name\":\"ტროაკარი\",\"qty\":1}]}")
TLID=$(echo "$TL" | jq -r .id)
chk "ნაკრების ტიპი: 3 პოზიცია; იგივე კოდი — 409" "$(echo "$TL" | jq -r '.items|length'):$(code POST /cssd/templates "$CH" -d "{\"code\":\"E2E-LAP-$S\",\"name\":\"x x\"}")" "3:409"
TI=$(api POST /cssd/templates "$CH" -d "{\"code\":\"E2E-IMP-$S\",\"name\":\"ტესტ-E2E ორთოპედიული იმპლანტები\",\"packaging_type_id\":\"$PKG\",\"is_implant\":true,\"items\":[{\"name\":\"ხრახნი\",\"qty\":10}]}" | jq -r .id)
SETS=$(api POST /cssd/sets "$CH" -d "{\"template_id\":\"$TLID\",\"home_location_id\":\"$UNIT\",\"count\":2}")
L1=$(echo "$SETS" | jq -r '.[0].id'); L2=$(echo "$SETS" | jq -r '.[1].id'); L1C=$(echo "$SETS" | jq -r '.[0].barcode')
I1=$(api POST /cssd/sets "$CH" -d "{\"template_id\":\"$TI\",\"home_location_id\":\"$UNIT\",\"barcode\":\"imp-$S\"}" | jq -r '.[0].id')
chk "ნაკრები: 2 ლაპაროსკოპია (CS-…, №1/№2) + იმპლანტი (ხელით კოდი)" "$(echo "$SETS" | jq -r '[.[]|"\(.barcode|test("^CS-")):\(.serial)"]|join(",")'):$(api GET "/cssd/sets/$I1" "$C1" | jq -r .barcode)" "true:№1,true:№2:IMP-$S"
chk "ერთეულის თანამშრომელს — can_process" "$(api GET /cssd/refs "$C1" | jq -r ".units[]|select(.id==\"$UNIT\")|.can_process")" "true"

step "2. მიღება, რეცხვა, შეფუთვა"
chk "სხვა განყოფილება ვერ იღებს — 403" "$(code POST /cssd/receive "$X1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\"]}")" "403"
chk "მიღება (3 ნაკრები); მეორედ — 409" "$(api POST /cssd/receive "$C1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\",\"$L2\",\"$I1\"]}" | jq -r .received):$(code POST /cssd/receive "$C1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\"]}")" "3:409"
chk "შეფუთვა რეცხვამდე — 409; რეცხვა აპარატის გარეშე — 400 (პარამეტრი)" "$(code POST /cssd/pack "$C1" -d "{\"set_id\":\"$L1\"}"):$(code POST /cssd/wash "$C1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\"]}")" "409:400"
chk "რეცხვა (სარეცხი აპარატი, ციკლი)" "$(api POST /cssd/wash "$C1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\",\"$L2\",\"$I1\"],\"machine_id\":\"$WASH\",\"program\":\"A0 3000\",\"result\":\"pass\"}" | jq -r '"\(.washed):\(.cycle_id!=null)"')" "3:true"
chk "არასრული შემადგენლობა შენიშვნის გარეშე — 400" "$(code POST /cssd/pack "$C1" -d "{\"set_id\":\"$L1\",\"checklist\":[{\"line_no\":2,\"counted\":3}]}")" "400"
P1=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$L1\",\"checklist\":[{\"line_no\":2,\"counted\":3,\"note\":\"ერთი მომჭერი შეკეთებაზე\"}]}")
P1ID=$(echo "$P1" | jq -r .id); P1NO=$(echo "$P1" | jq -r .pack_no)
chk "შეფუთვა: SP-ნომერი, არასრული (შენიშვნით), სტატუსი packed" "$(echo "$P1" | jq -r '"\(.pack_no|test("^SP[0-9]{2}-")):\(.incomplete):\(.status)"')" "true:true:packed"
P2ID=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$L2\"}" | jq -r .id); PIID=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$I1\"}" | jq -r .id)
chk "შეფუთვის მასალა ჩამოიწერა (10 → 7); იგივე ნაკრები მეორედ — 409" "$(pbal):$(code POST /cssd/pack "$C1" -d "{\"set_id\":\"$L1\"}")" "7:409"
chk "სკანირება შეფუთვის ნომრით → ნაკრები + შეფუთვა" "$(api GET "/cssd/scan/$P1NO" "$S1" | jq -r '"\(.set.barcode):\(.pack.pack_no)"')" "$L1C:$P1NO"

step "3. სტერილიზაცია: Bowie-Dick, ინდიკატორები, BI"
CY() { api POST /cssd/cycles "$C1" -d "$1"; }
cyc() { curl -s -o /dev/null -w '%{http_code}' -X POST "$B/cssd/cycles" -H "authorization: Bearer $C1" -H "$J" -d "$1"; }
chk "Bowie-Dick-ის გარეშე — 409" "$(cyc "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"bi_used\":true,\"pack_ids\":[\"$P1ID\"]}")" "409"
CY "{\"machine_id\":\"$AUTO\",\"kind\":\"bowie_dick\",\"result\":\"fail\"}" >/dev/null
chk "Bowie-Dick ჩავარდა — აპარატი დაბლოკილია (409)" "$(cyc "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"bi_used\":true,\"pack_ids\":[\"$P1ID\"]}")" "409"
chk "Bowie-Dick გაიარა; სარეცხზე Bowie-Dick — 400" "$(CY "{\"machine_id\":\"$AUTO\",\"kind\":\"bowie_dick\",\"result\":\"pass\"}" | jq -r .result):$(cyc "{\"machine_id\":\"$WASH\",\"kind\":\"bowie_dick\",\"result\":\"pass\"}")" "pass:400"
chk "BI სავალდებულო: კვირის პირველი ციკლი (BI-ს გარეშე — 400)" "$(api GET "/cssd/bi-required?machine_id=$AUTO" "$C1" | jq -r .required):$(cyc "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"pack_ids\":[\"$P1ID\",\"$P2ID\"]}")" "true:400"
C1J=$(CY "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"program\":\"134° 5 წთ\",\"temp_c\":134,\"minutes\":5,\"pressure_bar\":2.1,\"result\":\"pass\",\"bi_used\":true,\"bi_lot\":\"BI-77\",\"pack_ids\":[\"$P1ID\",\"$P2ID\"],\"ci_fail_pack_ids\":[\"$P2ID\"]}")
CY1=$(echo "$C1J" | jq -r .id)
chk "ციკლი: P1 — სტერილური (არა-იმპლანტი, BI-ს არ ელოდება), ვადა +180; P2 — ქიმ. ინდიკატორი ჩავარდა → failed" \
  "$(echo "$C1J" | jq -r --arg a "$P1ID" --arg b "$P2ID" '"\(.bi_result):" + ([.packs[]|select(.id==$a)|"\(.status):\(.expires_on)"]|join("")) + ":" + ([.packs[]|select(.id==$b)|.status]|join(""))')" "pending:sterile:$D180:failed"
chk "ჩავარდნილის ნაკრები — ხელახლა შეფუთვისთვის (washed)" "$(api GET "/cssd/sets/$L2" "$C1" | jq -r .status)" "washed"
chk "კვირაში ერთხელ: ახლა BI აღარ სჭირდება; იმპლანტზე — ყოველთვის" "$(api GET "/cssd/bi-required?machine_id=$AUTO" "$C1" | jq -r .required):$(api GET "/cssd/bi-required?machine_id=$AUTO&implant=true" "$C1" | jq -r .required)" "false:true"
chk "იმპლანტი BI-ს გარეშე — 400" "$(cyc "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"pack_ids\":[\"$PIID\"]}")" "400"
CY2=$(CY "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"bi_used\":true,\"pack_ids\":[\"$PIID\"]}" | jq -r .id)
chk "იმპლანტი — ქარანტინი (BI-ს მოლოდინი)" "$(api GET "/cssd/packs/$PIID" "$C1" | jq -r .status)" "quarantine"
chk "იგივე ციკლის № იმავე აპარატზე — 409" "$(cyc "{\"machine_id\":\"$AUTO\",\"kind\":\"bowie_dick\",\"cycle_no\":\"$(api GET "/cssd/cycles/$CY2" "$C1" | jq -r .cycle_no)\",\"result\":\"pass\"}")" "409"

step "4. გაცემა, გამოყენება, დაბრუნება"
chk "ქარანტინიდან გაცემა — 409" "$(code POST /cssd/issue "$C1" -d "{\"location_id\":\"$UNIT\",\"department_id\":\"$DO\",\"pack_ids\":[\"$PIID\"]}")" "409"
chk "გაცემა ქირურგიაში; სხვა განყოფილებას — გამოყენება 403" "$(api POST /cssd/issue "$C1" -d "{\"location_id\":\"$UNIT\",\"department_id\":\"$DO\",\"pack_ids\":[\"$P1ID\"]}" | jq -r .issued):$(code POST "/cssd/packs/$P1ID/use" "$X1" -d "{\"patient_id\":\"$PAT\"}")" "1:403"
chk "ქირურგიის „ჩემი“ სია; გამოყენება პაციენტის გარეშე — 400 (მიკვლევა)" "$(api GET "/cssd/packs?mine=true&status=issued" "$S1" | jq -r "[.[]|select(.id==\"$P1ID\")]|length"):$(code POST "/cssd/packs/$P1ID/use" "$S1" -d '{}')" "1:400"
chk "გამოყენება პაციენტზე → used; პაციენტის ისტორიაში" "$(api POST "/cssd/packs/$P1ID/use" "$S1" -d "{\"patient_id\":\"$PAT\"}" | jq -r .status):$(api GET "/cssd/packs?patient_id=$PAT" "$C1" | jq length)" "used:1"
chk "ბინძურის მიღება CSSD-ში → received" "$(api POST /cssd/receive "$C1" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$L1\"]}" | jq -r .received):$(api GET "/cssd/sets/$L1" "$C1" | jq -r .status)" "1:received"
chk "BI დადებითი → იმპლანტი სტერილური" "$(api POST "/cssd/cycles/$CY2/bi" "$C1" -d '{"result":"pass"}' | jq -r .bi_result):$(api GET "/cssd/packs/$PIID" "$C1" | jq -r .status)" "pass:sterile"
api POST /cssd/issue "$C1" -d "{\"location_id\":\"$UNIT\",\"department_id\":\"$DO\",\"pack_ids\":[\"$PIID\"]}" >/dev/null
chk "გაუხსნელის დაბრუნება → ისევ სტერილური, ნაკრები CSSD-ში" "$(api POST "/cssd/packs/$PIID/return" "$S1" | jq -r .status):$(api GET "/cssd/sets/$I1" "$C1" | jq -r .status)" "sterile:packed"

step "5. BI ჩავარდა → გაწვევა"
P2B=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$L2\"}" | jq -r .id)
CY3=$(CY "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"bi_used\":true,\"pack_ids\":[\"$P2B\"]}" | jq -r .id)
api POST /cssd/issue "$C1" -d "{\"location_id\":\"$UNIT\",\"department_id\":\"$DO\",\"pack_ids\":[\"$P2B\"]}" >/dev/null
chk "BI ჩავარდა → შეფუთვა გაწვეულია; ქირურგიას — სასწრაფო შეტყობინება" "$(api POST "/cssd/cycles/$CY3/bi" "$C1" -d '{"result":"fail"}' | jq -r '.packs[0].status'):$(api GET "/notifications?unread=true" "$S1" | jq -r '[.[]|select(.kind=="cssd_recall" and .urgent)]|length')" "recalled:1"
chk "გაწვეულის გამოყენება — 409; დაბრუნება CSSD-ში (გაწვეული რჩება)" "$(code POST "/cssd/packs/$P2B/use" "$S1" -d "{\"patient_id\":\"$PAT\"}"):$(api POST "/cssd/packs/$P2B/return" "$S1" | jq -r .status)" "409:recalled"
chk "მეორედ BI-ს პასუხი — 409" "$(code POST "/cssd/cycles/$CY3/bi" "$C1" -d '{"result":"pass"}')" "409"

step "6. ეტიკეტი, რეპორტი, ისტორია"
chk "ეტიკეტი — PDF; სხვა განყოფილება — 403" "$(curl -s "$B/cssd/labels?ids=$PIID" -H "authorization: Bearer $C1" | head -c 4):$(code GET "/cssd/labels?ids=$PIID" "$X1")" "%PDF:403"
REP=$(api GET "/cssd/report?from=$TODAY&to=$TODAY" "$CH")
chk "რეპორტი: ავტოკლავი — სტერილიზაცია 3 (BI 3, ჩავარდა 1); Bowie-Dick 2 (1 ჩავარდა)" \
  "$(echo "$REP" | jq -r --arg m "ტესტ-E2E ავტოკლავი $S" '[.cycles[]|select(.machine_name==$m)|"\(.kind)=\(.total)/\(.failed)/\(.bi)/\(.bi_failed)"]|sort|join(",")')" "bowie_dick=2/1/0/0,sterilize=3/0/3/1"
chk "ნაკრების ისტორია (მიღება → … → გამოყენება → მიღება)" "$(api GET "/cssd/sets/$L1" "$C1" | jq -r '[.events[].kind]|reverse|join(">")')" "created>received>washed>packed>sterile>issued>used>received"

step "7. პარამეტრები"
mod '{"wash_record":false,"patient_trace":false,"bi_frequency":"off","bi_hold":"none","auto_consume":false}'
P1B=$(api POST /cssd/pack "$C1" -d "{\"set_id\":\"$L1\"}")
chk "რეცხვის აღრიცხვის გარეშე — შეფუთვა მიღებიდან; მასალა არ ჩამოიწერა" "$(echo "$P1B" | jq -r .status):$(pbal)" "packed:6"
CY4=$(CY "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"pack_ids\":[\"$(echo "$P1B" | jq -r .id)\"]}")
chk "BI გამორთულია — ციკლი BI-ს გარეშე" "$(echo "$CY4" | jq -r '"\(.bi_used):\(.packs[0].status)"')" "false:sterile"
api POST /cssd/issue "$C1" -d "{\"location_id\":\"$UNIT\",\"department_id\":\"$DO\",\"pack_ids\":[\"$(echo "$P1B" | jq -r .id)\"]}" >/dev/null
chk "მიკვლევა გამორთულია — გამოყენება პაციენტის გარეშე" "$(api POST "/cssd/packs/$(echo "$P1B" | jq -r .id)/use" "$S1" -d '{}' | jq -r .status)" "used"
chk "ინსტრუმენტები გამორთულია — 400" "$(code POST /cssd/instruments "$CH" -d "{\"code\":\"I-$S\",\"name\":\"x x\"}")" "400"
mod '{"instrument_tracking":true}'
chk "ჩართვა → ინსტრუმენტი ნაკრებზე" "$(api POST /cssd/instruments "$CH" -d "{\"code\":\"lz-$S\",\"name\":\"ტესტ-E2E მაკრატელი Metzenbaum\",\"set_id\":\"$I1\",\"max_cycles\":500}" | jq -r '"\(.code):\(.cycles)"')" "LZ-$S:0"
api PUT /modules/cssd "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → 403" "$(code GET /cssd/refs "$C1")" "403"

step "გასუფთავება"
api PUT /modules/cssd "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="cssd")|{enabled, settings}' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"
for T in "$TLID" "$TI"; do api PATCH "/cssd/templates/$T" "$CH" -d '{"is_active":false}' >/dev/null; done
for M in "$AUTO" "$WASH"; do api PATCH "/cssd/machines/$M" "$CH" -d '{"is_active":false}' >/dev/null; done
api PATCH "/cssd/packaging/$PKG" "$CH" -d '{"is_active":false}' >/dev/null
LN=$(api GET "/stock/balances?location_id=$UNIT" "$SM" | jq -c '[.rows[]|{lot_id, qty_base:(.qty|tonumber)}]')
[ "$LN" != "[]" ] && { WC=$(api POST /stock/writeoffs "$SM" -d "{\"location_id\":\"$UNIT\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":$LN}" | jq -r '.id // empty'); [ -n "$WC" ] && api POST "/stock/writeoffs/$WC/decide" "$ADM" -d '{"approve":true}' >/dev/null; }
api PATCH "/stock/items/$POUCH" "$SM" -d '{"is_active":false}' >/dev/null; api PATCH "/stock/locations/$UNIT" "$SM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$DC" "$DO" "$DX"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო ცნობარები / ერთეული / მომხმარებლები გათიშულია (ციკლები, შეფუთვები და ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
