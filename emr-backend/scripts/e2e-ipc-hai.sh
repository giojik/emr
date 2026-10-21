#!/usr/bin/env bash
# =====================================================================
# e2e-ipc-hai.sh — ინფექციის კონტროლი, ეტაპი 2 (0068): პარამეტრები, ნიმუშის ახალი ტიპები, კომენსალები, დიალიზის კათეტერი,
#   სიგნალები (ჰემოკულტურა / კომენსალის წყვილი / ჰოსპიტალური კულტურა / ცხელება მოწყობილობით / ანტიბიოტიკი / კლასტერი, დუბლირება,
#   დაკვირვება / უარყოფა / ხელახლა გახსნა, ხედვა), HAI რეესტრი (კონტექსტი: დღე, მიკუთვნება, გადაყვანის წესი, მოწყობილობა;
#   სიგნალიდან შექმნა, კრიტერიუმები, დადასტურება / უარყოფა / ხელახლა გახსნა, ხელით მიკუთვნება / მოწყობილობა, ჩაკეტვა, ხედვა),
#   ხარისხის ინციდენტი (წყარო hai_case), device-days (calendar_day / census, მაჩვენებლები), მოდულის გამორთვა
#   bash scripts/e2e-ipc-hai.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-ipc-hai.sh
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
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r '.code // .error.code // .message.code // empty'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F)
ago() { date -u -d "-$1" +%FT%TZ; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.hai.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"HAI-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.hai.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
uid() { cat "$TMP/u$1"; }
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_hai_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_hai_$1_$S"; }
notes() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" --arg e "${3:-}" '[.[]|select(.kind==$k and ($e=="" or (.link // "" | contains($e))))]|length'; }
ipcset() { api PUT /modules/ipc "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }

step "0. პარამეტრები, ცნობარები, ახალი ტიპები"
O_IPC=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')
[ -n "$O_IPC" ] || die "მოდული ipc ვერ მოიძებნა"
echo "$O_IPC" | jq -e '.settings.sig_blood_culture != null' >/dev/null || die "0068 არ არის დაყენებული (სიგნალების პარამეტრები აკლია)"
chk "ნაგულისხმევი: 5 სიგნალი ჩართული, 38.0°, კომენსალი 48 სთ, კლასტერი 3 / 14 დღე, ECDC, გადაყვანა 2, მოწყობილობა 3 დღე, calendar_day, 3 ცენტრ. ტიპი" \
  "$(echo "$O_IPC" | jq -r '.settings|"\([.sig_blood_culture,.sig_hospital_culture,.sig_fever_device,.sig_antibiotic_start,.sig_cluster]|all):\(.fever_threshold):\(.commensal_window_hours):\(.cluster_count)/\(.cluster_days):\(.hai_criteria_set):\(.hai_transfer_days):\(.device_min_days):\(.device_days_basis):\(.central_line_kinds|length)"')" \
  "true:38:48:3/14:ecdc:2:3:calendar_day:3"
chk "ვალიდაცია: ცხელება 40 / მოწყობილობა 4 / უცნობი ნაკრები / ცენტრ. ტიპები ცარიელი → 400" \
  "$(code PUT /modules/ipc "$ADM" -d '{"settings":{"fever_threshold":40},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"device_min_days":4},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"hai_criteria_set":"nhsn"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"central_line_kinds":[]},"reason":"ტესტ-E2E"}')" "400:400:400:400"
# ტესტისთვის: ყველა დღე „ჰოსპიტალურია“ (onset 1), კლასტერი — 2 პაციენტი
ipcset '{"hospital_onset_day":1,"cluster_count":2,"cluster_days":14,"signal_dedupe_days":7,"device_min_days":3,"device_days_basis":"calendar_day","hai_transfer_days":2,"fever_threshold":38.0,"mdro_flag_mode":"auto"}'
HC=$(api GET /ipc/hai-catalog "$ADM")
chk "HAI ცნობარი: 6 ტიპი (CLABSI / CAUTI / VAP), ECDC ნაკრები — 19 პუნქტი, კლინიკის აქტიური" \
  "$(echo "$HC" | jq -r '"\(.types|length):\([.types[]|.device_name // empty]|join(",")):\([.items[]|select(.set_id == ($s[0].id))]|length):\(.sets[0].active_for_clinic)"' --argjson s "$(echo "$HC" | jq '[.sets[]|select(.code=="ecdc")]')")" "6:CLABSI,CAUTI,VAP:19:true"
REF=$(api GET /lab/micro/refs "$ADM")
chk "კომენსალები: CoNS / S. epidermidis / Corynebacterium …; S. aureus — არა" "$(echo "$REF" | jq -r '"\([.organisms[]|select(.is_commensal)]|length >= 9):\(.organisms[]|select(.code=="sep")|.is_commensal):\(.organisms[]|select(.code=="sau")|.is_commensal)"')" "true:true:false"

step "1. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E HAI თერაპია $S\",\"code\":\"E2EHA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E HAI ქირურგია $S\",\"code\":\"E2EHB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
R_IPC=$(mkrole ipc "IPC" '["infection"]'); R_IPD=$(mkrole ipd "IPC განყ." '["infection_dept"]')
IC=$(mkuser "[\"$R_IPC\"]" 41)
ID=$(mkuser "[\"$R_IPD\"]" 42 ",\"department_id\":\"$DA\"")
NA=$(mkuser '["nurse"]' 43 ",\"department_id\":\"$DA\"")
NB=$(mkuser '["nurse"]' 44 ",\"department_id\":\"$DB\"")
DR=$(mkuser '["doctor"]' 45 ",\"department_id\":\"$DA\""); DRID=$(uid 45)
RC=$(mkuser '["receptionist"]' 46); LT=$(mkuser '["diagnostic"]' 47); LD=$(mkuser '["lab_doctor"]' 48); LM=$(mkuser '["lab_manager"]' 49)
[ -n "$IC" ] && [ -n "$ID" ] && [ -n "$NA" ] && [ -n "$NB" ] && [ -n "$DR" ] && [ -n "$RC" ] && [ -n "$LT" ] && [ -n "$LD" ] && [ -n "$LM" ] && ok "9 მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"HAI-$2\",\"birth_date\":\"1966-06-06\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 31 ერთი); P2=$(mkpat 32 ორი); P3=$(mkpat 33 სამი); P4=$(mkpat 34 ოთხი)
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"A41.9\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$DA"); E2=$(ADMIT "$P2" "$DA"); E3=$(ADMIT "$P3" "$DB"); E4=$(ADMIT "$P4" "$DA")
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$E3" ] && [ -n "$E4" ] && ok "4 ჰოსპიტალიზაცია (A: P1, P2, P4; B: P3)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
mksvc() { local id; id=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"HAI_$1_$S\",\"name\":\"ტესტ-E2E HAI $1 $S\",\"group_name\":\"ტესტ-E2E მიკრობიოლოგია\",\"specimen_type\":\"$2\",\"container\":\"Sterile\"}" | jq -r '.id // empty')
  [ -n "$id" ] && api PATCH "/dx/catalog/$id" "$ADM" -d '{"is_micro":true}' >/dev/null; echo "$id"; }
SV_BL=$(mksvc BLOOD blood); SV_SP=$(mksvc SPUT sputum); SV_WD=$(mksvc WOUND wound)
chk "ნიმუშის ახალი ტიპები: ნახველი / ჭრილობა — 201; უცნობი — 400" "$([ -n "$SV_SP" ] && [ -n "$SV_WD" ] && [ -n "$SV_BL" ] && echo ok):$(code POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"HAI_X_$S\",\"name\":\"x\",\"group_name\":\"x\",\"specimen_type\":\"xyz\"}")" "ok:400"
ORG() { echo "$REF" | jq -r --arg c "$1" '.organisms[]|select(.code==$c)|.id'; }
SAU=$(ORG sau); SEP=$(ORG sep); KPN=$(ORG kpn)
# სტაციონარის შეკვეთა → აღება → მიღება → იზოლატი → საბოლოო
culture() {
  local e=$1 svc=$2 org=$3 bc it
  api POST "/encounters/$e/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$svc\"}]}" >/dev/null
  bc=$(api POST "/encounters/$e/dx-collect" "$NA" -d '{"identity_confirmed":true}' | jq -r '[.[]?|.barcode][0] // empty')
  [ -n "$bc" ] || bc=$(api POST "/encounters/$e/dx-collect" "$NB" -d '{"identity_confirmed":true}' | jq -r '[.[]?|.barcode][0] // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  it=$(api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty')
  api PUT "/lab/micro/items/$it/culture" "$LT" -d '{"stage":"growth"}' >/dev/null
  api POST "/lab/micro/items/$it/isolates" "$LT" -d "{\"organism_id\":\"$org\",\"quantity\":\"+\"}" >/dev/null
  api POST "/lab/micro/items/$it/complete" "$LT" >/dev/null; api POST "/lab/micro/items/$it/final" "$LD" >/dev/null
  echo "$it"
}
sigs() { api GET "/ipc/signals?status=all" "$IC" | jq -c --arg p "$1" '[.[]|select(.patient_id==$p)]'; }

step "2. სიგნალები"
I1=$(culture "$E1" "$SV_BL" "$SAU"); I2=$(culture "$E2" "$SV_BL" "$SEP"); I3=$(culture "$E3" "$SV_SP" "$KPN")
[ -n "$I1" ] && [ -n "$I2" ] && [ -n "$I3" ] && ok "კულტურები: P1 ჰემოკულტურა S. aureus, P2 ჰემოკულტურა S. epidermidis (ერთი), P3 ნახველი K. pneumoniae" || bad "კულტურები" "$I1 / $I2 / $I3"
L1=$(api POST "/inpatient/stays/$E1/lines" "$NA" -d "{\"kind\":\"cvc\",\"site\":\"v. subclavia\",\"inserted_at\":\"$(ago '4 days')\",\"inserted_where\":\"ტესტ-E2E სხვა დაწესებულება\"}" | jq -r '.id // empty')
chk "ხაზი: CVC (4 დღის წინ); ახალი ტიპი „დიალიზის კათეტერი“ — 201" "$([ -n "$L1" ] && echo ok):$(code POST "/inpatient/stays/$E2/lines" "$NA" -d '{"kind":"dialysis","site":"v. jugularis"}')" "ok:201"
api POST "/inpatient/stays/$E1/vitals" "$NA" -d '{"temperature":38.6,"heart_rate":104}' >/dev/null
api POST "/inpatient/stays/$E4/vitals" "$NA" -d '{"temperature":39.0}' >/dev/null
G_CEF=$(api POST /pharmacy/generics "$ADM" -d "{\"inn\":\"ტესტ-E2E HAI ცეფტრიაქსონი $S\",\"atc_code\":\"J01DD04\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"max_single_dose\":2000,\"routes\":[\"IV\"]}" | jq -r '.id // empty')
DRB=$(mkuser '["doctor"]' 50 ",\"department_id\":\"$DB\"")
api POST "/inpatient/stays/$E3/orders" "$DRB" -d "{\"category\":\"medication\",\"generic_id\":\"$G_CEF\",\"order_type\":\"scheduled\",\"dose\":1000,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"frequency_code\":\"Q12H\",\"duration_days\":7}" >/dev/null
NIC0=$(notes "$IC" ipc_signal)
chk "შემოწმება: ექთანი / IPC განყ. — 403; IPC — ok" "$(code POST /ipc/signals/scan "$NA"):$(code POST /ipc/signals/scan "$ID"):$(api POST /ipc/signals/scan "$IC" | jq -r '.created >= 4')" "403:403:true"
S1=$(sigs "$P1"); S2=$(sigs "$P2"); S3=$(sigs "$P3"); S4=$(sigs "$P4")
chk "P1: ჰემოკულტურა (S. aureus) + ცხელება ცენტრ. ხაზით" "$(echo "$S1" | jq -r '[.[].kind]|sort|join(",")'):$(echo "$S1" | jq -r '.[]|select(.kind=="fever_device")|.data.devices|join(",")')" "blood_culture,fever_device:central_line"
chk "P2: ერთი კომენსალი — სიგნალი არა; P4: ცხელება მოწყობილობის გარეშე — არა" "$(echo "$S2" | jq length):$(echo "$S4" | jq length)" "0:0"
chk "P3 (განყ. B): ნახველი K. pneumoniae (ჰოსპიტალური) + ანტიბიოტიკის დაწყება (J01)" "$(echo "$S3" | jq -r '[.[].kind]|sort|join(",")')" "antibiotic_start,hospital_culture"
chk "ზარი IPC-ს (ipc_signal)" "$(( $(notes "$IC" ipc_signal) - NIC0 > 0 ))" "1"
culture "$E2" "$SV_BL" "$SEP" >/dev/null
api POST /ipc/signals/scan "$IC" >/dev/null
chk "P2: იგივე კომენსალი მეორე ჰემოკულტურაში (48 სთ) → ჰემოკულტურის სიგნალი (წყვილი)" "$(sigs "$P2" | jq -r '.[0]|"\(.kind):\(.data.commensal_pair)"')" "blood_culture:true"
culture "$E4" "$SV_WD" "$SAU" >/dev/null
NIC1=$(api GET "/notifications?unread=true" "$IC" | jq '[.[]|select(.kind=="ipc_signal" and .urgent)]|length')
api POST /ipc/signals/scan "$IC" >/dev/null
CL=$(api GET "/ipc/signals?kind=cluster" "$IC" | jq -c --arg d "$DA" '[.[]|select(.department_id==$d)]')
chk "კლასტერი: განყ. A, S. aureus — 2 პაციენტი (P1 სისხლი + P4 ჭრილობა); სასწრაფო ზარი" "$(echo "$CL" | jq -r '"\(length):\(.[0].data.n)"'):$(( $(api GET "/notifications?unread=true" "$IC" | jq '[.[]|select(.kind=="ipc_signal" and .urgent)]|length') - NIC1 ))" "1:2:1"
api POST "/inpatient/stays/$E1/vitals" "$NA" -d '{"temperature":39.1}' >/dev/null
chk "განმეორებითი შემოწმება: ახალი არაფერი (დუბლირება — 7 დღე, იგივე წყარო)" "$(api POST /ipc/signals/scan "$IC" | jq -r .created)" "0"
chk "IPC განყ. A: მხოლოდ A (P3-ის არა); ექთანი — 403" "$(api GET '/ipc/signals?status=all' "$ID" | jq -r --arg p "$P3" --arg a "$P1" '"\([.[]|select(.patient_id==$p)]|length):\([.[]|select(.patient_id==$a)]|length)"'):$(code GET /ipc/signals "$NA")" "0:2:403"
SF=$(echo "$S1" | jq -r '.[]|select(.kind=="fever_device")|.id'); SB=$(echo "$S1" | jq -r '.[]|select(.kind=="blood_culture")|.id')
S3C=$(echo "$S3" | jq -r '.[]|select(.kind=="hospital_culture")|.id'); S3A=$(echo "$S3" | jq -r '.[]|select(.kind=="antibiotic_start")|.id')
chk "დაკვირვება 2 დღე → watch; უარყოფა მიზეზის გარეშე — 400; IPC განყ. A — P3-ის სიგნალი 403" \
  "$(api POST "/ipc/signals/$S3A/watch" "$IC" -d '{"days":2}' | jq -r .status):$(code POST "/ipc/signals/$S3A/dismiss" "$IC" -d '{}'):$(ecode POST "/ipc/signals/$S3A/dismiss" "$ID" -d '{"reason":"ტესტ-E2E"}')" "watch:400:OUT_OF_SCOPE"
chk "უარყოფა → dismissed; ხელახლა გახსნა → open" "$(api POST "/ipc/signals/$S3A/dismiss" "$IC" -d '{"reason":"ტესტ-E2E: პროფილაქტიკა"}' | jq -r .status):$(api POST "/ipc/signals/$S3A/reopen" "$IC" | jq -r .status)" "dismissed:open"

step "3. HAI — კონტექსტი"
CTX=$(api GET "/ipc/hai/context?patient_id=$P1&onset_date=$TODAY&hai_type=bsi" "$IC")
chk "P1 BSI დღეს: ჰოსპ. დღე 1, განყ. A (current), ცენტრ. ხაზი 5-ე დღე → CLABSI, გაფრთხილება არ არის" \
  "$(echo "$CTX" | jq -r '"\(.onset_day):\(.department_id == "'"$DA"'"):\(.attribution):\(.device_days):\(.device_assoc):\(.device_name):\(.warnings|length)"')" "1:true:current:5:true:CLABSI:0"
chk "P2 UTI: შარდის კათეტერი არ იდგა → ასოციაცია არა" "$(api GET "/ipc/hai/context?patient_id=$P2&onset_date=$TODAY&hai_type=uti" "$IC" | jq -r '"\(.device_assoc):\(.device_detail|contains("არ იდგა"))"')" "false:true"
chk "ჰოსპიტალიზაციამდე — 400 ONSET_BEFORE_ADMISSION; უცნობი ტიპი — 400" \
  "$(ecode GET "/ipc/hai/context?patient_id=$P1&encounter_id=$E1&onset_date=2020-01-01&hai_type=bsi" "$IC"):$(ecode GET "/ipc/hai/context?patient_id=$P1&onset_date=$TODAY&hai_type=xx" "$IC")" "ONSET_BEFORE_ADMISSION:HAI_TYPE"
T4=$(api POST "/inpatient/stays/$E4/transfer" "$DR" -d "{\"to_department_id\":\"$DB\",\"reason\":\"ტესტ-E2E გადაყვანა\"}" | jq -r '.id // empty')
[ -n "$T4" ] || T4=$(api GET "/inpatient/transfers?encounter_id=$E4" "$NA" | jq -r '.[0].id // empty')
api POST "/inpatient/transfers/$T4/accept" "$NB" -d "{\"attending_doctor_id\":\"$DRID\"}" >/dev/null
chk "P4 გადაყვანილია A → B დღეს; ინფექცია დღეს → მიკუთვნება A (transfer, < 2 დღე)" \
  "$(api GET "/ipc/hai/context?patient_id=$P4&onset_date=$TODAY&hai_type=other" "$IC" | jq -r '"\(.attribution):\(.department_id == "'"$DA"'")"')" "transfer:true"
ipcset '{"hai_transfer_days":0}'
chk "hai_transfer_days = 0 → მიკუთვნება B (current)" "$(api GET "/ipc/hai/context?patient_id=$P4&onset_date=$TODAY&hai_type=other" "$IC" | jq -r '"\(.attribution):\(.department_id == "'"$DB"'")"')" "current:true"
ipcset '{"hai_transfer_days":2}'

step "4. HAI — შემთხვევა სიგნალიდან, დადასტურება"
H1=$(api POST /ipc/hai "$IC" -d "{\"patient_id\":\"$P1\",\"hai_type\":\"bsi\",\"onset_date\":\"$TODAY\",\"signal_ids\":[\"$SB\",\"$SF\"]}")
H1ID=$(echo "$H1" | jq -r '.id // empty')
chk "შემთხვევა: HAIyy-NNNNNN, ეჭვი, A, CLABSI (5 დღე), მიკროორგანიზმი სიგნალიდან, 2 სიგნალი" \
  "$(echo "$H1" | jq -r '"\(.case_no|test("^HAI[0-9]{2}-[0-9]{6}$")):\(.status):\(.department_id == "'"$DA"'"):\(.device_assoc):\(.device_days):\(.organisms|length):\(.signals|length)"')" "true:suspected:true:true:5:1:2"
chk "სიგნალები → case; იგივე სიგნალი მეორედ — 409 SIGNAL_CASE; სხვა პაციენტის — 400 SIGNAL_PATIENT" \
  "$(api GET '/ipc/signals?status=case' "$IC" | jq -r --arg h "$H1ID" '[.[]|select(.case_id==$h)]|length'):$(ecode POST /ipc/hai "$IC" -d "{\"patient_id\":\"$P1\",\"hai_type\":\"bsi\",\"onset_date\":\"$TODAY\",\"signal_ids\":[\"$SB\"]}"):$(ecode POST /ipc/hai "$IC" -d "{\"patient_id\":\"$P2\",\"hai_type\":\"bsi\",\"onset_date\":\"$TODAY\",\"signal_ids\":[\"$S3C\"]}")" "2:SIGNAL_CASE:SIGNAL_PATIENT"
chk "SSI-ს სიღრმე BSI-ზე — 400; IPC განყ. A: B-ს პაციენტზე შემთხვევა — 403 OUT_OF_SCOPE" \
  "$(code PATCH "/ipc/hai/$H1ID" "$IC" -d '{"ssi_depth":"deep"}'):$(ecode POST /ipc/hai "$ID" -d "{\"patient_id\":\"$P3\",\"hai_type\":\"pn\",\"onset_date\":\"$TODAY\"}")" "400:OUT_OF_SCOPE"
chk "დადასტურება: IPC განყ. — 403; წყაროს გარეშე — 400 BSI_SOURCE" "$(code POST "/ipc/hai/$H1ID/confirm" "$ID"):$(ecode POST "/ipc/hai/$H1ID/confirm" "$IC")" "403:BSI_SOURCE"
api PATCH "/ipc/hai/$H1ID" "$IC" -d '{"bsi_source":"catheter"}' >/dev/null
chk "კრიტერიუმების გარეშე — 400 CRITERIA" "$(ecode POST "/ipc/hai/$H1ID/confirm" "$IC")" "CRITERIA"
D1=$(api GET "/ipc/hai/$H1ID" "$IC")
REQ=$(echo "$D1" | jq -c '[.criteria[]|select(.required)|.id]'); PAT=$(echo "$D1" | jq -r '.criteria[0].id')
OTHER=$(echo "$HC" | jq -r '[.items[]|select(.hai_type=="uti")][0].id')
chk "სხვა ტიპის კრიტერიუმი — 400 CRITERIA_ITEM; მხოლოდ სავალდებულო — დადასტურება ✓" \
  "$(ecode PATCH "/ipc/hai/$H1ID" "$IC" -d "{\"criteria_met\":[\"$OTHER\"]}"):$(api PATCH "/ipc/hai/$H1ID" "$IC" -d "{\"criteria_met\":$(echo "$REQ" | jq -c --arg p "$PAT" '. + [$p]')}" | jq -r '.criteria_met|length')" "CRITERIA_ITEM:2"
api POST "/ipc/hai/$H1ID/review" "$ID" >/dev/null
ND0=$(notes "$DR" ipc_hai)
chk "განხილვა (IPC განყ.) → review; დადასტურება (IPC) → confirmed" "$(api GET "/ipc/hai/$H1ID" "$ID" | jq -r .status):$(api POST "/ipc/hai/$H1ID/confirm" "$IC" | jq -r .status)" "review:confirmed"
chk "მკურნალ ექიმს — შეტყობინება; ჰოსპიტალიზაციის გვერდზე: CLABSI (დადასტურებული)" "$(( $(notes "$DR" ipc_hai) - ND0 )):$(api GET "/ipc/stays/$E1/hai" "$DR" | jq -r '.[0]|"\(.label):\(.status)"')" "1:CLABSI:confirmed"
chk "დადასტურებულზე ტიპის შეცვლა — 409 CASE_LOCKED; გამოსავალი — 200" "$(ecode PATCH "/ipc/hai/$H1ID" "$IC" -d '{"hai_type":"pn"}'):$(code PATCH "/ipc/hai/$H1ID" "$IC" -d '{"outcome":"recovered","hai_contributed":"no"}')" "CASE_LOCKED:200"
chk "ხელახლა გახსნა (მიზეზით) → review; კვლავ დადასტურება" "$(api POST "/ipc/hai/$H1ID/reopen" "$IC" -d '{"reason":"ტესტ-E2E: გადახედვა"}' | jq -r .status):$(api POST "/ipc/hai/$H1ID/confirm" "$IC" | jq -r .status)" "review:confirmed"
chk "ქრონოლოგია: created, updated, review, confirm, reopen …" "$(api GET "/ipc/hai/$H1ID" "$IC" | jq -r '[.events[].kind]|unique|sort|join(",")')" "confirm,created,reopen,review,updated"

step "5. HAI — ხელით: მიკუთვნება, მოწყობილობა, ადრეული დღე, უარყოფა"
H2ID=$(api POST /ipc/hai "$IC" -d "{\"patient_id\":\"$P3\",\"hai_type\":\"pn\",\"onset_date\":\"$TODAY\",\"signal_ids\":[\"$S3C\"],\"description\":\"ტესტ-E2E პნევმონია\"}" | jq -r '.id // empty')
D2=$(api GET "/ipc/hai/$H2ID" "$IC")
chk "P3 PN: განყ. B, ვენტილაცია არ იდგა → VAP არა" "$(echo "$D2" | jq -r '"\(.department_id == "'"$DB"'"):\(.device_assoc):\(.device_kind)"')" "true:false:ventilator"
chk "მოწყობილობის ხელით შეცვლა მიზეზის გარეშე — 400; მიზეზით → VAP (override)" \
  "$(ecode PATCH "/ipc/hai/$H2ID" "$IC" -d '{"device_override":true,"device_assoc":true}'):$(api PATCH "/ipc/hai/$H2ID" "$IC" -d '{"device_override":true,"device_assoc":true,"device_note":"ტესტ-E2E: სხვა კლინიკაში ვენტილირებული"}' | jq -r '"\(.device_assoc):\(.device_override)"')" "DEVICE_NOTE:true:true"
chk "ავტომატურზე დაბრუნება → false" "$(api PATCH "/ipc/hai/$H2ID" "$IC" -d '{"device_override":false}' | jq -r '"\(.device_assoc):\(.device_override)"')" "false:false"
chk "მიკუთვნება ხელით მიზეზის გარეშე — 400; მიზეზით → A (manual)" \
  "$(ecode PATCH "/ipc/hai/$H2ID" "$IC" -d "{\"department_id\":\"$DA\"}"):$(api PATCH "/ipc/hai/$H2ID" "$IC" -d "{\"department_id\":\"$DA\",\"attribution_note\":\"ტესტ-E2E: ინფექცია A-ში დაიწყო\"}" | jq -r '"\(.attribution):\(.department_id == "'"$DA"'")"')" "ATTRIBUTION_NOTE:manual:true"
chk "IPC განყ. A ახლა ხედავს (მიკუთვნება A); უარყოფა — 403 (მხოლოდ IPC)" "$(code GET "/ipc/hai/$H2ID" "$ID"):$(code POST "/ipc/hai/$H2ID/reject" "$ID" -d '{"reason":"ტესტ-E2E"}')" "200:403"
chk "უარყოფა მიზეზის გარეშე — 400; მიზეზით → rejected" "$(code POST "/ipc/hai/$H2ID/reject" "$IC" -d '{}'):$(api POST "/ipc/hai/$H2ID/reject" "$IC" -d '{"reason":"ტესტ-E2E: კოლონიზაცია"}' | jq -r .status)" "400:rejected"
ipcset '{"hospital_onset_day":3}'
H3=$(api POST /ipc/hai "$IC" -d "{\"patient_id\":\"$P2\",\"hai_type\":\"other\",\"onset_date\":\"$TODAY\"}")
H3ID=$(echo "$H3" | jq -r '.id // empty')
chk "hospital_onset_day = 3: P2 დღე 1 → გაფრთხილება ONSET_EARLY; დადასტურება — 409 ONSET_EARLY" \
  "$(echo "$H3" | jq -r '[.context.warnings[].code]|join(",")'):$(api PATCH "/ipc/hai/$H3ID" "$IC" -d "{\"criteria_met\":[\"$(echo "$HC" | jq -r '[.items[]|select(.hai_type=="other")][0].id')\"]}" >/dev/null; ecode POST "/ipc/hai/$H3ID/confirm" "$IC")" "ONSET_EARLY:ONSET_EARLY"
chk "ხელით მიკუთვნებით (მიზეზით) — დადასტურდება" "$(api PATCH "/ipc/hai/$H3ID" "$IC" -d "{\"department_id\":\"$DA\",\"attribution_note\":\"ტესტ-E2E: წინა ოპერაცია სხვაგან\"}" >/dev/null; api POST "/ipc/hai/$H3ID/confirm" "$IC" | jq -r .status)" "confirmed"
ipcset '{"hospital_onset_day":1}'
chk "სია: სტატუსი confirmed — H1, H3; device=1 — H1; IPC განყ. A — 3 (A-ს მიკუთვნებული)" \
  "$(api GET "/ipc/hai?status=confirmed&department_id=$DA" "$IC" | jq length):$(api GET "/ipc/hai?device=1&department_id=$DA" "$IC" | jq -r '[.[].id]|join(",")'):$(api GET '/ipc/hai' "$ID" | jq -r --arg a "$H1ID" --arg b "$H2ID" --arg c "$H3ID" '[.[]|select(.id==$a or .id==$b or .id==$c)]|length')" "2:$H1ID:3"

step "6. ხარისხის ინციდენტი (წყარო: HAI შემთხვევა)"
CAT=$(api GET '/quality/classifiers?kind=category' "$DR" | jq -r '.[]|select(.code=="inf_line")|.id')
DATA=$(jq -nc --arg d "$DA" --arg c "$CAT" --arg p "$P1" --arg s "$H1ID" --arg t "$(ago '1 hour')" '{event_type:"harm",affected:"patient",occurred_at:$t,department_id:$d,category_id:$c,harm_reported:"moderate",description:"ტესტ-E2E: CLABSI — ცენტრალური ხაზის მოვლის დარღვევა",patient_id:$p,source_type:"hai_case",source_id:$s,identity_mode:"open"}')
INC=$(curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $IC" -F "data=$DATA" | jq -r '.inc_no // .code // empty')
chk "ინციდენტი წყაროთი hai_case (IPC ავტორი) → INCyy-…; HAI ბარათზე ჩანს ნომერი" "$(echo "$INC" | grep -c '^INC'):$(api GET "/ipc/hai/$H1ID" "$IC" | jq -r --arg i "$INC" '[.incidents[]|select(.inc_no==$i)]|length')" "1:1"
chk "წყარო სხვა პაციენტით — 400 SOURCE_PATIENT" "$(curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $IC" -F "data=$(echo "$DATA" | jq -c --arg p "$P2" '.patient_id=$p')" | jq -r '.code // empty')" "SOURCE_PATIENT"

step "7. device-days"
R=$(api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$(TZ=Asia/Tbilisi date -d '-5 days' +%F)\",\"to\":\"$TODAY\"}")
chk "გადათვლა (IPC): 6 დღე; IPC განყ. — 403; from > to — 400" "$(echo "$R" | jq -r .days):$(code POST /ipc/device-days/refresh "$ID" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}"):$(code POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"2020-01-01\"}")" "6:403:400"
RT=$(api GET "/ipc/device-days?from=$TODAY&to=$TODAY&department_id=$DA" "$IC")
chk "განყ. A დღეს: პაციენტ-დღე 2 (P1, P2; P4 გადაყვანის დღეს — ბოლო ეპიზოდით B-ში), ცენტრ. ხაზი 2 (CVC P1 + დიალიზი P2), CLABSI 1 → 500 / 1000 device-day" \
  "$(echo "$RT" | jq -r '.rows[0]|"\(.patient_days):\(.cl):\(.clabsi):\(.clabsi_rate)"')" "2:2:1:500"
chk "DUR (ცენტრ. ხაზი) = 2 / 2 = 1; HAI 1000 პაციენტ-დღეზე = 2 / 2 × 1000" "$(echo "$RT" | jq -r '.rows[0]|"\(.dur_cl):\(.hai):\(.hai_rate)"')" "1:2:1000"
ipcset '{"central_line_kinds":["cvc","picc"]}'
api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" >/dev/null
chk "დიალიზი ცენტრალურად არ ითვლება → ცენტრ. ხაზი 1, CLABSI 1000 / 1000" "$(api GET "/ipc/device-days?from=$TODAY&to=$TODAY&department_id=$DA" "$IC" | jq -r '.rows[0]|"\(.cl):\(.clabsi_rate)"')" "1:1000"
ipcset "{\"central_line_kinds\":[\"cvc\",\"picc\",\"dialysis\"],\"device_days_basis\":\"census\",\"census_hour\":0}"
api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" >/dev/null
chk "census (00:00): დღეს მიღებული პაციენტები ჯერ არ იყვნენ → პაციენტ-დღე 0 (განყ. A)" "$(api GET "/ipc/device-days?from=$TODAY&to=$TODAY&department_id=$DA" "$IC" | jq -r '[.rows[]|.patient_days]|add // 0')" "0"
ipcset '{"device_days_basis":"calendar_day"}'
api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" >/dev/null
chk "IPC განყ. A: განყ. B — 400 OUT_OF_SCOPE; საკუთარი — 200; ექთანი — 403" "$(ecode GET "/ipc/device-days?from=$TODAY&to=$TODAY&department_id=$DB" "$ID"):$(code GET "/ipc/device-days?from=$TODAY&to=$TODAY" "$ID"):$(code GET "/ipc/device-days?from=$TODAY&to=$TODAY" "$NA")" "OUT_OF_SCOPE:200:403"

step "8. მოდულის გამორთვა / აღდგენა"
api PUT /modules/ipc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე: სიგნალები / HAI / device-days — 403; ჰოსპიტალიზაციის HAI — ცარიელი" \
  "$(code GET /ipc/signals "$IC"):$(code GET /ipc/hai "$IC"):$(code GET "/ipc/device-days?from=$TODAY&to=$TODAY" "$IC"):$(api GET "/ipc/stays/$E1/hai" "$DR" | jq length)" "403:403:403:0"
api PUT /modules/ipc "$ADM" -d "{\"enabled\":$(echo "$O_IPC" | jq '.enabled'),\"settings\":$(echo "$O_IPC" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')" "$O_IPC"
AUD=$( (api GET "/audit-logs?entity_name=ipc_hai_cases&limit=200" "$ADM"; api GET "/audit-logs?entity_name=ipc_signals&limit=200" "$ADM") | jq -s -r '[.[]|(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: IPC_HAI_CREATE / UPDATE / REVIEW / CONFIRM / REJECT / REOPEN, IPC_SIGNAL_SCAN / WATCH / DISMISS / REOPEN" \
  "$(for a in IPC_HAI_CREATE IPC_HAI_UPDATE IPC_HAI_REVIEW IPC_HAI_CONFIRM IPC_HAI_REJECT IPC_HAI_REOPEN IPC_SIGNAL_SCAN IPC_SIGNAL_WATCH IPC_SIGNAL_DISMISS IPC_SIGNAL_REOPEN; do echo "$AUD" | tr ',' '\n' | grep -qx "$a" && echo y || echo "$a"; done | sort -u | tr '\n' ' ')" "y "

step "გასუფთავება"
for x in $SV_BL $SV_SP $SV_WD; do api PATCH "/dx/catalog/$x" "$ADM" -d '{"is_active":false}' >/dev/null; done
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მომხმარებლები / ანალიზები გათიშულია (HAI შემთხვევები / სიგნალები რეესტრში რჩება — ტესტ-E2E პაციენტებით)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
