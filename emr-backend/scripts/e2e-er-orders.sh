#!/usr/bin/env bash
# =====================================================================
# e2e-er-orders.sh — გადაუდებელი დახმარება (ER), ეტაპი 2 / 4 (0089, ყოფილი „0088b“): დანიშვნა / მიცემა / ჩამოწერა
#   • პარამეტრები (prn_max_h, verbal_orders, verbal_confirm_h, double_check, dose_rule, allow_no_stock, stock_deduct, stat_due_min) — ვალიდაცია;
#     რეესტრი: er → stock / pharmacy (რბილი);
#   • დანიშვნა: STAT / ერთჯერადი / PRN (ვადა prn_max_h), მედიკამენტი / ინფუზია / პროცედურა, კატალოგი / თავისუფალი ტექსტი, doctor_write team / attending;
#     შემოწმებები: ალერგია (ყოველთვის; მძიმე — დასაბუთება + დადასტურება), დოზის ზღვარი (dose_rule warn / reason), ურთიერთქმედება, დუბლირება, ბავშვის წონა (გაფრთხილება);
#   • ზეპირი: ექთანი ექიმის სახელით → შეტყობინება ექიმს → დადასტურება; verbal_orders off → 403;
#   • მიცემა: უფლებები (ER-ის ექთანი / ექიმი, ER-ის განყოფილების ექთანი; სხვა განყოფილება — 403), ჩამოწერა ER-ის ქვესაწყობიდან (FEFO, ნაშთი),
#     STAT / ერთჯერადი → შესრულებული, უარი / გადადება მიზეზით, PRN ინტერვალი / მაქსიმუმი (დასაბუთება), ინფუზია დაწყება / დასრულება,
#     ნარკოტიკული — მოწმე, მაღალი რისკი — ორმაგი შემოწმება (double_check), ნაშთის გარეშე (allow_no_stock), გაუქმება — შემობრუნება;
#   • დაფა / ბარათი: შეუსრულებელი / ზეპირი ნიშნები; ER-ის შემთხვევის გაუქმება მიცემის შემდეგ — 409;
#   • რბილი: pharmacy off → დოზა / ურთიერთქმედება არ მოწმდება (ალერგია — კი); stock off → კატალოგი / ჩამოწერა არ არის, მიცემა იწერება;
#     inpatient off → ER-ის დანიშვნა მუშაობს; er off → ისტორია ჩანს, ჩაწერა 403, მომიჯნავე არ ვარდება.
# ბოლოს: მიცემები გაუქმებულია (შემობრუნებით), შემთხვევები გაუქმებულია, მომხმარებლები / როლები / განყოფილებები / ლოკაციები გათიშულია, მოდულები / პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-er-orders.sh [API_URL]
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
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d)
ago() { date -u -d "-$1" +%FT%TZ; }
setm() { api PUT "/modules/$1" "$ADM" -d "{$2,\"reason\":\"ტესტ-E2E ER orders\"}"; }
sets() { api PUT /modules/er "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E ER orders\"}"; }
pid() { printf '%s%010d' "$1" "$(( (10#$S * 7 + $2) % 10000000000 ))"; }
TODAY=$(TZ=Asia/Tbilisi date +%F); D2Y=$(date -d "$TODAY +2 years" +%F)
bal() { api GET "/stock/balances?location_id=$1&item_id=$2" "$ADM" | jq -r '([.rows[].qty|tonumber]|add // 0) + 0'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0089" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0089" | tostring)')" "ok:true"
MODS=$(api GET /modules "$ADM")
ORIG=$(echo "$MODS" | jq -c '[.[]|{code, enabled}]')
ORIG_ER=$(echo "$MODS" | jq -c '.[]|select(.code=="er")|{enabled, settings}')
[ -n "$ORIG_ER" ] || die "მოდული er ვერ მოიძებნა"
for c in er stock pharmacy inpatient; do
  [ "$(echo "$MODS" | jq -r --arg c "$c" '.[]|select(.code==$c)|.state')" = "active" ] || die "მოდული $c არააქტიურია — e2e-ის წინ: ლიცენზიის მოხსნა („DEV — ყველა მოდული“)"
done
REG=$(echo "$MODS" | jq -c '[.[]|{code, dependents}]')
ORDER=$(echo "$MODS" | jq -r '[.[]|select(.core|not)|.code]|join(" ")')
mods() { api GET /modules "$ADM"; }
en()   { mods | jq -r --arg c "$1" '.[]|select(.code==$c)|.enabled'; }
closure() {
  local want="$1" prev=""
  while [ "$want" != "$prev" ]; do prev="$want"
    want=$(echo "$REG" | jq -r --arg w "$want" '($w|split(" ")) as $s | [ $s[], (.[]|select(.code as $c|$s|index($c))|.dependents[]) ] | unique | join(" ")')
  done
  local out=""; for c in $ORDER; do [[ " $want " == *" $c "* ]] && out="$c $out"; done; echo "$out"
}
modoff() { local c cl; cl=$(closure "$1"); for _ in 1 2 3 4 5 6; do for c in $cl; do [ "$(en "$c")" = "false" ] || setm "$c" '"enabled":false' >/dev/null; done; done; }
restore_mods() {
  local on c; on=$(echo "$ORIG" | jq -r '.[]|select(.enabled)|.code')
  for _ in 1 2 3 4 5; do for c in $on; do [ "$(en "$c")" = "true" ] || setm "$c" '"enabled":true' >/dev/null; done; done
}
cleanup() {
  restore_mods
  sets "$(echo "$ORIG_ER" | jq -c .settings)" >/dev/null
  if [ -f "$TMP/visits" ]; then while read -r e; do
    for a in $(api GET "/er/visits/$e/orders" "$ADM" | jq -r '.orders[]?.administrations[]|select(.voided_at==null)|.id'); do api POST "/er/administrations/$a/void" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
    api POST "/er/visits/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null
  done < "$TMP/visits"; fi
  [ -f "$TMP/items" ] && while read -r i; do api PATCH "/stock/items/$i" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/items"
  [ -f "$TMP/locs" ] && while read -r l; do api PATCH "/stock/locations/$l" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/locs"
  [ -f "$TMP/allergies" ] && while read -r p a; do api PATCH "/patients/$p/allergies/$a" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done < "$TMP/allergies"
  [ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
  [ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
  [ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
  rm -rf "$TMP"
}
trap cleanup EXIT
sets '{"prn_max_h":12,"verbal_orders":true,"verbal_confirm_h":4,"double_check":"off","dose_rule":"warn","allow_no_stock":true,"stock_deduct":true,"stat_due_min":15,"doctor_write":"team"}' >/dev/null
dep() { local id; id=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/deps"; echo "$id"; }
DER=$(dep "ER დანიშნულება" E2EOE emergency); DOT=$(dep "სხვა ER-O" E2EOO inpatient)
[ -n "$DER" ] && [ -n "$DOT" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_ero_$1_$S\",\"name\":\"ტესტ-E2E ER-O $1\",\"capabilities\":$2}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_ero_$1_$S"; }; }
R_TR=$(mkrole tr '["er_triage"]'); R_DR=$(mkrole dr '["er_doctor"]')
[ -n "$R_TR" ] && [ -n "$R_DR" ] || die "როლები ვერ შეიქმნა"
mkuser() {   # <roles-json> <n> <department> → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ero.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"ERO-$2\",\"personal_number\":\"$(pid 7 "$2")\",\"roles\":$1,\"department_id\":\"$3\",\"specialty\":\"ტესტი\",\"license_number\":\"ERO$2$S\"}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.ero.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
wit() { echo "{\"username\":\"e2e.ero.$1.$S@test.local\",\"password\":\"${2:-E2e-$S-pass-$1}\"}"; }
read -r TRID TR <<< "$(mkuser "[\"$R_TR\"]" 31 "$DER")"
read -r T2ID T2 <<< "$(mkuser "[\"$R_TR\"]" 32 "$DER")"
read -r DRID DR <<< "$(mkuser "[\"$R_DR\"]" 33 "$DER")"
read -r D2ID D2 <<< "$(mkuser "[\"$R_DR\"]" 34 "$DER")"
read -r NRID NR <<< "$(mkuser '["nurse"]' 35 "$DER")"
read -r NXID NX <<< "$(mkuser '["nurse"]' 36 "$DOT")"
[ -n "${TR:-}" ] && [ -n "${T2:-}" ] && [ -n "${DR:-}" ] && [ -n "${D2:-}" ] && [ -n "${NR:-}" ] && [ -n "${NX:-}" ] || die "მომხმარებლები ვერ შეიქმნა"
ok "მომხმარებლები: 2 ER-ის ექთანი (er_triage), 2 ER-ის ექიმი (er_doctor), ER-ის განყოფილების ექთანი (nurse), სხვა განყოფილების ექთანი"

# --- კატალოგი / საწყობი
gen() { api POST /pharmacy/generics "$ADM" -d "$1" | jq -r '.id // empty'; }
G_KET=$(gen "{\"inn\":\"ტესტ-E2E ERO კეტოროლაკი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"30 მგ/მლ\",\"dose_unit\":\"mg\",\"dose_per_unit\":30,\"routes\":[\"IV\",\"IM\"],\"max_single_dose\":30,\"max_daily_dose\":90}")
G_WAR=$(gen "{\"inn\":\"ტესტ-E2E ERO ვარფარინი $S\",\"form_code\":\"TAB\",\"strength\":\"5 მგ\",\"dose_unit\":\"mg\",\"dose_per_unit\":5,\"routes\":[\"PO\"]}")
G_MOR=$(gen "{\"inn\":\"ტესტ-E2E ERO მორფინი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ/მლ\",\"controlled_class\":\"narcotic\",\"dose_unit\":\"mg\",\"dose_per_unit\":10,\"routes\":[\"IV\",\"SC\"]}")
G_HEP=$(gen "{\"inn\":\"ტესტ-E2E ERO ჰეპარინი $S\",\"form_code\":\"INJ_SOL\",\"strength\":\"5000 ერთ.\",\"dose_unit\":\"IU\",\"dose_per_unit\":5000,\"routes\":[\"IV\",\"SC\"],\"high_alert\":true}")
G_NS=$(gen "{\"inn\":\"ტესტ-E2E ERO ნატრიუმის ქლორიდი 0.9% $S\",\"form_code\":\"INF_SOL\",\"strength\":\"500 მლ\",\"routes\":[\"IV\"]}")
G_NOS=$(gen "{\"inn\":\"ტესტ-E2E ERO ომეპრაზოლი $S\",\"form_code\":\"CAP\",\"strength\":\"20 მგ\",\"dose_unit\":\"mg\",\"dose_per_unit\":20,\"routes\":[\"PO\"]}")
for g in G_KET G_WAR G_MOR G_HEP G_NS G_NOS; do [ -n "${!g}" ] || die "ჯენერიკი $g ვერ შეიქმნა"; done
api POST /pharmacy/interactions "$ADM" -d "{\"a_generic_id\":\"$G_KET\",\"b_generic_id\":\"$G_WAR\",\"severity\":\"major\",\"effect\":\"ტესტ-E2E სისხლდენის რისკი\"}" >/dev/null
PHL=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EOP$S\",\"name\":\"ტესტ-E2E ERO აფთიაქი $S\",\"kind\":\"pharmacy\"}" | jq -r '.id // empty')
LOC=$(api POST /stock/locations "$ADM" -d "{\"code\":\"E2EOL$S\",\"name\":\"ტესტ-E2E ERO ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DER\",\"requires_approval\":false}" | jq -r '.id // empty')
[ -n "$PHL" ] && [ -n "$LOC" ] || die "ლოკაციები ვერ შეიქმნა"; printf '%s\n%s\n' "$LOC" "$PHL" >> "$TMP/locs"
CAT=$(api GET /stock/refs "$ADM" | jq -r '.categories[]|select(.kind=="medication")|.id' | head -1)
item() { local i; i=$(api POST /stock/items "$ADM" -d "{\"name\":\"ტესტ-E2E ERO $1 $S\",\"category_id\":\"$CAT\",\"generic_id\":\"$2\",\"base_unit\":\"$3\"}" | jq -r '.id // empty'); [ -n "$i" ] && echo "$i" >> "$TMP/items"; echo "$i"; }
IT_KET=$(item "Ketorolac 30" "$G_KET" ampoule); IT_WAR=$(item "Warfarin 5" "$G_WAR" tablet); IT_MOR=$(item "Morphini 1%" "$G_MOR" ampoule)
IT_HEP=$(item "Heparin 5000" "$G_HEP" ampoule); IT_NS=$(item "NaCl 0.9% 500" "$G_NS" bottle)
for i in IT_KET IT_WAR IT_MOR IT_HEP IT_NS; do [ -n "${!i}" ] || die "SKU $i ვერ შეიქმნა"; done
ln() { echo "{\"item_id\":\"$1\",\"qty\":$2,\"lot_no\":\"$3$S\",\"expires_on\":\"$D2Y\",\"price\":1,\"vat_rate\":0}"; }
RCP=$(api POST /stock/receipts "$ADM" -d "{\"location_id\":\"$PHL\",\"lines\":[$(ln "$IT_KET" 10 K),$(ln "$IT_WAR" 10 W),$(ln "$IT_MOR" 10 M),$(ln "$IT_HEP" 10 H),$(ln "$IT_NS" 10 N)]}" | jq -r '.id // empty')
api POST "/stock/receipts/$RCP/post" "$ADM" >/dev/null
LINES=$(for i in "$IT_KET" "$IT_WAR" "$IT_MOR" "$IT_HEP" "$IT_NS"; do api GET "/stock/items/$i/lots" "$ADM" | jq -c '{lot_id:.[0].id, qty_base:5}'; done | jq -sc .)
TRF=$(api POST /stock/transfers "$ADM" -d "{\"doc_type\":\"transfer\",\"from_location_id\":\"$PHL\",\"to_location_id\":\"$LOC\",\"lines\":$LINES}" | jq -r '.id // empty')
api POST "/stock/docs/$TRF/receive" "$ADM" -d '{"action":"receive"}' >/dev/null
chk "ER-ის ქვესაწყობი: 5 SKU × 5 (ომეპრაზოლი — SKU-ს გარეშე)" "$(bal "$LOC" "$IT_KET"):$(bal "$LOC" "$IT_MOR"):$(bal "$LOC" "$IT_NS")" "5:5:5"

pat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(pat "$(pid 5 1)" "ERO-ერთი" 1972-03-03 male); P2=$(pat "$(pid 5 2)" "ERO-ბავშვი" "$(date -d "$TODAY -5 years" +%F)" female)
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
ALG="ტესტალერგენ$S"
AL=$(api POST "/patients/$P1/allergies" "$ADM" -d "{\"substance\":\"$ALG\",\"allergy_type\":\"allergy\",\"severity\":\"severe\"}" | jq -r '.id // empty'); [ -n "$AL" ] && echo "$P1 $AL" >> "$TMP/allergies"
keep() { local e; e=$(echo "$1" | jq -r '.encounter_id // empty'); [ -n "$e" ] && echo "$e" >> "$TMP/visits"; echo "$e"; }
E1=$(keep "$(api POST /er/visits "$TR" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E ტკივილი\",\"arrived_at\":\"$(ago '30 min')\"}")")
E2=$(keep "$(api POST /er/visits "$TR" -d "{\"patient_id\":\"$P2\",\"department_id\":\"$DER\",\"arrival_mode\":\"walk_in\",\"chief_complaint\":\"ტესტ-E2E ცხელება\"}")")
[ -n "$E1" ] && [ -n "$E2" ] && [ -n "$AL" ] || die "ER-ის შემთხვევები / ალერგია ვერ შეიქმნა"
api POST "/er/visits/$E1/triage" "$TR" -d '{"level":2}' >/dev/null
[ -n "$(api POST "/er/visits/$E1/pickup" "$DR" | jq -r '.doctor_at // empty')" ] || die "აყვანა ვერ მოხერხდა"
ok "2 ER-ის შემთხვევა (E1 — მოზრდილი, ალერგია; E2 — ბავშვი, წონის გარეშე); E1 — ტრიაჟი + აყვანა"

step "1. მოდული / პარამეტრები"
M=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")')
chk "რეესტრი: er → stock, pharmacy (რბილი); მკაცრი — არა" "$(echo "$M" | jq -r '(.hard|length|tostring) + ":" + ([.soft[]|select(.=="stock" or .=="pharmacy")]|sort|join(","))')" "0:pharmacy,stock"
chk "ნაგულისხმევი: prn_max_h 12, verbal_orders, verbal_confirm_h 4, double_check off, dose_rule warn, allow_no_stock, stock_deduct, stat_due_min 15" \
  "$(echo "$M" | jq -r '.settings|"\(.prn_max_h):\(.verbal_orders):\(.verbal_confirm_h):\(.double_check):\(.dose_rule):\(.allow_no_stock):\(.stock_deduct):\(.stat_due_min)"')" "12:true:4:off:warn:true:true:15"
chk "არასწორი: prn_max_h 30 / double_check / dose_rule / stat_due_min 1 / verbal_orders \"x\" — 400" \
  "$(code PUT /modules/er "$ADM" -d '{"settings":{"prn_max_h":30},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"double_check":"all"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"dose_rule":"block"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"stat_due_min":1},"reason":"ტესტ-E2E"}'):$(code PUT /modules/er "$ADM" -d '{"settings":{"verbal_orders":"x"},"reason":"ტესტ-E2E"}')" "400:400:400:400:400"
L=$(api GET "/er/visits/$E1/orders" "$DR")
chk "სია: ცარიელი; modules catalog / stock / pharmacy; ექიმი — order, ექთანი — verbal + administer" \
  "$(echo "$L" | jq -r '"\(.orders|length):\(.modules.catalog):\(.modules.stock):\(.modules.pharmacy):\(.can.order):\(.can.verbal)"'):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r '"\(.can.order):\(.can.verbal):\(.can.administer)"')" "0:true:true:true:true:false:false:true:true"
chk "სხვა განყოფილების ექთანი: ნახვა 200, administer false; ER-ის განყოფილების ექთანი — administer true" "$(code GET "/er/visits/$E1/orders" "$NX"):$(api GET "/er/visits/$E1/orders" "$NX" | jq -r .can.administer):$(api GET "/er/visits/$E1/orders" "$NR" | jq -r .can.administer)" "200:false:true"
MD=$(api GET "/er/meds?search=$(jq -rn --arg s "ERO კეტოროლაკი $S" '$s|@uri')&department_id=$DER" "$DR")
chk "კატალოგი (/er/meds): ჯენერიკი + ნაშთი ER-ის ქვესაწყობში" "$(echo "$MD" | jq -r --arg g "$G_KET" '"\(.enabled):\([.items[]|select(.id==$g)][0].available)"')" "true:5"

step "2. დანიშვნა / შემოწმებები"
O="/er/visits/$E1/orders"
chk "ტრიაჟის ექთანი პირდაპირ ვერ ნიშნავს — 403" "$(code POST "$O" "$TR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"dose\":30,\"dose_unit\":\"mg\",\"route_code\":\"IV\"}")" "403"
chk "ვალიდაცია: გზის გარეშე / კატალოგი + ტექსტი / ინფუზია PRN / პროცედურა ტექსტის გარეშე — 400" \
  "$(code POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"dose\":30,\"dose_unit\":\"mg\"}"):$(code POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"drug_text\":\"xx\",\"dose\":30,\"dose_unit\":\"mg\",\"route_code\":\"IV\"}"):$(code POST "$O" "$DR" -d "{\"kind\":\"infusion\",\"order_type\":\"prn\",\"generic_id\":\"$G_NS\",\"volume_ml\":500,\"route_code\":\"IV\",\"prn_reason\":\"xx\"}"):$(code POST "$O" "$DR" -d '{"kind":"procedure","order_type":"stat"}')" "400:400:400:400"
OK1=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"dose\":30,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"instructions\":\"ტესტ-E2E ნელა\"}")
OKET=$(echo "$OK1" | jq -r '.id // empty')
chk "STAT კეტოროლაკი 30 მგ IV (ზღვარში) — 201, active, high_alert false" "$(echo "$OK1" | jq -r '"\(.status):\(.order_type):\(.high_alert):\(.ordered_by == "'"$DRID"'")"')" "active:stat:false:true"
R=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"once\",\"generic_id\":\"$G_KET\",\"dose\":60,\"dose_unit\":\"mg\",\"route_code\":\"IM\"}")
chk "60 მგ — 409 ER_ORDER_CHECKS: dose_max_single (warn) + დუბლირება; requires ack, reason — არა" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="dose_max_single")][0].level):\([.checks[]|select(.code=="duplicate")]|length):\(.requires.ack):\(.requires.reason)"')" "ER_ORDER_CHECKS:warn:1:true:false"
sets '{"dose_rule":"reason"}' >/dev/null
chk "dose_rule = reason: ack საკმარისი არ არის — 409, requires.reason" "$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"once\",\"generic_id\":\"$G_KET\",\"dose\":60,\"dose_unit\":\"mg\",\"route_code\":\"IM\",\"ack\":true}" | jq -r '"\(.code):\(.requires.reason)"')" "ER_ORDER_CHECKS:true"
O60=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"once\",\"generic_id\":\"$G_KET\",\"dose\":60,\"dose_unit\":\"mg\",\"route_code\":\"IM\",\"override_reason\":\"ტესტ-E2E ძლიერი ტკივილი\"}")
chk "დასაბუთებით — 201; checks შენახულია, override_reason" "$(echo "$O60" | jq -r '"\(.status):\([.checks[]|select(.code=="dose_max_single")]|length):\(.override_reason)"')" "active:1:ტესტ-E2E ძლიერი ტკივილი"
sets '{"dose_rule":"warn"}' >/dev/null
chk "შეწყვეტა: ექთანი — 403; ექიმი — stopped" "$(code POST "/er/orders/$(echo "$O60" | jq -r .id)/stop" "$TR" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/er/orders/$(echo "$O60" | jq -r .id)/stop" "$D2" -d '{"reason":"ტესტ-E2E დუბლი"}' | jq -r .status)" "403:stopped"
R=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"once\",\"generic_id\":\"$G_WAR\",\"dose\":5,\"dose_unit\":\"mg\",\"route_code\":\"PO\"}")
chk "ვარფარინი + კეტოროლაკი — interaction_major (reason)" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="interaction_major")]|length):\(.requires.reason)"')" "ER_ORDER_CHECKS:1:true"
R=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"drug_text\":\"$ALG 1 ამპ\",\"dose\":1,\"dose_unit\":\"amp\",\"route_code\":\"IM\"}")
chk "ალერგია (თავისუფალი ტექსტი, მძიმე) — 409: allergy severe, requires reason + severe" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="allergy")][0].severe):\(.requires.reason):\(.requires.severe)"')" "ER_ORDER_CHECKS:true:true:true"
chk "დასაბუთება confirm_severe-ის გარეშე — 409; ორივე — 201" "$(code POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"drug_text\":\"$ALG 1 ამპ\",\"dose\":1,\"dose_unit\":\"amp\",\"route_code\":\"IM\",\"override_reason\":\"ტესტ-E2E სასიცოცხლო\"}"):$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"drug_text\":\"$ALG 1 ამპ\",\"dose\":1,\"dose_unit\":\"amp\",\"route_code\":\"IM\",\"override_reason\":\"ტესტ-E2E სასიცოცხლო\",\"confirm_severe\":true}" | tee "$TMP/oal" | jq -r .status)" "409:active"
api POST "/er/orders/$(jq -r .id "$TMP/oal")/stop" "$DR" -d '{"reason":"ტესტ-E2E"}' >/dev/null
OTXR=$(api POST "$O" "$DR" -d '{"kind":"medication","order_type":"once","drug_text":"ტესტ-E2E პაციენტის საკუთარი წამალი","dose":1,"dose_unit":"tab","route_code":"PO"}'); OTX=$(echo "$OTXR" | jq -r '.id // empty')
chk "თავისუფალი ტექსტი — 201 (free_text info, დადასტურების გარეშე)" "$(echo "$OTXR" | jq -r '"\(.status):\([.checks[]|select(.code=="free_text")]|length):\(.override_reason)"')" "active:1:null"
OECG=$(api POST "$O" "$DR" -d '{"kind":"procedure","order_type":"stat","text":"ტესტ-E2E ეკგ 12 განხრით"}' | jq -r '.id // empty')
OMR=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"prn\",\"generic_id\":\"$G_MOR\",\"dose\":5,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"prn_reason\":\"ტესტ-E2E ტკივილი > 6\",\"prn_min_interval_h\":4,\"prn_max_doses\":2}")
OMOR=$(echo "$OMR" | jq -r '.id // empty')
chk "PRN მორფინი: ვადა ≈ 12 სთ (prn_max_h), controlled_class narcotic" "$(echo "$OMR" | jq -r '"\((((.expires_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - (.created_at|sub("\\.[0-9]+Z$";"Z")|fromdate)) - 43200)|fabs < 5):\(.controlled_class)"')" "true:narcotic"
ONS=$(api POST "$O" "$DR" -d "{\"kind\":\"infusion\",\"order_type\":\"stat\",\"generic_id\":\"$G_NS\",\"volume_ml\":500,\"rate_ml_h\":250,\"route_code\":\"IV\"}" | jq -r '.id // empty')
ONOS=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"once\",\"generic_id\":\"$G_NOS\",\"dose\":20,\"dose_unit\":\"mg\",\"route_code\":\"PO\"}" | jq -r '.id // empty')
OHEP=$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_HEP\",\"dose\":5000,\"dose_unit\":\"IU\",\"route_code\":\"IV\"}" | jq -r '.id // empty')
[ -n "$OKET" ] && [ -n "$OECG" ] && [ -n "$OMOR" ] && [ -n "$ONS" ] && [ -n "$ONOS" ] && [ -n "$OHEP" ] && ok "დანიშნულებები: პროცედურა, PRN, ინფუზია, SKU-ს გარეშე, მაღალი რისკი" || bad "დანიშნულებები" "$OKET $OECG $OMOR $ONS $ONOS $OHEP"
sets '{"doctor_write":"attending"}' >/dev/null
chk "doctor_write = attending: არა მკურნალი — 403; მკურნალი — 201" "$(code POST "$O" "$D2" -d '{"kind":"procedure","order_type":"once","text":"ტესტ-E2E xx"}'):$(api POST "$O" "$DR" -d '{"kind":"procedure","order_type":"once","text":"ტესტ-E2E შარდის ანალიზის აღება"}' | tee "$TMP/op2" | jq -r .status)" "403:active"
sets '{"doctor_write":"team"}' >/dev/null
R=$(api POST "/er/visits/$E2/orders" "$D2" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"dose\":15,\"dose_unit\":\"mg\",\"route_code\":\"IV\"}")
chk "ბავშვი წონის გარეშე: არ იბლოკება — 409 weight_missing (warn); ack-ით — 201" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="weight_missing")][0].level):\(.requires.reason)"'):$(api POST "/er/visits/$E2/orders" "$D2" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"dose\":15,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"ack\":true}" | jq -r .status)" "ER_ORDER_CHECKS:warn:false:active"

step "3. ზეპირი დანიშნულება"
V=$(api POST "$O" "$TR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"drug_text\":\"ტესტ-E2E ადრენალინი 1 მგ\",\"dose\":1,\"dose_unit\":\"mg\",\"route_code\":\"IV\",\"verbal_doctor_id\":\"$DRID\"}")
OVB=$(echo "$V" | jq -r '.id // empty')
chk "ექთანი ექიმის სახელით — 201: is_verbal, ordered_by = ექიმი, entered_by = ექთანი, ვადა ≈ 4 სთ" "$(echo "$V" | jq -r '"\(.is_verbal):\(.ordered_by=="'"$DRID"'"):\(.entered_by=="'"$TRID"'"):\((((.verbal_due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - (.created_at|sub("\\.[0-9]+Z$";"Z")|fromdate)) - 14400)|fabs < 5)"')" "true:true:true:true"
chk "ექიმს — შეტყობინება (er_verbal_confirm, ბმული ბარათის ჩანართზე)" "$(api GET /notifications "$DR" | jq -r --arg e "$E1" '[.[] | select(.kind=="er_verbal_confirm" and (.link|contains($e)))][0].link | test("tab=orders")')" "true"
chk "ზეპირი: არა ER-ის ექიმის სახელით — 400; სხვა განყოფილების ექთანი — 403" "$(code POST "$O" "$TR" -d "{\"kind\":\"procedure\",\"order_type\":\"stat\",\"text\":\"ტესტ-E2E xx\",\"verbal_doctor_id\":\"$NRID\"}"):$(code POST "$O" "$NX" -d "{\"kind\":\"procedure\",\"order_type\":\"stat\",\"text\":\"ტესტ-E2E xx\",\"verbal_doctor_id\":\"$DRID\"}")" "400:403"
B1=$(api GET "/er/board?department_id=$DER" "$TR" | jq -c --arg e "$E1" '.items[]|select(.encounter_id==$e)|.orders')
chk "დაფა: verbal_pending 1 (ვადაში), შეუსრულებელი STAT / ერთჯერადი ითვლება" "$(echo "$B1" | jq -r '"\(.verbal_pending):\(.verbal_overdue):\(.pending >= 6):\(.overdue)"')" "1:0:true:0"
chk "ბარათი: orders.active, verbal_pending" "$(api GET "/er/visits/$E1" "$DR" | jq -r '"\(.orders.active >= 8):\(.orders.verbal_pending)"')" "true:1"
chk "დადასტურება: ექთანი — 403; ექიმი — 200; ხელმეორედ — 409" "$(code POST "/er/orders/$OVB/confirm" "$TR"):$(api POST "/er/orders/$OVB/confirm" "$DR" | jq -r '.verbal_confirmed_by=="'"$DRID"'"'):$(code POST "/er/orders/$OVB/confirm" "$DR")" "403:true:409"
sets '{"verbal_orders":false}' >/dev/null
chk "verbal_orders = false — 403" "$(code POST "$O" "$TR" -d "{\"kind\":\"procedure\",\"order_type\":\"stat\",\"text\":\"ტესტ-E2E xx\",\"verbal_doctor_id\":\"$DRID\"}")" "403"
sets '{"verbal_orders":true}' >/dev/null

step "4. მიცემა / ჩამოწერა"
A() { api POST "/er/orders/$1/administer" "$2" -d "$3"; }
chk "სხვა განყოფილების ექთანი — 403" "$(code POST "/er/orders/$OKET/administer" "$NX" -d '{"outcome":"given"}')" "403"
ST=$(api GET "/er/orders/$OKET/stock" "$TR")
chk "მარაგი: ER-ის ქვესაწყობი, 1 SKU (ნაშთი 5), qty_suggest 1 (30 მგ / 30)" "$(echo "$ST" | jq -r '"\(.deduct):\(.location.id=="'"$LOC"'"):\(.items|length):\(.items[0].available):\(.qty_suggest)"')" "true:true:1:5:1"
G1=$(A "$OKET" "$TR" '{"outcome":"given","site":"ტესტ-E2E მარჯვ. ხელი"}')
chk "კეტოროლაკი მიცემა — 201: stock_doc, qty 1, ნაშთი 5 → 4; დანიშნულება completed" "$(echo "$G1" | jq -r '"\(.outcome):\(.stock_doc_id != null):\((.qty_base|tonumber) == 1)"'):$(bal "$LOC" "$IT_KET"):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r --arg o "$OKET" '.orders[]|select(.id==$o)|.status')" "given:true:true:4:completed"
chk "შესრულებულზე ხელმეორედ — 409 ER_ORDER_INACTIVE" "$(A "$OKET" "$TR" '{"outcome":"given"}' | jq -r .code)" "ER_ORDER_INACTIVE"
chk "პროცედურა (ER-ის განყოფილების ექთანი): შესრულდა — completed, ჩამოწერის გარეშე" "$(A "$OECG" "$NR" '{"outcome":"given"}' | jq -r '"\(.outcome):\(.stock_doc_id)"'):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r --arg o "$OECG" '.orders[]|select(.id==$o)|.status')" "given:null:completed"
chk "გადადება / უარი მიზეზის გარეშე — 400; უარი მიზეზით — 201, PRN აქტიური რჩება" "$(code POST "/er/orders/$OMOR/administer" "$TR" -d '{"outcome":"held"}'):$(A "$OMOR" "$TR" '{"outcome":"refused","reason":"ტესტ-E2E პაციენტი უარობს"}' | jq -r .outcome):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r --arg o "$OMOR" '.orders[]|select(.id==$o)|.status')" "400:refused:active"
chk "მორფინი (ნარკოტიკული) მოწმის გარეშე — 400" "$(code POST "/er/orders/$OMOR/administer" "$TR" -d '{"outcome":"given"}')" "400"
chk "მოწმე = თვითონ — 400" "$(code POST "/er/orders/$OMOR/administer" "$TR" -d "{\"outcome\":\"given\",\"witness\":$(wit 31)}")" "400"
GM=$(A "$OMOR" "$TR" "{\"outcome\":\"given\",\"witness\":$(wit 32)}")
chk "მოწმით (მეორე ER-ის ექთანი) — 201: witness, ნაშთი 5 → 4" "$(echo "$GM" | jq -r '"\(.outcome):\(.witness_id=="'"$T2ID"'")"'):$(bal "$LOC" "$IT_MOR")" "given:true:4"
R=$(A "$OMOR" "$TR" "{\"outcome\":\"given\",\"witness\":$(wit 32)}")
chk "PRN: ინტერვალის დარღვევა — 409 ER_ADMIN_CHECKS (prn_interval)" "$(echo "$R" | jq -r '"\(.code):\([.checks[]|select(.code=="prn_interval")]|length)"')" "ER_ADMIN_CHECKS:1"
chk "დასაბუთებით — 201; მესამე — prn_max + prn_interval" "$(A "$OMOR" "$TR" "{\"outcome\":\"given\",\"witness\":$(wit 32),\"override_reason\":\"ტესტ-E2E ძლიერი ტკივილი\"}" | jq -r .override_reason):$(A "$OMOR" "$TR" "{\"outcome\":\"given\",\"witness\":$(wit 32)}" | jq -r '[.checks[].code]|sort|join(",")')" "ტესტ-E2E ძლიერი ტკივილი:prn_interval,prn_max"
chk "დოზა დანიშნულზე მეტი — 409 (dose_over); ნაწილობრივ ≥ დოზა — 400" "$(A "$OTX" "$TR" '{"outcome":"given","dose":3}' | jq -r '[.checks[].code]|join(",")'):$(code POST "/er/orders/$OTX/administer" "$TR" -d '{"outcome":"partial","dose":1}')" "dose_over:400"
chk "თავისუფალი ტექსტი — ჩამოწერის გარეშე (კატალოგი არ არის), completed" "$(A "$OTX" "$TR" '{"outcome":"given"}' | jq -r '"\(.stock_doc_id):\(.no_stock)"')" "null:false"
chk "ინფუზია: მოქმედების გარეშე — 400; დასრულება დაწყებამდე — 409" "$(code POST "/er/orders/$ONS/administer" "$TR" -d '{"outcome":"given"}'):$(code POST "/er/orders/$ONS/administer" "$TR" -d '{"outcome":"given","infusion_action":"stop"}')" "400:409"
chk "ინფუზია დაწყება — ჩამოწერა (5 → 4), სიჩქარე; დასრულება — completed" "$(A "$ONS" "$TR" '{"outcome":"given","infusion_action":"start"}' | jq -r '"\(.infusion_action):\((.rate_ml_h|tonumber) == 250)"'):$(bal "$LOC" "$IT_NS"):$(A "$ONS" "$TR" '{"outcome":"given","infusion_action":"stop"}' | jq -r .stock_doc_id):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r --arg o "$ONS" '.orders[]|select(.id==$o)|.status')" "start:true:4:null:completed"
R=$(A "$ONOS" "$TR" '{"outcome":"given"}')
chk "SKU / ნაშთის გარეშე (allow_no_stock) — 409 ER_ADMIN_CHECKS (no_stock)" "$(echo "$R" | jq -r '"\(.code):\([.checks[].code]|join(","))"')" "ER_ADMIN_CHECKS:no_stock"
sets '{"allow_no_stock":false}' >/dev/null
chk "allow_no_stock = false — 409 ER_NO_STOCK" "$(A "$ONOS" "$TR" '{"outcome":"given","override_reason":"ტესტ-E2E"}' | jq -r .code)" "ER_NO_STOCK"
sets '{"allow_no_stock":true}' >/dev/null
chk "დასაბუთებით — 201, no_stock true, stock_doc null" "$(A "$ONOS" "$TR" '{"outcome":"given","override_reason":"ტესტ-E2E პაციენტის მარაგიდან"}' | jq -r '"\(.no_stock):\(.stock_doc_id)"')" "true:null"
sets '{"double_check":"high_alert"}' >/dev/null
chk "double_check = high_alert: ჰეპარინი შემოწმების გარეშე — 422 ER_DOUBLE_CHECK" "$(A "$OHEP" "$TR" '{"outcome":"given"}' | jq -r .code)" "ER_DOUBLE_CHECK"
chk "მეორე თანამშრომლით — 201 (double_check_by), ნაშთი 5 → 4" "$(A "$OHEP" "$TR" "{\"outcome\":\"given\",\"double_check\":$(wit 32)}" | jq -r '.double_check_by=="'"$T2ID"'"'):$(bal "$LOC" "$IT_HEP")" "true:4"
sets '{"double_check":"off"}' >/dev/null
GID=$(echo "$G1" | jq -r .id)
chk "გაუქმება: სხვა განყოფილების ექთანი — 403; ავტორი — ჩამოწერა შემობრუნდა (4 → 5), დანიშნულება ისევ აქტიური" "$(code POST "/er/administrations/$GID/void" "$NX" -d '{"reason":"ტესტ-E2E"}'):$(api POST "/er/administrations/$GID/void" "$TR" -d '{"reason":"ტესტ-E2E შეცდომით"}' | jq -r .ok):$(bal "$LOC" "$IT_KET"):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r --arg o "$OKET" '.orders[]|select(.id==$o)|.status')" "403:true:5:active"
L=$(api GET "/er/visits/$E1/orders" "$DR")
chk "სია: მიცემების ისტორია (გაუქმებულიც), ლოტი, მოწმე, საწყობის დოკუმენტი" "$(echo "$L" | jq -r --arg o "$OMOR" '.orders[]|select(.id==$o)|"\(.given_count):\([.administrations[]|select(.witness_name!=null)]|length):\([.administrations[]|select(.lot_no!=null and .stock_doc_no!=null)]|length)"'):$(echo "$L" | jq -r --arg o "$OKET" '[.orders[]|select(.id==$o)|.administrations[]|select(.voided_at!=null)]|length')" "2:2:2:1"
sets '{"stock_deduct":false}' >/dev/null
chk "stock_deduct = false: მიცემა ჩამოწერის გარეშე (ნაშთი არ იცვლება)" "$(A "$OKET" "$TR" '{"outcome":"given"}' | jq -r .stock_doc_id):$(bal "$LOC" "$IT_KET"):$(api GET "/er/visits/$E1/orders" "$TR" | jq -r .modules.stock)" "null:5:false"
sets '{"stock_deduct":true}' >/dev/null
chk "ER-ის შემთხვევის გაუქმება მიცემის შემდეგ — 409 ER_HAS_ADMINISTRATIONS" "$(api POST "/er/visits/$E1/cancel" "$ADM" -d '{"reason":"ტესტ-E2E"}' | jq -r .code)" "ER_HAS_ADMINISTRATIONS"

step "5. რბილი კავშირები / მოდულის გამორთვა"
modoff pharmacy
chk "pharmacy off: კეტოროლაკი 60 მგ — დოზის შემოწმების გარეშე 201 (no_pharmacy info); კატალოგი / ჩამოწერა რჩება" "$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"once\",\"generic_id\":\"$G_KET\",\"dose\":60,\"dose_unit\":\"mg\",\"route_code\":\"IM\"}" | tee "$TMP/np" | jq -r '"\(.status):\([.checks[]|select(.code=="no_pharmacy")]|length):\([.checks[]|select(.code|startswith("dose_"))]|length)"'):$(api GET "/er/visits/$E1/orders" "$DR" | jq -r '"\(.modules.catalog):\(.modules.stock):\(.modules.pharmacy)"')" "active:1:0:true:true:false"
chk "pharmacy off: ალერგია მაინც მოწმდება — 409" "$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"drug_text\":\"$ALG\",\"dose\":1,\"dose_unit\":\"amp\",\"route_code\":\"IM\"}" | jq -r .code)" "ER_ORDER_CHECKS"
chk "pharmacy off: მიცემა ჩამოწერით (ნაშთი 5 → 3, 60 მგ = 2 ამპ.)" "$(A "$(jq -r .id "$TMP/np")" "$TR" '{"outcome":"given"}' | jq -r '(.qty_base|tonumber) == 2'):$(bal "$LOC" "$IT_KET")" "true:3"
restore_mods
modoff stock
chk "stock (+ pharmacy) off: ER-ის დაფა / სია 200; /er/meds — enabled false; კატალოგიდან დანიშვნა — 400 ER_CATALOG_UNAVAILABLE" "$(code GET /er/board "$TR"):$(code GET "/er/visits/$E1/orders" "$DR"):$(api GET "/er/meds?search=ERO" "$DR" | jq -r .enabled):$(api POST "$O" "$DR" -d "{\"kind\":\"medication\",\"order_type\":\"stat\",\"generic_id\":\"$G_KET\",\"dose\":30,\"dose_unit\":\"mg\",\"route_code\":\"IV\"}" | jq -r .code)" "200:200:false:ER_CATALOG_UNAVAILABLE"
OFT=$(api POST "$O" "$DR" -d '{"kind":"medication","order_type":"stat","drug_text":"ტესტ-E2E პარაცეტამოლი 1 გ","dose":1000,"dose_unit":"mg","route_code":"PO"}' | jq -r '.id // empty')
chk "stock off: ტექსტით დანიშვნა 201 და მიცემა 201 (ჩამოწერის გარეშე)" "$([ -n "$OFT" ] && echo 201):$(A "$OFT" "$TR" '{"outcome":"given"}' | jq -r '"\(.outcome):\(.stock_doc_id)"')" "201:given:null"
chk "stock off: PRN მორფინის მიცემა — 201, stock_doc null, მოწმე არ მოითხოვება (ჩამოწერა არ ხდება)" "$(A "$OMOR" "$TR" '{"outcome":"given","override_reason":"ტესტ-E2E stock off"}' | jq -r '"\(.outcome):\(.stock_doc_id):\(.no_stock)"')" "given:null:false"
restore_mods
modoff inpatient
chk "inpatient (+ დამოკიდებულები) off: ER-ის დანიშვნა / მიცემა — 201 / 201" "$(api POST "/er/visits/$E2/orders" "$D2" -d '{"kind":"procedure","order_type":"stat","text":"ტესტ-E2E სტაც. გარეშე"}' | tee "$TMP/oi" | jq -r .status):$(A "$(jq -r .id "$TMP/oi")" "$TR" '{"outcome":"given"}' | jq -r .outcome)" "active:given"
restore_mods
setm er '"enabled":false' >/dev/null
chk "er off: სია / ბარათი ჩანს (200); დანიშვნა / მიცემა / დადასტურება / meds — 403" \
  "$(code GET "/er/visits/$E1/orders" "$DR"):$(code GET "/er/visits/$E1" "$DR"):$(code POST "$O" "$DR" -d '{"kind":"procedure","order_type":"stat","text":"ტესტ-E2E x"}'):$(code POST "/er/orders/$OMOR/administer" "$TR" -d '{"outcome":"refused","reason":"xx"}'):$(code POST "/er/orders/$OVB/confirm" "$DR"):$(code GET "/er/meds?search=ab" "$DR")" "200:200:403:403:403:403"
chk "er off: სიაში can.* = false; მომიჯნავე (საწყობი / სტაციონარი) არ ვარდება" "$(api GET "/er/visits/$E1/orders" "$DR" | jq -r '"\(.can.order):\(.can.administer)"'):$(code GET /stock/refs "$ADM"):$(code GET /inpatient/census "$ADM"):$(code GET /stock/controlled/summary "$ADM")" "false:false:200:200:200"
setm er '"enabled":true' >/dev/null
chk "er ჩართვა — აქტიური" "$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="er")|.state')" "active"

step "6. დასრულება"
cleanup; trap - EXIT
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="er")|{enabled, settings}')" "$ORIG_ER"
chk "მოდულები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '[.[]|{code, enabled}]')" "$ORIG"
chk "ER-ის დაფაზე სატესტო შემთხვევა აღარ არის" "$(api GET /er/board "$ADM" | jq -r --arg d "$DER" '[.items[]|select(.department_id==$d)]|length')" "0"
ok "სატესტო ჩანაწერები გაუქმებულია / გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
