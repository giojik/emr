#!/usr/bin/env bash
# =====================================================================
# e2e-endoscopy.sh — ენდოსკოპიის სრული ნაკადი (API-ით)
#   რეგისტრატორი → განრიგი → ენდოსკოპები/დეზინფექცია → ექთანი (ჩეკლისტი, სედაცია, ენდოსკოპი)
#   → ენდოსკოპისტი (სურათები, მანიპულაციები, ბიოფსია, ხელმოწერა) → პათოლოგია (გაგზავნა, პასუხი, გაცნობა)
# ქმნის სატესტო მომხმარებლებს/პაციენტს/ენდოსკოპებს ("ტესტ-E2E"); ბოლოს მომხმარებლებს და ენდოსკოპებს თიშავს.
#   bash scripts/e2e-endoscopy.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-endoscopy.sh
# საჭიროა: curl, jq, base64
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
upl()  { local p=$1 t=$2; shift 2; curl -s -X POST "$B$p" -H "authorization: Bearer $t" "$@"; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCKiiivMPrQoqzZWUt9N5cfCj7znoorbh0KzjX94GlJAyS2PyxQRKajuc3RXTSaJYuuFRoznqrHP65rFv8ATpbBxk7426OBjn0PpQKNSMtCnRRRQaBRRRQB11laiztEhGMgZYjue9WKitp1urZJl4DjOPQ9xUtM4He+oVHNClxC8UgyrjBqSmu6xxtI5wqgkn0FAHHSxmGV4mIJRipx7UypJ5POnklxjexbGemTUdI7kFFFFAy7p2ovYyYOWiY/Mv8AUe9b0OqWUy5E6qcDIc7SPz/pXKUUGcqalqdbJqVlEu5rmMjOPlO4/pWHqWqte/u4gyQjqD1Y+9Z1FAo01F3Ciiig1P/Z' | base64 -d > "$TMP/img.jpg"
printf '%%PDF-1.4\n%% ტესტ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMP/scan.pdf"
echo "not an image" > "$TMP/bad.txt"
CREATED_USERS=(); CREATED_SCOPES=()
TOMORROW=$(date -d tomorrow +%F); at() { echo "${TOMORROW}T$1:00+04:00"; }
NOW=$(date -u +%FT%TZ); AGO=$(date -u -d '-25 min' +%FT%TZ)

step "0. გარემო"
chk "API ხელმისაწვდომია" "$(curl -s "$B/health" | jq -r .status)" "ok"
VER=$(curl -s "$B/health" | jq -r .schemaVersion); if [ "$VER" \> "0013" ]; then ok "სქემის ვერსია $VER"; else bad "სქემის ვერსია" "საჭიროა ≥ 0014, არის $VER"; fi

step "1. მომზადება"
DEP=$(api GET "/departments?include_inactive=true" "$ADM" | jq -r '[.[]|select(.type=="diagnostic" and .is_active)][0].id // empty')
[ -n "$DEP" ] || DEP=$(api POST /departments "$ADM" -d '{"name":"დიაგნოსტიკა","code":"DX","type":"diagnostic"}' | jq -r '.id // empty')
[ -n "$DEP" ] && ok "დიაგნოსტიკური განყოფილება" || die "განყოფილება ვერ შეიქმნა"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.$1.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { bad "მომხმარებელი ($1)" "$(echo "$R" | jq -rc .message)"; return; }
  CREATED_USERS+=("$id")
  local t; t=$(login "e2e.$1.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser receptionist 61); NS=$(mkuser endoscopy_nurse 62); EN=$(mkuser endoscopist 63)
[ -n "$RC" ] && [ -n "$NS" ] && [ -n "$EN" ] && ok "3 მომხმარებელი (რეგისტრატორი, ექთანი, ენდოსკოპისტი)" || die "მომხმარებლები ვერ შეიქმნა"
CAT=$(api GET "/dx/catalog?section=endoscopy" "$ADM"); sid() { echo "$CAT" | jq -r ".[]|select(.code==\"$1\")|.id"; }
COL=$(sid ENDO_COLON); EGD=$(sid ENDO_EGD)
[ -n "$COL" ] && [ -n "$EGD" ] && ok "კატალოგი: კოლონოსკოპია, ეზოფაგოგასტროდუოდენოსკოპია" || die "კატალოგი"
ROOM=$(api GET "/dx/devices?section=endoscopy" "$RC" | jq -r '.[0].id // empty'); RAD=$(api GET "/dx/devices?section=radiology" "$RC" | jq -r '.[0].id // empty')
[ -n "$ROOM" ] && ok "ენდოსკოპიის ოთახი" || die "ენდოსკოპიის ოთახი არ არის"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"51$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ენდოსკოპია\",\"birth_date\":\"1964-05-05\",\"gender\":\"male\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] && ok "სატესტო პაციენტი" || die "პაციენტი"

step "2. რეგისტრატორი + განრიგი"
E=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$COL\",\"note\":\"ანემია, სისხლი განავალში\"},{\"service_id\":\"$EGD\"}],\"external_referral\":\"დ. ტესტაძე\"}" | jq -r '.encounter_id // empty')
[ -n "$E" ] && ok "ვიზიტი გაიხსნა (2 პროცედურა)" || die "ვიზიტი"
INV=$(api GET "/invoices/encounter/$E" "$RC"); SH=$(echo "$INV" | jq -r .patient_share)
[ "$(echo "$INV" | jq -r '(.patient_share|tonumber) == 0')" = "true" ] || api POST "/encounters/$E/pay-initial" "$RC" -d "{\"amount\":$SH,\"method\":\"cash\"}" >/dev/null
IT=$(api GET "/encounters/$E/dx-orders" "$RC"); iid() { echo "$IT" | jq -r ".[]|select(.service_id==\"$1\")|.id"; }
IC=$(iid "$COL"); IG=$(iid "$EGD")
chk "დასაგეგმ სიაში (ენდოსკოპია)" "$(api GET "/radiology/board?date=$TOMORROW&section=endoscopy" "$RC" | jq "[.unscheduled[]|select(.encounter_id==\"$E\")]|length")" "2"
[ -n "$RAD" ] && chk "რადიოლოგიის აპარატზე — უარი (400)" "$(code PUT "/dx-orders/$IC/schedule" "$RC" -d "{\"device_id\":\"$RAD\",\"start\":\"$(at 10:00)\"}")" "400"
BUSY=$(api GET "/radiology/board?date=$TOMORROW&section=endoscopy" "$RC" | jq -r "[.booked[]|select(.device_id==\"$ROOM\" and (.status==\"scheduled\" or .status==\"arrived\"))|.scheduled_start[0:16]]|join(\" \")")
SLOT=""; for H in 09 10 11 12 13 14 15 16; do for M in 00 30; do T=$(date -u -d "$(at $H:$M)" +%FT%H:%M); case "$BUSY" in *"$T"*) ;; *) [ -z "$SLOT" ] && SLOT="$H:$M";; esac; done; done
chk "კოლონოსკოპია ჩაიწერა ხვალ $SLOT" "$(api PUT "/dx-orders/$IC/schedule" "$RC" -d "{\"device_id\":\"$ROOM\",\"start\":\"$(at $SLOT)\"}" | jq -r '.status // .message')" "scheduled"
chk "ჩაწერის ფურცელი (მომზადებით)" "$(code GET "/encounters/$E/imaging-slip" "$RC")" "200"

step "3. ენდოსკოპები და დეზინფექცია"
mkscope() { api POST /endo/scopes "$NS" -d "{\"name\":\"ტესტ-E2E $1\",\"scope_type\":\"$1\",\"serial_number\":\"E2E-$1-$S\"}" | jq -r '.id // empty'; }
SC=$(mkscope colonoscope); SG=$(mkscope gastroscope); CREATED_SCOPES+=("$SC" "$SG")
[ -n "$SC" ] && [ -n "$SG" ] && ok "2 ენდოსკოპი რეესტრში" || die "ენდოსკოპები"
chk "იგივე სერიული — უარი (409)" "$(code POST /endo/scopes "$NS" -d "{\"name\":\"დუბლიკატი\",\"scope_type\":\"colonoscope\",\"serial_number\":\"E2E-colonoscope-$S\"}")" "409"
st() { api GET /endo/scopes "$NS" | jq -r ".[]|select(.id==\"$1\")|.state"; }
chk "ახალი ენდოსკოპი — დეზინფექცია საჭიროა" "$(st "$SC")" "dirty"
chk "გაჟონვის ტესტის გარეშე 'წარმატებული' — უარი" "$(code POST "/endo/scopes/$SC/reprocess" "$NS" -d '{"method":"aer","leak_test":false,"result":"passed"}')" "400"
api POST "/endo/scopes/$SC/reprocess" "$NS" -d '{"method":"aer","machine":"AER-1 / ციკლი 101","disinfectant":"პერეთილმჟავა, სერია 7","leak_test":true,"result":"passed"}' >/dev/null
chk "დეზინფექციის შემდეგ — მზადაა" "$(st "$SC")" "ready"
api POST "/endo/scopes/$SG/reprocess" "$NS" -d '{"method":"manual","leak_test":true,"result":"failed","note":"ციკლი შეწყდა"}' >/dev/null
chk "ჩავარდნილი ციკლი — failed" "$(st "$SG")" "failed"

step "4. ექთანი: მიღება, ჩეკლისტი, სედაცია, პროცედურა"
chk "მოვიდა" "$(api POST "/dx-orders/$IC/arrive" "$NS" -d '{}' | jq -r '.status // .message')" "arrived"
chk "ოქმი შესრულებამდე — დაუშვებელია (409)" "$(code PUT "/dx-orders/$IC/report" "$EN" -d '{"impression":"x"}')" "409"
chk "ჩეკლისტის შუალედური შენახვა" "$(api PUT "/dx-orders/$IC/endo" "$NS" -d '{"consent_confirmed":true,"fasting_hours":10,"anticoagulants":"none","allergies_reviewed":true,"asa_class":2,"bowel_prep":"good"}' | jq -r '.asa_class // .message')" "2"
chk "იდენტიფიკაციის გარეშე — უარი" "$(code POST "/dx-orders/$IC/endo/complete" "$NS" -d '{}')" "400"
chk "არასრული (სედაცია, ენდოსკოპი, დრო) — INCOMPLETE" "$(api POST "/dx-orders/$IC/endo/complete" "$NS" -d '{"identity_confirmed":true}' | jq -r .code)" "INCOMPLETE"
chk "ზომიერი სედაცია პრეპარატის გარეშე — INCOMPLETE" "$(api POST "/dx-orders/$IC/endo/complete" "$NS" -d "{\"identity_confirmed\":true,\"sedation_type\":\"moderate\",\"scope_id\":\"$SC\",\"started_at\":\"$AGO\",\"ended_at\":\"$NOW\"}" | jq -r .code)" "INCOMPLETE"
chk "ჩავარდნილი დეზინფექციის ენდოსკოპი — SCOPE_NOT_READY" "$(api POST "/dx-orders/$IC/endo/complete" "$NS" -d "{\"identity_confirmed\":true,\"sedation_type\":\"moderate\",\"sedation_drugs\":[{\"drug\":\"პროპოფოლი\",\"dose\":120,\"unit\":\"მგ\"}],\"scope_id\":\"$SG\",\"started_at\":\"$AGO\",\"ended_at\":\"$NOW\"}" | jq -r .code)" "SCOPE_NOT_READY"
chk "პროცედურა დასრულდა (კოლონოსკოპი)" "$(api POST "/dx-orders/$IC/endo/complete" "$NS" -d "{\"identity_confirmed\":true,\"sedation_type\":\"moderate\",\"sedation_by\":\"დ. ანესთეზიოლოგი\",\"sedation_drugs\":[{\"drug\":\"პროპოფოლი\",\"dose\":120,\"unit\":\"მგ\",\"time\":\"10:05\"}],\"monitoring\":[{\"time\":\"10:05\",\"hr\":78,\"spo2\":97,\"sys\":125,\"dia\":80}],\"scope_id\":\"$SC\",\"started_at\":\"$AGO\",\"ended_at\":\"$NOW\",\"recovery_score\":9}" | jq -r '.status // .message')" "performed"
chk "გამოყენების შემდეგ ენდოსკოპი — დეზინფექცია საჭიროა" "$(st "$SC")" "dirty"
api POST "/dx-orders/$IG/arrive" "$NS" -d '{}' >/dev/null
chk "იგივე ენდოსკოპი დეზინფექციის გარეშე — SCOPE_NOT_READY" "$(api POST "/dx-orders/$IG/endo/complete" "$NS" -d "{\"identity_confirmed\":true,\"consent_confirmed\":true,\"allergies_reviewed\":true,\"asa_class\":2,\"anticoagulants\":\"none\",\"sedation_type\":\"topical\",\"scope_id\":\"$SC\",\"started_at\":\"$AGO\",\"ended_at\":\"$NOW\"}" | jq -r .code)" "SCOPE_NOT_READY"
api POST "/endo/scopes/$SG/reprocess" "$NS" -d '{"method":"aer","leak_test":true,"result":"passed"}' >/dev/null
chk "EGD — გასტროსკოპით (ხელახალი დეზინფექციის შემდეგ)" "$(api POST "/dx-orders/$IG/endo/complete" "$NS" -d "{\"identity_confirmed\":true,\"consent_confirmed\":true,\"allergies_reviewed\":true,\"asa_class\":2,\"anticoagulants\":\"none\",\"sedation_type\":\"topical\",\"scope_id\":\"$SG\",\"started_at\":\"$AGO\",\"ended_at\":\"$NOW\"}" | jq -r '.status // .message')" "performed"
chk "მიკვლევადობა: კოლონოსკოპის ისტორია (1 გამოყენება + 1 დეზინფექცია)" "$(api GET "/endo/scopes/$SC/history" "$NS" | jq -r '[.events[].kind]|sort|join(",")')" "reprocess,use"

step "5. ენდოსკოპისტი: სურათები, მანიპულაციები, ბიოფსია"
IMG=$(upl "/dx-orders/$IC/images" "$EN" -F "file=@$TMP/img.jpg;type=image/jpeg" -F source=capture -F caption="სიგმოიდური — პოლიპი" | jq -r '.id // empty')
[ -n "$IMG" ] && ok "კადრი ატვირთულია (capture)" || bad "სურათის ატვირთვა" "$(upl "/dx-orders/$IC/images" "$EN" -F "file=@$TMP/img.jpg" | jq -rc .message)"
chk "არა-სურათი — უარი (400)" "$(upl "/dx-orders/$IC/images" "$EN" -F "file=@$TMP/bad.txt" -o /dev/null -w '%{http_code}')" "400"
chk "სურათი ბლანკზე" "$(api PATCH "/dx-images/$IMG" "$EN" -d '{"in_report":true}' | jq -r '.in_report // .message')" "true"
chk "სურათის ნახვა (ექთანი)" "$(code GET "/dx-images/$IMG/file" "$NS")" "200"
api PUT "/dx-orders/$IC/endo" "$EN" -d '{"extent_reached":"ბრმა ნაწლავი (სეკუმი)","withdrawal_minutes":8,"bbps_score":7,"interventions":[{"type":"polypectomy","site":"სიგმოიდური, 25 სმ","details":"ცივი მარყუჟი, 8 მმ"},{"type":"biopsy","site":"აღმავალი კოლინჯი"}]}' >/dev/null
chk "ხელმოწერა ბიოფსიის ქილების გარეშე — უარი" "$(api POST "/dx-orders/$IC/report/sign" "$EN" -d '{"impression":"სიგმოიდური ნაწლავის პოლიპი, ამოკვეთილია."}' | jq -r '.message' | grep -c ქილ)" "1"
chk "გართულება აღწერის გარეშე — უარი" "$(code PUT "/dx-orders/$IC/endo" "$EN" -d '{"complications":"minor"}')" "400"
P=$(api PUT "/dx-orders/$IC/pathology" "$EN" -d '{"clinical_info":"ანემია, პოლიპი","specimens":[{"jar_no":1,"site":"სიგმოიდური, 25 სმ — პოლიპი","pieces":1,"description":"8 მმ"},{"jar_no":2,"site":"აღმავალი კოლინჯი","pieces":2}]}')
PR=$(echo "$P" | jq -r '.id // empty'); [ -n "$PR" ] && ok "მიმართვა $(echo "$P" | jq -r .request_no) — 2 ქილა" || bad "პათოლოგიის მიმართვა" "$(echo "$P" | jq -rc .message)"
chk "ქილის ნომრები მეორდება — უარი" "$(code PUT "/dx-orders/$IC/pathology" "$EN" -d '{"specimens":[{"jar_no":1,"site":"ა"},{"jar_no":1,"site":"ბ"}]}')" "400"
chk "ოქმის ხელმოწერა" "$(api POST "/dx-orders/$IC/report/sign" "$EN" -d '{"findings":"სიგმოიდურში 25 სმ-ზე 8 მმ პოლიპი (Paris 0-Is), ამოკვეთილია ცივი მარყუჟით.","impression":"სიგმოიდური ნაწლავის პოლიპი — პოლიპექტომია. ბიოფსია აღმავალი კოლინჯიდან.","recommendation":"ჰისტოლოგიური პასუხის შემდეგ — გასტროენტეროლოგის კონსულტაცია."}' | jq -r '.status // .message')" "validated"
chk "ოქმის ბლანკი (PDF, სურათით)" "$(code GET "/dx-orders/$IC/report.pdf" "$RC")" "200"
chk "ხელმოწერის შემდეგ სურათის დამატება — 409" "$(upl "/dx-orders/$IC/images" "$EN" -F "file=@$TMP/img.jpg" -o /dev/null -w '%{http_code}')" "409"

step "6. პათოლოგია (გარე ლაბორატორია)"
chk "ეტიკეტები (PDF)" "$(code GET "/pathology/$PR/labels" "$NS")" "200"
chk "მიმართვის ფორმა (PDF)" "$(code GET "/pathology/$PR/requisition" "$NS")" "200"
chk "ლაბორატორიის გარეშე გაგზავნა — უარი" "$(code POST "/pathology/$PR/send" "$NS" -d '{}')" "400"
chk "გაიგზავნა" "$(api POST "/pathology/$PR/send" "$NS" -d '{"external_lab":"ტესტ-პათოლოგია"}' | jq -r '.status // .message')" "sent"
chk "გაგზავნილის შეცვლა — 409" "$(code PUT "/dx-orders/$IC/pathology" "$EN" -d '{"clinical_info":"x"}')" "409"
chk "„პასუხს ელოდება“ სიაში" "$(api GET "/pathology?tab=sent" "$RC" | jq "[.[]|select(.id==\"$PR\")]|length")" "1"
chk "ცარიელი პასუხი — უარი" "$(upl "/pathology/$PR/result" "$RC" -o /dev/null -w '%{http_code}')" "400"
chk "პასუხი: ტექსტი + სკანი (რეგისტრატორი)" "$(upl "/pathology/$PR/result" "$RC" -F "file=@$TMP/scan.pdf;type=application/pdf" -F "result_text=1: ტუბულური ადენომა, დაბალი ხარისხის დისპლაზია, კიდეები სუფთა. 2: ქრონიკული არასპეციფიკური კოლიტი." | jq -r '.status // .message')" "resulted"
chk "სკანის ნახვა" "$(code GET "/pathology/$PR/file" "$RC")" "200"
chk "გასაცნობ სიაში" "$(api GET "/pathology?tab=resulted&unreviewed=true" "$EN" | jq "[.[]|select(.id==\"$PR\")]|length")" "1"
chk "ექთანს „გაცნობა“ არ შეუძლია (403)" "$(code POST "/pathology/$PR/review" "$NS")" "403"
chk "ენდოსკოპისტი გაეცნო" "$(api POST "/pathology/$PR/review" "$EN" | jq -r 'if .reviewed_at then "ok" else .message end')" "ok"
chk "ვიზიტის ხედში: ჰისტოლოგიის პასუხი" "$(api GET "/encounters/$E/dx-orders" "$RC" | jq -r ".[]|select(.id==\"$IC\")|.path_status")" "resulted"
chk "ბლანკი ჰისტოლოგიით (PDF)" "$(code GET "/dx-orders/$IC/report.pdf" "$RC")" "200"

step "7. დასუფთავება"
api POST "/dx-orders/$IG/report/sign" "$EN" -d '{"impression":"ზედა კუჭ-ნაწლავის ტრაქტის პათოლოგია არ ვლინდება."}' >/dev/null
chk "ორივე ოქმის შემდეგ ვიზიტი დაიხურა" "$(api GET "/encounters?patient_id=$PAT" "$ADM" | jq -r "[.[]|select(.id==\"$E\")][0].status")" "discharged"
for X in "${CREATED_SCOPES[@]}"; do api PATCH "/endo/scopes/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for U in "${CREATED_USERS[@]}"; do api POST "/users/$U/disable" "$ADM" >/dev/null; done
ok "სატესტო მომხმარებლები და ენდოსკოპები გაითიშა"
printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
