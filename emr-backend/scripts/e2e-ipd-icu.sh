#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-icu.sh — სტაციონარი, ეტაპი 0047: რეანიმაცია (ICU) / ინტენსიური
#   0. მომზადება (ICU, ინტენსიური, განყოფილება; პალატები / საწოლები; მომხმარებლები; პაციენტები)
#   1. განყოფილების დონე, მოდულის პარამეტრები          2. ეპიზოდი (გადაყვანით / მიმღებიდან), წონა, უფლებები
#   3. მონიტორინგის ფურცელი (MAP, GCS, შარდი → ბალანსი), NEWS2 ჩუმად      4. ინტერვალი (15 წთ პაციენტზე)
#   5. ვენტილაცია (ინტუბაცია, პარამეტრები)            6. ვაზოპრესორი: ტიტრაცია, მლ/სთ, MAR, ინფუზიის მოცულობა → ბალანსი
#   7. ABG (POC), SOFA, APACHE II                      8. bundle-ები (VAP / CLABSI)
#   9. ექიმი: ICU დღიური, „ჩასმა“, გაყვანის შეჯამება    10. დაფა            11. ბილინგი: ვენტილაციის დღე
#   12. გადაყვანა / ხელახლა შემოსვლა / გარდაცვალება, სტატისტიკა            13. ინტენსიური (ფუნქციების შეზღუდვა)
#   14. გაუქმება, ადმინისტრირება (bundle-ის პუნქტები, APACHE კატეგორიები)    15. აღდგენა
# გამოყენება:  bash scripts/e2e-ipd-icu.sh [API_URL]
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
uid() { cat "$TMP/u$1" 2>/dev/null; }
ago() { date -u -d "-$1" +%FT%TZ; }
H0=$(date -u -d "@$(( ($(date +%s) / 3600) * 3600 - 4 * 3600 ))" +%FT%TZ)        # 4 სთ-ის წინ, საათის დასაწყისი
at() { date -u -d "$H0 + $1" +%FT%TZ; }

step "0. მომზადება"
DI=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E რეანიმაცია $S\",\"code\":\"E2EICU$S\",\"type\":\"inpatient\",\"care_level\":\"icu\"}" | jq -r '.id // empty')
DN=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ინტენსიური $S\",\"code\":\"E2EINT$S\",\"type\":\"inpatient\",\"care_level\":\"intensive\"}" | jq -r '.id // empty')
DW=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E თერაპია (ICU) $S\",\"code\":\"E2EIW$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DI" ] && [ -n "$DN" ] && [ -n "$DW" ] || die "განყოფილებები ვერ შეიქმნა"
# საწოლის ტიპი: „icu“, თუ აქტიურია; თუ კლინიკამ გათიშა / შეცვალა — პირველი აქტიური ტიპი (ICU-ს ლოგიკა განყოფილების დონეზეა, არა ტიპზე)
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -c ".types // empty")
BTI=$(echo "$BT" | jq -r 'if type=="array" then ([.[]|select(.is_active!=false)|.code] as $a | if ($a|index("icu")) then "icu" else ($a[0] // "standard") end) else "icu" end')
BTW=$(echo "$BT" | jq -r 'if type=="array" then ([.[]|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end) else "standard" end')
[ "$BTI" = "icu" ] || echo "      (საწოლის ტიპი „icu“ არ არის აქტიური — ტესტი იყენებს „$BTI“)"
arr() { echo "$1" | jq -r "if type==\"array\" then (.[$2].id // empty) else empty end"; }
err() { echo "$1" | jq -r 'if type=="object" then (.message|tostring) else . end' 2>/dev/null | head -c 300; }
RW=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DI\",\"code\":\"R1\",\"sex\":\"mixed\"}"); WI=$(echo "$RW" | jq -r '.id // empty')
[ -n "$WI" ] || die "ICU პალატა ვერ შეიქმნა: $(err "$RW")"
RW=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DW\",\"code\":\"T1\",\"sex\":\"mixed\"}"); WW=$(echo "$RW" | jq -r '.id // empty')
[ -n "$WW" ] || die "განყოფილების პალატა ვერ შეიქმნა: $(err "$RW")"
BI=$(api POST "/inpatient/wards/$WI/beds" "$ADM" -d "{\"count\":3,\"type_code\":\"$BTI\"}"); BI1=$(arr "$BI" 0); BI2=$(arr "$BI" 1); BI3=$(arr "$BI" 2)
[ -n "$BI3" ] || die "ICU საწოლები ვერ შეიქმნა (ტიპი $BTI): $(err "$BI")"
BW=$(api POST "/inpatient/wards/$WW/beds" "$ADM" -d "{\"count\":2,\"type_code\":\"$BTW\"}"); BW1=$(arr "$BW" 0); BW2=$(arr "$BW" 1)
[ -n "$BW2" ] || die "განყოფილების საწოლები ვერ შეიქმნა (ტიპი $BTW): $(err "$BW")"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.icu.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ICU-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.icu.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 61)
NI=$(mkuser '["nurse"]' 62 ",\"department_id\":\"$DI\"")
DRI=$(mkuser '["doctor"]' 63 ",\"department_id\":\"$DI\"")
NW=$(mkuser '["nurse"]' 64 ",\"department_id\":\"$DW\"")
DRW=$(mkuser '["doctor"]' 65 ",\"department_id\":\"$DW\"")
NN=$(mkuser '["nurse"]' 66 ",\"department_id\":\"$DN\"")
DRN=$(mkuser '["doctor"]' 67 ",\"department_id\":\"$DN\"")
NI2=$(mkuser '["nurse"]' 68 ",\"department_id\":\"$DI\"")
BL=$(mkuser '["billing"]' 69)
for t in RC NI DRI NW DRW NN DRN NI2 BL; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები (რეგისტრატორი, ICU ექთანი ×2 / ექიმი, განყოფილების ექთანი / ექიმი, ინტენსიურის ექთანი / ექიმი, ბილინგი)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 71 "ICU-სეფსისი" 1960-02-02 male); P2=$(mkpat 72 "ICU-მიმღებიდან" 1950-05-05 female); P3=$(mkpat 73 "ინტენსიური" 1975-03-03 male)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] || die "პაციენტები ვერ შეიქმნა"
ORIG_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
ORIG_ICU=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="icu")|.settings')
[ "$ORIG_ICU" != "" ] && [ "$ORIG_ICU" != "null" ] || die "მოდული „icu“ ვერ მოიძებნა (migration 0047?)"
api PUT /modules/inpatient "$ADM" -d '{"settings":{"med_verification":"off","bed_assign_mode":"direct"},"reason":"ტესტ-E2E"}' >/dev/null
icu() { api PUT /modules/icu "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
icu '{"monitor_interval_min":60,"fast_interval_max_hours":12,"intensive_features":["sheet","infusions","abg","board"],"news2_alerts":false,"infusion_to_balance":true,"titration_reason":true,"vent_billing":true,"vent_day_tariff_id":null,"readmit_hours":48}' >/dev/null
ok "პარამეტრები: ვერიფიკაცია გამორთულია, ფურცელი 60 წთ, ტიტრაციის მიზეზი, ვენტილაციის ბილინგი"

step "1. განყოფილების დონე, მოდულის პარამეტრები"
chk "ამბულატორიული + icu → 400" "$(code POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E X $S\",\"code\":\"E2EIX$S\",\"type\":\"outpatient\",\"care_level\":\"icu\"}")" "400"
chk "სია: დონე icu / intensive / ward" "$(api GET /departments "$ADM" | jq -r --arg a "$DI" --arg b "$DN" --arg c "$DW" '[.[]|select(.id==$a or .id==$b or .id==$c)]|sort_by(.code)|map(.care_level)|join(",")')" "icu,intensive,ward"
R=$(api GET /inpatient/icu/departments "$NI")
chk "ICU განყოფილებები: icu — ყველა ფუნქცია; intensive — 4 (ვენტილაციის გარეშე)" "$(echo "$R" | jq -r --arg a "$DI" --arg b "$DN" '"\(.[]|select(.id==$a)|.features|length):\(.[]|select(.id==$b)|.features|join(","))"')" "9:sheet,infusions,abg,board"
chk "პარამეტრი: უცნობი ფუნქცია → 400; არარსებული ტარიფი → 400; ინტერვალი 20 → 400" \
  "$(code PUT /modules/icu "$ADM" -d '{"settings":{"intensive_features":["foo"]},"reason":"ტესტ-E2E"}'):$(code PUT /modules/icu "$ADM" -d '{"settings":{"vent_day_tariff_id":"00000000-0000-0000-0000-000000000001"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/icu "$ADM" -d '{"settings":{"monitor_interval_min":20},"reason":"ტესტ-E2E"}')" "400:400:400"

step "2. ეპიზოდი"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$3\",\"source\":\"$4\",\"icd10_code\":\"A41.9\",\"chief_complaint\":\"ტესტ-E2E ცხელება, ჰიპოტენზია\"${5:-}}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$DW" "$(uid 65)" direct ",\"bed_id\":\"$BW1\"")
E2=$(ADMIT "$P2" "$DI" "$(uid 63)" emergency ",\"bed_id\":\"$BI2\"")
E3=$(ADMIT "$P3" "$DN" "$(uid 67)" direct)
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$E3" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
ok "3 ჰოსპიტალიზაცია: P1 — თერაპია, P2 — პირდაპირ რეანიმაციაში (სასწრაფოდან), P3 — ინტენსიური"
chk "P1 (თერაპია) — ICU ეპიზოდი არ აქვს" "$(api GET "/inpatient/stays/$E1/icu" "$DRW" | jq -r '.episode')" "null"
chk "P2: ეპიზოდი გაიხსნა ავტომატურად, წყარო — მიმღები / სასწრაფო" "$(api GET "/inpatient/stays/$E2/icu" "$NI" | jq -r '"\(.episode.origin):\(.episode.care_level):\(.episode.readmission)"')" "er:icu:false"
chk "P3: ინტენსიური, წყარო — პირდაპირ" "$(api GET "/inpatient/stays/$E3/icu" "$NN" | jq -r '"\(.episode.origin):\(.episode.care_level)"')" "direct:intensive"
T1=$(api POST "/inpatient/stays/$E1/transfer" "$DRW" -d "{\"to_department_id\":\"$DI\",\"reason\":\"ტესტ-E2E: სეპტიკური შოკი\"}" | jq -r '.id // empty')
R=$(api POST "/inpatient/transfers/$T1/accept" "$NI" -d "{\"attending_doctor_id\":\"$(uid 63)\",\"bed_id\":\"$BI1\"}")
chk "გადაყვანა თერაპიიდან რეანიმაციაში → accepted" "$(echo "$R" | jq -r .status)" "accepted"
V=$(api GET "/inpatient/stays/$E1/icu" "$NI")
EP1=$(echo "$V" | jq -r '.episode.id // empty')
chk "P1: ეპიზოდი — წყარო „განყოფილება“ (თერაპია), ფუნქციები 9" "$(echo "$V" | jq -r '"\(.episode.origin):\(.episode.from_department_name|test("თერაპია")):\(.features|length)"')" "ward:true:9"
chk "ისტორიაში icu_in" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="icu_in")]|length')" "1"
chk "წონა: თერაპიის ექთანი → 403; ICU ექთანი → 80 კგ; წყარო ხელით „საოპერაციო“" \
  "$(code PATCH "/inpatient/icu/episodes/$EP1" "$NW" -d '{"admission_weight_kg":80}'):$(api PATCH "/inpatient/icu/episodes/$EP1" "$NI" -d '{"admission_weight_kg":80,"reason":"სეპტიკური შოკი"}' | jq -r '.admission_weight_kg|tonumber+0')" "403:80"
chk "გასვლის მდგომარეობა — ღია ეპიზოდზე 409; ექთანი → 403" "$(code PATCH "/inpatient/icu/episodes/$EP1" "$DRI" -d '{"exit_condition":"improved"}'):$(code PATCH "/inpatient/icu/episodes/$EP1" "$NI" -d '{"exit_condition":"improved"}')" "409:403"

step "3. მონიტორინგის ფურცელი"
OB="/inpatient/stays/$E1/icu/observations"
chk "თერაპიის ექთანი → 403; რეგისტრატორი → 403" "$(code POST "$OB" "$NW" -d '{"heart_rate":100}'):$(code POST "$OB" "$RC" -d '{"heart_rate":100}')" "403:403"
chk "ცარიელი → 400; GCS არასრული → 400; ინტუბირებული + V → 400" \
  "$(code POST "$OB" "$NI" -d '{}'):$(code POST "$OB" "$NI" -d '{"gcs_e":3}'):$(code POST "$OB" "$NI" -d '{"gcs_e":3,"gcs_v":2,"gcs_m":5,"gcs_intubated":true}')" "400:400:400"
R=$(api POST "$OB" "$NI" -d "{\"systolic_bp\":100,\"diastolic_bp\":55,\"heart_rate\":118,\"respiratory_rate\":26,\"spo2\":94,\"temperature\":38.0,\"cvp\":10,\"gcs_e\":3,\"gcs_m\":5,\"gcs_intubated\":true,\"rass\":-2,\"pupil_l\":3,\"pupil_r\":3,\"pupil_l_react\":\"brisk\",\"pupil_r_react\":\"brisk\",\"urine_ml\":150}")
chk "ჩანაწერი: MAP ავტომატურად 70, GCS 9 (E3 VT M5), ICU ფურცელი" "$(echo "$R" | jq -r '"\(.map_mmhg):\(.gcs_total):\(.icu_sheet)"')" "70:9:true"
VID=$(echo "$R" | jq -r '.id')
R=$(api POST "$OB" "$NI" -d "{\"map_mmhg\":58,\"map_invasive\":true,\"heart_rate\":125}")
chk "არტერიული MAP 58 (ინვაზიური)" "$(echo "$R" | jq -r '"\(.map_mmhg):\(.map_invasive)"')" "58:true"
SH=$(api GET "/inpatient/stays/$E1/icu/sheet" "$NI")
chk "ფურცელი: 24 სლოტი (60 წთ), 2 ჩანაწერი, შარდი 150 ბალანსში" "$(echo "$SH" | jq -r '"\(.slots|length):\(.vitals|length):\(.balance|map(.by.urine // 0)|add)"')" "24:2:150"
chk "ექთნის ხედშიც ჩანს (ვიტალები, შარდი fluid_entries-ში, vitals_id)" "$(api GET "/inpatient/stays/$E1/nursing?days=1" "$NI" | jq -r --arg v "$VID" '"\([.vitals[]|select(.icu_sheet)]|length):\([.fluid.entries[]|select(.vitals_id==$v)]|length)"')" "2:1"
BEFORE=$(api GET /notifications "$DRI" | jq -r '[.[]|select(.kind=="ipd_news2")]|length')
api POST "/inpatient/stays/$E1/vitals" "$NI" -d '{"respiratory_rate":30,"spo2":88,"o2_supplement":true,"systolic_bp":85,"heart_rate":135,"consciousness":"V","temperature":39.5}' >/dev/null
chk "NEWS2 მაღალი, მაგრამ რეანიმაციაში შეტყობინება არ იგზავნება (news2_alerts = false)" "$(api GET /notifications "$DRI" | jq -r '[.[]|select(.kind=="ipd_news2")]|length')" "$BEFORE"

step "4. ფურცლის ინტერვალი"
chk "ექთანი → 403; ექიმი: 15 წთ, 80 სთ → 400 (მაქს. 12)" "$(code POST "/inpatient/icu/episodes/$EP1/interval" "$NI" -d '{"interval_min":15,"hours":2}'):$(code POST "/inpatient/icu/episodes/$EP1/interval" "$DRI" -d '{"interval_min":15,"hours":13}')" "403:400"
R=$(api POST "/inpatient/icu/episodes/$EP1/interval" "$DRI" -d '{"interval_min":15,"hours":2,"reason":"ვაზოპრესორის ტიტრაცია"}')
chk "ექიმი: 15 წთ 2 სთ-ით" "$(echo "$R" | jq -r '.monitor_interval_min')" "15"
SH=$(api GET "/inpatient/stays/$E1/icu/sheet" "$NI")
# ფანჯარა შეიძლება ფურცლის დღის ბოლოს დაიწყოს (fluid_day_start-მდე < 15 წთ) — მაშინ 15-წუთიანი სლოტები მომდევნო დღის ფურცელშია
MORE=$(echo "$SH" | jq -r '.slots|length > 24')
[ "$MORE" = "true" ] || MORE=$(api GET "/inpatient/stays/$E1/icu/sheet?day=$(date -d "$(echo "$SH" | jq -r .day) + 1 day" +%F)" "$NI" | jq -r '.slots|length > 24')
chk "ფურცელი: მიმდინარე ინტერვალი 15, სლოტები > 24" "$(echo "$SH" | jq -r '.interval_min'):$MORE" "15:true"
chk "გაუქმება (ნაგულისხმევზე) → 60" "$(api POST "/inpatient/icu/episodes/$EP1/interval" "$DRI" -d '{"interval_min":null}' | jq -r '.monitor_interval_min'):$(api GET "/inpatient/stays/$E1/icu" "$NI" | jq -r '.interval_min')" "null:60"

step "5. ვენტილაცია"
VE="/inpatient/stays/$E1/icu/ventilation"
chk "NIV + ტუბი → 400; HFNC + ნიღაბი → 400" "$(code POST "$VE" "$DRI" -d '{"kind":"niv","airway":"ett"}'):$(code POST "$VE" "$DRI" -d '{"kind":"hfnc","airway":"mask"}')" "400:400"
R=$(api POST "$VE" "$DRI" -d "{\"kind\":\"invasive\",\"airway\":\"ett\",\"started_at\":\"$(ago '40 min')\",\"ett_size\":8,\"ett_depth_cm\":22,\"attempts\":1,\"settings\":{\"recorded_at\":\"$(ago '40 min')\",\"mode\":\"VC-AC\",\"fio2\":80,\"peep\":8,\"vt_ml\":450,\"rate_set\":16}}")
VENT=$(echo "$R" | jq -r '.id // empty')
chk "ინტუბაცია: ETT 8 / 22 სმ, შემსრულებელი — ექიმი" "$(echo "$R" | jq -r '"\(.ett_size|tonumber+0):\(.ett_depth_cm|tonumber+0):\(.performed_by)"')" "8:22:$(uid 63)"
chk "მეორე ღია ვენტილაცია → 409" "$(code POST "$VE" "$DRI" -d '{"kind":"niv","airway":"mask"}')" "409"
VS2=$(api POST "/inpatient/icu/ventilation/$VENT/settings" "$NI" -d "{\"recorded_at\":\"$(ago '25 min')\",\"mode\":\"VC-AC\",\"fio2\":60,\"peep\":10,\"vt_ml\":450,\"rate_set\":18,\"ppeak\":28,\"pplat\":24}" | jq -r '.id // empty')
[ -n "$VS2" ] && ok "პარამეტრები (ექთანი): FiO₂ 60, PEEP 10" || bad "ვენტილაციის პარამეტრები" ""
chk "პარამეტრი დაწყებამდე → 400; FiO₂ 15 → 400" "$(code POST "/inpatient/icu/ventilation/$VENT/settings" "$NI" -d "{\"recorded_at\":\"$(ago '2 hours')\",\"mode\":\"VC-AC\"}"):$(code POST "/inpatient/icu/ventilation/$VENT/settings" "$NI" -d '{"mode":"VC-AC","fio2":15}')" "400:400"
V=$(api GET "/inpatient/stays/$E1/icu" "$NI")
chk "ხედი: მიმდინარე ვენტილაცია + ბოლო პარამეტრები (FiO₂ 60)" "$(echo "$V" | jq -r '"\(.current_vent.kind):\(.last_settings.fio2)"')" "invasive:60"
chk "ისტორიაში vent_started" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="vent_started")]|length')" "1"

step "6. ვაზოპრესორი: ტიტრაცია"
OR="/inpatient/stays/$E1/orders"
NE() { jq -nc --arg s "$(at '-10 min')" "{category:\"medication\",drug_text:\"Norepinephrine 4 mg/50 ml (E2E)\",order_type:\"continuous\",route_code:\"IV\",dose_rate:0.1,dose_rate_unit:\"mcg/kg/min\",conc_amount:4,conc_unit:\"mg\",conc_volume_ml:50,titratable:true,titrate_min:0.05,titrate_max:0.5,titrate_goal:\"MAP ≥ 65\",start_at:\$s} + $1"; }
chk "ერთეულები შეუთავსებელი (ერთ./სთ + მგ) → 400; დიაპაზონის გარეთ → 400; არა-უწყვეტი → 400" \
  "$(code POST "$OR" "$DRI" -d "$(NE '{dose_rate_unit:"units/h"}')"):$(code POST "$OR" "$DRI" -d "$(NE '{dose_rate:0.8}')"):$(code POST "$OR" "$DRI" -d "$(NE '{order_type:"once",dose:1,dose_unit:"mg"}')")" "400:400:400"
R=$(api POST "$OR" "$DRI" -d "$(NE '{}')")
ONE=$(echo "$R" | jq -r '.id // empty')
chk "დანიშნულება: 0.1 მკგ/კგ/წთ × 80 კგ, 4 მგ/50 მლ → 6 მლ/სთ (წონა — ეპიზოდიდან)" "$(echo "$R" | jq -r '"\(.rate_ml_h|tonumber+0):\(.weight_kg|tonumber+0):\(.titratable)"')" "6:80:true"
ADMN="/inpatient/orders/$ONE/administer"
R=$(api POST "$ADMN" "$NI" -d "{\"outcome\":\"given\",\"infusion_action\":\"start\",\"documented_at\":\"$H0\"}")
chk "MAR: დაწყება — 0.1 / 6 მლ/სთ" "$(echo "$R" | jq -r '"\(.dose_rate|tonumber+0):\(.rate_ml_h|tonumber+0)"')" "0.1:6"
chk "სიჩქარის ცვლილება მიზეზის გარეშე → 400" "$(code POST "$ADMN" "$NI" -d "{\"outcome\":\"given\",\"infusion_action\":\"rate\",\"dose_rate\":0.2,\"documented_at\":\"$(at '1 hour')\"}")" "400"
R=$(api POST "$ADMN" "$NI" -d "{\"outcome\":\"given\",\"infusion_action\":\"rate\",\"dose_rate\":0.2,\"reason\":\"MAP 58\",\"documented_at\":\"$(at '1 hour')\"}")
chk "0.2 მკგ/კგ/წთ → 12 მლ/სთ (მიზეზით)" "$(echo "$R" | jq -r '"\(.rate_ml_h|tonumber+0):\(.reason)"')" "12:MAP 58"
R=$(curl -s -X POST "$B$ADMN" -H "authorization: Bearer $NI" -H "$J" -d "{\"outcome\":\"given\",\"infusion_action\":\"rate\",\"dose_rate\":0.8,\"reason\":\"MAP 50\",\"documented_at\":\"$(at '2 hours')\"}")
chk "0.8 — დიაპაზონს გარეთ → 409 MAR_CHECKS (titration_range)" "$(echo "$R" | jq -r '"\(.code):\(.checks[0].code)"')" "MAR_CHECKS:titration_range"
R=$(api POST "$ADMN" "$NI" -d "{\"outcome\":\"given\",\"infusion_action\":\"rate\",\"dose_rate\":0.8,\"reason\":\"MAP 50\",\"override_reason\":\"ექიმის ზეპირი მითითება\",\"documented_at\":\"$(at '2 hours')\"}")
M3=$(echo "$R" | jq -r '.id // empty')
chk "დასაბუთებით → 48 მლ/სთ" "$(echo "$R" | jq -r '.rate_ml_h|tonumber+0')" "48"
chk "მლ/სთ-ით ცვლილება → დოზა ავტომატურად (12 მლ/სთ → 0.2)" "$(api POST "$ADMN" "$NI" -d "{\"outcome\":\"given\",\"infusion_action\":\"rate\",\"rate_ml_h\":12,\"reason\":\"MAP 70\",\"documented_at\":\"$(ago '1 min')\"}" | jq -r '.dose_rate|tonumber+0')" "0.2"
autovol() { api GET "/inpatient/stays/$E1/icu/sheet" "$NI" >/dev/null; api GET "/inpatient/stays/$E1/nursing?days=1" "$NI" | jq -r --arg o "$ONE" '[.fluid.entries[]|select(.order_id==$o and .auto_hour!=null and .voided_at==null)|.volume_ml|tonumber]|"\(length):\(add // 0)"'; }
chk "ინფუზიის მოცულობა → ბალანსი: 4 დასრულებული საათი, 6 + 12 + 48 + 48 = 114 მლ" "$(autovol)" "4:114"
chk "განმეორებით — იგივე (იდემპოტენტური)" "$(autovol)" "4:114"
api POST "/inpatient/mar/$M3/void" "$NI" -d '{"reason":"ტესტ-E2E: შეცდომით ჩაიწერა"}' >/dev/null
chk "MAR-ის გაუქმება → გადათვლა: 6 + 12 + 12 + 12 = 42 მლ" "$(autovol)" "4:42"
SH=$(api GET "/inpatient/stays/$E1/icu/sheet?day=$(echo "$SH" | jq -r .day)" "$NI")
chk "ფურცელი: ინფუზია — მიმდინარე 12 მლ/სთ, 0.2 მკგ/კგ/წთ" "$(echo "$SH" | jq -r --arg o "$ONE" '.infusions[]|select(.id==$o)|"\(.current_rate_ml_h):\(.current_dose_rate)"')" "12:0.2"

step "7. ABG, SOFA, APACHE II"
chk "ABG ცარიელი → 400" "$(code POST "/inpatient/stays/$E1/icu/abg" "$NI" -d '{"sao2":95}')" "400"
ABG=$(api POST "/inpatient/stays/$E1/icu/abg" "$NI" -d "{\"ph\":7.30,\"pco2\":45,\"po2\":90,\"hco3\":22,\"lactate\":4.2,\"na\":134,\"k\":4.1}" | jq -r '.id // empty')
[ -n "$ABG" ] && ok "ABG (POC): pH 7.30, pO₂ 90, ლაქტატი 4.2" || bad "ABG" ""
V=$(api GET "/inpatient/stays/$E1/icu" "$NI")
chk "ABG: FiO₂ ვენტილატორიდან (60) → P/F 150" "$(echo "$V" | jq -r '[.abg[]|select(.source=="poc")][-1]|"\(.fio2):\(.fio2_source):\(.pf)"')" "60:vent:150"
R=$(api GET "/inpatient/stays/$E1/icu/scores/sofa/draft" "$DRI")
chk "SOFA (მონახაზი): სუნთქვა 3 (P/F 150 + ვენტილაცია), ცირკ. 4 (ნორეპინეფრინი > 0.1), ცნს 3 (GCS 9), თირკმ. 4 (შარდი < 200)" \
  "$(echo "$R" | jq -r '[.components[]|select(.key=="resp" or .key=="cv" or .key=="cns" or .key=="renal")|"\(.key)=\(.points)"]|join(",")')" "resp=3,cv=4,cns=3,renal=4"
chk "SOFA: ლაბ. არ არის → კოაგულაცია / ღვიძლი „დაუდგენელი“ (ნორმად არ ითვლება), ჯამი 14" "$(echo "$R" | jq -r '"\(.missing|join(",")):\(.total)"')" "coag,liver:14"
chk "ექთანი ვერ ადასტურებს (403); დაუდგენელით, დადასტურების გარეშე → 409 SCORE_MISSING" \
  "$(code POST "/inpatient/stays/$E1/icu/scores" "$NI" -d '{"kind":"sofa"}'):$(curl -s -X POST "$B/inpatient/stays/$E1/icu/scores" -H "authorization: Bearer $DRI" -H "$J" -d '{"kind":"sofa"}' | jq -r .code)" "403:SCORE_MISSING"
R=$(api POST "/inpatient/stays/$E1/icu/scores" "$DRI" -d '{"kind":"sofa","overrides":{"platelets":120},"accept_missing":true,"note":"ტესტ-E2E"}')
SOFA=$(echo "$R" | jq -r '.id // empty')
chk "SOFA დადასტურდა: თრომბოციტები ხელით 120 (1) → ჯამი 15, დაუდგენელი — ღვიძლი" "$(echo "$R" | jq -r '"\(.total):\(.missing|join(",")):\(.components.coag.source)"')" "15:liver:manual"
chk "იმავე დღის მეორე SOFA → 409" "$(code POST "/inpatient/stays/$E1/icu/scores" "$DRI" -d '{"kind":"sofa","accept_missing":true}')" "409"
R=$(api GET "/inpatient/stays/$E1/icu/scores/apache2/draft?category=n_cv_sepsis" "$DRI")
chk "APACHE II (მონახაზი): პირველი 24 სთ არ გასულა; დაუდგენელი — კრეატ., Hct, WBC" "$(echo "$R" | jq -r '"\(.incomplete):\(.missing|sort|join(","))"')" "true:creatinine,hct,wbc"
chk "A-aDO₂ (FiO₂ ≥ 50%) = 282 → 2 ქულა" "$(echo "$R" | jq -r '.components[]|select(.key=="oxy")|"\(.value):\(.points)"')" "282:2"
R=$(api POST "/inpatient/stays/$E1/icu/scores" "$DRI" -d '{"kind":"apache2","overrides":{"creatinine":1.0,"hct":35,"wbc":12},"accept_missing":true,"apache":{"category":"n_cv_sepsis","chronic_health":false}}')
APA=$(echo "$R" | jq -r '.id // empty')
chk "APACHE II: 23 ქულა (ტ° 39.5 → 3, ასაკი 66 → 5), სიკვდილობის რისკი 48.9% (სეფსისი)" "$(echo "$R" | jq -r '"\(.total):\(.predicted_mortality|tonumber+0)"')" "23:48.9"
chk "APACHE II ეპიზოდზე მეორედ → 409" "$(code POST "/inpatient/stays/$E1/icu/scores" "$DRI" -d '{"kind":"apache2","accept_missing":true}')" "409"
chk "ისტორიაში icu_score ×2" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="icu_score")]|length')" "2"

step "8. bundle-ები"
V=$(api GET "/inpatient/stays/$E1/icu" "$NI")
chk "VAP ეხება (ინვაზიური ვენტილაცია), CLABSI — არა (ცენტრ. ხაზი არ არის)" "$(echo "$V" | jq -r '"\(.applicable.vap):\(.applicable.clabsi):\(.bundle_due.vap)"')" "true:false:true"
api POST "/inpatient/stays/$E1/lines" "$NI" -d '{"kind":"cvc","site":"v. jugularis interna dextra","size":"7Fr"}' >/dev/null
chk "ცენტრალური ვენა ჩაიდგა → CLABSI ეხება" "$(api GET "/inpatient/stays/$E1/icu" "$NI" | jq -r '.applicable.clabsi')" "true"
VAPI=$(echo "$V" | jq -c '[.bundle_items[]|select(.bundle=="vap")|.id]')
ANS() { echo "$VAPI" | jq -c --arg a "$1" --arg l "$2" 'to_entries|map({key:.value,value:(if .key==0 then $l else $a end)})|from_entries'; }
chk "არასრული → 400; „არა“ შენიშვნის გარეშე → 400" "$(code POST "/inpatient/stays/$E1/icu/bundles" "$NI" -d '{"bundle":"vap","answers":{}}'):$(code POST "/inpatient/stays/$E1/icu/bundles" "$NI" -d "{\"bundle\":\"vap\",\"answers\":$(ANS yes no)}")" "400:400"
R=$(api POST "/inpatient/stays/$E1/icu/bundles" "$NI" -d "{\"bundle\":\"vap\",\"answers\":$(ANS yes no),\"note\":\"საწოლის თავი 20° — პროცედურის გამო\"}")
BUN=$(echo "$R" | jq -r '.id // empty')
chk "VAP: ერთი „არა“ შენიშვნით → compliant = false" "$(echo "$R" | jq -r '.compliant')" "false"
chk "დღეს მეორედ → 409" "$(code POST "/inpatient/stays/$E1/icu/bundles" "$NI" -d "{\"bundle\":\"vap\",\"answers\":$(ANS yes yes)}")" "409"
chk "გაუქმება (ავტორი) → თავიდან ჩაწერა: compliant = true" "$(api POST "/inpatient/icu/bundle/$BUN/void" "$NI" -d '{"reason":"ტესტ-E2E: გადამოწმდა"}' | jq -r .voided):$(api POST "/inpatient/stays/$E1/icu/bundles" "$NI" -d "{\"bundle\":\"vap\",\"answers\":$(ANS yes yes)}" | jq -r .compliant)" "true:true"
chk "ხედი: VAP დღეს შესრულებულია, CLABSI — ელოდება" "$(api GET "/inpatient/stays/$E1/icu" "$NI" | jq -r '"\(.bundle_due.vap):\(.bundle_due.clabsi)"')" "false:true"

step "9. ექიმი: ICU დღიური, „ჩასმა“, გაყვანის შეჯამება"
R=$(api GET "/inpatient/stays/$E1/icu/insert" "$DRI")
chk "„ჩასმა“: B — ინვაზიური ვენტილაცია, FiO₂ 60; C — ინფუზია მლ/სთ; F — ბალანსი; შეფასება — SOFA 15" \
  "$(echo "$R" | jq -r '"\(.b_breathing|test("ინვაზიური.*FiO₂ 60")):\(.c_circulation|test("მლ/სთ")):\(.f_fluids|test("ბალანსი")):\(.assessment|test("SOFA 15"))"')" "true:true:true:true"
chk "ექთანი „ჩასმას“ ვერ იღებს (403)" "$(code GET "/inpatient/stays/$E1/icu/insert" "$NI")" "403"
R=$(api POST "/inpatient/stays/$E1/notes" "$DRI" -d "$(echo "$R" | jq -c '{kind:"icu_daily",content:{a_airway:.a_airway,b_breathing:.b_breathing,c_circulation:.c_circulation,f_fluids:.f_fluids,assessment:"სეპტიკური შოკი, ვაზოპრესორზე; SOFA 15",plan:"ტიტრაცია MAP ≥ 65"},sign:true}')")
chk "ICU დღიური (A–F) — ხელმოწერილი" "$(echo "$R" | jq -r '"\(.kind):\(.status)"')" "icu_daily:signed"
chk "ICU დღიური შეფასების გარეშე → ხელმოწერა 400" "$(code POST "/inpatient/stays/$E1/notes" "$DRI" -d '{"kind":"icu_daily","content":{"a_airway":"ETT"},"sign":true}')" "400"
chk "ჩანაწერების სია: ველების სქემაში icu_daily (8 ველი) და icu_out" "$(api GET "/inpatient/stays/$E1/notes" "$DRI" | jq -r '"\(.fields.icu_daily|length):\(.fields.icu_out|length)"')" "8:4"

step "10. რეანიმაციის დაფა"
R=$(api GET "/inpatient/icu/board?department_id=$DI" "$NI")
P=$(echo "$R" | jq -c --arg e "$E1" '.patients[]|select(.encounter_id==$e)')
chk "დაფა: P1 — ვენტილაცია (VC-AC, FiO₂ 60), ინფუზია 12 მლ/სთ, SOFA 15, MAP 58 → გაფრთხილება" \
  "$(echo "$P" | jq -r '"\(.vent.mode):\(.vent.fio2):\(.infusions[0].rate_ml_h):\(.sofa.total):\([.alerts[].text|select(test("MAP"))]|length)"')" "VC-AC:60:12:15:1"
chk "დაფა: P2 — „წონა არ არის“" "$(echo "$R" | jq -r --arg e "$E2" '.patients[]|select(.encounter_id==$e)|[.alerts[].text|select(test("წონა"))]|length')" "1"
chk "თერაპიის განყოფილებაზე დაფა → 404" "$(code GET "/inpatient/icu/board?department_id=$DW" "$NI")" "404"

step "11. ბილინგი: ვენტილაციის დღე"
V=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "ვენტილაციის დღე 1 (მინიმუმი); ტარიფი არ არის → missing_vent_tariff 1, ხაზი არ არის" "$(echo "$V" | jq -r '"\(.vent_days|length):\(.vent_days[0].minimum):\(.missing_vent_tariff):\([.lines[]|select(.category=="ventilation")]|length)"')" "1:true:1:0"
TV=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2EVENT$S\",\"title\":\"ტესტ-E2E ხელოვნური ვენტილაცია\",\"base_price\":250}" | jq -r '.id // empty')
icu "{\"vent_day_tariff_id\":\"$TV\"}" >/dev/null
V=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "ტარიფი 250 → ინვოისში „ventilation“ 1 × 250" "$(echo "$V" | jq -r '[.lines[]|select(.category=="ventilation")][0]|"\(.quantity):\(.unit_price|tonumber+0):\(.category_ka)"'):$(echo "$V" | jq -r '.missing_vent_tariff')" "1:250:ხელოვნური ვენტილაცია:0"

step "12. გაყვანა, ხელახლა შემოსვლა, გარდაცვალება, სტატისტიკა"
R=$(api POST "/inpatient/icu/ventilation/$VENT/end" "$DRI" -d '{"reason":"extubated","note":"ტესტ-E2E: SBT წარმატებული"}')
chk "ექსტუბაცია" "$(echo "$R" | jq -r '.ended_at != null'):$(code POST "/inpatient/icu/ventilation/$VENT/end" "$DRI" -d '{"reason":"extubated"}')" "true:409"
api POST "$ADMN" "$NI" -d '{"outcome":"given","infusion_action":"stop"}' >/dev/null
T2=$(api POST "/inpatient/stays/$E1/transfer" "$DRI" -d "{\"to_department_id\":\"$DW\",\"reason\":\"ტესტ-E2E: სტაბილიზაცია\"}" | jq -r '.id // empty')
NB=$(api GET /notifications "$DRW" | jq -r '[.[]|select(.kind=="icu_out_note")]|length')
R=$(api POST "/inpatient/stays/$E1/notes" "$DRI" -d '{"kind":"icu_out","content":{"course":"სეპტიკური შოკი, 1 დღე ვენტილაცია","condition":"სტაბილური","recommendations":"ანტიბიოტიკი, ბალანსი"},"sign":true}')
chk "გაყვანის შეჯამება — ხელმოწერილი; მიმღები განყოფილების ექიმს შეტყობინება" "$(echo "$R" | jq -r .status):$(api GET /notifications "$DRW" | jq -r '[.[]|select(.kind=="icu_out_note")]|length')" "signed:$((NB+1))"
api POST "/inpatient/transfers/$T2/accept" "$NW" -d "{\"attending_doctor_id\":\"$(uid 65)\",\"bed_id\":\"$BW2\"}" >/dev/null
V=$(api GET "/inpatient/stays/$E1/icu" "$DRW")
chk "გადაყვანის შემდეგ: ეპიზოდი დახურულია (transfer → თერაპია)" "$(echo "$V" | jq -r '"\(.episode):\(.episodes[0].exit_kind):\(.episodes[0].exit_department_name|test("თერაპია"))"')" "null:transfer:true"
chk "დახურულ ეპიზოდზე ჩაწერა → 409 ICU_NO_EPISODE" "$(curl -s -X POST "$B$OB" -H "authorization: Bearer $NI" -H "$J" -d '{"heart_rate":90}' | jq -r .code)" "ICU_NO_EPISODE"
chk "ექიმი: გასვლის მდგომარეობა „გაუმჯობესებით“" "$(api PATCH "/inpatient/icu/episodes/$EP1" "$DRI" -d '{"exit_condition":"improved","exit_note":"ტესტ-E2E"}' | jq -r .exit_condition)" "improved"
T3=$(api POST "/inpatient/stays/$E1/transfer" "$DRW" -d "{\"to_department_id\":\"$DI\",\"reason\":\"ტესტ-E2E: რეციდივი\"}" | jq -r '.id // empty')
api POST "/inpatient/transfers/$T3/accept" "$NI" -d "{\"attending_doctor_id\":\"$(uid 63)\",\"bed_id\":\"$BI3\"}" >/dev/null
V=$(api GET "/inpatient/stays/$E1/icu" "$NI")
chk "ხელახლა შემოსვლა 48 სთ-ში → readmission = true; ეპიზოდები 2" "$(echo "$V" | jq -r '"\(.episode.readmission):\(.episodes|length)"')" "true:2"
NOW=$(date -u +%FT%TZ)
R=$(api POST "/inpatient/stays/$E2/discharge" "$DRI" -d "{\"type\":\"death\",\"death_at\":\"$NOW\",\"death_icd10_code\":\"R57.0\",\"autopsy_required\":false,\"override_reason\":\"ტესტ-E2E დასრულება\"}")
[ "$(echo "$R" | jq -r '.status // empty')" = "discharged" ] || echo "      (გაწერა: $(echo "$R" | jq -c '{code,message}'))"
chk "P2: გარდაცვალება → ეპიზოდი დახურულია, მდგომარეობა „გარდაიცვალა“" "$(api GET "/inpatient/stays/$E2/icu" "$DRI" | jq -r '"\(.episodes[0].exit_kind):\(.episodes[0].exit_condition)"')" "discharge:died"
R=$(api GET "/inpatient/icu/stats?department_id=$DI" "$DRI")
chk "სტატისტიკა: 3 ეპიზოდი, 1 ხელახლა შემოსვლა, 1 გარდაცვალება, 1 ვენტილირებული" "$(echo "$R" | jq -r '.departments[0]|"\(.episodes):\(.readmissions):\(.deaths):\(.ventilated)"')" "3:1:1:1"
chk "სტატისტიკა: VAP compliance 1/1 (100%), APACHE II საშუალო 23" "$(echo "$R" | jq -r '"\(.bundles[]|select(.bundle=="vap")|"\(.compliant)/\(.checks)"):\(.admission_scores[]|select(.kind=="apache2")|.avg)"')" "1/1:23"

step "13. ინტენსიური პალატა (ფუნქციების შეზღუდვა)"
chk "ვენტილაცია ინტენსიურში → 403 ICU_FEATURE_OFF; SOFA → 403" "$(curl -s -X POST "$B/inpatient/stays/$E3/icu/ventilation" -H "authorization: Bearer $DRN" -H "$J" -d '{"kind":"niv","airway":"mask"}' | jq -r .code):$(code GET "/inpatient/stays/$E3/icu/scores/sofa/draft" "$DRN")" "ICU_FEATURE_OFF:403"
chk "ფურცელი ინტენსიურში — 201; ABG — 201" "$(code POST "/inpatient/stays/$E3/icu/observations" "$NN" -d '{"heart_rate":96,"systolic_bp":130,"diastolic_bp":80}'):$(code POST "/inpatient/stays/$E3/icu/abg" "$NN" -d '{"ph":7.41,"lactate":1.1}')" "201:201"
api PATCH "/departments/$DN" "$ADM" -d '{"icu_features":["sheet","infusions","abg","board","ventilation"]}' >/dev/null
chk "განყოფილების საკუთარი სია (+ ვენტილაცია) → NIV 201" "$(code POST "/inpatient/stays/$E3/icu/ventilation" "$DRN" -d '{"kind":"niv","airway":"mask","settings":{"mode":"BiPAP","ipap":14,"epap":6,"fio2":40}}')" "201"
chk "დონის შეცვლა ward-ზე პაციენტით → 409" "$(code PATCH "/departments/$DN" "$ADM" -d '{"care_level":"ward"}')" "409"

step "14. გაუქმება, ადმინისტრირება"
chk "ვენტ. პარამეტრი: სხვა ექთანი (არა ავტორი) → 403; ავტორი → გაუქმდა" "$(code POST "/inpatient/icu/vent_settings/$VS2/void" "$NI2" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/inpatient/icu/vent_settings/$VS2/void" "$NI" -d '{"reason":"ტესტ-E2E შეცდომა"}' | jq -r .voided)" "403:true"
chk "ფურცლის ჩანაწერის გაუქმება → მიბმული შარდიც უქმდება" "$(api POST "/inpatient/nursing/vitals/$VID/void" "$NI" -d '{"reason":"ტესტ-E2E შეცდომა"}' | jq -r .voided):$(api GET "/inpatient/stays/$E1/nursing?days=1" "$NI" | jq -r --arg v "$VID" '[.fluid.entries[]|select(.vitals_id==$v and .voided_at==null)]|length')" "true:0"
chk "SOFA გაუქმება (ექიმი, მიზეზით)" "$(api POST "/inpatient/icu/score/$SOFA/void" "$DRI" -d '{"reason":"ტესტ-E2E: ლაბ. მოვიდა"}' | jq -r .voided)" "true"
BI_ID=$(api POST /inpatient/icu/bundle-items "$ADM" -d '{"bundle":"clabsi","label":"ტესტ-E2E: ხაზის თარიღი ეტიკეტზე","sort_order":99}' | jq -r '.id // empty')
chk "bundle-ის პუნქტი: ექთანი → 403; admin ამატებს და თიშავს" "$(code POST /inpatient/icu/bundle-items "$NI" -d '{"bundle":"vap","label":"xxx yyy"}'):$([ -n "$BI_ID" ] && echo ok):$(api PATCH "/inpatient/icu/bundle-items/$BI_ID" "$ADM" -d '{"is_active":false}' | jq -r .is_active)" "403:ok:false"
OW=$(api GET /inpatient/icu/apache-categories "$ADM" | jq -r '.[]|select(.code=="n_cv_sepsis")|.weight')
chk "APACHE კატეგორია: წონის შეცვლა (admin) / ექთანი → 403" "$(api PATCH /inpatient/icu/apache-categories/n_cv_sepsis "$ADM" -d '{"weight":0.2}' | jq -r '.weight|tonumber+0'):$(code PATCH /inpatient/icu/apache-categories/n_cv_sepsis "$NI" -d '{"weight":0.1}')" "0.2:403"
api PATCH /inpatient/icu/apache-categories/n_cv_sepsis "$ADM" -d "{\"weight\":$OW}" >/dev/null

step "15. აღდგენა"
DIS() { api POST "/inpatient/stays/$1/discharge" "$2" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid $3)\",\"$(uid $4)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" | jq -r '.status // .message'; }
chk "ტესტის პაციენტები გაეწერა (ეპიზოდები დაიხურა)" "$(DIS "$E1" "$DRI" 62 68):$(DIS "$E3" "$DRN" 66 64):$(api GET "/inpatient/stays/$E3/icu" "$DRN" | jq -r '.episode')" "discharged:discharged:null"
api PATCH "/tariffs/$TV" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/icu "$ADM" -d "{\"settings\":$ORIG_ICU,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგა (icu, inpatient)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="icu")|.settings.vent_day_tariff_id')" "$(echo "$ORIG_ICU" | jq -c .vent_day_tariff_id)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
