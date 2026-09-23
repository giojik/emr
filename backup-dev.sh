#!/usr/bin/env bash
# მარტივი ღამის dump dev-ისთვის (cron: 0 2 * * * /opt/emr/backup-dev.sh)
set -euo pipefail
cd "$(dirname "$0")"
source .env
TS=$(date +%Y%m%d_%H%M)
docker exec emr-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "/data/backups/emr_${TS}.dump"
find /data/backups -name 'emr_*.dump' -mtime +7 -delete
echo "backup: /data/backups/emr_${TS}.dump"
