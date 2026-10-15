#!/usr/bin/env bash
# =====================================================================
# e2e-claim-scrubber.sh — DRG ბლოკი, ეტაპი 0057: claim scrubber (ქლეიმის შემოწმება)
#   0. მომზადება   1. მოდული, წესები (მზა: სიმძიმე / პარამეტრები / გავრცელება; საკუთარი: DSL, აკრძალვები, წაშლა)
#   2. შემთხვევა: შედეგი (PDX, სქესი, არასრული კოდი, საგარანტიო, ეპიკრიზი, საკუთარი წესი, გავრცელება)
#   3. ფინალიზაცია: block → გამონაკლისი (მიზეზით; დაუშვებელი წესი) → ფინალიზაცია გაფრთხილებით; warn რეჟიმი
#   4. ქლეიმი: შეცდომიანი გამოტოვება → გამონაკლისი → განახლება → გაუქმება → გაგზავნის ბლოკი → გაგზავნა; CSV   5. გამორთვა   6. აღდგენა
# გამოყენება:  bash scripts/e2e-claim-scrubber.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F); PAST=$(date -d "$TODAY -10 days" +%F); FUT=$(date -d "$TODAY +30 days" +%F)

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E შემოწმება $S\",\"code\":\"E2ESC$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] || die "განყოფილება ვერ შეიქმნა"
T_BED=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2ESCBED$S\",\"title\":\"ტესტ-E2E შემოწმება საწოლდღე\",\"base_price\":100}" | jq -r '.id // empty')
BT=$(api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
[ -n "$T_BED" ] && [ -n "$BT" ] || die "ტარიფი ვერ დაყენდა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty'); [ -n "$id" ] && echo "e2e_$1_$S"; }
R_CD=$(mkrole scd "DRG კოდირება" '["drg"]'); R_DA=$(mkrole sad "DRG კონფიგურაცია" '["drg_admin"]'); R_AC=$(mkrole sac "ბუღალტერი" '["accountant"]')
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.scr.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"SCR-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.scr.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
CD=$(mkuser "[\"$R_CD\"]" 41); DA1=$(mkuser "[\"$R_DA\"]" 42); BL=$(mkuser '["billing"]' 43); RC=$(mkuser '["receptionist"]' 44); AC=$(mkuser "[\"$R_AC\"]" 45)
DR=$(mkuser '["doctor"]' 46 ",\"department_id\":\"$DA\""); NA=$(mkuser '["nurse"]' 47 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 48 ",\"department_id\":\"$DA\"")
for t in CD DA1 BL RC AC DR NA N2; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"49$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"SCR-1\",\"birth_date\":\"1970-03-03\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] || die "პაციენტი ვერ შეიქმნა"
INS=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2ESCI$S\",\"name\":\"ტესტ-E2E შემოწმება დაზღვევა $S\",\"kind\":\"insurance\",\"default_mode\":\"percent\",\"default_coverage_pct\":80}" | jq -r '.id // empty')
OTH=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2ESCO$S\",\"name\":\"ტესტ-E2E შემოწმება სხვა $S\",\"kind\":\"other\",\"default_mode\":\"percent\",\"default_coverage_pct\":50}" | jq -r '.id // empty')
[ -n "$INS" ] && [ -n "$OTH" ] || die "გადამხდელები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="scrubber")|.settings'); ORIG_EN=$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="scrubber")|.enabled')
ORIG_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
ORIG_RULES=$(api GET /scrub/rules "$ADM" | jq -c '[.[]|select(.builtin)|{code,severity,is_active,payer_kinds,payer_ids,params,message,allow_override}]')
mod() { api PUT /modules/scrubber "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"finalize_check":"block","claim_check":"block"}'
api PUT /modules/inpatient "$ADM" -d '{"settings":{"discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null
# წესები: ცნობილი მდგომარეობა ამ ტესტისთვის (ბოლოს აღდგება)
for c in $(echo "$ORIG_RULES" | jq -r '.[].code'); do api PATCH "/scrub/rules/$c" "$ADM" -d '{"is_active":true,"payer_kinds":[],"payer_ids":[]}' >/dev/null; done
ok "განყოფილება, ტარიფი, 8 მომხმარებელი, პაციენტი (კაცი), 2 გადამხდელი (დაზღვევა 80%, სხვა 50%), მოდული: block / block"

step "1. მოდული, წესები"
chk "მოდული: ნაგულისხმევი ✓ (block / block)" "$(echo "$ORIG" | jq -r '"\(.finalize_check):\(.claim_check)"')" "block:block"
chk "არასწორი პარამეტრი (finalize_check=x) → 400" "$(code PUT /modules/scrubber "$ADM" -d '{"settings":{"finalize_check":"x"},"reason":"ტესტ-E2E"}')" "400"
R=$(api GET /scrub/rules "$CD")
chk "მზა წესები: 19, ჯგუფებით" "$(echo "$R" | jq -r '[.[]|select(.builtin)]|length'):$(echo "$R" | jq -r '.[]|select(.code=="PDX_MISSING")|"\(.group_ka):\(.allow_override)"')" "19:დიაგნოზი:false"
chk "ექთანი წესებს ვერ ხედავს (403); კოდირება ვერ ცვლის (403)" "$(code GET /scrub/rules "$NA"):$(code PATCH /scrub/rules/LOS_LONG "$CD" -d '{"severity":"error"}')" "403:403"
chk "მზა: პარამეტრი LOS_LONG.days = 0 (ყოველთვის)" "$(api PATCH /scrub/rules/LOS_LONG "$DA1" -d '{"params":{"days":0}}' | jq -r '.params.days')" "0"
chk "მზა: უცნობი პარამეტრი → 400; არასწორი ნიმუში → 400" "$(code PATCH /scrub/rules/LOS_LONG "$DA1" -d '{"params":{"x":1}}'):$(code PATCH /scrub/rules/DX_SEX "$DA1" -d '{"params":{"female_only":["O-"]}}')" "400:400"
chk "მზა: დასახელება არ იცვლება (400); ტექსტი (message) — იცვლება" "$(code PATCH /scrub/rules/LOS_LONG "$DA1" -d '{"title":"xx"}'):$(api PATCH /scrub/rules/LOS_LONG "$DA1" -d '{"message":"ტესტ-E2E ხანგრძლივი"}' | jq -r .message)" "400:ტესტ-E2E ხანგრძლივი"
chk "მზა წესი არ იშლება (400)" "$(code DELETE /scrub/rules/LOS_LONG "$DA1")" "400"
chk "საკუთარი: კოდი X_-ის გარეშე → 400" "$(code POST /scrub/rules "$DA1" -d '{"code":"E2E","title":"ტესტ","conditions_text":"los > 1"}')" "400"
chk "საკუთარი: cc ველი → 400; @სია → 400; DSL შეცდომა → 400" "$(code POST /scrub/rules "$DA1" -d "{\"code\":\"X_E2E$S\",\"title\":\"ტესტ\",\"conditions_text\":\"cc >= cc\"}"):$(code POST /scrub/rules "$DA1" -d "{\"code\":\"X_E2E$S\",\"title\":\"ტესტ\",\"conditions_text\":\"pdx in @PNEU\"}"):$(code POST /scrub/rules "$DA1" -d "{\"code\":\"X_E2E$S\",\"title\":\"ტესტ\",\"conditions_text\":\"los ~ 1\"}")" "400:400:400"
XR="X_E2E$S"
chk "საკუთარი წესი: pdx in J18 & los >= 1 (warn, მხოლოდ „სხვა“ ტიპის გადამხდელზე)" "$(api POST /scrub/rules "$DA1" -d "{\"code\":\"$XR\",\"title\":\"ტესტ-E2E პნევმონია\",\"message\":\"ტესტ-E2E: პნევმონია — დასაბუთება\",\"conditions_text\":\"pdx in J18 & los >= 1\",\"payer_kinds\":[\"other\"]}" | jq -r '"\(.code):\(.severity):\(.grp)"')" "$XR:warn:custom"
XR2="X_E2EDEL$S"
api POST /scrub/rules "$DA1" -d "{\"code\":\"$XR2\",\"title\":\"ტესტ-E2E წასაშლელი\",\"conditions_text\":\"age > 200\"}" >/dev/null
chk "საკუთარი წესის წაშლა" "$(api DELETE "/scrub/rules/$XR2" "$DA1" | jq -r .ok)" "true"
chk "მეტა: ველები (cc-ის გარეშე), ჯგუფები" "$(api GET /scrub/meta "$CD" | jq -r '"\(.fields|has("cc")):\(.fields|has("los")):\(.groups.guarantee)"')" "false:true:საგარანტიო"

step "2. შემთხვევა: შედეგი"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 46)\",\"source\":\"emergency\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); [ -n "$E1" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
chk "გადამხდელის გარეშე — არ მოწმდება" "$(api GET "/scrub/stays/$E1" "$BL" | jq -r '"\(.checked):\(.issues|length)"')" "false:0"
SP1=$(api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\"}" | jq -r '.id // empty')
[ -n "$SP1" ] || die "გადამხდელი ვერ დაემატა"
has() { api GET "/scrub/stays/$1" "$BL" | jq -r --arg c "$2" '[.issues[]|select(.code==$c)][0]|if . then "\(.severity)\(if .overridden then ":ov" else "" end)" else "-" end'; }
V=$(api GET "/scrub/stays/$E1" "$BL")
chk "შეცდომა: ძირითადი დიაგნოზი არ არის" "$(has "$E1" PDX_MISSING)" "error"
chk "გაფრთხილება: საგარანტიო № / ფაილი, ეპიკრიზი, ხანგრძლივობა (0 დღეზე)" "$(has "$E1" GUARANTEE_MISSING):$(has "$E1" GUARANTEE_FILE):$(has "$E1" EPICRISIS_UNSIGNED):$(has "$E1" LOS_LONG)" "warn:warn:warn:warn"
chk "ტექსტი (message) და დეტალი" "$(echo "$V" | jq -r '.issues[]|select(.code=="LOS_LONG")|"\(.message)|\(.detail)"')" "ტესტ-E2E ხანგრძლივი|1 დღე (> 0)"
chk "შეჯამება: errors ≥ 1; რიგი — შეცდომები პირველი" "$(echo "$V" | jq -r '"\(.errors >= 1):\(.issues[0].severity)"')" "true:error"
api POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"O80.0","diagnosis_type":"primary"}' >/dev/null
chk "O80.0 (კაცი) → სქესის შეცდომა; PDX — აღარ" "$(has "$E1" DX_SEX):$(has "$E1" PDX_MISSING)" "error:-"
DXID=$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '.diagnoses[]|select(.icd10_code=="O80.0")|.id')
code DELETE "/encounters/$E1/diagnoses/$DXID" "$DR" >/dev/null
api POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' >/dev/null
api POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"L54","diagnosis_type":"secondary"}' >/dev/null
chk "O80.0 წაშლილი → სქესი გასწორდა; L54 → არასრული კოდი (warn)" "$(has "$E1" DX_SEX):$(has "$E1" ICD_NONSPECIFIC)" "-:warn"
chk "საკუთარი წესი — მხოლოდ „სხვა“ ტიპზე (დაზღვევაზე — არა)" "$(has "$E1" "$XR")" "-"
api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$OTH\"}" >/dev/null
chk "„სხვა“ გადამხდელი დაემატა → საკუთარი წესი (warn)" "$(has "$E1" "$XR")" "warn"
chk "გადამხდელზე მიბმული: საგარანტიო № — ორივე გადამხდელზე" "$(api GET "/scrub/stays/$E1" "$BL" | jq -r '[.issues[]|select(.code=="GUARANTEE_MISSING")]|length')" "2"
api PATCH "/scrub/rules/GUARANTEE_MISSING" "$DA1" -d "{\"payer_ids\":[\"$INS\"]}" >/dev/null
chk "გავრცელება: მხოლოდ დაზღვევა → 1" "$(api GET "/scrub/stays/$E1" "$BL" | jq -r '[.issues[]|select(.code=="GUARANTEE_MISSING")]|length')" "1"
SPID=$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r --arg p "$INS" '.payers[]|select(.payer_id==$p and .status=="active")|.id')
api PATCH "/inpatient/stay-payers/$SPID" "$BL" -d "{\"guarantee_no\":\"G-SC$S\",\"guarantee_date\":\"$PAST\",\"valid_until\":\"$PAST\"}" >/dev/null
chk "საგარანტიო ვადა გასულია (მიღების დღეს) → შეცდომა; № — აღარ" "$(has "$E1" GUARANTEE_EXPIRED):$(has "$E1" GUARANTEE_MISSING)" "error:-"
chk "ექიმი შედეგს ვერ ხედავს (403); მიმღები ხედავს (200)" "$(code GET "/scrub/stays/$E1" "$DR"):$(code GET "/scrub/stays/$E1" "$RC")" "403:200"

step "3. ფინალიზაცია"
api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 47)\",\"$(uid 48)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "block: საგარანტიოს ვადა → 409 SCRUB_ERRORS (1 შეცდომა)" "$(echo "$F" | jq -r '"\(.code):\(.issues|length):\(.issues[0].code)"')" "SCRUB_ERRORS:1:GUARANTEE_EXPIRED"
INV1=$(api GET "/scrub/stays/$E1" "$BL" | jq -r .invoice_id)
chk "გამონაკლისი: ექიმი → 403; მოკლე მიზეზი → 400" "$(code POST /scrub/overrides "$DR" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"GUARANTEE_EXPIRED\",\"reason\":\"ტესტ-E2E გაგრძელებულია\"}"):$(code POST /scrub/overrides "$BL" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"GUARANTEE_EXPIRED\",\"reason\":\"x\"}")" "403:400"
chk "გამონაკლისი დაუშვებელი წესზე (PDX_MISSING) → 403" "$(code POST /scrub/overrides "$BL" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"PDX_MISSING\",\"reason\":\"ტესტ-E2E მიზეზი\"}")" "403"
chk "გამონაკლისი წესზე, რომელიც არ ფიქსირდება → 400" "$(code POST /scrub/overrides "$BL" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"DX_SEX\",\"reason\":\"ტესტ-E2E მიზეზი\"}")" "400"
OV1=$(api POST /scrub/overrides "$CD" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"GUARANTEE_EXPIRED\",\"reason\":\"ტესტ-E2E გაგრძელების წერილი მოსულია\"}" | jq -r '.id // empty')
chk "გამონაკლისი (კოდირება) → შეცდომა აღარ ბლოკავს" "$([ -n "$OV1" ] && echo ok):$(has "$E1" GUARANTEE_EXPIRED):$(api GET "/scrub/stays/$E1" "$BL" | jq -r '"\(.errors):\(.overridden)"')" "ok:error:ov:0:1"
chk "განმეორებითი გამონაკლისი → 409" "$(code POST /scrub/overrides "$BL" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"GUARANTEE_EXPIRED\",\"reason\":\"ტესტ-E2E მიზეზი\"}")" "409"
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ფინალიზაცია — გაფრთხილებებით" "$(echo "$F" | jq -r '"\(.finalized):\(.scrub_warnings|length > 2)"')" "true:true"
api POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
api POST "/scrub/overrides/$OV1/revoke" "$BL" -d '{"reason":"ტესტ-E2E შემოწმება"}' >/dev/null
mod '{"finalize_check":"warn"}'
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "finalize_check=warn: შეცდომა არ ბლოკავს, ჩანს გაფრთხილებაში" "$(echo "$F" | jq -r '"\(.finalized):\([.scrub_warnings[]|select(test("ვადა"))]|length)"')" "true:1"
mod '{"finalize_check":"block"}'

step "4. ქლეიმი"
E2=$(ADMIT "$P1"); [ -n "$E2" ] || die "მეორე ჰოსპიტალიზაცია ვერ მოხერხდა"
api POST "/inpatient/stays/$E2/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"guarantee_no\":\"G-SD$S\"}" >/dev/null
api POST "/encounters/$E2/diagnoses" "$DR" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' >/dev/null
chk "დუბლიკატი: იგივე პაციენტი, იგივე გადამხდელი, გადამფარავი პერიოდი (warn)" "$(has "$E2" DUPLICATE_STAY)" "warn"
api POST "/inpatient/stays/$E2/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 47)\",\"$(uid 48)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
chk "E2 ფინალიზაცია (მხოლოდ გაფრთხილებები)" "$(api POST "/inpatient/stays/$E2/billing/finalize" "$BL" | jq -r .finalized)" "true"
C=$(api POST /finance/claims "$AC" -d "{\"payer_id\":\"$INS\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\"}")
CID=$(echo "$C" | jq -r '.id // empty')
chk "ქლეიმი: E1 (საგარანტიოს ვადა) გამოტოვდა, E2 შევიდა" "$(echo "$C" | jq -r '"\(.items|length):\(.scrub_skipped|length):\(.scrub_skipped[0].errors|test("ვადა"))"')" "1:1:true"
chk "ქლეიმის შემთხვევის შედეგი: გაფრთხილებები, შეცდომის გარეშე" "$(echo "$C" | jq -r '.items[0].scrub|"\(.errors):\(.warnings > 0)"'):$(echo "$C" | jq -r '.scrub.errors')" "0:true:0"
OV2=$(api POST /scrub/overrides "$BL" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"GUARANTEE_EXPIRED\",\"reason\":\"ტესტ-E2E გაგრძელების წერილი\"}" | jq -r '.id // empty')
C=$(api PUT "/finance/claims/$CID" "$AC" -d '{}')
chk "გამონაკლისი → ქლეიმის განახლება: E1 დაემატა" "$(echo "$C" | jq -r '"\(.items|length):\(.scrub_skipped|length)"')" "2:0"
api POST "/scrub/overrides/$OV2/revoke" "$BL" -d '{"reason":"ტესტ-E2E გაუქმება"}' >/dev/null
chk "გამონაკლისის გაუქმება → ქლეიმში E1-ს შეცდომა ჩანს" "$(api GET "/finance/claims/$CID" "$AC" | jq -r '.scrub.errors')" "1"
R=$(api POST "/finance/claims/$CID/send" "$AC")
chk "გაგზავნა შეცდომით → 409 SCRUB_ERRORS (1 შემთხვევა)" "$(echo "$R" | jq -r '"\(.code):\(.items|length)"')" "SCRUB_ERRORS:1"
chk "გაუქმებული გამონაკლისი — ხელმეორედ გაუქმება → 409" "$(code POST "/scrub/overrides/$OV2/revoke" "$BL" -d '{"reason":"ტესტ-E2E გაუქმება"}')" "409"
api POST /scrub/overrides "$BL" -d "{\"invoice_id\":\"$INV1\",\"rule_code\":\"GUARANTEE_EXPIRED\",\"reason\":\"ტესტ-E2E საბოლოო\"}" >/dev/null
chk "გამონაკლისის შემდეგ — გაგზავნა" "$(api POST "/finance/claims/$CID/send" "$AC" | jq -r .status)" "sent"
CSV=$(curl -s "$B/finance/claims/$CID/csv" -H "authorization: Bearer $AC")
chk "CSV: სვეტი „შემოწმება“, გაფრთხილება ⚠" "$(echo "$CSV" | sed -n 2p | grep -c 'შემოწმება'):$(echo "$CSV" | grep -c '⚠')" "1:2"

step "5. გამორთვა"
api PUT /modules/scrubber "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია: შედეგი ჩანს (enabled=false), ქლეიმში — არა" "$(api GET "/scrub/stays/$E1" "$BL" | jq -r .enabled):$(api GET "/finance/claims/$CID" "$AC" | jq -r '.scrub')" "false:null"
chk "აუდიტი: SCRUB_OVERRIDE / SCRUB_OVERRIDE_REVOKE" "$(api GET "/audit-logs?entity_name=scrub_overrides&limit=50" "$ADM" | jq -r --arg a "$OV2" '[.[]|select(.entity_id==$a)|.action]|sort|join(",")')" "SCRUB_OVERRIDE,SCRUB_OVERRIDE_REVOKE"

step "6. აღდგენა"
api DELETE "/scrub/rules/$XR" "$DA1" >/dev/null || true
api PATCH "/scrub/rules/$XR" "$DA1" -d '{"is_active":false}' >/dev/null
echo "$ORIG_RULES" | jq -c '.[]' | while read -r r; do c=$(echo "$r" | jq -r .code); api PATCH "/scrub/rules/$c" "$ADM" -d "$(echo "$r" | jq -c 'del(.code)')" >/dev/null; done
api PUT /modules/scrubber "$ADM" -d "{\"enabled\":$ORIG_EN,\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
for p in "$INS" "$OTH"; do api PATCH "/billing/payers/$p" "$BL" -d '{"is_active":false}' >/dev/null; done
api DELETE "/billing/bed-tariffs/$BT" "$ADM" >/dev/null; api PATCH "/tariffs/$T_BED" "$ADM" -d '{"is_active":false}' >/dev/null
chk "წესები და პარამეტრები აღდგა" "$(api GET /scrub/rules "$ADM" | jq -c '[.[]|select(.builtin)|{code,severity,is_active,payer_kinds,payer_ids,params,message,allow_override}]' | jq -S -c . | md5sum | cut -c1-8)" "$(echo "$ORIG_RULES" | jq -S -c . | md5sum | cut -c1-8)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
