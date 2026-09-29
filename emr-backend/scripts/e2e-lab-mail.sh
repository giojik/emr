#!/usr/bin/env bash
# =====================================================================
# e2e-lab-mail.sh — გარე ლაბორატორიის პასუხები ელ-ფოსტით (0022), .eml ატვირთვით (იგივე დამუშავება, რაც IMAP-ით)
#   რეგისტრირებული გამგზავნი → შტრიხკოდით/კოდით ავტომატური მიბმა; დუბლიკატი; უცნობი გამგზავნი;
#   ამოუცნობი ფაილი → ხელით მიბმა / უარყოფა; მხოლოდ კონკრეტული ანალიზი (<შტრიხკოდი>_<კოდი>.pdf)
# გამოყენება:  bash scripts/e2e-lab-mail.sh [API_URL]
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
read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" "$@"; }
S=$(date +%s | tail -c 7); TRACK=$(mktemp); DIR=$(mktemp -d)
FROM="results.$S@partner-lab.test"
# .eml: გამგზავნი, თემა, Message-ID, მიმაგრებები (სახელი → PDF)
eml() { # $1 file, $2 from, $3 subject, $4 msgid, $5.. attachment names
  local f=$1 from=$2 subj=$3 mid=$4; shift 4
  local pdf; pdf=$(printf '%%PDF-1.4\n%% EMR e2e %s\n%%%%EOF\n' "$mid" | base64 -w0)
  { printf 'From: Partner Lab <%s>\r\nTo: lab-results@clinic.test\r\nSubject: %s\r\nMessage-ID: <%s@partner-lab.test>\r\nDate: %s\r\nMIME-Version: 1.0\r\n' "$from" "$subj" "$mid" "$(date -R)"
    printf 'Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' "${BODY:-შედეგი თან ერთვის.}"
    for n in "$@"; do pdf=$(printf '%%PDF-1.4\n%% EMR e2e %s %s\n%%%%EOF\n' "$S" "$n" | base64 -w0)   # თითო ფაილი — განსხვავებული შიგთავსი
      printf -- '--b1\r\nContent-Type: application/pdf; name="%s"\r\nContent-Disposition: attachment; filename="%s"\r\nContent-Transfer-Encoding: base64\r\n\r\n%s\r\n' "$n" "$n" "$pdf"; done
    printf -- '--b1--\r\n'; } > "$f"
}
up() { curl -s -X POST "$B/lab/external/mail/upload" -H "authorization: Bearer $1" -F "file=@$2;type=message/rfc822"; }

step "1. მომზადება"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.mail.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.mail.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
LM=$(mkuser lab_manager 41); RC=$(mkuser receptionist 42); PH=$(mkuser phlebotomist 43); LT=$(mkuser diagnostic 44)
[ -n "$LM" ] && [ -n "$RC" ] && [ -n "$PH" ] && [ -n "$LT" ] && ok "4 სატესტო მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
LAB=$(api POST /lab/external-labs "$LM" -d "{\"name\":\"ტესტ-E2E ფოსტა $S\",\"emails\":[\"${FROM^^}\"]}" | jq -r '.id // empty'); echo "l $LAB" >> "$TRACK"
chk "ლაბორატორია: ნებადართული გამგზავნი (მცირე ასოებით)" "$(api GET '/lab/external-labs?all=true' "$LM" | jq -r ".[]|select(.id==\"$LAB\")|.emails[0]")" "$FROM"
mksvc() { local id; id=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"$1_$S\",\"name\":\"ტესტ-E2E $2 $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\",\"performed_by\":\"external\"}" | jq -r '.id // empty')
  api PATCH "/dx/catalog/$id" "$ADM" -d "{\"external_lab_id\":\"$LAB\",\"purchase_price\":10}" >/dev/null; echo "s $id" >> "$TRACK"; echo "$id"; }
X1=$(mksvc EVITD "ვიტამინი D"); X2=$(mksvc EFERR "ფერიტინი"); [ -n "$X1" ] && [ -n "$X2" ] && ok "2 გარე ანალიზი (კოდები EVITD_$S, EFERR_$S)" || die "ანალიზები ვერ შეიქმნა"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"4$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ფოსტა\",\"birth_date\":\"1988-02-02\",\"gender\":\"male\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty')
visit() { local e sh; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":$1}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' >/dev/null; echo "$e"; }
ship() { local ids; ids=$(api GET /lab/external/to-send "$LT" | jq -c "[.[]|select(.patient_id==\"$PAT\")|.id]"); api POST /lab/external/shipments "$LT" -d "{\"lab_id\":\"$LAB\",\"item_ids\":$ids}" >/dev/null; }
E1=$(visit "[{\"service_id\":\"$X1\"},{\"service_id\":\"$X2\"}]"); ship
W=$(api GET "/lab/external/waiting?lab_id=$LAB" "$LT")
BC=$(echo "$W" | jq -r '.[0].barcode'); I1=$(echo "$W" | jq -r ".[]|select(.service_name|startswith(\"ტესტ-E2E ვიტამინი\"))|.id"); I2=$(echo "$W" | jq -r ".[]|select(.service_name|startswith(\"ტესტ-E2E ფერიტინი\"))|.id")
[ -n "$BC" ] && [ -n "$I1" ] && [ -n "$I2" ] && ok "სინჯარა $BC: 2 ანალიზი გაგზავნილია" || die "გაგზავნა ვერ მოხერხდა"

step "2. კონკრეტული ანალიზი: ${BC}_EFERR_$S.pdf"
eml "$DIR/1.eml" "$FROM" "EMR $BC" "m1-$S" "${BC}_EFERR_$S.pdf"
R=$(up "$LT" "$DIR/1.eml")
chk "წერილი: matched, ფაილი მიება 1 ანალიზს" "$(echo "$R" | jq -r '"\(.status):\(.files[0].status):\(.files[0].items)"')" "matched:attached:1"
chk "ფერიტინი → ვალიდაციას ელოდება" "$(api GET "/lab/items/$I2" "$LT" | jq -r '"\(.status):\(.ext_result_at != null)"')" "resulted:true"
chk "ვიტამინი D — ჯერ ელოდება" "$(api GET "/lab/items/$I1" "$LT" | jq -r '.ext_result_at == null')" "true"
chk "იგივე წერილი ხელახლა — დუბლიკატი" "$(up "$LT" "$DIR/1.eml" | jq -r .duplicate)" "true"

step "3. უცნობი გამგზავნი"
eml "$DIR/2.eml" "spam.$S@evil.test" "EMR $BC" "m2-$S" "${BC}.pdf"
R=$(up "$LT" "$DIR/2.eml")
chk "უარყოფილი; ფაილი ავტომატურად არ მიება" "$(echo "$R" | jq -r '"\(.status):\(.files[0].status)"')" "rejected:unmatched"
chk "ვიტამინი D — ისევ პასუხის გარეშე" "$(api GET "/lab/items/$I1" "$LT" | jq -r '.ext_result_at == null')" "true"
F2=$(api GET "/lab/external/mail?open=true" "$LT" | jq -r "[.[]|select(.from_addr==\"spam.$S@evil.test\")][0].files[0].id")
chk "უარყოფა მიზეზით" "$(api POST "/lab/external/mail/files/$F2/dismiss" "$LT" -d '{"reason":"უცნობი გამგზავნი — სპამი"}' | jq -r .status)" "dismissed"

step "4. ამოუცნობი ფაილი → ხელით მიბმა"
eml "$DIR/3.eml" "$FROM" "შედეგები" "m3-$S" "scan_0001.pdf"
R=$(up "$LT" "$DIR/3.eml")
chk "შტრიხკოდი ვერ ამოიცნო → მისაბმელი" "$(echo "$R" | jq -r '"\(.status):\(.files[0].status)"')" "unmatched:unmatched"
F3=$(api GET "/lab/external/mail?open=true" "$LT" | jq -r "[.[]|select(.subject==\"შედეგები\" and .from_addr==\"$FROM\")][0].files[0].id")
chk "ფაილის ნახვა (PDF)" "$(curl -s "$B/lab/external/mail/files/$F3" -H "authorization: Bearer $LT" | head -c 5)" "%PDF-"
chk "ხელით მიბმა ვიტამინ D-ზე" "$(api POST "/lab/external/mail/files/$F3/assign" "$LT" -d "{\"item_ids\":[\"$I1\"]}" | jq -r .status)" "attached"
chk "ვიტამინი D → ვალიდაციას ელოდება" "$(api GET "/lab/items/$I1" "$LT" | jq -r .status)" "resulted"
chk "უკვე პასუხიანზე ხელახლა მიბმა — 409" "$(code POST "/lab/external/mail/files/$F3/assign" "$LT" -H "$J" -d "{\"item_ids\":[\"$I1\"]}")" "409"

step "5. თემით ამოცნობა (ფაილის სახელში შტრიხკოდი არ არის)"
E2=$(visit "[{\"service_id\":\"$X1\"}]"); ship
W=$(api GET "/lab/external/waiting?lab_id=$LAB" "$LT"); BC2=$(echo "$W" | jq -r '.[0].barcode'); I3=$(echo "$W" | jq -r '.[0].id')
eml "$DIR/4.eml" "$FROM" "EMR $BC2" "m4-$S" "result.pdf"
chk "თემა „EMR $BC2“ + result.pdf → მიება" "$(up "$LT" "$DIR/4.eml" | jq -r '"\(.status):\(.files[0].barcode)"')" "matched:$BC2"
chk "სია: ღია ფაილები აღარ არის (ამ ლაბორატორიით)" "$(api GET "/lab/external/mail?open=true" "$LT" | jq -r "[.[]|select(.lab_id==\"$LAB\")]|length")" "0"
chk "IMAP-ის მდგომარეობა ჩანს" "$(api GET /lab/external/mail/state "$LT" | jq -r 'has("configured")')" "true"
chk "რეგისტრატორს ფოსტა დახურული (403)" "$(code GET /lab/external/mail "$RC")" "403"

step "6. ლაბორატორიის საკუთარი ფორმატი"
newbatch() { visit "[{\"service_id\":\"$X1\"}]" >/dev/null; ship; api GET "/lab/external/waiting?lab_id=$LAB" "$LT" | jq -r "[.[]|select(.patient_id==\"$PAT\")][0]|\"\(.id) \(.barcode)\""; }
read -r I4 BC4 <<< "$(newbatch)"
chk "შაბლონი (regex) შენახვა" "$(api PATCH "/lab/external-labs/$LAB" "$LM" -d '{"mail_id_regex":"Sample\\s*#?\\s*(\\d+)"}' | jq -r .mail_id_regex)" 'Sample\s*#?\s*(\d+)'
chk "არასწორი regex — 400" "$(code PATCH "/lab/external-labs/$LAB" "$LM" -H "$J" -d '{"mail_id_regex":"("}')" "400"
eml "$DIR/5.eml" "$FROM" "Results - Sample #$BC4" "m5-$S" "report_2026.pdf"
chk "შემოწმება (ცვლილების გარეშე): lab_pattern" "$(curl -s -X POST "$B/lab/external/mail/test" -H "authorization: Bearer $LT" -F "file=@$DIR/5.eml" | jq -r '.files[0].match.method')" "lab_pattern"
chk "შემოწმებამ არაფერი შეცვალა" "$(api GET "/lab/items/$I4" "$LT" | jq -r '.ext_result_at == null')" "true"
chk "„Sample #$BC4“ + report_2026.pdf → მიება (ლაბორატორიის შაბლონით)" "$(up "$LT" "$DIR/5.eml" | jq -r '"\(.status):\(.files[0].method)"')" "matched:lab_pattern"
PN=$(api GET "/patients/$PAT" "$LT" 2>/dev/null | jq -r '.personal_number // empty'); [ -n "$PN" ] || PN="4$(printf '%010d' "$S")"
read -r I5 BC5 <<< "$(newbatch)"
BODY="Laboratory report. Patient ID: $PN" eml "$DIR/6.eml" "$FROM" "Laboratory results" "m6-$S" "rep.pdf"
chk "ტექსტში პირადი № → მიება (personal_number)" "$(up "$LT" "$DIR/6.eml" | jq -r '"\(.status):\(.files[0].method)"')" "matched:personal_number"
read -r I6 BC6 <<< "$(newbatch)"
BODY="პაციენტი: ფოსტა ტესტ-E2E, დაბადების თარიღი 02.02.1988" eml "$DIR/7.eml" "$FROM" "პასუხი" "m7-$S" "rep.pdf"
chk "ტექსტში სახელი + გვარი + დაბ. თარიღი → მიება (name_dob)" "$(up "$LT" "$DIR/7.eml" | jq -r '"\(.status):\(.files[0].method)"')" "matched:name_dob"
read -r I7 BC7 <<< "$(newbatch)"
BODY="პაციენტი: ფოსტა ტესტ-E2E" eml "$DIR/8.eml" "$FROM" "პასუხი" "m8-$S" "rep.pdf"
R=$(up "$LT" "$DIR/8.eml")
chk "მხოლოდ სახელი (თარიღის გარეშე) → ავტომატურად არა, მინიშნებით" "$(echo "$R" | jq -r '"\(.status):\(.files[0].reason|startswith("შესაძლოა"))"')" "unmatched:true"
PAT2=$(api POST /patients "$RC" -d "{\"personal_number\":\"3$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მეორე\",\"birth_date\":\"1990-03-03\",\"gender\":\"female\",\"phone_number\":\"594$S\"}" | jq -r '.id // empty')
P1=$PAT; PAT=$PAT2; visit "[{\"service_id\":\"$X1\"}]" >/dev/null; ship; PAT=$P1
BODY="Patients: $PN, 3$(printf '%010d' "$S")" eml "$DIR/9.eml" "$FROM" "Batch results" "m9-$S" "batch.pdf"
chk "ორი პაციენტი ერთ ფაილში → ხელით (ambiguous)" "$(up "$LT" "$DIR/9.eml" | jq -r '"\(.status):\(.files[0].reason|startswith("ფაილში რამდენიმე"))"')" "unmatched:true"

step "7. OCR (სკანი / სურათი)"
OCRPNG="iVBORw0KGgoAAAANSUhEUgAAAvgAAABaAQAAAADlEh+CAAAEIklEQVR42u2YP4gdRRzHP7M35kY4eCtYXOPLRBtJoWcX8cwNIY1tQCuRK22ECBZXPHASg7zC4kiwP7CzutJCkjEGA1ZXKIiN8151nfuOJMyFvf1Z7L6Xu3jxrcQHFjvNMrvsZ37znd+/XSUsdGR0/I7f8Tt+x+/4Hb/jd/yO3/H/T/xDD8DDxdovK4vi6x2Ag5MPdvkNgJHnEWjEwC6HFgmMPNfgyD/6wM9dQESqnohIWJbj4wu5LyIi/qyMpESSEulJXJZyQ+iVnJW0EdmQOSMD1AOAH9Kp6/t9IiUuiReIjyk5IpUUALhW+t8G+PL07fU8jjSgSDyGHyP7cJb0eSLBzbnyaAALyOrJB1VzzdcFuH5O6fAp6B4RNi+/6A0HLH3Szn96QGWfMpwAUFlbrTFRjDMmnqHhJ5a8PcP6v/BPdYqUprnhqtKRUWjiGHL8sN6cZtyaL4w8lw4tY8QcWkYe8MA2kFPPFBrQ5PWLJXdb8yfsbJd3UgFUj/f32dluDmaLEpYhQoALCBCnb50htuSP8Ql/9QE5pcQSn6CWH6h/ICQajwxM9bmJbZl/LktvwMVvAkJK929LbwAZjJgdDoZGGFcbRJB+a/tXyV1yK33wE4ZvkjsghugMeKFAkwwFHktoHHdYZby2246/X9m+UYAJ6JzK9kEV7udYgIecEhLgiU3G4mHORX6/0oq/PMDlyZOjyTIMrpbiaxo3QoNhGolAYGWzvA7iW9n/UdmcZLYXgQG173AV8AYocQkPxDqfDyGkild3Qrv41QjkoLCA5thPJ58ATTB4wFYAksOeynjlw3b6mxJq/9uKWOrdrAc706fRn8ZjKoukgwqy2K5+eVA0WkZdX62Lz9K/dPB9zFrG75Grxd9mwjrYcpZAc8AroMQkciDigOSBexWoom39VVAo0LUECsibiD0lfidA/+irX6YxN4fvmvIqivLJ+QpXt0GjAItx9fnj6vAlK7eK6Zpz+IEBKrGrpLZ+gAKMn8zySzyRi7g3qz95O31ugMEJ6H49O1ZcC8DiEUDVvjUEsvPfvt42PydPUaseUEUz0+GdcCxflrPFkByI7195GWnDz2JBAE9hPDlMpqlZs0MWx0BP8n5lga3kZ6U0e1Kk/9n+YjTV6c5Q+KzJYRnw8akbKN/47gGXqdgubQu+mlzKQEOm7+bGv3spazz2mgU1ugEYbXvGAW+fA7j13tFLkPHWsFX/EzQxEohLWB3sCvFY2HsDaFyTf6bxUqxSEXyr/Ll2oSm3hJDtra41Mw8GNteAJeXPLAGsrky7i00yNpfmO9DTDeOJLvSPZ/aVf4qIyJ157aeop13s7sXFfr9suIXyj9o0Bc9j//n9hfKzXwf/Kf9v58u4v9jv096Cv3/NgvkvLFj/7v9Dx+/4Hb/jd/znH38B1dMS0dUgXQsAAAAASUVORK5CYII="
{ printf 'From: Partner Lab <%s>\r\nTo: lab-results@clinic.test\r\nSubject: scan\r\nMessage-ID: <ocr-%s@partner-lab.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n' "$FROM" "$S"
  printf -- '--b1\r\nContent-Type: image/png; name="scan.png"\r\nContent-Disposition: attachment; filename="scan.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n%s\r\n--b1--\r\n' "$OCRPNG"; } > "$DIR/ocr.eml"
O=$(curl -s -X POST "$B/lab/external/mail/test?lab_id=$LAB" -H "authorization: Bearer $LT" -F "file=@$DIR/ocr.eml")
chk "სურათიდან ტექსტი ამოიკითხა (OCR, პ/ნ 01001012345)" "$(echo "$O" | jq -r '"\(.files[0].ocr):\(.files[0].pdf_text|contains("01001012345"))"')" "true:true"

step "8. რამდენიმე ფაილი ერთ ანალიზზე"
read -r I8 BC8 <<< "$(newbatch)"
eml "$DIR/10.eml" "$FROM" "EMR $BC8" "m10-$S" "$BC8.pdf" "$BC8 (2).pdf"
chk "ერთ წერილში 2 PDF → ორივე მიება" "$(up "$LT" "$DIR/10.eml" | jq -r '[.files[].status]|join(",")')" "attached,attached"
chk "ანალიზს 2 ფაილი აქვს (ერთმანეთს არ გადააწერა)" "$(api GET "/lab/items/$I8/external-files" "$LT" | jq -r length)" "2"
eml "$DIR/11.eml" "$FROM" "EMR $BC8" "m11-$S" "$BC8.pdf" "$BC8 (2).pdf"
up "$LT" "$DIR/11.eml" >/dev/null
chk "იგივე ფაილები ხელახლა (სხვა წერილით) — დუბლიკატი არ ემატება" "$(api GET "/lab/items/$I8/external-files" "$LT" | jq -r length)" "2"
X3=$(mktemp --suffix=.pdf); printf '%%PDF-1.4\n%% manual %s\n%%%%EOF\n' "$S" > "$X3"
chk "ხელით მესამე ფაილი → ემატება" "$(curl -s -X POST "$B/lab/items/$I8/external-result" -H "authorization: Bearer $LT" -F "file=@$X3;filename=extra.pdf" >/dev/null; api GET "/lab/items/$I8/external-files" "$LT" | jq -r length)" "3"
chk "იგივე ფაილი ხელით მეორედ — 409" "$(code POST "/lab/items/$I8/external-result" "$LT" -F "file=@$X3")" "409"
XF=$(api GET "/lab/items/$I8/external-files" "$LT" | jq -r '.[]|select(.filename=="extra.pdf")|.id')
chk "ფაილის მოხსნა მიზეზით → 2" "$(api POST "/lab/items/$I8/external-files/$XF/remove" "$LT" -d '{"reason":"შეცდომით მიბმული"}' | jq -r length)" "2"
chk "ვალიდაციამდე რეგისტრატორი ფაილებს ვერ ხედავს (403)" "$(code GET "/lab/items/$I8/external-files" "$RC")" "403"
LD=$(mkuser lab_doctor 45)
chk "ლაბ. ექიმი ადასტურებს" "$(api POST "/lab/items/$I8/validate" "$LD" | jq -r .status)" "validated"
chk "დადასტურების შემდეგ — რეგისტრატორი ხედავს 2 ფაილს" "$(api GET "/lab/items/$I8/external-files" "$RC" | jq -r length)" "2"
F0=$(api GET "/lab/items/$I8/external-files" "$RC" | jq -r '.[0].id')
chk "ფაილის ნახვა (PDF)" "$(curl -s "$B/lab/items/$I8/external-files/$F0" -H "authorization: Bearer $RC" | head -c 5)" "%PDF-"
eml "$DIR/12.eml" "$FROM" "EMR $BC8" "m12-$S" "$BC8 (3).pdf"
chk "დადასტურებულზე ახალი ფაილი → ხელით, მიზეზით" "$(up "$LT" "$DIR/12.eml" | jq -r '"\(.files[0].status):\(.files[0].reason|contains("უკვე დადასტურებულია"))"')" "unmatched:true"
chk "დადასტურებულზე ფაილის მოხსნა — 409" "$(code POST "/lab/items/$I8/external-files/$F0/remove" "$LT" -H "$J" -d '{"reason":"ტესტი ტესტი"}')" "409"
rm -f "$X3"

step "გასუფთავება"
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^l /{print $2}' "$TRACK"); do api PATCH "/lab/external-labs/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -rf "$TRACK" "$DIR"; ok "სატესტო მონაცემები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
