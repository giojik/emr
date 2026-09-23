-- 0007_documents.sql
-- ფორმა №IV-100/ა: კლინიკის რეკვიზიტები, დოკუმენტების ჟურნალი (რიგითი ნომრით), უცვლელობა DB დონეზე.

-- კლინიკის რეკვიზიტები (ცნობის 1-ლი და მე-19 პუნქტები) — ერთი ჩანაწერი
CREATE TABLE clinic_settings (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name            TEXT NOT NULL,
    address         TEXT NOT NULL,
    phone           TEXT,
    email           TEXT,
    director_name   TEXT NOT NULL,
    director_title  TEXT NOT NULL DEFAULT 'დაწესებულების ხელმძღვანელი',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_clinic_settings_updated_at BEFORE UPDATE ON clinic_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- დიაგნოზის ტიპს ემატება "გართულება" (ცნობის მე-9 პუნქტი: ძირითადი / თანმხლები / გართულებები)
ALTER TABLE encounter_diagnoses DROP CONSTRAINT chk_diagnosis_type;
ALTER TABLE encounter_diagnoses ADD CONSTRAINT chk_diagnosis_type
    CHECK (diagnosis_type IN ('primary', 'secondary', 'complication', 'admission'));

-- დოკუმენტების ჟურნალი
CREATE SEQUENCE form100_number_seq;
ALTER TABLE generated_documents
    ADD COLUMN document_number VARCHAR(50) UNIQUE,
    ADD COLUMN status          VARCHAR(20) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'revoked')),
    ADD COLUMN payload         JSONB NOT NULL DEFAULT '{}'::jsonb,     -- ცნობის ყველა ველის ასლი გაცემის მომენტში
    ADD COLUMN file_sha256     CHAR(64),
    ADD COLUMN revoked_at      TIMESTAMPTZ,
    ADD COLUMN revoked_by      UUID REFERENCES users(id),
    ADD COLUMN revoke_reason   TEXT,
    ADD CONSTRAINT chk_documents_revoked CHECK (
        (status = 'issued'  AND revoked_at IS NULL)
     OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL));
CREATE INDEX idx_documents_generated_at ON generated_documents (document_type, generated_at);

-- გაცემული დოკუმენტი უცვლელია: აპლიკაციას შეუძლია მხოლოდ გაუქმება (სტატუსის ველები), წაშლა — არა
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON generated_documents FROM emr_app;
    GRANT UPDATE (status, revoked_at, revoked_by, revoke_reason) ON generated_documents TO emr_app;
  END IF;
END $$;
