#!/usr/bin/env bash
# =====================================================================
# e2e-management.sh — მართვის უფლებები (API-ით)
#   ბუღალტერი (accountant), მენეჯერი (manager), HR (hr), სამედიცინო ინჟინერი (med_engineer),
#   ხელმძღვანელობა (viewer). სატესტო როლები იქმნება და ბოლოს იშლება.
#   bash scripts/e2e-management.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-management.sh
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
LG=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); ADM=$(echo "$LG" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა"
ADMIN_ID=$(echo "$LG" | jq -r .user.id)
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(date +%F); MONTH=$(date +%Y-%m-01)

# სატესტო როლი: mkrole <კოდი> <სახელი> <caps-json>
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
# მომხმარებელი: mkuser <roles-json> <n> [department_id] → access token; id → $TMP/u
mkuser() {
  local dep=""; [ -n "${3:-}" ] && dep=",\"department_id\":\"$3\""
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.mgmt.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მართვა-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1$dep}")
  local id tmp pw; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { echo "ERR:$(echo "$R" | jq -rc .message)"; return; }
  pw="E2e-$S-pass$RANDOM"; echo "$id" > "$TMP/u"; echo "$id" >> "$TMP/all"
  local t; t=$(login "e2e.mgmt.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"$pw\"}" | jq -r '.accessToken // empty'
}

step "0. მომზადება"
chk "უფლებების კატალოგში 19 უფლება" "$(api GET /roles/capabilities "$ADM" | jq length)" "19"
chk "ახალი უფლებები: accountant, manager, hr, med_engineer, viewer" \
  "$(api GET /roles/capabilities "$ADM" | jq -r '[.[].code|select(.=="accountant" or .=="manager" or .=="hr" or .=="med_engineer" or .=="viewer")]|length')" "5"
DEPS=$(api GET /departments "$ADM"); DA=$(echo "$DEPS" | jq -r '.[0].id // empty'); DB=$(echo "$DEPS" | jq -r '.[1].id // empty')
[ -n "$DA" ] || die "საჭიროა მინიმუმ 1 აქტიური განყოფილება"
if [ -z "$DB" ]; then   # მეორე განყოფილება — ტესტისთვის (ბოლოს ითიშება)
  DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E განყოფილება $S\",\"code\":\"E2E$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty'); DB_TMP=1
  [ -n "$DB" ] || die "მეორე განყოფილება ვერ შეიქმნა"
fi
R_ACC=$(mkrole acc "ბუღალტერი" '["accountant"]'); R_MGR=$(mkrole mgr "მენეჯერი" '["manager"]'); R_HR=$(mkrole hr "HR" '["hr"]')
R_ENG=$(mkrole eng "სამედ. ინჟინერი" '["med_engineer"]'); R_VW=$(mkrole vw "ხელმძღვანელობა" '["viewer"]'); R_SUP=$(mkrole sup "სუპერ" '["admin","billing"]')
chk "სატესტო როლები შეიქმნა (6)" "$(wc -l < "$TMP/roles" | tr -d ' ')" "6"
T_ACC=$(mkuser "[\"$R_ACC\"]" 81); T_VW=$(mkuser "[\"$R_VW\"]" 82)
T_MGR=$(mkuser "[\"$R_MGR\"]" 83 "$DA"); U_MGR=$(cat "$TMP/u")
T_HR=$(mkuser "[\"$R_HR\"]" 84); U_HR=$(cat "$TMP/u")
T_ENG=$(mkuser "[\"$R_ENG\"]" 85)
T_NA=$(mkuser '["nurse"]' 86 "$DA"); U_NA=$(cat "$TMP/u")
T_NB=$(mkuser '["nurse"]' 87 "$DB"); U_NB=$(cat "$TMP/u")
T_M2=$(mkuser "[\"$R_MGR\"]" 88); U_M2=$(cat "$TMP/u")
for t in "$T_ACC" "$T_VW" "$T_MGR" "$T_HR" "$T_ENG" "$T_NA" "$T_NB" "$T_M2"; do [ -n "$t" ] && [ "${t#ERR}" = "$t" ] || die "მომხმარებელი ვერ შეიქმნა: $t"; done
ok "8 სატესტო მომხმარებელი"

step "1. ბუღალტერი — ანგარიშები, შემოსავლები, ხარჯები, ფინანსური რეპორტი"
BASE=$(api GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_ACC" | jq -r '.totals.expenses // empty')
[ -n "$BASE" ] && ok "ფინანსური რეპორტი — 200 (ხარჯები: $BASE)" || bad "ფინანსური რეპორტი" "ცარიელი"
chk "რეპორტი: შემოსავალი მეთოდებით/დღეებით/კატეგორიით/ექიმებით" "$(api GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_ACC" | jq -r '[has("by_method"),has("by_day"),has("by_category"),has("by_doctor"),has("outstanding")]|all')" "true"
chk "არასწორი პერიოდი — 400" "$(code GET "/reports/finance?from=$TODAY&to=2000-01-01" "$T_ACC")" "400"
chk "ხარჯის კატეგორიები" "$(api GET /expenses/categories "$T_ACC" | jq 'index("კომუნალური") != null')" "true"
X=$(api POST /expenses "$T_ACC" -d "{\"expense_date\":\"$TODAY\",\"category\":\"კომუნალური\",\"description\":\"ტესტ-E2E ელექტროენერგია\",\"amount\":123.45,\"supplier\":\"ტესტ-E2E\",\"doc_number\":\"E2E-$S\"}")
XID=$(echo "$X" | jq -r '.id // empty'); [ -n "$XID" ] && ok "ხარჯი დაემატა (123.45 ₾)" || bad "ხარჯის დამატება" "$(echo "$X" | jq -rc .message)"
chk "ნული/უარყოფითი თანხა — 400" "$(code POST /expenses "$T_ACC" -d "{\"expense_date\":\"$TODAY\",\"category\":\"სხვა\",\"amount\":0}")" "400"
chk "რეპორტში ხარჯი აისახა" "$(api GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_ACC" | jq -r ".totals.expenses|tonumber - $BASE | . * 100 | round")" "12345"
chk "სალდო = შემოსავალი − ხარჯი" "$(api GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_ACC" | jq -r '.totals | ((.payments|tonumber) - (.expenses|tonumber) - (.net|tonumber)) | fabs < 0.01')" "true"
chk "ხარჯის რედაქტირება" "$(api PATCH "/expenses/$XID" "$T_ACC" -d '{"amount":100}' | jq -r .amount)" "100.00"
chk "გაუქმება მიზეზის გარეშე — 400" "$(code PATCH "/expenses/$XID" "$T_ACC" -d '{"void":true}')" "400"
chk "გაუქმება (void)" "$(api PATCH "/expenses/$XID" "$T_ACC" -d '{"void":true,"void_reason":"ტესტ-E2E გაუქმება"}' | jq -r .is_void)" "true"
chk "გაუქმებული არ იცვლება — 409" "$(code PATCH "/expenses/$XID" "$T_ACC" -d '{"amount":5}')" "409"
chk "გაუქმებული სიაში არ ჩანს" "$(api GET "/expenses?from=$TODAY&to=$TODAY" "$T_ACC" | jq "[.[]|select(.id==\"$XID\")]|length")" "0"
chk "…include_void=true — ჩანს" "$(api GET "/expenses?from=$TODAY&to=$TODAY&include_void=true" "$T_ACC" | jq "[.[]|select(.id==\"$XID\")]|length")" "1"
chk "აქტივობის რეპორტი — 200" "$(code GET "/reports/activity?from=$MONTH&to=$TODAY" "$T_ACC")" "200"
chk "მომხმარებლები — 403" "$(code GET /users "$T_ACC")" "403"
chk "პაციენტის რეგისტრაცია — 403" "$(code POST /patients "$T_ACC" -d '{}')" "403"
chk "ექთანს ფინანსური რეპორტი — 403" "$(code GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_NA")" "403"

step "2. ხელმძღვანელობა — მხოლოდ ნახვა და რეპორტები"
chk "ფინანსური რეპორტი — 200" "$(code GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_VW")" "200"
chk "აქტივობის რეპორტი — 200" "$(code GET "/reports/activity?from=$MONTH&to=$TODAY" "$T_VW")" "200"
chk "ხარჯების ნახვა — 200" "$(code GET "/expenses?from=$MONTH&to=$TODAY" "$T_VW")" "200"
chk "ჩაწერების ნახვა — 200" "$(code GET "/appointments?date=$TODAY" "$T_VW")" "200"
chk "დიაგნოსტიკის განრიგის ნახვა — 200" "$(code GET "/radiology/board?date=$TODAY&section=radiology" "$T_VW")" "200"
chk "აპარატების ნახვა — 200" "$(code GET "/dx/devices?section=radiology" "$T_VW")" "200"
chk "ხარჯის დამატება — 403" "$(code POST /expenses "$T_VW" -d "{\"expense_date\":\"$TODAY\",\"category\":\"სხვა\",\"amount\":1}")" "403"
chk "ჩაწერის შექმნა — 403" "$(code POST /appointments "$T_VW" -d '{}')" "403"
chk "პაციენტის რეგისტრაცია — 403" "$(code POST /patients "$T_VW" -d '{}')" "403"
chk "აპარატის დამატება — 403" "$(code POST /dx/devices "$T_VW" -d '{}')" "403"
chk "მომხმარებლები — 403" "$(code GET /users "$T_VW")" "403"
chk "როლები — 403" "$(code GET /roles "$T_VW")" "403"

step "3. მენეჯერი — ნაკადები, ჩაწერები, საკუთარი განყოფილების თანამშრომლები"
chk "ჩაწერების ნახვა — 200" "$(code GET "/appointments?date=$TODAY" "$T_MGR")" "200"
chk "ჩაწერის შექმნა — ვალიდაცია (400, არა 403)" "$(code POST /appointments "$T_MGR" -d '{}')" "400"
chk "პაციენტების ძებნა — 200" "$(code GET "/patients?search=e2e" "$T_MGR")" "200"
chk "დიაგნოსტიკის განრიგი — 200" "$(code GET "/radiology/board?date=$TODAY&section=endoscopy" "$T_MGR")" "200"
chk "აქტივობა — მხოლოდ საკუთარი განყოფილება (სხვისი department_id იგნორდება)" "$(api GET "/reports/activity?from=$MONTH&to=$TODAY&department_id=$DB" "$T_MGR" | jq -r .department_id)" "$DA"
chk "ფინანსური რეპორტი — 403" "$(code GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_MGR")" "403"
L=$(api GET "/users?limit=100" "$T_MGR")
chk "თანამშრომლების სია — მხოლოდ საკუთარი განყოფილება" "$(echo "$L" | jq -r "[.[]|select(.department_id!=\"$DA\")]|length")" "0"
chk "…საკუთარი ექთანი ჩანს" "$(echo "$L" | jq -r "[.[]|select(.id==\"$U_NA\")]|length")" "1"
chk "სხვა განყოფილების თანამშრომელი — 403" "$(code GET "/users/$U_NB" "$T_MGR")" "403"
chk "სხვა განყოფილების გათიშვა — 403" "$(code POST "/users/$U_NB/disable" "$T_MGR")" "403"
chk "საკუთარის: პაროლის აღდგენა — 200" "$(code POST "/users/$U_NA/reset-password" "$T_MGR")" "200"
chk "საკუთარის: გათიშვა — 200" "$(code POST "/users/$U_NA/disable" "$T_MGR")" "200"
chk "საკუთარის: ჩართვა — 200" "$(code POST "/users/$U_NA/enable" "$T_MGR")" "200"
chk "საკუთარის: სესიების დახურვა — 200" "$(code DELETE "/users/$U_NA/sessions" "$T_MGR")" "200"
chk "პროფილის/როლების შეცვლა — 403" "$(code PATCH "/users/$U_NA" "$T_MGR" -d '{"phone":"555000000"}')" "403"
chk "ახალი მომხმარებელი — 403" "$(code POST /users "$T_MGR" -d '{}')" "403"
chk "ადმინისტრატორის გათიშვა — 403" "$(code POST "/users/$ADMIN_ID/disable" "$T_MGR")" "403"
chk "მენეჯერი განყოფილების გარეშე: სია — 403" "$(code GET /users "$T_M2")" "403"
chk "მენეჯერი განყოფილების გარეშე: აქტივობა — 400" "$(code GET "/reports/activity?from=$MONTH&to=$TODAY" "$T_M2")" "400"

step "4. HR — მომხმარებლები და როლები, ადმინისტრატორის გარეშე"
chk "ყველა მომხმარებლის სია — 200" "$(code GET /users "$T_HR")" "200"
chk "როლების სია — 200" "$(code GET /roles "$T_HR")" "200"
chk "როლის შექმნა/რედაქტირება — 403 (მხოლოდ ადმინი)" "$(code POST /roles "$T_HR" -d '{"code":"e2e_x","name":"x","capabilities":[]}')" "403"
R=$(api POST /users "$T_HR" -d "{\"email\":\"e2e.mgmt.91.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"HR-ის შექმნილი\",\"personal_number\":\"91$(printf '%09d' "$S")\",\"roles\":[\"nurse\",\"$R_ACC\"]}")
U_H1=$(echo "$R" | jq -r '.user.id // empty'); [ -n "$U_H1" ] && { ok "მომხმარებლის შექმნა (ექთანი + ბუღალტერი)"; echo "$U_H1" >> "$TMP/all"; } || bad "HR: შექმნა" "$(echo "$R" | jq -rc .message)"
chk "როლის მინიჭება" "$(api PATCH "/users/$U_H1" "$T_HR" -d '{"roles":["nurse","receptionist"]}' | jq -r '[.roles[].code]|sort|join(",")')" "nurse,receptionist"
chk "ადმინისტრატორის როლის მინიჭება — 403" "$(code PATCH "/users/$U_H1" "$T_HR" -d '{"roles":["nurse","admin"]}')" "403"
chk "ადმინ-უფლებიანი კლინიკის როლი — 403" "$(code PATCH "/users/$U_H1" "$T_HR" -d "{\"roles\":[\"nurse\",\"$R_SUP\"]}")" "403"
chk "ადმინისტრატორის შექმნა — 403" "$(code POST /users "$T_HR" -d "{\"email\":\"e2e.mgmt.92.$S@test.local\",\"first_name\":\"x\",\"last_name\":\"y\",\"personal_number\":\"92$(printf '%09d' "$S")\",\"roles\":[\"admin\"]}")" "403"
chk "გათიშვა — 200" "$(code POST "/users/$U_H1/disable" "$T_HR")" "200"
chk "ჩართვა — 200" "$(code POST "/users/$U_H1/enable" "$T_HR")" "200"
chk "ადმინისტრატორის გათიშვა — 403" "$(code POST "/users/$ADMIN_ID/disable" "$T_HR")" "403"
chk "ადმინისტრატორის რედაქტირება — 403" "$(code PATCH "/users/$ADMIN_ID" "$T_HR" -d '{"phone":"555000000"}')" "403"
chk "ადმინისტრატორის პაროლის აღდგენა — 403" "$(code POST "/users/$ADMIN_ID/reset-password" "$T_HR")" "403"
chk "ადმინისტრატორის ნახვა — 200" "$(code GET "/users/$ADMIN_ID" "$T_HR")" "200"
chk "ფინანსური რეპორტი — 403" "$(code GET "/reports/finance?from=$MONTH&to=$TODAY" "$T_HR")" "403"
chk "პაციენტები — 403" "$(code GET "/patients?search=e2e" "$T_HR")" "403"

step "5. სამედიცინო ინჟინერი — აპარატები, ოთახები, ენდოსკოპების რეესტრი"
chk "აპარატების სია — 200" "$(code GET "/dx/devices?section=radiology" "$T_ENG")" "200"
DV=$(api POST /dx/devices "$T_ENG" -d "{\"section\":\"radiology\",\"name\":\"ტესტ-E2E აპარატი $S\",\"modalities\":[\"US\"],\"room\":\"E2E-101\",\"slot_minutes\":15}" | jq -r '.id // empty')
[ -n "$DV" ] && ok "აპარატის დამატება (ოთახი E2E-101)" || bad "აპარატის დამატება" "ვერ შეიქმნა"
chk "ოთახის შეცვლა" "$(api PATCH "/dx/devices/$DV" "$T_ENG" -d '{"room":"E2E-102"}' | jq -r .room)" "E2E-102"
chk "აპარატის გათიშვა" "$(api PATCH "/dx/devices/$DV" "$T_ENG" -d '{"is_active":false}' | jq -r .is_active)" "false"
chk "ენდოსკოპების რეესტრი — 200" "$(code GET /endo/scopes "$T_ENG")" "200"
SC=$(api POST /endo/scopes "$T_ENG" -d "{\"name\":\"ტესტ-E2E ინჟ\",\"scope_type\":\"gastroscope\",\"serial_number\":\"E2E-ENG-$S\"}" | jq -r '.id // empty')
[ -n "$SC" ] && ok "ენდოსკოპის რეგისტრაცია" || bad "ენდოსკოპის რეგისტრაცია" "ვერ შეიქმნა"
chk "ენდოსკოპის ისტორია — 200" "$(code GET "/endo/scopes/$SC/history" "$T_ENG")" "200"
chk "ენდოსკოპის გათიშვა" "$(api PATCH "/endo/scopes/$SC" "$T_ENG" -d '{"is_active":false}' | jq -r .is_active)" "false"
chk "დეზინფექციის ჩაწერა — 403 (პერსონალის საქმეა)" "$(code POST "/endo/scopes/$SC/reprocess" "$T_ENG" -d '{}')" "403"
chk "პაციენტები — 403" "$(code GET "/patients?search=e2e" "$T_ENG")" "403"
chk "მომხმარებლები — 403" "$(code GET /users "$T_ENG")" "403"
chk "რეპორტები — 403" "$(code GET "/reports/activity?from=$MONTH&to=$TODAY" "$T_ENG")" "403"

step "6. დასუფთავება"
for U in $(cat "$TMP/all" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
[ -n "${DB_TMP:-}" ] && api PATCH "/departments/$DB" "$ADM" -d '{"is_active":false}' >/dev/null
for R in $(cat "$TMP/roles" 2>/dev/null); do chk "სატესტო როლი წაიშალა" "$(api DELETE "/roles/$R" "$ADM" | jq -r '.deleted // .message')" "true"; done
ok "სატესტო მომხმარებლები გაითიშა; ხარჯი გაუქმებულია; აპარატი/ენდოსკოპი გათიშულია"
printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
