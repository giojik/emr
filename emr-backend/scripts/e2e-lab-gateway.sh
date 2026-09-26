#!/usr/bin/env bash
# =====================================================================
# e2e-lab-gateway.sh — ანალიზატორების მიერთება (0019) ვირტუალური ანალიზატორით
#   ASTM (host query → შეკვეთა; შედეგები → EMR), HL7 (ORU → ACK; QRY → ORM),
#   push (მიღებული სინჯარის შეკვეთა ანალიზატორზე), დასამუშავებელი (უცნობი კოდი, არარიცხვითი, ერთეული, QC),
#   ნორმა ანალიზატორით, ვალიდაცია — მხოლოდ ადამიანი
# ქმნის ცალკე სატესტო კვლევას და ანალიზატორებს (ტესტ-E2E) — რეალურ კონფიგურაციას არ ეხება.
# გამოყენება:  bash scripts/e2e-lab-gateway.sh [API_URL]      (ნაგულისხმევი: http://localhost/api)
# სიმულატორი ეშვება emr-lab-gateway კონტეინერში; სხვა გარემოში: SIM="node dist/lab-gateway/simulator.js"
# საჭიროა: curl, jq; თავისუფალი პორტები 4108, 4109 (სერვერი) და 4150 (კლიენტის ტესტი)
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
S=$(date +%s | tail -c 7)
CREATED_USERS=(); TRACK=$(mktemp)   # mkuser/newmethod ეშვება $(…)-ში (subshell) — ID-ები ფაილში
sim() { $SIM --json "$@" 2>&1; }
orders_of() { echo "$1" | jq -rs '[.[]|select(.type=="orders")][-1]|if . then (.codes|join(",")) else "—" end' 2>/dev/null; }

step "0. გარემო"
chk "API ხელმისაწვდომია" "$(curl -s "$B/health" | jq -r .status)" "ok"
VER=$(curl -s "$B/health" | jq -r .schemaVersion); if [ "$VER" \> "0018" ]; then ok "სქემის ვერსია $VER"; else bad "სქემის ვერსია" "საჭიროა ≥ 0019, არის $VER"; fi
chk "gateway მუშაობს (პულსი)" "$(api GET /lab/gateway "$ADM" | jq -r .alive)" "true"
$SIM --help >/dev/null 2>&1; [ $? -ne 127 ] && ok "სიმულატორი ხელმისაწვდომია" || die "სიმულატორი ვერ გაეშვა: $SIM"

step "1. მომხმარებლები და სატესტო კვლევა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.gw.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\",\"is_section_head\":$3}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { bad "მომხმარებელი ($1)" "$(echo "$R" | jq -rc .message)"; return; }
  echo "$id" >> "$TRACK"
  local t; t=$(login "e2e.gw.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
LM=$(mkuser lab_manager 71 false); LD=$(mkuser lab_doctor 72 true); RC=$(mkuser receptionist 73 false); PH=$(mkuser phlebotomist 74 false); LT=$(mkuser diagnostic 75 false)
[ -n "$LM" ] && [ -n "$LD" ] && [ -n "$RC" ] && [ -n "$PH" ] && [ -n "$LT" ] && ok "5 სატესტო მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_GW_$S\",\"name\":\"ტესტ-E2E ბიოქიმია $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty')
[ -n "$SVC" ] || die "სატესტო კვლევა ვერ შეიქმნა"
api POST "/dx/catalog/$SVC/analytes" "$LM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"sort_order":1,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.9,"high":6.1}]}' >/dev/null
R=$(api POST "/dx/catalog/$SVC/analytes" "$LM" -d '{"code":"CREA","name":"კრეატინინი","unit":"µmol/L","result_type":"numeric","decimals":0,"sort_order":2,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":62,"high":106}]}')
GLU=$(echo "$R" | jq -r '.analytes[]|select(.code=="GLU")|.id'); CREA=$(echo "$R" | jq -r '.analytes[]|select(.code=="CREA")|.id')
[ -n "$GLU" ] && [ -n "$CREA" ] && ok "კვლევა: გლუკოზა (mmol/L) + კრეატინინი (µmol/L)" || die "კომპონენტები ვერ შეიქმნა"

newmethod() { local id; id=$(api POST /lab/methods "$LM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"kind\":\"analyzer\"}" | jq -r '.id // empty'); echo "m $id" >> "$TRACK.m"; echo "$id"; }
M1=$(newmethod ASTM); M2=$(newmethod HL7); M3=$(newmethod PUSH)
[ -n "$M1" ] && [ -n "$M2" ] && [ -n "$M3" ] && ok "3 ვირტუალური ანალიზატორი" || die "ანალიზატორები ვერ შეიქმნა"

step "2. კავშირის კონფიგურაცია"
chk "ლაბორანტს კონფიგურაცია არ შეუძლია (403)" "$(code PUT "/lab/instruments/$M1" "$LT" -d '{"protocol":"astm","conn_mode":"server","port":4108,"is_enabled":true,"order_mode":"query"}')" "403"
chk "სერვერის პორტი დიაპაზონის გარეთ — 400" "$(code PUT "/lab/instruments/$M1" "$LM" -d '{"protocol":"astm","conn_mode":"server","port":5000,"is_enabled":true,"order_mode":"query"}')" "400"
chk "კლიენტი მისამართის გარეშე — 400" "$(code PUT "/lab/instruments/$M1" "$LM" -d '{"protocol":"astm","conn_mode":"client","port":4001,"is_enabled":true,"order_mode":"query"}')" "400"
chk "ASTM: სერვერი :4108, host query" "$(api PUT "/lab/instruments/$M1" "$LM" -d '{"protocol":"astm","conn_mode":"server","port":4108,"is_enabled":true,"order_mode":"query"}' | jq -r .instrument.port)" "4108"
chk "იგივე პორტი მეორეზე — 409" "$(code PUT "/lab/instruments/$M2" "$LM" -d '{"protocol":"hl7","conn_mode":"server","port":4108,"is_enabled":true,"order_mode":"query"}')" "409"
chk "HL7: სერვერი :4109, host query" "$(api PUT "/lab/instruments/$M2" "$LM" -d '{"protocol":"hl7","conn_mode":"server","port":4109,"is_enabled":true,"order_mode":"query"}' | jq -r .instrument.protocol)" "hl7"
CODES1="{\"codes\":[{\"code\":\"GLUC3\",\"analyte_id\":\"$GLU\"},{\"code\":\"CREJ2\",\"analyte_id\":\"$CREA\"}]}"
chk "ASTM კოდები: GLUC3 → გლუკოზა, CREJ2 → კრეატინინი" "$(api PUT "/lab/instruments/$M1/codes" "$LM" -d "$CODES1" | jq -r '.codes|length')" "2"
chk "დუბლირებული კოდი — 400" "$(code PUT "/lab/instruments/$M1/codes" "$LM" -d "{\"codes\":[{\"code\":\"X\",\"analyte_id\":\"$GLU\"},{\"code\":\"x\",\"analyte_id\":\"$CREA\"}]}")" "400"
# HL7: CREA mg/dL → µmol/L (×88.42), GLU — ერთეულის შემოწმებით
CODES2="{\"codes\":[{\"code\":\"GLU\",\"analyte_id\":\"$GLU\"},{\"code\":\"CREA\",\"analyte_id\":\"$CREA\",\"factor\":88.42}]}"
chk "HL7 კოდები (კრეატინინი mg/dL → µmol/L, ×88.42)" "$(api PUT "/lab/instruments/$M2/codes" "$LM" -d "$CODES2" | jq -r '.codes|length')" "2"
sleep 7
chk "gateway უსმენს :4108" "$(api GET /lab/instruments "$LT" | jq -r ".[]|select(.method_id==\"$M1\")|.status")" "listening"

step "3. პაციენტი → ვიზიტი → აღება → მიღება"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"7$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ანალიზატორი\",\"birth_date\":\"1980-01-15\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] || die "პაციენტი ვერ შეიქმნა"
visit() {
  local e sh sp bc
  e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  bc=$(api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
  echo "$bc"
}
BC=$(visit); [ -n "$BC" ] && ok "სინჯარა $BC აღებულია" || die "აღება ვერ მოხერხდა"
api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC\"}" >/dev/null
IT=$(api GET "/lab/worklist?search=$BC" "$LT" | jq -r '.[0].id // empty'); [ -n "$IT" ] && ok "მიღებულია ლაბორატორიაში" || die "სამუშაო სიაში ვერ მოიძებნა"

step "4. ASTM: host query → შეკვეთა; შედეგები → EMR"
O=$(sim --proto astm --connect 127.0.0.1:4108 --query "$BC"); chk "ქვერი: ანალიზატორმა მიიღო GLUC3, CREJ2" "$(orders_of "$O")" "GLUC3,CREJ2"
O=$(sim --proto astm --connect 127.0.0.1:4108 --query "00$BC"); chk "წინ ნულებიანი შტრიხკოდიც იცნობა" "$(orders_of "$O")" "GLUC3,CREJ2"
O=$(sim --proto astm --connect 127.0.0.1:4108 --query "999$S"); chk "უცნობი სინჯარა — „შეკვეთა არ არის“" "$(echo "$O" | jq -rs '[.[]|select(.type=="orders")][-1].none')" "true"
O=$(sim --proto astm --connect 127.0.0.1:4108 --result "$BC" GLUC3=7.8/mmol/L CREJ2=95/µmol/L)
chk "შედეგები გაიგზავნა (ASTM ჩარჩოები, ACK)" "$(echo "$O" | jq -rs '[.[]|select(.type=="sent")]|length')" "1"
sleep 1
I=$(api GET "/lab/items/$IT" "$LT")
chk "EMR: GLU 7.8 → H, CREA 95 → N" "$(echo "$I" | jq -r '[.results[]|"\(.code):\(.value_num|tonumber):\(.flag)"]|sort|join(",")')" "CREA:95:N,GLU:7.8:H"
chk "სტატუსი — ვალიდაციას ელოდება" "$(echo "$I" | jq -r .status)" "resulted"
chk "შედეგი მონიშნულია ანალიზატორით" "$(echo "$I" | jq -r '[.results[]|.instrument_id != null]|all')" "true"
chk "ანალიზატორი მიეთითა შეკვეთას (ნორმისთვის)" "$(echo "$I" | jq -r ".lab_method_id == \"$M1\"")" "true"
chk "ჟურნალში: ქვერი, შეკვეთა, შედეგები" "$(api GET "/lab/instruments/$M1/messages" "$LT" | jq -r '[.[].kind]|unique|sort|join(",")')" "orders,query,results"
O=$(sim --proto astm --connect 127.0.0.1:4108 --result "$BC" GLUC3=5.1/mmol/L); sleep 1
chk "განმეორებითი გაზომვა → 5.1, N" "$(api GET "/lab/items/$IT" "$LT" | jq -r '.results[]|select(.code=="GLU")|"\(.value_num|tonumber):\(.flag)"')" "5.1:N"

step "5. დასამუშავებელი"
sim --proto astm --connect 127.0.0.1:4108 --result "$BC" XXX9=1 >/dev/null
sim --proto astm --connect 127.0.0.1:4108 --result "$BC" GLUC3="<0.5" >/dev/null
sim --proto astm --connect 127.0.0.1:4108 --result "$BC" CREJ2=1.1/mg/dL >/dev/null
sim --proto astm --connect 127.0.0.1:4108 --result "12345$S" GLUC3=5 >/dev/null
sim --proto astm --connect 127.0.0.1:4108 --qc --result "QC$S" GLUC3=5.5 >/dev/null
sleep 1
U=$(api GET "/lab/instrument-results?method_id=$M1" "$LT")
chk "უცნობი კოდი" "$(echo "$U" | jq -r '[.[]|select(.code=="XXX9")][0].reason')" "კოდი „XXX9“ რუკაში არ არის"
chk "არარიცხვითი მნიშვნელობა" "$(echo "$U" | jq -r '[.[]|select(.value=="<0.5")][0].reason|startswith("არარიცხვითი")')" "true"
chk "ერთეული განსხვავდება (mg/dL ≠ µmol/L)" "$(echo "$U" | jq -r '[.[]|select(.unit=="mg/dL")][0].reason|startswith("ერთეული")')" "true"
chk "უცნობი შტრიხკოდი" "$(echo "$U" | jq -r "[.[]|select(.barcode==\"12345$S\")][0].reason|endswith(\"ვერ მოიძებნა\")")" "true"
chk "QC სიაში არ ხვდება" "$(echo "$U" | jq -r "[.[]|select(.barcode==\"QC$S\")]|length")" "0"
chk "მრიცხველი ≥ 4" "$(api GET /lab/instrument-results/count "$LT" | jq -r '.unmatched >= 4')" "true"
XID=$(echo "$U" | jq -r '[.[]|select(.code=="XXX9")][0].id')
chk "რუკა შესწორდა (XXX9 → გლუკოზა) → „ხელახლა“ → მიბმულია" "$(api PUT "/lab/instruments/$M1/codes" "$LM" -d "{\"codes\":[{\"code\":\"XXX9\",\"analyte_id\":\"$GLU\"},{\"code\":\"CREJ2\",\"analyte_id\":\"$CREA\"}]}" >/dev/null; api POST "/lab/instrument-results/$XID/retry" "$LT" | jq -r .status)" "applied"
NID=$(echo "$U" | jq -r "[.[]|select(.barcode==\"12345$S\")][0].id")
chk "უარყოფა მიზეზით" "$(api POST "/lab/instrument-results/$NID/dismiss" "$LT" -d '{"reason":"სატესტო სინჯარა"}' | jq -r .status)" "dismissed"
api PUT "/lab/instruments/$M1/codes" "$LM" -d "$CODES1" >/dev/null

step "6. ვალიდაცია — მხოლოდ ადამიანი; დადასტურებულს ანალიზატორი ვერ ცვლის"
chk "ლაბ. ექიმი ადასტურებს" "$(api POST "/lab/items/$IT/validate" "$LD" | jq -r .status)" "validated"
sim --proto astm --connect 127.0.0.1:4108 --result "$BC" GLUC3=9.9 >/dev/null; sleep 1
chk "ახალი მნიშვნელობა → დასამუშავებელი („უკვე დადასტურებულია“)" "$(api GET "/lab/instrument-results?method_id=$M1" "$LT" | jq -r '[.[]|select(.value=="9.9")][0].reason|startswith("შედეგი უკვე დადასტურებულია")')" "true"
chk "დადასტურებული უცვლელია (9.9 არ ჩაიწერა)" "$(api GET "/lab/items/$IT" "$LT" | jq -r '.results[]|select(.code=="GLU")|(.value_num|tonumber) != 9.9')" "true"

step "7. HL7: QRY → ORM; ORU → ACK; ერთეულის გადაყვანა"
BC2=$(visit); api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC2\"}" >/dev/null
IT2=$(api GET "/lab/worklist?search=$BC2" "$LT" | jq -r '.[0].id // empty')
O=$(sim --proto hl7 --connect 127.0.0.1:4109 --query "$BC2"); chk "QRY^Q02 → ORM^O01: GLU, CREA" "$(orders_of "$O")" "GLU,CREA"
O=$(sim --proto hl7 --connect 127.0.0.1:4109 --result "$BC2" GLU=4.4/mmol/L CREA=1.2/mg/dL)
chk "ORU^R01 → ACK AA" "$(echo "$O" | jq -rs '[.[]|select(.type=="ack")][0].code')" "AA"
sleep 1
chk "EMR: GLU 4.4, CREA 1.2 mg/dL × 88.42 = 106.104 µmol/L" "$(api GET "/lab/items/$IT2" "$LT" | jq -r '[.results[]|"\(.code):\(.value_num|tonumber)"]|sort|join(",")')" "CREA:106.104,GLU:4.4"

step "8. push: მიღებული სინჯარის შეკვეთა ანალიზატორზე (gateway — კლიენტი)"
api PUT "/lab/instruments/$M3/codes" "$LM" -d '{"codes":[]}' >/dev/null 2>&1
TMP=$(mktemp)
$SIM --json --proto astm --listen 4150 --wait 25 > "$TMP" 2>&1 &
SIMPID=$!
sleep 2
api PUT "/lab/instruments/$M3" "$LM" -d '{"protocol":"astm","conn_mode":"client","host":"127.0.0.1","port":4150,"is_enabled":true,"order_mode":"push"}' >/dev/null
api PUT "/lab/instruments/$M3/codes" "$LM" -d "{\"codes\":[{\"code\":\"BIO\",\"service_id\":\"$SVC\"},{\"code\":\"GLU\",\"analyte_id\":\"$GLU\",\"send_order\":false}]}" >/dev/null
BC3=$(visit); api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC3\"}" >/dev/null
for i in $(seq 1 20); do grep -q "\"$BC3\"" "$TMP" && break; sleep 1; done
chk "gateway დაუკავშირდა ანალიზატორს" "$(api GET /lab/instruments "$LT" | jq -r ".[]|select(.method_id==\"$M3\")|.status")" "connected"
chk "შეკვეთა გაიგზავნა პანელის კოდით (BIO)" "$(jq -rs "[.[]|select(.type==\"orders\" and .barcode==\"$BC3\")][0].codes|join(\",\")" "$TMP" 2>/dev/null)" "BIO"
kill $SIMPID 2>/dev/null; wait $SIMPID 2>/dev/null; rm -f "$TMP"

step "გასუფთავება"
for M in $(awk '{print $2}' "$TRACK.m" 2>/dev/null); do
  CFG=$(api GET "/lab/instruments/$M" "$LM" | jq -c '.instrument|select(.)|{protocol,conn_mode,host,port,order_mode,settings,is_enabled:false}')
  [ -n "$CFG" ] && api PUT "/lab/instruments/$M" "$LM" -d "$CFG" >/dev/null
  api PATCH "/lab/methods/$M" "$LM" -d '{"is_active":false}' >/dev/null
done
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TRACK"); do api POST "/users/$U/disable" "$ADM" >/dev/null; done
ok "სატესტო ანალიზატორები, კვლევა და მომხმარებლები გათიშულია (ისტორია რჩება — სახელი: ტესტ-E2E)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
