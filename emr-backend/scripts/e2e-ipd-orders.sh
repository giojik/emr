#!/usr/bin/env bash
# =====================================================================
# e2e-ipd-orders.sh — სტაციონარი, ეტაპი 0042: ექიმის დანიშნულებები, შემოწმებები, ფარმაცევტის ვერიფიკაცია
#   0. მომზადება: განყოფილებები, ქვესაწყობი, მომხმარებლები, პაციენტები, სატესტო ჯენერიკები (ATC, ზღვრები, ალერგენი, ურთიერთქმედება)
#   1. უფლებები          2. ალერგია (მძიმე → მიზეზი + დადასტურება)     3. დოზა, ერთეული, ანტიბიოტიკის ხანგრძლივობა
#   4. გზა, ურთიერთქმედება, დუბლირება, ბლოკის რეჟიმი                5. ბავშვი: წონა, მგ/კგ
#   6. ტიპები (PRN, ინფუზია), არამედიკამენტური, კატალოგის გარეშე     7. ზეპირი დანიშნულება
#   8. სარეზერვო ანტიბიოტიკი — დამტკიცება / უარყოფა               9. ფარმაცევტის ვერიფიკაცია (+ აფთიაქიდან მოთხოვნა)
#  10. შეცვლა, შეჩერება, განახლება, შეწყვეტა                      11. განყოფილების ხედი, შაბლონები, სიხშირეები
#  12. გაწერა წყვეტს დანიშნულებებს; გაუქმება დანიშნულებით — 409    13. აღდგენა (პარამეტრები, ჯენერიკები გაითიშება)
# გამოყენება:  bash scripts/e2e-ipd-orders.sh [API_URL]
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

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E დან. თერაპია $S\",\"code\":\"E2EOA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E დან. ქირურგია $S\",\"code\":\"E2EOB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
LOC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EO$S\",\"name\":\"ტესტ-E2E დან. ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DA\",\"requires_approval\":false}" | jq -r '.id // empty')
[ -n "$LOC" ] && ok "განყოფილებები + ქვესაწყობი" || die "ქვესაწყობი ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ord.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"დან-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.ord.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser '["receptionist"]' 71)
NA=$(mkuser '["nurse"]' 72 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 73 ",\"department_id\":\"$DA\"")                       # მკურნალი
D2=$(mkuser '["doctor"]' 74 ",\"department_id\":\"$DA\"")                       # განყოფილების ექიმი
HD=$(mkuser '["doctor"]' 75 ",\"department_id\":\"$DA\",\"is_section_head\":true")
DX=$(mkuser '["doctor"]' 76 ",\"department_id\":\"$DB\"")                       # სხვა განყოფილება
PH=$(mkuser '["pharmacist"]' 77)
for t in RC NA DR D2 HD DX PH; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები (რეგისტრატორი, ექთანი, 3 ექიმი A, ექიმი B, ფარმაცევტი)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 81 "მოზრდილი" 1970-03-03 male); P2=$(mkpat 82 "ბავშვი" "$(date -d '-5 years' +%F)" female); P3=$(mkpat 83 "გაუქმება" 1980-01-01 male)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && ok "პაციენტები (მოზრდილი, 5 წლის ბავშვი, მესამე)" || die "პაციენტები ვერ შეიქმნა"
api POST "/patients/$P1/allergies" "$NA" -d '{"substance":"პენიცილინი","allergy_type":"allergy","severity":"severe"}' >/dev/null

ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod()  { api PUT /modules/inpatient "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
mod '{"med_verification":"high_risk","med_verifier":"both","dose_rule":"warn","interaction_rule":"warn","verbal_orders":true,"antibiotic_default_days":7,"weight_max_age_days":7}'
gen() { api POST /pharmacy/generics "$ADM" -d "$1" | jq -r '.id // empty'; }
G_CEF=$(gen "{\"inn\":\"ტესტ-E2E ცეფტრიაქსონი $S\",\"atc_code\":\"J01DD04\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"dose_per_unit\":1000,\"max_single_dose\":2000,\"max_daily_dose\":4000,\"routes\":[\"IV\",\"IM\"],\"allergen_groups\":[\"CEPHALOSPORINS\"]}")
G_AMX=$(gen "{\"inn\":\"ტესტ-E2E ამოქსიცილინი $S\",\"atc_code\":\"J01CA04\",\"form_code\":\"TAB\",\"strength\":\"500 მგ\",\"dose_unit\":\"mg\",\"max_single_dose\":1000,\"max_daily_dose\":3000,\"routes\":[\"PO\"],\"allergen_groups\":[\"PENICILLINS\"]}")
G_WAR=$(gen "{\"inn\":\"ტესტ-E2E ვარფარინი $S\",\"atc_code\":\"B01AA03\",\"form_code\":\"TAB\",\"strength\":\"5 მგ\",\"dose_unit\":\"mg\",\"max_single_dose\":15,\"routes\":[\"PO\"],\"high_alert\":true}")
G_IBU=$(gen "{\"inn\":\"ტესტ-E2E იბუპროფენი $S\",\"atc_code\":\"M01AE01\",\"form_code\":\"TAB\",\"strength\":\"400 მგ\",\"dose_unit\":\"mg\",\"max_single_dose\":800,\"max_daily_dose\":2400,\"ped_max_single_per_kg\":10,\"ped_max_daily_per_kg\":30,\"routes\":[\"PO\"]}")
G_MER=$(gen "{\"inn\":\"ტესტ-E2E მეროპენემი $S\",\"atc_code\":\"J01DH02\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"max_single_dose\":2000,\"routes\":[\"IV\"],\"reserve_antibiotic\":true,\"patient_only\":true}")
for g in G_CEF G_AMX G_WAR G_IBU G_MER; do [ -n "${!g}" ] || die "ჯენერიკი $g ვერ შეიქმნა"; done
api POST /pharmacy/interactions "$ADM" -d "{\"a_generic_id\":\"$G_WAR\",\"b_generic_id\":\"$G_IBU\",\"severity\":\"major\",\"effect\":\"სისხლდენის რისკი იზრდება\",\"recommendation\":\"მოერიდეთ კომბინაციას\"}" >/dev/null
CAT=$(api GET /stock/refs "$ADM" | jq -r '.categories[]|select(.kind=="medication")|.id' | head -1)
IT_MER=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E მერონემი 1გ $S\",\"category_id\":\"$CAT\",\"generic_id\":\"$G_MER\",\"base_unit\":\"vial\"}" | jq -r '.id // empty')
IT_CEF=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E როცეფინი 1გ $S\",\"category_id\":\"$CAT\",\"generic_id\":\"$G_CEF\",\"base_unit\":\"vial\"}" | jq -r '.id // empty')
[ -n "$IT_MER" ] && [ -n "$IT_CEF" ] && ok "5 ჯენერიკი, ურთიერთქმედება (ვარფარინი + იბუპროფენი), 2 SKU" || die "SKU ვერ შეიქმნა"
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 73)\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2"); E3=$(ADMIT "$P3")
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$E3" ] && ok "3 ჰოსპიტალიზაცია (A)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
OR="/inpatient/stays/$E1/orders"
med() { jq -nc --arg g "$1" --arg t "$2" --argjson d "$3" --arg u "$4" --arg r "$5" --arg f "${6:-}" '{category:"medication",generic_id:$g,order_type:$t,dose:$d,dose_unit:$u,route_code:$r} + (if $f=="" then {} else {frequency_code:$f} end)'; }
plus() { echo "$1" | jq -c ". + $2"; }

step "1. უფლებები"
BODY=$(plus "$(med "$G_CEF" scheduled 1000 mg IV Q12H)" '{"duration_days":7,"override_reason":"ტესტ-E2E: ჯვარედინი რისკი შეფასებულია"}')
chk "რეგისტრატორი — 403; სხვა განყოფილების ექიმი — 403" "$(code POST "$OR" "$RC" -d "$BODY"):$(code POST "$OR" "$DX" -d "$BODY")" "403:403"
chk "ექთანი ზეპირი ნიშნის გარეშე — 403" "$(code POST "$OR" "$NA" -d "$BODY")" "403"
chk "სია: ექიმი can.order; ექთანი can.verbal" "$(api GET "$OR" "$DR" | jq -r .can.order):$(api GET "$OR" "$NA" | jq -r '"\(.can.order):\(.can.verbal)"')" "true:false:true"

step "2. ალერგია"
AMX=$(plus "$(med "$G_AMX" scheduled 500 mg PO TID)" '{"duration_days":5}')
R=$(api POST "$OR" "$DR" -d "$AMX")
chk "ამოქსიცილინი პენიცილინზე ალერგიისას — 409 ORDER_CHECKS (მიზეზი + მძიმე)" "$(echo "$R" | jq -r '"\(.code):\(.requires.reason):\(.requires.severe):\([.checks[].code]|index("allergy")!=null)"')" "ORDER_CHECKS:true:true:true"
chk "მხოლოდ ack — 409; მიზეზით, მძიმის დადასტურების გარეშე — 409" "$(code POST "$OR" "$DR" -d "$(plus "$AMX" '{"ack":true}')"):$(code POST "$OR" "$DR" -d "$(plus "$AMX" '{"override_reason":"ტესტ-E2E: სხვა ალტერნატივა არ არის"}')")" "409:409"
R=$(api POST "$OR" "$DR" -d "$(plus "$AMX" '{"override_reason":"ტესტ-E2E: სხვა ალტერნატივა არ არის","confirm_severe":true}')")
O_AMX=$(echo "$R" | jq -r '.id // empty')
chk "მიზეზით + დადასტურებით → active; შემოწმება და მიზეზი შენახულია; ვერიფიკაცია არ სჭირდება" \
  "$(echo "$R" | jq -r '"\(.status):\(.override_reason!=null):\([.checks[].code]|index("allergy")!=null):\(.verify_status)"')" "active:true:true:not_required"

step "3. დოზა, ერთეული, ანტიბიოტიკი"
chk "ანტიბიოტიკი ხანგრძლივობის გარეშე — 400 ANTIBIOTIC_DURATION" "$(api POST "$OR" "$DR" -d "$(med "$G_CEF" scheduled 1000 mg IV Q12H)" | jq -r .code)" "ANTIBIOTIC_DURATION"
chk "ერთეული g (ჯენერიკი — mg) — 400" "$(code POST "$OR" "$DR" -d "$(plus "$(med "$G_CEF" scheduled 1 g IV Q12H)" '{"duration_days":7}')")" "400"
R=$(api POST "$OR" "$DR" -d "$(plus "$(med "$G_CEF" scheduled 3000 mg IV Q8H)" '{"duration_days":7}')")
chk "3000 მგ ყოველ 8 სთ — ერთჯერადი + დღიური ზღვარი → მიზეზი" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code|startswith("dose_"))]|length):\(.requires.reason)"')" "ORDER_CHECKS:2:true"
chk "ცეფტრიაქსონი — ჯვარედინი ალერგია (პენიცილინი → ცეფალოსპორინი) → მიზეზი" "$(api POST "$OR" "$DR" -d "$(echo "$BODY" | jq -c 'del(.override_reason)')" | jq -r '"\(.code):\(.requires.reason):\([.checks[]|select(.code=="allergy")][0].message|test("ჯვარედინი"))"')" "ORDER_CHECKS:true:true"
R=$(api POST "$OR" "$DR" -d "$BODY"); O_CEF=$(echo "$R" | jq -r '.id // empty')
chk "1000 მგ ყოველ 12 სთ, 7 დღე — active, end_at, მომარაგება ward" "$(echo "$R" | jq -r '"\(.status):\(.end_at!=null):\(.supply_mode):\(.frequency_name)"')" "active:true:ward:ყოველ 12 სთ-ში"

step "4. გზა, ურთიერთქმედება, დუბლირება"
WAR=$(plus "$(med "$G_WAR" scheduled 5 mg PO QPM)" '{}')
R=$(api POST "$OR" "$DR" -d "$WAR"); O_WAR=$(echo "$R" | jq -r '.id // empty')
chk "ვარფარინი (high-alert) — active, ვერიფიკაცია pending" "$(echo "$R" | jq -r '"\(.status):\(.verify_status)"')" "active:pending"
IBU=$(plus "$(med "$G_IBU" scheduled 400 mg PO TID)" '{}')
R=$(api POST "$OR" "$DR" -d "$IBU")
chk "იბუპროფენი ვარფარინთან — ურთიერთქმედება major → მიზეზი" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="interaction_major")]|length):\(.requires.reason)"')" "ORDER_CHECKS:1:true"
mod '{"interaction_rule":"block"}'
chk "ბლოკის რეჟიმი — 422 ORDER_BLOCKED (მიზეზითაც)" "$(api POST "$OR" "$DR" -d "$(plus "$IBU" '{"override_reason":"ტესტ-E2E ტკივილი"}')" | jq -r .code)" "ORDER_BLOCKED"
mod '{"interaction_rule":"warn"}'
O_IBU=$(api POST "$OR" "$DR" -d "$(plus "$IBU" '{"override_reason":"ტესტ-E2E: ხანმოკლე, მონიტორინგით"}')" | jq -r '.id // empty')
[ -n "$O_IBU" ] && ok "მიზეზით → შეიქმნა" || bad "მიზეზით → შეიქმნა"
R=$(api POST "$OR" "$D2" -d "$(plus "$(med "$G_IBU" prn 400 mg IV)" '{"prn_reason":"ტკივილი > 5","prn_max_per_day":3}')")
chk "მეორე იბუპროფენი IV (განყოფილების ექიმი) — დუბლირება + გზა → ack" "$(echo "$R" | jq -r '"\(.code):\([.checks[].code]|(index("duplicate")!=null) and (index("route")!=null)):\(.requires.ack)"')" "ORDER_CHECKS:true:true"

step "5. ბავშვი: წონა, მგ/კგ"
OB="/inpatient/stays/$E2/orders"
IBK=$(jq -nc --arg g "$G_IBU" '{category:"medication",generic_id:$g,order_type:"scheduled",dose_per_kg:15,dose_unit:"mg",route_code:"PO",frequency_code:"TID"}')
chk "წონის გარეშე — 422 WEIGHT_REQUIRED" "$(api POST "$OB" "$DR" -d "$IBK" | jq -r .code)" "WEIGHT_REQUIRED"
api POST "/encounters/$E2/vitals" "$NA" -d '{"weight_kg":20,"heart_rate":100}' >/dev/null
R=$(api POST "$OB" "$DR" -d "$IBK")
chk "15 მგ/კგ × 20 კგ = 300 მგ > ბავშვის ზღვარი 10 მგ/კგ → მიზეზი" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="dose_ped_single")]|length)"')" "ORDER_CHECKS:1"
R=$(api POST "$OB" "$DR" -d "$(echo "$IBK" | jq -c '.dose_per_kg=7.5')")
chk "7.5 მგ/კგ → 150 მგ, წონა 20 შენახულია" "$(echo "$R" | jq -r '"\((.dose|tonumber)+0):\((.weight_kg|tonumber)+0):\((.dose_per_kg|tonumber)+0)"')" "150:20:7.5"
chk "სიაში წონა ჩანს (20 კგ)" "$(api GET "$OB" "$DR" | jq -r '.weight.kg')" "20"

step "6. ტიპები, არამედიკამენტური, კატალოგის გარეშე"
chk "PRN ჩვენების გარეშე — 400; ინფუზია სიჩქარის გარეშე — 400" \
  "$(code POST "$OR" "$DR" -d "$(med "$G_CEF" prn 1000 mg IV)"):$(code POST "$OR" "$DR" -d "$(jq -nc --arg g "$G_CEF" '{category:"medication",generic_id:$g,order_type:"continuous",route_code:"IV",duration_days:2}')")" "400:400"
R=$(api POST "$OR" "$DR" -d '{"category":"medication","drug_text":"ტესტ-E2E პაციენტის საკუთარი წამალი","order_type":"once","dose":1,"dose_unit":"tab","route_code":"PO"}')
O_FREE=$(echo "$R" | jq -r '.id // empty')
chk "კატალოგის გარეშე — info, ვერიფიკაცია pending" "$(echo "$R" | jq -r '"\([.checks[].code]|index("free_text")!=null):\(.verify_status)"')" "true:pending"
R=$(api POST "$OR" "$DR" -d '{"category":"diet","text":"ტესტ-E2E დიეტა №10, მარილის შეზღუდვა","frequency_code":"TID"}')
chk "დიეტა — active, ვერიფიკაციის გარეშე" "$(echo "$R" | jq -r '"\(.category):\(.status):\(.verify_status)"')" "diet:active:not_required"
chk "არამედიკამენტური ტექსტის გარეშე — 400" "$(code POST "$OR" "$DR" -d '{"category":"nursing"}')" "400"

step "7. ზეპირი დანიშნულება"
R=$(api POST "$OR" "$NA" -d "$(plus "$(med "$G_CEF" once 1000 mg IM)" "{\"verbal_doctor_id\":\"$(uid 73)\",\"override_reason\":\"ტესტ-E2E: ჯვარედინი რისკი შეფასებულია\"}")")
O_VB=$(echo "$R" | jq -r '.id // empty')
chk "ექთანი ექიმის სახელით → is_verbal, ordered_by = ექიმი" "$(echo "$R" | jq -r --arg d "$(uid 73)" '"\(.is_verbal):\(.ordered_by==$d):\(.verbal_confirmed_at)"')" "true:true:null"
chk "ექიმს — შეტყობინება" "$(api GET /notifications "$DR" | jq -r '[.. | objects | select(.kind? == "ipd_verbal_confirm")]|length>0')" "true"
chk "სხვა ექიმი ადასტურებს — 403; ავტორი ექიმი → დადასტურდა" "$(code POST "/inpatient/orders/$O_VB/confirm" "$D2"):$(api POST "/inpatient/orders/$O_VB/confirm" "$DR" -d '{}' | jq -r '.verbal_confirmed_at!=null')" "403:true"
api POST "/inpatient/orders/$O_VB/stop" "$DR" -d '{"reason":"ტესტ-E2E: ერთჯერადი შესრულდა"}' >/dev/null
mod '{"verbal_orders":false}'
chk "ზეპირი გამორთულია — 403" "$(code POST "$OR" "$NA" -d "$(plus "$(med "$G_CEF" once 1000 mg IM)" "{\"verbal_doctor_id\":\"$(uid 73)\"}")")" "403"
mod '{"verbal_orders":true}'

step "8. სარეზერვო ანტიბიოტიკი"
MER=$(plus "$(med "$G_MER" scheduled 1000 mg IV Q8H)" '{"duration_days":7,"override_reason":"ტესტ-E2E: ჯვარედინი რისკი შეფასებულია"}')
R=$(api POST "$OR" "$DR" -d "$MER"); O_MER=$(echo "$R" | jq -r '.id // empty')
chk "მეროპენემი — approval pending, verify pending, მომარაგება pharmacy" "$(echo "$R" | jq -r '"\(.approval_status):\(.verify_status):\(.supply_mode)"')" "pending:pending:pharmacy"
chk "ხელმძღვანელს — შეტყობინება" "$(api GET /notifications "$HD" | jq -r '[.. | objects | select(.kind? == "ipd_order_approve")]|length>0')" "true"
chk "დამტკიცება: ავტორი ვერ ამტკიცებს (ის არ არის ხელმძღვანელი) — 403; ჩვეულებრივი ექიმი — 403" "$(code POST "/inpatient/orders/$O_MER/approve" "$DR" -d '{}'):$(code POST "/inpatient/orders/$O_MER/approve" "$D2" -d '{}')" "403:403"
chk "ხელმძღვანელი ამტკიცებს → approved" "$(api POST "/inpatient/orders/$O_MER/approve" "$HD" -d '{"note":"ტესტ-E2E: კულტურის მგრძნობელობით"}' | jq -r .approval_status)" "approved"
O_MER2=$(api POST "/inpatient/stays/$E2/orders" "$DR" -d "$(plus "$(med "$G_MER" scheduled 400 mg IV Q8H)" '{"duration_days":5,"ack":true,"override_reason":"ტესტ-E2E ბავშვი"}')" | jq -r '.id // empty')
chk "უარყოფა მიზეზის გარეშე — 400; ფარმაცევტი უარყოფს → დანიშნულება stopped" \
  "$(code POST "/inpatient/orders/$O_MER2/approve-reject" "$PH" -d '{}'):$(api POST "/inpatient/orders/$O_MER2/approve-reject" "$PH" -d '{"note":"ტესტ-E2E: არ არის ჩვენება"}' | jq -r '"\(.approval_status):\(.status)"')" "400:rejected:stopped"

step "9. ფარმაცევტის ვერიფიკაცია"
Q=$(api GET /pharmacy/verification "$PH")
chk "რიგში: ვარფარინი, კატალოგის გარეშე, მეროპენემი; ექიმი — 403" \
  "$(echo "$Q" | jq -r --arg a "$O_WAR" --arg b "$O_FREE" --arg c "$O_MER" '[.[].id]|(index($a)!=null) and (index($b)!=null) and (index($c)!=null)'):$(code GET /pharmacy/verification "$DR")" "true:403"
chk "ვერიფიკაცია შენიშვნით → verified; ექიმს — შენიშვნის შეტყობინება" \
  "$(api POST "/pharmacy/verification/$O_WAR/verify" "$PH" -d '{"note":"ტესტ-E2E: INR-ის კონტროლი"}' | jq -r .verify_status):$(api GET /notifications "$DR" | jq -r '[.. | objects | select(.kind? == "ipd_order_note")]|length>0')" "verified:true"
chk "გაცემა სხვა ჯენერიკის SKU-თი — 400; ward-ზე გაცემა — 400" \
  "$(code POST "/pharmacy/verification/$O_MER/verify" "$PH" -d "{\"dispense_item_id\":\"$IT_CEF\",\"dispense_qty\":3}"):$(code POST "/pharmacy/verification/$O_FREE/verify" "$PH" -d "{\"dispense_item_id\":\"$IT_CEF\",\"dispense_qty\":3}")" "400:400"
chk "ხელახლა — 409; უარყოფა მიზეზის გარეშე — 400" "$(code POST "/pharmacy/verification/$O_WAR/verify" "$PH" -d '{}'):$(code POST "/pharmacy/verification/$O_FREE/reject" "$PH" -d '{}')" "409:400"
chk "უარყოფა (კატალოგის გარეშე) → rejected; ექიმს — შეტყობინება" \
  "$(api POST "/pharmacy/verification/$O_FREE/reject" "$PH" -d '{"note":"ტესტ-E2E: დაზუსტდეს პრეპარატი"}' | jq -r .verify_status):$(api GET /notifications "$DR" | jq -r '[.. | objects | select(.kind? == "ipd_order_rejected")]|length>0')" "rejected:true"
R=$(api POST "/pharmacy/verification/$O_MER/verify" "$PH" -d "{\"dispense_item_id\":\"$IT_MER\",\"dispense_qty\":3}")
chk "მეროპენემი: ვერიფიკაცია + აფთიაქის მოთხოვნა (RQ, დამტკიცებული)" "$(echo "$R" | jq -r '"\(.verify_status):\(.req_no|test("^RQ")):\(.request_status)"')" "verified:true:approved"
REQ=$(echo "$R" | jq -r .stock_request_id)
chk "მოთხოვნის ხაზი: პაციენტი, 3 ფლაკონი, ქვესაწყობი A" "$(api GET "/stock/requests/$REQ" "$ADM" | jq -r --arg p "$P1" --arg l "$LOC" '"\(.lines[0].patient_id==$p):\((.lines[0].qty_base|tonumber)+0):\(.to_location_id==$l)"')" "true:3:true"

step "10. შეცვლა, შეჩერება, შეწყვეტა"
chk "შეცვლა მიზეზის გარეშე — 400" "$(code POST "/inpatient/orders/$O_CEF/modify" "$DR" -d "$(plus "$(med "$G_CEF" scheduled 2000 mg IV Q24H)" '{"duration_days":7}')")" "400"
R=$(api POST "/inpatient/orders/$O_CEF/modify" "$DR" -d "$(plus "$(med "$G_CEF" scheduled 2000 mg IV Q24H)" '{"duration_days":7,"reason":"ტესტ-E2E: ერთჯერადი დოზირება","override_reason":"ტესტ-E2E: ჯვარედინი რისკი შეფასებულია"}')")
O_CEF2=$(echo "$R" | jq -r '.id // empty')
chk "ახალი — replaces_id; ძველი — stopped („შეიცვალა“) + modified" \
  "$(echo "$R" | jq -r --arg o "$O_CEF" '.replaces_id==$o'):$(api GET "/inpatient/orders/$O_CEF" "$DR" | jq -r '"\(.status):\(.stop_reason|startswith("შეიცვალა")):\([.events[].kind]|index("modified")!=null)"')" "true:stopped:true:true"
chk "შეცვლა: დუბლირება ძველთან აღარ ითვლება" "$(echo "$R" | jq -r '[.checks[].code]|index("duplicate")==null')" "true"
chk "ექთანი აჩერებს — 403; მიზეზის გარეშე — 400" "$(code POST "/inpatient/orders/$O_CEF2/hold" "$NA" -d '{"reason":"ოპერაცია"}'):$(code POST "/inpatient/orders/$O_CEF2/hold" "$DR" -d '{}')" "403:400"
chk "შეჩერება → on_hold; განახლება → active" "$(api POST "/inpatient/orders/$O_CEF2/hold" "$DR" -d '{"reason":"ტესტ-E2E ოპერაციის წინ"}' | jq -r .status):$(api POST "/inpatient/orders/$O_CEF2/resume" "$DR" -d '{}' | jq -r .status)" "on_hold:active"
chk "შეწყვეტა → stopped; ხელახლა — 409; შეწყვეტილის განახლება — 409" \
  "$(api POST "/inpatient/orders/$O_IBU/stop" "$D2" -d '{"reason":"ტესტ-E2E ტკივილი გაქრა"}' | jq -r .status):$(code POST "/inpatient/orders/$O_IBU/stop" "$DR" -d '{"reason":"xxx"}'):$(code POST "/inpatient/orders/$O_IBU/resume" "$DR" -d '{}')" "stopped:409:409"
chk "ისტორია: created → verified" "$(api GET "/inpatient/orders/$O_WAR" "$DR" | jq -r '[.events[].kind]|join(",")')" "created,verified"

step "11. განყოფილების ხედი, შაბლონები, სიხშირეები"
R=$(api GET "/inpatient/departments/$DA/orders" "$HD")
chk "განყოფილების აქტიური დანიშნულებები; ხელმძღვანელი — can_approve" "$(echo "$R" | jq -r '"\(.orders|length>=5):\(.can_approve)"')" "true:true"
SET1=$(api POST /inpatient/orders/sets "$DR" -d "{\"name\":\"ტესტ-E2E პირადი $S\",\"items\":[$(plus "$(med "$G_CEF" scheduled 1000 mg IV Q12H)" '{"duration_days":7}'),{\"category\":\"diet\",\"text\":\"დიეტა №10\"}]}" | jq -r '.id // empty')
chk "პირადი შაბლონი; განყოფილების — რიგითი ექიმი 403, ხელმძღვანელი OK" \
  "$([ -n "$SET1" ] && echo ok):$(code POST /inpatient/orders/sets "$D2" -d "{\"name\":\"xx\",\"department_id\":\"$DA\",\"items\":[{\"category\":\"diet\",\"text\":\"xx\"}]}"):$(code POST /inpatient/orders/sets "$HD" -d "{\"name\":\"ტესტ-E2E განყ. $S\",\"department_id\":\"$DA\",\"items\":[{\"category\":\"nursing\",\"text\":\"ჭრილობის დამუშავება\"}]}")" "ok:403:201"
chk "ექიმი ხედავს: პირადი + განყოფილების" "$(api GET /inpatient/orders/sets "$DR" | jq -r '[.[]|select(.name|test("'"$S"'"))]|length')" "2"
chk "სხვისი პირადი შაბლონის შეცვლა — 403" "$(code PATCH "/inpatient/orders/sets/$SET1" "$D2" -d '{"name":"xx","items":[{"category":"diet","text":"xx"}]}')" "403"
FC="E${S: -4}"
chk "სიხშირე: admin ქმნის (05:00, 17:00 → 2/დღე); ექიმი — 403; დუბლი — 409" \
  "$(api POST /inpatient/orders/frequencies "$ADM" -d "{\"code\":\"$FC\",\"name\":\"ტესტ-E2E\",\"times_of_day\":[\"17:00\",\"05:00\"],\"is_active\":false}" | jq -r '"\((.per_day|tonumber)+0):\(.times_of_day|join(","))"'):$(code POST /inpatient/orders/frequencies "$DR" -d "{\"code\":\"X$FC\",\"name\":\"x\",\"interval_hours\":6}"):$(code POST /inpatient/orders/frequencies "$ADM" -d "{\"code\":\"$FC\",\"name\":\"x\",\"interval_hours\":6}")" "2:05:00,17:00:403:409"
chk "საათები და ინტერვალი ერთად — 400" "$(code POST /inpatient/orders/frequencies "$ADM" -d '{"code":"ZZ1","name":"x","interval_hours":6,"times_of_day":["08:00"]}')" "400"

step "12. გაწერა და გაუქმება"
api POST "/inpatient/stays/$E3/orders" "$DR" -d '{"category":"diet","text":"ტესტ-E2E საერთო მაგიდა"}' >/dev/null
chk "დანიშნულებიანი ჰოსპიტალიზაციის გაუქმება — 409 STAY_IN_USE" "$(api POST "/inpatient/stays/$E3/cancel" "$RC" -d '{"reason":"ტესტ-E2E შეცდომა"}' | jq -r .code)" "STAY_IN_USE"
ACT=$(api GET "$OR" "$DR" | jq -r '[.orders[]|select(.status=="active" or .status=="on_hold")]|length')
R=$(api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 72)\",\"$(uid 74)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}")
chk "თვითნებური გაწერა ($ACT აქტიური დანიშნულება)" "$(echo "$R" | jq -r .status)" "discharged"
chk "გაწერისას ყველა დანიშნულება შეწყდა (discharge_stop); ისტორიაში orders_stopped" \
  "$(api GET "$OR" "$DR" | jq -r '[.orders[]|select(.status=="active" or .status=="on_hold")]|length'):$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|index("orders_stopped")!=null')" "0:true"
chk "გაწერილზე ახალი დანიშნულება — 409" "$(code POST "$OR" "$DR" -d '{"category":"diet","text":"xx"}')" "409"
for E in "$E2" "$E3"; do api POST "/inpatient/stays/$E/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 72)\",\"$(uid 74)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null; done

step "13. აღდგენა"
for g in "$G_CEF" "$G_AMX" "$G_WAR" "$G_IBU" "$G_MER"; do api PATCH "/pharmacy/generics/$g" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/stock/locations/$LOC" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
ok "პარამეტრები აღდგენილია; სატესტო ჯენერიკები და ქვესაწყობი გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
