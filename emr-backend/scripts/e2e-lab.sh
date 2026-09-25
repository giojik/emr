#!/usr/bin/env bash
# =====================================================================
# e2e-lab.sh — ლაბორატორიის სრული ნაკადის ავტომატური ტესტი (API-ით)
#   რეგისტრატორი → ლაბ. ვიზიტი → სალარო → ფლებოტომისტი → ლაბორანტი → ლაბ. ექიმი
# ქმნის სატესტო მომხმარებლებს და პაციენტს (სახელში "ტესტ-E2E"), ბოლოს მომხმარებლებს თიშავს.
#
# გამოყენება:  bash scripts/e2e-lab.sh [API_URL]          (ნაგულისხმევი: http://localhost/api)
#   admin-ის ელ-ფოსტასა და პაროლს იკითხავს (ეკრანზე არ ჩანს)
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
A="authorization: Bearer $ADM"
api() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7)
CREATED_USERS=()

step "0. გარემო"
chk "API ხელმისაწვდომია" "$(curl -s "$B/health" | jq -r .status)" "ok"
VER=$(curl -s "$B/health" | jq -r .schemaVersion); if [ "$VER" \> "0011" ]; then ok "სქემის ვერსია $VER"; else bad "სქემის ვერსია" "საჭიროა ≥ 0012, არის $VER"; fi

step "1. მომზადება"
DEP=$(api GET "/departments?include_inactive=true" "$ADM" | jq -r '[.[]|select(.type=="diagnostic" and .is_active)][0].id // empty')
if [ -z "$DEP" ]; then
  DEP=$(api POST /departments "$ADM" -d '{"name":"ლაბორატორია","code":"LAB","type":"diagnostic"}' | jq -r '.id // empty')
  [ -n "$DEP" ] && ok "შეიქმნა განყოფილება 'ლაბორატორია'" || bad "დიაგნოსტიკური განყოფილება" "ვერ შეიქმნა"
else ok "დიაგნოსტიკური განყოფილება არსებობს"; fi
mkuser() { # $1 role, $2 prefix-digits
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.$1.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$1\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"role\":\"$1\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { bad "მომხმარებელი ($1)" "$(echo "$R" | jq -rc .message)"; return; }
  CREATED_USERS+=("$id")
  local t; t=$(login "e2e.$1.$S@test.local" "$tmp")
  local np="E2e-$S-pass$RANDOM"
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"$np\"}" | jq -r '.accessToken // empty'
}
RC=$(mkuser receptionist 91); PH=$(mkuser phlebotomist 92); LT=$(mkuser diagnostic 93); LD=$(mkuser lab_doctor 94)
[ -n "$RC" ] && [ -n "$PH" ] && [ -n "$LT" ] && [ -n "$LD" ] && ok "4 სატესტო მომხმარებელი (რეგისტრატორი, ფლებოტომისტი, ლაბორანტი, ლაბ. ექიმი)" || die "მომხმარებლები ვერ შეიქმნა"
CAT=$(api GET "/dx/catalog?section=lab" "$ADM")
sid() { echo "$CAT" | jq -r ".[]|select(.code==\"$1\")|.id"; }
CBC=$(sid LAB_CBC); COAG=$(sid LAB_COAG); LIP=$(sid LAB_LIPID)
[ -n "$CBC" ] && [ -n "$COAG" ] && [ -n "$LIP" ] && ok "კატალოგი: სისხლის საერთო, კოაგულოგრამა, ლიპიდური" || die "კატალოგში საჭირო ანალიზები ვერ მოიძებნა"
PRICED=$(echo "$CAT" | jq -r "[.[]|select(.id==\"$CBC\" or .id==\"$COAG\" or .id==\"$LIP\")|.base_price|tonumber]|add > 0")
if [ "$PRICED" = "true" ]; then ok "ანალიზებს ფასი აქვს"; else echo "  ⚠ ანალიზებს ფასი არ აქვს — შემოწმდება 0 ₾-ის (უფასო ვიზიტის) სცენარი"; fi
PAT=$(api POST /patients "$RC" -d "{\"personal_number\":\"9$(printf '%010d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ფლებოტომია\",\"birth_date\":\"1985-06-15\",\"gender\":\"male\",\"phone_number\":\"599$S\"}" | jq -r '.id // empty')
[ -n "$PAT" ] && ok "სატესტო პაციენტი" || die "პაციენტი ვერ შეიქმნა"

step "2. რეგისტრატორი: ლაბორატორიული ვიზიტი + სალარო"
LV=$(api POST /lab-visits "$RC" -d "{\"patient_id\":\"$PAT\",\"items\":[{\"service_id\":\"$CBC\",\"note\":\"უზმოზე\"},{\"service_id\":\"$COAG\"},{\"service_id\":\"$LIP\"}],\"external_referral\":\"დ. ტესტაძე\"}")
E=$(echo "$LV" | jq -r '.encounter_id // empty'); [ -n "$E" ] && ok "ვიზიტი გაიხსნა (3 ანალიზი)" || die "ლაბ. ვიზიტი: $(echo "$LV" | jq -rc .message)"
INV=$(api GET "/invoices/encounter/$E" "$RC"); chk "ინვოისში 3 ხაზი" "$(echo "$INV" | jq '[.lines[]]|length')" "3"
ZERO=$(echo "$INV" | jq -r '(.patient_share|tonumber) == 0'); SHARE=$(echo "$INV" | jq -r .patient_share)
if [ "$ZERO" = "true" ]; then
  chk "0 ₾ — ვიზიტი გადახდის გარეშე აქტიურია" "$(api GET "/encounters?patient_id=$PAT" "$ADM" | jq -r "[.[]|select(.id==\"$E\")][0].status")" "active"
else
  chk "ფლებოტომისტის რიგში 'გადაუხდელი' (გადახდამდე)" "$(api GET /dx/collection "$PH" | jq -r "[.[]|select(.encounter_id==\"$E\")][0].paid_status")" "unpaid"
  chk "გადაუხდელზე აღება იბლოკება" "$(api POST "/encounters/$E/dx-collect" "$PH" -d '{"identity_confirmed":true}' | jq -r 'if type=="object" then (.code // "none") else "COLLECTED" end')" "UNPAID"
  chk "გადახდა (ნაღდი $SHARE ₾)" "$(api POST "/encounters/$E/pay-initial" "$RC" -d "{\"amount\":$SHARE,\"method\":\"cash\"}" | jq -r '.status // .message')" "active"
fi

step "3. ფლებოტომისტი"
chk "პაციენტის ბარათი დახურულია (403)" "$(code GET "/patients/$PAT" "$PH")" "403"
chk "ვიზიტის ხედი დახურულია (403)" "$(code GET "/encounters/$E" "$PH")" "403"
chk "ლაბორატორიის სია დახურულია (403)" "$(code GET /lab/worklist "$PH")" "403"
D=$(api GET "/dx/collection/$E" "$PH")
chk "რიგში ჩანს გადახდილად" "$(api GET /dx/collection "$PH" | jq -r "[.[]|select(.encounter_id==\"$E\")][0].paid_status")" "paid"
chk "ჩანს მხოლოდ 3 დანიშნული ანალიზი" "$(echo "$D" | jq '.items|length')" "3"
chk "შენიშვნა 'უზმოზე'" "$(echo "$D" | jq -r '[.items[].clinical_note]|map(select(.))|.[0]')" "უზმოზე"
chk "სინჯარები აღების რიგით" "$(echo "$D" | jq -r '[.tubes[].container]|join(" → ")')" "Citrate → Serum gel → EDTA"
chk "იდენტიფიკაციის გარეშე აღება იბლოკება" "$(code POST "/encounters/$E/dx-collect" "$PH" -d '{}')" "400"
SP=$(api POST "/encounters/$E/dx-collect" "$PH" -d '{"identity_confirmed":true}')
chk "აღება: 3 სინჯარა / 3 შტრიხკოდი" "$(echo "$SP" | jq -r 'if type=="array" then length else ("შეცდომა: " + (.message|tostring)) end')" "3"
echo "$SP" | jq -e 'type=="array"' >/dev/null || die "აღება ვერ მოხერხდა — შემდეგი ნაბიჯები ვერ შემოწმდება"
IDS=$(echo "$SP" | jq -r '[.[].id]|join(",")')
chk "სტიკერების PDF" "$(curl -s "$B/dx/labels?ids=$IDS" -H "authorization: Bearer $PH" | head -c 5)" "%PDF-"
chk "რიგიდან გავიდა" "$(api GET /dx/collection "$PH" | jq "[.[]|select(.encounter_id==\"$E\")]|length")" "0"

step "4. ლაბორანტი: მიღება + შედეგები"
RECV=0; for BC in $(echo "$SP" | jq -r '.[].barcode'); do R=$(api POST /lab/receive "$LT" -d "{\"barcode\":\"$BC\"}" | jq -r '.barcode // .message'); if [ "$R" = "$BC" ]; then RECV=$((RECV+1)); else bad "მიღება $BC" "$R"; fi; done
chk "3 სინჯარა მიღებულია (სკანირება)" "$RECV" "3"
EDTA=$(echo "$SP" | jq -r '.[]|select(.container=="EDTA")|.barcode')
IT=$(api GET "/lab/worklist?search=$EDTA" "$LT" | jq -r '.[0].id // empty'); [ -n "$IT" ] || die "EDTA სინჯარის ანალიზი სამუშაო სიაში ვერ მოიძებნა"
ITEM=$(api GET "/lab/items/$IT" "$LT")
VALS=$(echo "$ITEM" | jq -c '[.analytes[]|{analyte_id:.id,value:({"WBC":"6.5","RBC":"5.0","HGB":"100","HCT":"42","MCV":"88","MCH":"29","MCHC":"330","PLT":"15","NEU":"60","LYM":"30","MON":"6","EOS":"3","BAS":"0.5"}[.code] // "1")}]')
chk "შენახვა → 'ვალიდაციას ელოდება'" "$(api PUT "/lab/items/$IT/results" "$LT" -d "{\"values\":$VALS}" | jq -r .status)" "resulted"
FL=$(api GET "/lab/items/$IT" "$LT" | jq -r '[.results[]|select(.code=="HGB" or .code=="PLT")|.code+":"+.flag]|join(",")')
chk "ნიშნები: HGB დაბალი, PLT კრიტიკული" "$FL" "HGB:L,PLT:LL"
chk "ლაბორანტი ვერ ადასტურებს (403)" "$(code POST "/lab/items/$IT/validate" "$LT")" "403"

step "5. ლაბორატორიის ექიმი: ვალიდაცია"
chk "დადასტურება" "$(api POST "/lab/items/$IT/validate" "$LD" | jq -r .status)" "validated"
chk "ბლანკის PDF" "$(curl -s "$B/encounters/$E/lab-report?item=$IT" -H "authorization: Bearer $LD" | head -c 5)" "%PDF-"
for X in $(api GET "/lab/worklist?status=in_progress" "$LT" | jq -r ".[]|select(.encounter_id==\"$E\")|.id"); do
  V=$(api GET "/lab/items/$X" "$LT" | jq -c '[.analytes[]|{analyte_id:.id,value:(if .result_type=="numeric" then ((.range.low // .range.high // 1)|tostring) else (.options[0] // "x") end)}]')
  api PUT "/lab/items/$X/results" "$LT" -d "{\"values\":$V}" >/dev/null; api POST "/lab/items/$X/validate" "$LD" >/dev/null
done
chk "ყველა დადასტურდა → ვიზიტი ავტომატურად დაიხურა" "$(api GET "/encounters?patient_id=$PAT" "$ADM" | jq -r "[.[]|select(.id==\"$E\")][0].status")" "discharged"
chk "აუდიტში: აღება იდენტიფიკაციით" "$(api GET "/audit-logs?action=COLLECT_SPECIMENS&entity_id=$E" "$ADM" | jq -r '.[0].new_data.identity_confirmed')" "true"

step "გასუფთავება"
for U in "${CREATED_USERS[@]}"; do api POST "/users/$U/disable" "$ADM" >/dev/null; done
ok "სატესტო მომხმარებლები გათიშულია (პაციენტი და ჩანაწერები რჩება ისტორიაში — სახელი: ტესტ-E2E)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
