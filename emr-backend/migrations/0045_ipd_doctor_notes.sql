-- 0045_ipd_doctor_notes.sql
-- სტაციონარი, ეტაპი 0045 — ექიმის ჩანაწერები, კონსულტაციები, ფორმა №IV-100/ა სტაციონარიდან.
--
--  • doctor_notes — მიმღები გასინჯვა / დღიური (SOAP) / შემოვლა / კონსულტაციის პასუხი:
--      შავი ვერსია (მხოლოდ ავტორი ხედავს) → ხელმოწერა (იბლოკება); შესწორება = ახალი ვერსია (მიზეზით), წინა — superseded (ისტორიაში).
--  • note_templates — პირადი (ექიმი) / განყოფილების (ხელმძღვანელი) შაბლონები ველებით.
--  • consultations — მოთხოვნა (განყოფილება / ექიმი, სასწრაფოობა, კითხვა) → პასუხი (ხელმოწერილი ჩანაწერი); ვადა; ბილინგი (კონსულტანტის ტარიფი).
--  • ფორმა 100 სტაციონარიდან — არსებული generated_documents / ნუმერაცია / PDF / QR (ცხრილი არ ემატება).

-- ================================================================ 1. კონსულტაციები
CREATE TABLE consultations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id        UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id          UUID NOT NULL REFERENCES patients(id),
    requested_by        UUID NOT NULL REFERENCES users(id),
    from_department_id  UUID REFERENCES departments(id),
    target_department_id UUID REFERENCES departments(id),
    target_doctor_id    UUID REFERENCES users(id),
    urgency             VARCHAR(10) NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'emergency')),
    question            TEXT NOT NULL CHECK (length(btrim(question)) >= 3),
    status              VARCHAR(10) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'answered', 'cancelled')),
    due_at              TIMESTAMPTZ NOT NULL,
    answered_by         UUID REFERENCES users(id),
    answered_at         TIMESTAMPTZ,
    cancelled_by        UUID REFERENCES users(id),
    cancelled_at        TIMESTAMPTZ,
    cancel_reason       TEXT,
    overdue_notified_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_consult_target CHECK (target_department_id IS NOT NULL OR target_doctor_id IS NOT NULL),
    CONSTRAINT chk_consult_answered CHECK ((status = 'answered') = (answered_at IS NOT NULL) AND (answered_at IS NULL) = (answered_by IS NULL)),
    CONSTRAINT chk_consult_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL OR length(btrim(coalesce(cancel_reason, ''))) >= 3))
);
CREATE INDEX idx_consult_encounter ON consultations (encounter_id, created_at DESC);
CREATE INDEX idx_consult_open ON consultations (due_at) WHERE status = 'requested';
CREATE INDEX idx_consult_target ON consultations (target_department_id, target_doctor_id) WHERE status = 'requested';

-- ================================================================ 2. ექიმის ჩანაწერები
CREATE TABLE doctor_notes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id    UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id      UUID NOT NULL REFERENCES patients(id),
    department_id   UUID REFERENCES departments(id),
    kind            VARCHAR(10) NOT NULL CHECK (kind IN ('admission', 'progress', 'rounds', 'consult')),
    note_date       DATE NOT NULL,                                   -- კალენდარული დღე (კლინიკის დროით) — დღიურის სავალდებულოობა
    consultation_id UUID REFERENCES consultations(id),
    content         JSONB NOT NULL DEFAULT '{}'::jsonb,               -- { field_key: text }
    participants    UUID[] NOT NULL DEFAULT '{}',                     -- შემოვლა
    status          VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
    version         INT NOT NULL DEFAULT 1 CHECK (version > 0),
    root_id         UUID REFERENCES doctor_notes(id),                 -- ვერსიების ჯაჭვი (პირველი ვერსიის id)
    amends_id       UUID REFERENCES doctor_notes(id),                 -- რომელ ვერსიას ასწორებს
    amend_reason    TEXT,
    superseded_at   TIMESTAMPTZ,                                      -- ახალი ვერსია ხელმოწერილია
    author_id       UUID NOT NULL REFERENCES users(id),
    signed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_dn_signed CHECK ((status = 'signed') = (signed_at IS NOT NULL)),
    CONSTRAINT chk_dn_consult CHECK ((kind = 'consult') = (consultation_id IS NOT NULL)),
    CONSTRAINT chk_dn_amend CHECK ((amends_id IS NULL) = (amend_reason IS NULL) AND (amend_reason IS NULL OR length(btrim(amend_reason)) >= 3)),
    CONSTRAINT chk_dn_superseded CHECK (superseded_at IS NULL OR status = 'signed')
);
CREATE INDEX idx_dn_encounter ON doctor_notes (encounter_id, note_date DESC, created_at DESC);
CREATE UNIQUE INDEX ux_dn_amend_draft ON doctor_notes (amends_id) WHERE status = 'draft' AND amends_id IS NOT NULL;
CREATE UNIQUE INDEX ux_dn_admission ON doctor_notes (encounter_id) WHERE kind = 'admission' AND status = 'signed' AND superseded_at IS NULL;
CREATE TRIGGER trg_doctor_notes_updated BEFORE UPDATE ON doctor_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ხელმოწერილი ჩანაწერი არ იცვლება (მხოლოდ superseded_at); შავი ვერსია — მხოლოდ შიგთავსი / ხელმოწერა
CREATE OR REPLACE FUNCTION doctor_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id OR NEW.kind <> OLD.kind OR NEW.author_id <> OLD.author_id
       OR NEW.root_id IS DISTINCT FROM OLD.root_id OR NEW.amends_id IS DISTINCT FROM OLD.amends_id OR NEW.version <> OLD.version
       OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id THEN
        RAISE EXCEPTION 'ჩანაწერის მიბმა არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'signed' AND ((to_jsonb(NEW) - ARRAY['superseded_at', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_at', 'updated_at'])
                                  OR OLD.superseded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'ხელმოწერილი ჩანაწერი არ რედაქტირდება — შექმენით შესწორებული ვერსია (მიზეზით)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_doctor_notes_guard BEFORE UPDATE ON doctor_notes FOR EACH ROW EXECUTE FUNCTION doctor_notes_guard();
-- შავი ვერსია იშლება (ავტორი), ხელმოწერილი — არასდროს
CREATE OR REPLACE FUNCTION doctor_notes_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ხელმოწერილი ჩანაწერი არ იშლება' USING ERRCODE = 'check_violation'; END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER trg_doctor_notes_no_delete BEFORE DELETE ON doctor_notes FOR EACH ROW EXECUTE FUNCTION doctor_notes_no_delete();

ALTER TABLE consultations ADD COLUMN answer_note_id UUID REFERENCES doctor_notes(id);

-- ================================================================ 3. შაბლონები
CREATE TABLE note_templates (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('admission', 'progress', 'rounds', 'consult')),
    name           TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    content        JSONB NOT NULL DEFAULT '{}'::jsonb,
    department_id  UUID REFERENCES departments(id),
    owner_id       UUID REFERENCES users(id),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_by     UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_nt_scope CHECK ((department_id IS NULL) <> (owner_id IS NULL))
);
CREATE TRIGGER trg_note_templates_updated BEFORE UPDATE ON note_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ================================================================ 4. ბილინგი (კონსულტაცია)
ALTER TABLE invoice_line_items ADD COLUMN consultation_id UUID REFERENCES consultations(id);

-- ================================================================ 5. ისტორია / პარამეტრები
ALTER TABLE inpatient_events DROP CONSTRAINT inpatient_events_kind_check;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_events_kind_check CHECK (kind IN (
    'admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled',
    'bed_cleaned', 'bed_blocked', 'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled',
    'planned_sms', 'wristband',
    'transfer_requested', 'transfer_accepted', 'transfer_rejected', 'transfer_cancelled', 'transfer_overdue',
    'leave_started', 'leave_returned', 'leave_overdue',
    'discharged', 'discharge_cancelled', 'death', 'body_released', 'closed',
    'epicrisis_created', 'epicrisis_signed', 'epicrisis_cosigned', 'epicrisis_reopened',
    'orders_stopped',
    'mar_missed',
    'news2_alert', 'line_inserted', 'line_removed', 'handover',
    -- 0045
    'note_signed', 'note_amended', 'consult_requested', 'consult_answered', 'consult_cancelled', 'form100_issued'));

UPDATE system_modules SET settings = settings || '{
    "admission_note_hours": 24,
    "progress_note_daily": true,
    "progress_reminder_time": "12:00",
    "consult_due_hours": {"routine": 24, "urgent": 2, "emergency": 1},
    "consult_billing": true,
    "form100_on_discharge": "warn"
}'::jsonb
WHERE code = 'inpatient';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON consultations FROM emr_app;
    REVOKE TRUNCATE ON doctor_notes FROM emr_app;
  END IF;
END $$;
