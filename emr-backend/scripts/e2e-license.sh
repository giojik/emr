#!/usr/bin/env bash
# =====================================================================
# e2e-license.sh — ლიცენზია (0085): ფორმატი / ხელმოწერა / install_id, ლიცენზირებული ნაკრები (not_licensed + ისტორია),
#   ვადის ფაზები (valid / warning / grace / expired → მხოლოდ წაკითხვა), ბანერი, მომხმარებლების ლიმიტი, მოხსნა (dev), აუდიტი.
#   სატესტო გასაღებით ხელს აწერს openssl (scripts/test-license/TEST_ONLY_private.pem).
#   მოითხოვს: backend — NODE_ENV ≠ production და LICENSE_TEST_KEY=1; ლიცენზია არ არის (dev) ან სატესტო.
#   bash scripts/e2e-license.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-license.sh
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
J='content-type: application/json'
DIR="$(cd "$(dirname "$0")" && pwd)"; KEY="$DIR/test-license/TEST_ONLY_private.pem"; KID=test-0085
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mშეწყდა:\033[0m %s\n' "$1"; exit 1; }
command -v jq >/dev/null || die "jq არ არის დაყენებული"
command -v openssl >/dev/null || die "openssl არ არის დაყენებული"
[ -f "$KEY" ] || die "სატესტო გასაღები ვერ მოიძებნა: $KEY"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
st()   { api GET /modules "$ADM" | jq -r --arg c "$1" '.[]|select(.code==$c)|.state'; }
TMP=$(mktemp -d)
D() { TZ=Asia/Tbilisi date -d "$1" +%F; }
# ხელმოწერა: payload-ის კანონიკური JSON (jq -cS — გასაღებები დალაგებული) → Ed25519 (openssl, -rawin)
sign() { # $1 = payload JSON, $2 = kid (ნაგულისხმევი — სატესტო)
  printf '%s' "$(echo "$1" | jq -cS .)" > "$TMP/msg"
  local sig; sig=$(openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$TMP/msg" | base64 | tr -d '\n')
  jq -nc --argjson p "$1" --arg k "${2:-$KID}" --arg s "$sig" '{v:1, kid:$k, payload:$p, sig:$s}'
}
put()  { api POST /license "$ADM" -d "$(jq -nc --argjson l "$1" '{license:$l}')"; }
ver()  { api POST /license/verify "$ADM" -d "$(jq -nc --argjson l "$1" '{license:$l}')"; }

step "0. წინაპირობები"
L=$(api GET /license "$ADM")
MODE=$(echo "$L" | jq -r '.status.mode // empty'); INST=$(echo "$L" | jq -r '.status.install_id // empty')
[ -n "$INST" ] || die "GET /license ვერ მოხერხდა (0085 დაყენებულია?)"
[ "$MODE" = "dev" ] || [ "$(echo "$L" | jq -r .status.test_key)" = "true" ] || die "სერვერზე ნამდვილი ლიცენზიაა (mode=$MODE) — ტესტი მას არ შეცვლის"
[ "$MODE" = "dev" ] || api DELETE /license "$ADM" >/dev/null
ok "dev რეჟიმი; ინსტალაცია $INST"
cleanup() { api DELETE /license "$ADM" >/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
TODAY=$(D today)
P0=$(jq -nc --arg i "$INST" --arg t "$TODAY" --arg e "$(D '+400 days')" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["outpatient","lab","stock"], issued:$t, expires:$e}')
GOOD=$(sign "$P0")
R=$(ver "$GOOD")
[ "$(echo "$R" | jq -r '.code // empty')" = "LICENSE_UNKNOWN_KEY" ] && die "სატესტო გასაღები არ მიიღება — backend-ის .env-ში LICENSE_TEST_KEY=1 (NODE_ENV ≠ production) და გადატვირთვა"
chk "verify: სწორი ფაილი — ok, 3 მოდული" "$(echo "$R" | jq -r '"\(.ok):\(.modules|length):\(.kid)"')" "true:3:$KID"

step "1. შემოწმება: ფორმატი, ხელმოწერა, გასაღები, ინსტალაცია"
chk "ცარიელი — 400 LICENSE_FORMAT" "$(api POST /license/verify "$ADM" -d '{}' | jq -r .code)" "LICENSE_FORMAT"
chk "უცნობი ველი payload-ში — 400 LICENSE_FORMAT" "$(ver "$(sign "$(echo "$P0" | jq -c '.+{extra:1}')")" | jq -r .code)" "LICENSE_FORMAT"
chk "შეცვლილი payload (ხელმოწერის შემდეგ) — 400 LICENSE_BAD_SIGNATURE" "$(ver "$(echo "$GOOD" | jq -c '.payload.modules += ["inpatient"]')" | jq -r .code)" "LICENSE_BAD_SIGNATURE"
chk "უცნობი kid — 400 LICENSE_UNKNOWN_KEY" "$(ver "$(sign "$P0" other-key)" | jq -r .code)" "LICENSE_UNKNOWN_KEY"
chk "სხვა ინსტალაცია — 400 LICENSE_WRONG_INSTALL" "$(ver "$(sign "$(echo "$P0" | jq -c '.install_id="11111111-2222-4333-8444-555555555555"')")" | jq -r .code)" "LICENSE_WRONG_INSTALL"
chk "expires issued-ზე ადრე — 400 LICENSE_FORMAT" "$(ver "$(sign "$(echo "$P0" | jq -c --arg e "$(D '-1 day')" '.expires=$e')")" | jq -r .code)" "LICENSE_FORMAT"
chk "verify არ აყენებს (mode = dev)" "$(api GET /license/status "$ADM" | jq -r .mode)" "dev"

step "2. ლიცენზირებული ნაკრები: outpatient + lab + stock"
R=$(put "$GOOD")
chk "ატვირთვა: licensed, valid, ბანერი none" "$(echo "$R" | jq -r '"\(.mode):\(.phase):\(.banner):\(.modules|join("+"))"')" "licensed:valid:none:outpatient+lab+stock"
chk "იგივე ფაილი მეორედ — 409 LICENSE_SAME" "$(put "$GOOD" | jq -r .code)" "LICENSE_SAME"
chk "ბირთვი — აქტიური; lab / stock — აქტიური" "$(st billing):$(st lab):$(st stock)" "active:active:active"
chk "inpatient / pharmacy / lab_qc — not_licensed" "$(st inpatient):$(st pharmacy):$(st lab_qc)" "not_licensed:not_licensed:not_licensed"
R=$(api GET /inpatient/census "$ADM")
chk "GET /inpatient/census — 403 MODULE_NOT_LICENSED" "$(echo "$R" | jq -r .code)" "MODULE_NOT_LICENSED"
chk "ისტორია: GET /inpatient/stays/:id — guard გადის (არა 403)" "$([ "$(code GET /inpatient/stays/00000000-0000-4000-8000-000000000000 "$ADM")" != "403" ] && echo ok)" "ok"
chk "GET /lab/worklist (ლიცენზირებული) — 200" "$(code GET /lab/worklist "$ADM")" "200"
ORIG_QC=$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="lab_qc")|.enabled')
api PUT /modules/lab_qc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E ლიცენზია"}' >/dev/null
chk "ლიცენზიის გარეშე მოდულის ჩართვა — 409 MODULE_NOT_LICENSED" "$(api PUT /modules/lab_qc "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E ლიცენზია"}' | jq -r .code)" "MODULE_NOT_LICENSED"
chk "უფლებები: radiologist — module_active false; lab_doctor — true" "$(api GET /roles/capabilities "$ADM" | jq -r '[.[]|select(.code=="radiologist" or .code=="lab_doctor")|"\(.code)=\(.module_active)"]|sort|join(",")')" "lab_doctor=true,radiologist=false"

step "3. ვადა გავიდა (+ შეღავათიც) → ოპციური მოდულები მხოლოდ წაკითხვაზე"
R=$(put "$(sign "$(jq -nc --arg i "$INST" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["outpatient","lab","stock","lab_qc"], issued:"2020-01-01", expires:"2020-12-31"}')")")
chk "phase expired, ბანერი ყველას" "$(echo "$R" | jq -r '"\(.phase):\(.banner)"')" "expired:all"
chk "lab / stock — read_only; ბირთვი — active" "$(st lab):$(st stock):$(st encounters)" "read_only:read_only:active"
chk "GET /lab/worklist — 200 (ნახვა)" "$(code GET /lab/worklist "$ADM")" "200"
R=$(api POST /lab-visits "$ADM" -d '{}')
chk "POST /lab-visits — 403 LICENSE_EXPIRED" "$(echo "$R" | jq -r .code)" "LICENSE_EXPIRED"
chk "@ReadOnlySafe: POST /lab/blanks/preview — არა 403" "$([ "$(code POST /lab/blanks/preview "$ADM" -d '{}')" != "403" ] && echo ok)" "ok"
chk "ბირთვში ჩაწერა მუშაობს: PUT /modules/lab_qc (ჩართვა — ლიცენზიაშია)" "$(api PUT /modules/lab_qc "$ADM" -d "{\"enabled\":$ORIG_QC,\"reason\":\"ტესტ-E2E ლიცენზია\"}" | jq -r .code)" "lab_qc"
chk "lab_qc — read_only (ჩართული, ვადაგასული)" "$(st lab_qc)" "read_only"
chk "status (admin) — expired, days_left < -30" "$(api GET /license/status "$ADM" | jq -r '"\(.phase):\(.days_left < -30)"')" "expired:true"

step "4. შეღავათი (ვადა 5 დღის წინ) — სრული ფუნქცია"
R=$(put "$(sign "$(jq -nc --arg i "$INST" --arg e "$(D '-5 days')" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["outpatient","lab","stock"], issued:"2026-01-01", expires:$e}')")")
chk "phase grace, ბანერი ყველას, days_left -5" "$(echo "$R" | jq -r '"\(.phase):\(.banner):\(.days_left)"')" "grace:all:-5"
chk "lab — active; POST /lab-visits — არა 403" "$(st lab):$([ "$(code POST /lab-visits "$ADM" -d '{}')" != "403" ] && echo ok)" "active:ok"

step "5. გაფრთხილება: 10 დღე — admin-ებს, 5 დღე — ყველას; უვადო"
R=$(put "$(sign "$(jq -nc --arg i "$INST" --arg t "$TODAY" --arg e "$(D '+10 days')" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["lab"], issued:$t, expires:$e}')")")
chk "+10 დღე: warning, admins" "$(echo "$R" | jq -r '"\(.phase):\(.banner):\(.days_left)"')" "warning:admins:10"
R=$(put "$(sign "$(jq -nc --arg i "$INST" --arg t "$TODAY" --arg e "$(D '+5 days')" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["lab"], issued:$t, expires:$e}')")")
chk "+5 დღე: warning, all" "$(echo "$R" | jq -r '"\(.phase):\(.banner)"')" "warning:all"
R=$(put "$(sign "$(jq -nc --arg i "$INST" --arg t "$TODAY" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["lab"], issued:$t, expires:null}')")")
chk "უვადო: valid, ბანერი none, expires null" "$(echo "$R" | jq -r '"\(.phase):\(.banner):\(.expires)"')" "valid:none:null"
chk "stock — not_licensed (ლიცენზიაში აღარაა)" "$(st stock)" "not_licensed"

step "6. მომხმარებლების ლიმიტი"
N=$(api GET /license "$ADM" | jq -r .status.users_active)
R=$(put "$(sign "$(jq -nc --arg i "$INST" --arg t "$TODAY" --argjson n "$N" '{clinic:"ტესტ-E2E კლინიკა", install_id:$i, modules:["lab"], issued:$t, expires:null, max_users:$n}')")")
chk "max_users = აქტიურები → users_warn" "$(echo "$R" | jq -r '"\(.max_users == .users_active):\(.users_warn)"')" "true:true"
S=$(date +%s | tail -c 7)
R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.lic.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ლიცენზია\",\"personal_number\":\"77$(printf '%09d' "$((10#$S))")\",\"roles\":[\"nurse\"]}")
chk "ახალი მომხმარებელი — 409 LICENSE_USER_LIMIT" "$(echo "$R" | jq -r .code)" "LICENSE_USER_LIMIT"

step "7. აუდიტი, ისტორია, მოხსნა"
H=$(api GET /license "$ADM")
chk "ისტორია: ≥ 7 ატვირთვა, მიმდინარე — max_users-ით" "$([ "$(echo "$H" | jq '.history|length')" -ge 7 ] && echo ok):$(echo "$H" | jq -r '[.history[]|select(.removed_at==null)][0].max_users')" "ok:$N"
chk "აუდიტი: LICENSE_UPLOAD" "$([ "$(api GET "/audit-logs?action=LICENSE_UPLOAD&limit=50" "$ADM" | jq 'length')" -ge 7 ] && echo ok)" "ok"
R=$(api DELETE /license "$ADM")
chk "მოხსნა (dev) → mode dev, ყველა მოდული" "$(echo "$R" | jq -r '"\(.mode):\(.modules)"'):$(st inpatient):$(st stock)" "dev:all:active:active"
chk "აუდიტი: LICENSE_REMOVE" "$([ "$(api GET "/audit-logs?action=LICENSE_REMOVE&limit=5" "$ADM" | jq 'length')" -ge 1 ] && echo ok)" "ok"
trap - EXIT; rm -rf "$TMP"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
