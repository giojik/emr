#!/usr/bin/env bash
# =====================================================================
# e2e-lab-gateway-admin.sh — ანალიზატორების მართვის პანელი (0020), API-ით
#   დაფა, მოსმენის რეჟიმი (შედეგი EMR-ში არ იწერება), აღმოჩენილი კოდები, კავშირის შემოწმება (TCP / ASTM ENQ-ACK),
#   ხელახლა დაკავშირება, საერთო ჟურნალი, გაფრთხილებები (კავშირის გაწყვეტა → გახსნა → დახურვა), სატესტო შეტყობინება
# ქმნის ცალკე ვირტუალურ ანალიზატორებს (ტესტ-E2E); გაფრთხილებების პარამეტრებს ბოლოს აღადგენს. ხანგრძლივობა ~4 წთ.
# გამოყენება:  bash scripts/e2e-lab-gateway-admin.sh [API_URL]      სიმულატორი — როგორც e2e-lab-gateway.sh-ში (SIM=…)
# საჭიროა: curl, jq; თავისუფალი პორტები 4107 (სერვერი), 4197/4198 (არ უნდა უსმენდეს არაფერი)
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
command -v jq >/dev/null || die "jq არ არის დაყენებული: sudo apt install -y jq"

read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TRACK=$(mktemp)
sim() { $SIM --json "$@" 2>&1; }
# ბრძანება gateway-ს → შედეგის მოლოდინი (≤ 20 წმ)
cmd() {
  local id r; id=$(api POST /lab/gateway/commands "$ADM" -d "$1" | jq -r '.id // empty')
  [ -n "$id" ] || { echo '{"status":"error"}'; return; }
  for _ in $(seq 1 40); do r=$(api GET "/lab/gateway/commands/$id" "$ADM"); case "$(echo "$r" | jq -r .status)" in done|failed) echo "$r"; return;; esac; sleep 0.5; done
  echo "$r"
}

step "0. დაფა"
D=$(api GET /lab/gateway/dashboard "$ADM")
chk "gateway მუშაობს" "$(echo "$D" | jq -r .gateway.alive)" "true"
echo "      შეტყობინებები: ელ-ფოსტა $(echo "$D" | jq -r .notify.email), SMS $(echo "$D" | jq -r .notify.sms) (კონფიგურაცია .env-ში)"
LM=$(api POST /users "$ADM" -d "{\"email\":\"e2e.gwa.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"lab_manager\",\"personal_number\":\"66$(printf '%09d' "$S")\",\"role\":\"lab_manager\"}")
LMID=$(echo "$LM" | jq -r '.user.id // empty'); echo "$LMID" >> "$TRACK"
LMT=$(login "e2e.gwa.$S@test.local" "$(echo "$LM" | jq -r .temporaryPassword)")
chk "ლაბ. მენეჯერს პანელი დახურული აქვს (403)" "$(code GET /lab/gateway/dashboard "$LMT")" "403"

step "1. ახალი აპარატი — მოსმენის რეჟიმი"
M=$(api POST /lab/methods "$ADM" -d "{\"name\":\"ტესტ-E2E პანელი $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty'); echo "m $M" >> "$TRACK"
[ -n "$M" ] || die "ანალიზატორი ვერ შეიქმნა"
chk "შემოწმება შენახვამდე: :4197 — უარყოფილი" "$(cmd '{"kind":"tcp_test","host":"127.0.0.1","port":4197,"protocol":"astm"}' | jq -r .status)" "failed"
api PUT "/lab/instruments/$M" "$ADM" -d '{"protocol":"astm","conn_mode":"server","port":4107,"is_enabled":true,"order_mode":"query"}' >/dev/null
chk "მოსმენის რეჟიმი ჩაირთო" "$(api PATCH "/lab/gateway/instruments/$M/options" "$ADM" -d '{"listen_only":true}' | jq -r .listen_only)" "true"
sleep 7
chk "link_test ანალიზატორის გარეშე — „ელოდება“" "$(cmd "{\"kind\":\"link_test\",\"method_id\":\"$M\"}" | jq -r '.result.error|test("ელოდება")')" "true"
chk "TCP + ASTM ENQ → ACK (:4107)" "$(cmd '{"kind":"tcp_test","host":"127.0.0.1","port":4107,"protocol":"astm"}' | jq -r .result.astm)" "ACK"

step "2. მოსმენა: შეტყობინებები ჩანს, EMR-ში არაფერი იწერება"
O=$(sim --proto astm --connect 127.0.0.1:4107 --query "LSN$S" --result "LSN$S" NA=140/mmol/L K=4.1/mmol/L CL=101)
chk "ქვერზე — „შეკვეთა არ არის“ (მოსმენისას შეკვეთა არ იგზავნება)" "$(echo "$O" | jq -rs '[.[]|select(.type=="orders")][0].none')" "true"
sleep 1
SC=$(api GET "/lab/instruments/$M/seen-codes" "$ADM")
chk "აღმოჩენილი კოდები: CL, K, NA" "$(echo "$SC" | jq -r '[.[].code]|sort|join(",")')" "CL,K,NA"
chk "ბოლო მნიშვნელობა და ერთეული (NA 140 mmol/L)" "$(echo "$SC" | jq -r '.[]|select(.code=="NA")|"\(.last_value) \(.last_unit)"')" "140 mmol/L"
chk "ყველა — რუკის გარეშე" "$(echo "$SC" | jq -r '[.[]|select(.mapping_id==null)]|length')" "3"
chk "შედეგების სიაში არაფერი (მოსმენა)" "$(api GET "/lab/instrument-results?status=all&method_id=$M" "$ADM" | jq -r length)" "0"
D=$(api GET /lab/gateway/dashboard "$ADM")
chk "დაფა: რუკის გარეშე 3 კოდი" "$(echo "$D" | jq -r ".instruments[]|select(.method_id==\"$M\")|.unmapped_codes|tonumber")" "3"
chk "დაფა: დღეს 1 ქვერი" "$(echo "$D" | jq -r ".instruments[]|select(.method_id==\"$M\")|.queries_today|tonumber")" "1"
L=$(api GET "/lab/gateway/log?method_id=$M&search=LSN$S" "$ADM")
chk "საერთო ჟურნალი: ძებნა შტრიხკოდით (ქვერი, პასუხი, შედეგი)" "$(echo "$L" | jq -r '[.[].kind]|unique|sort|join(",")')" "orders,query,results"
chk "ჟურნალი: მხოლოდ გამავალი" "$(api GET "/lab/gateway/log?method_id=$M&direction=out" "$ADM" | jq -r '[.[].direction]|unique|join(",")')" "out"

step "3. შემოწმება არსებული კავშირით და ხელახლა დაკავშირება"
TMP=$(mktemp); $SIM --json --proto astm --connect 127.0.0.1:4107 --wait 12 > "$TMP" 2>&1 &
SP=$!; sleep 3
R=$(cmd "{\"kind\":\"link_test\",\"method_id\":\"$M\"}")
chk "link_test: არსებული კავშირით, ENQ → ACK" "$(echo "$R" | jq -r '"\(.result.via):\(.result.astm)"')" "existing:ACK"
chk "reconnect" "$(cmd "{\"kind\":\"reconnect\",\"method_id\":\"$M\"}" | jq -r .status)" "done"
kill $SP 2>/dev/null; wait $SP 2>/dev/null; rm -f "$TMP"
chk "შენახული აპარატის გარეშე reconnect — 400" "$(code POST /lab/gateway/commands "$ADM" -d '{"kind":"reconnect","host":"1.2.3.4","port":1}')" "400"

step "4. გაფრთხილებები: კავშირის გაწყვეტა → გახსნა → დახურვა (~2–3 წთ)"
ORIG=$(api GET /lab/gateway/alert-settings "$ADM" | jq -c '{enabled,disconnect_minutes,silent_minutes,work_start:(.work_start[0:5]),work_end:(.work_end[0:5]),work_days,sms_phones,emails,notify_resolved}')
chk "არასწორი ტელეფონი — 400" "$(code PUT /lab/gateway/alert-settings "$ADM" -d "$(echo "$ORIG" | jq -c '.sms_phones=["abc"]')")" "400"
chk "პარამეტრები: კავშირი — 1 წთ" "$(api PUT /lab/gateway/alert-settings "$ADM" -d "$(echo "$ORIG" | jq -c '.enabled=true|.disconnect_minutes=1')" | jq -r .disconnect_minutes)" "1"
M2=$(api POST /lab/methods "$ADM" -d "{\"name\":\"ტესტ-E2E მიუწვდომელი $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty'); echo "m $M2" >> "$TRACK"
api PUT "/lab/instruments/$M2" "$ADM" -d '{"protocol":"astm","conn_mode":"client","host":"127.0.0.1","port":4198,"is_enabled":true,"order_mode":"none"}' >/dev/null
printf '      ელოდება გაფრთხილებას'
A=""; for _ in $(seq 1 36); do A=$(api GET /lab/gateway/dashboard "$ADM" | jq -c "[.open_alerts[]|select(.method_id==\"$M2\" and .kind==\"disconnected\")][0] // empty"); [ -n "$A" ] && break; printf '.'; sleep 5; done; echo
[ -n "$A" ] && ok "გაიხსნა: „$(echo "$A" | jq -r .message | cut -c1-70)…“" || bad "გაფრთხილება კავშირის გაწყვეტაზე" "3 წუთში არ გაიხსნა"
chk "შეტყობინების მცდელობა ჩაიწერა (გაგზავნილი ან მიზეზი)" "$(echo "$A" | jq -r '.notified != null')" "true"
api PUT "/lab/instruments/$M2" "$ADM" -d '{"protocol":"astm","conn_mode":"client","host":"127.0.0.1","port":4198,"is_enabled":false,"order_mode":"none"}' >/dev/null
printf '      ელოდება დახურვას'
C=""; for _ in $(seq 1 24); do C=$(api GET /lab/gateway/alerts "$ADM" | jq -r "[.[]|select(.name==\"ტესტ-E2E მიუწვდომელი $S\" and .resolved_at!=null)]|length"); [ "$C" = "1" ] && break; printf '.'; sleep 5; done; echo
chk "ანალიზატორის გამორთვის შემდეგ — დაიხურა" "$C" "1"
T=$(api POST /lab/gateway/alerts/test "$ADM")
chk "სატესტო შეტყობინება: პასუხი კონფიგურაციით" "$(echo "$T" | jq -r '.configured|has("sms") and has("email")')" "true"
api PUT /lab/gateway/alert-settings "$ADM" -d "$ORIG" >/dev/null && ok "გაფრთხილებების პარამეტრები აღდგა"

step "გასუფთავება"
for X in $(awk '/^m /{print $2}' "$TRACK"); do
  CFG=$(api GET "/lab/instruments/$X" "$ADM" | jq -c '.instrument|select(.)|{protocol,conn_mode,host,port,order_mode,settings,is_enabled:false}')
  [ -n "$CFG" ] && api PUT "/lab/instruments/$X" "$ADM" -d "$CFG" >/dev/null
  api PATCH "/lab/methods/$X" "$ADM" -d '{"is_active":false}' >/dev/null
done
for U in $(grep -v '^m ' "$TRACK"); do api POST "/users/$U/disable" "$ADM" >/dev/null; done
rm -f "$TRACK"
ok "სატესტო ანალიზატორები და მომხმარებელი გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
