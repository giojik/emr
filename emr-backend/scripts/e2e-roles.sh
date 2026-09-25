#!/usr/bin/env bash
# =====================================================================
# e2e-roles.sh — როლები და უფლებები (API-ით)
#   ახალი როლი უფლებების ნაკრებით, რამდენიმე როლი ერთ მომხმარებელზე, უფლებების შეცვლა/გათიშვა,
#   სისტემური როლების დაცვა, ბოლო ადმინისტრატორის დაცვა.
#   bash scripts/e2e-roles.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-roles.sh
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
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა"
ADMIN_ID=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.user.id')
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); CREATED_USERS=(); CREATED_ROLES=()
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# მომხმარებელი როლებით → access token (პაროლი იცვლება); id/email/პაროლი → $TMP/u (subshell-იდან)
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.roles.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"როლები-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1}")
  local id tmp pw; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || { echo "ERR:$(echo "$R" | jq -rc .message)"; return; }
  pw="E2e-$S-pass$RANDOM"; LAST_EMAIL="e2e.roles.$2.$S@test.local"; LAST_PW=$pw
  printf '%s %s %s\n' "$id" "$LAST_EMAIL" "$pw" > "$TMP/u"; echo "$id" >> "$TMP/all"
  local t; t=$(login "$LAST_EMAIL" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"$LAST_PW\"}" | jq -r '.accessToken // empty'
}

step "1. უფლებების კატალოგი და სისტემური როლები"
chk "14 უფლება" "$(api GET /roles/capabilities "$ADM" | jq length)" "14"
chk "სისტემური როლები (14)" "$(api GET /roles "$ADM" | jq '[.[]|select(.is_system)]|length')" "14"
SYS_DOC=$(api GET /roles "$ADM" | jq -r '.[]|select(.code=="doctor")|.id'); SYS_ADM=$(api GET /roles "$ADM" | jq -r '.[]|select(.code=="admin")|.id')
chk "სისტემური როლის უფლებების შეცვლა — 403" "$(code PATCH "/roles/$SYS_DOC" "$ADM" -d '{"capabilities":["doctor","billing"]}')" "403"
chk "სისტემური როლის დასახელება იცვლება" "$(api PATCH "/roles/$SYS_DOC" "$ADM" -d '{"name":"ექიმი"}' | jq -r .name)" "ექიმი"
chk "ადმინისტრატორის როლი არ ითიშება — 403" "$(code PATCH "/roles/$SYS_ADM" "$ADM" -d '{"is_active":false}')" "403"

step "2. ახალი როლი"
RC="e2e_regcash_$S"
R=$(api POST /roles "$ADM" -d "{\"code\":\"$RC\",\"name\":\"ტესტ-E2E რეგისტრატორი-მოლარე\",\"capabilities\":[\"receptionist\",\"billing\"]}")
RID=$(echo "$R" | jq -r '.id // empty'); [ -n "$RID" ] && { ok "როლი შეიქმნა (რეგისტრატურა + სალარო)"; CREATED_ROLES+=("$RID"); } || bad "როლის შექმნა" "$(echo "$R" | jq -rc .message)"
chk "იგივე კოდი — 409" "$(code POST /roles "$ADM" -d "{\"code\":\"$RC\",\"name\":\"დუბლი\",\"capabilities\":[\"nurse\"]}")" "409"
chk "უცნობი უფლება — 400" "$(code POST /roles "$ADM" -d "{\"code\":\"e2e_bad_$S\",\"name\":\"ცუდი\",\"capabilities\":[\"superuser\"]}")" "400"
chk "არასწორი კოდი (დიდი ასოები) — 400" "$(code POST /roles "$ADM" -d '{"code":"Bad-Code","name":"ცუდი","capabilities":["nurse"]}')" "400"

PR="e2e_driver_$S"
PRID=$(api POST /roles "$ADM" -d "{\"code\":\"$PR\",\"name\":\"ტესტ-E2E მძღოლი\",\"capabilities\":[]}" | jq -r '.id // empty')
[ -n "$PRID" ] && { ok "პოზიცია უფლებების გარეშე (მძღოლი)"; CREATED_ROLES+=("$PRID"); } || bad "პოზიცია უფლებების გარეშე" "ვერ შეიქმნა"

step "3. მომხმარებელი ახალი როლით"
T1=$(mkuser "[\"$RC\"]" 71); read -r U1 E1 P1 < "$TMP/u"
[ -n "$T1" ] && [ "${T1#ERR}" = "$T1" ] && ok "მომხმარებელი შეიქმნა" || die "მომხმარებელი: $T1"
chk "სესიაში უფლებები: billing, receptionist" "$(login "$E1" "$P1" | jq -r '.user.caps|join(",")')" "billing,receptionist"
chk "რეგისტრატურა: პაციენტების სია — 200" "$(code GET "/patients?search=e2e" "$T1")" "200"
chk "სალარო: ტარიფის შექმნის უფლება (400 = ვალიდაცია, არა 403)" "$(code POST /tariffs "$T1" -d '{}')" "400"
chk "ლაბორატორია — 403" "$(code GET /lab/worklist "$T1")" "403"
chk "ადმინისტრირება (მომხმარებლები) — 403" "$(code GET /users "$T1")" "403"
chk "ფილტრი როლით" "$(api GET "/users?role=$RC" "$ADM" | jq length)" "1"

step "4. რამდენიმე როლი: ექიმი + ენდოსკოპისტი"
T2=$(mkuser '["doctor","endoscopist"]' 72); read -r U2 _ _ < "$TMP/u"
chk "ძირითადი როლი — doctor" "$(api GET "/users/$U2" "$ADM" | jq -r .role)" "doctor"
chk "ექიმების სიაში ჩანს" "$(api GET /doctors "$ADM" | jq "[.[]|select(.id==\"$U2\")]|length")" "1"
chk "ენდოსკოპიის ოქმები — 200" "$(code GET "/dx/report-worklist?section=endoscopy" "$T2")" "200"
chk "რადიოლოგიის ოქმები — 403 (არა აქვს)" "$(code POST "/dx/report-templates" "$T2" -d '{"section":"radiology","kind":"phrase","name":"xx","target":"findings","body":"x"}')" "403"
chk "როლის დამატება: + რადიოლოგი" "$(api PATCH "/users/$U2" "$ADM" -d '{"roles":["doctor","endoscopist","radiologist"]}' | jq -r '[.roles[].code]|sort|join(",")')" "doctor,endoscopist,radiologist"
chk "როლის შეცვლისას სესიები უქმდება (ძველი refresh აღარ მუშაობს) — 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/auth/refresh")" "401"
chk "ძირითადის შეცვლა: role=endoscopist" "$(api PATCH "/users/$U2" "$ADM" -d '{"role":"endoscopist"}' | jq -r '.role + ":" + ([.roles[].code]|length|tostring)')" "endoscopist:3"
chk "როლების გარეშე — 400" "$(code PATCH "/users/$U2" "$ADM" -d '{"roles":[]}')" "400"
chk "უცნობი როლი — 400" "$(code PATCH "/users/$U2" "$ADM" -d '{"roles":["no_such_role"]}')" "400"

step "4ა. თანამშრომელი მხოლოდ პოზიციით"
T4=$(mkuser "[\"$PR\"]" 74); read -r U4 E4 P4 < "$TMP/u"
chk "შესვლა შესაძლებელია, უფლებები — ცარიელი" "$(login "$E4" "$P4" | jq -r '.user.caps|length')" "0"
chk "პაციენტები — 403" "$(code GET "/patients?search=e2e" "$T4")" "403"
chk "პოზიცია + ექიმი → ექიმის უფლება" "$(api PATCH "/users/$U4" "$ADM" -d "{\"role\":\"$PR\",\"roles\":[\"$PR\",\"doctor\"]}" | jq -r '.capabilities|join(",")')" "doctor"

step "5. როლის უფლებების შეცვლა / გათიშვა"
chk "+ ლაბორანტი (diagnostic)" "$(api PATCH "/roles/$RID" "$ADM" -d '{"capabilities":["receptionist","billing","diagnostic"]}' | jq -r '.capabilities|length')" "3"
chk "იგივე ტოკენით — ლაბორატორია უკვე 200 (უფლებები ბაზიდან)" "$(code GET /lab/worklist "$T1")" "200"
chk "როლის გათიშვა" "$(api PATCH "/roles/$RID" "$ADM" -d '{"is_active":false}' | jq -r .is_active)" "false"
chk "გათიშული როლი უფლებას აღარ იძლევა — 403" "$(code GET "/patients?search=e2e" "$T1")" "403"
chk "გათიშულ როლს ვერ მიანიჭებ — 400" "$(code PATCH "/users/$U2" "$ADM" -d "{\"roles\":[\"doctor\",\"$RC\"]}")" "400"

step "6. ადმინისტრატორის დაცვა"
chk "საკუთარი admin უფლების მოხსნა — 403" "$(code PATCH "/users/$ADMIN_ID" "$ADM" -d '{"roles":["doctor"]}')" "403"
T3=$(mkuser '["admin","doctor"]' 73); read -r U3 _ _ < "$TMP/u"
chk "სხვა admin: როლის მოხსნა შესაძლებელია (მე ვრჩები)" "$(api PATCH "/users/$U3" "$ADM" -d '{"roles":["doctor"]}' | jq -r '.capabilities|join(",")')" "doctor"

step "7. დასუფთავება"
for U in $(cat "$TMP/all" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
chk "სისტემური როლი არ იშლება — 403" "$(code DELETE "/roles/$SYS_DOC" "$ADM")" "403"
for R in "${CREATED_ROLES[@]}"; do chk "სატესტო როლი წაიშალა (აღარავის აქვს)" "$(api DELETE "/roles/$R" "$ADM" | jq -r '.deleted // .message')" "true"; done
ok "სატესტო მომხმარებლები გაითიშა"
printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
