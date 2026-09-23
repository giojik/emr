#!/usr/bin/env bash
# =====================================================================
# EMR smoke test: ამბულატორიის სრული ნაკადი → ფორმა №IV-100/ა (PDF)
#
#   read -rsp "Admin password: " PW; echo
#   ADMIN_PW="$PW" bash smoke-form100.sh
#
# ქმნის სატესტო მონაცემებს (უნიკალური სუფიქსით — შეიძლება რამდენჯერმე გაეშვას):
#   განყოფილება → ტარიფები → ექიმი → პაციენტი → ვიზიტი → გადახდა → ვიტალები →
#   დიაგნოზი → დანიშნულება → ლაბ. მიმართვა + შედეგი → discharge → ფორმა 100
# =====================================================================
set -euo pipefail

API="${API:-http://localhost:3000/api}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@innovamedical.ge}"
: "${ADMIN_PW:?ADMIN_PW ცვლადი საჭიროა (read -rsp ... PW; ADMIN_PW=\"\$PW\" bash $0)}"
SFX=$(( 10#$(date +%s | tail -c 6) ))                # უნიკალური სუფიქსი (რიცხვი)
OUT="${OUT:-/tmp/form100_${SFX}.pdf}"

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘ %s\033[0m\n' "$*"; exit 1; }

# call <token> <METHOD> <path> [json]  — ბეჭდავს პასუხს; HTTP ≥400 → გაჩერება
call() {
  local tok=$1 m=$2 p=$3 d=${4:-}
  local r code
  r=$(curl -s -w $'\n%{http_code}' -X "$m" "$API$p" -H "authorization: Bearer $tok" \
      -H 'content-type: application/json' ${d:+-d "$d"})
  code=${r##*$'\n'}; r=${r%$'\n'*}
  if (( code >= 400 )); then echo "$r" | jq . >&2 || echo "$r" >&2; die "$m $p → HTTP $code"; fi
  echo "$r"
}
login() {
  curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
    -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty' || true
}

curl -sf "$API/health" >/dev/null || die "API მიუწვდომელია: $API (გაშვებულია npm run start:dev?)"

step "Admin login"
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [[ -n "$ADM" ]] || die "admin login ვერ მოხერხდა"
ok "token"

step "განყოფილება + ტარიფები"
DEP=$(call "$ADM" GET /departments | jq -r '.[] | select(.code=="SMOKE_CARDIO") | .id')
if [[ -z "$DEP" ]]; then
  DEP=$(call "$ADM" POST /departments '{"name":"კარდიოლოგია (ტესტი)","code":"SMOKE_CARDIO","type":"outpatient"}' | jq -r .id)
fi
ok "განყოფილება $DEP"
T_CONS=$(call "$ADM" POST /tariffs "{\"code\":\"SMK_CONS_$SFX\",\"title\":\"კარდიოლოგის კონსულტაცია\",\"base_price\":50}" | jq -r .id)
T_LAB=$(call "$ADM" POST /tariffs "{\"code\":\"SMK_LAB_$SFX\",\"title\":\"ლიპიდური პროფილი\",\"base_price\":30}" | jq -r .id)
call "$ADM" PUT /tariffs/referral-types "{\"type\":\"lab\",\"tariff_id\":\"$T_LAB\"}" >/dev/null
ok "კონსულტაცია 50 ₾, ლაბორატორია 30 ₾"

step "ექიმი (ლოკალური ანგარიში)"
R=$(call "$ADM" POST /users "{\"email\":\"smoke.doc.$SFX@example.ge\",\"first_name\":\"დავით\",\"last_name\":\"ტესტაშვილი\",
  \"personal_number\":\"01$(printf '%09d' "$SFX")\",\"role\":\"doctor\",\"department_id\":\"$DEP\",
  \"specialty\":\"კარდიოლოგი\",\"license_number\":\"MD-$SFX\",\"consultation_tariff_id\":\"$T_CONS\"}")
DOC_ID=$(echo "$R" | jq -r .user.id); DOC_EMAIL=$(echo "$R" | jq -r .user.email); TMP=$(echo "$R" | jq -r .temporaryPassword)
DOC=$(login "$DOC_EMAIL" "$TMP")
NEWPW="Smoke-$(openssl rand -hex 6)1"
DOC=$(call "$DOC" POST /auth/change-password "$(jq -nc --arg c "$TMP" --arg n "$NEWPW" '{currentPassword:$c,newPassword:$n}')" | jq -r .accessToken)
ok "$DOC_EMAIL (დროებითი პაროლი შეცვლილია)"

step "პაციენტი + ვიზიტი (walk-in)"
PAT=$(call "$ADM" POST /patients "{\"personal_number\":\"02$(printf '%09d' "$SFX")\",\"first_name\":\"ნიკოლოზ\",\"last_name\":\"ტესტიშვილი\",
  \"birth_date\":\"1972-04-15\",\"gender\":\"male\",\"phone_number\":\"599$SFX\",\"address\":\"თბილისი, ტესტის ქ. 1\"}" | jq -r .id)
ENC=$(call "$ADM" POST /encounters/walk-in "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOC_ID\",\"chief_complaint\":\"თავის ტკივილი, მაღალი წნევა\"}" | jq -r .encounter_id)
ok "ვიზიტი $ENC (planned)"

step "გადახდა → active"
call "$ADM" POST "/encounters/$ENC/pay-initial" '{"amount":50,"method":"cash"}' | jq -r '"  status: \(.status), \(.paid_status)"'

step "კლინიკური ჩანაწერები"
call "$DOC" PATCH "/encounters/$ENC" '{"history_of_present_illness":"წნევის მატება 2 კვირაა, თავბრუსხვევა.","objective_status":"ა/წ 160/100, გულის ტონები რიტმული."}' >/dev/null
call "$DOC" POST "/encounters/$ENC/vitals" '{"systolic_bp":160,"diastolic_bp":100,"heart_rate":84,"temperature":36.7,"spo2":98,"weight_kg":88,"height_cm":176}' | jq -r '"  ვიტალები: BMI \(.bmi)"'
call "$DOC" POST "/encounters/$ENC/diagnoses" '{"icd10_code":"I10","diagnosis_type":"primary"}' | jq -r '"  ძირითადი: \(.icd10_code) \(.icd10_title)"'
call "$DOC" POST "/encounters/$ENC/diagnoses" '{"icd10_code":"E78.0","diagnosis_type":"secondary"}' | jq -r '"  თანმხლები: \(.icd10_code) \(.icd10_title)"'
call "$DOC" POST "/encounters/$ENC/prescriptions" '{"medication_name":"ამლოდიპინი","dosage":"5 მგ","route":"oral","frequency":"1-ჯერ დღეში","duration_days":30}' >/dev/null
ok "დანიშნულება"

step "ლაბ. მიმართვა + შედეგი (admin — დიაგნოსტიკის როლის ნაცვლად)"
REF=$(call "$DOC" POST "/encounters/$ENC/referrals" '{"type":"lab","reason":"ლიპიდური პროფილი"}' | jq -r .id)
call "$ADM" PATCH "/referrals/$REF" '{"status":"completed","result_text":"საერთო ქოლესტერინი 6.4, LDL 4.3 mmol/L"}' >/dev/null
call "$ADM" GET "/invoices/encounter/$ENC" | jq -r '"  ინვოისი: \(.total_amount) ₾, ნაშთი \(.balance_due) ₾"'
call "$ADM" POST "/invoices/$(call "$ADM" GET "/invoices/encounter/$ENC" | jq -r .id)/payments" '{"amount":30,"method":"card_terminal","terminal_ref":"TEST-0001"}' | jq -r '"  დამატებითი გადახდა: \(.paid_status)"'

step "Discharge"
call "$DOC" POST "/encounters/$ENC/discharge" | jq -r '"  \(.status), ნაშთი \(.balance_due) ₾"'

step "ფორმა №IV-100/ა"
DOCR=$(call "$DOC" POST "/encounters/$ENC/form100" '{"recipient":"მოთხოვნის ადგილზე წარსადგენად","workplace":"შპს \"ტესტი\", მენეჯერი","course":"chronic","recommendations":"არტერიული წნევის ყოველდღიური კონტროლი; მარილის შეზღუდვა; განმეორებითი ვიზიტი 1 თვეში."}')
DOC_NO=$(echo "$DOCR" | jq -r .document_number); DOC_DID=$(echo "$DOCR" | jq -r .id); TOKEN=$(echo "$DOCR" | jq -r .verification_token)
curl -s -o "$OUT" "$API/documents/$DOC_DID/pdf" -H "authorization: Bearer $DOC"
ok "№ $DOC_NO → $OUT ($(stat -c %s "$OUT") ბაიტი)"

step "QR ვერიფიკაცია"
curl -s "$API/public/verify/$TOKEN" | jq '{valid, document_number, institution, patient_initials}'

printf '\n\033[1;32m✔ ყველაფერი წარმატებით დასრულდა.\033[0m PDF: %s\n' "$OUT"
