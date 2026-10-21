#!/usr/bin/env bash
# =====================================================================
# run-tests.sh — რამდენიმე e2e ტესტის გაშვება ერთი შესვლით, შედეგები ბოლოს ერთად
#
#   bash scripts/run-tests.sh ipc ipc-hai inpatient          # სახელები (e2e- / .sh — არასავალდებულო)
#   bash scripts/run-tests.sh 'ipd-*' 'quality*'             # შაბლონები
#   bash scripts/run-tests.sh --all                          # ყველა e2e-*.sh + smoke-form100
#   bash scripts/run-tests.sh --all -x lab-mail-imap -x 'lab-gateway*'   # გამოკლებით
#   bash scripts/run-tests.sh -u http://localhost/api ipc    # API მისამართი (ნაგულისხმევი — სკრიპტების)
#
# ელ-ფოსტა / პაროლი იკითხება ერთხელ (ან ADMIN_EMAIL / ADMIN_PW გარემოდან), მოწმდება და გადაეცემა ყველა ტესტს.
# პაროლი არსად იბეჭდება და ლოგში არ იწერება. თითო ტესტის სრული ლოგი — LOG_DIR-ში (ნაგულისხმევად /tmp/emr-tests-<დრო>).
# გასვლის კოდი: 0 — ყველა გავიდა, 1 — რომელიმე ჩავარდა.
# =====================================================================
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"; cd "$(dirname "$SELF")"

URL=""; ALL=0; PATS=(); EXCL=()
while [ $# -gt 0 ]; do
  case "$1" in
    -u|--url) URL="$2"; shift 2 ;;
    -x|--exclude) EXCL+=("$2"); shift 2 ;;
    --all) ALL=1; shift ;;
    -h|--help) sed -n '3,13p' "$SELF"; exit 0 ;;
    *) PATS+=("$1"); shift ;;
  esac
done
[ $ALL = 1 ] || [ ${#PATS[@]} -gt 0 ] || { sed -n '3,13p' "$SELF"; exit 2; }
command -v jq >/dev/null || { echo "jq არ არის დაყენებული"; exit 2; }

norm() { local n="${1%.sh}"; n="${n#e2e-}"; [ "$n" = "smoke-form100" ] && echo "$n" || echo "e2e-$n"; }
LIST=()
if [ $ALL = 1 ]; then for f in e2e-*.sh smoke-form100.sh; do [ -f "$f" ] && LIST+=("${f%.sh}"); done; fi
for p in "${PATS[@]}"; do
  n=$(norm "$p"); found=0
  for f in $n.sh; do [ -f "$f" ] && { LIST+=("${f%.sh}"); found=1; }; done
  [ $found = 1 ] || { echo "ტესტი ვერ მოიძებნა: $p"; exit 2; }
done
FINAL=()
for t in "${LIST[@]}"; do
  skip=0; for x in "${EXCL[@]}"; do x=$(norm "$x"); [[ "$t" == $x ]] && skip=1; done
  [[ " ${FINAL[*]} " == *" $t "* ]] && skip=1
  [ $skip = 1 ] || FINAL+=("$t")
done
[ ${#FINAL[@]} -gt 0 ] || { echo "გასაშვები ტესტი არ არის"; exit 2; }

# --- ერთჯერადი შესვლა
[ -n "${ADMIN_EMAIL:-}" ] || read -rp  "admin ელ-ფოსტა: " ADMIN_EMAIL
[ -n "${ADMIN_PW:-}" ]    || { read -rsp "admin პაროლი: " ADMIN_PW; echo; }
CHECK="${URL:-http://localhost/api}"
TOK=$(curl -s -X POST "$CHECK/auth/login" -H 'content-type: application/json' \
  -d "$(jq -nc --arg u "$ADMIN_EMAIL" --arg p "$ADMIN_PW" '{username:$u,password:$p}')" | jq -r '.accessToken // empty' 2>/dev/null)
[ -n "$TOK" ] || { printf '\033[31mშესვლა ვერ მოხერხდა (%s) — შეამოწმეთ ელ-ფოსტა / პაროლი ან -u\033[0m\n' "$CHECK"; exit 2; }
unset TOK
export ADMIN_EMAIL ADMIN_PW
[ -n "$URL" ] && export API="$URL"

LOG_DIR="${LOG_DIR:-/tmp/emr-tests-$(date +%Y%m%d-%H%M%S)}"; mkdir -p "$LOG_DIR"; chmod 700 "$LOG_DIR"
TO=""; command -v timeout >/dev/null && TO="timeout ${TEST_TIMEOUT:-1200}"
strip() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }

N=${#FINAL[@]}; i=0; T0=$(date +%s)
declare -A RES DUR
printf '\033[1m%d ტესტი\033[0m · ლოგები: %s\n' "$N" "$LOG_DIR"
for t in "${FINAL[@]}"; do
  i=$((i+1)); s=$(date +%s)
  printf '  [%2d/%d] %-28s ' "$i" "$N" "$t"
  if [ -n "$URL" ]; then $TO bash "$t.sh" "$URL" < /dev/null > "$LOG_DIR/$t.log" 2>&1; else $TO bash "$t.sh" < /dev/null > "$LOG_DIR/$t.log" 2>&1; fi
  rc=$?; d=$(( $(date +%s) - s )); DUR[$t]=$d
  txt=$(strip "$LOG_DIR/$t.log")
  line=$(grep -E "შედეგი:" <<< "$txt" | tail -1)
  p=""; f=""
  if [[ "$line" =~ ([0-9]+)\ ✓\ +([0-9]+)\ ✗ ]] || [[ "$line" =~ ([0-9]+)\ გავიდა,\ ([0-9]+)\ ჩავარდა ]]; then p=${BASH_REMATCH[1]}; f=${BASH_REMATCH[2]}; fi
  if [ -n "$p" ]; then
    if [ "$f" = 0 ] && [ $rc = 0 ]; then RES[$t]="OK|$p ✓"; else RES[$t]="FAIL|$p ✓  $f ✗"; fi
  elif [ $rc = 0 ] && grep -q "✔" <<< "$txt"; then RES[$t]="OK|✔"
  elif [ $rc = 124 ]; then RES[$t]="FAIL|დრო ამოიწურა"
  elif grep -q "შეწყდა:" <<< "$txt"; then RES[$t]="STOP|$(grep -m1 "შეწყდა:" <<< "$txt" | sed 's/.*შეწყდა: *//' | cut -c1-90)"
  else RES[$t]="FAIL|rc=$rc"; fi
  case "${RES[$t]%%|*}" in OK) printf '\033[32m✓\033[0m %ss\n' "$d" ;; STOP) printf '\033[33m■\033[0m %ss\n' "$d" ;; *) printf '\033[31m✗\033[0m %ss\n' "$d" ;; esac
done

# --- შეჯამება
TOT=$(( $(date +%s) - T0 )); okc=0; failc=0; stopc=0
printf '\n\033[1m════════ შედეგები (%d ტესტი, %dწთ %dწმ) ════════\033[0m\n' "$N" $((TOT/60)) $((TOT%60))
for t in "${FINAL[@]}"; do
  st=${RES[$t]%%|*}; msg=${RES[$t]#*|}
  case $st in OK) okc=$((okc+1)); c='\033[32m✓\033[0m' ;; STOP) stopc=$((stopc+1)); c='\033[33m■\033[0m' ;; *) failc=$((failc+1)); c='\033[31m✗\033[0m' ;; esac
  printf "  $c %-28s %s\n" "$t" "$msg"
done
if [ $failc -gt 0 ] || [ $stopc -gt 0 ]; then
  printf '\n\033[1mდეტალები\033[0m\n'
  for t in "${FINAL[@]}"; do
    st=${RES[$t]%%|*}; [ "$st" = OK ] && continue
    printf '\n\033[1m%s\033[0m (%s)\n' "$t" "$LOG_DIR/$t.log"
    strip "$LOG_DIR/$t.log" | grep -E -A1 "^\s*✗|შეწყდა:" | grep -v '^--$' | head -20 | sed 's/^/    /'
    [ "$st" = FAIL ] && ! strip "$LOG_DIR/$t.log" | grep -qE "^\s*✗|შეწყდა:" && strip "$LOG_DIR/$t.log" | tail -8 | sed 's/^/    /'
  done
fi
printf '\n\033[1mსულ: \033[32m%d გავიდა\033[0m' "$okc"
[ $failc -gt 0 ] && printf ', \033[31m%d ჩავარდა\033[0m' "$failc"
[ $stopc -gt 0 ] && printf ', \033[33m%d შეწყდა (გარემო / კონფიგურაცია)\033[0m' "$stopc"
printf '\n'
[ $failc = 0 ] && [ $stopc = 0 ]
