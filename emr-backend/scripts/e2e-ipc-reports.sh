#!/usr/bin/env bash
# =====================================================================
# e2e-ipc-reports.sh — ინფექციის კონტროლი, ეტაპი 6 (0072): ჩეკლისტები / აუდიტები, ანგარიშები, KPI ipc_*, „ყურადღება“, რეესტრი
#   პარამეტრები, შაბლონები (შექმნა / კითხვების შეცვლა / გათიშვა), ხელის ჰიგიენა (WHO 5 მომენტი — დაკვირვებები, შესაბამისობა),
#   ჩეკლისტი (კი / არა / არ ეხება, დასრულება, უცვლელობა), ხედვის არე (IPC განყ., განყოფილების ხელმძღვანელი — audit_by_dept_head),
#   სტატისტიკა, IPC ანგარიში (= KPI მენეჯერულ დაფაზე), „ყურადღება“, dashboard_visibility, ექსპორტი xlsx / PDF, დეპერსონალიზებული რეესტრი
#   bash scripts/e2e-ipc-reports.sh [API_URL]    ან  ADMIN_EMAIL=… ADMIN_PW=… bash scripts/e2e-ipc-reports.sh
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
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW" | jq -r '.accessToken // empty'); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
ecode() { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@" | jq -r 'if type=="object" then (.code // .error.code // (if (.message|type)=="object" then .message.code else null end) // empty) else empty end'; }
S=$(date +%s | tail -c 7)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TODAY=$(TZ=Asia/Tbilisi date +%F)
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.ipr.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"IPR-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.ipr.$2.$S@test.local" "$tmp" | jq -r .accessToken)
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
uid() { cat "$TMP/u$1"; }
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_ipr_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && echo "e2e_ipr_$1_$S"; }
ipcset() { api PUT /modules/ipc "$ADM" -d "{\"enabled\":true,\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
kv() { echo "$1" | jq -r --arg c "$2" '.kpis[]|select(.code==$c)|.value'; }
refresh() {
  local R id st i; R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  if [ -z "$id" ]; then
    for i in $(seq 1 60); do sleep 1; [ "$(api GET /reporting/runs "$ADM" | jq -r '.running // empty')" = "" ] && break; done
    R=$(api POST /reporting/refresh "$ADM" -d "{\"from\":\"$1\",\"to\":\"$2\"}"); id=$(echo "$R" | jq -r '.run_id // empty')
  fi
  [ -n "$id" ] || { echo "$R"; return; }
  for i in $(seq 1 120); do st=$(api GET "/reporting/runs/$id" "$ADM" | jq -r .status); [ "$st" != "running" ] && break; sleep 1; done
  api GET "/reporting/runs/$id" "$ADM"
}

step "0. პარამეტრები"
O_IPC=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')
O_RPT=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="reporting")|{enabled, settings}')
echo "$O_IPC" | jq -e '.settings.hh_target != null' >/dev/null || die "0072 არ არის დაყენებული (აუდიტის პარამეტრები აკლია)"
chk "ნაგულისხმევი: ხელმძღვანელი — არა, სამიზნე 80, მინ. 200, სიგნალი 3 დღე, დაფა — ყველას, თვიური სექცია" \
  "$(echo "$O_IPC" | jq -r '.settings|"\(.audit_by_dept_head):\(.hh_target):\(.hh_min_obs):\(.signal_overdue_days):\(.dashboard_visibility):\(.monthly_section)"')" "false:80:200:3:report_users:true"
chk "ვალიდაცია: სამიზნე 101 / ხილვადობა x / სიგნალი 0 → 400" \
  "$(code PUT /modules/ipc "$ADM" -d '{"settings":{"hh_target":101},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"dashboard_visibility":"x"},"reason":"ტესტ-E2E"}'):$(code PUT /modules/ipc "$ADM" -d '{"settings":{"signal_overdue_days":0},"reason":"ტესტ-E2E"}')" "400:400:400"
ipcset '{"audit_by_dept_head":false,"hh_target":80,"hh_min_obs":200,"signal_overdue_days":3,"dashboard_visibility":"report_users","monthly_section":true}'
[ "$(echo "$O_RPT" | jq -r .enabled)" = "true" ] || api PUT /modules/reporting "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null

step "1. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E IPR თერაპია $S\",\"code\":\"E2ERA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
DB=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E IPR ქირურგია $S\",\"code\":\"E2ERB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] && [ -n "$DB" ] || die "განყოფილებები ვერ შეიქმნა"
R_IPC=$(mkrole ipc "ინფექციის კონტროლი" '["infection"]'); R_IPD=$(mkrole ipd "IPC განყ." '["infection_dept"]'); R_IPV=$(mkrole ipv "IPC ანგარიშები" '["infection_view"]')
[ -n "$R_IPC" ] && [ -n "$R_IPD" ] && [ -n "$R_IPV" ] || die "როლები ვერ შეიქმნა"
IC=$(mkuser "[\"$R_IPC\"]" 61); ID=$(mkuser "[\"$R_IPD\"]" 62 ",\"department_id\":\"$DA\""); IV=$(mkuser "[\"$R_IPV\"]" 63)
NH=$(mkuser '["nurse"]' 64 ",\"department_id\":\"$DA\",\"is_section_head\":true"); NA=$(mkuser '["nurse"]' 65 ",\"department_id\":\"$DA\"")
DR=$(mkuser '["doctor"]' 66 ",\"department_id\":\"$DA\""); DRID=$(uid 66)
[ -n "$IC" ] && [ -n "$ID" ] && [ -n "$IV" ] && [ -n "$NH" ] && [ -n "$NA" ] && [ -n "$DR" ] && ok "6 მომხმარებელი (IPC, IPC განყ. A, IPC ანგარიშები, უფროსი ექთანი A, ექთანი A, ექიმი A)" || die "მომხმარებლები ვერ შეიქმნა"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"IPR-$2\",\"birth_date\":\"1960-03-03\",\"gender\":\"$3\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 51 "ერთი" male); P2=$(mkpat 52 "ორი" female)
ADMIT() { api POST /inpatient/admissions "$DR" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$DRID\",\"source\":\"emergency\",\"icd10_code\":\"A41.9\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1"); E2=$(ADMIT "$P2")
[ -n "$E1" ] && [ -n "$E2" ] && ok "P1, P2 — სტაციონარი (A)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"

step "2. შაბლონები"
T0=$(api GET /ipc/audit-templates "$IC")
HH=$(echo "$T0" | jq -r '.[]|select(.code=="hand_hygiene").id'); ISO=$(echo "$T0" | jq -r '.[]|select(.code=="isolation").id')
chk "წინასწარ: ხელის ჰიგიენა (WHO 5, 80%), იზოლაცია (8 კითხვა, 90%), დასუფთავება (8)" \
  "$(echo "$T0" | jq -r '[.[]|select(.code=="hand_hygiene" or .code=="isolation" or .code=="cleaning")|"\(.code):\(.kind):\(.items|length):\(.target)"]|join(" ")')" \
  "hand_hygiene:hand_hygiene:0:80 isolation:checklist:8:90 cleaning:checklist:8:90"
chk "შექმნა: IPC განყ. → 403; კითხვების გარეშე → 400; ხელის ჰიგიენას კითხვა → 400 HH_FIXED" \
  "$(code POST /ipc/audit-templates "$ID" -d '{"code":"x_1","name":"xxx","items":[{"text":"xxx"}]}'):$(code POST /ipc/audit-templates "$IC" -d '{"code":"x_1","name":"xxx"}'):$(ecode PATCH "/ipc/audit-templates/$HH" "$IC" -d '{"items":[{"text":"xxx"}]}')" "403:400:HH_FIXED"
TC=$(api POST /ipc/audit-templates "$IC" -d "{\"code\":\"e2e_cl_$S\",\"name\":\"ტესტ-E2E ცენტრალური ხაზი $S\",\"target\":95,\"items\":[{\"section\":\"ჩადგმა\",\"text\":\"ხელის ჰიგიენა ჩადგმამდე\"},{\"section\":\"ჩადგმა\",\"text\":\"მაქსიმალური სტერილური ბარიერი\"},{\"section\":\"მოვლა\",\"text\":\"ნახვევი სუფთა და მშრალია\"}]}")
TCID=$(echo "$TC" | jq -r '.id // empty')
chk "ჩეკლისტი შეიქმნა (3 კითხვა, 95%); იგივე კოდი → 409" "$(echo "$TC" | jq -r '"\(.items|length):\(.target)"'):$(code POST /ipc/audit-templates "$IC" -d "{\"code\":\"e2e_cl_$S\",\"name\":\"xxx\",\"items\":[{\"text\":\"xxx\"}]}")" "3:95:409"
I1=$(echo "$TC" | jq -r '.items[0].id'); I2=$(echo "$TC" | jq -r '.items[1].id')
TU=$(api PATCH "/ipc/audit-templates/$TCID" "$IC" -d "{\"items\":[{\"id\":\"$I1\",\"section\":\"ჩადგმა\",\"text\":\"ხელის ჰიგიენა ჩადგმამდე\"},{\"id\":\"$I2\",\"section\":\"ჩადგმა\",\"text\":\"სტერილური ბარიერი (ქუდი, ნიღაბი, ხალათი, ხელთათმანი, ზეწარი)\"},{\"section\":\"მოვლა\",\"text\":\"ყოველდღიური შეფასება — ხაზი ჯერ კიდევ საჭიროა?\"}]}")
chk "კითხვების შეცვლა: ამოღებული — გათიშულია (all=1-ში ჩანს), ახალი დაემატა → აქტიური 3" \
  "$(api GET "/ipc/audit-templates?all=1" "$IC" | jq -r --arg t "$TCID" '.[]|select(.id==$t)|"\([.items[]|select(.is_active)]|length):\([.items[]|select(.is_active|not)]|length)"')" "3:1"

step "3. ხელის ჰიგიენა (WHO 5 მომენტი)"
chk "IPC განყ. A: განყოფილება B → 403 OUT_OF_SCOPE; ექთანი (არა ხელმძღვანელი) → 403" \
  "$(ecode POST /ipc/audits "$ID" -d "{\"template_id\":\"$HH\",\"department_id\":\"$DB\"}"):$(code POST /ipc/audits "$NA" -d "{\"template_id\":\"$HH\",\"department_id\":\"$DA\"}")" "OUT_OF_SCOPE:403"
A1=$(api POST /ipc/audits "$ID" -d "{\"template_id\":\"$HH\",\"department_id\":\"$DA\",\"location\":\"პალატა 1–4\"}" | jq -r '.id // empty')
[ -n "$A1" ] && ok "IPC განყ. A — აუდიტი (draft)" || die "აუდიტი ვერ შეიქმნა"
chk "ვალიდაცია: მომენტის გარეშე / მომენტი 6 / ქმედება x → 400; ჩეკლისტის პასუხი → 400 KIND" \
  "$(code POST "/ipc/audits/$A1/observations" "$ID" -d '{"profession":"nurse","moments":[],"action":"rub"}'):$(code POST "/ipc/audits/$A1/observations" "$ID" -d '{"profession":"nurse","moments":[6],"action":"rub"}'):$(code POST "/ipc/audits/$A1/observations" "$ID" -d '{"profession":"nurse","moments":[1],"action":"x"}'):$(ecode PUT "/ipc/audits/$A1/answers" "$ID" -d "{\"answers\":[{\"item_id\":\"$I1\",\"answer\":\"yes\"}]}")" \
  "400:400:400:KIND"
obs() { api POST "/ipc/audits/$A1/observations" "$ID" -d "{\"profession\":\"$1\",\"moments\":$2,\"action\":\"$3\"}" >/dev/null; }
obs nurse '[1]' rub; obs nurse '[4,5]' rub; obs nurse '[2]' wash; obs nurse '[1]' missed; obs doctor '[1]' rub; obs doctor '[4]' missed
obs doctor '[3]' wash; obs assistant '[5]' missed; obs assistant '[4]' rub; obs nurse '[3,4]' rub
X=$(api POST "/ipc/audits/$A1/observations" "$ID" -d '{"profession":"other","moments":[1],"action":"rub"}' | jq -r '.observations[-1].id')
R=$(api DELETE "/ipc/audits/$A1/observations/$X" "$ID")
chk "10 დაკვირვება (11-ე წაიშალა)" "$(echo "$R" | jq -r '.observations|length')" "10"
chk "სხვა (IPC განყ. — არა ავტორი, არა infection) — IC შეუძლია ნახვა; ID-ს აუდიტზე ექიმი → 403" "$(code GET "/ipc/audits/$A1" "$IC"):$(code GET "/ipc/audits/$A1" "$DR")" "200:403"
R=$(api POST "/ipc/audits/$A1/complete" "$ID" -d '{}')
chk "დასრულება: 7 / 10 = 70%" "$(echo "$R" | jq -r '"\(.status):\(.opps_n):\(.done_n):\(.compliance)"')" "completed:10:7:70"
chk "დასრულებულზე: დაკვირვება → 409 COMPLETED; წაშლა → 409" \
  "$(ecode POST "/ipc/audits/$A1/observations" "$ID" -d '{"profession":"nurse","moments":[1],"action":"rub"}'):$(code DELETE "/ipc/audits/$A1" "$IC")" "COMPLETED:409"
A0=$(api POST /ipc/audits "$IC" -d "{\"template_id\":\"$HH\",\"department_id\":\"$DB\"}" | jq -r '.id // empty')
chk "ცარიელი აუდიტის დასრულება → 400 INCOMPLETE; draft-ის წაშლა → ✓ (404 შემდეგ)" \
  "$(ecode POST "/ipc/audits/$A0/complete" "$IC" -d '{}'):$(api DELETE "/ipc/audits/$A0" "$IC" | jq -r .ok):$(code GET "/ipc/audits/$A0" "$IC")" "INCOMPLETE:true:404"

step "4. ჩეკლისტი (იზოლაცია)"
A2=$(api POST /ipc/audits "$IC" -d "{\"template_id\":\"$ISO\",\"department_id\":\"$DA\",\"location\":\"იზოლატორი\"}")
A2ID=$(echo "$A2" | jq -r '.id // empty'); IT=$(echo "$A2" | jq -c '[.items[].id]')
api PUT "/ipc/audits/$A2ID/answers" "$IC" -d "$(echo "$IT" | jq -c '{answers:[.[0:3][]|{item_id:.,answer:"yes"}]}')" >/dev/null
chk "ნაწილობრივ (3 / 8) → დასრულება 400 INCOMPLETE" "$(ecode POST "/ipc/audits/$A2ID/complete" "$IC" -d '{}')" "INCOMPLETE"
R=$(api PUT "/ipc/audits/$A2ID/answers" "$IC" -d "$(echo "$IT" | jq -c '{answers:([.[3:6][]|{item_id:.,answer:"yes"}] + [{item_id:.[6],answer:"no",comment:"ტესტ-E2E: კონტეინერი გადავსებულია"},{item_id:.[7],answer:"na"}])}')")
chk "ყველა პასუხი (კი 6, არა 1, არ ეხება 1); სხვა შაბლონის კითხვა → 400" \
  "$(echo "$R" | jq -r '[.answers[].answer]|group_by(.)|map("\(.[0])=\(length)")|join(",")'):$(code PUT "/ipc/audits/$A2ID/answers" "$IC" -d "{\"answers\":[{\"item_id\":\"$I1\",\"answer\":\"yes\"}]}")" "na=1,no=1,yes=6:400"
chk "დასრულება: 6 / (6 + 1) = 85.7%" "$(api POST "/ipc/audits/$A2ID/complete" "$IC" -d '{}' | jq -r '"\(.yes_n):\(.no_n):\(.na_n):\(.compliance)"')" "6:1:1:85.7"

step "5. განყოფილების ხელმძღვანელი (audit_by_dept_head)"
chk "გამორთულია: უფროსი ექთანი → 403" "$(code POST /ipc/audits "$NH" -d "{\"template_id\":\"$TCID\",\"department_id\":\"$DA\"}")" "403"
ipcset '{"audit_by_dept_head":true}'
A3=$(api POST /ipc/audits "$NH" -d "{\"template_id\":\"$TCID\",\"department_id\":\"$DA\"}"); A3ID=$(echo "$A3" | jq -r '.id // empty')
chk "ჩართულია: უფროსი ექთანი A — ✓ (3 კითხვა); B → 403; რიგითი ექთანი → 403; IPC განყ. (არა ავტორი) ცვლის → 403 NOT_AUTHOR" \
  "$(echo "$A3" | jq -r '[.items[]|select(.is_active)]|length'):$(code POST /ipc/audits "$NH" -d "{\"template_id\":\"$TCID\",\"department_id\":\"$DB\"}"):$(code POST /ipc/audits "$NA" -d "{\"template_id\":\"$TCID\",\"department_id\":\"$DA\"}"):$(ecode PATCH "/ipc/audits/$A3ID" "$ID" -d '{"location":"x"}')" \
  "3:403:403:NOT_AUTHOR"
api PUT "/ipc/audits/$A3ID/answers" "$NH" -d "$(echo "$A3" | jq -c '{answers:[.items[]|select(.is_active)|{item_id:.id,answer:"yes"}]}')" >/dev/null
chk "უფროსი ექთანი ასრულებს → 100%; სიაში ხედავს მხოლოდ A-ს" \
  "$(api POST "/ipc/audits/$A3ID/complete" "$NH" -d '{}' | jq -r .compliance):$(api GET /ipc/audits "$NH" | jq -r --arg d "$DA" '[.[]|select(.department_id!=$d)]|length')" "100:0"
ipcset '{"audit_by_dept_head":false}'

step "6. სტატისტიკა"
ST=$(api GET "/ipc/audits/stats?from=$TODAY&to=$TODAY&department_id=$DA" "$IC")
chk "ხელის ჰიგიენა: 10 / 7 = 70%; ანტისეპტიკი 5, დაბანა 2; A — „არასაკმარისი“ (< 200)" \
  "$(echo "$ST" | jq -r '.hand_hygiene|"\(.opps):\(.done):\(.pct):\(.rub):\(.wash):\(.departments[0].insufficient)"')" "10:7:70:5:2:true"
chk "მომენტები: 1 — 2/3 (66.7), 4 — 3/4 (75); პროფესიები: ექთანი 4/5 (80), ექიმი 2/3, უმცროსი 1/2" \
  "$(echo "$ST" | jq -r '.hand_hygiene|"\(.moments[0].done)/\(.moments[0].opps)=\(.moments[0].pct) \(.moments[3].done)/\(.moments[3].opps)=\(.moments[3].pct) \([.professions[]|"\(.profession)=\(.done)/\(.opps)"]|join(","))"')" \
  "2/3=66.7 3/4=75 doctor=2/3,nurse=4/5,assistant=1/2"
chk "ჩეკლისტები: იზოლაცია 85.7 (ხშირი „არა“ — 1), ცენტრ. ხაზი 100" \
  "$(echo "$ST" | jq -r '[.checklists[]|"\(.pct):\(.top_no|length)"]|sort|join(" ")')" "100:0 85.7:1"
chk "IPC ანგარიშები (infection_view) — 200; ექიმი → 403; from > to → 400" \
  "$(code GET "/ipc/audits/stats?from=$TODAY&to=$TODAY" "$IV"):$(code GET "/ipc/audits/stats?from=$TODAY&to=$TODAY" "$DR"):$(code GET "/ipc/audits/stats?from=$TODAY&to=2020-01-01" "$IC")" "200:403:400"

step "7. IPC ანგარიში და KPI"
FL=$(api POST /ipc/flags "$IC" -d "{\"patient_id\":\"$P1\",\"mdro_code\":\"mrsa\",\"source\":\"manual\",\"onset\":\"hospital\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty')
[ -n "$FL" ] && ok "MDRO ფლაგი (ხელით, ჰოსპიტალური) — P1" || bad "MDRO ფლაგი" "$FL"
api POST /ipc/device-days/refresh "$IC" -d "{\"from\":\"$TODAY\",\"to\":\"$TODAY\"}" >/dev/null
RP=$(api GET "/ipc/reports/summary?from=$TODAY&to=$TODAY&department_id=$DA" "$IC")
chk "ანგარიში (A): პაციენტ-დღე 2, MDRO ჰოსპ. 1 → 500 / 1000; ხელის ჰიგიენა 70%" \
  "$(echo "$RP" | jq -r '"\(.total.patient_days):\(.total.mdro_hosp):\(.kpi.ipc_mdro_rate):\(.kpi.ipc_hh_pct):\(.kpi_defs|length)"')" "2:1:500:70:10"
chk "ანგარიში: განყოფილებების ცხრილი, MDRO ტიპებით (MRSA ჰოსპ. 1), ჩეკლისტები 2" \
  "$(echo "$RP" | jq -r '"\(.departments|length):\(.mdro[]|select(.mdro_code=="mrsa")|.hospital):\(.audits.checklists|length)"')" "1:1:2"
chk "ხედვა: IPC ანგარიშები (view) — ✓; IPC განყ. A → B 403; ექიმი → 403" \
  "$(code GET "/ipc/reports/summary?from=$TODAY&to=$TODAY" "$IV"):$(code GET "/ipc/reports/summary?from=$TODAY&to=$TODAY&department_id=$DB" "$ID"):$(code GET "/ipc/reports/summary?from=$TODAY&to=$TODAY" "$DR")" "200:403:403"
RR=$(refresh "$TODAY" "$TODAY")
chk "რეპორტინგის გადათვლა — ok, rpt_fact_ipc შევსებულია" "$(echo "$RR" | jq -r '"\(.status):\((.facts.ipc // 0) > 0)"')" "ok:true"
OV=$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DA&compare=none&category=ipc" "$ADM")
chk "მენეჯერული დაფა (A): 10 KPI ipc_*; ხელის ჰიგიენა 70 = ანგარიში; MDRO 500 = ანგარიში" \
  "$(echo "$OV" | jq -r '[.kpis[]|select(.category=="ipc")]|length'):$(kv "$OV" ipc_hh_pct):$(kv "$OV" ipc_mdro_rate)" "10:70:500"
AT=$(api GET "/reporting/attention?department_id=$DA" "$ADM")
chk "„ყურადღება“ (A): MDRO იზოლაციის გარეშე (წითელი, 1), ხელის ჰიგიენა < 80 (ყვითელი, 70)" \
  "$(echo "$AT" | jq -r '[.items[]|select(.kind|startswith("ipc_"))|"\(.kind):\(.severity):\(.value)"]|sort|join(" ")')" "ipc_hh_low:yellow:70 ipc_mdro_no_isolation:red:1"
ipcset '{"dashboard_visibility":"ipc_only"}'
chk "ipc_only: admin (IPC უფლების გარეშე) — KPI ipc_* არ ჩანს, „ყურადღებაში“ არ არის" \
  "$(api GET "/reporting/overview?from=$TODAY&to=$TODAY&department_id=$DA&compare=none" "$ADM" | jq -r '[.kpis[]|select(.category=="ipc")]|length'):$(api GET "/reporting/attention?department_id=$DA" "$ADM" | jq -r '[.items[]|select(.kind|startswith("ipc_"))]|length')" "0:0"
ipcset '{"dashboard_visibility":"report_users"}'
chk "KPI ცნობარი: 10 ipc_* (განმარტება / ფორმულა / წყარო)" \
  "$(api GET /reporting/kpis "$ADM" | jq -r '[.[]|select(.category=="ipc" and (.definition|length)>3 and (.formula|length)>3 and (.source|length)>2)]|length')" "10"

step "8. ექსპორტი და რეესტრი"
curl -s -o "$TMP/r.xlsx" "$B/ipc/reports/export?from=$TODAY&to=$TODAY&format=xlsx" -H "authorization: Bearer $IV"
curl -s -o "$TMP/r.pdf" "$B/ipc/reports/export?from=$TODAY&to=$TODAY&department_id=$DA&format=pdf" -H "authorization: Bearer $IC"
chk "ანგარიში: xlsx (IPC ანგარიშები) — PK; PDF — %PDF; ფორმატი x → 400" "$(head -c 2 "$TMP/r.xlsx"):$(head -c 5 "$TMP/r.pdf"):$(code GET "/ipc/reports/export?from=$TODAY&to=$TODAY&format=x" "$IC")" "PK:%PDF-:400"
curl -s -o "$TMP/m.csv" "$B/ipc/reports/registry?from=$TODAY&to=$TODAY&kind=mdro&format=csv" -H "authorization: Bearer $IC"
curl -s -o "$TMP/h.xlsx" "$B/ipc/reports/registry?from=$TODAY&to=$TODAY&kind=hai&format=xlsx" -H "authorization: Bearer $IC"
chk "რეესტრი: MDRO CSV — MRSA, ასაკი, სახელის / პ/ნ-ის გარეშე; HAI xlsx — PK; IPC ანგარიშები / IPC განყ. → 403" \
  "$(grep -c "MRSA" "$TMP/m.csv" | awk '{print ($1>0)}'):$(grep -c "IPR-ერთი\|51$(printf '%09d' "$((10#$S))")" "$TMP/m.csv"):$(head -c 2 "$TMP/h.xlsx"):$(code GET "/ipc/reports/registry?from=$TODAY&to=$TODAY" "$IV"):$(code GET "/ipc/reports/registry?from=$TODAY&to=$TODAY" "$ID")" \
  "1:0:PK:403:403"

step "9. მოდულის გამორთვა / აღდგენა"
api PUT /modules/ipc "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "გამორთულზე: აუდიტები / ანგარიში → 403; დაფაზე — KPI ipc_* ცარიელი" \
  "$(code GET /ipc/audits "$IC"):$(code GET "/ipc/reports/summary?from=$TODAY&to=$TODAY" "$IC"):$(api GET "/reporting/attention?department_id=$DA" "$ADM" | jq -r '[.items[]|select(.kind|startswith("ipc_"))]|length')" "403:403:0"
api PUT /modules/ipc "$ADM" -d "{\"enabled\":$(echo "$O_IPC" | jq '.enabled'),\"settings\":$(echo "$O_IPC" | jq -c '.settings'),\"reason\":\"ტესტ-E2E: აღდგენა\"}" >/dev/null
[ "$(echo "$O_RPT" | jq -r .enabled)" = "true" ] || api PUT /modules/reporting "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E: აღდგენა"}' >/dev/null
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="ipc")|{enabled, settings}')" "$O_IPC"
AUD=$( (api GET "/audit-logs?entity_name=ipc_audits&limit=100" "$ADM"; api GET "/audit-logs?entity_name=ipc_audit_templates&limit=50" "$ADM"; api GET "/audit-logs?entity_name=ipc_reports&limit=50" "$ADM") | jq -s -r '[.[]|(if type=="array" then . else .items end)[]|.action]|unique|join(",")')
chk "აუდიტი: IPC_AUDIT_CREATE / COMPLETE / DELETE, IPC_AUDIT_TEMPLATE_CREATE / UPDATE, IPC_REPORT_EXPORT, IPC_REGISTRY_EXPORT" \
  "$(for a in IPC_AUDIT_CREATE IPC_AUDIT_COMPLETE IPC_AUDIT_DELETE IPC_AUDIT_TEMPLATE_CREATE IPC_AUDIT_TEMPLATE_UPDATE IPC_REPORT_EXPORT IPC_REGISTRY_EXPORT; do echo "$AUD" | tr ',' '\n' | grep -qx "$a" && echo y || echo "$a"; done | sort -u | tr '\n' ' ')" "y "

step "გასუფთავება"
if [ -n "${E2E_KEEP:-}" ]; then ok "E2E_KEEP — მონაცემები დატოვებულია (ეკრანის სურათებისთვის)"; printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; exit; fi
for e in $E1 $E2; do api POST "/inpatient/stays/$e/cancel" "$DR" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
api PATCH "/ipc/audit-templates/$TCID" "$IC" -d '{"is_active":false}' >/dev/null
for f in "$TMP"/u*; do api PATCH "/users/$(cat "$f")" "$ADM" -d '{"is_active":false}' >/dev/null; done
ok "ჰოსპიტალიზაციები გაუქმდა, შაბლონი / მომხმარებლები გათიშულია"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
