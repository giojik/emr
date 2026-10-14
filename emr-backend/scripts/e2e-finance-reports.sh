#!/usr/bin/env bash
# =====================================================================
# e2e-finance-reports.sh — ფინანსები და შესყიდვები, ეტაპი 3 (0053): რეპორტები
#   0. მომზადება (განყოფილებები, მომხმარებლები, გადამხდელები, ტარიფები, ლაბ. ანალიზი, პარამეტრები)
#   1. ამბულატორიის გადამხდელი (სალარო): დაზღვევა / სახელმწიფო, ვალიდაცია, opd_payer_required, უფლებები
#   2. ხაზის თარიღი და განყოფილებები (ordering / performing, dx_performing_dept)
#   3. სტაციონარი: საწოლდღე, მომსახურება, მარაგი პაციენტზე → ფინალიზაცია (გადამხდელი) / დაუფინალებელი
#   4. შემოსავალი: გადამხდელით / განყოფილებით, service_date / finalized, ordering / performing, CSV
#   5. მარაგი: ღირებულება თარიღით, მოხმარება / გაცემა (dept_consumption_basis), დანაკარგი, ჩაწერილი / დაუწერელი, ქვესაწყობი
#   6. განყოფილების შედეგი + საერთო ხარჯის განაწილება (none / manual / revenue / bed_days)
#   7. უფლებები: მენეჯერი — თავისი განყოფილება (dept_finance_visible), ექთანი 403, მოდულის გამორთვა
#   8. აღდგენა (მარაგი 0, გადამხდელები / ტარიფები გაითიშა, პარამეტრები)
# შენიშვნა: სატესტო ინვოისები / ჰოსპიტალიზაციები რჩება (ტესტ-E2E განყოფილებებზე) — ეს ნორმაა.
# გამოყენება:  bash scripts/e2e-finance-reports.sh [API_URL]
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
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F)
Q="from=$TODAY&to=$TODAY"

step "0. მომზადება"
dep() { api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ფინ. $2 $S\",\"code\":\"E2EF$1$S\",\"type\":\"$3\"}" | jq -r '.id // empty'; }
DA=$(dep A "თერაპია" inpatient); DB=$(dep B "კარდიოლოგია" outpatient); DL=$(dep L "ლაბორატორია" diagnostic); DX=$(dep X "ადმინისტრაცია" administrative)
[ -n "$DA" ] && [ -n "$DB" ] && [ -n "$DL" ] && [ -n "$DX" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
R_AC=$(mkrole fac "ბუღალტერი" '["accountant"]'); R_VW=$(mkrole fvw "ხელმძღვანელობა" '["viewer"]'); R_MG=$(mkrole fmg "მენეჯერი" '["manager"]')
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.fin.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ფინ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.fin.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
AC=$(mkuser "[\"$R_AC\"]" 41); VW=$(mkuser "[\"$R_VW\"]" 42); MG=$(mkuser "[\"$R_MG\"]" 43 ",\"department_id\":\"$DA\"")
MG2=$(mkuser "[\"$R_MG\"]" 44); RC=$(mkuser '["receptionist"]' 45); BL=$(mkuser '["billing"]' 46)
NA=$(mkuser '["nurse"]' 47 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 48 ",\"department_id\":\"$DA\""); DR=$(mkuser '["doctor"]' 49 ",\"department_id\":\"$DA\"")
for t in AC VW MG MG2 RC BL NA N2 DR; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "4 განყოფილება (სტაც., ამბ., ლაბ., ადმ.) + 9 მომხმარებელი (ბუღალტერი, ხელმძღვანელობა, 2 მენეჯერი, მიმღები, ბილინგი, 2 ექთანი, ექიმი)"
INS=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EFI$S\",\"name\":\"ტესტ-E2E ფინ. დაზღვევა $S\",\"kind\":\"insurance\",\"default_mode\":\"percent\",\"default_coverage_pct\":50,\"default_deductible\":0,\"payment_terms_days\":15}" | jq -r '.id // empty')
SSA=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EFS$S\",\"name\":\"ტესტ-E2E ფინ. სახელმწიფო $S\",\"kind\":\"state\",\"default_mode\":\"percent\",\"default_coverage_pct\":100}" | jq -r '.id // empty')
[ -n "$INS" ] && [ -n "$SSA" ] || die "გადამხდელები ვერ შეიქმნა"
chk "გადამხდელი: ანაზღაურების ვადა (15 დღე)" "$(api GET /billing/payers "$BL" | jq -r --arg p "$INS" '.[]|select(.id==$p)|.payment_terms_days')" "15"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"E2EF$1$S\",\"title\":\"ტესტ-E2E ფინ. $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_BED=$(tar BED "საწოლდღე" 100); T_SRV=$(tar SRV "გადასახვევი" 40)
BT=$(api PUT /billing/bed-tariffs "$BL" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
[ -n "$T_BED" ] && [ -n "$T_SRV" ] && [ -n "$BT" ] || die "ტარიფები ვერ შეიქმნა"
SVC=$(api POST /dx/catalog "$ADM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_FIN_$S\",\"name\":\"ტესტ-E2E ფინ. ანალიზი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\"}" | jq -r '.id // empty')
[ -n "$SVC" ] || die "ლაბ. ანალიზი ვერ შეიქმნა"
api POST "/dx/catalog/$SVC/analytes" "$ADM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"ranges":[]}' >/dev/null
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"base_price":50}' >/dev/null
ok "ტარიფები (საწოლდღე 100 — განყოფილება A, მომსახურება 40), ლაბ. ანალიზი 50 ₾"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings')
echo "$ORIG" | jq -e '.revenue_basis' >/dev/null || die "მოდული „finance“ ვერ მოიძებნა (მიგრაცია 0053?)"
fin() { api PUT /modules/finance "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }
chk "პარამეტრები: ნაგულისხმევი + ლაბ. → ლაბორატორია" "$(fin "{\"dept_consumption_basis\":\"consumption\",\"revenue_basis\":\"service_date\",\"revenue_dept_basis\":\"performing\",\"dx_performing_dept\":{\"lab\":\"$DL\",\"radiology\":null,\"endoscopy\":null},\"opd_payer_required\":false,\"overhead_allocation\":\"none\",\"period_lock\":\"off\",\"dept_finance_visible\":\"heads\"}")" "finance"
chk "პარამეტრი: უცნობი მნიშვნელობა → 400" "$(code PUT /modules/finance "$ADM" -d '{"settings":{"dept_consumption_basis":"x"},"reason":"ტესტ-E2E"}')" "400"
chk "პარამეტრი: dx — უცნობი განყოფილება → 400" "$(code PUT /modules/finance "$ADM" -d '{"settings":{"dx_performing_dept":{"lab":"00000000-0000-0000-0000-000000000000","radiology":null,"endoscopy":null}},"reason":"ტესტ-E2E"}')" "400"
chk "პარამეტრი: manual — ჯამი ≠ 100 → 400" "$(code PUT /modules/finance "$ADM" -d "{\"settings\":{\"overhead_allocation\":\"manual\",\"overhead_manual\":{\"$DA\":60}},\"reason\":\"ტესტ-E2E\"}")" "400"
chk "პარამეტრი: manual — ადმინისტრაციული განყოფილება → 400" "$(code PUT /modules/finance "$ADM" -d "{\"settings\":{\"overhead_allocation\":\"manual\",\"overhead_manual\":{\"$DX\":100}},\"reason\":\"ტესტ-E2E\"}")" "400"
chk "პარამეტრს მხოლოდ admin ცვლის (ბუღალტერი 403)" "$(code PUT /modules/finance "$AC" -d '{"settings":{"period_lock":"on"},"reason":"ტესტ-E2E"}')" "403"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ფინ-$2\",\"birth_date\":\"1970-05-05\",\"gender\":\"male\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 51 1); P2=$(mkpat 52 2); P3=$(mkpat 53 3); P4=$(mkpat 54 4)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && [ -n "$P4" ] || die "პაციენტები ვერ შეიქმნა"

step "1. ამბულატორიის გადამხდელი (სალარო)"
labvisit() { api POST /lab-visits "$RC" -d "{\"patient_id\":\"$1\",\"items\":[{\"service_id\":\"$SVC\"}],\"department_id\":\"$DB\"}" | jq -r '.encounter_id // empty'; }
V1=$(labvisit "$P1"); V2=$(labvisit "$P2")
[ -n "$V1" ] && [ -n "$V2" ] || die "ლაბ. ვიზიტები ვერ გაიხსნა"
I1=$(api GET "/invoices/encounter/$V1" "$RC" | jq -r .id); I2=$(api GET "/invoices/encounter/$V2" "$RC" | jq -r .id)
chk "2 ლაბ. ვიზიტი (ამბ. განყოფილება B), ინვოისი 50 ₾" "$(api GET "/invoices/encounter/$V1" "$RC" | jq -r '.total_amount|tonumber+0')" "50"
R=$(api PUT "/invoices/$I1/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS\",\"insurance_share\":30}")
chk "მიმღები: დაზღვევა 30 → პაციენტის წილი 20" "$(echo "$R" | jq -r '"\(.insurance_share|tonumber+0):\(.patient_share|tonumber+0):\(.insurance_payer_id==$p)"' --arg p "$INS")" "30:20:true"
chk "ინვოისში ჩანს გადამხდელის სახელი" "$(api GET "/invoices/encounter/$V1" "$RC" | jq -r '.insurance_payer_name')" "ტესტ-E2E ფინ. დაზღვევა $S"
chk "სახელმწიფო პროგრამა დაზღვევის წილში → 400" "$(code PUT "/invoices/$I2/payers" "$RC" -d "{\"insurance_payer_id\":\"$SSA\",\"insurance_share\":10}")" "400"
chk "დაზღვევა სახელმწიფოს წილში → 400" "$(code PUT "/invoices/$I2/payers" "$RC" -d "{\"state_payer_id\":\"$INS\",\"state_share\":10}")" "400"
chk "წილების ჯამი > ინვოისი → 400" "$(code PUT "/invoices/$I2/payers" "$RC" -d "{\"state_payer_id\":\"$SSA\",\"state_share\":60}")" "400"
chk "ექთანი → 403" "$(code PUT "/invoices/$I2/payers" "$NA" -d "{\"state_payer_id\":\"$SSA\",\"state_share\":50}")" "403"
fin '{"opd_payer_required":true}' >/dev/null
chk "opd_payer_required: წილი გადამხდელის გარეშე → 400" "$(code PUT "/invoices/$I2/payers" "$RC" -d '{"state_share":50}')" "400"
fin '{"opd_payer_required":false}' >/dev/null
chk "სახელმწიფო 50 → პაციენტის წილი 0" "$(api PUT "/invoices/$I2/payers" "$BL" -d "{\"state_payer_id\":\"$SSA\",\"state_share\":50}" | jq -r '"\(.state_share|tonumber+0):\(.patient_share|tonumber+0)"')" "50:0"
api POST "/encounters/$V1/pay-initial" "$RC" -d '{"amount":20,"method":"cash"}' >/dev/null
chk "გადახდა 20 → წილის გაზრდა (პაციენტის წილი < გადახდილი) → 400" "$(code PUT "/invoices/$I1/payers" "$RC" -d '{"insurance_share":40}')" "400"

step "2. ხაზის თარიღი და განყოფილებები"
L=$(api GET "/invoices/encounter/$V1" "$RC" | jq -c '.lines[0]')
chk "service_date = დღეს; ordering = B (ვიზიტი), performing = ლაბორატორია (dx_performing_dept)" \
  "$(echo "$L" | jq -r --arg b "$DB" --arg l "$DL" '"\(.service_date):\(.ordering_department_id==$b):\(.performing_department_id==$l)"')" "$TODAY:true:true"

step "3. სტაციონარი"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 49)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P3"); E2=$(ADMIT "$P4")
[ -n "$E1" ] && [ -n "$E2" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
api POST "/inpatient/stays/$E1/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" >/dev/null
api GET "/inpatient/stays/$E2/billing" "$BL" >/dev/null
SP=$(api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"policy_no\":\"POL-F$S\"}" | jq -r '.id // empty')
[ -n "$SP" ] && ok "2 ჰოსპიტალიზაცია (A); E1: მომსახურება 40 + დაზღვევა 50%" || bad "გადამხდელი E1" ""
# მარაგი: ცენტრალური (განყოფილების გარეშე) + განყოფილების ქვესაწყობი (A)
REFS=$(api GET /stock/refs "$ADM"); cat_id() { echo "$REFS" | jq -r ".categories[]|select(.code==\"$1\").id"; }
LC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2E_FC_$S\",\"name\":\"ტესტ-E2E ფინ. ცენტრალური $S\",\"kind\":\"central\",\"requires_approval\":false}" | jq -r '.id // empty')
LD=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2E_FD_$S\",\"name\":\"ტესტ-E2E ფინ. ქვესაწყობი A $S\",\"kind\":\"department\",\"department_id\":\"$DA\",\"requires_approval\":false}" | jq -r '.id // empty')
CAT=$(api POST /stock/categories "$ADM" -d "{\"code\":\"E2E_FB$S\",\"name\":\"ტესტ-E2E ფინ. ბილინგი $S\",\"kind\":\"medical_supply\",\"billing_mode\":\"invoice\",\"markup_pct\":0}" | jq -r '.id // empty')
HOU=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E ფინ. ხელთათმანი $S\",\"category_id\":\"$(cat_id HOUSE)\",\"base_unit\":\"pair\"}" | jq -r '.id // empty')
BIL=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E ფინ. კათეტერი $S\",\"category_id\":\"$CAT\",\"base_unit\":\"piece\",\"sale_price\":5}" | jq -r '.id // empty')
[ -n "$LC" ] && [ -n "$LD" ] && [ -n "$CAT" ] && [ -n "$HOU" ] && [ -n "$BIL" ] || die "საწყობის მონაცემები ვერ შეიქმნა"
C0=$(api GET "/finance/stock/consumption?$Q" "$ADM" | jq -r '[.by_department[]|select(.department_id==null)|.cost][0] // 0')
R1=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$LC\",\"lines\":[{\"item_id\":\"$HOU\",\"qty\":100,\"lot_no\":\"H$S\",\"expires_on\":\"$D2Y\",\"price\":2,\"vat_rate\":0}]}" | jq -r '.id // empty')
R2=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$LD\",\"lines\":[{\"item_id\":\"$BIL\",\"qty\":10,\"lot_no\":\"B$S\",\"expires_on\":\"$D2Y\",\"price\":3,\"vat_rate\":0}]}" | jq -r '.id // empty')
chk "მიღება: ცენტრალური 100 × 2 ₾, ქვესაწყობი 10 × 3 ₾" "$(api POST "/stock/receipts/$R1/post" "$ADM" | jq -r .status):$(api POST "/stock/receipts/$R2/post" "$ADM" | jq -r .status)" "posted:posted"
LH=$(api GET "/stock/items/$HOU/lots" "$ADM" | jq -r '.[0].id')
T=$(api POST /stock/transfers "$ADM" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$LC\",\"to_location_id\":\"$LD\",\"lines\":[{\"lot_id\":\"$LH\",\"qty_base\":40}]}" | jq -r '.id // empty')
chk "გაცემა ცენტრალური → A: 40 (მიღება დადასტურდა)" "$(api POST "/stock/docs/$T/receive" "$ADM" -d '{"action":"receive"}' | jq -r .receive_status)" "received"
CN=$(api POST /stock/consumptions "$ADM" -d "{\"location_id\":\"$LD\",\"patient_id\":\"$P3\",\"encounter_id\":\"$E1\",\"lines\":[{\"item_id\":\"$HOU\",\"qty_base\":10},{\"item_id\":\"$BIL\",\"qty_base\":2}]}")
chk "მოხმარება A: ხელთათმანი 10 (აღრიცხვა), კათეტერი 2 (ინვოისში 2 × 5)" "$(echo "$CN" | jq -r '[.lines[]|.invoiced]|sort|join(",")')" "false,true"
W=$(api POST /stock/writeoffs "$ADM" -d "{\"location_id\":\"$LD\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E\",\"lines\":[{\"lot_id\":\"$LH\",\"qty_base\":5}]}")
[ "$(echo "$W" | jq -r '.status')" = "posted" ] || api POST "/stock/writeoffs/$(echo "$W" | jq -r .id)/decide" "$ADM" -d '{"approve":true}' >/dev/null
api POST /stock/consumptions "$ADM" -d "{\"location_id\":\"$LC\",\"patient_id\":\"$P3\",\"lines\":[{\"item_id\":\"$HOU\",\"qty_base\":3}]}" >/dev/null
ok "ჩამოწერა A: 5 (დაზიანებული); მოხმარება ცენტრალურში: 3"
chk "მარაგის ხაზი: performing = ლოკაციის განყოფილება (A)" "$(api GET "/invoices/encounter/$E1" "$ADM" | jq -r --arg a "$DA" '[.lines[]|select(.category=="supply")][0].performing_department_id==$a')" "true"
api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 47)\",\"$(uid 48)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "E1: ფინალიზაცია — 100 + 40 + 10 = 150; დაზღვევა 75, პაციენტი 75" "$(echo "$F" | jq -r '"\(.money.total):\(.money.insurance):\(.money.patient)"')" "150:75:75"

step "4. შემოსავალი"
rev() { api GET "/finance/revenue?$Q${1:-}" "${2:-$AC}"; }
R=$(rev)
row() { echo "$R" | jq -c --arg d "$1" '[.by_department[]|select(.department_id==$d)][0] // {}'; }
chk "ლაბორატორია (შემსრულებელი): 100 = დაზღვევა 30 + პაციენტი 20 + სახელმწიფო 50" "$(row "$DL" | jq -r '"\(.total):\(.insurance):\(.patient):\(.state)"')" "100:30:20:50"
chk "A: 250 = E1 150 (დაზღვევა 75 / პაციენტი 75) + E2 100 განუსაზღვრელი (დაუფინალებელი)" "$(row "$DA" | jq -r '"\(.total):\(.insurance):\(.patient):\(.undetermined)"')" "250:75:75:100"
chk "გადამხდელით: დაზღვევა 30 + 75 = 105, სახელმწიფო 50" "$(echo "$R" | jq -r --arg i "$INS" --arg s "$SSA" '"\([.by_payer[]|select(.payer_id==$i)][0].amount):\([.by_payer[]|select(.payer_id==$s)][0].amount)"')" "105:50"
R=$(rev "&dept_basis=ordering")
chk "დამნიშნავი განყოფილებით: ლაბ. შემოსავალი → B (100), ლაბორატორიას — არა" "$(row "$DB" | jq -r '.total'):$(row "$DL" | jq -r '.total // 0')" "100:0"
R=$(rev "&basis=finalized")
chk "finalized: დაუფინალებელი სტაციონარი არ ითვლება (A = 150)" "$(row "$DA" | jq -r '"\(.total):\(.undetermined)"')" "150:0"
chk "რეპორტი: სხვა პერიოდი (2000) — A არ ჩანს" "$(api GET "/finance/revenue?from=2000-01-01&to=2000-01-31" "$AC" | jq -r --arg d "$DA" '[.by_department[]|select(.department_id==$d)]|length')" "0"
chk "პერიოდი from > to → 400" "$(code GET "/finance/revenue?from=$TODAY&to=2000-01-01" "$AC")" "400"
CSVR=$(curl -s "$B/finance/csv/revenue?$Q" -H "authorization: Bearer $AC")
chk "CSV: განყოფილება A — 250.00" "$(echo "$CSVR" | grep -c "ტესტ-E2E ფინ. თერაპია $S;.*;250.00;250.00")" "1"

step "5. მარაგი"
V=$(api GET "/finance/stock/value?as_of=$TODAY" "$AC")
loc() { echo "$V" | jq -r --arg l "$1" '[.by_location[]|select(.location_id==$l)][0].value // 0'; }
chk "ღირებულება: ცენტრალური 57 × 2 = 114; ქვესაწყობი 25 × 2 + 8 × 3 = 74" "$(loc "$LC"):$(loc "$LD")" "114:74"
chk "განყოფილებით: A = 74" "$(echo "$V" | jq -r --arg d "$DA" '[.by_department[]|select(.department_id==$d)][0].value')" "74"
chk "გუშინდელი თარიღით — ჯერ არ არსებობდა (0)" "$(api GET "/finance/stock/value?as_of=$(date -d "$TODAY -1 day" +%F)" "$AC" | jq -r --arg l "$LD" '[.by_location[]|select(.location_id==$l)]|length')" "0"
C=$(api GET "/finance/stock/consumption?$Q" "$AC")
crow() { echo "$C" | jq -c --arg d "$1" '[.by_department[]|select(.department_id==$d)][0] // {}'; }
chk "consumption: A — მოხმარება 26 (20 + 6), დანაკარგი 10, ხარჯი 36" "$(crow "$DA" | jq -r '"\(.consumption):\(.loss):\(.cost)"')" "26:10:36"
chk "A: ჩაწერილი 6 (ინვოისში 10), დაუწერელი 20, გაცემა 110 (80 + 30), ქვესაწყობი 74" "$(crow "$DA" | jq -r '"\(.billed_cost):\(.billed_revenue):\(.unbilled_cost):\(.issued):\(.on_hand)"')" "6:10:20:110:74"
C1=$(echo "$C" | jq -r '[.by_department[]|select(.department_id==null)|.cost][0] // 0')
chk "საერთო (განყოფილების გარეშე): +6 (ცენტრალურის მოხმარება 3 × 2)" "$(jq -n --argjson a "$C1" --argjson b "$C0" '($a - $b)*100|round/100')" "6"
C=$(api GET "/finance/stock/consumption?$Q&basis=issue" "$AC")
chk "issue: A — ხარჯი = გაცემა 110" "$(crow "$DA" | jq -r '.cost')" "110"
chk "საფუძველი: არასწორი → 400" "$(code GET "/finance/stock/consumption?$Q&basis=x" "$AC")" "400"

step "6. განყოფილების შედეგი"
api POST /expenses "$AC" -d "{\"expense_date\":\"$TODAY\",\"category\":\"ტესტ-E2E ფინ.\",\"amount\":30,\"payment_method\":\"cash\",\"department_id\":\"$DA\"}" | jq -r .id > "$TMP/x1"
api POST /expenses "$AC" -d "{\"expense_date\":\"$TODAY\",\"category\":\"ტესტ-E2E ფინ.\",\"amount\":60,\"payment_method\":\"cash\",\"department_id\":\"$DX\"}" | jq -r .id > "$TMP/x2"
res() { api GET "/finance/dept-result?$Q$1" "${2:-$AC}"; }
D=$(res "&allocation=none")
drow() { echo "$D" | jq -c --arg d "$1" '[.rows[]|select(.department_id==$d)][0] // {}'; }
chk "A: შემოსავალი 250 − ხარჯი 30 − მარაგი 36 = 184; საწოლდღე 2" "$(drow "$DA" | jq -r '"\(.revenue_net):\(.expenses):\(.stock_cost):\(.overhead):\(.result):\(.bed_days)"')" "250:30:36:0:184:2"
chk "ლაბორატორია: 100 (ხარჯი 0)" "$(drow "$DL" | jq -r '"\(.revenue_net):\(.result)"')" "100:100"
chk "ადმინისტრაცია — სტრიქონად არა, საერთოში (ხარჯი 60)" "$(echo "$D" | jq -r --arg d "$DX" '"\([.rows[]|select(.department_id==$d)]|length):\([.pool.admin_departments[]|select(.department_id==$d)][0].expenses)"')" "0:60"
chk "none: საერთო გაუნაწილებელია (unallocated = pool)" "$(echo "$D" | jq -r '(.unallocated == .pool.total)')" "true"
fin "{\"overhead_allocation\":\"manual\",\"overhead_manual\":{\"$DA\":75,\"$DL\":25}}" >/dev/null
D=$(res "")
chk "manual (A 75%, ლაბ. 25%): ნაწილდება სრულად, A ≈ 75%" "$(echo "$D" | jq -r --arg a "$DA" --arg l "$DL" '([.rows[]|select(.department_id==$a)][0].overhead) as $x | ([.rows[]|select(.department_id==$l)][0].overhead) as $y
  | "\((($x + $y - .pool.total)|fabs) < 0.011):\(.unallocated|fabs < 0.011):\((($x - .pool.total*0.75)|fabs) < 0.011)"')" "true:true:true"
D=$(res "&allocation=revenue")
chk "revenue: სულ განაწილებული = საერთო; A-ს წილი > 0" "$(echo "$D" | jq -r --arg a "$DA" '"\((([.rows[].overhead]|add) - .pool.total + .unallocated)|fabs < 0.02):\([.rows[]|select(.department_id==$a)][0].overhead > 0)"')" "true:true"
D=$(res "&allocation=bed_days")
chk "bed_days: ლაბორატორია (საწოლდღე 0) — წილი 0" "$(echo "$D" | jq -r --arg l "$DL" '[.rows[]|select(.department_id==$l)][0].overhead')" "0"
CSVD=$(curl -s "$B/finance/csv/dept-result?$Q&allocation=none" -H "authorization: Bearer $AC")
chk "CSV (განყოფილების შედეგი): A — 184.00" "$(echo "$CSVD" | grep -c "ტესტ-E2E ფინ. თერაპია $S;250.00;0.00;250.00;30.00;36.00;0.00;184.00")" "1"

step "7. უფლებები"
chk "ხელმძღვანელობა (viewer) — შემოსავალი 200" "$(code GET "/finance/revenue?$Q" "$VW")" "200"
R=$(api GET "/finance/revenue?$Q" "$MG")
chk "მენეჯერი (A): მხოლოდ თავისი განყოფილება" "$(echo "$R" | jq -r --arg a "$DA" '"\(.scope_department|test("თერაპია")):\([.by_department[].department_id]|unique|join(",")==$a)"')" "true:true"
chk "მენეჯერი: მარაგი — მხოლოდ A-ს ლოკაციები" "$(api GET "/finance/stock/value" "$MG" | jq -r --arg l "$LD" '"\(.by_location|length):\(.by_location[0].location_id==$l)"')" "1:true"
chk "მენეჯერი: შედეგი — მხოლოდ A, საერთო არ ჩანს" "$(api GET "/finance/dept-result?$Q" "$MG" | jq -r '"\(.rows|length):\(.pool)"')" "1:null"
chk "მენეჯერი: დებიტორები / პერიოდები → 403" "$(code GET /finance/receivables "$MG"):$(code GET /finance/periods "$MG")" "403:403"
chk "მენეჯერი განყოფილების გარეშე → 403" "$(code GET "/finance/revenue?$Q" "$MG2")" "403"
fin '{"dept_finance_visible":"off"}' >/dev/null
chk "dept_finance_visible=off → მენეჯერი 403" "$(code GET "/finance/revenue?$Q" "$MG")" "403"
fin '{"dept_finance_visible":"heads"}' >/dev/null
chk "ექთანი / მიმღები → 403" "$(code GET "/finance/revenue?$Q" "$NA"):$(code GET "/finance/stock/value" "$RC")" "403:403"
api PUT /modules/finance "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → 403 (MODULE_DISABLED)" "$(api GET "/finance/revenue?$Q" "$AC" | jq -r '.code // .message.code // empty')" "MODULE_DISABLED"
api PUT /modules/finance "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "აუდიტი: INVOICE_PAYERS" "$(api GET "/audit-logs?entity_name=invoices&entity_id=$I1&limit=20" "$ADM" | jq -r '[.[].action]|index("INVOICE_PAYERS")!=null')" "true"

step "8. აღდგენა"
for x in x1 x2; do api PATCH "/expenses/$(cat "$TMP/$x")" "$AC" -d '{"void":true,"void_reason":"ტესტ-E2E გასუფთავება"}' >/dev/null; done
api POST "/inpatient/stays/$E2/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 47)\",\"$(uid 48)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
for L in "$LC" "$LD"; do
  LINES=$(api GET "/stock/balances?location_id=$L" "$ADM" | jq -c '[.rows[]|select((.qty|tonumber) > 0)|{lot_id, qty_base:(.qty|tonumber)}]')
  if [ "$LINES" != "[]" ] && [ -n "$LINES" ]; then
    WC=$(api POST /stock/writeoffs "$ADM" -d "{\"location_id\":\"$L\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":$LINES}")
    [ "$(echo "$WC" | jq -r '.status')" = "posted" ] || api POST "/stock/writeoffs/$(echo "$WC" | jq -r .id)/decide" "$ADM" -d '{"approve":true}' >/dev/null
  fi
done
chk "მარაგი ტესტის ლოკაციებზე — 0" "$(api GET "/finance/stock/value" "$AC" | jq -r --arg a "$LC" --arg b "$LD" '[.by_location[]|select(.location_id==$a or .location_id==$b)]|length')" "0"
api DELETE "/billing/bed-tariffs/$BT" "$BL" >/dev/null
for p in "$INS" "$SSA"; do api PATCH "/billing/payers/$p" "$BL" -d '{"is_active":false}' >/dev/null; done
for t in "$T_BED" "$T_SRV"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/finance "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
chk "პარამეტრები აღდგა" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="finance")|.settings' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"

[ "$SCRUB_EN" = "true" ] && curl -s -o /dev/null -X PUT "$B/modules/scrubber" -H "authorization: Bearer $ADM" -H "$J" -d '{"enabled":true,"reason":"ტესტ-E2E აღდგენა"}'
printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
