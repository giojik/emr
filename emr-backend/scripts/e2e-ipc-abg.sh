#!/usr/bin/env bash
# =====================================================================
# e2e-ipc-abg.sh — ინფექციის კონტროლი, ეტაპი 5 (0071): ანტიბიოგრამა (CLSI M39) და IPC მასალები
#   პარამეტრები (dedup / min_n / გამორიცხული ანალიზები / მასალების წყარო), საბოლოო პასუხი → იზოლატები, პირველი იზოლატი,
#   %S, n < min_n, ფილტრები (სერვისი, განყოფილება, სტაციონარი / ამბულატორია, გრამი), MDRO წილი, ხედვის არე (infection_dept),
#   გამოქვეყნება (snapshot) / გაუქმება, ექიმის ხედვა, ექსპორტი xlsx / PDF;
#   მასალები: ჯგუფი + საქონელი (კოეფიციენტი), გაცემა / დაბრუნება / ჩამოწერა განყოფილების ლოკაციაზე → ლ / 1000 პაციენტ-დღე
#   bash scripts/e2e-ipc-abg.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-ipc-abg.sh
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
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r 'if type=="object" then (.code // .error.code // (if (.message|type)=="object" then .message.code else null end) // empty) else empty end'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F); D1Y=$(date -d "$TODAY +1 year" +%F)
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.abg.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ABG-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.abg.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
uid() { cat "$TMP/u$1"; }
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_abg_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_abg_$1_$S"; }
ipcset() { api PUT /modules/ipc "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }

step "0. პარამეტრები"
O_IPC=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')
echo "$O_IPC" | jq -e '.settings.abg_dedup != null' >/dev/null || die "0071 არ არის დაყენებული (ანტიბიოგრამის პარამეტრები აკლია)"
chk "ნაგულისხმევი: პირველი იზოლატი, n ≥ 30, გამორიცხული — არა, მასალები — გაცემით" \
  "$(echo "$O_IPC" | jq -r '.settings|"\(.abg_dedup):\(.abg_min_n):\(.abg_exclude_services|length):\(.material_source)"')" "first_patient:30:0:issue"
chk "ვალიდაცია: dedup x / min_n 0 / უცნობი ანალიზი / წყარო x → 400" \
  "$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abg_dedup":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abg_min_n":0},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"abg_exclude_services":["00000000-0000-4000-8000-000000000000"]},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"material_source":"x"},"reason":"ტესტ-E2E"}')" \
  "400:400:400:400"
ipcset '{"abg_dedup":"first_patient","abg_min_n":30,"abg_exclude_services":[],"material_source":"issue","mdro_flag_mode":"auto"}'

step "1. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ABG თერაპია $S\",\"code\":\"E2EGA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E ABG ქირურგია $S\",\"code\":\"E2EGB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
R_IPC=$(mkrole ipc "ინფექციის კონტროლი" '["infection"]'); R_IPD=$(mkrole ipd "IPC განყ." '["infection_dept"]')
R_SK=$(mkrole sk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole sm "საწყობის მენეჯერი" '["stock_manager"]')
[ -n "$R_IPC" ] && [ -n "$R_IPD" ] && [ -n "$R_SK" ] && [ -n "$R_SM" ] || die "როლები ვერ შეიქმნა"
IC=$(mkuser "[\"$R_IPC\"]" 61); ID=$(mkuser "[\"$R_IPD\"]" 62 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 63 ",\"department_id\":\"$DA\""); DRID=$(uid 63); NA=$(mkuser '["nurse"]' 64 ",\"department_id\":\"$DA\"")
RC=$(mkuser '["receptionist"]' 65); LT=$(mkuser '["diagnostic"]' 66); LD=$(mkuser '["lab_doctor"]' 67); PHB=$(mkuser '["phlebotomist"]' 68); LM=$(mkuser '["lab_manager"]' 69)
SK=$(mkuser "[\"$R_SK\"]" 70); SM=$(mkuser "[\"$R_SM\"]" 71)
[ -n "$IC" ] && [ -n "$ID" ] && [ -n "$DR" ] && [ -n "$NA" ] && [ -n "$RC" ] && [ -n "$LT" ] && [ -n "$LD" ] && [ -n "$PHB" ] && [ -n "$LM" ] && [ -n "$SK" ] && [ -n "$SM" ] \
  && ok "11 მომხმარებელი (IPC, IPC განყ. A, ექიმი / ექთანი A, რეგისტრატორი, ლაბ. ×4, საწყობი ×2)" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ABG-$2\",\"birth_date\":\"1970-02-02\",\"gender\":\"$3\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 51 "ერთი" male); P2=$(mkpat 52 "ორი" female); P3=$(mkpat 53 "სამი" male); P4=$(mkpat 54 "ოთხი" female)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$P3" ] && [ -n "$P4" ] && ok "4 პაციენტი" || die "პაციენტები ვერ შეიქმნა"
ADMIT() { api POST /inpatient/admissions "$DR" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"A41.9\"}" | jq -r '.encounter_id // empty'; }
E3=$(ADMIT "$P3"); E4=$(ADMIT "$P4")
[ -n "$E3" ] && [ -n "$E4" ] && ok "P3, P4 — სტაციონარი (განყოფილება A)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
REF=$(api GET /lab/micro/refs "$LT")
ORG() { echo "$REF" | jq -r --arg c "$1" '.organisms[]|select(.code==$c)|.id'; }
ECO=$(ORG eco); KPN=$(ORG kpn); SAU=$(ORG sau)
SVC=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"MIC_ABG_$S\",\"name\":\"ტესტ-E2E ABG კულტურა $S\",\"group_name\":\"ტესტ-E2E მიკრობიოლოგია\",\"specimen_type\":\"urine\",\"container\":\"Sterile\"}" | jq -r '.id // empty')
api PATCH "/dx/catalog/$SVC" "$ADM" -d '{"is_micro":true}' >/dev/null
SVC2=$(api POST /dx/catalog "$LM" -d "{\"section\":\"lab\",\"code\":\"MIC_ABS_$S\",\"name\":\"ტესტ-E2E ABG სკრინინგი $S\",\"group_name\":\"ტესტ-E2E მიკრობიოლოგია\",\"specimen_type\":\"swab\",\"container\":\"Swab\"}" | jq -r '.id // empty')
api PATCH "/dx/catalog/$SVC2" "$ADM" -d '{"is_micro":true}' >/dev/null
[ -n "$SVC" ] && [ -n "$SVC2" ] && ok "მიკრობიოლოგიური ანალიზები: კულტურა, სკრინინგი" || die "ანალიზი ვერ შეიქმნა"
labitem() {   # <patient> <service>
  local e sh bc; e=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$1\",\"items\":[{\"service_id\":\"$2\"}]}" | jq -r '.encounter_id // empty')
  sh=$(api GET "/invoices/encounter/$e" "$RC" | jq -r .patient_share)
  if [ "$(jq -n --arg s "$sh" '($s|tonumber) > 0')" = "true" ]; then api POST "/encounters/$e/pay-initial" "$RC" -d "{\"amount\":$sh,\"method\":\"cash\"}" >/dev/null; fi
  bc=$(api POST "/encounters/$e/dx-collect" "$PHB" -d '{"identity_confirmed":true}' | jq -r '.[0].barcode // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty'
}
ipditem() {
  api POST "/encounters/$1/dx-orders" "$DR" -d "{\"items\":[{\"service_id\":\"$SVC\"}]}" >/dev/null
  local bc; bc=$(api POST "/encounters/$1/dx-collect" "$NA" -d '{"identity_confirmed":true}' | jq -r '[.[]?|.barcode][0] // empty')
  api POST /lab/receive "$LT" -d "{\"barcode\":\"$bc\"}" >/dev/null
  api GET "/lab/worklist?search=$bc" "$LT" | jq -r '.[0].id // empty'
}
grow() {   # <item> <organism> <R კოდები> [მარკერები]
  local it=$1 org=$2 rs=$3 mk=${4:-[]} D iso rows
  api PUT "/lab/micro/items/$it/culture" "$LT" -d '{"stage":"growth"}' >/dev/null
  D=$(api POST "/lab/micro/items/$it/isolates" "$LT" -d "{\"organism_id\":\"$org\",\"quantity\":\"10^5\"}"); iso=$(echo "$D" | jq -r '.isolates[-1].id')
  rows=$(echo "$D" | jq -c --arg rs "$rs" '[.isolates[-1].ast[]|. as $a|{antibiotic_id, interp: (if (($rs|split(",")) | index($a.code)) != null then "R" else "S" end)}]')
  api PUT "/lab/micro/isolates/$iso/ast" "$LT" -d "{\"rows\":$rows}" >/dev/null
  [ "$mk" != "[]" ] && api PATCH "/lab/micro/isolates/$iso" "$LT" -d "{\"markers\":$mk}" >/dev/null
  echo "$iso"
}
fin() { api POST "/lab/micro/items/$1/complete" "$LT" >/dev/null; api POST "/lab/micro/items/$1/final" "$LD" | jq -r .status; }

step "2. კულტურები (საბოლოო პასუხი)"
I1=$(labitem "$P1" "$SVC"); grow "$I1" "$ECO" "AMP" '["esbl"]' >/dev/null
I1B=$(labitem "$P1" "$SVC"); grow "$I1B" "$ECO" "" >/dev/null
I2=$(labitem "$P2" "$SVC"); grow "$I2" "$ECO" "" >/dev/null
I3=$(ipditem "$E3"); grow "$I3" "$KPN" "MEM" >/dev/null
I4=$(ipditem "$E4"); grow "$I4" "$SAU" "OXA" >/dev/null
I5=$(labitem "$P2" "$SVC2"); grow "$I5" "$KPN" "MEM" >/dev/null
[ -n "$I1" ] && [ -n "$I1B" ] && [ -n "$I2" ] && [ -n "$I3" ] && [ -n "$I4" ] && [ -n "$I5" ] && ok "6 კულტურა: E. coli ×3 (P1 ×2: ESBL + AMP R, P2), K. pneumoniae (MEM R, სტაციონარი), S. aureus (OXA R, სტაციონარი), სკრინინგი" \
  || die "კულტურები ვერ შეიქმნა"
Q="from=$TODAY&to=$TODAY&service_id=$SVC"
chk "საბოლოო პასუხამდე — 0 იზოლატი" "$(api GET "/ipc/abg/current?$Q" "$IC" | jq -r .isolates)" "0"
F=""; for i in $I1 $I1B $I2 $I3 $I4 $I5; do F="$F$(fin "$i"),"; done
chk "საბოლოო პასუხი ×6 (ვალიდირებული)" "$F" "validated,validated,validated,validated,validated,validated,"

step "3. ანტიბიოგრამა (მიმდინარე)"
A=$(api GET "/ipc/abg/current?$Q" "$IC")
chk "იზოლატები: 5 → 4 (P1-ის მეორე E. coli — დუბლიკატი), პაციენტები 4, პირველი იზოლატი" "$(echo "$A" | jq -r '"\(.isolates_raw):\(.isolates):\(.patients):\(.dedup)"')" "5:4:4:first_patient"
chk "სექციები: გრამ-უარყოფითი (E. coli 2, K. pneumoniae 1), გრამ-დადებითი (S. aureus 1)" \
  "$(echo "$A" | jq -r '[.sections[]|"\(.gram)=\([.rows[]|"\(.code):\(.n)"]|join("+"))"]|join(" ")')" "neg=eco:2+kpn:1 pos=sau:1"
chk "E. coli — AMP %S = 50 (S 1, R 1); MEM %S = 100; K. pneumoniae — MEM 0" \
  "$(echo "$A" | jq -r '.sections[0] as $s|($s.antibiotics|map(.code)|index("AMP")) as $a|($s.antibiotics|map(.code)|index("MEM")) as $m|"\($s.rows[0].cells[$a]|"\(.pct):\(.s):\(.r)"):\($s.rows[0].cells[$m].pct):\($s.rows[1].cells[$m].pct)"')" "50:1:1:100:0"
chk "n < 30 → ყველა „არასანდო“; label — მთელი კლინიკა · ანალიზი" "$(echo "$A" | jq -r '"\([.sections[].rows[].low]|all):\(.label|startswith("მთელი კლინიკა"))"')" "true:true"
chk "MDRO: MRSA 1/1 = 100; ESBL 1/3; CRE 1/3; VRE — მნიშვნელი 0" \
  "$(echo "$A" | jq -r '[.mdro[]|select(.code=="mrsa" or .code=="esbl" or .code=="cre" or .code=="vre")|"\(.code)=\(.n)/\(.denominator)"]|join(" ")')" "mrsa=1/1 vre=0/0 esbl=1/3 cre=1/3"
chk "ფილტრები: სტაციონარი 2 · ამბულატორია 2 · განყოფილება A 2 · გრამ-დადებითი 1 · ICU-ს გარეშე 4" \
  "$(for x in "setting=inpatient" "setting=outpatient" "department_id=$DA" "gram=pos" "care=non_icu"; do api GET "/ipc/abg/current?$Q&$x" "$IC" | jq -r .isolates; done | tr '\n' ' ')" "2 2 2 1 4 "
ipcset '{"abg_dedup":"all","abg_min_n":2}'
A2=$(api GET "/ipc/abg/current?$Q" "$IC")
chk "dedup = all → 5 იზოლატი (E. coli 3); min_n 2 → E. coli სანდო, K. pneumoniae — არა" "$(echo "$A2" | jq -r '"\(.isolates):\(.sections[0].rows[0].n):\(.sections[0].rows[0].low):\(.sections[0].rows[1].low)"')" "5:3:false:true"
ipcset '{"abg_dedup":"first_patient","abg_min_n":30}'
chk "სკრინინგის ანალიზი: ჩანს (2 სერვისი, P2-ის K. pneumoniae) → გამორიცხვის შემდეგ — 0" \
  "$(api GET "/ipc/abg/current?from=$TODAY&to=$TODAY&service_id=$SVC2" "$IC" | jq -r .isolates):$(ipcset "{\"abg_exclude_services\":[\"$SVC2\"]}"; api GET "/ipc/abg/current?from=$TODAY&to=$TODAY&service_id=$SVC2" "$IC" | jq -r '"\(.isolates):\(.excluded_services|map(select(contains("სკრინინგი")))|length)"')" "1:0:1"
chk "meta: განყოფილებები, მიკრობიოლოგიური ანალიზები (ორივე), გამორიცხული" \
  "$(api GET /ipc/abg/meta "$IC" | jq -r --arg a "$SVC" --arg b "$SVC2" '"\([.services[].id]|(index($a)!=null and index($b)!=null)):\(.exclude_services==[$b])"')" "true:true"
chk "ვალიდაცია: პერიოდის გარეშე / from > to / care x → 400" \
  "$(code GET /ipc/abg/current "$IC"):$(code GET "/ipc/abg/current?from=$TODAY&to=2020-01-01" "$IC"):$(code GET "/ipc/abg/current?from=$TODAY&to=$TODAY&care=x" "$IC")" "400:400:400"
chk "IPC განყ. A: თავისი არე — 2 (სტაციონარი A); განყოფილება B — 403; ექიმი — 403" \
  "$(api GET "/ipc/abg/current?$Q" "$ID" | jq -r .isolates):$(code GET "/ipc/abg/current?$Q&department_id=$DB" "$ID"):$(code GET "/ipc/abg/current?$Q" "$DR")" "2:403:403"

step "4. გამოქვეყნება"
chk "IPC განყ. — 403; სათაურის გარეშე — 400; მონაცემის გარეშე — 409 NO_DATA" \
  "$(code POST /ipc/abg/publish "$ID" -d "{\"title\":\"x x x\",\"from\":\"$TODAY\",\"to\":\"$TODAY\"}"):$(code POST /ipc/abg/publish "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}"):$(ecode POST /ipc/abg/publish "$IC" -d "{\"title\":\"ტესტ-E2E ცარიელი\",\"from\":\"$TODAY\",\"to\":\"$TODAY\",\"service_id\":\"$SVC2\"}")" "403:400:NO_DATA"
PB=$(api POST /ipc/abg/publish "$IC" -d "{\"title\":\"ტესტ-E2E ანტიბიოგრამა $S\",\"from\":\"$TODAY\",\"to\":\"$TODAY\",\"service_id\":\"$SVC\",\"note\":\"ტესტ-E2E: ემპირიული — ცეფტრიაქსონი\"}")
PID=$(echo "$PB" | jq -r '.id // empty')
chk "IPC აქვეყნებს → 4 იზოლატი" "$(echo "$PB" | jq -r .isolates)" "4"
chk "ექიმი: სიაში ჩანს; ვერსია = snapshot (4, E. coli AMP 50, შენიშვნა)" \
  "$(api GET /ipc/abg/published "$DR" | jq -r --arg i "$PID" '[.[]|select(.id==$i)]|length'):$(api GET "/ipc/abg/published/$PID" "$DR" | jq -r '.data as $d|($d.sections[0].antibiotics|map(.code)|index("AMP")) as $a|"\($d.isolates):\($d.sections[0].rows[0].cells[$a].pct):\(.note|contains("ცეფტრიაქსონი"))"')" "1:4:50:true"
I6=$(labitem "$P4" "$SVC"); grow "$I6" "$KPN" "" >/dev/null; fin "$I6" >/dev/null
chk "ახალი იზოლატი: მიმდინარე — 5; გამოქვეყნებული — უცვლელი (4)" \
  "$(api GET "/ipc/abg/current?$Q" "$IC" | jq -r .isolates):$(api GET "/ipc/abg/published/$PID" "$DR" | jq -r .data.isolates)" "5:4"
curl -s -o "$TMP/a.xlsx" "$B/ipc/abg/export?id=$PID&format=xlsx" -H "authorization: Bearer $DR"
curl -s -o "$TMP/a.pdf" "$B/ipc/abg/export?id=$PID&format=pdf" -H "authorization: Bearer $DR"
curl -s -o "$TMP/c.pdf" "$B/ipc/abg/export?$Q&format=pdf" -H "authorization: Bearer $IC"
chk "ექსპორტი (ექიმი): xlsx (PK), PDF; IPC — მიმდინარე PDF; ექიმი მიმდინარეს — 403; ფორმატი x — 400" \
  "$(head -c 2 "$TMP/a.xlsx"):$(head -c 5 "$TMP/a.pdf"):$(head -c 5 "$TMP/c.pdf"):$(code GET "/ipc/abg/export?$Q&format=xlsx" "$DR"):$(code GET "/ipc/abg/export?id=$PID&format=x" "$DR")" "PK:%PDF-:%PDF-:403:400"
chk "გაუქმება: ექიმი → 403; მიზეზის გარეშე → 400; IPC → ✓; მეორედ → 409" \
  "$(code POST "/ipc/abg/published/$PID/withdraw" "$DR" -d '{"reason":"x x x"}'):$(code POST "/ipc/abg/published/$PID/withdraw" "$IC" -d '{}'):$(api POST "/ipc/abg/published/$PID/withdraw" "$IC" -d '{"reason":"ტესტ-E2E: ტესტი"}' | jq -r .ok):$(code POST "/ipc/abg/published/$PID/withdraw" "$IC" -d '{"reason":"ტესტ-E2E: კიდევ"}')" \
  "403:400:true:409"
chk "გაუქმებული: ექიმი — სიაში არ არის, ვერსია 404; IPC (all=1) — ჩანს, withdrawn" \
  "$(api GET /ipc/abg/published "$DR" | jq -r --arg i "$PID" '[.[]|select(.id==$i)]|length'):$(code GET "/ipc/abg/published/$PID" "$DR"):$(api GET '/ipc/abg/published?all=1' "$IC" | jq -r --arg i "$PID" '[.[]|select(.id==$i)][0].status')" "0:404:withdrawn"

step "5. მასალები"
G0=$(api GET /ipc/materials/groups "$IC")
chk "ჯგუფი „ხელის ალკოჰოლიანი ანტისეპტიკი“ (ლ / 1000, სამიზნე 20)" "$(echo "$G0" | jq -r '.[]|select(.code=="hand_rub")|"\(.unit_label):\(.per_days):\(.target|tonumber+0)"')" "ლ:1000:20"
chk "ჯგუფი: IPC განყ. → 403; კოდის გარეშე → 400; არასწორი მნიშვნელი → 400" \
  "$(code POST /ipc/materials/groups "$ID" -d '{"code":"x_1","name":"xx","unit_label":"ლ"}'):$(code POST /ipc/materials/groups "$IC" -d '{"name":"xx","unit_label":"ლ"}'):$(code POST /ipc/materials/groups "$IC" -d '{"code":"x_1","name":"xx","unit_label":"ლ","per_days":7}')" "403:400:400"
GR=$(api POST /ipc/materials/groups "$IC" -d "{\"code\":\"e2e_rub_$S\",\"name\":\"ტესტ-E2E ანტისეპტიკი $S\",\"unit_label\":\"ლ\",\"per_days\":1000,\"target\":20}" | jq -r '.id // empty')
chk "ჯგუფი შეიქმნა; იგივე კოდი — 409; კოდის შეცვლა — 400" \
  "$([ -n "$GR" ] && echo y):$(code POST /ipc/materials/groups "$IC" -d "{\"code\":\"e2e_rub_$S\",\"name\":\"xx\",\"unit_label\":\"ლ\"}"):$(code PATCH "/ipc/materials/groups/$GR" "$IC" -d '{"code":"other"}')" "y:409:400"
REFS=$(api GET /stock/refs "$SM"); HOUSE=$(echo "$REFS" | jq -r '.categories[]|select(.code=="HOUSE").id')
CEN=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_GC_$S\",\"name\":\"ტესტ-E2E ABG საწყობი $S\",\"kind\":\"central\",\"requires_approval\":false}" | jq -r '.id // empty')
SUB=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_GD_$S\",\"name\":\"ტესტ-E2E ABG განყოფილება $S\",\"kind\":\"department\",\"department_id\":\"$DA\",\"requires_approval\":false}" | jq -r '.id // empty')
RUB=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ხელის ანტისეპტიკი 500 მლ $S\",\"category_id\":\"$HOUSE\",\"base_unit\":\"bottle\"}" | jq -r '.id // empty')
[ -n "$CEN" ] && [ -n "$SUB" ] && [ -n "$RUB" ] && ok "ლოკაციები (ცენტრალური, განყოფილება A), საქონელი (ბოთლი 500 მლ)" || die "საწყობის მონაცემები ვერ შეიქმნა"
chk "საქონლის ძებნა (IPC)" "$(api GET "/ipc/materials/stock-items?q=$(jq -rn --arg q "ანტისეპტიკი 500 მლ $S" '$q|@uri')" "$IC" | jq -r --arg i "$RUB" '[.[]|select(.id==$i)]|length')" "1"
chk "მიბმა: კოეფიციენტი 0 → 400; უცნობი საქონელი → 400; 0.5 ლ → ✓" \
  "$(code PUT "/ipc/materials/groups/$GR/items" "$IC" -d "{\"items\":[{\"item_id\":\"$RUB\",\"factor\":0}]}"):$(code PUT "/ipc/materials/groups/$GR/items" "$IC" -d '{"items":[{"item_id":"00000000-0000-4000-8000-000000000000","factor":1}]}'):$(api PUT "/ipc/materials/groups/$GR/items" "$IC" -d "{\"items\":[{\"item_id\":\"$RUB\",\"factor\":0.5}]}" | jq -r '.items[0].factor')" \
  "400:400:0.5"
RCP=$(api POST /stock/receipts "$SK" -d "{\"location_id\":\"$CEN\",\"lines\":[{\"item_id\":\"$RUB\",\"qty\":20,\"price\":5,\"vat_rate\":0}]}" | jq -r '.id // empty')
api POST "/stock/receipts/$RCP/post" "$SK" >/dev/null
LOT=$(api GET "/stock/balances?location_id=$CEN&item_id=$RUB" "$SM" | jq -r '.rows[0].lot_id // empty')
T1=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$CEN\",\"to_location_id\":\"$SUB\",\"lines\":[{\"lot_id\":\"$LOT\",\"qty_base\":10}]}" | jq -r '.id // empty')
api POST "/stock/docs/$T1/receive" "$SK" -d '{"action":"receive"}' >/dev/null
T2=$(api POST /stock/transfers "$SK" -d "{\"doc_type\":\"return\",\"from_location_id\":\"$SUB\",\"to_location_id\":\"$CEN\",\"notes\":\"ტესტ-E2E: ზედმეტი\",\"lines\":[{\"lot_id\":\"$LOT\",\"qty_base\":2}]}" | jq -r '.id // empty')
api POST "/stock/docs/$T2/receive" "$SK" -d '{"action":"receive"}' >/dev/null
W=$(api POST /stock/writeoffs "$NA" -d "{\"location_id\":\"$SUB\",\"writeoff_reason\":\"damaged\",\"notes\":\"ტესტ-E2E: ბოთლები\",\"lines\":[{\"lot_id\":\"$LOT\",\"qty_base\":3}]}")
WID=$(echo "$W" | jq -r '.id // empty'); [ "$(echo "$W" | jq -r .status)" = "posted" ] || api POST "/stock/writeoffs/$WID/decide" "$SM" -d '{"approve":true}' >/dev/null
chk "განყოფილების ნაშთი: 10 − 2 − 3 = 5" "$(api GET "/stock/balances?location_id=$SUB&item_id=$RUB" "$SM" | jq -r '[.rows[].qty|tonumber]|add+0')" "5"
api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" >/dev/null
M=$(api GET "/ipc/materials/rates?from=$TODAY&to=$TODAY&department_id=$DA" "$IC")
chk "გაცემით (ნეტო): 8 ბოთლი = 4 ლ; პაციენტ-დღე 2 → 2000 ლ / 1000" \
  "$(echo "$M" | jq -r --arg g "$GR" '"\(.source):\(.patient_days):" + (.groups[]|select(.id==$g)|"\(.qty):\(.rate):\(.departments[0].rate):\(.months|length)")')" "issue:2:4:2000:2000:1"
ipcset '{"material_source":"consumption"}'
chk "ხარჯით / ჩამოწერით: 3 ბოთლი = 1.5 ლ → 750" "$(api GET "/ipc/materials/rates?from=$TODAY&to=$TODAY&department_id=$DA" "$IC" | jq -r --arg g "$GR" '.groups[]|select(.id==$g)|"\(.qty):\(.rate)"')" "1.5:750"
ipcset '{"material_source":"issue"}'
chk "IPC განყ. A: თავისი — ✓; განყოფილება B — 403; ექიმი — 403; საქონლის ძებნა — 403" \
  "$(code GET "/ipc/materials/rates?from=$TODAY&to=$TODAY" "$ID"):$(code GET "/ipc/materials/rates?from=$TODAY&to=$TODAY&department_id=$DB" "$ID"):$(code GET "/ipc/materials/rates?from=$TODAY&to=$TODAY" "$DR"):$(code GET "/ipc/materials/stock-items?q=xx" "$ID")" "200:403:403:403"
chk "ჯგუფის გათიშვა → მაჩვენებლებში აღარ არის" \
  "$(api PATCH "/ipc/materials/groups/$GR" "$IC" -d '{"is_active":false}' >/dev/null; api GET "/ipc/materials/rates?from=$TODAY&to=$TODAY" "$IC" | jq -r --arg g "$GR" '[.groups[]|select(.id==$g)]|length')" "0"

step "6. მოდულის გამორთვა / აღდგენა"
api PUT /modules/ipc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე: გამოქვეყნებული (ექიმი) / მასალები → 403" "$(code GET /ipc/abg/published "$DR"):$(code GET /ipc/materials/groups "$IC")" "403:403"
api PUT /modules/ipc "$ADM" -d "{\"enabled\":$(echo "$O_IPC" | jq '.enabled'),\"settings\":$(echo "$O_IPC" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')" "$O_IPC"
AUD=$( (api GET "/audit-logs?entity_name=ipc_antibiograms&limit=50" "$ADM"; api GET "/audit-logs?entity_name=ipc_material_groups&limit=50" "$ADM") | jq -s -r '[.[]|(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: IPC_ABG_PUBLISH, IPC_ABG_WITHDRAW, IPC_ABG_EXPORT, IPC_MATERIAL_GROUP_CREATE, IPC_MATERIAL_GROUP_UPDATE, IPC_MATERIAL_ITEMS_SET" \
  "$(for a in IPC_ABG_PUBLISH IPC_ABG_WITHDRAW IPC_ABG_EXPORT IPC_MATERIAL_GROUP_CREATE IPC_MATERIAL_GROUP_UPDATE IPC_MATERIAL_ITEMS_SET; do echo "$AUD" | tr ',' '\n' | grep -qx "$a" && echo y || echo "$a"; done | sort -u | tr '\n' ' ')" "y "

step "გასუფთავება"
if [ -n "${E2E_KEEP:-}" ]; then ok "E2E_KEEP — მონაცემები დატოვებულია (ეკრანის სურათებისთვის)"; printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; exit; fi
for e in $E3 $E4; do api POST "/inpatient/stays/$e/cancel" "$DR" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
api PATCH "/stock/items/$RUB" "$SM" -d '{"is_active":false}' >/dev/null
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "ჰოსპიტალიზაციები გაუქმდა, საქონელი / მომხმარებლები გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
