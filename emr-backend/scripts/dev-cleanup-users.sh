#!/usr/bin/env bash
# =====================================================================
# dev-cleanup-users.sh (0086, N) — e2e-ის ნარჩენი სატესტო მომხმარებლების გათიშვა (is_active = false), არა წაშლა (აუდიტი / FK რჩება).
#
#   bash scripts/dev-cleanup-users.sh                 # --dry-run (ნაგულისხმევი): რამდენი / ვინ გაითიშება
#   bash scripts/dev-cleanup-users.sh --apply         # გათიშვა (ერთი ტრანზაქცია + აუდიტი DEV_CLEANUP_USERS)
#   bash scripts/dev-cleanup-users.sh --days 3        # ზღვარი (ნაგულისხმევი 7): შექმნა და ბოლო შესვლა N დღეზე ძველია
#
# ვინ: ელფოსტა `e2e.%@test.local` (e2e სკრიპტების ნიმუში), აქტიური, შექმნილია > N დღის წინ და ბოლო შესვლა არ ყოფილა ან > N დღის წინ იყო.
# მუშაობს მხოლოდ NODE_ENV ≠ production-ზე (emr-backend კონტეინერის გარემო). admin და სხვა ნამდვილი ანგარიშები არ ეხება.
# ბაზა: docker exec emr-postgres psql (POSTGRES_USER / POSTGRES_DB — /opt/emr/.env); ლოკალურად — PSQL="psql -h 127.0.0.1 -U … -d …".
# =====================================================================
set -euo pipefail
APPLY=0; DAYS=7
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --days) DAYS="$2"; shift 2 ;;
    -h|--help) sed -n '3,11p' "$0"; exit 0 ;;
    *) echo "უცნობი არგუმენტი: $1"; exit 2 ;;
  esac
done
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "--days: მთელი რიცხვი"; exit 2; }

ENV_FILE="${ENV_FILE:-/opt/emr/.env}"
if [ -z "${PSQL:-}" ]; then
  [ -f "$ENV_FILE" ] || { echo "$ENV_FILE ვერ მოიძებნა (ან მიუთითეთ PSQL=…)"; exit 2; }
  PGU=$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2-); PGD=$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
  PSQL="docker exec -i emr-postgres psql -U $PGU -d $PGD"
fi
NODE_ENV_NOW="${NODE_ENV_OVERRIDE:-$(docker exec emr-backend printenv NODE_ENV 2>/dev/null || echo unknown)}"
if [ "$NODE_ENV_NOW" = "production" ] || [ "$NODE_ENV_NOW" = "unknown" ]; then
  echo "✗ NODE_ENV = $NODE_ENV_NOW — სკრიპტი მუშაობს მხოლოდ dev / test გარემოზე"; exit 1
fi

WHERE="u.is_active AND u.email LIKE 'e2e.%@test.local' AND u.created_at < now() - interval '$DAYS days'
       AND (u.last_login_at IS NULL OR u.last_login_at < now() - interval '$DAYS days')"

echo "NODE_ENV = $NODE_ENV_NOW · ზღვარი: $DAYS დღე"
$PSQL -q -v ON_ERROR_STOP=1 -At <<SQL
SELECT 'აქტიური მომხმარებლები: ' || count(*) FILTER (WHERE is_active) || ' · მათ შორის e2e (ყველა): ' || count(*) FILTER (WHERE is_active AND email LIKE 'e2e.%@test.local') FROM users;
SELECT 'გაითიშება: ' || count(*) FROM users u WHERE $WHERE;
SELECT '  ' || t || ': ' || n FROM (SELECT split_part(u.email, '.', 2) AS t, count(*) AS n FROM users u WHERE $WHERE GROUP BY 1) x ORDER BY n DESC, t LIMIT 15;
SQL

if [ $APPLY = 0 ]; then echo "dry-run — ცვლილება არ მომხდარა (გასათიშად: --apply)"; exit 0; fi

$PSQL -q -v ON_ERROR_STOP=1 -At <<SQL
BEGIN;
WITH x AS (UPDATE users u SET is_active = false, updated_at = now() WHERE $WHERE RETURNING u.id)
INSERT INTO audit_logs (user_id, action, entity_name, entity_id, new_data, user_agent)
SELECT NULL, 'DEV_CLEANUP_USERS', 'users', 'bulk', jsonb_build_object('count', count(*), 'days', $DAYS, 'pattern', 'e2e.%@test.local'), 'dev-cleanup-users.sh' FROM x;
SELECT 'გაითიშა: ' || (new_data->>'count') FROM audit_logs WHERE action = 'DEV_CLEANUP_USERS' ORDER BY id DESC LIMIT 1;
COMMIT;
SQL
echo "✔ მზადაა. სესიები: გათიშული მომხმარებელი ვეღარ შედის (refresh — უარყოფა)."
