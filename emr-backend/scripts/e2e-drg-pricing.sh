#!/usr/bin/env bash
# =====================================================================
# e2e-drg-pricing.sh — DRG ბლოკი, ეტაპი 0056: თანხის ფორმულა
#   0. მომზადება   1. ვერსია პაკეტიდან (კომპონენტებით), ვალიდაცია, CRUD, რიგი, დაბლოკვა   2. ტესტი: თითო კომპონენტი
#   3. შემთხვევა: თანხა გადამხდელზე (კოეფ. + მოკლე დაყოვნება → + ძვირი შემთხვევა) → დადასტურება → ფინალიზაცია (დაფიქსირება)
#   4. დაფიქსირება / გახსნა / მოდული გამორთული (0046: წონა × განაკვეთი)   5. რეესტრი, PDF   6. აღდგენა
# გამოყენება:  bash scripts/e2e-drg-pricing.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); PAST=$(date -d "$TODAY -30 days" +%F)

step "0. მომზადება"
DCODE="E2EDP$S"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E DRG ფასი $S\",\"code\":\"$DCODE\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] || die "განყოფილება ვერ შეიქმნა"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"$1\",\"title\":\"ტესტ-E2E DRG ფასი $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_BED=$(tar "E2EDPBED$S" "საწოლდღე" 100); T_EXP=$(tar "E2EDPEXP$S" "ძვირი მომსახურება" 5000)
[ -n "$T_BED" ] && [ -n "$T_EXP" ] || die "ტარიფები ვერ შეიქმნა"
BT=$(api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty'); [ -n "$id" ] && echo "e2e_$1_$S"; }
R_CD=$(mkrole pcd "DRG კოდირება" '["drg"]'); R_DA=$(mkrole pad "DRG კონფიგურაცია" '["drg_admin"]')
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.drp.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"DRP-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.drp.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
CD=$(mkuser "[\"$R_CD\"]" 51); DA1=$(mkuser "[\"$R_DA\"]" 52); BL=$(mkuser '["billing"]' 53); RC=$(mkuser '["receptionist"]' 54)
DR=$(mkuser '["doctor"]' 55 ",\"department_id\":\"$DA\""); NA=$(mkuser '["nurse"]' 56 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 57 ",\"department_id\":\"$DA\"")
for t in CD DA1 BL RC DR NA N2; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"58$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"DRP-1\",\"birth_date\":\"1960-02-02\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] || die "პაციენტი ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="drg")|.settings'); ORIG_EN=$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="drg")|.enabled')
ORIG_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
api PUT /modules/drg "$ADM" -d '{"enabled":true,"settings":{"confirm_required":true,"recheck_on_finalize":"block","manual_payer_drg":"allowed","version_approval":"off"},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null
SCH=$(api POST /drg/schemes "$DA1" -d "{\"code\":\"E2EP$S\",\"name\":\"ტესტ-E2E DRG ფასი $S\"}" | jq -r '.id // empty')
PY=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EPP$S\",\"name\":\"ტესტ-E2E DRG ფასი $S\",\"kind\":\"state\",\"default_mode\":\"drg\",\"default_coverage_pct\":100,\"drg_base_rate\":1000}" | jq -r '.id // empty')
[ -n "$SCH" ] && [ -n "$PY" ] || die "სქემა / გადამხდელი ვერ შეიქმნა"
api PUT "/drg/payers/$PY/scheme" "$DA1" -d "{\"drg_scheme_id\":\"$SCH\"}" >/dev/null
ok "განყოფილება ($DCODE), ტარიფები, 7 მომხმარებელი, პაციენტი, სქემა, გადამხდელი (DRG, განაკვეთი 1000, 100%)"

step "1. ვერსია პაკეტიდან, ვალიდაცია, CRUD"
PKG=$(jq -nc --arg d "$DCODE" '{format:"emr-drg-version",format_version:1,label:"ტესტ-E2E ფორმულა",settings:{rounding:"total"},
  groups:[{code:"P1",title:"ტესტ-E2E პნევმონია",weight:1,alos:5,los_low:2,los_high:10,kind:"medical"}],
  lists:[{code:"PNEU",title:"ტესტ-E2E პნევმონია",kind:"dx",items:["J12-J18"]}], cc:[],
  rules:[{seq:10,drg_code:"P1",conditions_text:"pdx in @PNEU"}],
  components:[
    {seq:10,kind:"coef",label:"ტესტ-E2E განყოფილება",conditions_text:("dept in " + $d),params:{factor:1.1}},
    {seq:20,kind:"transfer",label:"გადაყვანა",params:{extra_days:1},exclusive_group:"los"},
    {seq:30,kind:"low_los",label:"მოკლე",params:{floor_pct:50},exclusive_group:"los"},
    {seq:40,kind:"high_los",label:"ხანგრძლივი",params:{factor:0.5},exclusive_group:"los"},
    {seq:50,kind:"percent",label:"გარდაცვალება 2 დღეში",conditions_text:"discharge in death & los <= 2",params:{pct:-50}},
    {seq:60,kind:"per_unit",label:"ICU დღე",params:{metric:"icu_days",unit_amount:200}},
    {seq:70,kind:"cost_outlier",label:"ძვირი შემთხვევა",params:{threshold_mode:"x_base",threshold:2,pct:50}},
    {seq:80,kind:"cap",label:"ლიმიტი",params:{mode:"x_base",value:3}}]}')
R=$(api POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$PKG" --arg f "$PAST" '{package:$p,valid_from:$f}')")
V1=$(echo "$R" | jq -r '.id // empty')
chk "პაკეტი: 8 კომპონენტი" "$(echo "$R" | jq -r '.components')" "8"
BADP=$(echo "$PKG" | jq -c '.components[1].params={}|.components[2].params={floor_pct:500}')
chk "პაკეტი: არასწორი პარამეტრი (floor_pct 500) → 400" "$(api POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$BADP" --arg f "$PAST" '{package:$p,valid_from:$f,label:"x x"}')" | jq -r '"\(.code):\(.errors|length)"')" "DRG_PACKAGE_INVALID:1"
C=$(api GET "/drg/versions/$V1/components" "$CD")
chk "კომპონენტები: რიგი, სახეობა, პირობა (DSL)" "$(echo "$C" | jq -r '[.[]|.kind]|join(",")'):$(echo "$C" | jq -r '.[4].conditions_text')" "coef,transfer,low_los,high_los,percent,per_unit,cost_outlier,cap:discharge in death & los <= 2"
chk "სავალდებულო პარამეტრის გარეშე (percent) → 400" "$(code POST "/drg/versions/$V1/components" "$DA1" -d '{"kind":"percent","label":"ტესტ"}')" "400"
chk "უცნობი პარამეტრი → 400" "$(code POST "/drg/versions/$V1/components" "$DA1" -d '{"kind":"fixed","label":"ტესტ","params":{"amount":5,"x":1}}')" "400"
chk "არასწორი მნიშვნელობა (metric=x) → 400" "$(code POST "/drg/versions/$V1/components" "$DA1" -d '{"kind":"per_unit","label":"ტესტ","params":{"metric":"x","unit_amount":1}}')" "400"
chk "dept-ში სია (@) დაუშვებელია → 400" "$(code POST "/drg/versions/$V1/components" "$DA1" -d '{"kind":"fixed","label":"ტესტ","params":{"amount":5},"conditions_text":"dept in @PNEU"}')" "400"
chk "კოდირება კომპონენტს ვერ ამატებს (403)" "$(code POST "/drg/versions/$V1/components" "$CD" -d '{"kind":"fixed","label":"ტესტ","params":{"amount":5}}')" "403"
FX=$(api POST "/drg/versions/$V1/components" "$DA1" -d '{"kind":"fixed","label":"ტესტ-E2E იმპლანტი","params":{"amount":123},"conditions_text":"surgery is yes"}')
FXID=$(echo "$FX" | jq -r '.id // empty')
chk "კომპონენტი: fixed (+ პირობა) — seq ბოლოში (90)" "$(echo "$FX" | jq -r '"\(.seq):\(.conditions_text)"')" "90:surgery is yes"
chk "შეცვლა (თანხა 150)" "$(api PATCH "/drg/components/$FXID" "$DA1" -d '{"params":{"amount":150}}' | jq -r '.params.amount')" "150"
IDS=$(api GET "/drg/versions/$V1/components" "$CD" | jq -c '[.[].id]|[.[-1]]+.[0:-1]')
chk "რიგის შეცვლა: fixed პირველი (10)" "$(api POST "/drg/versions/$V1/components-reorder" "$DA1" -d "{\"ids\":$IDS}" | jq -r .ok):$(api GET "/drg/versions/$V1/components" "$CD" | jq -r '.[0].kind')" "true:fixed"
chk "წაშლა" "$(api DELETE "/drg/components/$FXID" "$DA1" | jq -r .ok):$(api GET "/drg/versions/$V1/components" "$CD" | jq -r 'length')" "true:8"
chk "შემოწმება: ok, კომპონენტების რაოდენობა" "$(api GET "/drg/versions/$V1/check" "$CD" | jq -r .ok):$(api GET "/drg/versions/$V1" "$CD" | jq -r .n_components)" "true:8"
chk "გააქტიურება" "$(api POST "/drg/versions/$V1/activate" "$DA1" -d '{}' | jq -r .ok)" "true"
CID=$(api GET "/drg/versions/$V1/components" "$CD" | jq -r '.[0].id')
chk "აქტიურის კომპონენტი არ იცვლება (409)" "$(code PATCH "/drg/components/$CID" "$DA1" -d '{"label":"xx"}')" "409"
chk "მეტა: 9 სახეობა" "$(api GET /drg/meta "$CD" | jq -r '.price_kinds|length')" "9"

step "2. ტესტი: კომპონენტები"
t() { api POST "/drg/versions/$V1/test" "$CD" -d "$1" | jq -r "$2"; }
P='"pdx":"J18.9","age":60,"base_rate":1000'
chk "საბაზისო (5 დღე): 1000 × 1 = 1000" "$(t "{$P,\"los\":5}" '.pricing|"\(.base):\(.total):\(.items|length)"')" "1000:1000:0"
chk "მოკლე (1 დღე): max(50%, 1/2) → 500" "$(t "{$P,\"los\":1}" '.pricing|"\(.total):\(.items[0].kind)"')" "500:low_los"
chk "ხანგრძლივი (14 დღე): (14−10) × 1000/5 × 0.5 = 400 → 1400" "$(t "{$P,\"los\":14}" '.pricing|"\(.total):\(.items[0].amount)"')" "1400:400"
chk "გადაყვანა (1 დღე): ჯგუფში პირველი → 400 (მოკლე აღარ)" "$(t "{$P,\"los\":1,\"discharge\":\"other_clinic\"}" '.pricing|"\(.total):\([.items[].kind]|join(","))"')" "400:transfer"
chk "გარდაცვალება 2 დღეში: −50% → 500" "$(t "{$P,\"los\":2,\"discharge\":\"death\"}" '.pricing.total')" "500"
chk "განყოფილება (კოეფ. 1.1): 1100" "$(t "{$P,\"los\":5,\"dept\":\"$DCODE\"}" '.pricing|"\(.factor):\(.base):\(.total)"')" "1.1:1100:1100"
chk "ICU 30 სთ → 2 დღე × 200 = 400 → 1400" "$(t "{$P,\"los\":5,\"icu_hours\":30}" '.pricing.total')" "1400"
chk "ძვირი შემთხვევა: (5000 − 2000) × 50% = 1500 → 2500" "$(t "{$P,\"los\":5,\"charges\":5000}" '.pricing.total')" "2500"
chk "ლიმიტი: 3 × საბაზისო = 3000" "$(t "{$P,\"los\":5,\"charges\":9000}" '.pricing|"\(.total):\(.items[-1].kind)"')" "3000:cap"
chk "ჯგუფი ხელით, ვერსიაში არ არის → 400" "$(code POST "/drg/versions/$V1/test" "$CD" -d "{$P,\"drg_code\":\"ZZ\"}")" "400"
chk "განაკვეთის გარეშე — თანხა არ ითვლება" "$(t '{"pdx":"J18.9","los":5}' '.pricing')" "null"

step "3. შემთხვევა: თანხა გადამხდელზე"
E1=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 55)\",\"source\":\"emergency\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
[ -n "$E1" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
api POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' >/dev/null
SPID=$(api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$PY\"}" | jq -r '.id // empty')
[ -n "$SPID" ] && ok "გადამხდელი (P1, წონა 1, განაკვეთი 1000)" || die "გადამხდელი ვერ დაემატა"
pc() { api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r --arg p "$SPID" ".payers[]|select(.id==\$p)|$1"; }
chk "ტარიფი: 1000 × 1.1 (განყოფილება) × 50% (1 დღე) = 550" "$(pc '"\(.calc.tariff):\(.calc.drg_price.factor):\([.calc.drg_price.items[].kind]|join(","))"')" "550:1.1:coef,low_los"
chk "გადამხდელი ფარავს ≤ ჯამი (100)" "$(pc '.calc.amount')" "100"
api POST "/inpatient/stays/$E1/services" "$BL" -d "{\"tariff_id\":\"$T_EXP\",\"quantity\":1}" >/dev/null
chk "ხარჯი 5100 → ძვირი შემთხვევა: (5100 − 2200) × 50% = 1450 → 2000" "$(pc '"\(.calc.tariff):\(.calc.amount)"')" "2000:2000"
V=$(api GET "/drg/stays/$E1" "$CD")
chk "DRG ბლოკი: თანხა, ვერსია, მიმდინარე" "$(echo "$V" | jq -r '.schemes[0].payers[0].price|"\(.total):\(.version_label):\(.charges)"'):$(echo "$V" | jq -r .can.money)" "2000:ტესტ-E2E ფორმულა:5100:true"
chk "ექიმი: თანხა არ ჩანს" "$(api GET "/drg/stays/$E1" "$DR" | jq -r '"\(.schemes[0].payers[0].price):\(.can.money)"')" "null:false"
api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" >/dev/null
api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 56)\",\"$(uid 57)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" >/dev/null
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ფინალიზაცია: სახელმწიფო 2000, პაციენტი 3100" "$(echo "$F" | jq -r '"\(.finalized):\(.money.state):\(.money.patient)"')" "true:2000:3100"

step "4. დაფიქსირება, გახსნა, მოდული გამორთული"
chk "stay_payers: თანხა და დაშლა დაფიქსირდა" "$(pc '"\(.drg_amount|tonumber+0):\(.drg_breakdown.total):\(.drg_breakdown.items|length)"')" "2000:2000:3"
api PUT /modules/drg "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია — ფინალიზებულზე დაფიქსირებული (2000)" "$(pc '"\(.calc.tariff):\(.covered_amount|tonumber+0)"')" "2000:2000"
api POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
chk "გახსნა: დაფიქსირება მოიხსნა; მოდულის გარეშე — წონა × განაკვეთი (1000)" "$(pc '"\(.drg_amount):\(.calc.tariff):\(.calc.drg_price)"')" "null:1000:null"
api PUT /modules/drg "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული ჩართულია — კვლავ ფორმულით (2000)" "$(pc '.calc.tariff')" "2000"
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ხელახალი ფინალიზაცია" "$(echo "$F" | jq -r '"\(.finalized):\(.money.state)"')" "true:2000"

step "5. რეესტრი, PDF"
CSVR=$(curl -s "$B/inpatient/billing/register/$PY?from=$TODAY&to=$TODAY" -H "authorization: Bearer $BL")
chk "რეესტრი: სვეტი „DRG თანხა“, 2000.00" "$(echo "$CSVR" | sed -n 2p | grep -c 'DRG თანხა'):$(echo "$CSVR" | grep -c ';P1;1.0000;1000.00;2000.00;')" "1:1"
chk "კალკულაცია PDF" "$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B/inpatient/stays/$E1/billing/pdf" -H "authorization: Bearer $BL")" "200:application/pdf"
chk "ექსპორტი: კომპონენტები პაკეტში" "$(api GET "/drg/versions/$V1/export" "$CD" | jq -r '.components|length')" "8"
V2=$(api POST "/drg/schemes/$SCH/versions" "$DA1" -d "{\"label\":\"ტესტ-E2E ასლი\",\"valid_from\":\"2099-01-01\",\"copy_from\":\"$V1\"}" | jq -r '.id // empty')
chk "ასლი: კომპონენტებიც კოპირდება" "$(api GET "/drg/versions/$V2" "$CD" | jq -r .n_components)" "8"
api DELETE "/drg/versions/$V2" "$DA1" >/dev/null

step "6. აღდგენა"
api POST "/drg/versions/$V1/retire" "$DA1" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null
api PATCH "/drg/schemes/$SCH" "$DA1" -d '{"is_active":false}' >/dev/null
api PATCH "/billing/payers/$PY" "$BL" -d '{"is_active":false}' >/dev/null
[ -n "$BT" ] && api DELETE "/billing/bed-tariffs/$BT" "$ADM" >/dev/null
for t in "$T_BED" "$T_EXP"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/drg "$ADM" -d "{\"enabled\":$ORIG_EN,\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგა" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="drg")|.enabled')" "$ORIG_EN"

[ "$SCRUB_EN" = "true" ] && curl -s -o /dev/null -X PUT "$B/modules/scrubber" -H "authorization: Bearer $ADM" -H "$J" -d '{"enabled":true,"reason":"ტესტ-E2E აღდგენა"}'
printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
