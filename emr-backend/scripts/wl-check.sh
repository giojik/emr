#!/usr/bin/env bash
# =====================================================================
# wl-check.sh — სამუშაო სიები: რეალური ანგარიშების შემოწმება (0082b). მხოლოდ წაკითხვა — არაფერს ქმნის / ცვლის.
#   1) კონფიგურაციის ხარვეზები, რომლებზეც სისტემური ჩანაწერის ადრესატი დგას: განყოფილება ხელმძღვანელის გარეშე, ქვესაწყობი
#      დამტკიცებით, მაგრამ დამმტკიცებლის გარეშე, ექთანი / ექიმი განყოფილების გარეშე, CSSD თანამშრომლის გარეშე, უფლება ადრესატის გარეშე;
#   2) თითო აქტიურ მომხმარებელზე (სატესტო @test.local-ის გარდა) — „ჩემი დავალებები“ იმავე წესით, რაც მას თავად უჩანს:
#      ჯამი / ვადაგადაცილებული / სასწრაფო + წყაროები რაოდენობით. ნახვა აუდიტში იწერება (WL_PREVIEW).
# გამოყენება:  bash scripts/wl-check.sh [API_URL] [-v]        (-v — ჩანაწერების სათაურებიც, თითო წყაროზე ≤ 3)
#              FILTER='ექთ' bash scripts/wl-check.sh             (მხოლოდ სახელით / ელფოსტით / განყოფილებით)
#              TEST=1 bash scripts/wl-check.sh                   (სატესტო @test.local / „ტესტ-E2E“ ჩანაწერებიც)
# =====================================================================
set -uo pipefail
B="http://localhost/api"; V=0
for a in "$@"; do case "$a" in -v) V=1 ;; *) B="$a" ;; esac; done
B="${API:-$B}"
J='content-type: application/json'
command -v jq >/dev/null || { echo "jq არ არის დაყენებული"; exit 2; }
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
T=$(curl -s -X POST "$B/auth/login" -H "$J" -d "$(jq -nc --arg u "$ADMIN_EMAIL" --arg p "$ADMIN_PW" '{username:$u,password:$p}')" | jq -r '.accessToken // empty')
[ -n "$T" ] || { echo "admin-ით შესვლა ვერ მოხერხდა ($B)"; exit 2; }
api() { curl -s "$B$1" -H "authorization: Bearer $T"; }
QT=""; [ "${TEST:-0}" = "1" ] && QT="?include_test=1"

printf '\n\033[1m1. კონფიგურაცია\033[0m\n'
D=$(api "/worklist/check/diagnostics$QT")
echo "$D" | jq -e '.issues' >/dev/null 2>&1 || { echo "  ✗ /worklist/check/diagnostics: $(echo "$D" | head -c 300)"; exit 1; }
echo "  dept_side = $(echo "$D" | jq -r .dept_side) · reg_scope = $(echo "$D" | jq -r .reg_scope)"
if [ "$(echo "$D" | jq '.issues|length')" = "0" ]; then printf '  \033[32m✓\033[0m ხარვეზი არ არის\n'; fi
echo "$D" | jq -r '.issues[] | (if .level=="error" then "\u001b[31m✗\u001b[0m" elif .level=="warn" then "\u001b[33m!\u001b[0m" else "\u001b[36mi\u001b[0m" end) + " " + .message + "\n" + ([.items[] | "      · " + .] | join("\n")) + (if (.total // 0) > (.items|length) then "\n      … და კიდევ \(.total - (.items|length))" else "" end)' | sed 's/^/  /'

printf '\n\033[1m2. მომხმარებლები — „ჩემი დავალებები“\033[0m\n'
U=$(api "/worklist/check/users$QT")
[ -n "${FILTER:-}" ] && U=$(echo "$U" | jq -c --arg f "$FILTER" '[.[]|select((.name+" "+.email+" "+(.department_name//""))|test($f;"i"))]')
N=$(echo "$U" | jq length); EMPTY=0
for i in $(seq 0 $((N-1))); do
  ID=$(echo "$U" | jq -r ".[$i].id")
  P=$(api "/worklist/check/preview/$ID")
  NAME=$(echo "$U" | jq -r ".[$i] | \"\(.name) <\(.email)>\"")
  META=$(echo "$U" | jq -r ".[$i] | \"\(.department_name // \"განყოფილების გარეშე\")\(if .is_section_head then \" · ხელმძღვანელი\" else \"\" end) · \((.capabilities // [])|join(\",\"))\"")
  TOT=$(echo "$P" | jq -r '.totals | "\(.total) · ვადაგადაც. \(.overdue) · სასწრ. \(.urgent)"')
  printf '\n  \033[1m%s\033[0m — %s\n    %s\n' "$NAME" "$TOT" "$META"
  if [ "$(echo "$P" | jq '.totals.total')" = "0" ]; then EMPTY=$((EMPTY+1)); echo "    (სია ცარიელია)"; continue; fi
  echo "$P" | jq -r '.sources[] | "    · \(.group) — \(.name): \(.count)\(if .overdue>0 then " (ვადაგადაც. \(.overdue))" else "" end)"'
  [ $V = 1 ] && echo "$P" | jq -r '[.items|group_by(.source)[]|.[0:3][]] | .[] | "        – [\(.source)] \(.title)\(if .overdue then " ⚠" else "" end)"'
done
printf '\n\033[1mსულ:\033[0m %d მომხმარებელი, აქედან ცარიელი სიით — %d\n' "$N" "$EMPTY"
