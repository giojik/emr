#!/usr/bin/env bash
# =====================================================================
# dev-cleanup-e2e.sh (0091a) — e2e-ის დაგროვილი ნარჩენების დასუფთავება dev-ზე (წაშლის გარეშე; აუდიტი DEV_CLEANUP_E2E).
#
#   bash scripts/dev-cleanup-e2e.sh                 # --dry-run (ნაგულისხმევი): რამდენი / რა დაიხურება
#   bash scripts/dev-cleanup-e2e.sh --apply         # დახურვა (ერთი ტრანზაქცია + აუდიტი)
#   bash scripts/dev-cleanup-e2e.sh --hours 6       # ზღვარი (ნაგულისხმევი 2): ჩანაწერი N საათზე ძველია
#
# რა:
#   • სატესტო პაციენტის (სახელი / გვარი „ტესტ-E2E…“) ღია ამბულატორიული / ლაბ. ვიზიტი (encounters.status = active, type ≠ inpatient / emergency)
#     → discharged. მიზეზი: ფლებოტომისტის სია („ნიმუშის აღება“) 200 ვიზიტით შემოიფარგლება — ნარჩენები ახალ ვიზიტს ფარავს (e2e-worklist-dx).
#     შეკვეთები / ინვოისი / გადახდა — უცვლელი. ER (emergency) და სტაციონარი — არ ეხება (მათ თავისი გაუქმება / გაწერა აქვს).
#   • აქტიური სატესტო ჯენერიკი (inn „ტესტ-E2E…“) → is_active = false (მარაგი / საქონელი — უცვლელი).
# მუშაობს მხოლოდ NODE_ENV ≠ production-ზე (emr-backend კონტეინერის გარემო). ნამდვილი პაციენტები / ჯენერიკები არ ეხება (ნიმუში „ტესტ-E2E“).
# ბაზა: docker exec emr-postgres psql (POSTGRES_USER / POSTGRES_DB — /opt/emr/.env); ლოკალურად — PSQL="psql -h 127.0.0.1 -U … -d …".
# =====================================================================
set -euo pipefail
APPLY=0; HOURS=2
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --hours) HOURS="$2"; shift 2 ;;
    -h|--help) sed -n '3,15p' "$0"; exit 0 ;;
    *) echo "უცნობი არგუმენტი: $1"; exit 2 ;;
  esac
done
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "--hours: მთელი რიცხვი"; exit 2; }

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

ENC="e.status::text = 'active' AND e.type::text NOT IN ('inpatient', 'emergency') AND e.start_time < now() - interval '$HOURS hours'
     AND EXISTS (SELECT 1 FROM patients p WHERE p.id = e.patient_id AND (p.first_name LIKE 'ტესტ-E2E%' OR p.last_name LIKE 'ტესტ-E2E%'))"
GEN="g.is_active AND g.inn LIKE 'ტესტ-E2E%' AND g.created_at < now() - interval '$HOURS hours'"

echo "NODE_ENV = $NODE_ENV_NOW · ზღვარი: $HOURS სთ"
$PSQL -q -v ON_ERROR_STOP=1 -At <<SQL
SELECT 'ღია სატესტო ვიზიტები (დაიხურება): ' || count(*) FROM encounters e WHERE $ENC;
SELECT '  ' || e.type || ': ' || count(*) FROM encounters e WHERE $ENC GROUP BY e.type ORDER BY 1;
SELECT 'მათ შორის აუღებელი ლაბ. ანალიზით: ' || count(DISTINCT e.id) FROM encounters e JOIN dx_order_items i ON i.encounter_id = e.id
 WHERE $ENC AND i.section = 'lab' AND i.status = 'ordered';
SELECT 'აქტიური სატესტო ჯენერიკები (გაითიშება): ' || count(*) FROM med_generics g WHERE $GEN;
SQL

if [ $APPLY = 0 ]; then echo "dry-run — ცვლილება არ მომხდარა (დასახურად: --apply)"; exit 0; fi

$PSQL -q -v ON_ERROR_STOP=1 -At <<SQL
BEGIN;
WITH e1 AS (UPDATE encounters e SET status = 'discharged', end_time = coalesce(e.end_time, now()) WHERE $ENC RETURNING e.id),
     g1 AS (UPDATE med_generics g SET is_active = false WHERE $GEN RETURNING g.id)
INSERT INTO audit_logs (user_id, action, entity_name, entity_id, new_data, user_agent)
SELECT NULL, 'DEV_CLEANUP_E2E', 'encounters', 'bulk',
       jsonb_build_object('encounters', (SELECT count(*) FROM e1), 'generics', (SELECT count(*) FROM g1), 'hours', $HOURS, 'pattern', 'ტესტ-E2E%'), 'dev-cleanup-e2e.sh';
SELECT 'დაიხურა ვიზიტი: ' || (new_data->>'encounters') || ' · გაითიშა ჯენერიკი: ' || (new_data->>'generics') FROM audit_logs WHERE action = 'DEV_CLEANUP_E2E' ORDER BY id DESC LIMIT 1;
COMMIT;
SQL
echo "✔ მზადაა."
