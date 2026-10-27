#!/usr/bin/env bash
# =====================================================================
# e2e-bme.sh — ბიომედ-აპარატურა, ეტაპი 1 (0073): აპარატის პასპორტი
#   მოდული და პარამეტრები (ვალიდაცია), უფლებები (med_engineer / bme_dept / bme_view; შაბლონ-როლი), ტიპების ცნობარი,
#   პასპორტი (ავტომატური ნომერი, ნაგულისხმევები ტიპიდან, სერიული ნომრის უნიკალურობა, რედაქტირება — მდებარეობა / სტატუსი ცალკე),
#   ხილვადობა (საკუთარი განყოფილება / bme_dept / bme_view), QR / სკანერი, სტატუსი (მიზეზი, პერიოდები, შეტყობინება),
#   გადაადგილება (დადასტურებით / პირდაპირ, უარი, გაუქმება), ბმა ოპერაციულ ჩანაწერებთან (მიუბმელები → პასპორტი, „შესავსები“),
#   ასახვა დაგეგმვაზე: რადიოლოგიის ჩაწერა (block / warn / შეზღუდული / გამორთული მოდული), ენდოსკოპის არჩევა, CSSD სტერილიზაცია, გაფრთხილებები,
#   დოკუმენტები (PDF, ვადა, ხილვადობა, მოხსნა მიზეზით), ეტიკეტები (QR მისამართით / Code128), იმპორტი (შემოწმება → იმპორტი), გამოყვანა, მოდულის გამორთვა
# ბოლოს: სატესტო აპარატები გამოყვანილია, ოპერაციული ჩანაწერები / მომხმარებლები / განყოფილებები გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-bme.sh [API_URL]
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
upl()  { local p=$1 t=$2; shift 2; curl -s -X POST "$B$p" -H "authorization: Bearer $t" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
YY=$(TZ=Asia/Tbilisi date +%y); TOMORROW=$(TZ=Asia/Tbilisi date -d tomorrow +%F); YESTERDAY=$(TZ=Asia/Tbilisi date -d yesterday +%F)
at() { echo "${TOMORROW}T$1:00+04:00"; }
enc()  { jq -rn --arg s "$1" '$s|@uri'; }
mod()  { api PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
dev()  { api GET "/bme/devices/$1" "$2"; }
status() { api POST "/bme/devices/$1/status" "$ENG" -d "{\"status\":\"$2\",\"reason\":\"ტესტ-E2E: $2\"}" | jq -r '.status // .message'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0073" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0073" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E რეანიმაცია $S\",\"code\":\"E2EBA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ქირურგია $S\",\"code\":\"E2EBB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.bme.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ბიომედ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.bme.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_ENG=$(mkrole beng "სამედ. ინჟინერი" '["med_engineer"]'); R_DEP=$(mkrole bdep "აპარატები (განყ.)" '["bme_dept","nurse"]'); R_VIEW=$(mkrole bview "აპარატები (ნახვა)" '["bme_view"]')
[ -n "$R_ENG" ] && [ -n "$R_DEP" ] && [ -n "$R_VIEW" ] || die "როლები ვერ შეიქმნა (bme_dept / bme_view უფლებები?)"
read -r ENGID ENG <<< "$(mkuser "[\"$R_ENG\"]" 41)"
read -r DH1ID DH1 <<< "$(mkuser "[\"$R_DEP\"]" 42 ",\"department_id\":\"$D1\"")"; read -r _ DH2 <<< "$(mkuser "[\"$R_DEP\"]" 43 ",\"department_id\":\"$D2\"")"
read -r _ N1 <<< "$(mkuser '["nurse"]' 44 ",\"department_id\":\"$D1\"")"; read -r _ VW <<< "$(mkuser "[\"$R_VIEW\"]" 45)"
read -r _ N0 <<< "$(mkuser '["nurse"]' 46)"
[ -n "$ENG" ] && [ -n "$DH1" ] && [ -n "$DH2" ] && [ -n "$N1" ] && [ -n "$VW" ] && [ -n "$N0" ] && ok "6 მომხმარებელი (ინჟინერი, 2 × bme_dept, ექთანი, ნახვა, განყოფილების გარეშე)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული bme ვერ მოიძებნა"

step "1. მოდული, უფლებები, პარამეტრები"
chk "უფლებები: bme_dept, bme_view (45; 0077: + roster, roster_all, roster_view; 0078: + absence_approve)" "$(api GET /roles/capabilities "$ADM" | jq -r '[.[]|select(.code=="bme_dept" or .code=="bme_view" or .code=="med_engineer")]|length'):$(api GET /roles/capabilities "$ADM" | jq length)" "3:45"
chk "შაბლონ-როლი „სამედიცინო ინჟინერი“ (med_engineer + reports_all)" "$(api GET /roles "$ADM" | jq -r '.[]|select(.code=="biomed_engineer")|.capabilities|sort|join(",")')" "med_engineer,reports_all"
chk "უცნობი პარამეტრი — 400; ლაბ. block — 400 (მხოლოდ warn / off)" "$(code PUT /modules/bme "$ADM" -d '{"settings":{"foo":1},"reason":"ტესტ"}'):$(code PUT /modules/bme "$ADM" -d '{"settings":{"area_lab":"block"},"reason":"ტესტ"}')" "400:400"
chk "ცვლა: ინჟინერი — 403" "$(code PUT /modules/bme "$ENG" -d '{"settings":{"move_mode":"direct"},"reason":"ტესტ ტესტ"}')" "403"
mod '{"inv_prefix":"BMT","inv_year":true,"inv_digits":4,"require_department":true,"move_mode":"confirm","area_radiology":"block","area_endoscopy":"block","area_scopes":"block","area_cssd":"block","area_lab":"warn","area_or":"warn","or_alert_criticality":"high","label_size":"50x25","label_code":"qr"}'
chk "პარამეტრები: BMT, წელი, 4 ციფრი, დადასტურებით" "$(api GET /bme/refs "$ENG" | jq -r '.settings|"\(.inv_prefix):\(.inv_year):\(.move_mode)"')" "BMT:true:confirm"

step "2. ტიპების ცნობარი"
REFS=$(api GET /bme/refs "$N1")
chk "ცნობარი ყველას: ≥ 30 ტიპი, ვენტილატორი — სიცოცხლის შემანარჩუნებელი, PM 6 თვე" "$(echo "$REFS" | jq -r '(.types|length >= 30|tostring) + ":" + (.types[]|select(.code=="VENTILATOR")|"\(.default_criticality):\(.pm_months)")')" "true:life_support:6"
VENT=$(echo "$REFS" | jq -r '.types[]|select(.code=="VENTILATOR").id'); MON=$(echo "$REFS" | jq -r '.types[]|select(.code=="PATIENT_MONITOR").id')
chk "ტიპის დამატება: ექთანი — 403" "$(code POST /bme/types "$N1" -d "{\"code\":\"E2E_$S\",\"name\":\"x x\"}")" "403"
TY=$(api POST /bme/types "$ENG" -d "{\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E ტიპი\",\"grp\":\"therapy\",\"default_criticality\":\"low\",\"pm_months\":24}")
TYID=$(echo "$TY" | jq -r '.id // empty')
chk "ინჟინერი: ტიპი (თერაპია, დაბალი, PM 24); იგივე კოდი — 409; კოდის შეცვლა — 400" "$(echo "$TY" | jq -r '"\(.grp):\(.default_criticality):\(.pm_months)"'):$(code POST /bme/types "$ENG" -d "{\"code\":\"E2E_$S\",\"name\":\"y y\"}"):$(code PATCH "/bme/types/$TYID" "$ENG" -d '{"code":"ZZZ"}')" "therapy:low:24:409:400"
chk "რედაქტირება: კალიბრაცია 12 თვე" "$(api PATCH "/bme/types/$TYID" "$ENG" -d '{"calibration_months":12}' | jq -r .calibration_months)" "12"

step "3. პასპორტი"
chk "ექთანი ვერ არეგისტრირებს — 403" "$(code POST /bme/devices "$N1" -d "{\"name\":\"x x\",\"type_id\":\"$VENT\",\"department_id\":\"$D1\"}")" "403"
chk "განყოფილების გარეშე — 400 (პარამეტრი)" "$(code POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E x\",\"type_id\":\"$VENT\"}")" "400"
A=$(api POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E ვენტილატორი $S\",\"type_id\":\"$VENT\",\"manufacturer\":\"Dräger\",\"model\":\"Evita V300\",\"serial_no\":\"e2e-$S-a\",\"department_id\":\"$D1\",\"room\":\"ICU-3\",\"manufacture_year\":2021,\"purchase_value\":85000,\"warranty_until\":\"2030-01-01\"}")
AID=$(echo "$A" | jq -r '.id // empty'); AINV=$(echo "$A" | jq -r '.inv_no // empty')
[ -n "$AID" ] || die "პასპორტი ვერ შეიქმნა: $(echo "$A" | jq -rc .message)"
chk "ავტომატური ნომერი BMT-$YY-NNNN; კრიტიკულობა / რისკი ტიპიდან; სერიული — დიდი ასოებით; გარანტიაში" "$(echo "$AINV" | grep -cE "^BMT-$YY-[0-9]{4}$"):$(echo "$A" | jq -r '"\(.criticality):\(.risk_class):\(.serial_no):\(.under_warranty):\(.status)"')" "1:life_support:IIb:E2E-$S-A:true:operational"
chk "სტატუსის პერიოდი — 1 (ღია), ისტორია: შექმნა" "$(echo "$A" | jq -r '"\(.periods|length):\(.periods[0].ended_at):\(.events[0].kind)"')" "1:null:created"
chk "იგივე მწარმოებელი + სერიული — 409" "$(code POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E დუბლი\",\"type_id\":\"$VENT\",\"manufacturer\":\"dräger\",\"serial_no\":\"E2E-$S-A\",\"department_id\":\"$D1\"}")" "409"
Bd=$(api POST /bme/devices "$ENG" -d "{\"inv_no\":\"e2e-x-$S\",\"name\":\"ტესტ-E2E მონიტორი $S\",\"type_id\":\"$MON\",\"manufacturer\":\"Mindray\",\"serial_no\":\"E2E-$S-A\",\"department_id\":\"$D2\",\"criticality\":\"medium\",\"risk_class\":null}")
BID=$(echo "$Bd" | jq -r '.id // empty')
chk "სხვა მწარმოებელი, იგივე სერიული — OK; ხელით ნომერი (დიდი ასოებით); კრიტიკულობა ხელით; რისკის კლასი — ცარიელი" "$(echo "$Bd" | jq -r '"\(.inv_no):\(.criticality):\(.risk_class)"')" "E2E-X-$S:medium:null"
chk "არასწორი ნომრის ფორმატი — 400; იგივე ნომერი — 409" "$(code POST /bme/devices "$ENG" -d "{\"inv_no\":\"a b\",\"name\":\"x x\",\"type_id\":\"$MON\",\"department_id\":\"$D2\"}"):$(code POST /bme/devices "$ENG" -d "{\"inv_no\":\"E2E-X-$S\",\"name\":\"x x\",\"type_id\":\"$MON\",\"department_id\":\"$D2\"}")" "400:409"
U=$(api PATCH "/bme/devices/$AID" "$ENG" -d '{"model":"Evita V500","gmdn_code":"35190","install_date":"2022-03-01"}')
chk "რედაქტირება → ისტორია (updated: ველები)" "$(echo "$U" | jq -r '"\(.model):\(.events[0].kind):\(.events[0].data.fields|sort|join(","))"')" "Evita V500:updated:gmdn_code,install_date,model"
chk "მდებარეობა / სტატუსი PATCH-ით — 400; ექთანი — 403" "$(code PATCH "/bme/devices/$AID" "$ENG" -d "{\"department_id\":\"$D2\"}"):$(code PATCH "/bme/devices/$AID" "$ENG" -d '{"status":"down"}'):$(code PATCH "/bme/devices/$AID" "$N1" -d '{"model":"x"}')" "400:400:403"

step "4. ხილვადობა, QR / სკანერი"
inlist() { api GET "/bme/devices?search=$(enc "$S")" "$1" | jq -r '[.[].inv_no]|sort|join(",")'; }
chk "ექთანი (განყ. 1): მხოლოდ თავისი განყოფილების" "$(inlist "$N1")" "$AINV"
chk "bme_dept (განყ. 2): მხოლოდ განყ. 2-ის; სხვისი პასპორტი — 403" "$(inlist "$DH2"):$(code GET "/bme/devices/$AID" "$DH2")" "E2E-X-$S:403"
chk "bme_view: ორივე; შემაჯამებელი — 200; ექთანი — 403" "$(inlist "$VW" | tr ',' '\n' | wc -l | tr -d ' '):$(code GET /bme/summary "$VW"):$(code GET /bme/summary "$N1")" "2:200:403"
chk "განყოფილების გარეშე თანამშრომელი — ცარიელი სია" "$(api GET "/bme/devices?search=$(enc "$S")" "$N0" | jq length)" "0"
chk "სკანერი: ნომერი / QR მისამართი → პასპორტი; სხვა განყ. — 403; უცნობი — 404" "$(api GET "/bme/scan?code=$(enc "$AINV")" "$N1" | jq -r .id):$(api GET "/bme/scan?code=$(enc "https://emr.test/bme?inv=$AINV")" "$N1" | jq -r .id):$(code GET "/bme/scan?code=E2E-X-$S" "$N1"):$(code GET "/bme/scan?code=NOPE-$S" "$N1")" "$AID:$AID:403:404"
chk "ძებნა QR მისამართით" "$(api GET "/bme/devices?search=$(enc "https://emr.test/bme?inv=$AINV")" "$ENG" | jq -r '.[0].id')" "$AID"

step "5. სტატუსი"
chk "გაუმართავი მიზეზის გარეშე — 400; ექთანი — 403" "$(code POST "/bme/devices/$AID/status" "$ENG" -d '{"status":"down"}'):$(code POST "/bme/devices/$AID/status" "$N1" -d '{"status":"down","reason":"ტესტ ტესტ"}')" "400:403"
chk "გაუმართავი (მიზეზით)" "$(status "$AID" down)" "down"
chk "იგივე სტატუსი იგივე მიზეზით — 409" "$(code POST "/bme/devices/$AID/status" "$ENG" -d '{"status":"down","reason":"ტესტ-E2E: down"}')" "409"
chk "განყოფილებას (bme_dept) — შეტყობინება" "$(api GET "/notifications?unread=true" "$DH1" | jq -r "[.[]|select(.kind==\"bme_status\" and .link==\"/bme?device=$AID\")]|length")" "1"
chk "აღდგა → 3 პერიოდი, ერთი ღია (მუშა), გაუმართაობა დახურული" "$(status "$AID" operational):$(dev "$AID" "$ENG" | jq -r '"\(.periods|length):\([.periods[]|select(.ended_at==null)]|length):\(.periods[0].status):\(.periods[1].status):\(.periods[1].ended_at != null)"')" "operational:3:1:operational:down:true"
chk "სიის ფილტრი: არამუშა (შეზღუდული / გაუმართავი)" "$(status "$BID" restricted):$(api GET "/bme/devices?status=unavailable&search=$(enc "$S")" "$ENG" | jq -r '[.[].id]|join(",")')" "restricted:$BID"

step "6. გადაადგილება"
MV=$(api POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"OR-1\",\"reason\":\"ტესტ-E2E: სესხად\"}")
MVID=$(echo "$MV" | jq -r .move_id)
chk "დადასტურებით: მოთხოვნა (pending), ადგილი ჯერ არ იცვლება" "$(echo "$MV" | jq -r '"\(.status):\(.device.department_id == "'"$D1"'"):\(.device.pending_move_id != null)"')" "pending:true:true"
chk "მეორე მოთხოვნა — 409; ექთანი — 403" "$(code POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D2\"}"):$(code POST "/bme/devices/$AID/move" "$N1" -d "{\"to_department_id\":\"$D2\"}")" "409:403"
chk "მიმღების „მისაღებში“ (bme_dept განყ. 2); სხვა განყოფილება — ცარიელი" "$(api GET "/bme/moves?scope=incoming" "$DH2" | jq -r "[.[]|select(.id==\"$MVID\")]|length"):$(api GET "/bme/moves?scope=incoming" "$DH1" | jq -r "[.[]|select(.id==\"$MVID\")]|length")" "1:0"
chk "მიმღები: პასპორტის ნახვა (გადმოცემისას) — 200" "$(code GET "/bme/devices/$AID" "$DH2")" "200"
chk "სხვა განყოფილება / ექთანი — დადასტურება 403" "$(code POST "/bme/moves/$MVID/decide" "$DH1" -d '{"accept":true}'):$(code POST "/bme/moves/$MVID/decide" "$N1" -d '{"accept":true}')" "403:403"
chk "მიმღები დაადასტურა → განყ. 2, ოთახი OR-1" "$(api POST "/bme/moves/$MVID/decide" "$DH2" -d '{"accept":true}' | jq -r .status):$(dev "$AID" "$ENG" | jq -r '"\(.department_id == "'"$D2"'"):\(.room):\(.events[0].kind)"')" "done:true:OR-1:moved"
chk "იმავე განყოფილებაში (ოთახი) — პირდაპირ" "$(api POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"OR-2\"}" | jq -r .status)" "done"
chk "იგივე ადგილი — 400" "$(code POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D2\",\"to_room\":\"OR-2\"}")" "400"
MV2=$(api POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"ICU-3\"}" | jq -r .move_id)
chk "უარი მიზეზის გარეშე — 400; მიზეზით → rejected, ადგილი უცვლელი" "$(code POST "/bme/moves/$MV2/decide" "$DH1" -d '{"accept":false}'):$(api POST "/bme/moves/$MV2/decide" "$DH1" -d '{"accept":false,"note":"ადგილი არ არის"}' | jq -r .status):$(dev "$AID" "$ENG" | jq -r '.department_id == "'"$D2"'"')" "400:rejected:true"
MV3=$(api POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D1\"}" | jq -r .move_id)
chk "გაუქმება: ექთანი — 403; ინჟინერი → cancelled" "$(code POST "/bme/moves/$MV3/cancel" "$N1"):$(api POST "/bme/moves/$MV3/cancel" "$ENG" | jq -r .status)" "403:cancelled"
mod '{"move_mode":"direct"}'
chk "პირდაპირი რეჟიმი: მაშინვე განყ. 1-ში" "$(api POST "/bme/devices/$AID/move" "$ENG" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"ICU-3\",\"to_responsible_id\":\"$DH1ID\"}" | jq -r '"\(.status):\(.device.department_id == "'"$D1"'"):\(.device.responsible_user_id == "'"$DH1ID"'")"')" "done:true:true"
chk "გადაადგილებების ისტორია (აპარატზე: 5 ჩანაწერი)" "$(api GET "/bme/moves?device_id=$AID" "$ENG" | jq -r '[.[].status]|sort|join(",")')" "cancelled,done,done,done,rejected"

step "7. ბმა ოპერაციულ ჩანაწერებთან + ასახვა რადიოლოგიის განრიგზე"
DXD=$(api POST /dx/devices "$ADM" -d "{\"section\":\"radiology\",\"name\":\"ტესტ-E2E CT $S\",\"modalities\":[\"CT\"],\"room\":\"E2E\",\"slot_minutes\":20,\"work_start\":\"08:00\",\"work_end\":\"20:00\"}" | jq -r '.id // empty')
[ -n "$DXD" ] || die "სატესტო რადიოლოგიის აპარატი ვერ შეიქმნა"
chk "ახალი რადიოლოგიის აპარატი — მიუბმელების სიაში; ექთანი — 403" "$(api GET /bme/unlinked "$ENG" | jq -r "[.[]|select(.kind==\"dx_device\" and .id==\"$DXD\")]|length"):$(code GET /bme/unlinked "$N1")" "1:403"
C=$(api POST /bme/devices/from-link "$ENG" -d "{\"kind\":\"dx_device\",\"target_id\":\"$DXD\"}")
CID=$(echo "$C" | jq -r '.id // empty')
chk "მიუბმელიდან პასპორტი: ტიპი CT, ბმა, „შესავსები“, განყოფილების გარეშე" "$(echo "$C" | jq -r '"\(.type_code):\(.link_kind):\(.needs_review):\(.department_id)"')" "CT:dx_device:true:null"
chk "იგივე ჩანაწერის მეორედ მიბმა — 409; ორი ბმა ერთ პასპორტზე — 409" "$(code POST /bme/devices/from-link "$ENG" -d "{\"kind\":\"dx_device\",\"target_id\":\"$DXD\"}"):$(code POST "/bme/devices/$BID/link" "$ENG" -d "{\"kind\":\"dx_device\",\"target_id\":\"$DXD\"}")" "409:409"
chk "გადამოწმება განყოფილების გარეშე — 400; გადაადგილება (განყ. 1) → გადამოწმებულია" "$(code POST "/bme/devices/$CID/review" "$ENG"):$(api POST "/bme/devices/$CID/move" "$ENG" -d "{\"to_department_id\":\"$D1\",\"to_room\":\"RAD-E2E\"}" | jq -r .status):$(api POST "/bme/devices/$CID/review" "$ENG" | jq -r .needs_review)" "400:done:false"
chk "„შესავსები“ ფილტრი" "$(api GET "/bme/devices?needs_review=1&search=$(enc "$S")" "$ENG" | jq length)" "0"
# რადიოლოგიის შეკვეთა
CAT=$(api GET "/dx/catalog?section=radiology" "$ADM"); CTS=$(echo "$CAT" | jq -r '.[]|select(.code=="RAD_CT_HEAD")|.id')
PAT=$(api POST /patients "$ADM" -d "{\"personal_number\":\"47$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ბიომედ\",\"birth_date\":\"1980-02-02\",\"gender\":\"male\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty')
E=$(api POST /lab-visits "$ADM" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$CTS\"}]}" | jq -r '.encounter_id // empty')
[ -n "$E" ] || die "რადიოლოგიის ვიზიტი ვერ გაიხსნა"
SH=$(api GET "/invoices/encounter/$E" "$ADM" | jq -r .patient_share)
[ "$(echo "$SH" | jq -r '(.|tonumber) == 0')" = "true" ] || api POST "/encounters/$E/pay-initial" "$ADM" -d "{\"amount\":$SH,\"method\":\"cash\"}" >/dev/null
IT=$(api GET "/encounters/$E/dx-orders" "$ADM" | jq -r '.[0].id')
sched() { api PUT "/dx-orders/$IT/schedule" "$ADM" -d "{\"device_id\":\"$DXD\",\"start\":\"$(at "$1")\"}" | jq -r '.status // .code'; }
unsched() { api DELETE "/dx-orders/$IT/schedule" "$ADM" >/dev/null; }
status "$CID" down >/dev/null
chk "გაუმართავი აპარატი + block → ჩაწერა 409 BME_DOWN" "$(sched 10:00)" "BME_DOWN"
AL=$(api GET "/bme/alerts?area=radiology" "$N1")
chk "გაფრთხილება (რადიოლოგია) ნებისმიერ თანამშრომელს: block, ჩანს აპარატი" "$(echo "$AL" | jq -r "\"\(.mode):\" + ([.items[]|select(.dx_device_id==\"$DXD\")|\"\(.status):\(.blocking)\"]|join(\",\"))")" "block:down:true"
chk "უცნობი არე — 400" "$(code GET "/bme/alerts?area=foo" "$N1")" "400"
mod '{"area_radiology":"warn"}'
chk "warn რეჟიმი → ჩაწერა დაშვებულია (გაფრთხილებით)" "$(sched 10:00):$(api GET "/bme/alerts?area=radiology" "$N1" | jq -r "[.items[]|select(.dx_device_id==\"$DXD\")|.blocking|tostring]|join(\",\")")" "scheduled:false"
unsched; mod '{"area_radiology":"block"}'
status "$CID" restricted >/dev/null
chk "შეზღუდულად მუშა + block → ჩაწერა დაშვებულია" "$(sched 10:20)" "scheduled"
unsched; status "$CID" down >/dev/null
api PUT /modules/bme "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → ჩაწერა არ ჩერდება; გაფრთხილებები — off" "$(sched 10:40):$(api GET "/bme/alerts?area=radiology" "$N1" | jq -r '"\(.mode):\(.items|length)"')" "scheduled:off:0"
unsched; api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
status "$CID" operational >/dev/null
chk "აღდგა → ჩაწერა" "$(sched 11:00)" "scheduled"
unsched

step "8. ენდოსკოპი და CSSD"
SCOPE=$(api POST /endo/scopes "$ADM" -d "{\"name\":\"ტესტ-E2E გასტროსკოპი $S\",\"scope_type\":\"gastroscope\",\"serial_number\":\"E2E-BME-$S\"}" | jq -r '.id // empty')
SP=$(api POST /bme/devices/from-link "$ENG" -d "{\"kind\":\"endo_scope\",\"target_id\":\"$SCOPE\",\"department_id\":\"$D1\"}")
SPID=$(echo "$SP" | jq -r '.id // empty')
chk "ენდოსკოპის პასპორტი: ტიპი ENDOSCOPE, სერიული ჩანაწერიდან, განყოფილებით" "$(echo "$SP" | jq -r '"\(.type_code):\(.serial_no):\(.department_id == "'"$D1"'")"')" "ENDOSCOPE:E2E-BME-$S:true"
ECAT=$(api GET "/dx/catalog?section=endoscopy" "$ADM"); EGD=$(echo "$ECAT" | jq -r '.[]|select(.code=="ENDO_EGD")|.id')
EE=$(api POST /lab-visits "$ADM" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$EGD\"}]}" | jq -r '.encounter_id // empty')
ESH=$(api GET "/invoices/encounter/$EE" "$ADM" | jq -r .patient_share)
[ "$(echo "$ESH" | jq -r '(.|tonumber) == 0')" = "true" ] || api POST "/encounters/$EE/pay-initial" "$ADM" -d "{\"amount\":$ESH,\"method\":\"cash\"}" >/dev/null
EIT=$(api GET "/encounters/$EE/dx-orders" "$ADM" | jq -r '.[0].id')
status "$SPID" down >/dev/null
chk "გაუმართავი ენდოსკოპის არჩევა პროცედურაში — 409 BME_DOWN" "$(api PUT "/dx-orders/$EIT/endo" "$ADM" -d "{\"scope_id\":\"$SCOPE\"}" | jq -r '.code // "ok"')" "BME_DOWN"
status "$SPID" operational >/dev/null
chk "აღდგა → არჩევა დაშვებულია" "$(api PUT "/dx-orders/$EIT/endo" "$ADM" -d "{\"scope_id\":\"$SCOPE\"}" | jq -r '.scope_id // .code')" "$SCOPE"
CSSD_ON=$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="cssd")|.enabled')
if [ "$CSSD_ON" = "true" ]; then
  UNIT=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2E_BC_$S\",\"name\":\"ტესტ-E2E CSSD ბიომედ $S\",\"kind\":\"cssd\",\"department_id\":\"$D2\"}" | jq -r '.id // empty')
  AUTO=$(api POST /cssd/machines "$ADM" -d "{\"name\":\"ტესტ-E2E ავტოკლავი $S\",\"kind\":\"steam\",\"location_id\":\"$UNIT\",\"manufacturer\":\"Tuttnauer\",\"serial_no\":\"E2E-AC-$S\"}" | jq -r '.id // empty')
  AP=$(api POST /bme/devices/from-link "$ENG" -d "{\"kind\":\"cssd_machine\",\"target_id\":\"$AUTO\"}")
  APID=$(echo "$AP" | jq -r '.id // empty')
  chk "CSSD აპარატის პასპორტი: სტერილიზატორი, განყოფილება — ერთეულის ლოკაციიდან" "$(echo "$AP" | jq -r '"\(.type_code):\(.department_id == "'"$D2"'"):\(.manufacturer)"')" "STERILIZER:true:Tuttnauer"
  status "$APID" down >/dev/null
  chk "გაუმართავ სტერილიზატორზე ციკლი — 409 BME_DOWN" "$(api POST /cssd/cycles "$ADM" -d "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"pack_ids\":[]}" | jq -r '.code // .message')" "BME_DOWN"
  chk "CSSD გაფრთხილება: block" "$(api GET "/bme/alerts?area=cssd" "$N1" | jq -r "[.items[]|select(.cssd_machine_id==\"$AUTO\")|.blocking]|join(\",\")")" "true"
  chk "გაუმართავზე Bowie-Dick (შეკეთების შემდგომი შემოწმება) — დაშვებულია" "$(code POST /cssd/cycles "$ADM" -d "{\"machine_id\":\"$AUTO\",\"kind\":\"bowie_dick\",\"result\":\"pass\"}")" "201"
  status "$APID" operational >/dev/null
  chk "აღდგა → ჩვეულებრივი შემოწმება (ცარიელი ჩატვირთვა — 400)" "$(code POST /cssd/cycles "$ADM" -d "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"pack_ids\":[]}")" "400"
else ok "CSSD მოდული გამორთულია — შემოწმება გამოტოვებულია"; fi
chk "ბმის მოხსნა → ისტორია (unlinked); მიუბმელებში ისევ ჩანს" "$(api POST "/bme/devices/$CID/unlink" "$ENG" | jq -r '"\(.link_kind):\(.events[0].kind)"'):$(api GET /bme/unlinked "$ENG" | jq -r "[.[]|select(.id==\"$DXD\")]|length")" "null:unlinked:1"
chk "ხელახლა მიბმა" "$(api POST "/bme/devices/$CID/link" "$ENG" -d "{\"kind\":\"dx_device\",\"target_id\":\"$DXD\"}" | jq -r .link_kind)" "dx_device"
chk "ლაბ. გაფრთხილებები — warn; საოპერაციო — warn" "$(api GET "/bme/alerts?area=lab" "$N1" | jq -r .mode):$(api GET "/bme/alerts?area=or" "$N1" | jq -r .mode)" "warn:warn"
# საოპერაციო ოთახის აპარატი: გაფრთხილება კრიტიკულობის ზღვრიდან (or_alert_criticality)
ORR=$(api GET /bme/refs "$ENG" | jq -c '.or_rooms[0] // empty')
if [ -n "$ORR" ]; then
  ORM=$(api POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E მონიტორი (საოპ.) $S\",\"type_id\":\"$MON\",\"department_id\":\"$(echo "$ORR" | jq -r .department_id)\",\"or_room_id\":\"$(echo "$ORR" | jq -r .id)\"}" | jq -r '.id // empty')
  orAl() { api GET "/bme/alerts?area=or" "$N1" | jq -r "[.items[]|select(.id==\"$ORM\")|\"\(.status):\(.blocking)\"]|join(\",\")"; }
  chk "საოპერაციო: მუშა მონიტორი — გაფრთხილება არ არის" "$(orAl)" ""
  status "$ORM" down >/dev/null
  chk "საოპერაციო: გაუმართავი მონიტორი (მაღალი ≥ high) → გაფრთხილება, არ ბლოკავს" "$(orAl)" "down:false"
  mod '{"or_alert_criticality":"life_support"}'
  chk "ზღვარი life_support → მონიტორი (მაღალი) აღარ ჩანს" "$(orAl)" ""
  mod '{"or_alert_criticality":"high","area_or":"off"}'
  chk "area_or = off → ცარიელი" "$(api GET "/bme/alerts?area=or" "$N1" | jq -r '"\(.mode):\(.items|length)"')" "off:0"
  mod '{"area_or":"warn"}'
  status "$ORM" retired >/dev/null
  chk "გამოყვანილი საოპერაციო აპარატი — გაფრთხილებაში აღარ ჩანს" "$(orAl)" ""
else ok "საოპერაციო ოთახი არ არის — საოპერაციოს გაფრთხილების შემოწმება გამოტოვებულია"; fi

step "9. დოკუმენტები"
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMP/cert.pdf"; echo "hello" > "$TMP/x.txt"
D=$(upl "/bme/devices/$AID/documents" "$ENG" -F "files=@$TMP/cert.pdf;type=application/pdf" -F kind=certificate -F "title=კალიბრაციის სერტიფიკატი" -F "valid_until=$YESTERDAY")
DID=$(echo "$D" | jq -r '.files[0] // empty')
chk "ატვირთვა: სერტიფიკატი (ვადაგასული), ისტორია — document" "$(echo "$D" | jq -r '.documents[0]|"\(.kind):\(.expired)"'):$(dev "$AID" "$ENG" | jq -r '.events[0].kind')" "certificate:true:document"
chk "არა PDF / JPG / PNG — 400; უცნობი სახეობა — 400; ექთანი — 403" "$(upl "/bme/devices/$AID/documents" "$ENG" -F "files=@$TMP/x.txt" -F kind=other | jq -r .code):$(upl "/bme/devices/$AID/documents" "$ENG" -F "files=@$TMP/cert.pdf" -F kind=foo -o /dev/null -w '%{http_code}'):$(upl "/bme/devices/$AID/documents" "$N1" -F "files=@$TMP/cert.pdf" -F kind=other -o /dev/null -w '%{http_code}')" "FILE_TYPE:400:403"
chk "ჩამოტვირთვა: ექთანი (იგივე განყ.) — 200 PDF; სხვა განყ. — 403" "$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B/bme/devices/$AID/documents/$DID" -H "authorization: Bearer $N1"):$(code GET "/bme/devices/$AID/documents/$DID" "$DH2")" "200:application/pdf:403"
chk "მოხსნა მიზეზის გარეშე — 400; მიზეზით — სია ცარიელი" "$(code POST "/bme/devices/$AID/documents/$DID/remove" "$ENG" -d '{}'):$(api POST "/bme/devices/$AID/documents/$DID/remove" "$ENG" -d '{"reason":"ტესტ-E2E: არასწორი ფაილი"}' | jq -r '.documents|length')" "400:0"
chk "მოხსნილი ფაილი — 404" "$(code GET "/bme/devices/$AID/documents/$DID" "$ENG")" "404"

step "10. ეტიკეტები"
chk "QR ეტიკეტი მისამართით (PDF); ექთანი — 403; არასწორი base — 400" "$(curl -s -o /dev/null -w '%{http_code}:%{content_type}' "$B/bme/labels?ids=$AID,$BID&base=$(enc https://emr.test)" -H "authorization: Bearer $ENG"):$(code GET "/bme/labels?ids=$AID" "$N1"):$(code GET "/bme/labels?ids=$AID&base=javascript:x" "$ENG")" "200:application/pdf:403:400"
mod '{"label_code":"code128","label_size":"70x35"}'
chk "Code128, 70×35" "$(curl -s -o "$TMP/l.pdf" -w '%{http_code}' "$B/bme/labels?ids=$AID" -H "authorization: Bearer $ENG"):$(head -c 5 "$TMP/l.pdf")" "200:%PDF-"

step "11. იმპორტი"
chk "შაბლონი (xlsx); ექთანი — 403" "$(curl -s -o /dev/null -w '%{http_code}' "$B/bme/import/template" -H "authorization: Bearer $ENG"):$(code GET /bme/import/template "$N1")" "200:403"
H='საინვენტარო №,დასახელება,ტიპი (კოდი),მწარმოებელი,მოდელი,სერიული №,განყოფილება (კოდი),ოთახი,კრიტიკულობა,რისკის კლასი,გამოშვების წელი,ექსპლ. შეყვანა,შეძენის თარიღი,ღირებულება,გარანტია (მდე),შენიშვნა'
printf '%s\n%s\n%s\n%s\n' "$H" \
  ",ტესტ-E2E ინფუზომატი $S,INFUSION_PUMP,B.Braun,Infusomat,E2E-IMP-$S,E2EBA$S,ICU-1,,,2020,2020-05-01,,1200,," \
  ",ტესტ-E2E ცუდი $S,NOPE,,,,E2EBA$S,,,,,,,,," \
  ",ტესტ-E2E დუბლი $S,PATIENT_MONITOR,Mindray,,e2e-$S-a,E2EBB$S,,,,,,,,," > "$TMP/imp.csv"
R=$(upl "/bme/import?commit=false" "$ENG" -F "file=@$TMP/imp.csv;type=text/csv")
chk "შემოწმება: 1 ახალი, 1 შეცდომა (უცნობი ტიპი), 1 გამოტოვებული (სერიული უკვე რეესტრშია)" "$(echo "$R" | jq -r '"\(.created):\(.errors):\(.skipped)"')" "1:1:1"
chk "შეცდომით იმპორტი — 400" "$(upl "/bme/import?commit=true" "$ENG" -F "file=@$TMP/imp.csv;type=text/csv" -o /dev/null -w '%{http_code}')" "400"
sed -i '3d' "$TMP/imp.csv"
R=$(upl "/bme/import?commit=true" "$ENG" -F "file=@$TMP/imp.csv;type=text/csv")
chk "იმპორტი: 1 შეიქმნა (ტიპის ნაგულისხმევი კრიტიკულობა — high, IIb)" "$(echo "$R" | jq -r .created):$(api GET "/bme/devices?search=E2E-IMP-$S" "$ENG" | jq -r '.[0]|"\(.criticality):\(.risk_class):\(.inv_no|test("^BMT-'"$YY"'-"))"')" "1:high:IIb:true"

step "12. გამოყვანა, შემაჯამებელი, მოდულის გამორთვა"
mod '{"move_mode":"confirm"}'
MV4=$(api POST "/bme/devices/$BID/move" "$ENG" -d "{\"to_department_id\":\"$D1\"}" | jq -r .move_id)
chk "გამოყვანა მიმდინარე გადაადგილებისას — 409" "$(code POST "/bme/devices/$BID/status" "$ENG" -d '{"status":"retired","reason":"ტესტ-E2E"}')" "409"
api POST "/bme/moves/$MV4/cancel" "$ENG" >/dev/null
chk "გამოყვანა → აქტიურების სიიდან ქრება; გადაადგილება — 409" "$(status "$BID" retired):$(api GET "/bme/devices?status=active&search=$(enc "$S")" "$ENG" | jq -r "[.[]|select(.id==\"$BID\")]|length"):$(code POST "/bme/devices/$BID/move" "$ENG" -d "{\"to_department_id\":\"$D1\"}")" "retired:0:409"
SUM=$(api GET /bme/summary "$VW")
chk "შემაჯამებელი: სტატუსები, ტიპები, განყოფილებები" "$(echo "$SUM" | jq -r '(.by_status|length > 0|tostring) + ":" + ([.by_department[]|select(.department_name=="ტესტ-E2E რეანიმაცია '"$S"'")|.total]|add > 0|tostring)')" "true:true"
api PUT /modules/bme "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → რეესტრი 403 (MODULE_DISABLED)" "$(code GET /bme/devices "$ENG"):$(api GET /bme/refs "$ENG" | jq -r .code)" "403:MODULE_DISABLED"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
chk "ჩართვა → ისევ მუშაობს" "$(code GET /bme/devices "$ENG")" "200"

step "გასუფთავება"
for id in $(api GET "/bme/devices?search=$(enc "ტესტ-E2E")" "$ENG" | jq -r '.[]|select(.status!="retired")|.id'); do
  P=$(api GET "/bme/moves?scope=incoming&device_id=$id" "$ENG" | jq -r '.[].id'); for m in $P; do api POST "/bme/moves/$m/cancel" "$ENG" >/dev/null; done
  api POST "/bme/devices/$id/status" "$ENG" -d '{"status":"retired","reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
done
chk "სატესტო აპარატები გამოყვანილია" "$(api GET "/bme/devices?status=active&search=$(enc "ტესტ-E2E")" "$ENG" | jq length)" "0"
radAl() { api GET "/bme/alerts?area=radiology" "$N1" | jq -r "[.items[]|select(.id==\"$CID\")|\"\(.status):\(.blocking)\"]|join(\",\")"; }
chk "გამოყვანილი, ოთახი ჯერ აქტიურია → გაფრთხილება (ჩაწერა დაბლოკილია)" "$(radAl)" "retired:true"
api PATCH "/dx/devices/$DXD" "$ADM" -d '{"is_active":false}' >/dev/null
chk "ოთახი გაითიშა → გაფრთხილებაში აღარ ჩანს" "$(radAl)" ""
api PATCH "/endo/scopes/$SCOPE" "$ADM" -d '{"is_active":false}' >/dev/null
[ -n "${AUTO:-}" ] && api PATCH "/cssd/machines/$AUTO" "$ADM" -d '{"is_active":false}' >/dev/null
[ -n "${UNIT:-}" ] && api PATCH "/stock/locations/$UNIT" "$ADM" -d '{"is_active":false}' >/dev/null
api PATCH "/bme/types/$TYID" "$ENG" -d '{"is_active":false}' >/dev/null
api PUT /modules/bme "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "ოპერაციული ჩანაწერები, ტიპი, მომხმარებლები, როლები, განყოფილებები გათიშულია (ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
