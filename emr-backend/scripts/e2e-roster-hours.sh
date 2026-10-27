#!/usr/bin/env bash
# =====================================================================
# e2e-roster-hours.sh — ცვლები / მორიგეობა, ეტაპი 3 (0079): საათები / ტაბელი, ზეგანაკვეთური, თვის დახურვა, HR ექსპორტი, კავშირები
#   პარამეტრები (ვალიდაცია), ფაქტი (მონახაზში / მომავალში / უფლების გარეშე — არა; რეალური დრო, საათები, „არ გამოცხადდა“, OC — გამოძახების საათები, გეგმაზე დაბრუნება,
#   ისტორია), ტაბელი: უჯრები (საათები / არყოფნის კოდი / „გ“), ნორმა (FTE, არყოფნა), „ნამუშევრად ჩათვლილი“ (მივლინება), ზეგანაკვეთი, ღამე / დღესასწაული / შაბ.–კვ.,
#   რამდენიმე განყოფილება (ნორმა — მხოლოდ ძირითადში), წვდომა (შემდგენი / ხელმძღვანელი / HR / ბუღალტერი / ნახვა), პირადი №,
#   წარდგენა (ადრე / განხილვაში მყოფი არყოფნა / ორჯერ), დახურვა (წარდგენის გარეშე / გაფრთხილება / COMP → ბალანსი), დახურულში ცვლილება — არა,
#   „მოძველებულია“ (გვიან დარეგისტრირებული ბიულეტენი), ხელახლა გახსნა (COMP საპირისპირო ჩანაწერით), პარამეტრების გავლენა (ღამის ფანჯარა, overtime_basis),
#   ექსპორტი (xlsx: 3 ფურცელი), მიმოხილვა, „ჩემი საათები“, კავშირები: lookup „ახლა“ (კონსულტაცია / ბიომედი), დატვირთვა (საწოლფონდი), შეტყობინებები, აუდიტი.
# ბოლოს: თანამშრომლები / მომხმარებლები / განყოფილებები გათიშულია, სატესტო დღესასწაული წაშლილია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-roster-hours.sh [API_URL]
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
command -v unzip >/dev/null || die "unzip არ არის დაყენებული"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); S4=${S: -4}; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mod()  { api PUT /modules/roster "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
# სატესტო თვე: PM — წინა (დასრულებული) თვე; CM — მიმდინარე
CM=$(TZ=Asia/Tbilisi date +%Y-%m); PM=$(date -d "$CM-01 -1 month" +%Y-%m); PY=${PM:0:4}
TODAY=$(TZ=Asia/Tbilisi date +%F); TOMORROW=$(date -d "$TODAY +1 day" +%F); HH=$(TZ=Asia/Tbilisi date +%H)
p()  { printf '%s-%02d' "$PM" "$1"; }
add() { api POST "/roster/rosters/$1/entries" "$2" -d "{\"items\":$3${4:-}}"; }
item() { echo "{\"staff_id\":\"$1\",\"day\":\"$2\",\"shift_template_id\":\"$3\"${4:-}}"; }
act() { api POST "/roster/entries/$1/actual" "$PL" -d "$2"; }
eid() { api GET "/roster/rosters/$1" "$ADM" | jq -r --arg s "$2" --arg d "$3" --arg c "${4:-}" '[.entries[]|select(.staff_id==$s and .day==$d and ($c=="" or .code==$c))][0].id // empty'; }
row() { echo "$1" | jq -c --arg s "$2" '.rows[]|select(.staff_id==$s)'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0079" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0079" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E საათ. თერაპია $S\",\"code\":\"E2EHA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E საათ. რეანიმაცია $S\",\"code\":\"E2EHB$S\",\"type\":\"inpatient\",\"care_level\":\"icu\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.hr.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"საათ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"phone\":\"5992$2$S4\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.hr.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_PL=$(mkrole hpl "განრიგი (განყ.)" '["roster"]'); R_AP=$(mkrole hap "არყოფნის დადასტ." '["absence_approve"]'); R_HR=$(mkrole hhr "HR" '["hr"]')
R_AC=$(mkrole hac "ბუღალტერი" '["accountant"]'); R_VW=$(mkrole hvw "განრიგის ნახვა" '["roster_view"]'); R_EN=$(mkrole hen "ინჟინერი" '["med_engineer"]')
[ -n "$R_PL" ] && [ -n "$R_AP" ] && [ -n "$R_HR" ] && [ -n "$R_AC" ] && [ -n "$R_VW" ] && [ -n "$R_EN" ] || die "როლები ვერ შეიქმნა"
read -r _ PL <<< "$(mkuser "[\"$R_PL\"]" 71 ",\"department_id\":\"$D1\"")"
read -r _ HD <<< "$(mkuser "[\"$R_AP\",\"doctor\"]" 72 ",\"department_id\":\"$D1\"")"
read -r _ HR <<< "$(mkuser "[\"$R_HR\"]" 73)"
read -r _ AC <<< "$(mkuser "[\"$R_AC\"]" 74)"
read -r U1 N1 <<< "$(mkuser '["nurse"]' 75 ",\"department_id\":\"$D1\"")"
read -r U2 N2 <<< "$(mkuser '["nurse"]' 76 ",\"department_id\":\"$D1\"")"
read -r U3 N3 <<< "$(mkuser '["nurse"]' 77 ",\"department_id\":\"$D2\"")"
read -r UD DOC <<< "$(mkuser '["doctor"]' 78 ",\"department_id\":\"$D1\"")"
read -r UE ENG <<< "$(mkuser "[\"$R_EN\"]" 79 ",\"department_id\":\"$D1\"")"
read -r _ VW <<< "$(mkuser "[\"$R_VW\"]" 70)"
[ -n "$PL" ] && [ -n "$HD" ] && [ -n "$HR" ] && [ -n "$AC" ] && [ -n "$N1" ] && [ -n "$N2" ] && [ -n "$N3" ] && [ -n "$DOC" ] && [ -n "$ENG" ] && [ -n "$VW" ] \
  && ok "10 მომხმარებელი (შემდგენი, ხელმძღვანელი, HR, ბუღალტერი, ექთნები D1 ×2 / D2, ექიმი, ინჟინერი, ნახვა)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული roster ვერ მოიძებნა"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
mod '{"rest_min_hours":12,"rest_mode":"warn","max_continuous_hours":24,"continuous_mode":"block","max_week_hours":48,"week_mode":"warn","max_consecutive_nights":3,"nights_mode":"warn","norm_mode":"off","cross_department":"warn","publish_notify":false,"change_notify":false,"duty_phone":"all","absence_unit_mode":"weekdays","accrual":"annual","balance_overdraw":"block","prefs_mode":"off","week_norm_hours":40,"overtime_basis":"month","overtime_default":"pay","comp_absence_type":"COMP","night_from":"22:00","night_to":"06:00","close_requires_submit":true,"link_consult":"hint","link_bme":"hint","link_or":"absence","nurse_ratio":{"ward":8,"intensive":4,"icu":2}}'
# სატესტო დღესასწაული (PM): ორშ.–ხუთ., მომდევნო დღე — სამუშაო; შაბათი (SAT) — შაბათ-კვირა დღესასწაულის გარეშე
HOL=$(api GET /roster/holidays "$ADM" | jq -r '.[].day|.[0:10]')
isH() { grep -qx "$1" <<< "$HOL"; }
H=""; for i in $(seq 2 26); do x=$(p "$i"); n=$(date -d "$x +1 day" +%F); dw=$(date -d "$x" +%u); if [ "$dw" -le 4 ] && ! isH "$x" && ! isH "$n" && ! isH "$(date -d "$x -1 day" +%F)"; then H=$x; break; fi; done
SAT=""; for i in $(seq 1 27); do x=$(p "$i"); n=$(date -d "$x +1 day" +%F); if [ "$(date -d "$x" +%u)" = 6 ] && ! isH "$x" && ! isH "$n" && [ "$x" != "$H" ]; then SAT=$x; break; fi; done
[ -n "$H" ] && [ -n "$SAT" ] || die "სატესტო დღესასწაული / შაბათი ვერ შეირჩა ($PM)"
api POST /roster/holidays "$ADM" -d "{\"day\":\"$H\",\"name\":\"ტესტ-E2E დღესასწაული $S4\"}" >/dev/null
HOL=$(api GET /roster/holidays "$ADM" | jq -r '.[].day|.[0:10]')
isw() { [ "$(date -d "$1" +%u)" -le 5 ] && ! grep -qx "$1" <<< "$HOL"; }
wd() { local x=$1 n=0; while [[ ! "$x" > "$2" ]]; do isw "$x" && n=$((n+1)); x=$(date -d "$x +1 day" +%F); done; echo $n; }
W=(); x="$PM-01"; while [ "${x:0:7}" = "$PM" ]; do isw "$x" && W+=("$x"); x=$(date -d "$x +1 day" +%F); done
NW=${#W[@]}; L=$((NW-1))
[ "$NW" -ge 16 ] || die "წინა თვეში სამუშაო დღე < 16"
isw "$H" && die "სატესტო დღესასწაული სამუშაო დღედ ითვლება"
ok "წინა თვე $PM: სამუშაო დღე $NW (სატესტო დღესასწაული $H), შაბათი $SAT"
HM1=$(date -d "$H -1 day" +%F); HP1=$(date -d "$H +1 day" +%F)
TRIP_D=${W[$L]}; ANN_A=${W[$((L-2))]}; ANN_B=${W[$((L-1))]}; S2_ANN=${W[$((L-3))]}; SICK_A=${W[$((L-5))]}; SICK_B=${W[$((L-4))]}
DL=(); for x in "${W[@]}"; do case "$x" in "$HM1"|"$HP1"|"$TRIP_D"|"$ANN_A"|"$ANN_B") continue ;; esac; DL+=("$x"); done
ND=$(( ${#DL[@]} < 16 ? ${#DL[@]} : 16 )); DL=("${DL[@]:0:$ND}")
S2D=(); for x in "${W[@]}"; do case "$x" in "$S2_ANN"|"$SICK_A"|"$SICK_B") continue ;; esac; S2D+=("$x"); done   # ექთანი 2: D ×3 + OC

step "1. უფლებები, პარამეტრები"
chk "უფლებები — 45 (ახალი არ ემატება)" "$(api GET /roles/capabilities "$ADM" | jq length)" "45"
chk "პარამეტრები: overtime_basis = x / night_from = night_to / nurse_ratio.icu = 0 / link_or = x — 400" "$(code PUT /modules/roster "$ADM" -d '{"settings":{"overtime_basis":"x"},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"night_from":"22:00","night_to":"22:00"},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"nurse_ratio":{"ward":8,"intensive":4,"icu":0}},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"link_or":"x"},"reason":"ტესტ"}')" "400:400:400:400"
chk "  … week_norm_hours = 10 / comp_absence_type = 'x' — 400" "$(code PUT /modules/roster "$ADM" -d '{"settings":{"week_norm_hours":10},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"comp_absence_type":"x"},"reason":"ტესტ"}')" "400:400"
chk "refs: ახალი პარამეტრები (week_norm_hours, link_consult, nurse_ratio.icu)" "$(api GET /roster/refs "$PL" | jq -r '.settings|"\(.week_norm_hours):\(.link_consult):\(.nurse_ratio.icu)"')" "40:hint:2"

step "2. თანამშრომლები, განრიგები ($PM — D1 / D2; $CM — D1)"
REFS=$(api GET /roster/refs "$ADM")
TD=$(echo "$REFS" | jq -r '.templates[]|select(.code=="D").id'); TN=$(echo "$REFS" | jq -r '.templates[]|select(.code=="N").id'); TOC=$(echo "$REFS" | jq -r '.templates[]|select(.code=="OC").id')
TY=$(api GET /roster/absence-types "$ADM")
TA=$(echo "$TY" | jq -r '.[]|select(.code=="ANNUAL").id'); TS=$(echo "$TY" | jq -r '.[]|select(.code=="SICK").id'); TT=$(echo "$TY" | jq -r '.[]|select(.code=="TRIP").id'); TC=$(echo "$TY" | jq -r '.[]|select(.code=="COMP").id')
PN=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_HN_$S\",\"name\":\"ტესტ-E2E ექთანი\",\"category\":\"nurse\"}" | jq -r '.id // empty')
PD=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_HD_$S\",\"name\":\"ტესტ-E2E ექიმი\",\"category\":\"doctor\"}" | jq -r '.id // empty')
PT=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_HT_$S\",\"name\":\"ტესტ-E2E ინჟინერი\",\"category\":\"tech\"}" | jq -r '.id // empty')
api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$U1\",\"$U2\",\"$U3\"],\"position_id\":\"$PN\"}" >/dev/null
api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$UD\"],\"position_id\":\"$PD\"}" >/dev/null
api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$UE\"],\"position_id\":\"$PT\"}" >/dev/null
sid() { api GET "/roster/staff?search=$(jq -rn --arg s "საათ-$1" '$s|@uri')" "$ADM" | jq -r '.[0].id // empty'; }
S1=$(sid 75); S2=$(sid 76); S3=$(sid 77); SDOC=$(sid 78); SENG=$(sid 79)
SJ=$(api POST /roster/staff "$ADM" -d "{\"first_name\":\"სანიტარი\",\"last_name\":\"ტესტ-E2E-სთ\",\"department_id\":\"$D1\",\"personal_number\":\"79$(printf '%09d' "$((10#$S))")\"}" | jq -r '.id // empty')
[ -n "$S1" ] && [ -n "$S2" ] && [ -n "$S3" ] && [ -n "$SDOC" ] && [ -n "$SENG" ] && [ -n "$SJ" ] && ok "6 თანამშრომელი (ექთნები D1 ×2 / D2, ექიმი, ინჟინერი, სანიტარი ანგარიშის გარეშე)" || die "თანამშრომლები ვერ შეიქმნა"
chk "ექთანი 2 — FTE 0.5; ექთანი D2 — დამატებითი განყოფილება D1" "$(code PATCH "/roster/staff/$S2" "$ADM" -d '{"fte":0.5}'):$(code PATCH "/roster/staff/$S3" "$ADM" -d "{\"extra_department_ids\":[\"$D1\"]}")" "200:200"
R1=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$PM\"}" | jq -r '.id // empty')
R2=$(api POST /roster/rosters "$ADM" -d "{\"department_id\":\"$D2\",\"month\":\"$PM\"}" | jq -r '.id // empty')
[ -n "$R1" ] && [ -n "$R2" ] || die "განრიგები ვერ შეიქმნა"
IT=""; for x in "${DL[@]}"; do IT+="$(item "$S1" "$x" "$TD"),"; done
IT+="$(item "$S1" "$H" "$TN"),$(item "$S1" "$SAT" "$TN"),"
IT+="$(item "$S2" "${S2D[0]}" "$TD"),$(item "$S2" "${S2D[1]}" "$TD"),$(item "$S2" "${S2D[2]}" "$TD"),$(item "$S2" "${S2D[4]}" "$TOC"),"
IT+="$(item "$S3" "${W[5]}" "$TD"),$(item "$S3" "${W[6]}" "$TD"),$(item "$SJ" "${W[8]}" "$TD")"
R=$(add "$R1" "$PL" "[$IT]" ',"mode":"skip"')
EXPN=$((ND + 2 + 4 + 2 + 1))
chk "D1 ($PM): $EXPN ჩანაწერი (ექთანი 1: D ×$ND + N დღესასწაულზე + N შაბათს)" "$(echo "$R" | jq '.created|length'):$(echo "$R" | jq '.skipped|length')" "$EXPN:0"
chk "D2 ($PM): ექთანი D2 — 1 D" "$(add "$R2" "$ADM" "[$(item "$S3" "${W[7]}" "$TD")]" | jq '.created|length')" "1"
chk "ტაბელი მონახაზში — 409 ROSTER_NOT_PUBLISHED; ფაქტი მონახაზში — 409" "$(api GET "/roster/rosters/$R1/timesheet" "$PL" | jq -r .code):$(code POST "/roster/entries/$(eid "$R1" "$S1" "${DL[0]}")/actual" "$PL" -d '{"status":"no_show","reason":"ტესტ"}')" "ROSTER_NOT_PUBLISHED:409"
chk "გამოქვეყნება (D1, D2)" "$(api POST "/roster/rosters/$R1/publish" "$PL" -d '{"confirm_warnings":true}' | jq -r .ok):$(api POST "/roster/rosters/$R2/publish" "$ADM" -d '{"confirm_warnings":true}' | jq -r .ok)" "true:true"
# მიმდინარე თვე: ახლა ცვლაში — ექიმი / ინჟინერი / ექთანი 2 (კავშირები); ექთანი 2 — ხვალ (მომავლის ფაქტი)
ST=$(printf '%02d:00' "$((10#$HH))"); EN=$(printf '%02d:00' "$(( (10#$HH + 3) % 24 ))")
RC=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$CM\"}" | jq -r '.id // empty')
NOW=",\"start_time\":\"$ST\",\"end_time\":\"$EN\""
IT="$(item "$SDOC" "$TODAY" "$TD" "$NOW"),$(item "$SENG" "$TODAY" "$TD" "$NOW"),$(item "$S2" "$TODAY" "$TD" "$NOW")"
[ "${TOMORROW:0:7}" = "$CM" ] && IT+=",$(item "$S2" "$TOMORROW" "$TD")"
R=$(add "$RC" "$PL" "[$IT]" ',"mode":"skip"')
chk "მიმდინარე თვე ($CM): ახლა ცვლაში ექიმი / ინჟინერი / ექთანი; გამოქვეყნება" "$(echo "$R" | jq '[.created[]|select(.day=="'"$TODAY"'")]|length'):$(api POST "/roster/rosters/$RC/publish" "$PL" -d '{"confirm_warnings":true}' | jq -r .ok)" "3:true"

step "3. ფაქტი"
E0=$(eid "$R1" "$S1" "${DL[0]}"); E1=$(eid "$R1" "$S1" "${DL[1]}"); E2=$(eid "$R1" "$S1" "${DL[2]}"); EOC=$(eid "$R1" "$S2" "${S2D[4]}" OC)
chk "ექთანი — 403; HR (განრიგის რედაქტორი, roster_all არე) — 200 → გეგმაზე" "$(code POST "/roster/entries/$E0/actual" "$N1" -d '{"status":"no_show","reason":"ტესტ"}'):$(code POST "/roster/entries/$E0/actual" "$HR" -d '{"status":"plan","reason":"ტესტ-E2E"}')" "403:200"
R=$(act "$E0" '{"status":"worked","start_time":"08:00","end_time":"21:00","reason":"ტესტ-E2E: დარჩა ცვლის შემდეგ","note":"პაციენტის გადაყვანა"}')
chk "ექთანი 1, ${DL[0]}: რეალური დრო 08:00–21:00 → 13 სთ" "$(echo "$R" | jq -r '"\(.status):\(.hours)"')" "worked:13"
chk "ექთანი 1, ${DL[1]}: „არ გამოცხადდა“ → 0" "$(act "$E1" '{"status":"no_show","reason":"ტესტ-E2E: არ გამოცხადდა"}' | jq -r '"\(.status):\(.hours)"')" "no_show:0"
chk "ექთანი 1, ${DL[2]}: საათები 10 (დროის გარეშე)" "$(act "$E2" '{"status":"worked","hours":10,"reason":"ტესტ-E2E: ადრე წავიდა"}' | jq -r .hours)" "10"
chk "ვალიდაცია: worked დროის / საათების გარეშე — 400; საათები > ინტერვალი — 400; მიზეზის გარეშე — 400" "$(code POST "/roster/entries/$E2/actual" "$PL" -d '{"status":"worked","reason":"ტესტ ტესტ"}'):$(code POST "/roster/entries/$E2/actual" "$PL" -d '{"status":"worked","start_time":"08:00","end_time":"09:00","hours":5,"reason":"ტესტ ტესტ"}'):$(code POST "/roster/entries/$E2/actual" "$PL" -d '{"status":"no_show"}')" "400:400:400"
chk "„მორიგეობა სახლიდან“: საათების გარეშე — 400 ACTUAL_HOURS; გამოძახება 3 სთ" "$(api POST "/roster/entries/$EOC/actual" "$PL" -d '{"status":"worked","start_time":"18:00","end_time":"09:00","reason":"ტესტ ტესტ"}' | jq -r .code):$(act "$EOC" '{"status":"worked","hours":3,"reason":"ტესტ-E2E: გამოძახება"}' | jq -r .hours)" "ACTUAL_HOURS:3"
chk "გეგმაზე დაბრუნება და ისევ 10 სთ" "$(act "$E2" '{"status":"plan","reason":"ტესტ-E2E: შეცდომა"}' | jq -r .hours):$(act "$E2" '{"status":"worked","hours":10,"reason":"ტესტ-E2E: ადრე წავიდა"}' | jq -r .hours)" "12:10"
if [ "${TOMORROW:0:7}" = "$CM" ]; then
  chk "მომავალი ცვლა — 409 ACTUAL_FUTURE" "$(api POST "/roster/entries/$(eid "$RC" "$S2" "$TOMORROW")/actual" "$PL" -d '{"status":"no_show","reason":"ტესტ ტესტ"}' | jq -r .code)" "ACTUAL_FUTURE"
else ok "მომავლის ფაქტის შემოწმება გამოტოვდა (თვის ბოლო დღე)"; fi
CH=$(api GET "/roster/rosters/$R1/changes" "$PL")
chk "ისტორია: actual ×7, მიზეზით; ვერსია უცვლელი (0)" "$(echo "$CH" | jq '[.[]|select(.kind=="actual")]|length'):$(echo "$CH" | jq -r '[.[]|select(.kind=="actual")][0].reason|length > 2'):$(api GET "/roster/rosters/$R1" "$PL" | jq .version)" "7:true:0"
chk "ბადეში ფაქტი ჩანს (att_status / actual_hours)" "$(api GET "/roster/rosters/$R1" "$PL" | jq -r --arg e "$E0" '.entries[]|select(.id==$e)|"\(.att_status):\(.actual_hours|tonumber == 13):\(.actual_start_local)-\(.actual_end_local)"')" "worked:true:08:00-21:00"

step "4. არყოფნა თვეში (HR — მაგივრად), განხილვაში მყოფი"
chk "ექთანი 1: მივლინება ${TRIP_D} (ნამუშევრად ითვლება) — HR → დადასტურებული" "$(api POST /roster/absences "$HR" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TT\",\"date_from\":\"$TRIP_D\",\"date_to\":\"$TRIP_D\"}" | jq -r .status)" "approved"
chk "ექთანი 1: შვებულება ${ANN_A} … ${ANN_B} — HR → დადასტურებული (2 დღე)" "$(api POST /roster/absences "$HR" -d "{\"staff_id\":\"$S1\",\"absence_type_id\":\"$TA\",\"date_from\":\"$ANN_A\",\"date_to\":\"$ANN_B\"}" | jq -r '"\(.status):\(.days)"')" "approved:2"
A2=$(api POST /roster/absences "$N2" -d "{\"absence_type_id\":\"$TA\",\"date_from\":\"$S2_ANN\",\"date_to\":\"$S2_ANN\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
chk "ექთანი 2: შვებულება $S2_ANN — ხელმძღვანელთან (განხილვაში)" "$(api GET "/roster/absences/$A2" "$N2" | jq -r .status)" "head"

step "5. ტაბელი ($PM, D1 — ცოცხალი)"
T=$(api GET "/roster/rosters/$R1/timesheet" "$PL")
W1=$((12 * ND + 11)); NORM1=$(( (NW - 2) * 8 )); OT1=$(( W1 + 8 - NORM1 )); [ $OT1 -lt 0 ] && OT1=0
X=$(row "$T" "$S1")
chk "წყარო — live, წინასწარი; სამუშაო დღე $NW" "$(echo "$T" | jq -r '"\(.source):\(.preliminary):\(.workdays)"')" "live:true:$NW"
chk "ექთანი 1: გეგმა $((12*ND+24)) / ფაქტი $W1 / ცვლა $((ND+1)) / გაცდენა 1" "$(echo "$X" | jq -r '"\(.plan_hours):\(.worked_hours):\(.shifts):\(.no_show)"')" "$((12*ND+24)):$W1:$((ND+1)):1"
chk "  … ნორმა ($NW − 2 შვებ.) × 8 = $NORM1; მივლინება +8; ზეგანაკვეთი $OT1" "$(echo "$X" | jq -r '"\(.norm_hours):\(.credit_hours):\(.total_hours):\(.overtime_hours)"')" "$NORM1:8:$W1:$OT1"
chk "  … ღამე 16 (N ×2), დღესასწაული 4 (N 20–24), შაბ.–კვ. 12 (N შაბათს)" "$(echo "$X" | jq -r '"\(.night_hours):\(.holiday_hours):\(.weekend_hours)"')" "16:4:12"
chk "  … უჯრები: 13 / გ / 10 / მ (მივლინება) / შ (შვებულება)" "$(echo "$X" | jq -r --arg a "${DL[0]}" --arg b "${DL[1]}" --arg c "${DL[2]}" --arg t "$TRIP_D" --arg s "$ANN_A" '"\(.days[$a]):\(.days[$b]):\(.days[$c]):\(.days[$t]):\(.days[$s])"')" "13:გ:10:მ:შ"
chk "  … არყოფნა ტიპებით: ANNUAL 2 (ანაზღ.), TRIP 1 (ნამუშევრად)" "$(echo "$X" | jq -r '[.absence[]|"\(.code)=\(.days)/\(.paid)/\(.counts_as_work)"]|sort|join(",")')" "ANNUAL=2/true/false,TRIP=1/true/true"
X=$(row "$T" "$S2")
chk "ექთანი 2 (FTE 0.5): ფაქტი 39 (3 D + OC 3), ნორმა $NW × 4 = $((NW*4)), ზეგანაკვეთი 0" "$(echo "$X" | jq -r '"\(.worked_hours):\(.norm_hours):\(.overtime_hours)"')" "39:$((NW*4)):0"
X=$(row "$T" "$S3")
chk "ექთანი D2 (D1-ში დამატებითი): ამ განრიგში 24 სთ, ნორმა / ზეგანაკვეთი — არა (home = false)" "$(echo "$X" | jq -r '"\(.home):\(.worked_hours):\(.norm_hours)"')" "false:24:null"
chk "ექიმი (ცვლის გარეშე): ნორმა $((NW*8)), ფაქტი 0, ზეგანაკვეთი 0; სანიტარი — 12" "$(row "$T" "$SDOC" | jq -r '"\(.norm_hours):\(.worked_hours):\(.overtime_hours)"'):$(row "$T" "$SJ" | jq -r .worked_hours)" "$((NW*8)):0:0:12"
chk "შემოწმებები: განხილვაში 1, გაცდენა 1; შემდგენს: ფაქტი ✓, წარდგენა ✓, დახურვა ✗" "$(echo "$T" | jq -r '"\(.checks.pending|length):\(.checks.no_show):\(.can.actual):\(.can.submit):\(.can.close)"')" "1:1:true:true:false"
chk "პირადი №: შემდგენს — არ ჩანს; HR-ს — ჩანს" "$(row "$T" "$SJ" | jq -r .personal_number):$(row "$(api GET "/roster/rosters/$R1/timesheet" "$HR")" "$SJ" | jq -r '.personal_number|length')" "null:11"
T2=$(api GET "/roster/rosters/$R2/timesheet" "$ADM")
chk "D2: ექთანი D2 — ძირითადი; ამ განრიგში 12, სულ (ყველა განრიგი) 36" "$(row "$T2" "$S3" | jq -r '"\(.home):\(.worked_hours):\(.total_hours)"')" "true:12:36"
chk "წვდომა: ექთანი — 403; ნახვა (roster_view) — 403; ხელმძღვანელი D1 — 200; ბუღალტერი (დაუხურავი) — 403" "$(code GET "/roster/rosters/$R1/timesheet" "$N1"):$(code GET "/roster/rosters/$R1/timesheet" "$VW"):$(code GET "/roster/rosters/$R1/timesheet" "$HD"):$(code GET "/roster/rosters/$R1/timesheet" "$AC")" "403:403:200:403"

step "6. წარდგენა / დახურვა"
chk "მიმდინარე თვე: წარდგენა — 409 TIMESHEET_EARLY" "$(api POST "/roster/rosters/$RC/submit" "$PL" -d '{}' | jq -r .code)" "TIMESHEET_EARLY"
chk "HR: დახურვა წარდგენამდე — 409 TIMESHEET_NOT_SUBMITTED; ექთანი: წარდგენა — 403" "$(api POST "/roster/rosters/$R1/close" "$HR" -d '{}' | jq -r .code):$(code POST "/roster/rosters/$R1/submit" "$N1" -d '{}')" "TIMESHEET_NOT_SUBMITTED:403"
chk "წარდგენა განხილვაში მყოფი არყოფნით — 409 TIMESHEET_PENDING" "$(api POST "/roster/rosters/$R1/submit" "$PL" -d '{}' | jq -r .code)" "TIMESHEET_PENDING"
chk "ექთანი 2-ის შვებულება: ხელმძღვანელი → HR → დადასტურებული" "$(api POST "/roster/absences/$A2/approve" "$HD" -d '{}' | jq -r .status):$(api POST "/roster/absences/$A2/approve" "$HR" -d '{}' | jq -r .status)" "hr:approved"
chk "წარდგენა — 200; ხელახლა — 409 TIMESHEET_SUBMITTED; HR-ს შეტყობინება" "$(code POST "/roster/rosters/$R1/submit" "$PL" -d '{"note":"ტესტ-E2E"}'):$(api POST "/roster/rosters/$R1/submit" "$PL" -d '{}' | jq -r .code):$(api GET /notifications "$HR" | jq '[.[]|select(.kind=="timesheet_submitted")]|length')" "200:TIMESHEET_SUBMITTED:1"
chk "ექთანი 2: ნორმა ($NW − 1) × 4 = $(( (NW-1)*4 )) (შვებულება)" "$(row "$(api GET "/roster/rosters/$R1/timesheet" "$PL")" "$S2" | jq -r .norm_hours)" "$(( (NW-1)*4 ))"
chk "შემდგენი: დახურვა — 403" "$(code POST "/roster/rosters/$R1/close" "$PL" -d '{"confirm_warnings":true}')" "403"
chk "HR: დახურვა დადასტურების გარეშე — 409 TIMESHEET_WARNINGS (გაცდენა 1)" "$(api POST "/roster/rosters/$R1/close" "$HR" -d '{}' | jq -r '"\(.code):\(.no_show)"')" "TIMESHEET_WARNINGS:1"
chk "COMP > ზეგანაკვეთი — 400; ზეგანაკვეთის გარეშე (ექთანი 2) — 400" "$(code POST "/roster/rosters/$R1/close" "$HR" -d "{\"confirm_warnings\":true,\"comp\":[{\"staff_id\":\"$S1\",\"hours\":$((OT1+1))}]}"):$(code POST "/roster/rosters/$R1/close" "$HR" -d "{\"confirm_warnings\":true,\"comp\":[{\"staff_id\":\"$S2\",\"hours\":1}]}")" "400:400"
CB0=$(api GET "/roster/balances?staff_id=$S1&year=$PY" "$HR" | jq -r '.items[]|select(.type.code=="COMP")|.available')
R=$(api POST "/roster/rosters/$R1/close" "$HR" -d "{\"confirm_warnings\":true,\"comp\":[{\"staff_id\":\"$S1\",\"hours\":8}],\"note\":\"ტესტ-E2E\"}")
chk "დახურვა: ზეგანაკვეთი $OT1, COMP 1 დღე" "$(echo "$R" | jq -r '"\(.ok):\(.overtime):\(.comp_days)"')" "true:$OT1:1"
T=$(api GET "/roster/rosters/$R1/timesheet" "$PL"); X=$(row "$T" "$S1")
chk "ტაბელი: snapshot, დახურული; ექთანი 1 — ანაზღ. $((OT1-8)) / COMP 8 სთ / 1 დღე" "$(echo "$T" | jq -r '"\(.source):\(.roster.status):\(.preliminary)"'):$(echo "$X" | jq -r '"\(.ot_pay_hours):\(.ot_comp_hours):\(.comp_days)"')" "snapshot:closed:false:$((OT1-8)):8:1"
chk "  … snapshot-ში ღამე / უჯრები იგივე (16, 13 / გ)" "$(echo "$X" | jq -r --arg a "${DL[0]}" --arg b "${DL[1]}" '"\(.night_hours):\(.days[$a]):\(.days[$b])"')" "16:13:გ"
chk "COMP ბალანსი ($PY): +1; ჟურნალში comp" "$(api GET "/roster/balances?staff_id=$S1&year=$PY" "$HR" | jq -r '.items[]|select(.type.code=="COMP")|"\(.available - '"$CB0"'):\([.ledger[]|select(.kind=="comp")]|length)"')" "1:1"
chk "შეტყობინება: ექთანს — comp_added; შემდგენს — timesheet_closed" "$(api GET /notifications "$N1" | jq '[.[]|select(.kind=="comp_added")]|length'):$(api GET /notifications "$PL" | jq '[.[]|select(.kind=="timesheet_closed")]|length')" "1:1"
chk "დახურულში: ფაქტი — 409 ROSTER_CLOSED; ცვლის დამატება — 409 ROSTER_CLOSED" "$(api POST "/roster/entries/$E2/actual" "$PL" -d '{"status":"plan","reason":"ტესტ ტესტ"}' | jq -r .code):$(add "$R1" "$PL" "[$(item "$SJ" "${W[9]}" "$TD")]" ',"reason":"ტესტ ტესტ"' | jq -r .code)" "ROSTER_CLOSED:ROSTER_CLOSED"
chk "ბუღალტერი: დახურული ტაბელი — 200; ხელახლა დახურვა — 409" "$(code GET "/roster/rosters/$R1/timesheet" "$AC"):$(code POST "/roster/rosters/$R1/close" "$HR" -d '{"confirm_warnings":true}')" "200:409"

step "7. „მოძველებულია“ (გვიან დარეგისტრირებული ბიულეტენი), ხელახლა გახსნა"
chk "ექთანი 2: ბიულეტენი $SICK_A … $SICK_B (HR, დოკუმენტით) — დახურულ თვეში რეგისტრირდება" "$(api POST /roster/absences "$HR" -d "{\"staff_id\":\"$S2\",\"absence_type_id\":\"$TS\",\"date_from\":\"$SICK_A\",\"date_to\":\"$SICK_B\",\"document_no\":\"E2E-$S4\"}" | jq -r .status)" "approved"
chk "ტაბელი: მოძველებულია (1)" "$(api GET "/roster/rosters/$R1/timesheet" "$HR" | jq '.stale|length')" "1"
chk "ხელახლა გახსნა: შემდგენი — 403; მიზეზის გარეშე — 400" "$(code POST "/roster/rosters/$R1/reopen" "$PL" -d '{"reason":"ტესტ ტესტ"}'):$(code POST "/roster/rosters/$R1/reopen" "$HR" -d '{}')" "403:400"
chk "HR: ხელახლა გახსნა → გამოქვეყნებული; COMP ბალანსი უკან (0); comp ჩანაწერი ×2" "$(api POST "/roster/rosters/$R1/reopen" "$HR" -d '{"reason":"ტესტ-E2E: გვიანი ბიულეტენი"}' | jq -r .ok):$(api GET "/roster/rosters/$R1" "$PL" | jq -r .status):$(api GET "/roster/balances?staff_id=$S1&year=$PY" "$HR" | jq -r '.items[]|select(.type.code=="COMP")|"\(.available - '"$CB0"'):\([.ledger[]|select(.kind=="comp")]|length)"')" "true:published:0:2"
SW=$(wd "$SICK_A" "$SICK_B")
chk "ცოცხალი: ექთანი 2 — ნორმა ($NW − 1 − $SW) × 4 = $(( (NW-1-SW)*4 )); ბიულეტენი უჯრაში (ბ)" "$(row "$(api GET "/roster/rosters/$R1/timesheet" "$PL")" "$S2" | jq -r --arg d "$SICK_A" '"\(.norm_hours):\(.days[$d])"')" "$(( (NW-1-SW)*4 )):ბ"
mod '{"night_from":"21:00"}'
chk "ღამის ფანჯარა 21:00–06:00 → ექთანი 1: ღამე 18" "$(row "$(api GET "/roster/rosters/$R1/timesheet" "$PL")" "$S1" | jq -r .night_hours)" "18"
mod '{"night_from":"22:00","overtime_basis":"off"}'
chk "overtime_basis = off → ზეგანაკვეთი 0" "$(row "$(api GET "/roster/rosters/$R1/timesheet" "$PL")" "$S1" | jq -r .overtime_hours)" "0"
mod '{"overtime_basis":"month","overtime_default":"comp"}'
chk "overtime_default = comp → ნაგულისხმევად COMP = ზეგანაკვეთი ($OT1)" "$(row "$(api GET "/roster/rosters/$R1/timesheet" "$PL")" "$S1" | jq -r .ot_comp_hours)" "$OT1"
mod '{"overtime_default":"pay"}'
chk "ხელახლა დახურვა (წარდგენა ნარჩუნდება) — COMP არა" "$(api POST "/roster/rosters/$R1/close" "$HR" -d '{"confirm_warnings":true}' | jq -r '"\(.ok):\(.comp_days)"'):$(api GET "/roster/rosters/$R1/timesheet" "$HR" | jq '.stale|length')" "true:0:0"
CH=$(api GET "/roster/rosters/$R1/changes" "$PL")
chk "ისტორია: submit / close ×2 / reopen" "$(echo "$CH" | jq -r '[.[]|select(.kind|test("submit|close|reopen"))|.kind]|reverse|join(",")')" "submit,close,reopen,close"

step "8. ექსპორტი (Excel), მიმოხილვა, ჩემი საათები"
dl() { curl -s -o "$TMP/$1.xlsx" -w '%{http_code}:%{content_type}' "$B/roster/timesheets/export?month=$PM$2" -H "authorization: Bearer $3"; }
chk "განყოფილება (შემდგენი) — 200, xlsx" "$(dl d1 "&department_id=$D1" "$PL")" "200:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
WB=$(unzip -p "$TMP/d1.xlsx" xl/workbook.xml 2>/dev/null)
chk "  … 3 ფურცელი: ტაბელი / ჯამები / არყოფნები" "$(echo "$WB" | grep -o 'sheet name="[^"]*"' | cut -d'"' -f2 | paste -sd, -)" "ტაბელი,ჯამები,არყოფნები"
SH2=$(unzip -p "$TMP/d1.xlsx" xl/worksheets/sheet2.xml 2>/dev/null)
has "  … ჯამებში ექთანი 1 + ზეგანაკვეთი $OT1" "$(echo "$SH2" | grep -o "საათ-75.\{0,4000\}" | head -c 4000)" "<v>$OT1</v>"
has "  … ტაბელში „დახურული“ და კოდი „გ“" "$(unzip -p "$TMP/d1.xlsx" xl/worksheets/sheet1.xml)" "დახურული"
chk "ექთანი — 403; შემდგენი მთელი კლინიკა — 403; HR / ბუღალტერი მთელი კლინიკა — 200" "$(dl x "&department_id=$D1" "$N1" | cut -d: -f1):$(dl x "" "$PL" | cut -d: -f1):$(dl all "" "$HR" | cut -d: -f1):$(dl acc "" "$AC" | cut -d: -f1)"  "403:403:200:200"
has "  … HR — D2 (წინასწარი) შედის; ბუღალტერი — მხოლოდ დახურული" "$(unzip -p "$TMP/all.xlsx" xl/worksheets/sheet1.xml | grep -o "რეანიმაცია $S — წინასწარი" | head -1)" "წინასწარი"
chk "  … ბუღალტრის ფაილში D2 არ არის" "$(unzip -p "$TMP/acc.xlsx" xl/worksheets/sheet1.xml | grep -c "რეანიმაცია $S")" "0"
OV=$(api GET "/roster/timesheets?month=$PM" "$HR")
chk "მიმოხილვა (HR): D1 — დახურული / წარდგენილი, D2 — გამოქვეყნებული" "$(echo "$OV" | jq -r --arg a "$D1" --arg b "$D2" '[.rows[]|select(.department_id==$a or .department_id==$b)]|sort_by(.department_name)|map("\(.status):\(.timesheet_submitted_at != null)")|join(",")')" "closed:true,published:false"
chk "მიმოხილვა: ექთანი — ცარიელი; შემდგენი — D1 ჩანს" "$(api GET "/roster/timesheets?month=$PM" "$N1" | jq '.rows|length'):$(api GET "/roster/timesheets?month=$PM" "$PL" | jq --arg a "$D1" '[.rows[]|select(.department_id==$a)]|length')" "0:1"
chk "ჩემი საათები (ექთანი 1): დახურული, ზეგანაკვეთი $OT1; ექთანი D2 — ცოცხალი, სულ 36" "$(api GET "/roster/my/hours?month=$PM" "$N1" | jq -r '"\(.closed):\(.row.overtime_hours)"'):$(api GET "/roster/my/hours?month=$PM" "$N3" | jq -r '"\(.closed):\(.row.total_hours)"')" "true:$OT1:false:36"
chk "აუდიტი: SUBMIT / CLOSE / REOPEN / EXPORT" "$(api GET "/audit-logs?entity_name=rosters&entity_id=$R1&limit=50" "$ADM" | jq -r '[.[]|.action]|map(select(test("SUBMIT_TIMESHEET|CLOSE_ROSTER|REOPEN_ROSTER|TIMESHEET_EXPORT")))|unique|join(",")')" "CLOSE_ROSTER,REOPEN_ROSTER,SUBMIT_TIMESHEET,TIMESHEET_EXPORT"

step "9. კავშირები (ახლა)"
L=$(api GET "/roster/lookup/now?purpose=consult&department_id=$D1" "$DOC")
chk "კონსულტაცია (D1): hint; მორიგე / ცვლაში ექიმი — ჩანს (ტელეფონით)" "$(echo "$L" | jq -r --arg u "$UD" '"\(.mode):\([.people[]|select(.user_id==$u)]|length):\([.people[]|select(.user_id==$u)][0].phone != null)"')" "hint:1:true"
chk "  … ექთანი კონსულტანტად არ ჩანს (კატეგორია — ექიმი)" "$(echo "$L" | jq --arg u "$U2" '[.people[]|select(.user_id==$u)]|length')" "0"
chk "ბიომედი: ინჟინერი ახლა ცვლაში" "$(api GET "/roster/lookup/now?purpose=bme" "$N1" | jq -r --arg u "$UE" '"\(.mode):\([.people[]|select(.user_id==$u)]|length)"')" "hint:1"
mod '{"link_consult":"off","duty_phone":"off"}'
chk "link_consult = off → off / ცარიელი; duty_phone = off → ტელეფონი არ ჩანს (ბიომედი)" "$(api GET "/roster/lookup/now?purpose=consult&department_id=$D1" "$DOC" | jq -r '"\(.mode):\(.people|length)"'):$(api GET "/roster/lookup/now?purpose=bme" "$N1" | jq -r --arg u "$UE" '[.people[]|select(.user_id==$u)][0].phone')" "off:0:null"
mod '{"link_consult":"hint","duty_phone":"all"}'
LD=$(api GET /roster/lookup/load "$N1")
chk "დატვირთვა: D1 — ექთანი 1 ახლა, ზღვარი 8; D2 (ICU) — ზღვარი 2" "$(echo "$LD" | jq -r --arg a "$D1" --arg b "$D2" '"\(.departments[]|select(.department_id==$a)|"\(.nurses):\(.limit)"):\(.departments[]|select(.department_id==$b)|"\(.nurses):\(.limit)")"')" "1:8:0:2"
chk "საწოლფონდის დაფა (სტაციონარი): D1 load.nurses = 1, roster_load" "$(api GET /inpatient/census "$ADM" | jq -r --arg a "$D1" '"\(.departments[]|select(.id==$a)|.load.nurses):\(.roster_load)"')" "1:true"
chk "lookup: არასწორი purpose — 400" "$(code GET "/roster/lookup/now?purpose=x" "$N1")" "400"

step "10. მოდულის გამორთვა"
api PUT /modules/roster "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულია → ტაბელი / ექსპორტი / ჩემი საათები — 403; lookup — off; დაფაზე load — null" "$(code GET "/roster/rosters/$R1/timesheet" "$HR"):$(code GET "/roster/timesheets/export?month=$PM" "$HR"):$(code GET "/roster/my/hours" "$N1"):$(api GET "/roster/lookup/now?purpose=bme" "$N1" | jq -r .mode):$(api GET /inpatient/census "$ADM" | jq -r --arg a "$D1" '.departments[]|select(.id==$a)|.load')" "403:403:403:off:null"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null

step "გასუფთავება"
api DELETE "/roster/holidays/$H" "$ADM" >/dev/null
chk "სატესტო დღესასწაული წაშლილია" "$(api GET /roster/holidays "$ADM" | jq --arg h "$H" '[.[]|select(.day[0:10]==$h)]|length')" "0"
for X in $S1 $S2 $S3 $SDOC $SENG $SJ; do api PATCH "/roster/staff/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $PN $PD $PT; do api PATCH "/roster/positions/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/roster "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო თანამშრომლები, მომხმარებლები, როლები, განყოფილებები გათიშულია (განრიგები / ტაბელები / ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
