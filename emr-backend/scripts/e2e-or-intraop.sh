#!/usr/bin/env bash
# =====================================================================
# e2e-or-intraop.sh — საოპერაციო ბლოკი, ეტაპი 0049: ოპერაციის მსვლელობა
#   0. მომზადება (ბლოკი + ლოკაცია, ოთახები, მარაგი: მედიკამენტები / მასალა / იმპლანტი, CSSD შეფუთვები, მომხმარებლები, პაციენტები)
#   1. პარამეტრები (ვალიდაცია)          2. ოთახის გუნდი: მუდმივი / დღის ცვლილება / ავტომატური შევსება / ხელით მოხსნილი
#   3. nursing_team_by (surgeon / or_head_nurse / both)             4. ანესთეზიის რუკა: ჩანაწერი, ვიტალები 5-წთ ბადეზე, სითხეები → ბალანსი
#   5. ანესთეზიის მედიკამენტები: direct (ხარჯი ბლოკიდან), ნარკოტიკული — მოწმე + ნარჩენი, orders რეჟიმი
#   6. დათვლა (count_mode = block): დაწყებისას / დახურვამდე / ბოლოს     7. CSSD: სტერილური / არასტერილური შეფუთვა
#   8. მასალები: preference card → შეკრება, სკანირება, იმპლანტი (ლოტი + სერია), ჩამოწერა + რეესტრი
#   9. ოქმი: უფლებები, შაბლონები, სავალდებულო ველები, ხელმოწერა → დრენაჟი / ბიოფსია / ბლოკი, შესწორება (ვერსია)
#   10. ანესთეზიის რუკის ხელმოწერა    11. დასრულება: Sign out + დათვლა + ოქმი → CSSD used, იმპლანტების რეესტრი
#   12. count_mode = warn (ახსნით); ადგილობრივი ანესთეზია — ანესთეზიის გუნდი არ ემატება     13. აღდგენა
# გამოყენება:  bash scripts/e2e-or-intraop.sh [API_URL]     (admin — ADMIN_EMAIL / ADMIN_PW env-ით ან stdin-ით)
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
ecode() { echo "$1" | jq -r 'if type=="object" then (.code // .statusCode // "") else "" end' 2>/dev/null; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F)
D2Y=$(date -d '+2 years' +%F)
BASE=$(( $(date +%s) / 300 * 300 ))                          # მიმდინარე დრო — 5 წუთზე დამრგვალებული (ქვემოთ)
T() { date -u -d "@$((BASE - $1 * 60))" +%FT%TZ; }          # T 40 = 40 წუთის წინ (ბადის სლოტი)
SIG=$(python3 -c "
import zlib,struct,random,base64
w,h=60,24; raw=b''.join(b'\x00'+bytes(random.randrange(256) for _ in range(w*3)) for _ in range(h))
c=lambda t,d: struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
print('data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b'')).decode())")

step "0. მომზადება"
ORIG_OR=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings')
ORIG_CSSD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="cssd")|{enabled,settings}')
[ -n "$ORIG_OR" ] && [ "$ORIG_OR" != "null" ] || die "მოდული „or“ ვერ მოიძებნა"
echo "$ORIG_OR" | jq -e 'has("count_mode")' >/dev/null || die "0049-ის პარამეტრები არ არის (migration 0049?)"
ormod() { api PUT /modules/or "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
ormod '{"or_scheduling":"coordinator","anesthesia_team_by":"anesthesia_head","preop_readiness":"warn","turnover_min":30,"default_duration_min":60,"self_booking_days":30,"notify_requests":false,
  "nursing_team_by":"both","room_teams":true,"anesthesia_meds":"direct","preference_cards":"procedure_surgeon","count_mode":"block","note_required":["postop_dx","procedures","description","complications","blood_loss"]}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"bed_assign_mode":"direct"},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/cssd "$ADM" -d '{"enabled":true,"settings":{"wash_record":false,"bd_required":false,"bi_frequency":"off","bi_hold":"none","shelf_life_mode":"time","patient_trace":true,"auto_consume":false},"reason":"ტესტ-E2E"}' >/dev/null
dep() { api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'; }
DBK=$(dep "საოპერაციო (მსვლელობა)" E2EOIB or); DS=$(dep "ქირურგია (მსვლელობა)" E2EOIS inpatient); DA=$(dep "ანესთეზიოლოგია (მსვლელობა)" E2EOIA administrative)
DC=$(dep "CSSD (მსვლელობა)" E2EOIC administrative)
[ -n "$DBK" ] && [ -n "$DS" ] && [ -n "$DA" ] && [ -n "$DC" ] || die "განყოფილებები ვერ შეიქმნა"
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -r '[.types[]?|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end')
WS=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$DS\",\"code\":\"S1\",\"sex\":\"mixed\"}" | jq -r '.id // empty')
BS=$(api POST "/inpatient/wards/$WS/beds" "$ADM" -d "{\"count\":3,\"type_code\":\"$BT\"}")
BS1=$(echo "$BS" | jq -r '.[0].id // empty'); BS2=$(echo "$BS" | jq -r '.[1].id // empty'); BS3=$(echo "$BS" | jq -r '.[2].id // empty')
[ -n "$BS3" ] || die "საწოლები ვერ შეიქმნა"
role() {
  local id; id=$(api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.id' | head -1)
  [ -n "$id" ] || api POST /roles "$ADM" -d "{\"code\":\"$1\",\"name\":\"$2\",\"capabilities\":$3}" >/dev/null
  api GET /roles "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.code' | head -1
}
[ "$(role e2e_or_coord 'ტესტ-E2E საოპერაციოს კოორდინატორი' '["or_schedule"]')" = e2e_or_coord ] && [ "$(role e2e_anesth 'ტესტ-E2E ანესთეზიოლოგი' '["anesthesiologist"]')" = e2e_anesth ] \
  && [ "$(role e2e_or_nurse 'ტესტ-E2E საოპერაციო ექთანი' '["or_nurse"]')" = e2e_or_nurse ] || die "როლები ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.oi.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"OI-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.oi.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
WIT() { jq -nc --arg u "e2e.oi.$1.$S@test.local" --arg p "E2e-$S-pass-$1" '{username:$u,password:$p}'; }   # მოწმე
RC=$(mkuser '["receptionist"]' 61)
SU1=$(mkuser '["doctor"]' 62 ",\"department_id\":\"$DS\""); SU2=$(mkuser '["doctor"]' 63 ",\"department_id\":\"$DS\""); AS=$(mkuser '["doctor"]' 64 ",\"department_id\":\"$DS\"")
CO=$(mkuser '["e2e_or_coord"]' 65)
AN1=$(mkuser '["e2e_anesth"]' 66 ",\"department_id\":\"$DA\",\"is_section_head\":true"); AN2=$(mkuser '["e2e_anesth"]' 67 ",\"department_id\":\"$DA\"")
ON1=$(mkuser '["e2e_or_nurse"]' 68 ",\"department_id\":\"$DBK\",\"is_section_head\":true")
ON2=$(mkuser '["e2e_or_nurse"]' 69 ",\"department_id\":\"$DBK\""); ON3=$(mkuser '["e2e_or_nurse"]' 70 ",\"department_id\":\"$DBK\""); ON4=$(mkuser '["e2e_or_nurse"]' 71 ",\"department_id\":\"$DBK\"")
for t in RC SU1 SU2 AS CO AN1 AN2 ON1 ON2 ON3 ON4; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "მომხმარებლები: ქირურგები ×2 + ასისტენტი, კოორდინატორი, ანესთეზიოლოგი ×2 (ხელმძღვანელი), საოპერაციო ექთანი ×4 (მთავარი)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 72 "OI-მუხლი" 1955-03-03 female); P2=$(mkpat 73 "OI-თიაქარი" 1979-09-09 male)
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DS\",\"attending_doctor_id\":\"$(uid 62)\",\"source\":\"direct\",\"icd10_code\":\"M17.1\",\"chief_complaint\":\"ტესტ-E2E\",\"bed_id\":\"$2\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$BS1"); E2=$(ADMIT "$P2" "$BS2")
[ -n "$E1" ] && [ -n "$E2" ] || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
# ბლოკი + ოთახები + ლოკაცია
LOC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EOI$S\",\"name\":\"ტესტ-E2E საოპერაციოს საწყობი $S\",\"kind\":\"operating\",\"department_id\":\"$DBK\"}" | jq -r '.id // empty')
[ -n "$LOC" ] || die "ბლოკის ლოკაცია ვერ შეიქმნა"
api PATCH "/or/blocks/$DBK" "$ADM" -d "{\"stock_location_id\":\"$LOC\"}" >/dev/null
room() { api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"$1\",\"name\":\"$2\",\"work_start\":\"00:00\",\"work_end\":\"23:59\",\"work_days\":[1,2,3,4,5,6,7]}" | jq -r '.id // empty'; }
RO1=$(room OI1 "ოთახი 1 (მსვლელობა)"); RO2=$(room OI2 "ოთახი 2 (მსვლელობა)")
PR=$(api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-OI-TKA-$S\",\"ncsp_code\":\"NGB40\",\"name\":\"ტესტ-E2E მუხლის ენდოპროთეზირება (მსვლელობა)\",\"specialty_code\":\"ortho\",\"default_duration_min\":120,\"laterality\":true}" | jq -r '.id // empty')
PH=$(api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-OI-HER-$S\",\"name\":\"ტესტ-E2E თიაქრის პლასტიკა (მსვლელობა)\",\"specialty_code\":\"general\",\"default_duration_min\":60}" | jq -r '.id // empty')
[ -n "$RO1" ] && [ -n "$RO2" ] && [ -n "$PR" ] && [ -n "$PH" ] || die "ოთახები / პროცედურები ვერ შეიქმნა"
# მარაგი ბლოკის ლოკაციაზე: მედიკამენტები (ნარკოტიკულიც), მასალა, იმპლანტი (სერიული, ინვოისში)
gen() { api POST /pharmacy/generics "$ADM" -d "$1" | jq -r '.id // empty'; }
G_FEN=$(gen "{\"inn\":\"ტესტ-E2E OI ფენტანილი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"100 მკგ/2 მლ\",\"controlled_class\":\"narcotic\",\"dose_unit\":\"mcg\",\"dose_per_unit\":100,\"routes\":[\"IV\"]}")
G_PRO=$(gen "{\"inn\":\"ტესტ-E2E OI პროპოფოლი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"200 მგ/20 მლ\",\"dose_unit\":\"mg\",\"dose_per_unit\":200,\"routes\":[\"IV\"]}")
cat_id() { api GET /stock/refs "$ADM" | jq -r --arg k "$1" '.categories[]|select(.code==$k)|.id' | head -1; }
EAN="$(printf '27%011d' "$S")"
item() { api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E OI $1 $S\",\"category_id\":\"$(cat_id "$2")\",\"base_unit\":\"$3\"${4:-}}" | jq -r '.id // empty'; }
IT_FEN=$(item "Fentanyl 0.1mg" MED ampoule ",\"generic_id\":\"$G_FEN\""); IT_PRO=$(item "Propofol 200mg" MED ampoule ",\"generic_id\":\"$G_PRO\"")
IT_GAU=$(item "საფენი სტერილური" MEDSUP piece ",\"barcodes\":[{\"barcode\":\"$EAN\"}]"); IT_SUT=$(item "ნაკერი Vicryl 2-0" MEDSUP piece)
IT_IMP=$(item "მუხლის ენდოპროთეზი" IMPLANT piece ",\"serial_tracked\":true,\"billing_mode\":\"invoice\",\"sale_price\":1500,\"manufacturer\":\"ტესტ-E2E Ortho\"")
for i in IT_FEN IT_PRO IT_GAU IT_SUT IT_IMP; do [ -n "${!i}" ] || die "საქონელი $i ვერ შეიქმნა"; done
SUP=$(api POST /stock/suppliers "$ADM" -d "{\"name\":\"ტესტ-E2E OI მიმწოდებელი $S\",\"tax_id\":\"7$(printf '%08d' "$S")\"}" | jq -r '.id // empty')
ln() { echo "{\"item_id\":\"$1\",\"qty\":$2,\"lot_no\":\"$3$S\",\"expires_on\":\"$D2Y\",\"price\":${4:-1},\"vat_rate\":0${5:-}}"; }
RCP=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$LOC\",\"supplier_id\":\"$SUP\",\"lines\":[$(ln "$IT_FEN" 10 F),$(ln "$IT_PRO" 20 P),$(ln "$IT_GAU" 100 G 0.2),$(ln "$IT_SUT" 20 V 3),
  $(ln "$IT_IMP" 1 KN 900 ",\"serial_no\":\"SN1-$S\""),$(ln "$IT_IMP" 1 KN 900 ",\"serial_no\":\"SN2-$S\"")]}" | jq -r '.id // empty')
[ -n "$RCP" ] && [ "$(api POST "/stock/receipts/$RCP/post" "$ADM" | jq -r .status)" = "posted" ] || die "მიღება ბლოკის ლოკაციაზე ვერ მოხერხდა"
bal() { api GET "/stock/balances?location_id=$LOC&item_id=$1" "$ADM" | jq -r '([.rows[].qty|tonumber]|add // 0) + 0'; }
ok "ბლოკი + ლოკაცია, ოთახები OI1 / OI2, პროცედურები, მარაგი (ფენტანილი, პროპოფოლი, საფენი, ნაკერი, ენდოპროთეზი ×2 სერიული)"
# CSSD: ერთეული, ნაკრები ×2 → ერთი სტერილური, მეორე — შეფუთული (არასტერილური)
UNIT=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EOIC$S\",\"name\":\"ტესტ-E2E OI CSSD $S\",\"kind\":\"cssd\",\"department_id\":\"$DC\"}" | jq -r '.id // empty')
PKG=$(api POST /cssd/packaging "$ADM" -d "{\"name\":\"ტესტ-E2E OI პაკეტი $S\",\"shelf_days\":90}" | jq -r '.id // empty')
AUTO=$(api POST /cssd/machines "$ADM" -d "{\"name\":\"ტესტ-E2E OI ავტოკლავი $S\",\"kind\":\"steam\",\"location_id\":\"$UNIT\"}" | jq -r '.id // empty')
TPL=$(api POST /cssd/templates "$ADM" -d "{\"code\":\"E2E-OI-$S\",\"name\":\"ტესტ-E2E ორთოპედიული ნაკრები\",\"packaging_type_id\":\"$PKG\",\"items\":[{\"name\":\"მომჭერი\",\"qty\":4}]}" | jq -r '.id // empty')
SETS=$(api POST /cssd/sets "$ADM" -d "{\"template_id\":\"$TPL\",\"home_location_id\":\"$UNIT\",\"count\":2}")
SET1=$(echo "$SETS" | jq -r '.[0].id // empty'); SET2=$(echo "$SETS" | jq -r '.[1].id // empty'); SET1BC=$(echo "$SETS" | jq -r '.[0].barcode // empty')
api POST /cssd/receive "$ADM" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$SET1\",\"$SET2\"]}" >/dev/null
api POST /cssd/wash "$ADM" -d "{\"location_id\":\"$UNIT\",\"set_ids\":[\"$SET1\",\"$SET2\"]}" >/dev/null
PK1=$(api POST /cssd/pack "$ADM" -d "{\"set_id\":\"$SET1\"}"); PK1ID=$(echo "$PK1" | jq -r '.id // empty'); PK1NO=$(echo "$PK1" | jq -r '.pack_no // empty')
PK2=$(api POST /cssd/pack "$ADM" -d "{\"set_id\":\"$SET2\"}"); PK2NO=$(echo "$PK2" | jq -r '.pack_no // empty')
api POST /cssd/cycles "$ADM" -d "{\"machine_id\":\"$AUTO\",\"kind\":\"sterilize\",\"result\":\"pass\",\"pack_ids\":[\"$PK1ID\"]}" >/dev/null
chk "CSSD: შეფუთვა 1 — სტერილური, 2 — შეფუთული (სტერილიზაციის გარეშე)" "$(api GET "/cssd/packs/$PK1ID" "$ADM" | jq -r .status):$(api GET "/cssd/scan/$PK2NO" "$ADM" | jq -r .pack.status)" "sterile:packed"

step "1. პარამეტრები"
chk "nursing_team_by / count_mode / note_required — არასწორი → 400" \
  "$(code PUT /modules/or "$ADM" -d '{"settings":{"nursing_team_by":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"count_mode":"strict"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/or "$ADM" -d '{"settings":{"note_required":["foo"]},"reason":"ტესტ-E2E"}')" "400:400:400"
chk "ნაგულისხმევები (0049): both, room_teams, direct, procedure_surgeon, block" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="or")|.settings|"\(.nursing_team_by):\(.room_teams):\(.anesthesia_meds):\(.preference_cards):\(.count_mode)"')" "both:true:direct:procedure_surgeon:block"

step "2. ოთახის გუნდი (roster)"
RS() { api POST /or/roster "$1" -d "{\"room_id\":\"$2\",\"user_id\":\"$3\",\"role_code\":\"$4\"}"; }
chk "მთავარი ექთანი: სკრაბ ექთანი OI1-ში; ქირურგი → 403; ჩვ. საოპერაციო ექთანი → 403" \
  "$(RS "$ON1" "$RO1" "$(uid 69)" scrub_nurse | jq -r --arg r "$RO1" '.rooms[]|select(.id==$r)|.staff|length'):$(code POST /or/roster "$SU1" -d "{\"room_id\":\"$RO1\",\"user_id\":\"$(uid 70)\",\"role_code\":\"circulating_nurse\"}"):$(code POST /or/roster "$ON2" -d "{\"room_id\":\"$RO1\",\"user_id\":\"$(uid 70)\",\"role_code\":\"circulating_nurse\"}")" "1:403:403"
RS "$ON1" "$RO1" "$(uid 70)" circulating_nurse >/dev/null
chk "ანესთეზიოლოგი ოთახში: მთავარი ექთანი → 403 (anesthesia_head), ანესთეზიოლოგიის ხელმძღვანელი → ✓" \
  "$(code POST /or/roster "$ON1" -d "{\"room_id\":\"$RO1\",\"user_id\":\"$(uid 67)\",\"role_code\":\"anesthesiologist\"}"):$(RS "$AN1" "$RO1" "$(uid 67)" anesthesiologist | jq -r --arg r "$RO1" '.rooms[]|select(.id==$r)|.staff|length')" "403:3"
chk "ქირურგიული როლი ოთახში → 400; იგივე პირი მეორე ოთახში → 409; არაექთანი სკრაბად → 400" \
  "$(code POST /or/roster "$ADM" -d "{\"room_id\":\"$RO2\",\"user_id\":\"$(uid 64)\",\"role_code\":\"assistant\"}"):$(code POST /or/roster "$ON1" -d "{\"room_id\":\"$RO2\",\"user_id\":\"$(uid 69)\",\"role_code\":\"scrub_nurse\"}"):$(code POST /or/roster "$ON1" -d "{\"room_id\":\"$RO2\",\"user_id\":\"$(uid 64)\",\"role_code\":\"scrub_nurse\"}")" "400:409:400"
BODY1="{\"encounter_id\":\"$E1\",\"urgency\":\"elective\",\"anesthesia_type\":\"general\",\"needs_implant\":true,\"preferred_anesthesiologist_id\":\"$(uid 66)\",\"procedures\":[{\"procedure_id\":\"$PR\",\"side\":\"right\"}]}"
C1=$(api POST /or/cases "$SU1" -d "$BODY1" | jq -r '.id // empty'); [ -n "$C1" ] || die "მოთხოვნა ვერ შეიქმნა"
R=$(api POST "/or/cases/$C1/schedule" "$CO" -d "{\"room_id\":\"$RO1\",\"start\":\"$(T 45)\",\"duration_min\":120,\"confirm\":true}")
chk "დაგეგმვა OI1-ში → ოთახის გუნდი ავტომატურად (ანესთეზიოლოგი + 2 ექთანი, auto)" "$(echo "$R" | jq -r '[.team[]|select(.auto and .removed_at==null)|.role_code]|sort|join(",")')" "anesthesiologist,circulating_nurse,scrub_nurse"
chk "მინიშნება: ქირურგის სასურველი ანესთეზიოლოგი ≠ ოთახის გუნდის" "$(echo "$R" | jq -r '.hints|length>0 and (.[0]|test("ოთახის გუნდიდან"))')" "true"
chk "ისტორია: team_auto" "$(echo "$R" | jq -r '[.events[]|select(.kind=="team_auto")]|length>0')" "true"
DAY() { api POST /or/roster/day "$1" -d "$2"; }
R=$(DAY "$ON1" "{\"day\":\"$TODAY\",\"user_id\":\"$(uid 70)\",\"room_id\":\"$RO2\",\"note\":\"ტესტ-E2E\"}")
chk "დღის ცვლილება: მოძრავი ექთანი დღეს → OI2 (დღის გუნდი OI1: 2, OI2: 1)" "$(echo "$R" | jq -r --arg a "$RO1" --arg b "$RO2" '"\(.rooms[]|select(.id==$a)|.team|length):\(.rooms[]|select(.id==$b)|.team|length)"')" "2:1"
chk "→ ოპერაციიდან ავტომატური წევრი მოიხსნა (removed_auto)" "$(api GET "/or/cases/$C1" "$ON1" | jq -r --arg u "$(uid 70)" '[.team[]|select(.user_id==$u and .removed_at!=null and .removed_auto)]|length'):$(api GET "/or/cases/$C1" "$ON1" | jq -r '[.team[]|select(.auto and .removed_at==null)]|length')" "1:2"
OV=$(echo "$R" | jq -r --arg u "$(uid 70)" '.overrides[]|select(.user_id==$u)|.id')
chk "წარსული დღე → 400; ქირურგი → 403" "$(code POST /or/roster/day "$ON1" -d "{\"day\":\"2020-01-01\",\"user_id\":\"$(uid 70)\",\"room_id\":null}"):$(code POST /or/roster/day "$SU1" -d "{\"day\":\"$TODAY\",\"user_id\":\"$(uid 70)\",\"room_id\":null}")" "400:403"
api POST "/or/roster/day/$OV/cancel" "$ON1" >/dev/null
chk "ცვლილების გაუქმება → ექთანი ისევ ოპერაციაზე (auto)" "$(api GET "/or/cases/$C1" "$ON1" | jq -r --arg u "$(uid 70)" '[.team[]|select(.user_id==$u and .auto and .removed_at==null)]|length')" "1"
R=$(DAY "$ON1" "{\"day\":\"$TODAY\",\"user_id\":\"$(uid 69)\",\"room_id\":null}")
chk "„დღეს არ არის“ (სკრაბ ექთანი) → დღის გუნდიდან და ოპერაციიდან მოიხსნა" "$(echo "$R" | jq -r --arg a "$RO1" '.rooms[]|select(.id==$a)|.team|map(.role_code)|index("scrub_nurse")==null'):$(api GET "/or/cases/$C1" "$ON1" | jq -r '[.team[]|select(.role_code=="scrub_nurse" and .removed_at==null)]|length')" "true:0"
api POST "/or/roster/day/$(echo "$R" | jq -r --arg u "$(uid 69)" '.overrides[]|select(.user_id==$u)|.id')/cancel" "$ON1" >/dev/null
TID=$(api GET "/or/cases/$C1" "$SU1" | jq -r --arg u "$(uid 70)" '.team[]|select(.user_id==$u and .removed_at==null)|.id')
api POST "/or/team/$TID/remove" "$SU1" -d '{"reason":"ტესტ-E2E: ხელით"}' >/dev/null
RS "$ON1" "$RO1" "$(uid 71)" circulating_nurse >/dev/null
R=$(api GET "/or/cases/$C1" "$SU1")
chk "ხელით მოხსნილი ავტომატური აღარ ბრუნდება; ახალი ოთახის წევრი ემატება" "$(echo "$R" | jq -r --arg a "$(uid 70)" --arg b "$(uid 71)" '"\([.team[]|select(.user_id==$a and .removed_at==null)]|length):\([.team[]|select(.user_id==$b and .auto and .removed_at==null)]|length)"')" "0:1"
BD=$(api GET "/or/board?date=$TODAY" "$CO")
chk "დაფა (დღე): OI1-ის დღის გუნდი — 4 (ანესთეზიოლოგი, სკრაბ, მოძრავი ×2)" "$(echo "$BD" | jq -r --arg a "$RO1" '.rooms[]|select(.id==$a)|.team|length'):$(echo "$BD" | jq -r .room_teams)" "4:true"
chk "roster — ნახვა (კოორდინატორი), მართვა — არა" "$(api GET "/or/roster?date=$TODAY" "$CO" | jq -r '"\(.can.nursing):\(.can.anesthesia)"')" "false:false"

step "3. საექთნო როლები — nursing_team_by"
ormod '{"nursing_team_by":"or_head_nurse"}' >/dev/null
chk "or_head_nurse: ქირურგი სკრაბ ექთანს ვერ ნიშნავს → 403; მთავარი ექთანი → ✓" \
  "$(code POST "/or/cases/$C1/team" "$SU1" -d "{\"role_code\":\"scrub_nurse\",\"user_id\":\"$(uid 70)\",\"confirm\":true}"):$(api POST "/or/cases/$C1/team" "$ON1" -d "{\"role_code\":\"scrub_nurse\",\"user_id\":\"$(uid 70)\",\"confirm\":true}" | jq -r --arg u "$(uid 70)" '[.team[]|select(.user_id==$u and .removed_at==null and (.auto|not))]|length')" "403:1"
ormod '{"nursing_team_by":"surgeon"}' >/dev/null
TID=$(api GET "/or/cases/$C1" "$SU1" | jq -r --arg u "$(uid 70)" '.team[]|select(.user_id==$u and .removed_at==null)|.id')
chk "surgeon: მთავარი ექთანი → 403; ასისტენტი (ქირურგიული) — მთავარ ექთანს → 403" "$(code POST "/or/team/$TID/remove" "$ON1" -d '{}'):$(code POST "/or/cases/$C1/team" "$ON1" -d "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 64)\"}")" "403:403"
ormod '{"nursing_team_by":"both"}' >/dev/null
chk "both: ქირურგიც და მთავარი ექთანიც; ასისტენტი (ქირურგი)" "$(api GET "/or/cases/$C1" "$ON1" | jq -r '"\(.can.team_nursing):\(.can.team_surgical)"'):$(api POST "/or/cases/$C1/team" "$SU1" -d "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 64)\",\"confirm\":true}" | jq -r '[.team[]|select(.role_code=="assistant" and .removed_at==null)]|length')" "true:false:1"

step "4. ანესთეზიის რუკა"
chk "დაწყებამდე → 409" "$(code PUT "/or/cases/$C1/anesthesia" "$AN2" -d '{"airway_device":"ett"}')" "409"
TM() { api POST "/or/cases/$1/times" "$2" -d "$3"; }
R=$(TM "$C1" "$ON2" "{\"kind\":\"in_room\",\"at\":\"$(T 40)\",\"readiness_override\":\"ტესტ-E2E: თანხმობა ქაღალდზე\"}")
chk "საოპერაციოში შემოვიდა (მზადყოფნა — დასაბუთებით) → მიმდინარე" "$(echo "$R" | jq -r .status)" "in_progress"
TM "$C1" "$AN2" "{\"kind\":\"anesthesia_start\",\"at\":\"$(T 35)\"}" >/dev/null
chk "ქირურგი → 403; სკრაბ ექთანი (საექთნო როლი) → 403; ანესთეზიოლოგი → ✓" \
  "$(code PUT "/or/cases/$C1/anesthesia" "$SU1" -d '{"notes":"x"}'):$(code PUT "/or/cases/$C1/anesthesia" "$ON2" -d '{"notes":"x"}'):$(api PUT "/or/cases/$C1/anesthesia" "$AN2" -d '{"position":"ზურგზე"}' | jq -r '.record.status')" "403:403:draft"
R=$(api POST "/or/cases/$C1/anesthesia/sign" "$AN2")
chk "ხელმოწერა: აკლია (სასუნთქი გზები, ანესთეზიის დასრულება, ვიტალები) → ANESTHESIA_INCOMPLETE" "$(ecode "$R"):$(echo "$R" | jq -r '.missing|length')" "ANESTHESIA_INCOMPLETE:3"
R=$(api PUT "/or/cases/$C1/anesthesia" "$AN2" -d '{"airway_device":"ett","ett_size":7.5,"intubation_attempts":1,"cormack_lehane":1,"technique_notes":"RSI"}')
chk "სასუნთქი გზები: ETT 7.5, 1 მცდელობა, CL I" "$(echo "$R" | jq -r '.record|"\(.airway_device):\(.ett_size|tonumber):\(.intubation_attempts):\(.cormack_lehane)"')" "ett:7.5:1:1"
VT() { api POST "/or/cases/$C1/anesthesia/vitals" "$1" -d "$2"; }
chk "ვიტალები: ბადის გარეთ (… :03) → 400; ცარიელი → 400; მომავალი → 400" \
  "$(code POST "/or/cases/$C1/anesthesia/vitals" "$AN2" -d "{\"at\":\"$(date -u -d "@$((BASE - 33*60))" +%FT%TZ)\",\"heart_rate\":80}"):$(code POST "/or/cases/$C1/anesthesia/vitals" "$AN2" -d "{\"at\":\"$(T 30)\"}"):$(code POST "/or/cases/$C1/anesthesia/vitals" "$AN2" -d "{\"at\":\"$(T -30)\",\"heart_rate\":80}")" "400:400:400"
VT "$AN2" "{\"at\":\"$(T 35)\",\"systolic_bp\":130,\"diastolic_bp\":80,\"heart_rate\":78,\"spo2\":99}" >/dev/null
VT "$AN2" "{\"at\":\"$(T 30)\",\"systolic_bp\":105,\"diastolic_bp\":60,\"heart_rate\":70,\"spo2\":100,\"etco2\":35}" >/dev/null
R=$(VT "$AN2" "{\"at\":\"$(T 25)\",\"systolic_bp\":110,\"diastolic_bp\":65,\"heart_rate\":72,\"spo2\":100,\"etco2\":36,\"temperature\":36.4}")
chk "3 სლოტი (35 / 30 / 25 წთ წინ); MAP ავტომატურად (105/60 → 75)" "$(echo "$R" | jq -r '[.vitals[]|select(.voided_at==null)]|length'):$(echo "$R" | jq -r --arg t "$(T 30)" '[.vitals[]|select(.systolic_bp==105)][0].map_mmhg')" "3:75"
chk "იგივე სლოტი მეორედ → 409" "$(code POST "/or/cases/$C1/anesthesia/vitals" "$AN2" -d "{\"at\":\"$(T 25)\",\"heart_rate\":90}")" "409"
VID=$(echo "$R" | jq -r '[.vitals[]|select(.systolic_bp==105)][0].id')
R=$(api POST "/or/anesthesia/vitals/$VID/void" "$AN2" -d '{"reason":"ტესტ-E2E: შეცდომა"}')
chk "გაუქმება (მიზეზით) → სლოტი თავისუფალია, ხელახლა ჩაიწერა" "$(echo "$R" | jq -r '[.vitals[]|select(.voided_at==null)]|length'):$(VT "$AN2" "{\"at\":\"$(T 30)\",\"systolic_bp\":108,\"diastolic_bp\":62,\"heart_rate\":71}" | jq -r '[.vitals[]|select(.voided_at==null)]|length')" "2:3"
FL() { api POST "/or/cases/$C1/anesthesia/fluids" "$AN2" -d "$1"; }
FL "{\"category\":\"iv\",\"volume_ml\":1000,\"at\":\"$(T 20)\",\"note\":\"რინგერი\"}" >/dev/null; FL "{\"category\":\"blood_loss\",\"volume_ml\":300,\"at\":\"$(T 15)\"}" >/dev/null
FID=$(FL "{\"category\":\"urine\",\"volume_ml\":999,\"at\":\"$(T 15)\"}" | jq -r '[.fluids[]|select(.category=="urine")][0].id')
api POST "/or/anesthesia/fluids/$FID/void" "$AN2" -d '{"reason":"ტესტ-E2E"}' >/dev/null
R=$(FL "{\"category\":\"urine\",\"volume_ml\":150,\"at\":\"$(T 15)\"}")
chk "სითხეები → ბალანსი: მიღება 1000, გამოყოფა 450 (სისხლი 300 + შარდი 150), +550" "$(echo "$R" | jq -r '.balance|"\(.in):\(.out):\(.net):\(.by_category.blood_loss)"')" "1000:450:550:300"
chk "ჰოსპიტალიზაციის ბალანსში (fluid_entries): სისხლის დაკარგვა" "$(api GET "/inpatient/stays/$E1/nursing" "$ADM" | jq -r '[..|objects|select(.category?=="blood_loss" and .voided_at==null)]|length>0')" "true"

step "5. ანესთეზიის მედიკამენტები"
MD() { api POST "/or/cases/$C1/anesthesia/meds" "$1" -d "$2"; }
P0=$(bal "$IT_PRO"); F0=$(bal "$IT_FEN")
R=$(MD "$AN2" "{\"item_id\":\"$IT_PRO\",\"dose\":150,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"qty_base\":1,\"dose_wasted\":50,\"given_at\":\"$(T 34)\"}")
chk "პროპოფოლი 150 მგ (+50 ნარჩენი) — ჩაიწერა, ბლოკის საწყობიდან ჩამოიწერა (20 → 19)" "$(echo "$R" | jq -r '[.meds[]|select(.controlled|not)]|length'):$P0→$(bal "$IT_PRO")" "1:20→19"
chk "ფენტანილი მოწმის გარეშე → WITNESS_REQUIRED; ნარჩენის გარეშე → WASTE_REQUIRED" \
  "$(ecode "$(MD "$AN2" "{\"item_id\":\"$IT_FEN\",\"dose\":50,\"qty_base\":1,\"dose_wasted\":50}")"):$(ecode "$(MD "$AN2" "{\"item_id\":\"$IT_FEN\",\"dose\":50,\"qty_base\":1,\"witness\":$(WIT 68)}")")" "WITNESS_REQUIRED:WASTE_REQUIRED"
chk "დოზა + ნარჩენი ≠ ამპულა (50 + 30 ≠ 100) → 400; საკუთარი თავი მოწმედ → 400" \
  "$(code POST "/or/cases/$C1/anesthesia/meds" "$AN2" -d "{\"item_id\":\"$IT_FEN\",\"dose\":50,\"qty_base\":1,\"dose_wasted\":30,\"witness\":$(WIT 68)}"):$(code POST "/or/cases/$C1/anesthesia/meds" "$AN2" -d "{\"item_id\":\"$IT_FEN\",\"dose\":50,\"qty_base\":1,\"dose_wasted\":50,\"witness\":$(WIT 67)}")" "400:400"
R=$(MD "$AN2" "{\"item_id\":\"$IT_FEN\",\"dose\":50,\"dose_unit\":\"mcg\",\"route_code\":\"IV\",\"qty_base\":1,\"dose_wasted\":50,\"witness\":$(WIT 68),\"given_at\":\"$(T 35)\"}")
chk "ფენტანილი 50 მკგ: მოწმე (მთავარი ექთანი) + ნარჩენი 50; ჩამოიწერა (10 → 9)" "$(echo "$R" | jq -r '[.meds[]|select(.controlled)][0]|"\(.witness_name!=null):\((.dose_wasted|tonumber)+0)"'):$F0→$(bal "$IT_FEN")" "true:50:10→9"
chk "მასალა (საფენი) ანესთეზიის რუკაში → 400; ქირურგი → 403" "$(code POST "/or/cases/$C1/anesthesia/meds" "$AN2" -d "{\"item_id\":\"$IT_GAU\",\"dose\":1,\"qty_base\":1}"):$(code POST "/or/cases/$C1/anesthesia/meds" "$SU1" -d "{\"item_id\":\"$IT_PRO\",\"dose\":1,\"qty_base\":1}")" "400:403"
chk "ბლოკის მედიკამენტების ძებნა (ნაშთით)" "$(api GET "/or/cases/$C1/anesthesia/stock?q=$(jq -rn --arg q 'ტესტ-E2E OI' '$q|@uri')" "$AN2" | jq -r 'map(.kind)|unique|join(",")')" "medication"
ormod '{"anesthesia_meds":"orders"}' >/dev/null
chk "anesthesia_meds = orders: პირდაპირი ჟურნალი → MEDS_VIA_ORDERS; რუკაზე — MAR-ის სია" "$(ecode "$(MD "$AN2" "{\"item_id\":\"$IT_PRO\",\"dose\":10,\"qty_base\":1}")"):$(api GET "/or/cases/$C1/anesthesia" "$AN2" | jq -r '"\(.meds_mode):\(.mar|type)"')" "MEDS_VIA_ORDERS:orders:array"
ormod '{"anesthesia_meds":"direct"}' >/dev/null

step "6. დათვლა (count_mode = block) + WHO"
WHO_ITEMS() { api GET "/or/cases/$1" "$ON2" | jq -c --arg p "$2" '[.who_items[]|select(.phase==$p)|{key:.id,value:"yes"}]|from_entries'; }
api POST "/or/cases/$C1/who" "$ON2" -d "{\"phase\":\"sign_in\",\"answers\":$(WHO_ITEMS "$C1" sign_in)}" >/dev/null
api POST "/or/cases/$C1/who" "$SU1" -d "{\"phase\":\"time_out\",\"answers\":$(WHO_ITEMS "$C1" time_out)}" >/dev/null
chk "განაკვეთი დათვლის გარეშე → COUNT_REQUIRED" "$(ecode "$(TM "$C1" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(T 25)\"}")")" "COUNT_REQUIRED"
CNT() { api POST "/or/cases/$C1/counts" "$1" -d "$2"; }
chk "დახურვამდე დათვლა დაწყებამდე → COUNT_ORDER; ქირურგი → 403" "$(ecode "$(CNT "$ON2" '{"phase":"pre_closure","lines":[{"kind":"sponges","expected":10,"counted":10}]}')"):$(code POST "/or/cases/$C1/counts" "$SU1" -d '{"phase":"initial","lines":[{"kind":"sponges","expected":10,"counted":10}]}')" "COUNT_ORDER:403"
R=$(CNT "$ON2" "{\"phase\":\"initial\",\"second_by\":\"$(uid 71)\",\"lines\":[{\"kind\":\"sponges\",\"expected\":10,\"counted\":10},{\"kind\":\"needles\",\"expected\":5,\"counted\":5},{\"kind\":\"instruments\",\"expected\":24,\"counted\":24}]}")
chk "დათვლა დაწყებისას: სწორი (მეორე დამთვლელით)" "$(echo "$R" | jq -r '.count_state.initial|"\(.done):\(.correct)"')" "true:true"
chk "განაკვეთი (Time out + დათვლა) → ✓" "$(TM "$C1" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(T 25)\"}" | jq -r '[.times[]|select(.kind=="incision")]|length')" "1"

step "7. CSSD ნაკრები"
PK() { api POST "/or/cases/$C1/packs" "$ON2" -d "{\"code\":\"$1\"}"; }
chk "არასტერილური (შეფუთული) → PACK_NOT_STERILE; უცნობი → PACK_UNKNOWN" "$(ecode "$(PK "$PK2NO")"):$(ecode "$(PK "NOPE-$S")")" "PACK_NOT_STERILE:PACK_UNKNOWN"
R=$(PK "$SET1BC")
chk "სტერილური (ნაკრების კოდით) → მიება; CSSD-ში — გაცემულია ბლოკზე" "$(echo "$R" | jq -r '[.packs[]|select(.removed_at==null)]|length'):$(api GET "/cssd/packs/$PK1ID" "$ADM" | jq -r .status)" "1:issued"
chk "იგივე შეფუთვა მეორედ → 409; ქირურგი → 403" "$(code POST "/or/cases/$C1/packs" "$ON2" -d "{\"code\":\"$PK1NO\"}"):$(code POST "/or/cases/$C1/packs" "$SU1" -d "{\"code\":\"$PK1NO\"}")" "409:403"

step "8. მასალები: preference card, სკანირება, იმპლანტი, ჩამოწერა"
CARD() { api PUT /or/preference-cards "$1" -d "$2"; }
chk "ზოგადი ბარათი: ქირურგი → 403; მთავარი ექთანი → ✓" "$(code PUT /or/preference-cards "$SU1" -d "{\"procedure_id\":\"$PR\",\"items\":[{\"item_id\":\"$IT_GAU\",\"qty\":10}]}"):$(CARD "$ON1" "{\"procedure_id\":\"$PR\",\"items\":[{\"item_id\":\"$IT_GAU\",\"qty\":10}]}" | jq -r '.items|length')" "403:1"
chk "ქირურგის ბარათი: სხვა ქირურგი → 403; თავად → ✓ (საფენი 20, ნაკერი 2)" "$(code PUT /or/preference-cards "$SU2" -d "{\"procedure_id\":\"$PR\",\"surgeon_id\":\"$(uid 62)\",\"items\":[{\"item_id\":\"$IT_GAU\",\"qty\":1}]}"):$(CARD "$SU1" "{\"procedure_id\":\"$PR\",\"surgeon_id\":\"$(uid 62)\",\"items\":[{\"item_id\":\"$IT_GAU\",\"qty\":20},{\"item_id\":\"$IT_SUT\",\"qty\":2}]}" | jq -r '.items|length')" "403:2"
chk "ოპერაციაზე — ოპერატორის ბარათი (procedure_surgeon)" "$(api GET "/or/cases/$C1/materials" "$ON2" | jq -r '.card.items|map("\(.qty)")|sort|join(",")')" "2,20"
ormod '{"preference_cards":"procedure"}' >/dev/null
chk "preference_cards = procedure → ზოგადი ბარათი (საფენი 10)" "$(api GET "/or/cases/$C1/materials" "$ON2" | jq -r '.card.items|map("\(.qty)")|join(",")')" "10"
ormod '{"preference_cards":"procedure_surgeon"}' >/dev/null
R=$(api POST "/or/cases/$C1/items/assemble" "$ON2")
chk "შეკრება → 2 პოზიცია (card); მეორედ → 409" "$(echo "$R" | jq -r '[.items[]|select(.source=="card")]|length'):$(code POST "/or/cases/$C1/items/assemble" "$ON2")" "2:409"
SC() { api POST "/or/cases/$C1/items/scan" "$ON2" -d "$1"; }
R=$(SC "{\"code\":\"$EAN\"}")
chk "სკანირება (EAN) — საფენი: იმავე ხაზზე +1 (20 → 21)" "$(echo "$R" | jq -r --arg i "$IT_GAU" '[.items[]|select(.item_id==$i)][0].qty|tonumber+0')" "21"
R=$(SC "{\"code\":\"SN1-$S\",\"implant_site\":\"მარჯვენა მუხლი\"}")
chk "სკანირება — იმპლანტის სერიული: იმპლანტი, ლოტი + სერია" "$(echo "$R" | jq -r --arg i "$IT_IMP" '[.items[]|select(.item_id==$i)][0]|"\(.is_implant):\(.serial_no):\(.implant_site)"')" "true:SN1-$S:მარჯვენა მუხლი"
chk "უცნობი კოდი → SCAN_UNKNOWN; იგივე სერიული მეორედ → 409" "$(ecode "$(SC "{\"code\":\"ZZ-$S\"}")"):$(code POST "/or/cases/$C1/items/scan" "$ON2" -d "{\"code\":\"SN1-$S\"}")" "SCAN_UNKNOWN:409"
R=$(api POST "/or/cases/$C1/items" "$ON2" -d "{\"item_id\":\"$IT_IMP\",\"qty\":1}")
chk "იმპლანტი ლოტის გარეშე → ჩამოწერა: IMPLANT_LOT_SERIAL" "$(ecode "$(api POST "/or/cases/$C1/items/post" "$ON2")")" "IMPLANT_LOT_SERIAL"
api POST "/or/items/$(echo "$R" | jq -r --arg i "$IT_IMP" '[.items[]|select(.item_id==$i and .lot_id==null)][0].id')/remove" "$ON2" >/dev/null
SUTROW=$(api GET "/or/cases/$C1/materials" "$ON2" | jq -r --arg i "$IT_SUT" '.items[]|select(.item_id==$i)|.id')
chk "რაოდენობის შეცვლა (ნაკერი 2 → 3); ქირურგი → 403" "$(api PATCH "/or/items/$SUTROW" "$ON2" -d '{"qty":3}' | jq -r --arg i "$IT_SUT" '.items[]|select(.item_id==$i)|.qty|tonumber+0'):$(code PATCH "/or/items/$SUTROW" "$SU1" -d '{"qty":4}')" "3:403"
G0=$(bal "$IT_GAU")
R=$(api POST "/or/cases/$C1/items/post" "$ON2")
chk "ჩამოწერა: 3 ხაზი, დოკუმენტი, ნაშთი — საფენი 100 → 79, ნაკერი 20 → 17, SN1 → 0" "$(echo "$R" | jq -r '[.items[]|select(.posted_at!=null)]|length'):$(echo "$R" | jq -r '.doc_no|test("^CN")'):$G0→$(bal "$IT_GAU"):$(bal "$IT_SUT"):$(bal "$IT_IMP")" "3:true:100→79:17:1"
chk "იმპლანტების რეესტრი: SN1, ადგილი" "$(echo "$R" | jq -r '.implants|map("\(.serial_no):\(.site)")|join(",")')" "SN1-$S:მარჯვენა მუხლი"
DOC=$(echo "$R" | jq -r '[.items[]|select(.is_implant)][0].stock_doc_id')
chk "ინვოისი: იმპლანტი (კატეგორიის წესით — 1500 ₾), გაფრთხილების გარეშე" "$(api GET "/stock/docs/$DOC" "$ADM" | jq -r --arg i "$IT_IMP" '[.lines[]|select(.item_id==$i)][0].sale_price|tonumber+0'):$(echo "$R" | jq -r '.warnings|length')" "1500:0"
chk "ჩამოწერილი ხაზის შეცვლა / წაშლა → 409; ცარიელი სია → 400" "$(code PATCH "/or/items/$SUTROW" "$ON2" -d '{"qty":5}'):$(code POST "/or/items/$SUTROW/remove" "$ON2"):$(code POST "/or/cases/$C1/items/post" "$ON2")" "409:409:400"

step "9. ოქმი"
NT() { api PUT "/or/cases/$C1/note" "$1" -d "$2"; }
chk "ექთანი → 403; გუნდის გარეშე ქირურგი → 403" "$(code PUT "/or/cases/$C1/note" "$ON2" -d '{"description":"x"}'):$(code PUT "/or/cases/$C1/note" "$SU2" -d '{"description":"x"}')" "403:403"
TP1=$(api POST /or/note-templates "$SU1" -d "{\"name\":\"ტესტ-E2E ჩემი TKA\",\"personal\":true,\"procedure_id\":\"$PR\",\"description\":\"მედიალური პარაპატელარული მიდგომა…\"}" | jq -r '.id // empty')
TP2=$(api POST /or/note-templates "$ADM" -d "{\"name\":\"ტესტ-E2E TKA (კლინიკა)\",\"procedure_id\":\"$PR\",\"description\":\"სტანდარტული აღწერა\",\"findings\":\"ართროზი III-IV\"}" | jq -r '.id // empty')
chk "შაბლონები: პროცედურისა — ქირურგი → 403; ასისტენტი ხედავს მხოლოდ კლინიკის, ოპერატორი — ორივეს" \
  "$(code POST /or/note-templates "$SU1" -d "{\"name\":\"x x\",\"procedure_id\":\"$PR\"}"):$(api GET "/or/cases/$C1/note" "$AS" | jq -r '[.templates[]|select(.name|startswith("ტესტ-E2E"))]|length'):$(api GET "/or/cases/$C1/note" "$SU1" | jq -r '[.templates[]|select(.name|startswith("ტესტ-E2E"))]|length')" "403:1:2"
R=$(NT "$AS" "{\"template_id\":\"$TP2\",\"description\":\"სტანდარტული აღწერა — ტესტ-E2E\",\"findings\":\"ართროზი III-IV\"}")
chk "ასისტენტი — შავი ვერსია (v1); ნაგულისხმევი პროცედურა + წინასაოპ. დიაგნოზი" "$(echo "$R" | jq -r '.draft|"\(.version):\(.procedures|length):\(.preop_icd10_code)"')" "1:1:M17.1"
chk "ხელმოწერა: ასისტენტი → 403; ნაკერამდე → NOTE_TOO_EARLY" "$(code POST "/or/cases/$C1/note/sign" "$AS"):$(ecode "$(api POST "/or/cases/$C1/note/sign" "$SU1")")" "403:NOTE_TOO_EARLY"
chk "დახურვამდე დათვლა: შეუსაბამობა ახსნის გარეშე → COUNT_EXPLANATION" "$(ecode "$(CNT "$ON2" '{"phase":"pre_closure","lines":[{"kind":"sponges","expected":10,"counted":9}]}')")" "COUNT_EXPLANATION"
CNT "$ON2" '{"phase":"pre_closure","lines":[{"kind":"sponges","expected":10,"counted":9},{"kind":"needles","expected":5,"counted":5}],"explanation":"ერთი საფენი აკლია — ვეძებთ"}' >/dev/null
chk "ნაკერი შეუსაბამობით → COUNT_DISCREPANCY" "$(ecode "$(TM "$C1" "$SU1" "{\"kind\":\"closure\",\"at\":\"$(T 10)\"}")")" "COUNT_DISCREPANCY"
CNT "$ON2" '{"phase":"pre_closure","lines":[{"kind":"sponges","expected":10,"counted":10},{"kind":"needles","expected":5,"counted":5}]}' >/dev/null
chk "ხელახლა დათვლა (სწორი) → ნაკერი ✓" "$(TM "$C1" "$SU1" "{\"kind\":\"closure\",\"at\":\"$(T 10)\"}" | jq -r '[.times[]|select(.kind=="closure")]|length')" "1"
TM "$C1" "$AN2" "{\"kind\":\"anesthesia_end\",\"at\":\"$(T 5)\"}" >/dev/null
R=$(api POST "/or/cases/$C1/note/sign" "$SU1")
chk "ხელმოწერა სავალდებულო ველების გარეშე → NOTE_INCOMPLETE (პოსტოპ. დიაგნოზი, გართულებები, სისხლის დაკარგვა)" "$(ecode "$R"):$(echo "$R" | jq -r '.missing|length')" "NOTE_INCOMPLETE:3"
api POST "/or/cases/$C1/who" "$ON2" -d "{\"phase\":\"sign_out\",\"answers\":$(WHO_ITEMS "$C1" sign_out)}" >/dev/null
CNT "$ON2" '{"phase":"final","lines":[{"kind":"sponges","expected":10,"counted":10},{"kind":"needles","expected":5,"counted":5}]}' >/dev/null
chk "დასრულება არასრული ოქმით → NOTE_INCOMPLETE (არაარჩევადი)" "$(ecode "$(TM "$C1" "$ON2" "{\"kind\":\"out_of_room\",\"at\":\"$(T 0)\",\"destination\":\"ward\"}")")" "NOTE_INCOMPLETE"
R=$(NT "$SU1" "{\"postop_icd10_code\":\"M17.1\",\"blood_loss_ml\":300,\"complications_none\":true,\"drains\":[{\"kind\":\"drain\",\"site\":\"მარჯვენა მუხლი\",\"size\":\"Ch 12\"}],\"specimens\":[{\"jar_no\":1,\"site\":\"სინოვია\"}],\"path_lab\":\"ტესტ-E2E პათოლოგია\"}")
chk "შევსება: გართულება — „არ ყოფილა“, აკლია — 0" "$(echo "$R" | jq -r '"\(.draft.complications_none):\(.missing|length)"')" "true:0"
R=$(api POST "/or/cases/$C1/note/sign" "$SU1")
chk "ხელმოწერა: v1, დრენაჟი → ხაზები, ბიოფსია → მიმართვა (1 ქილა), იმპლანტი ოქმში" "$(echo "$R" | jq -r '"\(.current.version):\(.lines|length):\(.pathology.specimens|length):\(.pathology.status):\(.current.implants|length)"')" "1:1:1:draft:1"
chk "ოპერაცია დაბლოკილია: გუნდი → 403; განაკვეთის შესწორება → 403" "$(code POST "/or/cases/$C1/team" "$SU1" -d "{\"role_code\":\"assistant\",\"user_id\":\"$(uid 63)\",\"confirm\":true}"):$(code POST "/or/cases/$C1/times" "$SU1" -d "{\"kind\":\"incision\",\"at\":\"$(T 24)\",\"correction_reason\":\"ტესტ-E2E\"}")" "403:403"
chk "ხელმოწერილის შეცვლა → NOTE_SIGNED; ჰოსპიტალიზაციის ისტორიაში — or_note_signed" "$(ecode "$(NT "$SU1" '{"findings":"x"}')"):$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[..|objects|select(.kind?=="or_note_signed")]|length>0' 2>/dev/null)" "NOTE_SIGNED:true"
R=$(api POST "/or/cases/$C1/note/amend" "$SU1" -d '{"reason":"ტესტ-E2E: აღმოჩენების დაზუსტება"}')
chk "შესწორება → v2 (შავი), v1 — ჯერ მოქმედი" "$(echo "$R" | jq -r '"\(.draft.version):\(.current.version)"')" "2:1"
NT "$SU1" '{"findings":"ართროზი IV, ოსტეოფიტები","specimens":[{"jar_no":1,"site":"სინოვია"},{"jar_no":2,"site":"მენისკი"}]}' >/dev/null
R=$(api POST "/or/cases/$C1/note/sign" "$SU1")
chk "v2 ხელმოწერილი, v1 — ჩანაცვლებული; მიმართვა (შავი) — 2 ქილა; დრენაჟი არ დუბლირდა" "$(echo "$R" | jq -r '"\(.current.version):\([.notes[]|select(.superseded_at!=null)]|length):\(.pathology.specimens|length):\(.lines|length)"')" "2:1:2:1"
REQNO=$(echo "$R" | jq -r .pathology.request_no)
chk "პათოლოგიის რეესტრი (გასაგზავნი): „ოპერაცია …“" "$(api GET "/pathology?tab=draft&search=$REQNO" "$ADM" | jq -r '.[0].service_name|startswith("ოპერაცია")')" "true"

step "10. ანესთეზიის რუკის ხელმოწერა"
chk "ანესთეზიის ექთანი (არა ანესთეზიოლოგი) → 403" "$(code POST "/or/cases/$C1/anesthesia/sign" "$ON1")" "403"
R=$(api POST "/or/cases/$C1/anesthesia/sign" "$AN2")
chk "ხელმოწერილი; შემდეგ ვიტალები / სითხე → 409" "$(echo "$R" | jq -r .record.status):$(code POST "/or/cases/$C1/anesthesia/vitals" "$AN2" -d "{\"at\":\"$(T 5)\",\"heart_rate\":70}"):$(code POST "/or/cases/$C1/anesthesia/fluids" "$AN2" -d '{"category":"iv","volume_ml":100}')" "signed:409:409"

step "11. დასრულება"
R=$(TM "$C1" "$ON2" "{\"kind\":\"out_of_room\",\"at\":\"$(T 0)\",\"destination\":\"ward\"}")
chk "Sign out + დათვლა ბოლოს + ოქმი → დასრულებული (ოქმის შემდეგაც — ახალი ნიშნული)" "$(echo "$R" | jq -r .status)" "completed"
chk "CSSD: შეფუთვა → used პაციენტზე" "$(api GET "/cssd/packs/$PK1ID" "$ADM" | jq -r '"\(.status):\(.patient_id)"')" "used:$P1"
chk "ისტორია: packs_used, items_posted, note_signed, anesthesia_signed, count" "$(api GET "/or/cases/$C1" "$ADM" | jq -r '[.events[].kind]|(index("packs_used")!=null) and (index("items_posted")!=null) and (index("note_signed")!=null) and (index("anesthesia_signed")!=null) and (index("count")!=null)')" "true"
chk "პაციენტის იმპლანტების რეესტრი (რეგისტრატორიც ხედავს)" "$(api GET "/or/implants?patient_id=$P1" "$RC" | jq -r 'map("\(.serial_no):\(.case_no!=null)")|join(",")')" "SN1-$S:true"

step "12. count_mode = warn; ადგილობრივი ანესთეზია"
ormod '{"count_mode":"warn"}' >/dev/null
C2=$(api POST /or/cases "$SU1" -d "{\"encounter_id\":\"$E2\",\"anesthesia_type\":\"local\",\"procedures\":[{\"procedure_id\":\"$PH\"}]}" | jq -r '.id // empty')
R=$(api POST "/or/cases/$C2/schedule" "$CO" -d "{\"room_id\":\"$RO1\",\"start\":\"$(T 30)\",\"duration_min\":60,\"confirm\":true}")
chk "ადგილობრივი ანესთეზია → ოთახის გუნდიდან მხოლოდ ექთნები (ანესთეზიოლოგი — არა)" "$(echo "$R" | jq -r '[.team[]|select(.auto and .removed_at==null)|.role_code]|unique|join(",")')" "circulating_nurse,scrub_nurse"
TM "$C2" "$ON2" "{\"kind\":\"in_room\",\"at\":\"$(T 20)\",\"readiness_override\":\"ტესტ-E2E\"}" >/dev/null
api POST "/or/cases/$C2/who" "$ON2" -d "{\"phase\":\"sign_in\",\"answers\":$(WHO_ITEMS "$C2" sign_in)}" >/dev/null
api POST "/or/cases/$C2/who" "$ON2" -d "{\"phase\":\"time_out\",\"answers\":$(WHO_ITEMS "$C2" time_out)}" >/dev/null
chk "warn: განაკვეთი დათვლის გარეშე → COUNT_OVERRIDE_REQUIRED" "$(ecode "$(TM "$C2" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(T 15)\"}")")" "COUNT_OVERRIDE_REQUIRED"
R=$(TM "$C2" "$SU1" "{\"kind\":\"incision\",\"at\":\"$(T 15)\",\"count_override\":\"ტესტ-E2E: მცირე ჩარევა, საფენები არ გამოიყენება\"}")
chk "ახსნით → ✓; ისტორიაში count_override" "$(echo "$R" | jq -r '[.times[]|select(.kind=="incision")]|length'):$(echo "$R" | jq -r '[.events[]|select(.kind=="count_override")]|length')" "1:1"
chk "ანესთეზიის რუკა — ადგილობრივი: ხელმოწერა ვიტალების გარეშე" "$(api PUT "/or/cases/$C2/anesthesia" "$AN2" -d '{"anesthesia_type":"local"}' >/dev/null; api POST "/or/cases/$C2/anesthesia/sign" "$AN2" | jq -r .record.status)" "signed"

step "13. აღდგენა"
api PUT /modules/or "$ADM" -d "{\"settings\":$ORIG_OR,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/cssd "$ADM" -d "{\"enabled\":$(echo "$ORIG_CSSD" | jq .enabled),\"settings\":$(echo "$ORIG_CSSD" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
for id in $(api GET /or/roster "$ADM" | jq -r --arg a "$RO1" --arg b "$RO2" '.rooms[]|select(.id==$a or .id==$b)|.staff[].id'); do api POST "/or/roster/$id/remove" "$ADM" >/dev/null; done
for r in "$PR" "$PH"; do api PATCH "/or/procedures/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PATCH "/or/note-templates/$TP1" "$SU1" -d '{"is_active":false}' >/dev/null; api PATCH "/or/note-templates/$TP2" "$ADM" -d '{"is_active":false}' >/dev/null
chk "პარამეტრები აღდგენილია; ოთახის გუნდი გასუფთავდა" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="or")|.settings' | jq -S . | md5sum | cut -c1-8):$(api GET /or/roster "$ADM" | jq -r --arg a "$RO1" '.rooms[]|select(.id==$a)|.staff|length')" "$(echo "$ORIG_OR" | jq -S . | md5sum | cut -c1-8):0"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
