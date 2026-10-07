#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-mar.sh — სტაციონარი, ეტაპი 0043: MAR (მედიკამენტების მიღების ფურცელი)
#   0. მომზადება: განყოფილება + ქვესაწყობი (მარაგით), ექთნები, ექიმი, ფარმაცევტი, ჯენერიკები / SKU / შტრიხკოდი, დანიშნულებები
#   1. განრიგი, უფლებები           2. მიცემა: ავტოჩამოწერა, დროის ფანჯარა, გადადება     3. შტრიხკოდი (სამაჯური / GS1)
#   4. გაუქმება (მარაგი ბრუნდება)    5. high-alert: ვერიფიკაციის მოლოდინი, მეორე ექთანი      6. PRN კონტროლირებადი: მოწმე, ნარჩენი, ლიმიტები
#   7. რამდენიმე SKU, ნაშთის გარეშე    8. ინფუზია                                            9. მოვლის დავალება, ერთჯერადი, უარყოფილი
#  10. შეჩერება / განახლება, დროებითი გასვლა                                             11. განყოფილების ეკრანი, გაწერა, აღდგენა
# გამოყენება:  bash scripts/e2e-ipd-mar.sh [API_URL]
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
wit() { echo "{\"username\":\"e2e.mar.$1.$S@test.local\",\"password\":\"${2:-E2e-$S-pass-$1}\"}"; }
bal() { api GET "/stock/balances?location_id=$1&item_id=$2" "$ADM" | jq -r '([.rows[].qty|tonumber]|add // 0) + 0'; }
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F)

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E MAR თერაპია $S\",\"code\":\"E2EMA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E MAR ქირურგია $S\",\"code\":\"E2EMB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
PHL=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EMP$S\",\"name\":\"ტესტ-E2E MAR აფთიაქი $S\",\"kind\":\"pharmacy\"}" | jq -r '.id // empty')
LOC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EML$S\",\"name\":\"ტესტ-E2E MAR ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DA\",\"requires_approval\":false}" | jq -r '.id // empty')
[ -n "$PHL" ] && [ -n "$LOC" ] && ok "განყოფილებები, აფთიაქი, ქვესაწყობი" || die "ლოკაციები ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.mar.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"MAR-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.mar.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 61)
NA=$(mkuser '["nurse"]' 62 ",\"department_id\":\"$DA\"")
NB=$(mkuser '["nurse"]' 63 ",\"department_id\":\"$DA\"")                      # მეორე ექთანი / მოწმე
DR=$(mkuser '["doctor"]' 64 ",\"department_id\":\"$DA\"")
NX=$(mkuser '["nurse"]' 65 ",\"department_id\":\"$DB\"")                      # სხვა განყოფილება
PH=$(mkuser '["pharmacist"]' 66)
for t in RC NA NB DR NX PH; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები (რეგისტრატორი, 2 ექთანი A, ექიმი A, ექთანი B, ფარმაცევტი)"
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"91$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"MAR\",\"birth_date\":\"1965-04-04\",\"gender\":\"male\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] || die "პაციენტი ვერ შეიქმნა"

ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"med_verification":"high_risk","mar_window_min":60,"mar_barcode":"optional","mar_stock_deduct":true,"mar_allow_no_stock":false,"mar_double_check":true}'
gen() { api POST /pharmacy/generics "$ADM" -d "$1" | jq -r '.id // empty'; }
G_CEF=$(gen "{\"inn\":\"ტესტ-E2E MAR ცეფაზოლინი $S\",\"atc_code\":\"J01DB04\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"dose_per_unit\":1000,\"routes\":[\"IV\",\"IM\"]}")
G_WAR=$(gen "{\"inn\":\"ტესტ-E2E MAR ჰეპარინი $S\",\"atc_code\":\"B01AB01\",\"form_code\":\"INJ_SOL\",\"strength\":\"5000 ერთ.\",\"dose_unit\":\"IU\",\"dose_per_unit\":5000,\"routes\":[\"SC\",\"IV\"],\"high_alert\":true}")
G_MOR=$(gen "{\"inn\":\"ტესტ-E2E MAR მორფინი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ/მლ\",\"controlled_class\":\"narcotic\",\"dose_unit\":\"mg\",\"dose_per_unit\":10,\"routes\":[\"IV\",\"SC\"]}")
G_PAR=$(gen "{\"inn\":\"ტესტ-E2E MAR პარაცეტამოლი $S\",\"atc_code\":\"N02BE01\",\"form_code\":\"TAB\",\"strength\":\"500 მგ\",\"dose_unit\":\"mg\",\"dose_per_unit\":500,\"routes\":[\"PO\"]}")
G_NOS=$(gen "{\"inn\":\"ტესტ-E2E MAR ომეპრაზოლი $S\",\"atc_code\":\"A02BC01\",\"form_code\":\"CAP\",\"strength\":\"20 მგ\",\"dose_unit\":\"mg\",\"dose_per_unit\":20,\"routes\":[\"PO\"]}")
G_NS=$(gen "{\"inn\":\"ტესტ-E2E MAR ნატრიუმის ქლორიდი 0.9% $S\",\"form_code\":\"INF_SOL\",\"strength\":\"500 მლ\",\"routes\":[\"IV\"]}")
for g in G_CEF G_WAR G_MOR G_PAR G_NOS G_NS; do [ -n "${!g}" ] || die "ჯენერიკი $g ვერ შეიქმნა"; done
CAT=$(api GET /stock/refs "$ADM" | jq -r '.categories[]|select(.kind=="medication")|.id' | head -1)
EAN="$(printf '29%011d' "$S")"; EAN2="$(printf '28%011d' "$S")"
item() { api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E MAR $1 $S\",\"category_id\":\"$CAT\",\"generic_id\":\"$2\",\"base_unit\":\"$3\"${4:-}}" | jq -r '.id // empty'; }
IT_CEF=$(item "Cefazolin 1g" "$G_CEF" vial ",\"barcodes\":[{\"barcode\":\"$EAN\"}]")
IT_WAR=$(item "Heparin 5000" "$G_WAR" ampoule ",\"barcodes\":[{\"barcode\":\"$EAN2\"}]")
IT_MOR=$(item "Morphini 1%" "$G_MOR" ampoule); IT_PA1=$(item "Paracetamol A" "$G_PAR" tablet); IT_PA2=$(item "Paracetamol B" "$G_PAR" tablet)
IT_NOS=$(item "Omeprazole" "$G_NOS" capsule); IT_NS=$(item "NaCl 0.9% 500ml" "$G_NS" bottle)
for i in IT_CEF IT_WAR IT_MOR IT_PA1 IT_PA2 IT_NOS IT_NS; do [ -n "${!i}" ] || die "SKU $i ვერ შეიქმნა"; done
ln() { echo "{\"item_id\":\"$1\",\"qty\":$2,\"lot_no\":\"$3$S\",\"expires_on\":\"$D2Y\",\"price\":1,\"vat_rate\":0}"; }
RCP=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$PHL\",\"lines\":[$(ln "$IT_CEF" 10 C),$(ln "$IT_WAR" 10 H),$(ln "$IT_MOR" 10 M),$(ln "$IT_PA1" 20 PA),$(ln "$IT_PA2" 20 PB),$(ln "$IT_NS" 10 N)]}" | jq -r '.id // empty')
api POST "/stock/receipts/$RCP/post" "$ADM" >/dev/null
LINES=$(for i in "$IT_CEF" "$IT_WAR" "$IT_MOR" "$IT_PA1" "$IT_PA2" "$IT_NS"; do api GET "/stock/items/$i/lots" "$ADM" | jq -c '{lot_id:.[0].id, qty_base:5}'; done | jq -sc .)
TR=$(api POST /stock/transfers "$ADM" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$LOC\",\"lines\":$LINES}" | jq -r '.id // empty')
api POST "/stock/docs/$TR/receive" "$NA" -d '{"action":"receive"}' >/dev/null
chk "ქვესაწყობი: 6 SKU × 5 (ომეპრაზოლი — ნაშთის გარეშე)" "$(bal "$LOC" "$IT_CEF"):$(bal "$LOC" "$IT_MOR"):$(bal "$LOC" "$IT_NOS")" "5:5:0"
E1=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 64)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
[ -n "$E1" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
ADMNO=$(api GET "/inpatient/stays/$E1" "$NA" | jq -r '.stay.adm_no // .adm_no')
OR="/inpatient/stays/$E1/orders"
ord() { api POST "$OR" "$DR" -d "$1" | jq -r '.id // empty'; }
O_CEF=$(ord "{\"category\":\"medication\",\"generic_id\":\"$G_CEF\",\"order_type\":\"scheduled\",\"dose\":1000,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"frequency_code\":\"Q8H\",\"duration_days\":3}")
O_HEP=$(ord "{\"category\":\"medication\",\"generic_id\":\"$G_WAR\",\"order_type\":\"scheduled\",\"dose\":5000,\"dose_unit\":\"IU\",\"route_code\":\"SC\",\"frequency_code\":\"Q12H\",\"duration_days\":3}")
O_MOR=$(ord "{\"category\":\"medication\",\"generic_id\":\"$G_MOR\",\"order_type\":\"prn\",\"dose\":5,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"prn_reason\":\"ტკივილი > 6\",\"prn_max_per_day\":2,\"prn_min_interval_h\":4}")
O_PAR=$(ord "{\"category\":\"medication\",\"generic_id\":\"$G_PAR\",\"order_type\":\"prn\",\"dose\":500,\"dose_unit\":\"mg\",\"route_code\":\"PO\",\"prn_reason\":\"ცხელება > 38.5\",\"prn_max_per_day\":4}")
O_NOS=$(ord "{\"category\":\"medication\",\"generic_id\":\"$G_NOS\",\"order_type\":\"prn\",\"dose\":20,\"dose_unit\":\"mg\",\"route_code\":\"PO\",\"prn_reason\":\"გულძმარვა\"}")
O_NS=$(ord "{\"category\":\"medication\",\"generic_id\":\"$G_NS\",\"order_type\":\"continuous\",\"route_code\":\"IV\",\"rate_ml_h\":80,\"duration_days\":1}")
O_NUR=$(ord '{"category":"nursing","text":"ტესტ-E2E ჭრილობის შეხვევა","frequency_code":"Q12H"}')
O_OWN=$(api POST "$OR" "$DR" -d '{"category":"medication","drug_text":"ტესტ-E2E საკუთარი წამალი","order_type":"once","dose":1,"dose_unit":"tab","route_code":"PO","override_reason":"ტესტ-E2E"}' | jq -r '.id // empty')
O_REJ=$(api POST "$OR" "$DR" -d '{"category":"medication","drug_text":"ტესტ-E2E გაურკვეველი წამალი","order_type":"once","dose":1,"dose_unit":"tab","route_code":"PO","override_reason":"ტესტ-E2E"}' | jq -r '.id // empty')
for o in O_CEF O_HEP O_MOR O_PAR O_NOS O_NS O_NUR O_OWN O_REJ; do [ -n "${!o}" ] || die "დანიშნულება $o ვერ შეიქმნა"; done
ok "9 დანიშნულება (გეგმიური ×2, PRN ×3, ინფუზია, მოვლა, ერთჯერადი ×2)"

step "1. განრიგი, უფლებები"
M="/inpatient/stays/$E1/mar"
R=$(api GET "$M" "$NA")
slot() { echo "$R" | jq -r --arg o "$1" "[.entries[]|select(.order_id==\$o and .status==\"${3:-due}\")]|sort_by(.scheduled_at)|.[${2:-0}].id // empty"; }
chk "დღის ბადე: can_document; ცეფაზოლინი (Q8H) პირველი სლოტი ახლა; მოვლა — სლოტი; PRN — სლოტების გარეშე" \
  "$(echo "$R" | jq -r --arg c "$O_CEF" --arg n "$O_NUR" --arg m "$O_MOR" '"\(.can_document):\([.entries[]|select(.order_id==$c)]|length>=1):\([.entries[]|select(.order_id==$n)]|length>=1):\([.entries[]|select(.order_id==$m)]|length)"')" "true:true:true:0"
chk "ორდერების სიაში PRN / ინფუზია / მოვლა" "$(echo "$R" | jq -r '[.orders[].order_type]|(index("prn")!=null) and (index("continuous")!=null)')" "true"
S_CEF0=$(slot "$O_CEF"); S_OWN=$(slot "$O_OWN"); S_REJ=$(slot "$O_REJ"); S_NUR=$(slot "$O_NUR"); S_HEP=$(slot "$O_HEP")
[ -n "$S_CEF0" ] && [ -n "$S_OWN" ] && [ -n "$S_NUR" ] && [ -n "$S_HEP" ] && ok "სლოტები: ცეფაზოლინი, ჰეპარინი, ერთჯერადი, მოვლა" || bad "სლოტები" "$(echo "$R" | jq -c '[.entries[]|{order_id,scheduled_at,status}]')"
R2=$(api GET "/inpatient/stays/$E1/mar?day=$(date -d "$TODAY +1 day" +%F)" "$NA")
chk "ხვალინდელი დღე — ცეფაზოლინის 3 სლოტი (Q8H, 48 სთ წინ)" "$(echo "$R2" | jq -r --arg c "$O_CEF" '[.entries[]|select(.order_id==$c)]|length')" "3"
chk "იგივე GET ორჯერ — დუბლიკატი არ ჩნდება" "$(api GET "$M" "$NA" | jq -r --arg c "$O_CEF" '[.entries[]|select(.order_id==$c)]|length'):$(api GET "$M" "$NA" | jq -r --arg c "$O_CEF" '[.entries[]|select(.order_id==$c)]|length')" \
  "$(echo "$R" | jq -r --arg c "$O_CEF" '[.entries[]|select(.order_id==$c)]|length'):$(echo "$R" | jq -r --arg c "$O_CEF" '[.entries[]|select(.order_id==$c)]|length')"
chk "რეგისტრატორი — 403; სხვა განყოფილების ექთანი: ხედავს, can_document=false, ჩაწერა — 403" \
  "$(code GET "$M" "$RC"):$(api GET "$M" "$NX" | jq -r .can_document):$(code POST "/inpatient/mar/$S_CEF0/document" "$NX" -d '{"outcome":"given"}')" "403:false:403"
chk "მიზეზის გარეშე უარი — 400; არასწორი შედეგი — 400" "$(code POST "/inpatient/mar/$S_CEF0/document" "$NA" -d '{"outcome":"refused"}'):$(code POST "/inpatient/mar/$S_CEF0/document" "$NA" -d '{"outcome":"done"}')" "400:400"

step "2. მიცემა: ავტოჩამოწერა, დროის ფანჯარა, გადადება"
R=$(api POST "/inpatient/mar/$S_CEF0/document" "$NA" -d '{"outcome":"given","site":"მარცხენა მხარი"}')
chk "მიცემულია: დოზა 1000 mg, დროულად, ჩამოწერა CN (1 ფლაკონი, ერთადერთი SKU)" \
  "$(echo "$R" | jq -r '"\(.status):\((.dose_given|tonumber)+0)\(.dose_unit):\(.timing):\(.stock_doc_no|test("^CN")):\((.qty_base|tonumber)+0):\(.documented_by_name!=null)"')" "given:1000mg:on_time:true:1:true"
chk "ქვესაწყობი: ცეფაზოლინი 5 → 4" "$(bal "$LOC" "$IT_CEF")" "4"
R=$(api GET "$M" "$NA"); S_CEF1=$(slot "$O_CEF" 0)
chk "ხელახლა — 409; ნაწილობრივი დოზით (≥ დანიშნული) — 400" "$(code POST "/inpatient/mar/$S_CEF0/document" "$NA" -d '{"outcome":"given"}'):$(code POST "/inpatient/mar/$S_CEF1/document" "$NA" -d '{"outcome":"partial","dose":1000,"reason":"ტესტ"}')" "409:400"
R=$(api POST "/inpatient/mar/$S_CEF1/document" "$NA" -d '{"outcome":"given"}')
chk "შემდეგი დოზა (+8 სთ) ახლა — 409 MAR_CHECKS (timing_early)" "$(echo "$R" | jq -r '"\(.code):\([.checks[].code]|join(","))"')" "MAR_CHECKS:timing_early"
IN1H=$(date -u -d '+1 hour' +%FT%TZ)
R=$(api POST "/inpatient/mar/$S_CEF1/document" "$NA" -d "{\"outcome\":\"held\",\"reason\":\"ტესტ-E2E პაციენტი გამოკვლევაზეა\",\"postponed_to\":\"$IN1H\"}")
chk "გადადებულია +1 სთ-ით (მიზეზით), ჩამოწერის გარეშე" "$(echo "$R" | jq -r '"\(.status):\(.postponed_to!=null):\(.stock_doc_id)"')" "held:true:null"
R=$(api GET "$M" "$NA")
S_POST=$(echo "$R" | jq -r --arg o "$O_CEF" '[.entries[]|select(.order_id==$o and .source=="postponed" and .status=="due")][0].id // empty')
[ -n "$S_POST" ] && ok "ახალი სლოტი (postponed)" || bad "ახალი სლოტი (postponed)"
chk "გადადება წარსულში — 400" "$(code POST "/inpatient/mar/$S_POST/document" "$NA" -d "{\"outcome\":\"held\",\"reason\":\"ტესტ\",\"postponed_to\":\"$(date -u -d '-1 hour' +%FT%TZ)\"}")" "400"

step "3. შტრიხკოდი"
DOC="/inpatient/mar/$S_POST/document"
chk "სხვა პაციენტის სამაჯური — 422 MAR_WRONG_PATIENT" "$(api POST "$DOC" "$NA" -d '{"outcome":"given","scanned_patient":"H-000000"}' | jq -r .code)" "MAR_WRONG_PATIENT"
chk "ჰეპარინის შეფუთვა ცეფაზოლინზე — 422 MAR_WRONG_DRUG; უცნობი — MAR_UNKNOWN_BARCODE" \
  "$(api POST "$DOC" "$NA" -d "{\"outcome\":\"given\",\"scanned_patient\":\"$ADMNO\",\"scanned_barcode\":\"$EAN2\"}" | jq -r .code):$(api POST "$DOC" "$NA" -d '{"outcome":"given","scanned_barcode":"4000000000017"}' | jq -r .code)" "MAR_WRONG_DRUG:MAR_UNKNOWN_BARCODE"
mod '{"mar_barcode":"required"}'
chk "სავალდებულო რეჟიმი, სკანირების გარეშე — 422 MAR_SCAN_REQUIRED" "$(api POST "$DOC" "$NA" -d '{"outcome":"given"}' | jq -r .code)" "MAR_SCAN_REQUIRED"
R=$(api POST "$DOC" "$NA" -d "{\"outcome\":\"given\",\"scanned_patient\":\"$ADMNO\",\"scanned_barcode\":\"(01)0$EAN(10)C$S\"}")
chk "GS1 (GTIN + ლოტი) + სამაჯური → მიცემულია, scanned ×2, ჩამოწერა" "$(echo "$R" | jq -r '"\(.status):\(.scanned_patient):\(.scanned_med):\(.stock_doc_id!=null)"')" "given:true:true:true"
mod '{"mar_barcode":"optional"}'

step "4. გაუქმება"
chk "მიზეზის გარეშე — 400; სხვა განყოფილების ექთანი — 403" "$(code POST "/inpatient/mar/$S_CEF0/void" "$NA" -d '{}'):$(code POST "/inpatient/mar/$S_CEF0/void" "$NX" -d '{"reason":"ტესტ-E2E"}')" "400:403"
R=$(api POST "/inpatient/mar/$S_CEF0/void" "$NB" -d '{"reason":"ტესტ-E2E: შეცდომით ჩაიწერა"}')
chk "გაუქმდა (მეორე ექთანი): voided, შემობრუნება; ქვესაწყობი 3 → 4" "$(echo "$R" | jq -r '"\(.voided_at!=null):\(.void_stock_doc_id!=null):\(.voided_by_name!=null)"'):$(bal "$LOC" "$IT_CEF")" "true:true:true:4"
R=$(api GET "$M" "$NA")
chk "სლოტი თავიდან ღიაა (due, იგივე დრო); მეორედ გაუქმება — 404" \
  "$(echo "$R" | jq -r --arg o "$O_CEF" --arg v "$S_CEF0" '([.entries[]|select(.id==$v)][0].scheduled_at) as $t | [.entries[]|select(.order_id==$o and .status=="due" and .scheduled_at==$t)]|length'):$(code POST "/inpatient/mar/$S_CEF0/void" "$NA" -d '{"reason":"ტესტ-E2E"}')" "1:404"
chk "გაუქმებული ჩანაწერი ბადეში ჩანს (voided_at)" "$(echo "$R" | jq -r --arg v "$S_CEF0" '[.entries[]|select(.id==$v and .voided_at!=null)]|length')" "1"
chk "დანიშნულების ისტორია: administered" "$(api GET "/inpatient/orders/$O_CEF" "$NA" | jq -r '[.events[].kind]|index("administered")!=null')" "true"

step "5. high-alert: ვერიფიკაცია, მეორე ექთანი"
D5="/inpatient/mar/$S_HEP/document"
R=$(api POST "$D5" "$NA" -d '{"outcome":"given"}')
chk "ვერიფიკაციის მოლოდინში — 409 MAR_CHECKS (verify_pending)" "$(echo "$R" | jq -r '"\(.code):\([.checks[].code]|index("verify_pending")!=null)"')" "MAR_CHECKS:true"
chk "მიზეზით, მეორე ექთნის გარეშე — 422 MAR_DOUBLE_CHECK" "$(api POST "$D5" "$NA" -d '{"outcome":"given","override_reason":"ტესტ-E2E: ღამე, ფარმაცევტი არ არის"}' | jq -r .code)" "MAR_DOUBLE_CHECK"
chk "არასწორი პაროლი — 400; საკუთარი თავი — 400; რეგისტრატორი — 403" \
  "$(code POST "$D5" "$NA" -d "{\"outcome\":\"given\",\"override_reason\":\"ტესტ-E2E\",\"double_check\":$(wit 63 wrong-pass)}"):$(code POST "$D5" "$NA" -d "{\"outcome\":\"given\",\"override_reason\":\"ტესტ-E2E\",\"double_check\":$(wit 62)}"):$(code POST "$D5" "$NA" -d "{\"outcome\":\"given\",\"override_reason\":\"ტესტ-E2E\",\"double_check\":$(wit 61)}")" "400:400:403"
R=$(api POST "$D5" "$NA" -d "{\"outcome\":\"given\",\"override_reason\":\"ტესტ-E2E: ღამე, ფარმაცევტი არ არის\",\"double_check\":$(wit 63)}")
chk "მეორე ექთნით → მიცემულია; double_check_name, override, warnings" "$(echo "$R" | jq -r '"\(.status):\(.double_check_name|test("MAR-63")):\(.override_reason!=null):\(.warnings|length)"')" "given:true:true:1"
chk "აუდიტში პაროლი არ ინახება" "$(api GET "/audit-logs?entity_name=mar_entries&entity_id=$S_HEP" "$ADM" | jq -r 'tostring|test("E2e-")')" "false"

step "6. PRN კონტროლირებადი: მოწმე, ნარჩენი, ლიმიტები"
api POST "/pharmacy/verification/$O_MOR/verify" "$PH" -d '{}' >/dev/null
AD="/inpatient/orders/$O_MOR/administer"
chk "გეგმიურზე administer — 400; მოწმის გარეშე — 400" "$(code POST "/inpatient/orders/$O_CEF/administer" "$NA" -d '{"outcome":"given"}'):$(code POST "$AD" "$NA" -d '{"outcome":"given"}')" "400:400"
R=$(api POST "$AD" "$NA" -d "{\"outcome\":\"given\",\"witness\":$(wit 63)}")
chk "მორფინი 5 მგ მოწმით: 1 ამპულა, witness_name, PRN" "$(echo "$R" | jq -r '"\(.status):\(.source):\((.qty_base|tonumber)+0):\(.witness_name|test("MAR-63"))"'):$(bal "$LOC" "$IT_MOR")" "given:prn:1:true:4"
R=$(api POST "$AD" "$NA" -d "{\"outcome\":\"given\",\"witness\":$(wit 63)}")
chk "მეორე დოზა მაშინვე — 409 MAR_CHECKS (prn_interval)" "$(echo "$R" | jq -r '"\(.code):\([.checks[].code]|join(","))"')" "MAR_CHECKS:prn_interval"
api POST "$AD" "$NA" -d "{\"outcome\":\"given\",\"witness\":$(wit 63),\"override_reason\":\"ტესტ-E2E: ექიმის ზეპირი მითითებით\"}" >/dev/null
chk "მესამე — prn_max + prn_interval" "$(api POST "$AD" "$NA" -d "{\"outcome\":\"given\",\"witness\":$(wit 63)}" | jq -r '[.checks[].code]|sort|join(",")')" "prn_interval,prn_max"
CN=$(api GET "$M" "$NA" | jq -r --arg o "$O_MOR" '[.entries[]|select(.order_id==$o)][0].stock_doc_id')
chk "ხარჯის დოკუმენტი: დოზა 5 + ნარჩენი 5 mg" "$(api GET "/stock/docs/$CN" "$ADM" | jq -r '.lines[0]|"\((.dose_given|tonumber)+0)+\((.dose_wasted|tonumber)+0)"')" "5+5"

step "7. რამდენიმე SKU, ნაშთის გარეშე"
R=$(api POST "/inpatient/orders/$O_PAR/administer" "$NA" -d '{"outcome":"given"}')
chk "2 SKU ნაშთით — 409 MAR_ITEM_REQUIRED (კანდიდატები, რაოდენობა 1)" "$(echo "$R" | jq -r '"\(.code):\(.items|length):\(.qty_suggest)"')" "MAR_ITEM_REQUIRED:2:1"
chk "საქონლის ნაშთი (GET orders/:id/stock)" "$(api GET "/inpatient/orders/$O_PAR/stock" "$NA" | jq -r '[.items[].available]|add')" "10"
R=$(api POST "/inpatient/orders/$O_PAR/administer" "$NA" -d "{\"outcome\":\"given\",\"item_id\":\"$IT_PA2\",\"qty_base\":2,\"dose\":1000}")
chk "არჩეული SKU, 2 ტაბ. (დოზა 1000 > 500 → dose_over → 409)" "$(echo "$R" | jq -r .code)" "MAR_CHECKS"
R=$(api POST "/inpatient/orders/$O_PAR/administer" "$NA" -d "{\"outcome\":\"given\",\"item_id\":\"$IT_PA2\"}")
chk "არჩეული SKU → 1 ტაბ.; B: 5 → 4" "$(echo "$R" | jq -r '"\(.status):\(.stock_item_name|test("Paracetamol B"))"'):$(bal "$LOC" "$IT_PA2")" "given:true:4"
chk "ნაშთი არ არის — 409 MAR_NO_STOCK" "$(api POST "/inpatient/orders/$O_NOS/administer" "$NA" -d '{"outcome":"given"}' | jq -r .code)" "MAR_NO_STOCK"
mod '{"mar_allow_no_stock":true}'
chk "დაშვებულია — 409 MAR_CHECKS (no_stock)" "$(api POST "/inpatient/orders/$O_NOS/administer" "$NA" -d '{"outcome":"given"}' | jq -r '[.checks[].code]|join(",")')" "no_stock"
chk "მიზეზით → given, no_stock, ჩამოწერის გარეშე" "$(api POST "/inpatient/orders/$O_NOS/administer" "$NA" -d '{"outcome":"given","override_reason":"ტესტ-E2E: პაციენტის საკუთარი შეფუთვა"}' | jq -r '"\(.status):\(.no_stock):\(.stock_doc_id)"')" "given:true:null"
mod '{"mar_allow_no_stock":false}'

step "8. ინფუზია"
AI="/inpatient/orders/$O_NS/administer"
chk "მოქმედების გარეშე — 400" "$(code POST "$AI" "$NA" -d '{"outcome":"given"}')" "400"
R=$(api POST "$AI" "$NA" -d '{"outcome":"given","infusion_action":"start"}')
chk "დაწყება 80 მლ/სთ → ჩამოწერა (1 ფლაკონი)" "$(echo "$R" | jq -r '"\(.source):\(.infusion_action):\((.rate_ml_h|tonumber)+0):\(.stock_doc_id!=null)"'):$(bal "$LOC" "$IT_NS")" "infusion:start:80:true:4"
R=$(api POST "$AI" "$NA" -d '{"outcome":"given","infusion_action":"rate","rate_ml_h":120}')
chk "სიჩქარე 120 — ჩამოწერის გარეშე" "$(echo "$R" | jq -r '"\((.rate_ml_h|tonumber)+0):\(.stock_doc_id)"'):$(bal "$LOC" "$IT_NS")" "120:null:4"
api POST "$AI" "$NA" -d '{"outcome":"given","infusion_action":"bag"}' >/dev/null
chk "ახალი ფლაკონი → ჩამოწერა (3); ბადეში infusion_state = bag" "$(bal "$LOC" "$IT_NS"):$(api GET "$M" "$NA" | jq -r --arg o "$O_NS" '.orders[]|select(.id==$o)|.infusion_state')" "3:bag"
api POST "$AI" "$NA" -d '{"outcome":"given","infusion_action":"stop"}' >/dev/null
chk "დასრულება → დანიშნულება completed" "$(api GET "/inpatient/orders/$O_NS" "$NA" | jq -r '.status // .order.status')" "completed"

step "9. მოვლის დავალება, ერთჯერადი, უარყოფილი"
chk "მოვლა: შესრულდა (დოზის გარეშე)" "$(api POST "/inpatient/mar/$S_NUR/document" "$NA" -d '{"outcome":"given"}' | jq -r '"\(.status):\(.dose_given):\(.stock_doc_id)"')" "given:null:null"
R=$(api POST "/inpatient/mar/$S_OWN/document" "$NA" -d '{"outcome":"given"}')
chk "კატალოგის გარეშე, ვერიფიკაციის მოლოდინში — მიზეზი" "$(echo "$R" | jq -r '[.checks[].code]|join(",")')" "verify_pending"
R=$(api POST "/inpatient/mar/$S_OWN/document" "$NA" -d '{"outcome":"given","override_reason":"ტესტ-E2E: პაციენტის საკუთარი, ექიმთან შეთანხმებით"}')
chk "მიცემულია ჩამოწერის გარეშე; ერთჯერადი → completed" "$(echo "$R" | jq -r '"\(.status):\(.stock_doc_id)"'):$(api GET "/inpatient/orders/$O_OWN" "$NA" | jq -r '.status // .order.status')" "given:null:completed"
api POST "/pharmacy/verification/$O_REJ/reject" "$PH" -d '{"note":"ტესტ-E2E: დაზუსტდეს"}' >/dev/null
chk "ფარმაცევტმა უარყო — 422 MAR_BLOCKED (მიზეზითაც); უარი (refused) — დაშვებულია" \
  "$(api POST "/inpatient/mar/$S_REJ/document" "$NA" -d '{"outcome":"given","override_reason":"ტესტ-E2E"}' | jq -r .code):$(api POST "/inpatient/mar/$S_REJ/document" "$NA" -d '{"outcome":"not_given","reason":"ტესტ-E2E: უარყოფილია ფარმაცევტის მიერ"}' | jq -r .status)" "MAR_BLOCKED:not_given"

step "10. შეჩერება / განახლება, დროებითი გასვლა"
api POST "/inpatient/orders/$O_CEF/hold" "$DR" -d '{"reason":"ტესტ-E2E ოპერაციის წინ"}' >/dev/null
R=$(api GET "$M" "$NA")
chk "შეჩერებისას ღია სლოტები → cancelled; ჩაწერა — 409" "$(echo "$R" | jq -r --arg o "$O_CEF" '[.entries[]|select(.order_id==$o and .status=="due")]|length'):$(code POST "/inpatient/mar/$(slot "$O_CEF" 0 cancelled)/document" "$NA" -d '{"outcome":"given"}')" "0:409"
api POST "/inpatient/orders/$O_CEF/resume" "$DR" -d '{}' >/dev/null
R=$(api GET "$M" "$NA")
chk "განახლებისას სლოტები ისევ due" "$(echo "$R" | jq -r --arg o "$O_CEF" '[.entries[]|select(.order_id==$o and .status=="due")]|length>0')" "true"
api POST "/inpatient/stays/$E1/leave" "$NA" -d "{\"expected_return_at\":\"$(date -u -d '+2 hours' +%FT%TZ)\",\"reason\":\"ტესტ-E2E ოჯახური\",\"permitted_by\":\"$(uid 64)\"}" >/dev/null
chk "დროებით გასულზე მიცემა — 409; „არ მიეცა“ მიზეზით — OK" "$(code POST "/inpatient/mar/$(slot "$O_CEF" 0)/document" "$NA" -d '{"outcome":"given"}'):$(api POST "/inpatient/mar/$(slot "$O_CEF" 0)/document" "$NA" -d '{"outcome":"not_given","reason":"პაციენტი დროებით გასულია"}' | jq -r .status)" "409:not_given"
api POST "/inpatient/stays/$E1/leave/return" "$NA" >/dev/null

step "11. განყოფილების ეკრანი, გაწერა"
R=$(api GET "/inpatient/departments/$DA/mar?hours=12" "$NA")
chk "ექთნის ეკრანი: პაციენტი, სლოტები ≤ 12 სთ, PRN (3 → აქტიური), can_document" \
  "$(echo "$R" | jq -r --arg e "$E1" '.patients[]|select(.encounter_id==$e)|"\(.adm_no!=null):\(.entries|length>0):\(.prn|length):\(.infusions|length)"'):$(echo "$R" | jq -r .can_document)" "true:true:3:0:true"
chk "სხვა განყოფილების ექთანი: can_document=false" "$(api GET "/inpatient/departments/$DA/mar" "$NX" | jq -r .can_document)" "false"
R=$(api GET "/inpatient/stays/$E1/discharge/check" "$DR")
chk "გაწერის შემოწმება მუშაობს (MAR — ვადაგადაცილებული არ არის)" "$(echo "$R" | jq -r '[.warnings[].code]|index("MAR_MISSED")==null')" "true"
api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 62)\",\"$(uid 63)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
R=$(api GET "$M" "$NA")
chk "გაწერის შემდეგ: ღია სლოტები cancelled, can_document=false" "$(echo "$R" | jq -r '"\([.entries[]|select(.status=="due")]|length):\(.can_document)"')" "0:false"

step "12. აღდგენა"
for g in "$G_CEF" "$G_WAR" "$G_MOR" "$G_PAR" "$G_NOS" "$G_NS"; do api PATCH "/pharmacy/generics/$g" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
ok "პარამეტრები აღდგენილია; სატესტო ჯენერიკები გათიშულია (ქვესაწყობში მორფინის ნაშთი რჩება — ჩამოწერეთ ხელით, თუ საჭიროა)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
