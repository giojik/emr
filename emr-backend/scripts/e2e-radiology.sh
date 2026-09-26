#!/usr/bin/env bash
# =====================================================================
# e2e-radiology.sh — რადიოლოგიის სრული ნაკადის ავტომატური ტესტი (API-ით)
#   რეგისტრატორი (ვიზიტი ექიმის გარეშე) → განრიგი (აპარატი + დრო) → ტექნიკოსი (მიღება, შესრულება)
#   → რადიოლოგი (შაბლონი, draft, ხელმოწერა, ხელახლა გახსნა, ვერსიები, PDF)
# ქმნის სატესტო მომხმარებლებს და პაციენტებს (სახელში "ტესტ-E2E"), ბოლოს მომხმარებლებს თიშავს.
#
# გამოყენება:  bash scripts/e2e-radiology.sh [API_URL]     (ნაგულისხმევი: http://localhost/api)
#   admin-ის მონაცემებს იკითხავს; ან: ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-radiology.sh
# საჭიროა: curl, jq
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

[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7)
CREATED_USERS=(); TRACK=$(mktemp)   # mkuser ეშვება $(…)-ში (subshell) — ID-ები ფაილში
TOMORROW=$(date -d tomorrow +%F)
# ხვალ, კლინიკის დროით (Asia/Tbilisi, UTC+4)
at() { echo "${TOMORROW}T$1:00+04:00"; }

step "0. გარემო"
chk "API ხელმისაწვდომია" "$(curl -s "$B/health" | jq -r .status)" "ok"
VER=$(curl -s "$B/health" | jq -r .schemaVersion); if [ "$VER" \> "0012" ]; then ok "სქემის ვერსია $VER"; else bad "სქემის ვერსია" "საჭიროა ≥ 0013, არის $VER"; fi

step "1. მომზადება"
DEP=$(api GET "/departments?include_inactive=true" "$ADM" | jq -r '[.[]|select(.type=="diagnostic" and .is_active)][0].id // empty')
if [ -z "$DEP" ]; then
  DEP=$(api POST /departments "$ADM" -d '{"name":"დიაგნოსტიკა","code":"DX","type":"diagnostic"}' | jq -r '.id // empty')
  [ -n "$DEP" ] && ok "შეიქმნა დიაგნოსტიკური განყოფილება" || bad "დიაგნოსტიკური განყოფილება" "ვერ შეიქმნა"
else ok "დიაგნოსტიკური განყოფილება არსებობს"; fi
mkuser() { # $1 role, $2 prefix-digits, $3 extra json
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.$1.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { bad "მომხმარებელი ($1)" "$(echo "$R" | jq -rc .message)"; return; }
  echo "$id" >> "$TRACK"
  local t; t=$(login "e2e.$1.$2.$S@test.local" "$tmp")
  local np="E2e-$S-pass$RANDOM"
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"$np\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser receptionist 81); RT=$(mkuser radiographer 82); RD=$(mkuser radiologist 83); HD=$(mkuser radiologist 84 ',"is_section_head":true')
[ -n "$RC" ] && [ -n "$RT" ] && [ -n "$RD" ] && [ -n "$HD" ] && ok "4 მომხმარებელი (რეგისტრატორი, ტექნიკოსი, რადიოლოგი, ხელმძღვანელი)" || die "მომხმარებლები ვერ შეიქმნა"
CAT=$(api GET "/dx/catalog?section=radiology" "$ADM")
sid() { echo "$CAT" | jq -r ".[]|select(.code==\"$1\")|.id"; }
CT=$(sid RAD_CT_HEAD); MR=$(sid RAD_MR_BRAIN_C); US=$(sid RAD_US_ABD)
[ -n "$CT" ] && [ -n "$MR" ] && [ -n "$US" ] && ok "კატალოგი: CT თავი, MRI თავი (კონტრ.), ექო მუცელი" || die "კატალოგში კვლევები ვერ მოიძებნა"
DEVS=$(api GET "/dx/devices?section=radiology" "$RC")
dev() { echo "$DEVS" | jq -r "[.[]|select(.modalities|index(\"$1\"))][0].id // empty"; }
DCT=$(dev CT); DMR=$(dev MR); DUS=$(dev US)
[ -n "$DCT" ] && [ -n "$DMR" ] && [ -n "$DUS" ] && ok "აპარატები: CT, MRI, ულტრაბგერა" || die "აპარატები ვერ მოიძებნა"
mkpat() { api POST /patients "$RC" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty'; }
PAT=$(mkpat 71 რადიოლოგია 1994-03-10 female); PAT2=$(mkpat 72 გადაფარვა 1970-01-01 male)
[ -n "$PAT" ] && [ -n "$PAT2" ] && ok "2 სატესტო პაციენტი" || die "პაციენტები ვერ შეიქმნა"

step "2. რეგისტრატორი: ვიზიტი ექიმის გარეშე (გარე მიმართვით)"
V=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$CT\",\"note\":\"თავის ტკივილი\"},{\"service_id\":\"$MR\"},{\"service_id\":\"$US\"}],\"external_referral\":\"დ. ტესტაძე, კლინიკა X\"}")
E=$(echo "$V" | jq -r '.encounter_id // empty'); [ -n "$E" ] && ok "ვიზიტი გაიხსნა (3 კვლევა)" || die "ვიზიტი: $(echo "$V" | jq -rc .message)"
ACC=$(echo "$V" | jq -r '[.created[].accession_number]|map(select(.!=null))|length'); chk "Accession № — 3-ვე კვლევაზე" "$ACC" "3"
INV=$(api GET "/invoices/encounter/$E" "$RC"); SHARE=$(echo "$INV" | jq -r .patient_share)
if [ "$(echo "$INV" | jq -r '(.patient_share|tonumber) == 0')" != "true" ]; then
  chk "გადახდა ($SHARE ₾)" "$(api POST "/encounters/$E/pay-initial" "$RC" -d "{\"amount\":$SHARE,\"method\":\"cash\"}" | jq -r '.status // .message')" "active"
else ok "0 ₾ — გადახდა არ სჭირდება"; fi
ITEMS=$(api GET "/encounters/$E/dx-orders" "$RC")
iid() { echo "$ITEMS" | jq -r ".[]|select(.service_id==\"$1\")|.id"; }
ICT=$(iid "$CT"); IMR=$(iid "$MR"); IUS=$(iid "$US")
V2=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT2\",\"items\":[{\"service_id\":\"$CT\"}]}"); E2=$(echo "$V2" | jq -r '.encounter_id // empty')
I2=$(api GET "/encounters/$E2/dx-orders" "$RC" | jq -r '.[0].id')

step "3. განრიგი"
BOARD=$(api GET "/radiology/board?date=$TOMORROW" "$RC")
chk "დასაგეგმ სიაში ჩანს 3 კვლევა" "$(echo "$BOARD" | jq "[.unscheduled[]|select(.encounter_id==\"$E\")]|length")" "3"
chk "ექო MRI-ის აპარატზე — უარი (400)" "$(code PUT "/dx-orders/$IUS/schedule" "$RC" -d "{\"device_id\":\"$DMR\",\"start\":\"$(at 10:00)\"}")" "400"
chk "სამუშაო საათების გარეთ — გაფრთხილება" "$(api PUT "/dx-orders/$ICT/schedule" "$RC" -d "{\"device_id\":\"$DCT\",\"start\":\"$(at 07:00)\"}" | jq -r .code)" "OUTSIDE_HOURS"
chk "CT ჩაწერა 10:00" "$(api PUT "/dx-orders/$ICT/schedule" "$RC" -d "{\"device_id\":\"$DCT\",\"start\":\"$(at 10:00)\"}" | jq -r '.status // .message')" "scheduled"
chk "სხვა პაციენტი იმავე დროს — დაკავებულია (409)" "$(code PUT "/dx-orders/$I2/schedule" "$RC" -d "{\"device_id\":\"$DCT\",\"start\":\"$(at 10:10)\"}")" "409"
chk "სხვა პაციენტი 10:20 — თავისუფალია" "$(api PUT "/dx-orders/$I2/schedule" "$RC" -d "{\"device_id\":\"$DCT\",\"start\":\"$(at 10:20)\"}" | jq -r '.status // .message')" "scheduled"
chk "MRI ჩაწერა 11:00" "$(api PUT "/dx-orders/$IMR/schedule" "$RC" -d "{\"device_id\":\"$DMR\",\"start\":\"$(at 11:00)\"}" | jq -r '.status // .message')" "scheduled"
chk "MRI-ის ხანგრძლივობა 40 წთ (კატალოგიდან)" "$(api GET "/radiology/board?date=$TOMORROW" "$RC" | jq -r "[.booked[]|select(.id==\"$IMR\")][0] | def t: sub(\"\\\\.[0-9]+Z$\";\"Z\")|fromdateiso8601; ((.scheduled_end|t) - (.scheduled_start|t))/60")" "40"
chk "ჩაწერის ფურცელი (PDF)" "$(code GET "/encounters/$E/imaging-slip" "$RC")" "200"
chk "გადაწერა: მეორე პაციენტი → გაუქმება ჩაწერის" "$(api DELETE "/dx-orders/$I2/schedule" "$RC" | jq -r '.status // .message')" "ordered"
chk "რადიოლოგი: შესრულებამდე დასკვნა დაუშვებელია (409)" "$(code PUT "/dx-orders/$ICT/report" "$RD" -d '{"impression":"x"}')" "409"

step "4. ტექნიკოსი"
chk "რიგში ჩანს (ხვალ)" "$(api GET "/radiology/queue?date=$TOMORROW" "$RT" | jq "[.[]|select(.encounter_id==\"$E\")]|length")" "3"
chk "მიღება (მოვიდა)" "$(api POST "/dx-orders/$ICT/arrive" "$RT" -d '{}' | jq -r '.status // .message')" "arrived"
chk "იდენტიფიკაციის გარეშე — უარი (400)" "$(code POST "/dx-orders/$ICT/perform" "$RT" -d '{}')" "400"
chk "ქალი 32 წ, CT: ორსულობის სტატუსის გარეშე — უარი" "$(api POST "/dx-orders/$ICT/perform" "$RT" -d '{"identity_confirmed":true}' | jq -r '.message' | grep -c ორსულობ)" "1"
chk "CT შესრულდა (DLP, შენიშვნა)" "$(api POST "/dx-orders/$ICT/perform" "$RT" -d '{"identity_confirmed":true,"safety":{"pregnancy":"not_pregnant"},"dose_text":"DLP 850 mGy·cm","tech_note":"მოძრაობის არტეფაქტი"}' | jq -r '.status // .message')" "performed"
chk "MRI: უსაფრთხოების კითხვარის გარეშე — უარი" "$(api POST "/dx-orders/$IMR/perform" "$RT" -d '{"identity_confirmed":true,"contrast_agent":"გადობუტროლი","contrast_volume_ml":7.5}' | jq -r '.message' | grep -c კითხვარ)" "1"
chk "MRI: კონტრასტის მოცულობის გარეშე — უარი" "$(api POST "/dx-orders/$IMR/perform" "$RT" -d '{"identity_confirmed":true,"safety":{"mr_screening":true},"contrast_agent":"გადობუტროლი"}' | jq -r '.message' | grep -c მოცულობ)" "1"
chk "MRI შესრულდა (კონტრასტით)" "$(api POST "/dx-orders/$IMR/perform" "$RT" -d '{"identity_confirmed":true,"safety":{"mr_screening":true,"renal":"ok"},"contrast_agent":"გადობუტროლი","contrast_volume_ml":7.5}' | jq -r '.status // .message')" "performed"
chk "ექო — ცოცხალი რიგიდან, ჩაწერის გარეშე" "$(api POST "/dx-orders/$IUS/perform" "$RT" -d '{"identity_confirmed":true}' | jq -r '.status // .message')" "performed"
chk "ტექნიკოსს დასკვნის წერა არ შეუძლია (403)" "$(code PUT "/dx-orders/$ICT/report" "$RT" -d '{"impression":"x"}')" "403"

step "5. შაბლონები"
TPL=$(api GET "/dx/report-templates?section=radiology&modality=CT" "$RD")
SH=$(echo "$TPL" | jq -r '[.items[]|select(.owner_id==null and .kind=="template")][0].id // empty')
[ -n "$SH" ] && ok "CT-ის საერთო შაბლონი ჩანს" || bad "საერთო შაბლონი" "ვერ მოიძებნა"
chk "US-ის შაბლონები CT-ზე არ ჩანს" "$(echo "$TPL" | jq '[.items[]|select(.modality=="US")]|length')" "0"
chk "რადიოლოგი: საერთოს მართვა — არა" "$(echo "$TPL" | jq -r .can_manage_shared)" "false"
chk "რადიოლოგი: საერთო შაბლონის შეცვლა — 403" "$(code PATCH "/dx/report-templates/$SH" "$RD" -d '{"section":"radiology","kind":"template","name":"ტესტი","impression":"x"}')" "403"
MY=$(api POST /dx/report-templates "$RD" -d '{"section":"radiology","kind":"template","name":"ჩემი CT — ინსულტი","modality":"CT","findings":"ჰიპოდენსური უბანი ___ წილში.","impression":"იშემიური ინსულტის ნიშნები ___."}' | jq -r '.id // empty')
[ -n "$MY" ] && ok "პირადი შაბლონი შეიქმნა" || bad "პირადი შაბლონი" "ვერ შეიქმნა"
chk "პირადი შაბლონი სხვა რადიოლოგს არ უჩანს" "$(api GET "/dx/report-templates?section=radiology" "$HD" | jq "[.items[]|select(.id==\"$MY\")]|length")" "0"
chk "ხელმძღვანელი: საერთოს მართვა — კი" "$(api GET "/dx/report-templates?section=radiology" "$HD" | jq -r .can_manage_shared)" "true"
PH=$(api POST /dx/report-templates "$HD" -d '{"section":"radiology","kind":"phrase","name":"ტესტ-E2E ფრაზა","shared":true,"target":"findings","body":"ყბის წიაღებში ლორწოვანის გასქელება."}')
chk "ხელმძღვანელი: საერთო ფრაზა" "$(echo "$PH" | jq -r '.owner_id')" "null"
PHID=$(echo "$PH" | jq -r '.id // empty')

step "6. რადიოლოგი: დასკვნა"
chk "აღსაწერ სიაში 3 კვლევა" "$(api GET "/dx/report-worklist?section=radiology&tab=todo" "$RD" | jq "[.[]|select(.encounter_id==\"$E\")]|length")" "3"
D=$(api GET "/dx-orders/$ICT/report" "$RD")
chk "რედაქტორში: ტექნიკოსის შენიშვნა და დოზა" "$(echo "$D" | jq -r '.tech_note + " | " + .dose_text')" "მოძრაობის არტეფაქტი | DLP 850 mGy·cm"
chk "draft შენახვა (შაბლონიდან, ___-ით)" "$(api PUT "/dx-orders/$ICT/report" "$RD" -d "{\"template_id\":\"$MY\",\"findings\":\"ჰიპოდენსური უბანი ___ წილში.\",\"impression\":\"იშემიური ინსულტის ნიშნები ___.\"}" | jq -r '.report_status // .message')" "draft"
chk "ხელმოწერა ___-ით — უარი" "$(api POST "/dx-orders/$ICT/report/sign" "$RD" -d '{"findings":"ჰიპოდენსური უბანი ___ წილში.","impression":"x"}' | jq -r .code)" "BLANKS"
chk "კრიტიკული, ვის ეცნობა — გარეშე უარი" "$(code POST "/dx-orders/$ICT/report/sign" "$RD" -d '{"findings":"ჰიპოდენსური უბანი მარცხენა საფეთქლის წილში.","impression":"მწვავე იშემიური ინსულტი.","is_critical":true}')" "400"
chk "ხელმოწერა" "$(api POST "/dx-orders/$ICT/report/sign" "$RD" -d '{"technique":"კონტრასტის გარეშე.","findings":"ჰიპოდენსური უბანი მარცხენა საფეთქლის წილში.","impression":"მწვავე იშემიური ინსულტი.","recommendation":"ნევროლოგის კონსულტაცია.","is_critical":true,"critical_notified_to":"დ. ტესტაძე, ტელ., 10:45"}' | jq -r '.status // .message')" "validated"
chk "ხელმოწერილზე draft — 409" "$(code PUT "/dx-orders/$ICT/report" "$RD" -d '{"impression":"y"}')" "409"
chk "ბლანკი (PDF)" "$(code GET "/dx-orders/$ICT/report.pdf" "$RC")" "200"
chk "ვიზიტის ხედში: დასკვნა + კრიტიკული ნიშანი" "$(api GET "/encounters/$E/dx-orders" "$RC" | jq -r ".[]|select(.id==\"$ICT\")|(.report_text|contains(\"მწვავე იშემიური\"))and .is_critical")" "true"
RD2=$(mkuser radiologist 85)
chk "სხვა რადიოლოგი (არა ხელმძღვანელი): ხელახლა გახსნა — 403" "$(code POST "/dx-orders/$ICT/report/reopen" "$RD2" -d '{"reason":"შემოწმება"}')" "403"
chk "ხელმომწერი: ხელახლა გახსნა მიზეზით → ვერსია 2" "$(api POST "/dx-orders/$ICT/report/reopen" "$RD" -d '{"reason":"მხარე შეცდომით — მარჯვენა"}' | jq -r '.version // .message')" "2"
chk "გახსნილი დასკვნა ექიმს აღარ უჩანს როგორც მზა" "$(api GET "/encounters/$E/dx-orders" "$RC" | jq -r ".[]|select(.id==\"$ICT\")|.status")" "in_progress"
chk "ვერსია 2 ხელმოწერა" "$(api POST "/dx-orders/$ICT/report/sign" "$RD" -d '{"findings":"ჰიპოდენსური უბანი მარჯვენა საფეთქლის წილში.","impression":"მწვავე იშემიური ინსულტი (მარჯვ.).","is_critical":true,"critical_notified_to":"დ. ტესტაძე, ტელ., 11:05"}' | jq -r '.version // .message')" "2"
chk "არქივში 2 ვერსია" "$(api GET "/dx-orders/$ICT/report" "$RD" | jq '.versions|length')" "2"
chk "ძველი ვერსიის ბლანკი (v1)" "$(code GET "/dx-orders/$ICT/report.pdf?version=1" "$RD")" "200"
api POST "/dx-orders/$IMR/report/sign" "$HD" -d '{"impression":"ნორმა."}' >/dev/null
chk "ყველა ხელმოწერის შემდეგ ვიზიტი იხურება" "$(api POST "/dx-orders/$IUS/report/sign" "$HD" -d '{"impression":"ნორმა."}' >/dev/null; api GET "/encounters?patient_id=$PAT" "$ADM" | jq -r "[.[]|select(.id==\"$E\")][0].status")" "discharged"

step "7. დასუფთავება"
api POST "/dx-orders/$I2/cancel" "$ADM" -d '{"reason":"ტესტის დასრულება"}' >/dev/null
[ -n "$PHID" ] && api PATCH "/dx/report-templates/$PHID" "$HD" -d '{"section":"radiology","kind":"phrase","name":"ტესტ-E2E ფრაზა","target":"findings","body":"x","is_active":false}' >/dev/null
[ -n "$MY" ] && api PATCH "/dx/report-templates/$MY" "$RD" -d '{"section":"radiology","kind":"template","name":"ჩემი CT — ინსულტი","impression":"x","is_active":false}' >/dev/null
for U in $(cat "$TRACK"); do api POST "/users/$U/disable" "$ADM" >/dev/null; done
ok "სატესტო მომხმარებლები გაითიშა"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
