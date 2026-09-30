#!/usr/bin/env bash
# =====================================================================
# e2e-lab-qc.sh — ხარისხის კონტროლი (0026): მასალები/სამიზნეები, Westgard-ის წესები (1-2s, 1-3s, 2-2s, R-4s, 4-1s, 10x),
#   კომპონენტის კონფიგურაცია (ხელმძღვანელი), დაბლოკვა / გაფრთხილება (მიზეზით), განხილვა, გამორიცხვა, გრაფიკი, ანალიზატორიდან QC
# ქმნის სატესტო ანალიზს/ანალიზატორს/მასალებს (ტესტ-E2E); ბოლოს თიშავს.
# გამოყენება:  bash scripts/e2e-lab-qc.sh [API_URL]     სიმულატორი — როგორც e2e-lab-gateway.sh-ში (SIM=…); პორტი 4105
# =====================================================================
set -uo pipefail
B="${1:-http://localhost/api}"
J='content-type: application/json'
DC="docker compose -f /opt/emr/docker-compose.dev.yml -f /opt/emr/docker-compose.app.yml"
SIM="${SIM:-$DC exec -T emr-lab-gateway node dist/lab-gateway/simulator.js}"
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
S=$(date +%s | tail -c 7); TRACK=$(mktemp); TODAY=$(TZ=Asia/Tbilisi date +%F)

step "1. მომზადება"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.qc.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\",\"is_section_head\":$3}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.qc.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
HEAD=$(mkuser lab_doctor 21 true); LM=$(mkuser lab_manager 22 false); LT=$(mkuser diagnostic 23 false); RC=$(mkuser receptionist 24 false); PH=$(mkuser phlebotomist 25 false)
[ -n "$HEAD" ] && [ -n "$LM" ] && [ -n "$LT" ] && [ -n "$RC" ] && [ -n "$PH" ] && ok "5 სატესტო მომხმარებელი (ხელმძღვანელი, მენეჯერი, ლაბორანტი…)" || die "მომხმარებლები ვერ შეიქმნა"
M=$(api POST /lab/methods "$LM" -d "{\"name\":\"ტესტ-E2E QC ანალიზატორი $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty'); echo "m $M" >> "$TRACK"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_QC_$S\",\"name\":\"ტესტ-E2E ბიოქიმია QC $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty'); echo "s $SVC" >> "$TRACK"
an() { api POST "/dx/catalog/$SVC/analytes" "$LM" -d "{\"code\":\"$1\",\"name\":\"$2\",\"unit\":\"$3\",\"result_type\":\"numeric\",\"decimals\":2,\"sort_order\":$4,\"ranges\":[{\"sex\":null,\"age_min_days\":0,\"age_max_days\":54750,\"low\":$5,\"high\":$6}]}" | jq -r ".analytes[]|select(.code==\"$1\")|.id"; }
GLU=$(an GLU გლუკოზა mmol/L 1 3.9 6.1); CREA=$(an CREA კრეატინინი µmol/L 2 62 106); UREA=$(an UREA შარდოვანა mmol/L 3 2.5 7.5); K=$(an K კალიუმი mmol/L 4 3.5 5.1)
api PATCH "/dx/catalog/$SVC" "$ADM" -d "{\"default_method_id\":\"$M\"}" >/dev/null
[ -n "$M" ] && [ -n "$GLU" ] && [ -n "$K" ] && ok "ანალიზატორი + ანალიზი 4 კომპონენტით (ნაგულისხმევი ანალიზატორით)" || die "კატალოგი ვერ შეიქმნა"

step "2. მასალები და სამიზნეები"
mat() { api POST /lab/qc/materials "$LM" -d "{\"name\":\"ტესტ-E2E Control $S\",\"manufacturer\":\"Test\",\"level\":\"$1\",\"lot\":\"LOT$S\",\"expires_on\":\"2030-12-31\",\"barcode\":\"$2\"}" | jq -r '.id // empty'; }
L1=$(mat L1 "QC1-$S"); L2=$(mat L2 "QC2-$S"); echo "q $L1" >> "$TRACK"; echo "q $L2" >> "$TRACK"
[ -n "$L1" ] && [ -n "$L2" ] && ok "2 მასალა (L1, L2), ლოტი, ვადა, შტრიხკოდი" || die "მასალები ვერ შეიქმნა"
chk "იგივე შტრიხკოდი მეორე მასალაზე — 409" "$(code POST /lab/qc/materials "$LM" -d "{\"name\":\"ტესტ-E2E dup\",\"level\":\"L3\",\"lot\":\"x\",\"barcode\":\"QC1-$S\"}")" "409"
api PUT "/lab/qc/materials/$L1/targets" "$LM" -d "{\"targets\":[{\"analyte_id\":\"$GLU\",\"method_id\":\"$M\",\"mean\":5,\"sd\":0.2},{\"analyte_id\":\"$CREA\",\"method_id\":\"$M\",\"mean\":100,\"sd\":5},{\"analyte_id\":\"$UREA\",\"method_id\":\"$M\",\"mean\":5,\"sd\":0.5},{\"analyte_id\":\"$K\",\"method_id\":\"$M\",\"mean\":4,\"sd\":0.1}]}" >/dev/null
api PUT "/lab/qc/materials/$L2/targets" "$LM" -d "{\"targets\":[{\"analyte_id\":\"$GLU\",\"method_id\":\"$M\",\"mean\":15,\"sd\":0.5}]}" >/dev/null
TG=$(api GET "/lab/qc/materials/$L1/targets" "$LT"); T2=$(api GET "/lab/qc/materials/$L2/targets" "$LT")
tid() { echo "$1" | jq -r ".[]|select(.analyte_id==\"$2\")|.id"; }
TGLU=$(tid "$TG" "$GLU"); TCREA=$(tid "$TG" "$CREA"); TUREA=$(tid "$TG" "$UREA"); TK=$(tid "$TG" "$K"); TGLU2=$(tid "$T2" "$GLU")
[ -n "$TGLU" ] && [ -n "$TK" ] && [ -n "$TGLU2" ] && ok "სამიზნეები: L1 — 4 კომპონენტი, L2 — გლუკოზა" || die "სამიზნეები ვერ შეიქმნა"
chk "SD = 0 — 400" "$(code PUT "/lab/qc/materials/$L1/targets" "$LM" -d "{\"targets\":[{\"analyte_id\":\"$GLU\",\"method_id\":\"$M\",\"mean\":5,\"sd\":0}]}")" "400"

step "3. კონფიგურაცია (ხელმძღვანელი)"
chk "ნაგულისხმევი: სრული ნაკრები + დაბლოკვა" "$(api GET /lab/qc/rules "$LT" | jq -r ".analytes[]|select(.id==\"$GLU\")|\"\\(.rules|length):\\(.action)\"")" "6:block"
chk "ლაბორანტს წესების შეცვლა არ შეუძლია (403)" "$(code PUT "/lab/qc/rules/$CREA" "$LT" -d '{"rules":["4_1s"],"action":"warn"}')" "403"
chk "მენეჯერს (არა ხელმძღვანელს) — 403" "$(code PUT "/lab/qc/rules/$CREA" "$LM" -d '{"rules":["4_1s"],"action":"warn"}')" "403"
chk "უცნობი წესი — 400" "$(code PUT "/lab/qc/rules/$CREA" "$HEAD" -d '{"rules":["9_9s"],"action":"warn"}')" "400"
api PUT "/lab/qc/rules/$CREA" "$HEAD" -d '{"rules":["4_1s"],"action":"warn"}' >/dev/null
api PUT "/lab/qc/rules/$UREA" "$HEAD" -d '{"rules":["10x"],"action":"block"}' >/dev/null
chk "ხელმძღვანელი: კრეატინინი — 4-1s, გაფრთხილება; შარდოვანა — 10x" "$(api GET /lab/qc/rules "$LT" | jq -r "[.analytes[]|select(.id==\"$CREA\" or .id==\"$UREA\")|\"\\(.rules|join(\"+\")):\\(.action)\"]|sort|join(\",\")")" "10x:block,4_1s:warn"

step "4. Westgard — 1-2s, 1-3s, 2-2s; დაბლოკვა"
qc() { api POST /lab/qc/results "$1" -d "{\"target_id\":\"$2\",\"value\":$3}"; }
chk "5.10 (z 0.5) → მისაღები" "$(qc "$LT" "$TGLU" 5.1 | jq -r .status)" "accept"
chk "5.45 (z 2.25) → გაფრთხილება 1-2s" "$(qc "$LT" "$TGLU" 5.45 | jq -r '"\(.status):\(.violations|join(","))"')" "warn:1_2s"
chk "5.70 (z 3.5) → უარყოფა: 1-3s + 2-2s, დაბლოკვა" "$(qc "$LT" "$TGLU" 5.7 | jq -r '"\(.status):\(.violations|sort|join(",")):\(.action)"')" "reject:1_3s,2_2s:block"
chk "ღია დარღვევა: გლუკოზა" "$(api GET /lab/qc/violations "$LT" | jq -r "[.[]|select(.analyte_id==\"$GLU\")]|length")" "1"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"6$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"QC\",\"birth_date\":\"1970-07-07\",\"gender\":\"male\",\"phone_number\":\"591$S\"}" | jq -r '.id // empty')
item() {
  local e sh bc it; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  bc=$(api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  it=$(api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty')
  api PUT "/lab/items/$it/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$GLU\",\"value\":\"5.2\"},{\"analyte_id\":\"$CREA\",\"value\":\"90\"},{\"analyte_id\":\"$UREA\",\"value\":\"5\"},{\"analyte_id\":\"$K\",\"value\":\"4.2\"}]}" >/dev/null
  echo "$it"
}
I1=$(item)
chk "ფორმაში ჩანს QC-ის დარღვევა (დაბლოკვა)" "$(api GET "/lab/items/$I1" "$LT" | jq -r '[.qc_open[]|.action]|join(",")')" "block"
chk "ვალიდაცია დაბლოკილია (409)" "$(code POST "/lab/items/$I1/validate" "$HEAD")" "409"
chk "მიზეზით — მაინც დაბლოკილია (409)" "$(code POST "/lab/items/$I1/validate" "$HEAD" -d '{"qc_reason":"გადავამოწმე"}')" "409"
VG=$(api GET /lab/qc/violations "$LT" | jq -r "[.[]|select(.analyte_id==\"$GLU\")][0].id")
chk "ლაბორანტს განხილვა არ შეუძლია (403)" "$(code POST "/lab/qc/violations/$VG/resolve" "$LT" -d '{"cause":"x x x","corrective_action":"y y y"}')" "403"
chk "განხილვა: მიზეზი + მაკორექტირებელი ქმედება" "$(api POST "/lab/qc/violations/$VG/resolve" "$HEAD" -d '{"cause":"რეაგენტის ლოტი შეიცვალა","corrective_action":"რეკალიბრაცია, QC ხელახლა — OK"}' | jq -r .status)" "resolved"
chk "განხილვის შემდეგ — ვალიდაცია" "$(api POST "/lab/items/$I1/validate" "$HEAD" | jq -r .status)" "validated"

step "5. 4-1s — გაფრთხილება (ვალიდაცია მიზეზით)"
for v in 106 106.5 107; do qc "$LT" "$TCREA" "$v" >/dev/null; done
chk "4 ზედიზედ > +1 SD → 4-1s, გაფრთხილება" "$(qc "$LT" "$TCREA" 106.2 | jq -r '"\(.status):\(.violations|join(",")):\(.action)"')" "reject:4_1s:warn"
I2=$(item)
R=$(curl -s -X POST "$B/lab/items/$I2/validate" -H "authorization: Bearer $HEAD" -H "$J")
chk "მიზეზის გარეშე — 409 (QC_WARN)" "$(echo "$R" | jq -r '.code // .message.code // empty' | head -1)" "QC_WARN"
chk "მიზეზით — დადასტურდა (აუდიტში)" "$(api POST "/lab/items/$I2/validate" "$HEAD" -d '{"qc_reason":"შედეგი გადამოწმებულია სხვა ანალიზატორზე"}' | jq -r .status)" "validated"
VC=$(api GET /lab/qc/violations "$LT" | jq -r "[.[]|select(.analyte_id==\"$CREA\")][0].id")
api POST "/lab/qc/violations/$VC/resolve" "$HEAD" -d '{"cause":"სისტემური წანაცვლება","corrective_action":"კალიბრაცია"}' >/dev/null

step "6. R-4s, 10x, წესების გამორთვა"
qc "$LT" "$TGLU" 5.5 >/dev/null
chk "L1 +2.5 SD და L2 −2.6 SD ერთ სერიაში → R-4s" "$(qc "$LT" "$TGLU2" 13.7 | jq -r '"\(.status):\(.violations|index("R_4s") != null)"')" "reject:true"
VG=$(api GET /lab/qc/violations "$LT" | jq -r "[.[]|select(.analyte_id==\"$GLU\")][0].id")
api POST "/lab/qc/violations/$VG/resolve" "$HEAD" -d '{"cause":"შემთხვევითი შეცდომა","corrective_action":"ნიმუში ხელახლა"}' >/dev/null
for n in 1 2 3 4 5 6 7 8 9; do qc "$LT" "$TUREA" 5.1 >/dev/null; done
chk "10 ზედიზედ სამიზნის ერთ მხარეს → 10x" "$(qc "$LT" "$TUREA" 5.12 | jq -r '"\(.status):\(.violations|join(","))"')" "reject:10x"
chk "კალიუმი: წესების გარეშე — 4.5 (z 5) → მისაღები" "$(api PUT "/lab/qc/rules/$K" "$HEAD" -d '{"rules":[],"action":"block"}' >/dev/null; qc "$LT" "$TK" 4.5 | jq -r .status)" "accept"
chk "კალიუმი: მხოლოდ 1-2s → 4.25 — გაფრთხილება, დარღვევა არ იხსნება" "$(api PUT "/lab/qc/rules/$K" "$HEAD" -d '{"rules":["1_2s"],"action":"block"}' >/dev/null; qc "$LT" "$TK" 4.25 | jq -r .status):$(api GET /lab/qc/violations "$LT" | jq -r "[.[]|select(.analyte_id==\"$K\")]|length")" "warn:0"

step "7. გრაფიკი, სტატისტიკა, გამორიცხვა"
CH=$(api GET "/lab/qc/chart?target_id=$TGLU&from=$TODAY&to=$TODAY" "$LT")
chk "Levey-Jennings: გლუკოზა L1 — 4 წერტილი, mean 5, SD 0.2" "$(echo "$CH" | jq -r '"\(.points|length):\(.target.mean|tonumber):\(.target.sd|tonumber)"')" "4:5:0.2"
RID=$(echo "$CH" | jq -r '[.points[]|select((.value|tonumber)==5.7)][0].id')
chk "ლაბორანტს გამორიცხვა არ შეუძლია (403)" "$(code POST "/lab/qc/results/$RID/exclude" "$LT" -d '{"reason":"ბუშტი კიუვეტაში"}')" "403"
chk "გამორიცხვა მიზეზით (ხელმძღვანელი)" "$(api POST "/lab/qc/results/$RID/exclude" "$HEAD" -d '{"reason":"ბუშტი კიუვეტაში"}' >/dev/null; api GET "/lab/qc/chart?target_id=$TGLU&from=$TODAY&to=$TODAY" "$LT" | jq -r '[.points[]|select(.excluded_at!=null)]|length')" "1"
SM=$(api GET "/lab/qc/summary?from=$TODAY&to=$TODAY" "$LT")
chk "სტატისტიკა: გლუკოზა L1 — n, CV%, ღია დარღვევები" "$(echo "$SM" | jq -r "[.[]|select(.id==\"$TGLU\")][0]|(.n|tonumber) >= 3 and (.cv != null)")" "true"

step "8. QC ანალიზატორიდან (gateway)"
api PUT "/lab/instruments/$M" "$LM" -d '{"protocol":"astm","conn_mode":"server","port":4105,"is_enabled":true,"order_mode":"none"}' >/dev/null
api PUT "/lab/instruments/$M/codes" "$LM" -d "{\"codes\":[{\"code\":\"GLUC3\",\"analyte_id\":\"$GLU\"}]}" >/dev/null
sleep 7
if $SIM --json --proto astm --connect 127.0.0.1:4105 --qc --result "QC1-$S" GLUC3=5.02/mmol/L >/dev/null 2>&1; then
  sleep 1
  chk "ASTM QC (ნიშნით) → QC შედეგი, წყარო — ანალიზატორი" "$(api GET "/lab/qc/chart?target_id=$TGLU&from=$TODAY&to=$TODAY" "$LT" | jq -r '[.points[]|select(.source=="instrument")]|length')" "1"
  $SIM --json --proto astm --connect 127.0.0.1:4105 --result "QC2-$S" GLUC3=15.1/mmol/L >/dev/null 2>&1; sleep 1
  chk "QC მასალის შტრიხკოდი (ნიშნის გარეშეც) → L2 სამიზნე" "$(api GET "/lab/qc/chart?target_id=$TGLU2&from=$TODAY&to=$TODAY" "$LT" | jq -r '[.points[]|select(.source=="instrument")]|length')" "1"
  chk "QC პაციენტის შედეგებში / დასამუშავებელში არ ხვდება" "$(api GET "/lab/instrument-results?method_id=$M" "$LT" | jq -r length)" "0"
else bad "სიმულატორი ვერ გაეშვა" "$SIM"; fi

step "გასუფთავება"
for V in $(api GET /lab/qc/violations "$LT" | jq -r ".[]|select(.analyte_id==\"$UREA\" or .analyte_id==\"$GLU\" or .analyte_id==\"$CREA\" or .analyte_id==\"$K\")|.id"); do
  api POST "/lab/qc/violations/$V/resolve" "$HEAD" -d '{"cause":"e2e ტესტი","corrective_action":"e2e ტესტი"}' >/dev/null; done
CFG=$(api GET "/lab/instruments/$M" "$LM" | jq -c '.instrument|select(.)|{protocol,conn_mode,host,port,order_mode,settings,is_enabled:false}'); [ -n "$CFG" ] && api PUT "/lab/instruments/$M" "$LM" -d "$CFG" >/dev/null
for X in $(awk '/^q /{print $2}' "$TRACK"); do api PATCH "/lab/qc/materials/$X" "$LM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^m /{print $2}' "$TRACK"); do api PATCH "/lab/methods/$X" "$LM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -f "$TRACK"; ok "სატესტო მონაცემები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
