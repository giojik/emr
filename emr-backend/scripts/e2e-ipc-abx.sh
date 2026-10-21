#!/usr/bin/env bash
# =====================================================================
# e2e-ipc-abx.sh — ინფექციის კონტროლი, ეტაპი 4 (0070): ანტიბიოტიკების მართვა
#   პარამეტრები, DDD / AWaRe (საცნობარო ცხრილი, ჯენერიკზე ავტომატური შევსება, რედაქტირება, გადატანა), ჩვენება / დიაგნოზი,
#   შეზღუდული ანტიბიოტიკი (AWaRe Reserve, abx_restrict_mode approve / notify / off, abx_approver any / department / ipc),
#   time-out (შეხსენება, გადახედვა: გაგრძელება / შეწყვეტა), სამუშაო სია, მაჩვენებლები (MAR → DDD / 100, DOT / 1000, AWaRe),
#   ხედვა, მოდულის გამორთვა (0042-ის ქცევა), აუდიტი
#   bash scripts/e2e-ipc-abx.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-ipc-abx.sh
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
TODAY=$(TZ=Asia/Tbilisi date +%F); YDAY=$(TZ=Asia/Tbilisi date -d yesterday +%F)
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.abx.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ABX-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.abx.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
uid() { cat "$TMP/u$1"; }
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_abx_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_abx_$1_$S"; }
ipcset() { api PUT /modules/ipc "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
notes() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" '[.[]|select(.kind==$k)]|length'; }

step "0. პარამეტრები"
O_IPC=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')
O_INP=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
echo "$O_IPC" | jq -e '.settings.abx_restrict_mode != null' >/dev/null || die "0070 არ არის დაყენებული (ანტიბიოტიკის პარამეტრები აკლია)"
chk "ნაგულისხმევი: J01, ჩვენება სავალდებულო, approve, Reserve → შეზღუდული, any, 72 სთ, Access 60%" \
  "$(echo "$O_IPC" | jq -r '.settings|"\(.abx_atc_prefixes|join(",")):\(.abx_indication_required):\(.abx_restrict_mode):\(.abx_restrict_reserve):\(.abx_approver):\(.abx_timeout_hours):\(.aware_access_target)"')" \
  "J01:true:approve:true:any:72:60"
chk "ვალიდაცია: ამტკიცებს x / time-out 10 / ATC „X“ → 400; time-out 0 (გამორთული) → 200" \
  "$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abx_approver":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abx_timeout_hours":10},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abx_atc_prefixes":["X"]},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abx_timeout_hours":0},"reason":"ტესტ-E2E"}')" \
  "400:400:400:200"
ipcset '{"abx_atc_prefixes":["J01"],"abx_indication_required":true,"abx_restrict_mode":"approve","abx_restrict_reserve":true,"abx_approver":"any","abx_timeout_hours":72,"aware_access_target":60}'
api PUT /modules/inpatient "$ADM" -d '{"settings":{"med_verification":"off","mar_stock_deduct":false,"mar_barcode":"off","mar_double_check":false,"mar_window_min":60},"reason":"ტესტ-E2E"}' >/dev/null

step "1. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ABX თერაპია $S\",\"code\":\"E2EXA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ABX ქირურგია $S\",\"code\":\"E2EXB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
R_IPC=$(mkrole ipc "IPC" '["infection"]'); R_IPD=$(mkrole ipd "IPC განყ." '["infection_dept"]')
IC=$(mkuser "[\"$R_IPC\"]" 71); IDB=$(mkuser "[\"$R_IPD\"]" 72 ",\"department_id\":\"$DB\"")
DR=$(mkuser '["doctor"]' 73 ",\"department_id\":\"$DA\""); DH=$(mkuser '["doctor"]' 74 ",\"department_id\":\"$DA\",\"is_section_head\":true")
NA=$(mkuser '["nurse"]' 75 ",\"department_id\":\"$DA\""); PH=$(mkuser '["pharmacist"]' 76); RC=$(mkuser '["receptionist"]' 77)
for t in IC IDB DR DH NA PH RC; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: IPC, IPC განყ. (B), ექიმი, ხელმძღვანელი ექიმი, ექთანი, ფარმაცევტი, რეგისტრატორი"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ABX-$2\",\"birth_date\":\"1961-01-01\",\"gender\":\"male\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 81 ერთი); P2=$(mkpat 82 ორი)
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 73)\",\"source\":\"emergency\",\"icd10_code\":\"J18.9\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
gen() { api POST /pharmacy/generics "$PH" -d "$1"; }
GC=$(gen "{\"inn\":\"ტესტ-E2E ABX ცეფტრიაქსონი $S\",\"atc_code\":\"J01DD04\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"routes\":[\"IV\",\"IM\"]}")
GA=$(gen "{\"inn\":\"ტესტ-E2E ABX ამოქსიცილინი $S\",\"atc_code\":\"J01CA04\",\"form_code\":\"TAB\",\"strength\":\"500 მგ\",\"dose_unit\":\"mg\",\"routes\":[\"PO\"]}")
GL=$(gen "{\"inn\":\"ტესტ-E2E ABX ლინეზოლიდი $S\",\"atc_code\":\"J01XX08\",\"form_code\":\"INF_SOL\",\"strength\":\"600 მგ\",\"dose_unit\":\"mg\",\"routes\":[\"IV\"]}")
GX=$(gen "{\"inn\":\"ტესტ-E2E ABX უცნობი $S\",\"atc_code\":\"J01XX99\",\"form_code\":\"INJ_SOL\",\"dose_unit\":\"mg\",\"routes\":[\"IV\"]}")
GP=$(gen "{\"inn\":\"ტესტ-E2E ABX პარაცეტამოლი $S\",\"atc_code\":\"N02BE01\",\"form_code\":\"TAB\",\"strength\":\"500 მგ\",\"dose_unit\":\"mg\",\"routes\":[\"PO\"]}")
G_C=$(echo "$GC" | jq -r .id); G_A=$(echo "$GA" | jq -r .id); G_L=$(echo "$GL" | jq -r .id); G_X=$(echo "$GX" | jq -r .id); G_P=$(echo "$GP" | jq -r .id)
for g in G_C G_A G_L G_X G_P; do [ "${!g}" != "null" ] && [ -n "${!g}" ] || die "ჯენერიკი $g ვერ შეიქმნა"; done
chk "ჯენერიკზე ავტომატურად (ATC): ცეფტრიაქსონი — Watch, DDD პარ. 2 g; ამოქსიცილინი — Access, per os 1.5; ლინეზოლიდი — Reserve; უცნობი — არაფერი" \
  "$(echo "$GC" | jq -r '"\(.aware):\(.ddd_parenteral|tonumber+0):\(.ddd_unit)"'):$(echo "$GA" | jq -r '"\(.aware):\(.ddd_oral|tonumber+0)"'):$(echo "$GL" | jq -r .aware):$(echo "$GX" | jq -r '"\(.aware):\(.ddd_oral)"')" \
  "watch:2:g:access:1.5:reserve:null:null"
chk "DDD / AWaRe-ს ცვლა: ექიმი → 403; ფარმაცევტი → ✓" "$(code PATCH "/pharmacy/generics/$G_X" "$DR" -d '{"aware":"watch"}'):$(api PATCH "/pharmacy/generics/$G_X" "$PH" -d '{"aware":"watch"}' | jq -r .aware)" "403:watch"
api PATCH "/pharmacy/generics/$G_X" "$PH" -d '{"aware":null}' >/dev/null

step "2. დანიშნულება: ჩვენება, დიაგნოზი, time-out"
OR1="/inpatient/stays/$E1/orders"; OR2="/inpatient/stays/$E2/orders"
med() { jq -nc --arg g "$1" --arg t "$2" --argjson d "$3" --arg r "$4" --arg f "${5:-}" '{category:"medication",generic_id:$g,order_type:$t,dose:$d,dose_unit:"mg",route_code:$r,duration_days:5,ack:true,override_reason:"ტესტ-E2E: შეფასებულია"} + (if $f=="" then {} else {frequency_code:$f} end)'; }
plus() { echo "$1" | jq -c ". + $2"; }
chk "ანტიბიოტიკი ჩვენების გარეშე → 400 ABX_INDICATION; არარსებული ICD → 400" \
  "$(ecode POST "$OR1" "$DR" -d "$(med "$G_C" scheduled 1000 IV Q24H)"):$(code POST "$OR1" "$DR" -d "$(plus "$(med "$G_C" scheduled 1000 IV Q24H)" '{"abx_indication":"empiric","abx_icd10":"ZZ9.99"}')")" "ABX_INDICATION:400"
R=$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_C" scheduled 1000 IV Q24H)" '{"abx_indication":"empiric","abx_icd10":"J18.9"}')"); O_C=$(echo "$R" | jq -r '.id // empty')
chk "ცეფტრიაქსონი: ემპირიული, J18.9, Watch, time-out +72 სთ, დამტკიცება არ სჭირდება" \
  "$(echo "$R" | jq -r '"\(.abx_indication):\(.abx_icd10):\(.aware):\(((.abx_review_due|sub("\\.[0-9]+";"")|sub("\\+00:00$";"Z")|fromdateiso8601) - (.start_at|sub("\\.[0-9]+";"")|sub("\\+00:00$";"Z")|fromdateiso8601))/3600|round):\(.approval_status)"')" \
  "empiric:J18.9:watch:72:not_required"
R=$(api POST "$OR1" "$DR" -d "$(med "$G_P" scheduled 500 PO TID)")
chk "პარაცეტამოლი (არა-ანტიმიკრობული): ჩვენების გარეშე ✓, abx ველები ცარიელი" "$(echo "$R" | jq -r '"\(.id!=null):\(.abx_indication):\(.abx_review_due)"')" "true:null:null"
O_A=$(api POST "$OR2" "$DR" -d "$(plus "$(med "$G_A" scheduled 500 PO TID)" '{"abx_indication":"targeted"}')" | jq -r '.id // empty')
O_X=$(api POST "$OR2" "$DR" -d "$(plus "$(med "$G_X" scheduled 100 IV Q24H)" '{"abx_indication":"prophylaxis"}')" | jq -r '.id // empty')
[ -n "$O_C" ] && [ -n "$O_A" ] && [ -n "$O_X" ] || die "დანიშნულებები ვერ შეიქმნა"
chk "ერთჯერადი ანტიბიოტიკი — time-out არ ენიჭება" "$(api POST "$OR2" "$DR" -d "$(plus "$(med "$G_A" once 500 PO)" '{"abx_indication":"prophylaxis"}')" | jq -r '"\(.abx_indication):\(.abx_review_due)"')" "prophylaxis:null"

step "3. შეზღუდული ანტიბიოტიკი"
NI0=$(notes "$IC" ipd_order_approve); NP0=$(notes "$PH" ipd_order_approve)
R=$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_L" scheduled 600 IV Q12H)" '{"abx_indication":"targeted"}')"); O_L=$(echo "$R" | jq -r '.id // empty')
chk "ლინეზოლიდი (AWaRe Reserve, დროშის გარეშე) → დასამტკიცებელი; შეტყობინება: IPC + ფარმაცევტი (any)" \
  "$(echo "$R" | jq -r .approval_status):$(( $(notes "$IC" ipd_order_approve) - NI0 )):$(( $(notes "$PH" ipd_order_approve) - NP0 ))" "pending:1:1"
chk "სამუშაო სია (IPC, „დასამტკიცებელი“) — ლინეზოლიდი; ექიმი → 403" \
  "$(api GET "/ipc/abx/orders?view=pending" "$IC" | jq -r --arg o "$O_L" '[.[]|select(.id==$o)][0]|"\(.inn|test("ლინეზოლიდი")):\(.aware):\(.restricted):\(.dot_day)"'):$(code GET /ipc/abx/orders "$DR")" "true:reserve:true:1:403"
chk "დამტკიცება: რიგითი ექიმი → 403; საკუთარი (ხელმძღვ. არა) → 403; IPC → approved" \
  "$(code POST "/inpatient/orders/$O_L/approve" "$NA" -d '{}'):$(code POST "/inpatient/orders/$O_L/approve" "$DR" -d '{}'):$(api POST "/inpatient/orders/$O_L/approve" "$IC" -d '{"note":"ტესტ-E2E: MRSA, ვანკომიცინის აუტანლობა"}' | jq -r '"\(.approval_status):\(.approved_by_name|test("ABX-71"))"')" \
  "403:403:approved:true"
ipcset '{"abx_approver":"department"}'
O_L2=$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_L" scheduled 600 IV Q12H)" '{"abx_indication":"targeted"}')" | jq -r '.id // empty')
chk "abx_approver = department: IPC → 403; ხელმძღვანელი ექიმი → approved" "$(code POST "/inpatient/orders/$O_L2/approve" "$IC" -d '{}'):$(api POST "/inpatient/orders/$O_L2/approve" "$DH" -d '{}' | jq -r .approval_status)" "403:approved"
ipcset '{"abx_approver":"ipc"}'
O_L3=$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_L" scheduled 600 IV Q12H)" '{"abx_indication":"targeted"}')" | jq -r '.id // empty')
chk "abx_approver = ipc: ხელმძღვანელი / ფარმაცევტი → 403; უარი (IPC) მიზეზით → შეწყდა" \
  "$(code POST "/inpatient/orders/$O_L3/approve" "$DH" -d '{}'):$(code POST "/inpatient/orders/$O_L3/approve" "$PH" -d '{}'):$(api POST "/inpatient/orders/$O_L3/approve-reject" "$IC" -d '{"note":"ტესტ-E2E: მგრძნობიარეა ცეფტრიაქსონზე"}' | jq -r '"\(.approval_status):\(.status)"')" \
  "403:403:rejected:stopped"
ipcset '{"abx_approver":"any","abx_restrict_mode":"notify"}'
chk "notify: დამტკიცება საჭიროა (pending), შეტყობინება — არასასწრაფო" "$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_L" scheduled 600 IV Q12H)" '{"abx_indication":"targeted"}')" | jq -r .approval_status):$(api GET "/notifications?unread=true" "$IC" | jq -r '[.[]|select(.kind=="ipd_order_approve")][0].urgent')" "pending:false"
ipcset '{"abx_restrict_mode":"off"}'
chk "off: დამტკიცება არ სჭირდება" "$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_L" scheduled 600 IV Q12H)" '{"abx_indication":"targeted"}')" | jq -r .approval_status)" "not_required"
ipcset '{"abx_restrict_mode":"approve","abx_restrict_reserve":false}'
chk "abx_restrict_reserve = false: Reserve დროშის გარეშე — არ იზღუდება" "$(api POST "$OR1" "$DR" -d "$(plus "$(med "$G_L" scheduled 600 IV Q12H)" '{"abx_indication":"targeted"}')" | jq -r .approval_status)" "not_required"
ipcset '{"abx_restrict_reserve":true}'

step "4. MAR → მაჩვενებლები"
slot() { api GET "/inpatient/stays/$1/mar" "$NA" | jq -r --arg o "$2" '[.entries[]|select(.order_id==$o and .status=="due")]|sort_by(.scheduled_at)|.[0].id // empty'; }
give() { local s; s=$(slot "$1" "$2"); [ -n "$s" ] && api POST "/inpatient/mar/$s/document" "$NA" -d '{"outcome":"given"}' | jq -r '.status // .code // .message'; }
chk "MAR: ცეფტრიაქსონი 1000 მგ IV (P1), ამოქსიცილინი 500 მგ PO (P2), უცნობი 100 მგ IV (P2)" "$(give "$E1" "$O_C"):$(give "$E2" "$O_A"):$(give "$E2" "$O_X")" "given:given:given"
api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" >/dev/null
RT=$(api GET "/ipc/abx/rates?from=$TODAY&to=$TODAY&department_id=$DA" "$IC")
chk "განყ. A: 2 პაციენტ-დღე, 3 დოზა, DDD 0.83 (0.5 + 0.33), DOT 3, DDD აკლია 1; DDD / 100 = 41.67, DOT / 1000 = 1500" \
  "$(echo "$RT" | jq -r '"\(.patient_days):\(.total.doses):\(.total.ddd):\(.total.dot):\(.total.missing_ddd):\(.total.ddd_per_100):\(.total.dot_per_1000)"')" "2:3:0.83:3:1:41.67:1500"
chk "AWaRe: Watch DDD 60%, Access 40%; კლასიფიკაციის გარეშე — DOT 1 (33.33%)" \
  "$(echo "$RT" | jq -r '[.aware[]|select(.doses>0)]|map("\(.aware)=\(.ddd_pct // "-")/\(.dot_pct)")|join(",")')" "access=40/33.33,watch=60/33.33,unclassified=0/33.33"
chk "აგენტები: ცეფტრიაქსონი 0.5 DDD (IV 100%), ამოქსიცილინი 0.33, უცნობი — DDD აკლია 1" \
  "$(echo "$RT" | jq -r '[.agents[]|"\(.atc_code):\(.ddd):\(.missing_ddd)"]|sort|join(",")'):$(echo "$RT" | jq -r '.agents[]|select(.atc_code=="J01DD04")|.parenteral_pct')" \
  "J01CA04:0.33:0,J01DD04:0.5:0,J01XX99:0:1:100"
chk "დანიშნულებები: ჩვენება (ემპირ. 1, მიზნ. ≥ 5, პროფ. 2); შეზღუდული: დამტკ. 2, უარი 1, მოლოდინში 1" \
  "$(echo "$RT" | jq -r '.orders|"\(.indication.empiric):\(.indication.targeted >= 5):\(.indication.prophylaxis):\(.restricted.approved):\(.restricted.rejected):\(.restricted.pending)"')" "1:true:2:2:1:1"
chk "განყოფილების სტრიქონი: Access 40%; IPC განყ. B — A → 400 OUT_OF_SCOPE; from > to → 400; ექთანი → 403" \
  "$(echo "$RT" | jq -r '.departments[0].access_pct'):$(ecode GET "/ipc/abx/rates?from=$TODAY&to=$TODAY&department_id=$DA" "$IDB"):$(code GET "/ipc/abx/rates?from=$TODAY&to=$YDAY" "$IC"):$(code GET "/ipc/abx/rates?from=$TODAY&to=$TODAY" "$NA")" \
  "40:OUT_OF_SCOPE:400:403"

step "5. Time-out"
ipcset '{"abx_timeout_hours":24}'
ST=$(date -u -d '-23 hours -59 minutes -54 seconds' +%FT%TZ)
O_T=$(api POST "$OR2" "$DR" -d "$(plus "$(med "$G_C" scheduled 1000 IV Q24H)" "{\"abx_indication\":\"empiric\",\"start_at\":\"$ST\"}")" | jq -r '.id // empty')
[ -n "$O_T" ] || die "time-out-ის დანიშნულება ვერ შეიქმნა"
sleep 8
ND0=$(notes "$DR" ipd_abx_timeout)
chk "შემოწმება: IPC განყ. → 403; IPC → ≥ 1; ექიმს — შეტყობინება; მეორედ — აღარ" \
  "$(code POST /ipc/abx/timeout-scan "$IDB"):$(api POST /ipc/abx/timeout-scan "$IC" | jq -r '.timeouts >= 1'):$(( $(notes "$DR" ipd_abx_timeout) - ND0 )):$(api POST /ipc/abx/timeout-scan "$IC" | jq -r .timeouts)" "403:true:1:0"
chk "სამუშაო სია „გადასახედი“ — დანიშნულება (ვადაგასული); IPC განყ. B — ვერ ხედავს" \
  "$(api GET '/ipc/abx/orders?view=timeout' "$IC" | jq -r --arg o "$O_T" '[.[]|select(.id==$o)][0].timeout_overdue'):$(api GET '/ipc/abx/orders?view=timeout' "$IDB" | jq -r --arg o "$O_T" '[.[]|select(.id==$o)]|length')" "true:0"
chk "გადახედვა: ექთანი → 403; შეწყვეტა მიზეზის გარეშე → 400; არა-ანტიმიკრობული → NOT_ABX" \
  "$(code POST "/inpatient/orders/$O_T/abx-review" "$NA" -d '{"decision":"continue"}'):$(code POST "/inpatient/orders/$O_T/abx-review" "$DR" -d '{"decision":"stop"}'):$(ecode POST "/inpatient/orders/$(api GET "$OR1" "$DR" | jq -r '[.orders[]|select(.inn!=null and (.inn|test("პარაცეტამოლი")))][0].id')/abx-review" "$DR" -d '{"decision":"continue"}')" "403:400:NOT_ABX"
R=$(api POST "/inpatient/orders/$O_T/abx-review" "$DR" -d '{"decision":"continue","note":"ტესტ-E2E: კულტურა მოლოდინში"}')
chk "ექიმი: გაგრძელება → ჩაიწერა (ისტორია: abx_timeout, abx_review), სიიდან მოიხსნა" \
  "$(echo "$R" | jq -r '"\(.abx_review_decision):\([.events[].kind]|map(select(.=="abx_timeout" or .=="abx_review"))|join(","))"'):$(api GET '/ipc/abx/orders?view=timeout' "$IC" | jq -r --arg o "$O_T" '[.[]|select(.id==$o)]|length')" "continue:abx_timeout,abx_review:0"
chk "IPC: შეწყვეტა (მიზეზით) → დანიშნულება შეწყდა" "$(api POST "/inpatient/orders/$O_C/abx-review" "$IC" -d '{"decision":"stop","note":"ტესტ-E2E: ვირუსული"}' | jq -r '"\(.abx_review_decision):\(.status)"')" "stop:stopped"

step "6. DDD / AWaRe ცნობარი"
REF=$(api GET /ipc/abx/reference "$IC")
chk "საცნობარო: ≥ 38 ATC; ჯენერიკებში — უცნობს DDD / AWaRe აკლია" "$(echo "$REF" | jq -r '(.reference|length) >= 38'):$(echo "$REF" | jq -r --arg g "$G_X" '[.generics[]|select(.id==$g)][0].missing')" "true:true"
chk "რედაქტირება: ფარმაცევტი → 403; DDD-ის გარეშე → 400 DDD_REQUIRED; IPC → ✓" \
  "$(code PATCH /ipc/abx/reference/J01DD04 "$PH" -d '{"name":"x x"}'):$(ecode PATCH /ipc/abx/reference/J01CE01 "$IC" -d '{"ddd_parenteral":null}'):$(api PATCH /ipc/abx/reference/J01DD04 "$IC" -d '{"name":"ცეფტრიაქსონი"}' | jq -r '.reference[]|select(.atc_code=="J01DD04")|.name')" \
  "403:DDD_REQUIRED:ცეფტრიაქსონი"
api PATCH "/pharmacy/generics/$G_A" "$PH" -d '{"aware":null,"ddd_oral":null,"ddd_unit":null}' >/dev/null
chk "გადატანა ჯენერიკებზე: ექიმი → 403; ფარმაცევტი → ამოქსიცილინი შეივსო (Access, 1.5)" \
  "$(code POST /ipc/abx/reference/apply "$DR" -d '{}'):$(api POST /ipc/abx/reference/apply "$PH" -d '{}' | jq -r --arg g "$G_A" '[.generics[]|select(.id==$g)][0]|"\(.aware):\(.ddd_oral|tonumber+0)"')" "403:access:1.5"

step "7. მოდულის გამორთვა / აღდგენა"
api PUT /modules/ipc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე (0042-ის ქცევა): ჩვენების გარეშე ✓; ლინეზოლიდი (Reserve, დროშის გარეშე) — დამტკიცება არ სჭირდება; IPC API → 403" \
  "$(api POST "$OR2" "$DR" -d "$(med "$G_L" scheduled 600 IV Q12H)" | jq -r '"\(.approval_status):\(.abx_indication):\(.abx_review_due)"'):$(code GET /ipc/abx/orders "$IC")" "not_required:null:null:403"
api PUT /modules/ipc "$ADM" -d "{\"enabled\":$(echo "$O_IPC" | jq '.enabled'),\"settings\":$(echo "$O_IPC" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$O_INP,\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')" "$O_IPC"
AUD=$( (api GET "/audit-logs?entity_name=med_orders&limit=200" "$ADM"; api GET "/audit-logs?entity_name=ipc_abx_reference&limit=50" "$ADM"; api GET "/audit-logs?entity_name=med_generics&limit=50" "$ADM") | jq -s -r '[.[]|(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: MED_ORDER_ABX_REVIEW, MED_ORDER_APPROVE, IPC_ABX_REF_UPDATE, IPC_ABX_REF_APPLY, IPC_ABX_TIMEOUT_SCAN" \
  "$(for a in MED_ORDER_ABX_REVIEW MED_ORDER_APPROVE IPC_ABX_REF_UPDATE IPC_ABX_REF_APPLY IPC_ABX_TIMEOUT_SCAN; do echo "$AUD" | tr ',' '\n' | grep -qx "$a" && echo y || echo "$a"; done | sort -u | tr '\n' ' ')" "y "

step "გასუფთავება"
if [ -n "${E2E_KEEP:-}" ]; then ok "E2E_KEEP — მონაცემები დატოვებულია (ეკრანის სურათებისთვის)"; printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"; exit 0; fi
for e in $E1 $E2; do for o in $(api GET "/inpatient/stays/$e/orders" "$DR" | jq -r '.orders[]|select(.status=="active" or .status=="on_hold")|.id'); do api POST "/inpatient/orders/$o/stop" "$DR" -d '{"reason":"ტესტ-E2E: დასრულება"}' >/dev/null; done; done
for g in $G_C $G_A $G_L $G_X $G_P; do api PATCH "/pharmacy/generics/$g" "$ADM" -d '{"is_active":false}' >/dev/null; done
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სატესტო დანიშნულებები შეწყდა, ჯენერიკები / მომხმარებლები გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
