#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-billing.sh — სტაციონარი, ეტაპი 0046: ბილინგი
#   0. მომზადება   1. ცნობარები (გადამხდელები, პაკეტები, DRG, საწოლდღის ტარიფები)   2. საწოლდღე
#   3. მომსახურება, თანხების ხილვადობა   4. გადამხდელი (%, ფრანშიზა, გამორიცხვა, შესწორება)   5. ავანსი
#   6. პაკეტი   7. DRG (თანაგადახდა, ჩამოწერა)   8. გაწერა → ფინალიზაცია → გადახდა → გახსნა
#   9. PDF, სამუშაო სია, რეპორტი, რეესტრი   10. აღდგენა
# გამოყენება:  bash scripts/e2e-ipd-billing.sh [API_URL]
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
TODAY=$(TZ=Asia/Tbilisi date +%F)

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ბილინგი თერაპია $S\",\"code\":\"E2EBA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ბილინგი ქირურგია $S\",\"code\":\"E2EBB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"E2EB$1$S\",\"title\":\"ტესტ-E2E $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_STD=$(tar STD "საწოლდღე ჩვეულებრივი" 100); T_STDA=$(tar STDA "საწოლდღე თერაპია" 120); T_EXTRA=$(tar EXT "ზედმეტი დღე (პაკეტი)" 80); T_SRV=$(tar SRV "გადასახვევი" 30)
for t in T_STD T_STDA T_EXTRA T_SRV; do [ -n "${!t}" ] || die "ტარიფი $t ვერ შეიქმნა"; done
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.bl.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ბილ-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.bl.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 31)
BL=$(mkuser '["billing"]' 32)
NA=$(mkuser '["nurse"]' 33 ",\"department_id\":\"$DA\"")
N2=$(mkuser '["nurse"]' 34 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 35 ",\"department_id\":\"$DA\"")
HD=$(mkuser '["doctor"]' 36 ",\"department_id\":\"$DA\",\"is_section_head\":true")
DX=$(mkuser '["doctor"]' 37 ",\"department_id\":\"$DB\"")
for t in RC BL NA N2 DR HD DX; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: მიმღები, ბილინგი, 2 ექთანი, ექიმი + ხელმძღვანელი (A), ექიმი (B)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1961-03-03\",\"gender\":\"female\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 71 "ბილინგი-1"); P2=$(mkpat 72 "ბილინგი-2"); P3=$(mkpat 73 "ბილინგი-3")
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"discharge_balance":"warn","deposit_alert_amount":500,"billing_amounts_visible":"heads","staff_add_services":true,"leave_counts_bed_day":true}'
chk "პარამეტრები: discharge_balance=warn, billing_amounts_visible=heads" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="inpatient")|.settings|"\(.discharge_balance):\(.billing_amounts_visible)"')" "warn:heads"
chk "არასწორი პარამეტრი (discharge_balance=x) → 400" "$(code PUT /modules/inpatient "$ADM" -d '{"settings":{"discharge_balance":"x"},"reason":"ტესტ-E2E"}')" "400"

step "1. ცნობარები"
OLDGEN=$(api GET /billing/bed-tariffs "$ADM" | jq -r '[.[]|select(.bed_type_code=="standard" and .department_id==null)][0].tariff_id // empty')
chk "საწოლდღის ტარიფი: ზოგადი (standard → 100)" "$(api PUT /billing/bed-tariffs "$BL" -d "{\"bed_type_code\":\"standard\",\"tariff_id\":\"$T_STD\"}" | jq -r '.tariff_id')" "$T_STD"
BTA=$(api PUT /billing/bed-tariffs "$BL" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_STDA\"}" | jq -r '.id // empty')
[ -n "$BTA" ] && ok "საწოლდღის ტარიფი: განყოფილება A (standard → 120)" || bad "განყოფილების ტარიფი" ""
chk "მიმღები ტარიფს ვერ ცვლის (403)" "$(code PUT /billing/bed-tariffs "$RC" -d "{\"bed_type_code\":\"standard\",\"tariff_id\":\"$T_STD\"}")" "403"
chk "ექთანი ცნობარს კითხულობს (200)" "$(code GET /billing/bed-tariffs "$NA")" "200"
chk "გადამხდელი: DRG რეჟიმი განაკვეთის გარეშე → 400" "$(code POST /billing/payers "$BL" -d "{\"code\":\"E2EX$S\",\"name\":\"ტესტ-E2E X\",\"kind\":\"state\",\"default_mode\":\"drg\"}")" "400"
INS=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EINS$S\",\"name\":\"ტესტ-E2E დაზღვევა\",\"kind\":\"insurance\",\"default_mode\":\"percent\",\"default_coverage_pct\":80,\"default_limit\":1000,\"default_deductible\":50,\"tax_id\":\"404000000\"}" | jq -r '.id // empty')
SSA=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2ESSA$S\",\"name\":\"ტესტ-E2E საყოველთაო\",\"kind\":\"state\",\"default_mode\":\"drg\",\"default_coverage_pct\":90,\"drg_base_rate\":1000,\"writeoff_excess\":true}" | jq -r '.id // empty')
[ -n "$INS" ] && [ -n "$SSA" ] && ok "გადამხდელები: დაზღვევა (80%, ლიმიტი 1000, ფრანშიზა 50), სახელმწიფო (DRG 1000 ₾, 90%, ჩამოწერა)" || die "გადამხდელები ვერ შეიქმნა"
chk "გამეორებული კოდი → 409" "$(code POST /billing/payers "$BL" -d "{\"code\":\"E2EINS$S\",\"name\":\"ტესტ-E2E Y\",\"kind\":\"insurance\"}")" "409"
chk "მიმღები გადამხდელს ვერ ქმნის (403)" "$(code POST /billing/payers "$RC" -d "{\"code\":\"E2EZ$S\",\"name\":\"ტესტ-E2E Z\",\"kind\":\"other\"}")" "403"
chk "გადამხდელის რედაქტირება (ტელეფონი)" "$(api PATCH "/billing/payers/$INS" "$BL" -d '{"phone":"032 2 000 000"}' | jq -r '.phone')" "032 2 000 000"
C1="E1$S"; C2="E2$S"
CSV=$(printf 'code;title;weight;alos\n%s;ტესტ-E2E პნევმონია;0,1;5\n%s;"ტესტ-E2E ქოლეცისტექტომია; ლაპ.";1.8500;3\n' "$C1" "$C2")
R=$(api POST /billing/drg/import "$BL" -d "$(jq -nc --arg c "$CSV" '{csv:$c,dry_run:true}')")
chk "DRG იმპორტი (შემოწმება): 2 სტრიქონი, 2 ახალი, არ ჩაიწერა" "$(echo "$R" | jq -r '"\(.rows):\(.added):\(.applied)"')" "2:2:false"
R=$(api POST /billing/drg/import "$BL" -d "$(jq -nc --arg c "$CSV" '{csv:$c}')")
chk "DRG იმპორტი: ჩაიწერა" "$(echo "$R" | jq -r '"\(.added):\(.applied)"')" "2:true"
chk "DRG: წონა (მძიმით) 0.1, ბრჭყალებში „;“" "$(api GET "/billing/drg?search=$C2" "$NA" | jq -r ".rows[0].title"):$(api GET "/billing/drg?search=$C1" "$NA" | jq -r '.rows[0].relative_weight|tonumber+0')" "ტესტ-E2E ქოლეცისტექტომია; ლაპ.:0.1"
BADCSV=$(printf 'code;title;weight\n%s;ტესტ;abc\n' "E3$S")
chk "DRG იმპორტი: არასწორი წონა → შეცდომა, არაფერი იწერება" "$(api POST /billing/drg/import "$BL" -d "$(jq -nc --arg c "$BADCSV" '{csv:$c}')" | jq -r '"\(.errors|length>0):\(.applied)"')" "true:false"
chk "DRG: ხელით რედაქტირება (წონა 1.9)" "$(api PATCH "/billing/drg/$C2" "$BL" -d '{"relative_weight":1.9}' | jq -r '.relative_weight|tonumber+0')" "1.9"
PK=$(api POST /billing/packages "$BL" -d "{\"code\":\"E2EPK$S\",\"name\":\"ტესტ-E2E პაკეტი\",\"price\":500,\"includes_bed\":true,\"included_days\":2,\"extra_day_tariff_id\":\"$T_EXTRA\",\"items\":[{\"kind\":\"category\",\"category\":\"lab\"},{\"kind\":\"tariff\",\"tariff_id\":\"$T_SRV\"}]}" | jq -r '.id // empty')
[ -n "$PK" ] && ok "პაკეტი: 500 ₾, 2 დღე, ლაბ. + გადასახვევი, ზედმეტი დღე 80" || die "პაკეტი ვერ შეიქმნა"
chk "პაკეტის შემადგენლობა (2)" "$(api GET /billing/packages "$RC" | jq -r --arg p "$PK" '.[]|select(.id==$p)|.items|length')" "2"
chk "პაკეტი: დღეები საწოლდღის გარეშე → 400" "$(code POST /billing/packages "$BL" -d "{\"code\":\"E2EPX$S\",\"name\":\"ტესტ-E2E X\",\"price\":1,\"includes_bed\":false,\"included_days\":2}")" "400"

step "2. საწოლდღე (შუაღამის აღრიცხვა)"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$(uid 35)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E ცხელება\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$DA"); E2=$(ADMIT "$P2" "$DA"); E3=$(ADMIT "$P3" "$DA")
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$E3" ] && ok "3 ჰოსპიტალიზაცია (განყოფილება A)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
V=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "1 დღე (შუაღამე ჯერ არ გადაკვეთა — მინიმუმი)" "$(echo "$V" | jq -r '"\(.bed_days_count):\(.bed_days[0].minimum):\(.bed_days[0].day)"')" "1:true:$TODAY"
chk "ინვოისის ხაზი: საწოლდღე — განყოფილების ტარიფით 120" "$(echo "$V" | jq -r '[.lines[]|select(.category=="bed")][0]|"\(.quantity):\(.unit_price|tonumber+0)"')" "1:120"
chk "ჯამი 120, პაციენტის წილი 120" "$(echo "$V" | jq -r '"\(.money.total|tonumber+0):\(.money.patient|tonumber+0)"')" "120:120"

step "3. მომსახურება, თანხების ხილვადობა"
L1=$(api POST "/inpatient/stays/$E1/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":2,\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
[ -n "$L1" ] && ok "ექთანი (განყოფილება A) ამატებს მომსახურებას: 2 × 30" || bad "მომსახურების დამატება" ""
chk "სხვა განყოფილების ექიმი → 403" "$(code POST "/inpatient/stays/$E1/services" "$DX" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}")" "403"
chk "მიმღები → 403" "$(code POST "/inpatient/stays/$E1/services" "$RC" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}")" "403"
chk "მომავალი თარიღი → 400" "$(code POST "/inpatient/stays/$E1/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1,\"service_date\":\"2099-01-01\"}")" "400"
L2=$(api POST "/inpatient/stays/$E1/services" "$DR" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" | jq -r '.id // empty')
chk "სხვა ექთანი ვერ შლის სხვის ჩანაწერს (403)" "$(code DELETE "/inpatient/stays/$E1/services/$L2" "$N2" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "403"
chk "ბილინგი შლის (მიზეზით)" "$(api DELETE "/inpatient/stays/$E1/services/$L2" "$BL" -d '{"reason":"ტესტ-E2E შეცდომა"}' | jq -r '.ok')" "true"
chk "ავტომატური ხაზი (საწოლდღე) არ იშლება (404)" "$(code DELETE "/inpatient/stays/$E1/services/$(echo "$V" | jq -r '[.lines[]|select(.category=="bed")][0].id')" "$BL" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "404"
V=$(api GET "/inpatient/stays/$E1/billing" "$NA")
chk "ექთანი: სია ჩანს, თანხები — არა (heads)" "$(echo "$V" | jq -r '"\(.lines|length):\(.money):\(.amounts_visible):\(.lines[0].unit_price):\(.can.services)"')" "2:null:false:null:true"
chk "ხელმძღვანელი ექიმი: თანხები ჩანს (ჯამი 180)" "$(api GET "/inpatient/stays/$E1/billing" "$HD" | jq -r '.money.total|tonumber+0')" "180"
mod '{"billing_amounts_visible":"all"}'
chk "billing_amounts_visible=all → ექთანი ხედავს" "$(api GET "/inpatient/stays/$E1/billing" "$NA" | jq -r '.amounts_visible')" "true"
mod '{"billing_amounts_visible":"heads","staff_add_services":false}'
chk "staff_add_services=false → ექთანი ვერ ამატებს (403)" "$(code POST "/inpatient/stays/$E1/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}")" "403"
mod '{"staff_add_services":true}'
chk "კატეგორიები: საწოლდღე 120, მომსახურება 60" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '[.by_category[]|"\(.category)=\(.amount|tonumber+0)"]|sort|join(",")')" "bed=120,service=60"

step "4. გადამხდელი"
SP1=$(api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\",\"policy_no\":\"POL-$S\",\"guarantee_no\":\"G-$S\",\"guarantee_date\":\"$TODAY\"}" | jq -r '.id // empty')
[ -n "$SP1" ] && ok "მიმღები ამატებს დაზღვევას (საგარანტიო წერილი; პირობები — ნაგულისხმევი)" || bad "გადამხდელის დამატება" ""
chk "იგივე გადამხდელი მეორედ → 409" "$(code POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$INS\"}")" "409"
V=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "გაანგარიშება: (180 − 50) × 80% = 104; პაციენტი 76" "$(echo "$V" | jq -r '"\(.payers[0].calc.amount):\(.money.insurance|tonumber+0):\(.money.patient|tonumber+0)"')" "104:104:76"
api PATCH "/inpatient/stay-payers/$SP1" "$RC" -d '{"excluded_categories":["service"]}' >/dev/null
chk "გამორიცხული კატეგორია (მომსახურება): (120 − 50) × 80% = 56" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '.payers[0].calc.amount')" "56"
api PATCH "/inpatient/stay-payers/$SP1" "$RC" -d '{"excluded_categories":[],"limit_amount":90}' >/dev/null
chk "ლიმიტი 90 → 90" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '.payers[0].calc.amount')" "90"
api PATCH "/inpatient/stay-payers/$SP1" "$RC" -d '{"limit_amount":1000}' >/dev/null
chk "მიმღები თანხას ხელით ვერ ასწორებს (403)" "$(code PATCH "/inpatient/stay-payers/$SP1" "$RC" -d '{"override_amount":100,"override_reason":"ტესტ-E2E"}')" "403"
chk "ბილინგი: შესწორება მიზეზის გარეშე → 400" "$(code PATCH "/inpatient/stay-payers/$SP1" "$BL" -d '{"override_amount":100}')" "400"
api PATCH "/inpatient/stay-payers/$SP1" "$BL" -d '{"override_amount":100,"override_reason":"ტესტ-E2E საგარანტიო თანხა"}' >/dev/null
chk "ბილინგი: შესწორება 100 (მიზეზით) → პაციენტი 80" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '"\(.payers[0].calc.amount):\(.money.patient|tonumber+0)"')" "100:80"
api PATCH "/inpatient/stay-payers/$SP1" "$BL" -d '{"override_amount":null}' >/dev/null
chk "შესწორების მოხსნა → 104" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '.payers[0].calc.amount')" "104"
SPX=$(api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$SSA\",\"mode\":\"percent\",\"coverage_pct\":50}" | jq -r '.id // empty')
chk "მეორე გადამხდელი (seq 2): ნაშთიდან 76 × 50% = 38" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r --arg x "$SPX" '"\(.payers[]|select(.id==$x)|.seq):\(.payers[]|select(.id==$x)|.calc.amount)"')" "2:38"
chk "გაუქმება მიზეზით" "$(api POST "/inpatient/stay-payers/$SPX/cancel" "$RC" -d '{"reason":"ტესტ-E2E არ ეკუთვნის"}' | jq -r '.ok')" "true"
chk "ისტორია: payer_added, payer_cancelled" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(.=="payer_added" or .=="payer_cancelled")]|unique|join(",")')" "payer_added,payer_cancelled"

step "5. ავანსი"
DP1=$(api POST "/inpatient/stays/$E1/deposits" "$RC" -d '{"kind":"deposit","amount":50,"method":"cash"}')
chk "ავანსი 50 ₾ (ნაღდი) — ქვითრის ნომერი" "$(echo "$DP1" | jq -r '.receipt_no|test("^DP-[0-9]{2}-[0-9]{6}$")')" "true"
DP1=$(echo "$DP1" | jq -r '.id')
chk "ბარათი ტრანზაქციის ნომრის გარეშე → 400" "$(code POST "/inpatient/stays/$E1/deposits" "$RC" -d '{"kind":"deposit","amount":10,"method":"card_terminal"}')" "400"
chk "დაბრუნება ავანსზე მეტი → 409" "$(code POST "/inpatient/stays/$E1/deposits" "$RC" -d '{"kind":"refund","amount":60,"method":"cash"}')" "409"
DP2=$(api POST "/inpatient/stays/$E1/deposits" "$RC" -d '{"kind":"deposit","amount":20,"method":"card_terminal","terminal_ref":"TRX-1"}' | jq -r '.id')
chk "მიმღები ავანსს ვერ აუქმებს (403)" "$(code POST "/inpatient/deposits/$DP2/void" "$RC" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "403"
chk "ბილინგი აუქმებს (მიზეზით)" "$(api POST "/inpatient/deposits/$DP2/void" "$BL" -d '{"reason":"ტესტ-E2E შეცდომა"}' | jq -r '.ok')" "true"
V=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "ბალანსი: ავანსი 50, გადასახდელი 26" "$(echo "$V" | jq -r '"\(.money.deposit_net|tonumber+0):\(.money.due|tonumber+0)"')" "50:26"
INV1=$(api GET "/invoices/encounter/$E1" "$BL" | jq -r '.id')
chk "ინვოისზე პირდაპირი გადახდა ფინალიზაციამდე → 409 (ავანსით)" "$(api POST "/invoices/$INV1/payments" "$BL" -d '{"amount":5,"method":"cash"}' | jq -r '.code // .message.code // empty')" "IPD_USE_DEPOSIT"

step "6. პაკეტი"
L3=$(api POST "/inpatient/stays/$E2/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" | jq -r '.id // empty')
chk "მიმღები ირჩევს პაკეტს" "$(api POST "/inpatient/stays/$E2/billing/package" "$RC" -d "{\"package_id\":\"$PK\"}" | jq -r '.package_id')" "$PK"
V=$(api GET "/inpatient/stays/$E2/billing" "$BL")
chk "პაკეტის ხაზი 500; საწოლდღე და გადასახვევი — „პაკეტშია“; ჯამი 500" "$(echo "$V" | jq -r '"\([.lines[]|select(.category=="package")][0].line_total|tonumber+0):\([.lines[]|select(.category!="package")|.package_included]|all):\(.money.total|tonumber+0)"')" "500:true:500"
L4=$(api POST "/inpatient/stays/$E2/services" "$DR" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" | jq -r '.id // empty')
chk "ახალი ხაზი პაკეტის ტარიფით → ავტომატურად პაკეტში" "$(api GET "/inpatient/stays/$E2/billing" "$BL" | jq -r --arg l "$L4" '.lines[]|select(.id==$l)|.package_included')" "true"
chk "კატეგორიები: პაკეტში შემავალი ცალკე ჩანს (მომსახურება 60)" "$(api GET "/inpatient/stays/$E2/billing" "$BL" | jq -r '.by_category[]|select(.category=="service")|"\(.amount|tonumber+0):\(.included|tonumber+0)"')" "0:60"
PB=$(api POST /billing/packages "$BL" -d "{\"code\":\"E2EPB$S\",\"name\":\"ტესტ-E2E B\",\"price\":1,\"department_id\":\"$DB\"}" | jq -r '.id')
chk "სხვა განყოფილების პაკეტი → 400" "$(code POST "/inpatient/stays/$E2/billing/package" "$RC" -d "{\"package_id\":\"$PB\"}")" "400"
api POST "/inpatient/stays/$E2/billing/package" "$RC" -d '{"package_id":null}' >/dev/null
V=$(api GET "/inpatient/stays/$E2/billing" "$BL")
chk "პაკეტის მოხსნა → ხაზები ჩვეულებრივად (120 + 30 + 30 = 180)" "$(echo "$V" | jq -r '"\([.lines[]|select(.category=="package")]|length):\(.money.total|tonumber+0)"')" "0:180"

step "7. DRG (თანაგადახდა, ჩამოწერა)"
api POST "/inpatient/stays/$E3/services" "$NA" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}" >/dev/null
chk "DRG ჯგუფის გარეშე → 400" "$(code POST "/inpatient/stays/$E3/payers" "$RC" -d "{\"payer_id\":\"$SSA\"}")" "400"
SP3=$(api POST "/inpatient/stays/$E3/payers" "$RC" -d "{\"payer_id\":\"$SSA\",\"drg_code\":\"$C1\"}" | jq -r '.id // empty')
V=$(api GET "/inpatient/stays/$E3/billing" "$BL")
chk "DRG: ტარიფი 0.1 × 1000 = 100; სახელმწიფო 90; ჩამოწერა 50 (150 − 100); პაციენტი 10" "$(echo "$V" | jq -r '"\(.payers[0].calc.tariff):\(.money.state|tonumber+0):\(.money.writeoff|tonumber+0):\(.money.patient|tonumber+0)"')" "100:90:50:10"
chk "DRG: წონა / განაკვეთი დაფიქსირდა ჩანაწერზე" "$(echo "$V" | jq -r '"\(.payers[0].drg_weight|tonumber+0):\(.payers[0].drg_base_rate|tonumber+0):\(.payers[0].drg_title)"')" "0.1:1000:ტესტ-E2E პნევმონია"
api PATCH "/billing/drg/$C1" "$BL" -d '{"relative_weight":0.2}' >/dev/null
chk "ცნობარში წონის ცვლილება არ ეხება მინიჭებულს" "$(api GET "/inpatient/stays/$E3/billing" "$BL" | jq -r '.payers[0].calc.tariff')" "100"
api PATCH "/inpatient/stay-payers/$SP3" "$BL" -d "{\"drg_code\":\"$C2\"}" >/dev/null
chk "DRG-ის შეცვლა → ახალი წონა (1.9 × 1000), დასაფარამდე 150; პაციენტი 0" "$(api GET "/inpatient/stays/$E3/billing" "$BL" | jq -r '"\(.payers[0].calc.tariff):\(.payers[0].calc.amount):\(.money.patient|tonumber+0)"')" "1900:150:0"

step "8. გაწერა → ფინალიზაცია → გადახდა → გახსნა"
chk "ფინალიზაცია გაწერამდე → 409" "$(code POST "/inpatient/stays/$E1/billing/finalize" "$BL")" "409"
W=$(api GET "/inpatient/stays/$E1/discharge/check" "$DR" | jq -c '.warnings[]|select(.code=="BALANCE")')
chk "გაწერის შემოწმება: დავალიანება 26 ₾ (რბილი შეხსენება)" "$(echo "$W" | jq -r '"\(.soft):\(.message|test("26.00"))"')" "true:true"
mod '{"discharge_balance":"block"}'
chk "discharge_balance=block → დასაბუთების გარეშე 409" "$(api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 33)\",\"$(uid 34)\"]}" | jq -r '.code // .message.code // empty')" "DISCHARGE_WARNINGS"
mod '{"discharge_balance":"warn"}'
R=$(api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 33)\",\"$(uid 34)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" | jq -r '.status // .message')
chk "გაწერა (თვითნებური)" "$R" "discharged"
chk "მიმღები ფინალიზაციას ვერ აკეთებს (403)" "$(code POST "/inpatient/stays/$E1/billing/finalize" "$RC")" "403"
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ფინალიზაცია: დაზღვევა 104, პაციენტი 76, ავანსი 50 მიემართა, დარჩა 26" "$(echo "$F" | jq -r '"\(.money.insurance):\(.money.patient):\(.money.deposit_applied):\(.money.due)"')" "104:76:50:26"
I=$(api GET "/invoices/encounter/$E1" "$BL")
chk "ინვოისი: insurance_share 104, patient_share 76, გადახდა „deposit“ 50" "$(echo "$I" | jq -r '"\(.insurance_share|tonumber+0):\(.patient_share|tonumber+0):\([.payments[]|select(.method=="deposit")][0].amount|tonumber+0)"')" "104:76:50"
chk "ფინალიზებულზე მომსახურება → 409" "$(code POST "/inpatient/stays/$E1/services" "$BL" -d "{\"tariff_id\":\"$T_SRV\",\"quantity\":1}")" "409"
chk "ფინალიზებულზე გადამხდელის ცვლილება → 409" "$(code PATCH "/inpatient/stay-payers/$SP1" "$BL" -d '{"coverage_pct":90}')" "409"
chk "ფინალიზებულზე ფასის შესწორება (ხაზი) → 400 (DB დაცვა)" "$(code PATCH "/invoices/$INV1/lines/$L1" "$BL" -d '{"unit_price":31}')" "400"
chk "გაწერის გაუქმება ფინალიზებულზე → 409" "$(code POST "/inpatient/stays/$E1/discharge/cancel" "$HD" -d '{"reason":"ტესტ-E2E შეცდომა"}')" "409"
chk "სალარო: დარჩენილი 26 ₾ ინვოისზე" "$(api POST "/invoices/$INV1/payments" "$RC" -d '{"amount":26,"method":"cash"}' | jq -r '.paid_status')" "paid"
chk "ხედი: გადასახდელი 0, დასაბრუნებელი 0" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '"\(.money.due|tonumber+0):\(.money.refund_due|tonumber+0):\(.finalized)"')" "0:0:true"
chk "მიმღები ვერ ხსნის (403)" "$(code POST "/inpatient/stays/$E1/billing/reopen" "$RC" -d '{"reason":"ტესტ-E2E შესწორება"}')" "403"
chk "გახსნა (მიზეზით)" "$(api POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}' | jq -r '.finalized')" "false"
I=$(api GET "/invoices/encounter/$E1" "$BL")
chk "გახსნისას: ავანსის მიმართვა მოიხსნა, წილები 0" "$(echo "$I" | jq -r '"\([.payments[]|select(.method=="deposit")]|length):\(.insurance_share|tonumber+0):\(.reopen_count)"')" "0:0:1"
api PATCH "/inpatient/stay-payers/$SP1" "$BL" -d '{"coverage_pct":100}' >/dev/null
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ხელახალი ფინალიზაცია (100%): დაზღვევა 130, პაციენტი 50 (= ავანსი + 26 გადახდილი → დასაბრუნებელი 26)" "$(echo "$F" | jq -r '"\(.money.insurance):\(.money.patient):\(.money.deposit_applied):\(.money.refund_due)"')" "130:50:24:26"
chk "დაბრუნება 26 ₾ (ავანსის გამოუყენებელი ნაწილი)" "$(api POST "/inpatient/stays/$E1/deposits" "$RC" -d '{"kind":"refund","amount":26,"method":"cash"}' | jq -r '.kind')" "refund"
chk "ბალანსი: გადასახდელი 0, დასაბრუნებელი 0" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r '"\(.money.due|tonumber+0):\(.money.refund_due|tonumber+0)"')" "0:0"
chk "ისტორია: ავანსი, დაბრუნება, გაუქმება, ფინალიზაცია, გახსნა" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(test("^(deposit|billing_)"))]|unique|join(",")')" "billing_finalized,billing_reopened,deposit,deposit_refund,deposit_voided"

step "9. PDF, სამუშაო სია, რეპორტი, რეესტრი"
chk "კალკულაცია PDF (ბილინგი)" "$(curl -s -o "$TMP/c.pdf" -w '%{http_code}:%{content_type}' "$B/inpatient/stays/$E1/billing/pdf" -H "authorization: Bearer $BL")" "200:application/pdf"
chk "კალკულაცია PDF — ექთანი (თანხები დამალულია) → 403" "$(code GET "/inpatient/stays/$E1/billing/pdf" "$NA")" "403"
chk "ქვითარი PDF" "$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B/inpatient/deposits/$DP1/receipt" -H "authorization: Bearer $RC")" "200:application/pdf"
chk "სამუშაო სია (აქტიური): E2, E3" "$(api GET '/inpatient/billing/worklist?status=active' "$BL" | jq -r --arg a "$E2" --arg b "$E3" '[.[]|select(.encounter_id==$a or .encounter_id==$b)]|length')" "2"
chk "სამუშაო სია (ფინალიზებული): E1, გადამხდელით" "$(api GET '/inpatient/billing/worklist?status=finalized' "$BL" | jq -r --arg a "$E1" '.[]|select(.encounter_id==$a)|.payer_names|join(",")')" "ტესტ-E2E დაზღვევა"
R=$(api GET "/inpatient/billing/report?from=$TODAY&to=$TODAY" "$BL")
chk "რეპორტი: განყოფილება A — 1 შემთხვევა, ჯამი 180, გადამხდელი 130" "$(echo "$R" | jq -r --arg d "ტესტ-E2E ბილინგი თერაპია $S" '.departments[]|select(.department==$d)|"\(.stays):\(.total|tonumber+0):\(.covered|tonumber+0)"')" "1:180:130"
chk "რეპორტი: გადამხდელის მიხედვით" "$(echo "$R" | jq -r --arg p "$INS" '.payers[]|select(.payer_id==$p)|.covered|tonumber+0')" "130"
CSVR=$(curl -s "$B/inpatient/billing/register/$INS?from=$TODAY&to=$TODAY" -H "authorization: Bearer $BL")
chk "რეესტრი (CSV): საგარანტიო № და თანხა" "$(echo "$CSVR" | grep -c "G-$S.*;130.00;50.00")" "1"
chk "რეესტრი — მიმღები → 403" "$(code GET "/inpatient/billing/register/$INS?from=$TODAY&to=$TODAY" "$RC")" "403"

step "10. აღდგენა"
for E in "$E2" "$E3"; do api POST "/inpatient/stays/$E/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 33)\",\"$(uid 34)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null; done
api DELETE "/billing/bed-tariffs/$BTA" "$BL" >/dev/null
if [ -n "$OLDGEN" ]; then api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"standard\",\"tariff_id\":\"$OLDGEN\"}" >/dev/null
else api DELETE "/billing/bed-tariffs/$(api GET /billing/bed-tariffs "$ADM" | jq -r '[.[]|select(.bed_type_code=="standard" and .department_id==null)][0].id')" "$ADM" >/dev/null; fi
api PATCH "/tariffs/$T_STD" "$ADM" -d '{"is_active":false}' >/dev/null
for p in "$INS" "$SSA"; do api PATCH "/billing/payers/$p" "$BL" -d '{"is_active":false}' >/dev/null; done
for p in "$PK" "$PB"; do api PATCH "/billing/packages/$p" "$BL" -d '{"is_active":false}' >/dev/null; done
for c in "$C1" "$C2"; do api PATCH "/billing/drg/$c" "$BL" -d '{"is_active":false}' >/dev/null; done
for t in "$T_STDA" "$T_EXTRA" "$T_SRV"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
ok "გადამხდელები / პაკეტი / DRG / ტარიფები გაითიშა, საწოლდღის ტარიფები და პარამეტრები აღდგა"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
