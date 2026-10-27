#!/usr/bin/env bash
# =====================================================================
# e2e-roster-reports.sh — ცვლები / მორიგეობა, ეტაპი 4 (0080): ანგარიშები / KPI / მენეჯერული დაფა
#   პარამეტრები (ვალიდაცია), თვიური მაჩვენებლები (ნორმა / ფაქტი / ზეგანაკვეთი / შესრულება / არყოფნა / ბიულეტენი — წინასწარი → დახურული snapshot),
#   დღიური: ცვლები / „არ გამოცხადდა“, შევსების ნორმის / მორიგის ხარვეზები (გეგმით / ფაქტით), წესები (დასვენება), დასაფარი (დაწყებამდე / გვიან / დაუფარავი / ღია),
#   გაცვლები (დადასტურდა / კოლეგის უარი), დატვირთვა (პაციენტი / ექთანი საათობრივად, ექთნის გარეშე — at-ით), ხედვა (HR / შემდგენი / მენეჯერი / ნახვა / ბუღალტერი / ექთანი),
#   აგრეგატული ხედვა (სახელები / ტიპები არ ჩანს), Bradford (პარამეტრით), Excel (ფურცლები), აუდიტი, მენეჯერული დაფა (rpt_fact_roster → KPI = ანგარიში), „ყურადღება“.
# ბოლოს: პაციენტების ჰოსპიტალიზაცია გაუქმებულია, თანამშრომლები / მომხმარებლები / განყოფილებები გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-roster-reports.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
J='content-type: application/json'
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
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
# PM — წინა (დასრულებული) თვე; CM — მიმდინარე; F1 / F2 — +2 / +3 დღე (გაცვლა); RT — ბოლო თვე, რომელსაც ტესტი ეხება
CM=$(TZ=Asia/Tbilisi date +%Y-%m); PM=$(date -d "$CM-01 -1 month" +%Y-%m)
TODAY=$(TZ=Asia/Tbilisi date +%F); TOMORROW=$(date -d "$TODAY +1 day" +%F); F1=$(date -d "$TODAY +2 day" +%F); F2=$(date -d "$TODAY +3 day" +%F); RT=${F2:0:7}
HH=$(TZ=Asia/Tbilisi date +%H); AT=$(date -u -d '+3 hour' +%FT%TZ); AT_M=$(TZ=Asia/Tbilisi date -d '+3 hour' +%Y-%m)
p()  { printf '%s-%02d' "$PM" "$1"; }
add() { api POST "/roster/rosters/$1/entries" "$2" -d "{\"items\":$3,\"mode\":\"skip\"}"; }
item() { echo "{\"staff_id\":\"$1\",\"day\":\"$2\",\"shift_template_id\":\"$3\"${4:-}}"; }
eid() { api GET "/roster/rosters/$1" "$ADM" | jq -r --arg s "$2" --arg d "$3" '[.entries[]|select(.staff_id==$s and .day==$d)][0].id // empty'; }
rep() { api GET "/roster/reports/summary?$2" "$1"; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0080" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0080" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ანგ. თერაპია $S\",\"code\":\"E2ERA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ანგ. რეანიმაცია $S\",\"code\":\"E2ERB$S\",\"type\":\"inpatient\",\"care_level\":\"icu\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.rr.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ანგ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"phone\":\"5993$2$S4\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.rr.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_PL=$(mkrole rpl "განრიგი (განყ.)" '["roster"]'); R_HR=$(mkrole rhr "HR" '["hr"]'); R_AC=$(mkrole rac "ბუღალტერი" '["accountant"]')
R_MG=$(mkrole rmg "მენეჯერი" '["manager"]'); R_VW=$(mkrole rvw "განრიგის ნახვა" '["roster_view"]'); R_RA=$(mkrole rra "რეპორტინგი (კლინიკა)" '["reports_all"]')
[ -n "$R_PL" ] && [ -n "$R_HR" ] && [ -n "$R_AC" ] && [ -n "$R_MG" ] && [ -n "$R_VW" ] && [ -n "$R_RA" ] || die "როლები ვერ შეიქმნა"
read -r _ PL <<< "$(mkuser "[\"$R_PL\"]" 81 ",\"department_id\":\"$D1\"")"
read -r _ HR <<< "$(mkuser "[\"$R_HR\"]" 82)"
read -r _ AC <<< "$(mkuser "[\"$R_AC\"]" 83)"
read -r _ MG <<< "$(mkuser "[\"$R_MG\"]" 84)"
read -r _ VW <<< "$(mkuser "[\"$R_VW\"]" 85)"
read -r _ RA <<< "$(mkuser "[\"$R_RA\"]" 80)"
read -r U1 N1 <<< "$(mkuser '["nurse"]' 86 ",\"department_id\":\"$D1\"")"
read -r U2 N2 <<< "$(mkuser '["nurse"]' 87 ",\"department_id\":\"$D1\"")"
read -r U3 N3 <<< "$(mkuser '["nurse"]' 88 ",\"department_id\":\"$D2\"")"
read -r UD DOC <<< "$(mkuser '["doctor"]' 89 ",\"department_id\":\"$D1\"")"
[ -n "$PL" ] && [ -n "$HR" ] && [ -n "$AC" ] && [ -n "$MG" ] && [ -n "$VW" ] && [ -n "$RA" ] && [ -n "$N1" ] && [ -n "$N2" ] && [ -n "$N3" ] && [ -n "$DOC" ] \
  && ok "10 მომხმარებელი (შემდგენი D1, HR, ბუღალტერი, მენეჯერი, ნახვა, რეპორტინგი, ექთნები D1 ×2 / D2, ექიმი)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული roster ვერ მოიძებნა"
api PUT /modules/roster "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
mod '{"rest_min_hours":12,"rest_mode":"warn","max_continuous_hours":24,"continuous_mode":"block","max_week_hours":48,"week_mode":"off","max_consecutive_nights":3,"nights_mode":"warn","norm_mode":"warn","cross_department":"warn","publish_notify":false,"change_notify":false,"open_shift_notify":false,"open_shift_volunteer":true,"swap_approval":"head","swap_min_notice_hours":12,"prefs_mode":"off","absence_unit_mode":"weekdays","week_norm_hours":40,"overtime_basis":"month","overtime_default":"pay","night_from":"22:00","night_to":"06:00","close_requires_submit":true,"nurse_ratio":{"ward":8,"intensive":4,"icu":2},"rpt_norm_low_pct":90,"rpt_chronic_ot_months":1,"rpt_open_urgent_hours":48,"rpt_close_late_days":0,"rpt_min_group":3,"rpt_bradford":false,"rpt_sick_types":["SICK"],"dashboard_visibility":"report_users","monthly_section":true}'
ORIG_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
api PUT /modules/inpatient "$ADM" -d '{"settings":{"bed_assign_mode":"direct"},"reason":"ტესტ-E2E"}' >/dev/null
# წინა თვის სამუშაო დღეები (ორშ.–პარ., დღესასწაულის გარეშე)
HOL=$(api GET /roster/holidays "$ADM" | jq -r '.[].day|.[0:10]')
isw() { [ "$(date -d "$1" +%u)" -le 5 ] && ! grep -qx "$1" <<< "$HOL"; }
W=(); x="$PM-01"; while [ "${x:0:7}" = "$PM" ]; do isw "$x" && W+=("$x"); x=$(date -d "$x +1 day" +%F); done
NW=${#W[@]}; DM=$(date -d "$PM-01 +1 month -1 day" +%d); DM=$((10#$DM))
[ "$NW" -ge 18 ] || die "წინა თვეში სამუშაო დღე < 18"
ok "წინა თვე $PM: დღე $DM, სამუშაო დღე $NW; მიმდინარე $CM; ტესტის ბოლო თვე $RT"

step "1. პარამეტრები, წვდომა"
chk "rpt_norm_low_pct = 30 / rpt_chronic_ot_months = 7 / dashboard_visibility = x / rpt_sick_types = ['x'] — 400" "$(code PUT /modules/roster "$ADM" -d '{"settings":{"rpt_norm_low_pct":30},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"rpt_chronic_ot_months":7},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"dashboard_visibility":"x"},"reason":"ტესტ"}'):$(code PUT /modules/roster "$ADM" -d '{"settings":{"rpt_sick_types":["x"]},"reason":"ტესტ"}')" "400:400:400:400"
chk "უფლებები — 45 (ახალი არ ემატება); KPI ჯგუფი roster — 12" "$(api GET /roles/capabilities "$ADM" | jq length):$(api GET /reporting/kpis "$ADM" | jq '[.[]|select(.category=="roster")]|length')" "45:12"
chk "refs.can.reports: შემდგენი / მენეჯერი / ბუღალტერი — true; ექთანი — false" "$(api GET /roster/refs "$PL" | jq .can.reports):$(api GET /roster/refs "$MG" | jq .can.reports):$(api GET /roster/refs "$AC" | jq .can.reports):$(api GET /roster/refs "$N1" | jq .can.reports)" "true:true:true:false"
chk "ანგარიში: ექთანი — 403; პერიოდი > 24 თვე — 400; from > to — 400; at — მხოლოდ admin (403)" "$(code GET "/roster/reports/summary?from=$PM&to=$PM" "$N1"):$(code GET "/roster/reports/summary?from=2020-01&to=$PM" "$HR"):$(code GET "/roster/reports/summary?from=$CM&to=$PM" "$HR"):$(code GET "/roster/reports/summary?from=$PM&to=$PM&at=$AT" "$HR")" "403:400:400:403"
chk "შემდგენი: სხვა განყოფილება — 403; meta — ჩემი განყოფილება" "$(code GET "/roster/reports/summary?from=$PM&to=$PM&department_id=$D2" "$PL"):$(api GET /roster/reports/meta "$PL" | jq -r --arg a "$D1" '"\(.access.named):\([.departments[].id]==[$a])"')" "403:true:true"

step "2. თანამშრომლები, ცნობარები, განრიგები"
REFS=$(api GET /roster/refs "$ADM")
TD=$(echo "$REFS" | jq -r '.templates[]|select(.code=="D").id'); TN=$(echo "$REFS" | jq -r '.templates[]|select(.code=="N").id'); TOC=$(echo "$REFS" | jq -r '.templates[]|select(.code=="OC").id')
TS=$(api GET /roster/absence-types "$ADM" | jq -r '.[]|select(.code=="SICK").id')
PN=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_RN_$S\",\"name\":\"ტესტ-E2E ექთანი\",\"category\":\"nurse\"}" | jq -r '.id // empty')
PD=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_RD_$S\",\"name\":\"ტესტ-E2E ექიმი\",\"category\":\"doctor\"}" | jq -r '.id // empty')
api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$U1\",\"$U2\",\"$U3\"],\"position_id\":\"$PN\"}" >/dev/null
api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$UD\"],\"position_id\":\"$PD\"}" >/dev/null
sid() { api GET "/roster/staff?search=$(jq -rn --arg s "ანგ-$1" '$s|@uri')" "$ADM" | jq -r '.[0].id // empty'; }
S1=$(sid 86); S2=$(sid 87); S3=$(sid 88); SDOC=$(sid 89)
SJ=$(api POST /roster/staff "$ADM" -d "{\"first_name\":\"სანიტარი\",\"last_name\":\"ტესტ-E2E-ანგ\",\"department_id\":\"$D1\",\"personal_number\":\"80$(printf '%09d' "$((10#$S))")\"}" | jq -r '.id // empty')
[ -n "$S1" ] && [ -n "$S2" ] && [ -n "$S3" ] && [ -n "$SDOC" ] && [ -n "$SJ" ] && ok "5 თანამშრომელი (ექთნები D1 ×2 / D2, ექიმი, სანიტარი ანგარიშის გარეშე)" || die "თანამშრომლები ვერ შეიქმნა"
DR=$(api POST /roster/duty-roles "$ADM" -d "{\"code\":\"E2E_RDR_$S\",\"name\":\"ტესტ-E2E მორიგე ექიმი\",\"department_id\":\"$D1\",\"categories\":[\"doctor\"],\"required_count\":1}" | jq -r '.id // empty')
NR=$(api POST /roster/norms "$PL" -d "{\"department_id\":\"$D1\",\"shift_template_id\":\"$TD\",\"category\":\"nurse\",\"min_count\":2}" | jq -r '.id // empty')
[ -n "$DR" ] && [ -n "$NR" ] && ok "მორიგის როლი D1 (1 ექიმი / დღე), შევსების ნორმა D1: D × ექთანი ≥ 2" || die "მორიგის როლი / ნორმა ვერ შეიქმნა"
R1=$(api POST /roster/rosters "$PL" -d "{\"department_id\":\"$D1\",\"month\":\"$PM\"}" | jq -r '.id // empty')
R2=$(api POST /roster/rosters "$ADM" -d "{\"department_id\":\"$D2\",\"month\":\"$PM\"}" | jq -r '.id // empty')
[ -n "$R1" ] && [ -n "$R2" ] || die "განრიგები ვერ შეიქმნა"
DUTY=",\"duty_role_id\":\"$DR\",\"duty_level\":1"
IT=""; for i in $(seq 0 15); do IT+="$(item "$S1" "${W[$i]}" "$TD"),"; done
for i in $(seq 0 4); do IT+="$(item "$S2" "${W[$i]}" "$TD"),"; done
for i in $(seq 0 9); do IT+="$(item "$SDOC" "${W[$i]}" "$TD" "$DUTY"),"; done
J5=$(date -d "${W[5]} +1 day" +%F)
IT+="$(item "$SJ" "${W[5]}" "$TD" ',"start_time":"09:00","end_time":"21:00"'),$(item "$SJ" "$J5" "$TD")"
chk "D1 ($PM): 33 ჩანაწერი (ექთანი 1 — 16 D, ექთანი 2 — 5 D, ექიმი — 10 მორიგე, სანიტარი — 2, 11 სთ დასვენებით)" "$(add "$R1" "$PL" "[$IT]" | jq '.created|length')" "33"
add "$R2" "$ADM" "[$(item "$S3" "${W[3]}" "$TD")]" >/dev/null
chk "გამოქვეყნება: D1 (გაფრთხილებებით — ნორმა / დასვენება), D2 (რჩება დაუხურავი)" "$(api POST "/roster/rosters/$R1/publish" "$PL" -d '{"confirm_warnings":true}' | jq -r .ok):$(api POST "/roster/rosters/$R2/publish" "$ADM" -d '{"confirm_warnings":true}' | jq -r .ok)" "true:true"
chk "ექთანი 2: ბიულეტენი ${W[$((NW-2))]} … ${W[$((NW-1))]} (HR)" "$(api POST /roster/absences "$HR" -d "{\"staff_id\":\"$S2\",\"absence_type_id\":\"$TS\",\"date_from\":\"${W[$((NW-2))]}\",\"date_to\":\"${W[$((NW-1))]}\",\"document_no\":\"E2E-$S4\"}" | jq -r .status)" "approved"
chk "„არ გამოცხადდა“: ექთანი 2 ${W[0]}, ექიმი ${W[9]}" "$(api POST "/roster/entries/$(eid "$R1" "$S2" "${W[0]}")/actual" "$PL" -d '{"status":"no_show","reason":"ტესტ-E2E"}' | jq -r .status):$(api POST "/roster/entries/$(eid "$R1" "$SDOC" "${W[9]}")/actual" "$PL" -d '{"status":"no_show","reason":"ტესტ-E2E"}' | jq -r .status)" "no_show:no_show"
OSA=$(api POST "/roster/rosters/$R1/open-shifts" "$PL" -d "{\"day\":\"${W[12]}\",\"shift_template_id\":\"$TN\",\"category\":\"nurse\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
OSB=$(api POST "/roster/rosters/$R1/open-shifts" "$PL" -d "{\"day\":\"${W[11]}\",\"shift_template_id\":\"$TD\",\"category\":\"nurse\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
chk "დასაფარი ($PM): ${W[12]} N — ღია რჩება; ${W[11]} D → ექთანი 2 (გვიან)" "$([ -n "$OSA" ] && echo ok):$(api POST "/roster/open-shifts/$OSB/assign" "$PL" -d "{\"staff_id\":\"$S2\"}" | jq -r '.entry_id != null')" "ok:true"
# მიმდინარე / შემდეგი თვე: ექთანი 1 — ახლა ცვლაში (3 სთ), F1 D; ექთანი 2 — F2 D; D2 — ექთანი D2 „მორიგეობა სახლიდან“ დღეს (ექთნად არ ითვლება)
ST=$(printf '%02d:00' "$((10#$HH))"); EN=$(printf '%02d:00' "$(( (10#$HH + 3) % 24 ))")
declare -A RM
rmon() { local m=$1 dep=${2:-$D1} k="$1|${2:-$D1}"; [ -n "${RM[$k]:-}" ] || RM[$k]=$(api POST /roster/rosters "$ADM" -d "{\"department_id\":\"$dep\",\"month\":\"$m\"}" | jq -r '.id // empty'); echo "${RM[$k]}"; }
for m in "$CM" "${TOMORROW:0:7}" "${F1:0:7}" "${F2:0:7}" "${AT_M}"; do rmon "$m" >/dev/null; done
rmon "$CM" "$D2" >/dev/null; rmon "$AT_M" "$D2" >/dev/null
add "$(rmon "$CM")" "$ADM" "[$(item "$S1" "$TODAY" "$TD" ",\"start_time\":\"$ST\",\"end_time\":\"$EN\"")]" >/dev/null
add "$(rmon "${F1:0:7}")" "$ADM" "[$(item "$S1" "$F1" "$TD")]" >/dev/null
add "$(rmon "${F2:0:7}")" "$ADM" "[$(item "$S2" "$F2" "$TD")]" >/dev/null
add "$(rmon "$CM" "$D2")" "$ADM" "[$(item "$S3" "$TODAY" "$TOC")]" >/dev/null
PUB=0; for k in "${!RM[@]}"; do [ "$(api POST "/roster/rosters/${RM[$k]}/publish" "$ADM" -d '{"confirm_warnings":true}' | jq -r .ok)" = "true" ] && PUB=$((PUB+1)); done
chk "მიმდინარე / შემდეგი თვის განრიგები გამოქვეყნებულია (${#RM[@]})" "$PUB" "${#RM[@]}"
RTM=$(rmon "${TOMORROW:0:7}")
OSC=$(api POST "/roster/rosters/$RTM/open-shifts" "$PL" -d "{\"day\":\"$TOMORROW\",\"shift_template_id\":\"$TD\",\"category\":\"nurse\"}" | jq -r '.id // empty')
OSD=$(api POST "/roster/rosters/$RTM/open-shifts" "$PL" -d "{\"day\":\"$TOMORROW\",\"shift_template_id\":\"$TD\",\"category\":\"nurse\"}" | jq -r '.id // empty')
chk "დასაფარი ხვალ ($TOMORROW): ერთი → ექთანი 2 (დაწყებამდე), მეორე — ღია" "$(api POST "/roster/open-shifts/$OSC/assign" "$PL" -d "{\"staff_id\":\"$S2\"}" | jq -r '.entry_id != null'):$([ -n "$OSD" ] && echo ok)" "true:ok"
EF1=$(eid "$(rmon "${F1:0:7}")" "$S1" "$F1"); EF2=$(eid "$(rmon "${F2:0:7}")" "$S2" "$F2")
SW1=$(api POST /roster/swaps "$N1" -d "{\"kind\":\"give\",\"from_entry_id\":\"$EF1\",\"to_staff_id\":\"$S2\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
SW2=$(api POST /roster/swaps "$N2" -d "{\"kind\":\"give\",\"from_entry_id\":\"$EF2\",\"to_staff_id\":\"$S1\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
chk "გაცვლა 1: კოლეგა თანახმაა → შემდგენი ადასტურებს; გაცვლა 2: კოლეგა უარს ამბობს" "$(api POST "/roster/swaps/$SW1/peer" "$N2" -d '{"accept":true}' | jq -r .status):$(api POST "/roster/swaps/$SW1/decide" "$PL" -d '{"approve":true,"confirm_warnings":true}' | jq -r .status):$(api POST "/roster/swaps/$SW2/peer" "$N1" -d '{"accept":false,"note":"ტესტ-E2E"}' | jq -r .status)" "head:approved:declined"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1970-01-01\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
ADMIT() { api POST /inpatient/admissions "$ADM" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$UD\",\"source\":\"direct\",\"icd10_code\":\"A41.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
P1=$(mkpat 81 "ანგ-დატვირთვა-1"); P2=$(mkpat 82 "ანგ-დატვირთვა-2")
E1=$(ADMIT "$P1" "$D1"); E2=$(ADMIT "$P2" "$D2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "ჰოსპიტალიზაცია: D1 — 1 პაციენტი (ექთანი ცვლაში), D2 — 1 პაციენტი (ექთანი არ არის)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"

step "3. თვიური მაჩვენებლები ($PM, D1 — წინასწარი)"
NORM=$((32 * NW - 16)); FACT=384; OT=$((192 - 8 * NW)); [ $OT -lt 0 ] && OT=0
pct() { awk -v a="$1" -v b="$2" 'BEGIN { if (b == 0) print "null"; else { x = int(a / b * 1000 + 0.5) / 10; print x } }'; }
X=$(rep "$HR" "from=$PM&to=$PM&department_id=$D1&trend=0")
chk "ადამიანი 4 (დახურული 0), წინასწარი — $PM" "$(echo "$X" | jq -r '"\(.totals.staff):\(.totals.closed_staff):\(.preliminary|join(","))"')" "4:0:$PM"
chk "ნორმა $NORM (4 × $NW × 8 − ბიულ. 2 × 8), ფაქტი $FACT, ჩათვლილი 0, ზეგანაკვეთი $OT" "$(echo "$X" | jq -r '"\(.totals.norm_h):\(.totals.fact_h):\(.totals.credit_h):\(.totals.ot_h)"')" "$NORM:$FACT:0:$OT"
chk "KPI: შესრულება $(pct $FACT $NORM)%, „არ გამოცხადდა“ $(pct 2 34)% (2 / 34), არყოფნა / ბიულეტენი $(pct 2 $((4*NW)))%" "$(echo "$X" | jq -r '.kpi|"\(.roster_norm_fulfil_pct):\(.roster_no_show_pct):\(.roster_absence_pct):\(.roster_sick_pct)"')" "$(pct $FACT $NORM):$(pct 2 34):$(pct 2 $((4*NW))):$(pct 2 $((4*NW)))"
chk "ნორმის ჯგუფები: < 90% — 3 (ექთანი 2, ექიმი, სანიტარი); ზეგანაკვეთი — $([ $OT -gt 0 ] && echo 1 || echo 0)" "$(echo "$X" | jq -r '"\(.norm.buckets.under):\(.norm.buckets.over)"')" "3:$([ $OT -gt 0 ] && echo 1 || echo 0)"
chk "ტოპ ზეგანაკვეთი (სახელობით): ექთანი 1 = $OT" "$(echo "$X" | jq -r --arg s "$S1" '[.overtime.top[]|select(.staff_id==$s)|.ot][0] // 0')" "$OT"
chk "არყოფნა ტიპებით: SICK — 2 სამუშაო დღე, 1 ადამიანი" "$(echo "$X" | jq -r '[.absence.by_type[]|"\(.code)=\(.workdays)/\(.people)"]|join(",")')" "SICK=2/1"
chk "ადამიანი × თვე: ექთანი 2 — ფაქტი 60 (6 D − 1 „გ“), ნორმა $((8*(NW-2)))" "$(echo "$X" | jq -r --arg s "$S2" '.person_months[]|select(.staff_id==$s)|"\(.fact):\(.norm):\(.no_show)"')" "60:$((8*(NW-2))):1"

step "4. დღიური მაჩვენებლები ($PM, D1)"
chk "ცვლები 34, „არ გამოცხადდა“ 2" "$(echo "$X" | jq -r '"\(.totals.shifts):\(.totals.no_show)"')" "34:2"
chk "შევსების ნორმის ხარვეზი: გეგმით $((2*DM-22)), ფაქტით $((2*DM-21))" "$(echo "$X" | jq -r '"\(.totals.norm_gaps_plan):\(.totals.norm_gaps_fact):\(.kpi.roster_norm_gaps)"')" "$((2*DM-22)):$((2*DM-21)):$((2*DM-21))"
chk "მორიგის ხარვეზი: გეგმით $((DM-10)), ფაქტით $((DM-9))" "$(echo "$X" | jq -r '"\(.totals.duty_gaps_plan):\(.totals.duty_gaps_fact):\(.kpi.roster_duty_gaps)"')" "$((DM-10)):$((DM-9)):$((DM-9))"
chk "  … ცხრილი: ნორმა D / ექთანი; მორიგე — დღე (ფაქტით) $((DM-9))" "$(echo "$X" | jq -r '"\(.gaps.by_norm|length):\(.gaps.by_norm[0].category):\(.gaps.by_duty[0].days_fact)"')" "1:nurse:$((DM-9))"
chk "წესები: დასვენება 1 (სანიტარი, 11 სთ), სხვა 0" "$(echo "$X" | jq -r '"\(.totals.viol_rest):\(.totals.viol_continuous):\(.totals.viol_week):\(.totals.viol_nights):\([.rules.people[].name]|join(","))"')" "1:0:0:0:ტესტ-E2E-ანგ სანიტარი"
chk "დასაფარი: 2 (დაწყებამდე 0 / გვიან 1 / დაუფარავი 1), დაწყებამდე 0%" "$(echo "$X" | jq -r '"\(.totals.open_n):\(.totals.open_ontime):\(.totals.open_late):\(.totals.open_unfilled):\(.kpi.roster_open_filled_pct)"')" "2:0:1:1:0"
chk "  … სია: ${W[11]} — გვიან, ${W[12]} — დაუფარავი" "$(echo "$X" | jq -r --arg a "${W[11]}" --arg b "${W[12]}" '"\(.open.list[]|select(.day==$a)|.outcome):\(.open.list[]|select(.day==$b)|.outcome)"')" "late:unfilled"

step "5. მიმდინარე: დასაფარი, გაცვლები, დატვირთვა ($CM … $RT, at = +3 სთ)"
Y=$(rep "$ADM" "from=$CM&to=$RT&department_id=$D1&trend=0")
chk "დასაფარი: დაწყებამდე 1 (100%), ღია (მომავალი) 1 — წილში არ ითვლება" "$(echo "$Y" | jq -r '"\(.totals.open_n):\(.totals.open_ontime):\(.kpi.roster_open_filled_pct):\(.open.totals.pending)"')" "1:1:100:1"
chk "გაცვლები: 2 (დადასტურდა 1, უარი 1); სტატუსები" "$(echo "$Y" | jq -r '"\(.swaps.totals.n):\(.swaps.totals.approved):\(.swaps.totals.refused):\([.swaps.by_status[].key]|sort|join(","))"')" "2:1:1:approved,declined"
if [ "$AT_M" = "$CM" ] || [ "${TOMORROW:0:7}" = "$AT_M" ]; then
  Z=$(rep "$ADM" "from=$CM&to=$AT_M&trend=0&at=$AT")
  L1=$(echo "$Z" | jq -c --arg a "$D1" '.load.by_department[]|select(.department_id==$a)')
  L2=$(echo "$Z" | jq -c --arg a "$D2" '.load.by_department[]|select(.department_id==$a)')
  chk "D1: ექთან-სთ 3, საათები პაციენტით 3, ზღვარზე მეტი 0, ექთნის გარეშე 0, პაციენტი / ექთანი ≤ 1" "$(echo "$L1" | jq -r '"\(.nurse_h):\(.census_h):\(.over_h):\(.nonurse_h):\(.ratio <= 1 and .ratio > 0.5)"')" "3:3:0:0:true"
  chk "D2 (რეანიმაცია, ზღვარი 2): ექთნის გარეშე 3 სთ → ზღვარზე მეტი 100%" "$(echo "$L2" | jq -r '"\(.limit):\(.nurse_h):\(.nonurse_h):\(.over_pct)"')" "2:0:3:100"
else ok "დატვირთვის შემოწმება გამოტოვდა (+3 სთ — შემდეგ თვეში, განრიგის გარეშე)"; ok "—"; fi

step "6. ხედვა: აგრეგატული (მენეჯერი / ნახვა), ბუღალტერი (დახურული)"
M=$(rep "$MG" "from=$PM&to=$PM&department_id=$D1&trend=0")
chk "მენეჯერი: KPI იგივე; სახელობითი სიები ცარიელია; ტიპები — კლასებით" "$(echo "$M" | jq -r '"\(.kpi.roster_norm_fulfil_pct):\(.access.named):\(.overtime.top|length):\(.person_months|length):\(.rules.people|length):\(.absence.types_visible)"')" "$(pct $FACT $NORM):false:0:0:0:false"
chk "  … ბიულეტენი 1 ადამიანზე (< 3) → „ანაზღაურებადში“ ერთიანდება; განყოფილება (4 ადამიანი) — ჩანს" "$(echo "$M" | jq -r --arg a "$D1" '"\([.absence.by_type[].code]|join(",")):\(.by_department[]|select(.department_id==$a)|"\(.sick_masked):\(.roster_sick_pct)")"')" "PAID:false:$(pct 2 $((4*NW)))"
chk "ნახვა (roster_view): 200, სახელობით — არა" "$(rep "$VW" "from=$PM&to=$PM&trend=0" | jq -r .access.named)" "false"
chk "ბუღალტერი: დაუხურავი თვე — ადამიანი 0 (მხოლოდ დახურული)" "$(rep "$AC" "from=$PM&to=$PM&department_id=$D1&trend=0" | jq -r '"\(.access.closedOnly):\(.totals.staff)"')" "true:0"

step "7. თვის დახურვა → snapshot"
chk "წარდგენა (შემდგენი) → დახურვა (HR, გაფრთხილებებით)" "$(code POST "/roster/rosters/$R1/submit" "$PL" -d '{}'):$(api POST "/roster/rosters/$R1/close" "$HR" -d '{"confirm_warnings":true}' | jq -r .ok)" "200:true"
X=$(rep "$HR" "from=$PM&to=$PM&department_id=$D1&trend=0")
chk "დახურული: ადამიანი 4 / 4, წინასწარი — არა; ნორმა / ფაქტი / ზეგანაკვეთი უცვლელი; ანაზღ. = $OT" "$(echo "$X" | jq -r '"\(.totals.staff):\(.totals.closed_staff):\(.preliminary|length):\(.totals.norm_h):\(.totals.fact_h):\(.totals.ot_h):\(.totals.ot_pay_h)"')" "4:4:0:$NORM:$FACT:$OT:$OT"
chk "ბუღალტერი: ახლა ჩანს (4 ადამიანი, სახელობით)" "$(rep "$AC" "from=$PM&to=$PM&department_id=$D1&trend=0" | jq -r '"\(.totals.staff):\(.person_months|length)"')" "4:4"
chk "ქრონიკული ზეგანაკვეთი (≥ 1 დახურული თვე): ექთანი 1 — $([ $OT -gt 0 ] && echo კი || echo არა)" "$(echo "$X" | jq -r --arg s "$S1" '[.overtime.chronic[]|select(.staff_id==$s)]|length')" "$([ $OT -gt 0 ] && echo 1 || echo 0)"
mod '{"rpt_bradford":true}'
chk "Bradford (ჩართული): ექთანი 2 — S 1, D 2, ქულა 2" "$(rep "$HR" "from=$PM&to=$PM&department_id=$D1&trend=0" | jq -r --arg s "$S2" '.absence.bradford[]|select(.staff_id==$s)|"\(.spells):\(.days):\(.score)"')" "1:2:2"
mod '{"rpt_bradford":false}'
chk "ტრენდი — 13 თვე, ბოლო = $PM" "$(rep "$HR" "from=$PM&to=$PM&department_id=$D1" | jq -r '"\(.trend|length):\(.trend[-1].month):\(.trend[-1].roster_norm_fulfil_pct)"')" "13:$PM:$(pct $FACT $NORM)"

step "8. Excel, აუდიტი"
curl -s -o "$TMP/r.xlsx" "$B/roster/reports/export?from=$PM&to=$PM&department_id=$D1" -H "authorization: Bearer $HR"
curl -s -o "$TMP/m.xlsx" "$B/roster/reports/export?from=$PM&to=$PM&department_id=$D1" -H "authorization: Bearer $MG"
chk "xlsx: HR — 13 ფურცელი (ადამიანი × თვე), მენეჯერი — 12" "$(unzip -l "$TMP/r.xlsx" 2>/dev/null | grep -c 'xl/worksheets/sheet'):$(unzip -l "$TMP/m.xlsx" 2>/dev/null | grep -c 'xl/worksheets/sheet')" "13:12"
chk "აუდიტი: ROSTER_REPORT_EXPORT" "$(api GET "/audit-logs?entity_name=roster_reports&limit=20" "$ADM" | jq -r '[.[]|select(.action=="ROSTER_REPORT_EXPORT")]|length >= 2')" "true"

step "9. მენეჯერული დაფა (გადათვლა → KPI = ანგარიში), „ყურადღება“"
RUN=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$PM-01\",\"to\":\"$TODAY\"}" | jq -r '.run_id // empty')
ST2=""; for i in $(seq 1 60); do ST2=$(api GET "/reporting/runs/$RUN" "$ADM" | jq -r .status); [ "$ST2" = "running" ] || break; sleep 2; done
chk "გადათვლა: ok, ფაქტები roster / roster_month" "$ST2:$(api GET "/reporting/runs/$RUN" "$ADM" | jq -r '(.facts.roster > 0) and (.facts.roster_month > 0)')" "ok:true"
PE=$(date -d "$PM-01 +1 month -1 day" +%F)
O=$(api GET "/reporting/overview?from=$PM-01&to=$PE&department_id=$D1" "$ADM")
kv() { echo "$O" | jq -r --arg c "$1" '[.kpis[]?|select(.code==$c)|.value][0]'; }
chk "KPI დაფაზე = ანგარიში: ზეგანაკვეთი / შესრულება / „გ“ % / ნორმის / მორიგის ხარვეზი / დასაფარი %" \
  "$(kv roster_overtime_h):$(kv roster_norm_fulfil_pct):$(kv roster_no_show_pct):$(kv roster_norm_gaps):$(kv roster_duty_gaps):$(kv roster_open_filled_pct)" \
  "$(echo "$X" | jq -r '.kpi|"\(.roster_overtime_h):\(.roster_norm_fulfil_pct):\(.roster_no_show_pct):\(.roster_norm_gaps):\(.roster_duty_gaps):\(.roster_open_filled_pct)"')"
A=$(api GET /reporting/attention "$ADM")
av() { echo "$A" | jq -r --arg k "$1" '[.items[]|select(.kind==$k)|.value][0] // 0'; }
chk "„ყურადღება“: მორიგე დღეს / ხვალ, დასაფარი მალე, ექთნის გარეშე, დაუხურავი ტაბელი — ≥ 1" "$([ "$(av roster_duty_gap)" -ge 1 ] && echo y):$([ "$(av roster_open_urgent)" -ge 1 ] && echo y):$([ "$(av roster_load_none)" -ge 1 ] && echo y):$([ "$(av roster_close_late)" -ge 1 ] && echo y)" "y:y:y:y"
rk() { api GET "/reporting/overview?from=$PM-01&to=$PE" "$RA" | jq '[.kpis[]|select(.category=="roster")]|length'; }
ra() { api GET /reporting/attention "$RA" | jq '[.items[]|select(.kind|startswith("roster"))]|length > 0'; }
chk "რეპორტინგის მომხმარებელი (reports_all): roster KPI 12, „ყურადღება“ ჩანს" "$(rk):$(ra)" "12:true"
mod '{"dashboard_visibility":"roster_only"}'
chk "dashboard_visibility = roster_only → განრიგის / HR უფლების გარეშე — არ ჩანს" "$(rk):$(ra)" "0:false"
mod '{"dashboard_visibility":"report_users"}'

step "გასუფთავება"
for E in $E1 $E2; do api POST "/inpatient/stays/$E/cancel" "$ADM" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
api PATCH "/roster/norms/$NR" "$ADM" -d '{"is_active":false}' >/dev/null; api PATCH "/roster/duty-roles/$DR" "$ADM" -d '{"is_active":false}' >/dev/null
for X in $S1 $S2 $S3 $SDOC $SJ; do api PATCH "/roster/staff/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $PN $PD; do api PATCH "/roster/positions/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/inpatient "$ADM" -d "$(jq -nc --argjson s "$ORIG_IPD" '{settings:$s, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
api PUT /modules/roster "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="roster")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "ჰოსპიტალიზაცია გაუქმებულია; თანამშრომლები, მომხმარებლები, როლები, განყოფილებები გათიშულია (განრიგები / ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
