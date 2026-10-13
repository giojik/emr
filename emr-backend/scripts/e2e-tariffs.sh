#!/usr/bin/env bash
# =====================================================================
# e2e-tariffs.sh — ფინანსები, ეტაპი 0054: სატარიფო ფენა
#   0. მომზადება   1. მოდული, საბაზო ნუსხა, ძველი API   2. ნუსხები და ცვლილებები (ვადით)   3. ფასი ხაზზე (სტაც. / ამბ.), გადაფასება
#   4. საქონელი (ფასნამატი)   5. გადამხდელის წესები (ვერსია, პუნქტები, თანაგადახდა) → ფინალიზაცია → ხაზობრივი წილი
#   6. ამბულატორია: opd_payer_mode = rules   7. დამტკიცება (tariff_change_approval = required)   8. CSV   9. უფლებები   10. აღდგენა
# გამოყენება:  bash scripts/e2e-tariffs.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); TOMORROW=$(date -d "$TODAY +1 day" +%F); YESTERDAY=$(date -d "$TODAY -1 day" +%F); D2Y=$(date -d "$TODAY +2 years" +%F)

step "0. მომზადება"
dep() { api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ტარ. $2 $S\",\"code\":\"E2ET$1$S\",\"type\":\"$3\"}" | jq -r '.id // empty'; }
DA=$(dep A "ქირურგია" inpatient); DB=$(dep B "პოლიკლინიკა" outpatient)
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
R_TE=$(mkrole tte "ტარიფები" '["tariffs"]'); R_TA=$(mkrole tta "ტარიფების დამტკიცება" '["tariffs_approve"]'); R_VW=$(mkrole tvw "ხელმძღვანელობა" '["viewer"]')
[ -n "$R_TE" ] && [ -n "$R_TA" ] || die "როლები ვერ შეიქმნა (tariffs / tariffs_approve — მიგრაცია 0054?)"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.tar.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ტარ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.tar.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
TE=$(mkuser "[\"$R_TE\"]" 61); TA=$(mkuser "[\"$R_TA\"]" 62); VW=$(mkuser "[\"$R_VW\"]" 63); BL=$(mkuser '["billing"]' 64); RC=$(mkuser '["receptionist"]' 65)
NA=$(mkuser '["nurse"]' 66 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 67 ",\"department_id\":\"$DA\""); DR=$(mkuser '["doctor"]' 68 ",\"department_id\":\"$DA\"")
for t in TE TA VW BL RC NA N2 DR; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "2 განყოფილება (A — სტაც., B — ამბ.) + 8 მომხმარებელი (ტარიფები, დამტკიცება, ხელმძღვანელობა, ბილინგი, მიმღები, 2 ექთანი, ექიმი)"
payer() { api POST /billing/payers "$BL" -d "{\"code\":\"$1$S\",\"name\":\"ტესტ-E2E ტარ. $2 $S\",\"kind\":\"$3\",\"default_mode\":\"percent\",\"default_coverage_pct\":$4,\"default_deductible\":0}" | jq -r '.id // empty'; }
INS=$(payer E2ETI "დაზღვევა" insurance 50); INS2=$(payer E2ETJ "დაზღვევა-2" insurance 70); SSA=$(payer E2ETS "სახელმწიფო" state 100)
[ -n "$INS" ] && [ -n "$INS2" ] && [ -n "$SSA" ] || die "გადამხდელები ვერ შეიქმნა"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"E2ET$1$S\",\"title\":\"ტესტ-E2E ტარ. $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_SRV=$(tar SRV "გადასახვევი" 40); T_SRV2=$(tar SRVB "კონსულტაცია (გამორიცხული)" 20); T_BED=$(tar BED "საწოლდღე" 100)
BT=$(api PUT /billing/bed-tariffs "$BL" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
SVC=$(api POST /dx/catalog "$ADM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_TAR_$S\",\"name\":\"ტესტ-E2E ტარ. ანალიზი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\"}" | jq -r '.id // empty')
[ -n "$T_SRV" ] && [ -n "$T_SRV2" ] && [ -n "$T_BED" ] && [ -n "$BT" ] && [ -n "$SVC" ] || die "ტარიფები ვერ შეიქმნა"
api POST "/dx/catalog/$SVC/analytes" "$ADM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"ranges":[]}' >/dev/null
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"base_price":50}' >/dev/null
T_LAB=$(api GET "/dx/catalog/$SVC" "$ADM" | jq -r '.tariff_id // empty')
C_SRV="E2ETSRV$S"; C_SRV2="E2ETSRVB$S"
ok "ტარიფები: მომსახურება 40, გამორიცხული 20, საწოლდღე 100 (A), ლაბ. ანალიზი 50"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="tariffs")|.settings')
echo "$ORIG" | jq -e '.tariff_change_approval' >/dev/null || die "მოდული „tariffs“ ვერ მოიძებნა (მიგრაცია 0054?)"
tset() { api PUT /modules/tariffs "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }
chk "პარამეტრები: ნაგულისხმევი (off / manual / primary / auto_unpaid)" "$(tset '{"tariff_change_approval":"off","opd_payer_mode":"manual","payer_price_mode":"primary","reprice_on_payer_change":"auto_unpaid"}')" "tariffs"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ტარ-$2\",\"birth_date\":\"1970-05-05\",\"gender\":\"male\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 71 1); P2=$(mkpat 72 2); P3=$(mkpat 73 3); P4=$(mkpat 74 4); P5=$(mkpat 75 5); P6=$(mkpat 76 6)
for p in P1 P2 P3 P4 P5 P6; do [ -n "${!p}" ] || die "პაციენტი $p ვერ შეიქმნა"; done

step "1. მოდული, საბაზო ნუსხა, ძველი API"
chk "მოდული „ტარიფები“ არ ითიშება → 400" "$(code PUT /modules/tariffs "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}')" "400"
chk "უცნობი მნიშვნელობა → 400" "$(code PUT /modules/tariffs "$ADM" -d '{"settings":{"opd_payer_mode":"x"},"reason":"ტესტ-E2E"}')" "400"
BASE=$(api GET /tariff-lists "$BL" | jq -r '.[]|select(.scope=="base")|.id')
[ -n "$BASE" ] && ok "საბაზო ნუსხა არსებობს" || die "საბაზო ნუსხა ვერ მოიძებნა"
item() { api GET "/tariff-lists/$1/items?search=$2&date=${3:-$TODAY}" "$ADM" | jq -r ".items[]|select(.code==\"$2\")|${4:-.price|tonumber+0}|tostring"; }
chk "ახალი ტარიფი → საბაზო ნუსხაში (40, ვადის გარეშე)" "$(item "$BASE" "$C_SRV" "$TODAY" '"\(.price|tonumber+0):\(.valid_from)"')" "40:null"
chk "ძველი API: ფასი 45 → 200" "$(code PATCH "/tariffs/$T_SRV" "$BL" -d '{"base_price":45}')" "200"
H=$(api GET "/tariff-lists/$BASE/history/$T_SRV" "$ADM")
chk "ისტორია: 45 დღეიდან, 40 — გუშინდლამდე" "$(echo "$H" | jq -r '[.[]|"\(.price|tonumber+0):\(.valid_from):\(.valid_to)"]|join(",")')" "45:$TODAY:null,40:null:$YESTERDAY"
chk "ძველი სვეტი (service_tariffs.base_price) = 45" "$(api GET "/tariffs?search=$C_SRV" "$BL" | jq -r '.[0].base_price|tonumber+0')" "45"
chk "იმავე დღეს მეორედ (46) → ძველი ჩანაწერი „ჩანაცვლებული“" "$(api PATCH "/tariffs/$T_SRV" "$BL" -d '{"base_price":46}' >/dev/null; api GET "/tariff-lists/$BASE/history/$T_SRV" "$ADM" | jq -r '[.[]|select(.valid_from=="'$TODAY'")|"\(.price|tonumber+0):\(.superseded)"]|sort|join(",")')" "45:true,46:false"
api PATCH "/tariffs/$T_SRV" "$BL" -d '{"base_price":45}' >/dev/null

step "2. ნუსხები და ცვლილებები"
mklist() { api POST /tariff-lists "$1" -d "$2" | jq -r '.id // empty'; }
LA=$(mklist "$TE" "{\"code\":\"E2ETLA$S\",\"name\":\"ტესტ-E2E ქირურგია\",\"scope\":\"department\",\"department_id\":\"$DA\"}")
LP=$(mklist "$TE" "{\"code\":\"E2ETLP$S\",\"name\":\"ტესტ-E2E დაზღვევის ხელშეკრულება\",\"scope\":\"payer\",\"payer_id\":\"$INS\"}")
[ -n "$LA" ] && [ -n "$LP" ] && ok "ნუსხები: განყოფილება A, გადამხდელი (დაზღვევა)" || die "ნუსხები ვერ შეიქმნა"
chk "მეორე ნუსხა იმავე განყოფილებაზე → 409" "$(code POST /tariff-lists "$TE" -d "{\"code\":\"E2ETLX$S\",\"name\":\"დუბლი\",\"scope\":\"department\",\"department_id\":\"$DA\"}")" "409"
chk "„საბაზო“ ნუსხის შექმნა → 400" "$(code POST /tariff-lists "$TE" -d "{\"code\":\"E2ETLB$S\",\"name\":\"მეორე საბაზო\",\"scope\":\"base\"}")" "400"
chk "საბაზო ნუსხის გათიშვა → 400" "$(code PATCH "/tariff-lists/$BASE" "$ADM" -d '{"is_active":false}')" "400"
chg() { api POST /tariff-changes "$1" -d "$2"; }
it() { echo "{\"list_id\":\"$1\",\"kind\":\"${4:-tariff}\",\"ref\":\"$2\",\"action\":\"set\",\"${5:-price}\":$3,\"valid_from\":\"${6:-$TODAY}\"}"; }
C1=$(chg "$TE" "{\"title\":\"ტესტ-E2E ხელშეკრულება\",\"reason\":\"ტესტ-E2E ფასები\",\"items\":[$(it "$LA" "$T_SRV" 50),$(it "$LP" "$T_SRV" 35),$(it "$LP" "$T_BED" 80)]}")
chk "ცვლილება (დამტკიცების გარეშე) → მაშინვე გატარდა" "$(echo "$C1" | jq -r '"\(.status):\(.change_no|test("^TC[0-9]{2}-[0-9]{6}$"))"')" "applied:true"
chk "გუშინდელი თარიღით → 400" "$(code POST /tariff-changes "$TE" -d "{\"title\":\"ტესტ-E2E\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV" 51 tariff price "$YESTERDAY")]}")" "400"
chk "საბაზოდან მომსახურების „დასრულება“ → 400" "$(code POST /tariff-changes "$TE" -d "{\"title\":\"ტესტ-E2E\",\"reason\":\"ტესტ-E2E\",\"items\":[{\"list_id\":\"$BASE\",\"kind\":\"tariff\",\"ref\":\"$T_SRV\",\"action\":\"end\",\"valid_from\":\"$TODAY\"}]}")" "400"
chk "ფასის გარეშე „set“ → 400" "$(code POST /tariff-changes "$TE" -d "{\"title\":\"ტესტ-E2E\",\"reason\":\"ტესტ-E2E\",\"items\":[{\"list_id\":\"$LA\",\"kind\":\"tariff\",\"ref\":\"$T_SRV\",\"action\":\"set\",\"valid_from\":\"$TODAY\"}]}")" "400"
chg "$TE" "{\"title\":\"ტესტ-E2E ხვალიდან\",\"reason\":\"ტესტ-E2E ინდექსაცია\",\"items\":[$(it "$BASE" "$T_SRV" 60 tariff price "$TOMORROW")]}" >/dev/null
chk "ნუსხა A: 50 (საბაზო 45 შედარებისთვის)" "$(item "$LA" "$C_SRV" "$TODAY" '"\(.price|tonumber+0):\(.base_price|tonumber+0)"')" "50:45"
chk "საბაზო: დღეს 45, „შემდეგი“ — 60 ხვალიდან" "$(item "$BASE" "$C_SRV" "$TODAY" '"\(.price|tonumber+0):\(.next.price|tonumber+0):\(.next.valid_from)"')" "45:60:$TOMORROW"
chk "საბაზო ხვალ — 60" "$(item "$BASE" "$C_SRV" "$TOMORROW")" "60"
q() { api GET "/tariff-quote?tariff_id=$T_SRV&$1" "$RC" | jq -r '"\(.chosen.scope):\(.chosen.price|tonumber+0)"'; }
chk "ფასის შემოწმება: A + დაზღვევა → გადამხდელი 35" "$(q "date=$TODAY&department_id=$DA&payer_id=$INS")" "payer:35"
chk "ფასის შემოწმება: A → განყოფილება 50" "$(q "date=$TODAY&department_id=$DA")" "department:50"
chk "ფასის შემოწმება: B → საბაზო 45; ხვალ — 60" "$(q "date=$TODAY&department_id=$DB"),$(q "date=$TOMORROW&department_id=$DB")" "base:45,base:60"

step "3. ფასი ხაზზე, გადაფასება"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 68)\",\"source\":\"direct\",\"icd10_code\":\"${2:-K35.8}\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); [ -n "$E1" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
L1=$(api POST "/inpatient/stays/$E1/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":2}")
chk "სტაც. A: მომსახურება → განყოფილების ფასი 50 × 2" "$(echo "$L1" | jq -r '"\(.unit_price|tonumber+0):\(.line_total|tonumber+0)"')" "50:100"
I1=$(api GET "/invoices/encounter/$E1" "$BL" | jq -r .id)
chk "ხაზის ფასის წყარო — განყოფილება" "$(api GET "/invoices/encounter/$E1" "$BL" | jq -r --arg l "$(echo "$L1" | jq -r .id)" '.lines[]|select(.id==$l)|.price_scope')" "department"
api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"policy_no\":\"POL-T$S\"}" >/dev/null
V=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "გადამხდელი დაემატა → ხელშეკრულების ფასი: მომსახურება 35, საწოლდღე 80" "$(echo "$V" | jq -r '[.lines[]|select(.category=="service" or .category=="bed")|"\(.category):\(.unit_price|tonumber+0)"]|sort|join(",")')" "bed:80,service:35"
chk "საწოლდღის დღე — 80 (stay_bed_days)" "$(echo "$V" | jq -r '.bed_days[0].price|tonumber+0')" "80"
chk "გადაფასების ჟურნალი: 1 (გადამხდელის ცვლილება)" "$(api GET "/invoices/$I1/reprices" "$BL" | jq -r '"\(length):\(.[0].kind):\(.[0].old_price|tonumber+0)→\(.[0].new_price|tonumber+0)"')" "1:payer_change:50→35"
api POST "/inpatient/stay-payers/$(echo "$V" | jq -r '.payers[0].id')/cancel" "$RC" -d '{"reason":"ტესტ-E2E გაუქმება"}' >/dev/null
chk "გადამხდელი გაუქმდა → ისევ განყოფილების ფასი 50, საწოლდღე 100" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '[.lines[]|select(.category=="service" or .category=="bed")|"\(.category):\(.unit_price|tonumber+0)"]|sort|join(",")')" "bed:100,service:50"
api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"policy_no\":\"POL-T$S\"}" >/dev/null
api GET "/inpatient/stays/$E1/billing" "$BL" >/dev/null
labvisit() { api POST /lab-visits "$RC" -d "{\"patient_id\":\"$1\",\"items\":[{\"service_id\":\"$SVC\"}],\"department_id\":\"$DB\"}" | jq -r '.encounter_id // empty'; }
V2=$(labvisit "$P2"); I2=$(api GET "/invoices/encounter/$V2" "$RC" | jq -r .id)
chk "ამბ. B: ლაბ. ანალიზი — საბაზო 50" "$(api GET "/invoices/encounter/$V2" "$RC" | jq -r '.lines[0]|"\(.unit_price|tonumber+0):\(.price_scope)"')" "50:base"
chg "$TE" "{\"title\":\"ტესტ-E2E ლაბ.\",\"reason\":\"ტესტ-E2E ხელშეკრულება\",\"items\":[$(it "$LP" "$T_LAB" 30)]}" >/dev/null
R=$(api PUT "/invoices/$I2/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS\"}")
chk "გადამხდელი (დაზღვევა) → ავტომატური გადაფასება 50 → 30" "$(echo "$R" | jq -r '"\(.repriced|length):\(.total_amount|tonumber+0)"')" "1:30"
api PUT "/invoices/$I2/payers" "$RC" -d '{"insurance_payer_id":null}' >/dev/null
chk "გადამხდელი მოიხსნა → საბაზო 50" "$(api GET "/invoices/encounter/$V2" "$RC" | jq -r '.total_amount|tonumber+0')" "50"
tset '{"reprice_on_payer_change":"manual"}' >/dev/null
chk "reprice_on_payer_change = manual: გადამხდელი → ფასი უცვლელი (50)" "$(api PUT "/invoices/$I2/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS\"}" | jq -r '"\(.repriced|length):\(.total_amount|tonumber+0)"')" "0:50"
chk "გადაფასება მიზეზის გარეშე → 400" "$(code POST "/invoices/$I2/reprice" "$BL" -d '{}')" "400"
chk "გადაფასება — მიმღები 403, ექთანი 403" "$(code POST "/invoices/$I2/reprice" "$RC" -d '{"reason":"ტესტ-E2E"}'):$(code POST "/invoices/$I2/reprice" "$NA" -d '{"reason":"ტესტ-E2E"}')" "403:403"
R=$(api POST "/invoices/$I2/reprice" "$BL" -d '{"reason":"ტესტ-E2E ხელშეკრულების ფასი"}')
chk "ბილინგი: გადაფასება → 30 (1 ხაზი)" "$(echo "$R" | jq -r '"\(.changed|length):\(.invoice.total_amount|tonumber+0)"')" "1:30"
chk "მეორედ — ცვლილება არ არის" "$(api POST "/invoices/$I2/reprice" "$BL" -d '{"reason":"ტესტ-E2E"}' | jq -r '.changed|length')" "0"
tset '{"reprice_on_payer_change":"auto_unpaid"}' >/dev/null
api POST "/encounters/$V2/pay-initial" "$RC" -d '{"amount":30,"method":"cash"}' >/dev/null
chg "$TE" "{\"title\":\"ტესტ-E2E ლაბ. 20\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LP" "$T_LAB" 20)]}" >/dev/null
chk "გადახდილი 30 → გადაფასება 20-ზე (პაციენტის წილი < გადახდილი) → 400" "$(code POST "/invoices/$I2/reprice" "$BL" -d '{"reason":"ტესტ-E2E"}')" "400"
chk "ფასი უცვლელი (30)" "$(api GET "/invoices/encounter/$V2" "$RC" | jq -r '.total_amount|tonumber+0')" "30"
V3=$(labvisit "$P3"); I3=$(api GET "/invoices/encounter/$V3" "$RC" | jq -r .id)
api POST "/encounters/$V3/pay-initial" "$RC" -d '{"amount":50,"method":"cash"}' >/dev/null
chk "auto_unpaid: გადახდის შემდეგ გადამხდელი → ფასი უცვლელი (50)" "$(api PUT "/invoices/$I3/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS\"}" | jq -r '"\(.repriced|length):\(.total_amount|tonumber+0)"')" "0:50"

step "4. საქონელი (ფასნამატი)"
LD=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2E_TD_$S\",\"name\":\"ტესტ-E2E ტარ. ქვესაწყობი A $S\",\"kind\":\"department\",\"department_id\":\"$DA\",\"requires_approval\":false}" | jq -r '.id // empty')
CAT=$(api POST /stock/categories "$ADM" -d "{\"code\":\"E2E_TB$S\",\"name\":\"ტესტ-E2E ტარ. ბილინგი $S\",\"kind\":\"medical_supply\",\"billing_mode\":\"invoice\",\"markup_pct\":20}" | jq -r '.id // empty')
BIL=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E ტარ. კათეტერი $S\",\"category_id\":\"$CAT\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
[ -n "$LD" ] && [ -n "$CAT" ] && [ -n "$BIL" ] || die "საწყობის მონაცემები ვერ შეიქმნა"
chk "კატეგორიის ფასნამატი → საბაზო ნუსხაში (20%)" "$(api GET "/tariff-lists/$BASE/items?kind=stock_category&search=E2E_TB$S" "$ADM" | jq -r '.items[0].markup_pct|tonumber+0')" "20"
RCP=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$LD\",\"lines\":[{\"item_id\":\"$BIL\",\"qty\":5,\"lot_no\":\"T$S\",\"expires_on\":\"$D2Y\",\"price\":10,\"vat_rate\":0}]}" | jq -r '.id // empty')
api POST "/stock/receipts/$RCP/post" "$ADM" >/dev/null
cons() { api POST /stock/consumptions "$ADM" -d "{\"location_id\":\"$LD\",\"patient_id\":\"$P1\",\"encounter_id\":\"$E1\",\"lines\":[{\"item_id\":\"$BIL\",\"qty_base\":1}]}" >/dev/null; }
cons
chk "ხარჯი პაციენტზე: თვითღირებულება 10 + 20% → 12" "$(api GET "/invoices/encounter/$E1" "$BL" | jq -r '[.lines[]|select(.category=="supply")|.unit_price|tonumber+0]|join(",")')" "12"
chg "$TE" "{\"title\":\"ტესტ-E2E ფასნამატი A\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$CAT" 50 stock_category markup_pct)]}" >/dev/null
cons
chk "განყოფილება A: ფასნამატი 50% → 15 (პირველი ხაზი — უცვლელი 12)" "$(api GET "/invoices/encounter/$E1" "$BL" | jq -r '[.lines[]|select(.category=="supply")|.unit_price|tonumber+0]|sort|join(",")')" "12,15"
chg "$TE" "{\"title\":\"ტესტ-E2E საქონლის ფასი\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LP" "$BIL" 9 stock_item)]}" >/dev/null
cons
chk "გადამხდელის ნუსხა: საქონლის ფასი 9 (ფასნამატზე მაღლა)" "$(api GET "/invoices/encounter/$E1" "$BL" | jq -r '[.lines[]|select(.category=="supply")|.unit_price|tonumber+0]|sort|join(",")')" "9,12,15"

step "5. გადამხდელის წესები (ვერსიები)"
PR=$(api GET "/payer-rules/$INS" "$TE")
chk "ვერსია 1 (ნაგულისხმევიდან, ვადის გარეშე)" "$(echo "$PR" | jq -r '[.versions[]|"\(.version_no):\(.status):\(.valid_from)"]|join(",")')" "1:active:null"
api PATCH "/billing/payers/$INS" "$BL" -d '{"default_coverage_pct":60}' >/dev/null
chk "ძველი API: % 60 → ვერსია 2 დღეიდან" "$(api GET "/payer-rules/$INS" "$TE" | jq -r '[.versions[]|"\(.version_no):\(.coverage_pct|tonumber+0):\(.valid_from)"]|join(",")')" "2:60:$TODAY,1:50:null"
VER='{"valid_from":"'$TODAY'","mode":"percent","coverage_pct":80,"copay_amount":5,"excluded_codes":["'$C_SRV2'"],
  "clauses":[{"seq":1,"label":"ლაბორატორია — არა","categories":["lab"],"effect":"exclude"},
             {"seq":2,"label":"პნევმონია — 100%","categories":["service"],"codes":["'$C_SRV'"],"dx_prefixes":["J18"],"effect":"cover","coverage_pct":100},
             {"seq":3,"label":"60+","age_min":60,"effect":"exclude"}],"reason":"ტესტ-E2E ახალი ხელშეკრულება"}'
chk "ვერსია: უცნობი კოდი → 400" "$(code POST "/payer-rules/$INS/versions" "$TE" -d "$(echo "$VER" | jq -c '.excluded_codes=["NOPE_XX"]')")" "400"
chk "ვერსია: გუშინდელი თარიღით → 400" "$(code POST "/payer-rules/$INS/versions" "$TE" -d "$(echo "$VER" | jq -c --arg d "$YESTERDAY" '.valid_from=$d')")" "400"
chk "ვერსია: „დაფარვა“ % / ლიმიტის გარეშე → 400" "$(code POST "/payer-rules/$INS/versions" "$TE" -d "$(echo "$VER" | jq -c '.clauses[1].coverage_pct=null')")" "400"
R=$(api POST "/payer-rules/$INS/versions" "$TE" -d "$VER")
chk "ვერსია 3 (80%, თანაგადახდა 5, 3 პუნქტი) → აქტიური; იმავე დღის ვერსია 2 — ჩანაცვლდა" "$(echo "$R" | jq -r '"\(.version_no):\(.status)"'):$(api GET "/payer-rules/$INS" "$TE" | jq -r '[.versions[]|select(.version_no==2)|.status][0]')" "3:active:rejected"
chk "payers.default_* (ძველი ეკრანი) = ვერსია 3" "$(api GET /billing/payers "$BL" | jq -r --arg p "$INS" '.[]|select(.id==$p)|.default_coverage_pct|tonumber+0')" "80"
E2=$(ADMIT "$P5" J18.9); [ -n "$E2" ] || die "ჰოსპიტალიზაცია E2 ვერ მოხერხდა"
api POST "/inpatient/stays/$E2/services" "$BL" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" >/dev/null
api POST "/inpatient/stays/$E2/services" "$BL" -d "{\"tariff_id\":\"$T_SRV2\",\"quantity\":1}" >/dev/null
SP2=$(api POST "/inpatient/stays/$E2/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"policy_no\":\"POL-U$S\"}")
chk "ჰოსპიტალიზაციის გადამხდელი: პირობები ვერსია 3-იდან (80%)" "$(echo "$SP2" | jq -r '"\(.coverage_pct|tonumber+0):\(.rule_version_id!=null)"')" "80:true"
V=$(api GET "/inpatient/stays/$E2/billing" "$BL")
chk "ხაზები: საწოლდღე 80, მომსახურება 35 (ხელშეკრ.), გამორიცხული 20" "$(echo "$V" | jq -r '[.lines[]|.unit_price|tonumber+0]|sort|join(",")')" "20,35,80"
# საწოლდღე 80 × 80% = 64; მომსახურება J18 (პუნქტი 2) 100% = 35; კოდი გამორიცხული — 0; ჯამი 99 − თანაგადახდა 5 = 94; პაციენტი 135 − 94 = 41
chk "წესები: დაზღვევა 94 (64 + 35 − 5), პაციენტი 41" "$(echo "$V" | jq -r '"\(.payers[0].calc.amount):\(.payers[0].calc.copay):\(.money.patient|tonumber+0)"')" "94:5:41"
api POST "/inpatient/stays/$E2/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 66)\",\"$(uid 67)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
F=$(api POST "/inpatient/stays/$E2/billing/finalize" "$BL")
chk "ფინალიზაცია: 135 / დაზღვევა 94 / პაციენტი 41" "$(echo "$F" | jq -r '"\(.money.total):\(.money.insurance):\(.money.patient)"')" "135:94:41"
INV2=$(api GET "/invoices/encounter/$E2" "$BL")
chk "ხაზობრივი წილი: დაზღვევა Σ 94, პაციენტი Σ 41, გამორიცხულ კოდზე — მხოლოდ პაციენტი" \
  "$(echo "$INV2" | jq -r --arg c "$T_SRV2" '"\([.lines[].shares[]|select(.kind=="insurance")|.amount|tonumber+0]|add*100|round/100):\([.lines[].shares[]|select(.kind=="patient")|.amount|tonumber+0]|add*100|round/100):\([.lines[]|select(.tariff_id==$c)|.shares[]|.kind]|join(","))"')" "94:41:patient"
RV=$(api GET "/finance/revenue?from=$TODAY&to=$TODAY" "$ADM")
chk "შემოსავალი გადამხდელით (ხაზობრივი წილით): დაზღვევა 94" "$(echo "$RV" | jq -r --arg p "$INS" '[.by_payer[]|select(.payer_id==$p)|.amount]|add // 0')" "94"
chk "გახსნა → ხაზობრივი წილი იშლება" "$(api POST "/inpatient/stays/$E2/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E გახსნა"}' >/dev/null; api GET "/invoices/encounter/$E2" "$BL" | jq -r '[.lines[].shares[]]|length')" "0"
api POST "/inpatient/stays/$E2/billing/finalize" "$BL" >/dev/null
VQ=$(api GET "/tariff-quote?tariff_id=$T_SRV&payer_id=$INS&date=$TODAY&age=56&sex=male&dx=J18.9" "$TE")
chk "ფასის შემოწმება + დაფარვა: პუნქტი 2 (100%)" "$(echo "$VQ" | jq -r '"\(.coverage.clause.seq):\(.coverage.pct|tonumber+0)"')" "2:100"
chk "ფასის შემოწმება: 65 წლის — პუნქტი 3 (გამორიცხვა)" "$(api GET "/tariff-quote?tariff_id=$T_SRV2&payer_id=$INS&date=$TODAY&age=65" "$TE" | jq -r '"\(.coverage.clause.seq):\(.coverage.covered)"')" "3:false"

step "6. ამბულატორია: opd_payer_mode = rules"
api POST "/payer-rules/$INS2/versions" "$TE" -d '{"valid_from":"'$TODAY'","mode":"percent","coverage_pct":70,"copay_amount":3,"reason":"ტესტ-E2E თანაგადახდა"}' >/dev/null
tset '{"opd_payer_mode":"rules"}' >/dev/null
V6=$(labvisit "$P6"); I6=$(api GET "/invoices/encounter/$V6" "$RC" | jq -r .id)
R=$(api PUT "/invoices/$I6/payers" "$RC" -d "{\"insurance_payer_id\":\"$INS2\"}")
chk "მიმღები: გადამხდელი → წილი წესებით: 50 × 70% − 3 = 32, პაციენტი 18" "$(echo "$R" | jq -r '"\(.mode):\(.insurance_share|tonumber+0):\(.patient_share|tonumber+0)"')" "rules:32:18"
chk "მიმღები: წილის ხელით შეცვლა → 403" "$(code PUT "/invoices/$I6/payers" "$RC" -d '{"insurance_share":40}')" "403"
chk "ბილინგი: ხელით — მიზეზის გარეშე → 400" "$(code PUT "/invoices/$I6/payers" "$BL" -d '{"insurance_share":40}')" "400"
chk "ბილინგი: ხელით 40, მიზეზით → rules_manual" "$(api PUT "/invoices/$I6/payers" "$BL" -d '{"insurance_share":40,"reason":"ტესტ-E2E საგარანტიო წერილი"}' | jq -r '"\(.mode):\(.insurance_share|tonumber+0):\(.payer_shares_manual)"')" "rules_manual:40:true"
LN6=$(api GET "/invoices/encounter/$V6" "$BL" | jq -r '.lines[0].id')
api PATCH "/invoices/$I6/lines/$LN6" "$BL" -d '{"unit_price":60}' >/dev/null
chk "ხელით შესწორებული — ხაზის ცვლილება წილს არ ცვლის (40)" "$(api GET "/invoices/encounter/$V6" "$RC" | jq -r '.insurance_share|tonumber+0')" "40"
chk "„წესებით აღდგენა“ → 60 × 70% − 3 = 39" "$(api PUT "/invoices/$I6/payers" "$RC" -d '{"recalc":true}' | jq -r '"\(.insurance_share|tonumber+0):\(.payer_shares_manual)"')" "39:false"
api PATCH "/invoices/$I6/lines/$LN6" "$BL" -d '{"unit_price":70}' >/dev/null
chk "ხაზი 70 → გადასათვლელი; ნახვისას — 70 × 70% − 3 = 46" "$(api GET "/invoices/encounter/$V6" "$RC" | jq -r '"\(.insurance_share|tonumber+0):\(.payer_shares_stale)"')" "46:false"
chk "წინასწარი გაანგარიშება (preview)" "$(api GET "/invoices/$I6/payers/preview" "$RC" | jq -r '.result.payers[0].amount')" "46"
chk "ხაზობრივი წილი (ამბ.): დაზღვევა 46 + პაციენტი 24" "$(api GET "/invoices/encounter/$V6" "$BL" | jq -r '[.lines[0].shares[]|"\(.kind):\(.amount|tonumber+0)"]|sort|join(",")')" "insurance:46,patient:24"
chk "შემოსავალი გადამხდელით: დაზღვევა-2 — 46" "$(api GET "/finance/revenue?from=$TODAY&to=$TODAY" "$ADM" | jq -r --arg p "$INS2" '[.by_payer[]|select(.payer_id==$p)|.amount]|add // 0')" "46"
api POST "/encounters/$V6/pay-initial" "$RC" -d '{"amount":24,"method":"cash"}' >/dev/null
chk "გადახდა 24 → paid" "$(api GET "/invoices/encounter/$V6" "$RC" | jq -r '.paid_status')" "paid"
tset '{"opd_payer_mode":"manual"}' >/dev/null
chk "manual რეჟიმი: წილი ხელით (მიმღები) — როგორც 0053-ში" "$(api PUT "/invoices/$I3/payers" "$RC" -d '{"insurance_share":0}' | jq -r '.mode')" "manual"

step "7. დამტკიცება (tariff_change_approval = required)"
tset '{"tariff_change_approval":"required"}' >/dev/null
chk "ძველი API: ფასის პირდაპირი ცვლილება → 409" "$(code PATCH "/tariffs/$T_SRV" "$BL" -d '{"base_price":70}')" "409"
chk "ძველი API: სახელის ცვლილება — 200" "$(code PATCH "/tariffs/$T_SRV" "$BL" -d "{\"title\":\"ტესტ-E2E ტარ. გადასახვევი (განახლ.)\"}")" "200"
chk "ძველი API: გადამხდელის % → 409" "$(code PATCH "/billing/payers/$INS2" "$BL" -d '{"default_coverage_pct":90}')" "409"
C2=$(chg "$TE" "{\"title\":\"ტესტ-E2E დასამტკიცებელი\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV" 55)]}")
C2ID=$(echo "$C2" | jq -r .id); C2NO=$(echo "$C2" | jq -r .change_no)
chk "ცვლილება → „დასამტკიცებელი“, ფასი ჯერ უცვლელი (50)" "$(echo "$C2" | jq -r .status):$(item "$LA" "$C_SRV")" "pending:50"
chk "დამმტკიცებელს — შეტყობინება" "$(api GET /notifications "$TA" | jq -r "[.[]|select(.kind==\"tariff_change\" and (.title|contains(\"$C2NO\")))]|length")" "1"
chk "ავტორი (tariffs) ვერ ამტკიცებს → 403" "$(code POST "/tariff-changes/$C2ID/approve" "$TE" -d '{}')" "403"
chk "დამტკიცება → გატარდა, ფასი 55" "$(api POST "/tariff-changes/$C2ID/approve" "$TA" -d '{}' | jq -r .status):$(item "$LA" "$C_SRV")" "applied:55"
chk "ავტორს — შეტყობინება „დამტკიცდა“" "$(api GET /notifications "$TE" | jq -r "[.[]|select(.kind==\"tariff_change_done\" and (.title|contains(\"$C2NO\")))]|length")" "1"
chk "მეორედ დამტკიცება → 409" "$(code POST "/tariff-changes/$C2ID/approve" "$TA" -d '{}')" "409"
chk "დამმტკიცებელი (მხოლოდ tariffs_approve) ცვლილებას ვერ ქმნის → 403" "$(code POST /tariff-changes "$TA" -d "{\"title\":\"ტესტ-E2E\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV" 57)]}")" "403"
CA=$(chg "$ADM" "{\"title\":\"ტესტ-E2E admin\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV" 58)]}" | jq -r '.id // empty')
chk "admin-საც კი: საკუთარი ცვლილება — 403 (მეორე პირი)" "$(code POST "/tariff-changes/$CA/approve" "$ADM" -d '{}')" "403"
C4=$(chg "$TE" "{\"title\":\"ტესტ-E2E უარყოფა\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV" 99)]}"); C4ID=$(echo "$C4" | jq -r .id)
chk "უარყოფა მიზეზის გარეშე → 400" "$(code POST "/tariff-changes/$C4ID/reject" "$TA" -d '{}')" "400"
chk "უარყოფა მიზეზით → rejected; ფასი 55" "$(api POST "/tariff-changes/$C4ID/reject" "$TA" -d '{"note":"ტესტ-E2E ძალიან მაღალია"}' | jq -r .status):$(item "$LA" "$C_SRV")" "rejected:55"
C5ID=$(chg "$TE" "{\"title\":\"ტესტ-E2E გაუქმება\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV" 98)]}" | jq -r .id)
chk "გაუქმება — სხვისი (ბილინგი) → 403; ავტორი → cancelled" "$(code POST "/tariff-changes/$C5ID/cancel" "$BL" -d '{"note":"ტესტ-E2E"}'):$(api POST "/tariff-changes/$C5ID/cancel" "$TE" -d '{"note":"ტესტ-E2E აღარ არის საჭირო"}' | jq -r .status)" "403:cancelled"
VR=$(api POST "/payer-rules/$INS2/versions" "$TE" -d '{"valid_from":"'$TOMORROW'","mode":"percent","coverage_pct":90,"reason":"ტესტ-E2E ხვალიდან"}')
chk "წესის ვერსია → pending; დამტკიცება → active (ხვალიდან)" "$(echo "$VR" | jq -r .status):$(api POST "/tariff-changes/$(api GET "/tariff-changes?status=pending" "$TA" | jq -r --arg n "$(echo "$VR" | jq -r .change_no)" '.[]|select(.change_no==$n)|.id')/approve" "$TA" -d '{}' | jq -r .status)" "pending:applied"
chk "დღეს — ძველი ვერსია (70%); payers.default_* — 70" "$(api GET "/payer-rules/$INS2" "$TE" | jq -r '. as $r|.versions[]|select(.id==$r.current_version_id)|.coverage_pct|tonumber+0'):$(api GET /billing/payers "$BL" | jq -r --arg p "$INS2" '.[]|select(.id==$p)|.default_coverage_pct|tonumber+0')" "70:70"
chk "ცვლილებების სია: დასამტკიცებელი — 1 (admin-ის)" "$(api GET "/tariff-changes?status=pending" "$TA" | jq -r '[.[]|select(.title|startswith("ტესტ-E2E"))]|length')" "1"
api POST "/tariff-changes/$CA/cancel" "$ADM" -d '{"note":"ტესტ-E2E გასუფთავება"}' >/dev/null
tset '{"tariff_change_approval":"off"}' >/dev/null

step "8. CSV"
CSV=$(curl -s "$B/tariff-lists/$LA/csv" -H "authorization: Bearer $TE")
chk "ექსპორტი: ნუსხა A — მომსახურება 55" "$(echo "$CSV" | grep -c "^tariff;$C_SRV;.*;55.00;")" "1"
chk "იმპორტი: უცნობი კოდი → 400 (შეცდომების სიით)" "$(api POST /tariff-changes/import "$TE" -d "$(jq -nc --arg l "$LA" --arg d "$TOMORROW" --arg c "code;price
$C_SRV;61
NOPE_$S;5" '{list_id:$l,valid_from:$d,title:"ტესტ-E2E CSV",reason:"ტესტ-E2E",csv:$c}')" | jq -r '.errors|length')" "1"
R=$(api POST /tariff-changes/import "$TE" -d "$(jq -nc --arg l "$LA" --arg d "$TOMORROW" --arg c "kind;code;price
tariff;$C_SRV;61
tariff;$C_SRV2;
stock_category;E2E_TB$S;40" '{list_id:$l,valid_from:$d,title:"ტესტ-E2E CSV",reason:"ტესტ-E2E",csv:$c}')")
chk "იმპორტი: 3 ჩანაწერი (ფასი, დასრულება, ფასნამატი) → გატარდა" "$(echo "$R" | jq -r '"\(.status):\(.source)"')" "applied:csv"
chk "ნუსხა A ხვალ: მომსახურება 61, ფასნამატი 40; დღეს — 55" "$(item "$LA" "$C_SRV" "$TOMORROW"):$(api GET "/tariff-lists/$LA/items?kind=stock_category&date=$TOMORROW&search=E2E_TB$S" "$ADM" | jq -r '.items[0].markup_pct|tonumber+0'):$(item "$LA" "$C_SRV")" "61:40:55"

step "9. უფლებები"
chk "ხელმძღვანელობა: ნუსხები / ცვლილებები — 200; ცვლილება — 403" "$(code GET /tariff-lists "$VW"):$(code GET /tariff-changes "$VW"):$(code POST /tariff-changes "$VW" -d '{}')" "200:200:403"
chk "ექთანი: ნუსხები — 403" "$(code GET /tariff-lists "$NA")" "403"
chk "მიმღები: ფასის შემოწმება — 200, ნუსხის შექმნა — 403" "$(code GET "/tariff-quote?tariff_id=$T_SRV" "$RC"):$(code POST /tariff-lists "$RC" -d '{}')" "200:403"
chk "ბილინგი: ცვლილება — 200 (როგორც ძველი ტარიფები); დამტკიცება — 403" "$(chg "$BL" "{\"title\":\"ტესტ-E2E ბილინგი\",\"reason\":\"ტესტ-E2E\",\"items\":[$(it "$LA" "$T_SRV2" 21)]}" | jq -r .status):$(code POST "/tariff-changes/$C4ID/approve" "$BL" -d '{}')" "applied:403"
chk "აუდიტი: ცვლილება (TARIFF_CHANGE_APPLY), გადაფასება (INVOICE_REPRICE)" "$(api GET "/audit-logs?entity_name=tariff_changes&entity_id=$C2ID&limit=20" "$ADM" | jq -r '[.[].action]|index("TARIFF_CHANGE_APPLY")!=null'):$(api GET "/audit-logs?entity_name=invoices&entity_id=$I2&limit=20" "$ADM" | jq -r '[.[].action]|index("INVOICE_REPRICE")!=null')" "true:true"

step "10. აღდგენა"
api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 66)\",\"$(uid 67)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
LINES=$(api GET "/stock/balances?location_id=$LD" "$ADM" | jq -c '[.rows[]|select((.qty|tonumber+0) > 0)|{lot_id, qty_base:(.qty|tonumber+0)}]')
if [ "$LINES" != "[]" ] && [ -n "$LINES" ]; then
  WC=$(api POST /stock/writeoffs "$ADM" -d "{\"location_id\":\"$LD\",\"writeoff_reason\":\"other\",\"notes\":\"ტესტ-E2E: გასუფთავება\",\"lines\":$LINES}")
  [ "$(echo "$WC" | jq -r '.status')" = "posted" ] || api POST "/stock/writeoffs/$(echo "$WC" | jq -r .id)/decide" "$ADM" -d '{"approve":true}' >/dev/null
fi
for x in "$LA" "$LP"; do api PATCH "/tariff-lists/$x" "$TE" -d '{"is_active":false}' >/dev/null; done
chk "ნუსხები გაითიშა" "$(api GET /tariff-lists "$TE" | jq -r --arg a "$LA" --arg b "$LP" '[.[]|select((.id==$a or .id==$b) and .is_active)]|length')" "0"
api DELETE "/billing/bed-tariffs/$BT" "$BL" >/dev/null
for p in "$INS" "$INS2" "$SSA"; do api PATCH "/billing/payers/$p" "$BL" -d '{"is_active":false}' >/dev/null; done
for t in "$T_SRV" "$T_SRV2" "$T_BED"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/tariffs "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
chk "პარამეტრები აღდგა" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="tariffs")|.settings' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
