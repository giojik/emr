#!/usr/bin/env bash
# =====================================================================
# e2e-lab-config.sh — ლაბორატორიის ნორმები, ანალიზატორები, ბლანკები (0018), API-ით
#   უფლებები (ხელმძღვანელი / ლაბ. ექიმი / მენეჯერი) → ანალიზატორი → ნორმების ვერსიები
#   (ორსულობა, ანალიზატორი, გადათვლა) → ბლანკის შაბლონი (ვერსია, მინიჭება, ნიმუში) → QR ვერიფიკაცია
# ქმნის ცალკე სატესტო ანალიზს (E2E_NORM_*) — რეალურ კატალოგს და ნორმებს არ ეხება.
# გამოყენება:  bash scripts/e2e-lab-config.sh [API_URL]     (ნაგულისხმევი: http://localhost/api)
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

read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7)
CREATED_USERS=(); TRACK=$(mktemp)   # mkuser ეშვება $(…)-ში (subshell) — ID-ები ფაილში

step "0. გარემო"
chk "API ხელმისაწვდომია" "$(curl -s "$B/health" | jq -r .status)" "ok"
VER=$(curl -s "$B/health" | jq -r .schemaVersion); if [ "$VER" \> "0017" ]; then ok "სქემის ვერსია $VER"; else bad "სქემის ვერსია" "საჭიროა ≥ 0018, არის $VER"; fi

step "1. მომხმარებლები"
mkuser() { # $1 role, $2 prefix-digits, $3 section_head(true/false)
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.$1.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\",\"is_section_head\":$3}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { bad "მომხმარებელი ($1)" "$(echo "$R" | jq -rc .message)"; return; }
  echo "$id" >> "$TRACK"
  local t; t=$(login "e2e.$1.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
HEAD=$(mkuser lab_doctor 81 true); LD=$(mkuser lab_doctor 82 false); LM=$(mkuser lab_manager 83 false)
RC=$(mkuser receptionist 84 false); PH=$(mkuser phlebotomist 85 false); LT=$(mkuser diagnostic 86 false)
[ -n "$HEAD" ] && [ -n "$LD" ] && [ -n "$LM" ] && [ -n "$RC" ] && [ -n "$PH" ] && [ -n "$LT" ] && ok "6 სატესტო მომხმარებელი (ხელმძღვანელი, ლაბ. ექიმი, მენეჯერი, რეგისტრატორი, ფლებოტომისტი, ლაბორანტი)" || die "მომხმარებლები ვერ შეიქმნა"
chk "ხელმძღვანელი: ნორმები + ბლანკები" "$(api GET /lab/config/permissions "$HEAD" | jq -r '"\(.norms),\(.blanks)"')" "true,true"
chk "ლაბ. ექიმი (არა ხელმძღვანელი): ნორმები/ბლანკები არა" "$(api GET /lab/config/permissions "$LD" | jq -r '"\(.norms),\(.blanks)"')" "false,false"
chk "მენეჯერი: ანალიზატორები კი, ნორმები არა" "$(api GET /lab/config/permissions "$LM" | jq -r '"\(.methods),\(.norms)"')" "true,false"

step "2. ანალიზატორები"
MNAME="E2E ანალიზატორი $S"
MID=$(api POST /lab/methods "$LM" -d "{\"name\":\"$MNAME\",\"kind\":\"analyzer\",\"manufacturer\":\"Test\"}" | jq -r '.id // empty')
[ -n "$MID" ] && ok "მენეჯერმა დაამატა ანალიზატორი" || bad "ანალიზატორის დამატება" "ვერ შეიქმნა"
chk "იგივე სახელი — 409" "$(code POST /lab/methods "$LM" -d "{\"name\":\"$MNAME\"}")" "409"
chk "ლაბორანტს არ შეუძლია (403)" "$(code POST /lab/methods "$LT" -d '{"name":"x-'$S'"}')" "403"

step "3. სატესტო ანალიზი (მენეჯერი)"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"LAB_E2E_NORM_$S\",\"name\":\"ტესტ-E2E გლუკოზა $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\"}" | jq -r '.id // empty')
[ -n "$SVC" ] || die "სატესტო ანალიზი ვერ შეიქმნა"
R=$(api POST "/dx/catalog/$SVC/analytes" "$LM" -d '{"code":"GLU","name":"გლუკოზა","unit":"mmol/L","result_type":"numeric","decimals":1,"critical_low":2.5,"critical_high":25,"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.9,"high":6.1}]}')
AN=$(echo "$R" | jq -r '.analytes[0].id // empty'); [ -n "$AN" ] && ok "კომპონენტი საწყისი ნორმით (3.9–6.1)" || die "კომპონენტი: $(echo "$R" | jq -rc .message)"
chk "ისტორია: ვერსია 1 „ახალი კომპონენტი“" "$(api GET "/lab/analytes/$AN/norm-history" "$LD" | jq -r '.versions[0]|"\(.version):\(.reason)"')" "1:ახალი კომპონენტი"
chk "მენეჯერს არსებული კომპონენტის ნორმის შეცვლა არ შეუძლია (403)" "$(code PUT "/lab/analytes/$AN/norms" "$LM" -d '{"ranges":[],"reason":"ტესტი ტესტი"}')" "403"
chk "ლაბ. ექიმს (არა ხელმძღვანელს) — 403" "$(code PUT "/lab/analytes/$AN/norms" "$LD" -d '{"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3,"high":6}],"reason":"ტესტი ტესტი"}')" "403"
NEWR="[{\"sex\":null,\"age_min_days\":0,\"age_max_days\":54750,\"low\":3.9,\"high\":6.1},{\"sex\":\"female\",\"age_min_days\":0,\"age_max_days\":54750,\"pregnancy\":\"P\",\"low\":3.3,\"high\":5.1},{\"sex\":null,\"age_min_days\":0,\"age_max_days\":54750,\"method_id\":\"$MID\",\"low\":4.0,\"high\":5.9}]"
chk "მიზეზის გარეშე — 400" "$(code PUT "/lab/analytes/$AN/norms" "$HEAD" -d "{\"ranges\":$NEWR}")" "400"
chk "გადაფარული ასაკები — 400" "$(code PUT "/lab/analytes/$AN/norms" "$HEAD" -d '{"ranges":[{"sex":null,"age_min_days":0,"age_max_days":6570,"low":3,"high":5},{"sex":null,"age_min_days":6000,"age_max_days":54750,"low":3.9,"high":6.1}],"reason":"გადაფარვის ტესტი"}')" "400"
chk "ორსულობა მამრობით სქესზე — 400" "$(code PUT "/lab/analytes/$AN/norms" "$HEAD" -d '{"ranges":[{"sex":"male","age_min_days":0,"age_max_days":54750,"pregnancy":"T1","low":3,"high":5}],"reason":"არასწორი ტესტი"}')" "400"
chk "ცვლილების გარეშე — 400" "$(code PUT "/lab/analytes/$AN/norms" "$HEAD" -d '{"ranges":[{"sex":null,"age_min_days":0,"age_max_days":54750,"low":3.9,"high":6.1}],"critical_low":2.5,"critical_high":25,"reason":"იგივე ნორმები"}')" "400"
R=$(api PUT "/lab/analytes/$AN/norms" "$HEAD" -d "{\"ranges\":$NEWR,\"critical_low\":2.5,\"critical_high\":25,\"reason\":\"E2E: ორსულთა და ანალიზატორის ნორმა\"}")
chk "ხელმძღვანელმა შეცვალა → ვერსია 2" "$(echo "$R" | jq -r '.version // .message')" "2"
chk "ნორმების სიაში: 3 ნორმა, ვერსია 2" "$(api GET "/lab/norms?search=LAB_E2E_NORM_$S" "$LT" | jq -r "[.[]|select(.id==\"$AN\")][0]|\"\(.ranges|length):\(.norm_version)\"")" "3:2"

step "4. ნაკადი: ორსული პაციენტი → ნორმის შერჩევა"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"8$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ნორმები\",\"birth_date\":\"1994-03-10\",\"gender\":\"female\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] || die "პაციენტი ვერ შეიქმნა"
E=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty'); [ -n "$E" ] || die "ლაბ. ვიზიტი ვერ გაიხსნა"
SHARE=$(api GET "/invoices/encounter/$E" "$RC" | jq -r .patient_share)
if [ "$(echo "$SHARE > 0" | bc 2>/dev/null || echo 0)" = "1" ]; then api POST "/encounters/$E/pay-initial" "$RC" -d "{\"amount\":$SHARE,\"method\":\"cash\"}" >/dev/null; fi
chk "ორსულობის არასწორი ვადა (99 კვ.) — 400" "$(code POST "/encounters/$E/dx-collect" "$PH" -d '{"identity_confirmed":true,"pregnancy_weeks":99}')" "400"
SP=$(api POST "/encounters/$E/dx-collect" "$PH" -d '{"identity_confirmed":true,"pregnancy_weeks":10}')
BC=$(echo "$SP" | jq -r '.[0].barcode // empty'); [ -n "$BC" ] && ok "აღება ორსულობით (10 კვირა)" || die "აღება: $(echo "$SP" | jq -rc .message)"
api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC\"}" >/dev/null
IT=$(api GET "/lab/worklist?search=$BC" "$LT" | jq -r '.[0].id // empty'); [ -n "$IT" ] || die "სამუშაო სიაში ვერ მოიძებნა"
I=$(api GET "/lab/items/$IT" "$LT")
chk "ფორმაში: ორსულის ნორმა (3.3–5.1, P)" "$(echo "$I" | jq -r '.analytes[0].range|"\(.low|tonumber)-\(.high|tonumber):\(.pregnancy)"')" "3.3-5.1:P"
chk "5.5 → მაღალი (H)" "$(api PUT "/lab/items/$IT/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AN\",\"value\":\"5.5\"}]}" >/dev/null; api GET "/lab/items/$IT" "$LT" | jq -r '.results[0]|"\(.flag):\(.ref_high|tonumber)"')" "H:5.1"
chk "ორსულობის მოხსნა → ზოგადი ნორმა, N (მნიშვნელობის გადაცემის გარეშე)" "$(api PUT "/lab/items/$IT/results" "$LT" -d '{"values":[],"pregnancy_weeks":null}' >/dev/null; api GET "/lab/items/$IT" "$LT" | jq -r '.results[0]|"\(.flag):\(.ref_high|tonumber)"')" "N:6.1"
chk "ანალიზატორის არჩევა → მისი ნორმა (4.0–5.9)" "$(api PUT "/lab/items/$IT/results" "$LT" -d "{\"values\":[],\"lab_method_id\":\"$MID\"}" >/dev/null; api GET "/lab/items/$IT" "$LT" | jq -r '.results[0]|"\(.flag):\(.ref_low|tonumber)-\(.ref_high|tonumber)"')" "N:4-5.9"

step "5. ნორმის ცვლილება → დაუმტკიცებელი შედეგის გადათვლა"
NEWR2="[{\"sex\":null,\"age_min_days\":0,\"age_max_days\":54750,\"low\":3.9,\"high\":6.1},{\"sex\":\"female\",\"age_min_days\":0,\"age_max_days\":54750,\"pregnancy\":\"P\",\"low\":3.3,\"high\":5.1},{\"sex\":null,\"age_min_days\":0,\"age_max_days\":54750,\"method_id\":\"$MID\",\"low\":4.0,\"high\":5.3}]"
R=$(api PUT "/lab/analytes/$AN/norms" "$HEAD" -d "{\"ranges\":$NEWR2,\"critical_low\":2.5,\"critical_high\":25,\"reason\":\"E2E: ანალიზატორის ზედა ზღვარი 5.3\"}")
chk "ვერსია 3, გადაითვალა ≥ 1 შედეგი" "$(echo "$R" | jq -r '"\(.version):\(.recalculated >= 1)"')" "3:true"
I=$(api GET "/lab/items/$IT" "$LT")
chk "შედეგი ახლა მაღალია (H, 5.3)" "$(echo "$I" | jq -r '.results[0]|"\(.flag):\(.ref_high|tonumber)"')" "H:5.3"
chk "ფორმაში ჩანს „ნორმა შეიცვალა“" "$(echo "$I" | jq -r '.norm_recalculated_at != null')" "true"
chk "ვალიდაცია" "$(api POST "/lab/items/$IT/validate" "$HEAD" | jq -r .status)" "validated"
I=$(api GET "/lab/items/$IT" "$HEAD")
BV=$(echo "$I" | jq -r '.blank_version_id // empty'); TOK=$(echo "$I" | jq -r '.verify_token // empty')
[ -n "$BV" ] && [ -n "$TOK" ] && ok "ვალიდაციისას დაფიქსირდა ბლანკის ვერსია და QR ტოკენი" || bad "ბლანკის ვერსია / ტოკენი" "$BV / $TOK"
R=$(api PUT "/lab/analytes/$AN/norms" "$HEAD" -d "{\"ranges\":$NEWR,\"critical_low\":2.5,\"critical_high\":25,\"reason\":\"E2E: დაბრუნება 5.9-ზე\"}")
chk "ვალიდირებულს ნორმის ცვლილება არ ეხება (გადაითვალა 0)" "$(echo "$R" | jq -r .recalculated)" "0"
chk "ვალიდირებული შედეგი უცვლელია (H, 5.3)" "$(api GET "/lab/items/$IT" "$HEAD" | jq -r '.results[0]|"\(.flag):\(.ref_high|tonumber)"')" "H:5.3"
chk "ისტორია: 4 ვერსია, ბოლოს — მიზეზით" "$(api GET "/lab/analytes/$AN/norm-history" "$LT" | jq -r '"\(.versions|length):\(.versions[0].reason)"')" "4:E2E: დაბრუნება 5.9-ზე"
chk "ერთეულის შეცვლა შედეგების შემდეგ — 409" "$(code POST "/dx/catalog/$SVC/analytes" "$LM" -d "{\"id\":\"$AN\",\"code\":\"GLU\",\"name\":\"გლუკოზა\",\"unit\":\"mg/dL\",\"result_type\":\"numeric\"}")" "409"
chk "ბლანკის PDF" "$(curl -s "$B/encounters/$E/lab-report?item=$IT" -H "authorization: Bearer $LD" | head -c 5)" "%PDF-"

step "6. QR ვერიფიკაცია (საჯარო)"
chk "ტოკენით — ნამდვილია, ჩანს კვლევა" "$(curl -s "$B/public/lab-verify/$TOK" | jq -r '"\(.valid):\(.tests|length)"')" "true:1"
chk "HTML ბრაუზერისთვის" "$(curl -s -H 'accept: text/html' "$B/public/lab-verify/$TOK" | grep -c 'ნამდვილია')" "1"
chk "უცნობი ტოკენი — არანამდვილი" "$(curl -s "$B/public/lab-verify/00000000-0000-4000-8000-000000000000" | jq -r .valid)" "false"

step "7. ბლანკები"
chk "ლაბ. ექიმს (არა ხელმძღვანელს) შექმნა არ შეუძლია (403)" "$(code POST /lab/blanks "$LD" -d '{"name":"ტესტ-E2E აკრძალული"}')" "403"
DEF=$(api GET /lab/blanks "$LT" | jq -r '[.[]|select(.is_default)][0].id // empty'); [ -n "$DEF" ] && ok "ნაგულისხმევი შაბლონი არსებობს" || bad "ნაგულისხმევი შაბლონი" "არ არის"
BLK=$(api POST /lab/blanks "$HEAD" -d "{\"name\":\"ტესტ-E2E ბლანკი $S\",\"copy_from\":\"$DEF\"}" | jq -r '.id // empty'); [ -n "$BLK" ] && ok "ახალი შაბლონი (ასლი)" || die "შაბლონი ვერ შეიქმნა"
ST=$(api GET "/lab/blanks/$BLK" "$HEAD" | jq -c '.settings|.layout="two_column"|.columns=["unit","reference","flag","previous"]|.footer.show_qr=true|.header.title="ტესტ-E2E"')
chk "პარამეტრების შენახვა → ვერსია 2" "$(api PUT "/lab/blanks/$BLK" "$HEAD" -d "{\"settings\":$ST}" | jq -r .current_version)" "2"
chk "იგივე პარამეტრები → ახალი ვერსია არ იქმნება" "$(api PUT "/lab/blanks/$BLK" "$HEAD" -d "{\"settings\":$ST}" | jq -r .current_version)" "2"
chk "ვერსია 1 ინახება (layout: table)" "$(api GET "/lab/blanks/$BLK/versions/1" "$LT" | jq -r .layout)" "table"
chk "უცნობი სურათი — 400" "$(code PUT "/lab/blanks/$BLK" "$HEAD" -d "{\"settings\":$(echo "$ST" | jq -c '.header.logo_image_id="00000000-0000-4000-8000-000000000000"')}")" "400"
chk "ნიმუში (PDF)" "$(curl -s -X POST "$B/lab/blanks/preview" -H "authorization: Bearer $LM" -H "$J" -d "{\"settings\":$ST}" | head -c 5)" "%PDF-"
chk "მინიჭება ანალიზზე" "$(api PUT "/lab/blanks/$BLK/assignments" "$HEAD" -d "{\"groups\":[],\"service_ids\":[\"$SVC\"]}" | jq -r '.services|length')" "1"
chk "ნაგულისხმევის გათიშვა — 409" "$(code PUT "/lab/blanks/$DEF" "$HEAD" -d '{"is_active":false}')" "409"
# მეორე შეკვეთა — ახალი შაბლონით უნდა დადასტურდეს; პირველი რჩება ძველ ვერსიაზე
E2=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
SHARE=$(api GET "/invoices/encounter/$E2" "$RC" | jq -r .patient_share)
if [ "$(echo "$SHARE > 0" | bc 2>/dev/null || echo 0)" = "1" ]; then api POST "/encounters/$E2/pay-initial" "$RC" -d "{\"amount\":$SHARE,\"method\":\"cash\"}" >/dev/null; fi
BC2=$(api POST "/encounters/$E2/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC2\"}" >/dev/null
IT2=$(api GET "/lab/worklist?search=$BC2" "$LT" | jq -r '.[0].id // empty')
api PUT "/lab/items/$IT2/results" "$LT" -d "{\"values\":[{\"analyte_id\":\"$AN\",\"value\":\"4.4\"}]}" >/dev/null
api POST "/lab/items/$IT2/validate" "$HEAD" >/dev/null
chk "ახალი შეკვეთა — ახალი შაბლონის ვერსია 2 (გამოყენებულია 1-ჯერ)" "$(api GET "/lab/blanks/$BLK" "$HEAD" | jq -r '.versions[]|select(.version==2)|.used')" "1"
chk "ძველი შეკვეთა რჩება ძველ ვერსიაზე" "$(api GET "/lab/items/$IT" "$HEAD" | jq -r ".blank_version_id == \"$BV\"")" "true"
chk "ბლანკი (ახალი შაბლონი, წინა შედეგით)" "$(curl -s "$B/encounters/$E2/lab-report" -H "authorization: Bearer $LD" | head -c 5)" "%PDF-"
chk "შესწორება → QR ძველი ტოკენი აღარ მოქმედებს" "$(api POST "/lab/items/$IT/reopen" "$HEAD" -d '{"reason":"E2E შესწორების ტესტი"}' >/dev/null; curl -s "$B/public/lab-verify/$TOK" | jq -r .valid)" "false"
chk "აუდიტში: ნორმის ცვლილება მიზეზით" "$(api GET "/audit-logs?action=CHANGE_LAB_NORMS&entity_id=$AN" "$ADM" | jq -r '.[0].new_data.reason')" "E2E: დაბრუნება 5.9-ზე"

step "გასუფთავება"
api PUT "/lab/blanks/$BLK/assignments" "$HEAD" -d '{"groups":[],"service_ids":[]}' >/dev/null
chk "სატესტო შაბლონი გაითიშა" "$(api PUT "/lab/blanks/$BLK" "$HEAD" -d '{"is_active":false}' | jq -r .is_active)" "false"
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_active":false}' >/dev/null
api PATCH "/lab/methods/$MID" "$LM" -d '{"is_active":false}' >/dev/null
for U in $(cat "$TRACK"); do api POST "/users/$U/disable" "$ADM" >/dev/null; done
ok "სატესტო ანალიზი, ანალიზატორი და მომხმარებლები გათიშულია (ისტორია რჩება — სახელი: ტესტ-E2E)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
