#!/usr/bin/env bash
# =====================================================================
# e2e-ipc-ssi.sh — ინფექციის კონტროლი, ეტაპი 3 (0069): ოპერაციის ადგილის ინფექცია (SSI)
#   პარამეტრები, SSI კატეგორიები / ოპერაციების ცნობარი (NCSP შეთავაზება), ჭრილობის კლასი ოქმში (optional / required / off),
#   ზედამხედველობის ჩანაწერი (ASA, ხანგრძლივობა, NNIS ინდექსი, პროფილაქტიკის დრო, დაკვირვების ვადა), IPC-ის შესწორება / გამორიცხვა,
#   გაწერის შემდგომი კონტაქტი (ცდა, კითხვარი → SSI შემთხვევა), სიგნალი ssi_postop (ხელახალი ჰოსპიტალიზაცია), HAI SSI (ოპერაცია, POD,
#   მიკუთვნება — ოპერაციის განყოფილება, დადასტურება → ოპერაცია „SSI“), მაჩვენებლები, ხედვა, მოდულის გამორთვა, აუდიტი
#   bash scripts/e2e-ipc-ssi.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-ipc-ssi.sh
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
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r 'if type=="object" then (.code // .error.code // (if (.message|type)=="object" then .message.code else null end) // empty) else empty end'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F); YDAY=$(TZ=Asia/Tbilisi date -d yesterday +%F); D2Y=$(date -d '+2 years' +%F)
N() { date -u -d "@$(( $(date +%s) / 60 * 60 - $1 * 60 ))" +%FT%TZ; }      # N 30 = ახლა − 30 წთ
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ssi.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"SSI-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.ssi.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
uid() { cat "$TMP/u$1"; }
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_ssi_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_ssi_$1_$S"; }
ipcset() { api PUT /modules/ipc "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }

step "0. პარამეტრები"
O_IPC=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')
[ -n "$O_IPC" ] || die "მოდული ipc ვერ მოიძებნა"
echo "$O_IPC" | jq -e '.settings.wound_class_mode != null' >/dev/null || die "0069 არ არის დაყენებული (SSI პარამეტრები აკლია)"
O_OR=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings')
O_INP=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
chk "ნაგულისხმევი: კლასი optional, SSI ჩართული, კონტაქტი, 3 ცდა, SMS გამორთული, სიგნალი, ფანჯარა 60" \
  "$(echo "$O_IPC" | jq -r '.settings|"\(.wound_class_mode):\(.ssi_surveillance):\(.ssi_pd_calls):\(.ssi_pd_attempts):\(.ssi_pd_sms):\(.sig_ssi_postop):\(.prophylaxis_window_min)"')" \
  "optional:true:true:3:false:true:60"
chk "ვალიდაცია: კლასის რეჟიმი x / ცდა 9 / ფანჯარა 10 → 400" \
  "$(code PUT /modules/ipc "$ADM" -d '{"settings":{"wound_class_mode":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"ssi_pd_attempts":9},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"prophylaxis_window_min":10},"reason":"ტესტ-E2E"}')" "400:400:400"
ipcset '{"ssi_surveillance":true,"ssi_pd_calls":true,"ssi_pd_attempts":3,"sig_ssi_postop":true,"prophylaxis_window_min":60,"wound_class_mode":"optional","signal_dedupe_days":7,"ssi_pd_sms":false}'
api PUT /modules/or "$ADM" -d '{"settings":{"or_scheduling":"coordinator","anesthesia_team_by":"anesthesia_head","preop_readiness":"warn","nursing_team_by":"both","room_teams":false,"anesthesia_meds":"direct","preference_cards":"off","count_mode":"off","note_required":[]},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"bed_assign_mode":"direct","discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null

step "1. მომზადება"
dep() { api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E SSI $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'; }
DBK=$(dep "საოპერაციო" E2ESB or); DS=$(dep "ქირურგია" E2ESS inpatient); DT=$(dep "ტრავმატოლოგია" E2EST inpatient); DA=$(dep "ანესთეზიოლოგია" E2ESA administrative)
[ -n "$DBK" ] && [ -n "$DS" ] && [ -n "$DT" ] && [ -n "$DA" ] || die "განყოფილებები ვერ შეიქმნა"
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -r '[.types[]?|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end')
beds() { local w; w=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$1\",\"code\":\"$2\",\"sex\":\"mixed\"}" | jq -r '.id // empty'); api POST "/inpatient/wards/$w/beds" "$ADM" -d "{\"count\":3,\"type_code\":\"$BT\"}"; }
BS=$(beds "$DS" S1); BTR=$(beds "$DT" T1)
role() {
  local id; id=$(api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id' | head -1)
  [ -n "$id" ] || api POST /roles "$ADM" -d "{\"code\":\"$1\",\"name\":\"$2\",\"capabilities\":$3}" >/dev/null; echo "$1"; }
role e2e_or_coord 'ტესტ-E2E საოპერაციოს კოორდინატორი' '["or_schedule"]' >/dev/null; role e2e_anesth 'ტესტ-E2E ანესთეზიოლოგი' '["anesthesiologist"]' >/dev/null
role e2e_or_nurse 'ტესტ-E2E საოპერაციო ექთანი' '["or_nurse"]' >/dev/null
R_IPC=$(mkrole ipc "IPC" '["infection"]'); R_IPD=$(mkrole ipd "IPC განყ." '["infection_dept"]')
IC=$(mkuser "[\"$R_IPC\"]" 51); IDS=$(mkuser "[\"$R_IPD\"]" 52 ",\"department_id\":\"$DS\""); IDT=$(mkuser "[\"$R_IPD\"]" 53 ",\"department_id\":\"$DT\"")
RC=$(mkuser '["receptionist"]' 54); SU=$(mkuser '["doctor"]' 55 ",\"department_id\":\"$DS\""); SUT=$(mkuser '["doctor"]' 56 ",\"department_id\":\"$DT\"")
CO=$(mkuser '["e2e_or_coord"]' 57); AN=$(mkuser '["e2e_anesth"]' 58 ",\"department_id\":\"$DA\""); ON=$(mkuser '["e2e_or_nurse"]' 59 ",\"department_id\":\"$DBK\"")
for t in IC IDS IDT RC SU SUT CO AN ON; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: IPC, IPC განყ. (ქირურგია / ტრავმატოლოგია), რეგისტრატორი, ქირურგები ×2, კოორდინატორი, ანესთეზიოლოგი, საოპერაციო ექთანი"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"SSI-$2\",\"birth_date\":\"1958-05-05\",\"gender\":\"female\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 61 ქოლე); P2=$(mkpat 62 მენჯი); P3=$(mkpat 63 თიაქარი)
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$3\",\"source\":\"direct\",\"icd10_code\":\"$4\",\"chief_complaint\":\"ტესტ-E2E\",\"bed_id\":\"$5\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$DS" "$(uid 55)" K80.2 "$(echo "$BS" | jq -r '.[0].id')"); E2=$(ADMIT "$P2" "$DT" "$(uid 56)" M16.1 "$(echo "$BTR" | jq -r '.[0].id')")
E3=$(ADMIT "$P3" "$DS" "$(uid 55)" K40.9 "$(echo "$BS" | jq -r '.[1].id')")
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$E3" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
LOC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2ESL$S\",\"name\":\"ტესტ-E2E SSI საოპერაციოს საწყობი $S\",\"kind\":\"operating\",\"department_id\":\"$DBK\"}" | jq -r '.id // empty')
api PATCH "/or/blocks/$DBK" "$ADM" -d "{\"stock_location_id\":\"$LOC\"}" >/dev/null
room() { api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"$1\",\"name\":\"$2\",\"work_start\":\"00:00\",\"work_end\":\"23:59\",\"work_days\":[1,2,3,4,5,6,7]}" | jq -r '.id // empty'; }
RO1=$(room SS1 "ოთახი 1 (SSI)"); RO2=$(room SS2 "ოთახი 2 (SSI)")
proc() { api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-SSI-$1-$S\",\"name\":\"ტესტ-E2E SSI $2\",\"specialty_code\":\"general\",\"default_duration_min\":60${3:-}}" | jq -r '.id // empty'; }
PCH=$(proc CHOL "ლაპ. ქოლეცისტექტომია" ',"ncsp_code":"JKA21"'); PHP=$(proc HPRO "მენჯის ენდოპროთეზირება" ',"ncsp_code":"NFB49"'); PHE=$(proc HER "თიაქრის პლასტიკა")
[ -n "$RO1" ] && [ -n "$RO2" ] && [ -n "$PCH" ] && [ -n "$PHP" ] && [ -n "$PHE" ] && [ -n "$LOC" ] || die "ოთახები / პროცედურები / ლოკაცია ვერ შეიქმნა"
G_CFZ=$(api POST /pharmacy/generics "$ADM" -d "{\"inn\":\"ტესტ-E2E SSI ცეფაზოლინი $S\",\"atc_code\":\"J01DB04\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"dose_per_unit\":1000,\"routes\":[\"IV\"]}" | jq -r '.id // empty')
CAT_MED=$(api GET /stock/refs "$ADM" | jq -r '.categories[]|select(.code=="MED")|.id' | head -1)
IT_CFZ=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E SSI Cefazolin 1g $S\",\"category_id\":\"$CAT_MED\",\"base_unit\":\"vial\",\"generic_id\":\"$G_CFZ\"}" | jq -r '.id // empty')
SUP=$(api POST /stock/suppliers "$ADM" -d "{\"name\":\"ტესტ-E2E SSI მიმწოდებელი $S\",\"tax_id\":\"6$(printf '%08d' "$((10#$S))")\"}" | jq -r '.id // empty')
RCP=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[{\"item_id\":\"$IT_CFZ\",\"qty\":10,\"lot_no\":\"CF$S\",\"expires_on\":\"$D2Y\",\"price\":2,\"vat_rate\":0}]}" | jq -r '.id // empty')
[ -n "$G_CFZ" ] && [ -n "$IT_CFZ" ] && [ "$(api POST "/stock/receipts/$RCP/post" "$ADM" | jq -r .status)" = "posted" ] || die "ანტიბიოტიკის მარაგი ვერ მომზადდა"
ok "ბლოკი, ოთახები, ქირურგია + ტრავმატოლოგია, პროცედურები (JKA21 / NFB49 / NCSP-ის გარეშე), ცეფაზოლინი (J01DB04) ბლოკის საწყობში"

step "2. SSI კატეგორიები და ოპერაციების ცნობარი"
CAT=$(api GET /ipc/ssi/catalog "$IC")
chk "7 კატეგორია (ECDC): CHOL 30 / T 120; HPRO 90; CABG — იმპლანტით 90" \
  "$(echo "$CAT" | jq -r '[.categories[]|select(.code|IN("CABG","CHOL","COLO","CSEC","HPRO","KPRO","LAM"))]|length'):$(echo "$CAT" | jq -r '.categories[]|select(.code=="CHOL")|"\(.followup_days)/\(.t_point_min)"'):$(echo "$CAT" | jq -r '.categories[]|select(.code=="HPRO")|.followup_days'):$(echo "$CAT" | jq -r '.categories[]|select(.code=="CABG")|.implant_followup_days')" \
  "7:30/120:90:90"
chk "NCSP შეთავაზება: JKA21 → CHOL, NFB49 → HPRO, NCSP-ის გარეშე — არა" \
  "$(echo "$CAT" | jq -r --arg a "$PCH" --arg b "$PHP" --arg c "$PHE" '[.procedures[]|select(.id==$a or .id==$b or .id==$c)]|sort_by(.code)|map(.suggested // "-")|join(",")')" "CHOL,-,HPRO"
chk "მიბმა: ქირურგი → 403; უცნობი კატეგორია → 400 SSI_CATEGORY" \
  "$(code PATCH "/ipc/ssi/procedures/$PCH" "$SU" -d '{"ssi_category":"CHOL"}'):$(ecode PATCH "/ipc/ssi/procedures/$PCH" "$IC" -d '{"ssi_category":"ZZZ"}')" "403:SSI_CATEGORY"
R=$(api PATCH "/ipc/ssi/procedures/$PCH" "$IC" -d '{"ssi_category":"CHOL"}'); api PATCH "/ipc/ssi/procedures/$PHP" "$IC" -d '{"ssi_category":"HPRO"}' >/dev/null
chk "CHOL / HPRO მიბმულია, შეთავაზება აღარ ჩანს" "$(echo "$R" | jq -r --arg a "$PCH" '.procedures[]|select(.id==$a)|"\(.ssi_category):\(.suggested)"')" "CHOL:null"
NC="E2E$S"
chk "ახალი კატეგორია (თიაქარი): IPC → ✓; დუბლი → 409; T-წერტილი 5 → 400" \
  "$(api POST /ipc/ssi/categories "$IC" -d "{\"code\":\"$NC\",\"name\":\"ტესტ-E2E თიაქარი\",\"followup_days\":30,\"t_point_min\":90,\"ncsp_prefixes\":[\"JAB\"]}" | jq -r --arg c "$NC" '[.categories[]|select(.code==$c)]|length'):$(code POST /ipc/ssi/categories "$IC" -d "{\"code\":\"$NC\",\"name\":\"x x\"}"):$(code PATCH "/ipc/ssi/categories/$NC" "$IC" -d '{"t_point_min":5}')" "1:409:400"

step "3. ოპერაციები: ASA, ჭრილობის კლასი, პროფილაქტიკა"
WHO() { api GET "/or/cases/$1" "$ON" | jq -c --arg p "$2" '[.who_items[]|select(.phase==$p)|{key:.id,value:"yes"}]|from_entries'; }
TM() { api POST "/or/cases/$1/times" "$2" -d "$3"; }
mkcase() { api POST /or/cases "$1" -d "{\"encounter_id\":\"$2\",\"urgency\":\"elective\",\"anesthesia_type\":\"general\",\"procedures\":[{\"procedure_id\":\"$3\",\"is_primary\":true}]}" | jq -r '.id // empty'; }
sched() { api POST "/or/cases/$1/schedule" "$CO" -d "{\"room_id\":\"$2\",\"start\":\"$3\",\"duration_min\":60,\"confirm\":true}" | jq -r '.status // .message'; }
preop() { api PUT "/or/cases/$1/preop" "$AN" -d "{\"asa_class\":$2,\"mallampati\":2,\"weight_kg\":70}" >/dev/null; api POST "/or/cases/$1/preop/sign" "$AN" | jq -r '.preop[0].status // .message'; }
# run CASE SURGEON in_room anesth_start incision closure anesth_end (წუთები ახლამდე)
run() {
  TM "$1" "$ON" "{\"kind\":\"in_room\",\"at\":\"$(N "$3")\",\"readiness_override\":\"ტესტ-E2E\"}" >/dev/null
  TM "$1" "$AN" "{\"kind\":\"anesthesia_start\",\"at\":\"$(N "$4")\"}" >/dev/null
  api POST "/or/cases/$1/who" "$ON" -d "{\"phase\":\"sign_in\",\"answers\":$(WHO "$1" sign_in)}" >/dev/null
  api POST "/or/cases/$1/who" "$2" -d "{\"phase\":\"time_out\",\"answers\":$(WHO "$1" time_out)}" >/dev/null
  TM "$1" "$2" "{\"kind\":\"incision\",\"at\":\"$(N "$5")\"}" >/dev/null
  TM "$1" "$2" "{\"kind\":\"closure\",\"at\":\"$(N "$6")\"}" >/dev/null
  TM "$1" "$AN" "{\"kind\":\"anesthesia_end\",\"at\":\"$(N "$7")\"}" >/dev/null
}
fin() { api POST "/or/cases/$1/who" "$ON" -d "{\"phase\":\"sign_out\",\"answers\":$(WHO "$1" sign_out)}" >/dev/null
  TM "$1" "$ON" "{\"kind\":\"out_of_room\",\"at\":\"$(N "$2")\",\"destination\":\"ward\"}" | jq -r '.status // .code // .message'; }
abx() { api POST "/or/cases/$1/anesthesia/meds" "$AN" -d "{\"item_id\":\"$IT_CFZ\",\"dose\":2000,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"qty_base\":2,\"given_at\":\"$(N "$2")\"}" | jq -r '[.meds[]?]|length'; }
C1=$(mkcase "$SU" "$E1" "$PCH"); C2=$(mkcase "$SUT" "$E2" "$PHP"); C3=$(mkcase "$SU" "$E3" "$PHE")
[ -n "$C1" ] && [ -n "$C2" ] && [ -n "$C3" ] || die "ოპერაციის მოთხოვნები ვერ შეიქმნა"
chk "დაგეგმვა: C1 (CHOL), C2 (HPRO), C3 (თიაქარი — კატეგორიის გარეშე)" "$(sched "$C1" "$RO1" "$(N -30)"):$(sched "$C2" "$RO2" "$(N -30)"):$(sched "$C3" "$RO1" "$(N -120)")" "scheduled:scheduled:scheduled"
chk "წინასაოპერაციო შეფასება: C1 ASA 2, C2 ASA 3 — ხელმოწერილი" "$(preop "$C1" 2):$(preop "$C2" 3)" "signed:signed"
run "$C1" "$SU" 200 195 180 135 130; run "$C2" "$SUT" 400 395 380 230 225; run "$C3" "$SU" 100 95 90 70 65
chk "ცეფაზოლინი: C1 — ჭრილობამდე 10 წთ; C2 — ჭრილობის შემდეგ 10 წთ" "$(abx "$C1" 190):$(abx "$C2" 370)" "1:1"
NV=$(api GET "/or/cases/$C1/note" "$SU")
chk "ოქმი: wound_class_mode = optional (ნაგულისხმევი)" "$(echo "$NV" | jq -r .wound_class_mode)" "optional"
ipcset '{"wound_class_mode":"required"}'
api PUT "/or/cases/$C1/note" "$SU" -d '{"description":"ტესტ-E2E ლაპ. ქოლეცისტექტომია","complications_none":true}' >/dev/null
R=$(api POST "/or/cases/$C1/note/sign" "$SU")
chk "required: ხელმოწერა კლასის გარეშე → NOTE_INCOMPLETE (ჭრილობის კლასი)" "$(echo "$R" | jq -r '"\(.code):\(.missing|index("ჭრილობის კლასი") != null)"')" "NOTE_INCOMPLETE:true"
chk "კლასი 5 → 400; კლასი II → ხელმოწერა ✓" "$(code PUT "/or/cases/$C1/note" "$SU" -d '{"wound_class":5}'):$(api PUT "/or/cases/$C1/note" "$SU" -d '{"wound_class":2}' >/dev/null; api POST "/or/cases/$C1/note/sign" "$SU" | jq -r '"\(.current.status):\(.current.wound_class)"')" "400:signed:2"
ipcset '{"wound_class_mode":"off"}'
api PUT "/or/cases/$C3/note" "$SU" -d '{"description":"ტესტ-E2E თიაქარი","wound_class":1}' >/dev/null
chk "off: კლასი არ ინახება, ოქმის ხედში — off" "$(api GET "/or/cases/$C3/note" "$SU" | jq -r '"\(.draft.wound_class):\(.wound_class_mode)"')" "null:off"
ipcset '{"wound_class_mode":"optional"}'
api POST "/or/cases/$C3/note/sign" "$SU" >/dev/null
api PUT "/or/cases/$C2/note" "$SUT" -d '{"description":"ტესტ-E2E მენჯის ენდოპროთეზი","wound_class":2}' >/dev/null; api POST "/or/cases/$C2/note/sign" "$SUT" >/dev/null
chk "ოპერაციები დასრულდა (C1, C2, C3)" "$(fin "$C1" 125):$(fin "$C2" 220):$(fin "$C3" 60)" "completed:completed:completed"

step "4. ზედამხედველობის ჩანაწერი"
chk "გადათვლა: IPC განყ. → 403; IPC → ✓" "$(code POST /ipc/ssi/refresh "$IDS" -d '{}'):$(api POST /ipc/ssi/refresh "$IC" -d '{"days":30}' | jq -r '.ops >= 2')" "403:true"
O1=$(api GET "/ipc/ssi/ops/$C1" "$IC"); O2=$(api GET "/ipc/ssi/ops/$C2" "$IC")
chk "C1: CHOL, 45 წთ, ASA 2, კლასი II, NNIS 0, პროფილაქტიკა — დროულად (ცეფაზოლინი), 30 დღე, აქტიური" \
  "$(echo "$O1" | jq -r '"\(.category):\(.duration_min):\(.asa):\(.wound_class):\(.risk_index):\(.prophylaxis):\(.prophylaxis_drug|test("ცეფაზოლინი")):\(.followup_days):\(.status)"')" "CHOL:45:2:2:0:timely:true:30:active"
chk "C2: HPRO, 150 წთ (> T 120), ASA 3, კლასი II → NNIS 2; პროფილაქტიკა — განაკვეთის შემდეგ; 90 დღე" \
  "$(echo "$O2" | jq -r '"\(.category):\(.duration_min):\(.asa):\(.risk_index):\(.prophylaxis):\(.followup_days):\(.followup_until)"')" "HPRO:150:3:2:late:90:$(date -d "$TODAY +90 days" +%F)"
chk "C3 (კატეგორიის გარეშე) — ზედამხედველობაში არ არის (404)" "$(code GET "/ipc/ssi/ops/$C3" "$IC")" "404"
chk "კლასის შესწორება (IPC): მიზეზის გარეშე → WOUND_NOTE; III მიზეზით → NNIS 3; IPC განყ. → 403" \
  "$(ecode PATCH "/ipc/ssi/ops/$C2" "$IC" -d '{"wound_class_ipc":3}'):$(api PATCH "/ipc/ssi/ops/$C2" "$IC" -d '{"wound_class_ipc":3,"wound_class_note":"ტესტ-E2E: ოქმით — ნაწლავის დაზიანება"}' | jq -r '"\(.wound_class):\(.wound_class_ipc):\(.risk_index)"'):$(code PATCH "/ipc/ssi/ops/$C2" "$IDT" -d '{"wound_class_ipc":1,"wound_class_note":"xxx"}')" \
  "WOUND_NOTE:2:3:3:403"
chk "გადათვლა IPC-ის შესწორებას არ შლის" "$(api POST /ipc/ssi/refresh "$IC" -d '{"days":30}' >/dev/null; api GET "/ipc/ssi/ops/$C2" "$IC" | jq -r '"\(.wound_class_ipc):\(.risk_index)"')" "3:3"
chk "ხედვა: IPC განყ. ქირურგია — C1 ✓, C2 → 403 OUT_OF_SCOPE; სიაში მხოლოდ საკუთარი" \
  "$(code GET "/ipc/ssi/ops/$C1" "$IDS"):$(ecode GET "/ipc/ssi/ops/$C2" "$IDS"):$(api GET "/ipc/ssi/ops?from=$TODAY&to=$TODAY" "$IDS" | jq -r --arg a "$C1" --arg b "$C2" '[.[]|select(.case_id==$a or .case_id==$b)]|map(.case_id==$a)|join(",")')" "200:OUT_OF_SCOPE:true"
chk "გამორიცხვა: მიზეზის გარეშე → EXCLUDE_REASON; მიზეზით → excluded; დაბრუნება → active" \
  "$(ecode PATCH "/ipc/ssi/ops/$C2" "$IC" -d '{"excluded":true}'):$(api PATCH "/ipc/ssi/ops/$C2" "$IC" -d '{"excluded":true,"excluded_reason":"ტესტ-E2E: შემოწმება"}' | jq -r .status):$(api PATCH "/ipc/ssi/ops/$C2" "$IC" -d '{"excluded":false}' | jq -r .status)" \
  "EXCLUDE_REASON:excluded:active"

step "5. გაწერა → გაწერის შემდგომი კონტაქტი"
discharge() {
  api POST "/inpatient/stays/$1/epicrisis" "$2" >/dev/null
  api PUT "/inpatient/stays/$1/epicrisis" "$2" -d '{"content":{"anamnesis":"ტესტ-E2E","course":"ტესტ-E2E","treatment":"ტესტ-E2E","state_on_discharge":"დამაკმაყოფილებელი","recommendations":"ტესტ-E2E"}}' >/dev/null
  api POST "/encounters/$1/diagnoses" "$2" -d "{\"icd10_code\":\"$3\",\"diagnosis_type\":\"primary\"}" >/dev/null
  api POST "/inpatient/stays/$1/discharge" "$2" -d '{"type":"home","sign_epicrisis":true,"override_reason":"ტესტ-E2E: გაწერა"}' | jq -r '.status // .code // .message'
}
chk "გაწერა: P1, P2" "$(discharge "$E1" "$SU" K80.2):$(discharge "$E2" "$SUT" M16.1)" "discharged:discharged"
api POST /ipc/ssi/refresh "$IC" -d '{"days":30}' >/dev/null
FU=$(api GET "/ipc/ssi/followups?status=pending" "$IC")
F1=$(echo "$FU" | jq -r --arg c "$C1" '.[]|select(.case_id==$c)|.id'); F2=$(echo "$FU" | jq -r --arg c "$C2" '.[]|select(.case_id==$c)|.id')
chk "კონტაქტი შეიქმნა: C1 — ვადა +30, C2 — +90; „დღეს / 3 დღეში“ სიაში — არა" \
  "$(echo "$FU" | jq -r --arg c "$C1" '.[]|select(.case_id==$c)|.due_date'):$(echo "$FU" | jq -r --arg c "$C2" '.[]|select(.case_id==$c)|.due_date'):$(api GET "/ipc/ssi/followups?status=pending&due=now" "$IC" | jq -r --arg a "$F1" '[.[]|select(.id==$a)]|length')" \
  "$(date -d "$TODAY +30 days" +%F):$(date -d "$TODAY +90 days" +%F):0"
chk "ცდა (ვერ დავუკავშირდი) → attempts 1, ისევ მოსალოდნელი; გაუქმება მიზეზის გარეშე → CANCEL_REASON" \
  "$(api POST "/ipc/ssi/followups/$F2" "$IC" -d '{"action":"attempt","note":"არ პასუხობს"}' | jq -r '"\(.attempts):\(.status)"'):$(ecode POST "/ipc/ssi/followups/$F2" "$IC" -d '{"action":"cancel"}')" "1:pending:CANCEL_REASON"
chk "IPC განყ. ტრავმატოლოგია: C1-ის კონტაქტი → 403 OUT_OF_SCOPE" "$(ecode POST "/ipc/ssi/followups/$F1" "$IDT" -d '{"action":"attempt"}')" "OUT_OF_SCOPE"
R=$(api POST "/ipc/ssi/followups/$F2" "$IDT" -d "{\"action\":\"done\",\"outcome\":\"suspected\",\"answers\":{\"redness\":true,\"discharge\":true,\"fever\":false},\"onset_date\":\"$TODAY\",\"note\":\"ტესტ-E2E: ჭრილობიდან გამონადენი\"}")
H2=$(echo "$R" | jq -r '.hai_case_id // empty')
chk "კონტაქტი (IPC განყ.): ეჭვი → შესრულებული, 2 ცდა, SSI შემთხვევა შეიქმნა" "$(echo "$R" | jq -r '"\(.status):\(.outcome):\(.attempts):\(.answers.redness)"'):$([ -n "$H2" ] && echo case)" "done:suspected:2:true:case"
HD2=$(api GET "/ipc/hai/$H2" "$IC")
chk "SSI შემთხვევა: ოპერაცია C2, POD 0, გაწერის შემდეგ, მიკუთვნება — ტრავმატოლოგია (operation), ეჭვი" \
  "$(echo "$HD2" | jq -r --arg c "$C2" --arg d "$DT" '"\(.hai_type):\(.or_case_id==$c):\(.context.pod):\(.post_discharge):\(.department_id==$d):\(.attribution):\(.status)"')" "ssi:true:0:true:true:operation:suspected"
chk "მეორედ იგივე კონტაქტი → 409 STATE" "$(ecode POST "/ipc/ssi/followups/$F2" "$IC" -d '{"action":"attempt"}')" "STATE"

step "6. სიგნალი ssi_postop → SSI შემთხვევა → დადასტურება"
E1B=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DS\",\"attending_doctor_id\":\"$(uid 55)\",\"source\":\"emergency\",\"icd10_code\":\"T81.4\",\"chief_complaint\":\"ტესტ-E2E: ჭრილობის ინფექცია\",\"bed_id\":\"$(echo "$BS" | jq -r '.[2].id')\"}" | jq -r '.encounter_id // empty')
[ -n "$E1B" ] || die "ხელახალი ჰოსპიტალიზაცია ვერ მოხერხდა"
api POST /ipc/signals/scan "$IC" -d '{}' >/dev/null
SG=$(api GET "/ipc/signals?status=all&kind=ssi_postop" "$IC" | jq -c --arg p "$P1" '[.[]|select(.patient_id==$p)]')
chk "სიგნალი ssi_postop: P1 ხელახალი ჰოსპიტალიზაცია (POD 0), ოპერაცია C1, განყოფილება — ქირურგია" \
  "$(echo "$SG" | jq -r --arg c "$C1" --arg d "$DS" '"\(length):\(.[0].data.reason):\(.[0].data.or_case_id==$c):\(.[0].data.pod):\(.[0].department_id==$d)"')" "1:readmission:true:0:true"
SID=$(echo "$SG" | jq -r '.[0].id')
CTX=$(api GET "/ipc/hai/context?patient_id=$P1&onset_date=$TODAY&hai_type=ssi" "$IC")
chk "კონტექსტი (ოპერაციის გარეშე) → ავტომატურად C1, POD 0, ვადა +30, attribution operation" \
  "$(echo "$CTX" | jq -r --arg c "$C1" '"\(.or_case_id==$c):\(.pod):\(.followup_until):\(.attribution)"')" "true:0:$(date -d "$TODAY +30 days" +%F):operation"
chk "სხვა პაციენტის ოპერაცია → 400 OR_CASE; ინფექცია ოპერაციამდე → 400 ONSET_BEFORE_OPERATION" \
  "$(ecode GET "/ipc/hai/context?patient_id=$P1&onset_date=$TODAY&hai_type=ssi&or_case_id=$C2" "$IC"):$(ecode GET "/ipc/hai/context?patient_id=$P1&onset_date=$YDAY&hai_type=ssi&or_case_id=$C1" "$IC")" "OR_CASE:ONSET_BEFORE_OPERATION"
H1=$(api POST /ipc/hai "$IC" -d "{\"patient_id\":\"$P1\",\"hai_type\":\"ssi\",\"onset_date\":\"$TODAY\",\"ssi_depth\":\"deep\",\"signal_ids\":[\"$SID\"]}")
H1ID=$(echo "$H1" | jq -r '.id // empty')
chk "სიგნალიდან: ოპერაცია C1 (სიგნალიდან), გაწერის შემდეგ, ქირურგია, ღრმა" \
  "$(echo "$H1" | jq -r --arg c "$C1" --arg d "$DS" '"\(.or_case_id==$c):\(.or_case_no!=null):\(.post_discharge):\(.department_id==$d):\(.ssi_depth)"')" "true:true:true:true:deep"
REQ=$(echo "$H1" | jq -c '[.criteria[]|select(.required)|.id]'); PAT=$(echo "$H1" | jq -r '[.criteria[]|select(.required|not)][0].id')
api PATCH "/ipc/hai/$H1ID" "$IC" -d "{\"criteria_met\":$(echo "$REQ" | jq -c --arg p "$PAT" '. + [$p] | map(select(. != "null"))')}" >/dev/null
R=$(api POST "/ipc/hai/$H1ID/confirm" "$IC")
chk "დადასტურება (ჰოსპიტალიზაციის 1-ელ დღეს — ONSET_EARLY არ მოქმედებს SSI-ზე)" "$(echo "$R" | jq -r .status)" "confirmed"
chk "ოპერაცია C1 → SSI (შემთხვევა მიბმულია), კონტაქტი გაუქმდა („SSI დადასტურდა“)" \
  "$(api GET "/ipc/ssi/ops/$C1" "$IC" | jq -r --arg h "$H1ID" '"\(.status):\(.ssi_case_id==$h):\(.ssi_depth):\(.followup.status):\(.followup.cancel_reason)"')" "ssi:true:deep:cancelled:SSI დადასტურდა"
chk "SSI-ით ოპერაციის გამორიცხვა → 409 SSI_CONFIRMED" "$(ecode PATCH "/ipc/ssi/ops/$C1" "$IC" -d '{"excluded":true,"excluded_reason":"ტესტ-E2E"}')" "SSI_CONFIRMED"
chk "ხელახლა გახსნა → ოპერაცია ისევ აქტიური; დადასტურება → SSI" \
  "$(api POST "/ipc/hai/$H1ID/reopen" "$IC" -d '{"reason":"ტესტ-E2E: გადახედვა"}' >/dev/null; api GET "/ipc/ssi/ops/$C1" "$IC" | jq -r .status):$(api POST "/ipc/hai/$H1ID/confirm" "$IC" >/dev/null; api GET "/ipc/ssi/ops/$C1" "$IC" | jq -r .status)" "active:ssi"
chk "C2-ის შემთხვევა უარყოფილი → ოპერაცია C2 აქტიური რჩება" "$(api POST "/ipc/hai/$H2/reject" "$IC" -d '{"reason":"ტესტ-E2E: სუფთა ჭრილობა ვიზიტზე"}' | jq -r .status):$(api GET "/ipc/ssi/ops/$C2" "$IC" | jq -r .status)" "rejected:active"
chk "HAI სიაში: ოპერაციის ნომერი, გაწერის შემდეგ" "$(api GET "/ipc/hai?hai_type=ssi&q=SSI-" "$IC" | jq -r --arg h "$H1ID" '.[]|select(.id==$h)|"\(.or_case_no!=null):\(.post_discharge)"')" "true:true"
chk "SSI-ს ოპერაციის შეცვლა სხვა ტიპზე (BSI) → 400 OR_CASE" "$(api POST "/ipc/hai/$H2/reopen" "$IC" -d '{"reason":"ტესტ-E2E"}' >/dev/null; ecode PATCH "/ipc/hai/$H2" "$IC" -d "{\"hai_type\":\"bsi\",\"or_case_id\":\"$C2\"}")" "OR_CASE"

step "7. მაჩვენებლები"
RT=$(api GET "/ipc/ssi/rates?from=$TODAY&to=$TODAY" "$IC")
chk "CHOL: 1 ოპერაცია, 1 SSI (100%), ღრმა 1, გაწერის შემდეგ 1, NNIS 0 — 1/1, პროფილაქტიკა დროულად 100%" \
  "$(echo "$RT" | jq -r '[.rows[]|select(.category=="CHOL")][0]|"\(.ops >= 1):\(.ssi >= 1):\(.deep >= 1):\(.post_discharge >= 1):\(.s0 >= 1)"')" "true:true:true:true:true"
chk "HPRO: ოპერაცია აქტიურ დაკვირვებაში, NNIS 3, პროფილაქტიკა — 0 დროულად" \
  "$(echo "$RT" | jq -r '[.rows[]|select(.category=="HPRO")][0]|"\(.active >= 1):\(.r3 >= 1):\(.ph_known >= .ph_timely)"')" "true:true:true"
chk "IPC განყ. ტრავმატოლოგია: მხოლოდ HPRO" "$(api GET "/ipc/ssi/rates?from=$TODAY&to=$TODAY" "$IDT" | jq -r '[.rows[].category]|unique|join(",")')" "HPRO"
chk "rates: from > to → 400; ექთანი / ქირურგი → 403" "$(code GET "/ipc/ssi/rates?from=$TODAY&to=$YDAY" "$IC"):$(code GET "/ipc/ssi/rates?from=$TODAY&to=$TODAY" "$SU")" "400:403"

step "8. მოდულის გამორთვა / აღდგენა"
ipcset '{"ssi_surveillance":false}'
chk "ssi_surveillance = false: გადათვლა → 409 SSI_OFF" "$(ecode POST /ipc/ssi/refresh "$IC" -d '{}')" "SSI_OFF"
api PUT /modules/ipc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია: SSI სია / კონტაქტები → 403; ოქმი — კლასი მაინც ჩანს (optional)" \
  "$(code GET /ipc/ssi/ops "$IC"):$(code GET /ipc/ssi/followups "$IC"):$(api GET "/or/cases/$C1/note" "$SU" | jq -r .wound_class_mode)" "403:403:optional"
api PUT /modules/ipc "$ADM" -d "{\"enabled\":$(echo "$O_IPC" | jq '.enabled'),\"settings\":$(echo "$O_IPC" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
api PUT /modules/or "$ADM" -d "{\"settings\":$O_OR,\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$O_INP,\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')" "$O_IPC"
AUD=$( (api GET "/audit-logs?entity_name=ipc_ssi_ops&limit=100" "$ADM"; api GET "/audit-logs?entity_name=ipc_ssi_followups&limit=100" "$ADM"; api GET "/audit-logs?entity_name=ipc_ssi_categories&limit=100" "$ADM"; api GET "/audit-logs?entity_name=or_procedures&limit=100" "$ADM") | jq -s -r '[.[]|(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: IPC_SSI_REFRESH / OP_UPDATE / FOLLOWUP_ATTEMPT / FOLLOWUP_DONE / CATEGORY_CREATE / PROCEDURE" \
  "$(for a in IPC_SSI_REFRESH IPC_SSI_OP_UPDATE IPC_SSI_FOLLOWUP_ATTEMPT IPC_SSI_FOLLOWUP_DONE IPC_SSI_CATEGORY_CREATE IPC_SSI_PROCEDURE; do echo "$AUD" | tr ',' '\n' | grep -qx "$a" && echo y || echo "$a"; done | sort -u | tr '\n' ' ')" "y "

step "გასუფთავება"
api PATCH "/ipc/ssi/categories/$NC" "$IC" -d '{"is_active":false}' >/dev/null
for p in $PCH $PHP $PHE; do api PATCH "/or/procedures/$p" "$ADM" -d '{"is_active":false}' >/dev/null; done
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო მომხმარებლები / პროცედურები / კატეგორია გათიშულია (ოპერაციები / SSI ჩანაწერები რეესტრში რჩება — ტესტ-E2E პაციენტებით)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
