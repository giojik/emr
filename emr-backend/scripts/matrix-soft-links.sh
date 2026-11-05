#!/usr/bin/env bash
# =====================================================================
# matrix-soft-links.sh (0086, B / C / E) — რბილი კავშირები: A მუშაობს B-ს გარეშე, B-ს ნაწილი ჩუმად არ სრულდება / არ ჩანს.
#   1) რეესტრის ყველა წყვილი A → B (GET /modules → soft): B (+ მისი დამოკიდებულები) ითიშება → A-ს მთავარი endpoint არ არის 403,
#      B-ს endpoint — 403; თუ B-ს გამორთვა A-საც თიშავს (მკაცრი ჯაჭვი, მაგ. mar → stock) — წყვილი მხოლოდ read_only-ზეა რელევანტური (გამოტოვება);
#   2) 8 @ModulePort — არააქტიურ მოდულზე 200 + ნეიტრალური პასუხი (enabled: false / ცარიელი სია);
#   3) კონკრეტული წყვილები: or → stock (მასალის ბლოკი 403, ოქმის ხედში stock: false), or → cssd, outpatient → lab (კატალოგი orderable),
#      lab → outpatient (შეკვეთა არააქტიურ ვიზიტზე — 403), inpatient → ipc (MDRO / სტატუსი), mar / icu (NEWS2) — რეესტრით;
#   4) C — ძველი მონაცემი: ლაბ. შეკვეთა → lab გამორთვა → GET ჩანს (ისტორია), POST 403; ვიტალები → outpatient გამორთვა → ვიზიტზე ჩანს, POST 403;
#   5) E — კონფიგურაციის პაკეტი: scrubber ჩართული + drg გამორთული → preview error MODULE_HAS_DEPENDENTS, import 409; drg ჩართვა
#      inpatient-ის გარეშე → MODULE_PREREQ_MISSING; სწორი პაკეტი → გადის.
#   run-tests.sh --all-ში არ შედის (M): bash scripts/run-tests.sh 'matrix-*'
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
J='content-type: application/json'
PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
skip() { printf '  \033[36m–\033[0m %s\n' "$1"; SKIP=$((SKIP+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mშეწყდა:\033[0m %s\n' "$1"; exit 1; }
command -v jq >/dev/null || die "jq არ არის დაყენებული"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')"; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა"
api()  { local m=$1 p=$2; shift 2; curl -s -X "$m" "$B$p" -H "authorization: Bearer $ADM" -H "$J" "$@"; }
code() { local m=$1 p=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $ADM" -H "$J" "$@"; }
upl()  { curl -s -X POST "$B$1" -H "authorization: Bearer $ADM" -F "file=@$2;type=application/json"; }
mods() { api GET /modules; }
setm() { api PUT "/modules/$1" -d "{\"enabled\":$2,\"reason\":\"ტესტ-E2E რბილი კავშირები\"}"; }
act()  { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.active'; }
S=$(date +%s | tail -c 6); RND=00000000-0000-4000-8000-000000000000
TMP=$(mktemp -d)

declare -A EP=(
  [outpatient]=/referrals [inpatient]=/inpatient/census [ipd_orders]=/inpatient/orders/units [mar]=/inpatient/departments/$RND/mar
  [icu]=/inpatient/icu/board [or]=/or/roster [lab]=/lab/methods [lab_gateway]=/lab/gateway [lab_external]=/lab/external/mail/state
  [lab_qc]=/lab/qc/materials [lab_micro]=/lab/micro/refs [radiology]=/radiology/board [endoscopy]=/endo/scopes
  [stock]=/stock/minmax [pharmacy]=/stock/controlled/summary [lab_stock]=/stock/lab/kits [procurement]=/payables/summary
  [cssd]=/cssd/sets [asset_register]=/assets/summary [bme]=/bme/summary [tariffs]=/tariff-lists [finance]=/finance/summary
  [drg]=/drg/meta [scrubber]=/scrub/meta [reporting]=/reporting/dashboards [quality]=/quality/reports/meta [ipc]=/ipc/hai-catalog
  [roster]=/roster/refs [worklist]=/worklist/mine [er]=/er/board
)

ORIG=$(mods | jq -c '[.[]|{code, enabled}]')
[ "$(echo "$ORIG" | jq length)" -gt 0 ] || die "GET /modules ვერ მოხერხდა"
NOTON=$(mods | jq -r '[.[]|select((.core|not) and (.state!="active"))|.code]|join(",")')
[ -z "$NOTON" ] || die "არააქტიური მოდულები ($NOTON) — საჭიროა ყველა ჩართული და აქტიური (dev / ლიცენზია „ყველა“)"
ORDER=$(mods | jq -r '[.[]|select(.core|not)|.code]|join(" ")')
REG=$(mods | jq -c '[.[]|{code, dependents, soft}]')
restore() {
  local on off c
  on=$(echo "$ORIG" | jq -r '.[]|select(.enabled)|.code'); off=$(echo "$ORIG" | jq -r '.[]|select(.enabled|not)|.code')
  for _ in 1 2 3 4; do for c in $on; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "true" ] || setm "$c" true >/dev/null; done; done
  for _ in 1 2 3 4; do for c in $off; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "false" ] || setm "$c" false >/dev/null; done; done
  rm -rf "$TMP"
}
trap restore EXIT
closure() {
  local want="$1" prev=""
  while [ "$want" != "$prev" ]; do prev="$want"
    want=$(echo "$REG" | jq -r --arg w "$want" '($w|split(" ")) as $s | [ $s[], (.[]|select(.code as $c|$s|index($c))|.dependents[]) ] | unique | join(" ")')
  done
  local out=""; for c in $ORDER; do [[ " $want " == *" $c "* ]] && out="$c $out"; done; echo "$out"
}
# რამდენიმე გავლა: 409-ზე (დამოკიდებული / წინაპირობა ჯერ არ შეცვლილა) შემდეგ გავლაზე გაიმეორებს — რიგი ჯგუფებს შორის არ არის ტოპოლოგიური
en()  { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.enabled'; }
off() { local c cl; cl=$(closure "$1"); for _ in 1 2 3 4 5 6; do for c in $cl; do [ "$(en "$c")" = "false" ] || setm "$c" false >/dev/null; done; done; }
on()  { local c cl; cl=$(closure "$1"); for _ in 1 2 3 4 5 6; do for c in $(echo "$cl" | tr ' ' '\n' | tac); do [ "$(en "$c")" = "true" ] || setm "$c" true >/dev/null; done; done; }

step "0. მომზადება"
DEP=$(api GET "/departments?include_inactive=true" | jq -r '[.[]|select(.is_active and .type=="outpatient")][0].id // empty')
[ -n "$DEP" ] || DEP=$(api POST /departments -d "{\"name\":\"ტესტ-E2E რბილი $S\",\"code\":\"SL$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty')
TC=$(api POST /tariffs -d "{\"code\":\"E2E_SL_$S\",\"title\":\"ტესტ-E2E კონსულტაცია SL\",\"base_price\":20}" | jq -r '.id // empty')
DOC=$(api POST /users -d "{\"email\":\"e2e.sl.doc.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"რბილი\",\"personal_number\":\"98$(printf '%09d' "$((10#$S))")\",\"role\":\"doctor\",\"department_id\":\"$DEP\",\"specialty\":\"თერაპევტი\",\"license_number\":\"SL$S\",\"consultation_tariff_id\":\"$TC\"}" | jq -r '.user.id // empty')
PAT=$(api POST /patients -d "{\"personal_number\":\"8$(printf '%010d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"რბილი\",\"birth_date\":\"1979-02-02\",\"gender\":\"male\",\"phone_number\":\"596$S\"}" | jq -r '.id // empty')
[ -n "$DOC" ] && [ -n "$PAT" ] && ok "ექიმი + პაციენტი" || die "მომზადება ვერ მოხერხდა"
visit() {   # აქტიური ამბულატორიული ვიზიტი → encounter_id
  local E SH; E=$(api POST /encounters/walk-in -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOC\"}" | jq -r '.encounter_id // empty')
  SH=$(api GET "/invoices/encounter/$E" | jq -r '.patient_share // "0"')
  [ "$(echo "$SH" | jq -r 'tonumber > 0')" = "true" ] && api POST "/encounters/$E/pay-initial" -d "{\"amount\":$SH,\"method\":\"cash\"}" >/dev/null
  echo "$E"
}
LABSVC=$(api GET "/dx/catalog?section=lab&orderable=true" | jq -r '[.[]|select(.performed_by!="external" and (.is_micro|not))][0].id // empty')

step "1. რეესტრის ყველა რბილი წყვილი (A მუშაობს B-ს გარეშე)"
PAIRS=$(echo "$REG" | jq -r '.[]|.code as $a|.soft[]|"\($a)>\(.)"')
chk "რბილი წყვილები რეესტრში: 0086-ის 4 ახალი (lab → worklist, or → ipc, stock → cssd, bme → procurement)" "$(echo "$PAIRS" | grep -cxE 'lab>worklist|or>ipc|stock>cssd|bme>procurement')" "4"
chk "0087: er → roster რეესტრში (მორიგე ექიმი დაფაზე)" "$(echo "$PAIRS" | grep -cx 'er>roster')" "1"
chk "0088: er → lab / radiology / endoscopy რეესტრში (დიაგნოსტიკა ER-ის შემთხვევაზე)" "$(echo "$PAIRS" | grep -cxE 'er>lab|er>radiology|er>endoscopy')" "3"
chk "0089: er → stock / pharmacy რეესტრში (ჩამოწერა / დოზა-ურთიერთქმედება)" "$(echo "$PAIRS" | grep -cxE 'er>stock|er>pharmacy')" "2"
chk "0090: er → inpatient / ipd_orders რეესტრში (ჰოსპიტალიზაცია / დანიშნულებების გადატანა)" "$(echo "$PAIRS" | grep -cxE 'er>inpatient|er>ipd_orders')" "2"
chk "0091: er → worklist რეესტრში (ER-ის სამუშაო სიები)" "$(echo "$PAIRS" | grep -cx 'er>worklist')" "1"
echo "  (წყვილები სულ: $(echo "$PAIRS" | wc -l | tr -d ' '))"
for P in $PAIRS; do
  A=${P%>*}; Bm=${P#*>}; CL=$(closure "$Bm")
  if [[ " $CL " == *" $A "* ]]; then skip "$A → $Bm: B-ს გამორთვა A-საც თიშავს (მკაცრი ჯაჭვი: $CL) — მხოლოდ read_only-ზე"; continue; fi
  off "$Bm"
  CA=$(code GET "${EP[$A]}"); CB=$(code GET "${EP[$Bm]}")
  chk "$A → $Bm off: A ${EP[$A]} ≠ 403 · B ${EP[$Bm]} = 403" "$([ "$CA" != "403" ] && [ "$CA" != "500" ] && echo ok || echo "A=$CA"):$CB" "ok:403"
  on "$Bm"
done

step "2. @ModulePort — ნეიტრალური პასუხი არააქტიურ მოდულზე"
off bme
chk "bme off: GET /bme/alerts?area=or → 200, enabled false, items []" "$(code GET '/bme/alerts?area=or'):$(api GET '/bme/alerts?area=or' | jq -c '[.enabled,.mode,(.items|length)]')" '200:[false,"off",0]'
chk "bme off: POST /bme/repairs/run-jobs → enabled false" "$(api POST /bme/repairs/run-jobs -d '{}' | jq -r .enabled)" "false"
chk "bme off: POST /bme/pm/run-reminders → enabled false" "$(api POST /bme/pm/run-reminders -d '{}' | jq -r .enabled)" "false"
on bme
off ipc
chk "ipc off: GET /ipc/patients/:id/status → 200, enabled false" "$(code GET "/ipc/patients/$PAT/status"):$(api GET "/ipc/patients/$PAT/status" | jq -r .enabled)" "200:false"
chk "ipc off: GET /ipc/stays/:id/hai → 200, []" "$(code GET "/ipc/stays/$RND/hai"):$(api GET "/ipc/stays/$RND/hai" | jq -c .)" "200:[]"
on ipc
off roster
chk "roster off: GET /roster/lookup/now → 200, enabled false, people []" "$(code GET '/roster/lookup/now?purpose=consult'):$(api GET '/roster/lookup/now?purpose=consult' | jq -c '[.enabled,(.people|length)]')" "200:[false,0]"
on roster
off worklist
chk "worklist off: GET /worklist/count → 200, enabled false" "$(code GET /worklist/count):$(api GET /worklist/count | jq -r .enabled)" "200:false"
on worklist
off scrubber
chk "scrubber off: GET /scrub/stays/:eid → guard გადის (404 — ინვოისი არ არის, არა 403)" "$(code GET "/scrub/stays/$RND")" "404"
on scrubber

step "3. კონკრეტული წყვილები"
off lab
chk "outpatient → lab off: კატალოგი orderable — lab სექცია ცარიელი; ადმინის კატალოგი — სრული" \
  "$(api GET '/dx/catalog?section=lab&orderable=true' | jq length):$([ "$(api GET '/dx/catalog?section=lab' | jq length)" -gt 0 ] && echo full || echo empty)" "0:full"
E=$(visit)
[ -n "$LABSVC" ] && chk "outpatient → lab off: POST dx-orders (lab) → 403 MODULE_DISABLED" "$(api POST "/encounters/$E/dx-orders" -d "{\"items\":[{\"service_id\":\"$LABSVC\"}]}" | jq -r .code)" "MODULE_DISABLED"
on lab
off outpatient
E2=$(api POST /encounters/walk-in -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOC\"}" | jq -r '.encounter_id // empty')
[ -n "$LABSVC" ] && [ -n "$E" ] && chk "lab → outpatient off: ლაბ. შეკვეთა ამბულატორიულ ვიზიტზე → 403 (ლაბ. ვიზიტი — თავად lab)" "$(api POST "/encounters/$E/dx-orders" -d "{\"items\":[{\"service_id\":\"$LABSVC\"}]}" | jq -r .code)" "MODULE_DISABLED"
chk "outpatient off: ბირთვი — walk-in ვიზიტი (encounters) იქმნება" "$([ -n "$E2" ] && echo ok)" "ok"
on outpatient
off stock
chk "or → stock off: მასალის ნაშთი (GET /or/cases/:id/materials/stock) → 403" "$(code GET "/or/cases/$RND/materials/stock")" "403"
chk "or → stock off: OR ბირთვი (GET /or/roster) — 200" "$(code GET /or/roster)" "200"
on stock
off cssd
chk "or → cssd off: შეფუთვის დამატება (POST /or/cases/:id/packs) → 403" "$(code POST "/or/cases/$RND/packs" -d '{"code":"PK-000001"}')" "403"
on cssd
off drg
chk "inpatient → drg off: სტაციონარი 200, DRG 403" "$(code GET /inpatient/census):$(code GET /drg/meta)" "200:403"
on drg

step "4. C — ძველი მონაცემი გამორთულ მოდულზე: წასაკითხად ჩანს, ახალი — 403"
E=$(visit)
if [ -n "$LABSVC" ]; then
  chk "ლაბ. შეკვეთა (lab აქტიურია)" "$(code POST "/encounters/$E/dx-orders" -d "{\"items\":[{\"service_id\":\"$LABSVC\"}]}")" "201"
  off lab
  chk "lab off: GET /encounters/:id/dx-orders — 200, შეკვეთა ჩანს" "$(code GET "/encounters/$E/dx-orders"):$(api GET "/encounters/$E/dx-orders" | jq 'length > 0')" "200:true"
  chk "lab off: ახალი შეკვეთა — 403" "$(code POST "/encounters/$E/dx-orders" -d "{\"items\":[{\"service_id\":\"$LABSVC\"}]}")" "403"
  on lab
else skip "ლაბ. კატალოგი ცარიელია"; fi
chk "ვიტალები (outpatient აქტიურია)" "$(code POST "/encounters/$E/vitals" -d '{"heart_rate":72,"systolic_bp":120,"diastolic_bp":80}')" "201"
off outpatient
chk "outpatient off: ვიზიტზე ვიტალები ჩანს (GET /encounters/:id)" "$(api GET "/encounters/$E" | jq '(.vitals // []) | length > 0')" "true"
chk "outpatient off: ახალი ვიტალი — 403" "$(code POST "/encounters/$E/vitals" -d '{"heart_rate":70}')" "403"
on outpatient

step "5. E — კონფიგურაციის პაკეტი: მოდულების საბოლოო მდგომარეობა"
api GET '/config-package?parts=modules' > "$TMP/base.json"
chk "ექსპორტი (modules: drg, scrubber)" "$(jq -r '[.parts.modules[].code]|join(",")' "$TMP/base.json")" "drg,scrubber"
jq '.parts.modules |= map(if .code=="drg" then .enabled=false else .enabled=true end)' "$TMP/base.json" > "$TMP/bad1.json"
R=$(upl '/config-package/preview?parts=modules' "$TMP/bad1.json")
chk "drg off + scrubber on → preview: drg — MODULE_HAS_DEPENDENTS, scrubber — MODULE_PREREQ_MISSING (ერთად)" "$(echo "$R" | jq -r '[.lines[]|select(.part=="modules" and .action=="error")|"\(.key):\(.code)"]|join(",")')" "drg:MODULE_HAS_DEPENDENTS,scrubber:MODULE_PREREQ_MISSING"
R=$(upl '/config-package/import?parts=modules' "$TMP/bad1.json")
chk "import → 409 (პირველი შეცდომის კოდი); drg ჩართული რჩება" "$(echo "$R" | jq -r '.code // .statusCode'):$(act drg)" "MODULE_HAS_DEPENDENTS:true"
off inpatient   # inpatient + დამოკიდებულები (drg, scrubber, icu, ipc, ipd_orders, mar, or)
jq '.parts.modules |= map(.enabled=true)' "$TMP/base.json" > "$TMP/bad2.json"
R=$(upl '/config-package/preview?parts=modules' "$TMP/bad2.json")
chk "drg on inpatient-ის გარეშე → preview: MODULE_PREREQ_MISSING" "$(echo "$R" | jq -r '[.lines[]|select(.key=="drg")|.code]|join(",")')" "MODULE_PREREQ_MISSING"
chk "import → 409 MODULE_PREREQ_MISSING" "$(upl '/config-package/import?parts=modules' "$TMP/bad2.json" | jq -r '.code // .statusCode')" "MODULE_PREREQ_MISSING"
on inpatient
R=$(upl '/config-package/import?parts=modules' "$TMP/base.json")
chk "სწორი პაკეტი (საწყისი) — import გადის" "$(echo "$R" | jq -r 'if .lines then "ok" else (.code // .message) end')" "ok"
chk "drg / scrubber — აქტიური" "$(act drg):$(act scrubber)" "true:true"

restore; trap - EXIT
step "6. აღდგენა"
chk "ჩართვა / გამორთვა — როგორც დასაწყისში" "$(mods | jq -c '[.[]|{code, enabled}]')" "$ORIG"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m  (გამოტოვებული: %s)\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
