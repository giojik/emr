#!/usr/bin/env bash
# მარტივი ღამის dump dev-ისთვის (cron: 0 2 * * * /opt/emr/backup-dev.sh)
set -euo pipefail
cd "$(dirname "$0")"
# .env არ ვასრულებთ (source) — მხოლოდ ორი საჭირო მნიშვნელობა (სპეციალური სიმბოლოები / <...> აღარ არღვევს სკრიპტს)
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -E "s/^[\"'](.*)[\"']\$/\1/"; }
POSTGRES_USER=$(env_get POSTGRES_USER); POSTGRES_DB=$(env_get POSTGRES_DB)
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] || { echo "backup: POSTGRES_USER / POSTGRES_DB ვერ წავიკითხე .env-დან" >&2; exit 1; }
TS=$(date +%Y%m%d_%H%M)
docker exec emr-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "/data/backups/emr_${TS}.dump"
find /data/backups -name 'emr_*.dump' -mtime +7 -delete
echo "backup: /data/backups/emr_${TS}.dump"
