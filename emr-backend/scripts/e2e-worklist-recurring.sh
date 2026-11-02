#!/usr/bin/env bash
# =====================================================================
# e2e-worklist-recurring.sh — სამუშაო სიები, ეტაპი 4 (0084): განმეორებადი (გრაფიკით) ხელით დავალებები
#   ვალიდაცია (კვირის დღეები, საათობრივი — ერთი დრო, თარიღები, პაციენტი — არა), შემდეგი დგომა (ყოველდღე / კვირის დღე / თვის ბოლო / ყოველ N საათში),
#   worker (run-jobs at + schedule_ids): შექმნა → დუბლიკატი არა → წინა ღიაა: skip (ჟურნალი) / replace (წინა უქმდება) / create; შესრულების შემდეგ — ახალი;
#   ჯგუფური სამიზნე (განყოფილება) — წევრებს, შეტყობინება; მინიჭების წესი (managers — 403), ხედები (ჩემი / განყოფილების), შეჩერება;
#   diagnostics: SCHED_EMPTY_TARGET (გათიშული შემსრულებელი).
# ბოლოს: გრაფიკები — შეჩერებული, დავალებები — გაუქმებული, მომხმარებლები / როლები / განყოფილებები — გათიშული; პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-worklist-recurring.sh [API_URL]
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
wl()   { api PUT /modules/worklist "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
plus() { date -u -d "$1 $2" +%FT%TZ; }   # <ISO> <'+61 minutes'>
run()  { api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$1\",\"schedule_ids\":[\"$2\"]}"; }
local_dow() { TZ=Asia/Tbilisi date -d "$1" +%u; }
TODAY=$(TZ=Asia/Tbilisi date +%F)

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0084" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0084" | tostring)')" "ok:true"
ORIG=$(api GET /modules "$ADM"); orig() { echo "$ORIG" | jq -c --arg c "$1" '.[]|select(.code==$c)|{enabled, settings}'; }
api PUT /modules/worklist "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
wl '{"assign_scope":"any","notify_assign":true,"remind_at_due":false,"escalate_hours":0,"due_default_hours":[0,24,4]}'
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WR განყოფილება $S\",\"code\":\"E2EWR$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty'); echo "$D1" >> "$TMP/deps"
[ -n "$D1" ] || die "განყოფილება ვერ შეიქმნა"
R_MG=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_wrmg_$S\",\"name\":\"ტესტ-E2E ხელმძღვანელი\",\"capabilities\":[\"nurse\",\"worklist_manage\"]}" | jq -r '.id // empty'); echo "$R_MG" >> "$TMP/roles"
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.wr.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"გრაფ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.wr.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
read -r NAID NA <<< "$(mkuser '["nurse"]' 71 ",\"department_id\":\"$D1\"")"
read -r NBID NB <<< "$(mkuser '["nurse"]' 72 ",\"department_id\":\"$D1\"")"
read -r MGID MG <<< "$(mkuser "[\"e2e_wrmg_$S\"]" 73 ",\"department_id\":\"$D1\",\"is_section_head\":true")"
read -r XXID XX <<< "$(mkuser '["nurse"]' 74 ",\"department_id\":\"$D1\"")"
for t in NA NB MG XX; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "4 მომხმარებელი (2 ექთანი, ხელმძღვანელი — worklist_manage, მესამე ექთანი)"

step "1. ვალიდაცია, შემდეგი დგომა"
SC() { api POST /worklist/schedules "$1" -d "$2"; }
chk "კვირის დღეების გარეშე / საათობრივი 2 დროით / დასრულება დაწყებამდე / თვის 29 / პაციენტი — 400" \
  "$(code POST /worklist/schedules "$NA" -d '{"title":"ტესტ-E2E x","freq":"weekly","times":["09:00"],"weekdays":[]}'):$(code POST /worklist/schedules "$NA" -d '{"title":"ტესტ-E2E x","freq":"hourly","times":["09:00","10:00"],"every_hours":2}'):$(code POST /worklist/schedules "$NA" -d "{\"title\":\"ტესტ-E2E x\",\"freq\":\"daily\",\"times\":[\"09:00\"],\"starts_on\":\"$TODAY\",\"ends_on\":\"2020-01-01\"}"):$(code POST /worklist/schedules "$NA" -d '{"title":"ტესტ-E2E x","freq":"monthly","times":["09:00"],"month_day":29}'):$(code POST /worklist/schedules "$NA" -d '{"title":"ტესტ-E2E x","freq":"daily","times":["09:00"],"patient_id":"00000000-0000-0000-0000-000000000000"}')" \
  "400:400:400:400:400"
W=$(SC "$NA" '{"title":"ტესტ-E2E WR კვირის","freq":"weekly","times":["08:15"],"weekdays":[1]}'); WID=$(echo "$W" | jq -r '.id // empty'); echo "$WID" >> "$TMP/sch"
chk "კვირის დღე (ორშ) → შემდეგი დგომა ორშაბათს 08:15 (კლინიკის დრო)" "$(local_dow "$(echo "$W" | jq -r .next_at)"):$(TZ=Asia/Tbilisi date -d "$(echo "$W" | jq -r .next_at)" +%H:%M)" "1:08:15"
M=$(SC "$NA" '{"title":"ტესტ-E2E WR თვის ბოლო","freq":"monthly","times":["18:00"],"month_day":0}'); MID=$(echo "$M" | jq -r '.id // empty'); echo "$MID" >> "$TMP/sch"
MD=$(TZ=Asia/Tbilisi date -d "$(echo "$M" | jq -r .next_at)" +%F)
chk "თვის ბოლო დღე (month_day 0)" "$(date -d "$MD +1 day" +%d)" "01"
H=$(SC "$NA" "{\"title\":\"ტესტ-E2E WR საათობრივი\",\"freq\":\"hourly\",\"times\":[\"00:00\"],\"every_hours\":1,\"due_hours\":1,\"prev_open\":\"skip\"}")
HID=$(echo "$H" | jq -r '.id // empty'); echo "$HID" >> "$TMP/sch"; NX=$(echo "$H" | jq -r '.next_at // empty')
chk "ყოველ საათში → შემდეგი დგომა ≤ 1 სთ-ში; სამიზნე — საკუთარი თავი" "$(jq -n --arg n "$NX" '(($n|sub("\\.[0-9]+Z$";"Z")|fromdate) - now) | (. > 0 and . <= 3600)'):$(echo "$H" | jq -r '"\(.target_kind):\(.assignee_id)"')" "true:user:$NAID"

step "2. worker: შექმნა / დუბლიკატი / წინა ღიაა"
T1=$(plus "$NX" '+1 minute')
chk "დგომის შემდეგ → შეიქმნა 1" "$(run "$T1" "$HID" | jq -r '.schedules.created')" "1"
TK=$(api GET /worklist/tasks "$NA" --get --data-urlencode "q=ტესტ-E2E WR საათობრივი" | jq -c '[.[]|select(.status=="open")]')
chk "დავალება ჩემს სიაში; ვადა = დგომა + 1 სთ" "$(echo "$TK" | jq -r 'length'):$(echo "$TK" | jq -r --arg n "$NX" '.[0].due_at|sub("\\.[0-9]+Z$";"Z")|fromdate - ($n|sub("\\.[0-9]+Z$";"Z")|fromdate)')" "1:3600"
TID1=$(echo "$TK" | jq -r '.[0].id')
chk "იგივე დრო მეორედ → დუბლიკატი არა" "$(run "$T1" "$HID" | jq -r '.schedules.created + .schedules.skipped')" "0"
chk "შემდეგი საათი, წინა ღიაა (skip) → გამოტოვდა" "$(run "$(plus "$NX" '+61 minutes')" "$HID" | jq -r '.schedules.skipped')" "1"
chk "ჟურნალი: skipped (წინა დავალებით)" "$(api GET "/worklist/schedules/$HID" "$NA" | jq -r --arg t "$TID1" '.runs[0]|"\(.result):\(.task_id == null)"')" "skipped:true"
api PATCH "/worklist/schedules/$HID" "$NA" -d '{"prev_open":"replace"}' >/dev/null
R=$(run "$(plus "$NX" '+121 minutes')" "$HID")
chk "replace → წინა გაუქმდა, ახალი შეიქმნა" "$(echo "$R" | jq -r .schedules.replaced):$(api GET "/worklist/tasks/$TID1" "$NA" | jq -r '"\(.status):\(.cancel_reason|test("გრაფიკ"))"')" "1:cancelled:true"
TID2=$(api GET /worklist/tasks "$NA" --get --data-urlencode "q=ტესტ-E2E WR საათობრივი" | jq -r '[.[]|select(.status=="open")][0].id')
api POST "/worklist/tasks/$TID2/done" "$NA" -d '{"note":"ტესტ-E2E"}' >/dev/null
api PATCH "/worklist/schedules/$HID" "$NA" -d '{"prev_open":"skip"}' >/dev/null
chk "წინა შესრულდა → შემდეგ საათზე ახალი (skip-ითაც)" "$(run "$(plus "$NX" '+181 minutes')" "$HID" | jq -r .schedules.created)" "1"
chk "ჟურნალი: შეიქმნა / გამოტოვდა / ჩანაცვლდა" "$(api GET "/worklist/schedules/$HID" "$NA" | jq -r '[.runs[].result]|unique|sort|join(",")')" "created,replaced,skipped"

step "3. ჯგუფური სამიზნე, მინიჭების წესი, ხედები"
G=$(SC "$MG" "{\"title\":\"ტესტ-E2E WR მაცივრის ტემპერატურა\",\"freq\":\"hourly\",\"times\":[\"00:00\"],\"every_hours\":2,\"target_kind\":\"department\",\"target_department_id\":\"$D1\"}")
GID=$(echo "$G" | jq -r '.id // empty'); echo "$GID" >> "$TMP/sch"; GX=$(echo "$G" | jq -r .next_at)
api POST /notifications/read-all "$NB" >/dev/null
run "$(plus "$GX" '+1 minute')" "$GID" >/dev/null; sleep 1
GT=$(api GET /worklist/tasks "$NB" --get --data-urlencode "q=ტესტ-E2E WR მაცივრის" --data-urlencode "box=group" | jq -r '[.[]|select(.status=="open")]|length')
chk "განყოფილების რიგი: წევრს (ჯგუფის ჩანართში) + შეტყობინება" "$GT:$(api GET /notifications/count "$NB" | jq -r '.unread > 0')" "1:true"
wl '{"assign_scope":"managers"}'
chk "managers: ექთანი სხვისთვის → 403 WL_ASSIGN_SCOPE; საკუთარ თავზე → 201" "$(api POST /worklist/schedules "$NA" -d "{\"title\":\"ტესტ-E2E WR სხვისთვის\",\"freq\":\"daily\",\"times\":[\"09:00\"],\"target_kind\":\"user\",\"assignee_id\":\"$NBID\"}" | jq -r .code):$(code POST /worklist/schedules "$NA" -d '{"title":"ტესტ-E2E WR ჩემთვის","freq":"daily","times":["09:00"]}')" "WL_ASSIGN_SCOPE:201"
api GET /worklist/schedules "$NA" | jq -r '.[]|select(.title=="ტესტ-E2E WR ჩემთვის")|.id' >> "$TMP/sch"
wl '{"assign_scope":"any"}'
chk "ხედები: ექთანს — ჩემი (4), განყოფილების — 403; ხელმძღვანელს — განყოფილების (ჯგუფური ჩანს)" "$(api GET /worklist/schedules "$NA" | jq -r '[.[]|select(.title|startswith("ტესტ-E2E WR"))]|length'):$(code GET '/worklist/schedules?box=team' "$NA"):$(api GET '/worklist/schedules?box=team' "$MG" | jq -r --arg g "$GID" '[.[]|select(.id==$g)]|length')" "4:403:1"
chk "სხვისი გრაფიკის შეცვლა (ექთანი B) → 403" "$(code PATCH "/worklist/schedules/$HID" "$NB" -d '{"title":"ტესტ-E2E xx"}')" "403"
chk "შეჩერება → next_at null; worker — არაფერი" "$(api PATCH "/worklist/schedules/$GID" "$MG" -d '{"is_active":false}' | jq -r '"\(.is_active):\(.next_at)"'):$(run "$(plus "$GX" '+300 minutes')" "$GID" | jq -r '.schedules.created + .schedules.skipped')" "false:null:0"
chk "გააქტიურება → next_at ისევ არის" "$(api PATCH "/worklist/schedules/$GID" "$MG" -d '{"is_active":true}' | jq -r '.next_at != null')" "true"

step "4. diagnostics"
X=$(SC "$MG" "{\"title\":\"ტესტ-E2E WR გათიშულს\",\"freq\":\"daily\",\"times\":[\"09:00\"],\"target_kind\":\"user\",\"assignee_id\":\"$XXID\"}" | jq -r '.id // empty'); echo "$X" >> "$TMP/sch"
api POST "/users/$XXID/disable" "$ADM" -d '{}' >/dev/null
chk "SCHED_EMPTY_TARGET: შემსრულებელი გათიშულია" "$(api GET '/worklist/check/diagnostics?include_test=1' "$ADM" | jq -r '[.issues[]|select(.code=="SCHED_EMPTY_TARGET")|.items[]|select(startswith("ტესტ-E2E WR გათიშულს"))]|length')" "1"

step "5. გასუფთავება"
[ -f "$TMP/sch" ] && while read -r s; do [ -n "$s" ] && api PATCH "/worklist/schedules/$s" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/sch"
for t in $(api GET /worklist/tasks "$ADM" --get --data-urlencode "q=ტესტ-E2E WR" --data-urlencode "box=team" | jq -r '.[]|select(.status=="open" or .status=="in_progress")|.id'); do
  api POST "/worklist/tasks/$t/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
api PUT /modules/worklist "$ADM" -d "$(orig worklist | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null
chk "პარამეტრები აღდგენილია (worklist)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}')" "$(orig worklist)"
[ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
[ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
[ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
ok "გრაფიკები შეჩერებულია, დავალებები გაუქმებულია, ჩანაწერები გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
