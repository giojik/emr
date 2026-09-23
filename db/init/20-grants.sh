#!/usr/bin/env bash
# აპლიკაციის როლის უფლებები — audit_logs-ზე მხოლოდ INSERT/SELECT (უცვლელი ლოგი)
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${EMR_APP_USER};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${EMR_APP_USER};

-- მომავალი migration-ებით შექმნილ ცხრილებზეც ავტომატურად
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${EMR_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${EMR_APP_USER};

-- audit_logs: უცვლელობა DB დონეზე
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='audit_logs') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM ${EMR_APP_USER};
  END IF;
END
\$\$;
SQL
