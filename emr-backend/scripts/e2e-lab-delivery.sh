#!/usr/bin/env bash
# =====================================================================
# e2e-lab-delivery.sh — პასუხის მიწოდება პაციენტს (0028): ნაგულისხმევად გამორთული, ჩართვა (admin), თანხმობა ბარათში,
#   ავტომატური (ვიზიტის ყველა ანალიზის დადასტურების შემდეგ, ერთხელ), ხელით (სხვა მისამართზე), ჟურნალი, უფლებები
# ⚠️ ტესტის დროს დროებით ჩართავს მიწოდებას და ბოლოს აღადგენს წინა მდგომარეობას. SMTP/SMS კონფიგურაციის გარეშე ჩანაწერი
#    „failed“-ით ჩაიწერება (მიზეზით) — ესეც მოსალოდნელია; რეალური გაგზავნისთვის: .env — SMTP_*, SMS_API_URL.
# ტესტის ელ-ფოსტა: DELIVERY_TEST_EMAIL (ნაგულისხმევი — lab-results-test@example.com, არ იგზავნება რეალურ პაციენტზე)
# გამოყენება:  bash scripts/e2e-lab-delivery.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-http://localhost/api}"
J='content-type: application/json'
TEST_EMAIL="${DELIVERY_TEST_EMAIL:-lab-results-test@example.com}"
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
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.dlv.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.dlv.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
LD=$(mkuser lab_doctor 61); LM=$(mkuser lab_manager 62); LT=$(mkuser diagnostic 63); RC=$(mkuser receptionist 64); PH=$(mkuser phlebotomist 65)
[ -n "$LD" ] && [ -n "$RC" ] && ok "5 სატესტო მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /lab/delivery/settings "$ADM")
echo "      SMTP: $(echo "$ORIG" | jq -r .configured.email), SMS: $(echo "$ORIG" | jq -r .configured.sms)"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_DLV_$S\",\"name\":\"ტესტ-E2E გლუკოზა (მიწოდება) $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty'); echo "s $SVC" >> "$TRACK"
GLU=$(api POST "/dx/catalog/$SVC/analytes" "$LM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.9,"high":6.1}]}' | jq -r '.analytes[0].id // empty')
mkpat() { api POST /patients "$RC" -d "{\"personal_number\":\"$1$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"1980-01-01\",\"gender\":\"male\",\"phone_number\":\"599$S\"$3}" | jq -r '.id // empty'; }
P1=$(mkpat 8 მიწოდება ",\"email\":\"$TEST_EMAIL\",\"result_email\":true,\"result_sms\":true")
P2=$(mkpat 9 თანხმობისგარეშე "")
chk "ბარათში: ელ-ფოსტა + თანხმობა (ელ-ფოსტა, SMS)" "$(api GET "/patients/$P1" "$RC" | jq -r '"\(.email):\(.result_email):\(.result_sms)"')" "$TEST_EMAIL:true:true"
chk "არასწორი ელ-ფოსტა — 400" "$(code PATCH "/patients/$P2" "$RC" -d '{"email":"not-an-email"}')" "400"
visit() { # $1 patient → „encounter item“ (შედეგი შეყვანილი, ვალიდაციამდე)
  local e sh bc it; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$1\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  bc=$(api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  it=$(api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty')
  api PUT "/lab/items/$it/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$GLU\",\"value\":\"5.4\"}]}" >/dev/null
  echo "$e $it"
}

step "2. ნაგულისხმევად გამორთულია"
read -r E0 I0 <<< "$(visit "$P1")"
api POST "/lab/items/$I0/validate" "$LD" >/dev/null; sleep 2
chk "გამორთულზე ავტომატური არ იგზავნება" "$(api GET "/encounters/$E0/lab-deliveries" "$RC" | jq -r length)" "0"
chk "გამორთულზე ხელით — 409" "$(code POST "/encounters/$E0/lab-deliveries" "$RC" -d '{"email":true,"sms":false}')" "409"
chk "ჩართვა მხოლოდ admin-ს (ლაბ. მენეჯერი — 403)" "$(code PUT /lab/delivery/settings "$LM" -d '{"enabled":true}')" "403"
chk "admin: ჩართვა (ავტომატური, დაშიფვრით)" "$(api PUT /lab/delivery/settings "$ADM" -d '{"enabled":true,"auto_send":true,"encrypt_pdf":true}' | jq -r '"\(.enabled):\(.auto_send):\(.encrypt_pdf)"')" "true:true:true"

step "3. ავტომატური: ვიზიტის დადასტურებისას, ერთხელ"
read -r E1 I1 <<< "$(visit "$P1")"
chk "ლაბ. ექიმი ადასტურებს" "$(api POST "/lab/items/$I1/validate" "$LD" | jq -r .status)" "validated"
L=""; for _ in $(seq 1 15); do L=$(api GET "/encounters/$E1/lab-deliveries" "$RC"); [ "$(echo "$L" | jq -r length)" -ge 2 ] && break; sleep 1; done
chk "ჟურნალი: ელ-ფოსტა + SMS (ავტომატური)" "$(echo "$L" | jq -r '[.[]|"\(.channel):\(.trigger)"]|sort|join(",")')" "email:auto,sms:auto"
EM=$(echo "$L" | jq -c '.[]|select(.channel=="email")')
if [ "$(echo "$EM" | jq -r .status)" = "sent" ]; then ok "ელ-ფოსტა გაიგზავნა ($TEST_EMAIL), მიმაგრება: $(echo "$EM" | jq -r .attachments)"
else ok "ელ-ფოსტა ჩაიწერა მიზეზით: $(echo "$EM" | jq -r .error | cut -c1-80) (SMTP?)"; fi
chk "ელ-ფოსტის ჩანაწერში — PDF მიმაგრება (ან მიზეზი)" "$(echo "$EM" | jq -r '(.attachments >= 1) or (.error != null)')" "true"
chk "SMS ჩანაწერი (ნომერი)" "$(echo "$L" | jq -r '.[]|select(.channel=="sms")|.recipient')" "599$S"
api POST "/lab/items/$I1/reopen" "$LD" -d '{"reason":"ტესტი — ხელახალი დადასტურება"}' >/dev/null
api POST "/lab/items/$I1/validate" "$LD" >/dev/null; sleep 2
chk "ხელახალი დადასტურება — ავტომატური მეორედ არ იგზავნება" "$(api GET "/encounters/$E1/lab-deliveries" "$RC" | jq -r '[.[]|select(.trigger=="auto")]|length')" "2"

step "4. თანხმობის გარეშე; ხელით"
read -r E2 I2 <<< "$(visit "$P2")"
api POST "/lab/items/$I2/validate" "$LD" >/dev/null; sleep 2
chk "თანხმობის გარეშე — ავტომატური არა" "$(api GET "/encounters/$E2/lab-deliveries" "$RC" | jq -r length)" "0"
chk "ხელით, ელ-ფოსტის გარეშე — მიზეზით ჩაიწერა" "$(api POST "/encounters/$E2/lab-deliveries" "$RC" -d '{"email":true,"sms":false}' | jq -r '.results[0].error|contains("ელ-ფოსტა არ აქვს")')" "true"
R=$(api POST "/encounters/$E2/lab-deliveries" "$RC" -d "{\"email\":true,\"sms\":true,\"email_to\":\"$TEST_EMAIL\",\"phone_to\":\"598$S\"}")
chk "ხელით — სხვა მისამართზე და ნომერზე" "$(echo "$R" | jq -r '[.results[].recipient]|sort|join(",")')" "598$S,$TEST_EMAIL"
chk "არჩევანის გარეშე — 400" "$(code POST "/encounters/$E2/lab-deliveries" "$RC" -d '{"email":false,"sms":false}')" "400"
chk "ფლებოტომისტს გაგზავნა არ შეუძლია (403)" "$(code POST "/encounters/$E2/lab-deliveries" "$PH" -d '{"email":true,"sms":false}')" "403"
read -r E3 I3 <<< "$(visit "$P1")"
chk "დადასტურებამდე ხელით — 409" "$(code POST "/encounters/$E3/lab-deliveries" "$RC" -d '{"email":true,"sms":false}')" "409"

step "გასუფთავება"
api PUT /lab/delivery/settings "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled,auto_send,encrypt_pdf}')" >/dev/null && ok "მიწოდების პარამეტრები აღდგა (ჩართული: $(echo "$ORIG" | jq -r .enabled))"
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -f "$TRACK"; ok "სატესტო მონაცემები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
