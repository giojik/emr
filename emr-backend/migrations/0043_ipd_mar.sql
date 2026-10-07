-- 0043_ipd_mar.sql
-- სტაციონარი, ეტაპი 0043 — MAR (მედიკამენტების მიღების ფურცელი) და მოვლის დავალებების შესრულება.
--
--  • mar_entries — ერთი ჩანაწერი = ერთი დოზა / დავალება:
--      სლოტი (scheduled_at) — worker / გვერდის გახსნა ქმნის აქტიური დანიშნულებიდან (სიხშირის საათები ან ინტერვალი; ერთჯერადი — start_at),
--        48 სთ-ის წინ (mar_horizon_hours); იგივე დრო ორჯერ არ იქმნება (unique, გაუქმებულის გარდა);
--      PRN / უწყვეტი ინფუზია — სლოტის გარეშე (scheduled_at = NULL), ჩაიწერება საჭიროებისამებრ.
--      სტატუსი: due → given / partial / held (გადადება — ახალი სლოტით) / refused / not_given / missed (worker) / cancelled (დანიშნულება არ არის აქტიური).
--      მიცემისას: რეალური დოზა, დრო, გზა, ადგილი, დროის ნიშანი (on_time / early / late — ფანჯრის გარეთ მიზეზით),
--        მარაგის ხარჯი (stock_doc_id — 0033, FEFO, ინვოისი კონფიგურაციით), მოწმე (კონტროლირებადი), მეორე ექთანი (high-alert),
--        სკანირება (სამაჯური / მედიკამენტი), override (ვერიფიკაციის მოლოდინში, დამტკიცებამდე პირველი დოზა, ჩამოწერის გარეშე, PRN-ის ლიმიტი).
--      შესწორება: ჩანაწერი არ რედაქტირდება — გაუქმება მიზეზით (voided_*; მარაგი ბრუნდება შემობრუნებით); სლოტი თავიდან იხსნება.
--      ინფუზია: infusion_action (start / rate / bag / pause / stop) + rate_ml_h; ჩამოწერა — start / bag.

CREATE TABLE mar_entries (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id           UUID NOT NULL REFERENCES med_orders(id),
    encounter_id       UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id         UUID NOT NULL REFERENCES patients(id),
    scheduled_at       TIMESTAMPTZ,                                  -- NULL — PRN / ინფუზია
    source             VARCHAR(10) NOT NULL DEFAULT 'schedule' CHECK (source IN ('schedule', 'postponed', 'prn', 'infusion')),
    status             VARCHAR(10) NOT NULL DEFAULT 'due'
                           CHECK (status IN ('due', 'given', 'partial', 'held', 'refused', 'not_given', 'missed', 'cancelled')),
    -- ჩანაწერი
    documented_at      TIMESTAMPTZ,                                  -- როდის მიეცა / შესრულდა (ფაქტობრივი)
    documented_by      UUID REFERENCES users(id),
    recorded_at        TIMESTAMPTZ,                                  -- როდის ჩაიწერა სისტემაში
    dose_given         NUMERIC(14,4) CHECK (dose_given >= 0),
    dose_unit          VARCHAR(10),
    route_code         VARCHAR(10) REFERENCES med_routes(code),
    site               TEXT,                                         -- ინექციის ადგილი
    timing             VARCHAR(8) CHECK (timing IN ('on_time', 'early', 'late')),
    reason             TEXT,                                         -- held / refused / not_given / ადრე / დაგვიანებით
    postponed_to       TIMESTAMPTZ,
    infusion_action    VARCHAR(6) CHECK (infusion_action IN ('start', 'rate', 'bag', 'pause', 'stop')),
    rate_ml_h          NUMERIC(8,2) CHECK (rate_ml_h > 0),
    -- მარაგი
    stock_doc_id       UUID REFERENCES stock_docs(id),
    stock_item_id      UUID REFERENCES stock_items(id),
    qty_base           NUMERIC(14,3) CHECK (qty_base > 0),
    no_stock           BOOLEAN NOT NULL DEFAULT FALSE,              -- მიეცა ჩამოწერის გარეშე (მიზეზით) — ფარმაცევტთან შეუსაბამობა
    -- უსაფრთხოება
    witness_id         UUID REFERENCES users(id),                    -- კონტროლირებადი (0035)
    double_check_by    UUID REFERENCES users(id),                    -- high-alert — მეორე ექთანი
    scanned_patient    BOOLEAN NOT NULL DEFAULT FALSE,
    scanned_med        BOOLEAN NOT NULL DEFAULT FALSE,
    override_reason    TEXT,
    warnings           JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- შესწორება
    voided_at          TIMESTAMPTZ,
    voided_by          UUID REFERENCES users(id),
    void_reason        TEXT,
    void_stock_doc_id  UUID REFERENCES stock_docs(id),
    missed_notified_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_mar_slot CHECK ((scheduled_at IS NULL) = (source IN ('prn', 'infusion'))),
    CONSTRAINT chk_mar_documented CHECK ((status IN ('due', 'missed', 'cancelled')) = (documented_at IS NULL)
        AND (documented_at IS NULL) = (documented_by IS NULL)),
    CONSTRAINT chk_mar_reason CHECK (status NOT IN ('held', 'refused', 'not_given') OR length(btrim(coalesce(reason, ''))) >= 2),
    CONSTRAINT chk_mar_given CHECK (status NOT IN ('given', 'partial') OR documented_at IS NOT NULL),
    CONSTRAINT chk_mar_held CHECK (postponed_to IS NULL OR status = 'held'),
    CONSTRAINT chk_mar_infusion CHECK ((infusion_action IS NOT NULL) = (source = 'infusion')),
    CONSTRAINT chk_mar_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3)),
    CONSTRAINT chk_mar_stock CHECK (stock_doc_id IS NULL OR (stock_item_id IS NOT NULL AND qty_base IS NOT NULL))
);
CREATE UNIQUE INDEX ux_mar_slot ON mar_entries (order_id, scheduled_at) WHERE voided_at IS NULL AND scheduled_at IS NOT NULL;
CREATE INDEX idx_mar_encounter ON mar_entries (encounter_id, scheduled_at);
CREATE INDEX idx_mar_due ON mar_entries (scheduled_at) WHERE status = 'due' AND voided_at IS NULL;
CREATE INDEX idx_mar_order ON mar_entries (order_id, documented_at DESC) WHERE voided_at IS NULL;

-- დოკუმენტირებული ჩანაწერი არ იცვლება (იცვლება მხოლოდ: due → შედეგი / missed / cancelled; cancelled → due (დანიშნულება განახლდა);
-- missed → შედეგი (დაგვიანებით ჩაწერა); გაუქმება — voided_*; შეტყობინების ნიშანი)
CREATE OR REPLACE FUNCTION mar_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.order_id <> OLD.order_id OR NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id
       OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.source <> OLD.source THEN
        RAISE EXCEPTION 'MAR: სლოტის მიბმა არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'MAR: გაუქმებული ჩანაწერი არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status NOT IN ('due', 'missed', 'cancelled') AND NEW.voided_at IS NULL
       AND (NEW.status, NEW.documented_at, NEW.documented_by, NEW.dose_given, NEW.route_code, NEW.stock_doc_id, NEW.qty_base, NEW.reason)
           IS DISTINCT FROM (OLD.status, OLD.documented_at, OLD.documented_by, OLD.dose_given, OLD.route_code, OLD.stock_doc_id, OLD.qty_base, OLD.reason) THEN
        RAISE EXCEPTION 'MAR: ჩაწერილი დოზა არ რედაქტირდება — გააუქმეთ (მიზეზით) და ჩაწერეთ თავიდან' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_mar_entries_guard BEFORE UPDATE ON mar_entries FOR EACH ROW EXECUTE FUNCTION mar_entries_guard();

-- ---------------------------------------------------------------- დანიშნულების ისტორია / პარამეტრები
ALTER TABLE med_order_events DROP CONSTRAINT med_order_events_kind_check;
ALTER TABLE med_order_events ADD CONSTRAINT med_order_events_kind_check CHECK (kind IN ('created', 'held', 'resumed', 'stopped', 'modified', 'completed', 'verified',
    'verify_rejected', 'approved', 'approval_rejected', 'verbal_confirmed', 'supply_requested', 'end_reminder', 'discharge_stop',
    -- 0043
    'administered'));

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
    -- 0043
    'mar_missed'));

UPDATE system_modules SET settings = settings || '{
    "mar_window_min": 60,
    "mar_missed_hours": 2,
    "mar_horizon_hours": 48,
    "mar_stock_deduct": true,
    "mar_allow_no_stock": false,
    "mar_double_check": true,
    "mar_barcode": "optional"
}'::jsonb
WHERE code = 'inpatient';

-- ---------------------------------------------------------------- უსაფრთხოება: მოწმის პაროლი აუდიტში (0035–0042)
-- ხარჯის / ჩამოწერის აუდიტში dto.witness მთლიანად (პაროლითაც) იწერებოდა; კოდი შესწორდა (მხოლოდ username) —
-- არსებული ჩანაწერებიდან პაროლი იშლება.
UPDATE audit_logs SET new_data = jsonb_set(new_data, '{witness}', jsonb_build_object('username', new_data->'witness'->'username'))
WHERE action IN ('STOCK_CONSUMPTION', 'CREATE_STOCK_WRITEOFF') AND jsonb_typeof(new_data->'witness') = 'object' AND new_data->'witness' ? 'password';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON mar_entries FROM emr_app;
  END IF;
END $$;
