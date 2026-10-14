#!/usr/bin/env bash
# =====================================================================
# e2e-claim-export.sh — DRG ბლოკი, ეტაპი 0058: გადამხდელის (SSA) ექსპორტი, პასუხები, უარის მიზეზები, CMI
#   0. მომზადება (DRG სქემა / ვერსია, გადამხდელი, 2 ფინალიზებული შემთხვევა)
#   1. შაბლონები (ექსპორტი: xlsx / csv / xml; პასუხი; ვალიდაცია, ვერსია, ასლი, გადამხდელის ნაგულისხმევი)
#   2. უარის მიზეზები   3. ქლეიმი → გადახედვა → ექსპორტი (ფაილი, sha256, შემოწმება warn / block)
#   4. პასუხი: ხელით, იმპორტი (csv / xlsx, dry-run → ჩაწერა)   5. უარის გადაწყვეტა   6. უარის ანგარიში   7. CMI   8. აღდგენა
# გამოყენება:  bash scripts/e2e-claim-export.sh [API_URL]
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
DCODE="E2ECX$S"; DNAME="ტესტ-E2E ექსპორტი $S"
DA=$(api POST /departments "$ADM" -d "{\"name\":\"$DNAME\",\"code\":\"$DCODE\",\"type\":\"inpatient\"}" | jq -r '.id // empty')
[ -n "$DA" ] || die "განყოფილება ვერ შეიქმნა"
T_BED=$(api POST /tariffs "$ADM" -d "{\"code\":\"E2ECXBED$S\",\"title\":\"ტესტ-E2E ექსპორტი საწოლდღე\",\"base_price\":300}" | jq -r '.id // empty')
BT=$(api PUT /billing/bed-tariffs "$ADM" -d "{\"bed_type_code\":\"standard\",\"department_id\":\"$DA\",\"tariff_id\":\"$T_BED\"}" | jq -r '.id // empty')
[ -n "$T_BED" ] && [ -n "$BT" ] || die "ტარიფი ვერ დაყენდა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty'); [ -n "$id" ] && echo "e2e_$1_$S"; }
R_CD=$(mkrole xcd "DRG კოდირება" '["drg"]'); R_DA=$(mkrole xad "DRG კონფიგურაცია" '["drg_admin"]'); R_AC=$(mkrole xac "ბუღალტერი" '["accountant"]')
mkuser() {
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.cx.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"CX-$2\",\"personal_number\":\"$2$(printf '%09d' "$S")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" > "$TMP/u$2"
  local t; t=$(login "e2e.cx.$2.$S@test.local" "$tmp")
  api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty'
}
CD=$(mkuser "[\"$R_CD\"]" 61); DA1=$(mkuser "[\"$R_DA\"]" 62); BL=$(mkuser '["billing"]' 63); RC=$(mkuser '["receptionist"]' 64); AC=$(mkuser "[\"$R_AC\"]" 65)
DR=$(mkuser '["doctor"]' 66 ",\"department_id\":\"$DA\""); NA=$(mkuser '["nurse"]' 67 ",\"department_id\":\"$DA\""); N2=$(mkuser '["nurse"]' 68 ",\"department_id\":\"$DA\"")
for t in CD DA1 BL RC AC DR NA N2; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
PN1="69$(printf '%09d' "$S")"; PN2="70$(printf '%09d' "$S")"
P1=$(api POST /patients "$ADM" -d "{\"personal_number\":\"$PN1\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"CX-1\",\"birth_date\":\"1960-02-02\",\"gender\":\"male\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty')
P2=$(api POST /patients "$ADM" -d "{\"personal_number\":\"$PN2\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"CX-2\",\"birth_date\":\"1985-07-15\",\"gender\":\"female\",\"phone_number\":\"598$S\"}" | jq -r '.id // empty')
[ -n "$P1" ] && [ -n "$P2" ] || die "პაციენტები ვერ შეიქმნა"
MODS=$(api GET /modules "$ADM")
O_DRG=$(echo "$MODS" | jq -c '.[]|select(.code=="drg")|{enabled,settings}'); O_IPD=$(echo "$MODS" | jq -c '.[]|select(.code=="inpatient")|.settings')
O_SCR=$(echo "$MODS" | jq -c '.[]|select(.code=="scrubber")|{enabled,settings}')
api PUT /modules/drg "$ADM" -d '{"enabled":true,"settings":{"confirm_required":true,"recheck_on_finalize":"block","manual_payer_drg":"allowed","version_approval":"off"},"reason":"ტესტ-E2E"}' >/dev/null
api PUT /modules/inpatient "$ADM" -d '{"settings":{"discharge_balance":"warn"},"reason":"ტესტ-E2E"}' >/dev/null
scr() { api PUT /modules/scrubber "$ADM" -d "{\"enabled\":$1,\"settings\":{\"finalize_check\":\"off\",\"claim_check\":\"$2\"},\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
scr true off
SCH=$(api POST /drg/schemes "$DA1" -d "{\"code\":\"E2EX$S\",\"name\":\"ტესტ-E2E ექსპორტი $S\"}" | jq -r '.id // empty')
PY=$(api POST /billing/payers "$BL" -d "{\"code\":\"E2EXP$S\",\"name\":\"ტესტ-E2E საყოველთაო $S\",\"kind\":\"state\",\"default_mode\":\"drg\",\"default_coverage_pct\":100,\"drg_base_rate\":1000}" | jq -r '.id // empty')
[ -n "$SCH" ] && [ -n "$PY" ] || die "სქემა / გადამხდელი ვერ შეიქმნა"
api PUT "/drg/payers/$PY/scheme" "$DA1" -d "{\"drg_scheme_id\":\"$SCH\"}" >/dev/null
PKG=$(jq -nc '{format:"emr-drg-version",format_version:1,label:"ტესტ-E2E ექსპორტი",settings:{rounding:"total"},
  groups:[{code:"P1",title:"ტესტ-E2E პნევმონია",weight:1,alos:5,los_low:2,los_high:10,kind:"medical"},{code:"C2",title:"ტესტ-E2E გულის იშემია",weight:2.5,alos:7,los_low:3,los_high:14,kind:"surgical",mdc:"05"}],
  lists:[{code:"PNEU",title:"პნევმონია",kind:"dx",items:["J12-J18"]},{code:"IHD",title:"იშემია",kind:"dx",items:["I20-I25"]}], cc:[],
  rules:[{seq:10,drg_code:"P1",conditions_text:"pdx in @PNEU"},{seq:20,drg_code:"C2",conditions_text:"pdx in @IHD"}], components:[]}')
V1=$(api POST "/drg/schemes/$SCH/versions/import" "$DA1" -d "$(jq -nc --argjson p "$PKG" --arg f "$PAST" '{package:$p,valid_from:$f}')" | jq -r '.id // empty')
[ -n "$V1" ] && [ "$(api POST "/drg/versions/$V1/activate" "$DA1" -d '{}' | jq -r .ok)" = "true" ] || die "DRG ვერსია ვერ გააქტიურდა"
CASE() {  # $1 პაციენტი, $2 ICD → encounter_id (ფინალიზებული)
  local E; E=$(api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$DA\",\"attending_doctor_id\":\"$(uid 66)\",\"source\":\"emergency\",\"icd10_code\":\"$2\",\"chief_complaint\":\"ტესტ-E2E\"}" | jq -r '.encounter_id // empty')
  [ -n "$E" ] || return
  api POST "/encounters/$E/diagnoses" "$DR" -d "{\"icd10_code\":\"$2\",\"diagnosis_type\":\"primary\"}" >/dev/null
  api POST "/encounters/$E/diagnoses" "$DR" -d '{"icd10_code":"E11.9","diagnosis_type":"secondary"}' >/dev/null
  api POST "/inpatient/stays/$E/payers" "$RC" -d "{\"payer_id\":\"$PY\",\"guarantee_no\":\"G-$3-$S\"}" >/dev/null
  api POST "/inpatient/stays/$E/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$(uid 67)\",\"$(uid 68)\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
  api POST "/drg/stays/$E/confirm" "$CD" -d "{\"scheme_id\":\"$SCH\"}" >/dev/null
  [ "$(api POST "/inpatient/stays/$E/billing/finalize" "$BL" | jq -r .finalized)" = "true" ] && echo "$E"
}
E1=$(CASE "$P1" J18.9 A); E2=$(CASE "$P2" I21.9 B)
[ -n "$E1" ] && [ -n "$E2" ] || die "შემთხვევები ვერ ფინალიზდა"
ok "განყოფილება ($DCODE), 8 მომხმარებელი, 2 პაციენტი, DRG ვერსია (P1 = 1, C2 = 2.5), გადამხდელი, 2 ფინალიზებული შემთხვევა"

step "1. შაბლონები"
M=$(api GET /claim-templates/meta "$BL")
chk "მეტა: ველები (≥ 50), თარიღის ფორმატები, პასუხის სტატუსები" "$(echo "$M" | jq -r '"\(.fields|length >= 50):\(.date_formats|index("DD.MM.YYYY") != null):\(.resp_statuses|join(","))"')" "true:true:accepted,partial,rejected,pending"
chk "მაგალითი-შაბლონები (ექსპორტი + პასუხი)" "$(api GET '/claim-templates?kind=export' "$BL" | jq -r '[.[]|select(.code=="EXAMPLE_EXPORT")]|length'):$(api GET '/claim-templates?kind=response' "$BL" | jq -r '[.[]|select(.code=="EXAMPLE_RESPONSE")]|length')" "1:1"
chk "ბილინგი ხედავს (200), ვერ ქმნის (403); ექიმი ვერ ხედავს (403)" "$(code GET /claim-templates "$BL"):$(code POST /claim-templates "$BL" -d '{"code":"X_E","name":"xx","kind":"export","format":"csv","config":{}}'):$(code GET /claim-templates "$DR")" "200:403:403"
tpl() { api POST /claim-templates "$AC" -d "$1"; }
bad_cfg() { tpl "{\"code\":\"E2E_BAD$S\",\"name\":\"ტესტ\",\"kind\":\"export\",\"format\":\"${2:-xlsx}\",\"config\":$1}" | jq -r '.statusCode // "ok"'; }
chk "ვალიდაცია: უცნობი ველი / ფორმატი / ველი+მუდმივი / სვეტების გარეშე → 400" "$(bad_cfg '{"columns":[{"header":"x","field":"nope"}]}'):$(bad_cfg '{"columns":[{"header":"x","field":"birth_date","format":"DD.YY"}]}'):$(bad_cfg '{"columns":[{"header":"x","field":"adm_no","const":"1"}]}'):$(bad_cfg '{"columns":[]}')" "400:400:400:400"
chk "ვალიდაცია: ფაილის სახელში უცნობი {x}; XML ცუდი tag; CSV გამყოფი = ათწილადის" "$(bad_cfg '{"file_name":"{x}","columns":[{"header":"x","field":"adm_no"}]}'):$(bad_cfg '{"columns":[{"header":"x","field":"adm_no","tag":"1 a"}]}' xml):$(bad_cfg '{"csv_sep":",","decimal_sep":",","columns":[{"header":"x","field":"adm_no"}]}' csv)" "400:400:400"
chk "შეცდომების სია პასუხში" "$(tpl '{"code":"E2E_BAD","name":"ტესტ","kind":"export","format":"xlsx","config":{"columns":[{"header":"","field":"nope"},{"header":"y"}]}}' | jq -r '.errors|length >= 3')" "true"
CFG1=$(jq -nc '{kinds:["ipd","opd"],header_row:true,total_row:true,date_format:"DD.MM.YYYY",sheet_name:"რეესტრი",file_name:"{payer_code}_{claim_no}",
  columns:[{header:"№",field:"seq"},{header:"პირადი №",field:"personal_number",width:13},{header:"პაციენტი",field:"full_name"},{header:"სქესი",field:"sex",map:{M:"1",F:"2"}},
   {header:"დაბადება",field:"birth_date"},{header:"ისტორია",field:"adm_no"},{header:"DRG",field:"drg_code"},{header:"წონა",field:"drg_weight",format:"0.0000"},
   {header:"დიაგნოზი",field:"pdx_code"},{header:"თანმხლები",field:"sdx_codes",default:"-"},{header:"კლინიკა",const:"ტესტ-E2E კლინიკა"},{header:"კოდი",field:"department_code",pad:12},
   {header:"საგარანტიო",field:"guarantee_no"},{header:"თანხა",field:"claimed",format:"0.00"}]}')
T1=$(tpl "{\"code\":\"E2E_X$S\",\"name\":\"ტესტ-E2E xlsx $S\",\"kind\":\"export\",\"format\":\"xlsx\",\"config\":$CFG1}")
T1ID=$(echo "$T1" | jq -r '.id // empty')
chk "xlsx შაბლონი (14 სვეტი, revision 1)" "$(echo "$T1" | jq -r '"\(.config.columns|length):\(.revision):\(.config.decimal_sep)"')" "14:1:."
chk "იგივე კოდი → 409" "$(code POST /claim-templates "$AC" -d "{\"code\":\"E2E_X$S\",\"name\":\"ტესტ\",\"kind\":\"export\",\"format\":\"xlsx\",\"config\":$CFG1}")" "409"
CFG2=$(jq -nc '{kinds:["ipd"],header_row:true,date_format:"YYYYMMDD",decimal_sep:",",csv_sep:";",csv_bom:false,file_name:"ssa_{period_to}",
  columns:[{header:"PN",field:"personal_number"},{header:"ADM",field:"admit_date"},{header:"DIS",field:"discharge_date",format:"DD/MM/YYYY"},{header:"LOS",field:"los"},
   {header:"DRG",field:"drg_code"},{header:"AMT",field:"claimed"},{header:"SDX",field:"dx_all_codes"}],list_sep:"|"}')
T2ID=$(tpl "{\"code\":\"E2E_C$S\",\"name\":\"ტესტ-E2E csv $S\",\"kind\":\"export\",\"format\":\"csv\",\"config\":$CFG2}" | jq -r '.id // empty')
CFG3=$(jq -nc '{xml_root:"Claims",xml_row:"Case",columns:[{header:"",field:"personal_number",tag:"PN"},{header:"",field:"drg_code"},{header:"",field:"claimed",tag:"Amount"},{header:"",const:"GE",tag:"Country"}]}')
T3ID=$(tpl "{\"code\":\"E2E_M$S\",\"name\":\"ტესტ-E2E xml $S\",\"kind\":\"export\",\"format\":\"xml\",\"config\":$CFG3}" | jq -r '.id // empty')
[ -n "$T1ID" ] && [ -n "$T2ID" ] && [ -n "$T3ID" ] || die "შაბლონები ვერ შეიქმნა"
ok "csv (მხოლოდ სტაციონარი, „,“ ათწილადი) და xml შაბლონები"
chk "სახელის შეცვლა — revision იგივე (1)" "$(api PATCH "/claim-templates/$T1ID" "$AC" -d '{"name":"ტესტ-E2E xlsx რეესტრი"}' | jq -r '"\(.revision):\(.name)"')" "1:ტესტ-E2E xlsx რეესტრი"
CFG1B=$(echo "$CFG1" | jq -c '.total_row=false')
chk "კონფიგურაციის შეცვლა → revision 2" "$(api PATCH "/claim-templates/$T1ID" "$AC" -d "{\"config\":$CFG1B}" | jq -r .revision)" "2"
chk "იგივე კონფიგურაცია ხელახლა — revision არ იზრდება" "$(api PATCH "/claim-templates/$T1ID" "$AC" -d "{\"config\":$CFG1B}" | jq -r .revision)" "2"
api PATCH "/claim-templates/$T1ID" "$AC" -d "{\"config\":$CFG1}" >/dev/null
chk "ტიპის შეცვლა → 400; კოდის შეცვლა → 400" "$(code PATCH "/claim-templates/$T1ID" "$AC" -d '{"kind":"response"}'):$(code PATCH "/claim-templates/$T1ID" "$AC" -d '{"code":"E2E_ZZ"}')" "400:400"
CP=$(api POST "/claim-templates/$T1ID/copy" "$AC" -d "{\"code\":\"E2E_XC$S\",\"name\":\"ტესტ-E2E ასლი\"}")
CPID=$(echo "$CP" | jq -r '.id // empty')
chk "ასლი: იგივე სვეტები, revision 1" "$(echo "$CP" | jq -r '"\(.config.columns|length):\(.revision)"')" "14:1"
RCFG=$(jq -nc '{header_row:true,csv_sep:";",key_field:"invoice_number",amount_kind:"approved",columns:{key:"ინვოისი",status:"სტატუსი",amount:"დამტკიცებული",reason:"მიზეზი",note:"შენიშვნა",ref:"№"},
  status_map:{accepted:["მიღებულია"],partial:["ნაწილობრივ"],rejected:["უარყოფილია"],pending:["განხილვაში"]}}')
chk "პასუხის შაბლონი: xml → 400; საიდენტიფიკაციოს გარეშე → 400; ერთი მნიშვნელობა ორ სტატუსში → 400" "$(code POST /claim-templates "$AC" -d "{\"code\":\"E2E_R$S\",\"name\":\"ტესტ\",\"kind\":\"response\",\"format\":\"xml\",\"config\":$RCFG}"):$(code POST /claim-templates "$AC" -d "{\"code\":\"E2E_R$S\",\"name\":\"ტესტ\",\"kind\":\"response\",\"format\":\"csv\",\"config\":$(echo "$RCFG" | jq -c '.columns.key=""')}"):$(code POST /claim-templates "$AC" -d "{\"code\":\"E2E_R$S\",\"name\":\"ტესტ\",\"kind\":\"response\",\"format\":\"csv\",\"config\":$(echo "$RCFG" | jq -c '.status_map.rejected+=["მიღებულია"]')}")" "400:400:400"
R1ID=$(tpl "{\"code\":\"E2E_R$S\",\"name\":\"ტესტ-E2E პასუხი $S\",\"kind\":\"response\",\"format\":\"csv\",\"config\":$RCFG}" | jq -r '.id // empty')
[ -n "$R1ID" ] && ok "პასუხის შაბლონი (csv, გასაღები — ინვოისი)" || bad "პასუხის შაბლონი" "ვერ შეიქმნა"
chk "გადამხდელი: ექსპორტის ველში პასუხის შაბლონი → 400" "$(code PUT "/claim-templates/payers/$PY" "$AC" -d "{\"export_template_id\":\"$R1ID\"}")" "400"
chk "გადამხდელის ნაგულისხმევი: ექსპორტი T1, პასუხი R1" "$(api PUT "/claim-templates/payers/$PY" "$AC" -d "{\"export_template_id\":\"$T1ID\",\"response_template_id\":\"$R1ID\"}" | jq -r '"\(.export_template_id == "'"$T1ID"'"):\(.response_template_id == "'"$R1ID"'")"')" "true:true"
chk "შაბლონის ბარათი: გადამხდელი მიბმულია" "$(api GET "/claim-templates/$T1ID" "$BL" | jq -r '.payers|length')" "1"

step "2. უარის მიზეზები"
RS=$(api GET /denial-reasons "$BL")
chk "ცნობარი: 11 საწყისი (DOCS … OTHER), კატეგორიით" "$(echo "$RS" | jq -r '[.[]|select(.code=="DOCS" or .code=="OTHER" or .code=="DRG")]|length'):$(echo "$RS" | jq -r '.[]|select(.code=="DRG")|"\(.category_ka):\(.default_action)"')" "3:კოდირება:writeoff"
RN="E2E$S"
chk "ახალი მიზეზი: ბილინგი → 403; ცუდი კოდი → 400" "$(code POST /denial-reasons "$BL" -d "{\"code\":\"$RN\",\"title\":\"ტესტ\"}"):$(code POST /denial-reasons "$AC" -d '{"code":"a b","title":"ტესტ"}')" "403:400"
chk "ახალი მიზეზი (გარე კოდი R-17$S, ჩამოწერა)" "$(api POST /denial-reasons "$AC" -d "{\"code\":\"$RN\",\"title\":\"ტესტ-E2E არასწორი DRG\",\"category\":\"coding\",\"external_codes\":[\"R-17$S\",\" R-17$S \"],\"default_action\":\"writeoff\",\"sort_order\":5}" | jq -r --arg c "$RN" '.[]|select(.code==$c)|"\(.external_codes|length):\(.default_action)"')" "1:writeoff"
chk "იგივე კოდი → 409" "$(code POST /denial-reasons "$AC" -d "{\"code\":\"$RN\",\"title\":\"ტესტ\"}")" "409"
chk "შეცვლა: კატეგორია → tariff" "$(api PATCH "/denial-reasons/$RN" "$AC" -d '{"category":"tariff"}' | jq -r --arg c "$RN" '.[]|select(.code==$c)|.category')" "tariff"

step "3. ქლეიმი → ექსპორტი"
C=$(api POST /finance/claims "$AC" -d "{\"payer_id\":\"$PY\",\"period_from\":\"$TODAY\",\"period_to\":\"$TODAY\"}")
CID=$(echo "$C" | jq -r '.id // empty'); [ -n "$CID" ] || die "ქლეიმი ვერ შეიქმნა: $(echo "$C" | jq -c .)"
chk "ქლეიმი: 2 შემთხვევა" "$(echo "$C" | jq -r '.items|length')" "2"
PV=$(api GET "/finance/claims/$CID/export-preview" "$BL")
chk "მონახაზი: გადახედვა (ნაგულისხმევი შაბლონი T1), ექსპორტი არ შეიძლება" "$(echo "$PV" | jq -r '"\(.template.id == "'"$T1ID"'"):\(.rows):\(.can_export):\(.header|length)"')" "true:2:false:14"
chk "გადახედვა: სქესი (map), თანმხლები, მუდმივი, ნულებით შევსება" "$(echo "$PV" | jq -r '.preview[0]|"\(.[3]):\(.[9]):\(.[10]):\(.[11]|length)"')" "1:E11.9:ტესტ-E2E კლინიკა:12"
chk "მონახაზის ექსპორტი → 409" "$(code POST "/finance/claims/$CID/exports" "$AC" -d '{}')" "409"
api POST "/finance/claims/$CID/send" "$AC" >/dev/null
CL=$(api GET "/finance/claims/$CID" "$AC"); CNO=$(echo "$CL" | jq -r .claim_no)
I1=$(echo "$CL" | jq -r --arg a "$PN1" '.items[]|select(.personal_number==$a)|.id'); I2=$(echo "$CL" | jq -r --arg a "$PN2" '.items[]|select(.personal_number==$a)|.id')
INV1=$(echo "$CL" | jq -r --arg a "$I1" '.items[]|select(.id==$a)|.invoice_number'); INV2=$(echo "$CL" | jq -r --arg a "$I2" '.items[]|select(.id==$a)|.invoice_number')
A1=$(echo "$CL" | jq -r --arg a "$I1" '.items[]|select(.id==$a)|.claimed|tonumber+0'); A2=$(echo "$CL" | jq -r --arg a "$I2" '.items[]|select(.id==$a)|.claimed|tonumber+0')
chk "გაგზავნილი: № და პასუხის შეჯამება (2 უპასუხო)" "$([ "$CNO" != null ] && echo ok):$(echo "$CL" | jq -r '"\(.responses.none):\(.responses.accepted)"')" "ok:2:0"
chk "ბილინგი ექსპორტს ვერ ქმნის (403)" "$(code POST "/finance/claims/$CID/exports" "$BL" -d '{}')" "403"
X1=$(api POST "/finance/claims/$CID/exports" "$AC" -d '{"note":"ტესტ-E2E პირველი"}')
X1ID=$(echo "$X1" | jq -r '.id // empty')
chk "ექსპორტი (xlsx): 2 ხაზი, ფაილის სახელი, ჯამი" "$(echo "$X1" | jq -r '"\(.rows):\(.file_name):\(.repeat)"'):$(echo "$X1" | jq -r '.total')" "2:E2EXP$S"_"$CNO.xlsx:false:$(jq -n "$A1+$A2")"
curl -s -D "$TMP/h1" -o "$TMP/f1.xlsx" "$B/finance/claim-exports/$X1ID/file" -H "authorization: Bearer $BL"
SHA_H=$(grep -i '^x-content-sha256' "$TMP/h1" | tr -d '\r' | awk '{print $2}')
chk "ჩამოტვირთვა (ბილინგი): sha256 = ჟურნალის = ფაილის" "$SHA_H:$(sha256sum "$TMP/f1.xlsx" | cut -c1-64)" "$(echo "$X1" | jq -r .sha256):$(echo "$X1" | jq -r .sha256)"
XL=$(python3 - "$TMP/f1.xlsx" <<'PY'
import sys, zipfile, re
z = zipfile.ZipFile(sys.argv[1]); s = z.read('xl/worksheets/sheet1.xml').decode()
rows = re.findall(r'<row r="(\d+)">', s); nums = re.findall(r's="\d+"><v>([\d.]+)</v>', s)
print(f"{len(rows)}:{'რეესტრი' in z.read('xl/workbook.xml').decode()}:{'ტესტ-E2E კლინიკა' in s}:{'0.0000' in z.read('xl/styles.xml').decode()}:{len(nums) >= 4}")
PY
)
chk "xlsx: 4 ხაზი (სათაური + 2 + ჯამი), ფურცლის სახელი, მუდმივი, რიცხვის ფორმატი" "$XL" "4:True:True:True:True"
X1B=$(api POST "/finance/claims/$CID/exports" "$AC" -d '{}')
chk "განმეორებითი ექსპორტი: repeat, იგივე sha256 (დეტერმინისტული)" "$(echo "$X1B" | jq -r '"\(.repeat):\(.sha256)"')" "true:$(echo "$X1" | jq -r .sha256)"
X2=$(api POST "/finance/claims/$CID/exports" "$AC" -d "{\"template_id\":\"$T2ID\"}")
curl -s -o "$TMP/f2.csv" "$B/finance/claim-exports/$(echo "$X2" | jq -r .id)/file" -H "authorization: Bearer $AC"
L2=$(grep "^$PN1;" "$TMP/f2.csv" | tr -d '\r')
chk "csv: ფაილის სახელი, BOM-ის გარეშე, სათაური" "$(echo "$X2" | jq -r .file_name):$(head -c 3 "$TMP/f2.csv" | od -An -tx1 | tr -d ' '):$(head -1 "$TMP/f2.csv" | tr -d '\r')" "ssa_$TODAY.csv:504e3b:PN;ADM;DIS;LOS;DRG;AMT;SDX"
chk "csv: თარიღი YYYYMMDD / DD/MM/YYYY, LOS, DRG, „,“ ათწილადი, სიის გამყოფი |" "$L2" "$PN1;${TODAY//-/};$(date -d "$TODAY" +%d/%m/%Y);1;P1;$(printf '%.2f' "$A1" | tr . ,);J18.9|E11.9"
X3=$(api POST "/finance/claims/$CID/exports" "$AC" -d "{\"template_id\":\"$T3ID\"}")
curl -s -o "$TMP/f3.xml" "$B/finance/claim-exports/$(echo "$X3" | jq -r .id)/file" -H "authorization: Bearer $AC"
chk "xml: ძირი / ხაზები / ელემენტები (tag ან ველის სახელი)" "$(python3 -c "
import sys, xml.etree.ElementTree as E; r=E.parse(sys.argv[1]).getroot(); c=r.findall('Case')
print(f\"{r.tag}:{r.get('count')}:{len(c)}:{c[0].find('Country').text}:{c[0].find('drg_code').text is not None}\")" "$TMP/f3.xml")" "Claims:2:2:GE:True"
chk "ჟურნალი: 4 ექსპორტი, შაბლონი / ვერსია / ზომა" "$(api GET "/finance/claims/$CID/exports" "$BL" | jq -r '"\(length):\(.[-1].template_revision):\(.[-1].note):\(.[-1].size > 1000)"')" "4:3:ტესტ-E2E პირველი:true"
OP=$(jq -nc '{kinds:["opd"],columns:[{header:"x",field:"invoice_number"}]}')
TO=$(tpl "{\"code\":\"E2E_O$S\",\"name\":\"ტესტ-E2E ამბ.\",\"kind\":\"export\",\"format\":\"csv\",\"config\":$OP}" | jq -r .id)
chk "შაბლონის ფილტრი: მხოლოდ ამბულატორია → 400 (შემთხვევა არ არის)" "$(code POST "/finance/claims/$CID/exports" "$AC" -d "{\"template_id\":\"$TO\"}")" "400"
api PATCH "/claim-templates/$TO" "$AC" -d '{"is_active":false}' >/dev/null
chk "გამორთული შაბლონი → 400" "$(code POST "/finance/claims/$CID/exports" "$AC" -d "{\"template_id\":\"$TO\"}")" "400"
chk "აუდიტი: FIN_CLAIM_FILE_EXPORT / DOWNLOAD" "$(api GET "/audit-logs?entity_name=fin_claims&entity_id=$CID&limit=50" "$ADM" | jq -r '[(if type=="array" then . else .items end)[]|.action]|"\(index("FIN_CLAIM_FILE_EXPORT") != null):\(index("FIN_CLAIM_FILE_DOWNLOAD") != null)"')" "true:true"
# შემოწმება (0057): warn → ექსპორტი გაფრთხილებით; block + შეცდომა → 409
XR="X_E2ECX$S"
api POST /scrub/rules "$DA1" -d "{\"code\":\"$XR\",\"title\":\"ტესტ-E2E ექსპორტი\",\"severity\":\"error\",\"conditions_text\":\"los >= 1\",\"payer_ids\":[\"$PY\"]}" >/dev/null
scr true warn
chk "scrubber warn: ექსპორტი — გაფრთხილებით (2)" "$(api POST "/finance/claims/$CID/exports" "$AC" -d '{}' | jq -r .scrub_warnings)" "2"
scr true block
chk "scrubber block: გადახედვა — 2 შეცდომა, ექსპორტი → 409 SCRUB_ERRORS" "$(api GET "/finance/claims/$CID/export-preview" "$AC" | jq -r '"\(.scrub.errors|length):\(.can_export)"'):$(api POST "/finance/claims/$CID/exports" "$AC" -d '{}' | jq -r .code)" "2:false:SCRUB_ERRORS"
api DELETE "/scrub/rules/$XR" "$DA1" >/dev/null; scr true off

step "4. პასუხი"
chk "პასუხი: ექიმი → 403" "$(code PUT "/finance/claim-items/$I1/response" "$DR" -d '{"status":"accepted"}')" "403"
chk "მიღებულია, თანხა ≠ მოთხოვნილს → 400; ნაწილობრივ მიზეზის გარეშე → 400; უცნობი მიზეზი → 400" "$(code PUT "/finance/claim-items/$I1/response" "$BL" -d '{"status":"accepted","amount":1}'):$(code PUT "/finance/claim-items/$I1/response" "$BL" -d '{"status":"partial","amount":1}'):$(code PUT "/finance/claim-items/$I1/response" "$BL" -d '{"status":"rejected","reason":"NOPE"}')" "400:400:400"
chk "ნაწილობრივ: თანხა ≥ მოთხოვნილი → 400" "$(code PUT "/finance/claim-items/$I1/response" "$BL" -d "{\"status\":\"partial\",\"amount\":$A1,\"reason\":\"DOCS\"}")" "400"
HALF=$(jq -n "($A1/2*100|floor)/100")
R=$(api PUT "/finance/claim-items/$I1/response" "$BL" -d "{\"status\":\"partial\",\"amount\":$HALF,\"reason\":\"DOCS\",\"note\":\"ტესტ-E2E\",\"ref\":\"SSA-1\"}")
chk "ნაწილობრივ (ბილინგი): თანხა, მიზეზი, შეჯამება" "$(echo "$R" | jq -r --arg i "$I1" '.items[]|select(.id==$i)|"\(.resp_status):\(.resp_amount|tonumber+0):\(.resp_reason_title|length > 5)"'):$(echo "$R" | jq -r '"\(.responses.partial):\(.responses.none)"')" "partial:$HALF:true:1:1"
chk "პასუხის გასუფთავება (status null)" "$(api PUT "/finance/claim-items/$I1/response" "$BL" -d '{"status":null}' | jq -r --arg i "$I1" '.items[]|select(.id==$i)|.resp_status')" "null"
# xlsx პასუხი — ექსპორტის შაბლონით აწყობილი ფაილი (სათაურები = პასუხის შაბლონის სვეტები)
XCFG=$(jq -nc --arg r "R-17$S" '{columns:[{header:"ინვოისი",field:"invoice_number"},{header:"სტატუსი",const:"უარყოფილია"},{header:"დამტკიცებული",const:"0"},{header:"მიზეზი",field:"pdx_code",map:{"J18.9":$r}},{header:"№",field:"adm_no"}]}')
TX=$(tpl "{\"code\":\"E2E_RX$S\",\"name\":\"ტესტ-E2E პასუხის ფაილი\",\"kind\":\"export\",\"format\":\"xlsx\",\"config\":$XCFG}" | jq -r .id)
XF=$(api POST "/finance/claims/$CID/exports" "$AC" -d "{\"template_id\":\"$TX\"}" | jq -r .id)
curl -s -o "$TMP/resp.xlsx" "$B/finance/claim-exports/$XF/file" -H "authorization: Bearer $AC"
D=$(upload "/finance/claims/$CID/responses/import" "$BL" "$TMP/resp.xlsx")
chk "xlsx იმპორტი (dry-run): 2 დაემთხვა; გარე კოდი → მიზეზი; უცნობი მიზეზი → OTHER + გაფრთხილება" "$(echo "$D" | jq -r --arg i "$INV1" --arg r "$RN" '"\(.dry_run):\(.matched):\(.by_status.rejected):\([.lines[]|select(.invoice_number==$i)][0].reason == $r):\([.lines[]|select(.warn)]|length)"')" "true:2:2:true:1"
chk "dry-run — არაფერი ჩაიწერა" "$(api GET "/finance/claims/$CID" "$BL" | jq -r '.responses.none')" "2"
# csv პასუხი: 1 უარი (გარე კოდი), 1 მიღებული, 1 უცნობი ინვოისი, 1 უცნობი სტატუსი
printf 'ინვოისი;სტატუსი;დამტკიცებული;მიზეზი;შენიშვნა;№\r\n%s;უარყოფილია;0;R-17%s;ტესტ-E2E;SSA-77\r\n%s;მიღებულია;%s;;;SSA-78\r\nNOPE-1;მიღებულია;1;;;\r\n%s;რაღაც;1;;;\r\n' "$INV1" "$S" "$INV2" "$A2" "$INV2" > "$TMP/resp.csv"
D=$(upload "/finance/claims/$CID/responses/import" "$BL" "$TMP/resp.csv")
chk "csv (dry-run): 4 ხაზი, 2 პრობლემა (უცნობი ინვოისი, მეორდება / სტატუსი)" "$(echo "$D" | jq -r '"\(.rows):\(.matched):\(.problems)"'):$(echo "$D" | jq -r '[.lines[]|select(.problem)|.problem]|map(select(test("ვერ მოიძებნა|სტატუსი")))|length')" "4:2:2:2"
chk "იმპორტი: ექიმი → 403; ფაილის გარეშე → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/finance/claims/$CID/responses/import" -H "authorization: Bearer $DR" -F "file=@$TMP/resp.csv"):$(code POST "/finance/claims/$CID/responses/import" "$BL")" "403:400"
D=$(upload "/finance/claims/$CID/responses/import?commit=true" "$BL" "$TMP/resp.csv")
IMPID=$(echo "$D" | jq -r '.import_id // empty')
CL=$(api GET "/finance/claims/$CID" "$AC")
chk "ჩაწერა: უარყოფილია (მიზეზი $RN, № SSA-77) + მიღებულია" "$(echo "$CL" | jq -r --arg i "$I1" '.items[]|select(.id==$i)|"\(.resp_status):\(.resp_reason):\(.resp_ref):\(.resp_import_id != null)"'):$(echo "$CL" | jq -r --arg i "$I2" '.items[]|select(.id==$i)|.resp_status')" "rejected:$RN:SSA-77:true:accepted"
chk "შეჯამება: დამტკიცებული / უარი" "$(echo "$CL" | jq -r '"\(.responses.approved):\(.responses.denied)"')" "$(jq -n "$A2"):$(jq -n "$A1")"
chk "იმპორტის ჟურნალი: ფაილი, 2 ჩაიწერა, 2 პრობლემა" "$(api GET "/finance/claims/$CID/response-imports" "$BL" | jq -r '.[0]|"\(.file_name):\(.applied):\(.problems|length)"')" "resp.csv:2:2"

step "5. უარის გადაწყვეტა"
chk "ჯგუფური გადაწყვეტა: ექიმი → 403" "$(code POST "/finance/claims/$CID/apply-denials" "$DR" -d '{}')" "403"
api PUT "/finance/claim-items/$I2/response" "$BL" -d "{\"status\":\"partial\",\"amount\":$(jq -n "($A2/2*100|floor)/100"),\"reason\":\"DOCS\"}" >/dev/null
AP=$(api POST "/finance/claims/$CID/apply-denials" "$BL" -d '{}')
chk "გადაწყვეტა: $RN → ჩამოწერა (სრული თანხა); DOCS (ქმედების გარეშე) — გამოტოვებული" "$(echo "$AP" | jq -r '"\(.done|length):\(.done[0].action):\(.done[0].amount):\(.skipped|length)"')" "1:writeoff:$(jq -n "$A1"):1"
chk "შემთხვევა გადაწყვეტილია: მიზეზი ტექსტში" "$(echo "$AP" | jq -r --arg i "$I1" '.claim.items[]|select(.id==$i)|"\(.resolution):\(.resolution_reason|startswith("უარი: '"$RN"'"))"')" "writeoff:true"
chk "განმეორებით — უკვე გადაწყვეტილი გამოტოვდება" "$(api POST "/finance/claims/$CID/apply-denials" "$BL" -d "{\"item_ids\":[\"$I1\"]}" | jq -r '"\(.done|length):\(.skipped[0].reason)"')" "0:უკვე გადაწყვეტილია"
chk "პასუხი გაგზავნილზე — ისევ იცვლება (მიღებულია)" "$(api PUT "/finance/claim-items/$I2/response" "$BL" -d '{"status":"accepted"}' | jq -r --arg i "$I2" '.items[]|select(.id==$i)|.resp_status')" "accepted"

step "6. უარის ანგარიში"
DR_=$(api GET "/finance/reports/denials?from=$TODAY&to=$TODAY&payer_id=$PY" "$AC")
chk "სულ: 2 პასუხი, 1 უარი, უარის წილი, დაუფარავი 0" "$(echo "$DR_" | jq -r '.totals|"\(.responded_cases):\(.denied_cases):\(.rejected):\(.unresolved)"')" "2:1:1:0"
chk "მიზეზით / კატეგორიით / განყოფილებით; ჩამოწერილი" "$(echo "$DR_" | jq -r --arg r "$RN" '"\(.by_reason[0].key == $r):\(.by_category[0].title):\(.by_department[0].title):\(.by_reason[0].resolved_writeoff)"')" "true:ტარიფი / თანხა:$DNAME:$(jq -n "$A1")"
chk "ცუდი პერიოდი → 400; ექიმი → 403" "$(code GET "/finance/reports/denials?from=$TODAY&to=2000-01-01" "$AC"):$(code GET "/finance/reports/denials?from=$TODAY&to=$TODAY" "$DR")" "400:403"

step "7. CMI"
CM=$(api GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&payer_id=$PY" "$CD")
chk "სულ: 2 შემთხვევა, წონა 3.5, CMI 1.75, ქირურგიული 50%" "$(echo "$CM" | jq -r '.totals|"\(.cases):\(.weight):\(.cmi):\(.surgical_pct)"')" "2:3.5:1.75:50"
chk "ხანგრძლივობა: საშუალო 1, ALOS 6, los_index 0.17" "$(echo "$CM" | jq -r '.totals|"\(.avg_los):\(.alos):\(.los_index)"')" "1:6:0.17"
chk "განყოფილებით: 1 ხაზი ($DNAME)" "$(echo "$CM" | jq -r '"\(.rows|length):\(.rows[0].title)"')" "1:$DNAME"
chk "ჯგუფები: C2 პირველი (წონის წილი 71.43%)" "$(echo "$CM" | jq -r '.groups[0]|"\(.key):\(.weight_share_pct):\(.mdc)"')" "C2:71.43:05"
chk "outlier: 2 (ორივე < ქვედა ზღვარი)" "$(echo "$CM" | jq -r '[.outliers[]|select(.kind=="low")]|length')" "2"
chk "თვით / ექიმით / გადამხდელით" "$(api GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&payer_id=$PY&by=month" "$CD" | jq -r '.rows[0].key'):$(api GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&payer_id=$PY&by=doctor" "$CD" | jq -r '.rows[0].title'):$(api GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&payer_id=$PY&by=payer" "$CD" | jq -r '.rows[0].cmi')" "$YM:CX-66 ტესტ-E2E:1.75"
chk "სქემის ფილტრი: იგივე 2" "$(api GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&scheme_id=$SCH" "$CD" | jq -r .totals.cases)" "2"
chk "by=x → 400; ექთანი → 403" "$(code GET "/drg/reports/cmi?from=$TODAY&to=$TODAY&by=x" "$CD"):$(code GET "/drg/reports/cmi?from=$TODAY&to=$TODAY" "$NA")" "400:403"

step "8. აღდგენა"
api PUT "/claim-templates/payers/$PY" "$AC" -d '{"export_template_id":null,"response_template_id":null}' >/dev/null
for t in "$T1ID" "$T2ID" "$T3ID" "$CPID" "$R1ID" "$TX"; do api PATCH "/claim-templates/$t" "$AC" -d '{"is_active":false}' >/dev/null; done
api PATCH "/denial-reasons/$RN" "$AC" -d '{"is_active":false}' >/dev/null
api POST "/drg/versions/$V1/retire" "$DA1" -d '{"reason":"ტესტ-E2E დასრულება"}' >/dev/null
api PATCH "/drg/schemes/$SCH" "$DA1" -d '{"is_active":false}' >/dev/null
api PATCH "/billing/payers/$PY" "$BL" -d '{"is_active":false}' >/dev/null
[ -n "$BT" ] && api DELETE "/billing/bed-tariffs/$BT" "$ADM" >/dev/null
api PATCH "/tariffs/$T_BED" "$ADM" -d '{"is_active":false}' >/dev/null
api PUT /modules/drg "$ADM" -d "{\"enabled\":$(echo "$O_DRG" | jq -c .enabled),\"settings\":$(echo "$O_DRG" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/inpatient "$ADM" -d "{\"settings\":$O_IPD,\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
api PUT /modules/scrubber "$ADM" -d "{\"enabled\":$(echo "$O_SCR" | jq -c .enabled),\"settings\":$(echo "$O_SCR" | jq -c .settings),\"reason\":\"ტესტ-E2E აღდგენა\"}" >/dev/null
chk "შაბლონები / მიზეზი გამოირთო, მოდულები აღდგა" "$(api GET "/claim-templates/$T1ID" "$BL" | jq -r .is_active):$(api GET /modules "$ADM" | jq -c '[.[]|select(.code=="scrubber" or .code=="drg")|{enabled,settings}]|sort_by(.settings|keys|length)|length')" "false:2"

printf '\n\033[1mშედეგი: %s ✓  %s ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
