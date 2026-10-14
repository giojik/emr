#!/usr/bin/env bash
# =====================================================================
# e2e-claims-lock.sh — ფინანსები და შესყიდვები, ეტაპი 3 (0053): გადამხდელის დებიტორები (ქლეიმები) და პერიოდის დახურვა
#   0. მომზადება   1. ქლეიმში შესატანი შემთხვევები (სტაციონარი — ფინალიზებული; ამბულატორია — გადამხდელით)
#   2. ქლეიმი: მონახაზი, შემადგენლობა, გაგზავნა (ნომერი, ვადა), ბლოკები (გადამხდელის ცვლილება, სტაციონარის გახსნა)
#   3. ანაზღაურება (განაწილება, ზედმეტი, თარიღი), დანაკლისის გადაწყვეტა (პაციენტზე / ჩამოწერა), დაფარვა, გაუქმება
#   4. დებიტორები (ხანდაზმულობა, შეუტანელი), CSV, უფლებები, დილის შემოწმება
#   5. პერიოდის დახურვა: შემოწმება, დახურვა (სნეპშოტი), period_lock — ხარჯი / მომწოდებლის ინვოისი / მარაგი / ანაზღაურება → 409,
#      გახსნა (მიზეზით, შეტყობინება), ისტორია
#   6. აღდგენა
# შენიშვნა: ტესტი ხურავს და ხელახლა ხსნის წინა თვეს (fin_periods-ში რჩება „ღია, გაიხსნა“ ჩანაწერი); წინა თვე უკვე დახურულია → შეწყდება.
# გამოყენება:  bash scripts/e2e-claims-lock.sh [API_URL]
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
# 0057: ქლეიმის შემოწმება (scrubber) — ამ სკრიპტში გამორთული (ცალკე ტესტი: e2e-claim-scrubber.sh); ბოლოს აღდგება
SCRUB_EN=$(curl -s "$B/modules" -H "authorization: Bearer $ADM" | jq -r '.[]|select(.code=="scrubber")|.enabled // empty')
[ "$SCRUB_EN" = "true" ] && curl -s -o /dev/null -X PUT "$B/modules/scrubber" -H "authorization: Bearer $ADM" -H "$J" -d '{"enabled":false,"reason":"ტესტ-E2E: შემოწმება — ცალკე სკრიპტში"}'
# HTTP სტატუსი + შეცდომის კოდი: „409:PERIOD_LOCKED“
sc()   { local m=$1 p=$2 t=$3; shift 3; local o; o=$(curl -s -w '\n%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"); echo "$(echo "$o" | tail -1):$(echo "$o" | head -n -1 | jq -r '.code // .message.code // empty' 2>/dev/null)"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F); D10=$(date -d "$TODAY +10 days" +%F)
PM_END=$(date -d "$(date -d "$TODAY" +%Y-%m-01) -1 day" +%F); PM=${PM_END:0:7}; PM_DAY="$PM-15"; YEST=$(date -d "$TODAY -1 day" +%F)
Q="from=$TODAY&to=$TODAY"

step "0. მომზადება"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings')
echo "$ORIG" | jq -e '.period_lock' >/dev/null || die "მოდული „finance“ ვერ მოიძებნა (მიგრაცია 0053?)"
[ "$(api GET /finance/periods "$ADM" | jq -r --arg m "$PM" '.periods[]|select(.month==$m)|.status')" != "closed" ] || die "წინა თვე ($PM) უკვე დახურულია — ტესტი მას ხურავს / ხსნის; ჯერ გახსენით (ფინანსები → პერიოდები)"
fin() { api PUT /modules/finance "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }
fin '{"period_lock":"off","claim_overdue_alert":true,"opd_payer_required":false}' >/dev/null
dep() { api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქლეიმი $2 $S\",\"code\":\"E2EC$1$S\",\"type\":\"$3\"}" | jq -r '.id // empty'; }
DA=$(dep A "თერაპია" inpatient); DB=$(dep B "ამბულატორია" outpatient)
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
R_AC=$(mkrole cac "ბუღალტერი" '["accountant"]'); R_VW=$(mkrole cvw "ხელმძღვანელობა" '["viewer"]')
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.cl.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ქლ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.cl.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
AC=$(mkuser "[\"$R_AC\"]" 61); VW=$(mkuser "[\"$R_VW\"]" 62); RC=$(mkuser '["receptionist"]' 63); BL=$(mkuser '["billing"]' 64)
NA=$(mkuser '["nurse"]' 65 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 66 ",\"department_id\":\"$DA\""); DR=$(mkuser '["doctor"]' 67 ",\"department_id\":\"$DA\"")
for t in AC VW RC BL NA N2 DR; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
INS=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2ECI$S\",\"name\":\"ტესტ-E2E ქლ. დაზღვევა $S\",\"kind\":\"insurance\",\"default_mode\":\"percent\",\"default_coverage_pct\":50,\"default_deductible\":0,\"payment_terms_days\":10}" | jq -r '.id // empty')
OTH=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2ECO$S\",\"name\":\"ტესტ-E2E ქლ. სხვა $S\",\"kind\":\"other\",\"default_mode\":\"percent\",\"default_coverage_pct\":50,\"default_deductible\":0,\"payment_terms_days\":0}" | jq -r '.id // empty')
[ -n "$INS" ] && [ -n "$OTH" ] || die "გადამხდელები ვერ შეიქმნა"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"E2EC$1$S\",\"title\":\"ტესტ-E2E ქლ. $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_BED=$(tar BED "საწოლდღე" 100); T_SRV=$(tar SRV "მომსახურება" 40)
BT=$(api PUT /billing/bed-tariffs "$BL" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
SVC=$(api POST /dx/catalog "$ADM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_CL_$S\",\"name\":\"ტესტ-E2E ქლ. ანალიზი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\"}" | jq -r '.id // empty')
api POST "/dx/catalog/$SVC/analytes" "$ADM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"ranges":[]}' >/dev/null
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"base_price":50}' >/dev/null
[ -n "$T_BED" ] && [ -n "$T_SRV" ] && [ -n "$BT" ] && [ -n "$SVC" ] || die "ტარიფები / ანალიზი ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ქლ-$2\",\"birth_date\":\"1965-06-06\",\"gender\":\"female\",\"phone_number\":\"596$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 81 1); P2=$(mkpat 82 2); P3=$(mkpat 83 3); P4=$(mkpat 84 4)
ok "მომზადება: 2 განყოფილება, 7 მომხმარებელი, 2 გადამხდელი (ვადა 10 / 0 დღე), ტარიფები, ანალიზი 50 ₾"

step "1. შესატანი შემთხვევები"
labvisit() { api POST /lab-visits "$RC" -d "{\"patient_id\":\"$1\",\"items\":[{\"service_id\":\"$SVC\"}],\"department_id\":\"$DB\"}" | jq -r '.encounter_id // empty'; }
V1=$(labvisit "$P1"); V2=$(labvisit "$P2")
I1=$(api GET "/invoices/encounter/$V1" "$RC" | jq -r .id); I2=$(api GET "/invoices/encounter/$V2" "$RC" | jq -r .id)
api PUT "/invoices/$I1/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS\",\"insurance_share\":40}" >/dev/null
api PUT "/invoices/$I2/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS\",\"insurance_share\":50}" >/dev/null
api POST "/encounters/$V1/pay-initial" "$RC" -d '{"amount":10,"method":"cash"}' >/dev/null
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 67)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
DISCH() { api POST "/inpatient/stays/$1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 65)\",\"$(uid 66)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null; }
E1=$(ADMIT "$P3"); E2=$(ADMIT "$P4")
[ -n "$V1" ] && [ -n "$V2" ] && [ -n "$E1" ] && [ -n "$E2" ] || die "ვიზიტები / ჰოსპიტალიზაციები ვერ შეიქმნა"
api POST "/inpatient/stays/$E1/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" >/dev/null
api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"policy_no\":\"POL-C$S\",\"guarantee_no\":\"G-C$S\"}" >/dev/null
api POST "/inpatient/stays/$E2/payers" "$RC" -d "{\"payer_id\":\"$OTH\"}" >/dev/null
CAND=$(api GET "/finance/claims/candidates?payer_id=$INS&$Q" "$AC")
chk "დაუფინალებელი სტაციონარი არ შედის: მხოლოდ 2 ამბ. (40 + 50)" "$(echo "$CAND" | jq -r '"\(length):\([.[].claimed|tonumber]|add)"')" "2:90"
DISCH "$E1"; DISCH "$E2"
chk "ფინალიზაცია: E1 140 (დაზღვევა 70), E2 100 (სხვა 50)" "$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL" | jq -r '.money.insurance'):$(api POST "/inpatient/stays/$E2/billing/finalize" "$BL" | jq -r '.money.insurance')" "70:50"
CAND=$(api GET "/finance/claims/candidates?payer_id=$INS&$Q" "$AC")
chk "დაზღვევა: 3 შემთხვევა (ამბ. 40, 50; სტაც. 70) = 160" "$(echo "$CAND" | jq -r '"\(length):\([.[].claimed|tonumber]|add):\([.[]|select(.kind=="ipd")][0].adm_no!=null)"')" "3:160:true"

step "2. ქლეიმი"
chk "ბილინგი ქლეიმს ვერ ქმნის (403); ექთანი სიას ვერ ხედავს (403)" "$(code POST /finance/claims "$BL" -d "{\"payer_id\":\"$INS\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\"}"):$(code GET /finance/claims "$NA")" "403:403"
CL=$(api POST /finance/claims "$AC" -d "{\"payer_id\":\"$INS\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\",\"notes\":\"ტესტ-E2E\"}")
CID=$(echo "$CL" | jq -r '.id // empty'); [ -n "$CID" ] || die "ქლეიმი ვერ შეიქმნა: $(echo "$CL" | jq -rc .message)"
chk "მონახაზი: 3 შემთხვევა, 160, ნომრის გარეშე" "$(echo "$CL" | jq -r '"\(.status):\(.items|length):\(.total_claimed|tonumber+0):\(.claim_no)"')" "draft:3:160:null"
chk "იგივე გადამხდელი / პერიოდი მეორედ → 400 (შემთხვევები უკვე ქლეიმშია)" "$(code POST /finance/claims "$AC" -d "{\"payer_id\":\"$INS\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\"}")" "400"
item() { api GET "/finance/claims/$CID" "$AC" | jq -r --arg i "$1" '.items[]|select(.invoice_id==$i)|.id'; }
IE1=$(api GET "/invoices/encounter/$E1" "$BL" | jq -r .id)
IT1=$(item "$I1"); IT2=$(item "$I2"); IT3=$(item "$IE1")
chk "შემთხვევის ამოღება (მონახაზი) → 2, 110" "$(api DELETE "/finance/claims/$CID/items/$IT2" "$AC" | jq -r '"\(.items|length):\(.total_claimed|tonumber+0)"')" "2:110"
chk "განახლება: ახალი შემთხვევები უბრუნდება → 3, 160" "$(api PUT "/finance/claims/$CID" "$AC" -d '{}' | jq -r '"\(.items|length):\(.total_claimed|tonumber+0)"')" "3:160"
IT2=$(item "$I2")
chk "მონახაზზე ანაზღაურება → 409" "$(code POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":10}")" "409"
S1=$(api POST "/finance/claims/$CID/send" "$AC")
chk "გაგზავნა: CL-ნომერი, ვადა = დღეს + 10" "$(echo "$S1" | jq -r '"\(.status):\(.claim_no|test("^CL[0-9]{2}-[0-9]{6}$")):\(.due_date)"')" "sent:true:$D10"
chk "მეორედ გაგზავნა → 409; გაგზავნილში ამოღება → 409" "$(code POST "/finance/claims/$CID/send" "$AC"):$(code DELETE "/finance/claims/$CID/items/$IT1" "$AC")" "409:409"
chk "ქლეიმში შემავალი ინვოისი: გადამხდელის ცვლილება → 409" "$(api PUT "/invoices/$I1/payers" "$RC" -d '{"insurance_share":30}' | jq -r '.code // .message.code // empty')" "INVOICE_IN_CLAIM"
chk "ქლეიმში შემავალი სტაციონარი: ბილინგის გახსნა → 409" "$(sc POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}')" "409:INVOICE_IN_CLAIM"
chk "სალაროში ჩანს ქლეიმის ნომერი" "$(api GET "/invoices/encounter/$V1" "$RC" | jq -r '.claim_nos')" "$(echo "$S1" | jq -r .claim_no)"

step "3. ანაზღაურება და გადაწყვეტა"
chk "ზედმეტი ანაზღაურება (161) → 409" "$(code POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":161}")" "409"
chk "მომავალი თარიღი → 400" "$(code POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$D10\",\"amount\":10}")" "400"
chk "განაწილების ჯამი ≠ თანხა → 400" "$(code POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":100,\"allocations\":[{\"item_id\":\"$IT1\",\"amount\":40}]}")" "400"
chk "განაწილება ნაშთზე მეტი (ამბ. 40 → 41) → 409" "$(code POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":41,\"allocations\":[{\"item_id\":\"$IT1\",\"amount\":41}]}")" "409"
P=$(api POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":100,\"ref_no\":\"BANK-$S\",\"allocations\":[{\"item_id\":\"$IT1\",\"amount\":40},{\"item_id\":\"$IT2\",\"amount\":30},{\"item_id\":\"$IT3\",\"amount\":30}]}")
chk "ანაზღაურება 100 (40 / 30 / 30) → ნაწილობრივ, ნაშთი 60" "$(echo "$P" | jq -r '"\(.status):\(.total_paid|tonumber+0):\(.outstanding|tonumber+0)"')" "partial:100:60"
chk "ბილინგი: დაფარულ შემთხვევაზე გადაწყვეტა → 400" "$(code POST "/finance/claim-items/$IT1/resolve" "$BL" -d '{"action":"writeoff","reason":"ტესტ-E2E"}')" "400"
chk "მიზეზის გარეშე → 400; ექთანი → 403" "$(code POST "/finance/claim-items/$IT2/resolve" "$AC" -d '{"action":"writeoff"}'):$(code POST "/finance/claim-items/$IT2/resolve" "$NA" -d '{"action":"writeoff","reason":"ტესტ-E2E"}')" "400:403"
R=$(api POST "/finance/claim-items/$IT2/resolve" "$AC" -d '{"action":"writeoff","reason":"ტესტ-E2E გამორიცხული მომსახურება"}')
chk "ჩამოწერა (ამბ. 2, ნაშთი 20) → გადაწყვეტილი 20, ქლეიმის ნაშთი 40" "$(echo "$R" | jq -r --arg i "$IT2" '"\(.items[]|select(.id==$i)|"\(.resolution):\(.resolved_amount|tonumber+0):\(.outstanding|tonumber+0)"):\(.outstanding|tonumber+0)"')" "writeoff:20:0:40"
chk "მეორედ გადაწყვეტა → 409" "$(code POST "/finance/claim-items/$IT2/resolve" "$AC" -d '{"action":"patient","reason":"ტესტ-E2E"}')" "409"
R=$(api POST "/finance/claim-items/$IT3/resolve" "$BL" -d '{"action":"patient","amount":15,"reason":"ტესტ-E2E ლიმიტი"}')
chk "ბილინგი: სტაციონარი — 15 პაციენტზე (ქლეიმის ნაშთი 25)" "$(echo "$R" | jq -r '.outstanding|tonumber+0')" "25"
INV=$(api GET "/invoices/encounter/$E1" "$BL")
chk "ინვოისი E1: დაზღვევა 70 → 55, პაციენტი 70 → 85" "$(echo "$INV" | jq -r '"\(.insurance_share|tonumber+0):\(.patient_share|tonumber+0)"')" "55:85"
chk "სტაციონარის ბილინგი: გადამხდელის დაფარვა 55" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '.payers[0].covered_amount|tonumber+0')" "55"
REV=$(api GET "/finance/revenue?$Q&dept_basis=ordering" "$AC")
chk "შემოსავალი (ამბ. B): დაზღვევა 70, პაციენტი 10, უარი 20, წმინდა 80" "$(echo "$REV" | jq -r --arg d "$DB" '[.by_department[]|select(.department_id==$d)][0]|"\(.insurance):\(.patient):\(.denied):\(.net)"')" "70:10:20:80"
chk "შემოსავალი (სტაც. A): დაზღვევა 55 (E1), სხვა 50 (E2), პაციენტი 85 + 50" "$(echo "$REV" | jq -r --arg d "$DA" '[.by_department[]|select(.department_id==$d)][0]|"\(.insurance):\(.other):\(.patient)"')" "55:50:135"
P2=$(api POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":25}")
chk "ანაზღაურება 25 (ავტომატური განაწილება) → დაფარული" "$(echo "$P2" | jq -r '"\(.status):\(.outstanding|tonumber+0)"')" "settled:0"
PID=$(echo "$P2" | jq -r '[.payments[]|select(.is_void|not)]|last|.id')
chk "გაუქმება მიზეზის გარეშე → 400" "$(code POST "/finance/claim-payments/$PID/void" "$AC" -d '{}')" "400"
chk "ანაზღაურების გაუქმება → ნაწილობრივ, ნაშთი 25" "$(api POST "/finance/claim-payments/$PID/void" "$AC" -d '{"reason":"ტესტ-E2E შეცდომა"}' | jq -r '"\(.status):\(.outstanding|tonumber+0)"')" "partial:25"
chk "ანაზღაურებიანი ქლეიმის გაუქმება → 409" "$(code POST "/finance/claims/$CID/cancel" "$AC" -d '{"reason":"ტესტ-E2E"}')" "409"

step "4. დებიტორები, CSV, უფლებები"
RV=$(api GET "/finance/receivables?as_of=$TODAY" "$AC")
chk "დაზღვევა: ვადამდე 25 (ქლეიმი), შეუტანელი 0" "$(echo "$RV" | jq -r --arg p "$INS" '.rows[]|select(.payer_id==$p)|"\(.not_due):\(.unclaimed):\(.total)"')" "25:0:25"
chk "„სხვა“ გადამხდელი: შეუტანელი 50 (სტაც. E2)" "$(echo "$RV" | jq -r --arg p "$OTH" '.rows[]|select(.payer_id==$p)|.unclaimed')" "50"
chk "ვადის შემდეგ (as_of = ვადა + 20) — 1–30 დღე" "$(api GET "/finance/receivables?as_of=$(date -d "$D10 +20 days" +%F)" "$AC" | jq -r --arg p "$INS" '.rows[]|select(.payer_id==$p)|.d1_30')" "25"
CSV=$(curl -s "$B/finance/claims/$CID/csv" -H "authorization: Bearer $AC")
chk "CSV: სტაციონარის ხაზი (საგარანტიო, 70 / 30 / 15 / 25)" "$(echo "$CSV" | grep -c "G-C$S;70.00;30.00;15.00;25.00")" "1"
chk "ხელმძღვანელობა: ნახვა 200, ანაზღაურება 403" "$(code GET "/finance/claims/$CID" "$VW"):$(code POST "/finance/claims/$CID/payments" "$VW" -d "{\"paid_on\":\"$TODAY\",\"amount\":1}")" "200:403"
CL2=$(api POST /finance/claims "$AC" -d "{\"payer_id\":\"$OTH\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\"}" | jq -r '.id // empty')
chk "მეორე ქლეიმი („სხვა“, ვადა 0 დღე) → გაგზავნა, ვადა დღეს" "$(api POST "/finance/claims/$CL2/send" "$AC" | jq -r '"\(.status):\(.due_date)"')" "sent:$TODAY"
chk "დილის შემოწმება: ვადა დღეს — ჯერ არ არის ვადაგადაცილებული" "$(api POST /stock/alerts/run "$ADM" | jq -r '.claim_due.claims // 0')" "0"
chk "გაგზავნილის გაუქმება (ანაზღაურების გარეშე) → შემთხვევა თავისუფლდება" "$(api POST "/finance/claims/$CL2/cancel" "$AC" -d '{"reason":"ტესტ-E2E არასწორი პერიოდი"}' | jq -r '"\(.status):\(.items|length)"'):$(api GET "/finance/claims/candidates?payer_id=$OTH&$Q" "$AC" | jq -r 'length')" "cancelled:0:1"
chk "სია: ფილტრი „ღია“ — ქლეიმი 1 ჩანს" "$(api GET '/finance/claims?status=open' "$AC" | jq -r --arg c "$CID" '[.[]|select(.id==$c)]|length')" "1"
chk "ჯამი (ბეჯი): ღია ≥ 1, დაუფარავი ≥ 25" "$(api GET /finance/claims/summary "$AC" | jq -r '"\(.open >= 1):\((.outstanding|tonumber) >= 25)"')" "true:true"
chk "აუდიტი: შექმნა, გაგზავნა, ანაზღაურება, გადაწყვეტა" "$(api GET "/audit-logs?entity_name=fin_claims&entity_id=$CID&limit=30" "$ADM" | jq -r '[.[].action]|(index("FIN_CLAIM_CREATE")!=null) and (index("FIN_CLAIM_SEND")!=null) and (index("FIN_CLAIM_PAYMENT")!=null)')" "true"

step "5. პერიოდის დახურვა"
chk "მიმდინარე თვე → 400" "$(code POST "/finance/periods/${TODAY:0:7}/close" "$AC" -d '{}')" "400"
chk "არასწორი თვე → 400; ბილინგი → 403" "$(code POST "/finance/periods/2026-13/close" "$AC" -d '{}'):$(code POST "/finance/periods/$PM/close" "$BL" -d '{}')" "400:403"
CK=$(api GET "/finance/periods/$PM/checklist" "$AC")
chk "შემოწმების სია: 7 პუნქტი" "$(echo "$CK" | jq -r '.items|length')" "7"
# მონაცემები წინა თვის თარიღით (დახურვამდე)
X0=$(api POST /expenses "$AC" -d "{\"expense_date\":\"$PM_DAY\",\"category\":\"ტესტ-E2E ქლ.\",\"amount\":12,\"payment_method\":\"cash\"}" | jq -r '.id // empty')
[ -n "$X0" ] && ok "ხარჯი წინა თვის თარიღით (დახურვამდე) — 201" || bad "ხარჯი წინა თვით" ""
SUP=$(api POST /stock/suppliers "$ADM" -d "{\"name\":\"ტესტ-E2E ქლ. მომწოდებელი $S\",\"tax_id\":\"7$(printf '%08d' "$S")\",\"vat_payer\":false,\"payment_terms_days\":30}" | jq -r '.id // empty')
AP=$(api POST /payables/invoices "$AC" -d "{\"supplier_id\":\"$SUP\",\"invoice_no\":\"F-$S\",\"invoice_date\":\"$PM_DAY\",\"total\":100,\"lines\":[{\"description\":\"ტესტ-E2E მომსახურება\",\"category\":\"ტესტ-E2E ქლ.\",\"amount\":100}]}" | jq -r '.id // empty')
[ -n "$AP" ] || bad "მომწოდებლის ინვოისი (მონახაზი)" ""
fin '{"period_lock":"on"}' >/dev/null
CLOSE=$(api POST "/finance/periods/$PM/close" "$AC" -d '{"note":"ტესტ-E2E დახურვა"}')
chk "დახურვა: closed, დაცვა ჩართულია, სნეპშოტი (ხარჯი ≥ 12)" "$(echo "$CLOSE" | jq -r '"\(.status):\(.locked):\(.snapshot.expenses >= 12)"')" "closed:true:true"
chk "მეორედ დახურვა → 409" "$(code POST "/finance/periods/$PM/close" "$AC" -d '{}')" "409"
chk "ხარჯი დახურული თვით → 409 PERIOD_LOCKED" "$(sc POST /expenses "$AC" -d "{\"expense_date\":\"$PM_DAY\",\"category\":\"ტესტ-E2E ქლ.\",\"amount\":5,\"payment_method\":\"cash\"}")" "409:PERIOD_LOCKED"
chk "დახურული თვის ხარჯის გაუქმება → 409" "$(code PATCH "/expenses/$X0" "$AC" -d '{"void":true,"void_reason":"ტესტ-E2E შეცდომა"}')" "409"
X1=$(api POST /expenses "$AC" -d "{\"expense_date\":\"$TODAY\",\"category\":\"ტესტ-E2E ქლ.\",\"amount\":5,\"payment_method\":\"cash\"}" | jq -r '.id // empty')
[ -n "$X1" ] && ok "ხარჯი მიმდინარე თვით — დასაშვებია" || bad "ხარჯი მიმდინარე თვით" ""
chk "მომწოდებლის ინვოისის გატარება (დახურული თვის თარიღი) → 409" "$(code POST "/payables/invoices/$AP/post" "$AC")" "409"
LC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2E_CL_$S\",\"name\":\"ტესტ-E2E ქლ. საწყობი $S\",\"kind\":\"central\",\"requires_approval\":false}" | jq -r '.id // empty')
HOU=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E ქლ. ხელთათმანი $S\",\"category_id\":\"$(api GET /stock/refs "$ADM" | jq -r '.categories[]|select(.code=="HOUSE").id')\",\"base_unit\":\"pair\"}" | jq -r '.id // empty')
RCP=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$LC\",\"doc_date\":\"$PM_DAY\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":5,\"lot_no\":\"L$S\",\"expires_on\":\"$D2Y\",\"price\":1,\"vat_rate\":0}]}" | jq -r '.id // empty')
chk "მარაგის მიღება დახურული თვის თარიღით — გატარება 409" "$(code POST "/stock/receipts/$RCP/post" "$ADM")" "409"
chk "ქლეიმის ანაზღაურება დახურული თვით → 409" "$(code POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$PM_DAY\",\"amount\":5}")" "409"
chk "ანაზღაურება მიმდინარე თვით → დაფარული" "$(api POST "/finance/claims/$CID/payments" "$AC" -d "{\"paid_on\":\"$TODAY\",\"amount\":25}" | jq -r '.status')" "settled"
fin '{"period_lock":"off"}' >/dev/null
X2=$(api POST /expenses "$AC" -d "{\"expense_date\":\"$PM_DAY\",\"category\":\"ტესტ-E2E ქლ.\",\"amount\":3,\"payment_method\":\"cash\"}" | jq -r '.id // empty')
[ -n "$X2" ] && ok "period_lock=off — დახურულ თვეში ცვლილება აღარ იბლოკება" || bad "period_lock=off" ""
fin '{"period_lock":"on"}' >/dev/null
chk "გახსნა მიზეზის გარეშე → 400; ბილინგი → 403" "$(code POST "/finance/periods/$PM/reopen" "$AC" -d '{}'):$(code POST "/finance/periods/$PM/reopen" "$BL" -d '{"reason":"ტესტ-E2E"}')" "400:403"
chk "გახსნა (admin, მიზეზით)" "$(api POST "/finance/periods/$PM/reopen" "$ADM" -d '{"reason":"ტესტ-E2E შესწორება"}' | jq -r .status)" "open"
chk "ბუღალტერს — შეტყობინება (fin_period)" "$(api GET /notifications "$AC" | jq -r '[.[]|select(.kind=="fin_period")]|length > 0')" "true"
chk "გახსნის შემდეგ — გატარება დასაშვებია" "$(api POST "/stock/receipts/$RCP/post" "$ADM" | jq -r .status):$(api POST "/payables/invoices/$AP/post" "$AC" | jq -r .status)" "posted:posted"
P=$(api GET /finance/periods "$AC")
chk "პერიოდები: თვე ღიაა („გაიხსნა“), ისტორია — დახურვა + გახსნა" "$(echo "$P" | jq -r --arg m "$PM" '"\(.periods[]|select(.month==$m)|"\(.status):\(.reopen_reason)"):\([.log[]|select(.month==$m)|.action]|unique|join(","))"')" "open:ტესტ-E2E შესწორება:close,reopen"
chk "აუდიტი: FIN_PERIOD_CLOSE / REOPEN" "$(api GET "/audit-logs?entity_name=fin_periods&entity_id=$PM&limit=10" "$ADM" | jq -r '[.[].action]|(index("FIN_PERIOD_CLOSE")!=null) and (index("FIN_PERIOD_REOPEN")!=null)')" "true"

step "6. აღდგენა"
for X in "$X0" "$X1" "$X2"; do [ -n "$X" ] && api PATCH "/expenses/$X" "$AC" -d '{"void":true,"void_reason":"ტესტ-E2E გასუფთავება"}' >/dev/null; done
api POST "/payables/invoices/$AP/void" "$AC" -d '{"reason":"ტესტ-E2E გასუფთავება"}' >/dev/null
LOT=$(api GET "/stock/balances?location_id=$LC" "$ADM" | jq -c '[.rows[]|select((.qty|tonumber) > 0)|{lot_id, qty_base:(.qty|tonumber)}]')
if [ -n "$LOT" ] && [ "$LOT" != "[]" ]; then
  WC=$(api POST /stock/writeoffs "$ADM" -d "{\"location_id\":\"$LC\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":$LOT}")
  [ "$(echo "$WC" | jq -r '.status')" = "posted" ] || api POST "/stock/writeoffs/$(echo "$WC" | jq -r .id)/decide" "$ADM" -d '{"approve":true}' >/dev/null
fi
api DELETE "/billing/bed-tariffs/$BT" "$BL" >/dev/null
for p in "$INS" "$OTH"; do api PATCH "/billing/payers/$p" "$BL" -d '{"is_active":false}' >/dev/null; done
for t in "$T_BED" "$T_SRV"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
api PATCH "/stock/locations/$LC" "$ADM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
api PUT /modules/finance "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგა; ტესტის ლოკაციის ნაშთი 0" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings' | jq -S -c .):$(api GET "/stock/balances?location_id=$LC" "$ADM" | jq -r '.rows|length')" "$(echo "$ORIG" | jq -S -c .):0"

[ "$SCRUB_EN" = "true" ] && curl -s -o /dev/null -X PUT "$B/modules/scrubber" -H "authorization: Bearer $ADM" -H "$J" -d '{"enabled":true,"reason":"ტესტ-E2E აღდგენა"}'
printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
