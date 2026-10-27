#!/usr/bin/env bash
# =====================================================================
# e2e-roster.sh — ცვლები / მორიგეობა, ეტაპი 1 (0077): საფუძველი
#   მოდული და პარამეტრები (ვალიდაცია), უფლებები (roster / roster_all / roster_view; შაბლონ-როლი), ცნობარები (პოზიციები, ცვლის შაბლონები — საათები,
#   მორიგის როლები, როტაციის ნიმუშები, დღესასწაულები), თანამშრომლები (ანგარიშით / ანგარიშის გარეშე, მომხმარებლებიდან, არე),
#   განრიგი (შექმნა, ხილვადობა — მონახაზი / გამოქვეყნებული), ჩანაწერები: გადაფარვა, წესები (დასვენება, ზედიზედ, ღამეები — warn / block),
#   ცვლის / მორიგის კატეგორია, II დონე, სხვა განყოფილება (warn / block), წასული თანამშრომელი, მასობრივი (skip), ნორმის / მორიგეობის ხარვეზები, ჯამები,
#   გამოქვეყნება (გაფრთხილების დადასტურება, შეტყობინება), ცვლილება მიზეზით (ვერსია, ისტორია, შეტყობინება), „ვინ არის მორიგე“ (ტელეფონის ხილვადობა,
#   დაუნიშნავი, მონახაზი არ ჩანს), „ჩემი განრიგი“, წინა თვიდან კოპირება, როტაცია (overwrite), გასუფთავება, მოდულის გამორთვა
# ბოლოს: თანამშრომლები / ცნობარების სატესტო ჩანაწერები / მომხმარებლები / განყოფილებები გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-roster.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
J='content-type: application/json'
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
has()  { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1" "უნდა შეიცავდეს: $3 | მიღებული: $2"; fi; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mშეწყდა:\033[0m %s\n' "$1"; exit 1; }
command -v jq >/dev/null || die "jq არ არის დაყენებული"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); S4=${S: -4}; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mod()  { api PUT /modules/roster "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
# სატესტო თვე: +2 თვე (M), შემდეგი — M+1 (კოპირება / როტაცია)
M=$(TZ=Asia/Tbilisi date -d "$(TZ=Asia/Tbilisi date +%Y-%m-01) +2 month" +%Y-%m); NX=$(date -d "$M-01 +1 month" +%Y-%m)
LEN=$(date -d "$M-01 +1 month -1 day" +%d | sed 's/^0//')
d()  { printf '%s-%02d' "$M" "$1"; }
dn() { printf '%s-%02d' "$NX" "$1"; }
at() { echo "$(d "$1")T$2:00+04:00"; }
add() { api POST "/roster/rosters/$1/entries" "$2" -d "{\"items\":$3${4:-}}"; }   # <roster> <token> <items-json> [,"mode":…]
item() { echo "{\"staff_id\":\"$1\",\"day\":\"$2\",\"shift_template_id\":\"$3\"${4:-}}"; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0077" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0077" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E თერაპია $S\",\"code\":\"E2ERA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქირურგია $S\",\"code\":\"E2ERB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rst.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"განრიგი-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"phone\":\"5990$2$S4\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rst.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_PL=$(mkrole rpl "განრიგი (განყ.)" '["roster"]'); R_ALL=$(mkrole rall "განრიგი (ყველა)" '["roster_all"]'); R_VW=$(mkrole rvw "განრიგი (ნახვა)" '["roster_view"]')
[ -n "$R_PL" ] && [ -n "$R_ALL" ] && [ -n "$R_VW" ] || die "როლები ვერ შეიქმნა (roster / roster_all / roster_view უფლებები?)"
read -r _ PL <<< "$(mkuser "[\"$R_PL\",\"nurse\"]" 51 ",\"department_id\":\"$D1\"")"
read -r _ PL2 <<< "$(mkuser "[\"$R_PL\"]" 52 ",\"department_id\":\"$D2\"")"
read -r _ ALL <<< "$(mkuser "[\"$R_ALL\"]" 53)"; read -r _ VW <<< "$(mkuser "[\"$R_VW\"]" 54)"
read -r N1ID N1 <<< "$(mkuser '["nurse"]' 55 ",\"department_id\":\"$D1\"")"; read -r _ N0 <<< "$(mkuser '["nurse"]' 56)"
[ -n "$PL" ] && [ -n "$PL2" ] && [ -n "$ALL" ] && [ -n "$VW" ] && [ -n "$N1" ] && [ -n "$N0" ] && ok "6 მომხმარებელი (შემდგენი D1 / D2, მთელი კლინიკა, ნახვა, ექთანი D1, ექთანი)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული roster ვერ მოიძებნა"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null

step "1. მოდული, უფლებები, პარამეტრები"
CAPS=$(api GET /roles/capabilities "$ADM")
chk "უფლებები: roster, roster_all, roster_view (45; 0078: + absence_approve)" "$(echo "$CAPS" | jq -r '[.[]|select(.code=="roster" or .code=="roster_all" or .code=="roster_view")]|length'):$(echo "$CAPS" | jq length)" "3:45"
chk "შაბლონ-როლი „განრიგის შემდგენი“ (roster)" "$(api GET /roles "$ADM" | jq -r '.[]|select(.code=="roster_planner")|.capabilities|join(",")')" "roster"
chk "უცნობი პარამეტრი / ზედიზედ 100 სთ / უცნობი რეჟიმი — 400" "$(code PUT /modules/roster "$ADM" -d '{"settings":{"foo":1},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"max_continuous_hours":100},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"rest_mode":"hard"},"reason":"ტესტ"}')" "400:400:400"
chk "პარამეტრის ცვლა: შემდგენი — 403" "$(code PUT /modules/roster "$PL" -d '{"settings":{"rest_mode":"warn"},"reason":"ტესტ ტესტ"}')" "403"
mod '{"rest_min_hours":12,"rest_mode":"warn","max_continuous_hours":24,"continuous_mode":"block","max_week_hours":48,"week_mode":"warn","max_consecutive_nights":3,"nights_mode":"warn","norm_mode":"warn","cross_department":"warn","publish_notify":true,"change_notify":true,"duty_phone":"staff","copy_mode":"weekday"}'
chk "პარამეტრები: დასვენება 12 / warn, ზედიზედ 24 / block, ტელეფონი — staff" "$(api GET /roster/refs "$PL" | jq -r '.settings|"\(.rest_min_hours):\(.rest_mode):\(.max_continuous_hours):\(.continuous_mode):\(.duty_phone)"')" "12:warn:24:block:staff"

step "2. ცნობარები"
REFS=$(api GET /roster/refs "$N0")
chk "ცნობარი ყველას: ცვლები D / N / 24 / W / OC — 12 / 12 / 24 / 8 / 0 სთ; 3 ნიმუში" "$(echo "$REFS" | jq -r '[.templates[]|select(.code=="D" or .code=="N" or .code=="24" or .code=="W" or .code=="OC")|"\(.code)=\(.hours)"]|sort|join(",")'):$(echo "$REFS" | jq -r '[.patterns[]|select(.code=="R24_72" or .code=="DNOO" or .code=="W5_2")]|length')" "24=24,D=12,N=12,OC=0,W=8:3"
chk "უფლებები ცნობარში: ექთანი — არაფერი; შემდგენი — თავისი განყოფილება" "$(echo "$REFS" | jq -r '.can|"\(.setup):\(.hr):\(.edit_depts|length)"'):$(api GET /roster/refs "$PL" | jq -r --arg d "$D1" '.can.edit_depts|index($d) != null')" "false:false:0:true"
TD=$(echo "$REFS" | jq -r '.templates[]|select(.code=="D").id'); TN=$(echo "$REFS" | jq -r '.templates[]|select(.code=="N").id'); T24=$(echo "$REFS" | jq -r '.templates[]|select(.code=="24").id')
TW=$(echo "$REFS" | jq -r '.templates[]|select(.code=="W").id'); PDNOO=$(echo "$REFS" | jq -r '.patterns[]|select(.code=="DNOO").id'); REST=$(echo "$REFS" | jq -r .rest)
chk "პოზიცია: შემდგენი — 403" "$(code POST /roster/positions "$PL" -d "{\"code\":\"E2E_N_$S\",\"name\":\"x x\",\"category\":\"nurse\"}")" "403"
PN=$(api POST /roster/positions "$ALL" -d "{\"code\":\"E2E_N_$S\",\"name\":\"ტესტ-E2E ექთანი\",\"category\":\"nurse\"}" | jq -r '.id // empty')
PD=$(api POST /roster/positions "$ALL" -d "{\"code\":\"E2E_D_$S\",\"name\":\"ტესტ-E2E ექიმი\",\"category\":\"doctor\"}" | jq -r '.id // empty')
PJ=$(api POST /roster/positions "$ALL" -d "{\"code\":\"E2E_J_$S\",\"name\":\"ტესტ-E2E სანიტარი\",\"category\":\"junior\"}" | jq -r '.id // empty')
chk "3 პოზიცია (ექთანი, ექიმი, სანიტარი); იგივე კოდი — 409; კოდის შეცვლა — 400" "$([ -n "$PN" ] && [ -n "$PD" ] && [ -n "$PJ" ] && echo ok):$(code POST /roster/positions "$ALL" -d "{\"code\":\"E2E_N_$S\",\"name\":\"y y\",\"category\":\"nurse\"}"):$(code PATCH "/roster/positions/$PN" "$ALL" -d '{"code":"ZZ"}')" "ok:409:400"
chk "ცვლის შაბლონი: შემდგენი — 403; შესვენება > ხანგრძლივობა — 400" "$(code POST /roster/templates "$PL" -d "{\"code\":\"Q$S4\",\"name\":\"x x\",\"kind\":\"day\",\"start_time\":\"07:00\",\"end_time\":\"15:00\"}"):$(code POST /roster/templates "$ALL" -d "{\"code\":\"Z$S4\",\"name\":\"ტესტ-E2E x\",\"kind\":\"day\",\"start_time\":\"08:00\",\"end_time\":\"09:00\",\"break_min\":120}")" "403:400"
chk "  … უარყოფილი შაბლონი არ შეინახა" "$(api GET /roster/refs "$ALL" | jq --arg c "Z$S4" '[.templates[]|select(.code==$c)]|length')" "0"
TQ=$(api POST /roster/templates "$ALL" -d "{\"code\":\"Q$S4\",\"name\":\"ტესტ-E2E ექიმის ცვლა\",\"kind\":\"day\",\"start_time\":\"07:00\",\"end_time\":\"15:00\",\"break_min\":30,\"categories\":[\"doctor\"],\"color\":\"#123456\"}")
TQID=$(echo "$TQ" | jq -r '.id // empty')
chk "შაბლონი 07–15, შესვენება 30 წთ → 7.5 სთ, მხოლოდ ექიმი" "$(echo "$TQ" | jq -r '"\(.hours):\(.categories|join(","))"')" "7.5:doctor"
DR1=$(api POST /roster/duty-roles "$ALL" -d "{\"code\":\"E2E_DOC_$S\",\"name\":\"ტესტ-E2E მორიგე ექიმი\",\"department_id\":\"$D1\",\"categories\":[\"doctor\"],\"required_count\":1,\"has_backup\":true,\"phone\":\"0322$S4\"}" | jq -r '.id // empty')
DR2=$(api POST /roster/duty-roles "$ALL" -d "{\"code\":\"E2E_ANY_$S\",\"name\":\"ტესტ-E2E მორიგე (ნებისმიერი)\",\"required_count\":0}" | jq -r '.id // empty')
chk "მორიგის როლები: D1 ექიმი (1, II დონით) / ნებისმიერი (0); შემდგენი — 403" "$([ -n "$DR1" ] && [ -n "$DR2" ] && echo ok):$(code POST /roster/duty-roles "$PL" -d "{\"code\":\"E2E_X_$S\",\"name\":\"x x\"}")" "ok:403"
chk "ნიმუში: უცნობი ცვლით — 400; მხოლოდ დასვენებით — 400" "$(code POST /roster/patterns "$ALL" -d "{\"code\":\"E2E$S\",\"name\":\"x x\",\"cycle\":[\"$D1\"]}"):$(code POST /roster/patterns "$ALL" -d "{\"code\":\"E2E$S\",\"name\":\"x x\",\"cycle\":[\"$REST\"]}")" "400:400"
HD=$(d 16)
chk "დღესასწაული: შემდგენი — 403; HR / ყველა — 201; იგივე დღე — 409" "$(code POST /roster/holidays "$PL" -d "{\"day\":\"$HD\",\"name\":\"ტესტ-E2E\"}"):$(code POST /roster/holidays "$ALL" -d "{\"day\":\"$HD\",\"name\":\"ტესტ-E2E დღესასწაული\"}"):$(code POST /roster/holidays "$ALL" -d "{\"day\":\"$HD\",\"name\":\"ტესტ-E2E\"}")" "403:201:409"

step "3. თანამშრომლები"
SJ=$(api POST /roster/staff "$PL" -d "{\"first_name\":\"სანიტარი\",\"last_name\":\"ტესტ-E2E-ა\",\"department_id\":\"$D1\",\"position_id\":\"$PJ\"}" | jq -r '.id // empty')
SD=$(api POST /roster/staff "$PL" -d "{\"first_name\":\"ექიმი\",\"last_name\":\"ტესტ-E2E-ბ\",\"department_id\":\"$D1\",\"position_id\":\"$PD\",\"phone\":\"599000$S4\"}" | jq -r '.id // empty')
SL=$(api POST /roster/staff "$PL" -d "{\"first_name\":\"წასული\",\"last_name\":\"ტესტ-E2E-გ\",\"department_id\":\"$D1\",\"position_id\":\"$PN\",\"left_on\":\"$(d 5)\"}" | jq -r '.id // empty')
chk "შემდგენი: ანგარიშის გარეშე თანამშრომლები D1-ში (3); D2-ში — 403" "$([ -n "$SJ" ] && [ -n "$SD" ] && [ -n "$SL" ] && echo ok):$(code POST /roster/staff "$PL" -d "{\"first_name\":\"x\",\"last_name\":\"y\",\"department_id\":\"$D2\"}")" "ok:403"
SC=$(api POST /roster/staff "$ALL" -d "{\"first_name\":\"ექთანი\",\"last_name\":\"ტესტ-E2E-დ\",\"department_id\":\"$D2\",\"position_id\":\"$PN\"}" | jq -r '.id // empty')
FU=$(api POST /roster/staff/from-users "$ALL" -d "{\"user_ids\":[\"$N1ID\"],\"position_id\":\"$PN\"}")
SN=$(echo "$FU" | jq -r '.ids[0] // empty')
chk "მომხმარებლიდან: ექთანი (D1, ანგარიშით); მეორედ — გამოტოვდა" "$(echo "$FU" | jq -r .created):$(api POST /roster/staff/from-users "$ALL" -d "{\"user_ids\":[\"$N1ID\"]}" | jq -r '"\(.created):\(.skipped[0].message)"')" "1:0:უკვე რეესტრშია"
SNR=$(api GET "/roster/staff?search=$(jq -rn --arg s "განრიგი-55" '$s|@uri')" "$ALL" | jq -c '.[0]')
chk "ანგარიშიანი: სახელი / ტელეფონი ანგარიშიდან, D1, ექთანი" "$(echo "$SNR" | jq -r --arg d "$D1" '"\(.user_id != null):\(.department_id == $d):\(.category):\(.phone != null)"')" "true:true:nurse:true"
chk "იგივე მომხმარებელი მეორე თანამშრომელს — 409" "$(code POST /roster/staff "$ALL" -d "{\"user_id\":\"$N1ID\",\"department_id\":\"$D1\"}")" "409"
chk "სია: შემდგენი D1 — 4 (D2-ის გარეშე); შემდგენი D2 — 1; ნახვა — ყველა (≥ 5); ექთანი — 403" "$(api GET "/roster/staff?search=$(jq -rn --arg s "ტესტ-E2E" '$s|@uri')" "$PL" | jq length):$(api GET "/roster/staff?search=$(jq -rn --arg s "ტესტ-E2E" '$s|@uri')" "$PL2" | jq length):$(api GET "/roster/staff?search=$(jq -rn --arg s "ტესტ-E2E" '$s|@uri')" "$VW" | jq 'length >= 5'):$(code GET /roster/staff "$N0")" "4:1:true:403"
chk "ანგარიშის გარეშე ფილტრი: D1 — 3" "$(api GET "/roster/staff?no_user=1&department_id=$D1" "$PL" | jq length)" "3"

step "4. განრიგი: შექმნა, ჩანაწერები, წესები"
chk "D2-ის შემდგენი D1-ზე — 403" "$(code POST /roster/rosters "$PL2" -d "{\"department_id\":\"$D1\",\"month\":\"$M\"}")" "403"
R1=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$M\"}" | jq -r '.id // empty')
[ -n "$R1" ] || die "განრიგი ვერ შეიქმნა"
chk "განრიგი D1 / $M — მონახაზი; იგივე თვე — 409; ნახვის უფლებით მონახაზი — 403" "$(api GET "/roster/rosters?month=$M" "$PL" | jq -r --arg d "$D1" '.[]|select(.department_id==$d)|.status'):$(code POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$M\"}"):$(code GET "/roster/rosters/$R1" "$VW")" "draft:409:403"
R=$(add "$R1" "$PL" "[$(item "$SN" "$(d 1)" "$TD")]")
chk "ექთანი, 1 — D (12 სთ), გაფრთხილების გარეშე" "$(echo "$R" | jq -r '"\(.created|length):\(.created[0].warnings|length)"')" "1:0"
R=$(add "$R1" "$PL" "[$(item "$SN" "$(d 1)" "$T24")]")
has "იგივე დრო (24 სთ) — 409, გადაფარვა" "$(echo "$R" | jq -r '.message')" "ემთხვევა"
add "$R1" "$PL" "[$(item "$SN" "$(d 3)" "$TN"),$(item "$SN" "$(d 4)" "$TD")]" >/dev/null
R=$(add "$R1" "$PL" "[$(item "$SN" "$(d 4)" "$TN")]")
chk "ღამე → დღე (24 სთ უწყვეტად) — დაშვებულია; + ღამე (36 სთ) — 409 (block)" "$(api GET "/roster/rosters/$R1" "$PL" | jq --arg s "$SN" '[.entries[]|select(.staff_id==$s)]|length'):$(echo "$R" | jq -r '"\(.code):\(.message|test("ზედიზედ 36"))"')" "3:ROSTER_RULE:true"
add "$R1" "$PL" "[$(item "$SN" "$(d 6)" "$TD")]" >/dev/null
R=$(add "$R1" "$PL" "[$(item "$SN" "$(d 7)" "$TW" ',"start_time":"06:00","end_time":"14:00"')]")
has "დასვენება 10 სთ (< 12) — დაემატა გაფრთხილებით (warn)" "$(echo "$R" | jq -r '.created[0].warnings|join(" | ")')" "დასვენება ცვლებს შორის 10"
R=$(add "$R1" "$PL" "[$(item "$SJ" "$(d 10)" "$TN"),$(item "$SJ" "$(d 11)" "$TN"),$(item "$SJ" "$(d 12)" "$TN"),$(item "$SJ" "$(d 13)" "$TN")]")
chk "სანიტარი: 4 ღამე ზედიზედ — 4 დაემატა" "$(echo "$R" | jq '.created|length')" "4"
has "  … მე-4-ზე გაფრთხილება: „ზედიზედ 4 ღამე“" "$(echo "$R" | jq -r '.created[3].warnings|join(" | ")')" "ზედიზედ 4 ღამე"
R=$(add "$R1" "$PL" "[$(item "$SN" "$(d 9)" "$TQID")]")
has "ექიმის ცვლა ექთანს — 409" "$(echo "$R" | jq -r '.message')" "კატეგორიისთვის"
chk "მორიგე ექიმი (★, I) — 201; ექთანს — 409; II დონე როლზე backup-ის გარეშე — 409" "$(code POST "/roster/rosters/$R1/entries" "$PL" -d "{\"items\":[$(item "$SD" "$(d 1)" "$T24" ",\"duty_role_id\":\"$DR1\",\"duty_level\":1")]}"):$(code POST "/roster/rosters/$R1/entries" "$PL" -d "{\"items\":[$(item "$SN" "$(d 2)" "$TD" ",\"duty_role_id\":\"$DR1\"")]}"):$(code POST "/roster/rosters/$R1/entries" "$PL" -d "{\"items\":[$(item "$SD" "$(d 5)" "$T24" ",\"duty_role_id\":\"$DR2\",\"duty_level\":2")]}")" "201:409:409"
R=$(add "$R1" "$PL" "[$(item "$SC" "$(d 2)" "$TD")]")
has "სხვა განყოფილების ექთანი (warn) — დაემატა გაფრთხილებით" "$(echo "$R" | jq -r '"\(.created|length):" + (.created[0].warnings|join(" | "))')" "სხვა განყოფილების"
mod '{"cross_department":"block"}'
chk "  … cross_department = block — 409" "$(code POST "/roster/rosters/$R1/entries" "$PL" -d "{\"items\":[$(item "$SC" "$(d 5)" "$TD")]}")" "409"
mod '{"cross_department":"warn"}'
R=$(add "$R1" "$PL" "[$(item "$SL" "$(d 10)" "$TD")]")
has "წასული თანამშრომელი (წასვლის თარიღის შემდეგ) — 409" "$(echo "$R" | jq -r '.message')" "წასულია"
R=$(add "$R1" "$PL" "[$(item "$SJ" "$(d 20)" "$TD"),$(item "$SJ" "$(d 20)" "$T24"),$(item "$SJ" "$(d 21)" "$D1")]" ',"mode":"skip"')
chk "მასობრივი (skip): 1 დაემატა, 2 გამოტოვდა (გადაფარვა, უცნობი ცვლა)" "$(echo "$R" | jq -r '"\(.created|length):\(.skipped|length)"')" "1:2"
chk "strict: ერთი ცუდი → არცერთი (409)" "$(code POST "/roster/rosters/$R1/entries" "$PL" -d "{\"items\":[$(item "$SJ" "$(d 22)" "$TD"),$(item "$SJ" "$(d 22)" "$T24")]}"):$(api GET "/roster/rosters/$R1" "$PL" | jq --arg s "$SJ" --arg d "$(d 22)" '[.entries[]|select(.staff_id==$s and .day==$d)]|length')" "409:0"

step "5. ბადე: ჯამები, დარღვევები, ნორმა, მორიგეობა"
NR=$(api POST /roster/norms "$PL" -d "{\"department_id\":\"$D1\",\"shift_template_id\":\"$TD\",\"category\":\"nurse\",\"min_count\":2}" | jq -r '.id // empty')
chk "ნორმა: D1 / D / ექთანი ≥ 2 — შემდგენი; D2-ის შემდგენი — 403" "$([ -n "$NR" ] && echo ok):$(code POST /roster/norms "$PL2" -d "{\"department_id\":\"$D1\",\"shift_template_id\":\"$TD\",\"category\":\"nurse\",\"min_count\":1}")" "ok:403"
G=$(api GET "/roster/rosters/$R1" "$PL")
chk "ჩანაწერი 12; ექთნის საათები 55 (12 + 12 + 12 + 12 + 7)" "$(echo "$G" | jq '.entries|length'):$(echo "$G" | jq --arg s "$SN" '.totals[$s].hours')" "12:55"
chk "მწკრივები: D1-ის 4 აქტიური + სხვა განყოფილებიდან 1 (home = false)" "$(echo "$G" | jq '.staff|length'):$(echo "$G" | jq -r --arg s "$SC" '.staff[]|select(.id==$s)|.home')" "5:false"
chk "დარღვევები (warn): დასვენება + ღამეები; დამბლოკავი 0" "$(echo "$G" | jq -r '[.violations[]|.rule]|unique|map(select(.=="rest" or .=="nights"))|join(",")'):$(echo "$G" | jq .blocking)" "nights,rest:0"
chk "ნორმის ხარვეზი: 1 — ექთანი D 1 / 2; მე-16 დღესასწაულია" "$(echo "$G" | jq -r --arg d "$(d 1)" '.gaps[]|select(.day==$d)|"\(.have)/\(.need)"'):$(echo "$G" | jq -r --arg d "$HD" '.days[]|select(.day==$d)|.holiday')" "1/2:ტესტ-E2E დღესასწაული"
chk "მორიგე დაუნიშნავი: ყველა დღე, 1-ის გარდა ($((LEN - 1)))" "$(echo "$G" | jq --arg r "$DR1" '[.duty_gaps[]|select(.duty_role_id==$r)]|length')" "$((LEN - 1))"

step "6. გამოქვეყნება, ცვლილება მიზეზით"
chk "D2-ის შემდგენი — 403; გაფრთხილებების დადასტურების გარეშე — 409 (ROSTER_WARNINGS)" "$(code POST "/roster/rosters/$R1/publish" "$PL2" -d '{}'):$(api POST "/roster/rosters/$R1/publish" "$PL" -d '{}' | jq -r .code)" "403:ROSTER_WARNINGS"
chk "დადასტურებით — გამოქვეყნდა" "$(api POST "/roster/rosters/$R1/publish" "$PL" -d '{"confirm_warnings":true,"note":"ტესტ-E2E"}' | jq -r .ok):$(api GET "/roster/rosters/$R1" "$PL" | jq -r .status)" "true:published"
chk "გამოქვეყნებულს ხედავს ნახვის უფლება; ხელახლა გამოქვეყნება — 409" "$(code GET "/roster/rosters/$R1" "$VW"):$(code POST "/roster/rosters/$R1/publish" "$PL" -d '{"confirm_warnings":true}')" "200:409"
chk "ექთანს (ანგარიშით) — შეტყობინება „გამოქვეყნდა“" "$(api GET /notifications "$N1" | jq --arg r "$R1" '[.[]|select(.kind=="roster_published")]|length')" "1"
chk "აუდიტში PUBLISH_ROSTER" "$(api GET "/audit-logs?entity_name=rosters&entity_id=$R1&limit=20" "$ADM" | jq -r '[.[]|select(.action=="PUBLISH_ROSTER")]|length')" "1"
R=$(add "$R1" "$PL" "[$(item "$SJ" "$(d 25)" "$TD")]")
chk "გამოქვეყნებულში მიზეზის გარეშე — 400 (REASON_REQUIRED)" "$(echo "$R" | jq -r .code)" "REASON_REQUIRED"
R=$(add "$R1" "$PL" "[$(item "$SJ" "$(d 25)" "$TD")]" ',"reason":"ტესტ-E2E: დამატებითი ცვლა"')
EJ=$(echo "$R" | jq -r '.created[0].id // empty')
chk "მიზეზით — დაემატა; ვერსია 1" "$([ -n "$EJ" ] && echo ok):$(api GET "/roster/rosters/$R1" "$PL" | jq .version)" "ok:1"
E1=$(api GET "/roster/rosters/$R1" "$PL" | jq -r --arg s "$SN" --arg d "$(d 1)" '.entries[]|select(.staff_id==$s and .day==$d)|.id')
chk "ცვლილება (D → W) მიზეზის გარეშე — 400; მიზეზით — OK" "$(code PATCH "/roster/entries/$E1" "$PL" -d "{\"shift_template_id\":\"$TW\"}"):$(api PATCH "/roster/entries/$E1" "$PL" -d "{\"shift_template_id\":\"$TW\",\"reason\":\"ტესტ-E2E: გაცვლა\"}" | jq -r .ok)" "400:true"
chk "ექთანს — შეტყობინება „შეიცვალა“ (± დღე W)" "$(api GET /notifications "$N1" | jq -r --arg r "$R1" '.[]|select(.kind=="roster_changed")|.items|join(",")')" "± $(d 1 | cut -c9-10).$(d 1 | cut -c6-7) W"
chk "მოხსნა მიზეზის გარეშე — 400; მიზეზით — ბადიდან ქრება" "$(code POST "/roster/entries/$EJ/remove" "$PL" -d '{}'):$(api POST "/roster/entries/$EJ/remove" "$PL" -d '{"reason":"ტესტ-E2E: გაუქმდა"}' | jq -r .ok):$(api GET "/roster/rosters/$R1" "$PL" | jq --arg e "$EJ" '[.entries[]|select(.id==$e)]|length')" "400:true:0"
CH=$(api GET "/roster/rosters/$R1/changes" "$PL")
chk "ისტორია: created, publish, add, change, remove; მიზეზები ჩაწერილია" "$(echo "$CH" | jq -r '[.[].kind]|unique|map(select(.=="created" or .=="publish" or .=="add" or .=="change" or .=="remove"))|length'):$(echo "$CH" | jq -r '[.[]|select(.kind=="remove")|.reason]|join(",")')" "5:ტესტ-E2E: გაუქმდა"
chk "გამოქვეყნებულში კოპირება / როტაცია / გასუფთავება — 409" "$(code POST "/roster/rosters/$R1/copy" "$PL" -d '{}'):$(code POST "/roster/rosters/$R1/rotation" "$PL" -d "{\"pattern_id\":\"$PDNOO\",\"staff\":[{\"staff_id\":\"$SJ\"}]}"):$(code POST "/roster/rosters/$R1/clear" "$PL" -d '{}')" "409:409:409"

step "7. ვინ არის მორიგე / ცვლაში"
OD=$(api GET "/roster/on-duty?department_id=$D1&at=$(jq -rn --arg s "$(at 1 12:00)" '$s|@uri')" "$PL")
chk "1-ის 12:00 — მორიგე ექიმი (I), როლის ტელეფონი; ცვლაში 2 (W ექთანი, 24 ექიმი)" "$(echo "$OD" | jq -r --arg s "$SD" '.duty[]|select(.staff_id==$s)|"\(.duty_level):\(.duty_phone != null)"'):$(echo "$OD" | jq '.on_shift|length')" "1:true:2"
chk "პირადი ტელეფონი (duty_phone = staff): შემდგენს — ჩანს, ექთანს — არა" "$(echo "$OD" | jq -r --arg s "$SD" '.duty[]|select(.staff_id==$s)|.phone'):$(api GET "/roster/on-duty?department_id=$D1&at=$(jq -rn --arg s "$(at 1 12:00)" '$s|@uri')" "$N0" | jq -r --arg s "$SD" '.duty[]|select(.staff_id==$s)|.phone')" "599000$S4:null"
chk "2-ის 12:00 — მორიგე ექიმი არ არის (დაუნიშნავი)" "$(api GET "/roster/on-duty?department_id=$D1&at=$(jq -rn --arg s "$(at 2 12:00)" '$s|@uri')" "$N0" | jq -r --arg r "$DR1" '"\(.duty|length):\([.uncovered[]|select(.id==$r)]|length)"')" "0:1"
R2=$(api POST /roster/rosters "$ALL" -d "{\"department_id\":\"$D2\",\"month\":\"$M\"}" | jq -r '.id // empty')
add "$R2" "$ALL" "[$(item "$SC" "$(d 1)" "$TW" ",\"duty_role_id\":\"$DR2\"")]" >/dev/null
chk "მონახაზის მორიგე „მორიგეებში“ არ ჩანს" "$(api GET "/roster/on-duty?department_id=$D2&at=$(jq -rn --arg s "$(at 1 12:00)" '$s|@uri')" "$PL" | jq '.duty|length')" "0"
chk "ექთანი: ჩემი განრიგი — 5 ცვლა, 51 სთ (W 8 + 12 + 12 + 12 + 7); ანგარიში რეესტრის გარეშე — staff = null" "$(api GET "/roster/my?month=$M" "$N1" | jq -r '"\(.entries|length):\(.hours)"'):$(api GET "/roster/my?month=$M" "$N0" | jq -r .staff)" "5:51:null"

step "8. კოპირება, როტაცია, გასუფთავება"
R3=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$NX\"}" | jq -r '.id // empty')
C=$(api POST "/roster/rosters/$R3/copy" "$PL" -d '{"mode":"weekday"}')
TDAY=$(dn $((10 + 28 - LEN)))
chk "წინა თვიდან (კვირის დღეებით): ≥ 5 გადმოვიდა; სანიტრის ღამე 10 → $TDAY" "$(echo "$C" | jq '.created >= 5'):$(api GET "/roster/rosters/$R3" "$PL" | jq -r --arg s "$SJ" --arg d "$TDAY" '[.entries[]|select(.staff_id==$s and .day==$d)|.code]|join(",")')" "true:N"
chk "  … ისტორიაში — copy" "$(api GET "/roster/rosters/$R3/changes" "$PL" | jq -r '[.[]|select(.kind=="copy")]|length')" "1"
R4=$(api POST /roster/rosters "$ALL" -d "{\"department_id\":\"$D2\",\"month\":\"$NX\"}" | jq -r '.id // empty')
ROT="{\"pattern_id\":\"$PDNOO\",\"staff\":[{\"staff_id\":\"$SC\",\"offset\":0}],\"from\":\"$(dn 1)\",\"to\":\"$(dn 8)\""
R=$(api POST "/roster/rosters/$R4/rotation" "$ALL" -d "$ROT}")
chk "როტაცია D-N-·-· (8 დღე) → 4 ცვლა: 1 D, 2 N, 5 D, 6 N" "$(echo "$R" | jq .created):$(api GET "/roster/rosters/$R4" "$ALL" | jq -r --arg s "$SC" '[.entries[]|select(.staff_id==$s)|"\(.day[8:10])\(.code)"]|join(",")')" "4:01D,02N,05D,06N"
chk "განმეორებით — 0 (4 გამოტოვდა); ჩანაცვლებით — 4" "$(api POST "/roster/rosters/$R4/rotation" "$ALL" -d "$ROT}" | jq -r '"\(.created):\(.skipped|length)"'):$(api POST "/roster/rosters/$R4/rotation" "$ALL" -d "$ROT,\"overwrite\":true}" | jq .created)" "0:4:4"
chk "როტაცია სხვის განყოფილებაზე (შემდგენი D1 → D2) — 403" "$(code POST "/roster/rosters/$R4/rotation" "$PL" -d "$ROT}")" "403"
mod '{"rest_mode":"block"}'
add "$R4" "$ALL" "[$(item "$SC" "$(dn 10)" "$TD")]" >/dev/null
chk "rest_mode = block: დასვენება 10 სთ — 409" "$(code POST "/roster/rosters/$R4/entries" "$ALL" -d "{\"items\":[$(item "$SC" "$(dn 11)" "$TW" ',"start_time":"06:00","end_time":"14:00"')]}")" "409"
mod '{"rest_mode":"warn"}'
chk "გასუფთავება (მონახაზი) — 5 წაიშალა" "$(api POST "/roster/rosters/$R4/clear" "$ALL" -d '{}' | jq .deleted)" "5"

step "9. მოდულის გამორთვა"
api PUT /modules/roster "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულია → ცნობარი / მორიგეები 403 (MODULE_DISABLED)" "$(api GET /roster/refs "$PL" | jq -r .code):$(code GET /roster/on-duty "$N0")" "MODULE_DISABLED:403"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "ჩართვა → ისევ მუშაობს" "$(code GET /roster/refs "$PL")" "200"

step "გასუფთავება"
for X in $SN $SJ $SD $SL $SC; do api PATCH "/roster/staff/$X" "$ALL" -d '{"is_active":false}' >/dev/null; done
api PATCH "/roster/norms/$NR" "$PL" -d '{"is_active":false}' >/dev/null
api PATCH "/roster/templates/$TQID" "$ALL" -d '{"is_active":false}' >/dev/null
for X in $DR1 $DR2; do api PATCH "/roster/duty-roles/$X" "$ALL" -d '{"is_active":false}' >/dev/null; done
for X in $PN $PD $PJ; do api PATCH "/roster/positions/$X" "$ALL" -d '{"is_active":false}' >/dev/null; done
api DELETE "/roster/holidays/$HD" "$ALL" >/dev/null
chk "სატესტო თანამშრომლები გათიშულია" "$(api GET "/roster/staff?search=$(jq -rn --arg s "ტესტ-E2E" '$s|@uri')" "$ALL" | jq length)" "0"
api PUT /modules/roster "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "ცნობარების სატესტო ჩანაწერები, მომხმარებლები, როლები, განყოფილებები გათიშულია (განრიგები / ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
