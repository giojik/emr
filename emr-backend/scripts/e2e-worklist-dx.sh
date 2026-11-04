#!/usr/bin/env bash
# =====================================================================
# e2e-worklist-dx.sh — სამუშაო სიები, ეტაპი 4 (0084): დიაგნოსტიკის სისტემური წყაროები + პასუხის გაცნობა + ზარის ჩახშობა
#   პარამეტრები (ვალიდაცია), კატალოგი (102 წყარო, 4 ახალი ჯგუფი); ლაბ.: აღება (ამბულატორია — ფლებოტომისტი, სტაციონარი — ექთანი),
#   „ვერ აიღეს“ (lab_recollect + dx_issue), შედეგი, ვალიდაცია (კრიტიკული → სასწრაფო), „ვის ეცნობა“ (required → 409 / task → lab_crit_call → ჩაწერა),
#   კრიტიკული → დამნიშნავს (res_critical) → „გავეცანი“ ქმედებით; პასუხის გაცნობა (ack_scope: abnormal / all, სტაციონარი — მკურნალს),
#   შესწორება → თავიდან; ლაბ. ვიზიტი ექიმის გარეშე — არავის; ზარის ჩახშობა (non_urgent: ჩვეულებრივი — წაკითხულად, კრიტიკული — ზარში);
#   რადიოლოგია (დაგეგმვა — rad_scheduler, შესრულება, დასკვნა — მონახაზის ავტორი, კრიტიკული მიგნება → მკურნალს, „ვერ შესრულდა“ → დამნიშნავს);
#   მიმართვა (referrals — diagnostic / რეგისტრატორი); diagnostics (0084-ის ველები); admin — 0.
# ბოლოს: ჰოსპიტალიზაცია — გაუქმება / გაწერა; კვლევები / აპარატი / მომხმარებლები / განყოფილებები — გათიშული; პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-worklist-dx.sh [API_URL]
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
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
it()   { api GET "/worklist/mine?source=${1%%:*}" "$2" | jq -c --arg k "$1" '[.items[]|select(.key==$k)][0] // empty'; }
inm()  { api GET "/worklist/mine?source=${1%%:*}" "$2" | jq -r --arg k "$1" '[.items[]|select(.key==$k)]|length'; }
wl()   { api PUT /modules/worklist "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
pay()  { local sh; sh=$(api GET "/invoices/encounter/$1" "$ADM" | jq -r '.patient_share // 0'); [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ] && api POST "/encounters/$1/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; return 0; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0084" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0084" | tostring)')" "ok:true"
ORIG=$(api GET /modules "$ADM")
orig() { echo "$ORIG" | jq -c --arg c "$1" '.[]|select(.code==$c)|{enabled, settings}'; }
[ -n "$(orig worklist)" ] && [ -n "$(orig inpatient)" ] || die "მოდულები ვერ მოიძებნა"
api PUT /modules/worklist "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"enabled":true,"settings":{"bed_assign_mode":"direct"},"reason":"ტესტ-E2E"}' >/dev/null
dep() { local id; id=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WD $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/deps"; echo "$id"; }
DO=$(dep "ამბულატორია" E2EWDO outpatient); DI=$(dep "თერაპია" E2EWDI inpatient); DX=$(dep "დიაგნოსტიკა" E2EWDX diagnostic)
[ -n "$DO" ] && [ -n "$DI" ] && [ -n "$DX" ] || die "განყოფილებები ვერ შეიქმნა"
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -r '[.types[]?|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end')
W=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DI\",\"code\":\"WD\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BEDS=$(api POST "/inpatient/wards/$W/beds" "$ADM" -d "{\"count\":2,\"type_code\":\"$BT\"}")
[ -n "$(echo "$BEDS" | jq -r '.[1].id // empty')" ] || die "საწოლები ვერ შეიქმნა"
TC=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2E_WD_$S\",\"title\":\"ტესტ-E2E კონსულტაცია\",\"base_price\":10}" | jq -r .id)
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.wd.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"დიაგ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.wd.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
DOCX=",\"department_id\":\"$DO\",\"specialty\":\"თერაპევტი\",\"license_number\":\"MD-$S\",\"consultation_tariff_id\":\"$TC\""
read -r RCID RC <<< "$(mkuser '["receptionist"]' 51)"
read -r PHID PH <<< "$(mkuser '["phlebotomist"]' 52)"
read -r LTID LT <<< "$(mkuser '["diagnostic"]' 53 ",\"department_id\":\"$DX\"")"
read -r LDID LD <<< "$(mkuser '["lab_doctor"]' 54)"
read -r D1ID D1 <<< "$(mkuser '["doctor"]' 55 "$DOCX")"
read -r D2ID D2 <<< "$(mkuser '["doctor"]' 56 "${DOCX/MD-$S/MD2-$S}")"
read -r DAID DA <<< "$(mkuser '["doctor"]' 57 ",\"department_id\":\"$DI\"")"
read -r DHID DH <<< "$(mkuser '["doctor"]' 58 ",\"department_id\":\"$DI\",\"is_section_head\":true")"
read -r NAID NA <<< "$(mkuser '["nurse"]' 59 ",\"department_id\":\"$DI\"")"
read -r NBID NB <<< "$(mkuser '["nurse"]' 60 ",\"department_id\":\"$DI\"")"
read -r RTID RT <<< "$(mkuser '["radiographer"]' 61)"
read -r RDID RD <<< "$(mkuser '["radiologist"]' 62)"
read -r R2ID R2 <<< "$(mkuser '["radiologist"]' 63)"
read -r LMID LM <<< "$(mkuser '["lab_manager"]' 64)"
for t in RC PH LT LD D1 D2 DA DH NA NB RT RD R2 LM; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "14 მომხმარებელი (რეგისტრატორი, ფლებოტომისტი, ლაბორანტი, ლაბ. ექიმი, 2 ამბ. ექიმი, მკურნალი + ხელმძღვანელი, 2 ექთანი, ტექნიკოსი, 2 რადიოლოგი, ლაბ. მენეჯერი)"
svc() { local id; id=$(api POST /dx/catalog "$LM" -d "$1" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/svcs"; echo "$id"; }
SK=$(svc "{\"section\":\"lab\",\"code\":\"LAB_E2E_WDK_$S\",\"name\":\"ტესტ-E2E WD კალიუმი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}")
AK=$(api POST "/dx/catalog/$SK/analytes" "$LM" -d '{"code":"K","name":"კალიუმი","unit":"mmol/L","result_type":"numeric","decimals":1,"critical_low":2.8,"critical_high":6.2,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.5,"high":5.1}]}' | jq -r '.analytes[0].id // empty')
SN=$(svc "{\"section\":\"lab\",\"code\":\"LAB_E2E_WDN_$S\",\"name\":\"ტესტ-E2E WD ნატრიუმი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"plasma\",\"container\":\"Heparin\"}")
AN=$(api POST "/dx/catalog/$SN/analytes" "$LM" -d '{"code":"NA","name":"ნატრიუმი","unit":"mmol/L","result_type":"numeric","decimals":0,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":135,"high":145}]}' | jq -r '.analytes[0].id // empty')
SC=$(svc "{\"section\":\"radiology\",\"code\":\"RAD_E2E_WD_$S\",\"name\":\"ტესტ-E2E WD CT თავი $S\",\"group_name\":\"ტესტ-E2E\",\"modality\":\"CT\",\"body_part\":\"head\"}")
[ -z "$SC" ] && SC=$(api POST /dx/catalog "$ADM" -d "{\"section\":\"radiology\",\"code\":\"RAD_E2E_WD_$S\",\"name\":\"ტესტ-E2E WD CT თავი $S\",\"group_name\":\"ტესტ-E2E\",\"modality\":\"CT\",\"body_part\":\"head\"}" | jq -r '.id // empty') && [ -n "$SC" ] && echo "$SC" >> "$TMP/svcs"
[ -n "$AK" ] && [ -n "$AN" ] && [ -n "$SC" ] || die "კატალოგი ვერ შეიქმნა"
ok "კატალოგი: კალიუმი (კრიტიკული ზღვრებით), ნატრიუმი, CT (აპარატი არ იქმნება — დაგეგმვა აქ არ მოწმდება)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"დიაგ-$2\",\"birth_date\":\"$3\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 41 "ერთი" 1961-01-01); P2=$(mkpat 42 "ორი" 1962-02-02); P3=$(mkpat 43 "სამი" 1963-03-03)
for p in P1 P2 P3; do [ -n "${!p}" ] || die "პაციენტი $p ვერ შეიქმნა"; done
wl '{"sources":{},"dx_list_mode":"all","ack_scope":"abnormal","lab_crit_call":"task","bell_suppress":"off","rad_scheduler":"radiographer","critical_ack_min":30,"nurse_scope":"department","reg_scope":"all"}'

step "1. პარამეტრები, კატალოგი"
chk "dx_list_mode / ack_scope / lab_tat_hours (უცნობი გასაღები) / bell_suppress all_mapped / kpi_interval_min 20 — 400" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"dx_list_mode":"x"},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"ack_scope":"some"},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"lab_tat_hours":{"foo":2}},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"bell_suppress":"all_mapped"},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"kpi_interval_min":20},"reason":"ტესტ"}')" "400:400:400:400:400"
chk "0084a: dx_max_age_days 0 / 366, lab_collect_days 0 / 91 — 400" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"dx_max_age_days":0},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"dx_max_age_days":366},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"lab_collect_days":0},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"lab_collect_days":91},"reason":"ტესტ"}')" "400:400:400:400"
chk "sla_hours: lab_validate — 200" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"sla_hours":{"stk_approve":24,"stk_issue":24,"stk_receive":24,"stk_urgent":4,"proc_approve":48,"asset_move":72,"med_verify":2,"med_approve":4,"doc_cosign":24,"or_docs":24,"lab_validate":4}},"reason":"ტესტ-E2E"}')" "200"
REFS=$(api GET /worklist/refs "$D1")
chk "კატალოგი: 101 წყარო (0088: + er_consult); 4 ახალი ჯგუფი; can.ack ექიმს" "$(echo "$REFS" | jq -r '.sources|length'):$(echo "$REFS" | jq -r '[.sources[].group]|unique|map(select(.=="ლაბორატორია" or .=="პასუხის გაცნობა" or .=="რადიოლოგია / ენდოსკოპია" or .=="ამბულატორიული მიმართვები"))|length'):$(echo "$REFS" | jq -r .can.ack)" "101:4:true"
CODES="lab_collect lab_recollect lab_receive lab_result lab_validate lab_crit_call lab_qc lab_unmatched lab_ext_send lab_ext_due res_critical res_ack rad_schedule rad_perform rad_report endo_report endo_path dx_issue ref_todo amb_dx_pending"
chk "ყველა ახალი წყარო — ?source → 200 (ექიმი / ლაბ. / რადიოლოგი / ფლებოტომისტი / რეგისტრატორი)" "$(for t in D1 LD LT RD PH RC; do for c in $CODES; do code GET "/worklist/mine?source=$c" "${!t}"; echo; done; done | sort -u | tr '\n' ' ')" "200 "

step "2. ლაბ. — ამბულატორია (ფლებოტომისტი → ლაბორანტი → ლაბ. ექიმი → დამნიშნავი)"
E1=$(api POST /encounters/walk-in "$RC" -d "{\"patient_id\":\"$P1\",\"doctor_id\":\"$D1ID\"}" | jq -r '.encounter_id // empty'); pay "$E1"
[ -n "$E1" ] || die "ვიზიტი ვერ შეიქმნა"
chk "ექიმი ნიშნავს 2 ანალიზს" "$(api POST "/encounters/$E1/dx-orders" "$D1" -d "{\"items\":[{\"service_id\":\"$SK\"},{\"service_id\":\"$SN\"}]}" | jq -r 'if type=="array" then length else (.message|tostring) end')" "2"
X=$(it "lab_collect:$E1" "$PH")
chk "lab_collect: ფლებოტომისტს (2 ანალიზი, ბმული /collection); ლაბორანტს / ექთანს — არა" "$(echo "$X" | jq -r '"\(.title|test("2 ანალიზი")):\(.link)"'):$(inm "lab_collect:$E1" "$LT"):$(inm "lab_collect:$E1" "$NA")" "true:/collection:0:0"
wl '{"dx_list_mode":"attention"}'
chk "dx_list_mode = attention → ჩვეულებრივი, ვადამდე — არ ჩანს" "$(inm "lab_collect:$E1" "$PH")" "0"
wl '{"dx_list_mode":"all"}'
api POST "/dx/collection/$E1/issue" "$PH" -d '{"reason":"ტესტ-E2E: ვენა ვერ მოიძებნა"}' >/dev/null
chk "„ვერ აიღეს“ → lab_recollect (მაღალი) + dx_issue დამნიშნავს; lab_collect — ქრება" "$(it "lab_recollect:$E1" "$PH" | jq -r .priority):$(inm "dx_issue:$E1:lab" "$D1"):$(inm "lab_collect:$E1" "$PH"):$(inm "dx_issue:$E1:lab" "$D2")" "high:1:0:0"
SP=$(api POST "/encounters/$E1/dx-collect" "$PH" -d '{"identity_confirmed":true,"unpaid_ack":true}')
chk "აღება → lab_recollect / dx_issue ქრება" "$(echo "$SP" | jq -r 'if type=="array" then length else 0 end'):$(inm "lab_recollect:$E1" "$PH"):$(inm "dx_issue:$E1:lab" "$D1")" "2:0:0"
for bc in $(echo "$SP" | jq -r '.[].barcode'); do api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null; done
ITS=$(api GET "/encounters/$E1/dx-orders" "$D1"); IK=$(echo "$ITS" | jq -r ".[]|select(.service_id==\"$SK\")|.id"); INA=$(echo "$ITS" | jq -r ".[]|select(.service_id==\"$SN\")|.id")
chk "lab_result (all): ლაბორანტს; ლაბ. ექიმს — არა (diagnostic არის)" "$(inm "lab_result:$IK" "$LT"):$(inm "lab_result:$IK" "$LD")" "1:0"
api PUT "/lab/items/$IK/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AK\",\"value\":\"6.8\"}]}" >/dev/null
api PUT "/lab/items/$INA/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AN\",\"value\":\"140\"}]}" >/dev/null
X=$(it "lab_validate:$IK" "$LD")
chk "lab_validate: კრიტიკული K 6.8 → ლაბ. ექიმს, სასწრაფო, ⚠; ნატრიუმი — ჩვეულებრივი; ლაბორანტს — არა; lab_result ქრება" "$(echo "$X" | jq -r '"\(.priority):\(.title|startswith("⚠"))"'):$(it "lab_validate:$INA" "$LD" | jq -r .priority):$(inm "lab_validate:$IK" "$LT"):$(inm "lab_result:$IK" "$LT")" "urgent:true:normal:0:0"
chk "სრული სია (ფილტრის გარეშე) — ლაბ. ექიმს lab_validate ჩანს (წყაროების ჯგუფი შეცდომის გარეშე)" "$(api GET /worklist/mine "$LD" | jq -r --arg k "lab_validate:$IK" '[.items[]|select(.key==$k)]|length')" "1"
wl '{"lab_crit_call":"required"}'
chk "lab_crit_call = required: ვალიდაცია „ვის ეცნობა“-ს გარეშე → 409 CRIT_CALL_REQUIRED" "$(api POST "/lab/items/$IK/validate" "$LD" -d '{}' | jq -r .code)" "CRIT_CALL_REQUIRED"
wl '{"lab_crit_call":"task"}'
api POST "/lab/items/$INA/validate" "$LD" -d '{}' >/dev/null
chk "task: ვალიდაცია ჩაწერის გარეშე — 200" "$(api POST "/lab/items/$IK/validate" "$LD" -d '{}' | jq -r .status)" "validated"
X=$(it "lab_crit_call:$IK" "$LD")
chk "lab_crit_call: ვალიდატორს (სასწრაფო, მნიშვნელობით); lab_validate ქრება" "$(echo "$X" | jq -r '"\(.priority):\(.detail|test("6.8"))"'):$(inm "lab_validate:$IK" "$LD")" "urgent:true:0"
chk "crit-call: ვის / როგორ — სავალდებულო (400)" "$(code POST "/lab/items/$IK/crit-call" "$LD" -d '{"to":"x"}')" "400"
chk "crit-call → ჩაიწერა; lab_crit_call ქრება; მეორედ — 409" "$(api POST "/lab/items/$IK/crit-call" "$LD" -d '{"to":"დ. ტესტ-E2E","via":"phone","readback":true}' | jq -r .via):$(inm "lab_crit_call:$IK" "$LD"):$(code POST "/lab/items/$IK/crit-call" "$LD" -d '{"to":"დ. ტესტ-E2E","via":"phone"}')" "phone:0:409"
chk "crit-call ჩანს შეკვეთაზე (crit_notified_to)" "$(api GET "/lab/items/$IK" "$LD" | jq -r '.crit_notified_to // empty')" "დ. ტესტ-E2E"
X=$(it "res_critical:$IK" "$D1")
chk "res_critical: დამნიშნავს (სასწრაფო, ბმული /tasks?ack=); სხვა ამბ. ექიმს — არა (ესკალაციამდე)" "$(echo "$X" | jq -r '"\(.priority):\(.link)"'):$(inm "res_critical:$IK" "$D2")" "urgent:/tasks?ack=$E1:0"
chk "res_ack (abnormal): ნორმალური ნატრიუმი — არ ჩანს; კრიტიკული — res_ack-ში არ ორმაგდება" "$(inm "res_ack:$E1" "$D1")" "0"
wl '{"ack_scope":"all"}'
chk "ack_scope = all → res_ack: 1 პასუხი (ნატრიუმი)" "$(it "res_ack:$E1" "$D1" | jq -r '.title|test(": 1 —")')" "true"
PND=$(api GET "/dx/acks/pending?encounter_id=$E1" "$D2")
chk "pending: იმავე განყოფილების ექიმი ხედავს (2 პასუხი, 1 კრიტიკული); ექთანი / ლაბორანტი — 403" "$(echo "$PND" | jq -r '"\(.can_ack):\(.items|length):\([.items[]|select(.critical)]|length)"'):$(code GET "/dx/acks/pending?encounter_id=$E1" "$NA"):$(code GET "/dx/acks/pending?encounter_id=$E1" "$LT")" "true:2:1:403:403"
chk "„გავეცანი“ კრიტიკულზე ქმედების გარეშე → 400 CRITICAL_ACTION_REQUIRED; „სხვა“ შენიშვნის გარეშე → 400" "$(api POST /dx/acks "$D1" -d "{\"item_ids\":[\"$IK\"]}" | jq -r .code):$(code POST /dx/acks "$D1" -d "{\"item_ids\":[\"$IK\"],\"action\":\"other\"}")" "CRITICAL_ACTION_REQUIRED:400"
chk "ლაბორანტს „გავეცანი“ — 403" "$(code POST /dx/acks "$LT" -d "{\"item_ids\":[\"$IK\"],\"action\":\"treatment\"}")" "403"
chk "„გავეცანი“ (მკურნალობა შეიცვალა) → 2; res_critical / res_ack ქრება; მეორედ — already 2" "$(api POST /dx/acks "$D1" -d "{\"item_ids\":[\"$IK\",\"$INA\"],\"action\":\"treatment\",\"note\":\"ტესტ-E2E\"}" | jq -r .acked):$(inm "res_critical:$IK" "$D1"):$(inm "res_ack:$E1" "$D1"):$(api POST /dx/acks "$D1" -d "{\"item_ids\":[\"$IK\"],\"action\":\"treatment\"}" | jq -r .already)" "2:0:0:1"
chk "ისტორია: critical / treatment" "$(api GET "/dx/acks/item/$IK" "$D1" | jq -r '.[0]|"\(.kind):\(.action)"')" "critical:treatment"
api POST "/lab/items/$IK/reopen" "$LD" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
api PUT "/lab/items/$IK/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AK\",\"value\":\"6.9\"}]}" >/dev/null
api POST "/lab/items/$IK/validate" "$LD" -d '{"crit_to":"დ. ტესტ-E2E 2","crit_via":"in_person","crit_readback":true}' >/dev/null
chk "შესწორება + ხელახალი ვალიდაცია (ჩაწერით) → lab_crit_call — არა; res_critical — თავიდან" "$(inm "lab_crit_call:$IK" "$LD"):$(inm "res_critical:$IK" "$D1")" "0:1"
api POST /dx/acks "$D1" -d "{\"item_ids\":[\"$IK\"],\"action\":\"monitor\"}" >/dev/null
chk "admin-ს დიაგნოსტიკის წყაროებში — 0" "$(api GET /worklist/mine "$ADM" | jq -r '[.items[]|select(.source|test("^(lab_|res_|rad_|endo_|dx_|ref_|amb_dx)"))]|length')" "0"

step "3. ლაბ. ვიზიტი (ექიმის გარეშე) — პასუხის გაცნობა არავის; ზარის ჩახშობა"
E3=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$P3\",\"items\":[{\"service_id\":\"$SN\"}]}" | jq -r '.encounter_id // empty'); pay "$E3"
BC=$(api POST "/encounters/$E3/dx-collect" "$PH" -d '{"identity_confirmed":true,"unpaid_ack":true}' | jq -r '.[0].barcode // empty'); api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC\"}" >/dev/null
I3=$(api GET "/encounters/$E3/dx-orders" "$RC" | jq -r '.[0].id'); api PUT "/lab/items/$I3/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AN\",\"value\":\"150\"}]}" >/dev/null
api POST "/lab/items/$I3/validate" "$LD" -d '{}' >/dev/null
chk "ლაბ. ვიზიტის პასუხი (H) — res_ack არავის (რეგისტრატორი დამნიშნავია)" "$(inm "res_ack:$E3" "$D1"):$(inm "res_ack:$E3" "$RC")" "0:0"
E4=$(api POST /encounters/walk-in "$RC" -d "{\"patient_id\":\"$P3\",\"doctor_id\":\"$D1ID\"}" | jq -r '.encounter_id // empty'); pay "$E4"
api POST "/encounters/$E4/dx-orders" "$D1" -d "{\"items\":[{\"service_id\":\"$SN\"},{\"service_id\":\"$SK\"}]}" >/dev/null
SP4=$(api POST "/encounters/$E4/dx-collect" "$PH" -d '{"identity_confirmed":true,"unpaid_ack":true}'); for bc in $(echo "$SP4" | jq -r '.[].barcode'); do api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null; done
I4=$(api GET "/encounters/$E4/dx-orders" "$D1"); I4N=$(echo "$I4" | jq -r ".[]|select(.service_id==\"$SN\")|.id"); I4K=$(echo "$I4" | jq -r ".[]|select(.service_id==\"$SK\")|.id")
api PUT "/lab/items/$I4N/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AN\",\"value\":\"138\"}]}" >/dev/null
api PUT "/lab/items/$I4K/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AK\",\"value\":\"2.1\"}]}" >/dev/null
api POST /notifications/read-all "$D1" >/dev/null
wl '{"bell_suppress":"non_urgent","ack_scope":"all"}'
api POST "/lab/items/$I4N/validate" "$LD" -d '{}' >/dev/null; sleep 1
N=$(api GET "/notifications" "$D1")
chk "non_urgent + ack_scope all: „პასუხი მზადაა“ → წაკითხულად (suppressed), მთვლელი 0" "$(api GET /notifications/count "$D1" | jq -r .unread):$(echo "$N" | jq -r '[.[]|select(.kind=="lab_ready" and .suppressed and .read_at!=null)]|length>0')" "0:true"
api POST "/lab/items/$I4K/validate" "$LD" -d '{"crit_to":"დ. ტესტ-E2E","crit_via":"phone"}' >/dev/null; sleep 1
chk "კრიტიკული (K 2.1) — ზარში ჩნდება (სასწრაფო, არ იხშობა)" "$(api GET /notifications/count "$D1" | jq -r '"\(.unread):\(.urgent)"')" "1:1"
wl '{"ack_scope":"abnormal"}'
api POST /notifications/read-all "$D1" >/dev/null
api PUT "/lab/items/$I4N/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AN\",\"value\":\"138\"}]}" >/dev/null
api POST "/lab/items/$I4N/reopen" "$LD" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
api POST "/lab/items/$I4N/validate" "$LD" -d '{}' >/dev/null; sleep 1
chk "ack_scope = abnormal → „პასუხი მზადაა“ არ იხშობა (ნორმა სიაში არ ჩანს)" "$(api GET /notifications/count "$D1" | jq -r .unread)" "1"
wl '{"bell_suppress":"off"}'
api POST /dx/acks "$D1" -d "{\"item_ids\":[\"$I4K\"],\"action\":\"repeat\"}" >/dev/null

step "4. სტაციონარი: აღება — ექთანი; პასუხი — მკურნალი"
ADM2=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P2\",\"department_id\":\"$DI\",\"attending_doctor_id\":\"$DAID\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\",\"bed_id\":\"$(echo "$BEDS" | jq -r '.[0].id')\"}")
E2=$(echo "$ADM2" | jq -r '.encounter_id // empty')
[ -n "$E2" ] && echo "$E2" >> "$TMP/stays" || die "ჰოსპიტალიზაცია ვერ მოხერხდა: $(echo "$ADM2" | head -c 300)"
api POST "/encounters/$E2/dx-orders" "$DA" -d "{\"items\":[{\"service_id\":\"$SK\",\"priority\":\"urgent\"}]}" >/dev/null
X=$(it "lab_collect:$E2" "$NA")
chk "lab_collect: განყოფილების ექთნებს (სასწრაფო); ფლებოტომისტს — არა" "$(echo "$X" | jq -r .priority):$(inm "lab_collect:$E2" "$NB"):$(inm "lab_collect:$E2" "$PH")" "urgent:1:0"
wl '{"dx_list_mode":"attention"}'
chk "attention: სასწრაფო — ჩანს" "$(inm "lab_collect:$E2" "$NA")" "1"
wl '{"dx_list_mode":"all"}'
BC2=$(api POST "/encounters/$E2/dx-collect" "$NA" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty'); api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC2\"}" >/dev/null
I2=$(api GET "/encounters/$E2/dx-orders" "$DA" | jq -r '.[0].id')
api PUT "/lab/items/$I2/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AK\",\"value\":\"3.2\"}]}" >/dev/null
api POST "/lab/items/$I2/validate" "$LD" -d '{}' >/dev/null
X=$(it "res_ack:$E2" "$DA")
chk "res_ack (L): მკურნალს (მაღალი); ხელმძღვანელს — არა; ბმული /tasks?ack=" "$(echo "$X" | jq -r '"\(.priority):\(.link)"'):$(inm "res_ack:$E2" "$DH")" "high:/tasks?ack=$E2:0"
api POST "/users/$DAID/disable" "$ADM" -d '{}' >/dev/null
chk "მკურნალი არააქტიურია → ხელმძღვანელს (doctorOwner)" "$(inm "res_ack:$E2" "$DH")" "1"
api POST "/users/$DAID/enable" "$ADM" -d '{}' >/dev/null; DA=$(login "e2e.wd.57.$S@test.local" "E2e-$S-pass-57")
api POST /dx/acks "$DH" -d "{\"item_ids\":[\"$I2\"]}" >/dev/null
chk "განყოფილების ექიმის „გავეცანი“ ხურავს ყველასთვის" "$(inm "res_ack:$E2" "$DA"):$(inm "res_ack:$E2" "$DH")" "0:0"

step "5. რადიოლოგია"
ORD=$(api POST "/encounters/$E2/dx-orders" "$DA" -d "{\"items\":[{\"service_id\":\"$SC\",\"priority\":\"urgent\"},{\"service_id\":\"$SC\"}]}")
ICT=$(echo "$ORD" | jq -r 'if type=="array" then .[0].id else empty end'); ICT2=$(echo "$ORD" | jq -r 'if type=="array" then .[1].id else empty end')
[ -n "$ICT" ] || die "CT შეკვეთა: $(echo "$ORD" | head -c 200)"
chk "rad_schedule: ტექნიკოსს (სტაციონარი → მაღალი); რეგისტრატორს — არა (radiographer)" "$(it "rad_schedule:$ICT" "$RT" | jq -r .priority):$(inm "rad_schedule:$ICT" "$RC")" "high:0"
wl '{"rad_scheduler":"both"}'
chk "rad_scheduler = both → რეგისტრატორსაც" "$(inm "rad_schedule:$ICT" "$RC")" "1"
wl '{"rad_scheduler":"radiographer"}'
chk "rad_perform: სასწრაფო სტაციონარული — ტექნიკოსს" "$(it "rad_perform:$ICT" "$RT" | jq -r .priority)" "urgent"
api POST "/dx-orders/$ICT2/exam-issue" "$RT" -d '{"reason":"ტესტ-E2E: პაციენტი ვერ გადაიყვანეს"}' >/dev/null
chk "„ვერ შესრულდა“ → dx_issue მკურნალს; rad_schedule-იდან ქრება" "$(inm "dx_issue:$E2:radiology" "$DA"):$(inm "rad_schedule:$ICT2" "$RT")" "1:0"
api POST "/dx-orders/$ICT/arrive" "$RT" -d '{}' >/dev/null
chk "შესრულება → rad_report რადიოლოგებს; rad_perform ქრება" "$(api POST "/dx-orders/$ICT/perform" "$RT" -d '{"identity_confirmed":true}' | jq -r .status):$(inm "rad_report:$ICT" "$RD"):$(inm "rad_report:$ICT" "$R2"):$(inm "rad_perform:$ICT" "$RT")" "performed:1:1:0"
api PUT "/dx-orders/$ICT/report" "$RD" -d '{"findings":"ტესტ-E2E","impression":"ტესტ-E2E"}' >/dev/null
chk "მონახაზი → მხოლოდ ავტორს" "$(inm "rad_report:$ICT" "$RD"):$(inm "rad_report:$ICT" "$R2")" "1:0"
api POST "/dx-orders/$ICT/report/sign" "$RD" -d '{"findings":"ჰიპოდენსური უბანი — ტესტ-E2E.","impression":"მწვავე იშემიური ინსულტი — ტესტ-E2E.","is_critical":true,"critical_notified_to":"დ. ტესტ-E2E, ტელ."}' >/dev/null
chk "კრიტიკული მიგნება → res_critical მკურნალს; rad_report ქრება" "$(it "res_critical:$ICT" "$DA" | jq -r .priority):$(inm "rad_report:$ICT" "$RD")" "urgent:0"
api POST /dx/acks "$DA" -d "{\"item_ids\":[\"$ICT\"],\"action\":\"escalated\"}" >/dev/null
chk "„გავეცანი“ (ესკალაცია) → ქრება" "$(inm "res_critical:$ICT" "$DA")" "0"

step "6. მიმართვები"
RT1=$(api GET /tariffs/referral-types "$ADM")
if [ "$(echo "$RT1" | jq -r '[.[]|select(.type=="specialist_consult" or .type=="hospitalization")]|length')" = "2" ]; then
  R1=$(api POST "/encounters/$E1/referrals" "$D1" -d "{\"type\":\"specialist_consult\",\"target_department_id\":\"$DX\",\"reason\":\"ტესტ-E2E კონსულტაცია\"}" | jq -r '.id // empty')
  R2=$(api POST "/encounters/$E1/referrals" "$D1" -d '{"type":"hospitalization","reason":"ტესტ-E2E ჰოსპიტალიზაცია"}' | jq -r '.id // empty')
  chk "ref_todo: კონსულტაცია → diagnostic (სამიზნე განყოფილება); ჰოსპიტალიზაცია → რეგისტრატორს" "$(inm "ref_todo:$R1" "$LT"):$(inm "ref_todo:$R2" "$RC"):$(inm "ref_todo:$R1" "$RC")" "1:1:0"
  api PATCH "/referrals/$R1" "$LT" -d '{"status":"completed","result_text":"ტესტ-E2E"}' >/dev/null
  api PATCH "/referrals/$R2" "$D1" -d '{"status":"cancelled"}' >/dev/null
  chk "შესრულება / გაუქმება → ქრება" "$(inm "ref_todo:$R1" "$LT"):$(inm "ref_todo:$R2" "$RC")" "0:0"
else ok "მიმართვის ტიპებს ტარიფი არ აქვს მინიჭებული — ref_todo გამოტოვებულია (გარემო)"; fi

step "7. diagnostics"
DG=$(api GET /worklist/check/diagnostics?include_test=1 "$ADM")
chk "diagnostics: bell_suppress / ack_scope / dx_list_mode / lab_crit_call / kpi" "$(echo "$DG" | jq -r '"\(.bell_suppress):\(.ack_scope):\(.dx_list_mode):\(.lab_crit_call):\(.kpi.tracker|type)"')" "off:abnormal:all:task:boolean"
chk "diagnostics: CRIT_NO_ESCALATION არ არის ჩვენს D-ზე (ხელმძღვანელი ჰყავს)" "$(echo "$DG" | jq -r --arg n "ტესტ-E2E WD თერაპია $S" '[.issues[]|select(.code=="CRIT_NO_ESCALATION")|.items[]|select(startswith($n))]|length')" "0"

step "8. გასუფთავება"
[ -f "$TMP/stays" ] && while read -r e; do
  [ "$(code POST "/inpatient/stays/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}')" = "200" ] || \
    api POST "/inpatient/stays/$e/discharge" "$ADM" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$NAID\",\"$NBID\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
done < "$TMP/stays"
for m in worklist inpatient; do api PUT "/modules/$m" "$ADM" -d "$(orig $m | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null; done
chk "პარამეტრები აღდგენილია (worklist)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}')" "$(orig worklist)"
[ -f "$TMP/svcs" ] && while read -r x; do api PATCH "/dx/catalog/$x" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/svcs"
[ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
[ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
ok "სატესტო ჩანაწერები გაუქმებულია / გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
