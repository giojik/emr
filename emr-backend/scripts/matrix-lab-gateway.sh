#!/usr/bin/env bash
# =====================================================================
# matrix-lab-gateway.sh (0086, D) — ანალიზატორის gateway არააქტიურ მოდულზე (lab_gateway გამორთული):
#   ASTM — ENQ-ზე NAK („დაკავშირებულია, მაგრამ დაკავებულია“; ანალიზატორი შედეგს ინახავს და ხელახლა ცდის), ჟურნალში შედეგი არ ჩნდება;
#   HL7 — ORU → ACK MSA|AE (ანალიზატორზე „გაუგზავნელი“), ჟურნალში — შეცდომით „lab_gateway inactive“;
#   მოდულის ჩართვის შემდეგ (≤ 15 წმ) — ASTM შედეგი ისევ მიიღება (ACK).
#   კონტეინერი / პროცესი ჩართული რჩება; მდგომარეობა — ModulesService (30 წმ ქეში + NOTIFY), gateway ამოწმებს 10 წმ-ში ერთხელ.
#   run-tests.sh --all-ში არ შედის (M): bash scripts/run-tests.sh 'matrix-*'
#   სიმულატორი: emr-lab-gateway კონტეინერში (ნაგულისხმევი) ან SIM="node /…/dist/lab-gateway/simulator.js"; პორტები 4103, 4104.
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
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
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა"
api()  { local m=$1 p=$2; shift 2; curl -s -X "$m" "$B$p" -H "authorization: Bearer $ADM" -H "$J" "$@"; }
mods() { api GET /modules; }
setm() { api PUT "/modules/$1" -d "{\"enabled\":$2,\"reason\":\"ტესტ-E2E gateway\"}"; }
st()   { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.state'; }
sim()  { timeout 25 $SIM --json "$@" 2>&1; }
S=$(date +%s | tail -c 6)

ORIG=$(mods | jq -r '.[]|select(.code=="lab_gateway")|.enabled')
[ "$(st lab_gateway)" = "active" ] || die "lab_gateway არ არის აქტიური — ტესტს სჭირდება ჩართული (dev / ლიცენზია)"
M1=""; M2=""
cleanup() {
  [ "$(mods | jq -r '.[]|select(.code=="lab_gateway")|.enabled')" = "$ORIG" ] || setm lab_gateway "$ORIG" >/dev/null
  [ -n "$M1" ] && api PUT "/lab/instruments/$M1" -d '{"protocol":"astm","conn_mode":"server","port":4103,"is_enabled":false,"order_mode":"query"}' >/dev/null
  [ -n "$M2" ] && api PUT "/lab/instruments/$M2" -d '{"protocol":"hl7","conn_mode":"server","port":4104,"is_enabled":false,"order_mode":"query"}' >/dev/null
  for m in $M1 $M2; do api PATCH "/lab/methods/$m" -d '{"is_active":false}' >/dev/null; done; M1=""; M2=""
}
trap cleanup EXIT

step "0. გარემო"
chk "gateway მუშაობს (პულსი)" "$(api GET /lab/gateway | jq -r .alive)" "true"
$SIM --help >/dev/null 2>&1; [ $? -ne 127 ] && ok "სიმულატორი ხელმისაწვდომია" || die "სიმულატორი ვერ გაეშვა: $SIM"
SVC=$(api POST /dx/catalog -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_GM_$S\",\"name\":\"ტესტ-E2E gateway $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty')
GLU=$(api POST "/dx/catalog/$SVC/analytes" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"sort_order":1,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.9,"high":6.1}]}' | jq -r '.analytes[]|select(.code=="GLU")|.id')
M1=$(api POST /lab/methods -d "{\"name\":\"ტესტ-E2E GM ASTM $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty')
M2=$(api POST /lab/methods -d "{\"name\":\"ტესტ-E2E GM HL7 $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty')
chk "ASTM :4103 / HL7 :4104 (სერვერი)" \
  "$(api PUT "/lab/instruments/$M1" -d '{"protocol":"astm","conn_mode":"server","port":4103,"is_enabled":true,"order_mode":"query"}' | jq -r .instrument.port):$(api PUT "/lab/instruments/$M2" -d '{"protocol":"hl7","conn_mode":"server","port":4104,"is_enabled":true,"order_mode":"query"}' | jq -r .instrument.port)" "4103:4104"
api PUT "/lab/instruments/$M1/codes" -d "{\"codes\":[{\"code\":\"GLUC3\",\"analyte_id\":\"$GLU\"}]}" >/dev/null
api PUT "/lab/instruments/$M2/codes" -d "{\"codes\":[{\"code\":\"GLU\",\"analyte_id\":\"$GLU\"}]}" >/dev/null
sleep 7
chk "gateway უსმენს :4103" "$(api GET /lab/instruments | jq -r ".[]|select(.method_id==\"$M1\")|.status")" "listening"
cnt() { api GET "/lab/instruments/$1/messages" | jq -r --arg k "$2" '[.[]|select(.kind==$k and .direction=="in")]|length'; }
cntb() { api GET "/lab/instruments/$1/messages?limit=500" | jq -r --arg b "$2" '[.[]|select(.kind=="results" and .direction=="in" and .error==null and (.raw|contains($b)))]|length'; }   # შეცდომის გარეშე ჩაწერილი შედეგი — ნიმუშით

step "1. lab_gateway გამორთულია → NAK / AE"
chk "lab_gateway → გამორთვა" "$(setm lab_gateway false | jq -r .state)" "disabled"
sleep 12   # gateway: მოდულის მდგომარეობა — 10 წმ-ში ერთხელ
O=$(sim --proto astm --connect 127.0.0.1:4103 --result "9$S" GLUC3=5.4/mmol/L --wait 3)
chk "ASTM: ENQ → NAK (ანალიზატორი ხელახლა ცდის), შედეგი არ გაიგზავნა" \
  "$(echo "$O" | jq -rs '[.[]|select(.type=="log" and (.text|test("NAK")))]|length > 0'):$(echo "$O" | jq -rs '[.[]|select(.type=="sent")]|length')" "true:0"
# ჟურნალი (lab_gateway-ის API) — გამორთულზე 403; მოწმდება ჩართვის შემდეგ (2)
O=$(sim --proto hl7 --connect 127.0.0.1:4104 --result "8$S" GLU=5.4/mmol/L)
chk "HL7: ORU → ACK MSA|AE" "$(echo "$O" | jq -rs '[.[]|select(.type=="ack")][0].code // "—"')" "AE"

step "2. lab_gateway ჩართულია → მიღება აღდგა"
chk "lab_gateway → ჩართვა" "$(setm lab_gateway true | jq -r .state)" "active"
sleep 12
O=$(sim --proto astm --connect 127.0.0.1:4103 --result "7$S" GLUC3=5.4/mmol/L)
chk "ASTM: შედეგი გაიგზავნა (ACK)" "$(echo "$O" | jq -rs '[.[]|select(.type=="sent")]|length')" "1"
sleep 1
# 0090: ნიმუშის ნომრით (არა ჯამური რაოდენობით) — ჩართვის მომენტის ხელახალი ცდა / დუბლი ჟურნალში მეორე ჩანაწერს ამატებს და ტესტს დროის ფანჯარაზე ამოკიდებდა
chk "ASTM: ჟურნალში შედეგი — მხოლოდ ჩართვის შემდეგი (7…: ჩაიწერა; გამორთულზე გაგზავნილი 9… — არა)" "$([ "$(cntb "$M1" "7$S")" -ge 1 ] && echo yes || echo no):$(cntb "$M1" "9$S")" "yes:0"
chk "HL7: ჟურნალში — შეცდომით „lab_gateway inactive“ (შედეგი არ დამუშავდა, 30 დღე ინახება)" \
  "$(api GET "/lab/instruments/$M2/messages" | jq -r '[.[]|select(.kind=="results" and .direction=="in")][0].error // "—"|test("lab_gateway inactive")')" "true"
O=$(sim --proto hl7 --connect 127.0.0.1:4104 --result "6$S" GLU=5.4/mmol/L)
chk "HL7: ORU → ACK MSA|AA" "$(echo "$O" | jq -rs '[.[]|select(.type=="ack")][0].code // "—"')" "AA"

cleanup; trap - EXIT
printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
