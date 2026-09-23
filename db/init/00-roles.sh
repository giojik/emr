#!/usr/bin/env bash
# ეშვება მხოლოდ პირველად (როცა /data/postgres ცარიელია)
# ქმნის აპლიკაციის runtime როლს — schema-ს მფლობელი რჩება POSTGRES_USER
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE ${EMR_APP_USER} LOGIN PASSWORD '${EMR_APP_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${EMR_APP_USER};
GRANT USAGE ON SCHEMA public TO ${EMR_APP_USER};
SQL
