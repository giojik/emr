#!/usr/bin/env bash
# =====================================================================
# e2e-lab-micro.sh — მიკრობიოლოგია (0027): ცნობარი (მიკროორგანიზმები, ანტიბიოტიკები, პანელები), კულტურა (სტადია, გრამი),
#   იზოლატები, ანტიბიოგრამა (MIC/ზონა → S/I/R ხელით), ექიმთან ჩვენება (მონიშნული; სარეზერვო — რეზისტენტობისას),
#   წინასწარი პასუხი → საბოლოო (ვალიდაცია), „ზრდა არ აღინიშნა“, PDF, უფლებები
# გამოყენება:  bash scripts/e2e-lab-micro.sh [API_URL]
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
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TRACK=$(mktemp)

step "1. მომზადება"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.mic.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "u $id" >> "$TRACK"
  local t; t=$(login "e2e.mic.$1.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
LD=$(mkuser lab_doctor 11); LM=$(mkuser lab_manager 12); LT=$(mkuser diagnostic 13); RC=$(mkuser receptionist 14); PH=$(mkuser phlebotomist 15); DR=$(mkuser doctor 16)
[ -n "$LD" ] && [ -n "$LT" ] && [ -n "$DR" ] && ok "6 სატესტო მომხმარებელი" || die "მომხმარებლები ვერ შეიქმნა"
REF=$(api GET /lab/micro/refs "$LT")
chk "ცნობარი: ≥ 40 მიკროორგანიზმი, ≥ 40 ანტიბიოტიკი, პანელები" "$(echo "$REF" | jq -r '(.organisms|length) >= 40 and (.antibiotics|length) >= 40 and (.panels|length) >= 5')" "true"
ECO=$(echo "$REF" | jq -r '.organisms[]|select(.code=="eco")|.id'); SAU=$(echo "$REF" | jq -r '.organisms[]|select(.code=="sau")|.id')
chk "მიკროორგანიზმის დამატება (ლაბ. მენეჯერი)" "$(api POST /lab/micro/organisms "$LM" -d "{\"code\":\"t$S\",\"name\":\"ტესტ-E2E ორგანიზმი $S\",\"gram\":\"neg\",\"group_code\":\"ENT\"}" | jq -r '.id != null')" "true"
chk "ლაბორანტს ცნობარის შეცვლა არ შეუძლია (403)" "$(code POST /lab/micro/organisms "$LT" -d '{"code":"zz1","name":"xx","gram":"neg","group_code":"ENT"}')" "403"
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"MIC_E2E_$S\",\"name\":\"ტესტ-E2E შარდის კულტურა $S\",\"group_name\":\"ტესტ-E2E მიკრობიოლოგია\",\"specimen_type\":\"urine\",\"container\":\"Sterile\"}" | jq -r '.id // empty'); echo "s $SVC" >> "$TRACK"
chk "კატალოგი: ანალიზი — მიკრობიოლოგიური (კომპონენტების გარეშე)" "$(api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_micro":true}' | jq -r .is_micro)" "true"
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"7$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მიკრო\",\"birth_date\":\"1965-03-03\",\"gender\":\"female\",\"phone_number\":\"590$S\"}" | jq -r '.id // empty')
item() {
  local e sh bc; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$SVC\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  bc=$(api POST "/encounters/$e/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  echo "$e $(api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty')"
}
read -r E1 I1 <<< "$(item)"
[ -n "$I1" ] && ok "ვიზიტი → აღება → მიღება (კომპონენტების გარეშე შეკვეთა დასაშვებია)" || die "შეკვეთა ვერ შეიქმნა"

step "2. დღე 1: დათესვა, გრამი → წინასწარი"
chk "სტადია — ინკუბაცია, გრამის შეღებვა" "$(api PUT "/lab/micro/items/$I1/culture" "$LT" -d '{"stage":"incubating","gram_stain":"გრამ-უარყოფითი ჩხირები"}' | jq -r .culture.stage)" "incubating"
chk "ექიმი ჯერ ვერაფერს ხედავს" "$(api GET "/lab/micro/items/$I1/view" "$DR" | jq -r .kind)" "none"
chk "ლაბორანტს წინასწარის გაცემა არ შეუძლია (403)" "$(code POST "/lab/micro/items/$I1/prelim" "$LT")" "403"
api POST "/lab/micro/items/$I1/prelim" "$LD" >/dev/null
V=$(api GET "/lab/micro/items/$I1/view" "$DR")
chk "ექიმი: წინასწარი — გრამ-უარყოფითი ჩხირები" "$(echo "$V" | jq -r '"\(.kind):\(.report.gram_stain)"')" "prelim:გრამ-უარყოფითი ჩხირები"
chk "ინკუბაციისას „მზადაა“ — 400" "$(code POST "/lab/micro/items/$I1/complete" "$LT")" "400"

step "3. დღე 2: ზრდა, იდენტიფიკაცია; დღე 3: ანტიბიოგრამა"
api PUT "/lab/micro/items/$I1/culture" "$LT" -d '{"stage":"growth","growth_summary":"მონოკულტურა"}' >/dev/null
chk "ზრდისას მიკროორგანიზმის გარეშე „მზადაა“ — 400" "$(code POST "/lab/micro/items/$I1/complete" "$LT")" "400"
D=$(api POST "/lab/micro/items/$I1/isolates" "$LT" -d "{\"organism_id\":\"$ECO\",\"quantity\":\"10^5 CFU/mL\"}")
ISO=$(echo "$D" | jq -r '.isolates[0].id'); NAB=$(echo "$D" | jq -r '.isolates[0].ast|length')
chk "E. coli 10^5 → პანელი ავტომატურად (ენტერობაქტერიები): ≥ 10 ანტიბიოტიკი" "$(jq -n --arg n "$NAB" '($n|tonumber) >= 10')" "true"
AST=$(echo "$D" | jq -c '.isolates[0].ast')
AMP=$(echo "$AST" | jq -r '.[]|select(.code=="AMP")|.antibiotic_id'); CIP=$(echo "$AST" | jq -r '.[]|select(.code=="CIP")|.antibiotic_id')
MEM=$(echo "$AST" | jq -r '.[]|select(.code=="MEM")|.antibiotic_id'); CRO=$(echo "$AST" | jq -r '.[]|select(.code=="CRO")|.antibiotic_id')
chk "მეროპენემი — სარეზერვო (ექიმთან ნაგულისხმევად არ ჩანს)" "$(echo "$AST" | jq -r '.[]|select(.code=="MEM")|"\(.reserve):\(.reported)"')" "true:false"
api POST "/lab/micro/items/$I1/prelim" "$LD" >/dev/null
chk "წინასწარი (დღე 2): ექიმი ხედავს E. coli-ს" "$(api GET "/lab/micro/items/$I1/view" "$DR" | jq -r '.report.isolates[0].organism_code')" "eco"
chk "ანტიბიოგრამა: AMP R, CIP S (MIC 0.25), CRO S (ზონა 26), MEM S" "$(api PUT "/lab/micro/isolates/$ISO/ast" "$LT" -d "{\"rows\":[{\"antibiotic_id\":\"$AMP\",\"interp\":\"R\",\"mic\":\">32\"},{\"antibiotic_id\":\"$CIP\",\"interp\":\"S\",\"mic\":\"0.25\"},{\"antibiotic_id\":\"$CRO\",\"interp\":\"S\",\"zone_mm\":26},{\"antibiotic_id\":\"$MEM\",\"interp\":\"S\"}]}" | jq -r '[.isolates[0].ast[]|select(.interp!=null)]|length')" "4"
chk "არასწორი შეფასება (X) — 400" "$(code PUT "/lab/micro/isolates/$ISO/ast" "$LT" -d "{\"rows\":[{\"antibiotic_id\":\"$AMP\",\"interp\":\"X\"}]}")" "400"
chk "ლაბორანტი: „მზადაა“ → ვალიდაციას ელოდება" "$(api POST "/lab/micro/items/$I1/complete" "$LT" | jq -r .status)" "resulted"
chk "ლაბორანტს საბოლოოს გაცემა არ შეუძლია (403)" "$(code POST "/lab/micro/items/$I1/final" "$LT")" "403"
chk "ლაბ. ექიმი: საბოლოო (ვალიდაცია)" "$(api POST "/lab/micro/items/$I1/final" "$LD" | jq -r .status)" "validated"
V=$(api GET "/lab/micro/items/$I1/view" "$DR")
chk "ექიმი: საბოლოო პასუხი" "$(echo "$V" | jq -r .kind)" "final"
chk "ექიმთან: შეფასებული ანტიბიოტიკები (AMP, CIP, CRO + სარეზერვო MEM)" "$(echo "$V" | jq -r '[.report.isolates[0].ast[].code]|sort|join(",")')" "AMP,CIP,CRO,MEM"
chk "სარეზერვო ჩანს, რადგან პირველი რიგის (AMP) რეზისტენტობაა" "$(echo "$V" | jq -r '[.report.isolates[0].ast[].code]|index("MEM") != null')" "true"
chk "დადასტურებულის შეცვლა — 409" "$(code PUT "/lab/micro/items/$I1/culture" "$LT" -d '{"comment":"x"}')" "409"
chk "PDF პასუხი" "$(curl -s "$B/lab/micro/items/$I1/report.pdf" -H "authorization: Bearer $DR" | head -c 5)" "%PDF-"

step "4. ზრდა არ აღინიშნა; სარეზერვო რეზისტენტობის გარეშე"
read -r E2 I2 <<< "$(item)"
api PUT "/lab/micro/items/$I2/culture" "$LT" -d '{"stage":"no_growth","comment":"48 სთ"}' >/dev/null
api POST "/lab/micro/items/$I2/complete" "$LT" >/dev/null
chk "„ზრდა არ აღინიშნა“ → საბოლოო" "$(api POST "/lab/micro/items/$I2/final" "$LD" >/dev/null; api GET "/lab/micro/items/$I2/view" "$DR" | jq -r '"\(.kind):\(.report.stage)"')" "final:no_growth"
read -r E3 I3 <<< "$(item)"
api PUT "/lab/micro/items/$I3/culture" "$LT" -d '{"stage":"growth"}' >/dev/null
D=$(api POST "/lab/micro/items/$I3/isolates" "$LT" -d "{\"organism_id\":\"$ECO\",\"quantity\":\"10^5 CFU/mL\"}"); ISO3=$(echo "$D" | jq -r '.isolates[0].id')
A3=$(echo "$D" | jq -c '.isolates[0].ast'); MEM3=$(echo "$A3" | jq -r '.[]|select(.code=="MEM")|.antibiotic_id'); AMP3=$(echo "$A3" | jq -r '.[]|select(.code=="AMP")|.antibiotic_id')
api PUT "/lab/micro/isolates/$ISO3/ast" "$LT" -d "{\"rows\":[{\"antibiotic_id\":\"$AMP3\",\"interp\":\"S\"},{\"antibiotic_id\":\"$MEM3\",\"interp\":\"S\"}]}" >/dev/null
api POST "/lab/micro/items/$I3/complete" "$LT" >/dev/null; api POST "/lab/micro/items/$I3/final" "$LD" >/dev/null
chk "რეზისტენტობის გარეშე სარეზერვო (MEM) ექიმთან არ ჩანს" "$(api GET "/lab/micro/items/$I3/view" "$DR" | jq -r '[.report.isolates[0].ast[].code]|join(",")')" "AMP"
chk "რეგისტრატორს მიმდინარე (ლაბ.) ხედი დახურული (403)" "$(code GET "/lab/micro/items/$I3" "$RC")" "403"

step "გასუფთავება"
for X in $(awk '/^s /{print $2}' "$TRACK"); do api PATCH "/dx/catalog/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
TORG=$(api GET /lab/micro/refs "$LT" | jq -r ".organisms[]|select(.code==\"t$S\")|.id"); [ -n "$TORG" ] && api PATCH "/lab/micro/organisms/$TORG" "$LM" -d '{"is_active":false}' >/dev/null
for X in $(awk '/^u /{print $2}' "$TRACK"); do api POST "/users/$X/disable" "$ADM" >/dev/null; done
rm -f "$TRACK"; ok "სატესტო მონაცემები გათიშულია"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
