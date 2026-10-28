-- 0083_worklist_clinical.sql
-- სამუშაო სიები (D5), ეტაპი 3 / 4 — კლინიკური წყაროები (ექიმი / ექთანი). წყაროები ვირტუალურია (0081-ის A1): ჩანაწერი ყოველ ჯერზე
-- წყაროს ცხრილიდან ითვლება, მოდულის წვდომის წესით.
--
--  • 29 წყარო: დოკუმენტაცია (7), დანიშნულებები / MAR (7), კონსულტაცია / გადაყვანა (2), საექთნო / NEWS2 (5), ICU (3), საოპერაციო / PACU (5).
--  • ექთნის შესასრულებელი საქმე — განყოფილების ექთნები (nurse_scope: department / on_shift); B1 (dept_side) — მხოლოდ განყოფილების
--      გადაწყვეტილებაზე (გადმოყვანა, საოპერაციო მზადყოფნა). ექიმის საქმე — მკურნალი (არ არის / არააქტიური → ხელმძღვანელი → განყოფილების ექიმები).
--  • D — NEWS2: ექიმის შეფასება („შეფასდა“) — news2_reviews (უცვლელი ჟურნალი); შემდეგი გაზომვა ზღვარს ქვემოთ — ჩანაწერი ქრება.
--  • F — ხაზები / კათეტერები: „საჭიროება შეფასდა“ — lines_drains.reviewed_*; ჩანაწერი თავიდან line_review_hours-ის შემდეგ.
--  • ახალი უფლება არ ემატება (47). არსებული ზარის შეტყობინებები უცვლელია.

-- ================================================================ 1. NEWS2 — ექიმის შეფასება
CREATE TABLE news2_reviews (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    vitals_id     UUID NOT NULL REFERENCES encounter_vitals(id),
    score         SMALLINT NOT NULL,
    level         VARCHAR(8) NOT NULL CHECK (level IN ('low', 'low_red', 'medium', 'high')),
    action        VARCHAR(12) NOT NULL CHECK (action IN ('monitor', 'treatment', 'escalated', 'transfer', 'other')),
    note          TEXT,
    reviewed_by   UUID NOT NULL REFERENCES users(id),
    reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_news2_review_note CHECK (action <> 'other' OR length(btrim(coalesce(note, ''))) >= 3)
);
CREATE UNIQUE INDEX ux_news2_review_vitals ON news2_reviews (vitals_id);
CREATE INDEX idx_news2_reviews_enc ON news2_reviews (encounter_id, reviewed_at DESC);
-- უცვლელი ჟურნალი: აპლიკაციას — მხოლოდ INSERT / SELECT
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON news2_reviews FROM emr_app;
        GRANT SELECT, INSERT ON news2_reviews TO emr_app;
    END IF;
END $$;

-- ================================================================ 2. ხაზები / კათეტერები — საჭიროების გადახედვა
ALTER TABLE lines_drains
    ADD COLUMN reviewed_at  TIMESTAMPTZ,
    ADD COLUMN reviewed_by  UUID REFERENCES users(id),
    ADD COLUMN review_note  TEXT,
    ADD CONSTRAINT chk_line_review CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL));
-- უცვლელობის trigger (0044): გადახედვის ველებიც დასაშვებია
DROP TRIGGER trg_lines_guard ON lines_drains;
CREATE TRIGGER trg_lines_guard BEFORE UPDATE ON lines_drains FOR EACH ROW
    EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason', 'removed_at', 'removed_by', 'removal_reason', 'alert_notified_at',
                                             'reviewed_at', 'reviewed_by', 'review_note');

-- ================================================================ 3. ჰოსპიტალიზაციის ისტორია: news2_reviewed, line_reviewed
ALTER TABLE inpatient_events DROP CONSTRAINT inpatient_events_kind_check;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_events_kind_check CHECK (kind IN (
    'admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled', 'bed_cleaned', 'bed_blocked',
    'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled', 'planned_sms', 'wristband',
    'transfer_requested', 'transfer_accepted', 'transfer_rejected', 'transfer_cancelled', 'transfer_overdue', 'leave_started', 'leave_returned',
    'leave_overdue', 'discharged', 'discharge_cancelled', 'death', 'body_released', 'closed', 'epicrisis_created', 'epicrisis_signed',
    'epicrisis_cosigned', 'epicrisis_reopened', 'orders_stopped', 'mar_missed', 'news2_alert', 'line_inserted', 'line_removed', 'handover',
    'note_signed', 'note_amended', 'consult_requested', 'consult_answered', 'consult_cancelled', 'form100_issued', 'billing_package', 'payer_added',
    'payer_cancelled', 'deposit', 'deposit_refund', 'deposit_voided', 'billing_finalized', 'billing_reopened', 'icu_in', 'icu_out', 'icu_interval',
    'vent_started', 'vent_ended', 'icu_score', 'or_requested', 'or_scheduled', 'or_cancelled', 'or_started', 'or_completed', 'or_note_signed',
    'or_implant', 'or_pacu_discharged', 'drg_confirmed', 'drg_reset',
    'news2_reviewed', 'line_reviewed'));

-- ================================================================ 4. პარამეტრები (ნაგულისხმევი; არსებული მნიშვნელობები უპირატესია)
UPDATE system_modules
   SET settings = '{"nurse_scope": "department", "mar_due_ahead_min": 60,
                    "obs_minutes": {"zero": 720, "low": 240, "low_red": 60, "medium": 60, "high": 30},
                    "news2_review_min": {"alert": 60, "urgent": 30},
                    "line_review_hours": 24, "draft_hours": 12, "amb_open_days": 7, "or_ahead_hours": 24, "pacu_long_hours": 4}'::jsonb || settings,
       description = '„ჩემი დავალებები“: სხვა მოდულების ღია საქმეები (სისტემური — კლინიკური: დოკუმენტაცია, დანიშნულებები / MAR, კონსულტაცია / გადაყვანა, საექთნო / NEWS2, ICU, საოპერაციო; ხარისხი, IPC, ბიომედი, ცვლები, მარაგი, შესყიდვები, ფინანსები, ტარიფები, CSSD, ინვენტარი, რეგისტრატურა) + ხელით შექმნილი დავალებები (პირზე / როლზე / განყოფილებაზე / მორიგეზე), ვადა, პრიორიტეტი, ესკალაცია; ხელმძღვანელის ხედი'
 WHERE code = 'worklist';
-- sla_hours: ახალი გასაღებები (არსებული ობიექტი შენარჩუნდება)
UPDATE system_modules
   SET settings = jsonb_set(settings, '{sla_hours}', '{"med_verify": 2, "med_approve": 4, "doc_cosign": 24, "or_docs": 24}'::jsonb || coalesce(settings->'sla_hours', '{}'::jsonb))
 WHERE code = 'worklist';

-- ================================================================ 5. ინდექსები (წყაროების მოთხოვნებისთვის)
CREATE INDEX IF NOT EXISTS idx_dn_drafts           ON doctor_notes (author_id, created_at) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_med_orders_rejected ON med_orders (ordered_by) WHERE verify_status = 'rejected' AND status IN ('active', 'on_hold');
CREATE INDEX IF NOT EXISTS idx_med_orders_verbal   ON med_orders (ordered_by) WHERE is_verbal AND verbal_confirmed_at IS NULL AND status IN ('active', 'on_hold');
CREATE INDEX IF NOT EXISTS idx_mar_missed          ON mar_entries (encounter_id, scheduled_at) WHERE status = 'missed' AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nn_handover_open    ON nursing_notes (encounter_id, shift_start) WHERE kind = 'handover' AND ack_at IS NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_encounters_amb_open ON encounters (attending_doctor_id, start_time) WHERE status = 'active' AND type = 'outpatient';
CREATE INDEX IF NOT EXISTS idx_or_preop_signed     ON or_preop_assessments (case_id) WHERE status = 'signed' AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_or_anesth_unsigned  ON or_anesthesia_records (case_id) WHERE status = 'draft';
