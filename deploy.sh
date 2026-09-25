#!/usr/bin/env bash
# deploy.sh — patch-ის დადება და განახლება ერთი ბრძანებით (dev / პილოტი)
#   bash deploy.sh ~/patches/0016-….patch      — patch + build + შემოწმება
#   bash deploy.sh                             — მხოლოდ build + შემოწმება (კოდი უკვე განახლებულია)
# ნებისმიერ შეცდომაზე ჩერდება.
set -euo pipefail
cd "$(dirname "$0")"
DC="docker compose -f docker-compose.dev.yml -f docker-compose.app.yml"
say() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

if [ -n "${1:-}" ]; then
  say "patch: $1"
  [ -f "$1" ] || die "ფაილი ვერ მოიძებნა: $1"
  git apply --check "$1" || die "patch არ ჯდება (იხ. ზემოთ). ხომ არ არის უკვე დადებული ან წინა patch აკლია?"
  git apply -v "$1"
fi

EXPECTED=$(ls emr-backend/migrations/*.sql | sed -E 's#.*/([0-9]{4})_.*#\1#' | sort | tail -1)
say "build + გაშვება (მოსალოდნელი სქემა: $EXPECTED)"
$DC up -d --build

say "შემოწმება"
for i in $(seq 1 30); do H=$(curl -s localhost/api/health || true); [ -n "$H" ] && echo "$H" | grep -q '"status":"ok"' && break; sleep 2; done
echo "$H"
echo "$H" | grep -q "\"schemaVersion\":\"$EXPECTED\"" || { docker logs emr-migrate --tail 20; die "სქემა არ არის $EXPECTED"; }
printf '\033[32m✓\033[0m backend + სქემა %s\n' "$EXPECTED"
# frontend: build-ში უნდა იყოს ყველაზე ახალი წყაროს ფაილის ნაკვალევი — index.html-ის ჰეში უნდა შეიცვალოს
NEW=$(docker exec emr-frontend sh -c 'ls /usr/share/nginx/html/assets/index-*.js' | head -1)
[ -n "$NEW" ] || die "frontend build ვერ მოიძებნა კონტეინერში"
printf '\033[32m✓\033[0m frontend: %s\n' "$(basename "$NEW")"
say "მზადაა — ბრაუზერში Ctrl+Shift+R. არ დაგავიწყდეს: git add -A && git commit"
