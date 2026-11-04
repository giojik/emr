#!/usr/bin/env bash
# =====================================================================
# e2e-modules.sh — მოდულური პლატფორმა (0085): რეესტრი, მკაცრი დამოკიდებულებები, guard (@RequireModule),
#   კლინიკური ისტორია გამორთულ მოდულზე, მეთოდის დონე (ამბულატორია / ლაბორატორია), სამუშაო სიის წყაროები,
#   KPI და უფლებები მოდულის მიხედვით. ყველა ცვლილება ბოლოს აღდგება.
#   მოითხოვს: ლიცენზია არ არის (dev — ყველა მოდული) ან ლიცენზიაში ყველა მოდულია.
#   bash scripts/e2e-modules.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-modules.sh
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
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
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
mods() { api GET /modules "$ADM"; }
st()   { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.state'; }
setm() { api PUT "/modules/$1" "$ADM" -d "{\"enabled\":$2,\"reason\":\"ტესტ-E2E მოდულები\"}"; }
RND=00000000-0000-4000-8000-000000000000

# --- საწყისი მდგომარეობა (აღდგენისთვის)
ORIG=$(mods | jq -c '[.[]|{code, enabled}]')
[ "$(echo "$ORIG" | jq length)" -gt 0 ] || die "GET /modules ვერ მოხერხდა"
LIC=$(api GET /license "$ADM" | jq -r '.status.mode // empty')
[ -n "$LIC" ] || die "GET /license ვერ მოხერხდა (0085 დაყენებულია?)"
NOTACT=$(mods | jq -r '[.[]|select(.enabled and .state!="active")|.code]|join(",")')
[ -z "$NOTACT" ] || die "ჩართული, მაგრამ არააქტიური მოდულები ($NOTACT) — ტესტს სჭირდება ლიცენზია „ყველა“ ან dev"
restore() {
  # ჯერ ჩართვა (წინაპირობები → დამოკიდებული), შემდეგ გამორთვა (დამოკიდებული → წინაპირობა)
  local on off c
  on=$(echo "$ORIG" | jq -r '.[]|select(.enabled)|.code'); off=$(echo "$ORIG" | jq -r '.[]|select(.enabled|not)|.code')
  for _ in 1 2 3 4; do for c in $on; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "true" ] || setm "$c" true >/dev/null; done; done
  for _ in 1 2 3 4; do for c in $off; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "false" ] || setm "$c" false >/dev/null; done; done
}
trap restore EXIT

step "1. რეესტრი"
M=$(mods)
chk "მოდულები: ბირთვი 4 + ოპციური 30 (0087: + er)" "$(echo "$M" | jq '[.[]|select(.core)]|length'):$(echo "$M" | jq '[.[]|select(.core|not)]|length')" "4:30"
chk "ბირთვი: core, mpi, encounters, billing — აქტიური, არ ითიშება" "$(echo "$M" | jq -c '[.[]|select(.core)|"\(.code)=\(.state)=\(.can_disable)"]|sort')" '["billing=active=false","core=active=false","encounters=active=false","mpi=active=false"]'
chk "ახალი მოდულები (12) რეესტრშია" "$(echo "$M" | jq '[.[]|select(.code|IN("outpatient","ipd_orders","mar","lab","lab_gateway","lab_external","lab_qc","lab_micro","radiology","endoscopy","pharmacy","lab_stock"))]|length')" "12"
chk "stock / tariffs — ახლა ოპციურია" "$(echo "$M" | jq -r '[.[]|select(.code=="stock" or .code=="tariffs")|.can_disable]|join(",")')" "true,true"
chk "მკაცრი: ipd_orders → inpatient, pharmacy; scrubber → drg" "$(echo "$M" | jq -r '[.[]|select(.code=="ipd_orders" or .code=="scrubber")|"\(.code):\(.hard|join("+"))"]|join(",")')" "ipd_orders:inpatient+pharmacy,scrubber:drg"
chk "დამოკიდებულები: stock ← pharmacy, lab_stock, procurement" "$(echo "$M" | jq -r '.[]|select(.code=="stock")|.dependents|sort|join(",")')" "lab_stock,pharmacy,procurement"
chk "ორად გაყოფილის პარამეტრები — inpatient-ში (ipd_orders, mar)" "$(echo "$M" | jq -r '[.[]|select(.settings_of=="inpatient")|.code]|sort|join(",")')" "ipd_orders,mar"
chk "ბირთვის გამორთვა — 400" "$(code PUT /modules/billing "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}')" "400"

step "2. მკაცრი დამოკიდებულებები"
R=$(setm stock false)
chk "stock-ის გამორთვა (pharmacy / lab_stock / procurement ჩართულია) — 409 + სია" "$(echo "$R" | jq -r '.code'):$(echo "$R" | jq -r '.dependents|sort|join(",")')" "MODULE_HAS_DEPENDENTS:lab_stock,pharmacy,procurement"
chk "mar → გამორთვა (დამოკიდებული არ ჰყავს)" "$(setm mar false | jq -r .state)" "disabled"
chk "ipd_orders → გამორთვა" "$(setm ipd_orders false | jq -r .state)" "disabled"
R=$(setm mar true)
chk "mar-ის ჩართვა ipd_orders-ის გარეშე — 409 MODULE_PREREQ_MISSING" "$(echo "$R" | jq -r '.code'):$(echo "$R" | jq -r '.missing|join(",")')" "MODULE_PREREQ_MISSING:ipd_orders"
chk "ipd_orders → ჩართვა, შემდეგ mar" "$(setm ipd_orders true | jq -r .state):$(setm mar true | jq -r .state)" "active:active"
chk "mar-ის API — აქტიური (GET /inpatient/departments/:id/mar → არა 403)" "$([ "$(code GET "/inpatient/departments/$RND/mar" "$ADM")" != "403" ] && echo ok)" "ok"

step "3. guard: გამორთული მოდული — 403, კლინიკური ისტორია — ჩანს"
for c in lab_stock lab_gateway lab_external lab_qc lab_micro; do setm "$c" false >/dev/null; done
chk "ლაბ. ქვემოდულები გამორთულია" "$(mods | jq -r '[.[]|select(.code|IN("lab_stock","lab_gateway","lab_external","lab_qc","lab_micro"))|.state]|unique|join(",")')" "disabled"
chk "lab → გამორთვა" "$(setm lab false | jq -r .state)" "disabled"
R=$(api POST /lab-visits "$ADM" -d '{}')
chk "POST /lab-visits — 403 MODULE_DISABLED (მეთოდის დონე)" "$(echo "$R" | jq -r '.code // .statusCode')" "MODULE_DISABLED"
chk "GET /lab/worklist — 403" "$(code GET /lab/worklist "$ADM")" "403"
chk "GET /lab/qc/... (lab_qc) — 403" "$(code GET /lab/qc/materials "$ADM")" "403"
chk "ისტორია: GET /lab/items/:id — guard გადის (404, არა 403)" "$(code GET "/lab/items/$RND" "$ADM")" "404"
chk "ისტორია: GET /encounters/:id/lab-report — არა 403" "$([ "$(code GET "/encounters/$RND/lab-report" "$ADM")" != "403" ] && echo ok)" "ok"
chk "ისტორიაზე ჩაწერა: PUT /lab/items/:id/results — 403" "$(code PUT "/lab/items/$RND/results" "$ADM" -d '{}')" "403"
chk "დიაგნოსტიკის კატალოგი (რომელიმე: lab / radiology / endoscopy) — 200" "$(code GET /dx/catalog "$ADM")" "200"
REFS=$(api GET /worklist/refs "$ADM")
chk "სამუშაო სია: ლაბ. წყაროები — module_enabled false, რადიოლოგია — true" "$(echo "$REFS" | jq -r '[.sources[]|select(.code=="lab_collect" or .code=="lab_ext_due" or .code=="rad_report")|"\(.code)=\(.module_enabled)"]|sort|join(",")')" "lab_collect=false,lab_ext_due=false,rad_report=true"
CAPS=$(api GET /roles/capabilities "$ADM")
chk "უფლებები: 50 (უცვლელი); lab_doctor — module_active false, diagnostic — true (რომელიმე; 0087: + er_triage, er_doctor, er_manage)" "$(echo "$CAPS" | jq length):$(echo "$CAPS" | jq -r '[.[]|select(.code=="lab_doctor" or .code=="diagnostic")|"\(.code)=\(.module_active)"]|sort|join(",")')" "50:diagnostic=true,lab_doctor=false"
KP=$(api GET /reporting/meta "$ADM" | jq -r '[.kpis[]?.code]|join(",")')
chk "KPI: lab_orders დამალულია, dx_orders (ბირთვი) — ჩანს" "$(echo ",$KP," | grep -q ',lab_orders,' && echo shown || echo hidden):$(echo ",$KP," | grep -q ',dx_orders,' && echo shown || echo hidden)" "hidden:shown"
chk "lab → ჩართვა" "$(setm lab true | jq -r .state)" "active"
chk "GET /lab/worklist — 200" "$(code GET /lab/worklist "$ADM")" "200"
chk "KPI: lab_orders — ისევ ჩანს" "$(api GET /reporting/meta "$ADM" | jq -r '[.kpis[]?.code]|index("lab_orders")!=null')" "true"
for c in lab_stock lab_gateway lab_external lab_qc lab_micro; do setm "$c" true >/dev/null; done

step "4. ამბულატორია (მეთოდის დონე encounters-ში) და რადიოლოგია"
chk "outpatient → გამორთვა" "$(setm outpatient false | jq -r .state)" "disabled"
chk "POST /encounters/:id/vitals — 403" "$(code POST "/encounters/$RND/vitals" "$ADM" -d '{}')" "403"
chk "POST /encounters/:id/prescriptions — 403" "$(code POST "/encounters/$RND/prescriptions" "$ADM" -d '{}')" "403"
chk "GET /referrals — 403 (ReferralsController)" "$(code GET /referrals "$ADM")" "403"
chk "ბირთვი: GET /encounters — 200" "$(code GET /encounters "$ADM")" "200"
chk "outpatient → ჩართვა" "$(setm outpatient true | jq -r .state)" "active"
chk "radiology → გამორთვა" "$(setm radiology false | jq -r .state)" "disabled"
chk "GET /dx/report-worklist — 403" "$(code GET /dx/report-worklist "$ADM")" "403"
chk "ისტორია: GET /dx-orders/:id/report.pdf — არა 403" "$([ "$(code GET "/dx-orders/$RND/report.pdf" "$ADM")" != "403" ] && echo ok)" "ok"
chk "radiology → ჩართვა" "$(setm radiology true | jq -r .state)" "active"

step "5. სტაციონარი: გამორთვა იბლოკება, სანამ დამოკიდებულები ჩართულია"
R=$(setm inpatient false)
chk "inpatient — 409, დამოკიდებულები (drg, icu, ipc, ipd_orders, or)" "$(echo "$R" | jq -r '.code'):$(echo "$R" | jq -r '.dependents|sort|join(",")')" "MODULE_HAS_DEPENDENTS:drg,icu,ipc,ipd_orders,or"
chk "inpatient — აქტიური რჩება" "$(st inpatient)" "active"

restore; trap - EXIT
step "6. აღდგენა"
chk "ჩართვა / გამორთვა — როგორც დასაწყისში" "$(mods | jq -c '[.[]|{code, enabled}]')" "$ORIG"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
