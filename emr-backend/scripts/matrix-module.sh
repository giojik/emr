#!/usr/bin/env bash
# =====================================================================
# matrix-module.sh (0086, L) — e2e მატრიცა: თითო ოპციური მოდული (29) სათითაოდ ითიშება და მოწმდება, რომ
#   1) მისი მთავარი endpoint → 403 MODULE_DISABLED (გამორთვამდე ჯერ ითიშება მისი დამოკიდებულები, უკუ რიგით);
#   2) GET /modules → active = false; frontend-ის მენიუს რუკაში (lib/moduleRoutes.ts) მისი მისამართები არააქტიურია;
#   3) დანარჩენზე smoke: პაციენტის ძებნა → ვიზიტი → ინვოისი → გადახდა; სტაციონარი; ლაბ. შეკვეთა (თუ lab აქტიურია);
#      /worklist/mine; რეპორტინგი — ყველა 200 (თუ შესაბამისი მოდული აქტიურია);
#   4) აღდგენა — მოდულები ბრუნდება საწყის მდგომარეობაში (trap; ტესტის ბოლოს — შემოწმება).
#   run-tests.sh --all-ში არ შედის (M): bash scripts/run-tests.sh 'matrix-*'   (≈ 5–8 წთ)
#   მოითხოვს: ლიცენზია არ არის (dev — ყველა მოდული) ან ლიცენზიაში ყველაა; ყველა ოპციური მოდული ჩართული.
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
api()  { local m=$1 p=$2; shift 2; curl -s -X "$m" "$B$p" -H "authorization: Bearer $ADM" -H "$J" "$@"; }
code() { local m=$1 p=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $ADM" -H "$J" "$@"; }
mods() { api GET /modules; }
setm() { api PUT "/modules/$1" -d "{\"enabled\":$2,\"reason\":\"ტესტ-E2E მატრიცა\"}"; }
S=$(date +%s | tail -c 6); RND=00000000-0000-4000-8000-000000000000
FE_MAP="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)/emr-frontend/src/lib/moduleRoutes.ts"

# მოდული → მთავარი endpoint (GET, არა @ClinicalHistory / @ModulePort) — guard ამოწმებს პარამეტრებამდე
declare -A EP=(
  [outpatient]=/referrals [inpatient]=/inpatient/census [ipd_orders]=/inpatient/orders/units [mar]=/inpatient/departments/$RND/mar
  [icu]=/inpatient/icu/board [or]=/or/roster [lab]=/lab/methods [lab_gateway]=/lab/gateway [lab_external]=/lab/external/mail/state
  [lab_qc]=/lab/qc/materials [lab_micro]=/lab/micro/refs [radiology]=/radiology/board [endoscopy]=/endo/scopes
  [stock]=/stock/minmax [pharmacy]=/stock/controlled/summary [lab_stock]=/stock/lab/kits [procurement]=/payables/summary
  [cssd]=/cssd/sets [asset_register]=/assets/summary [bme]=/bme/summary [tariffs]=/tariff-lists [finance]=/finance/summary
  [drg]=/drg/meta [scrubber]=/scrub/meta [reporting]=/reporting/dashboards [quality]=/quality/reports/meta [ipc]=/ipc/hai-catalog
  [roster]=/roster/refs [worklist]=/worklist/mine
)

# --- საწყისი მდგომარეობა
ORIG=$(mods | jq -c '[.[]|{code, enabled}]')
[ "$(echo "$ORIG" | jq length)" -gt 0 ] || die "GET /modules ვერ მოხერხდა"
NOTON=$(mods | jq -r '[.[]|select((.core|not) and (.enabled|not))|.code]|join(",")')
[ -z "$NOTON" ] || die "გამორთული მოდულები ($NOTON) — მატრიცას სჭირდება ყველა ჩართული (ადმინისტრირება → მოდულები → პროფილი „მრავალპროფილიანი“)"
NOTACT=$(mods | jq -r '[.[]|select(.enabled and .state!="active")|.code]|join(",")')
[ -z "$NOTACT" ] || die "ჩართული, მაგრამ არააქტიური მოდულები ($NOTACT) — საჭიროა ლიცენზია „ყველა“ ან dev (ლიცენზიის მოხსნა)"
ORDER=$(mods | jq -r '[.[]|select(.core|not)|.code]|join(" ")')   # რეესტრის რიგი (წინაპირობა წინ)
REG=$(mods | jq -c '[.[]|{code, dependents}]')
restore() {
  local on off c
  on=$(echo "$ORIG" | jq -r '.[]|select(.enabled)|.code'); off=$(echo "$ORIG" | jq -r '.[]|select(.enabled|not)|.code')
  for _ in 1 2 3 4; do for c in $on; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "true" ] || setm "$c" true >/dev/null; done; done
  for _ in 1 2 3 4; do for c in $off; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "false" ] || setm "$c" false >/dev/null; done; done
}
trap restore EXIT
# დამოკიდებულების ჩაკეტვა (ტრანზიტული) + თავად მოდული, გამოსართავი რიგით (დამოკიდებული ჯერ)
closure() {
  local want="$1" prev=""
  while [ "$want" != "$prev" ]; do prev="$want"
    want=$(echo "$REG" | jq -r --arg w "$want" '($w|split(" ")) as $s | [ $s[], (.[]|select(.code as $c|$s|index($c))|.dependents[]) ] | unique | join(" ")')
  done
  local out=""; for c in $ORDER; do [[ " $want " == *" $c "* ]] && out="$c $out"; done; echo "$out"
}
act() { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.active'; }
en()  { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.enabled'; }

step "0. მომზადება (პაციენტი, ექიმი, ლაბ. ანალიზი)"
DEP=$(api GET "/departments?include_inactive=true" | jq -r '[.[]|select(.is_active and .type=="outpatient")][0].id // empty')
[ -n "$DEP" ] || DEP=$(api POST /departments -d "{\"name\":\"ტესტ-E2E მატრიცა $S\",\"code\":\"MX$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty')
TC=$(api POST /tariffs -d "{\"code\":\"E2E_MX_$S\",\"title\":\"ტესტ-E2E კონსულტაცია MX\",\"base_price\":20}" | jq -r '.id // empty')
DOC=$(api POST /users -d "{\"email\":\"e2e.mx.doc.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მატრიცა\",\"personal_number\":\"97$(printf '%09d' "$((10#$S))")\",\"role\":\"doctor\",\"department_id\":\"$DEP\",\"specialty\":\"თერაპევტი\",\"license_number\":\"MX$S\",\"consultation_tariff_id\":\"$TC\"}" | jq -r '.user.id // empty')
PAT=$(api POST /patients -d "{\"personal_number\":\"7$(printf '%010d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"მატრიცა\",\"birth_date\":\"1980-01-01\",\"gender\":\"female\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
LABSVC=$(api GET "/dx/catalog?section=lab&orderable=true" | jq -r '[.[]|select(.performed_by!="external" and (.is_micro|not))][0].id // empty')
[ -n "$DOC" ] && [ -n "$PAT" ] && ok "ექიმი + პაციენტი" || die "მომზადება ვერ მოხერხდა (ექიმი: ${DOC:-—}, პაციენტი: ${PAT:-—})"
[ -n "$LABSVC" ] && ok "ლაბ. ანალიზი კატალოგში" || echo "  ⚠ ლაბ. კატალოგი ცარიელია — ლაბ. შეკვეთის smoke გამოტოვდება"

smoke() {   # $1 — გამორთული მოდული (ინფორმაციისთვის)
  local fails="" E INV SH c
  [ "$(code GET "/patients?search=E2E")" = "200" ] || fails+=" პაციენტის-ძებნა"
  E=$(api POST /encounters/walk-in -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOC\"}" | jq -r '.encounter_id // empty')
  if [ -z "$E" ]; then fails+=" ვიზიტი"; else
    INV=$(api GET "/invoices/encounter/$E"); SH=$(echo "$INV" | jq -r '.patient_share // "x"')
    [ "$SH" = "x" ] && fails+=" ინვოისი"
    if [ "$SH" != "x" ] && [ "$(echo "$SH" | jq -r 'tonumber > 0')" = "true" ]; then
      c=$(api POST "/encounters/$E/pay-initial" -d "{\"amount\":$SH,\"method\":\"cash\"}" | jq -r '.status // "x"'); [ "$c" = "active" ] || fails+=" გადახდა($c)"
    fi
    if [ -n "$LABSVC" ] && [ "$(act lab)" = "true" ] && [ "$(act outpatient)" = "true" ]; then
      c=$(code POST "/encounters/$E/dx-orders" -d "{\"items\":[{\"service_id\":\"$LABSVC\"}]}"); [[ "$c" == 20? ]] || fails+=" ლაბ.შეკვეთა($c)"
    fi
    api POST "/encounters/$E/cancel" -d '{"reason":"ტესტ-E2E მატრიცა"}' >/dev/null 2>&1 || true
  fi
  if [ "$(act inpatient)" = "true" ]; then c=$(code GET /inpatient/census); [ "$c" = "200" ] || fails+=" სტაციონარი($c)"; fi
  if [ "$(act worklist)" = "true" ]; then c=$(code GET /worklist/mine); [ "$c" = "200" ] || fails+=" worklist($c)"; fi
  if [ "$(act reporting)" = "true" ]; then c=$(code GET /reporting/dashboards); [ "$c" = "200" ] || fails+=" რეპორტინგი($c)"; fi
  c=$(code GET /worklist/count); [ "$c" = "200" ] || fails+=" worklist/count-პორტი($c)"
  echo "${fails:-ok}"
}

step "1. მატრიცა (29 მოდული)"
for M in $ORDER; do
  CL=$(closure "$M")
  # რამდენიმე გავლა: 409-ზე (დამოკიდებული ჯერ ჩართულია) — შემდეგ გავლაზე; რიგი ჯგუფებს შორის არ არის ტოპოლოგიური
  for _ in 1 2 3 4 5 6; do for c in $CL; do [ "$(en "$c")" = "false" ] || setm "$c" false >/dev/null; done; done
  LEFT=$(for c in $CL; do [ "$(en "$c")" = "true" ] && echo -n "$c "; done); [ -z "$LEFT" ] || bad "$M: გამორთვა ვერ მოხერხდა" "$LEFT"
  R=$(api GET "${EP[$M]}")
  chk "$M ($(echo "$CL" | wc -w) გამორთული): ${EP[$M]} → 403 MODULE_DISABLED · /modules active=false" \
    "$(code GET "${EP[$M]}"):$(echo "$R" | jq -r '.code // "—"'):$(act "$M")" "403:MODULE_DISABLED:false"
  if [ -f "$FE_MAP" ]; then
    NR=$(grep -c "'$M'" "$FE_MAP" || true)
    ok "$M: მენიუს რუკა — $NR მისამართი იმალება (moduleRoutes.ts; state ≠ active)"
  fi
  SM=$(smoke "$M"); chk "$M გამორთულია — smoke დანარჩენზე" "$SM" "ok"
  for _ in 1 2 3 4 5 6; do for c in $(echo "$CL" | tr ' ' '\n' | tac); do [ "$(en "$c")" = "true" ] || setm "$c" true >/dev/null; done; done
  [ "$(act "$M")" = "true" ] || bad "$M: აღდგენა" "$(mods | jq -rc --arg c "$M" '.[]|select(.code==$c)|{state,missing}')"
done

restore; trap - EXIT
step "2. აღდგენა"
chk "ჩართვა / გამორთვა — როგორც დასაწყისში" "$(mods | jq -c '[.[]|{code, enabled}]')" "$ORIG"
api PATCH "/users/$DOC" -d '{"is_active":false}' >/dev/null 2>&1 || true

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
