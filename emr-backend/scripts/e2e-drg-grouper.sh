#!/usr/bin/env bash
# =====================================================================
# e2e-drg-grouper.sh — DRG ბლოკი, ეტაპი 0055: grouper (დაჯგუფება)
#   0. მომზადება   1. მოდული, უფლებები   2. სქემა, გადამხდელი   3. ვერსია: CSV იმპორტი (ჯგუფები, სიები, CC, წესები), პარამეტრები, შემოწმება
#   4. ტესტ-შემთხვევა (ძრავა)   5. გააქტიურება (დამტკიცება), დაბლოკვა, ასლი, თარიღის კონფლიქტი, გაუქმება   6. პაკეტი (JSON), სადემონსტრაციო
#   7. შემთხვევა: შეთავაზება → გადამხდელი → დადასტურება → შეცვლილი მონაცემები → ფინალიზაცია (block / warn) → შეცვლა მიზეზით → გაუქმება
#   8. გადამხდელის ფორმა: grouper_only / ხელით; შეუსაბამობა   9. ისტორია, მონახაზის შემოწმება შემთხვევაზე   10. აღდგენა
# გამოყენება:  bash scripts/e2e-drg-grouper.sh [API_URL]
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
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
csvb() { jq -nc --arg c "$1" --argjson d "${2:-false}" --argjson r "${3:-false}" '{csv:$c,dry_run:$d,replace:$r}'; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F); PAST=$(date -d "$TODAY -30 days" +%F); FUT=$(date -d "$TODAY +400 days" +%F)

step "0. მომზადება"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E DRG თერაპია $S\",\"code\":\"E2EDG$S\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] || die "განყოფილება ვერ შეიქმნა"
tar() { api POST /tariffs "$ADM" -d "{\"code\":\"$1\",\"title\":\"ტესტ-E2E DRG $2\",\"base_price\":$3}" | jq -r '.id // empty'; }
T_BED=$(tar "E2EDGBED$S" "საწოლდღე" 100); T_PROC=$(tar "E2EDGPRC$S" "პროცედურა (DRG სია)" 300)
[ -n "$T_BED" ] && [ -n "$T_PROC" ] || die "ტარიფები ვერ შეიქმნა"
BT=$(api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
[ -n "$BT" ] || die "საწოლდღის ტარიფი ვერ დაყენდა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
R_CD=$(mkrole dcd "DRG კოდირება" '["drg"]'); R_DA=$(mkrole dad "DRG კონფიგურაცია" '["drg_admin"]')
[ -n "$R_CD" ] && [ -n "$R_DA" ] || die "როლები ვერ შეიქმნა (drg / drg_admin — მიგრაცია 0055?)"
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.drg.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"DRG-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.drg.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
CD=$(mkuser "[\"$R_CD\"]" 81); DA1=$(mkuser "[\"$R_DA\"]" 82); DA2=$(mkuser "[\"$R_DA\"]" 83); BL=$(mkuser '["billing"]' 84); RC=$(mkuser '["receptionist"]' 85)
DR=$(mkuser '["doctor"]' 86 ",\"department_id\":\"$DA\""); NA=$(mkuser '["nurse"]' 87 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 88 ",\"department_id\":\"$DA\"")
for t in CD DA1 DA2 BL RC DR NA N2; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "განყოფილება, ტარიფები (საწოლდღე 100, პროცედურა 300), 8 მომხმარებელი (კოდირება, 2 კონფიგურაცია, ბილინგი, მიმღები, ექიმი, 2 ექთანი)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$S")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 91 "DRG-1" "1970-05-05" male); P2=$(mkpat 92 "DRG-2" "1985-01-01" female)
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
ORIG=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="drg")|.settings')
ORIG_EN=$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="drg")|.enabled')
ORIG_IPD=$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="inpatient")|.settings')
mod() { api PUT /modules/drg "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
api PUT /modules/inpatient "$ADM" -d '{"settings":{"discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null

step "1. მოდული, უფლებები"
chk "მოდული drg: ნაგულისხმევი პარამეტრები" "$(echo "$ORIG" | jq -r '"\(.version_date_basis):\(.confirm_required):\(.recheck_on_finalize):\(.manual_payer_drg):\(.version_approval)"')" "discharge:true:block:allowed:off"
api PUT /modules/drg "$ADM" -d '{"enabled":true,"settings":{"version_date_basis":"discharge","confirm_required":true,"recheck_on_finalize":"block","manual_payer_drg":"allowed","version_approval":"off"},"reason":"ტესტ-E2E"}' >/dev/null
chk "არასწორი პარამეტრი (recheck_on_finalize=x) → 400" "$(code PUT /modules/drg "$ADM" -d '{"settings":{"recheck_on_finalize":"x"},"reason":"ტესტ-E2E"}')" "400"
chk "უფლებების კატალოგი: drg, drg_admin" "$(api GET /roles/capabilities "$ADM" | jq -r '[.[].code|select(.=="drg" or .=="drg_admin")]|sort|join(",")')" "drg,drg_admin"
chk "ექთანი DRG კონფიგურაციას ვერ ხედავს (403)" "$(code GET /drg/schemes "$NA")" "403"
chk "კოდირება / ბილინგი — ნახვა (200 / 200)" "$(code GET /drg/schemes "$CD") / $(code GET /drg/meta "$BL")" "200 / 200"
chk "მეტა: 16 ველი, ოპერატორები" "$(api GET /drg/meta "$CD" | jq -r '"\(.fields|length):\(.ops.between)"')" "16:შუალედი"

step "2. სქემა, გადამხდელი"
chk "ბილინგი სქემას ვერ ქმნის (403)" "$(code POST /drg/schemes "$BL" -d "{\"code\":\"E2ED$S\",\"name\":\"ტესტ-E2E\"}")" "403"
SCH=$(api POST /drg/schemes "$DA1" -d "{\"code\":\"E2ED$S\",\"name\":\"ტესტ-E2E DRG სქემა $S\"}" | jq -r '.id // empty')
[ -n "$SCH" ] && ok "სქემა (DRG კონფიგურაცია)" || die "სქემა ვერ შეიქმნა"
chk "გამეორებული კოდი → 409" "$(code POST /drg/schemes "$DA1" -d "{\"code\":\"E2ED$S\",\"name\":\"ტესტ-E2E 2\"}")" "409"
DEF=$(api GET /drg/schemes "$CD" | jq -r '.[]|select(.is_default)|.id')
chk "ნაგულისხმევი სქემა არ ითიშება (400)" "$(code PATCH "/drg/schemes/$DEF" "$DA1" -d '{"is_active":false}')" "400"
PY=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EDP$S\",\"name\":\"ტესტ-E2E DRG სახელმწიფო $S\",\"kind\":\"state\",\"default_mode\":\"drg\",\"default_coverage_pct\":100,\"drg_base_rate\":1000}" | jq -r '.id // empty')
[ -n "$PY" ] || die "გადამხდელი ვერ შეიქმნა"
chk "გადამხდელი → სქემა (კოდირება ვერ ცვლის — 403)" "$(code PUT "/drg/payers/$PY/scheme" "$CD" -d "{\"drg_scheme_id\":\"$SCH\"}")" "403"
api PUT "/drg/payers/$PY/scheme" "$DA1" -d "{\"drg_scheme_id\":\"$SCH\"}" >/dev/null
chk "გადამხდელი მიბმულია სქემაზე" "$(api GET /drg/payers "$CD" | jq -r --arg p "$PY" '.[]|select(.id==$p)|.scheme_name')" "ტესტ-E2E DRG სქემა $S"

step "3. ვერსია: შემადგენლობა"
V1=$(api POST "/drg/schemes/$SCH/versions" "$DA1" -d "{\"label\":\"ტესტ-E2E ვერსია 1\",\"valid_from\":\"$PAST\"}" | jq -r '.id // empty')
[ -n "$V1" ] && ok "ცარიელი მონახაზი (მოქმედებს $PAST)" || die "ვერსია ვერ შეიქმნა"
chk "შემოწმება: ცარიელი → შეცდომები (ჯგუფები, წესები)" "$(api GET "/drg/versions/$V1/check" "$CD" | jq -r '"\(.ok):\(.errors|length)"')" "false:2"
chk "ცარიელის გააქტიურება → 400" "$(code POST "/drg/versions/$V1/activate" "$DA1" -d '{}')" "400"
GCSV=$(printf 'code;title;weight;alos;los_low;los_high;mdc;kind\nT1;ტესტ-E2E პნევმონია;0,8;5;1;12;04;medical\nT2;"ტესტ-E2E პნევმონია; CC";1.3;7;2;18;04;medical\nT3;ტესტ-E2E პნევმონია ბავშვი;0.7;4;;;04;medical\nT4;ტესტ-E2E პროცედურა;2.5;3;1;9;06;surgical\nT6;ტესტ-E2E მშობიარობა;0.6;2;;;14;medical\nT9;ტესტ-E2E ვერ დაჯგუფდა;0.1;;;;ERR;other\n')
R=$(api POST "/drg/versions/$V1/groups/import" "$DA1" -d "$(csvb "$GCSV" true)")
chk "ჯგუფები CSV (შემოწმება): 6, არ ჩაიწერა" "$(echo "$R" | jq -r '"\(.rows):\(.added):\(.applied)"')" "6:6:false"
chk "კოდირება იმპორტს ვერ აკეთებს (403)" "$(code POST "/drg/versions/$V1/groups/import" "$CD" -d "$(csvb "$GCSV")")" "403"
R=$(api POST "/drg/versions/$V1/groups/import" "$DA1" -d "$(csvb "$GCSV")")
chk "ჯგუფები CSV: ჩაიწერა" "$(echo "$R" | jq -r '"\(.added):\(.applied)"')" "6:true"
chk "წონა მძიმით (0,8), ბრჭყალებში „;“" "$(api GET "/drg/versions/$V1/groups?q=T2" "$CD" | jq -r '.rows[0].title'):$(api GET "/drg/versions/$V1/groups?q=T1" "$CD" | jq -r '.rows[0].weight|tonumber+0')" "ტესტ-E2E პნევმონია; CC:0.8"
BADG=$(printf 'code;title;weight\nTX;ტესტ;abc\nT1;ტესტ;1;;5;2\n')
chk "არასწორი წონა / ზღვრები → შეცდომები, არაფერი" "$(api POST "/drg/versions/$V1/groups/import" "$DA1" -d "$(csvb "$BADG")" | jq -r '"\(.errors|length):\(.applied)"')" "2:false"
chk "ჯგუფი ხელით (PUT T5)" "$(api PUT "/drg/versions/$V1/groups/T5" "$DA1" -d '{"title":"ტესტ-E2E ვენტილაცია","weight":5,"kind":"other","los_low":3,"los_high":40}' | jq -r '"\(.code):\(.weight|tonumber+0)"')" "T5:5"
chk "ზღვრები: ქვედა > ზედა → 400" "$(code PUT "/drg/versions/$V1/groups/T5" "$DA1" -d '{"los_low":50}')" "400"
LCSV=$(printf 'list;kind;pattern;title\nPNEU;dx;J12-J18;პნევმონია\nDELIV;dx;O80-O84;\nPROCX;service;E2EDGPRC%s;\nSAME;proc;JEA;\n' "$S")
R=$(api POST "/drg/versions/$V1/lists-import" "$DA1" -d "$(csvb "$LCSV")")
chk "სიები CSV: 4 სია (ახალი), 4 ჩანაწერი" "$(echo "$R" | jq -r '"\(.lists):\(.new_lists):\(.items):\(.applied)"')" "4:4:4:true"
chk "სია: ხელით (PUT, ჩანაწერები ნორმალიზდება: k35.8 → K358)" "$(api PUT "/drg/versions/$V1/lists/APP" "$DA1" -d '{"title":"ტესტ-E2E აპენდიციტი","kind":"dx","items":["k35.8","K36 "," K37"]}' | jq -r '.items'):$(api GET "/drg/versions/$V1/lists/APP" "$CD" | jq -r '[.items[].pattern]|join(",")')" "3:K358,K36,K37"
chk "სია: არასწორი კოდი („K-“) → 400" "$(code PUT "/drg/versions/$V1/lists/BAD" "$DA1" -d '{"title":"ტესტ","kind":"dx","items":["K-"]}')" "400"
chk "სიის სახეობის შეუსაბამობა CSV-ში → შეცდომა" "$(api POST "/drg/versions/$V1/lists-import" "$DA1" -d "$(csvb "$(printf 'PNEU;proc;X01\n')")" | jq -r '"\(.errors|length>0):\(.applied)"')" "true:false"
chk "CC: N17 MCC" "$(api PUT "/drg/versions/$V1/cc" "$DA1" -d '{"pattern":"n17","level":"mcc"}' | jq -r '"\(.pattern):\(.level)"')" "N17:mcc"
CCSV=$(printf 'pattern;level;excl_pdx\nE10-E11;cc;\nJ44;cc;@PNEU\nI50;cc;J81\n')
chk "CC CSV: 3" "$(api POST "/drg/versions/$V1/cc-import" "$DA1" -d "$(csvb "$CCSV")" | jq -r '"\(.rows):\(.applied)"')" "3:true"
chk "CC: უცნობი სია გამონაკლისში → 400" "$(code PUT "/drg/versions/$V1/cc" "$DA1" -d '{"pattern":"D62","level":"cc","excl_pdx":["@NOPE"]}')" "400"
RCSV=$(printf 'seq;drg_code;conditions;label\n10;T4;service any @PROCX;პროცედურა\n20;T3;pdx in @PNEU & age between 0..17;ბავშვი\n30;T2;pdx in @PNEU & cc >= cc;CC\n40;T1;pdx in @PNEU;პნევმონია\n50;T6;pdx in @DELIV & sex = F;მშობიარობა\n')
chk "წესები CSV (შემოწმება): 5" "$(api POST "/drg/versions/$V1/rules-import" "$DA1" -d "$(csvb "$RCSV" true)" | jq -r '"\(.rows):\(.applied)"')" "5:false"
chk "წესი: უცნობი სია → შეცდომა" "$(api POST "/drg/versions/$V1/rules-import" "$DA1" -d "$(csvb "$(printf '10;T1;pdx in @NOPE\n')")" | jq -r '.errors[0]|test("@NOPE")')" "true"
chk "წესი: სხვა სახეობის სია (proc ველში dx სია) → შეცდომა" "$(api POST "/drg/versions/$V1/rules-import" "$DA1" -d "$(csvb "$(printf '10;T1;proc any @PNEU\n')")" | jq -r '.errors|length')" "1"
chk "წესი: უცნობი ჯგუფი → შეცდომა" "$(api POST "/drg/versions/$V1/rules-import" "$DA1" -d "$(csvb "$(printf '10;ZZ;pdx in @PNEU\n')")" | jq -r '.errors|length')" "1"
chk "წესები CSV: ჩაიწერა" "$(api POST "/drg/versions/$V1/rules-import" "$DA1" -d "$(csvb "$RCSV")" | jq -r '.applied')" "true"
RV=$(api POST "/drg/versions/$V1/rules" "$DA1" -d '{"seq":5,"drg_code":"T5","label":"ვენტილაცია","conditions":[{"f":"vent_hours","op":"gte","v":96}]}')
RVID=$(echo "$RV" | jq -r '.id // empty')
chk "წესი JSON-ით (კონსტრუქტორი): ტექსტური ჩანაწერი" "$(echo "$RV" | jq -r '.conditions_text')" "vent_hours >= 96"
chk "წესი: არასწორი ოპერატორი (sex gte) → 400" "$(code POST "/drg/versions/$V1/rules" "$DA1" -d '{"drg_code":"T1","conditions":[{"f":"sex","op":"gte","v":"F"}]}')" "400"
chk "წესი: ტექსტი (DSL) — შუალედი a..b" "$(api PATCH "/drg/rules/$RVID" "$DA1" -d '{"conditions_text":"vent_hours between 96..100000 & surgery is no"}' | jq -r '.conditions_text')" "vent_hours between 96..100000 & surgery is no"
chk "წესი: DSL შეცდომა → 400" "$(code PATCH "/drg/rules/$RVID" "$DA1" -d '{"conditions_text":"vent_hours ~ 5"}')" "400"
chk "წესების რაოდენობა 6, რიგი 5,10,…" "$(api GET "/drg/versions/$V1/rules" "$CD" | jq -r '[.[].seq]|map(tostring)|join(",")')" "5,10,20,30,40,50"
IDS=$(api GET "/drg/versions/$V1/rules" "$CD" | jq -c '[.[].id]')
chk "რიგის შეცვლა (10, 20, …)" "$(api POST "/drg/versions/$V1/rules-reorder" "$DA1" -d "{\"ids\":$IDS}" | jq -r '.ok'):$(api GET "/drg/versions/$V1/rules" "$CD" | jq -r '[.[].seq]|map(tostring)|join(",")')" "true:10,20,30,40,50,60"
chk "რიგი: არასრული სია → 400" "$(code POST "/drg/versions/$V1/rules-reorder" "$DA1" -d "{\"ids\":[\"$RVID\"]}")" "400"
chk "ჯგუფის წაშლა, რომელსაც წესი იყენებს → 400" "$(code DELETE "/drg/versions/$V1/groups/T1" "$DA1")" "400"
chk "სიის წაშლა, რომელსაც წესი იყენებს → 409" "$(code DELETE "/drg/versions/$V1/lists/PNEU" "$DA1")" "409"
chk "გამოუყენებელი სიის წაშლა (SAME)" "$(api DELETE "/drg/versions/$V1/lists/SAME" "$DA1" | jq -r '.ok')" "true"
chk "პარამეტრები: fallback T9, proc_sources + service_code" "$(api PATCH "/drg/versions/$V1" "$DA1" -d '{"settings":{"fallback_code":"T9","proc_sources":["or_ncsp","or_code","service_code"]}}' | jq -r '.id|length>0'):$(api GET "/drg/versions/$V1" "$CD" | jq -r '"\(.settings.fallback_code):\(.settings.proc_sources|length):\(.settings.los_basis)"')" "true:T9:3:bed_days"
chk "პარამეტრები: უცნობი ჯგუფი fallback-ად → 400" "$(code PATCH "/drg/versions/$V1" "$DA1" -d '{"settings":{"fallback_code":"NOPE"}}')" "400"
chk "პარამეტრები: არასწორი მნიშვნელობა (los_basis=x) → 400" "$(code PATCH "/drg/versions/$V1" "$DA1" -d '{"settings":{"los_basis":"x"}}')" "400"
C=$(api GET "/drg/versions/$V1/check" "$CD")
chk "შემოწმება: შეცდომა არ არის; გაფრთხილება — ჯგუფი წესის გარეშე, CC" "$(echo "$C" | jq -r '"\(.ok):\(.errors|length):\([.warnings[]|select(test("წესის გარეშე"))]|length)"')" "true:0:0"

step "4. ტესტ-შემთხვევა (ძრავა)"
t() { api POST "/drg/versions/$V1/test" "$CD" -d "$1" | jq -r "$2"; }
chk "J18.9, 60 წ → T1 (წესი 50)" "$(t '{"pdx":"J18.9","age":60,"los":4}' '"\(.result.code):\(.result.rule_seq):\(.result.cc_level)"')" "T1:50:none"
chk "J18.9 + N17.9 (MCC) → T2" "$(t '{"pdx":"J18.9","sdx":["N17.9"],"age":60}' '"\(.result.code):\(.result.cc_level)"')" "T2:mcc"
chk "J18.9 + J44.9: CC გამონაკლისი (@PNEU) → T1" "$(t '{"pdx":"J18.9","sdx":["J44.9"],"age":60}' '"\(.result.code):\(.result.trace.cc[0].counted)"')" "T1:false"
chk "J18.9 + E11.9 (CC) → T2" "$(t '{"pdx":"J18.9","sdx":["E11.9"],"age":60}' '"\(.result.code):\(.result.cc_level)"')" "T2:cc"
chk "J18.9, 10 წ → T3 (ასაკის შუალედი)" "$(t '{"pdx":"J18.9","age":10}' '.result.code')" "T3"
chk "J18.9 + პროცედურის სერვისი → T4 (პირველი წესი)" "$(t "{\"pdx\":\"J18.9\",\"services\":[\"E2EDGPRC$S\"],\"age\":60}" '.result.code')" "T4"
chk "O80, F → T6; O80, M → T9 (ნაგულისხმევი)" "$(t '{"pdx":"O80","sex":"F","age":30}' '.result.code'):$(t '{"pdx":"O80","sex":"M","age":30}' '"\(.result.code):\(.result.fallback)"')" "T6:T9:true"
chk "ვენტილაცია 120 სთ, ოპერაციის გარეშე → T5" "$(t '{"pdx":"Z00","vent_hours":120,"surgery":false}' '.result.code')" "T5"
chk "ძირითადი დიაგნოზის გარეშე → შედეგი არ არის (NO_PDX)" "$(t '{"sdx":["J18.9"]}' '"\(.result.code):\(.result.issues[0].code)"')" "null:NO_PDX"
chk "„რატომ“: დამთხვეული პირობა" "$(t '{"pdx":"J18.9","age":60}' '.result.trace.matched.conds[0].why')" "დაემთხვა: J189"
chk "გამოტოვებული წესები (trace)" "$(t '{"pdx":"J18.9","age":60}' '.result.trace.skipped_total')" "4"

step "5. გააქტიურება, დაბლოკვა, ასლი, გაუქმება"
mod '{"version_approval":"required"}'
chk "version_approval=required: ბოლო რედაქტორი ვერ ააქტიურებს (403)" "$(code POST "/drg/versions/$V1/activate" "$DA1" -d '{}')" "403"
chk "კოდირება ვერ ააქტიურებს (403)" "$(code POST "/drg/versions/$V1/activate" "$CD" -d '{}')" "403"
chk "მეორე პირი ააქტიურებს" "$(api POST "/drg/versions/$V1/activate" "$DA2" -d '{}' | jq -r '.ok')" "true"
mod '{"version_approval":"off"}'
chk "სქემის მიმდინარე ვერსია" "$(api GET /drg/schemes "$CD" | jq -r --arg s "$SCH" '.[]|select(.id==$s)|.current_version.id')" "$V1"
chk "აქტიურის შეცვლა → 409 DRG_VERSION_LOCKED" "$(api PUT "/drg/versions/$V1/groups/T1" "$DA1" -d '{"weight":9}' | jq -r '.code')" "DRG_VERSION_LOCKED"
chk "აქტიურის წესის შეცვლა → 409" "$(code PATCH "/drg/rules/$RVID" "$DA1" -d '{"label":"x"}')" "409"
chk "აქტიურის წაშლა → 409" "$(code DELETE "/drg/versions/$V1" "$DA1")" "409"
chk "drg_groups (0046 ცნობარი) — კოდები აისახა" "$(api GET "/billing/drg?search=T4" "$BL" | jq -r '[.rows[]|select(.code=="T4")]|length')" "1"
V2=$(api POST "/drg/schemes/$SCH/versions" "$DA1" -d "{\"label\":\"ტესტ-E2E ვერსია 2\",\"valid_from\":\"$PAST\",\"copy_from\":\"$V1\"}" | jq -r '.id // empty')
chk "ასლი: შემადგენლობა იგივეა (ჯგუფი 7, სია 4, CC 4, წესი 6)" "$(api GET "/drg/versions/$V2" "$CD" | jq -r '"\(.n_groups):\(.n_lists):\(.n_cc):\(.n_rules):\(.status)"')" "7:4:4:6:draft"
chk "ასლში ცვლილება შესაძლებელია (T1 წონა 0.9)" "$(api PUT "/drg/versions/$V2/groups/T1" "$DA1" -d '{"weight":0.9}' | jq -r '.weight|tonumber+0')" "0.9"
chk "იმავე თარიღით გააქტიურება → 409 (კონფლიქტი)" "$(code POST "/drg/versions/$V2/activate" "$DA1" -d '{}')" "409"
api PATCH "/drg/versions/$V2" "$DA1" -d "{\"valid_from\":\"$FUT\"}" >/dev/null
chk "მომავალი თარიღით გააქტიურება" "$(api POST "/drg/versions/$V2/activate" "$DA1" -d '{}' | jq -r '.ok')" "true"
chk "დღეს მოქმედებს კვლავ V1" "$(api GET /drg/schemes "$CD" | jq -r --arg s "$SCH" '.[]|select(.id==$s)|.current_version.id')" "$V1"
chk "გაუქმება მიზეზის გარეშე → 400" "$(code POST "/drg/versions/$V2/retire" "$DA1" -d '{}')" "400"
chk "V2 გაუქმება" "$(api POST "/drg/versions/$V2/retire" "$DA1" -d '{"reason":"ტესტ-E2E გაუქმება"}' | jq -r '.ok'):$(api GET "/drg/versions/$V2" "$CD" | jq -r .status)" "true:retired"

step "6. პაკეტი (JSON), სადემონსტრაციო, CSV ექსპორტი"
PKG=$(api GET "/drg/versions/$V1/export" "$CD")
chk "ექსპორტი: ფორმატი, ჯგუფი 7, წესი 6" "$(echo "$PKG" | jq -r '"\(.format):\(.groups|length):\(.rules|length)"')" "emr-drg-version:7:6"
V3=$(api POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$PKG" '{package:$p,label:"ტესტ-E2E იმპორტი"}')" | jq -r '.id // empty')
chk "იმპორტი → ახალი მონახაზი, იგივე შემადგენლობა" "$(api GET "/drg/versions/$V3" "$CD" | jq -r '"\(.n_groups):\(.n_lists):\(.n_cc):\(.n_rules):\(.status)"')" "7:4:4:6:draft"
BADPKG=$(echo "$PKG" | jq -c '.rules[0].drg_code="NOPE"')
chk "პაკეტი: უცნობი ჯგუფი წესში → 400 (არაფერი იქმნება)" "$(code POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$BADPKG" '{package:$p,label:"ტესტ-E2E x"}')")" "400"
chk "პაკეტი: სხვა ფორმატი → 400" "$(code POST "/drg/schemes/$SCH/versions/import" "$DA1" -d '{"package":{"format":"x"},"label":"ტესტ-E2E x","valid_from":"2026-01-01"}')" "400"
chk "მონახაზის წაშლა" "$(api DELETE "/drg/versions/$V3" "$DA1" | jq -r '.ok'):$(code GET "/drg/versions/$V3" "$CD")" "true:404"
VD=$(api POST "/drg/schemes/$SCH/versions/demo" "$DA1" -d "{\"valid_from\":\"$FUT\"}")
VDID=$(echo "$VD" | jq -r '.id // empty')
chk "სადემონსტრაციო: 14 ჯგუფი, 13 წესი; შემოწმება გავლილია" "$(echo "$VD" | jq -r '"\(.groups):\(.rules)"'):$(api GET "/drg/versions/$VDID/check" "$CD" | jq -r .ok)" "14:13:true"
chk "სადემონსტრაციო: K35.8 + JEA01 + E11 → G01A" "$(api POST "/drg/versions/$VDID/test" "$CD" -d '{"pdx":"K35.8","sdx":["E11.9"],"procs":["JEA01"],"age":40}' | jq -r .result.code)" "G01A"
api DELETE "/drg/versions/$VDID" "$DA1" >/dev/null
chk "CSV ექსპორტი (წესები): BOM, სათაური, DSL" "$(curl -s "$B/drg/versions/$V1/csv/rules" -H "authorization: Bearer $CD" | sed -n 2p | cut -d';' -f1-3)" "10;T5;vent_hours between 96..100000 & surgery is no"
chk "CSV ექსპორტი: უცნობი ცხრილი → 400" "$(code GET "/drg/versions/$V1/csv/x" "$CD")" "400"

step "7. შემთხვევა: შეთავაზება → დადასტურება → ფინალიზაცია"
E1=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$P1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 86)\",\"source\":\"emergency\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
[ -n "$E1" ] && ok "ჰოსპიტალიზაცია (მიღების დიაგნოზი J18.9)" || die "ჰოსპიტალიზაცია ვერ მოხერხდა"
chk "DRG რეჟიმი, ძირითადი დიაგნოზის გარეშე → გადამხდელი ვერ ემატება (400)" "$(code POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$PY\"}")" "400"
api POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' >/dev/null
SP=$(api POST "/inpatient/stays/$E1/payers" "$RC" -d "{\"payer_id\":\"$PY\"}")
SPID=$(echo "$SP" | jq -r '.id // empty')
chk "გადამხდელი კოდის გარეშე → შეთავაზება T1, წონა ვერსიიდან, წყარო grouper" "$(echo "$SP" | jq -r '"\(.drg_code):\(.drg_weight|tonumber+0):\(.drg_source):\(.drg_version_id==$v)"' --arg v "$V1")" "T1:0.8:grouper:true"
V=$(api GET "/drg/stays/$E1" "$CD")
chk "ბლოკი: სქემა, ვერსია, შეთავაზება T1, დაუდასტურებელი" "$(echo "$V" | jq -r '.schemes[0]|"\(.scheme.id==$s):\(.version.id==$v):\(.result.code):\(.current)"' --arg s "$SCH" --arg v "$V1")" "true:true:T1:null"
chk "მონაცემები: PDX J18.9, ასაკი 56, სქესი M, წყარო — გადაუდებელი" "$(echo "$V" | jq -r '.schemes[0].inputs|"\(.pdx):\(.age):\(.sex):\(.source)"')" "J189:56:M:emergency"
chk "ექთანი DRG ბლოკს ვერ ხედავს (403); ექიმი — ხედავს (200)" "$(code GET "/drg/stays/$E1" "$NA"):$(code GET "/drg/stays/$E1" "$DR")" "403:200"
api POST "/encounters/$E1/diagnoses" "$DR" -d '{"icd10_code":"N17.9","diagnosis_type":"secondary"}' >/dev/null
chk "თანმხლები N17.9 (MCC) → შეთავაზება T2" "$(api GET "/drg/stays/$E1" "$CD" | jq -r '.schemes[0].result|"\(.code):\(.cc_level)"')" "T2:mcc"
chk "ექიმი ვერ ადასტურებს (403)" "$(code POST "/drg/stays/$E1/confirm" "$DR" -d "{\"scheme_id\":\"$SCH\"}")" "403"
R=$(api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}")
chk "კოდირება ადასტურებს T2; გადამხდელი განახლდა" "$(echo "$R" | jq -r '"\(.status):\(.code):\(.payers_updated)"')" "confirmed:T2:1"
B1=$(api GET "/inpatient/stays/$E1/billing" "$BL")
chk "გადამხდელი: T2, წონა 1.3, ტარიფი 1300 (1.3 × 1000)" "$(echo "$B1" | jq -r --arg p "$SPID" '.payers[]|select(.id==$p)|"\(.drg_code):\(.drg_weight|tonumber+0):\(.calc.tariff)"')" "T2:1.3:1300"
chk "ბლოკი: დადასტურებულია, არ შეცვლილა" "$(api GET "/drg/stays/$E1" "$CD" | jq -r '.schemes[0]|"\(.current.final_code):\(.current.status):\(.stale)"')" "T2:confirmed:false"
api POST "/inpatient/stays/$E1/services" "$BL" -d "{\"tariff_id\":\"$T_PROC\",\"quantity\":1}" >/dev/null
V=$(api GET "/drg/stays/$E1" "$CD")
chk "პროცედურის მომსახურება → შეთავაზება T4, „შეიცვალა“" "$(echo "$V" | jq -r '.schemes[0]|"\(.result.code):\(.stale)"')" "T4:true"
R=$(api POST "/inpatient/stays/$E1/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 87)\",\"$(uid 88)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" | jq -r '.status // .message')
chk "გაწერა (თვითნებური)" "$R" "discharged"
chk "გაწერის ტიპი მონაცემებში" "$(api GET "/drg/stays/$E1" "$CD" | jq -r '.schemes[0].inputs.discharge')" "against_advice"
chk "ფინალიზაცია: შეიცვალა (block) → 409 DRG_STALE" "$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL" | jq -r '.code')" "DRG_STALE"
mod '{"recheck_on_finalize":"warn"}'
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "recheck_on_finalize=warn → ფინალიზაცია გაფრთხილებით" "$(echo "$F" | jq -r '"\(.finalized):\(.drg_warnings|length)"')" "true:1"
chk "ფინალიზებულზე დადასტურება → 409" "$(api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" | jq -r '.code')" "FINALIZED"
chk "ფინალიზებულზე გაუქმება → 409" "$(code POST "/drg/stays/$E1/reset" "$CD" -d "{\"scheme_id\":\"$SCH\",\"reason\":\"ტესტ-E2E შეცდომა\"}")" "409"
api POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
mod '{"recheck_on_finalize":"block"}'
chk "შეცვლა მიზეზის გარეშე (T1 ≠ შეთავაზება T4) → 400" "$(code POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\",\"code\":\"T1\"}")" "400"
chk "ვერსიაში არმყოფი ჯგუფი → 400" "$(code POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\",\"code\":\"ZZ9\",\"reason\":\"ტესტ-E2E მიზეზი\"}")" "400"
R=$(api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\",\"code\":\"T1\",\"reason\":\"ტესტ-E2E პროცედურა არ ითვლება\"}")
chk "შეცვლა მიზეზით → overridden, T1" "$(echo "$R" | jq -r '"\(.status):\(.code)"')" "overridden:T1"
chk "გადამხდელი: T1, 0.8; ტარიფი 800" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r --arg p "$SPID" '.payers[]|select(.id==$p)|"\(.drg_code):\(.drg_weight|tonumber+0):\(.calc.tariff)"')" "T1:0.8:800"
F=$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL")
chk "ფინალიზაცია (დადასტურებული, უცვლელი) — გაფრთხილების გარეშე" "$(echo "$F" | jq -r '"\(.finalized):\(.drg_warnings|length)"')" "true:0"
api POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
chk "გაუქმება მოკლე მიზეზით → 400" "$(code POST "/drg/stays/$E1/reset" "$CD" -d "{\"scheme_id\":\"$SCH\",\"reason\":\"x\"}")" "400"
chk "დადასტურების გაუქმება" "$(api POST "/drg/stays/$E1/reset" "$CD" -d "{\"scheme_id\":\"$SCH\",\"reason\":\"ტესტ-E2E ხელახლა\"}" | jq -r '.ok')" "true"
chk "ფინალიზაცია დადასტურების გარეშე → 409 DRG_NOT_CONFIRMED" "$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL" | jq -r '.code')" "DRG_NOT_CONFIRMED"
mod '{"confirm_required":false}'
chk "confirm_required=false → ფინალიზაცია" "$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL" | jq -r '.finalized')" "true"
api POST "/inpatient/stays/$E1/billing/reopen" "$BL" -d '{"reason":"ტესტ-E2E შესწორება"}' >/dev/null
mod '{"confirm_required":true}'

step "8. გადამხდელის ფორმა: ხელით / grouper_only"
api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" >/dev/null
chk "დადასტურება (T4)" "$(api GET "/drg/stays/$E1" "$CD" | jq -r '.schemes[0].current.final_code')" "T4"
mod '{"manual_payer_drg":"grouper_only"}'
chk "grouper_only: ხელით სხვა კოდი → 400" "$(code PATCH "/inpatient/stay-payers/$SPID" "$BL" -d '{"drg_code":"T1"}')" "400"
chk "grouper_only: დადასტურებული კოდი — 200" "$(code PATCH "/inpatient/stay-payers/$SPID" "$BL" -d '{"drg_code":"T4"}')" "200"
mod '{"manual_payer_drg":"allowed"}'
chk "allowed: ხელით T6 → წყარო manual, წონა ვერსიიდან 0.6" "$(api PATCH "/inpatient/stay-payers/$SPID" "$BL" -d '{"drg_code":"T6"}' | jq -r '"\(.drg_code):\(.drg_source):\(.drg_weight|tonumber+0)"')" "T6:manual:0.6"
chk "ფინალიზაცია: გადამხდელის კოდი ≠ დადასტურებული → 409 DRG_MISMATCH" "$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL" | jq -r '.code')" "DRG_MISMATCH"
api POST "/drg/stays/$E1/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" >/dev/null
chk "ხელახლა დადასტურება → გადამხდელი T4, ფინალიზაცია" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r --arg p "$SPID" '.payers[]|select(.id==$p)|.drg_code'):$(api POST "/inpatient/stays/$E1/billing/finalize" "$BL" | jq -r '.finalized')" "T4:true"
chk "გადამხდელის წილი: min(2500, ჯამი)" "$(api GET "/inpatient/stays/$E1/billing" "$BL" | jq -r --arg p "$SPID" '.payers[]|select(.id==$p)|(.covered_amount|tonumber) == ([2500, (.calc.eligible)]|min)')" "true"

step "9. ისტორია, მონახაზის შემოწმება შემთხვევაზე"
H=$(api GET "/drg/stays/$E1/history" "$CD")
chk "ისტორია: 4 დადასტურება (T2, T1 შეცვლით, T4 ×2), 1 მიმდინარე" "$(echo "$H" | jq -r '"\(length):\([.[]|select(.superseded_at==null)]|length):\([.[]|select(.status=="overridden")]|length):\([.[].final_code]|join(","))"')" "4:1:1:T4,T4,T1,T2"
chk "ჰოსპიტალიზაციის ისტორია: drg_confirmed, drg_reset" "$(api GET "/inpatient/stays/$E1" "$ADM" | jq -r '[.events[].kind|select(test("^drg_"))]|unique|join(",")')" "drg_confirmed,drg_reset"
V4=$(api POST "/drg/schemes/$SCH/versions" "$DA1" -d "{\"label\":\"ტესტ-E2E მონახაზი\",\"valid_from\":\"$FUT\",\"copy_from\":\"$V1\"}" | jq -r '.id // empty')
api PUT "/drg/versions/$V4/lists/PROCX" "$DA1" -d '{"items":["ZZZ"]}' >/dev/null
chk "მონახაზი შემთხვევაზე (drg_admin): პროცედურა აღარ ითვლება → T2" "$(api GET "/drg/stays/$E1?scheme_id=$SCH&version_id=$V4" "$DA1" | jq -r '.schemes[0]|"\(.result.code):\(.version.status)"')" "T2:draft"
chk "მონახაზი შემთხვევაზე — კოდირება → 403" "$(code GET "/drg/stays/$E1?scheme_id=$SCH&version_id=$V4" "$CD")" "403"
api DELETE "/drg/versions/$V4" "$DA1" >/dev/null
SDID=$(echo "$H" | jq -r '.[0].id')
chk "აუდიტი: DRG_CONFIRM (stay_drg), DRG_VERSION_ACTIVATE (drg_versions)" "$(api GET "/audit-logs?entity_name=stay_drg&entity_id=$SDID&limit=5" "$ADM" | jq -r '[.[].action]|index("DRG_CONFIRM")!=null'):$(api GET "/audit-logs?entity_name=drg_versions&entity_id=$V1&limit=20" "$ADM" | jq -r '[.[].action]|index("DRG_VERSION_ACTIVATE")!=null')" "true:true"

step "10. აღდგენა"
for v in "$V1"; do api POST "/drg/versions/$v/retire" "$DA1" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null; done
api PATCH "/drg/schemes/$SCH" "$DA1" -d '{"is_active":false}' >/dev/null
api PATCH "/billing/payers/$PY" "$BL" -d '{"is_active":false}' >/dev/null
api DELETE "/billing/bed-tariffs/$BT" "$ADM" >/dev/null
for t in "$T_BED" "$T_PROC"; do api PATCH "/tariffs/$t" "$ADM" -d '{"is_active":false}' >/dev/null; done
api PUT /modules/drg "$ADM" -d "{\"enabled\":$ORIG_EN,\"settings\":$ORIG,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$ORIG_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "სქემა გაითიშა, ვერსია გაუქმდა, პარამეტრები აღდგა" "$(api GET /drg/schemes "$ADM" | jq -r --arg s "$SCH" '.[]|select(.id==$s)|"\(.is_active):\(.current_version)"'):$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="drg")|.settings' | jq -r '.recheck_on_finalize')" "false:null:$(echo "$ORIG" | jq -r .recheck_on_finalize)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
