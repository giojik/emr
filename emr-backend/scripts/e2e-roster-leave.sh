#!/usr/bin/env bash
# =====================================================================
# e2e-roster-leave.sh — ცვლები / მორიგეობა, ეტაპი 2 (0078): შვებულება / არყოფნა, დასაფარი, გაცვლა / გადაცემა, ჩანაცვლება, „არ შემიძლია“
#   უფლება absence_approve (45), პარამეტრები (ვალიდაცია), არყოფნის ტიპები (seed 8, HR), ბალანსი (წლიური / თვიური დარიცხვა, კორექცია, ინდივიდუალური ნორმა,
#   გადაჭარბება block / HR მიზეზით), მოთხოვნა → ხელმძღვანელი → HR (საკუთარის დადასტურება — არა; ერთადერთი ხელმძღვანელი — გამოტოვება; მაგივრად რეგისტრაცია),
#   დოკუმენტი (HR ნაბიჯი), უარი, გადაფარვა, გაუქმება (განხილვაში / თხოვნით / ხელმძღვანელი), ადრე დასრულება (HR, ბალანსის აღდგენა),
#   განრიგი: განხილვაში — გაფრთხილება, დადასტურებული — 409 ROSTER_ABSENCE; მონახაზში — ცვლები იშლება, გამოქვეყნებულში — უქმდება → დასაფარი (ვერსია, ისტორია),
#   ბადე (არყოფნა — ტიპი მხოლოდ შემდგენს / ხელმძღვანელს, D4), დასაფარი: „ავიღებ“ (განყოფილება / კატეგორია), შევსება (fill), გაუქმება, მოხსნა → დასაფარი, ხელით,
#   ჩანაცვლება (replace), გაცვლა / გადაცემა: კოლეგა → ხელმძღვანელი (swap_approval), წესები (არყოფნა — SWAP_RULE), კატეგორია, ანგარიშის გარეშე, დაკავებული,
#   უარი, swap_approval = none, „არ შემიძლია“ / „მირჩევნია“ (ლიმიტი, შემდგენი, ვადა, გამოქვეყნებული — დაბლოკილი, ბადეში გაფრთხილება), „დასადასტურებელი“,
#   შეტყობინებები, აუდიტი, მოდულის გამორთვა.
# ბოლოს: თანამშრომლები / ტიპი / მომხმარებლები / განყოფილებები გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-roster-leave.sh [API_URL]
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
# სატესტო თვე: +2 (M); P — მიმდინარე +1 (სურვილების ვადა); NX — M+1 (სურვილები / ბალანსის გადაჭარბება)
M=$(TZ=Asia/Tbilisi date -d "$(TZ=Asia/Tbilisi date +%Y-%m-01) +2 month" +%Y-%m); NX=$(date -d "$M-01 +1 month" +%Y-%m)
P=$(TZ=Asia/Tbilisi date -d "$(TZ=Asia/Tbilisi date +%Y-%m-01) +1 month" +%Y-%m)
Y=${M:0:4}; CY=$(TZ=Asia/Tbilisi date +%Y); CM=$(TZ=Asia/Tbilisi date +%-m); TDD=$(TZ=Asia/Tbilisi date +%-d)
d()  { printf '%s-%02d' "$M" "$1"; }
dn() { printf '%s-%02d' "$NX" "$1"; }
dm() { echo "$1" | awk -F- '{print $3"."$2}'; }   # YYYY-MM-DD → DD.MM
add() { api POST "/roster/rosters/$1/entries" "$2" -d "{\"items\":$3${4:-}}"; }
item() { echo "{\"staff_id\":\"$1\",\"day\":\"$2\",\"shift_template_id\":\"$3\"${4:-}}"; }
absreq() { api POST /roster/absences "$1" -d "$2"; }   # <token> <json>

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0078" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0078" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E შვებ. თერაპია $S\",\"code\":\"E2ELA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E შვებ. ქირურგია $S\",\"code\":\"E2ELB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.lv.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"შვებ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"phone\":\"5991$2$S4\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.lv.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_PL=$(mkrole lpl "განრიგი (განყ.)" '["roster"]'); R_AP=$(mkrole lap "არყოფნის დადასტ." '["absence_approve"]'); R_HR=$(mkrole lhr "HR" '["hr"]'); R_VW=$(mkrole lvw "განრიგის ნახვა" '["roster_view"]')
[ -n "$R_PL" ] && [ -n "$R_AP" ] && [ -n "$R_HR" ] && [ -n "$R_VW" ] || die "როლები ვერ შეიქმნა (absence_approve უფლება?)"
read -r _ PL <<< "$(mkuser "[\"$R_PL\"]" 61 ",\"department_id\":\"$D1\"")"
read -r HDID HD <<< "$(mkuser "[\"$R_AP\",\"doctor\"]" 62 ",\"department_id\":\"$D1\"")"
read -r _ HR <<< "$(mkuser "[\"$R_HR\"]" 63)"
read -r U1 N1 <<< "$(mkuser '["nurse"]' 64 ",\"department_id\":\"$D1\"")"
read -r U2 N2 <<< "$(mkuser '["nurse"]' 65 ",\"department_id\":\"$D1\"")"
read -r U3 N3 <<< "$(mkuser '["nurse"]' 66 ",\"department_id\":\"$D2\"")"
read -r UD DOC <<< "$(mkuser '["doctor"]' 67 ",\"department_id\":\"$D1\"")"
read -r UH2 H2 <<< "$(mkuser "[\"$R_AP\",\"nurse\"]" 68 ",\"department_id\":\"$D2\"")"
read -r _ VW <<< "$(mkuser "[\"$R_VW\"]" 69)"
[ -n "$PL" ] && [ -n "$HD" ] && [ -n "$HR" ] && [ -n "$N1" ] && [ -n "$N2" ] && [ -n "$N3" ] && [ -n "$DOC" ] && [ -n "$H2" ] && [ -n "$VW" ] \
  && ok "9 მომხმარებელი (შემდგენი D1, ხელმძღვანელი D1, HR, ექთნები D1 ×2 / D2, ექიმი D1, ხელმძღვანელი-ექთანი D2, ნახვა)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული roster ვერ მოიძებნა"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
mod '{"rest_min_hours":12,"rest_mode":"warn","max_continuous_hours":24,"continuous_mode":"block","max_week_hours":48,"week_mode":"warn","max_consecutive_nights":3,"nights_mode":"warn","norm_mode":"off","cross_department":"warn","publish_notify":true,"change_notify":true,"duty_phone":"all","copy_mode":"weekday","absence_unit_mode":"weekdays","accrual":"annual","balance_overdraw":"block","swap_approval":"head","swap_min_notice_hours":12,"open_shift_volunteer":true,"open_shift_notify":true,"prefs_mode":"warn","prefs_deadline_day":0,"unavailable_max_per_month":4}'
# სამუშაო დღეები (ორშ.–პარ., დღესასწაულების გარეშე)
HOL=$(api GET /roster/holidays "$ADM" | jq -r '.[].day|.[0:10]')
isw() { [ "$(date -d "$1" +%u)" -le 5 ] && ! grep -qx "$1" <<< "$HOL"; }
wd() { local x=$1 n=0; while [[ ! "$x" > "$2" ]]; do isw "$x" && n=$((n+1)); x=$(date -d "$x +1 day" +%F); done; echo $n; }
W=(); x="$M-01"; while [ "${x:0:7}" = "$M" ]; do isw "$x" && W+=("$x"); x=$(date -d "$x +1 day" +%F); done   # W[k] — k-ე სამუშაო დღე (0-დან)
[ ${#W[@]} -ge 17 ] || die "თვეში სამუშაო დღე < 17"

step "1. უფლება, პარამეტრები, არყოფნის ტიპები"
CAPS=$(api GET /roles/capabilities "$ADM")
chk "უფლება absence_approve; სულ 47 (0081: + worklist_manage, worklist_all)" "$(echo "$CAPS" | jq -r '[.[]|select(.code=="absence_approve")]|length'):$(echo "$CAPS" | jq length)" "1:47"
chk "პარამეტრები: swap_approval = x / prefs_deadline_day = 40 / უცნობი accrual — 400" "$(code PUT /modules/roster "$ADM" -d '{"settings":{"swap_approval":"x"},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"prefs_deadline_day":40},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"accrual":"weekly"},"reason":"ტესტ"}')" "400:400:400"
TY=$(api GET /roster/absence-types "$N1")
chk "8 seed ტიპი; ANNUAL — 24 სამუშაო დღე, ხელმძღვანელი → HR; SICK — HR, დოკუმენტით" "$(echo "$TY" | jq '[.[]|select(.code|test("^(ANNUAL|UNPAID|SICK|MATERNITY|STUDY|TRIP|COMP|OTHER)$"))]|length'):$(echo "$TY" | jq -r '.[]|select(.code=="ANNUAL")|"\(.default_days|tonumber|floor):\(.unit):\(.route)"'):$(echo "$TY" | jq -r '.[]|select(.code=="SICK")|"\(.route):\(.requires_document)"')" "8:24:workday:head_hr:hr:true"
TA=$(echo "$TY" | jq -r '.[]|select(.code=="ANNUAL").id'); TS=$(echo "$TY" | jq -r '.[]|select(.code=="SICK").id'); TT=$(echo "$TY" | jq -r '.[]|select(.code=="TRIP").id')
chk "ახალი ტიპი: შემდგენი — 403; HR — 201; კოდის შეცვლა — 400" "$(code POST /roster/absence-types "$PL" -d "{\"code\":\"E2E_X$S4\",\"name\":\"x x\",\"short\":\"x\"}"):$(code POST /roster/absence-types "$HR" -d "{\"code\":\"E2E_X$S4\",\"name\":\"ტესტ-E2E ტიპი\",\"short\":\"ტ\",\"route\":\"none\",\"unit\":\"calendar\"}")" "403:201"
TX=$(api GET /roster/absence-types "$HR" | jq -r --arg c "E2E_X$S4" '.[]|select(.code==$c).id')
chk "  … კოდის შეცვლა — 400; ბალანსის გარეშე ნორმა — 400" "$(code PATCH "/roster/absence-types/$TX" "$HR" -d '{"code":"ZZ"}'):$(code PATCH "/roster/absence-types/$TX" "$HR" -d '{"default_days":5}')" "400:400"

step "2. თანამშრომლები, განრიგი (მონახაზი)"
REFS=$(api GET /roster/refs "$ADM")
TD=$(echo "$REFS" | jq -r '.templates[]|select(.code=="D").id'); TN=$(echo "$REFS" | jq -r '.templates[]|select(.code=="N").id')
PN=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_LN_$S\",\"name\":\"ტესტ-E2E ექთანი\",\"category\":\"nurse\"}" | jq -r '.id // empty')
PD=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_LD_$S\",\"name\":\"ტესტ-E2E ექიმი\",\"category\":\"doctor\"}" | jq -r '.id // empty')
PJ=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_LJ_$S\",\"name\":\"ტესტ-E2E სანიტარი\",\"category\":\"junior\"}" | jq -r '.id // empty')
FU=$(api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$U1\",\"$U2\",\"$U3\",\"$UH2\"],\"position_id\":\"$PN\"}")
FD=$(api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$UD\"],\"position_id\":\"$PD\"}")
sid() { api GET "/roster/staff?search=$(jq -rn --arg s "შვებ-$1" '$s|@uri')" "$ADM" | jq -r '.[0].id // empty'; }
S1=$(sid 64); S2=$(sid 65); S3=$(sid 66); SDOC=$(sid 67); SH2=$(sid 68)
SJ=$(api POST /roster/staff "$ADM" -d "{\"first_name\":\"სანიტარი\",\"last_name\":\"ტესტ-E2E-შვ\",\"department_id\":\"$D1\",\"position_id\":\"$PJ\"}" | jq -r '.id // empty')
[ -n "$S1" ] && [ -n "$S2" ] && [ -n "$S3" ] && [ -n "$SDOC" ] && [ -n "$SH2" ] && [ -n "$SJ" ] && ok "6 თანამშრომელი (ექთნები D1 ×2, D2 ×2, ექიმი D1, სანიტარი ანგარიშის გარეშე)" || die "თანამშრომლები ვერ შეიქმნა ($(echo "$FU$FD" | head -c 300))"
R1=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$M\"}" | jq -r '.id // empty')
[ -n "$R1" ] || die "განრიგი ვერ შეიქმნა"
R=$(add "$R1" "$PL" "[$(item "$S1" "${W[3]}" "$TD"),$(item "$S1" "${W[4]}" "$TD"),$(item "$S1" "${W[5]}" "$TN"),$(item "$S1" "$(d 1)" "$TD"),$(item "$S1" "$(d 20)" "$TD"),$(item "$S1" "$(d 28)" "$TD"),$(item "$S2" "${W[10]}" "$TD"),$(item "$S2" "${W[11]}" "$TD"),$(item "$S2" "$(d 21)" "$TD"),$(item "$S2" "$(d 8)" "$TN"),$(item "$SJ" "$(d 6)" "$TD")]" ',"mode":"skip"')
chk "მონახაზი: 11 ჩანაწერი" "$(echo "$R" | jq '.created|length'):$(echo "$R" | jq '.skipped|length')" "11:0"

step "3. ბალანსი"
B1=$(api GET "/roster/balances?year=$Y" "$N1")
chk "ჩემი ბალანსი (ANNUAL, $Y): დარიცხული 24, ხელმისაწვდომი 24; COMP — 0 (ნორმა ხელით)" "$(echo "$B1" | jq -r '.items[]|select(.type.code=="ANNUAL")|"\(.accrued):\(.available)"'):$(echo "$B1" | jq -r '.items[]|select(.type.code=="COMP")|.available')" "24:24:0"
chk "კორექცია: შემდგენი / ხელმძღვანელი — 403; HR — გადატანა +3 → 27" "$(code POST /roster/balances/entries "$PL" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TA\",\"year\":$Y,\"kind\":\"carry\",\"days\":3,\"reason\":\"ტესტ\"}"):$(code POST /roster/balances/entries "$HD" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TA\",\"year\":$Y,\"kind\":\"carry\",\"days\":3,\"reason\":\"ტესტ\"}"):$(api POST /roster/balances/entries "$HR" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TA\",\"year\":$Y,\"kind\":\"carry\",\"days\":3,\"reason\":\"ტესტ-E2E: წინა წლიდან\"}" | jq '.balance.available')" "403:403:27"
chk "კორექცია მიზეზის გარეშე — 400; ბალანსის გარეშე ტიპზე — 400" "$(code POST /roster/balances/entries "$HR" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TA\",\"year\":$Y,\"kind\":\"adjust\",\"days\":1,\"reason\":\"\"}"):$(code POST /roster/balances/entries "$HR" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TS\",\"year\":$Y,\"kind\":\"adjust\",\"days\":1,\"reason\":\"ტესტ ტესტ\"}")" "400:400"
chk "ინდივიდუალური ნორმა (ექთანი 2): HR — 30 → ბალანსი 30; შემდგენი — 403" "$(api PUT /roster/balances/entitlement "$HR" -d "{\"staff_id\":\"$S2\",\"absence_type_id\":\"$TA\",\"days_per_year\":30}" | jq -r .ok):$(api GET "/roster/balances?staff_id=$S2&year=$Y" "$HR" | jq -r '.items[]|select(.type.code=="ANNUAL")|"\(.entitlement):\(.available)"'):$(code PUT /roster/balances/entitlement "$PL" -d "{\"staff_id\":\"$S2\",\"absence_type_id\":\"$TA\",\"days_per_year\":30}")" "true:30:30:403"
mod '{"accrual":"monthly"}'
EXPM=$((CM * 2))
chk "თვიური დარიცხვა (ექთანი D2, $CY): $CM თვე × 2 = $EXPM" "$(api GET "/roster/balances?staff_id=$S3&year=$CY" "$HR" | jq -r '.items[]|select(.type.code=="ANNUAL")|.accrued')" "$EXPM"
mod '{"accrual":"annual"}'
chk "სხვისი ბალანსი: ექთანი — 403; შემდგენი (D1) — 200; განყოფილების ცხრილი — შემდგენი 200, D2-ის ექთანი 403" "$(code GET "/roster/balances?staff_id=$S2" "$N1"):$(code GET "/roster/balances?staff_id=$S2" "$PL"):$(code GET "/roster/balances?department_id=$D1&year=$Y" "$PL"):$(code GET "/roster/balances?department_id=$D1" "$N3")" "403:200:200:403"

step "4. მოთხოვნა → ხელმძღვანელი → HR (მონახაზი)"
EXP=$(wd "${W[3]}" "${W[5]}")
R=$(absreq "$N1" "{\"absence_type_id\":\"$TA\",\"date_from\":\"${W[3]}\",\"date_to\":\"${W[5]}\",\"note\":\"ტესტ-E2E: შვებულება\"}")
A1=$(echo "$R" | jq -r '.id // empty')
chk "ექთანი 1: ANNUAL ${W[3]} … ${W[5]} — ხელმძღვანელთან, $EXP სამუშაო დღე" "$(echo "$R" | jq -r '"\(.status):\(.days)"')" "head:$EXP"
chk "იგივე პერიოდი ხელახლა — 409 (გადაფარვა)" "$(code POST /roster/absences "$N1" -d "{\"absence_type_id\":\"$TA\",\"date_from\":\"${W[4]}\",\"date_to\":\"${W[4]}\"}")" "409"
chk "მხოლოდ შაბათ-კვირა (სამუშაო დღე არ არის) — 400 ABSENCE_NO_DAYS" "$(x="$M-01"; while isw "$x"; do x=$(date -d "$x +1 day" +%F); done; api POST /roster/absences "$N2" -d "{\"absence_type_id\":\"$TA\",\"date_from\":\"$x\",\"date_to\":\"$x\"}" | jq -r .code)" "ABSENCE_NO_DAYS"
chk "შეტყობინება ხელმძღვანელს და შემდგენს (absence_requested); HR-ს — ჯერ არა" "$(api GET /notifications "$HD" | jq --arg a "$A1" '[.[]|select(.kind=="absence_requested")]|length'):$(api GET /notifications "$PL" | jq '[.[]|select(.kind=="absence_requested")]|length'):$(api GET /notifications "$HR" | jq '[.[]|select(.kind=="absence_requested")]|length')" "1:1:0"
R=$(add "$R1" "$PL" "[$(item "$S1" "${W[4]}" "$TN" ',"start_time":"21:00","end_time":"23:00"')]")
has "განხილვაში მყოფ პერიოდში ცვლა — დაემატა გაფრთხილებით" "$(echo "$R" | jq -r '(.created|length|tostring) + ":" + (.created[0].warnings|join(" | "))')" "განხილვაშია"
chk "დადასტურება: თავად — 403; კოლეგა ექთანი — 403; HR (ხელმძღვანელის ნაბიჯი, მთელი კლინიკა) — შეუძლია, მაგრამ ჯერ ხელმძღვანელი" "$(code POST "/roster/absences/$A1/approve" "$N1" -d '{}'):$(code POST "/roster/absences/$A1/approve" "$N2" -d '{}')" "403:403"
INB=$(api GET /roster/inbox "$HD")
chk "„დასადასტურებელი“ (ხელმძღვანელი): არყოფნა 1, can_act" "$(echo "$INB" | jq -r --arg a "$A1" '"\(.counts.absences):\([.absences[]|select(.id==$a)|.can_act]|first)"')" "1:true"
chk "ხელმძღვანელი ადასტურებს → HR-თან; HR-ს — შეტყობინება" "$(api POST "/roster/absences/$A1/approve" "$HD" -d '{"note":"ტესტ-E2E: თანახმა"}' | jq -r .status):$(api GET /notifications "$HR" | jq --arg a "$A1" '[.[]|select(.kind=="absence_requested")]|length')" "hr:1"
chk "ხელმძღვანელი ხელახლა (HR ნაბიჯი) — 403" "$(code POST "/roster/absences/$A1/approve" "$HD" -d '{}')" "403"
DET=$(api GET "/roster/absences/$A1" "$HR")
chk "დეტალი: გავლენა — 4 ცვლა (მონახაზი); ბალანსი ხელმისაწვდომი 27" "$(echo "$DET" | jq '.impact|length'):$(echo "$DET" | jq -r '.impact[0].roster_status'):$(echo "$DET" | jq .balance.available)" "4:draft:27"
chk "HR ადასტურებს → დადასტურებული; მონახაზიდან 4 ცვლა წაიშალა" "$(api POST "/roster/absences/$A1/approve" "$HR" -d '{}' | jq -r .status):$(api GET "/roster/absences/$A1" "$HR" | jq '.roster_applied.deleted|length'):$(api GET "/roster/rosters/$R1" "$PL" | jq --arg s "$S1" --arg a "${W[3]}" --arg b "${W[5]}" '[.entries[]|select(.staff_id==$s and .day>=$a and .day<=$b)]|length')" "approved:4:0"
chk "ბალანსი: 27 − $EXP = $((27 - EXP)); შეტყობინება ექთანს (absence_decided)" "$(api GET "/roster/balances?year=$Y" "$N1" | jq -r '.items[]|select(.type.code=="ANNUAL")|.available'):$(api GET /notifications "$N1" | jq '[.[]|select(.kind=="absence_decided")]|length')" "$((27 - EXP)):1"
R=$(add "$R1" "$PL" "[$(item "$S1" "${W[4]}" "$TD")]")
chk "დადასტურებულ არყოფნაზე ცვლა — 409 ROSTER_ABSENCE" "$(echo "$R" | jq -r .code)" "ROSTER_ABSENCE"

step "5. მარშრუტები: HR (დოკუმენტი), მაგივრად, ერთადერთი ხელმძღვანელი, უარი, გადაჭარბება"
A2=$(absreq "$N2" "{\"absence_type_id\":\"$TS\",\"date_from\":\"$(d 1)\",\"date_to\":\"$(d 2)\"}" | jq -r '.id // empty')
chk "ექთანი 2: SICK (კალენდარული, 2 დღე) — პირდაპირ HR-თან" "$(api GET "/roster/absences/$A2" "$N2" | jq -r '"\(.status):\(.days|tonumber|floor)"')" "hr:2"
chk "ხელმძღვანელი SICK-ზე — 403; HR დოკუმენტის გარეშე — 409 ABSENCE_DOCUMENT" "$(code POST "/roster/absences/$A2/approve" "$HD" -d '{}'):$(api POST "/roster/absences/$A2/approve" "$HR" -d '{}' | jq -r .code)" "403:ABSENCE_DOCUMENT"
chk "ექთანი უთითებს ბიულეტენის №; HR ადასტურებს" "$(api PATCH "/roster/absences/$A2" "$N2" -d '{"document_no":"ტესტ-E2E-123"}' | jq -r .ok):$(api POST "/roster/absences/$A2/approve" "$HR" -d '{}' | jq -r .status)" "true:approved"
R=$(absreq "$HD" "{\"staff_id\":\"$SDOC\",\"absence_type_id\":\"$TT\",\"date_from\":\"${W[2]}\",\"date_to\":\"${W[2]}\",\"note\":\"ტესტ-E2E: კონფერენცია\"}")
chk "ხელმძღვანელი არეგისტრირებს ექიმის მივლინებას (მარშრუტი — ხელმძღვანელი) → მაშინვე დადასტურებული" "$(echo "$R" | jq -r .status):$(api GET "/roster/absences/$(echo "$R" | jq -r .id)" "$HD" | jq -r .on_behalf)" "approved:true"
chk "ექთანი სხვის მაგივრად — 403; D2-ის ხელმძღვანელი D1-ის თანამშრომლისთვის — 403" "$(code POST /roster/absences "$N2" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TT\",\"date_from\":\"${W[8]}\",\"date_to\":\"${W[8]}\"}"):$(code POST /roster/absences "$H2" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TT\",\"date_from\":\"${W[8]}\",\"date_to\":\"${W[8]}\"}")" "403:403"
R=$(absreq "$HR" "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TS\",\"date_from\":\"$(d 27)\",\"date_to\":\"$(d 27)\",\"document_no\":\"ტესტ-E2E-9\"}")
chk "HR არეგისტრირებს ბიულეტენს დოკუმენტით → დადასტურებული" "$(echo "$R" | jq -r .status)" "approved"
R=$(absreq "$H2" "{\"absence_type_id\":\"$TA\",\"date_from\":\"${W[6]}\",\"date_to\":\"${W[6]}\"}")
A3=$(echo "$R" | jq -r '.id // empty')
chk "D2-ის ერთადერთი ხელმძღვანელი — საკუთარი მოთხოვნა: ხელმძღვანელის ნაბიჯი გამოტოვდა → HR" "$(echo "$R" | jq -r .status):$(api GET "/roster/absences/$A3" "$H2" | jq -r .head_skipped)" "hr:true"
A4=$(absreq "$N2" "{\"absence_type_id\":\"$TA\",\"date_from\":\"${W[15]}\",\"date_to\":\"${W[15]}\"}" | jq -r '.id // empty')
chk "უარი: მიზეზის გარეშე — 400; მიზეზით — უარყოფილი; ექთანს — შეტყობინება" "$(code POST "/roster/absences/$A4/reject" "$HD" -d '{}'):$(api POST "/roster/absences/$A4/reject" "$HD" -d '{"reason":"ტესტ-E2E: დატვირთული პერიოდი"}' | jq -r .ok):$(api GET "/roster/absences/$A4" "$N2" | jq -r .status):$(api GET /notifications "$N2" | jq --arg a "$A4" '[.[]|select(.kind=="absence_decided")]|length >= 1')" "400:true:rejected:true"
OD="{\"absence_type_id\":\"$TA\",\"date_from\":\"$(dn 1)\",\"date_to\":\"$(date -d "$(dn 1) +60 day" +%F)\"}"
chk "ნაშთის გადაჭარბება (≈ 40 დღე > 30): ექთანი — 409 ABSENCE_BALANCE" "$(api POST /roster/absences "$N2" -d "$OD" | jq -r .code)" "ABSENCE_BALANCE"
R=$(absreq "$HR" "$(echo "$OD" | jq -c --arg s "$S2" '. + {staff_id:$s, overdraw_reason:"ტესტ-E2E: ხელშეკრულებით"}')")
A5=$(echo "$R" | jq -r '.id // empty')
chk "HR მიზეზით — დადასტურებული, გაფრთხილებით; გაუქმება → ბალანსი 30" "$(echo "$R" | jq -r '"\(.status):\(.warnings|length)"'):$(api POST "/roster/absences/$A5/cancel" "$HR" -d '{"reason":"ტესტ-E2E: გაუქმება"}' | jq -r .status):$(api GET "/roster/balances?staff_id=$S2&year=${NX:0:4}" "$HR" | jq -r '.items[]|select(.type.code=="ANNUAL")|.available')" "approved:1:cancelled:30"

step "6. გამოქვეყნებულ განრიგზე: დასაფარი (D1, E)"
chk "გამოქვეყნება" "$(api POST "/roster/rosters/$R1/publish" "$PL" -d '{"confirm_warnings":true}' | jq -r .ok)" "true"
V0=$(api GET "/roster/rosters/$R1" "$PL" | jq .version)
A6=$(absreq "$N2" "{\"absence_type_id\":\"$TA\",\"date_from\":\"${W[10]}\",\"date_to\":\"${W[11]}\"}" | jq -r '.id // empty')
api POST "/roster/absences/$A6/approve" "$HD" -d '{}' >/dev/null
chk "ექთანი 2: ANNUAL ${W[10]} … ${W[11]} — დადასტურებული; 2 ცვლა გაუქმდა" "$(api POST "/roster/absences/$A6/approve" "$HR" -d '{}' | jq -r .status):$(api GET "/roster/absences/$A6" "$HR" | jq '.roster_applied.cancelled|length')" "approved:2"
G=$(api GET "/roster/rosters/$R1" "$PL")
chk "ბადე: ვერსია +1; დასაფარი 2 (წყარო — არყოფნა); ისტორიაში absence × 2" "$(( $(echo "$G" | jq .version) - V0 )):$(echo "$G" | jq '[.open_shifts[]|select(.source=="absence")]|length'):$(api GET "/roster/rosters/$R1/changes" "$PL" | jq '[.[]|select(.kind=="absence")]|length')" "1:2:2"
chk "ბადე (შემდგენი): არყოფნა ტიპით — „შ“; ნახვის უფლებით — „—“ / „არყოფნა“ (D4)" "$(echo "$G" | jq -r --arg s "$S2" '[.absences[]|select(.staff_id==$s and .status=="approved")|.short]|unique|join(",")'):$(echo "$G" | jq -r .absence_detail):$(api GET "/roster/rosters/$R1" "$VW" | jq -r --arg s "$S2" '([.absences[]|select(.staff_id==$s)|"\(.short)/\(.name)"]|unique|join(",")) + ":" + (.absence_detail|tostring)')" "ბ,შ:true:—/არყოფნა:false"
OS1=$(echo "$G" | jq -r --arg d "${W[10]}" '.open_shifts[]|select(.day==$d).id'); OS2=$(echo "$G" | jq -r --arg d "${W[11]}" '.open_shifts[]|select(.day==$d).id')
chk "შეტყობინება „დასაფარი“: ექთანი 1 (იგივე განყ. / კატეგორია) — 2; ექიმი / D2-ის ექთანი — 0" "$(api GET /notifications "$N1" | jq -r '[.[]|select(.kind=="open_shift_new")|.items|length]|add // 0'):$(api GET /notifications "$DOC" | jq '[.[]|select(.kind=="open_shift_new")]|length'):$(api GET /notifications "$N3" | jq '[.[]|select(.kind=="open_shift_new")]|length')" "2:0:0"
MY=$(api GET "/roster/open-shifts?mine=1" "$N1")
chk "ექთანი 1: ჩემთვის ხელმისაწვდომი დასაფარი — 2" "$(echo "$MY" | jq --arg a "$OS1" --arg b "$OS2" '[.items[]|select(.id==$a or .id==$b)]|length')" "2"
chk "„ავიღებ“: ექთანი 1 — OK; ექიმი — 403 (კატეგორია); D2-ის ექთანი — 403 (განყოფილება)" "$(api POST "/roster/open-shifts/$OS1/offer" "$N1" -d '{"note":"ტესტ-E2E"}' | jq -r .ok):$(code POST "/roster/open-shifts/$OS1/offer" "$DOC" -d '{}'):$(code POST "/roster/open-shifts/$OS1/offer" "$N3" -d '{}')" "true:403:403"
chk "შემდგენს — შეტყობინება open_shift_offer; „დასადასტურებელში“ — 1 დასაფარი მოხალისით" "$(api GET /notifications "$PL" | jq '[.[]|select(.kind=="open_shift_offer")]|length'):$(api GET /roster/inbox "$PL" | jq -r --arg o "$OS1" '[.offers[]|select(.id==$o)|.offers|length]|first')" "1:1"
chk "შევსება: ექთანი 2 (არყოფნაშია) — 409 ROSTER_ABSENCE; ექთანი 1 — OK" "$(api POST "/roster/open-shifts/$OS1/assign" "$PL" -d "{\"staff_id\":\"$S2\"}" | jq -r .code):$(api POST "/roster/open-shifts/$OS1/assign" "$PL" -d "{\"staff_id\":\"$S1\"}" | jq -r '.entry_id != null')" "ROSTER_ABSENCE:true"
G=$(api GET "/roster/rosters/$R1" "$PL")
chk "  … ბადეში ექთანი 1 — ${W[10]} D; დასაფარი 1 დარჩა; ისტორია fill; ხელახლა შევსება — 409" "$(echo "$G" | jq -r --arg s "$S1" --arg d "${W[10]}" '[.entries[]|select(.staff_id==$s and .day==$d)|.code]|join(",")'):$(echo "$G" | jq '.open_shifts|length'):$(api GET "/roster/rosters/$R1/changes" "$PL" | jq '[.[]|select(.kind=="fill")]|length'):$(code POST "/roster/open-shifts/$OS1/assign" "$PL" -d "{\"staff_id\":\"$S1\"}")" "D:1:1:409"
chk "დასაფარის გაუქმება: ექთანი — 403; შემდგენი მიზეზით — OK" "$(code POST "/roster/open-shifts/$OS2/cancel" "$N1" -d '{"reason":"ტესტ ტესტ"}'):$(api POST "/roster/open-shifts/$OS2/cancel" "$PL" -d '{"reason":"ტესტ-E2E: საჭირო აღარ არის"}' | jq -r .ok)" "403:true"
EJ=$(echo "$G" | jq -r --arg s "$SJ" '.entries[]|select(.staff_id==$s)|.id')
R=$(api POST "/roster/entries/$EJ/remove" "$PL" -d '{"reason":"ტესტ-E2E: სანიტარი ავადაა","open_shift":true}')
chk "მოხსნა → დასაფარი (წყარო — cancel, კატეგორია junior)" "$(echo "$R" | jq -r '.open_shift_id != null'):$(api GET "/roster/rosters/$R1" "$PL" | jq -r '[.open_shifts[]|select(.source=="cancel")|.category]|join(",")')" "true:junior"
chk "ხელით დასაფარი: გამოქვეყნებულში — 201; ექთანი — 403" "$(code POST "/roster/rosters/$R1/open-shifts" "$PL" -d "{\"day\":\"$(d 25)\",\"shift_template_id\":\"$TN\",\"category\":\"nurse\",\"note\":\"ტესტ-E2E\"}"):$(code POST "/roster/rosters/$R1/open-shifts" "$N1" -d "{\"day\":\"$(d 25)\",\"shift_template_id\":\"$TN\"}")" "201:403"

step "7. ჩანაცვლება (G)"
E8=$(api GET "/roster/rosters/$R1" "$PL" | jq -r --arg s "$S2" --arg d "$(d 8)" '.entries[]|select(.staff_id==$s and .day==$d)|.id')
chk "მიზეზის გარეშე — 400; ექთანი — 403" "$(code POST "/roster/entries/$E8/replace" "$PL" -d "{\"staff_id\":\"$S3\"}"):$(code POST "/roster/entries/$E8/replace" "$N1" -d "{\"staff_id\":\"$S3\",\"reason\":\"ტესტ ტესტ\"}")" "400:403"
R=$(api POST "/roster/entries/$E8/replace" "$PL" -d "{\"staff_id\":\"$S3\",\"reason\":\"ტესტ-E2E: ჩანაცვლება\"}")
has "ექთანი 2 → D2-ის ექთანი: OK, გაფრთხილებით (სხვა განყოფილება)" "$(echo "$R" | jq -r '(.ok|tostring) + ":" + (.warnings|join(" | "))')" "სხვა განყოფილების"
chk "  … ისტორია replace; ექთან 2-ს — „− $(dm "$(d 8)") N“" "$(api GET "/roster/rosters/$R1/changes" "$PL" | jq '[.[]|select(.kind=="replace")]|length'):$(api GET /notifications "$N2" | jq -r --arg x "− $(dm "$(d 8)") N" '[.[]|select(.kind=="roster_changed")|.items[]|select(.==$x)]|length')" "1:1"

step "8. გაცვლა / გადაცემა (F)"
G=$(api GET "/roster/rosters/$R1" "$PL")
EA=$(echo "$G" | jq -r --arg s "$S1" --arg d "$(d 20)" '.entries[]|select(.staff_id==$s and .day==$d)|.id'); EB=$(echo "$G" | jq -r --arg s "$S2" --arg d "$(d 21)" '.entries[]|select(.staff_id==$s and .day==$d)|.id')
E1=$(echo "$G" | jq -r --arg s "$S1" --arg d "$(d 1)" '.entries[]|select(.staff_id==$s and .day==$d)|.id'); E28=$(echo "$G" | jq -r --arg s "$S1" --arg d "$(d 28)" '.entries[]|select(.staff_id==$s and .day==$d)|.id')
OPT=$(api GET "/roster/swaps/options?entry_id=$EA" "$N1")
chk "ფორმა: კოლეგები (იმავე კატეგორიის, ანგარიშით) — ექთანი 2 + შემდგენი…; ექთან 2-ის ცვლები ჩანს" "$(echo "$OPT" | jq --arg s "$S2" '[.colleagues[]|select(.id==$s)]|length'):$(echo "$OPT" | jq --arg e "$EB" '[.shifts[]|select(.id==$e)]|length'):$(echo "$OPT" | jq --arg s "$SDOC" '[.colleagues[]|select(.id==$s)]|length')" "1:1:0"
chk "სხვისი ცვლის გაცვლა — 403" "$(code POST /roster/swaps "$N2" -d "{\"kind\":\"swap\",\"from_entry_id\":\"$EA\",\"to_entry_id\":\"$EB\"}")" "403"
R=$(api POST /roster/swaps "$N1" -d "{\"kind\":\"swap\",\"from_entry_id\":\"$EA\",\"to_entry_id\":\"$EB\",\"note\":\"ტესტ-E2E: ოჯახური\"}")
SW1=$(echo "$R" | jq -r '.id // empty')
chk "გაცვლა $(dm "$(d 20)") D ↔ $(dm "$(d 21)") D — კოლეგასთან; კოლეგას — შეტყობინება" "$([ -n "$SW1" ] && echo ok):$(api GET /roster/swaps "$N2" | jq -r --arg w "$SW1" '.[]|select(.id==$w)|"\(.status):\(.direction)"'):$(api GET /notifications "$N2" | jq '[.[]|select(.kind=="swap_proposed")]|length')" "ok:peer:in:1"
chk "იგივე ცვლაზე მეორე გაცვლა — 409 SWAP_BUSY" "$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$EA\",\"to_staff_id\":\"$S2\"}" | jq -r .code)" "SWAP_BUSY"
chk "გადაცემა: ექიმს — 400 SWAP_CATEGORY; ანგარიშის გარეშე — 400 SWAP_NO_ACCOUNT" "$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$E28\",\"to_staff_id\":\"$SDOC\"}" | jq -r .code):$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$E28\",\"to_staff_id\":\"$SJ\"}" | jq -r .code)" "SWAP_CATEGORY:SWAP_NO_ACCOUNT"
R=$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$E1\",\"to_staff_id\":\"$S2\"}")
has "გადაცემა არყოფნაში მყოფ კოლეგას ($(dm "$(d 1)") — ბიულეტენი) — 409 SWAP_RULE" "$(echo "$R" | jq -r '.code + ":" + .message')" "SWAP_RULE:"
chk "კოლეგა გაუქმებას ვერ — 403; ინიციატორი გადაწყვეტილებას ვერ — 403" "$(code POST "/roster/swaps/$SW1/cancel" "$N2" -d '{}'):$(code POST "/roster/swaps/$SW1/peer" "$N1" -d '{"accept":true}')" "403:403"
chk "კოლეგა თანახმაა → ხელმძღვანელთან; შემდგენს — შეტყობინება" "$(api POST "/roster/swaps/$SW1/peer" "$N2" -d '{"accept":true}' | jq -r .status):$(api GET /notifications "$PL" | jq '[.[]|select(.kind=="swap_to_approve")]|length')" "head:1"
chk "„დასადასტურებელი“ (შემდგენი) — გაცვლა 1; ხელმძღვანელი (absence_approve) — 403" "$(api GET /roster/inbox "$PL" | jq -r --arg w "$SW1" '[.swaps[]|select(.id==$w)]|length'):$(code POST "/roster/swaps/$SW1/decide" "$HD" -d '{"approve":true}')" "1:403"
R=$(api POST "/roster/swaps/$SW1/decide" "$PL" -d '{"approve":true,"confirm_warnings":true}')
G=$(api GET "/roster/rosters/$R1" "$PL")
chk "შემდგენი ადასტურებს → შესრულდა: $(dm "$(d 20)") — ექთანი 2, $(dm "$(d 21)") — ექთანი 1" "$(echo "$R" | jq -r .status):$(echo "$G" | jq -r --arg e "$EA" --arg s "$S2" '.entries[]|select(.id==$e)|.staff_id==$s'):$(echo "$G" | jq -r --arg e "$EB" --arg s "$S1" '.entries[]|select(.id==$e)|.staff_id==$s')" "approved:true:true"
chk "  … ისტორია swap × 2; ორივეს — swap_decided" "$(api GET "/roster/rosters/$R1/changes" "$PL" | jq '[.[]|select(.kind=="swap")]|length'):$(api GET /notifications "$N1" | jq '[.[]|select(.kind=="swap_decided")]|length'):$(api GET /notifications "$N2" | jq '[.[]|select(.kind=="swap_decided")]|length')" "2:1:1"
SW2=$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$E28\",\"to_staff_id\":\"$S2\"}" | jq -r '.id // empty')
chk "გადაცემა → კოლეგა უარს ამბობს → declined; ინიციატორს — შეტყობინება" "$(api POST "/roster/swaps/$SW2/peer" "$N2" -d '{"accept":false,"note":"ტესტ-E2E: ვერ"}' | jq -r .status):$(api GET /notifications "$N1" | jq '[.[]|select(.kind=="swap_decided")]|length')" "declined:2"
SW3=$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$E28\",\"to_staff_id\":\"$S2\"}" | jq -r '.id // empty')
chk "ინიციატორი აუქმებს" "$(api POST "/roster/swaps/$SW3/cancel" "$N1" -d '{"reason":"ტესტ-E2E"}' | jq -r .ok):$(api GET /roster/swaps "$N1" | jq -r --arg w "$SW3" '.[]|select(.id==$w)|.status')" "true:cancelled"
mod '{"swap_approval":"none"}'
SW4=$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$EB\",\"to_staff_id\":\"$S2\"}" | jq -r '.id // empty')
chk "swap_approval = none: კოლეგის თანხმობით — მაშინვე შესრულდა ($(dm "$(d 21)") → ექთანი 2)" "$(api POST "/roster/swaps/$SW4/peer" "$N2" -d '{"accept":true}' | jq -r .status):$(api GET "/roster/rosters/$R1" "$PL" | jq -r --arg e "$EB" --arg s "$S2" '.entries[]|select(.id==$e)|.staff_id==$s')" "approved:true"
mod '{"swap_approval":"head"}'
R3=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$NX\"}" | jq -r '.id // empty')
EN=$(add "$R3" "$PL" "[$(item "$S1" "$(dn 3)" "$TD")]" | jq -r '.created[0].id // empty')
chk "მონახაზის ცვლის გაცვლა — 409 ROSTER_NOT_PUBLISHED" "$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$EN\",\"to_staff_id\":\"$S2\"}" | jq -r .code)" "ROSTER_NOT_PUBLISHED"

step "9. გაუქმება, ადრე დასრულება (C5)"
chk "ექთანი 1: დადასტურებული შვებულების გაუქმება → თხოვნა (დადასტურებული რჩება)" "$(api POST "/roster/absences/$A1/cancel" "$N1" -d '{"reason":"ტესტ-E2E: გეგმა შეიცვალა"}' | jq -r '"\(.status):\(.cancel_requested)"'):$(api GET /roster/inbox "$HD" | jq -r --arg a "$A1" '[.absences[]|select(.id==$a)|.can_cancel_decide]|first')" "approved:true:true"
chk "ხელმძღვანელი ეთანხმება → გაუქმდა; ბალანსი 27" "$(api POST "/roster/absences/$A1/cancel-decision" "$HD" -d '{"approve":true}' | jq -r .ok):$(api GET "/roster/absences/$A1" "$N1" | jq -r .status):$(api GET "/roster/balances?year=$Y" "$N1" | jq -r '.items[]|select(.type.code=="ANNUAL")|.available')" "true:cancelled:27"
chk "ექთანი 2: ბიულეტენის გაუქმების თხოვნა → HR უარს ამბობს → რჩება" "$(api POST "/roster/absences/$A2/cancel" "$N2" -d '{"reason":"ტესტ-E2E"}' | jq -r .cancel_requested):$(api POST "/roster/absences/$A2/cancel-decision" "$HR" -d '{"approve":false,"note":"ტესტ-E2E"}' | jq -r .ok):$(api GET "/roster/absences/$A2" "$N2" | jq -r '"\(.status):\(.cancel_requested_at)"')" "true:true:approved:null"
A7=$(absreq "$N1" "{\"absence_type_id\":\"$TA\",\"date_from\":\"${W[13]}\",\"date_to\":\"${W[13]}\"}" | jq -r '.id // empty')
chk "განხილვაში მყოფი — თავად აუქმებს; კოლეგა — 403" "$(code POST "/roster/absences/$A7/cancel" "$N2" -d '{"reason":"ტესტ ტესტ"}'):$(api POST "/roster/absences/$A7/cancel" "$N1" -d '{"reason":"ტესტ-E2E: აღარ მჭირდება"}' | jq -r .status)" "403:cancelled"
KEPT=$(wd "${W[10]}" "${W[10]}"); BACK=$(( $(wd "${W[10]}" "${W[11]}") - KEPT ))
chk "ადრე დასრულება: შემდგენი — 403; HR → ${W[10]}: დღე $KEPT, ბალანსს უბრუნდება $BACK" "$(code POST "/roster/absences/$A6/shorten" "$PL" -d "{\"date_to\":\"${W[10]}\",\"reason\":\"ტესტ ტესტ\"}"):$(api POST "/roster/absences/$A6/shorten" "$HR" -d "{\"date_to\":\"${W[10]}\",\"reason\":\"ტესტ-E2E: დაბრუნდა\"}" | jq -r '"\(.days):\(.restored)"')" "403:$KEPT:$BACK"
chk "  … ბალანსი (ექთანი 2, $Y): 30 − $KEPT = $((30 - KEPT))" "$(api GET "/roster/balances?staff_id=$S2&year=$Y" "$HR" | jq -r '.items[]|select(.type.code=="ANNUAL")|.available')" "$((30 - KEPT))"
LST=$(api GET "/roster/absences?scope=all&department_id=$D1" "$PL")
chk "სიები: ჩემი (ექთანი 1) ≥ 3; შემდგენი — განყოფილების ყველა ≥ 7; ექთანი scope=all — 403" "$(api GET "/roster/absences?scope=my" "$N1" | jq 'length >= 3'):$(echo "$LST" | jq 'length >= 7'):$(code GET "/roster/absences?scope=all" "$N2")" "true:true:403"
chk "აუდიტში APPROVE_ABSENCE / SHORTEN_ABSENCE" "$(api GET "/audit-logs?entity_name=absence_requests&entity_id=$A6&limit=20" "$ADM" | jq -r '[.[]|.action]|map(select(.=="APPROVE_ABSENCE" or .=="SHORTEN_ABSENCE"))|unique|join(",")')" "APPROVE_ABSENCE,SHORTEN_ABSENCE"

step "10. „არ შემიძლია“ / „მირჩევნია“ (H)"
PF="{\"month\":\"$NX\",\"items\":[{\"day\":\"$(dn 5)\",\"kind\":\"unavailable\",\"note\":\"ტესტ-E2E\"},{\"day\":\"$(dn 6)\",\"kind\":\"unavailable\",\"part\":\"night\"},{\"day\":\"$(dn 7)\",\"kind\":\"prefer\",\"shift_template_id\":\"$TD\"},{\"day\":\"$(dn 12)\",\"kind\":\"unavailable\"}]}"
chk "ექთანი 1 ($NX, მონახაზი): შენახვა — 3 / 1; რედაქტირებადია" "$(api PUT /roster/prefs "$N1" -d "$PF" | jq -r '"\(.unavailable):\(.prefer)"'):$(api GET "/roster/prefs?month=$NX" "$N1" | jq -r '"\(.items|length):\(.editable)"')" "3:1:4:true"
mod '{"unavailable_max_per_month":1}'
chk "ლიმიტი 1: ექთანი — 409 PREFS_LIMIT; შემდგენი მის მაგივრად — OK" "$(api PUT /roster/prefs "$N1" -d "$PF" | jq -r .code):$(api PUT /roster/prefs "$PL" -d "$(echo "$PF" | jq -c --arg s "$S1" '. + {staff_id:$s}')" | jq -r .ok)" "PREFS_LIMIT:true"
mod '{"unavailable_max_per_month":4}'
chk "სხვისი სურვილები: კოლეგა — 403" "$(code GET "/roster/prefs?month=$NX&staff_id=$S1" "$N2")" "403"
chk "გამოქვეყნებული თვე ($M) — 409 PREFS_LOCKED" "$(api PUT /roster/prefs "$N1" -d "{\"month\":\"$M\",\"items\":[]}" | jq -r .code)" "PREFS_LOCKED"
if [ "$TDD" -gt 1 ]; then
  mod '{"prefs_deadline_day":1}'
  chk "ვადა (წინა თვის 1 რიცხვი) ამოიწურა ($P) — 409 PREFS_DEADLINE; შემდგენს — OK" "$(api PUT /roster/prefs "$N1" -d "{\"month\":\"$P\",\"items\":[]}" | jq -r .code):$(api PUT /roster/prefs "$PL" -d "{\"month\":\"$P\",\"staff_id\":\"$S1\",\"items\":[]}" | jq -r .ok)" "PREFS_DEADLINE:true"
  mod '{"prefs_deadline_day":0}'
else ok "ვადის შემოწმება გამოტოვდა (თვის 1 რიცხვი)"; fi
R=$(add "$R3" "$PL" "[$(item "$S1" "$(dn 5)" "$TD"),$(item "$S1" "$(dn 6)" "$TD" ',"start_time":"09:00","end_time":"17:00"')]")
chk "ბადე: 2 ცვლა; ღამის შეზღუდვა დღის ცვლაზე — გაფრთხილების გარეშე" "$(echo "$R" | jq -r '"\(.created|length):\(.created[1].warnings|length)"')" "2:0"
has "  … „არ შემიძლია“ დღეზე — გაფრთხილებით" "$(echo "$R" | jq -r '.created[0].warnings|join(" | ")')" "„არ შემიძლია“"
chk "ბადეში სურვილები ჩანს შემდგენს (4)" "$(api GET "/roster/rosters/$R3" "$PL" | jq --arg s "$S1" '[.prefs[]|select(.staff_id==$s)]|length')" "4"
mod '{"prefs_mode":"off"}'
chk "prefs_mode = off — გაფრთხილება აღარ არის" "$(add "$R3" "$PL" "[$(item "$S1" "$(dn 12)" "$TD")]" | jq -r '.created[0].warnings|length')" "0"
mod '{"prefs_mode":"warn"}'

step "11. მოდულის გამორთვა"
api PUT /modules/roster "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულია → არყოფნა / გაცვლა / სურვილები — 403" "$(code GET "/roster/absences?scope=my" "$N1"):$(code GET /roster/swaps "$N1"):$(code GET "/roster/prefs?month=$NX" "$N1")" "403:403:403"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null

step "გასუფთავება"
api POST "/roster/absences/$A3/cancel" "$HR" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
for O in $(api GET "/roster/open-shifts?roster_id=$R1" "$PL" | jq -r '.[].id'); do api POST "/roster/open-shifts/$O/cancel" "$PL" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
chk "დარჩენილი მოთხოვნა / დასაფარი გაუქმდა" "$(api GET "/roster/absences/$A3" "$HR" | jq -r .status):$(api GET "/roster/open-shifts?roster_id=$R1" "$PL" | jq length)" "cancelled:0"
for X in $S1 $S2 $S3 $SDOC $SH2 $SJ; do api PATCH "/roster/staff/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $PN $PD $PJ; do api PATCH "/roster/positions/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/roster/absence-types/$TX" "$HR" -d '{"is_active":false}' >/dev/null
api PUT /modules/roster "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო თანამშრომლები, ტიპი, მომხმარებლები, როლები, განყოფილებები გათიშულია (განრიგები / მოთხოვნები / ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
