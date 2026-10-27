#!/usr/bin/env bash
# =====================================================================
# e2e-bme-reports.sh — ბიომედ-აპარატურა, ეტაპი 4 (0076): ანგარიშები / KPI
#   პარამეტრები (ვალიდაცია), ხელმისაწვდომობა (down / restricted × წონა / standby / ექსპლუატაციაში შეყვანამდე / არადაგეგმილი, განყოფილება გადაადგილებით),
#   MTBF / MTTR (მწყობრიდან გამოსვლა, no_fault / უარყოფა / დუბლიკატი, USER_ERROR-ის გამორიცხვა), SLA (კოჰორტა, ღია ვადაგასული → დარღვეული, მიმდინარე),
#   ხარჯი (ნაწილები — საწყობიდან, შემობრუნების გამოკლებით; შრომა; გარე; PM / კალიბრაციის ხარჯი — ახალი ველები; კონტრაქტი — დღიური წილი, თანაბრად / ღირებულებით),
#   TCO / COSR, PM ვადაში (გეგმა სამუშაოს გარეშე, დაგვიანება, grace), მიზეზები (მომხმ. შეცდომა, NFF, Pareto), ხედვა (bme_dept — თავისი განყოფილება, ხარჯის გარეშე),
#   აპარატის KPI (პასპორტი), Excel, მენეჯერული დაფა (rpt_fact_bme, KPI bme_*, „ყურადღება“, bme_only), მოდულის გამორთვა.
# „ახლა“-ს ჩანაცვლება (at) — მხოლოდ admin-ის ანგარიშის მოთხოვნაში, მხოლოდ სატესტო აპარატებზე (device_ids) — სხვა ჩანაწერებს არ ეხება.
# ბოლოს: სატესტო აპარატები გამოყვანილია, კონტრაქტი გაუქმებულია, მომხმარებლები / განყოფილებები / საქონელი გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-bme-reports.sh [API_URL]
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
d()   { TZ=Asia/Tbilisi date -d "$1" +%F; }
ts()  { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
TODAY=$(d today); YDAY=$(d yesterday)
enc()  { jq -rn --arg s "$1" '$s|@uri'; }
mod()  { api PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message // "ok"' | head -c 60; }
modc() { code PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
dev()  { api GET "/bme/devices/$1" "$ENG"; }
items_pass() { jq -c '[.items[]|if .item_type=="measure" then {id:(.id|tonumber), value_num:(if .tolerance!=null then (.nominal|tonumber) elif .limit_high!=null then (.limit_high|tonumber) else (.limit_low|tonumber) end)} else {id:(.id|tonumber), outcome:"pass"} end]'; }
near() { awk -v a="$1" -v b="$2" -v t="${3:-0.05}" 'BEGIN { if (a == "null" || b == "null") { print (a == b ? "ok" : a "≠" b); exit } d = a - b; if (d < 0) d = -d; print (d <= t ? "ok" : a "≠" b) }'; }
refresh() {
  local R id st i; R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  if [ -z "$id" ]; then
    for i in $(seq 1 60); do sleep 1; [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; done
    R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  fi
  [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 120); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}
kv() { echo "$1" | jq -r --arg c "$2" '.kpis[]|select(.code==$c)|.value'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0076" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0076" | tostring)')" "ok:true"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E RPT რეანიმაცია $S\",\"code\":\"E2EPA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E RPT ქირურგია $S\",\"code\":\"E2EPB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.bmerpt.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"RPT-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.bmerpt.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_ENG=$(mkrole peng "სამედ. ინჟინერი" '["med_engineer"]'); R_DEP=$(mkrole pdep "აპარატები (განყ.)" '["bme_dept","nurse"]'); R_VW=$(mkrole pvw "ბიომედ ნახვა" '["bme_view"]')
R_SM=$(mkrole psm "საწყობი" '["stock_manager"]'); R_AC=$(mkrole pac "ბუღალტერია" '["accountant"]')
[ -n "$R_ENG" ] && [ -n "$R_DEP" ] && [ -n "$R_VW" ] && [ -n "$R_SM" ] && [ -n "$R_AC" ] || die "როლები ვერ შეიქმნა"
read -r ENGID ENG <<< "$(mkuser "[\"$R_ENG\"]" 81)"; read -r _ DH <<< "$(mkuser "[\"$R_DEP\"]" 82 ",\"department_id\":\"$DB\"")"
read -r _ VW <<< "$(mkuser "[\"$R_VW\"]" 83)"; read -r _ N1 <<< "$(mkuser '["nurse"]' 84 ",\"department_id\":\"$DA\"")"
read -r _ SM <<< "$(mkuser "[\"$R_SM\"]" 85)"; read -r _ AC <<< "$(mkuser "[\"$R_AC\"]" 86)"
[ -n "$ENG" ] && [ -n "$DH" ] && [ -n "$VW" ] && [ -n "$N1" ] && [ -n "$SM" ] && [ -n "$AC" ] && ok "6 მომხმარებელი (ინჟინერი, bme_dept განყ. B, bme_view, ექთანი, საწყობი, ბუღალტერია)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული bme ვერ მოიძებნა"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/reporting "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
mod '{"rep_close_mode":"engineer","rep_post_check":"off","rep_pm_fail":"button","rep_labor_rate":20,"rep_sla_response":[1,4,24,72],"rep_sla_restore":[24,72,168,336],"rpt_restricted_weight":0,"rpt_mtbf_exclude_user_error":false,"rpt_contract_alloc":"equal","rpt_pm_grace_days":0,"rpt_cosr_warn_pct":10,"dashboard_visibility":"report_users","monthly_section":true}' >/dev/null
SUP=$(api POST /stock/suppliers "$ADM" -d "{\"name\":\"ტესტ-E2E RPT სერვისი $S\",\"tax_id\":\"6$(printf '%08d' "$((10#$S))")\"}" | jq -r '.id // empty')
LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RPT_$S\",\"name\":\"ტესტ-E2E RPT საწყობი $S\",\"kind\":\"other\"}" | jq -r '.id // empty')
CATG=$(api GET /stock/refs "$SM" | jq -r '.categories[]|select(.code=="HOUSE").id')
PART=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E RPT სენსორი $S\",\"category_id\":\"$CATG\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
RCV=$(api POST /stock/receipts "$SM" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$PART\",\"qty\":10,\"price\":12.5,\"vat_rate\":0}]}" | jq -r .id); api POST "/stock/receipts/$RCV/post" "$SM" >/dev/null
[ -n "$SUP" ] && [ -n "$LOC" ] && [ -n "$PART" ] && ok "მომწოდებელი, საწყობი: 10 ც × 12.50 ₾" || die "მომწოდებელი / საწყობი ვერ შეიქმნა"
REFS=$(api GET /bme/refs "$ENG"); ty() { echo "$REFS" | jq -r --arg c "$1" '.types[]|select(.code==$c)|.id'; }
mkdev() { api POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E RPT $1 $S\",\"type_id\":\"$2\",\"department_id\":\"$3\"${4:-}}" | jq -r '.id // empty'; }
V=$(mkdev "ვენტილატორი" "$(ty VENTILATOR)" "$DA" ",\"purchase_value\":50000,\"supplier_id\":\"$SUP\"")
M=$(mkdev "მონიტორი" "$(ty PATIENT_MONITOR)" "$DA" ",\"purchase_value\":10000")
G=$(mkdev "გადასაადგილებელი" "$(ty OTHER)" "$DA"); P=$(mkdev "PM" "$(ty OTHER)" "$DA"); SB=$(mkdev "რეზერვი" "$(ty OTHER)" "$DA")
X=$(mkdev "ჯერ არ შეყვანილი" "$(ty OTHER)" "$DA" ",\"install_date\":\"$(d tomorrow)\"")
[ -n "$V" ] && [ -n "$M" ] && [ -n "$G" ] && [ -n "$P" ] && [ -n "$SB" ] && [ -n "$X" ] && ok "6 სატესტო აპარატი (ვენტილატორი, მონიტორი, სხვა × 4)" || die "აპარატები ვერ შეიქმნა"
IDS="$V,$M,$G,$P,$SB,$X"
RR=$(api GET /bme/repairs/refs "$ENG"); rc() { echo "$RR" | jq -r --arg k "$1" --arg c "$2" '.codes[]|select(.kind==$k and .code==$c)|.id'; }
C_WEAR=$(rc cause WEAR); C_UE=$(rc cause USER_ERROR); A_PART=$(rc action PART); A_TRAIN=$(rc action TRAINING)
REQ() { jq -nc --arg d "$1" --arg c "$2" --arg t "$3" '{device_id:$d, condition:$c, urgency:"normal", description:$t}'; }
CMP() { jq -nc --arg o "$1" --arg c "${2:-}" --arg a "${3:-}" --argjson l "${4:-0}" --argjson x "${5:-0}" '{outcome:$o, resolution:"ტესტ-E2E: შესრულდა", labor_hours:$l, external_cost:$x}
  + (if $c=="" then {} else {cause_id:$c} end) + (if $a=="" then {} else {action_id:$a} end)'; }

step "1. პარამეტრები"
chk "ნაგულისხმევი (0076): წონა 0 / MTBF-ში მომხმ. შეცდომა ითვლება / თანაბრად / COSR 10 / grace 0 / report_users / თვიური სექცია" \
  "$(echo "$ORIG" | jq -r '.settings|"\(.rpt_restricted_weight):\(.rpt_mtbf_exclude_user_error):\(.rpt_contract_alloc):\(.rpt_cosr_warn_pct):\(.rpt_pm_grace_days):\(.dashboard_visibility):\(.monthly_section)"')" \
  "0:false:equal:10:0:report_users:true"
chk "არასწორი: წონა 0.3 / განაწილება x / COSR 0 / grace 61 / ხედვა x — 400" \
  "$(modc '{"rpt_restricted_weight":0.3}'):$(modc '{"rpt_contract_alloc":"x"}'):$(modc '{"rpt_cosr_warn_pct":0}'):$(modc '{"rpt_pm_grace_days":61}'):$(modc '{"dashboard_visibility":"x"}')" "400:400:400:400:400"

step "2. მონაცემები: ორდერები, ნაწილები, სტატუსი, გადაადგილება"
# R1 — V: არ მუშაობს → P1 შიდა → ნაწილები 2 + 1 (შემობრუნებული) → შესრულდა (WEAR / PART, 2 სთ, გარე 100) → მუშა
R1=$(api POST /bme/repairs "$N1" -d "$(REQ "$V" not_working 'ტესტ-E2E ვენტილატორი არ ირთვება')" | jq -r '.id // empty')
api POST "/bme/repairs/$R1/triage" "$ENG" -d "{\"priority\":1,\"performer_kind\":\"internal\",\"assignee_id\":\"$ENGID\"}" >/dev/null
api POST "/bme/repairs/$R1/act" "$ENG" -d '{"action":"start"}' >/dev/null
api POST "/bme/repairs/$R1/parts" "$ENG" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$PART\",\"qty\":2}]}" >/dev/null
P2=$(api POST "/bme/repairs/$R1/parts" "$ENG" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$PART\",\"qty\":1}]}")
DOC2=$(api GET "/bme/repairs/$R1" "$ENG" | jq -r --arg n "$(echo "$P2" | jq -r .doc_no)" '.parts[]|select(.doc_no==$n)|.doc_id' | head -1)
chk "ნაწილები: 2 ჩამოწერა (25 + 12.50), მეორე შემობრუნდა (საწყობი)" "$(echo "$P2" | jq -r '.repair.parts_cost|tonumber+0'):$(api POST "/stock/docs/$DOC2/reverse" "$ADM" -d '{"reason":"ტესტ-E2E: შეცდომით"}' | jq -r .doc_type)" "37.5:reversal"
chk "R1 შესრულდა (ინჟინრის რეჟიმი — დახურულია), შრომა 2 × 20 = 40, აპარატი → მუშა" \
  "$(api POST "/bme/repairs/$R1/complete" "$ENG" -d "$(CMP repaired "$C_WEAR" "$A_PART" 2 100)" | jq -r '"\(.status):\(.labor_cost|tonumber+0)"'):$(api POST "/bme/repairs/$R1/apply-status" "$ENG" | jq -r .device_status)" "closed:40:operational"
# R2 — M: შეზღუდულად → უარყოფა „მომხმარებლის შეცდომა“
R2=$(api POST /bme/repairs "$N1" -d "$(REQ "$M" limited 'ტესტ-E2E მონიტორი განგაშს არ აჩვენებს')" | jq -r .id)
api POST "/bme/repairs/$R2/reject" "$ENG" -d '{"reason":"user_error","note":"ტესტ-E2E: ხმა იყო გამორთული"}' >/dev/null
# R3 — M: პრობლემა → P4 → დაზიანება არ დადასტურდა
R3=$(api POST /bme/repairs "$N1" -d "$(REQ "$M" issue 'ტესტ-E2E ეკრანი ციმციმებს')" | jq -r .id)
api POST "/bme/repairs/$R3/triage" "$ENG" -d '{"priority":4}' >/dev/null
api POST "/bme/repairs/$R3/complete" "$ENG" -d "$(CMP no_fault)" >/dev/null
# R6 — G: არ მუშაობს → P3 → შესრულდა (USER_ERROR / TRAINING, 1 სთ) → მუშა → გადაადგილება B-ში
R6=$(api POST /bme/repairs "$N1" -d "$(REQ "$G" not_working 'ტესტ-E2E არასწორად შეერთებული')" | jq -r .id)
api POST "/bme/repairs/$R6/triage" "$ENG" -d '{"priority":3}' >/dev/null
api POST "/bme/repairs/$R6/complete" "$ENG" -d "$(CMP repaired "$C_UE" "$A_TRAIN" 1 0)" >/dev/null; api POST "/bme/repairs/$R6/apply-status" "$ENG" >/dev/null
chk "G → განყოფილება B (პირდაპირ)" "$(api POST "/bme/devices/$G/move" "$ENG" -d "{\"to_department_id\":\"$DB\",\"reason\":\"ტესტ-E2E\"}" | jq -r .status)" "done"
# R4 — V: ისევ არ მუშაობს → P1 შიდა, არ დაწყებულა (ღია); R5 — დუბლიკატი
R4=$(api POST /bme/repairs "$N1" -d "$(REQ "$V" not_working 'ტესტ-E2E ვენტილატორი ისევ გაითიშა')" | jq -r .id)
api POST "/bme/repairs/$R4/triage" "$ENG" -d '{"priority":1}' >/dev/null
R5=$(api POST /bme/repairs "$N1" -d "$(REQ "$V" not_working 'ტესტ-E2E იგივე ვენტილატორი' | jq -c '.force=true')" | jq -r .id)
api POST "/bme/repairs/$R5/reject" "$ENG" -d "{\"reason\":\"duplicate\",\"duplicate_of\":\"$R4\"}" >/dev/null
chk "სტატუსები: V გაუმართავი (R4), M → შეზღუდულად (ხელით), SB → რეზერვი" \
  "$(dev "$V" | jq -r .status):$(api POST "/bme/devices/$M/status" "$ENG" -d '{"status":"restricted","reason":"ტესტ-E2E: SpO2 არხი"}' | jq -r .status):$(api POST "/bme/devices/$SB/status" "$ENG" -d '{"status":"standby","reason":"ტესტ-E2E"}' | jq -r .status)" \
  "down:restricted:standby"

step "3. PM / კალიბრაცია: ვადები და ხარჯი"
plan() { api GET "/bme/devices/$1/pm" "$ENG" | jq -r --arg k "$2" '.plans[]|select(.kind_code==$k)|.id' | head -1; }
PL_P=$(plan "$P" PM); PL_MPM=$(plan "$M" PM); PL_MCAL=$(plan "$M" CALIBRATION)
[ -n "$PL_P" ] && [ -n "$PL_MPM" ] && [ -n "$PL_MCAL" ] || die "გეგმები ვერ მოიძებნა"
for pl in "$PL_P" "$PL_MPM" "$PL_MCAL"; do api PATCH "/bme/plans/$pl" "$ENG" -d "{\"next_due\":\"$YDAY\"}" >/dev/null; done
W1=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PL_MPM\",\"performer_kind\":\"internal\",\"assignee_id\":\"$ENGID\"}"); W1ID=$(echo "$W1" | jq -r .id)
W2=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PL_MCAL\",\"performer_kind\":\"internal\",\"assignee_id\":\"$ENGID\"}"); W2ID=$(echo "$W2" | jq -r .id)
chk "სამუშაოები გეგმიდან, ვადა — გუშინ" "$(echo "$W1" | jq -r .due_date):$(echo "$W2" | jq -r .due_date)" "$YDAY:$YDAY"
C1=$(api POST "/bme/works/$W1ID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$YDAY\",\"items\":$(echo "$W1" | items_pass),\"labor_hours\":1,\"external_cost\":50,\"invoice_no\":\"INV-RPT-$S\"}")
chk "PM შესრულდა (ვადაში): შრომა 1 × 20 = 20, გარე 50, ინვოისი" "$(echo "$C1" | jq -r '"\(.status):\(.labor_cost|tonumber+0):\(.external_cost|tonumber+0):\(.invoice_no)"')" "done:20:50:INV-RPT-$S"
chk "ხარჯის ველების ვალიდაცია: საათები < 0 — 400" "$(code POST "/bme/works/$W2ID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W2" | items_pass),\"labor_hours\":-1}")" "400"
api POST "/bme/works/$W2ID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W2" | items_pass)}" >/dev/null

step "4. კონტრაქტი"
CT=$(api POST /bme/contracts "$ENG" -d "$(jq -nc --arg s "$SUP" --arg sd "$(d '-9 days')" --arg ed "$(d '+20 days')" --arg n "E2E-RPT-$S" --arg a "$V" --arg b "$M" \
  '{contract_no:$n, title:"ტესტ-E2E RPT სრული სერვისი", supplier_id:$s, kind:"full_service", start_date:$sd, end_date:$ed, cost:3650, cost_period:"year", uptime_pct:99, pm_visits_per_year:4, device_ids:[$a,$b]}')")
KID=$(echo "$CT" | jq -r '.id // empty')
chk "კონტრაქტი: 2 აპარატი, 3650 ₾ / წელი (10 ₾ / დღე)" "$(echo "$CT" | jq -r '"\(.devices|length):\(.annual_cost|tonumber+0)"')" "2:3650"

step "5. ანგარიში — შეჯამება (at = +2 სთ, მხოლოდ სატესტო აპარატები)"
AT=$(ts '+2 hours')
Q="from=$YDAY&to=$TODAY&device_ids=$IDS&at=$(enc "$AT")&trend=0"
chk "at — მხოლოდ admin (ინჟინერი — 403); პერიოდი > 2 წელი / from > to — 400; ექთანი — 403" \
  "$(code GET "/bme/reports/summary?$Q" "$ENG"):$(code GET "/bme/reports/summary?from=2020-01-01&to=$TODAY" "$ENG"):$(code GET "/bme/reports/summary?from=$TODAY&to=$YDAY" "$ENG"):$(code GET "/bme/reports/summary?from=$YDAY&to=$TODAY" "$N1")" \
  "403:400:400:403"
REP=$(api GET "/bme/reports/summary?$Q" "$ADM")
echo "$REP" > "$TMP/rep.json"
[ "$(echo "$REP" | jq -r '.kpi // empty')" != "" ] || die "ანგარიში ვერ მიიღო: $(echo "$REP" | head -c 300)"
T() { echo "$REP" | jq -r "$1"; }
chk "მოთხოვნა 5 (დუბლიკატის გარეშე), მწყობრიდან გამოსვლა 3 (R1, R4, R6; მ.შ. USER_ERROR 1), შესრულდა 2 (no_fault — არა)" \
  "$(T '"\(.totals.requests):\(.totals.failures):\(.totals.failures_ue):\(.totals.repairs_done)"')" "5:3:1:2"
chk "მომხმარებლის შეცდომა 2 / 5 = 40%; NFF 1 / 5 = 20%" "$(T '"\(.kpi.bme_user_error_pct):\(.kpi.nff_pct)"')" "40:20"
chk "SLA რეაგირება: R1, R3, R6 ვადაში, R4 დარღვეული (+2 სთ > 1 სთ) → 75%; აღდგენა 3 / 3 = 100% (R4 მიმდინარე)" \
  "$(T '"\(.totals.sla_resp_met)/\(.totals.sla_resp_n):\(.kpi.bme_sla_response_pct):\(.totals.sla_rest_met)/\(.totals.sla_rest_n):\(.kpi.bme_sla_restore_pct)"')" "3/4:75:3/3:100"
chk "SLA P1: 1 ვადაში, 1 დარღვეული; მიმდინარე 1; შიდა — 4" "$(T '.sla.by_priority[0]|"\(.resp_met):\(.resp_breached):\(.in_progress)"'):$(T '.sla.by_mode[]|select(.mode=="internal")|.n')" "1:1:1:4"
MTTR=$(for r in "$R1" "$R6"; do api GET "/bme/repairs/$r" "$ENG"; done | jq -s '[.[]|(((.done_at|sub("\\.[0-9]+";"")|fromdateiso8601) - (.reported_at|sub("\\.[0-9]+";"")|fromdateiso8601))/3600)]|add/length')
chk "MTTR = საშუალო (შესრულება − მოთხოვნა) R1, R6" "$(near "$(T .kpi.bme_mttr_h)" "$(printf '%.1f' "$MTTR")" 0.11)" "ok"
chk "MTBF = (ექსპლ. − down) / 24 / 3" "$(near "$(T .kpi.bme_mtbf_d)" "$(T '((.totals.avail_h - .totals.down_h)/24/3*10|round)/10')" 0.11)" "ok"
A0=$(TZ=Asia/Tbilisi date -d "$YDAY 00:00" +%s); B0=$(date -d "$AT" +%s); MID=$(TZ=Asia/Tbilisi date -d "$(d tomorrow) 00:00" +%s); [ "$MID" -lt "$B0" ] && B0=$MID
ATDAY=$(TZ=Asia/Tbilisi date -d "$AT" +%F); NDAYS=$(( ( $(date -u -d "$ATDAY" +%s) - $(date -u -d "$(d '-9 days')" +%s) ) / 86400 + 1 ))
avx() { dev "$1" | jq -r --argjson a "$A0" --argjson b "$B0" --argjson w "${2:-0}" 'def ep: (sub("\\.[0-9]+";"")|fromdateiso8601) + (((capture("\\.(?<f>[0-9]+)").f) // "0") as $f | ("0." + $f | tonumber));
  [.periods[]|select(.status=="operational" or .status=="restricted" or .status=="down")
  |{st:.status, s:(.started_at|ep), e:(if .ended_at==null then 1e12 else (.ended_at|ep) end)}
  |{st, h:((([.e,$b]|min) - ([.s,$a]|max))/3600)}|select(.h>0)] as $p | ($p|map(.h)|add // 0) as $av
  | ($p|map(select(.st=="down").h)|add // 0) as $dn | ($p|map(select(.st=="restricted").h)|add // 0) as $rs
  | if $av>0 then ((1 - ($dn + $w*$rs)/$av)*10000|round)/100 else null end'; }
dv() { echo "$REP" | jq -r --arg id "$1" "[.availability.worst[], .reliability.devices[]]|map(select(.device_id==\$id))[0]|$2"; }
chk "ხელმისაწვდომობა V (სიცოცხ. შემანარჩ.) = პერიოდებიდან; სიცოცხ. შემანარჩ. KPI = V; არადაგეგმილი = საერთო (down — ორდერით)" \
  "$(near "$(dv "$V" .bme_availability_pct)" "$(avx "$V")" 0.02):$(near "$(T .kpi.bme_avail_ls_pct)" "$(avx "$V")" 0.02):$(near "$(dv "$V" .unplanned_availability_pct)" "$(dv "$V" .bme_availability_pct)" 0.001)" "ok:ok:ok"
chk "M (შეზღუდულად): წონა 0 → 100%; რეზერვი SB ~ 0 სთ; X (შეყვანა ხვალ) — საათები არ აქვს" \
  "$(dv "$M" .bme_availability_pct):$(T '[.availability.by_type[]|.devices]|add'):$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&device_ids=$X&at=$(enc "$AT")&trend=0" "$ADM" | jq -r '"\(.devices):\(.totals.avail_h)"')" \
  "100:5:0:0"
chk "განყოფილება გადაადგილებით: A — 5 აპარატი, B — 1 (G); მწყობრიდან გამოსვლა A — 3, B — 0" \
  "$(T '.availability.by_dept[]|select(.department_id=="'"$DA"'")|.devices'):$(T '.availability.by_dept[]|select(.department_id=="'"$DB"'")|.devices'):$(T '.reliability.by_dept[]|select(.key=="'"$DA"'")|.failures'):$(T '[.reliability.by_dept[]|select(.key=="'"$DB"'")|.failures]|add // 0')" \
  "5:1:3:0"
chk "მიზეზები: Pareto (WEAR 1, USER_ERROR 1), უარყოფა user_error 1, მიზეზის გარეშე 0" \
  "$(T '[.causes.causes[]|"\(.code):\(.n)"]|sort|join(",")'):$(T '.causes.rejected[]|select(.code=="user_error")|.n'):$(T .causes.unclassified)" "USER_ERROR:1,WEAR:1:1:0"
chk "PM: ვადიანი 3 (P — სამუშაოს გარეშე, M PM — ვადაში, M კალიბრაცია — დაგვიანებით) → 33.3%; ვადაგადაცილებული 1 (P)" \
  "$(T '"\(.totals.pm_due):\(.totals.pm_ontime):\(.kpi.bme_pm_ontime_pct)"'):$(T '.pm.total|"\(.late):\(.open)"'):$(T '.pm.overdue|length'):$(T '.pm.overdue[0].work_no')" "3:1:33.3:1:1:1:null"
chk "ხარჯი: ნაწილები 25 (შემობრუნება გამოკლებულია), შრომა 40 + 20, გარე 100, PM 70, კონტრაქტი 2 დღე × 10 = 20; სულ 275" \
  "$(T '.costs.total|"\(.cost_parts):\(.cost_labor):\(.cost_external):\(.cost_pm):\(.cost_contract):\(.cost_total)"'):$(T .kpi.bme_service_cost)" "25:60:100:70:20:275:275"
chk "TCO: V = 50000 + სერვისი (25 + 40 + 100 + კონტრაქტი $NDAYS დღე × 5); COSR — წლიური" \
  "$(T '.costs.devices[]|select(.device_id=="'"$V"'")|"\(.service_lifetime):\(.tco):\(.cosr_pct != null)"')" "$((165 + NDAYS * 5)):$((50165 + NDAYS * 5)):true"
chk "კონტრაქტის შესრულება: 2 აპარატი, uptime სამიზნე 99, ფაქტი = V + M ერთად, ხარჯი ფანჯარაში 20" \
  "$(T '.contracts[]|select(.contract_no=="E2E-RPT-'"$S"'")|"\(.devices):\(.uptime_target):\(.availability_pct != null):\(.cost_window)"')" "2:99:true:20"

step "6. პარამეტრების გავლენა"
mod '{"rpt_restricted_weight":1,"rpt_mtbf_exclude_user_error":true,"rpt_contract_alloc":"value","rpt_pm_grace_days":1}' >/dev/null
REP2=$(api GET "/bme/reports/summary?$Q" "$ADM")
T2() { echo "$REP2" | jq -r "$1"; }
chk "შეზღუდულის წონა 1: M < 100 = პერიოდებიდან" "$(near "$(echo "$REP2" | jq -r --arg id "$M" '.availability.worst[]|select(.device_id==$id)|.bme_availability_pct')" "$(avx "$M" 1)" 0.02)" "ok"
chk "MTBF USER_ERROR-ის გარეშე: (ექსპლ. − down) / 24 / 2" "$(near "$(T2 .kpi.bme_mtbf_d)" "$(T2 '((.totals.avail_h - .totals.down_h)/24/2*10|round)/10')" 0.11)" "ok"
chk "grace 1: კალიბრაცია (ვადა გუშინ, შესრულება დღეს) — ვადაში → 66.7%" "$(T2 .kpi.bme_pm_ontime_pct)" "66.7"
chk "კონტრაქტი ღირებულებით (50000 : 10000): V 16.67, M 3.33" \
  "$(T2 '.costs.devices[]|select(.device_id=="'"$V"'")|.cost_contract'):$(T2 '.costs.devices[]|select(.device_id=="'"$M"'")|.cost_contract')" "16.67:3.33"
mod '{"rpt_restricted_weight":0,"rpt_mtbf_exclude_user_error":false,"rpt_contract_alloc":"equal","rpt_pm_grace_days":0}' >/dev/null

step "7. ფილტრები, ხედვა, აპარატის KPI, Excel"
chk "ფილტრი: კრიტიკულობა life_support → 1 აპარატი; შემსრულებელი გარე → ორდერი 0; მომწოდებელი → V + M (პასპორტი / კონტრაქტი)" \
  "$(api GET "/bme/reports/summary?$Q&criticality=life_support" "$ADM" | jq -r .devices):$(api GET "/bme/reports/summary?$Q&performer=external" "$ADM" | jq -r .totals.requests):$(api GET "/bme/reports/summary?$Q&supplier_id=$SUP" "$ADM" | jq -r .devices)" "1:0:2"
DHR=$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&device_ids=$IDS&trend=0" "$DH")
chk "bme_dept (განყ. B): მხოლოდ B (G, 1 აპარატი), ხარჯის გარეშე; განყ. A — 403" \
  "$(echo "$DHR" | jq -r '"\(.devices):\(.can_cost):\(.costs):\(.kpi.bme_service_cost // "none")"'):$(code GET "/bme/reports/summary?from=$YDAY&to=$TODAY&department_id=$DA" "$DH")" "1:false:null:none:403"
chk "bme_view — ხარჯის გარეშე; ბუღალტერია — ხარჯით" \
  "$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&device_ids=$IDS&trend=0" "$VW" | jq -r .can_cost):$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&device_ids=$IDS&trend=0" "$AC" | jq -r '"\(.can_cost):\(.costs.total.cost_total)"')" "false:true:275"
chk "meta: ფილტრები (ტიპები, ჯგუფები, კრიტიკულობა); bme_dept — მხოლოდ თავისი განყოფილება" \
  "$(api GET /bme/reports/meta "$ENG" | jq -r '"\((.types|length) > 30):\(.groups|length):\(.criticality|length):\(.all_departments)"'):$(api GET /bme/reports/meta "$DH" | jq -r '"\(.all_departments):\(.departments|length):\(.can_cost)"')" "true:10:4:true:false:1:false"
TR=$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&device_ids=$IDS" "$ENG")
chk "ტრენდი: 13 თვე, ბოლო — მიმდინარე თვე, მოთხოვნა ≥ 5" "$(echo "$TR" | jq -r '"\(.trend|length):\(.trend[-1].ym == "'"${TODAY:0:7}"'"):\((.trend|map(.requests)|add) >= 5)"')" "13:true:true"
DK=$(api GET "/bme/devices/$V/kpi" "$ENG")
chk "პასპორტი V (12 თვე): მწყობრიდან გამოსვლა 2, ხარჯი 215, TCO 50215, COSR 0.4%" "$(echo "$DK" | jq -r '"\(.failures):\(.cost.total):\(.cost.tco):\(.cost.cosr_pct)"')" "2:215:50215:0.4"
chk "პასპორტი: bme_view — ხარჯის გარეშე; bme_dept (B) — V (A) 403; G (B) — 200" \
  "$(api GET "/bme/devices/$V/kpi" "$VW" | jq -r '"\(.can_cost):\(.cost // "none")"'):$(code GET "/bme/devices/$V/kpi" "$DH"):$(code GET "/bme/devices/$G/kpi" "$DH")" "false:none:403:200"
curl -s -o "$TMP/r.xlsx" "$B/bme/reports/export?from=$YDAY&to=$TODAY&device_ids=$IDS" -H "authorization: Bearer $ENG"
curl -s -o "$TMP/d.xlsx" "$B/bme/reports/export?from=$YDAY&to=$TODAY&device_ids=$IDS" -H "authorization: Bearer $DH"
SH=$(python3 -c "import zipfile,sys,re; z=zipfile.ZipFile('$TMP/r.xlsx'); print(len([n for n in z.namelist() if n.startswith('xl/worksheets/sheet')]))" 2>/dev/null || echo "?")
SHD=$(python3 -c "import zipfile,sys,re; z=zipfile.ZipFile('$TMP/d.xlsx'); print(len([n for n in z.namelist() if n.startswith('xl/worksheets/sheet')]))" 2>/dev/null || echo "?")
chk "Excel: PK; ინჟინერი — 14 ფურცელი (ხარჯი / TCO-ით), bme_dept — 12 (ხარჯის გარეშე); ექთანი — 403" "$(head -c 2 "$TMP/r.xlsx"):$SH:$SHD:$(code GET "/bme/reports/export?from=$YDAY&to=$TODAY" "$N1")" "PK:14:12:403"

step "8. მენეჯერული დაფა"
L1=$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&department_id=$DA&trend=0" "$ADM" | jq -r .kpi.bme_availability_pct)
RF=$(refresh "$YDAY" "$TODAY")
chk "რეპორტინგის გადათვლა — ok, rpt_fact_bme შევსებულია" "$(echo "$RF" | jq -r '"\(.status):\((.facts.bme // 0) > 0)"')" "ok:true"
OV=$(api GET "/reporting/overview?from=$YDAY&to=$TODAY&department_id=$DA&compare=none" "$ADM")
LIVE=$(api GET "/bme/reports/summary?from=$YDAY&to=$TODAY&department_id=$DA&trend=0" "$ADM")
CST=$(kv "$OV" bme_service_cost); NK=$(echo "$OV" | jq -r '[.kpis[]|select(.category=="bme")]|length')
chk "KPI bme_* (A): 9 (ფინანსური მოდულის გარეშე — 8, ხარჯის გარეშე); მომხმ. შეცდომა / MTTR / PM ვადაში / SLA რეაგ. / ხარჯი = ანგარიში" \
  "$([ "$NK" = 9 ] || { [ "$NK" = 8 ] && [ -z "$CST" ]; } && echo ok || echo "$NK"):$(kv "$OV" bme_user_error_pct):$(near "$(kv "$OV" bme_mttr_h)" "$(echo "$LIVE" | jq -r .kpi.bme_mttr_h)" 0.001):$(kv "$OV" bme_pm_ontime_pct):$(near "$(kv "$OV" bme_sla_response_pct)" "$(echo "$LIVE" | jq -r .kpi.bme_sla_response_pct)" 0.001):$([ -z "$CST" ] && echo ok || near "$CST" "$(echo "$LIVE" | jq -r .kpi.bme_service_cost)" 0.02)" \
  "ok:40:ok:33.3:ok:ok"
L2=$(echo "$LIVE" | jq -r .kpi.bme_availability_pct); AV=$(kv "$OV" bme_availability_pct)
chk "ხელმისაწვდომობა (დაფა, გადათვლის მომენტი) — ანგარიშის მნიშვნელობებს შორის (გადათვლამდე / შემდეგ)" \
  "$(awk -v x="$AV" -v a="$L1" -v b="$L2" 'BEGIN { lo = (a < b ? a : b) - 0.05; hi = (a > b ? a : b) + 0.05; print (x >= lo && x <= hi ? "ok" : x " ∉ [" a ", " b "]") }')" "ok"
AT2=$(api GET "/reporting/attention?department_id=$DA" "$ADM")
chk "„ყურადღება“ (A): სიცოცხ. შემანარჩ. აპარატი გაუმართავია (წითელი, 1)" "$(echo "$AT2" | jq -r '[.items[]|select(.kind|startswith("bme_"))|"\(.kind):\(.severity):\(.value)"]|sort|join(" ")')" "bme_ls_down:red:1"
chk "KPI ცნობარი: 9 bme_* (განმარტება / ფორმულა / წყარო); ხარჯი — ფინანსური" \
  "$(api GET /reporting/kpis "$ADM" | jq -r '[.[]|select(.category=="bme" and (.definition|length)>3 and (.formula|length)>3 and (.source|length)>2)]|length'):$(api GET /reporting/kpis "$ADM" | jq -r '.[]|select(.code=="bme_service_cost")|.finance')" "9:true"
mod '{"dashboard_visibility":"bme_only"}' >/dev/null
chk "bme_only: admin (ბიომედ-უფლების გარეშე) — KPI / „ყურადღება“ არ ჩანს" \
  "$(api GET "/reporting/overview?from=$YDAY&to=$TODAY&department_id=$DA&compare=none" "$ADM" | jq -r '[.kpis[]|select(.category=="bme")]|length'):$(api GET "/reporting/attention?department_id=$DA" "$ADM" | jq -r '[.items[]|select(.kind|startswith("bme_"))]|length')" "0:0"
mod '{"dashboard_visibility":"report_users"}' >/dev/null

step "9. მოდულის გამორთვა"
api PUT /modules/bme "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე: ანგარიში / პასპორტის KPI — 403; დაფაზე KPI bme_* არ ჩანს" \
  "$(code GET "/bme/reports/summary?from=$YDAY&to=$TODAY" "$ENG"):$(code GET "/bme/devices/$V/kpi" "$ENG"):$(api GET "/reporting/overview?from=$YDAY&to=$TODAY&department_id=$DA&compare=none" "$ADM" | jq -r '[.kpis[]|select(.category=="bme")]|length')" "403:403:0"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
AUD=$(api GET "/audit-logs?entity_name=bme_reports&limit=20" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: BME_REPORT_EXPORT" "$(echo "$AUD" | tr ',' '\n' | grep -cx BME_REPORT_EXPORT)" "1"

step "გასუფთავება"
if [ -n "${E2E_KEEP:-}" ]; then
  api PUT /modules/bme "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
  ok "E2E_KEEP — მონაცემები დატოვებულია (ეკრანის სურათებისთვის), პარამეტრები დაბრუნებულია"
  printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; exit
fi
for id in $V $M $G $P $SB $X; do api POST "/bme/devices/$id/status" "$ENG" -d '{"status":"retired","reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
chk "სატესტო აპარატები გამოყვანილია" "$(for id in $V $M $G $P $SB $X; do dev "$id" | jq -r .status; done | sort -u | tr '\n' ' ')" "retired "
api POST "/bme/contracts/$KID/cancel" "$ENG" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
api PATCH "/stock/items/$PART" "$SM" -d '{"is_active":false}' >/dev/null; api PATCH "/stock/locations/$LOC" "$SM" -d '{"is_active":false}' >/dev/null
api PATCH "/stock/suppliers/$SUP" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/bme "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
[ "$(echo "$O_RPT" | jq -r .enabled)" = "true" ] || api PUT /modules/reporting "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E: დაბრუნება"}' >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for Y in "$DA" "$DB"; do api PATCH "/departments/$Y" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "კონტრაქტი გაუქმებულია; საქონელი, ლოკაცია, მომწოდებელი, მომხმარებლები, როლები, განყოფილებები გათიშულია (ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
