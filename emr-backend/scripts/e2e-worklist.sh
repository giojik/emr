#!/usr/bin/env bash
# =====================================================================
# e2e-worklist.sh — სამუშაო სიები, ეტაპი 1 (0081): საფუძველი
#   მოდული და პარამეტრები (ვალიდაცია), უფლებები (worklist_manage / worklist_all — 47), კატეგორიები (seed, ნაგულისხმევი სამიზნე, SLA, უფლება),
#   ხელით დავალება: საკუთარი, პირზე, ჯგუფზე (როლი + განყოფილება — „ავიღებ“ / დაბრუნება), განყოფილების რიგი, მორიგე (D4 — გამოქვეყნებული განრიგით),
#   მინიჭების წესი (any / department / managers), ვადა (პრიორიტეტით / SLA / წარსული), დაწყება / შესრულება (კომენტარი სასწრაფოზე), გაუქმება (მიზეზი, უფლება),
#   ხელახლა გახსნა (reopen_days), რედაქტირება, გადანაწილება (ხელმძღვანელი), ხილვადობა (სხვა განყოფილება — 403), ხელმძღვანელის ხედი (არე), პაციენტი (პარამეტრი,
#   კატეგორია, ფილტრი, აუდიტი), შეტყობინებები, ვადის შეხსენება / ესკალაცია (run-jobs, ერთხელ),
#   სისტემური წყაროები: ბიომედი (ტრიაჟი, ჩემი ორდერი, დადასტურება), ხარისხი (ტრიაჟი), ცვლები (არყოფნის გადაწყვეტილება), წყაროს გამორთვა,
#   admin-ის უფლება პასუხისმგებლობას არ ქმნის, მთვლელი, მოდულის გამორთვა.
# ბოლოს: მომხმარებლები / განყოფილებები / სატესტო კატეგორია გათიშულია, პარამეტრები — საწყისი; ღია სატესტო დავალებები — გაუქმებული.
# გამოყენება:  bash scripts/e2e-worklist.sh [API_URL]
# =====================================================================
set -uo pipefail
B="${1:-${API:-http://localhost/api}}"
J='content-type: application/json'
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "მოსალოდნელი: $3 | მიღებული: $2"; fi; }
has()  { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1" "უნდა შეიცავდეს: $3 | მიღებული: $2"; fi; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mშეწყდა:\033[0m %s\n' "$1"; exit 1; }
command -v jq >/dev/null || die "jq არ არის დაყენებული"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
S=$(date +%s | tail -c 7); S4=${S: -4}; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mod()  { api PUT /modules/worklist "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
ts()   { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
task() { api POST /worklist/tasks "$1" -d "$2"; }                         # <token> <json> → დავალება
tid()  { task "$1" "$2" | jq -r '.id // empty'; }
one()  { api GET "/worklist/tasks/$1" "$2"; }
st()   { one "$1" "$ADM" | jq -r .status; }
inmine() { api GET /worklist/mine "$2" | jq -r --arg k "$1" '[.items[]|select(.key==$k)]|length'; }   # <key> <token>
notes() { api GET "/notifications?unread=true" "$1" | jq -r --arg e "$2" '[.[]|select(.kind=="wl_task" and (.link|endswith($e)))]|length'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0081" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0081" | tostring)')" "ok:true"
D1=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WL თერაპია $S\",\"code\":\"E2EWA$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
D2=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WL ქირურგია $S\",\"code\":\"E2EWB$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$D1" ] && [ -n "$D2" ] || die "განყოფილებები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.wl.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"დავ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"phone\":\"5990$2$S4\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.wl.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
R_MG=$(mkrole wmg "დავალებები (ხელმძღვ.)" '["worklist_manage","absence_approve"]'); R_ALL=$(mkrole wall "დავალებები (ყველა)" '["worklist_all"]')
R_ENG=$(mkrole weng "სამედ. ინჟინერი" '["med_engineer"]'); R_QM=$(mkrole wqm "ხარისხი" '["quality"]'); R_NURSE=$(mkrole wnr "ექთანი (ტესტ)" '["nurse"]')
[ -n "$R_MG" ] && [ -n "$R_ALL" ] && [ -n "$R_ENG" ] && [ -n "$R_QM" ] && [ -n "$R_NURSE" ] || die "როლები ვერ შეიქმნა (worklist_manage / worklist_all უფლებები?)"
read -r N1ID N1 <<< "$(mkuser "[\"$R_NURSE\"]" 81 ",\"department_id\":\"$D1\"")"
read -r N2ID N2 <<< "$(mkuser "[\"$R_NURSE\"]" 82 ",\"department_id\":\"$D1\"")"
read -r N3ID N3 <<< "$(mkuser "[\"$R_NURSE\"]" 83 ",\"department_id\":\"$D2\"")"
read -r H1ID H1 <<< "$(mkuser "[\"$R_MG\",\"$R_NURSE\"]" 84 ",\"department_id\":\"$D1\"")"
read -r ALID AL <<< "$(mkuser "[\"$R_ALL\"]" 85)"
read -r ENGID ENG <<< "$(mkuser "[\"$R_ENG\"]" 86)"
read -r QMID QM <<< "$(mkuser "[\"$R_QM\"]" 87 ",\"department_id\":\"$D2\"")"
[ -n "$N1" ] && [ -n "$N2" ] && [ -n "$N3" ] && [ -n "$H1" ] && [ -n "$AL" ] && [ -n "$ENG" ] && [ -n "$QM" ] && ok "7 მომხმარებელი (ექთანი D1 ×2, ექთანი D2, ხელმძღვანელი D1, მთელი კლინიკა, ინჟინერი, ხარისხი)" || die "მომხმარებლები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}')
[ -n "$ORIG" ] || die "მოდული worklist ვერ მოიძებნა"
api PUT /modules/worklist "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
mod '{"assign_scope":"any","done_comment":"urgent","reopen_days":7,"remind_at_due":true,"escalate_hours":0,"due_default_hours":[0,24,4],"notify_assign":true,"notify_done":true,"patient_tasks":true,"sources":{},"badge":"all","refresh_seconds":60,"home_tasks":false}'
ROLE_NURSE_ID=$(api GET /roles "$ADM" | jq -r --arg c "$R_NURSE" '.[]|select(.code==$c).id')

step "1. მოდული, უფლებები, პარამეტრები"
CAPS=$(api GET /roles/capabilities "$ADM")
chk "უფლებები: worklist_manage, worklist_all; სულ 47" "$(echo "$CAPS" | jq -r '[.[]|select(.code=="worklist_manage" or .code=="worklist_all")]|length'):$(echo "$CAPS" | jq length)" "2:47"
chk "უცნობი პარამეტრი / assign_scope / ვადები (2 ელემენტი) / უცნობი წყარო — 400" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"foo":1},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"assign_scope":"all"},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"due_default_hours":[1,2]},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"sources":{"xyz":false}},"reason":"ტესტ"}')" "400:400:400:400"
REFS=$(api GET /worklist/refs "$N1")
chk "ცნობარი: 5 seed კატეგორია; ექთანი — ხელმძღვანელის ხედი / კატეგორიები არა; წყაროები ≥ 21" "$(echo "$REFS" | jq -r '[.categories[]|select(.code=="ADMIN" or .code=="CLINICAL" or .code=="TECH" or .code=="CLEANING" or .code=="OTHER")]|length'):$(echo "$REFS" | jq -r '"\(.can.team):\(.can.categories)"'):$(echo "$REFS" | jq -r '.sources|length >= 21')" "5:false:false:true"
chk "ხელმძღვანელი — team (D1); მთელი კლინიკა — team + კატეგორიები" "$(api GET /worklist/refs "$H1" | jq -r --arg d "$D1" '"\(.can.team):\(.team_departments|index($d) != null)"'):$(api GET /worklist/refs "$AL" | jq -r '"\(.can.team):\(.can.categories)"')" "true:true:true:true"
C_ADMIN=$(echo "$REFS" | jq -r '.categories[]|select(.code=="ADMIN").id'); C_CLIN=$(echo "$REFS" | jq -r '.categories[]|select(.code=="CLINICAL").id')

step "2. კატეგორიები"
chk "ახალი კატეგორია: ექთანი — 403; worklist_all — 201" "$(code POST /worklist/categories "$N1" -d "{\"code\":\"E2E_C$S4\",\"name\":\"ტესტ-E2E\"}"):$(code POST /worklist/categories "$AL" -d "{\"code\":\"E2E_C$S4\",\"name\":\"ტესტ-E2E ტექ. სამსახური D2\",\"default_target_kind\":\"department\",\"default_department_id\":\"$D2\",\"sla_hours\":4,\"allow_patient\":false}")" "403:201"
C_T=$(api GET /worklist/refs "$AL" | jq -r --arg c "E2E_C$S4" '.categories[]|select(.code==$c).id')
chk "ნაგულისხმევი სამიზნე როლის გარეშე (role) — 400" "$(code PATCH "/worklist/categories/$C_T" "$AL" -d '{"default_target_kind":"role"}')" "400"

step "3. საკუთარი / პირზე, მინიჭების წესი"
R=$(task "$N1" '{"title":"ტესტ-E2E ჩემი ჩანაწერი"}'); T1=$(echo "$R" | jq -r '.id // empty')
chk "სამიზნის გარეშე → საკუთარ თავზე; ღია; TK-ნომერი; ვადის გარეშე (ჩვეულებრივი = 0)" "$(echo "$R" | jq -r '"\(.target_kind):\(.assignee_id):\(.status):\(.task_no|test("^TK[0-9]{2}-[0-9]{5}$")):\(.due_at)"')" "user:$N1ID:open:true:null"
chk "„ჩემს დავალებებში“ ჩანს (task:…)" "$(inmine "task:$T1" "$N1")" "1"
R=$(task "$N1" "{\"title\":\"ტესტ-E2E N2-ს\",\"priority\":\"high\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}"); T2=$(echo "$R" | jq -r '.id // empty')
DUE=$(echo "$R" | jq -r .due_at); H=$(( ( $(date -d "$DUE" +%s) - $(date +%s) + 1800 ) / 3600 ))
chk "პირზე (მაღალი → ვადა +24 სთ); N2-ს შეტყობინება; N2-ის სიაში; N1-ის „შექმნილში“" "$H:$(notes "$N2" "$T2"):$(inmine "task:$T2" "$N2"):$(api GET '/worklist/tasks?box=created' "$N1" | jq -r --arg t "$T2" '[.[]|select(.id==$t)]|length')" "24:1:1:1"
R=$(task "$N1" "{\"title\":\"ტესტ-E2E SLA\",\"category_id\":\"$C_T\"}")
DUE=$(echo "$R" | jq -r .due_at); H=$(( ( $(date -d "$DUE" +%s) - $(date +%s) + 1800 ) / 3600 ))
chk "კატეგორია: ნაგულისხმევი სამიზნე (D2-ის რიგი), SLA 4 სთ" "$(echo "$R" | jq -r '"\(.target_kind):\(.target_department_id)"'):$H" "department:$D2:4"
TQ=$(echo "$R" | jq -r .id)
chk "ვადა წარსულში — 400; სამიზნის id-ის გარეშე — 400; გათიშული / უცნობი პირი — 400" "$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E x\",\"due_at\":\"$(ts '-2 hours')\"}"):$(code POST /worklist/tasks "$N1" -d '{"title":"ტესტ-E2E x","target_kind":"role"}'):$(code POST /worklist/tasks "$N1" -d '{"title":"ტესტ-E2E x","target_kind":"user","assignee_id":"00000000-0000-0000-0000-000000000001"}')" "400:400:400"
mod '{"assign_scope":"department"}'
chk "department: D1 → D2-ის ექთანი — 403 WL_ASSIGN_SCOPE; D1 → D1 — 201; როლი განყ. გარეშე — 403; D2-ის რიგი — 201" "$(api POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E x\",\"target_kind\":\"user\",\"assignee_id\":\"$N3ID\"}" | jq -r .code):$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E D1\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}"):$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E x\",\"target_kind\":\"role\",\"target_role_id\":\"$ROLE_NURSE_ID\"}"):$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E რიგი\",\"target_kind\":\"department\",\"target_department_id\":\"$D2\"}")" "WL_ASSIGN_SCOPE:201:403:201"
mod '{"assign_scope":"managers"}'
chk "managers: ექთანი → კოლეგა — 403; საკუთარ თავზე — 201; ხელმძღვანელი → D1 ექთანი — 201, → D2 — 403; worklist_all → D2 — 201" "$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E x\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}"):$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E self\",\"target_kind\":\"user\",\"assignee_id\":\"$N1ID\"}"):$(code POST /worklist/tasks "$H1" -d "{\"title\":\"ტესტ-E2E ხელმძღ.\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}"):$(code POST /worklist/tasks "$H1" -d "{\"title\":\"ტესტ-E2E x\",\"target_kind\":\"user\",\"assignee_id\":\"$N3ID\"}"):$(code POST /worklist/tasks "$AL" -d "{\"title\":\"ტესტ-E2E ყველა\",\"target_kind\":\"user\",\"assignee_id\":\"$N3ID\"}")" "403:201:201:403:201"
mod '{"assign_scope":"any"}'

step "4. ჯგუფური: როლი + განყოფილება, განყოფილების რიგი"
TG=$(tid "$N1" "{\"title\":\"ტესტ-E2E ჯგუფური D1\",\"target_kind\":\"role_department\",\"target_role_id\":\"$ROLE_NURSE_ID\",\"target_department_id\":\"$D1\"}")
chk "ჯგუფის წევრები (N2, H1) — სიაში; D2-ის ექთანი — არა; N2-ს შეტყობინება" "$(inmine "task:$TG" "$N2"):$(inmine "task:$TG" "$H1"):$(inmine "task:$TG" "$N3"):$(notes "$N2" "$TG")" "1:1:0:1"
chk "N2: ავიღებ → აიღო N2; N1-ს — ავიღებ არა, „ჯგუფის“ სიაში ჩანს აღებული" "$(api POST "/worklist/tasks/$TG/claim" "$N2" | jq -r '.claimed_by == "'"$N2ID"'"'):$(one "$TG" "$N1" | jq -r .can.claim):$(api GET '/worklist/tasks?box=group' "$N1" | jq -r --arg t "$TG" '.[]|select(.id==$t)|.claimed_by_name != null')" "true:false:true"
chk "აღებული — H1-ის სიიდან ქრება; მეორედ აღება — 403; N2 დააბრუნებს → ისევ ჯგუფის" "$(inmine "task:$TG" "$H1"):$(code POST "/worklist/tasks/$TG/claim" "$H1"):$(api POST "/worklist/tasks/$TG/release" "$N2" -d '{}' | jq -r '"\(.claimed_by):\(.status)"'):$(inmine "task:$TG" "$H1")" "0:403:null:open:1"
chk "დაწყება ჯგუფურზე → ავტომატურად აიღებს (H1), შესრულებაში" "$(api POST "/worklist/tasks/$TG/start" "$H1" | jq -r '"\(.status):\(.claimed_by == "'"$H1ID"'")"')" "in_progress:true"
TD2=$(tid "$H1" "{\"title\":\"ტესტ-E2E D2-ის რიგი\",\"target_kind\":\"department\",\"target_department_id\":\"$D2\"}")
chk "D2-ის რიგი: N3-ის სიაში; N1-ის — არა; შემქმნელი H1 ხედავს" "$(inmine "task:$TD2" "$N3"):$(inmine "task:$TD2" "$N1"):$(code GET "/worklist/tasks/$TD2" "$H1")" "1:0:200"

step "5. შესრულება / გაუქმება / ხელახლა გახსნა / რედაქტირება"
TU=$(tid "$N1" "{\"title\":\"ტესტ-E2E სასწრაფო\",\"priority\":\"urgent\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}")
api POST /notifications/read-all "$N1" >/dev/null
chk "სასწრაფო: კომენტარის გარეშე — 400 WL_COMMENT_REQUIRED; კომენტარით — შესრულდა; შემქმნელს შეტყობინება" "$(api POST "/worklist/tasks/$TU/done" "$N2" -d '{}' | jq -r .code):$(api POST "/worklist/tasks/$TU/done" "$N2" -d '{"note":"ტესტ-E2E: გაკეთდა"}' | jq -r '"\(.status):\(.done_note)"'):$(notes "$N1" "$TU")" "WL_COMMENT_REQUIRED:done:ტესტ-E2E: გაკეთდა:1"
chk "შესრულებულზე ხელახლა „შესრულება“ — 409; სიიდან ქრება" "$(code POST "/worklist/tasks/$TU/done" "$N2" -d '{"note":"xxx"}'):$(inmine "task:$TU" "$N2")" "409:0"
chk "ხელახლა გახსნა: შემსრულებელი — 403; მიზეზის გარეშე — 400; შემქმნელი — ღია" "$(code POST "/worklist/tasks/$TU/reopen" "$N2" -d '{"reason":"ტესტ ტესტ"}'):$(code POST "/worklist/tasks/$TU/reopen" "$N1" -d '{}'):$(api POST "/worklist/tasks/$TU/reopen" "$N1" -d '{"reason":"ტესტ-E2E: თავიდან"}' | jq -r .status)" "403:400:open"
chk "გაუქმება: შემსრულებელი — 403; მოკლე მიზეზი — 400; შემქმნელი — გაუქმდა" "$(code POST "/worklist/tasks/$TU/cancel" "$N2" -d '{"reason":"ტესტ ტესტ"}'):$(code POST "/worklist/tasks/$TU/cancel" "$N1" -d '{"reason":"x"}'):$(api POST "/worklist/tasks/$TU/cancel" "$N1" -d '{"reason":"ტესტ-E2E: აღარ არის საჭირო"}' | jq -r .status)" "403:400:cancelled"
mod '{"reopen_days":0}'
chk "reopen_days = 0 → ხელახლა გახსნა — 403" "$(code POST "/worklist/tasks/$TU/reopen" "$N1" -d '{"reason":"ტესტ ტესტ"}')" "403"
mod '{"reopen_days":7,"done_comment":"off"}'
NEWDUE=$(ts '+3 days')
R=$(api PATCH "/worklist/tasks/$T2" "$N1" -d "{\"title\":\"ტესტ-E2E N2-ს (შეცვლილი)\",\"due_at\":\"$NEWDUE\",\"priority\":\"normal\"}")
chk "რედაქტირება (შემქმნელი): სათაური / ვადა / პრიორიტეტი; შემსრულებელი — 403; ისტორიაში edited" "$(echo "$R" | jq -r '"\(.title):\(.priority)"'):$( [ "$(date -d "$(echo "$R" | jq -r .due_at)" +%s)" = "$(date -d "$NEWDUE" +%s)" ] && echo due-ok):$(code PATCH "/worklist/tasks/$T2" "$N2" -d '{"title":"ტესტ-E2E x"}'):$(echo "$R" | jq -r '[.events[]|select(.kind=="edited")]|length')" "ტესტ-E2E N2-ს (შეცვლილი):normal:due-ok:403:1"
chk "კომენტარი (N2) → შემქმნელს შეტყობინება; ისტორიაში" "$(api POST "/worklist/tasks/$T2/comment" "$N2" -d '{"note":"ტესტ-E2E: ხვალ გავაკეთებ"}' | jq -r '[.events[]|select(.kind=="comment")]|length'):$(notes "$N1" "$T2")" "1:1"
chk "„ჩვეულებრივი“ შესრულება კომენტარის გარეშე (done_comment = off)" "$(api POST "/worklist/tasks/$T2/done" "$N2" -d '{}' | jq -r .status)" "done"

step "6. ხილვადობა, ხელმძღვანელის ხედი, გადანაწილება"
T5=$(tid "$N1" "{\"title\":\"ტესტ-E2E D1 გადასანაწილებელი\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}")
chk "სხვა განყოფილების ექთანი — 403; worklist_all — 200; არარსებული — 404" "$(code GET "/worklist/tasks/$T5" "$N3"):$(code GET "/worklist/tasks/$T5" "$AL"):$(code GET /worklist/tasks/00000000-0000-0000-0000-000000000009 "$AL")" "403:200:404"
chk "ხელმძღვანელის ხედი: ექთანი — 403; H1 — D1-ის დავალება ჩანს, D2-ის — არა; worklist_all — ორივე" "$(code GET /worklist/team "$N1"):$(api GET /worklist/team "$H1" | jq -r --arg a "$T5" --arg b "$TD2" '"\([.tasks[]|select(.id==$a)]|length):\([.tasks[]|select(.id==$b)]|length)"'):$(api GET /worklist/team "$AL" | jq -r --arg a "$T5" --arg b "$TD2" '"\([.tasks[]|select(.id==$a)]|length):\([.tasks[]|select(.id==$b)]|length)"')" "403:1:0:1:1"
chk "აგრეგატი: H1 — D1-ის ღია ≥ 2; შემსრულებლებში N2" "$(api GET /worklist/team "$H1" | jq -r --arg d "$D1" --arg n "$N2ID" '"\(.departments[]|select(.department_id==$d)|.open >= 2):\([.assignees[]|select(.user_id==$n)]|length)"')" "true:1"
api POST /notifications/read-all "$N1" >/dev/null
chk "გადანაწილება: N2 — 403; H1 (ხელმძღვანელი) → N1: N1-ს შეტყობინება, ისტორიაში reassigned" "$(code POST "/worklist/tasks/$T5/reassign" "$N2" -d "{\"target_kind\":\"user\",\"assignee_id\":\"$N1ID\"}"):$(api POST "/worklist/tasks/$T5/reassign" "$H1" -d "{\"target_kind\":\"user\",\"assignee_id\":\"$N1ID\",\"note\":\"ტესტ-E2E\"}" | jq -r '"\(.assignee_id == "'"$N1ID"'"):\([.events[]|select(.kind=="reassigned")]|length)"'):$(notes "$N1" "$T5")" "403:true:1:1"
chk "ფილტრები: ვადაგადაცილებული / აუღებელი / ძებნა (team)" "$(code GET '/worklist/team?overdue=1' "$H1"):$(code GET '/worklist/team?assignee_id=none' "$H1"):$(api GET "/worklist/tasks?box=created&q=$(jq -rn --arg s 'გადასანაწილებელი' '$s|@uri')" "$N1" | jq -r length)" "200:200:1"
chk "არასწორი box / department_id — 400" "$(code GET '/worklist/tasks?box=foo' "$N1"):$(code GET '/worklist/tasks?box=team&department_id=xyz' "$AL")" "400:400"

step "7. პაციენტი"
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"94$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"WL-პაციენტი\",\"birth_date\":\"1965-04-04\",\"gender\":\"female\",\"phone_number\":\"595$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] || die "პაციენტი ვერ შეიქმნა"
R=$(task "$N1" "{\"title\":\"ტესტ-E2E პაციენტის დავალება\",\"category_id\":\"$C_CLIN\",\"patient_id\":\"$P1\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}"); TP=$(echo "$R" | jq -r '.id // empty')
chk "კლინიკური + პაციენტი — 201; ADMIN კატეგორია + პაციენტი — 400; ვიზიტი პაციენტის გარეშე — 400" "$([ -n "$TP" ] && echo "$R" | jq -r '.patient_name != null'):$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E x\",\"category_id\":\"$C_ADMIN\",\"patient_id\":\"$P1\"}"):$(code POST /worklist/tasks "$N1" -d '{"title":"ტესტ-E2E x","encounter_id":"00000000-0000-0000-0000-000000000001"}')" "true:400:400"
chk "პაციენტის ფილტრი (N2 — 1; D2-ის ექთანი — 0); პაციენტი „ჩემს დავალებებში“" "$(api GET "/worklist/tasks?box=patient&patient_id=$P1" "$N2" | jq -r length):$(api GET "/worklist/tasks?box=patient&patient_id=$P1" "$N3" | jq -r length):$(api GET /worklist/mine "$N2" | jq -r --arg k "task:$TP" '.items[]|select(.key==$k)|.patient')" "1:0:WL-პაციენტი ტესტ-E2E"
chk "პაციენტიანი დავალების ნახვა → აუდიტი WL_TASK_VIEW" "$(one "$TP" "$N2" >/dev/null; api GET "/audit-logs?entity_id=$TP&action=WL_TASK_VIEW" "$ADM" | jq -r 'length > 0')" "true"
mod '{"patient_tasks":false}'
chk "patient_tasks = false → პაციენტით — 400" "$(code POST /worklist/tasks "$N1" -d "{\"title\":\"ტესტ-E2E x\",\"patient_id\":\"$P1\"}")" "400"
mod '{"patient_tasks":true}'

step "8. ვადის შეხსენება / ესკალაცია"
TJ=$(tid "$N1" "{\"title\":\"ტესტ-E2E ვადიანი\",\"due_at\":\"$(ts '+30 minutes')\",\"target_kind\":\"user\",\"assignee_id\":\"$N2ID\"}")
api POST /notifications/read-all "$N2" >/dev/null
chk "ვადამდე — შეხსენება არა" "$(api POST /worklist/run-jobs "$ADM" -d "{\"task_ids\":[\"$TJ\"]}" | jq -r .reminded)" "0"
chk "ვადა დადგა (at +1 სთ) → შეხსენება 1, N2-ს შეტყობინება; მეორედ — 0" "$(api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$(ts '+1 hour')\",\"task_ids\":[\"$TJ\"]}" | jq -r .reminded):$(notes "$N2" "$TJ"):$(api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$(ts '+1 hour')\",\"task_ids\":[\"$TJ\"]}" | jq -r .reminded)" "1:1:0"
chk "run-jobs: ექთანი — 403" "$(code POST /worklist/run-jobs "$N1" -d '{}')" "403"
chk "escalate_hours = 0 → ესკალაცია არა" "$(api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$(ts '+10 hours')\",\"task_ids\":[\"$TJ\"]}" | jq -r .escalated)" "0"
mod '{"escalate_hours":2}'
api POST /notifications/read-all "$H1" >/dev/null
chk "escalate_hours = 2: +2 სთ ჯერ არა; +3 სთ → ესკალაცია, ხელმძღვანელს (D1) შეტყობინება (სასწრაფო); ერთხელ" "$(api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$(ts '+2 hours')\",\"task_ids\":[\"$TJ\"]}" | jq -r .escalated):$(api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$(ts '+3 hours')\",\"task_ids\":[\"$TJ\"]}" | jq -r .escalated):$(api GET '/notifications?unread=true' "$H1" | jq -r --arg e "$TJ" '[.[]|select(.kind=="wl_task" and .urgent and (.link|endswith($e)))]|length'):$(api POST /worklist/run-jobs "$ADM" -d "{\"at\":\"$(ts '+5 hours')\",\"task_ids\":[\"$TJ\"]}" | jq -r .escalated)" "0:1:1:0"
chk "დავალებაზე: ესკალაციის ნიშანი, ისტორიაში reminded / escalated" "$(one "$TJ" "$N1" | jq -r '"\(.escalated_at != null):\([.events[]|select(.kind=="reminded" or .kind=="escalated")]|length)"')" "true:2"
mod '{"escalate_hours":0}'

step "9. სისტემური წყაროები"
# ბიომედი: ექთანი D1 → შეკეთების მოთხოვნა → ინჟინერს „ტრიაჟი“
BREFS=$(api GET /bme/refs "$ENG"); T_OTHER=$(echo "$BREFS" | jq -r '.types[]|select(.code=="OTHER")|.id')
DEV=$(api POST /bme/devices "$ENG" -d "{\"name\":\"ტესტ-E2E WL აპარატი $S\",\"type_id\":\"$T_OTHER\",\"department_id\":\"$D1\"}" | jq -r '.id // empty')
REP=$(api POST /bme/repairs "$N1" -d "{\"device_id\":\"$DEV\",\"condition\":\"not_working\",\"urgency\":\"urgent\",\"description\":\"ტესტ-E2E: არ ირთვება\"}" | jq -r '.id // empty')
[ -n "$DEV" ] && [ -n "$REP" ] || bad "ბიომედის მოთხოვნა ვერ შეიქმნა" "dev=$DEV rep=$REP"
MI=$(api GET /worklist/mine "$ENG")
chk "ინჟინერი: bme_triage (P2 → მაღალი, ბმული ორდერზე)" "$(echo "$MI" | jq -r --arg k "bme_triage:$REP" '.items[]|select(.key==$k)|"\(.priority):\(.link|contains("repair="))"')" "high:true"
chk "admin-ს (BME_FULL) — სისტემურ სიაში არ ჩანს; ექთანს — არა" "$(inmine "bme_triage:$REP" "$ADM"):$(inmine "bme_triage:$REP" "$N1")" "0:0"
api POST "/bme/repairs/$REP/triage" "$ENG" -d "{\"priority\":2,\"assignee_id\":\"$ENGID\"}" >/dev/null
chk "ტრიაჟის შემდეგ: ტრიაჟიდან ქრება → „ჩემი ორდერი“ (bme_repair)" "$(inmine "bme_triage:$REP" "$ENG"):$(inmine "bme_repair:$REP" "$ENG")" "0:1"
mod '{"sources":{"bme_repair":false}}'
chk "წყარო გამორთულია (sources.bme_repair = false) → არ ჩანს; ?source=bme_repair — ცარიელი" "$(inmine "bme_repair:$REP" "$ENG"):$(api GET '/worklist/mine?source=bme_repair' "$ENG" | jq -r '.items|length')" "0:0"
mod '{"sources":{}}'
chk "?source — უცნობი — 400" "$(code GET '/worklist/mine?source=foo' "$ENG")" "400"
# ხარისხი: ექთანი → ინციდენტი → ხარისხის მენეჯერს „ტრიაჟი“
CDEV=$(api GET "/quality/classifiers?kind=category" "$N1" | jq -r '.[0].id // empty')
INC=$(curl -s -X POST "$B/quality/incidents" -H "authorization: Bearer $N1" -F "data=$(jq -nc --arg d "$D1" --arg c "$CDEV" --arg at "$(ts '-30 minutes')" \
  '{event_type:"near_miss",affected:"none",occurred_at:$at,department_id:$d,category_id:$c,harm_reported:"none",description:"ტესტ-E2E: სამუშაო სიის შემოწმება",identity_mode:"open"}')" | jq -r '.id // empty')
if [ -n "$INC" ]; then
  chk "ხარისხის მენეჯერი: qm_triage (ბმული ინციდენტზე, ვადა — ტრიაჟის ვადა); ექთანს — არა" "$(api GET /worklist/mine "$QM" | jq -r --arg k "qm_triage:$INC" '.items[]|select(.key==$k)|"\(.link|endswith("'"$INC"'")):\(.due_at != null)"'):$(inmine "qm_triage:$INC" "$N1")" "true:true:0"
else bad "ინციდენტი ვერ შეიქმნა (ხარისხის მოდული ჩართულია?)" ""; fi
# ცვლები: N2-ის არყოფნის მოთხოვნა → ხელმძღვანელს (absence_approve, D1) „არყოფნის გადაწყვეტილება“
RR=$(api GET /roster/refs "$ADM"); T24=$(echo "$RR" | jq -r '.templates[]|select(.code=="24").id')
PN=$(api POST /roster/positions "$ADM" -d "{\"code\":\"E2E_WN_$S\",\"name\":\"ტესტ-E2E ექთანი (WL)\",\"category\":\"nurse\"}" | jq -r '.id // empty')
api POST /roster/staff/from-users "$ADM" -d "{\"user_ids\":[\"$N2ID\"],\"position_id\":\"$PN\"}" >/dev/null
SN2=$(api GET "/roster/staff?search=$(jq -rn --arg s 'დავ-82' '$s|@uri')" "$ADM" | jq -r --arg u "$N2ID" '[.[]|select(.user_id==$u)][0].id // empty')
TA=$(api GET /roster/absence-types "$N2" | jq -r '.[]|select(.code=="ANNUAL").id')
AB=""; for k in 21 22 23 24 25 26 27; do x=$(date -d "+$k days" +%F); AB=$(api POST /roster/absences "$N2" -d "{\"absence_type_id\":\"$TA\",\"date_from\":\"$x\",\"date_to\":\"$x\",\"note\":\"ტესტ-E2E\"}" | jq -r '.id // empty'); [ -n "$AB" ] && break; done
if [ -n "$SN2" ] && [ -n "$AB" ]; then
  chk "ხელმძღვანელი (absence_approve, D1): roster_absence; თავად თანამშრომელს — არა" "$(inmine "roster_absence:$AB" "$H1"):$(inmine "roster_absence:$AB" "$N2")" "1:0"
  api POST "/roster/absences/$AB/cancel" "$N2" -d '{"reason":"ტესტ-E2E"}' >/dev/null
else bad "არყოფნის მოთხოვნა ვერ შეიქმნა (ცვლების მოდული?)" "staff=$SN2 abs=$AB"; fi
# მორიგე: D1-ის მორიგის როლი, N2 მორიგეა ახლა (გამოქვეყნებული განრიგი, „24“ ცვლა)
DR=$(api POST /roster/duty-roles "$ADM" -d "{\"code\":\"E2E_WL_$S\",\"name\":\"ტესტ-E2E მორიგე ექთანი\",\"department_id\":\"$D1\",\"categories\":[\"nurse\"],\"required_count\":1,\"has_backup\":false}" | jq -r '.id // empty')
HR_NOW=$(TZ=Asia/Tbilisi date +%H); DAY=$(TZ=Asia/Tbilisi date +%F); [ "$((10#$HR_NOW))" -lt 9 ] && DAY=$(TZ=Asia/Tbilisi date -d 'yesterday' +%F)
ROS=$(api POST /roster/rosters "$ADM" -d "{\"department_id\":\"$D1\",\"month\":\"${DAY:0:7}\"}" | jq -r '.id // empty')
api POST "/roster/rosters/$ROS/entries" "$ADM" -d "{\"items\":[{\"staff_id\":\"$SN2\",\"day\":\"$DAY\",\"shift_template_id\":\"$T24\",\"duty_role_id\":\"$DR\",\"duty_level\":1}]}" >/dev/null
PUB=$(api POST "/roster/rosters/$ROS/publish" "$ADM" -d '{"confirm_warnings":true,"note":"ტესტ-E2E"}' | jq -r '.ok // empty')
if [ "$PUB" = "true" ]; then
  api POST /notifications/read-all "$N2" >/dev/null
  TDU=$(tid "$N1" "{\"title\":\"ტესტ-E2E მორიგეს\",\"target_kind\":\"duty\",\"target_duty_role_id\":\"$DR\"}")
  chk "მორიგეზე: N2 (ახლა მორიგე) — სიაში + შეტყობინება; N1 — არა" "$(inmine "task:$TDU" "$N2"):$(notes "$N2" "$TDU"):$(inmine "task:$TDU" "$N1")" "1:1:0"
  chk "მორიგე იღებს → შესრულება" "$(api POST "/worklist/tasks/$TDU/claim" "$N2" | jq -r .claimed_by_name | grep -c 'დავ-82'):$(api POST "/worklist/tasks/$TDU/done" "$N2" -d '{}' | jq -r .status)" "1:done"
else bad "განრიგი ვერ გამოქვეყნდა (მორიგის ტესტი გამოტოვდა)" "roster=$ROS"; fi
chk "ინფექციის კონტროლი / ხარისხი / ცვლები / ბიომედი — „ჩემი დავალებები“ შეცდომის გარეშე (200)" "$(code GET /worklist/mine "$QM"):$(code GET /worklist/mine "$H1"):$(code GET /worklist/mine "$ENG"):$(code GET /worklist/mine "$AL")" "200:200:200:200"

step "10. მთვლელი, მოდულის გამორთვა"
CNT=$(api GET /worklist/count "$N2"); MN=$(api GET /worklist/mine "$N2" | jq -r .totals.total)
chk "მთვლელი = „ჩემი დავალებების“ რაოდენობა; badge = all" "$(echo "$CNT" | jq -r '"\(.total == '"$MN"'):\(.badge):\(.enabled)"')" "true:all:true"
mod '{"badge":"off"}'
chk "badge = off → ნული" "$(api GET /worklist/count "$N2" | jq -r '"\(.total):\(.badge)"')" "0:off"
mod '{"badge":"all"}'
api PUT /modules/worklist "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
chk "მოდული გამორთულია: სია / შექმნა — 403 MODULE_DISABLED; მთვლელი — enabled false" "$(api GET /worklist/mine "$N1" | jq -r .code):$(code POST /worklist/tasks "$N1" -d '{"title":"ტესტ-E2E x"}'):$(api GET /worklist/count "$N1" | jq -r .enabled)" "MODULE_DISABLED:403:false"
api PUT /modules/worklist "$ADM" -d "$(echo "$ORIG" | jq -c '. + {reason:"ტესტ-E2E: აღდგენა"}')" >/dev/null

step "11. გასუფთავება"
for t in $(api GET "/worklist/tasks?box=team&status=active&q=$(jq -rn --arg s 'ტესტ-E2E' '$s|@uri')" "$AL" | jq -r '.[].id'); do api POST "/worklist/tasks/$t/cancel" "$AL" -d '{"reason":"ტესტ-E2E: გასუფთავება"}' >/dev/null; done
[ -n "${REP:-}" ] && api POST "/bme/repairs/$REP/reject" "$ENG" -d '{"reason":"other","note":"ტესტ-E2E"}' >/dev/null
[ -n "${DEV:-}" ] && api PATCH "/bme/devices/$DEV" "$ENG" -d '{"status":"retired","status_reason":"ტესტ-E2E"}' >/dev/null
[ -n "${C_T:-}" ] && api PATCH "/worklist/categories/$C_T" "$AL" -d '{"is_active":false}' >/dev/null
[ -n "${DR:-}" ] && api PATCH "/roster/duty-roles/$DR" "$ADM" -d '{"is_active":false}' >/dev/null
[ -n "${SN2:-}" ] && api PATCH "/roster/staff/$SN2" "$ADM" -d '{"is_active":false}' >/dev/null
[ -n "${PN:-}" ] && api PATCH "/roster/positions/$PN" "$ADM" -d '{"is_active":false}' >/dev/null
[ -f "$TMP/users" ] && while read -r u; do api PATCH "/users/$u" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/users"
[ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
for d in "$D1" "$D2"; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done
chk "პარამეტრები აღდგენილია" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}' | jq -S -c .)" "$(echo "$ORIG" | jq -S -c .)"
ok "სატესტო ჩანაწერები გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
