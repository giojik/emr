#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-nursing.sh — სტაციონარი, ეტაპი 0044: ექთნის დოკუმენტაცია
#   0. მომზადება          1. უფლებები                 2. ვიტალები + NEWS2 (შეტყობინება, ბავშვი, SpO₂ შკალა 2), გაუქმება
#   3. სითხის ბალანსი     4. შკალები (Morse, Braden, GCS)   5. ხაზები / დრენაჟები
#   6. MAR-ის მოვლის დავალება → ფორმა      7. ჩანაწერი, ცვლის გადაბარება      8. გაწერის გაფრთხილება, აღდგენა
# გამოყენება:  bash scripts/e2e-ipd-nursing.sh [API_URL]
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

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E საექთნო A $S\",\"code\":\"E2ENA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E საექთნო B $S\",\"code\":\"E2ENB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.nur.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"საექთ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.nur.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 31)
NA=$(mkuser '["nurse"]' 32 ",\"department_id\":\"$DA\"")
NB=$(mkuser '["nurse"]' 33 ",\"department_id\":\"$DA\"")
HN=$(mkuser '["nurse"]' 34 ",\"department_id\":\"$DA\",\"is_section_head\":true")
DR=$(mkuser '["doctor"]' 35 ",\"department_id\":\"$DA\"")
NX=$(mkuser '["nurse"]' 36 ",\"department_id\":\"$DB\"")
for t in RC NA NB HN DR NX; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები (რეგისტრატორი, 2 ექთანი A, მთავარი ექთანი A, ექიმი A, ექთანი B)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 51 "საექთნო" 1960-02-02 male); P2=$(mkpat 52 "საექთნო-ბავშვი" "$(date -d '-8 years' +%F)" female)
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"news2_enabled":true,"news2_alert":5,"news2_urgent":7,"fluid_day_start":"08:00","shift_times":["08:00","20:00"],"scale_reminders":true,"line_alert_hours":{"pvc":96,"urinary":720}}'
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 35)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "2 ჰოსპიტალიზაცია (მოზრდილი, 8 წლის ბავშვი)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
V="/inpatient/stays/$E1/vitals"; N="/inpatient/stays/$E1/nursing"
chk "პარამეტრის ვალიდაცია: სასწრაფო < შეტყობინების — 400" "$(code PUT /modules/inpatient "$ADM" -d '{"settings":{"news2_alert":7,"news2_urgent":5},"reason":"ტესტ-E2E"}')" "400"

step "1. უფლებები"
NORM='{"respiratory_rate":16,"spo2":97,"o2_supplement":false,"systolic_bp":125,"diastolic_bp":80,"heart_rate":72,"consciousness":"A","temperature":36.8}'
chk "რეგისტრატორი — 403; სხვა განყოფილების ექთანი — 403" "$(code POST "$V" "$RC" -d "$NORM"):$(code POST "$V" "$NX" -d "$NORM")" "403:403"
chk "ნახვა: ექთანი A can_write; ექთანი B — false; რეგისტრატორი — 403" "$(api GET "$N" "$NA" | jq -r .can_write):$(api GET "$N" "$NX" | jq -r .can_write):$(code GET "$N" "$RC")" "true:false:403"

step "2. ვიტალები + NEWS2"
chk "ცარიელი — 400; დიასტოლური ≥ სისტოლური — 400; პულსი 400 — 400" \
  "$(code POST "$V" "$NA" -d '{}'):$(code POST "$V" "$NA" -d '{"systolic_bp":80,"diastolic_bp":90}'):$(code POST "$V" "$NA" -d '{"heart_rate":400}')" "400:400:400"
R=$(api POST "$V" "$NA" -d "$NORM")
chk "ნორმა (სრული ნაკრები) → NEWS2 0, low" "$(echo "$R" | jq -r '"\(.news2):\(.news2_level)"')" "0:low"
chk "მხოლოდ ტემპერატურა → NEWS2 არ ითვლება" "$(api POST "$V" "$NA" -d '{"temperature":37.2,"pain":3}' | jq -r '"\(.news2):\(.pain)"')" "null:3"
chk "მომავალი დრო — 400" "$(code POST "$V" "$NA" -d "{\"temperature\":37,\"recorded_at\":\"$(date -u -d '+1 hour' +%FT%TZ)\"}")" "400"
BADV='{"respiratory_rate":26,"spo2":90,"o2_supplement":true,"o2_flow":4,"systolic_bp":95,"diastolic_bp":60,"heart_rate":120,"consciousness":"A","temperature":39.5}'
R=$(api POST "$V" "$NA" -d "$BADV"); V_BAD=$(echo "$R" | jq -r .id)
chk "მძიმე: RR 26 (3) + SpO₂ 90 (3) + O₂ (2) + SBP 95 (2) + HR 120 (2) + ტ° 39.5 (2) = 14, high" "$(echo "$R" | jq -r '"\(.news2):\(.news2_level):\(.news2_parts.rr):\(.news2_parts.spo2)"')" "14:high:3:3"
nn() { api GET /notifications "$1" | jq -r --arg a "$2" '[.[]|select(.kind=="ipd_news2" and (.body|contains($a)))]|length'; }
ADM1=$(api GET "/inpatient/stays/$E1" "$NA" | jq -r '.stay.adm_no // .adm_no')
chk "შეტყობინება: მკურნალ ექიმს და მთავარ ექთანს — 1; ავტორს — 0; სასწრაფო" \
  "$(nn "$DR" "$ADM1"):$(nn "$HN" "$ADM1"):$(nn "$NA" "$ADM1"):$(api GET /notifications "$DR" | jq -r --arg a "$ADM1" '[.[]|select(.kind=="ipd_news2" and (.body|contains($a)))][0].urgent')" "1:1:0:true"
api POST "$V" "$NA" -d "$BADV" >/dev/null
chk "იგივე დონე 4 სთ-ში — ახალი შეტყობინება არა" "$(nn "$DR" "$ADM1")" "1"
chk "ისტორიაში news2_alert" "$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|map(select(.=="news2_alert"))|length')" "1"
chk "SpO₂ შკალა 2: 89% ოთახის ჰაერზე → 0 ქულა (შკალა 1-ზე — 3)" \
  "$(api POST "$V" "$NA" -d '{"respiratory_rate":16,"spo2":89,"spo2_scale":2,"o2_supplement":false,"systolic_bp":125,"heart_rate":72,"consciousness":"A","temperature":36.8}' | jq -r '.news2_parts.spo2')" "0"
chk "ბავშვი (8 წ.) — NEWS2 არ ითვლება; news2_applicable=false" \
  "$(api POST "/inpatient/stays/$E2/vitals" "$NA" -d "$NORM" | jq -r .news2):$(api GET "/inpatient/stays/$E2/nursing" "$NA" | jq -r .news2_applicable)" "null:false"
VD="/inpatient/nursing/vitals/$V_BAD/void"
chk "გაუქმება: მიზეზის გარეშე — 400; სხვა ექთანი (არა ავტორი) — 403" "$(code POST "$VD" "$NA" -d '{}'):$(code POST "$VD" "$NB" -d '{"reason":"ტესტ-E2E"}')" "400:403"
chk "ავტორი აუქმებს → OK; მეორედ — 404; სიაში voided_at" \
  "$(api POST "$VD" "$NA" -d '{"reason":"ტესტ-E2E: სხვა პაციენტის მონაცემი"}' | jq -r .voided):$(code POST "$VD" "$NA" -d '{"reason":"ტესტ-E2E"}'):$(api GET "$N" "$NA" | jq -r --arg v "$V_BAD" '.vitals[]|select(.id==$v)|.voided_at!=null')" "true:404:true"
chk "ამბულატორიული ვიტალების ენდპოინტი იგივე ცხრილში (ნახვაში ჩანს ექიმისთვისაც)" "$(api GET "$N" "$DR" | jq -r '[.vitals[]|select(.voided_at==null)]|length')" "4"

step "3. სითხის ბალანსი"
F="/inpatient/stays/$E1/fluid"
chk "არასწორი კატეგორია — 400; 0 მლ — 400" "$(code POST "$F" "$NA" -d '{"category":"juice","volume_ml":100}'):$(code POST "$F" "$NA" -d '{"category":"po","volume_ml":0}')" "400:400"
api POST "$F" "$NA" -d '{"category":"po","volume_ml":500}' >/dev/null
api POST "$F" "$NA" -d '{"category":"iv","volume_ml":1000,"note":"NaCl 0.9%"}' >/dev/null
FU=$(api POST "$F" "$NA" -d '{"category":"urine","volume_ml":800}' | jq -r .id)
FV=$(api POST "$F" "$NA" -d '{"category":"vomit","volume_ml":200}' | jq -r .id)
T=$(api GET "$N" "$NA" | jq -c '.fluid.totals[0]')
chk "დღე: მიღება 1500, გამოყოფა 1000, ბალანსი +500" "$(echo "$T" | jq -r '"\(.in):\(.out):\(.balance)"')" "1500:1000:500"
api POST "/inpatient/nursing/fluid/$FV/void" "$NA" -d '{"reason":"ტესტ-E2E შეცდომა"}' >/dev/null
chk "გაუქმების შემდეგ — გამოყოფა 800, ბალანსი +700" "$(api GET "$N" "$NA" | jq -r '.fluid.totals[0]|"\(.out):\(.balance)"')" "800:700"
HR=$(TZ=Asia/Tbilisi date +%H)
if [ "$((10#$HR))" -ge 9 ]; then
  T730=$(TZ=Asia/Tbilisi date -d "$(TZ=Asia/Tbilisi date +%F) 07:30" +%FT%T%:z)
  api POST "$F" "$NA" -d "{\"category\":\"urine\",\"volume_ml\":300,\"recorded_at\":\"$T730\"}" >/dev/null
  chk "07:30 — წინა ბალანსის დღეს ეკუთვნის (დღე 08:00-დან)" "$(api GET "$N" "$NA" | jq -r --arg d "$(TZ=Asia/Tbilisi date -d yesterday +%F)" '.fluid.totals[]|select(.day==$d)|.out')" "300"
else ok "07:30 — შემოწმება გამოტოვებულია (ახლა 09:00-მდეა)"; fi

step "4. შკალები"
SC=$(api GET /inpatient/nursing/scales "$NA")
chk "შკალები: morse, braden, gcs; სავალდებულო — morse, braden" "$(echo "$SC" | jq -r '[.[].code]|join(",")'):$(echo "$SC" | jq -r '[.[]|select(.required)|.code]|join(",")')" "morse,braden,gcs:morse,braden"
chk "ჩაუტარებელი Morse — scales_due (არა ვადაგადაცილებული, 24 სთ-ში)" "$(api GET "$N" "$NA" | jq -r '.scales_due[]|select(.code=="morse")|"\(.overdue):\(.last_at)"')" "false:null"
A="/inpatient/stays/$E1/scales"
chk "პუნქტი აკლია — 400; არასწორი ვარიანტი — 400; უცნობი შკალა — 400" \
  "$(code POST "$A" "$NA" -d '{"scale_code":"morse","answers":{"history":1}}'):$(code POST "$A" "$NA" -d '{"scale_code":"gcs","answers":{"eye":9,"verbal":4,"motor":5}}'):$(code POST "$A" "$NA" -d '{"scale_code":"xxx","answers":{}}')" "400:400:400"
R=$(api POST "$A" "$NA" -d '{"scale_code":"morse","answers":{"history":1,"secondary":1,"aid":0,"iv":1,"gait":2,"mental":1}}')
chk "Morse: 25+15+0+20+20+15 = 95 → მაღალი რისკი" "$(echo "$R" | jq -r '"\(.score):\(.level):\(.band_label)"')" "95:high:მაღალი რისკი"
chk "Braden: 1+1+1+1+1+1 = 6 → მაღალი; GCS: 4+5+6 = 15 → low" \
  "$(api POST "$A" "$NA" -d '{"scale_code":"braden","answers":{"sensory":0,"moisture":0,"activity":0,"mobility":0,"nutrition":0,"friction":0}}' | jq -r '"\(.score):\(.level)"'):$(api POST "$A" "$NB" -d '{"scale_code":"gcs","answers":{"eye":3,"verbal":4,"motor":5}}' | jq -r '"\(.score):\(.level)"')" "6:high:15:low"
chk "შეჯამება: რისკები — დაცემის, ნაწოლის (high)" "$(api GET "$N/summary" "$NA" | jq -r '[.risks[]|"\(.label)=\(.level)"]|join(",")')" "დაცემის რისკი=high,ნაწოლის რისკი=high"
chk "Morse შეფასდა → შემდეგი 24 სთ-ში" "$(api GET "$N" "$NA" | jq -r '.scales_due[]|select(.code=="morse")|"\(.overdue):\(.last_at!=null)"')" "false:true"

step "5. ხაზები / დრენაჟები"
L="/inpatient/stays/$E1/lines"
chk "უცნობი ტიპი — 400; მომავალი დრო — 400" "$(code POST "$L" "$NA" -d '{"kind":"xyz"}'):$(code POST "$L" "$NA" -d "{\"kind\":\"pvc\",\"inserted_at\":\"$(date -u -d '+2 hours' +%FT%TZ)\"}")" "400:400"
PVC=$(api POST "$L" "$NA" -d "{\"kind\":\"pvc\",\"site\":\"მარცხენა მაჯა\",\"size\":\"20G\",\"inserted_at\":\"$(ago '100 hours')\",\"inserted_where\":\"მიმღები\"}" | jq -r '.id // empty')
URI=$(api POST "$L" "$NB" -d '{"kind":"urinary","size":"Ch 16"}' | jq -r '.id // empty')
R=$(api GET "$N" "$NA")
chk "PVC: 100 სთ, ზღვარი 96; შარდის კათეტერი — ჩვენთან (inserted_by)" \
  "$(echo "$R" | jq -r --arg p "$PVC" '.lines[]|select(.id==$p)|"\(.hours>=99):\(.alert_hours):\(.inserted_where)"'):$(echo "$R" | jq -r --arg p "$URI" '.lines[]|select(.id==$p)|.inserted_by_name!=null')" "true:96:მიმღები:true"
chk "შეჯამებაში 2 ხაზი" "$(api GET "$N/summary" "$NA" | jq -r '.lines|length')" "2"
chk "ამოღება ჩადგმამდე — 400; სხვა განყოფილების ექთანი — 403" \
  "$(code POST "/inpatient/lines/$PVC/remove" "$NA" -d "{\"removed_at\":\"$(ago '120 hours')\"}"):$(code POST "/inpatient/lines/$PVC/remove" "$NX" -d '{}')" "400:403"
chk "ამოღება → OK; მეორედ — 409" "$(api POST "/inpatient/lines/$PVC/remove" "$NA" -d '{"reason":"ტესტ-E2E: 96 სთ"}' | jq -r '.removed_at!=null'):$(code POST "/inpatient/lines/$PVC/remove" "$NA" -d '{}')" "true:409"
chk "ისტორიაში line_inserted ×2, line_removed ×1" "$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|"\(map(select(.=="line_inserted"))|length):\(map(select(.=="line_removed"))|length)"')" "2:1"

step "6. MAR-ის მოვლის დავალება → ფორმა"
OR="/inpatient/stays/$E1/orders"
chk "ტიპი მედიკამენტზე — 400; შკალა შკალის გარეშე — 400" \
  "$(code POST "$OR" "$DR" -d '{"category":"diet","text":"ტესტ-E2E","nursing_task":"vitals"}'):$(code POST "$OR" "$DR" -d '{"category":"nursing","text":"ტესტ-E2E","frequency_code":"Q6H","nursing_task":"scale"}')" "400:400"
OV=$(api POST "$OR" "$DR" -d '{"category":"nursing","text":"ტესტ-E2E ვიტალების კონტროლი","frequency_code":"Q6H","nursing_task":"vitals"}' | jq -r '.id // empty')
OS=$(api POST "$OR" "$DR" -d '{"category":"nursing","text":"ტესტ-E2E დაცემის რისკის შეფასება","frequency_code":"Q24H","nursing_task":"scale","task_scale_code":"morse"}' | jq -r '.id // empty')
[ -n "$OV" ] && [ -n "$OS" ] && ok "2 დავალება (ვიტალები Q6H, Morse Q24H)" || bad "დავალებები" "$OV/$OS"
MAR=$(api GET "/inpatient/stays/$E1/mar" "$NA")
SV=$(echo "$MAR" | jq -r --arg o "$OV" '[.entries[]|select(.order_id==$o and .status=="due")]|sort_by(.scheduled_at)[0].id')
SS=$(echo "$MAR" | jq -r --arg o "$OS" '[.entries[]|select(.order_id==$o and .status=="due")]|sort_by(.scheduled_at)[0].id')
chk "MAR: დავალების ტიპი ჩანს (vitals / scale:morse)" "$(echo "$MAR" | jq -r --arg o "$OV" --arg s "$OS" '"\(.orders[]|select(.id==$o)|.nursing_task):\(.orders[]|select(.id==$s)|"\(.nursing_task):\(.task_scale_code)")"')" "vitals:scale:morse"
chk "MAR „შესრულდა“ ფორმის გარეშე — 400 MAR_TASK_FORM; „არ შესრულდა“ — დაშვებულია (სხვა სლოტზე ვერ შევამოწმებთ — მხოლოდ კოდი)" \
  "$(api POST "/inpatient/mar/$SV/document" "$NA" -d '{"outcome":"given"}' | jq -r .code)" "MAR_TASK_FORM"
chk "სხვა ტიპის ფორმა (ბალანსი ვიტალების სლოტზე) — 400" "$(code POST "$F" "$NA" -d "{\"category\":\"po\",\"volume_ml\":100,\"mar_entry_id\":\"$SV\"}")" "400"
R=$(api POST "$V" "$NA" -d "$(echo "$NORM" | jq -c --arg m "$SV" '. + {mar_entry_id:$m}')"); VT=$(echo "$R" | jq -r .id)
chk "ვიტალები mar_entry_id-ით → სლოტი given" "$(api GET "/inpatient/stays/$E1/mar" "$NA" | jq -r --arg m "$SV" '.entries[]|select(.id==$m)|.status')" "given"
chk "იგივე სლოტზე მეორედ — 409" "$(code POST "$V" "$NA" -d "$(echo "$NORM" | jq -c --arg m "$SV" '. + {mar_entry_id:$m}')")" "409"
api POST "/inpatient/nursing/vitals/$VT/void" "$NA" -d '{"reason":"ტესტ-E2E: სლოტის თავიდან გახსნა"}' >/dev/null
chk "ვიტალების გაუქმება → MAR ჩანაწერი გაუქმდა, სლოტი ისევ due" \
  "$(api GET "/inpatient/stays/$E1/mar" "$NA" | jq -r --arg m "$SV" --arg o "$OV" '([.entries[]|select(.id==$m)][0]) as $x | "\($x.voided_at!=null):\([.entries[]|select(.order_id==$o and .status=="due" and .scheduled_at==$x.scheduled_at)]|length)"')" "true:1"
chk "Morse mar_entry_id-ით → სლოტი given" \
  "$(api POST "$A" "$NB" -d "{\"scale_code\":\"morse\",\"answers\":{\"history\":0,\"secondary\":1,\"aid\":0,\"iv\":1,\"gait\":0,\"mental\":0},\"mar_entry_id\":\"$SS\"}" | jq -r '.score'):$(api GET "/inpatient/stays/$E1/mar" "$NA" | jq -r --arg m "$SS" '.entries[]|select(.id==$m)|.status')" "35:given"
chk "Braden სლოტზე (შკალა არ ემთხვევა) — 400" "$(code POST "$A" "$NB" -d "{\"scale_code\":\"braden\",\"answers\":{\"sensory\":3,\"moisture\":3,\"activity\":3,\"mobility\":3,\"nutrition\":3,\"friction\":2},\"mar_entry_id\":\"$SS\"}")" "400"

step "7. ჩანაწერი, ცვლის გადაბარება"
NT="/inpatient/stays/$E1/nursing-notes"
chk "ცარიელი ჩანაწერი — 400; ექიმი ცვლას ვერ აბარებს — 403" "$(code POST "$NT" "$NA" -d '{"kind":"note","text":""}'):$(code POST "$NT" "$DR" -d '{"kind":"handover","sbar":{"s":"ტესტ"}}')" "400:403"
NO=$(api POST "$NT" "$NA" -d '{"kind":"note","text":"ტესტ-E2E: პაციენტი მშვიდადაა, ღამე ეძინა"}' | jq -r '.id // empty')
[ -n "$NO" ] && ok "ექთნის ჩანაწერი" || bad "ექთნის ჩანაწერი"
R=$(api POST "$NT" "$NA" -d '{"kind":"handover","sbar":{"s":"ტესტ-E2E: ცხელება","b":"პნევმონია","a":"NEWS2 დაეცა","r":"ტ° ყოველ 4 სთ"}}'); HO=$(echo "$R" | jq -r '.id // empty')
chk "გადაბარება: SBAR + შეჯამება (ვიტალები, ბალანსი, ხაზი, რისკები)" \
  "$(echo "$R" | jq -r '"\(.sbar.s|test("ცხელება")):\(.summary.vitals!=null):\(.summary.fluid.in>0):\(.summary.lines|length):\(.summary.risks|length>0)"')" "true:true:true:1:true"
chk "იგივე ცვლაში მეორედ — 409" "$(code POST "$NT" "$NB" -d '{"kind":"handover","sbar":{"s":"ტესტ"}}')" "409"
R=$(api GET "/inpatient/departments/$DA/handover" "$NB")
chk "განყოფილების გადაბარება: 2 პაციენტი; E1 — მიმდინარე ცვლის გადაბარებით" \
  "$(echo "$R" | jq -r '.patients|length'):$(echo "$R" | jq -r --arg e "$E1" '.patients[]|select(.encounter_id==$e)|.current.author_name|test("საექთ-32")')" "2:true"
chk "მიღება: ავტორი — 400; ექიმი — 403; სხვა განყოფილების ექთანი — 403" \
  "$(code POST "/inpatient/nursing-notes/$HO/ack" "$NA"):$(code POST "/inpatient/nursing-notes/$HO/ack" "$DR"):$(code POST "/inpatient/nursing-notes/$HO/ack" "$NX")" "400:403:403"
chk "მეორე ექთანი იღებს → OK; მეორედ — 409" "$(api POST "/inpatient/nursing-notes/$HO/ack" "$NB" | jq -r .ack):$(code POST "/inpatient/nursing-notes/$HO/ack" "$NB")" "true:409"
chk "მიღებული — ack_by_name ჩანს" "$(api GET "$N" "$NA" | jq -r --arg h "$HO" '.notes[]|select(.id==$h)|.ack_by_name|test("საექთ-33")')" "true"
chk "ჩანაწერის გაუქმება: მთავარი ექთანი (არა ავტორი) — OK" "$(api POST "/inpatient/nursing/note/$NO/void" "$HN" -d '{"reason":"ტესტ-E2E: სხვა პაციენტზე"}' | jq -r .voided)" "true"

step "8. გაწერის გაფრთხილება, დაფა"
R=$(api GET "/inpatient/stays/$E1/discharge/check" "$DR")
chk "გაწერის შემოწმება: LINES_IN_PLACE (შარდის კათეტერი)" "$(echo "$R" | jq -r '[.warnings[]|select(.code=="LINES_IN_PLACE")][0].message|test("შარდის")')" "true"
api POST "/inpatient/lines/$URI/remove" "$NA" -d '{}' >/dev/null
chk "ამოღების შემდეგ — გაფრთხილება აღარ არის" "$(api GET "/inpatient/stays/$E1/discharge/check" "$DR" | jq -r '[.warnings[]|select(.code=="LINES_IN_PLACE")]|length')" "0"
for E in "$E1" "$E2"; do api POST "/inpatient/stays/$E/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 32)\",\"$(uid 33)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null; done
chk "გაწერის შემდეგ ჩაწერა — 409; can_write=false" "$(code POST "$V" "$NA" -d "$NORM"):$(api GET "$N" "$NA" | jq -r .can_write)" "409:false"
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
ok "პარამეტრები აღდგენილია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
