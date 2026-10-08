#!/usr/bin/env bash
# =====================================================================
# e2e-stock-catalog.sh — საწყობი + აფთიაქი, ეტაპი 1 (0030): ნომენკლატურა
#   უფლებები (storekeeper, stock_manager, pharmacist, nurse), პარამეტრები (თვითღირებულების მეთოდი — მიზეზით),
#   კატეგორიები/ერთეულები, ჯენერიკები (2A: INN + ფორმა + დოზა; კლინიკური ველები — ფარმაცევტი),
#   საქონელი (ჯენერიკი სავალდებულოა მედიკამენტზე, შეფუთვები, შტრიხკოდები GTIN-14), GS1 სკანირება,
#   ურთიერთქმედებები (ჯენერიკი / ATC-ჯგუფი) + დუბლირება, დოზის შემოწმება, მომწოდებლები, ლოკაციები, Excel/CSV იმპორტი, აუდიტი
# ქმნის სატესტო მონაცემებს (ტესტ-E2E); ბოლოს თიშავს (წაშლის გარეშე), პარამეტრებს აბრუნებს.
# გამოყენება:  bash scripts/e2e-stock-catalog.sh [API_URL]
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
read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
read -rsp "admin პაროლი: " ADMIN_PW; echo
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
enc()  { jq -rn --arg s "$1" '$s|@uri'; }   # ქართული ტექსტი URL-ში
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# GTIN-13 სწორი საკონტროლო ციფრით: gtin13 <12 ციფრი>
gtin13() { local d=$1 s=0 i; for i in $(seq 0 11); do if [ $((i % 2)) -eq 0 ]; then s=$((s + ${d:$i:1})); else s=$((s + 3 * ${d:$i:1})); fi; done; echo "$d$(( (10 - s % 10) % 10 ))"; }
EAN1=$(gtin13 "462$(printf '%09d' "$S")"); EAN2=$(gtin13 "463$(printf '%09d' "$S")"); EAN3=$(gtin13 "464$(printf '%09d' "$S")"); EAN4=$(gtin13 "465$(printf '%09d' "$S")")

step "0. მომზადება"
chk "უფლებების კატალოგში 24 უფლება (+ storekeeper, stock_manager; 0048: + საოპერაციო — 3)" \
  "$(api GET /roles/capabilities "$ADM" | jq -r '"\(length):\([.[].code|select(.=="storekeeper" or .=="stock_manager")]|length)"')" "24:2"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.stock.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"საწყობი-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.stock.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass$RANDOM\"}" | jq -r '.accessToken // empty'
}
R_SK=$(mkrole sk "მესაწყობე" '["storekeeper"]'); R_SM=$(mkrole sm "საწყობის მენეჯერი" '["stock_manager"]')
[ -n "$R_SK" ] && [ -n "$R_SM" ] || die "სატესტო როლები ვერ შეიქმნა"
SK=$(mkuser "[\"$R_SK\"]" 61); SM=$(mkuser "[\"$R_SM\"]" 62); PH=$(mkuser '["pharmacist"]' 63); NR=$(mkuser '["nurse"]' 64); RC=$(mkuser '["receptionist"]' 65)
[ -n "$SK" ] && [ -n "$SM" ] && [ -n "$PH" ] && [ -n "$NR" ] && [ -n "$RC" ] && ok "როლები + 5 მომხმარებელი (მესაწყობე, მენეჯერი, ფარმაცევტი, ექთანი, რეგისტრატორი)" || die "მომხმარებლები ვერ შეიქმნა"

step "1. ცნობარები და პარამეტრები"
REFS=$(api GET /stock/refs "$NR")
chk "ცნობარები: ერთეულები, ფორმები, გზები, კატეგორიები (MED, HOUSE)" \
  "$(echo "$REFS" | jq -r '"\(.units|length>=20):\(.forms|length>=20):\(.routes|length>=15):\([.categories[].code|select(.=="MED" or .=="HOUSE")]|length)"')" "true:true:true:2"
chk "რეგისტრატორს საწყობი არ ეხება — 403" "$(code GET /stock/refs "$RC")" "403"
ORIG=$(echo "$REFS" | jq -c '.settings|{costing_method,short_expiry_months}')
OTHER=$(echo "$ORIG" | jq -r 'if .costing_method=="fifo" then "average" else "fifo" end')
chk "მესაწყობეს პარამეტრები ვერ შეცვლის — 403" "$(code PUT /stock/settings "$SK" -d "{\"costing_method\":\"$OTHER\",\"reason\":\"ტესტი\"}")" "403"
chk "მიზეზის გარეშე — 400" "$(code PUT /stock/settings "$SM" -d "{\"costing_method\":\"$OTHER\"}")" "400"
chk "თვითღირებულების მეთოდი იცვლება (მენეჯერი, მიზეზით)" "$(api PUT /stock/settings "$SM" -d "{\"costing_method\":\"$OTHER\",\"reason\":\"ტესტ-E2E: კლინიკის არჩევანი\"}" | jq -r .costing_method)" "$OTHER"
chk "ცვლილება აუდიტშია" "$(api GET "/audit-logs?entity_name=stock_settings&limit=5" "$ADM" | jq -r '[.[]|select(.action=="UPDATE_STOCK_SETTINGS")]|length>0')" "true"
api PUT /stock/settings "$SM" -d "$(echo "$ORIG" | jq -c '. + {reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null

step "2. კატეგორიები და ერთეულები"
CAT=$(api POST /stock/categories "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E ნაკერი $S\",\"kind\":\"medical_supply\",\"expiry_warn_days\":45,\"billing_mode\":\"invoice\",\"markup_pct\":15}" | jq -r '.id // empty')
[ -n "$CAT" ] && ok "კატეგორია (ბილინგი: ინვოისში +15%)" || bad "კატეგორია ვერ შეიქმნა"
chk "ფარმაცევტი კატეგორიას ვერ ქმნის — 403" "$(code POST /stock/categories "$PH" -d "{\"code\":\"E2E_X$S\",\"name\":\"x x\",\"kind\":\"other\"}")" "403"
chk "იგივე კოდი — 409" "$(code POST /stock/categories "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"დუბლი\",\"kind\":\"other\"}")" "409"
UNIT="e2eu$S"
chk "ერთეული" "$(api POST /stock/units "$SM" -d "{\"code\":\"$UNIT\",\"name\":\"ტესტ-E2E ერთეული\"}" | jq -r .code)" "$UNIT"
MED=$(echo "$REFS" | jq -r '.categories[]|select(.code=="MED").id'); HOUSE=$(echo "$REFS" | jq -r '.categories[]|select(.code=="HOUSE").id')
AG=$(echo "$REFS" | jq -r '.allergen_groups[0].code')

step "3. ჯენერიკები (INN + ფორმა + დოზა)"
G1J=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ცეფტრიაქსონი $S\",\"inn_latin\":\"Ceftriaxone\",\"atc_code\":\"Z99AA01\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"dose_per_unit\":1000,\"max_single_dose\":2000,\"max_daily_dose\":4000,\"ped_max_daily_per_kg\":80,\"min_age_days\":15,\"routes\":[\"IV\",\"IM\"],\"allergen_groups\":[\"$AG\"],\"reserve_antibiotic\":false}")
G1=$(echo "$G1J" | jq -r '.id // empty'); echo "$G1" >> "$TMP/gens"
chk "ფარმაცევტი: ჯენერიკი + დოზის ზღვრები + გზები + ალერგენი" "$(echo "$G1J" | jq -r '"\(.form_name|length>0):\(.routes|join(",")):\(.allergen_groups|length)"')" "true:IV,IM:1"
chk "იგივე INN + ფორმა + დოზა — 409" "$(code POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ცეფტრიაქსონი $S\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\"}")" "409"
G2=$(api POST /pharmacy/generics "$SM" -d "{\"inn\":\"ტესტ-E2E ცეფტრიაქსონი $S\",\"atc_code\":\"Z99AA01\",\"form_code\":\"INJ_PWD\",\"strength\":\"500 მგ\"}" | jq -r '.id // empty'); echo "$G2" >> "$TMP/gens"
[ -n "$G2" ] && ok "მენეჯერი: ჯენერიკი კლინიკური ველების გარეშე (სხვა დოზა)" || bad "G2 ვერ შეიქმნა"
chk "მენეჯერი კონტროლის კლასს ვერ უთითებს — 403" "$(code PATCH "/pharmacy/generics/$G2" "$SM" -d '{"controlled_class":"narcotic"}')" "403"
chk "დღიური < ერთჯერადი — 400" "$(code PATCH "/pharmacy/generics/$G1" "$PH" -d '{"max_single_dose":5000}')" "400"
chk "ზღვრები დოზის ერთეულის გარეშე — 400" "$(code PATCH "/pharmacy/generics/$G2" "$PH" -d '{"max_daily_dose":100}')" "400"
chk "უცნობი შეყვანის გზა — 400" "$(code PATCH "/pharmacy/generics/$G2" "$PH" -d '{"routes":["XX"]}')" "400"
G3=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E ვარფარინი $S\",\"atc_code\":\"Z99BB01\",\"form_code\":\"TAB\",\"strength\":\"5 მგ\",\"high_alert\":true}" | jq -r '.id // empty'); echo "$G3" >> "$TMP/gens"
G4=$(api POST /pharmacy/generics "$PH" -d "{\"inn\":\"ტესტ-E2E მორფინი $S\",\"atc_code\":\"Z99CC01\",\"form_code\":\"INJ_SOL\",\"strength\":\"10 მგ/მლ\",\"controlled_class\":\"narcotic\",\"patient_only\":true}" | jq -r '.id // empty'); echo "$G4" >> "$TMP/gens"
chk "ნარკოტიკული ჯენერიკი — ფილტრი „კონტროლირებადი“" "$(api GET "/pharmacy/generics?controlled=true&search=$(enc "მორფინი $S")" "$NR" | jq -r '[.[]|select(.id=="'"$G4"'")|"\(.controlled_class):\(.patient_only)"]|join(",")')" "narcotic:true"

step "4. საქონელი (SKU)"
IT1J=$(api POST /stock/items "$PH" -d "{\"name\":\"ტესტ-E2E Rocephin $S\",\"category_id\":\"$MED\",\"generic_id\":\"$G1\",\"base_unit\":\"vial\",\"manufacturer\":\"Roche\",\"storage\":\"room\",\"packs\":[{\"name\":\"კოლოფი\",\"qty_base\":5,\"is_receipt_default\":true}],\"barcodes\":[{\"barcode\":\"$EAN1\",\"pack_index\":0},{\"barcode\":\"$EAN2\"}]}")
IT1=$(echo "$IT1J" | jq -r '.id // empty'); echo "$IT1" >> "$TMP/items"
chk "მედიკამენტი: ჯენერიკით, შეფუთვა 5, 2 შტრიხკოდი (GTIN-14), ავტოკოდი" \
  "$(echo "$IT1J" | jq -r '"\(.inn|test("ცეფტრიაქსონი")):\(.packs|length):\(.barcodes|map(.barcode|length)|unique|join(",")):\(.code|test("^I[0-9]{6}$")):\(.requires_lot):\(.requires_expiry)"')" "true:1:14:true:true:true"
chk "მედიკამენტი ჯენერიკის გარეშე — 400" "$(code POST /stock/items "$PH" -d "{\"name\":\"ტესტ-E2E უჯენერიკო\",\"category_id\":\"$MED\",\"base_unit\":\"vial\"}")" "400"
chk "ფარმაცევტი სამეურნეოს ვერ ქმნის — 403" "$(code POST /stock/items "$PH" -d "{\"name\":\"ტესტ-E2E საპონი\",\"category_id\":\"$HOUSE\",\"base_unit\":\"piece\"}")" "403"
chk "ექთანი ნახულობს (200), ვერ ქმნის (403)" "$(code GET "/stock/items/$IT1" "$NR"):$(code POST /stock/items "$NR" -d "{\"name\":\"x x\",\"category_id\":\"$HOUSE\",\"base_unit\":\"piece\"}")" "200:403"
chk "მესაწყობე კატალოგს ვერ არედაქტირებს — 403" "$(code PATCH "/stock/items/$IT1" "$SK" -d '{"notes":"x"}')" "403"
IT2J=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ხელსახოცი $S\",\"category_id\":\"$HOUSE\",\"base_unit\":\"roll\"}")
IT2=$(echo "$IT2J" | jq -r '.id // empty'); echo "$IT2" >> "$TMP/items"
chk "სამეურნეო: ლოტის/ვადის გარეშე (კატეგორიის ნაგულისხმევი)" "$(echo "$IT2J" | jq -r '"\(.requires_lot):\(.requires_expiry):\(.effective_billing_mode)"')" "false:false:none"
IT3J=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E ნაკერი 3-0 $S\",\"category_id\":\"$CAT\",\"base_unit\":\"piece\",\"sale_price\":4.5}")
IT3=$(echo "$IT3J" | jq -r '.id // empty'); echo "$IT3" >> "$TMP/items"
chk "კატეგორიიდან: ვადის გაფრთხ. 45, ბილინგი — ინვოისში" "$(echo "$IT3J" | jq -r '"\(.effective_warn_days):\(.effective_billing_mode)"')" "45:invoice"
chk "სერიული ლოტის გარეშე — 400" "$(code POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E x\",\"category_id\":\"$CAT\",\"base_unit\":\"piece\",\"requires_lot\":false,\"requires_expiry\":false,\"serial_tracked\":true}")" "400"
chk "იგივე შტრიხკოდი სხვა საქონელზე — 409" "$(code POST "/stock/items/$IT3/barcodes" "$SM" -d "{\"barcode\":\"$EAN1\"}")" "409"
chk "ძებნა: INN / ATC / შტრიხკოდი (EAN-13 ფორმით)" \
  "$(for s in "$(enc "ცეფტრიაქსონი $S")" "Z99AA" "$EAN1"; do api GET "/stock/items?search=$s" "$NR" | jq -r "[.[]|select(.id==\"$IT1\")]|length"; done | paste -sd,)" "1,1,1"
chk "შეფუთვები: + ყუთი 50; იგივე რაოდენობა ორჯერ — 400" \
  "$(api PUT "/stock/items/$IT1/packs" "$PH" -d "$(echo "$IT1J" | jq -c '{packs:(.packs|map({id,name,qty_base:(.qty_base|tonumber),is_receipt_default}) + [{name:"ყუთი",qty_base:50}])}')" | jq -r '.packs|map(.qty_base|tonumber)|join(",")'):$(code PUT "/stock/items/$IT1/packs" "$PH" -d '{"packs":[{"name":"ა","qty_base":10},{"name":"ბ","qty_base":10}]}')" "5,50:400"
BOX=$(api GET "/stock/items/$IT1" "$NR" | jq -r '.packs[]|select(.name=="ყუთი").id')
chk "შტრიხკოდი ყუთზე" "$(api POST "/stock/items/$IT1/barcodes" "$PH" -d "{\"barcode\":\"$EAN3\",\"pack_id\":\"$BOX\"}" | jq -r "[.barcodes[]|select(.pack_id==\"$BOX\")]|length")" "1"
B2=$(api GET "/stock/items/$IT1" "$NR" | jq -r ".barcodes[]|select(.barcode==\"0$EAN2\").id")
chk "შტრიხკოდის მოხსნა" "$(api DELETE "/stock/items/$IT1/barcodes/$B2" "$PH" | jq -r '.barcodes|length')" "2"
chk "საქონლის ცვლილება აუდიტშია" "$(api GET "/audit-logs?entity_name=stock_items&entity_id=$IT1&limit=20" "$ADM" | jq -r '[.[].action]|(index("CREATE_STOCK_ITEM")!=null) and (index("SET_STOCK_ITEM_PACKS")!=null)')" "true"

step "5. სკანირება (GS1 DataMatrix / EAN)"
GS=$(printf '\035')
RAW="]d2010${EAN1}17271130 10LOT${S}${GS}21SN${S}"; RAW="${RAW// /}"
SC=$(api POST /stock/scan "$SK" -d "$(jq -nc --arg c "$RAW" '{code:$c}')")
chk "ნედლი DataMatrix (FNC1): საქონელი, შეფუთვა, ლოტი, ვადა, სერიული" \
  "$(echo "$SC" | jq -r --arg i "$IT1" '"\(.item.id==$i):\(.pack.name):\(.parsed.lot):\(.parsed.expiry):\(.parsed.serial):\(.warnings|length)"')" "true:კოლოფი:LOT$S:2027-11-30:SN$S:0"
SC=$(api POST /stock/scan "$SK" -d "{\"code\":\"(01)0${EAN1}(17)280200(10)A1\"}")
chk "ფრჩხილებიანი ფორმა; DD=00 → თვის ბოლო დღე" "$(echo "$SC" | jq -r '"\(.parsed.expiry):\(.parsed.lot)"')" "2028-02-29:A1"
chk "ჩვეულებრივი EAN-13 → საქონელი; ლოტი/ვადა — ხელით (გაფრთხილება)" "$(api POST /stock/scan "$SK" -d "{\"code\":\"$EAN1\"}" | jq -r --arg i "$IT1" '"\(.item.id==$i):\(.warnings|length)"')" "true:2"
chk "უცნობი კოდი → „კატალოგში არ არის“" "$(api POST /stock/scan "$SK" -d "{\"code\":\"$EAN4\"}" | jq -r '"\(.item):\(.warnings|map(select(test("კატალოგში")))|length)"')" "null:1"
BADCD="${EAN4:0:12}$(( (${EAN4:12:1} + 1) % 10 ))"
chk "არასწორი საკონტროლო ციფრი — გაფრთხილება" "$(api POST /stock/scan "$SK" -d "{\"code\":\"$BADCD\"}" | jq -r '[.warnings[]|select(test("საკონტროლო"))]|length')" "1"

step "6. ურთიერთქმედებები და შემოწმება"
IX=$(api POST /pharmacy/interactions "$PH" -d '{"a_atc":"Z99AA","b_atc":"Z99BB","severity":"major","effect":"ტესტ-E2E: სისხლდენის რისკი","recommendation":"INR-ის კონტროლი"}' | jq -r '.id // empty'); echo "$IX" >> "$TMP/ix"
[ -n "$IX" ] && ok "ATC-ჯგუფი × ATC-ჯგუფი (მძიმე)" || bad "ურთიერთქმედება ვერ შეიქმნა"
chk "იგივე წყვილი შებრუნებით — 409" "$(code POST /pharmacy/interactions "$PH" -d '{"a_atc":"Z99BB","b_atc":"Z99AA","severity":"minor","effect":"დუბლი"}')" "409"
chk "მენეჯერი ურთიერთქმედებას ვერ ქმნის — 403" "$(code POST /pharmacy/interactions "$SM" -d "{\"a_generic_id\":\"$G1\",\"b_generic_id\":\"$G4\",\"severity\":\"minor\",\"effect\":\"x x x\"}")" "403"
chk "მხარე ორივე (ჯენერიკი + ATC) — 400" "$(code POST /pharmacy/interactions "$PH" -d "{\"a_generic_id\":\"$G1\",\"a_atc\":\"Z99AA\",\"b_atc\":\"Z99CC\",\"severity\":\"minor\",\"effect\":\"x x x\"}")" "400"
IX2=$(api POST /pharmacy/interactions "$PH" -d "{\"a_generic_id\":\"$G4\",\"b_atc\":\"Z99BB\",\"severity\":\"moderate\",\"effect\":\"ტესტ-E2E: სედაცია\"}" | jq -r '.id // empty'); echo "$IX2" >> "$TMP/ix"
CK=$(api POST /pharmacy/interactions/check "$NR" -d "{\"generic_ids\":[\"$G1\",\"$G3\",\"$G2\",\"$G4\"]}")
chk "შემოწმება: მძიმე (ATC) + საშუალო (ჯენერიკი×ATC) + დუბლირება (ერთი ATC-5), სიმძიმით დალაგებული" "$(echo "$CK" | jq -r '[.[].severity]|join(",")')" "major,major,moderate,duplicate"
chk "ჯენერიკის ფილტრი: მორფინს — 1 ჩანაწერი" "$(api GET "/pharmacy/interactions?generic_id=$G4" "$NR" | jq -r "[.[]|select(.id==\"$IX2\" or .id==\"$IX\")]|length")" "1"

step "7. დოზის შემოწმება"
dc() { api POST /pharmacy/dose-check "$NR" -d "$1" | jq -r '[.warnings[].code]|join(",")'; }
chk "მოზრდილი 1 გ × 2 — ზღვრებში" "$(dc "{\"generic_id\":\"$G1\",\"dose\":1000,\"doses_per_day\":2,\"age_days\":12000}")" ""
chk "მოზრდილი 2.5 გ × 2 — ერთჯერადი და დღიური" "$(dc "{\"generic_id\":\"$G1\",\"dose\":2500,\"doses_per_day\":2,\"age_days\":12000}")" "max_single,max_daily"
chk "ბავშვი 20 კგ, 1 გ × 2 (100 მგ/კგ/დღ) → ped_daily" "$(dc "{\"generic_id\":\"$G1\",\"dose\":1000,\"doses_per_day\":2,\"age_days\":2000,\"weight_kg\":20}")" "ped_daily"
chk "ბავშვი წონის გარეშე → weight_required" "$(dc "{\"generic_id\":\"$G1\",\"dose\":500,\"doses_per_day\":1,\"age_days\":2000}")" "weight_required"
chk "ახალშობილი 10 დღის (მინ. 15) → min_age (block)" "$(api POST /pharmacy/dose-check "$NR" -d "{\"generic_id\":\"$G1\",\"dose\":50,\"doses_per_day\":1,\"age_days\":10,\"weight_kg\":3}" | jq -r '[.warnings[]|select(.code=="min_age")|.level]|join(",")')" "block"
chk "ზღვრების გარეშე → no_limits (info)" "$(dc "{\"generic_id\":\"$G3\",\"dose\":5,\"doses_per_day\":1}")" "no_limits"

step "8. მომწოდებლები და ლოკაციები"
TAX="9$(printf '%08d' "$S")"
SUP=$(api POST /stock/suppliers "$SK" -d "{\"name\":\"ტესტ-E2E შპს ფარმა $S\",\"tax_id\":\"$TAX\",\"phone\":\"591000000\"}" | jq -r '.id // empty'); echo "$SUP" >> "$TMP/sup"
[ -n "$SUP" ] && ok "მესაწყობე: მომწოდებელი" || bad "მომწოდებელი ვერ შეიქმნა"
chk "იგივე ს/კ — 409; არასწორი ს/კ — 400; ექთანი — 403" \
  "$(code POST /stock/suppliers "$SK" -d "{\"name\":\"დუბლი\",\"tax_id\":\"$TAX\"}"):$(code POST /stock/suppliers "$SK" -d '{"name":"ცუდი","tax_id":"12ab"}'):$(code POST /stock/suppliers "$NR" -d '{"name":"x x"}')" "409:400:403"
chk "საწყისი ლოკაციები: აფთიაქი, სამეურნეო" "$(api GET /stock/locations "$NR" | jq -r '[.[].code|select(.=="PHARMACY" or .=="HOUSEHOLD")]|sort|join(",")')" "HOUSEHOLD,PHARMACY"
DEP=$(api GET /departments "$ADM" | jq -r '[.[]|select(.is_active)][0].id // empty')
chk "განყოფილების ქვესაწყობი განყოფილების გარეშე — 400" "$(code POST /stock/locations "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E ქვესაწყობი\",\"kind\":\"department\"}")" "400"
if [ -n "$DEP" ]; then LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E ქვესაწყობი $S\",\"kind\":\"department\",\"department_id\":\"$DEP\"}" | jq -r '.id // empty')
else LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E ლოკაცია $S\",\"kind\":\"other\"}" | jq -r '.id // empty'); fi
echo "$LOC" >> "$TMP/loc"
[ -n "$LOC" ] && ok "ლოკაცია (მენეჯერი)" || bad "ლოკაცია ვერ შეიქმნა"
chk "იგივე კოდი — 409; მესაწყობე — 403" "$(code POST /stock/locations "$SM" -d "{\"code\":\"E2E_$S\",\"name\":\"დუბლი\",\"kind\":\"other\"}"):$(code POST /stock/locations "$SK" -d "{\"code\":\"E2E_Y$S\",\"name\":\"x x\",\"kind\":\"other\"}")" "409:403"

step "9. იმპორტი (Excel შაბლონი / CSV)"
chk "შაბლონი — .xlsx (zip)" "$(curl -s "$B/stock/import/template" -H "authorization: Bearer $SM" | head -c 2)" "PK"
CSV="$TMP/import.csv"
{ echo "კატეგორია;დასახელება;INN;ფორმა;დოზა;ATC;საბაზო ერთეული;შეფუთვა;რაოდენობა შეფუთვაში;შტრიხკოდი;მწარმოებელი;შენახვა"
  echo "MED;ტესტ-E2E Paracetamol-I $S;ტესტ-E2E პარაცეტამოლი $S;TAB;500 მგ;Z99DD01;tablet;კოლოფი;20;$EAN4;Test;ოთახის"
  echo "MED;ტესტ-E2E უINN-ო $S;;TAB;;;tablet;;;;;"
  echo "HOUSE;ტესტ-E2E ქაღალდი $S;;;;;piece;შეკვრა;10;;;"
  echo "MED;ტესტ-E2E დუბლ-შტრიხკოდი $S;ტესტ-E2E პარაცეტამოლი $S;TAB;500 მგ;;tablet;;;$EAN1;;"
} > "$CSV"
up() { curl -s -X POST "$B/stock/import?commit=$1" -H "authorization: Bearer $SM" -F "file=@$CSV;filename=import.csv"; }
DR=$(up false)
chk "შემოწმება: 2 დაემატება (1 ახალი ჯენერიკით), 1 გამოტოვებული, 1 შეცდომა" "$(echo "$DR" | jq -r '"\(.commit):\(.created):\(.generics_created):\(.skipped):\(.errors)"')" "false:2:1:1:1"
chk "შემოწმებისას არაფერი შეინახა" "$(api GET "/stock/items?search=Paracetamol-I%20$S" "$NR" | jq length)" "0"
CM=$(up true)
chk "იმპორტი: 2 დაემატა" "$(echo "$CM" | jq -r '"\(.commit):\(.created)"')" "true:2"
chk "იმპორტირებული: ჯენერიკით, შეფუთვა 20, შტრიხკოდი" "$(api GET "/stock/items?search=Paracetamol-I%20$S" "$NR" | jq -r '.[0]|"\(.inn|test("პარაცეტამოლი")):\(.packs[0].qty_base|tonumber):\(.barcodes|length)"')" "true:20:1"
chk "განმეორებით — ყველაფერი გამოტოვდება" "$(up true | jq -r '"\(.created):\(.skipped)"')" "0:3"
chk "მესაწყობეს იმპორტი არ შეუძლია — 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/stock/import" -H "authorization: Bearer $SK" -F "file=@$CSV;filename=import.csv")" "403"

step "გასუფთავება"
for X in $(api GET "/stock/items?search=$(enc ტესტ-E2E)&all=true&limit=1000" "$SM" | jq -r ".[]|select(.name|test(\"$S\"))|.id"); do api PATCH "/stock/items/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in $(api GET "/pharmacy/generics?search=$(enc ტესტ-E2E)&limit=1000" "$PH" | jq -r ".[]|select(.inn|test(\"$S\"))|.id"); do api PATCH "/pharmacy/generics/$X" "$PH" -d '{"is_active":false}' >/dev/null; done
for X in $(cat "$TMP/ix" 2>/dev/null); do api PATCH "/pharmacy/interactions/$X" "$PH" -d '{"is_active":false}' >/dev/null; done
for X in $(cat "$TMP/sup" 2>/dev/null); do api PATCH "/stock/suppliers/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
for X in $(cat "$TMP/loc" 2>/dev/null); do api PATCH "/stock/locations/$X" "$SM" -d '{"is_active":false}' >/dev/null; done
[ -n "$CAT" ] && api PATCH "/stock/categories/$CAT" "$SM" -d '{"is_active":false}' >/dev/null
api PATCH "/stock/units/$UNIT" "$SM" -d '{"is_active":false}' >/dev/null
chk "პარამეტრები დაბრუნებულია" "$(api GET /stock/refs "$NR" | jq -c '.settings|{costing_method,short_expiry_months}')" "$ORIG"
chk "აქტიური სატესტო საქონელი / ჯენერიკი აღარ არის" \
  "$(api GET "/stock/items?search=$S" "$NR" | jq length):$(api GET "/pharmacy/generics?search=$S" "$NR" | jq length)" "0:0"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
ok "სატესტო მონაცემები გათიშულია (როლები წაშლილია)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
