-- 0088_er_clinical.sql
-- გადაუდებელი დახმარება (ER), ეტაპი 2 / 4 — კლინიკური ნაწილი (I): ჩანაწერი, დიაგნოსტიკა, კონსულტაცია.
--
--  • doctor_notes / consultations — encounter_id → encounters(id) (ადრე inpatient_stays): ერთი ჩანაწერის / ხელმოწერის / ვერსიების /
--    კონსულტაციის მექანიზმი სტაციონარისა და ER-ისთვის. FK-ის ნაცვლად — ტრიგერი: შემთხვევა უნდა იყოს ჰოსპიტალიზაცია (inpatient_stays)
--    ან ER-ის შემთხვევა (er_visits); ER-ის სახეები (er_initial / er_progress) — მხოლოდ ER-ზე, სტაციონარის სახეები — მხოლოდ სტაციონარზე.
--  • ახალი სახეები: er_initial (ER-ის პირველადი გასინჯვა — ერთი მოქმედი), er_progress (დინამიკა / დამატებითი ჩანაწერი).
--  • ER-ის პარამეტრები: initial_note_min, doctor_write (team / attending), dx_unpaid_check (skip / ack), dx_default_priority,
--    consult_due_min, consult_billing.
--  • დანიშვნა / მიცემა / ჩამოწერა — 0088b.

-- ================================================================ 1. ჩანაწერები / კონსულტაციები → ზოგადი შემთხვევა
ALTER TABLE doctor_notes DROP CONSTRAINT doctor_notes_encounter_id_fkey;
ALTER TABLE doctor_notes ADD CONSTRAINT doctor_notes_encounter_id_fkey FOREIGN KEY (encounter_id) REFERENCES encounters(id);
ALTER TABLE consultations DROP CONSTRAINT consultations_encounter_id_fkey;
ALTER TABLE consultations ADD CONSTRAINT consultations_encounter_id_fkey FOREIGN KEY (encounter_id) REFERENCES encounters(id);

-- სახის სვეტი: VARCHAR(10) → VARCHAR(16) ('er_progress' — 11 სიმბოლო)
ALTER TABLE doctor_notes ALTER COLUMN kind TYPE VARCHAR(16);
ALTER TABLE note_templates ALTER COLUMN kind TYPE VARCHAR(16);
ALTER TABLE doctor_notes DROP CONSTRAINT doctor_notes_kind_check;
ALTER TABLE doctor_notes ADD CONSTRAINT doctor_notes_kind_check
    CHECK (kind IN ('admission', 'progress', 'rounds', 'consult', 'icu_daily', 'icu_out', 'er_initial', 'er_progress'));
ALTER TABLE note_templates DROP CONSTRAINT note_templates_kind_check;
ALTER TABLE note_templates ADD CONSTRAINT note_templates_kind_check
    CHECK (kind IN ('admission', 'progress', 'rounds', 'consult', 'icu_daily', 'icu_out', 'er_initial', 'er_progress'));

-- ER-ის პირველადი გასინჯვა — ერთი მოქმედი ხელმოწერილი (როგორც მიმღები გასინჯვა სტაციონარში)
CREATE UNIQUE INDEX ux_dn_er_initial ON doctor_notes (encounter_id) WHERE kind = 'er_initial' AND status = 'signed' AND superseded_at IS NULL;

-- შემთხვევის ტიპი ↔ ჩანაწერის სახე (FK-ის ნაცვლად; ჩასმისას / მიბმის შეცვლისას)
CREATE OR REPLACE FUNCTION clinical_chart_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ipd BOOLEAN; v_er BOOLEAN; v_kind TEXT;
BEGIN
    v_ipd := EXISTS (SELECT 1 FROM inpatient_stays WHERE encounter_id = NEW.encounter_id);
    v_er  := EXISTS (SELECT 1 FROM er_visits WHERE encounter_id = NEW.encounter_id);
    IF NOT (v_ipd OR v_er) THEN
        RAISE EXCEPTION 'ჩანაწერი / კონსულტაცია — მხოლოდ ჰოსპიტალიზაციაზე ან ER-ის შემთხვევაზე' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'chk_clinical_chart';
    END IF;
    IF TG_TABLE_NAME = 'doctor_notes' THEN
        v_kind := NEW.kind;
        IF v_kind IN ('er_initial', 'er_progress') AND NOT v_er THEN
            RAISE EXCEPTION 'ER-ის ჩანაწერი — მხოლოდ ER-ის შემთხვევაზე' USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_clinical_chart';
        END IF;
        IF v_kind IN ('admission', 'progress', 'rounds', 'icu_daily', 'icu_out') AND NOT v_ipd THEN
            RAISE EXCEPTION 'სტაციონარის ჩანაწერი — მხოლოდ ჰოსპიტალიზაციაზე' USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_clinical_chart';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_doctor_notes_chart BEFORE INSERT OR UPDATE OF encounter_id, kind ON doctor_notes FOR EACH ROW EXECUTE FUNCTION clinical_chart_check();
CREATE TRIGGER trg_consultations_chart BEFORE INSERT OR UPDATE OF encounter_id ON consultations FOR EACH ROW EXECUTE FUNCTION clinical_chart_check();

-- ================================================================ 2. ER-ის პარამეტრები
UPDATE system_modules SET settings = '{
    "initial_note_min": 60,
    "doctor_write": "team",
    "dx_unpaid_check": "skip",
    "dx_default_priority": "urgent",
    "consult_due_min": {"routine": 240, "urgent": 60, "emergency": 30},
    "consult_billing": true
}'::jsonb || settings
WHERE code = 'er';

UPDATE system_modules SET description = 'ER: რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი (ESI / MTS / საკუთარი), დაფა / TV, ადგილები; ჩანაწერი, დიაგნოსტიკა, კონსულტაცია'
WHERE code = 'er';
