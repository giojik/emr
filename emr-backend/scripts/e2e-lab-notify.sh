#!/usr/bin/env bash
# =====================================================================
# e2e-lab-notify.sh — დამნიშნავ ექიმს შეტყობინება „ანალიზის პასუხი მზადაა“ (0029) + ფორმა №100/ა-ს ისტორია
#   ექიმი → ვიზიტი → ანალიზები → ვალიდაცია → ზარი (დაჯგუფება, კრიტიკული — სასწრაფო, წაკითხვა); სხვა ექიმს — არა;
#   ლაბორატორიული ვიზიტი (ექიმის გარეშე) — არავის; ფორმა №100 — პაციენტის ყველა, ნახვა (PDF)
# გამოყენება:  bash scripts/e2e-lab-notify.sh [API_URL]
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
read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TRACK=$(mktemp)

step "1. მომზადება"
DEP=$(api GET /departments "$ADM" | jq -r '.[]|select(.code=="E2E_NTF")|.id')
[ -n "$DEP" ] || DEP=$(api POST /departments "$ADM" -d '{"name":"ტესტ-E2E თერაპია","code":"E2E_NTF","type":"outpatient"}' | jq -r .id)
TC=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2E_NTF_$S\",\"title\":\"ტესტ-E2E კონსულტაცია\",\"base_price\":10}" | jq -r .id)
mkuser() { # $1 role $2 pn-prefix $3 extra-json
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ntf.$1$4.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1$4\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"$3}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { echo "ERR $(echo "$R" | jq -rc .message)" >&2; return; }; echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.ntf.$1$4.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty')"
}
DOCX=",\"department_id\":\"$DEP\",\"specialty\":\"თერაპევტი\",\"license_number\":\"MD-$S\",\"consultation_tariff_id\":\"$TC\""
read -r D1 DR1 <<< "$(mkuser doctor 71 "$DOCX" 1)"; read -r D2 DR2 <<< "$(mkuser doctor 72 "${DOCX/MD-$S/MD2-$S}" 2)"
read -r _ LD <<< "$(mkuser lab_doctor 73 "" "")"; read -r _ LT <<< "$(mkuser diagnostic 74 "" "")"; read -r _ RC <<< "$(mkuser receptionist 75 "" "")"; read -r _ PH <<< "$(mkuser phlebotomist 76 "" "")"
read -r _ LM <<< "$(mkuser lab_manager 77 "" "")"
[ -n "$DR1" ] && [ -n "$DR2" ] && [ -n "$LD" ] && ok "2 ექიმი, ლაბ. ექიმი, ლაბორანტი, რეგისტრატორი, ფლებოტომისტი" || die "მომხმარებლები ვერ შეიქმნა"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_NTF_$S\",\"name\":\"ტესტ-E2E კალიუმი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty'); echo "s $SVC" >> "$TRACK"
K=$(api POST "/dx/catalog/$SVC/analytes" "$LM" -d '{"code":"K","name":"კალიუმი","unit":"mmol/L","result_type":"numeric","decimals":1,"critical_low":2.8,"critical_high":6.2,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.5,"high":5.1}]}' | jq -r '.analytes[0].id // empty')
SVC2=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_NTF2_$S\",\"name\":\"ტესტ-E2E ნატრიუმი $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty'); echo "s $SVC2" >> "$TRACK"
NA=$(api POST "/dx/catalog/$SVC2/analytes" "$LM" -d '{"code":"NA","name":"ნატრიუმი","unit":"mmol/L","result_type":"numeric","decimals":0,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":135,"high":145}]}' | jq -r '.analytes[0].id // empty')
[ -n "$K" ] && [ -n "$NA" ] && ok "2 ანალიზი (კალიუმი — კრიტიკული ზღვრებით)" || die "კატალოგი ვერ შეიქმნა"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"5$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"შეტყობინება\",\"birth_date\":\"1975-05-05\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
E=$(api POST /encounters/walk-in "$RC" -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$D1\"}" | jq -r '.encounter_id // empty')
SH=$(api GET "/invoices/encounter/$E" "$RC" | jq -r .patient_share); [ "$(jq -n --arg s "$SH" '($s|tonumber) > 0')" = "true" ] && api POST "/encounters/$E/pay-initial" "$RC" -d "{\"amount\":$SH,\"method\":\"cash\"}" >/dev/null
[ -n "$E" ] && ok "ვიზიტი ექიმთან (walk-in)" || die "ვიზიტი ვერ შეიქმნა"
chk "ექიმი ნიშნავს 2 ანალიზს" "$(api POST "/encounters/$E/dx-orders" "$DR1" -d "{\"items\":[{\"service_id\":\"$SVC\"},{\"service_id\":\"$SVC2\"}]}" | jq -r 'if type=="array" then length else (.items|length) end')" "2"
api POST "/encounters/$E/dx-collect" "$PH" -d '{"identity_confirmed":true,"unpaid_ack":true}' >/dev/null
IT=$(api GET "/encounters/$E/dx-orders" "$RC"); BC=$(echo "$IT" | jq -r '[.[]|select(.barcode!=null)][0].barcode')
api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC\"}" >/dev/null
IK=$(echo "$IT" | jq -r ".[]|select(.service_id==\"$SVC\")|.id"); INA=$(echo "$IT" | jq -r ".[]|select(.service_id==\"$SVC2\")|.id")
api PUT "/lab/items/$INA/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$NA\",\"value\":\"140\"}]}" >/dev/null
api PUT "/lab/items/$IK/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$K\",\"value\":\"6.8\"}]}" >/dev/null
chk "ჯერ შეტყობინება არ არის" "$(api GET /notifications/count "$DR1" | jq -r .unread)" "0"

step "2. ვალიდაცია → დამნიშნავ ექიმს"
api POST "/lab/items/$INA/validate" "$LD" >/dev/null; sleep 1
N=$(api GET "/notifications?unread=true" "$DR1")
chk "ექიმს: „ანალიზის პასუხი მზადაა“ — პაციენტი, ანალიზი, ბმული" "$(echo "$N" | jq -r '.[0]|"\(.title):\(.body):\(.items|join(",")):\(.link)"')" "ანალიზის პასუხი მზადაა:შეტყობინება ტესტ-E2E:ტესტ-E2E ნატრიუმი $S:/encounters/$E"
chk "სხვა ექიმს — არაფერი" "$(api GET /notifications/count "$DR2" | jq -r .unread)" "0"
chk "ლაბ. ექიმს (დამდასტურებელს) — არაფერი" "$(api GET /notifications/count "$LD" | jq -r .unread)" "0"
api POST "/lab/items/$IK/validate" "$LD" >/dev/null; sleep 1
N=$(api GET "/notifications?unread=true" "$DR1")
chk "კრიტიკული კალიუმი (6.8) → ცალკე, სასწრაფო" "$(echo "$N" | jq -r '[.[]|select(.urgent)][0]|"\(.title|startswith("⚠️")):\(.items|join(","))"')" "true:ტესტ-E2E კალიუმი $S"
chk "მრიცხველი: 2 წაუკითხავი, 1 სასწრაფო" "$(api GET /notifications/count "$DR1" | jq -r '"\(.unread):\(.urgent)"')" "2:1"
NID=$(echo "$N" | jq -r '[.[]|select(.urgent|not)][0].id')
chk "წაკითხვა → 1 დარჩა" "$(api POST "/notifications/$NID/read" "$DR1" | jq -r .unread)" "1"
chk "სხვისი შეტყობინების წაკითხვა არ მოქმედებს" "$(api POST "/notifications/$(echo "$N" | jq -r '[.[]|select(.urgent)][0].id')/read" "$DR2" >/dev/null; api GET /notifications/count "$DR1" | jq -r .unread)" "1"
chk "ყველა წაკითხულია" "$(api POST /notifications/read-all "$DR1" | jq -r .unread)" "0"

step "3. ლაბორატორიული ვიზიტი (ექიმის გარეშე) — არავის"
E2=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$SVC2\"}]}" | jq -r '.encounter_id // empty')
SH=$(api GET "/invoices/encounter/$E2" "$RC" | jq -r .patient_share); [ "$(jq -n --arg s "$SH" '($s|tonumber) > 0')" = "true" ] && api POST "/encounters/$E2/pay-initial" "$RC" -d "{\"amount\":$SH,\"method\":\"cash\"}" >/dev/null
BC2=$(api POST "/encounters/$E2/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty'); api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC2\"}" >/dev/null
I3=$(api GET "/lab/worklist?search=$BC2" "$LT" | jq -r '.[0].id'); api PUT "/lab/items/$I3/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$NA\",\"value\":\"139\"}]}" >/dev/null
api POST "/lab/items/$I3/validate" "$LD" >/dev/null; sleep 1
chk "ექიმებს შეტყობინება არ მოსვლია" "$(api GET /notifications/count "$DR1" | jq -r .unread):$(api GET /notifications/count "$DR2" | jq -r .unread)" "0:0"

step "4. ფორმა №100/ა — ისტორია"
F=$(api POST "/encounters/$E/form100" "$DR1" -d '{"conclusion":"practically_healthy","investigations":"ლაბ. კვლევები — იხ. პასუხი","recommendations":"ტესტი"}' | jq -r '.id // empty')
if [ -z "$F" ]; then F=$(api POST "/encounters/$E/form100" "$DR1" -d "$(api GET "/encounters/$E/form100/draft" "$DR1")" | jq -r '.id // empty'); fi
[ -n "$F" ] && ok "ფორმა №100/ა შეიქმნა" || bad "ფორმა №100/ა" "ვერ შეიქმნა"
chk "პაციენტის ყველა ფორმა №100 (სხვა ექიმიც ხედავს)" "$(api GET "/documents?patient_id=$PAT&type=form_100" "$DR2" | jq -r length)" "1"
chk "რეგისტრატორიც ხედავს" "$(api GET "/documents?patient_id=$PAT&type=form_100" "$RC" | jq -r length)" "1"
chk "PDF (ნახვა / ბეჭდვა)" "$(curl -s "$B/documents/$F/pdf" -H "authorization: Bearer $DR2" | head -c 5)" "%PDF-"
chk "ლაბორანტს ფორმა №100 დახურული (403)" "$(code GET "/documents?patient_id=$PAT&type=form_100" "$LT")" "403"

step "გასუფთავება"
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -f "$TRACK"; ok "სატესტო მომხმარებლები და ანალიზები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
