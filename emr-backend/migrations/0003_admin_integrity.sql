-- 0003_admin_integrity.sql
-- განყოფილებების ვალიდაცია + updated_at-ის ავტომატური განახლება (აღარ არის დამოკიდებული აპლიკაციის კოდზე)

ALTER TABLE departments ADD CONSTRAINT chk_departments_type
    CHECK (type IN ('inpatient', 'outpatient', 'diagnostic', 'administrative'));
ALTER TABLE departments ADD CONSTRAINT chk_departments_code
    CHECK (code ~ '^[A-Z0-9_]{2,50}$');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at       BEFORE UPDATE ON users       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_patients_updated_at    BEFORE UPDATE ON patients    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_encounters_updated_at  BEFORE UPDATE ON encounters  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_users_name_trgm ON users USING gin ((last_name || ' ' || first_name) gin_trgm_ops);
