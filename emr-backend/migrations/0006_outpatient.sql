-- 0006_outpatient.sql
-- ამბულატორიის ნაკადი: ექიმის კონსულტაციის ტარიფი, ჩაწერის გადაფარვის აკრძალვა,
-- ინვოისის ჯამების/სტატუსის ავტომატური დათვლა, დიაგნოზების წესები DB დონეზე.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1) ექიმის კონსულტაციის ტარიფი (pay-initial ფასი)
ALTER TABLE users ADD COLUMN consultation_tariff_id UUID REFERENCES service_tariffs(id);

-- 2) ჩაწერები: ერთ ექიმს ერთდროულად ორი აქტიური ჩაწერა არ უნდა ჰქონდეს
ALTER TABLE appointments ADD CONSTRAINT excl_appointments_doctor_overlap
    EXCLUDE USING gist (doctor_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status IN ('scheduled', 'confirmed', 'checked_in'));
ALTER TABLE appointments ADD CONSTRAINT uq_appointments_encounter UNIQUE (encounter_id);
CREATE INDEX idx_appointments_start ON appointments (scheduled_start);

-- 3) ინვოისი: ერთი ვიზიტი = ერთი ინვოისი (ფაზა 1); ნომრები სექვენციით
ALTER TABLE invoices ADD CONSTRAINT uq_invoices_encounter UNIQUE (encounter_id);
CREATE SEQUENCE invoice_number_seq;
ALTER TABLE invoice_line_items ADD COLUMN referral_id UUID REFERENCES referrals(id);
CREATE UNIQUE INDEX uq_invoice_lines_referral ON invoice_line_items (referral_id) WHERE referral_id IS NOT NULL;
ALTER TABLE invoice_line_items ADD CONSTRAINT chk_line_amounts CHECK (quantity > 0 AND unit_price >= 0);
ALTER TABLE payments ADD CONSTRAINT chk_payment_amount CHECK (amount > 0);
ALTER TABLE payments ADD CONSTRAINT chk_payment_method CHECK (method IN ('cash', 'card_terminal', 'bank_transfer'));

-- ინვოისის ჯამი = ხაზების ჯამი; პაციენტის წილი = ჯამი − დაზღვევა − სახელმწიფო (DB-ის გარანტია)
CREATE OR REPLACE FUNCTION recalc_invoice(p_invoice UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_total NUMERIC(10,2); v_paid NUMERIC(10,2); v_share NUMERIC(10,2);
BEGIN
    SELECT coalesce(sum(line_total), 0) INTO v_total FROM invoice_line_items WHERE invoice_id = p_invoice;
    SELECT coalesce(sum(amount), 0)     INTO v_paid  FROM payments           WHERE invoice_id = p_invoice;
    UPDATE invoices SET
        total_amount  = v_total,
        patient_share = greatest(v_total - insurance_share - state_share, 0),
        paid_status   = CASE
            WHEN v_paid >= greatest(v_total - insurance_share - state_share, 0) THEN 'paid'
            WHEN v_paid > 0 THEN 'partially_paid'
            ELSE 'unpaid' END
    WHERE id = p_invoice
    RETURNING patient_share INTO v_share;
    IF v_paid > v_share THEN
        RAISE EXCEPTION 'გადახდილი თანხა (%) აღემატება პაციენტის წილს (%)', v_paid, v_share
            USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_invoice_overpaid';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION trg_recalc_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'invoices' THEN
        PERFORM recalc_invoice(NEW.id);
    ELSE
        PERFORM recalc_invoice(coalesce(NEW.invoice_id, OLD.invoice_id));
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_lines_recalc AFTER INSERT OR UPDATE OR DELETE ON invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION trg_recalc_invoice();
CREATE TRIGGER trg_payments_recalc AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_recalc_invoice();
CREATE TRIGGER trg_invoice_shares_recalc AFTER UPDATE OF insurance_share, state_share ON invoices
    FOR EACH ROW EXECUTE FUNCTION trg_recalc_invoice();

-- 4) დიაგნოზები: ტიპების სია, ერთი ძირითადი ვიზიტზე, "*" კოდი ძირითადად დაუშვებელია
ALTER TABLE encounter_diagnoses ADD CONSTRAINT chk_diagnosis_type
    CHECK (diagnosis_type IN ('primary', 'secondary', 'admission'));
CREATE UNIQUE INDEX uq_encounter_primary_diagnosis ON encounter_diagnoses (encounter_id)
    WHERE diagnosis_type = 'primary';

CREATE OR REPLACE FUNCTION trg_primary_not_asterisk() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.diagnosis_type = 'primary'
       AND EXISTS (SELECT 1 FROM icd10_codes WHERE code = NEW.icd10_code AND is_asterisk) THEN
        RAISE EXCEPTION 'კოდი % არის "*" (მანიფესტაციის) კოდი და ძირითად დიაგნოზად ვერ გამოიყენება', NEW.icd10_code
            USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_primary_not_asterisk';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_diagnoses_primary_asterisk BEFORE INSERT OR UPDATE ON encounter_diagnoses
    FOR EACH ROW EXECUTE FUNCTION trg_primary_not_asterisk();

-- 5) ვიტალების ფიზიოლოგიური საზღვრები (აკრეფის შეცდომების დაჭერა: 1200 ნაცვლად 120)
ALTER TABLE encounter_vitals ADD CONSTRAINT chk_vitals_ranges CHECK (
        (systolic_bp      IS NULL OR systolic_bp      BETWEEN 40 AND 300)
    AND (diastolic_bp     IS NULL OR diastolic_bp     BETWEEN 20 AND 200)
    AND (heart_rate       IS NULL OR heart_rate       BETWEEN 20 AND 300)
    AND (respiratory_rate IS NULL OR respiratory_rate BETWEEN 4 AND 80)
    AND (temperature      IS NULL OR temperature      BETWEEN 30 AND 45)
    AND (spo2             IS NULL OR spo2             BETWEEN 30 AND 100)
    AND (weight_kg        IS NULL OR weight_kg        BETWEEN 0.3 AND 400)
    AND (height_cm        IS NULL OR height_cm        BETWEEN 20 AND 250)
);

CREATE INDEX idx_encounters_status_start ON encounters (status, start_time);
