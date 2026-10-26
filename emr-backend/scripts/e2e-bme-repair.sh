#!/usr/bin/env bash
# =====================================================================
# e2e-bme-repair.sh — ბიომედ-აპარატურა, ეტაპი 3 (0075): გაუმართაობის მოთხოვნა → შეკეთების ორდერი, სერვისის კონტრაქტები / SLA / გარანტია
#   პარამეტრები (ვალიდაცია), მოთხოვნა (ვინ / ხედვის არე, „არ მუშაობს“ → გაუმართავი, პრიორიტეტის შეთავაზება, ღია ორდერის გაფრთხილება, შეტყობინებები),
#   ტრიაჟი (P, შიდა / გარე, გარანტია / კონტრაქტი, SLA), დუბლიკატი / უარყოფა (სტატუსის აღდგენა), ქმედებები (დაწყება, მომწოდებელი, ლოდინი),
#   ნაწილები საწყობიდან (bme_use, FEFO, ნაშთი), შესყიდვის მოთხოვნა (მონახაზი), დასრულება (კლასიფიკატორი, შრომა, გარე ხარჯი), შემოწმება შეკეთების შემდეგ,
#   სტატუსის შეთავაზება → გამოყენება, დადასტურება / ავტომატური დახურვა / ინჟინრის დახურვა, ხელახლა გახსნა, SLA გაფრთხილება / დარღვევა (worker, at),
#   PM „ვერ გაიარა“ → ორდერი (ავტომატურად / ღილაკით), ინციდენტი (bme_device) + შენახვა გამოძიებისთვის, კონტრაქტები (CRUD, აპარატები, დაფარვა,
#   PM-ის გარე შემსრულებელი, ვადის შეხსენება), გარანტიის შეხსენება, გამოყვანა ღია ორდერით, მოდულის გამორთვა.
# worker-ის ხელით გაშვება მხოლოდ სატესტო ჩანაწერებზე (ids) — სხვას არ ეხება.
# ბოლოს: სატესტო აპარატები გამოყვანილია, კონტრაქტები გაუქმებულია, მომხმარებლები / განყოფილებები / საქონელი გათიშულია, პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-bme-repair.sh [API_URL]
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
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
d()   { TZ=Asia/Tbilisi date -d "$1" +%F; }
ts()  { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
TODAY=$(d today)
enc()  { jq -rn --arg s "$1" '$s|@uri'; }
mod()  { api PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message // "ok"' | head -c 60; }
modc() { code PUT /modules/bme "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}"; }
notif() { api GET "/notifications?unread=true" "$1" | jq -r --arg k "$2" '[.[]|select(.kind==$k)]|length'; }
rep()  { api GET "/bme/repairs/$1" "${2:-$ENG}"; }
dev()  { api GET "/bme/devices/$1" "$ENG"; }
items_pass() { jq -c '[.items[]|if .item_type=="measure" then {id:(.id|tonumber), value_num:(if .tolerance!=null then (.nominal|tonumber) elif .limit_high!=null then (.limit_high|tonumber) else (.limit_low|tonumber) end)} else {id:(.id|tonumber), outcome:"pass"} end]'; }
jobs() { api POST /bme/repairs/run-jobs "$ADM" -d "$1"; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0075" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0075" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E RO რეანიმაცია $S\",\"code\":\"E2ERA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E RO ქირურგია $S\",\"code\":\"E2ERB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.bmero.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"RO-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.bmero.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_ENG=$(mkrole reng "სამედ. ინჟინერი" '["med_engineer"]'); R_DEP=$(mkrole rdep "აპარატები (განყ.)" '["bme_dept","nurse"]'); R_QM=$(mkrole rqm "ხარისხი" '["quality"]')
R_SM=$(mkrole rsm "საწყობი" '["stock_manager"]')
[ -n "$R_ENG" ] && [ -n "$R_DEP" ] && [ -n "$R_QM" ] && [ -n "$R_SM" ] || die "როლები ვერ შეიქმნა"
read -r ENGID ENG <<< "$(mkuser "[\"$R_ENG\"]" 71)"; read -r ENG2ID ENG2 <<< "$(mkuser "[\"$R_ENG\"]" 72)"
read -r DH1ID DH1 <<< "$(mkuser "[\"$R_DEP\"]" 73 ",\"department_id\":\"$D1\"")"; read -r N1ID N1 <<< "$(mkuser '["nurse"]' 74 ",\"department_id\":\"$D1\"")"
read -r _ N2 <<< "$(mkuser '["nurse"]' 75 ",\"department_id\":\"$D2\"")"; read -r _ QU <<< "$(mkuser "[\"$R_QM\"]" 76 ",\"department_id\":\"$D1\"")"
read -r _ SM <<< "$(mkuser "[\"$R_SM\"]" 77)"
[ -n "$ENG" ] && [ -n "$ENG2" ] && [ -n "$DH1" ] && [ -n "$N1" ] && [ -n "$N2" ] && [ -n "$QU" ] && [ -n "$SM" ] && ok "7 მომხმარებელი (2 ინჟინერი, bme_dept, ექთანი განყ. 1, ექთანი განყ. 2, ხარისხი, საწყობი)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული bme ვერ მოიძებნა"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
SUP=$(api POST /stock/suppliers "$ADM" -d "{\"name\":\"ტესტ-E2E მედსერვისი $S\",\"tax_id\":\"5$(printf '%08d' "$((10#$S))")\"}" | jq -r '.id // empty')
[ -n "$SUP" ] && ok "მომწოდებელი" || die "მომწოდებელი ვერ შეიქმნა"
LOC=$(api POST /stock/locations "$SM" -d "{\"code\":\"E2E_RO_$S\",\"name\":\"ტესტ-E2E ბიომედ საწყობი $S\",\"kind\":\"other\"}" | jq -r '.id // empty')
CATG=$(api GET /stock/refs "$SM" | jq -r '.categories[]|select(.code=="HOUSE").id')
PART=$(api POST /stock/items "$SM" -d "{\"name\":\"ტესტ-E2E SpO2 სენსორი $S\",\"category_id\":\"$CATG\",\"base_unit\":\"piece\"}" | jq -r '.id // empty')
RC=$(api POST /stock/receipts "$SM" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$PART\",\"qty\":5,\"price\":12.5,\"vat_rate\":0}]}" | jq -r .id); api POST "/stock/receipts/$RC/post" "$SM" >/dev/null
[ -n "$LOC" ] && [ -n "$PART" ] && ok "ნაწილების საწყობი: 5 ც × 12.50 ₾" || die "საწყობი / საქონელი ვერ შეიქმნა"
REFS=$(api GET /bme/refs "$ENG"); ty() { echo "$REFS" | jq -r --arg c "$1" '.types[]|select(.code==$c)|.id'; }
T_VENT=$(ty VENTILATOR); T_MON=$(ty PATIENT_MONITOR); T_OTHER=$(ty OTHER)
mkdev() { api POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E $1 $S\",\"type_id\":\"$2\",\"department_id\":\"$3\"${4:-}}" | jq -r '.id // empty'; }
V1=$(mkdev "ვენტილატორი" "$T_VENT" "$D1"); M1=$(mkdev "მონიტორი გარანტიით" "$T_MON" "$D1" ",\"warranty_until\":\"$(d '+45 days')\",\"supplier_id\":\"$SUP\"")
X1=$(mkdev "სხვა A" "$T_OTHER" "$D1"); X2=$(mkdev "სხვა B" "$T_OTHER" "$D1"); C1=$(mkdev "მონიტორი კონტრაქტით" "$T_MON" "$D2"); P1=$(mkdev "PM აპარატი" "$T_OTHER" "$D1")
[ -n "$V1" ] && [ -n "$M1" ] && [ -n "$X1" ] && [ -n "$X2" ] && [ -n "$C1" ] && [ -n "$P1" ] && ok "6 სატესტო აპარატი" || die "აპარატები ვერ შეიქმნა"
mod '{"rep_who":"all_staff","rep_sets_down":true,"rep_close_mode":"confirm","rep_close_auto_days":3,"rep_post_check":"required_life_support","rep_pm_fail":"auto","rep_sla_response":[1,4,24,72],"rep_sla_restore":[24,72,168,336],"rep_sla_warn_pct":80,"rep_labor_rate":20,"rep_parts_location_id":null,"ct_remind_days":[90,30],"wr_remind_days":[60,30]}' >/dev/null

step "1. პარამეტრები და ცნობარები"
chk "ნაგულისხმევი (0075): ყველა / გაუმართავი / დადასტურებით, 3 დღე / ავტომატურად / RO" "$(echo "$ORIG" | jq -r '.settings|"\(.rep_who):\(.rep_sets_down):\(.rep_close_mode):\(.rep_close_auto_days):\(.rep_pm_fail):\(.rep_prefix)"')" "all_staff:true:confirm:3:auto:RO"
chk "არასწორი: rep_who / SLA (კლებადი, რეაგირება > აღდგენა) / ლოკაცია / შეხსენების დღე 0 — 400" \
  "$(modc '{"rep_who":"x"}'):$(modc '{"rep_sla_response":[4,1,24,72]}'):$(modc '{"rep_sla_response":[100,100,200,300]}'):$(modc "{\"rep_parts_location_id\":\"$D1\"}"):$(modc '{"ct_remind_days":[0]}')" "400:400:400:400:400"
chk "cssd მოდულს PM-ის პარამეტრი აღარ ეკუთვნის (0074-ის შეცდომის გასწორება) — 400" "$(code PUT /modules/cssd "$ADM" -d '{"settings":{"pm_due_basis":"calendar"},"reason":"ტესტ-E2E"}')" "400"
RR=$(api GET /bme/repairs/refs "$N1")
chk "ცნობარი: მიზეზი ≥ 8, ქმედება ≥ 7, ექთანს — 200" "$(echo "$RR" | jq -r '"\([.codes[]|select(.kind=="cause")]|length >= 8):\([.codes[]|select(.kind=="action")]|length >= 7)"'):$(code GET /bme/repairs/refs "$N1")" "true:true:200"
CAUSE=$(echo "$RR" | jq -r '.codes[]|select(.code=="WEAR" and .kind=="cause")|.id'); ACT_PART=$(echo "$RR" | jq -r '.codes[]|select(.code=="PART" and .kind=="action")|.id')
SAFETY=$(echo "$RR" | jq -r '.kinds[]|select(.code=="SAFETY")|.id'); PMK=$(echo "$RR" | jq -r '.kinds[]|select(.code=="PM")|.id')
chk "კლასიფიკატორი: ექთანი — 403; ახალი მიზეზი (ინჟინერი); იგივე კოდი — 409" \
  "$(code POST /bme/repair-codes "$N1" -d '{"kind":"cause","code":"E2E","name":"x"}'):$(api POST /bme/repair-codes "$ENG" -d "{\"kind\":\"cause\",\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E მიზეზი\"}" | jq -r .kind):$(code POST /bme/repair-codes "$ENG" -d "{\"kind\":\"cause\",\"code\":\"E2E_$S\",\"name\":\"ტესტ-E2E\"}")" "403:cause:409"
CODEID=$(api GET /bme/repairs/refs "$ENG" | jq -r ".codes[]|select(.code==\"E2E_$S\")|.id")

step "2. მოთხოვნა განყოფილებიდან"
REQ() { jq -nc --arg d "$1" --arg c "$2" --arg u "${3:-normal}" --arg t "$4" '{device_id:$d, condition:$c, urgency:$u, description:$t}'; }
chk "სხვა განყოფილების ექთანი — 403; მოკლე აღწერა — 400" "$(code POST /bme/repairs "$N2" -d "$(REQ "$V1" not_working normal 'ტესტ-E2E არ ირთვება')"):$(code POST /bme/repairs "$N1" -d "$(REQ "$V1" not_working normal 'x')")" "403:400"
R1=$(api POST /bme/repairs "$N1" -d "$(REQ "$V1" not_working normal 'ტესტ-E2E ვენტილატორი არ ირთვება, განგაში')"); R1ID=$(echo "$R1" | jq -r '.id // empty')
[ -n "$R1ID" ] || die "მოთხოვნა ვერ შეიქმნა: $(echo "$R1" | jq -c .)"
chk "№ RO, „მოთხოვნა“, შეთავაზება P1 (სიცოცხ. შემანარჩუნებელი + არ მუშაობს)" "$(echo "$R1" | jq -r '"\(.repair_no|test("^RO[0-9]{2}-[0-9]{5}$")):\(.status):\(.suggested_priority):\(.source)"')" "true:requested:1:request"
chk "აპარატი → „გაუმართავი“, პერიოდი ორდერზე მიბმული" "$(dev "$V1" | jq -r '"\(.status):\(.status_reason|startswith("RO"))"'):$(echo "$R1" | jq -r '.periods|length')" "down:true:1"
chk "ინჟინრებს — სასწრაფო შეტყობინება; განყოფილების bme_dept — სტატუსი" "$(api GET "/notifications?unread=true" "$ENG" | jq -r '[.[]|select(.kind=="bme_repair_new")][0].urgent'):$(notif "$DH1" bme_status)" "true:1"
chk "იმავე აპარატზე ახალი — 409 REPAIR_OPEN (ღია ორდერის სიით)" "$(api POST /bme/repairs "$DH1" -d "$(REQ "$V1" not_working normal 'ტესტ-E2E იგივე პრობლემა')" | jq -r '"\(.code // .message.code // "?"):\(.repairs|length)"')" "REPAIR_OPEN:1"
R2ID=$(api POST /bme/repairs "$DH1" -d "$(REQ "$V1" limited normal 'ტესტ-E2E იგივე ვენტილატორი' | jq -c '.force=true')" | jq -r .id)
chk "force → მეორე ორდერი; შენიშვნა (bme_dept) ორდერზე" "$([ -n "$R2ID" ] && echo ok):$(api POST "/bme/repairs/$R1ID/note" "$DH1" -d '{"text":"ტესტ-E2E: ღამითაც გაითიშა"}' | jq -r '[.events[]|select(.kind=="note")]|length')" "ok:1"
chk "ხედვა: ექთანი — თავისი (1), სხვა განყ. — 0 / 403, bme_dept — განყოფილების (2), ინჟინერი — ორივე" \
  "$(api GET "/bme/repairs?view=open&device_id=$V1" "$N1" | jq length):$(api GET "/bme/repairs?view=open&device_id=$V1" "$N2" | jq length):$(code GET "/bme/repairs/$R1ID" "$N2"):$(api GET "/bme/repairs?view=open&device_id=$V1" "$DH1" | jq length):$(api GET "/bme/repairs?view=open&device_id=$V1" "$ENG" | jq length)" "1:0:403:2:2"
mod '{"rep_who":"bme_dept"}' >/dev/null
chk "rep_who = bme_dept: ექთანი — 403, bme_dept — დაშვებულია (ფორმა: can_request)" "$(code POST /bme/repairs "$N1" -d "$(REQ "$X1" issue normal 'ტესტ-E2E ხმაური')"):$(api GET "/bme/devices/$X1/repairs" "$DH1" | jq -r .can_request):$(api GET "/bme/devices/$X1/repairs" "$N1" | jq -r .can_request)" "403:true:false"
mod '{"rep_who":"all_staff"}' >/dev/null
chk "პასპორტი / რეესტრი: ღია ორდერი ჩანს" "$(dev "$V1" | jq -r '"\(.open_repairs):\(.open_repair_no != null)"')" "2:true"

step "3. ტრიაჟი, დუბლიკატი, უარყოფა"
chk "ტრიაჟი: ექთანი — 403; „სხვა“ მიზეზი კომენტარის გარეშე — 400; დუბლიკატი სხვა აპარატის ორდერზე — 400" \
  "$(code POST "/bme/repairs/$R1ID/triage" "$N1" -d '{"priority":1}'):$(code POST "/bme/repairs/$R2ID/reject" "$ENG" -d '{"reason":"other"}'):$(code POST "/bme/repairs/$R2ID/reject" "$ENG" -d "{\"reason\":\"duplicate\",\"duplicate_of\":\"$R2ID\"}")" "403:400:400"
chk "დუბლიკატი → ძირითად ორდერს; ავტორს — შეტყობინება" "$(api POST "/bme/repairs/$R2ID/reject" "$ENG" -d "{\"reason\":\"duplicate\",\"duplicate_of\":\"$R1ID\"}" | jq -r '"\(.status):\(.duplicate_of_no != null)"'):$(notif "$DH1" bme_repair)" "duplicate:true:1"
T1=$(api POST "/bme/repairs/$R1ID/triage" "$ENG" -d "{\"priority\":1,\"performer_kind\":\"internal\",\"assignee_id\":\"$ENG2ID\",\"triage_note\":\"ტესტ-E2E: სასწრაფოდ\"}")
chk "ტრიაჟი: P1, შიდა (ინჟინერი 2), SLA 1 სთ / 24 სთ, მდგომარეობა ok; დაფარვა — არა" "$(echo "$T1" | jq -r --arg x "$ENG2ID" '"\(.status):\(.priority):\(.assignee_id==$x):\(.sla_response_hours)/\(.sla_restore_hours):\(.sla_response):\(.coverage)"')" "triaged:1:true:1/24:ok:null"
chk "შემსრულებელს — შეტყობინება; დუბლიკატიც ჩანს ძირითადზე" "$(notif "$ENG2" bme_repair):$(rep "$R1ID" | jq -r '.duplicates|length')" "1:1"
# უარყოფა → წინა სტატუსი
RX=$(api POST /bme/repairs "$N1" -d "$(REQ "$X1" not_working normal 'ტესტ-E2E არ ირთვება (ჩართვის ღილაკი)')" | jq -r .id)
chk "X1: „არ მუშაობს“ → გაუმართავი" "$(dev "$X1" | jq -r .status)" "down"
chk "უარყოფა (გაუმართაობა არ არის) → აპარატი „მუშა“, ავტორს — შეტყობინება" "$(api POST "/bme/repairs/$RX/reject" "$ENG" -d '{"reason":"no_fault","note":"ტესტ-E2E: დენის წყარო იყო გათიშული"}' | jq -r .status):$(dev "$X1" | jq -r .status):$(notif "$N1" bme_repair)" "rejected:operational:1"
chk "უარყოფილზე ქმედება — 409" "$(code POST "/bme/repairs/$RX/act" "$ENG" -d '{"action":"start"}')" "409"

step "4. სამუშაო, ნაწილები, შესყიდვა"
chk "ტრიაჟამდე დაწყება — 409 (სხვა ორდერზე); ლოდინი მიზეზის გარეშე — 400" "$(R=$(api POST /bme/repairs "$N1" -d "$(REQ "$X2" issue normal 'ტესტ-E2E ეკრანი ციმციმებს')" | jq -r .id); echo "$R" > "$TMP/rx2"; code POST "/bme/repairs/$R/act" "$ENG" -d '{"action":"start"}'):$(code POST "/bme/repairs/$R1ID/act" "$ENG" -d '{"action":"wait_parts"}')" "409:400"
A=$(api POST "/bme/repairs/$R1ID/act" "$ENG2" -d '{"action":"start"}')
chk "დაწყება → მიმდინარეობს, რეაგირება შესრულდა (met)" "$(echo "$A" | jq -r '"\(.status):\(.started_at != null):\(.sla_response)"')" "in_progress:true:met"
chk "ნაწილი: ლოკაციის გარეშე (პარამეტრიც ცარიელი) — 400; ნაშთზე მეტი — 409 NO_STOCK" \
  "$(code POST "/bme/repairs/$R1ID/parts" "$ENG" -d "{\"lines\":[{\"item_id\":\"$PART\",\"qty\":1}]}"):$(api POST "/bme/repairs/$R1ID/parts" "$ENG" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$PART\",\"qty\":10}]}" | jq -r '.code // .message.code')" "400:NO_STOCK"
P=$(api POST "/bme/repairs/$R1ID/parts" "$ENG" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"item_id\":\"$PART\",\"qty\":2}]}")
chk "ჩამოწერა: WO №, 25.00 ₾, ორდერის ნაწილების ღირებულება, ნაშთი 3" "$(echo "$P" | jq -r '"\(.doc_no|startswith("WO")):\(.total):\(.repair.parts_cost|tonumber+0):\(.repair.parts|length)"'):$(api GET "/stock/balances?location_id=$LOC" "$SM" | jq -r --arg i "$PART" '[.rows[]|select(.item_id==$i)|.qty|tonumber]|add+0')" "true:25:25:1:3"
PU=$(api POST "/bme/repairs/$R1ID/purchase" "$ENG" -d "{\"location_id\":\"$LOC\",\"lines\":[{\"free_name\":\"ტესტ-E2E ტურბინა\",\"qty\":1,\"est_price\":800}],\"notes\":\"ტესტ-E2E\"}")
PRID=$(echo "$PU" | jq -r '.requisition_id // empty')
chk "შესყიდვის მოთხოვნა: მონახაზი (bme_repair), ორდერი → ელოდება ნაწილებს; საწყობის მენეჯერს — შეტყობინება" \
  "$(api GET "/procurement/requisitions/$PRID" "$ADM" | jq -r '"\(.status):\(.source)"'):$(echo "$PU" | jq -r '.repair.status'):$(notif "$SM" bme_repair_purchase)" "draft:bme_repair:waiting_parts:1"
chk "გაგრძელება → მიმდინარეობს" "$(api POST "/bme/repairs/$R1ID/act" "$ENG" -d '{"action":"resume"}' | jq -r .status)" "in_progress"

step "5. დასრულება, შემოწმება შეკეთების შემდეგ, სტატუსი, დადასტურება"
CMP() { jq -nc --arg o "${1:-repaired}" --arg c "${2:-}" --arg a "${3:-}" --arg k "${4:-}" '{outcome:$o, resolution:"ტესტ-E2E: ტურბინის სენსორი შეიცვალა", labor_hours:1.5, external_cost:0}
  + (if $c=="" then {} else {cause_id:$c} end) + (if $a=="" then {} else {action_id:$a} end) + (if $k=="" then {} else {post_check_kind_id:$k} end)'; }
chk "მიზეზის გარეშე — 400; სიცოცხ. შემანარჩუნებელი შემოწმების გარეშე — POST_CHECK_REQUIRED" \
  "$(code POST "/bme/repairs/$R1ID/complete" "$ENG" -d "$(CMP repaired)"):$(api POST "/bme/repairs/$R1ID/complete" "$ENG" -d "$(CMP repaired "$CAUSE" "$ACT_PART")" | jq -r '.code // .message.code')" "400:POST_CHECK_REQUIRED"
C=$(api POST "/bme/repairs/$R1ID/complete" "$ENG" -d "$(CMP repaired "$CAUSE" "$ACT_PART" "$SAFETY")")
CW=$(echo "$C" | jq -r '.post_check_work_id // empty')
chk "შესრულდა: შეთავაზება „მუშა“, შრომა 1.5 × 20 = 30, ჯამი 55, შემოწმების სამუშაო შეიქმნა" "$(echo "$C" | jq -r '"\(.status):\(.suggested_status):\(.labor_cost|tonumber+0):\(.total_cost|tonumber+0):\(.post_check_required):\(.post_check_pending)"'):$([ -n "$CW" ] && echo ok)" "done:operational:30:55:true:true:ok"
chk "შემოწმებამდე: სტატუსის გამოყენება / დადასტურება — 409 POST_CHECK_PENDING; აპარატი ჯერ „გაუმართავი“" \
  "$(api POST "/bme/repairs/$R1ID/apply-status" "$ENG" | jq -r '.code // .message.code'):$(api POST "/bme/repairs/$R1ID/confirm" "$N1" -d '{}' | jq -r '.code // .message.code'):$(dev "$V1" | jq -r .status)" "POST_CHECK_PENDING:POST_CHECK_PENDING:down"
W=$(api GET "/bme/works/$CW" "$ENG")
chk "შემოწმების სამუშაო: ელ. უსაფრთხოება, ორდერზე მიბმული" "$(echo "$W" | jq -r --arg r "$R1ID" '"\(.kind_code):\(.for_repair.id==$r)"')" "SAFETY:true"
api POST "/bme/works/$CW/complete" "$ENG" -d "{\"result\":\"pass\",\"performed_on\":\"$TODAY\",\"items\":$(echo "$W" | items_pass)}" >/dev/null
chk "შემოწმება გავიდა → ორდერის ისტორიაში; სტატუსის გამოყენება → „მუშა“, პერიოდი დაიხურა" \
  "$(rep "$R1ID" | jq -r '"\(.post_check_pending):\([.events[]|select(.kind=="post_check")]|length)"'):$(api POST "/bme/repairs/$R1ID/apply-status" "$ENG" | jq -r .status_applied):$(dev "$V1" | jq -r .status)" "false:2:true:operational"
chk "downtime: ორდერის პერიოდი დახურულია" "$(rep "$R1ID" | jq -r '[.periods[]|select(.status=="down")][0].ended_at != null')" "true"
chk "დადასტურება: სხვა განყ. ექთანი — 403 (ხედვა); ინჟინრის დახურვა (confirm რეჟიმი) — 403" "$(code POST "/bme/repairs/$R1ID/confirm" "$N2" -d '{}'):$(code POST "/bme/repairs/$R1ID/close" "$ENG" -d '{}')" "403:403"
chk "განმცხადებელი ადასტურებს → დახურულია; შემსრულებელს — შეტყობინება" "$(api POST "/bme/repairs/$R1ID/confirm" "$N1" -d '{"note":"ტესტ-E2E: მიღებულია"}' | jq -r '"\(.status):\(.close_kind)"')" "closed:confirmed"
chk "ხელახლა გახსნა (არ მუშაობს) → მიმდინარეობს, გაუმართავი, მთვლელი 1" "$(api POST "/bme/repairs/$R1ID/reopen" "$N1" -d '{"reason":"ტესტ-E2E: ისევ გაითიშა","not_working":true}' | jq -r '"\(.status):\(.reopen_count)"'):$(dev "$V1" | jq -r .status)" "in_progress:1:down"

step "6. გარე შემსრულებელი, გარანტია, SLA (worker)"
RM=$(api POST /bme/repairs "$N1" -d "$(REQ "$M1" not_working urgent 'ტესტ-E2E მონიტორი ჩაქრა')" | jq -r .id)
TM=$(api POST "/bme/repairs/$RM/triage" "$ENG" -d "{\"priority\":2,\"performer_kind\":\"external\",\"supplier_id\":\"$SUP\",\"assignee_id\":\"$ENGID\"}")
chk "გარე + ქარხნული გარანტია → დაფარვა „warranty“; რეაგირება გამოძახებამდე არ ითვლება; აღდგენა 72 სთ" "$(echo "$TM" | jq -r '"\(.coverage):\(.sla_response_due):\(.sla_restore_hours)"')" "warranty:null:72"
chk "ჩამოსვლა გამოძახებამდე — 400; გამოძახება → ელოდება მომწოდებელს, რეაგირების ვადა 4 სთ" \
  "$(code POST "/bme/repairs/$RM/act" "$ENG" -d '{"action":"vendor_arrived"}'):$(api POST "/bme/repairs/$RM/act" "$ENG" -d '{"action":"vendor_called","vendor_ref":"TCK-1"}' | jq -r '"\(.status):\(.sla_response_hours):\(.vendor_ref)"')" "400:waiting_vendor:4:TCK-1"
J1=$(jobs "{\"at\":\"$(ts '+3 hours 30 minutes')\",\"repair_ids\":[\"$RM\"]}")
chk "worker (+3.5 სთ): რეაგირების გაფრთხილება (80%), ერთხელ" "$(echo "$J1" | jq -r .sla_warn):$(jobs "{\"at\":\"$(ts '+3 hours 40 minutes')\",\"repair_ids\":[\"$RM\"]}" | jq -r .sla_warn)" "1:0"
J2=$(jobs "{\"at\":\"$(ts '+5 hours')\",\"repair_ids\":[\"$RM\"]}")
chk "worker (+5 სთ): დარღვევა → სასწრაფო შეტყობინება ინჟინრებს, ისტორიაში" "$(echo "$J2" | jq -r .sla_breach):$(api GET "/notifications?unread=true" "$ENG2" | jq -r '[.[]|select(.kind=="bme_sla_breach")][0].urgent'):$(rep "$RM" | jq -r '[.events[]|select(.kind=="sla_breach")]|length')" "1:true:1"
chk "ჩამოსვლა → მიმდინარეობს; დასრულება (გარე ხარჯი 0, ინვოისი) → შესრულდა" \
  "$(api POST "/bme/repairs/$RM/act" "$ENG" -d '{"action":"vendor_arrived"}' | jq -r .status):$(api POST "/bme/repairs/$RM/complete" "$ENG" -d "$(CMP repaired "$CAUSE" "$ACT_PART" | jq -c '.invoice_no="INV-E2E-1"')" | jq -r '"\(.status):\(.invoice_no)"')" "in_progress:done:INV-E2E-1"
chk "ავტომატური დახურვა: 2 დღეში — არა, 4 დღეში — კი (auto)" "$(jobs "{\"at\":\"$(ts '+2 days')\",\"repair_ids\":[\"$RM\"]}" | jq -r .auto_closed):$(jobs "{\"at\":\"$(ts '+4 days')\",\"repair_ids\":[\"$RM\"]}" | jq -r .auto_closed):$(rep "$RM" | jq -r '"\(.status):\(.close_kind)"')" "0:1:closed:auto"

step "7. სერვისის კონტრაქტები"
CT() { jq -nc --arg s "$SUP" --arg sd "$(d '-30 days')" --arg ed "$1" --arg n "$2" --arg k "$PMK" --arg dv "$C1" \
  '{contract_no:$n, title:"ტესტ-E2E სრული სერვისი", supplier_id:$s, kind:"full_service", start_date:$sd, end_date:$ed, cost:1200, cost_period:"month",
    response_hours:[2,6,24,48], restore_hours:[8,24,72,120], uptime_pct:97, pm_visits_per_year:2, covers_kinds:[$k], device_ids:[$dv]}'; }
chk "ვალიდაცია: ექთანი — 403; დასასრული < დასაწყისი / საათები კლებადი / ღირებულება პერიოდის გარეშე — 400" \
  "$(code POST /bme/contracts "$N1" -d "$(CT "$(d '+20 days')" "E2E-X-$S")"):$(code POST /bme/contracts "$ENG" -d "$(CT "$(d '-60 days')" "E2E-X-$S")"):$(code POST /bme/contracts "$ENG" -d "$(CT "$(d '+20 days')" "E2E-X-$S" | jq -c '.response_hours=[6,2,24,48]')"):$(code POST /bme/contracts "$ENG" -d "$(CT "$(d '+20 days')" "E2E-X-$S" | jq -c 'del(.cost_period)')")" "403:400:400:400"
K=$(api POST /bme/contracts "$ENG" -d "$(CT "$(d '+20 days')" "E2E-CT-$S")"); KID=$(echo "$K" | jq -r '.id // empty')
chk "კონტრაქტი: 1 აპარატი, მოქმედი, წლიური 14400; იგივე № — 409" "$(echo "$K" | jq -r '"\(.devices|length):\(.in_force):\(.annual_cost|tonumber+0)"'):$(code POST /bme/contracts "$ENG" -d "$(CT "$(d '+20 days')" "E2E-CT-$S")")" "1:true:14400:409"
chk "სია: „ვადა ახლოვდება“ (90 დღე); შესყიდვები / bme_dept — ნახვა 200 / 403" "$(api GET "/bme/contracts?view=expiring&search=E2E-CT-$S" "$ENG" | jq length):$(code GET /bme/contracts "$DH1")" "1:403"
chk "დაფარვა C1: კონტრაქტი (P2 რეაგირება 6 სთ)" "$(api GET "/bme/devices/$C1/coverage" "$ENG" | jq -r '"\(.coverage):\(.response_hours[1])"')" "contract:6"
RC1=$(api POST /bme/repairs "$ENG" -d "$(REQ "$C1" limited normal 'ტესტ-E2E ეკგ არხი ხმაურიანია')" | jq -r .id)
chk "ორდერი C1: გარე → დაფარვა კონტრაქტით, აღდგენა P3 = 72 სთ (კონტრაქტიდან)" "$(api POST "/bme/repairs/$RC1/triage" "$ENG" -d "{\"priority\":3,\"performer_kind\":\"external\",\"supplier_id\":\"$SUP\",\"vendor_called\":true}" | jq -r '"\(.coverage):\(.contract_no):\(.sla_restore_hours):\(.sla_response_hours)"')" "contract:E2E-CT-$S:72:24"
chk "PM სამუშაო C1 (შემსრულებლის გარეშე) → გარე, კონტრაქტის მომწოდებელი" "$(api POST /bme/works "$ENG" -d "{\"device_id\":\"$C1\",\"kind_id\":\"$PMK\"}" | jq -r --arg s "$SUP" '"\(.performer_kind):\(.supplier_id==$s)"')" "external:true"
chk "აპარატის დამატება / ამოღება → აპარატის ისტორია" "$(api POST "/bme/contracts/$KID/devices" "$ENG" -d "{\"device_ids\":[\"$X1\"]}" | jq -r '.devices|length'):$(api POST "/bme/contracts/$KID/devices/$X1/remove" "$ENG" | jq -r '.devices|length'):$(dev "$X1" | jq -r '[.events[]|select(.kind=="contract")]|length')" "2:1:2"
chk "ვადის შეხსენება (20 დღე → ეტაპი 30): ინჟინრებს + შესყიდვები, ერთხელ" "$(jobs "{\"contract_ids\":[\"$KID\"],\"repair_ids\":[\"$RC1\"]}" | jq -r .contract_reminders):$(notif "$ENG" bme_contract_due):$(jobs "{\"contract_ids\":[\"$KID\"],\"repair_ids\":[\"$RC1\"]}" | jq -r .contract_reminders)" "1:1:0"
chk "ქარხნული გარანტია (45 დღე → ეტაპი 60): ინჟინრებს, ერთხელ" "$(jobs "{\"device_ids\":[\"$M1\"],\"repair_ids\":[\"$RC1\"],\"contract_ids\":[\"$KID\"]}" | jq -r .warranty_reminders):$(jobs "{\"device_ids\":[\"$M1\"],\"repair_ids\":[\"$RC1\"],\"contract_ids\":[\"$KID\"]}" | jq -r .warranty_reminders)" "1:0"
chk "კონტრაქტის ბარათი: ორდერები SLA-თ" "$(api GET "/bme/contracts/$KID" "$ENG" | jq -r '.repairs|length')" "1"

step "8. PM „ვერ გაიარა“ → ორდერი"
PW=$(api POST /bme/works "$ENG" -d "{\"device_id\":\"$P1\",\"kind_id\":\"$PMK\",\"performer_kind\":\"internal\",\"assignee_id\":\"$ENGID\"}")
PWID=$(echo "$PW" | jq -r .id)
IT=$(echo "$PW" | items_pass | jq -c '.[0].outcome="fail"')
PC=$(api POST "/bme/works/$PWID/complete" "$ENG" -d "{\"result\":\"fail\",\"performed_on\":\"$TODAY\",\"result_note\":\"ტესტ-E2E: კორპუსი დაზიანებულია\",\"items\":$IT}")
PRP=$(echo "$PC" | jq -r '.repair.id // empty')
chk "„ვერ გაიარა“ → ორდერი ავტომატურად: წყარო PM, ტრიაჟი გავლილია, შემსრულებელი — ინჟინერი, აღწერაში ჩავარდნილი" \
  "$(rep "$PRP" | jq -r --arg e "$ENGID" '"\(.source):\(.status):\(.assignee_id==$e):\(.description|test("ჩავარდნილი")):\(.pm_work_no != null)"')" "pm_work:triaged:true:true:true"
chk "იმავე სამუშაოზე ღილაკი — 409" "$(code POST "/bme/works/$PWID/repair" "$ENG")" "409"
chk "სამუშაოს სტატუსის შეთავაზება → პერიოდი ორდერზე მიბმული" "$(api POST "/bme/works/$PWID/apply-status" "$ENG" -d '{"status":"down"}' >/dev/null; rep "$PRP" | jq -r '[.periods[]|select(.status=="down")]|length')" "1"
mod '{"rep_pm_fail":"button"}' >/dev/null
PW2=$(api POST /bme/works "$ENG" -d "{\"device_id\":\"$X2\",\"kind_id\":\"$PMK\",\"performer_kind\":\"internal\"}"); PW2ID=$(echo "$PW2" | jq -r .id)
api POST "/bme/works/$PW2ID/complete" "$ENG" -d "{\"result\":\"conditional\",\"performed_on\":\"$TODAY\",\"result_note\":\"ტესტ-E2E: ეტიკეტი აკლია\",\"items\":$(echo "$PW2" | items_pass)}" >/dev/null
chk "rep_pm_fail = button: ავტომატურად არა; „პირობითად“ → ღილაკით ორდერი" "$(api GET "/bme/works/$PW2ID" "$ENG" | jq -r '.repair'):$(api POST "/bme/works/$PW2ID/repair" "$ENG" | jq -r '"\(.source):\(.condition)"')" "null:pm_work:issue"
mod '{"rep_pm_fail":"auto"}' >/dev/null

step "9. ინციდენტი და შენახვა გამოძიებისთვის"
RH=$(cat "$TMP/rx2")
chk "მოთხოვნა „შეეხო პაციენტს“ → ინციდენტის შეთავაზება" "$(api POST /bme/repairs "$N1" -d "$(REQ "$X2" not_working safety 'ტესტ-E2E შოკი შეეხო პაციენტს' | jq -c '.force=true | .patient_involved=true')" | jq -r '"\(.suggest_incident):\(.suggested_priority)"')" "true:1"
CATS=$(api GET "/quality/classifiers?kind=category" "$N1"); CDEV=$(echo "$CATS" | jq -r '.[]|select(.code=="dev_failure")|.id')
INC=$(curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $N1" -F "data=$(jq -nc --arg d "$D1" --arg c "$CDEV" --arg at "$(ts '-10 minutes')" --arg x "$X2" \
  '{event_type:"near_miss",affected:"none",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"none",description:"ტესტ-E2E: აპარატმა დენი გაატარა",identity_mode:"open",source_type:"bme_device",source_id:$x}')")
INCID=$(echo "$INC" | jq -r '.id // empty')
chk "ინციდენტი წყაროთი bme_device (ხარისხის მოდული); ორდერზე ჩანს № და სტატუსი" "$([ -n "$INCID" ] && echo ok || echo "$INC" | jq -c . | head -c 200):$(rep "$RH" | jq -r --arg i "$INCID" '[.incidents[]|select(.id==$i)]|length')" "ok:1"
chk "შენახვა: ექთანი — 403; მიზეზის გარეშე — 400; ხარისხი → hold, აპარატი გაუმართავი" \
  "$(code POST "/bme/repairs/$RH/hold" "$N1" -d '{"on":true,"note":"x"}'):$(code POST "/bme/repairs/$RH/hold" "$QU" -d '{"on":true}'):$(api POST "/bme/repairs/$RH/hold" "$QU" -d '{"on":true,"note":"ტესტ-E2E: გამოძიება"}' | jq -r .hold):$(dev "$X2" | jq -r .status)" "403:400:true:down"
api POST "/bme/repairs/$RH/triage" "$ENG" -d '{"priority":2}' >/dev/null
chk "hold: დაწყება / სტატუსი „მუშა“ / დასრულება — 409 BME_HOLD" \
  "$(api POST "/bme/repairs/$RH/act" "$ENG" -d '{"action":"start"}' | jq -r '.code // .message.code'):$(api POST "/bme/devices/$X2/status" "$ENG" -d '{"status":"operational"}' | jq -r '.code // .message.code'):$(api POST "/bme/repairs/$RH/complete" "$ENG" -d "$(CMP repaired "$CAUSE")" | jq -r '.code // .message.code')" "BME_HOLD:BME_HOLD:BME_HOLD"
chk "ინციდენტის ბმა (ხარისხი); სხვა აპარატის ინციდენტი — 400" "$(api POST "/bme/repairs/$RH/incident" "$QU" -d "{\"incident_id\":\"$INCID\"}" | jq -r '.incident_no != null'):$(code POST "/bme/repairs/$R1ID/incident" "$ENG" -d "{\"incident_id\":\"$INCID\"}")" "true:400"
chk "მოხსნა: ინჟინერი — 403; ხარისხი → ok; დაწყება შესაძლებელია" "$(code POST "/bme/repairs/$RH/hold" "$ENG" -d '{"on":false}'):$(api POST "/bme/repairs/$RH/hold" "$QU" -d '{"on":false}' | jq -r .hold):$(api POST "/bme/repairs/$RH/act" "$ENG" -d '{"action":"start"}' | jq -r .status)" "403:false:in_progress"

step "10. ინჟინრის დახურვა, შეუკეთებელი → გამოყვანა, მოდული"
mod '{"rep_close_mode":"engineer"}' >/dev/null
chk "engineer რეჟიმი: დასრულება (საშუალო კრიტიკულობა) → მაშინვე დახურულია" "$(api POST "/bme/repairs/$RH/complete" "$ENG" -d "$(CMP repaired "$CODEID")" | jq -r '"\(.status):\(.close_kind)"')" "closed:engineer"
mod '{"rep_close_mode":"confirm"}' >/dev/null
RP=$(api POST /bme/repairs "$ENG" -d "$(REQ "$X1" not_working normal 'ტესტ-E2E დაფა დაიწვა' | jq -c '.as_engineer=true')" | jq -r .id)
api POST "/bme/repairs/$RP/triage" "$ENG" -d '{"priority":3}' >/dev/null
chk "შეუკეთებელი → შეთავაზება „გამოყვანილი“ → აპარატი გამოყვანილია, ორდერი დაიხურა" \
  "$(api POST "/bme/repairs/$RP/complete" "$ENG" -d "$(CMP not_repairable "$CAUSE")" | jq -r '"\(.source):\(.suggested_status)"'):$(api POST "/bme/repairs/$RP/apply-status" "$ENG" | jq -r '"\(.device_status):\(.status)"')" "engineer:retired:retired:closed"
chk "მთვლელები / შემაჯამებელი" "$(api GET /bme/repairs/counts "$ENG" | jq -r '(.open >= 1) and (.sla_breached >= 0)'):$(api GET /bme/summary "$ENG" | jq -r '(.open_repairs >= 1) and (.contracts_90 >= 1)')" "true:true"
api PUT /modules/bme "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია → ორდერები / კონტრაქტები 403; worker — 0" "$(code GET /bme/repairs "$ENG"):$(code GET /bme/contracts "$ENG"):$(jobs "{\"repair_ids\":[\"$RC1\"]}" | jq -r .sla_breach)" "403:403:0"
api PUT /modules/bme "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null

step "გასუფთავება"
for id in $(api GET "/bme/repairs?view=open&search=$(enc "ტესტ-E2E")" "$ENG" | jq -r '.[]|select(.hold)|.id'); do api POST "/bme/repairs/$id/hold" "$QU" -d '{"on":false}' >/dev/null; done
for id in $(api GET "/bme/devices?search=$(enc "ტესტ-E2E")" "$ENG" | jq -r ".[]|select(.status!=\"retired\" and (.name|endswith(\" $S\")))|.id"); do
  api POST "/bme/devices/$id/status" "$ENG" -d '{"status":"retired","reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
done
chk "სატესტო აპარატები გამოყვანილია, ღია ორდერი აღარ აქვთ" "$(api GET "/bme/devices?status=active&search=$(enc " $S")" "$ENG" | jq -r "[.[]|select(.name|startswith(\"ტესტ-E2E\"))]|length"):$(api GET "/bme/repairs?view=open" "$ENG" | jq -r "[.[]|select(.device_name|endswith(\" $S\")) | select(.status!=\"done\")]|length")" "0:0"
api POST "/bme/contracts/$KID/cancel" "$ENG" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
[ -n "$PRID" ] && api POST "/procurement/requisitions/$PRID/cancel" "$ADM" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null
[ -n "$CODEID" ] && api PATCH "/bme/repair-codes/$CODEID" "$ENG" -d '{"is_active":false}' >/dev/null
api PATCH "/stock/items/$PART" "$SM" -d '{"is_active":false}' >/dev/null; api PATCH "/stock/locations/$LOC" "$SM" -d '{"is_active":false}' >/dev/null
api PATCH "/stock/suppliers/$SUP" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/bme "$ADM" -d "$(echo "$ORIG" | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "მოდულის პარამეტრები დაბრუნებულია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="bme")|{enabled, settings}')" "$ORIG"
for U in $(cat "$TMP/users" 2>/dev/null); do api PATCH "/users/$U" "$ADM" -d '{"role":"nurse","roles":["nurse"]}' >/dev/null; api POST "/users/$U/disable" "$ADM" >/dev/null; done
for R in $(cat "$TMP/roles" 2>/dev/null); do api DELETE "/roles/$R" "$ADM" >/dev/null; done
for X in "$D1" "$D2"; do api PATCH "/departments/$X" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "კონტრაქტი გაუქმებულია; PR, კლასიფიკატორი, საქონელი, ლოკაცია, მომწოდებელი, მომხმარებლები, როლები, განყოფილებები გათიშულია (ისტორია რჩება)"

printf '\n\033[1mშედეგი: \033[32m%d გავიდა\033[0m, \033[31m%d ჩავარდა\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
