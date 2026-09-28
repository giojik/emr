#!/usr/bin/env bash
# =====================================================================
# e2e-lab-external.sh — გარე ლაბორატორია, ანგარიშსწორება, delta-check, კუმულაციური შედეგები, სტატისტიკა (0021)
# ქმნის სატესტო ლაბორატორიას/ანალიზებს/პაციენტს (ტესტ-E2E); ბოლოს თიშავს.
# გამოყენება:  bash scripts/e2e-lab-external.sh [API_URL]     (ნაგულისხმევი: http://localhost/api)
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
command -v jq >/dev/null || die "jq არ არის დაყენებული: sudo apt install -y jq"
read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" "$@"; }
S=$(date +%s | tail -c 7); TRACK=$(mktemp); TODAY=$(date +%F); MONTH=$(date +%Y-%m)
PDF=$(mktemp --suffix=.pdf); printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$PDF"
TXT=$(mktemp --suffix=.pdf); echo "ეს არ არის PDF" > "$TXT"

step "1. მომხმარებლები"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ext.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { bad "მომხმარებელი ($1)" "$(echo "$R" | jq -rc .message)"; return; }
  echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.ext.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
LM=$(mkuser lab_manager 51); LD=$(mkuser lab_doctor 52); RC=$(mkuser receptionist 53); PH=$(mkuser phlebotomist 54); LT=$(mkuser diagnostic 55)
[ -n "$LM" ] && [ -n "$LD" ] && [ -n "$RC" ] && [ -n "$PH" ] && [ -n "$LT" ] && ok "5 სატესტო მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"

step "2. გარე ლაბორატორია და ანალიზები"
LAB=$(api POST /lab/external-labs "$LM" -d "{\"name\":\"ტესტ-E2E ლაბი $S\",\"phone\":\"555000000\"}" | jq -r '.id // empty'); echo "l $LAB" >> "$TRACK"
[ -n "$LAB" ] && ok "ლაბორატორია რეესტრში" || die "ლაბორატორია ვერ შეიქმნა"
chk "იგივე სახელი — 409" "$(code POST /lab/external-labs "$LM" -H "$J" -d "{\"name\":\"ტესტ-E2E ლაბი $S\"}")" "409"
LAB2=$(api POST /lab/external-labs "$LM" -d "{\"name\":\"ტესტ-E2E სხვა $S\"}" | jq -r .id); echo "l $LAB2" >> "$TRACK"
EXT=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_EXT_$S\",\"name\":\"ტესტ-E2E ვიტამინი D $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\",\"performed_by\":\"external\"}" | jq -r '.id // empty')
[ -n "$EXT" ] || die "გარე ანალიზი ვერ შეიქმნა"; echo "s $EXT" >> "$TRACK"
R=$(api PATCH "/dx/catalog/$EXT" "$ADM" -d "{\"external_lab_id\":\"$LAB\",\"purchase_price\":25.5,\"ext_turnaround_days\":5}")
chk "კატალოგი: ლაბორატორია, შესყიდვა 25.5, ვადა 5 დღე" "$(echo "$R" | jq -r '"\(.external_lab):\((.purchase_price|tonumber)+0):\(.ext_turnaround_days)"')" "ტესტ-E2E ლაბი $S:25.5:5"
INT=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_DLT_$S\",\"name\":\"ტესტ-E2E გლუკოზა $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty'); echo "s $INT" >> "$TRACK"
GLU=$(api POST "/dx/catalog/$INT/analytes" "$LM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"delta_limit_pct":20,"delta_window_days":30,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.9,"high":6.1}]}' | jq -r '.analytes[0].id // empty')
[ -n "$GLU" ] && ok "შიდა ანალიზი delta-check-ით (20 %, 30 დღე)" || die "კომპონენტი ვერ შეიქმნა"

step "3. ვიზიტი → აღება → გაგზავნა"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"5$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"გარე\",\"birth_date\":\"1975-06-01\",\"gender\":\"female\",\"phone_number\":\"596$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] || die "პაციენტი ვერ შეიქმნა"
visit() {
  local e sh; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":$1}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' >/dev/null
  echo "$e"
}
E1=$(visit "[{\"service_id\":\"$EXT\"},{\"service_id\":\"$INT\"}]"); [ -n "$E1" ] && ok "ვიზიტი: გარე + შიდა, აღებულია" || die "ვიზიტი ვერ შეიქმნა"
EIT=$(api GET /lab/external/to-send "$LT" | jq -r "[.[]|select(.patient_id==\"$PAT\")][0].id // empty")
[ -n "$EIT" ] && ok "გასაგზავნ სიაშია (ლაბორატორიით)" || die "გასაგზავნში არ ჩანს"
chk "სხვა ლაბორატორიაში გაგზავნა — 400" "$(code POST /lab/external/shipments "$LT" -H "$J" -d "{\"lab_id\":\"$LAB2\",\"item_ids\":[\"$EIT\"]}")" "400"
SH=$(api POST /lab/external/shipments "$LT" -d "{\"lab_id\":\"$LAB\",\"item_ids\":[\"$EIT\"],\"courier\":\"კურიერი ტესტი\"}")
SHID=$(echo "$SH" | jq -r '.id // empty'); chk "გაგზავნა: ნომერი EX…" "$(echo "$SH" | jq -r '.shipment_no|test("^EX[0-9]{2}-[0-9]{6}$")')" "true"
chk "განმეორებით გაგზავნა — 409" "$(code POST /lab/external/shipments "$LT" -H "$J" -d "{\"lab_id\":\"$LAB\",\"item_ids\":[\"$EIT\"]}")" "409"
chk "გადაცემის აქტი PDF" "$(curl -s "$B/lab/external/shipments/$SHID/act" -H "authorization: Bearer $LT" | head -c 5)" "%PDF-"
W=$(api GET "/lab/external/waiting?lab_id=$LAB" "$LT" | jq -c "[.[]|select(.id==\"$EIT\")][0]")
chk "პასუხს ელოდება: ღირებულება 25.5, ვადა +5 დღე, არ არის ვადაგადაცილებული" "$(echo "$W" | jq -r '"\((.ext_cost|tonumber)+0):\(.overdue)"')" "25.5:false"

step "4. პასუხი (PDF) → ვალიდაცია → ექიმი/რეგისტრატურა"
chk "არა-PDF ფაილი — 400" "$(code POST "/lab/items/$EIT/external-result" "$LT" -F "file=@$TXT")" "400"
chk "PDF მიება ანალიზს → ვალიდაციას ელოდება" "$(curl -s -X POST "$B/lab/items/$EIT/external-result" -H "authorization: Bearer $LT" -F "file=@$PDF;filename=vitD.pdf" | jq -r .status)" "resulted"
chk "ვალიდაციამდე რეგისტრატორი ფაილს ვერ ხედავს (403)" "$(code GET "/lab/items/$EIT/external-result" "$RC")" "403"
chk "ლაბ. ექიმი ადასტურებს" "$(api POST "/lab/items/$EIT/validate" "$LD" | jq -r .status)" "validated"
chk "დადასტურების შემდეგ — ფაილი ჩანს" "$(curl -s "$B/lab/items/$EIT/external-result" -H "authorization: Bearer $RC" | head -c 5)" "%PDF-"
chk "დადასტურებულზე ახალი ფაილი — 409" "$(code POST "/lab/items/$EIT/external-result" "$LT" -F "file=@$PDF")" "409"
chk "ლოდინის სიიდან გავიდა" "$(api GET "/lab/external/waiting?lab_id=$LAB" "$LT" | jq -r "[.[]|select(.id==\"$EIT\")]|length")" "0"

step "5. ანგარიშსწორება ($MONTH)"
ST=$(api GET "/lab/external/settlement?month=$MONTH" "$LM" | jq -c ".[]|select(.lab_id==\"$LAB\")")
chk "თვე: 1 ანალიზი, 25.50 ₾" "$(echo "$ST" | jq -r '"\(.items|tonumber):\((.amount|tonumber)+0)"')" "1:25.5"
chk "დეტალური სია" "$(api GET "/lab/external/settlement/items?lab_id=$LAB&month=$MONTH" "$LM" | jq -r length)" "1"
chk "ანგარიშსწორება ჩაიწერა (ინვოისი, გადახდა)" "$(api POST /lab/external/settlements "$LM" -d "{\"lab_id\":\"$LAB\",\"month\":\"$MONTH\",\"invoice_no\":\"INV-$S\",\"paid_at\":\"$TODAY\"}" | jq -r '"\(.items_count):\((.amount|tonumber)+0):\(.invoice_no)"')" "1:25.5:INV-$S"
chk "ლაბორანტს ანგარიშსწორება არ ეკუთვნის (403)" "$(code GET "/lab/external/settlement?month=$MONTH" "$LT")" "403"

step "6. delta-check და კუმულაციური შედეგები"
recv_item() { local e=$1 bc; bc=$(api GET "/encounters/$e/dx-orders" "$LT" | jq -r "[.[]|select(.service_id==\"$INT\")][0].barcode // empty")
  [ -n "$bc" ] && api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null; api GET "/lab/worklist?search=$bc" "$LT" | jq -r "[.[]|select(.service_id==\"$INT\")][0].id // empty"; }
I1=$(recv_item "$E1")
api PUT "/lab/items/$I1/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$GLU\",\"value\":\"5.0\"}]}" >/dev/null
chk "პირველი გაზომვა 5.0 → ვალიდირებულია" "$(api POST "/lab/items/$I1/validate" "$LD" | jq -r .status)" "validated"
E2=$(visit "[{\"service_id\":\"$INT\"}]"); I2=$(recv_item "$E2")
api PUT "/lab/items/$I2/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$GLU\",\"value\":\"8.0\"}]}" >/dev/null
A=$(api GET "/lab/items/$I2" "$LT" | jq -c '.analytes[0]')
chk "წინა შედეგი ჩანს (5)" "$(echo "$A" | jq -r '.history[0].value')" "5"
chk "delta: +60 % > 20 % → გაფრთხილება" "$(echo "$A" | jq -r '"\(.delta.pct+0):\(.delta.alert)"')" "60:true"
api POST "/lab/items/$I2/validate" "$LD" >/dev/null
C=$(api GET "/patients/$PAT/lab-cumulative?analyte_id=$GLU" "$RC" 2>/dev/null)
chk "რეგისტრატორს კუმულაციური დახურული აქვს (403)" "$(code GET "/patients/$PAT/lab-cumulative" "$RC")" "403"
C=$(api GET "/patients/$PAT/lab-cumulative?analyte_id=$GLU" "$LD")
chk "კუმულაციური: 2 გაზომვა (8 → 5, ახლიდან)" "$(echo "$C" | jq -r '[.[].value_num|tonumber+0]|map(tostring)|join(",")')" "8,5"
chk "ბლანკი: გარე PDF ცალკეა, შიდა იბეჭდება" "$(curl -s "$B/encounters/$E1/lab-report" -H "authorization: Bearer $LD" | head -c 5)" "%PDF-"

step "7. სტატისტიკა"
ST=$(api GET "/lab/stats?from=$TODAY&to=$TODAY" "$LM")
chk "დღეს: ≥ 3 შეკვეთა, ≥ 3 დადასტურებული" "$(echo "$ST" | jq -r '(.totals.ordered|tonumber) >= 3 and (.totals.validated|tonumber) >= 3')" "true"
chk "ანალიზებით: გარე და შიდა ჩანს" "$(echo "$ST" | jq -r "[.by_service[]|select(.id==\"$EXT\" or .id==\"$INT\")]|length")" "2"
chk "გარე: გაგზავნილი ≥ 1, პასუხი ≥ 1" "$(echo "$ST" | jq -r '(.external.sent|tonumber) >= 1 and (.external.resulted|tonumber) >= 1')" "true"
chk "ვალიდატორებით — ჩანს" "$(echo "$ST" | jq -r '(.by_validator|length) >= 1')" "true"
chk "არასწორი პერიოდი — 400" "$(code GET "/lab/stats?from=$TODAY&to=2000-01-01" "$LM")" "400"
chk "ლაბორანტს სტატისტიკა დახურული (403)" "$(code GET "/lab/stats?from=$TODAY&to=$TODAY" "$LT")" "403"

step "გასუფთავება"
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^l /{print $2}' "$TRACK"); do api PATCH "/lab/external-labs/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -f "$TRACK" "$PDF" "$TXT"
ok "სატესტო ლაბორატორიები, ანალიზები და მომხმარებლები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
