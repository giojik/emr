-- 0004_icd10.sql
-- ICD-10 კლასიფიკატორი (ქართული). მონაცემები — 0005_icd10_data.sql.
-- საცნობარო ცხრილები: აპლიკაციას მხოლოდ წაკითხვა შეუძლია, ცვლილებები მხოლოდ migration-ით.

CREATE TABLE icd10_chapters (
    id          SMALLINT PRIMARY KEY,           -- კლასი 1..22
    title       TEXT NOT NULL,
    code_from   CHAR(3) NOT NULL,
    code_to     CHAR(3) NOT NULL
);

CREATE TABLE icd10_codes (
    code          VARCHAR(10) PRIMARY KEY CHECK (code ~ '^[A-Z][0-9]{2}(\.[0-9]{1,2})?$'),
    title         TEXT NOT NULL,
    category      CHAR(3) GENERATED ALWAYS AS (left(code, 3)) STORED,
    chapter_id    SMALLINT REFERENCES icd10_chapters(id),
    is_asterisk   BOOLEAN NOT NULL DEFAULT FALSE,  -- "*" მანიფესტაცია: ძირითად დიაგნოზად დაუშვებელია
    is_dagger     BOOLEAN NOT NULL DEFAULT FALSE,  -- "†" ეტიოლოგია
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    needs_review  BOOLEAN NOT NULL DEFAULT FALSE   -- წყაროში დაზიანებული ტექსტი — გადასამოწმებელი
);
CREATE INDEX idx_icd10_code_prefix ON icd10_codes (code text_pattern_ops);
CREATE INDEX idx_icd10_title_trgm  ON icd10_codes USING gin (title gin_trgm_ops);
CREATE INDEX idx_icd10_category    ON icd10_codes (category);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON icd10_chapters, icd10_codes FROM emr_app;
    GRANT SELECT ON icd10_chapters, icd10_codes TO emr_app;
  END IF;
END $$;
