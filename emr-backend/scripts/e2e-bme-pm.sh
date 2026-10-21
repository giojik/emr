#!/usr/bin/env bash
# =====================================================================
# e2e-bme-pm.sh — ბიომედ-აპარატურა, ეტაპი 2 (0074): გეგმიური მომსახურება (PM) / კალიბრაცია / ელ. უსაფრთხოება / მეტროლოგია
#   პარამეტრები (ვალიდაცია), სამუშაოს სახეები, ჩეკლისტის შაბლონები (ტიპზე / ზოგადი), გეგმები (ავტომატურად ტიპიდან, გადაფარვა, ბოლო შესრულება,
#   ტიპის ცვლილება, sync), „სამუშაოები“ (ვადაგადაცილებული / კვირა / თვე / დასადგენი, ფილტრები, ხედვის არე), სამუშაო (შიდა / გარე შემსრულებელი,
#   ჯგუფური დაგეგმვა, მინიჭების შეტყობინება), შესრულება (გაზომვა → ავტომატური fail, შედეგის წესები, შემდეგი ვადა: ბოლო შესრულებიდან / კალენდრით /
#   სერტიფიკატით), „ვერ გაიარა“ → სტატუსის შეთავაზება (ავტომატურად არ იცვლება) → გამოყენება, სერტიფიკატი ფაილად → დოკუმენტებში, აქტის PDF,
#   გაუქმება, მოხმარების მთვლელი, შეხსენებები (30 / 7 / ვადაგადაცილება — ერთხელ), ავტომატური „შეზღუდულად მუშა“ და აღდგენა, გამოყვანა, მოდულის გამორთვა.
# შეხსენებები ხელით ეშვება მხოლოდ სატესტო აპარატებზე (device_ids) — სხვა აპარატებს არ ეხება.
# ბოლოს: სატესტო აპარატები გამოყვანილია, სახე / ჩეკლისტი / მომხმარებლები / განყოფილებები გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-bme-pm.sh [API_URL]
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
upl()  { local p=$1 t=$2; shift 2; curl -s -X POST "$B$p" -H "authorization: Bearer $t" "$@"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
d()   { TZ=Asia/Tbilisi date -d "$1" +%F; }
TODAY=$(d today); YY=$(TZ=Asia/Tbilisi date +%y)
enc()  { jq -rn --arg s "$1" '$s|@uri'; }
mod()  { api PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message // "ok"' | head -c 60; }
modc() { code PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
pm()   { api GET "/bme/devices/$1/pm" "$ENG"; }
plan() { pm "$1" | jq -r --arg k "$2" '.plans[]|select(.kind_code==$k)|.id'; }
items_pass() { jq -c '[.items[]|if .item_type=="measure" then {id:(.id|tonumber), value_num:(if .tolerance!=null then (.nominal|tonumber) elif .limit_high!=null then (.limit_high|tonumber) else (.limit_low|tonumber) end)} else {id:(.id|tonumber), outcome:"pass"} end]'; }
notif() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" '[.[]|select(.kind==$k)]|length'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0074" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0074" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E PM რეანიმაცია $S\",\"code\":\"E2EPA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E PM ქირურგია $S\",\"code\":\"E2EPB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.bmepm.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"PM-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.bmepm.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_ENG=$(mkrole peng "სამედ. ინჟინერი" '["med_engineer"]'); R_DEP=$(mkrole pdep "აპარატები (განყ.)" '["bme_dept","nurse"]'); R_VIEW=$(mkrole pview "აპარატები (ნახვა)" '["bme_view"]')
[ -n "$R_ENG" ] && [ -n "$R_DEP" ] && [ -n "$R_VIEW" ] || die "როლები ვერ შეიქმნა"
read -r ENGID ENG <<< "$(mkuser "[\"$R_ENG\"]" 51)"; read -r ENG2ID ENG2 <<< "$(mkuser "[\"$R_ENG\"]" 52)"
read -r DH1ID DH1 <<< "$(mkuser "[\"$R_DEP\"]" 53 ",\"department_id\":\"$D1\"")"; read -r N2ID N2 <<< "$(mkuser '["nurse"]' 54 ",\"department_id\":\"$D2\"")"
read -r _ VW <<< "$(mkuser "[\"$R_VIEW\"]" 55)"; read -r _ N0 <<< "$(mkuser '["nurse"]' 56)"
[ -n "$ENG" ] && [ -n "$ENG2" ] && [ -n "$DH1" ] && [ -n "$N2" ] && [ -n "$VW" ] && [ -n "$N0" ] && ok "6 მომხმარებელი (2 ინჟინერი, bme_dept, ექთანი სხვა განყ., ნახვა, განყოფილების გარეშე)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული bme ვერ მოიძებნა"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
SUP=$(api POST /stock/suppliers "$ADM" -d "{\"name\":\"ტესტ-E2E მედტექ სერვისი $S\",\"tax_id\":\"4$(printf '%08d' "$((10#$S))")\"}" | jq -r '.id // empty')
[ -n "$SUP" ] || SUP=$(api GET /bme/pm/refs "$ADM" | jq -r '.suppliers[0].id // empty')
[ -n "$SUP" ] && ok "მომწოდებელი (გარე შემსრულებელი)" || bad "მომწოდებელი" "ვერ შეიქმნა"
REFS=$(api GET /bme/refs "$ENG"); ty() { echo "$REFS" | jq -r --arg c "$1" '.types[]|select(.code==$c)|.id'; }
T_MON=$(ty PATIENT_MONITOR); T_SCALE=$(ty SCALE); T_OTHER=$(ty OTHER); T_DEF=$(ty DEFIBRILLATOR)

step "1. პარამეტრები და ცნობარები"
chk "ნაგულისხმევი: ბოლო შესრულებიდან, სერტ. → ვადა, 30 / 7 დღე, მხოლოდ გაფრთხილება" "$(echo "$ORIG" | jq -r '.settings|"\(.pm_due_basis):\(.pm_cert_sets_due):\(.pm_remind_days|join("/")):\(.pm_overdue_action)"')" "last_done:true:30/7:warn"
chk "არასწორი: ვადის საფუძველი / შეხსენების დღეები (0, დუბლი) / საათი 25 / პრეფიქსი — 400" "$(modc '{"pm_due_basis":"x"}'):$(modc '{"pm_remind_days":[0]}'):$(modc '{"pm_remind_days":[7,7]}'):$(modc '{"pm_remind_hour":25}'):$(modc '{"pm_work_prefix":"pm-1"}')" "400:400:400:400:400"
PR=$(api GET /bme/pm/refs "$ENG")
chk "სახეები: PM, კალიბრაცია, ელ. უსაფრთხოება, მეტროლოგია (საზომზე, სერტიფიკატით)" "$(echo "$PR" | jq -r '[.kinds[]|select(.code=="PM" or .code=="CALIBRATION" or .code=="SAFETY" or .code=="METROLOGY")]|length'):$(echo "$PR" | jq -r '.kinds[]|select(.code=="METROLOGY")|"\(.groups|join(",")):\(.needs_certificate)"')" "4:measuring:true"
chk "ჩეკლისტები (seed): IEC 62353 — 6 პუნქტი, მონიტორის კალიბრაცია — ტიპზე" "$(echo "$PR" | jq -r '[.checklists[]|select(.name|test("IEC 62353"))][0].items|length'):$(echo "$PR" | jq -r '[.checklists[]|select(.type_code=="PATIENT_MONITOR")]|length > 0')" "6:true"
chk "საზომ ტიპებზე კალიბრაცია → მეტროლოგია (სასწორს კალიბრაციის ინტერვალი აღარ აქვს)" "$(echo "$REFS" | jq -r '.types[]|select(.code=="SCALE")|.calibration_months')" "null"
chk "ცნობარი: ექთანს — 200 (ნახვა), შემსრულებლები (ინჟინრები) ≥ 2" "$(code GET /bme/pm/refs "$N2"):$(echo "$PR" | jq -r "[.engineers[]|select(.id==\"$ENGID\" or .id==\"$ENG2ID\")]|length")" "200:2"
# სახე
chk "სახე: ექთანი — 403; ტიპის სვეტი + ნაგულისხმევი ერთად — 400" "$(code POST /bme/kinds "$N2" -d '{"code":"E2E","name":"x"}'):$(code POST /bme/kinds "$ENG" -d "{\"code\":\"E2EX$S\",\"name\":\"ტესტ-E2E\",\"type_field\":\"pm_months\",\"default_months\":6}")" "403:400"
K=$(api POST /bme/kinds "$ENG" -d "{\"code\":\"E2EK$S\",\"name\":\"ტესტ-E2E აკუმულატორის შემოწმება $S\",\"short_name\":\"ტესტ-E2E აკუმ.\",\"default_months\":6,\"groups\":[\"monitoring\"]}")
KID=$(echo "$K" | jq -r '.id // empty')
chk "ახალი სახე (6 თვე, მონიტორინგის ჯგუფზე); იგივე კოდი — 409; კოდი არ იცვლება — 400" "$(echo "$K" | jq -r '"\(.default_months):\(.groups|join(","))"'):$(code POST /bme/kinds "$ENG" -d "{\"code\":\"E2EK$S\",\"name\":\"ტესტ-E2E\"}"):$(code PATCH "/bme/kinds/$KID" "$ENG" -d '{"code":"X"}')" "6:monitoring:409:400"
# ჩეკლისტი — ტიპზე (ელ. უსაფრთხოება + მონიტორი), არაკრიტიკული პუნქტით
SAFETY=$(echo "$PR" | jq -r '.kinds[]|select(.code=="SAFETY")|.id'); METRO=$(echo "$PR" | jq -r '.kinds[]|select(.code=="METROLOGY")|.id'); PMK=$(echo "$PR" | jq -r '.kinds[]|select(.code=="PM")|.id')
chk "გაზომვა ნორმის / ზღვრის გარეშე — 400; ქვედა > ზედა — 400" "$(code POST /bme/checklists "$ENG" -d "{\"kind_id\":\"$SAFETY\",\"type_id\":\"$T_MON\",\"name\":\"ტესტ-E2E\",\"items\":[{\"text\":\"გაზომვა\",\"item_type\":\"measure\"}]}"):$(code POST /bme/checklists "$ENG" -d "{\"kind_id\":\"$SAFETY\",\"type_id\":\"$T_MON\",\"name\":\"ტესტ-E2E\",\"items\":[{\"text\":\"გაზომვა\",\"item_type\":\"measure\",\"limit_low\":5,\"limit_high\":1}]}")" "400:400"
CL=$(api POST /bme/checklists "$ENG" -d "{\"kind_id\":\"$SAFETY\",\"type_id\":\"$T_MON\",\"name\":\"ტესტ-E2E მონიტორის ელ. უსაფრთხოება $S\",\"items\":[
  {\"text\":\"ტესტ-E2E დათვალიერება\",\"item_type\":\"check\"},
  {\"text\":\"ტესტ-E2E დამიწება\",\"item_type\":\"measure\",\"unit\":\"Ω\",\"limit_high\":0.3},
  {\"text\":\"ტესტ-E2E ძაბვა\",\"item_type\":\"measure\",\"unit\":\"V\",\"nominal\":12,\"tolerance\":0.5},
  {\"text\":\"ტესტ-E2E ეტიკეტი\",\"item_type\":\"check\",\"critical\":false},
  {\"text\":\"ტესტ-E2E დამატებითი\",\"item_type\":\"check\",\"required\":false}]}")
CLID=$(echo "$CL" | jq -r '.id // empty')
chk "ჩეკლისტი ტიპზე: 5 პუნქტი (არაკრიტიკული, არასავალდებულო)" "$(echo "$CL" | jq -r '"\(.items|length):\([.items[]|select(.critical==false)]|length):\([.items[]|select(.required==false)]|length)"')" "5:1:1"
chk "იგივე სახე + ტიპი, მეორე აქტიური — 409" "$(code POST /bme/checklists "$ENG" -d "{\"kind_id\":\"$SAFETY\",\"type_id\":\"$T_MON\",\"name\":\"ტესტ-E2E 2\",\"items\":[{\"text\":\"x x\",\"item_type\":\"check\"}]}")" "409"

step "2. გეგმები: ავტომატურად ტიპიდან"
mkdev() { api POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"type_id\":\"$2\",\"department_id\":\"$3\"${4:+,\"install_date\":\"$4\"}}" | jq -r '.id // empty'; }
INST=$(d "-2 months"); M1=$(mkdev "მონიტორი A" "$T_MON" "$D1" "$INST")
[ -n "$M1" ] || die "აპარატი ვერ შეიქმნა"
P1=$(pm "$M1")
chk "მონიტორი: PM + კალიბრაცია + ელ. უსაფრთხოება + ახალი სახე (მონიტორინგი) — 4 გეგმა" "$(echo "$P1" | jq -r '[.plans[]|.kind_code]|sort|join(",")')" "$(echo "CALIBRATION E2EK$S PM SAFETY" | tr ' ' '\n' | sort | paste -sd,)"
chk "პირველი ვადა = ექსპლ. შეყვანა + ინტერვალი (12 თვე / 6 თვე)" "$(echo "$P1" | jq -r '.plans[]|select(.kind_code=="PM")|.next_due'):$(echo "$P1" | jq -r ".plans[]|select(.kind_code==\"E2EK$S\")|.next_due")" "$(d "$INST +12 months"):$(d "$INST +6 months")"
M2=$(mkdev "მონიტორი B" "$T_MON" "$D1"); M3=$(mkdev "მონიტორი C" "$T_MON" "$D2")
chk "ექსპლ. შეყვანის გარეშე — პირველი ვადა დასადგენი (null)" "$(pm "$M2" | jq -r '[.plans[]|.next_due]|unique|join(",")')" ""
SC=$(mkdev "სასწორი" "$T_SCALE" "$D1" "$(d '-1 month')")
chk "სასწორი: მხოლოდ მეტროლოგიური დამოწმება" "$(pm "$SC" | jq -r '[.plans[]|.kind_code]|join(",")')" "METROLOGY"
mod '{"pm_auto_plans":false}' >/dev/null
X1=$(mkdev "გეგმის გარეშე" "$T_MON" "$D1")
chk "pm_auto_plans = false → გეგმა არ იქმნება" "$(pm "$X1" | jq '.plans|length')" "0"
mod '{"pm_auto_plans":true}' >/dev/null
O1=$(mkdev "სხვა → დეფიბრილატორი" "$T_OTHER" "$D1")
chk "ტიპი OTHER: მხოლოდ PM" "$(pm "$O1" | jq -r '[.plans[]|.kind_code]|join(",")')" "PM"
api PATCH "/bme/devices/$O1" "$ENG" -d "{\"type_id\":\"$T_DEF\"}" >/dev/null
chk "ტიპის ცვლილება (დეფიბრილატორი) → დაემატა კალიბრაცია + ელ. უსაფრთხოება" "$(pm "$O1" | jq -r '[.plans[]|.kind_code]|sort|join(",")')" "CALIBRATION,PM,SAFETY"
# სატესტო სახე ითიშება sync-მდე — sync ყველა აპარატზე მუშაობს და სხვა (არასატესტო) მონიტორებს ამ სახის გეგმა არ უნდა შეექმნას
chk "სახის გათიშვა → ახალ მონიტორს აღარ ემატება" "$(api PATCH "/bme/kinds/$KID" "$ENG" -d '{"is_active":false}' | jq -r .is_active):$(pm "$(mkdev "მონიტორი D" "$T_MON" "$D1")" | jq '.plans|length')" "false:3"
chk "sync: გეგმის გარეშე აპარატს (X1) შეექმნა 3; ექთანი — 403" "$(api POST /bme/plans/sync "$ENG" | jq -r '.created > 0'):$(pm "$X1" | jq '.plans|length'):$(code POST /bme/plans/sync "$N2")" "true:3:403"

step "3. გეგმის რედაქტირება"
PS1=$(plan "$M1" SAFETY); PP1=$(plan "$M1" PM); PC1=$(plan "$M1" CALIBRATION)
R=$(api PATCH "/bme/plans/$PS1" "$ENG" -d '{"interval_months":6}')
chk "გადაფარვა: 6 თვე (ტიპით 12)" "$(echo "$R" | jq -r ".plans[]|select(.id==\"$PS1\")|\"\(.interval):\(.type_interval):\(.interval_months)\"")" "6:12:6"
LD=$(d "-8 months")
R=$(api PATCH "/bme/plans/$PS1" "$ENG" -d "{\"last_done_on\":\"$LD\"}")
chk "ბოლო შესრულება (ისტორია) → ვადა = +6 თვე (ვადაგადაცილებული)" "$(echo "$R" | jq -r ".plans[]|select(.id==\"$PS1\")|\"\(.next_due):\(.days_left < 0)\"")" "$(d "$LD +6 months"):true"
chk "ბოლო შესრულება მომავალში — 400; ექთანი — 403; სახის ცვლილება — 400" "$(code PATCH "/bme/plans/$PS1" "$ENG" -d "{\"last_done_on\":\"$(d tomorrow)\"}"):$(code PATCH "/bme/plans/$PS1" "$N2" -d '{"interval_months":3}'):$(code PATCH "/bme/plans/$PS1" "$ENG" -d "{\"kind_id\":\"$PMK\"}")" "400:403:400"
CALK=$(echo "$PR" | jq -r '.kinds[]|select(.code=="CALIBRATION")|.id')
chk "ხელით გეგმა: იგივე სახე — 409; მეტროლოგია მონიტორზე — სახის ნაგულისხმევით (12 თვე)" "$(code POST "/bme/devices/$M1/plans" "$ENG" -d "{\"kind_id\":\"$PMK\"}"):$(api POST "/bme/devices/$M1/plans" "$ENG" -d "{\"kind_id\":\"$METRO\"}" | jq -r '.plans[]|select(.kind_code=="METROLOGY")|"\(.interval):\(.source)"')" "409:12:manual"
chk "კალიბრაცია სასწორზე (ტიპს ინტერვალი არ აქვს): თვეების გარეშე — 400; 24 თვით — 201" "$(code POST "/bme/devices/$SC/plans" "$ENG" -d "{\"kind_id\":\"$CALK\"}"):$(code POST "/bme/devices/$SC/plans" "$ENG" -d "{\"kind_id\":\"$CALK\",\"interval_months\":24}")" "400:201"
PSCC=$(plan "$SC" CALIBRATION); PM1=$(plan "$M1" METROLOGY)
chk "გადაფარვის მოხსნა (ტიპს ინტერვალი არ აქვს) — 400; გეგმის გათიშვა — OK" "$(code PATCH "/bme/plans/$PSCC" "$ENG" -d '{"interval_months":null}'):$(api PATCH "/bme/plans/$PM1" "$ENG" -d '{"is_active":false}' | jq -r ".plans[]|select(.id==\"$PM1\")|.is_active")" "400:false"
api PATCH "/bme/plans/$PP1" "$ENG" -d "{\"next_due\":\"$(d '+5 days')\"}" >/dev/null
api PATCH "/bme/plans/$PC1" "$ENG" -d "{\"next_due\":\"$(d '+20 days')\"}" >/dev/null
chk "ხილვადობა: bme_dept (განყ. 1) — 200; სხვა განყ. ექთანი — 403; განყოფილების გარეშე — 403" "$(code GET "/bme/devices/$M1/pm" "$DH1"):$(code GET "/bme/devices/$M1/pm" "$N2"):$(code GET "/bme/devices/$M1/pm" "$N0")" "200:403:403"

step "4. „სამუშაოები“"
has() { api GET "/bme/works?view=$1${3:-}" "${4:-$ENG}" | jq -r "[.[]|select(.id==\"$2\" or .plan_id==\"$2\")]|length"; }
chk "ვადაგადაცილებული: ელ. უსაფრთხოება (M1); PM (+5) — კვირაში; კალიბრაცია (+20) — თვეში, არა კვირაში" "$(has overdue "$PS1"):$(has week "$PP1"):$(has month "$PC1"):$(has week "$PC1")" "1:1:1:0"
chk "დასადგენი (ვადის გარეშე): M2-ის PM" "$(has undated "$(plan "$M2" PM)")" "1"
chk "ფილტრები: განყოფილება 2 — M1 არ ჩანს; სახე (PM) — ელ. უსაფრთხოება არ ჩანს" "$(has overdue "$PS1" "&department_id=$D2"):$(has overdue "$PS1" "&kind_id=$PMK")" "0:0"
chk "ხედვის არე: bme_dept განყ. 1 — ჩანს; ნახვის როლი — ჩანს; სხვა განყ. ექთანი — არ ჩანს; განყ. გარეშე — ცარიელი" "$(has overdue "$PS1" "" "$DH1"):$(has overdue "$PS1" "" "$VW"):$(has overdue "$PS1" "" "$N2"):$(api GET "/bme/works?view=all" "$N0" | jq length)" "1:1:0:0"
C=$(api GET /bme/pm/counts "$DH1")
chk "მთვლელები (bme_dept): ვადაგადაცილებული ≥ 1, კვირა ≥ 2" "$(echo "$C" | jq -r '"\(.overdue >= 1):\(.week >= 2)"')" "true:true"

step "5. სამუშაო: დაგეგმვა, შემსრულებელი"
chk "შიდა შემსრულებელი — არაინჟინერი — 400; გარე — მომწოდებლის / კონტაქტის გარეშე — 400; ექთანი — 403" "$(code POST /bme/works "$ADM" -d "{\"plan_id\":\"$PS1\",\"assignee_id\":\"$N2ID\"}"):$(code POST /bme/works "$ADM" -d "{\"plan_id\":\"$PS1\",\"performer_kind\":\"external\"}"):$(code POST /bme/works "$N2" -d "{\"plan_id\":\"$PS1\"}")" "400:400:403"
W=$(api POST /bme/works "$ADM" -d "{\"plan_id\":\"$PS1\",\"assignee_id\":\"$ENGID\",\"scheduled_date\":\"$(d tomorrow)\"}"); WID=$(echo "$W" | jq -r '.id // empty')
chk "სამუშაო: ნომერი PM-$YY-…, ვადა გეგმიდან, ჩეკლისტი — ტიპის (5 პუნქტი), შემსრულებელი" "$(echo "$W" | jq -r '"\(.work_no|test("^PM-'"$YY"'-[0-9]{5}$")):\(.due_date):\(.items|length):\(.assignee_id):\(.status)"')" "true:$(d "$LD +6 months"):5:$ENGID:planned"
chk "იგივე გეგმაზე მეორე ღია სამუშაო — 409" "$(code POST /bme/works "$ENG" -d "{\"plan_id\":\"$PS1\"}")" "409"
chk "შემსრულებელს — შეტყობინება (bme_work)" "$(notif "$ENG" bme_work)" "1"
chk "სიაში: გეგმის ხაზს ღია სამუშაო ერთვის" "$(api GET "/bme/works?view=overdue" "$ENG" | jq -r ".[]|select(.id==\"$PS1\")|\"\(.work_no == \"$(echo "$W" | jq -r .work_no)\"):\(.work_status)\"")" "true:planned"
PM2=$(plan "$M2" PM); PM3=$(plan "$M3" PM)
R=$(api POST /bme/works/bulk "$ENG" -d "{\"plan_ids\":[\"$PM2\",\"$PM3\"],\"performer_kind\":\"external\",\"supplier_id\":\"$SUP\",\"external_person\":\"ტესტ-E2E ინჟინერი\",\"scheduled_date\":\"$(d '+3 days')\"}")
chk "ჯგუფური დაგეგმვა (გარე): 2 შეიქმნა" "$(echo "$R" | jq -r '"\(.created):\(.updated)"')" "2:0"
R=$(api POST /bme/works/bulk "$ENG" -d "{\"plan_ids\":[\"$PM2\",\"$PM3\"],\"assignee_id\":\"$ENG2ID\"}")
chk "ჯგუფური — იგივე გეგმები: 2 განახლდა (შიდა ინჟინერი 2), შეტყობინება ერთი" "$(echo "$R" | jq -r '"\(.created):\(.updated)"'):$(notif "$ENG2" bme_work)" "0:2:1"
chk "„ჩემი“ ფილტრი (ინჟინერი 2): 2" "$(api GET "/bme/works?view=open&assignee=me" "$ENG2" | jq -r "[.[]|select(.id==\"$PM2\" or .id==\"$PM3\")]|length")" "2"
W2=$(api GET "/bme/works?view=open" "$ENG" | jq -r ".[]|select(.id==\"$PM2\")|.work_id")
chk "გადაგეგმვა / შემსრულებლის შეცვლა (გარე → შიდა)" "$(api PATCH "/bme/works/$W2" "$ENG" -d "{\"scheduled_date\":\"$(d '+4 days')\",\"performer_kind\":\"internal\",\"assignee_id\":\"$ENGID\"}" | jq -r '"\(.scheduled_date):\(.performer_kind):\(.supplier_id)"')" "$(d '+4 days'):internal:null"
chk "ცარიელი ფორმის აქტი (ღია სამუშაო) — PDF" "$(curl -s -o "$TMP/blank.pdf" -w '%{http_code}' "$B/bme/works/$WID/act" -H "authorization: Bearer $ENG"):$(head -c 5 "$TMP/blank.pdf")" "200:%PDF-"

step "6. შესრულება: ჩეკლისტი და შედეგი"
iid() { echo "$W" | jq -r --arg t "$1" '.items[]|select(.text|startswith($t))|.id'; }
I_VIS=$(iid "ტესტ-E2E დათვ"); I_PE=$(iid "ტესტ-E2E დამიწ"); I_V=$(iid "ტესტ-E2E ძაბ"); I_LBL=$(iid "ტესტ-E2E ეტიკ"); I_OPT=$(iid "ტესტ-E2E დამატ")
chk "სავალდებულო პუნქტი „არ ეხება“ — 400; ექთანი — 403" "$(code PUT "/bme/works/$WID/items" "$ENG" -d "{\"items\":[{\"id\":$I_VIS,\"outcome\":\"na\"}]}"):$(code PUT "/bme/works/$WID/items" "$N2" -d "{\"items\":[{\"id\":$I_VIS,\"outcome\":\"pass\"}]}")" "400:403"
R=$(api PUT "/bme/works/$WID/items" "$ENG" -d "{\"items\":[{\"id\":$I_VIS,\"outcome\":\"pass\"},{\"id\":$I_PE,\"value_num\":0.45},{\"id\":$I_V,\"value_num\":12.3}]}")
chk "გაზომვა: 0.45 Ω (≤ 0.3) → fail; 12.3 V (12 ± 0.5) → pass; სტატუსი — მიმდინარე; აკლია 1" "$(echo "$R" | jq -r "[.items[]|select(.id==\"$I_PE\" or .id==\"$I_V\")|.outcome]|join(\",\")"):$(echo "$R" | jq -r '"\(.status):\(.missing):\(.auto_result)"')" "fail,pass:in_progress:1:fail"
chk "დასრულება შეუვსებელით — 400 (CHECKLIST_INCOMPLETE)" "$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"fail\",\"performed_on\":\"$TODAY\",\"result_note\":\"x x x\"}" | jq -r .code)" "CHECKLIST_INCOMPLETE"
api PUT "/bme/works/$WID/items" "$ENG" -d "{\"items\":[{\"id\":$I_LBL,\"outcome\":\"pass\"},{\"id\":$I_OPT,\"outcome\":\"na\"}]}" >/dev/null
chk "კრიტიკული fail: „გავლილი“ / „პირობითად“ — 400 (RESULT_TOO_LOW); „ვერ გაიარა“ კომენტარის გარეშე — 400; მომავლის დღე — 400" "$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\"}" | jq -r .code):$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"conditional\",\"performed_on\":\"$TODAY\",\"result_note\":\"x x x\"}" | jq -r .code):$(code POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"fail\",\"performed_on\":\"$TODAY\"}"):$(code POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"fail\",\"performed_on\":\"$(d tomorrow)\",\"result_note\":\"x x x\"}")" "RESULT_TOO_LOW:RESULT_TOO_LOW:400:400"
R=$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"fail\",\"performed_on\":\"$TODAY\",\"result_note\":\"ტესტ-E2E: დამიწების წინაღობა მაღალია\"}")
chk "„ვერ გაიარა“: დასრულდა, შეთავაზება — გაუმართავი; აპარატის სტატუსი არ შეცვლილა (მუშა)" "$(echo "$R" | jq -r '"\(.status):\(.result):\(.suggested_status):\(.status_applied)"'):$(api GET "/bme/devices/$M1" "$ENG" | jq -r .status)" "done:fail:down:false:operational"
chk "გეგმა: ვადა არ გადაიწია (ისევ ვადაგადაცილებული), ბოლო შედეგი — fail" "$(pm "$M1" | jq -r ".plans[]|select(.id==\"$PS1\")|\"\(.next_due):\(.last_result):\(.work_id)\"")" "$(d "$LD +6 months"):fail:null"
chk "აქტი → დოკუმენტებში (PDF); განყოფილებას (bme_dept) — შეტყობინება (bme_pm_fail)" "$(echo "$R" | jq -r '[.documents[]|select(.kind=="act")]|length'):$(notif "$DH1" bme_pm_fail)" "1:1"
chk "აქტი: bme_dept (განყ. 1) — 200 PDF; სხვა განყ. ექთანი — 403" "$(curl -s -o "$TMP/act.pdf" -w '%{http_code}' "$B/bme/works/$WID/act" -H "authorization: Bearer $DH1"):$(head -c 5 "$TMP/act.pdf"):$(code GET "/bme/works/$WID/act" "$N2")" "200:%PDF-:403"
chk "სტატუსის გამოყენება: ექთანი — 403; „გაუმართავი“ → აპარატი გაუმართავია; მეორედ — 409" "$(code POST "/bme/works/$WID/apply-status" "$N2" -d '{"status":"down"}'):$(api POST "/bme/works/$WID/apply-status" "$ENG" -d '{"status":"down","reason":"ტესტ-E2E"}' | jq -r .status_applied):$(api GET "/bme/devices/$M1" "$ENG" | jq -r '"\(.status):\(.status_reason|test("ვერ გაიარა"))"'):$(code POST "/bme/works/$WID/apply-status" "$ENG" -d '{"status":"down"}')" "403:true:down:true:409"
api POST "/bme/devices/$M1/status" "$ENG" -d '{"status":"operational","reason":"ტესტ-E2E: შეკეთდა"}' >/dev/null
# მეორე ცდა — პირობითად (არაკრიტიკული fail)
W=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PS1\"}"); WID=$(echo "$W" | jq -r .id)
IT=$(echo "$W" | items_pass | jq -c "map(if .id==$(iid "ტესტ-E2E ეტიკ") then {id, outcome:\"fail\"} else . end)")
chk "„გავლილი“ არაკრიტიკული fail-ით — 400; „პირობითად“ — ვადა = დღეს + 6 თვე (გადაფარვა), შეთავაზება — შეზღუდული" "$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$IT}" | jq -r .code):$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"conditional\",\"performed_on\":\"$TODAY\",\"result_note\":\"ტესტ-E2E: ეტიკეტი დასაბეჭდია\",\"items\":$IT}" | jq -r '"\(.next_due):\(.suggested_status)"')" "RESULT_TOO_LOW:$(d '+6 months'):restricted"
chk "„გავლილი“ სამუშაოზე სტატუსის გამოყენება — 409" "$(W3=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PP1\"}"); W3ID=$(echo "$W3" | jq -r .id); api POST "/bme/works/$W3ID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W3" | items_pass)}" >/dev/null; code POST "/bme/works/$W3ID/apply-status" "$ENG" -d '{"status":"restricted"}')" "409"
chk "PM (ბოლო შესრულებიდან): ვადა = დღეს + 12 თვე" "$(pm "$M1" | jq -r ".plans[]|select(.id==\"$PP1\")|\"\(.next_due):\(.last_result)\"")" "$(d '+12 months'):pass"

step "7. კალენდრით, სერტიფიკატით, გაუქმება"
mod '{"pm_due_basis":"calendar"}' >/dev/null
api PATCH "/bme/plans/$PC1" "$ENG" -d "{\"next_due\":\"$(d '-10 days')\"}" >/dev/null
W=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PC1\"}"); WID=$(echo "$W" | jq -r .id)
chk "კალენდრით: ვადა = წინა ვადა + 12 თვე (არა შესრულების დღე)" "$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W" | items_pass)}" | jq -r .next_due)" "$(d "$(d '-10 days') +12 months")"
mod '{"pm_due_basis":"last_done"}' >/dev/null
PSC=$(plan "$SC" METROLOGY)
W=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PSC\",\"performer_kind\":\"external\",\"supplier_id\":\"$SUP\"}"); WID=$(echo "$W" | jq -r .id); IT=$(echo "$W" | items_pass)
chk "მეტროლოგია: ჩეკლისტი — სასწორის (საკონტროლო წონა 10 ± 0.05 კგ); სერტიფიკატის გარეშე — 400" "$(echo "$W" | jq -r '.items[0].text|test("10 კგ")'):$(code POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$IT}")" "true:400"
chk "სერტიფიკატის ვადა ≤ შესრულების დღე — 400" "$(code POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"cert_no\":\"E2E-$S\",\"cert_valid_until\":\"$TODAY\",\"items\":$IT}")" "400"
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMP/cert.pdf"; echo "x" > "$TMP/x.txt"
chk "სერტიფიკატის ფაილი: არა PDF — 400; ექთანი — 403; PDF — დოკუმენტებში" "$(upl "/bme/works/$WID/files" "$ENG" -F "file=@$TMP/x.txt" -F kind=certificate | jq -r .code):$(upl "/bme/works/$WID/files" "$N2" -F "file=@$TMP/cert.pdf" -o /dev/null -w '%{http_code}'):$(upl "/bme/works/$WID/files" "$ENG" -F "file=@$TMP/cert.pdf" -F kind=certificate | jq -r '[.documents[]|select(.kind=="certificate")]|length')" "FILE_TYPE:403:1"
CV=$(d '+11 months')
R=$(api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"cert_no\":\"E2E-$S\",\"cert_valid_until\":\"$CV\",\"items\":$IT}")
chk "სერტიფიკატით: შემდეგი ვადა = სერტიფიკატის ვადა; ფაილს ვადა მიენიჭა; აქტი + სერტიფიკატი" "$(echo "$R" | jq -r '"\(.next_due):\(.cert_no)"'):$(api GET "/bme/devices/$SC" "$ENG" | jq -r "[.documents[]|select(.kind==\"certificate\")][0].valid_until"):$(echo "$R" | jq -r '[.documents[]|.kind]|sort|join(",")')" "$CV:E2E-$S:$CV:act,certificate"
W=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PM2\"}" ); chk "ღია სამუშაოს არსებობისას — 409" "$(echo "$W" | jq -r .statusCode)" "409"
chk "გაუქმება მიზეზის გარეშე — 400; მიზეზით — გაუქმდა; გეგმაზე ისევ შეიძლება ახალი" "$(code POST "/bme/works/$W2/cancel" "$ENG" -d '{}'):$(api POST "/bme/works/$W2/cancel" "$ENG" -d '{"reason":"ტესტ-E2E: გადაიდო"}' | jq -r .status):$(code POST /bme/works "$ENG" -d "{\"plan_id\":\"$PM2\"}")" "400:cancelled:201"
chk "გაუქმებულზე შევსება / დასრულება — 409" "$(code PUT "/bme/works/$W2/items" "$ENG" -d '{"items":[]}'):$(code POST "/bme/works/$W2/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\"}")" "409:409"
chk "ერთჯერადი სამუშაო (გეგმის გარეშე): აპარატი + სახე → „ღიაში“ ჩანს" "$(AW=$(api POST /bme/works "$ENG" -d "{\"device_id\":\"$M3\",\"kind_id\":\"$SAFETY\",\"scheduled_date\":\"$TODAY\"}" | jq -r .id); api GET "/bme/works?view=open" "$ENG" | jq -r "[.[]|select(.id==\"$AW\" and .row==\"work\")]|length")" "1"
chk "შესრულებული (90 დღე): ვერ გაიარა ფილტრით ≥ 1" "$(api GET "/bme/works?view=done&result=fail" "$ENG" | jq -r "[.[]|select(.device_id==\"$M1\")]|length")" "1"

step "8. მოხმარების მთვლელი"
chk "ჩანაწერი 1200 სთ; ექთანი — 403; მომავლის თარიღი — 400" "$(api POST "/bme/devices/$M1/meters" "$ENG" -d "{\"unit\":\"hours\",\"value\":1200,\"read_on\":\"$TODAY\"}" | jq -r '.meters[0].value|tonumber|floor'):$(code POST "/bme/devices/$M1/meters" "$N2" -d "{\"unit\":\"hours\",\"value\":1,\"read_on\":\"$TODAY\"}"):$(code POST "/bme/devices/$M1/meters" "$ENG" -d "{\"unit\":\"hours\",\"value\":1300,\"read_on\":\"$(d tomorrow)\"}")" "1200:403:400"
chk "ნაკლები მნიშვნელობა შენიშვნის გარეშე — METER_DECREASE; შენიშვნით — OK (2 ჩანაწერი)" "$(api POST "/bme/devices/$M1/meters" "$ENG" -d "{\"unit\":\"hours\",\"value\":10,\"read_on\":\"$TODAY\"}" | jq -r .code):$(api POST "/bme/devices/$M1/meters" "$ENG" -d "{\"unit\":\"hours\",\"value\":10,\"read_on\":\"$TODAY\",\"note\":\"ტესტ-E2E: მთვლელი შეიცვალა\"}" | jq -r '.meters|length')" "METER_DECREASE:2"

step "9. შეხსენებები და ვადაგადაცილება"
R1=$(mkdev "ვადაგადაცილებული" "$T_OTHER" "$D1"); PR1=$(plan "$R1" PM)
api PATCH "/bme/plans/$PR1" "$ENG" -d "{\"last_done_on\":\"$(d '-13 months')\"}" >/dev/null
api PATCH "/bme/plans/$(plan "$M2" PM)" "$ENG" -d "{\"next_due\":\"$(d '+5 days')\"}" >/dev/null
api PATCH "/bme/plans/$(plan "$M3" PM)" "$ENG" -d "{\"next_due\":\"$(d '+25 days')\"}" >/dev/null
IDS="[\"$M1\",\"$M2\",\"$M3\",\"$R1\",\"$SC\",\"$O1\",\"$X1\"]"
chk "ხელით გაშვება — მხოლოდ ადმინი (ინჟინერი — 403)" "$(code POST /bme/pm/run-reminders "$ENG" -d "{\"device_ids\":$IDS}")" "403"
R=$(api POST /bme/pm/run-reminders "$ADM" -d "{\"device_ids\":$IDS}")
chk "შეხსენებები: ≥ 3 (ვადაგადაცილება, 7, 30 დღე); „მხოლოდ გაფრთხილება“ — შეზღუდვა 0" "$(echo "$R" | jq -r '"\(.reminders >= 3):\(.restricted)"')" "true:0"
chk "ინჟინერს — სასწრაფო შეჯამება; bme_dept (განყ. 1) — შეჯამება; სხვა განყ. ექთანს — არა" "$(api GET "/notifications?unread=true" "$ENG" | jq -r '[.[]|select(.kind=="bme_pm_due")][0]|"\(.urgent):\(.title|test("ვადაგადაცილებული"))"'):$(notif "$DH1" bme_pm_due):$(notif "$N2" bme_pm_due)" "true:true:1:0"
chk "მეორედ — ახალი შეხსენება არ იგზავნება (ერთხელ)" "$(api POST /bme/pm/run-reminders "$ADM" -d "{\"device_ids\":$IDS}" | jq -r .reminders)" "0"
mod '{"pm_overdue_action":"restrict"}' >/dev/null
R=$(api POST /bme/pm/run-reminders "$ADM" -d "{\"device_ids\":[\"$R1\"]}")
chk "„შეზღუდულად მუშა“ ავტომატურად: ვადაგადაცილებული აპარატი (R1), მიზეზით" "$(echo "$R" | jq -r .restricted):$(api GET "/bme/devices/$R1" "$ENG" | jq -r '"\(.status):\(.status_reason|test("ვადაგადაცილებული გეგმიური"))"')" "1:restricted:true"
W=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PR1\"}"); WID=$(echo "$W" | jq -r .id)
api POST "/bme/works/$WID/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W" | items_pass)}" >/dev/null
chk "სამუშაოს შესრულება → აპარატი აღდგა („მუშა“), ისტორიაში — ავტომატური" "$(api GET "/bme/devices/$R1" "$ENG" | jq -r '"\(.status):\([.events[]|select(.kind=="status" and .data.auto_pm==true)]|length)"')" "operational:2"
chk "ხელით შეზღუდული აპარატი სამუშაოთი არ აღდგება" "$(api POST "/bme/devices/$O1/status" "$ENG" -d '{"status":"restricted","reason":"ტესტ-E2E: ხელით"}' >/dev/null; W=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$(plan "$O1" PM)\"}"); api POST "/bme/works/$(echo "$W" | jq -r .id)/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W" | items_pass)}" >/dev/null; api GET "/bme/devices/$O1" "$ENG" | jq -r .status)" "restricted"
mod '{"pm_overdue_action":"warn"}' >/dev/null

step "10. რეესტრი, გამოყვანა, მოდულის გამორთვა"
chk "რეესტრი: უახლოესი ვადა და ვადაგადაცილების რაოდენობა" "$(api GET "/bme/devices?search=$(enc "მონიტორი A $S")" "$ENG" | jq -r '.[0]|"\(.pm_next_due != null):\(.pm_overdue)"')" "true:0"
chk "ისტორია: work_planned / work_done / plan / meter" "$(api GET "/bme/devices/$M1" "$ENG" | jq -r '[.events[]|.kind]|(index("work_planned")!=null) and (index("work_done")!=null) and (index("plan")!=null) and (index("meter")!=null)')" "true"
OPENW=$(api POST /bme/works "$ENG" -d "{\"plan_id\":\"$PP1\"}" | jq -r .id)
api POST "/bme/devices/$M1/status" "$ENG" -d '{"status":"retired","reason":"ტესტ-E2E: გამოყვანა"}' >/dev/null
chk "გამოყვანა: გეგმები გაითიშა, ღია სამუშაო გაუქმდა, სიაში აღარ ჩანს; ახალი სამუშაო — 409" "$(pm "$M1" | jq -r '[.plans[]|select(.is_active)]|length'):$(api GET "/bme/works/$OPENW" "$ENG" | jq -r .status):$(has all "$PP1"):$(code POST /bme/works "$ENG" -d "{\"device_id\":\"$M1\",\"kind_id\":\"$PMK\"}")" "0:cancelled:0:409"
api PUT /modules/bme "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → სამუშაოები / ცნობარი 403 (MODULE_DISABLED); შეხსენება — 0" "$(code GET /bme/works "$ENG"):$(api GET /bme/pm/refs "$ENG" | jq -r .code):$(api POST /bme/pm/run-reminders "$ADM" -d "{\"device_ids\":$IDS}" | jq -r .reminders)" "403:MODULE_DISABLED:0"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null

step "გასუფთავება"
for id in $(api GET "/bme/devices?search=$(enc "ტესტ-E2E")" "$ENG" | jq -r ".[]|select(.status!=\"retired\" and (.name|endswith(\" $S\")))|.id"); do
  api POST "/bme/devices/$id/status" "$ENG" -d '{"status":"retired","reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
done
chk "სატესტო აპარატები გამოყვანილია, ღია სამუშაო აღარ აქვთ" "$(api GET "/bme/devices?status=active&search=$(enc " $S")" "$ENG" | jq -r "[.[]|select(.name|startswith(\"ტესტ-E2E\"))]|length"):$(api GET "/bme/works?view=open" "$ENG" | jq -r "[.[]|select(.device_name|endswith(\" $S\"))]|length")" "0:0"
api PATCH "/bme/checklists/$CLID" "$ENG" -d '{"is_active":false}' >/dev/null
api PATCH "/bme/kinds/$KID" "$ENG" -d '{"is_active":false}' >/dev/null
[ -n "$SUP" ] && api PATCH "/stock/suppliers/$SUP" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/bme "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "სახე, ჩეკლისტი, მომწოდებელი, მომხმარებლები, როლები, განყოფილებები გათიშულია (ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
