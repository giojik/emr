#!/usr/bin/env bash
# =====================================================================
# e2e-worklist-clinical.sh — სამუშაო სიები, ეტაპი 3 (0083): კლინიკური სისტემური წყაროები (ექიმი / ექთანი)
#   პარამეტრები (ვალიდაცია), კატალოგი (80 წყარო); დოკუმენტაცია (მიმღები გასინჯვა — მკურნალი / არააქტიური მკურნალი → ხელმძღვანელი,
#   ხელმოუწერელი ჩანაწერი, თანხმობა, ეპიკრიზის თანახელმოწერა, გაწერილის დოკუმენტაცია); დანიშნულებები (ვერიფიკაცია — ფარმაცევტი /
#   მთავარი ექთანი, უარი → დამნიშნავი, ანტიბიოტიკის დამტკიცება, ზეპირი, ანტიბიოტიკის დასრულება); MAR (ახლა / გამოტოვებული — პაციენტზე,
#   nurse_scope); კონსულტაცია (განყოფილება / კონკრეტული ექიმი), გადმოყვანა (dept_side); საექთნო (შკალები, ხაზი → „საჭიროება შეფასდა“,
#   გადაბარება, ვიტალების ვადა NEWS2-ით, NEWS2 → ექიმის შეფასება); ICU (bundle); საოპერაციო (მოთხოვნა → კოორდინატორი, შეფასება →
#   ანესთეზიოლოგი, მზადყოფნა → განყოფილება, ოქმი / რუკა, PACU); admin — 0; diagnostics (0083-ის კოდები).
# ბოლოს: ჰოსპიტალიზაციები / ოპერაციები გაუქმებულია (სადაც შესაძლებელია), მომხმარებლები / როლები / განყოფილებები გათიშულია; პარამეტრები — საწყისი.
# გამოყენება:  bash scripts/e2e-worklist-clinical.sh [API_URL]
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
ago() { date -u -d "-$1" +%FT%TZ; }
BASE=$(( $(date +%s) / 900 * 900 )); T() { date -u -d "@$((BASE - $1 * 60))" +%FT%TZ; }
N() { date -u -d "@$(( $(date +%s) / 60 * 60 - $1 * 60 ))" +%FT%TZ; }
# ჩანაწერი „ჩემს დავალებებში“: <key> <token> → JSON / რაოდენობა
it()   { api GET "/worklist/mine?source=${1%%:*}" "$2" | jq -c --arg k "$1" '[.items[]|select(.key==$k)][0] // empty'; }
inm()  { api GET "/worklist/mine?source=${1%%:*}" "$2" | jq -r --arg k "$1" '[.items[]|select(.key==$k)]|length'; }
hrs()  { echo "$1" | jq -r 'if . == "" or .due_at == null then "null" else (((.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - now) / 3600 | round) end'; }
wl()   { api PUT /modules/worklist "$ADM" -d "{\"settings\":$1,\"reason\":\"ტესტ-E2E\"}" >/dev/null; }
modset() { api PUT "/modules/$1" "$ADM" -d "{\"settings\":$2,\"reason\":\"ტესტ-E2E\"}" | jq -r '.code // .message'; }

step "0. მომზადება"
chk "API ხელმისაწვდომია, სქემა ≥ 0083" "$(curl -s "$B/health" | jq -r '.status + ":" + (.schemaVersion >= "0083" | tostring)')" "ok:true"
ORIG=$(api GET /modules "$ADM")
orig() { echo "$ORIG" | jq -c --arg c "$1" '.[]|select(.code==$c)|{enabled, settings}'; }
for m in worklist inpatient icu or; do [ -n "$(orig $m)" ] || die "მოდული $m ვერ მოიძებნა"; done
SCRUB_EN=$(echo "$ORIG" | jq -r '.[]|select(.code=="scrubber")|.enabled // empty')
[ "$SCRUB_EN" = "true" ] && api PUT /modules/scrubber "$ADM" -d '{"enabled":false,"reason":"ტესტ-E2E"}' >/dev/null
dep() { local id; id=$(api POST /departments "$ADM" -d "{\"name\":\"ტესტ-E2E WC $1 $S\",\"code\":\"$2$S\",\"type\":\"$3\"${4:-}}" | jq -r '.id // empty'); [ -n "$id" ] && echo "$id" >> "$TMP/deps"; echo "$id"; }
D1=$(dep "თერაპია" E2EWC1 inpatient); D2=$(dep "ქირურგია" E2EWC2 inpatient); DI=$(dep "რეანიმაცია" E2EWCI inpatient ',"care_level":"icu"')
DBK=$(dep "საოპერაციო" E2EWCB or); DAN=$(dep "ანესთეზიოლოგია" E2EWCA administrative)
[ -n "$D1" ] && [ -n "$D2" ] && [ -n "$DI" ] && [ -n "$DBK" ] && [ -n "$DAN" ] || die "განყოფილებები ვერ შეიქმნა"
BT=$(api GET "/inpatient/structure?all=true" "$ADM" | jq -r '[.types[]?|select(.is_active!=false)|.code] as $a | if ($a|index("standard")) then "standard" else ($a[0] // "standard") end')
beds() { local w; w=$(api POST /inpatient/wards "$ADM" -d "{\"department_id\":\"$1\",\"code\":\"$2\",\"sex\":\"mixed\"}" | jq -r '.id // empty'); api POST "/inpatient/wards/$w/beds" "$ADM" -d "{\"count\":$3,\"type_code\":\"$BT\"}"; }
B1=$(beds "$D1" W1 6); B2=$(beds "$D2" W2 2); BI=$(beds "$DI" I1 1)
bed() { echo "$1" | jq -r ".[$2].id // empty"; }
[ -n "$(bed "$B1" 5)" ] && [ -n "$(bed "$B2" 1)" ] && [ -n "$(bed "$BI" 0)" ] || die "საწოლები ვერ შეიქმნა"
mkrole() { local id; id=$(api POST /roles "$ADM" -d "{\"code\":\"e2e_$1_$S\",\"name\":\"ტესტ-E2E $2\",\"capabilities\":$3}" | jq -r '.id // empty')
  [ -n "$id" ] && { echo "$id" >> "$TMP/roles"; echo "e2e_$1_$S"; }; }
R_CO=$(mkrole wcco "საოპერაციოს კოორდინატორი" '["or_schedule"]'); R_AN=$(mkrole wcan "ანესთეზიოლოგი" '["anesthesiologist"]'); R_ON=$(mkrole wcon "საოპერაციო ექთანი" '["or_nurse"]')
[ -n "$R_CO" ] && [ -n "$R_AN" ] && [ -n "$R_ON" ] || die "როლები ვერ შეიქმნა"
mkuser() {   # <roles-json> <n> [extra-json] → "<id> <token>"
  local R; R=$(api POST /users "$ADM" -d "{\"email\":\"e2e.wc.$2.$S@test.local\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"კლ-$2\",\"personal_number\":\"$2$(printf '%09d' "$((10#$S))")\",\"roles\":$1${3:-}}")
  local id tmp; id=$(echo "$R" | jq -r '.user.id // empty'); tmp=$(echo "$R" | jq -r '.temporaryPassword // empty')
  [ -n "$id" ] || return; echo "$id" >> "$TMP/users"
  local t; t=$(login "e2e.wc.$2.$S@test.local" "$tmp")
  echo "$id $(api POST /auth/change-password "$t" -d "{\"currentPassword\":\"$tmp\",\"newPassword\":\"E2e-$S-pass-$2\"}" | jq -r '.accessToken // empty')"
}
read -r RCID RC <<< "$(mkuser '["receptionist"]' 31)"
read -r DRID DR <<< "$(mkuser '["doctor"]' 32 ",\"department_id\":\"$D1\"")"                            # მკურნალი (D1)
read -r DHID DH <<< "$(mkuser '["doctor"]' 33 ",\"department_id\":\"$D1\",\"is_section_head\":true")"   # D1 ხელმძღვანელი
read -r DXID DX <<< "$(mkuser '["doctor"]' 34 ",\"department_id\":\"$D1\"")"                            # მკურნალი → გაითიშება
read -r NAID NA <<< "$(mkuser '["nurse"]' 35 ",\"department_id\":\"$D1\"")"
read -r NBID NB <<< "$(mkuser '["nurse"]' 36 ",\"department_id\":\"$D1\"")"
read -r HNID HN <<< "$(mkuser '["nurse"]' 37 ",\"department_id\":\"$D1\",\"is_section_head\":true")"    # D1 მთავარი ექთანი
read -r PHID PH <<< "$(mkuser '["pharmacist"]' 38)"
read -r D2ID D2R <<< "$(mkuser '["doctor"]' 39 ",\"department_id\":\"$D2\"")"
read -r D2HID D2H <<< "$(mkuser '["doctor"]' 40 ",\"department_id\":\"$D2\",\"is_section_head\":true")"
read -r NIID NI <<< "$(mkuser '["nurse"]' 41 ",\"department_id\":\"$DI\"")"
read -r COID CO <<< "$(mkuser "[\"$R_CO\"]" 42)"
read -r ANID AN <<< "$(mkuser "[\"$R_AN\"]" 43 ",\"department_id\":\"$DAN\"")"
read -r ONID ON <<< "$(mkuser "[\"$R_ON\"]" 44 ",\"department_id\":\"$DBK\"")"
read -r NXID NX <<< "$(mkuser '["nurse"]' 45 ",\"department_id\":\"$D2\"")"
for t in RC DR DH DX NA NB HN PH D2R D2H NI CO AN ON NX; do [ -n "${!t}" ] || die "მომხმარებელი $t ვერ შეიქმნა"; done
ok "15 მომხმარებელი (D1: მკურნალი, ხელმძღვანელი, მეორე ექიმი, 2 ექთანი + მთავარი; D2: ექიმი + ხელმძღვანელი + ექთანი; ფარმაცევტი, ICU ექთანი, საოპერაციო)"
mkpat() { api POST /patients "$ADM" -d "{\"personal_number\":\"$1$(printf '%09d' "$((10#$S))")\",\"first_name\":\"ტესტ-E2E\",\"last_name\":\"კლ-$2\",\"birth_date\":\"$3\",\"gender\":\"$4\",\"phone_number\":\"597$S\"}" | jq -r '.id // empty'; }
P1=$(mkpat 61 "ერთი" 1961-01-01 male); P2=$(mkpat 62 "ორი" 1962-02-02 female); P3=$(mkpat 63 "სამი" 1963-03-03 male)
P4=$(mkpat 64 "ოთხი" 1964-04-04 female); P5=$(mkpat 65 "ხუთი" 1965-05-05 male); P6=$(mkpat 66 "ექვსი" 1966-06-06 female)
for p in P1 P2 P3 P4 P5 P6; do [ -n "${!p}" ] || die "პაციენტი $p ვერ შეიქმნა"; done
modset inpatient '{"bed_assign_mode":"direct","med_verification":"high_risk","med_verifier":"both","verbal_orders":true,"verbal_confirm_hours":24,"news2_enabled":true,"news2_alert":5,"news2_urgent":7,
  "line_alert_hours":{"pvc":96,"urinary":720},"mar_stock_deduct":false,"epicrisis_cosign":false,"transfer_wait_hours":2,"mar_window_min":60,"admission_note_hours":24,"docs_pending_alert_hours":24,"discharge_balance":"warn"}' >/dev/null
api PUT /modules/icu "$ADM" -d '{"enabled":true,"settings":{"news2_alerts":false,"monitor_gap_hours":2},"reason":"ტესტ-E2E"}' >/dev/null
modset or '{"or_scheduling":"coordinator","anesthesia_team_by":"anesthesia_head","preop_readiness":"warn","turnover_min":30,"default_duration_min":60,"notify_requests":false,"nursing_team_by":"both",
  "room_teams":false,"count_mode":"off","note_required":[],"pacu_aldrete_min":9,"anesthesia_billing":"off"}' >/dev/null
api PUT /modules/worklist "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E"}' >/dev/null
wl '{"sources":{},"dept_side":"heads","nurse_scope":"department","mar_due_ahead_min":60,"draft_hours":12,"line_review_hours":24,"or_ahead_hours":24,"pacu_long_hours":4,
  "obs_minutes":{"zero":720,"low":240,"low_red":60,"medium":60,"high":30},"news2_review_min":{"alert":60,"urgent":30}}'
ADMIT() { api POST /inpatient/admissions "$RC" -d "{\"patient_id\":\"$1\",\"department_id\":\"$2\",\"attending_doctor_id\":\"$3\",\"source\":\"direct\",\"icd10_code\":\"J18.9\",\"chief_complaint\":\"ტესტ-E2E\",\"bed_id\":\"$4\"}" | jq -r '.encounter_id // empty'; }
E1=$(ADMIT "$P1" "$D1" "$DRID" "$(bed "$B1" 0)"); E2=$(ADMIT "$P2" "$D1" "$DXID" "$(bed "$B1" 1)"); E3=$(ADMIT "$P3" "$D1" "$DRID" "$(bed "$B1" 2)")
E4=$(ADMIT "$P4" "$DI" "$DRID" "$(bed "$BI" 0)"); E5=$(ADMIT "$P5" "$D1" "$DRID" "$(bed "$B1" 3)"); E6=$(ADMIT "$P6" "$D1" "$DRID" "$(bed "$B1" 4)")
for e in E1 E2 E3 E4 E5 E6; do [ -n "${!e}" ] && echo "${!e}" >> "$TMP/stays" || die "ჰოსპიტალიზაცია $e ვერ მოხერხდა"; done
ok "6 ჰოსპიტალიზაცია: E1 / E3 / E5 / E6 — D1 (მკურნალი DR), E2 — D1 (მკურნალი DX), E4 — რეანიმაცია"
gen() { api POST /pharmacy/generics "$ADM" -d "$1" | jq -r '.id // empty'; }
G_PAR=$(gen "{\"inn\":\"ტესტ-E2E WC პარაცეტამოლი $S\",\"atc_code\":\"N02BE01\",\"form_code\":\"TAB\",\"strength\":\"500 მგ\",\"dose_unit\":\"mg\",\"max_single_dose\":1000,\"routes\":[\"PO\"]}")
G_WAR=$(gen "{\"inn\":\"ტესტ-E2E WC ვარფარინი $S\",\"atc_code\":\"B01AA03\",\"form_code\":\"TAB\",\"strength\":\"5 მგ\",\"dose_unit\":\"mg\",\"max_single_dose\":15,\"routes\":[\"PO\"],\"high_alert\":true}")
G_MER=$(gen "{\"inn\":\"ტესტ-E2E WC მეროპენემი $S\",\"atc_code\":\"J01DH02\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"max_single_dose\":2000,\"routes\":[\"IV\"],\"reserve_antibiotic\":true}")
G_CEF=$(gen "{\"inn\":\"ტესტ-E2E WC ცეფტრიაქსონი $S\",\"atc_code\":\"J01DD04\",\"form_code\":\"INJ_PWD\",\"strength\":\"1 გ\",\"dose_unit\":\"mg\",\"max_single_dose\":2000,\"routes\":[\"IV\"]}")
for g in G_PAR G_WAR G_MER G_CEF; do [ -n "${!g}" ] || die "ჯენერიკი $g ვერ შეიქმნა"; done
med() { jq -nc --arg g "$1" --arg t "$2" --argjson d "$3" --arg u "$4" --arg r "$5" --arg f "${6:-}" '{category:"medication",generic_id:$g,order_type:$t,dose:$d,dose_unit:$u,route_code:$r,abx_indication:"empiric",ack:true,override_reason:"ტესტ-E2E"} + (if $f=="" then {} else {frequency_code:$f} end)'; }
plus() { echo "$1" | jq -c ". + $2"; }

step "1. პარამეტრები, კატალოგი"
chk "nurse_scope / obs_minutes (უცნობი გასაღები) / news2_review_min 1 / draft_hours 200 — 400" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"nurse_scope":"x"},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"obs_minutes":{"foo":60}},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"news2_review_min":{"alert":1}},"reason":"ტესტ"}'):$(code PUT /modules/worklist "$ADM" -d '{"settings":{"draft_hours":200},"reason":"ტესტ"}')" "400:400:400:400"
chk "sla_hours: ახალი გასაღებები (med_verify / or_docs) — 200" "$(code PUT /modules/worklist "$ADM" -d '{"settings":{"sla_hours":{"stk_approve":24,"stk_issue":24,"stk_receive":24,"stk_urgent":4,"proc_approve":48,"asset_move":72,"med_verify":2,"med_approve":4,"doc_cosign":24,"or_docs":24}},"reason":"ტესტ-E2E"}')" "200"
REFS=$(api GET /worklist/refs "$NA")
chk "კატალოგი: 80 წყარო; 6 ახალი ჯგუფი" "$(echo "$REFS" | jq -r '.sources|length'):$(echo "$REFS" | jq -r '[.sources[].group]|unique|map(select(.=="კლინიკური დოკუმენტაცია" or .=="დანიშნულებები / MAR" or .=="კონსულტაცია / გადაყვანა" or .=="საექთნო / NEWS2" or .=="ICU" or .=="საოპერაციო / PACU"))|length')" "80:6"
CODES="doc_admission doc_progress doc_draft doc_discharge doc_cosign doc_consent amb_open med_verify med_rejected med_approve med_verbal med_abx_end mar_due mar_missed consult_todo transfer_in nur_scale nur_line nur_handover nur_obs news2_review icu_sheet icu_bundle icu_sofa or_request or_preop or_ready or_docs or_pacu"
chk "ყველა ახალი წყარო — ?source → 200 (ექიმი / ექთანი / ანესთეზიოლოგი)" "$(for t in DR NA AN; do for c in $CODES; do code GET "/worklist/mine?source=$c" "${!t}"; echo; done; done | sort -u | tr '\n' ' ')" "200 "

step "2. დოკუმენტაცია (ექიმი)"
X=$(it "doc_admission:$E1" "$DR")
chk "doc_admission: მკურნალს (ვადა +24 სთ, ბმული #notes); ხელმძღვანელს / ექთანს / D1-ის სხვა ექიმს — არა" "$(echo "$X" | jq -r '"\(.priority):\(.link|test("#notes"))"'):$(hrs "$X"):$(inm "doc_admission:$E1" "$DH"):$(inm "doc_admission:$E1" "$NA"):$(inm "doc_admission:$E1" "$DX")" "normal:true:24:0:0:0"
api POST "/users/$DXID/disable" "$ADM" -d '{}' >/dev/null
chk "მკურნალი არააქტიურია (E2) → ხელმძღვანელს; D1-ის რიგით ექიმს — არა (ხელმძღვანელი ჰყავს)" "$(inm "doc_admission:$E2" "$DH"):$(inm "doc_admission:$E2" "$DR")" "1:0"
X=$(it "doc_consent:$E1" "$DR")
chk "doc_consent: სავალდებულო თანხმობა (HOSPITALIZATION) აკლია → მკურნალს, მაღალი" "$(echo "$X" | jq -r '"\(.priority):\(.detail|length>0)"')" "high:true"
wl '{"draft_hours":0}'
NID=$(api POST "/inpatient/stays/$E1/notes" "$DR" -d '{"kind":"admission","content":{"complaints":"ტესტ-E2E","objective":"ტესტ-E2E","plan":"ტესტ-E2E"}}' | jq -r '.id // empty')
chk "doc_draft (draft_hours = 0): ავტორს; ხელმძღვანელს — არა" "$(inm "doc_draft:$NID" "$DR"):$(inm "doc_draft:$NID" "$DH")" "1:0"
wl '{"draft_hours":12}'
chk "draft_hours = 12 → ახალი მონახაზი ჯერ არ ჩანს" "$(inm "doc_draft:$NID" "$DR")" "0"
api POST "/inpatient/notes/$NID/sign" "$DR" -d '{}' >/dev/null
chk "მიმღები გასინჯვა ხელმოწერილია → doc_admission ქრება" "$(inm "doc_admission:$E1" "$DR")" "0"
wl '{"sources":{"doc_consent":false}}'
chk "წყარო გამორთულია (doc_consent) → არ ჩანს" "$(inm "doc_consent:$E1" "$DR")" "0"
wl '{"sources":{}}'
modset inpatient '{"epicrisis_cosign":true}' >/dev/null
api POST "/inpatient/stays/$E3/epicrisis" "$DR" >/dev/null
api PUT "/inpatient/stays/$E3/epicrisis" "$DR" -d '{"content":{"anamnesis":"ტესტ-E2E","course":"ტესტ-E2E","treatment":"ტესტ-E2E","state_on_discharge":"დამაკმაყოფილებელი","recommendations":"ტესტ-E2E"}}' >/dev/null
api POST "/encounters/$E3/diagnoses" "$DR" -d '{"icd10_code":"J18.9","diagnosis_type":"primary"}' >/dev/null
ST=$(api POST "/inpatient/stays/$E3/epicrisis/sign" "$DR" | jq -r '.epicrisis.status // .code')
X=$(it "doc_cosign:$E3" "$DH")
chk "doc_cosign: ექიმი აწერს → awaiting_cosign → D1-ის ხელმძღვანელს (+24 სთ); ხელმომწერს — არა" "$ST:$(echo "$X" | jq -r '.link|test("#epicrisis")'):$(hrs "$X"):$(inm "doc_cosign:$E3" "$DR")" "awaiting_cosign:true:24:0"
R=$(api POST "/inpatient/stays/$E3/epicrisis/cosign" "$DH")
if echo "$R" | jq -e '.message? // "" | test("რეკვიზიტ")' >/dev/null 2>&1; then ok "თანახელმოწერა — გამოტოვებულია (კლინიკის რეკვიზიტები არ არის შევსებული — გარემო)"
else chk "თანახელმოწერა → ქრება" "$(echo "$R" | jq -r '.epicrisis.status // .code'):$(inm "doc_cosign:$E3" "$DH")" "signed:0"; fi
modset inpatient '{"epicrisis_cosign":false}' >/dev/null
DCH=$(api POST "/inpatient/stays/$E3/discharge" "$DR" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$NAID\",\"$NBID\"],\"override_reason\":\"ტესტ-E2E\"}" | jq -r '.status // .code // .message')
X=$(it "doc_discharge:$E3" "$DR")
chk "doc_discharge: გაწერილი (თვითნებური) — მკურნალს, მაღალი, ვადა +24 სთ" "$DCH:$(echo "$X" | jq -r .priority):$(hrs "$X")" "discharged:high:24"

step "3. დანიშნულებები"
O_WAR=$(api POST "/inpatient/stays/$E1/orders" "$DR" -d "$(med "$G_WAR" scheduled 5 mg PO QPM)" | jq -r '.id // empty')
X=$(it "med_verify:$O_WAR" "$PH")
chk "med_verify (both): ფარმაცევტს (მაღალი რისკი → მაღალი, +2 სთ) + D1-ის მთავარ ექთანს; ექთანს / ექიმს — არა" "$(echo "$X" | jq -r .priority):$(hrs "$X"):$(inm "med_verify:$O_WAR" "$HN"):$(inm "med_verify:$O_WAR" "$NA"):$(inm "med_verify:$O_WAR" "$DR")" "high:2:1:0:0"
modset inpatient '{"med_verifier":"pharmacist"}' >/dev/null
chk "med_verifier = pharmacist → მთავარ ექთანს — არა" "$(inm "med_verify:$O_WAR" "$HN"):$(inm "med_verify:$O_WAR" "$PH")" "0:1"
modset inpatient '{"med_verifier":"both"}' >/dev/null
api POST "/pharmacy/verification/$O_WAR/reject" "$PH" -d '{"note":"ტესტ-E2E: INR არ არის"}' >/dev/null
X=$(it "med_rejected:$O_WAR" "$DR")
chk "უარი → med_verify ქრება; med_rejected — დამნიშნავს (მაღალი, მიზეზით)" "$(inm "med_verify:$O_WAR" "$PH"):$(echo "$X" | jq -r '"\(.priority):\(.detail|test("INR"))"')" "0:high:true"
api POST "/inpatient/orders/$O_WAR/stop" "$DR" -d '{"reason":"ტესტ-E2E: შეცვლა"}' >/dev/null
chk "შეწყვეტა → med_rejected ქრება" "$(inm "med_rejected:$O_WAR" "$DR")" "0"
O_MER=$(api POST "/inpatient/stays/$E1/orders" "$DR" -d "$(plus "$(med "$G_MER" scheduled 1000 mg IV Q8H)" '{"duration_days":5}')" | jq -r '.id // empty')
chk "med_approve (department): D1-ის ხელმძღვანელს + ფარმაცევტს; მკურნალს — არა" "$(inm "med_approve:$O_MER" "$DH"):$(inm "med_approve:$O_MER" "$PH"):$(inm "med_approve:$O_MER" "$DR")" "1:1:0"
api POST "/inpatient/orders/$O_MER/approve" "$DH" -d '{"note":"ტესტ-E2E"}' >/dev/null
chk "დამტკიცება → ქრება" "$(inm "med_approve:$O_MER" "$DH")" "0"
O_VB=$(api POST "/inpatient/stays/$E1/orders" "$NA" -d "$(plus "$(med "$G_PAR" once 500 mg PO)" "{\"verbal_doctor_id\":\"$DRID\"}")" | jq -r '.id // empty')
X=$(it "med_verbal:$O_VB" "$DR")
chk "med_verbal: ექთანმა შეიყვანა ზეპირი → დამნიშნავ ექიმს (მაღალი, +24 სთ); ექთანს — არა" "$(echo "$X" | jq -r .priority):$(hrs "$X"):$(inm "med_verbal:$O_VB" "$NA")" "high:24:0"
api POST "/inpatient/orders/$O_VB/confirm" "$DR" -d '{}' >/dev/null
chk "დადასტურება → ქრება" "$(inm "med_verbal:$O_VB" "$DR")" "0"
O_CEF=$(api POST "/inpatient/stays/$E1/orders" "$DR" -d "$(plus "$(med "$G_CEF" scheduled 1000 mg IV Q24H)" '{"duration_days":1}')" | jq -r '.id // empty')
chk "med_abx_end: ანტიბიოტიკი სრულდება 24 სთ-ში → მკურნალს; D1-ის მეორე ექიმს — არა" "$(inm "med_abx_end:$O_CEF" "$DR"):$(inm "med_abx_end:$O_CEF" "$DH")" "1:0"
api POST "/inpatient/orders/$O_CEF/stop" "$DR" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "შეწყვეტა → ქრება" "$(inm "med_abx_end:$O_CEF" "$DR")" "0"

step "4. MAR (პაციენტზე)"
O_NOW=$(api POST "/inpatient/stays/$E5/orders" "$DR" -d "$(med "$G_PAR" once 500 mg PO)" | jq -r '.id // empty')
O_OLD=$(api POST "/inpatient/stays/$E6/orders" "$DR" -d "$(plus "$(med "$G_PAR" once 500 mg PO)" "{\"start_at\":\"$(ago '3 hours')\"}")" | jq -r '.id // empty')
M5=$(api GET "/inpatient/stays/$E5/mar" "$NA"); api GET "/inpatient/stays/$E6/mar" "$NA" >/dev/null
X=$(it "mar_due:$E5" "$NA")
chk "mar_due: ახლა შესასრულებელი → D1-ის ექთნებს (NA, NB, მთავარი); D2-ის ექთანს / ექიმს — არა" "$(echo "$X" | jq -r '"\(.priority):\(.link|test("#mar"))"'):$(inm "mar_due:$E5" "$NB"):$(inm "mar_due:$E5" "$HN"):$(inm "mar_due:$E5" "$NX"):$(inm "mar_due:$E5" "$DR")" "normal:true:1:1:0:0"
X=$(it "mar_missed:$E6" "$NA")
chk "mar_missed: 3 სთ-ის წინანდელი დოზა → სასწრაფო; mar_due-ში — არა" "$(echo "$X" | jq -r .priority):$(inm "mar_due:$E6" "$NA")" "urgent:0"
wl '{"nurse_scope":"on_shift"}'
chk "nurse_scope = on_shift: ცვლაში ექთანი არავინაა → განყოფილების ყველა ექთანი" "$(inm "mar_due:$E5" "$NA")" "1"
wl '{"nurse_scope":"department"}'
SL=$(echo "$M5" | jq -r --arg o "$O_NOW" '[.entries[]|select(.order_id==$o and .status=="due")][0].id')
api POST "/inpatient/mar/$SL/document" "$NA" -d '{"outcome":"given"}' >/dev/null
chk "დოზა ჩაიწერა → mar_due ქრება" "$(inm "mar_due:$E5" "$NA")" "0"

step "5. კონსულტაცია / გადმოყვანა"
C1=$(api POST "/inpatient/stays/$E1/consultations" "$DR" -d "{\"target_department_id\":\"$D2\",\"urgency\":\"urgent\",\"question\":\"ტესტ-E2E: ქირურგიული შეფასება\"}" | jq -r '.id // empty')
X=$(it "consult_todo:$C1" "$D2R")
chk "consult_todo (განყოფილება): D2-ის ექიმებს (ორივეს, მაღალი); მომთხოვნს / D1-ს — არა" "$(echo "$X" | jq -r .priority):$(inm "consult_todo:$C1" "$D2H"):$(inm "consult_todo:$C1" "$DR"):$(inm "consult_todo:$C1" "$DH")" "high:1:0:0"
C2=$(api POST "/inpatient/stays/$E1/consultations" "$DR" -d "{\"target_doctor_id\":\"$D2HID\",\"urgency\":\"routine\",\"question\":\"ტესტ-E2E: კონკრეტული ექიმი\"}" | jq -r '.id // empty')
chk "consult_todo (კონკრეტული ექიმი): მხოლოდ მას" "$(inm "consult_todo:$C2" "$D2H"):$(inm "consult_todo:$C2" "$D2R")" "1:0"
api POST "/inpatient/consultations/$C2/cancel" "$DR" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაუქმება → ქრება" "$(inm "consult_todo:$C2" "$D2H")" "0"
api POST "/inpatient/stays/$E5/transfer" "$NA" -d "{\"to_department_id\":\"$D2\",\"reason\":\"ტესტ-E2E: ქირურგია\"}" >/dev/null
TRID=$(api GET "/inpatient/transfers?encounter_id=$E5" "$NA" | jq -r '[.[]|select(.status=="requested")][0].id // empty')
X=$(it "transfer_in:$TRID" "$D2H")
chk "transfer_in (heads): D2-ის ხელმძღვანელს (მაღალი, +2 სთ); D2-ის რიგით ექიმს / ექთანს — არა" "$(echo "$X" | jq -r .priority):$(hrs "$X"):$(inm "transfer_in:$TRID" "$D2R"):$(inm "transfer_in:$TRID" "$NX")" "high:2:0:0"
wl '{"dept_side":"all"}'
chk "dept_side = all → D2-ის ექიმს და ექთანსაც" "$(inm "transfer_in:$TRID" "$D2R"):$(inm "transfer_in:$TRID" "$NX")" "1:1"
wl '{"dept_side":"heads"}'
api POST "/inpatient/transfers/$TRID/cancel" "$NA" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "გაუქმება → ქრება" "$(inm "transfer_in:$TRID" "$D2H")" "0"

step "6. საექთნო / NEWS2"
api POST "/inpatient/stays/$E1/scales" "$NA" -d "{\"scale_code\":\"morse\",\"answers\":{\"history\":0,\"secondary\":1,\"aid\":0,\"iv\":1,\"gait\":0,\"mental\":0},\"assessed_at\":\"$(ago '23 hours')\"}" >/dev/null
X=$(it "nur_scale:$E1" "$NA")
chk "nur_scale: Morse-ის ვადა ≤ 2 სთ → ექთანს (სათაურში Morse, Braden — არა); ექიმს — არა" "$(echo "$X" | jq -r '"\(.title|test("Morse")):\(.title|test("Braden"))"'):$(inm "nur_scale:$E1" "$DR")" "true:false:0"
api POST "/inpatient/stays/$E1/scales" "$NA" -d '{"scale_code":"morse","answers":{"history":0,"secondary":1,"aid":0,"iv":1,"gait":0,"mental":0}}' >/dev/null
chk "შეფასება → ქრება" "$(inm "nur_scale:$E1" "$NA")" "0"
PVC=$(api POST "/inpatient/stays/$E1/lines" "$NA" -d "{\"kind\":\"pvc\",\"site\":\"მარცხენა მაჯა\",\"inserted_at\":\"$(ago '100 hours')\",\"inserted_where\":\"მიმღები\"}" | jq -r '.id // empty')
X=$(it "nur_line:$PVC" "$NA")
chk "nur_line: PVC 100 სთ (ზღვარი 96) → ექთანს + მკურნალს; D2-ის ექთანს — არა" "$(echo "$X" | jq -r '"\(.priority):\(.title|test("4 დღე"))"'):$(inm "nur_line:$PVC" "$DR"):$(inm "nur_line:$PVC" "$NX")" "normal:true:1:0"
chk "„საჭიროება შეფასდა“: D2-ის ექთანი — 403; ამოღებულზე — (შემდეგ) 409" "$(code POST "/inpatient/lines/$PVC/review" "$NX" -d '{}')" "403"
R=$(api POST "/inpatient/lines/$PVC/review" "$NA" -d '{"note":"ტესტ-E2E: თერაპია გრძელდება"}')
chk "„საჭიროება შეფასდა“ → ქრება (ექთანთან და ექიმთან); ხაზზე reviewed_at / ავტორი; ისტორიაში line_reviewed" "$(echo "$R" | jq -r '.reviewed_at!=null'):$(inm "nur_line:$PVC" "$NA"):$(inm "nur_line:$PVC" "$DR"):$(api GET "/inpatient/stays/$E1/nursing" "$NA" | jq -r --arg p "$PVC" '.lines[]|select(.id==$p)|.reviewed_by_name|test("კლ-35")'):$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|index("line_reviewed")!=null')" "true:0:0:true:true"
api POST "/inpatient/lines/$PVC/remove" "$NA" -d '{"reason":"ტესტ-E2E"}' >/dev/null
chk "ამოღებულზე შეფასება — 409" "$(code POST "/inpatient/lines/$PVC/review" "$NA" -d '{}')" "409"
HO=$(api POST "/inpatient/stays/$E1/nursing-notes" "$NA" -d '{"kind":"handover","sbar":{"s":"ტესტ-E2E","b":"ტესტ","a":"ტესტ","r":"ტესტ"}}' | jq -r '.id // empty')
chk "nur_handover: სხვა ექთანს (NB); ავტორს / D2-ს — არა" "$(inm "nur_handover:$HO" "$NB"):$(inm "nur_handover:$HO" "$NA"):$(inm "nur_handover:$HO" "$NX")" "1:0:0"
api POST "/inpatient/nursing-notes/$HO/ack" "$NB" >/dev/null
chk "მიღება → ქრება" "$(inm "nur_handover:$HO" "$NB")" "0"
LOWV='{"respiratory_rate":22,"spo2":96,"o2_supplement":false,"systolic_bp":125,"diastolic_bp":80,"heart_rate":95,"consciousness":"A","temperature":37.5}'
api POST "/inpatient/stays/$E2/vitals" "$NA" -d "$(echo "$LOWV" | jq -c --arg t "$(ago '5 hours')" '. + {recorded_at:$t}')" >/dev/null
X=$(it "nur_obs:$E2" "$NA")
chk "nur_obs: NEWS2 1–4, ბოლო გაზომვა 5 სთ-ის წინ (სიხშირე 4 სთ) → ექთანს, ვადაგადაცილებული" "$(echo "$X" | jq -r '"\(.overdue):\(.priority):\(.detail|test("4 სთ"))"')" "true:normal:true"
wl '{"obs_minutes":{"zero":720,"low":480,"low_red":60,"medium":60,"high":30}}'
chk "obs_minutes.low = 480 → ჯერ არა" "$(inm "nur_obs:$E2" "$NA")" "0"
wl '{"obs_minutes":{"zero":720,"low":240,"low_red":60,"medium":60,"high":30}}'
api POST "/inpatient/stays/$E2/vitals" "$NA" -d "$LOWV" >/dev/null
chk "ახალი გაზომვა → ქრება" "$(inm "nur_obs:$E2" "$NA")" "0"
BADV='{"respiratory_rate":26,"spo2":90,"o2_supplement":true,"o2_flow":4,"systolic_bp":95,"diastolic_bp":60,"heart_rate":120,"consciousness":"A","temperature":39.5}'
VB=$(api POST "/inpatient/stays/$E1/vitals" "$NA" -d "$BADV" | jq -r '.id // empty')
X=$(it "news2_review:$VB" "$DR")
chk "news2_review: NEWS2 14 → მკურნალს (სასწრაფო, ~30 წთ) + ხელმძღვანელს (≥ სასწრაფო ზღვარი); ექთანს — არა" "$(echo "$X" | jq -r '"\(.priority):\(.title|test("NEWS2 14"))"'):$(echo "$X" | jq -r '(((.due_at|sub("\\.[0-9]+Z$";"Z")|fromdate) - now) / 60) | (. > 20 and . <= 31)'):$(inm "news2_review:$VB" "$DH"):$(inm "news2_review:$VB" "$NA")" "urgent:true:true:1:0"
chk "nursing: can_review_news2 — ექიმს true, ექთანს false; შეფასება: ექთანი — 403, უცნობი ქმედება — 400, „სხვა“ შენიშვნის გარეშე — 400" "$(api GET "/inpatient/stays/$E1/nursing" "$DR" | jq -r .can_review_news2):$(api GET "/inpatient/stays/$E1/nursing" "$NA" | jq -r .can_review_news2):$(code POST "/inpatient/vitals/$VB/news2-review" "$NA" -d '{"action":"monitor"}'):$(code POST "/inpatient/vitals/$VB/news2-review" "$DR" -d '{"action":"x"}'):$(code POST "/inpatient/vitals/$VB/news2-review" "$DR" -d '{"action":"other"}')" "true:false:403:400:400"
R=$(api POST "/inpatient/vitals/$VB/news2-review" "$DR" -d '{"action":"escalated","note":"ტესტ-E2E: რეანიმაციის კონსულტაცია"}')
chk "მკურნალი აფასებს → ქრება ორივესთან; მეორედ — 409; ისტორიაში news2_reviewed; nursing-ში შეფასება" "$(echo "$R" | jq -r '"\(.score):\(.action)"'):$(inm "news2_review:$VB" "$DR"):$(inm "news2_review:$VB" "$DH"):$(code POST "/inpatient/vitals/$VB/news2-review" "$DH" -d '{"action":"monitor"}'):$(api GET "/inpatient/stays/$E1" "$DR" | jq -r '[.events[].kind]|index("news2_reviewed")!=null'):$(api GET "/inpatient/stays/$E1/nursing" "$NA" | jq -r '.news2_reviews[0].action_ka|test("ესკალაცია")')" "14:escalated:0:0:409:true:true"
VB2=$(api POST "/inpatient/stays/$E1/vitals" "$NA" -d "$BADV" | jq -r '.id // empty')
chk "იგივე დონე 4 სთ-ში — ახალი ჩანაწერი არა" "$(inm "news2_review:$VB2" "$DR")" "0"
api POST "/inpatient/stays/$E1/vitals" "$NA" -d "$LOWV" >/dev/null
chk "შემდეგი გაზომვა ზღვარს ქვემოთ — ჩანაწერი არა" "$(api GET "/worklist/mine?source=news2_review" "$DR" | jq -r --arg e "$E1" '[.items[]|select(.link|test($e))]|length')" "0"

step "7. ICU"
api POST "/inpatient/stays/$E4/lines" "$NI" -d '{"kind":"cvc","site":"v. jugularis interna dextra","size":"7Fr"}' >/dev/null
X=$(it "icu_bundle:$E4" "$NI")
chk "icu_bundle: ცენტრ. ვენა → CLABSI — ICU-ს ექთანს; D1-ის ექთანს — არა" "$(echo "$X" | jq -r '"\(.title|test("CLABSI")):\(.title|test("VAP"))"'):$(inm "icu_bundle:$E4" "$NA")" "true:false:0"
IV=$(api GET "/inpatient/stays/$E4/icu" "$NI")
ANSW=$(echo "$IV" | jq -c '[.bundle_items[]|select(.bundle=="clabsi")|{key:.id,value:"yes"}]|from_entries')
api POST "/inpatient/stays/$E4/icu/bundles" "$NI" -d "{\"bundle\":\"clabsi\",\"answers\":$ANSW}" >/dev/null
chk "bundle ჩაიწერა → ქრება" "$(inm "icu_bundle:$E4" "$NI")" "0"

step "8. საოპერაციო / PACU"
RO=$(api POST /or/rooms "$ADM" -d "{\"department_id\":\"$DBK\",\"code\":\"WC$S\",\"name\":\"ტესტ-E2E WC ოთახი\",\"work_start\":\"00:00\",\"work_end\":\"23:59\",\"work_days\":[1,2,3,4,5,6,7]}" | jq -r '.id // empty')
PR=$(api POST /or/procedures "$ADM" -d "{\"code\":\"E2E-WC-$S\",\"name\":\"ტესტ-E2E WC ოპერაცია\",\"specialty_code\":\"general\",\"default_duration_min\":30}" | jq -r '.id // empty')
CS=$(api POST /or/cases "$DR" -d "{\"encounter_id\":\"$E5\",\"urgency\":\"elective\",\"anesthesia_type\":\"general\",\"procedures\":[{\"procedure_id\":\"$PR\",\"is_primary\":true}]}" | jq -r '.id // empty')
[ -n "$RO" ] && [ -n "$PR" ] && [ -n "$CS" ] && echo "$CS" >> "$TMP/cases" || die "ოპერაციის მოთხოვნა ვერ შეიქმნა"
chk "or_request (coordinator): კოორდინატორს; ქირურგს — არა (კოორდინატორი არის)" "$(inm "or_request:$CS" "$CO"):$(inm "or_request:$CS" "$DR")" "1:0"
chk "დაგეგმვა (+3 სთ)" "$(api POST "/or/cases/$CS/schedule" "$CO" -d "{\"room_id\":\"$RO\",\"start\":\"$(N -180)\",\"duration_min\":30,\"confirm\":true}" | jq -r '.status // .message')" "scheduled"
chk "დაგეგმვის შემდეგ or_request ქრება" "$(inm "or_request:$CS" "$CO")" "0"
X=$(it "or_preop:$CS" "$AN")
api POST "/or/cases/$CS/team" "$ADM" -d "{\"role_code\":\"anesthesiologist\",\"user_id\":\"$ANID\"}" >/dev/null
X=$(it "or_preop:$CS" "$AN")
chk "or_preop: გუნდის ანესთეზიოლოგს, მაღალი, ?tab=preop" "$(echo "$X" | jq -r '"\(.priority):\(.link|test("tab=preop"))"')" "high:true"
X=$(it "or_ready:$CS" "$DH")
chk "or_ready (heads): ქირურგიული განყოფილების (D1) ხელმძღვანელს — აკლია თანხმობა / შეფასება; ქირურგს / ექთანს — არა" "$(echo "$X" | jq -r '.detail|test("თანხმობა")'):$(inm "or_ready:$CS" "$DR"):$(inm "or_ready:$CS" "$NA")" "true:0:0"
WHO() { api GET "/or/cases/$CS" "$ON" | jq -c --arg p "$1" '[.who_items[]|select(.phase==$p)|{key:.id,value:"yes"}]|from_entries'; }
TM() { api POST "/or/cases/$CS/times" "$1" -d "$2" >/dev/null; }
TM "$ON" "{\"kind\":\"in_room\",\"at\":\"$(T 120)\",\"readiness_override\":\"ტესტ-E2E\"}"
TM "$AN" "{\"kind\":\"anesthesia_start\",\"at\":\"$(T 115)\"}"
api POST "/or/cases/$CS/who" "$ON" -d "{\"phase\":\"sign_in\",\"answers\":$(WHO sign_in)}" >/dev/null
api POST "/or/cases/$CS/who" "$DR" -d "{\"phase\":\"time_out\",\"answers\":$(WHO time_out)}" >/dev/null
TM "$DR" "{\"kind\":\"incision\",\"at\":\"$(T 105)\"}"; TM "$DR" "{\"kind\":\"closure\",\"at\":\"$(T 80)\"}"; TM "$AN" "{\"kind\":\"anesthesia_end\",\"at\":\"$(T 75)\"}"
api POST "/or/cases/$CS/who" "$ON" -d "{\"phase\":\"sign_out\",\"answers\":$(WHO sign_out)}" >/dev/null
TM "$ON" "{\"kind\":\"out_of_room\",\"at\":\"$(T 70)\",\"destination\":\"pacu\"}"
chk "ოპერაცია დასრულდა → or_preop / or_ready ქრება" "$(api GET "/or/cases/$CS" "$ON" | jq -r '.case.status // .status'):$(inm "or_preop:$CS" "$AN"):$(inm "or_ready:$CS" "$DH")" "completed:0:0"
X=$(it "or_docs:$CS" "$DR")
chk "or_docs: ოქმი — ქირურგს (?tab=note); ანესთეზიის რუკა — ანესთეზიოლოგს" "$(echo "$X" | jq -r '"\(.title|test("ოქმი")):\(.link|test("tab=note"))"'):$(api GET "/worklist/mine?source=or_docs" "$AN" | jq -r --arg k "or_docs:$CS" '[.items[]|select(.key==$k)][0].title|test("ანესთეზიის რუკა")')" "true:true:true"
api POST "/or/cases/$CS/pacu/admit" "$ON" -d "{\"at\":\"$(T 65)\",\"nurse_id\":\"$ONID\",\"bay\":\"P-1\"}" >/dev/null
X=$(it "or_pacu:$CS" "$ON")
chk "or_pacu: PACU-ს ექთანს (?tab=pacu); ანესთეზიოლოგს — ჯერ არა (არ არის მზად / დიდხანს)" "$(echo "$X" | jq -r '"\(.priority):\(.link|test("tab=pacu"))"'):$(inm "or_pacu:$CS" "$AN")" "normal:true:0"
api POST "/or/cases/$CS/pacu/scores" "$ON" -d "{\"at\":\"$(T 60)\",\"activity\":2,\"respiration\":2,\"circulation\":2,\"consciousness\":2,\"oxygenation\":2,\"pain\":2}" >/dev/null
chk "Aldrete 10 → „გასაწერად მზადაა“ (მაღალი) — ექთანს + ანესთეზიოლოგს" "$(it "or_pacu:$CS" "$ON" | jq -r '"\(.priority):\(.title|test("მზადაა"))"'):$(inm "or_pacu:$CS" "$AN")" "high:true:1"
api POST "/or/cases/$CS/pacu/discharge" "$ON" -d "{\"destination\":\"ward\",\"at\":\"$(T 45)\"}" >/dev/null
chk "PACU-დან გაწერა → ქრება" "$(inm "or_pacu:$CS" "$ON")" "0"

step "9. admin, diagnostics"
chk "admin-ს (მხოლოდ admin) კლინიკურ წყაროებში არაფერი" "$(api GET /worklist/mine "$ADM" | jq -r --arg c "$CODES" '($c|split(" ")) as $l | [.items[]|select(.source as $s | $l|index($s))]|length')" "0"
DG=$(api GET "/worklist/check/diagnostics?include_test=1" "$ADM")
ADM2=$(api GET "/inpatient/stays/$E2" "$DH" | jq -r '.stay.adm_no // .adm_no')
chk "diagnostics: NO_ATTENDING — E2 (მკურნალი გათიშულია); nurse_scope ჩანს" "$(echo "$DG" | jq -r --arg p "$ADM2 " '[.issues[]|select(.code=="NO_ATTENDING")|.items[]|select(startswith($p))]|length'):$(echo "$DG" | jq -r .nurse_scope)" "1:department"
chk "diagnostics: DEPT_NO_NURSE — რეანიმაცია არა (ექთანი ჰყავს); ICU ექთნის გათიშვის გარეშე" "$(echo "$DG" | jq -r --arg d "ტესტ-E2E WC რეანიმაცია $S" '[.issues[]|select(.code=="DEPT_NO_NURSE")|.items[]|select(.==$d)]|length')" "0"
modset inpatient '{"epicrisis_cosign":true}' >/dev/null
chk "diagnostics: epicrisis_cosign + რეანიმაცია ხელმძღვანელის გარეშე → NO_EPI_COSIGNER" "$(api GET "/worklist/check/diagnostics?include_test=1" "$ADM" | jq -r --arg d "ტესტ-E2E WC რეანიმაცია $S" '[.issues[]|select(.code=="NO_EPI_COSIGNER")|.items[]|select(.==$d)]|length')" "1"
modset inpatient '{"epicrisis_cosign":false}' >/dev/null
chk "preview: ექიმის სია admin-ის მხრიდან = მისი საკუთარი (ჯამი)" "$(api GET "/worklist/check/preview/$DRID" "$ADM" | jq -r '.totals.total'):$(api GET /worklist/mine "$DR" | jq -r '.totals.total')" "$(api GET /worklist/mine "$DR" | jq -r '.totals.total'):$(api GET /worklist/mine "$DR" | jq -r '.totals.total')"

step "10. გასუფთავება"
[ -f "$TMP/cases" ] && while read -r c; do api POST "/or/cases/$c/cancel" "$CO" -d '{"reason_code":"other","note":"ტესტ-E2E"}' >/dev/null; done < "$TMP/cases"
# ჰოსპიტალიზაცია: გაუქმება (თუ შესაძლებელია), თორემ გაწერა (თვითნებური) — საწოლები თავისუფლდება
[ -f "$TMP/stays" ] && while read -r e; do
  [ "$(code POST "/inpatient/stays/$e/cancel" "$ADM" -d '{"reason":"ტესტ-E2E დასრულება"}')" = "200" ] || \
    api POST "/inpatient/stays/$e/discharge" "$ADM" -d "{\"type\":\"against_advice\",\"refusal_witnesses\":[\"$NAID\",\"$NBID\"],\"override_reason\":\"ტესტ-E2E დასრულება\"}" >/dev/null
done < "$TMP/stays"
for m in worklist inpatient icu or; do api PUT "/modules/$m" "$ADM" -d "$(orig $m | jq -c '{enabled, settings, reason:"ტესტ-E2E: დაბრუნება"}')" >/dev/null; done
[ "$SCRUB_EN" = "true" ] && api PUT /modules/scrubber "$ADM" -d '{"enabled":true,"reason":"ტესტ-E2E: დაბრუნება"}' >/dev/null
chk "პარამეტრები აღდგენილია (worklist)" "$(api GET /modules "$ADM" | jq -c '.[]|select(.code=="worklist")|{enabled, settings}')" "$(orig worklist)"
[ -n "${RO:-}" ] && api PATCH "/or/rooms/$RO" "$ADM" -d '{"is_active":false}' >/dev/null
[ -f "$TMP/users" ] && while read -r u; do api POST "/users/$u/disable" "$ADM" -d '{}' >/dev/null; done < "$TMP/users"
[ -f "$TMP/roles" ] && while read -r r; do api PATCH "/roles/$r" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/roles"
[ -f "$TMP/deps" ] && while read -r d; do api PATCH "/departments/$d" "$ADM" -d '{"is_active":false}' >/dev/null; done < "$TMP/deps"
ok "სატესტო ჩანაწერები გაუქმებულია / გათიშულია"

printf '\n\033[1mშედეგი: %d ✓  %d ✗\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
