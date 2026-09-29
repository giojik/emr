#!/usr/bin/env bash
# =====================================================================
# e2e-lab-mail-imap.sh — გარე ლაბორატორიის ელ-ფოსტა რეალური ყუთით: წერილი → IMAP ყუთი → emr-worker → მიბმა
#   სცენარები: A ჩვენი ფორმატი · B ტექსტური PDF, პ/ნ-ით · C სკანი (OCR), პ/ნ-ით · D მხოლოდ სახელი (ხელით) · E უცნობი გამგზავნი
# წერილები ყუთში იდება პირდაპირ (IMAP APPEND, SMTP-ის გარეშე), სატესტო გამგზავნით — არავის არაფერი ეგზავნება.
# საჭიროა: IMAP კონფიგურირებული (.env), emr-worker გაშვებული. ხანგრძლივობა: ≈ LAB_MAIL_POLL_SECONDS + 1 წთ.
# გამოყენება:  bash scripts/e2e-lab-mail-imap.sh [API_URL]
#   სხვა გარემოში: INJ="node dist/cli/lab-mail-inject.js"
# =====================================================================
set -uo pipefail
B="${1:-http://localhost/api}"
J='content-type: application/json'
DC="docker compose -f /opt/emr/docker-compose.dev.yml -f /opt/emr/docker-compose.app.yml"
INJ="${INJ:-$DC exec -T emr-worker node dist/cli/lab-mail-inject.js}"
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
S=$(date +%s | tail -c 7); TRACK=$(mktemp)
FROM="lab.$S@e2e-sender.test"; OTHER="stranger.$S@e2e-sender.test"
PN="0$(printf '%010d' "$S")"; FIRST="ტესტ-E2E"; LAST="იმაპი"; DOB_ISO="1990-01-01"; DOB="01.01.1990"

step "0. გარემო"
ST=$(api GET /lab/external/mail/state "$ADM")
[ "$(echo "$ST" | jq -r .configured)" = "true" ] || die "IMAP არ არის კონფიგურირებული (.env: IMAP_HOST, IMAP_USER, IMAP_PASS) — ჯერ ის"
POLL=$(echo "$ST" | jq -r '.poll_seconds // 120'); ok "ყუთი: $(echo "$ST" | jq -r .mailbox), შემოწმება ყოველ $POLL წმ"
[ "$(echo "$ST" | jq -r .ok)" = "true" ] && ok "ბოლო შემოწმება — OK" || bad "IMAP-ის ბოლო შემოწმება" "$(echo "$ST" | jq -r .error)"

step "1. მომზადება"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.imap.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.imap.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
LM=$(mkuser lab_manager 31); RC=$(mkuser receptionist 32); PH=$(mkuser phlebotomist 33); LT=$(mkuser diagnostic 34)
[ -n "$LM" ] && [ -n "$RC" ] && [ -n "$PH" ] && [ -n "$LT" ] && ok "4 სატესტო მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
LAB=$(api POST /lab/external-labs "$LM" -d "{\"name\":\"ტესტ-E2E IMAP $S\",\"emails\":[\"$FROM\"]}" | jq -r '.id // empty'); echo "l $LAB" >> "$TRACK"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"EIMAP_$S\",\"name\":\"ტესტ-E2E ვიტამინი D $S\",\"group_name\":\"ტესტ-E2E\",\"specimen_type\":\"serum\",\"container\":\"Serum gel\",\"performed_by\":\"external\"}" | jq -r '.id // empty')
echo "s $SVC" >> "$TRACK"; api PATCH "/dx/catalog/$SVC" "$ADM" -d "{\"external_lab_id\":\"$LAB\",\"purchase_price\":10}" >/dev/null
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"$PN\",\"first_name\":\"$FIRST\",\"last_name\":\"$LAST\",\"birth_date\":\"$DOB_ISO\",\"gender\":\"female\",\"phone_number\":\"593$S\"}" | jq -r '.id // empty')
PAT2=$(api POST /patients "$RC" -d "{\"personal_number\":\"9$(printf '%010d' "$S")\",\"first_name\":\"$FIRST\",\"last_name\":\"მეორე\",\"birth_date\":\"1985-05-05\",\"gender\":\"male\",\"phone_number\":\"592$S\"}" | jq -r '.id // empty')
[ -n "$LAB" ] && [ -n "$SVC" ] && [ -n "$PAT" ] && [ -n "$PAT2" ] && ok "ლაბორატორია (გამგზავნი $FROM), გარე ანალიზი, 2 პაციენტი (პ/ნ $PN)" || die "მომზადება ვერ მოხერხდა"
# ვიზიტი → აღება → გაგზავნა; აბრუნებს „item_id barcode“
send_one() { # $1 — პაციენტი (ნაგულისხმევი: PAT)
  local P=${1:-$PAT} e sh ids; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$P\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' >/dev/null
  ids=$(api GET /lab/external/to-send "$LT" | jq -c "[.[]|select(.patient_id==\"$P\")|.id]")
  api POST /lab/external/shipments "$LT" -d "{\"lab_id\":\"$LAB\",\"item_ids\":$ids}" >/dev/null
  api GET "/lab/external/waiting?lab_id=$LAB" "$LT" | jq -r "[.[]|select(.id==($ids|.[0]))][0]|\"\(.id) \(.barcode)\""
}
# პ/ნ-ით მიბმა პაციენტის ყველა მომლოდინე ანალიზს ფარავს — ამიტომ C და D-სთვის ანალიზი იგზავნება უშუალოდ წინ; E — მეორე პაციენტი
read -r IA BA <<< "$(send_one)"; read -r IB BB <<< "$(send_one)"; read -r IE BE <<< "$(send_one "$PAT2")"
[ -n "$IA" ] && [ -n "$IB" ] && [ -n "$IE" ] && ok "3 ანალიზი გაგზავნილია და პასუხს ელოდება ($BA, $BB, $BE)" || die "გაგზავნა ვერ მოხერხდა"

step "2. წერილები ყუთში (IMAP APPEND)"
inj() { local r; r=$($INJ "$@" 2>&1 | tail -1); [ "$(echo "$r" | jq -r .ok 2>/dev/null)" = "true" ] && echo ok || echo "$r"; }
chk "A: „EMR $BA“ + $BA.pdf" "$(inj --from "$FROM" --subject "EMR $BA [$S]" --filename "$BA.pdf" --kind text --patient "$FIRST $LAST" --pn "$PN" --dob "$DOB")" "ok"
chk "B: „Test Results/კვლევის შედეგები - …“ + ტექსტური PDF (პ/ნ)" "$(inj --from "$FROM" --subject "Test Results/კვლევის შედეგები - $FIRST $LAST [$S]" --filename "$FIRST $LAST.pdf" --kind text --patient "$FIRST $LAST" --pn "$PN" --dob "$DOB")" "ok"
chk "E: უცნობი გამგზავნი, „EMR $BE“" "$(inj --from "$OTHER" --subject "EMR $BE [$S]" --filename "$BE.pdf" --kind text --patient "$FIRST $LAST" --pn "$PN" --dob "$DOB")" "ok"

wait_mail() { # $1 — რამდენი წერილი უნდა იყოს [$S]-ით
  local n=0 t=0 max=$((POLL + 90)); printf '      ელოდება worker-ს (≤ %s წმ)' "$max"
  while [ $t -lt $max ]; do n=$(api GET /lab/external/mail "$LT" | jq -r "[.[]|select(.subject|contains(\"[$S]\"))]|length"); [ "$n" -ge "$1" ] && break; printf '.'; sleep 10; t=$((t+10)); done; echo
  [ "$n" -ge "$1" ] && ok "worker-მა დაამუშავა $n წერილი" || bad "worker-მა წერილები დროულად ვერ დაამუშავა" "$n / $1 — docker logs emr-worker | grep LabMail"
}
wait_mail 3
M=$(api GET /lab/external/mail "$LT")
f() { echo "$M" | jq -r "[.[]|select(.subject|contains(\"$1\"))][0]|$2"; }
step "3. შედეგები (A, B, E)"
chk "A → მიება „ფაილის სახელით“" "$(f "EMR $BA" '"\(.status):\(.files[0].method)"')" "matched:filename"
chk "B → მიება „პირადი №-ით“ (PDF-ის ტექსტი)" "$(f "Test Results/" '"\(.status):\(.files[0].method)"')" "matched:personal_number"
chk "E → უცნობი გამგზავნი, არ მიება" "$(f "EMR $BE" '"\(.status):\(.files[0].status)"')" "rejected:unmatched"
chk "E-ს ანალიზი — ისევ პასუხს ელოდება" "$(api GET "/lab/items/$IE" "$LT" | jq -r '.ext_result_at == null')" "true"
chk "A-ს ანალიზი → ვალიდაციას ელოდება, PDF-ით" "$(api GET "/lab/items/$IA" "$LT" | jq -r '"\(.status):\(.ext_result_at != null)"')" "resulted:true"

step "4. C სკანი (OCR) და D მხოლოდ სახელი"
read -r IC BC <<< "$(send_one)"
chk "C: „Order number …“ + სკანი (სურათი, ტექსტის გარეშე)" "$(inj --from "$FROM" --subject "Order number TL-$S date 28-09-2026 [$S]" --filename "scan_0001.pdf" --kind scan --patient "$FIRST $LAST" --pn "$PN" --dob "$DOB")" "ok"
wait_mail 4
M=$(api GET /lab/external/mail "$LT")
chk "C → მიება „პირადი №-ით“ (OCR)" "$(f "Order number TL-$S" '"\(.status):\(.files[0].method)"')" "matched:personal_number"
read -r ID BD <<< "$(send_one)"
chk "D: „Test Results - …“ + მხოლოდ სახელი" "$(inj --from "$FROM" --subject "Test Results - $FIRST $LAST [$S]" --filename "$FIRST $LAST.pdf" --kind name --patient "$FIRST $LAST")" "ok"
wait_mail 5
M=$(api GET /lab/external/mail "$LT")
chk "D → ავტომატურად არა, მინიშნებით („შესაძლოა …“)" "$(f "Test Results - " '"\(.status):\(.files[0].reason|startswith("შესაძლოა"))"')" "unmatched:true"
FD=$(f "Test Results - " '.files[0].id')
chk "D → ხელით მიბმა ($BD)" "$(api POST "/lab/external/mail/files/$FD/assign" "$LT" -d "{\"item_ids\":[\"$ID\"]}" | jq -r .status)" "attached"
chk "D-ს ანალიზი → ვალიდაციას ელოდება" "$(api GET "/lab/items/$ID" "$LT" | jq -r .status)" "resulted"
chk "IMAP: ბოლო შემოწმება OK" "$(api GET /lab/external/mail/state "$LT" | jq -r .ok)" "true"

step "გასუფთავება"
F2=$(echo "$M" | jq -r "[.[]|select(.subject|contains(\"EMR $BE\"))][0].files[0].id")
api POST "/lab/external/mail/files/$F2/dismiss" "$LT" -d '{"reason":"e2e: უცნობი გამგზავნი"}' >/dev/null
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^l /{print $2}' "$TRACK"); do api PATCH "/lab/external-labs/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -f "$TRACK"; ok "სატესტო მონაცემები გათიშულია (წერილები ყუთში — საქაღალდე EMR-Processed)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
