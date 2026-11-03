#!/usr/bin/env bash
# =====================================================================
# matrix-profile-outpatient-lab.sh (0086, K / L) — პროფილი „ამბულატორია + ლაბორატორია“ (disable_others):
#   API: GET /modules/profiles, POST …/preview, POST …/apply (აუდიტი MODULE_PROFILE_APPLY);
#   სტაციონარი / საოპერაციო / რეანიმაცია … → 403; ამბულატორიული ვიზიტი → ლაბ. შეკვეთა → აღება → მიღება → შედეგი → ვალიდაცია →
#   მასალის ჩამოწერა პაციენტზე (საწყობი) → ანგარიში (ფასი ტარიფით) → გადახდა → სამუშაო სია / KPI მუშაობს.
#   ბოლოს: პროფილი „მრავალპროფილიანი“ + საწყისი ჩამრთველები (trap).
#   run-tests.sh --all-ში არ შედის (M): bash scripts/run-tests.sh 'matrix-*'
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
setm() { api PUT "/modules/$1" -d "{\"enabled\":$2,\"reason\":\"ტესტ-E2E პროფილი\"}"; }
act()  { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.active'; }
S=$(date +%s | tail -c 6); RND=00000000-0000-4000-8000-000000000000
D2Y=$(date -d '+2 years' +%F 2>/dev/null || date -v+2y +%F)

ORIG=$(mods | jq -c '[.[]|{code, enabled}]')
[ "$(echo "$ORIG" | jq length)" -gt 0 ] || die "GET /modules ვერ მოხერხდა"
NOTACT=$(mods | jq -r '[.[]|select(.enabled and .state!="active")|.code]|join(",")')
[ -z "$NOTACT" ] || die "ჩართული, მაგრამ არააქტიური მოდულები ($NOTACT) — საჭიროა ლიცენზია „ყველა“ ან dev"
restore() {
  api POST /modules/profiles/multi/apply -d '{"disable_others":false,"reason":"ტესტ-E2E: აღდგენა — მრავალპროფილიანი"}' >/dev/null
  local on off c
  on=$(echo "$ORIG" | jq -r '.[]|select(.enabled)|.code'); off=$(echo "$ORIG" | jq -r '.[]|select(.enabled|not)|.code')
  for _ in 1 2 3 4; do for c in $on; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "true" ] || setm "$c" true >/dev/null; done; done
  for _ in 1 2 3 4; do for c in $off; do [ "$(mods | jq -r --arg c "$c" '.[]|select(.code==$c)|.enabled')" = "false" ] || setm "$c" false >/dev/null; done; done
}
trap restore EXIT

step "1. პროფილები (API)"
PR=$(api GET /modules/profiles)
chk "3 პროფილი: outpatient_lab, elective_inpatient, multi" "$(echo "$PR" | jq -r '[.[].code]|join(",")')" "outpatient_lab,elective_inpatient,multi"
chk "outpatient_lab — 12 მოდული; multi — ყველა ოპციური" "$(echo "$PR" | jq -r '.[]|select(.code=="outpatient_lab")|.modules|length'):$(echo "$PR" | jq -r '.[]|select(.code=="multi")|.modules|length')" "12:$(mods | jq '[.[]|select(.core|not)]|length')"
chk "უცნობი პროფილი — 404" "$(code POST /modules/profiles/nope/preview -d '{}')" "404"
PV=$(api POST /modules/profiles/outpatient_lab/preview -d '{"disable_others":true}')
chk "preview (დანარჩენის გამორთვა): ჩასართავი 0 (ყველა ჩართულია), გამოსართავი — inpatient-ის ჩათვლით" \
  "$(echo "$PV" | jq '.enable|length'):$(echo "$PV" | jq -r '[.disable[].code]|index("inpatient")!=null'):$(echo "$PV" | jq -r '[.disable[].code]|index("lab")==null')" "0:true:true"
chk "preview: რიგი — დამოკიდებული ჯერ (mar inpatient-მდე)" "$(echo "$PV" | jq -r '[.disable[].code] as $d | ($d|index("mar")) < ($d|index("inpatient"))')" "true"
chk "preview ცვლილებას არ აკეთებს" "$(act inpatient)" "true"
PV0=$(api POST /modules/profiles/outpatient_lab/preview -d '{"disable_others":false}')
chk "preview (დანარჩენი რჩება): გამოსართავი არ არის" "$(echo "$PV0" | jq '.disable|length')" "0"
chk "apply მიზეზის გარეშე — 400" "$(code POST /modules/profiles/outpatient_lab/apply -d '{"disable_others":true}')" "400"

step "2. გამოყენება: outpatient_lab (disable_others)"
AP=$(api POST /modules/profiles/outpatient_lab/apply -d '{"disable_others":true,"reason":"ტესტ-E2E პროფილი"}')
chk "applied = true" "$(echo "$AP" | jq -r .applied)" "true"
chk "აქტიური ოპციური = პროფილის 12" "$(mods | jq -r '[.[]|select((.core|not) and .active)|.code]|sort|join(",")')" "finance,lab,lab_external,lab_gateway,lab_qc,lab_stock,outpatient,quality,reporting,stock,tariffs,worklist"
chk "სტაციონარი / საოპერაციო / რეანიმაცია / რადიოლოგია / აფთიაქი — 403" \
  "$(code GET /inpatient/census):$(code GET /or/roster):$(code GET /inpatient/icu/board):$(code GET /radiology/board):$(code GET /stock/controlled/summary)" "403:403:403:403:403"
chk "აუდიტი MODULE_PROFILE_APPLY" "$(api GET '/audit-logs?action=MODULE_PROFILE_APPLY&limit=5' | jq -r '(if type=="array" then . else .rows end)|map(select(.entity_id=="outpatient_lab"))|length > 0')" "true"
AP2=$(api POST /modules/profiles/outpatient_lab/apply -d '{"disable_others":true,"reason":"ტესტ-E2E პროფილი"}')
chk "განმეორებით — ცვლილება არ არის (applied = false)" "$(echo "$AP2" | jq -r .applied)" "false"

step "3. სცენარი: ამბულატორია → ლაბ. → მასალა → ანგარიში → გადახდა"
DEP=$(api GET "/departments?include_inactive=true" | jq -r '[.[]|select(.is_active and .type=="outpatient")][0].id // empty')
[ -n "$DEP" ] || DEP=$(api POST /departments -d "{\"name\":\"ტესტ-E2E ამბ. $S\",\"code\":\"PO$S\",\"type\":\"outpatient\"}" | jq -r '.id // empty')
TC=$(api POST /tariffs -d "{\"code\":\"E2E_PO_$S\",\"title\":\"ტესტ-E2E კონსულტაცია PO\",\"base_price\":30}" | jq -r '.id // empty')
DOC=$(api POST /users -d "{\"email\":\"e2e.po.doc.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"პროფილი\",\"personal_number\":\"99$(printf '%09d' "$((10#$S))")\",\"role\":\"doctor\",\"department_id\":\"$DEP\",\"specialty\":\"თერაპევტი\",\"license_number\":\"PO$S\",\"consultation_tariff_id\":\"$TC\"}" | jq -r '.user.id // empty')
PAT=$(api POST /patients -d "{\"personal_number\":\"5$(printf '%010d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"პროფილი\",\"birth_date\":\"1982-04-04\",\"gender\":\"female\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty')
[ -n "$DOC" ] && [ -n "$PAT" ] && ok "ექიმი + პაციენტი" || die "მომზადება ვერ მოხერხდა"
E=$(api POST /encounters/walk-in -d "{\"patient_id\":\"$PAT\",\"doctor_id\":\"$DOC\"}" | jq -r '.encounter_id // empty')
[ -n "$E" ] && ok "ამბულატორიული ვიზიტი" || die "ვიზიტი ვერ შეიქმნა"
SH=$(api GET "/invoices/encounter/$E" | jq -r '.patient_share // "0"')
[ "$(echo "$SH" | jq -r 'tonumber > 0')" = "true" ] && chk "კონსულტაციის გადახდა ($SH ₾)" "$(api POST "/encounters/$E/pay-initial" -d "{\"amount\":$SH,\"method\":\"cash\"}" | jq -r .status)" "active"
CAT=$(api GET '/dx/catalog?section=lab&orderable=true')
chk "კატალოგი (orderable): მხოლოდ ლაბ.; რადიოლოგია ცარიელი" "$([ "$(echo "$CAT" | jq length)" -gt 0 ] && echo lab):$(api GET '/dx/catalog?section=radiology&orderable=true' | jq length)" "lab:0"
SVC=$(echo "$CAT" | jq -r '[.[]|select(.performed_by!="external" and (.is_micro|not))][0].id // empty')
PRICE=$(echo "$CAT" | jq -r --arg s "$SVC" '.[]|select(.id==$s)|.base_price')
OR=$(api POST "/encounters/$E/dx-orders" -d "{\"items\":[{\"service_id\":\"$SVC\"}]}")
chk "ლაბ. შეკვეთა ვიზიტზე" "$(echo "$OR" | jq -r 'if type=="array" then "ok" elif .created then "ok" else (.code // .message) end')" "ok"
INV=$(api GET "/invoices/encounter/$E")
chk "ანგარიშში ანალიზი — ფასი ტარიფით ($PRICE ₾)" "$(echo "$INV" | jq -r --arg p "$PRICE" '[.lines[]|select((.unit_price|tonumber) == ($p|tonumber))]|length > 0')" "true"
SP=$(api POST "/encounters/$E/dx-collect" -d '{"identity_confirmed":true}')
BC=$(echo "$SP" | jq -r 'if type=="array" then .[0].barcode else empty end')
[ -n "$BC" ] && ok "ნიმუშის აღება (სინჯარა $BC)" || bad "ნიმუშის აღება" "$(echo "$SP" | jq -rc '.message // .')"
chk "ლაბორატორიაში მიღება" "$(api POST /lab/receive -d "{\"barcode\":\"$BC\"}" | jq -r '.barcode // .message')" "$BC"
IT=$(api GET "/lab/worklist?search=$BC" | jq -r '.[0].id // empty')
ITEM=$(api GET "/lab/items/$IT"); VALS=$(echo "$ITEM" | jq -c '[.analytes[]|{analyte_id:.id,value:"5"}]')
chk "შედეგი → resulted" "$(api PUT "/lab/items/$IT/results" -d "{\"values\":$VALS}" | jq -r '.status // .message')" "resulted"
chk "ვალიდაცია → validated" "$(api POST "/lab/items/$IT/validate" | jq -r '.status // .message')" "validated"
# მასალა პაციენტზე (საწყობი): ლოკაცია → საქონელი (ინვოისის კატეგორია) → მიღება → ხარჯი ვიზიტზე
LOC=$(api POST /stock/locations -d "{\"code\":\"E2E_PO_$S\",\"name\":\"ტესტ-E2E ამბ. ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\"}" | jq -r '.id // empty')
KCAT=$(api POST /stock/categories -d "{\"code\":\"E2E_PO$S\",\"name\":\"ტესტ-E2E ამბ. მასალა $S\",\"kind\":\"medical_supply\",\"billing_mode\":\"invoice\",\"markup_pct\":0}" | jq -r '.id // empty')
ITM=$(api POST /stock/items -d "{\"name\":\"ტესტ-E2E ბინტი $S\",\"category_id\":\"$KCAT\",\"base_unit\":\"piece\",\"sale_price\":4}" | jq -r '.id // empty')
RC=$(api POST /stock/receipts -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$ITM\",\"qty\":10,\"lot_no\":\"PO$S\",\"expires_on\":\"$D2Y\",\"price\":2,\"vat_rate\":0}]}" | jq -r '.id // empty')
chk "მარაგის მიღება (საწყობი)" "$(api POST "/stock/receipts/$RC/post" | jq -r '.status // .message')" "posted"
CN=$(api POST /stock/consumptions -d "{\"location_id\":\"$LOC\",\"patient_id\":\"$PAT\",\"encounter_id\":\"$E\",\"lines\":[{\"item_id\":\"$ITM\",\"qty_base\":2}]}")
chk "მასალის ჩამოწერა პაციენტზე → ინვოისში (2 × 4.00)" "$(echo "$CN" | jq -r '[.lines[]|"\(.invoiced):\(.sale_price)"]|join(",")')" "true:4.00"
chk "ლაბ. მარაგი (lab_stock) — 200" "$(code GET /stock/lab/kits)" "200"
INV=$(api GET "/invoices/encounter/$E"); DUE=$(echo "$INV" | jq -r '[(.patient_share|tonumber) - ([.payments[]?.amount|tonumber]|add // 0), 0]|max')
chk "ანგარიშში: ანალიზი + მასალა" "$(echo "$INV" | jq -r '[.lines[]|select((.unit_price|tonumber) == 4)]|length > 0')" "true"
if [ "$(jq -n "$DUE > 0")" = "true" ]; then
  chk "გადახდა (ნაშთი $DUE ₾)" "$(code POST "/invoices/$(echo "$INV" | jq -r .id)/payments" -d "{\"amount\":$DUE,\"method\":\"cash\"}")" "201"
else ok "გადასახდელი ნაშთი არ არის"; fi
chk "სამუშაო სია / KPI / დაფა — 200" "$(code GET /worklist/mine):$(code GET /worklist/count):$(code GET /reporting/dashboards)" "200:200:200"
chk "IPC / BME პორტები — ნეიტრალური (მოდული არ არის)" "$(api GET "/ipc/patients/$PAT/status" | jq -r .enabled):$(api GET '/bme/alerts?area=lab' | jq -r .enabled)" "false:false"

step "4. აღდგენა"
restore; trap - EXIT
chk "ჩართვა / გამორთვა — როგორც დასაწყისში" "$(mods | jq -c '[.[]|{code, enabled}]')" "$ORIG"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
