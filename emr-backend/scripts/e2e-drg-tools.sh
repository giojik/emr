#!/usr/bin/env bash
# =====================================================================
# e2e-drg-tools.sh — DRG ბლოკი, ეტაპი 0059: სიმულაცია, კონფიგურაციის პაკეტი, უარის მიზეზი → შემოწმების წესი
#   0. მომზადება (DRG ვერსია V1, 2 ფინალიზებული შემთხვევა)   1. სიმულაცია (მონახაზი V2: ფაქტობრივთან / ვერსიასთან, განაკვეთი, ფილტრები)
#   2. კონფიგურაციის პაკეტი (ექსპორტი, გეგმა, შეცდომა, ჩაწერა, განმეორება)   3. მიზეზი → წესი (ეფექტიანობა)   4. აღდგენა
# გამოყენება:  bash scripts/e2e-drg-tools.sh [API_URL]
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
command -v python3 >/dev/null || die "python3 არ არის დაყენებული (ფაილის შიგთავსის შემოწმება)"
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
login() { curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$1" --arg p "$2" '{username:$u,password:$p}')" | jq -r '.accessToken // empty'; }
ADM=$(login "$ADMIN_EMAIL" "$ADMIN_PW"); [ -n "$ADM" ] || die "admin-ით შესვლა ვერ მოხერხდა ($B)"
api()  { local m=$1 p=$2 t=$3; shift 3; curl -s -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
code() { local m=$1 p=$2 t=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$B$p" -H "authorization: Bearer $t" -H "$J" "$@"; }
upload() { local p=$1 t=$2 f=$3; curl -s -X POST "$B$p" -H "authorization: Bearer $t" -F "file=@$f"; }
S=$(date +%s | tail -c 7); TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
uid() { cat "$TMP/u$1" 2>/dev/null; }
TODAY=$(TZ=Asia/Tbilisi date +%F); PAST=$(date -d "$TODAY -30 days" +%F); YM=${TODAY:0:7}

step "0. მომზადება"
DCODE="E2ETL$S"; DNAME="ტესტ-E2E ინსტრუმენტები $S"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"$DNAME\",\"code\":\"$DCODE\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] || die "განყოფილება ვერ შეიქმნა"
T_BED=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2ETLBED$S\",\"title\":\"ტესტ-E2E ინსტრუმენტები საწოლდღე\",\"base_price\":300}" | jq -r '.id // empty')
BT=$(api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
[ -n "$T_BED" ] && [ -n "$BT" ] || die "ტარიფი ვერ დაყენდა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty'); [ -n "$id" ] && echo "e2e_$1_$S"; }
R_CD=$(mkrole tcd "DRG კოდირება" '["drg"]'); R_DA=$(mkrole tad "DRG კონფიგურაცია" '["drg_admin"]'); R_AC=$(mkrole tac "ბუღალტერი" '["accountant"]')
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.tl.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"TL-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.tl.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
CD=$(mkuser "[\"$R_CD\"]" 71); DA1=$(mkuser "[\"$R_DA\"]" 72); BL=$(mkuser '["billing"]' 73); RC=$(mkuser '["receptionist"]' 74); AC=$(mkuser "[\"$R_AC\"]" 75)
DR=$(mkuser '["doctor"]' 76 ",\"department_id\":\"$DA\""); NA=$(mkuser '["nurse"]' 77 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 78 ",\"department_id\":\"$DA\"")
for t in CD DA1 BL RC AC DR NA N2; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
PN1="79$(printf '%09d' "$S")"; PN2="80$(printf '%09d' "$S")"
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"$PN1\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"TL-1\",\"birth_date\":\"1960-02-02\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
P2=$(api POST /patients "$ADM" -d "{\"personal_number\":\"$PN2\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"TL-2\",\"birth_date\":\"1985-07-15\",\"gender\":\"female\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
MODS=$(api GET /modules "$ADM")
O_DRG=$(echo "$MODS" | jq -c '.[]|select(.code=="drg")|{enabled,settings}'); O_IPD=$(echo "$MODS" | jq -c '.[]|select(.code=="inpatient")|.settings')
O_SCR=$(echo "$MODS" | jq -c '.[]|select(.code=="scrubber")|{enabled,settings}')
api PUT /modules/drg "$ADM" -d '{"enabled":true,"settings":{"confirm_required":true,"recheck_on_finalize":"block","manual_payer_drg":"allowed","version_approval":"off"},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null
scr() { api PUT /modules/scrubber "$ADM" -d "{\"enabled\":$1,\"settings\":{\"finalize_check\":\"off\",\"claim_check\":\"$2\"},\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
scr true off
SCH=$(api POST /drg/schemes "$DA1" -d "{\"code\":\"E2ET$S\",\"name\":\"ტესტ-E2E ინსტრუმენტები $S\"}" | jq -r '.id // empty')
PY=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2ETP$S\",\"name\":\"ტესტ-E2E სიმულაცია $S\",\"kind\":\"state\",\"default_mode\":\"drg\",\"default_coverage_pct\":100,\"drg_base_rate\":1000}" | jq -r '.id // empty')
[ -n "$SCH" ] && [ -n "$PY" ] || die "სქემა / გადამხდელი ვერ შეიქმნა"
api PUT "/drg/payers/$PY/scheme" "$DA1" -d "{\"drg_scheme_id\":\"$SCH\"}" >/dev/null
PKG=$(jq -nc '{format:"emr-drg-version",format_version:1,label:"ტესტ-E2E ინსტრუმენტები",settings:{rounding:"total"},
  groups:[{code:"P1",title:"ტესტ-E2E პნევმონია",weight:1,alos:5,los_low:2,los_high:10,kind:"medical"},{code:"C2",title:"ტესტ-E2E გულის იშემია",weight:2.5,alos:7,los_low:3,los_high:14,kind:"surgical",mdc:"05"}],
  lists:[{code:"PNEU",title:"პნევმონია",kind:"dx",items:["J12-J18"]},{code:"IHD",title:"იშემია",kind:"dx",items:["I20-I25"]}], cc:[],
  rules:[{seq:10,drg_code:"P1",conditions_text:"pdx in @PNEU"},{seq:20,drg_code:"C2",conditions_text:"pdx in @IHD"}], components:[]}')
V1=$(api POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$PKG" --arg f "$PAST" '{package:$p,valid_from:$f}')" | jq -r '.id // empty')
[ -n "$V1" ] && [ "$(api POST "/drg/versions/$V1/activate" "$DA1" -d '{}' | jq -r .ok)" = "true" ] || die "DRG ვერსია ვერ გააქტიურდა"
CASE() {  # $1 პაციენტი, $2 ICD → encounter_id (ფინალიზებული)
  local E; E=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 76)\",\"source\":\"emergency\",\"icd10_code\":\"$2\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
  [ -n "$E" ] || return
  api POST "/encounters/$E/diagnoses" "$DR" -d "{\"icd10_code\":\"$2\",\"diagnosis_type\":\"primary\"}" >/dev/null
  api POST "/encounters/$E/diagnoses" "$DR" -d '{"icd10_code":"E11.9","diagnosis_type":"secondary"}' >/dev/null
  api POST "/inpatient/stays/$E/payers" "$RC" -d "{\"payer_id\":\"$PY\",\"guarantee_no\":\"G-$3-$S\"}" >/dev/null
  api POST "/inpatient/stays/$E/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 77)\",\"$(uid 78)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
  api POST "/drg/stays/$E/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" >/dev/null
  [ "$(api POST "/inpatient/stays/$E/billing/finalize" "$BL" | jq -r .finalized)" = "true" ] && echo "$E"
}
E1=$(CASE "$P1" J18.9 A); E2=$(CASE "$P2" I21.9 B)
[ -n "$E1" ] && [ -n "$E2" ] || die "შემთხვევები ვერ ფინალიზდა"
ok "განყოფილება ($DCODE), 8 მომხმარებელი, 2 პაციენტი, DRG V1 (P1 = 1, C2 = 2.5), გადამხდელი (განაკვეთი 1000), 2 ფინალიზებული შემთხვევა"

step "1. სიმულაცია"
# V2 (მონახაზი): P1 წონა 1.2; ახალი ჯგუფი C3 (3.0) — I21 გადადის C3-ში
PKG2=$(echo "$PKG" | jq -c '.label="ტესტ-E2E V2" | .groups[0].weight=1.2 | .groups += [{code:"C3",title:"ტესტ-E2E მწვავე ინფარქტი",weight:3,alos:8,los_low:3,los_high:15,kind:"surgical",mdc:"05"}]
  | .lists += [{code:"AMI",title:"ინფარქტი",kind:"dx",items:["I21-I22"]}] | .rules = [.rules[0], {seq:15,drg_code:"C3",conditions_text:"pdx in @AMI"}, .rules[1]]')
V2=$(api POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$PKG2" '{package:$p,valid_from:"2099-01-01"}')" | jq -r '.id // empty')
[ -n "$V2" ] || die "V2 ვერ შეიქმნა"
sim() { api POST /drg/simulate "$1" -d "$2"; }
Q="\"scheme_id\":\"$SCH\",\"from\":\"$TODAY\",\"to\":\"$TODAY\",\"payer_id\":\"$PY\""
R=$(sim "$CD" "{$Q,\"version_id\":\"$V2\"}")
chk "ფაქტობრივი → V2: 2 შემთხვევა, ჯგუფი შეიცვალა 1-ზე (C2 → C3)" "$(echo "$R" | jq -r '.totals|"\(.cases):\(.grouped):\(.changed_group)"'):$(echo "$R" | jq -r '.transitions|"\(length):\(.[0].from)→\(.[0].to)"')" "2:2:1:1:C2→C3"
chk "CMI 1.75 → 2.1; თანხა 3500 → 4200 (+700, +20%)" "$(echo "$R" | jq -r '.totals|"\(.cmi_base):\(.cmi_sim):\(.amount_base):\(.amount_sim):\(.diff):\(.diff_pct)"')" "1.75:2.1:3500:4200:700:20"
chk "განყოფილებით: 1 ხაზი, +700; საწყისი — ფაქტობრივი" "$(echo "$R" | jq -r '"\(.by_department|length):\(.by_department[0].diff):\(.base.kind):\(.version.status)"')" "1:700:actual:draft"
chk "ხაზი: C2 2500 → C3 3000 (+500)" "$(echo "$R" | jq -r '[.rows[]|select(.base.code=="C2")][0]|"\(.sim.code):\(.base.amount):\(.sim.amount):\(.diff)"')" "C3:2500:3000:500"
R=$(sim "$AC" "{$Q,\"version_id\":\"$V2\",\"base_version_id\":\"$V1\"}")
chk "V1 → V2 (ვერსიების შედარება): იგივე სხვაობა; ბუღალტერი — 200" "$(echo "$R" | jq -r '"\(.base.kind):\(.totals.amount_base):\(.totals.amount_sim):\(.totals.changed_group)"')" "version:3500:4200:1"
chk "განაკვეთი 2000: 8400" "$(sim "$CD" "{$Q,\"version_id\":\"$V2\",\"base_rate\":2000}" | jq -r '.totals.amount_sim')" "8400"
chk "V1 → V1: ცვლილება არ არის (0)" "$(sim "$CD" "{$Q,\"version_id\":\"$V1\",\"base_version_id\":\"$V1\",\"only_changed\":true}" | jq -r '"\(.totals.diff):\(.totals.changed_group):\(.rows|length)"')" "0:0:0"
OS=$(api POST /drg/schemes "$DA1" -d "{\"code\":\"E2ETO$S\",\"name\":\"ტესტ-E2E სხვა სქემა\"}" | jq -r '.id // empty')
chk "სხვა სქემის ვერსია → 400; from > to → 400" "$(code POST /drg/simulate "$CD" -d "{\"scheme_id\":\"$OS\",\"version_id\":\"$V2\",\"from\":\"$TODAY\",\"to\":\"$TODAY\"}"):$(code POST /drg/simulate "$CD" -d "{\"scheme_id\":\"$SCH\",\"version_id\":\"$V2\",\"from\":\"$TODAY\",\"to\":\"2000-01-01\"}")" "400:400"
chk "ექიმი / ექთანი → 403" "$(code POST /drg/simulate "$DR" -d "{$Q,\"version_id\":\"$V2\"}"):$(code POST /drg/simulate "$NA" -d "{$Q,\"version_id\":\"$V2\"}")" "403:403"
chk "ბაზაში არაფერი შეიცვალა: V2 მონახაზი, შემთხვევის DRG — P1 / C2" "$(api GET "/drg/versions/$V2" "$CD" | jq -r .status):$(api GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&payer_id=$PY" "$CD" | jq -r '[.groups[].key]|sort|join(",")')" "draft:C2,P1"

step "2. კონფიგურაციის პაკეტი"
chk "მეტა: 6 ნაწილი; ექსპორტი: ბილინგი / ექთანი → 403" "$(api GET /config-package/meta "$AC" | jq -r '.parts|length'):$(code GET /config-package "$BL"):$(code GET /config-package "$NA")" "6:403:403"
curl -s "$B/config-package" -H "authorization: Bearer $AC" -o "$TMP/cfg.json"
chk "ექსპორტი (ბუღალტერი): ფორმატი, 6 ნაწილი, მოდულები drg + scrubber" "$(jq -r '"\(.format):\(.parts|keys|length):\([.parts.modules[].code]|join(","))"' "$TMP/cfg.json")" "emr-config:6:drg,scrubber"
chk "ექსპორტი: ჩვენი სქემის მოქმედი ვერსია (V1), წესები 19+, მიზეზები, გადამხდელი" "$(jq -r --arg s "E2ET$S" --arg p "E2ETP$S" '"\([.parts.drg.versions[]|select(.scheme_code==$s)][0].package.label):\([.parts.scrub_rules[]|select(.builtin)]|length >= 19):\([.parts.denial_reasons[]|select(.code=="GUARANTEE")][0].scrub_rules|length):\([.parts.payers[]|select(.code==$p)][0].drg_scheme_code == $s)"' "$TMP/cfg.json")" "ტესტ-E2E ინსტრუმენტები:true:3:true"
chk "ექსპორტი: drg_version_ids=V2 → მხოლოდ V2" "$(curl -s "$B/config-package?parts=drg&drg_version_ids=$V2" -H "authorization: Bearer $DA1" | jq -r '"\(.parts|keys|join(",")):\(.parts.drg.versions|length):\(.parts.drg.versions[0].package.label)"')" "drg:1:ტესტ-E2E V2"
chk "გეგმა: ბუღალტერი → 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/config-package/preview" -H "authorization: Bearer $AC" -F "file=@$TMP/cfg.json")" "403"
P=$(upload /config-package/preview "$ADM" "$TMP/cfg.json")
chk "იგივე პაკეტი → ყველაფერი უცვლელი (შექმნა / შეცვლა / შეცდომა 0)" "$(echo "$P" | jq -r '.totals|"\(.create):\(.update):\(.error):\(.unchanged > 30)"')" "0:0:0:true"
# შეცვლილი პაკეტი
RN="E2ET$S"; XR="X_E2ET$S"; TC="E2E_TT$S"
LOS0=$(api GET /scrub/rules "$ADM" | jq -c '.[]|select(.code=="LOS_LONG")|{severity,params,is_active}')
jq --arg rn "$RN" --arg xr "$XR" --arg tc "$TC" --arg s "E2ET$S" --arg p "E2ETP$S" '
  .parts.modules |= map(if .code=="scrubber" then .settings.claim_check="warn" else . end)
  | .parts.denial_reasons |= (map(if .code=="LATE" then .title="ტესტ-E2E ვადაგადაცილება" else . end) + [{code:$rn,title:"ტესტ-E2E პაკეტიდან",category:"admin",external_codes:["PK-1"],default_action:"writeoff",is_active:true,sort_order:7,scrub_rules:[$xr,"LOS_LONG"]}])
  | .parts.scrub_rules |= (map(if .code=="LOS_LONG" then .severity="error" | .params={days:45} else . end) + [{code:$xr,builtin:false,title:"ტესტ-E2E პაკეტის წესი",message:null,severity:"warn",is_active:true,payer_kinds:[],payer_codes:[$p],params:{},conditions_text:"los > 60",allow_override:true}])
  | .parts.claim_templates += [{code:$tc,name:"ტესტ-E2E პაკეტის შაბლონი",kind:"export",format:"csv",config:{columns:[{header:"PN",field:"personal_number"}]},notes:null,is_active:true}]
  | .parts.payers |= map(if .code==$p then .export_template_code=$tc else . end)
  | .parts.drg.versions |= map(if .scheme_code==$s then .package.label="ტესტ-E2E სხვა სახელი" else . end)
  | .parts.drg.versions += [(.parts.drg.versions[]|select(.scheme_code==$s)|.package.label="ტესტ-E2E პაკეტის ვერსია"|.package.valid_from="2098-01-01"|.package.groups[1].weight=2.7)]
' "$TMP/cfg.json" > "$TMP/cfg2.json"
P=$(upload /config-package/preview "$ADM" "$TMP/cfg2.json")
act() { echo "$P" | jq -r --arg p "$1" --arg k "$2" '[.lines[]|select(.part==$p and (.key|startswith($k)))][0].action // "-"'; }
chk "გეგმა: მოდული (update), LOS_LONG (update), საკუთარი წესი (create), შაბლონი (create)" "$(act modules scrubber):$(act scrub_rules LOS_LONG):$(act scrub_rules "$XR"):$(act claim_templates "$TC")" "update:update:create:create"
chk "გეგმა: მიზეზი LATE (update) / ახალი (create); გადამხდელი (update)" "$(act denial_reasons LATE):$(act denial_reasons "$RN"):$(act payers "E2ETP$S")" "update:create:update"
chk "გეგმა: DRG — იგივე შიგთავსი სხვა სახელით → უცვლელი; შეცვლილი წონა → ახალი მონახაზი" "$(act drg "E2ET$S: ტესტ-E2E სხვა"):$(act drg "E2ET$S: ტესტ-E2E პაკეტის")" "unchanged:create"
chk "გეგმა: არაფერი ჩაწერილა" "$(api GET /scrub/rules "$ADM" | jq -r '.[]|select(.code=="LOS_LONG")|.severity'):$(api GET /scrub/rules "$ADM" | jq -r --arg x "$XR" '[.[]|select(.code==$x)]|length')" "$(echo "$LOS0" | jq -r .severity):0"
jq --arg xr "$XR" '.parts.scrub_rules |= map(if .code=="DX_SEX" then .params={x:1} else . end) | .parts.denial_reasons += [{code:"E2EBAD",title:"ტესტ",category:"admin",external_codes:[],default_action:null,is_active:true,sort_order:1,scrub_rules:["NOPE"]}]' "$TMP/cfg2.json" > "$TMP/bad.json"
P=$(upload /config-package/preview "$ADM" "$TMP/bad.json")
chk "შეცდომები: უცნობი პარამეტრი, არარსებული წესი (2)" "$(echo "$P" | jq -r '.totals.error'):$(act scrub_rules DX_SEX):$(act denial_reasons E2EBAD)" "2:error:error"
chk "შეცდომიანის ჩაწერა → 400 CONFIG_PACKAGE_INVALID; არაფერი შეიცვალა" "$(upload "/config-package/import" "$ADM" "$TMP/bad.json" | jq -r .code):$(api GET /scrub/rules "$ADM" | jq -r --arg x "$XR" '[.[]|select(.code==$x)]|length')" "CONFIG_PACKAGE_INVALID:0"
NV0=$(api GET "/drg/schemes/$SCH/versions" "$DA1" | jq -r length)
A=$(upload "/config-package/import" "$ADM" "$TMP/cfg2.json")
chk "ჩაწერა: applied, DRG — 1 ახალი მონახაზი" "$(echo "$A" | jq -r '"\(.applied):\(.drg_versions|length)"'):$(api GET "/drg/schemes/$SCH/versions" "$DA1" | jq -r --argjson n "$NV0" 'length - $n'):$(api GET "/drg/schemes/$SCH/versions" "$DA1" | jq -r '[.[]|select(.label=="ტესტ-E2E პაკეტის ვერსია")][0].status')" "true:1:1:draft"
RL=$(api GET /scrub/rules "$ADM")
chk "წესები: LOS_LONG — error, 45 დღე; საკუთარი — გადამხდელზე მიბმული" "$(echo "$RL" | jq -r '.[]|select(.code=="LOS_LONG")|"\(.severity):\(.params.days)"'):$(echo "$RL" | jq -r --arg x "$XR" --arg p "$PY" '.[]|select(.code==$x)|"\(.conditions_text):\(.payer_ids==[$p])"')" "error:45:los > 60:true"
chk "მიზეზები: LATE — ახალი სახელი; ახალი — წესებით; მოდული: claim_check = warn" "$(api GET /denial-reasons "$AC" | jq -r --arg r "$RN" '"\([.[]|select(.code=="LATE")][0].title):\([.[]|select(.code==$r)][0].scrub_rules|join(","))"'):$(api GET /modules "$ADM" | jq -r '.[]|select(.code=="scrubber")|.settings.claim_check')" "ტესტ-E2E ვადაგადაცილება:$XR,LOS_LONG:warn"
chk "გადამხდელი: ექსპორტის შაბლონი = პაკეტის შაბლონი" "$(api GET /claim-templates/payers "$AC" | jq -r --arg p "$PY" '.[]|select(.id==$p)|.export_template_name')" "ტესტ-E2E პაკეტის შაბლონი"
P=$(upload /config-package/preview "$ADM" "$TMP/cfg2.json")
chk "იგივე პაკეტი ხელახლა → შექმნა / შეცვლა 0 (idempotent)" "$(echo "$P" | jq -r '.totals|"\(.create):\(.update):\(.error)"')" "0:0:0"
chk "ნაწილობრივი: parts=denial_reasons → მხოლოდ მიზეზები" "$(curl -s -X POST "$B/config-package/preview?parts=denial_reasons" -H "authorization: Bearer $ADM" -F "file=@$TMP/cfg2.json" | jq -r '[.lines[].part]|unique|join(",")')" "denial_reasons"
chk "ცუდი ნაწილი → 400; არა-JSON ფაილი → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/config-package/preview?parts=x" -H "authorization: Bearer $ADM" -F "file=@$TMP/cfg2.json"):$(printf 'abc' > "$TMP/x.json"; curl -s -o /dev/null -w '%{http_code}' -X POST "$B/config-package/preview" -H "authorization: Bearer $ADM" -F "file=@$TMP/x.json")" "400:400"
chk "აუდიტი: CONFIG_PACKAGE_IMPORT" "$(api GET "/audit-logs?action=CONFIG_PACKAGE_IMPORT&limit=5" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|select(.action=="CONFIG_PACKAGE_IMPORT")]|length > 0')" "true"
# აღდგენა (ნაწილი 2)
api PATCH /scrub/rules/LOS_LONG "$DA1" -d "$(echo "$LOS0" | jq -c '{severity,is_active,params}')" >/dev/null
api DELETE "/scrub/rules/$XR" "$DA1" >/dev/null
api PATCH /denial-reasons/LATE "$AC" -d '{"title":"ვადაგადაცილებული წარდგენა"}' >/dev/null
api PATCH "/denial-reasons/$RN" "$AC" -d '{"is_active":false,"scrub_rules":[]}' >/dev/null
scr true off

step "3. უარის მიზეზი → შემოწმების წესი"
chk "მიზეზი: არარსებული წესი → 400" "$(code PATCH /denial-reasons/OTHER "$AC" -d '{"scrub_rules":["NOPE"]}')" "400"
R2="E2ER$S"
api POST /denial-reasons "$AC" -d "{\"code\":\"$R2\",\"title\":\"ტესტ-E2E საგარანტიოს №\",\"category\":\"admin\",\"scrub_rules\":[\"guarantee_missing\"]}" >/dev/null
chk "მიზეზი წესით (კოდი — დიდი ასოებით)" "$(api GET /denial-reasons "$AC" | jq -r --arg r "$R2" '.[]|select(.code==$r)|.scrub_rules|join(",")')" "GUARANTEE_MISSING"
CID=$(api POST /finance/claims "$AC" -d "{\"payer_id\":\"$PY\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\"}" | jq -r '.id // empty')
api POST "/finance/claims/$CID/send" "$AC" >/dev/null
CL=$(api GET "/finance/claims/$CID" "$AC")
I1=$(echo "$CL" | jq -r --arg a "$PN1" '.items[]|select(.personal_number==$a)|.id'); I2=$(echo "$CL" | jq -r --arg a "$PN2" '.items[]|select(.personal_number==$a)|.id')
api PUT "/finance/claim-items/$I1/response" "$BL" -d "{\"status\":\"rejected\",\"reason\":\"$R2\"}" >/dev/null
api PUT "/finance/claim-items/$I2/response" "$BL" -d '{"status":"rejected","reason":"GUARANTEE"}' >/dev/null
eff() { api GET "/finance/reports/denials?from=$TODAY&to=$TODAY&payer_id=$PY" "$AC" | jq -r --arg r "$1" '.rule_effect[]|select(.reason==$r)|"\(.cases):\(.caught):\(.overridden):\(.inactive):\(.missed):\(.unlinked)"'; }
chk "საგარანტიოს № მითითებულია → წესი ვერ იჭერს (missed)" "$(eff "$R2")" "1:0:0:0:1:0"
chk "GUARANTEE: ფაილი არ არის → GUARANTEE_FILE იჭერს (caught)" "$(eff GUARANTEE)" "1:1:0:0:0:0"
api PATCH /scrub/rules/GUARANTEE_FILE "$DA1" -d '{"is_active":false}' >/dev/null
chk "GUARANTEE_FILE გამორთულია → დაიჭერდა (inactive)" "$(eff GUARANTEE)" "1:0:0:1:0:0"
api PATCH /scrub/rules/GUARANTEE_FILE "$DA1" -d '{"is_active":true}' >/dev/null
api PUT "/finance/claim-items/$I1/response" "$BL" -d '{"status":"rejected","reason":"OTHER"}' >/dev/null
chk "OTHER — წესი არ აქვს (unlinked); შემთხვევის სტატუსი სიაში" "$(eff OTHER):$(api GET "/finance/reports/denials?from=$TODAY&to=$TODAY&payer_id=$PY" "$AC" | jq -r --arg i "$I2" '.items[]|select(.item_id==$i)|"\(.rule_status):\(.rules_fired|join(","))"')" "1:0:0:0:0:1:caught:GUARANTEE_FILE"

step "4. აღდგენა"
api PATCH "/denial-reasons/$R2" "$AC" -d '{"is_active":false}' >/dev/null
api PUT "/claim-templates/payers/$PY" "$AC" -d '{"export_template_id":null}' >/dev/null
TID=$(api GET '/claim-templates?kind=export' "$AC" | jq -r --arg c "$TC" '.[]|select(.code==$c)|.id'); [ -n "$TID" ] && api PATCH "/claim-templates/$TID" "$AC" -d '{"is_active":false}' >/dev/null
for v in $(api GET "/drg/schemes/$SCH/versions" "$DA1" | jq -r '.[]|select(.status=="draft")|.id'); do api DELETE "/drg/versions/$v" "$DA1" >/dev/null; done
api POST "/drg/versions/$V1/retire" "$DA1" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null
api PATCH "/drg/schemes/$SCH" "$DA1" -d '{"is_active":false}' >/dev/null; api PATCH "/drg/schemes/$OS" "$DA1" -d '{"is_active":false}' >/dev/null
api PATCH "/billing/payers/$PY" "$BL" -d '{"is_active":false}' >/dev/null
[ -n "$BT" ] && api DELETE "/billing/bed-tariffs/$BT" "$ADM" >/dev/null
api PATCH "/tariffs/$T_BED" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/drg "$ADM" -d "{\"enabled\":$(echo "$O_DRG" | jq -c .enabled),\"settings\":$(echo "$O_DRG" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$O_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/scrubber "$ADM" -d "{\"enabled\":$(echo "$O_SCR" | jq -c .enabled),\"settings\":$(echo "$O_SCR" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "წესი LOS_LONG, მოდულები აღდგა" "$(api GET /scrub/rules "$ADM" | jq -c '.[]|select(.code=="LOS_LONG")|{severity,params,is_active}' | jq -S -c .):$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="scrubber")|{enabled,settings}' | jq -S -c .)" "$(echo "$LOS0" | jq -S -c .):$(echo "$O_SCR" | jq -S -c .)"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
