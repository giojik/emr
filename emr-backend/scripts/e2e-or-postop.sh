#!/usr/bin/env bash
# =====================================================================
# e2e-or-postop.sh — საოპერაციო ბლოკი, ეტაპი 0050: PACU, ბილინგი, სტატისტიკა
#   0. მომზადება (ბლოკი, ოთახები OP1 / OP2, ქირურგია + რეანიმაცია, ტარიფები, მომხმარებლები, პაციენტები ×4)
#   1. პარამეტრები (ვალიდაცია, ნაგულისხმევები)       2. ოპერაციები C1 / C2 (ერთ ოთახში, თანმიმდევრობით) → დასრულება „PACU“ მიმართულებით
#   3. PACU (C1): შემოსვლა, ვიტალები 15-წთ ბადეზე (+ ტკივილი), სითხეები, Aldrete, გამოწერა — ზღვარი, დაფა, დაბლოკვა
#   4. PACU (C2): ICU-ში — ზღვრის გარეშე, გადაყვანის მოთხოვნა → მიღება → ICU ეპიზოდი (წყარო „საოპერაციო“)
#   5. ბილინგი: პროცედურები (all / primary_plus_pct), ანესთეზია (fixed / hourly / off), ხელით ფასი, ოქმის პროცედურები, ტარიფის გარეშე,
#      პაკეტი, თანხების ხილვადობა, ფინალიზაციის ბლოკი (OR_TARIFF_MISSING) → ფინალიზაცია → უცვლელი
#   6. სტატისტიკა: დატვირთვა, პირველი ოპერაცია, turnover, გაუქმებები, გართულებები, PACU, ქირურგები      7. აღდგენა
# გამოყენება:  bash scripts/e2e-or-postop.sh [API_URL]     (admin — ADMIN_EMAIL / ADMIN_PW env-ით ან stdin-ით)
# შენიშვნა: სცენარი იყენებს ბოლო ~3 საათის დროებს — შუაღამის ახლოს (00:00–03:00) სტატისტიკის „დღის“ შემოწმებები შეიძლება გაიყოს.
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
ecode() { echo "$1" | jq -r 'if type=="object" then (.code // .statusCode // "") else "" end' 2>/dev/null; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F); YDAY=$(TZ=Asia/Tbilisi date -d yesterday +%F)
BASE=$(( $(date +%s) / 900 * 900 ))                          # 15 წუთზე დამრგვალებული (PACU ბადე)
T() { date -u -d "@$((BASE - $1 * 60))" +%FT%TZ; }          # T 40 = 40 წუთის წინ (ბადიდან)
N() { date -u -d "@$(( $(date +%s) / 60 * 60 - $1 * 60 ))" +%FT%TZ; }   # N 30 = ახლა − 30 წთ (რეალური დრო)

step "0. მომზადება"
ORIG_OR=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings')
ORIG_ICU=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="icu")|{enabled,settings}')
ORIG_AT=$(api GET /or/anesthesia-tariffs "$ADM")
[ -n "$ORIG_OR" ] && [ "$ORIG_OR" != "null" ] || die "მოდული „or“ ვერ მოიძებნა"
echo "$ORIG_OR" | jq -e 'has("pacu_aldrete_min")' >/dev/null || die "0050-ის პარამეტრები არ არის (migration 0050?)"
echo "$ORIG_AT" | jq -e 'type=="array"' >/dev/null || die "ანესთეზიის ტარიფები (GET /or/anesthesia-tariffs) — 0050?"
ormod() { api PUT /modules/or "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
ormod '{"or_scheduling":"coordinator","anesthesia_team_by":"anesthesia_head","preop_readiness":"warn","turnover_min":30,"default_duration_min":60,"self_booking_days":30,"notify_requests":false,
  "nursing_team_by":"both","room_teams":false,"anesthesia_meds":"direct","preference_cards":"off","count_mode":"off","note_required":[],
  "pacu_aldrete_min":9,"multi_procedure_billing":"all","multi_procedure_pct":50,"anesthesia_billing":"fixed","anesthesia_round_min":15,"first_case_tolerance_min":15}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"bed_assign_mode":"direct","discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/icu "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
dep() { api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"${4:-}}" | jq -r '.id // empty'; }
DBK=$(dep "საოპერაციო (PACU)" E2EOPB or); DS=$(dep "ქირურგია (PACU)" E2EOPS inpatient); DI=$(dep "რეანიმაცია (PACU)" E2EOPI inpatient ',"care_level":"icu"')
DA=$(dep "ანესთეზიოლოგია (PACU)" E2EOPA administrative)
[ -n "$DBK" ] && [ -n "$DS" ] && [ -n "$DI" ] && [ -n "$DA" ] || die "განყოფილებები ვერ შეიქმნა"
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -r '[.types[]?|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end')
WS=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DS\",\"code\":\"P1\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BS=$(api POST "/inpatient/wards/$WS/beds" "$ADM" -d "{\"count\":4,\"type_code\":\"$BT\"}")
WI=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DI\",\"code\":\"I1\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BI1=$(api POST "/inpatient/wards/$WI/beds" "$ADM" -d "{\"count\":1,\"type_code\":\"$BT\"}" | jq -r '.[0].id // empty')
BED() { echo "$BS" | jq -r ".[$1].id // empty"; }
[ -n "$(BED 3)" ] && [ -n "$BI1" ] || die "საწოლები ვერ შეიქმნა"
role() {
  local id; id=$(api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id' | head -1)
  [ -n "$id" ] || api POST /roles "$ADM" -d "{\"code\":\"$1\",\"name\":\"$2\",\"capabilities\":$3}" >/dev/null
  api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.code' | head -1
}
[ "$(role e2e_or_coord 'ტესტ-E2E საოპერაციოს კოორდინატორი' '["or_schedule"]')" = e2e_or_coord ] && [ "$(role e2e_anesth 'ტესტ-E2E ანესთეზიოლოგი' '["anesthesiologist"]')" = e2e_anesth ] \
  && [ "$(role e2e_or_nurse 'ტესტ-E2E საოპერაციო ექთანი' '["or_nurse"]')" = e2e_or_nurse ] && [ "$(role e2e_manager 'ტესტ-E2E მენეჯერი' '["manager"]')" = e2e_manager ] || die "როლები ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.po.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"PO-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.po.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 81); BL=$(mkuser '["billing"]' 82)
SU1=$(mkuser '["doctor"]' 83 ",\"department_id\":\"$DS\""); CO=$(mkuser '["e2e_or_coord"]' 84)
AN=$(mkuser '["e2e_anesth"]' 85 ",\"department_id\":\"$DA\""); ON1=$(mkuser '["e2e_or_nurse"]' 86 ",\"department_id\":\"$DBK\""); ON2=$(mkuser '["e2e_or_nurse"]' 87 ",\"department_id\":\"$DBK\"")
NA1=$(mkuser '["nurse"]' 88 ",\"department_id\":\"$DS\""); NA2=$(mkuser '["nurse"]' 89 ",\"department_id\":\"$DS\"")
NI=$(mkuser '["nurse"]' 90 ",\"department_id\":\"$DI\""); DRI=$(mkuser '["doctor"]' 91 ",\"department_id\":\"$DI\""); MG=$(mkuser '["e2e_manager"]' 92)
for t in RC BL SU1 CO AN ON1 ON2 NA1 NA2 NI DRI MG; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: რეგისტრატორი, ბილინგი, ქირურგი, კოორდინატორი, ანესთეზიოლოგი, საოპერაციო ექთანი ×2, ექთნები, რეანიმაცია (ექთანი + ექიმი), მენეჯერი"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 93 "PO-ქოლე" 1960-01-01 female); P2=$(mkpat 94 "PO-კოლექტ" 1950-02-02 male); P3=$(mkpat 95 "PO-თიაქ" 1980-03-03 male); P4=$(mkpat 96 "PO-გაუქმ" 1990-04-04 female)
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DS\",\"attending_doctor_id\":\"$(uid 83)\",\"source\":\"direct\",\"icd10_code\":\"K80.2\",\"chief_complaint\":\"ტესტ-E2E\",\"bed_id\":\"$2\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$(BED 0)"); E2=$(ADMIT "$P2" "$(BED 1)"); E3=$(ADMIT "$P3" "$(BED 2)"); E4=$(ADMIT "$P4" "$(BED 3)")
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$E3" ] && [ -n "$E4" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
room() { api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"$1\",\"name\":\"$2\",\"work_start\":\"00:00\",\"work_end\":\"23:59\",\"work_days\":[1,2,3,4,5,6,7]}" | jq -r '.id // empty'; }
RO1=$(room OP1 "ოთახი 1 (PACU)"); RO2=$(room OP2 "ოთახი 2 (PACU)")
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"E2EOP$1$S\",\"title\":\"ტესტ-E2E $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_PA=$(tar PA "ლაპ. ქოლეცისტექტომია" 1000); T_PB=$(tar PB "ადჰეზიოლიზისი" 400); T_PC=$(tar PC "ღვიძლის ბიოფსია" 500)
T_AF=$(tar AF "ზოგადი ანესთეზია (ფიქს.)" 300); T_AH=$(tar AH "ზოგადი ანესთეზია (1 სთ)" 120); T_BED=$(tar BED "საწოლდღე (ქირურგია PACU)" 50)
for t in T_PA T_PB T_PC T_AF T_AH T_BED; do [ -n "${!t}" ] || die "ტარიფი $t ვერ შეიქმნა"; done
proc() { api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-OP-$1-$S\",\"name\":\"ტესტ-E2E $2 (PACU)\",\"specialty_code\":\"general\",\"default_duration_min\":60${3:-}}" | jq -r '.id // empty'; }
PA=$(proc PA "ლაპაროსკოპიული ქოლეცისტექტომია" ",\"tariff_id\":\"$T_PA\""); PB=$(proc PB "ადჰეზიოლიზისი" ",\"tariff_id\":\"$T_PB\""); PC=$(proc PC "ღვიძლის ბიოფსია")
[ -n "$PA" ] && [ -n "$PB" ] && [ -n "$PC" ] && [ -n "$RO1" ] && [ -n "$RO2" ] || die "ოთახები / პროცედურები ვერ შეიქმნა"
api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"$BT\",\"department_id\":\"$DS\",\"tariff_id\":\"$T_BED\"}" >/dev/null
ok "ბლოკი, ოთახები OP1 / OP2, ქირურგია + რეანიმაცია (საწოლებით), ტარიფები (PA 1000, PB 400, PC — ტარიფის გარეშე), საწოლდღე 50"

step "1. პარამეტრები"
chk "pacu_aldrete_min=11 / anesthesia_round_min=20 / multi_procedure_billing=x / multi_procedure_pct=150 → 400" \
  "$(code PUT /modules/or "$ADM" -d '{"settings":{"pacu_aldrete_min":11},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"anesthesia_round_min":20},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"multi_procedure_billing":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"multi_procedure_pct":150},"reason":"ტესტ-E2E"}')" "400:400:400:400"
chk "ნაგულისხმევები (migration): 9, all, 50, fixed, 15, 15" "$(echo "$ORIG_OR" | jq -r '"\(.pacu_aldrete_min):\(.multi_procedure_billing):\(.multi_procedure_pct):\(.anesthesia_billing):\(.anesthesia_round_min):\(.first_case_tolerance_min)"')" "9:all:50:fixed:15:15"
chk "ანესთეზიის ტარიფები: ექთანი → 403; admin → ფიქს. + საათობრივი (ზოგადი)" \
  "$(code PUT /or/anesthesia-tariffs "$ON1" -d '{"items":[],"reason":"ტესტ-E2E"}'):$(api PUT /or/anesthesia-tariffs "$ADM" -d "{\"items\":[{\"anesthesia_type\":\"general\",\"mode\":\"fixed\",\"tariff_id\":\"$T_AF\"},{\"anesthesia_type\":\"general\",\"mode\":\"hourly\",\"tariff_id\":\"$T_AH\"}],\"reason\":\"ტესტ-E2E\"}" | jq -r '[.[]|select(.anesthesia_type=="general")]|length')" "403:2"
chk "ანესთეზიის ტარიფები: დუბლი → 400" "$(code PUT /or/anesthesia-tariffs "$ADM" -d "{\"items\":[{\"anesthesia_type\":\"spinal\",\"mode\":\"fixed\",\"tariff_id\":\"$T_AF\"},{\"anesthesia_type\":\"spinal\",\"mode\":\"fixed\",\"tariff_id\":null}],\"reason\":\"ტესტ-E2E\"}")" "400"

step "2. ოპერაციები → დასრულება"
WHO_ITEMS() { api GET "/or/cases/$1" "$ON1" | jq -c --arg p "$2" '[.who_items[]|select(.phase==$p)|{key:.id,value:"yes"}]|from_entries'; }
TM() { api POST "/or/cases/$1/times" "$2" -d "$3"; }
mkcase() { api POST /or/cases "$SU1" -d "{\"encounter_id\":\"$1\",\"urgency\":\"${3:-elective}\",\"anesthesia_type\":\"general\",\"procedures\":$2}" | jq -r '.id // empty'; }
sched() { api POST "/or/cases/$1/schedule" "$CO" -d "{\"room_id\":\"$2\",\"start\":\"$3\",\"duration_min\":30,\"confirm\":true}" | jq -r '.status // .message'; }
# run CASE ROOM in a_start incision closure a_end out  (წუთები BASE-იდან)
run() {
  local c=$1
  TM "$c" "$ON1" "{\"kind\":\"in_room\",\"at\":\"$(T "$2")\",\"readiness_override\":\"ტესტ-E2E: დოკუმენტები ქაღალდზე\"}" >/dev/null
  TM "$c" "$AN" "{\"kind\":\"anesthesia_start\",\"at\":\"$(T "$3")\"}" >/dev/null
  api POST "/or/cases/$c/who" "$ON1" -d "{\"phase\":\"sign_in\",\"answers\":$(WHO_ITEMS "$c" sign_in)}" >/dev/null
  api POST "/or/cases/$c/who" "$SU1" -d "{\"phase\":\"time_out\",\"answers\":$(WHO_ITEMS "$c" time_out)}" >/dev/null
  TM "$c" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(T "$4")\"}" >/dev/null
  TM "$c" "$SU1" "{\"kind\":\"closure\",\"at\":\"$(T "$5")\"}" >/dev/null
  TM "$c" "$AN" "{\"kind\":\"anesthesia_end\",\"at\":\"$(T "$6")\"}" >/dev/null
  api POST "/or/cases/$c/who" "$ON1" -d "{\"phase\":\"sign_out\",\"answers\":$(WHO_ITEMS "$c" sign_out)}" >/dev/null
}
C1=$(mkcase "$E1" "[{\"procedure_id\":\"$PA\",\"is_primary\":true},{\"procedure_id\":\"$PB\"}]"); C2=$(mkcase "$E2" "[{\"procedure_id\":\"$PA\"}]")
C3=$(mkcase "$E3" "[{\"procedure_id\":\"$PB\"}]"); C4=$(mkcase "$E4" "[{\"procedure_id\":\"$PB\"}]")
[ -n "$C1" ] && [ -n "$C2" ] && [ -n "$C3" ] && [ -n "$C4" ] || die "მოთხოვნები ვერ შეიქმნა"
chk "დაგეგმვა: C1 (OP1, −30 წთ), C2 (OP1, +40 წთ), C3 (OP2, −50 წთ), C4 (OP2, +60 წთ)" \
  "$(sched "$C1" "$RO1" "$(N 30)"):$(sched "$C2" "$RO1" "$(N -40)"):$(sched "$C3" "$RO2" "$(N 50)"):$(sched "$C4" "$RO2" "$(N -60)")" "scheduled:scheduled:scheduled:scheduled"
run "$C1" 180 175 165 120 115
R=$(TM "$C1" "$ON1" "{\"kind\":\"out_of_room\",\"at\":\"$(T 110)\",\"destination\":\"pacu\"}")
chk "C1 დასრულდა → PACU (ანესთეზია 60 წთ)" "$(echo "$R" | jq -r '"\(.status):\([.times[]|select(.kind=="out_of_room" and .superseded_by==null)][0].destination)"')" "completed:pacu"
run "$C2" 100 95 90 60 55
chk "C2 დასრულდა → PACU (ანესთეზია 40 წთ; OP1-ში C1-ის შემდეგ 10 წთ-ში)" "$(TM "$C2" "$ON1" "{\"kind\":\"out_of_room\",\"at\":\"$(T 50)\",\"destination\":\"pacu\"}" | jq -r .status)" "completed"
TM "$C3" "$ON1" "{\"kind\":\"in_room\",\"at\":\"$(N 25)\",\"readiness_override\":\"ტესტ-E2E\"}" >/dev/null
chk "C3 — დაიწყო 25 წთ დაგვიანებით (OP2-ის პირველი ოპერაცია)" "$(api GET "/or/cases/$C3" "$ON1" | jq -r .status)" "in_progress"
chk "C4 გაუქმდა (აპარატურა)" "$(api POST "/or/cases/$C4/cancel" "$CO" -d '{"reason_code":"equipment","note":"ტესტ-E2E"}' | jq -r .status)" "cancelled"

step "3. PACU (C1) — შემოსვლა, ვიტალები, Aldrete, გამოწერა"
PV() { api GET "/or/cases/$1/pacu" "$2"; }
chk "შემოსვლამდე: ვიტალები → PACU_NOT_STARTED; can.admit" "$(ecode "$(api POST "/or/cases/$C1/pacu/vitals" "$ON1" -d "{\"at\":\"$(T 105)\",\"heart_rate\":80}")"):$(PV "$C1" "$ON1" | jq -r .can.admit)" "PACU_NOT_STARTED:true"
chk "შემოსვლა: ქირურგი → 403; დაუსრულებელი (C3) → 403/409" "$(code POST "/or/cases/$C1/pacu/admit" "$SU1" -d '{}'):$(code POST "/or/cases/$C3/pacu/admit" "$ON1" -d '{}')" "403:403"
R=$(api POST "/or/cases/$C1/pacu/admit" "$ON1" -d "{\"at\":\"$(T 105)\",\"nurse_id\":\"$(uid 87)\",\"bay\":\"P-1\"}")
chk "შემოსვლა (საოპერაციო ექთანი): ნიშნული pacu_in, ექთანი, ადგილი" "$(echo "$R" | jq -r '"\(.times.pacu_in != null):\(.episode.nurse_id):\(.episode.bay)"')" "true:$(uid 87):P-1"
PVT() { api POST "/or/cases/$C1/pacu/vitals" "$ON2" -d "$1"; }
chk "ვიტალები: ბადის გარეთ (… −100 წთ) → 400; ცარიელი → 400; ტკივილი 11 → 400" \
  "$(code POST "/or/cases/$C1/pacu/vitals" "$ON2" -d "{\"at\":\"$(T 100)\",\"heart_rate\":80}"):$(code POST "/or/cases/$C1/pacu/vitals" "$ON2" -d "{\"at\":\"$(T 90)\"}"):$(code POST "/or/cases/$C1/pacu/vitals" "$ON2" -d "{\"at\":\"$(T 90)\",\"pain\":11}")" "400:400:400"
PVT "{\"at\":\"$(T 105)\",\"systolic_bp\":118,\"diastolic_bp\":68,\"heart_rate\":92,\"spo2\":94,\"respiratory_rate\":18,\"pain\":6,\"o2_supplement\":true}" >/dev/null
R=$(PVT "{\"at\":\"$(T 90)\",\"systolic_bp\":124,\"diastolic_bp\":72,\"heart_rate\":84,\"spo2\":97,\"pain\":3}")
chk "ვიტალები 15-წთ ბადეზე (2), MAP ავტომატურად (118/68 → 85), ტკივილი" "$(echo "$R" | jq -r '[.vitals[]|select(.voided_at==null)]|length'):$(echo "$R" | jq -r '[.vitals[]|select(.systolic_bp==118)][0]|"\(.map_mmhg):\(.pain)"')" "2:85:6"
chk "იგივე სლოტი მეორედ → 409" "$(code POST "/or/cases/$C1/pacu/vitals" "$ON2" -d "{\"at\":\"$(T 90)\",\"heart_rate\":70}")" "409"
api POST "/or/cases/$C1/anesthesia/vitals" "$AN" -d "{\"at\":\"$(T 105)\",\"heart_rate\":95,\"spo2\":95}" >/dev/null
chk "ანესთეზიის რუკა იმავე დროზე — ცალკე ფაზა (რუკა: 1, PACU: 2)" "$(api GET "/or/cases/$C1/anesthesia" "$AN" | jq -r '[.vitals[]|select(.voided_at==null)]|length'):$(PV "$C1" "$ON1" | jq -r '[.vitals[]|select(.voided_at==null)]|length')" "1:2"
VID=$(PV "$C1" "$ON1" | jq -r '[.vitals[]|select(.systolic_bp==124)][0].id')
chk "ვიტალის გაუქმება (მიზეზით) — ანესთეზიის endpoint-ით → 404; PACU-თი → ✓" "$(code POST "/or/anesthesia/vitals/$VID/void" "$AN" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/or/pacu/vitals/$VID/void" "$ON2" -d '{"reason":"ტესტ-E2E: შეცდომა"}' | jq -r '[.vitals[]|select(.voided_at==null)]|length')" "404:1"
PVT "{\"at\":\"$(T 90)\",\"systolic_bp\":122,\"diastolic_bp\":70,\"heart_rate\":82,\"spo2\":97,\"pain\":3}" >/dev/null
api POST "/or/cases/$C1/pacu/fluids" "$ON2" -d "{\"category\":\"iv\",\"volume_ml\":500,\"at\":\"$(T 95)\"}" >/dev/null
R=$(api POST "/or/cases/$C1/pacu/fluids" "$ON2" -d "{\"category\":\"urine\",\"volume_ml\":200,\"at\":\"$(T 80)\"}")
chk "სითხეები → PACU ბალანსი (+500 / −200 = +300); ანესთეზიის ბალანსს არ ეხება" "$(echo "$R" | jq -r '.balance|"\(.in):\(.out):\(.net)"'):$(api GET "/or/cases/$C1/anesthesia" "$AN" | jq -r .balance.in)" "500:200:300:0"
chk "Aldrete: კომპონენტი 3 → 400" "$(code POST "/or/cases/$C1/pacu/scores" "$ON2" -d '{"activity":3,"respiration":2,"circulation":2,"consciousness":2,"oxygenation":2}')" "400"
R=$(api POST "/or/cases/$C1/pacu/scores" "$ON2" -d "{\"at\":\"$(T 85)\",\"activity\":2,\"respiration\":1,\"circulation\":2,\"consciousness\":1,\"oxygenation\":1,\"pain\":4,\"ponv\":true}")
chk "Aldrete 7 (2+1+2+1+1), ტკივილი 4, PONV; მზად არ არის (< 9)" "$(echo "$R" | jq -r '"\(.last_score.total):\(.last_score.pain):\(.ready)"')" "7:4:false"
chk "გამოწერა განყოფილებაში (Aldrete 7 < 9) → ALDRETE_LOW; ნიშნულით (/times) → ALDRETE_LOW" \
  "$(ecode "$(api POST "/or/cases/$C1/pacu/discharge" "$ON1" -d "{\"destination\":\"ward\",\"at\":\"$(T 60)\"}")"):$(ecode "$(TM "$C1" "$ON1" "{\"kind\":\"pacu_out\",\"at\":\"$(T 60)\",\"destination\":\"ward\"}")")" "ALDRETE_LOW:ALDRETE_LOW"
SID=$(api POST "/or/cases/$C1/pacu/scores" "$ON2" -d "{\"at\":\"$(T 70)\",\"activity\":2,\"respiration\":2,\"circulation\":2,\"consciousness\":2,\"oxygenation\":1,\"pain\":2}" | jq -r '[.scores[]|select(.total==9)][0].id')
R=$(api POST "/or/pacu/scores/$SID/void" "$ON2" -d '{"reason":"ტესტ-E2E: არასწორი"}')
chk "Aldrete 9 → გაუქმება (მიზეზით) → ბოლო ისევ 7" "$(echo "$R" | jq -r '"\(.last_score.total):\([.scores[]|select(.voided_at!=null)]|length)"')" "7:1"
B1=$(api GET "/or/pacu?block_id=$DBK" "$ON1")
chk "PACU დაფა: C1 (შემოსული, მზად არა), C2 — მოსალოდნელი (ოთახიდან „PACU“)" "$(echo "$B1" | jq -r --arg a "$C1" --arg b "$C2" '"\(.rows[]|select(.id==$a)|"\(.admitted):\(.ready):\(.bay)"):\(.rows[]|select(.id==$b)|.admitted)"')" "true:false:P-1:false"
api POST "/or/cases/$C1/pacu/scores" "$ON2" -d "{\"at\":\"$(T 62)\",\"activity\":2,\"respiration\":2,\"circulation\":2,\"consciousness\":2,\"oxygenation\":2,\"pain\":2}" >/dev/null
api PUT "/or/cases/$C1/pacu" "$ON1" -d '{"complications":"ტესტ-E2E: PONV — ონდანსეტრონი"}' >/dev/null
chk "დაფა: Aldrete 10 → მზადაა" "$(api GET "/or/pacu?block_id=$DBK" "$ON1" | jq -r --arg a "$C1" '.rows[]|select(.id==$a)|"\(.aldrete):\(.ready)"')" "10:true"
R=$(api POST "/or/cases/$C1/pacu/discharge" "$ON1" -d "{\"destination\":\"ward\",\"at\":\"$(T 60)\",\"note\":\"ტესტ-E2E: სტაბილური\"}")
chk "გამოწერა განყოფილებაში: pacu_out (→ ward), Aldrete 10, გადაყვანის გარეშე (საკუთარი განყოფილება)" "$(echo "$R" | jq -r '"\(.times.pacu_out!=null):\(.times.pacu_destination):\(.episode.discharge_aldrete):\(.episode.transfer_id):\(.warnings|length)"')" "true:ward:10:null:0"
chk "გამოწერის შემდეგ: ვიტალები / შეფასება / რედაქტირება → 409; მეორედ გამოწერა → 409" \
  "$(code POST "/or/cases/$C1/pacu/vitals" "$ON2" -d "{\"at\":\"$(T 45)\",\"heart_rate\":70}"):$(code POST "/or/cases/$C1/pacu/scores" "$ON2" -d '{"activity":2,"respiration":2,"circulation":2,"consciousness":2,"oxygenation":2}'):$(code PUT "/or/cases/$C1/pacu" "$ON1" -d '{"bay":"X"}'):$(code POST "/or/cases/$C1/pacu/discharge" "$ON1" -d '{"destination":"ward"}')" "409:409:409:409"
chk "ისტორია: pacu_score, pacu_score_voided, pacu_discharged; ჰოსპიტალიზაცია: or_pacu_discharged" \
  "$(api GET "/or/cases/$C1" "$ADM" | jq -r '[.events[].kind]|(index("pacu_score")!=null) and (index("pacu_score_voided")!=null) and (index("pacu_discharged")!=null)'):$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[..|objects|select(.kind?=="or_pacu_discharged")]|length>0')" "true:true"
chk "ოპერაციის ბარათი: progress.pacu (გამოწერილი, ward, 10)" "$(api GET "/or/cases/$C1" "$ON1" | jq -r '.progress.pacu|"\(.discharged):\(.destination):\(.aldrete)"')" "true:ward:10"
chk "დაფიდან გავიდა" "$(api GET "/or/pacu?block_id=$DBK" "$ON1" | jq -r --arg a "$C1" '[.rows[]|select(.id==$a)]|length')" "0"

step "4. PACU (C2) → ICU"
api POST "/or/cases/$C2/pacu/admit" "$AN" -d "{\"at\":\"$(T 45)\"}" >/dev/null
api POST "/or/cases/$C2/pacu/vitals" "$AN" -d "{\"at\":\"$(T 45)\",\"systolic_bp\":85,\"diastolic_bp\":50,\"heart_rate\":120,\"spo2\":89,\"pain\":5}" >/dev/null
api POST "/or/cases/$C2/pacu/scores" "$AN" -d "{\"at\":\"$(T 40)\",\"activity\":1,\"respiration\":1,\"circulation\":1,\"consciousness\":1,\"oxygenation\":1}" >/dev/null
chk "ICU — რეანიმაციის განყოფილების გარეშე → 400; ICU განყოფილება „განყოფილებად“ → 400" \
  "$(code POST "/or/cases/$C2/pacu/discharge" "$AN" -d '{"destination":"icu"}'):$(code POST "/or/cases/$C2/pacu/discharge" "$AN" -d "{\"destination\":\"ward\",\"to_department_id\":\"$DI\"}")" "400:400"
R=$(api POST "/or/cases/$C2/pacu/discharge" "$AN" -d "{\"destination\":\"icu\",\"to_department_id\":\"$DI\",\"at\":\"$(T 30)\",\"note\":\"ტესტ-E2E: ჰემოდინამიკა არასტაბილური\"}")
chk "ICU — Aldrete 5 (ზღვრის გარეშე); გადაყვანის მოთხოვნა რეანიმაციაში" "$(echo "$R" | jq -r '"\(.times.pacu_destination):\(.episode.discharge_aldrete):\(.episode.transfer_status):\(.episode.to_department_id)"')" "icu:5:requested:$DI"
TR=$(echo "$R" | jq -r .episode.transfer_id)
chk "მიღება (რეანიმაციის ექთანი) → ICU ეპიზოდი, წყარო — საოპერაციო" \
  "$(api POST "/inpatient/transfers/$TR/accept" "$NI" -d "{\"attending_doctor_id\":\"$(uid 91)\",\"bed_id\":\"$BI1\"}" | jq -r .status):$(api GET "/inpatient/stays/$E2/icu" "$NI" | jq -r '.episode.origin')" "accepted:or"

step "5. ბილინგი"
OB() { api GET "/or/cases/$1/billing" "$2"; }
R=$(OB "$C1" "$BL")
chk "C1 (all, fixed): PA 1000 + PB 400 (ოპერაცია) + ანესთეზია 300 = 1700; აკლია — 0" \
  "$(echo "$R" | jq -r '[.lines[]|"\(.category):\(.unit_price|tonumber+0)"]|sort|join(",")'):$(echo "$R" | jq -r '"\(.total|tonumber+0):\(.missing|length)"')" "anesthesia:300,surgery:1000,surgery:400:1700:0"
chk "საოპერაციო ექთანი: ხაზები ჩანს, თანხები — არა; რეგისტრატორი / მენეჯერი — თანხები" \
  "$(OB "$C1" "$ON1" | jq -r '"\(.lines|length):\(.lines[0].unit_price):\(.total):\(.can.amounts)"'):$(OB "$C1" "$RC" | jq -r .can.amounts):$(OB "$C1" "$MG" | jq -r .can.amounts)" "3:null:null:false:true:true"
IB=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "სტაციონარის ბილინგი: კატეგორიები „ოპერაცია“ 1400, „ანესთეზია“ 300" "$(echo "$IB" | jq -r '[.by_category[]|select(.category=="surgery" or .category=="anesthesia")|"\(.category)=\(.amount|tonumber+0)"]|sort|join(",")')" "anesthesia=300,surgery=1400"
LN1=$(echo "$R" | jq -r '[.lines[]|select(.description|contains("ქოლეცისტექტომია"))][0].id'); INV1=$(echo "$R" | jq -r .invoice.id)
LIDS=$(echo "$R" | jq -r '[.lines[].id]|sort|join(",")')
chk "ხელახლა ნახვა — ხაზები არ იცვლება (იდემპოტენტური)" "$(OB "$C1" "$BL" | jq -r '[.lines[].id]|sort|join(",")')" "$LIDS"
ormod '{"multi_procedure_billing":"primary_plus_pct","multi_procedure_pct":50}' >/dev/null
R=$(OB "$C1" "$BL")
chk "primary_plus_pct 50%: PA 1000, PB 200 (ფასდაკლება — მიზეზით), ჯამი 1500" "$(echo "$R" | jq -r '[.lines[]|select(.category=="surgery")|"\(.unit_price|tonumber+0)/\(.original_price|tonumber+0)"]|sort|join(",")'):$(echo "$R" | jq -r '[.lines[]|select(.discount_reason!=null)][0].discount_reason|test("50%")'):$(echo "$R" | jq -r '.total|tonumber+0')" "1000/1000,200/400:true:1500"
LN1=$(echo "$R" | jq -r '[.lines[]|select(.unit_price|tonumber==1000)][0].id')
api PATCH "/invoices/$INV1/lines/$LN1" "$BL" -d '{"unit_price":900,"discount_reason":"ტესტ-E2E: ხელშეკრულება"}' >/dev/null
ormod '{"multi_procedure_pct":40}' >/dev/null
R=$(OB "$C1" "$BL")
chk "ხელით ფასი (PA 900) ნარჩუნდება გადათვლისას; PB 40% = 160" "$(echo "$R" | jq -r '[.lines[]|select(.category=="surgery")|.unit_price|tonumber+0]|sort|join(",")')" "160,900"
api PUT "/or/cases/$C1/note" "$SU1" -d "{\"postop_icd10_code\":\"K80.2\",\"procedures\":[{\"procedure_id\":\"$PA\",\"is_primary\":true},{\"procedure_id\":\"$PC\"}],\"description\":\"ტესტ-E2E აღწერა\",\"complications\":\"ტესტ-E2E: ნაღვლის ბუშტის პერფორაცია\",\"blood_loss_ml\":50}" >/dev/null
api POST "/or/cases/$C1/note/sign" "$SU1" >/dev/null
R=$(OB "$C1" "$BL")
chk "ოქმი (PA + PC) → ბილინგი ოქმის პროცედურებით: PA (900, ხელით), PC — ტარიფის გარეშე (აკლია 1)" "$(echo "$R" | jq -r '[.lines[]|select(.category=="surgery")|.unit_price|tonumber+0]|join(",")'):$(echo "$R" | jq -r '.missing|length'):$(echo "$R" | jq -r '.missing[0]|test("ტარიფი")')" "900:1:true"
api PUT /billing/bed-tariffs "$BL" -d "{\"bed_type_code\":\"$BT\",\"department_id\":\"$DS\",\"tariff_id\":\"$T_BED\"}" >/dev/null
api POST "/inpatient/stays/$E1/discharge" "$SU1" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 88)\",\"$(uid 89)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
chk "გაწერა → ფინალიზაცია ოპერაციის ტარიფის გარეშე → OR_TARIFF_MISSING" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '.status // .stay.status'):$(ecode "$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")")" "discharged:OR_TARIFF_MISSING"
api PATCH "/or/procedures/$PC" "$ADM" -d "{\"tariff_id\":\"$T_PC\"}" >/dev/null
ormod '{"anesthesia_billing":"hourly","anesthesia_round_min":30}' >/dev/null
R=$(OB "$C1" "$BL")
chk "PC ტარიფი → 40% = 200; ანესთეზია hourly (60 წთ / 30 → 2 × 60); აკლია 0" "$(echo "$R" | jq -r '[.lines[]|"\(.category):\(.quantity)x\(.unit_price|tonumber+0)"]|sort|join(",")'):$(echo "$R" | jq -r '"\(.missing|length):\(.anesthesia.minutes):\(.anesthesia.units)"')" "anesthesia:2x60,surgery:1x200,surgery:1x900:0:60:2"
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ფინალიზაცია ✓ (საწოლდღე + ოპერაცია + ანესთეზია)" "$(echo "$F" | jq -r '.finalized')" "true"
ormod '{"anesthesia_billing":"off"}' >/dev/null
R=$(OB "$C1" "$BL")
chk "ფინალიზებულზე პარამეტრის ცვლილება ხაზებს არ ეხება (ანესთეზია რჩება)" "$(echo "$R" | jq -r '"\(.finalized):\([.lines[]|select(.category=="anesthesia")]|length)"')" "true:1"
chk "anesthesia_billing=off → C2: მხოლოდ ოპერაცია" "$(OB "$C2" "$BL" | jq -r '[.lines[].category]|join(",")')" "surgery"
ormod '{"anesthesia_billing":"hourly","anesthesia_round_min":15}' >/dev/null
chk "C2 hourly / 15: 40 წთ → 3 × 30" "$(OB "$C2" "$BL" | jq -r '[.lines[]|select(.category=="anesthesia")][0]|"\(.quantity)x\(.unit_price|tonumber+0)"')" "3x30"
PK=$(api POST /billing/packages "$BL" -d "{\"code\":\"E2EOPK$S\",\"name\":\"ტესტ-E2E ქოლეცისტექტომიის პაკეტი\",\"price\":1500,\"includes_bed\":false,\"items\":[{\"kind\":\"category\",\"category\":\"surgery\"},{\"kind\":\"category\",\"category\":\"anesthesia\"}]}" | jq -r '.id // empty')
api POST "/inpatient/stays/$E2/billing/package" "$RC" -d "{\"package_id\":\"$PK\"}" >/dev/null
chk "პაკეტი (კატეგორიები ოპერაცია + ანესთეზია) → C2 ხაზები პაკეტში, ჯამი 0" "$(OB "$C2" "$BL" | jq -r '"\([.lines[]|select(.package_included)]|length):\(.total|tonumber+0)"')" "2:0"
chk "პაკეტის კატეგორია surgery — ცნობარში" "$(api GET /billing/packages "$BL" | jq -r --arg p "$PK" '.[]|select(.id==$p)|[.items[].category]|sort|join(",")')" "anesthesia,surgery"

step "6. სტატისტიკა"
ST=$(api GET "/or/stats?from=$YDAY&to=$TODAY&block_id=$DBK" "$CO")
chk "უფლება: ქირურგი → 403; პერიოდი > 366 დღე → 400; from > to → 400" "$(code GET "/or/stats" "$SU1"):$(code GET "/or/stats?from=2020-01-01&to=2022-01-01" "$CO"):$(code GET "/or/stats?from=$TODAY&to=$YDAY" "$CO")" "403:400:400"
chk "ჯამი: დასრულებული 2, მიმდინარე 1" "$(echo "$ST" | jq -r '.totals|"\(.completed):\(.in_progress)"')" "2:1"
chk "საშ. ხანგრძლივობა: ოთახში (70 + 50) / 2 = 60; ოპერაცია (45 + 30) / 2 = 37.5; ანესთეზია (60 + 40) / 2 = 50" "$(echo "$ST" | jq -r '.totals|"\(.avg_room_min):\(.avg_surgery_min):\(.avg_anesthesia_min)"')" "60:37.5:50"
chk "დატვირთვა: OP1 — 2 ოპერაცია, 120 წთ; OP2 — 0" "$(echo "$ST" | jq -r --arg a "$RO1" --arg b "$RO2" '"\(.utilization.rooms[]|select(.room_id==$a)|"\(.cases):\(.used_min)"):\(.utilization.rooms[]|select(.room_id==$b)|.cases)"')" "2:120:0"
chk "პირველი ოპერაცია: 2 (OP1 დროულად, OP2 — 25 წთ დაგვიანებით) → 50%" "$(echo "$ST" | jq -r '.first_case|"\(.total):\(.on_time):\(.on_time_pct):\(.late[0].delay_min >= 24 and .late[0].delay_min <= 26)"')" "2:1:50:true"
chk "მომზადების დრო (turnover): OP1 C1 → C2 = 10 წთ" "$(echo "$ST" | jq -r '.turnover|"\(.count):\(.avg_min):\(.over_target)"')" "1:10:0"
chk "გაუქმებები: 1 (აპარატურა)" "$(echo "$ST" | jq -r '.cancellations|"\([.by_reason[]|select(.code=="equipment")][0].n >= 1):\(.total >= 1)"')" "true:true"
chk "გართულებები: 1 შემთხვევა (ქირურგიული + PACU) — C1" "$(echo "$ST" | jq -r --arg a "$C1" '.complications|"\(.cases):\(.surgical):\(.pacu):\(.list[0].case_id==$a)"')" "1:1:1:true"
chk "PACU: 2 (გამოწერილი 2), საშ. (45 + 15) / 2 = 30 წთ, ward 1 / icu 1, PONV 1, საშ. Aldrete (10 + 5) / 2 = 7.5" "$(echo "$ST" | jq -r '.pacu|"\(.admitted):\(.discharged):\(.avg_los_min):\(.destinations.ward):\(.destinations.icu):\(.ponv):\(.avg_discharge_aldrete)"')" "2:2:30:1:1:1:7.5"
chk "ქირურგები: 2 ოპერაცია, 1 გართულება" "$(echo "$ST" | jq -r --arg s "$(uid 83)" '.by_surgeon[]|select(.surgeon_id==$s)|"\(.cases):\(.complications)"')" "2:1"
chk "მენეჯერი — სტატისტიკა 200" "$(code GET "/or/stats?block_id=$DBK" "$MG")" "200"

step "7. აღდგენა"
api PUT /modules/or "$ADM" -d "{\"settings\":$ORIG_OR,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/icu "$ADM" -d "{\"enabled\":$(echo "$ORIG_ICU" | jq .enabled),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
ITEMS=$(jq -nc --argjson o "$ORIG_AT" '[("general","spinal","epidural","combined","regional","sedation","local","none") as $t | ("fixed","hourly") as $m
  | {anesthesia_type:$t, mode:$m, tariff_id:([ $o[] | select(.anesthesia_type==$t and .mode==$m) | .tariff_id ][0] // null)}]')
api PUT /or/anesthesia-tariffs "$ADM" -d "{\"items\":$ITEMS,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
for r in "$PA" "$PB" "$PC"; do api PATCH "/or/procedures/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done
for t in "$T_PA" "$T_PB" "$T_PC" "$T_AF" "$T_AH" "$T_BED"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
chk "პარამეტრები / ანესთეზიის ტარიფები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings' | jq -S . | md5sum | cut -c1-8):$(api GET /or/anesthesia-tariffs "$ADM" | jq -S '[.[]|{anesthesia_type,mode,tariff_id}]' | md5sum | cut -c1-8)" \
  "$(echo "$ORIG_OR" | jq -S . | md5sum | cut -c1-8):$(echo "$ORIG_AT" | jq -S '[.[]|{anesthesia_type,mode,tariff_id}]' | md5sum | cut -c1-8)"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
