-- 0042_ipd_orders.sql
-- სტაციონარი, ეტაპი 0042 — ექიმის დანიშნულებები (CPOE), შემოწმებები, ფარმაცევტის ვერიფიკაცია.
-- (MAR — მიღების ფურცელი, მარაგის ჩამოწერა, ბილინგი — 0043.)
--
--  • med_frequencies — სიხშირეების ცნობარი (admin): სტანდარტული საათები ან ინტერვალი; დღიური რაოდენობა.
--  • med_orders — დანიშნულება ჰოსპიტალიზაციაზე:
--      category: medication / diet / nursing / activity (არამედიკამენტური — ტექსტი, არასავალდებულო სიხშირით);
--      medication: ჯენერიკი (ან თავისუფალი ტექსტი — „კატალოგის გარეშე“), დოზა (ფიქსირებული ან მგ/კგ → გადათვლილი), გზა,
--        ტიპი: scheduled / once / prn / continuous (ინფუზია მლ/სთ), ხანგრძლივობა (დღეები ან „გაუქმებამდე“).
--      სტატუსი: active → on_hold ⇄ active → stopped / completed. აქტიური დანიშნულება არ რედაქტირდება:
--        შეცვლა = ძველის შეწყვეტა + ახალი (replaces_id).
--      ვერიფიკაცია (ფარმაცევტი): not_required / pending / verified / rejected — პარამეტრით (ყველა / მაღალი რისკის / გამორთული).
--      დამტკიცება (სარეზერვო ანტიბიოტიკი): not_required / pending / approved / rejected.
--      ზეპირი დანიშნულება: შეიყვანა ექთანმა ექიმის სახელით → ექიმი ადასტურებს (verbal_confirmed_at).
--      შემოწმებები (ალერგია, დოზა, ურთიერთქმედება, დუბლირება, გზა, წონა) — snapshot (checks) + override მიზეზი.
--      მომარაგება: ward (განყოფილების მარაგი) / pharmacy (აფთიაქიდან პაციენტზე — stock_request ვერიფიკაციისას).
--  • med_order_events — ისტორია (უცვლელი).
--  • med_order_sets — შაბლონები: პირადი (ექიმი) და განყოფილების (ხელმძღვანელი).

-- ================================================================ 1. სიხშირეები
CREATE TABLE med_frequencies (
    code            VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
    name            TEXT NOT NULL CHECK (length(btrim(name)) >= 1),
    times_of_day    TIME[],                          -- სტანდარტული საათები (08:00, 14:00, 20:00)
    interval_hours  SMALLINT CHECK (interval_hours BETWEEN 1 AND 72),   -- ან ინტერვალი (ყოველ 8 სთ)
    per_day         NUMERIC(6,3) NOT NULL CHECK (per_day > 0),         -- დღიური რაოდენობა (დოზის შემოწმებისთვის)
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 100,
    CONSTRAINT chk_freq_kind CHECK ((times_of_day IS NOT NULL AND cardinality(times_of_day) >= 1) <> (interval_hours IS NOT NULL))
);
INSERT INTO med_frequencies (code, name, times_of_day, interval_hours, per_day, sort_order) VALUES
 ('QD',   'დღეში 1-ჯერ',      ARRAY['08:00']::time[],                         NULL, 1, 10),
 ('BID',  'დღეში 2-ჯერ',      ARRAY['08:00','20:00']::time[],                 NULL, 2, 20),
 ('TID',  'დღეში 3-ჯერ',      ARRAY['08:00','14:00','20:00']::time[],         NULL, 3, 30),
 ('QID',  'დღეში 4-ჯერ',      ARRAY['06:00','12:00','18:00','00:00']::time[], NULL, 4, 40),
 ('Q4H',  'ყოველ 4 სთ-ში',    NULL, 4,  6, 50),
 ('Q6H',  'ყოველ 6 სთ-ში',    NULL, 6,  4, 60),
 ('Q8H',  'ყოველ 8 სთ-ში',    NULL, 8,  3, 70),
 ('Q12H', 'ყოველ 12 სთ-ში',   NULL, 12, 2, 80),
 ('Q24H', 'ყოველ 24 სთ-ში',   NULL, 24, 1, 90),
 ('HS',   'ძილის წინ',        ARRAY['22:00']::time[],                         NULL, 1, 100),
 ('QAM',  'დილით',            ARRAY['08:00']::time[],                         NULL, 1, 110),
 ('QPM',  'საღამოს',          ARRAY['18:00']::time[],                         NULL, 1, 120);

-- ================================================================ 2. დანიშნულებები
CREATE TABLE med_orders (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id         UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id           UUID NOT NULL REFERENCES patients(id),
    category             VARCHAR(12) NOT NULL DEFAULT 'medication' CHECK (category IN ('medication', 'diet', 'nursing', 'activity')),
    -- მედიკამენტი
    generic_id           UUID REFERENCES med_generics(id),
    drug_text            TEXT,                                   -- კატალოგის გარეშე (პაციენტის საკუთარი წამალი და სხვ.)
    order_type           VARCHAR(12) CHECK (order_type IN ('scheduled', 'once', 'prn', 'continuous')),
    dose                 NUMERIC(14,4) CHECK (dose > 0),          -- ერთჯერადი დოზა (dose_unit) — მგ/კგ-ზე: გადათვლილი
    dose_unit            VARCHAR(10),
    dose_per_kg          NUMERIC(14,4) CHECK (dose_per_kg > 0),   -- მგ/კგ რეჟიმი (dose = dose_per_kg × weight_kg)
    weight_kg            NUMERIC(6,2) CHECK (weight_kg BETWEEN 0.2 AND 400),   -- გამოყენებული წონა
    route_code           VARCHAR(10) REFERENCES med_routes(code),
    frequency_code       VARCHAR(20) REFERENCES med_frequencies(code),
    prn_reason           TEXT,
    prn_max_per_day      SMALLINT CHECK (prn_max_per_day BETWEEN 1 AND 48),
    prn_min_interval_h   NUMERIC(4,1) CHECK (prn_min_interval_h > 0),
    -- ინფუზია
    diluent              TEXT,
    volume_ml            NUMERIC(8,1) CHECK (volume_ml > 0),
    rate_ml_h            NUMERIC(8,2) CHECK (rate_ml_h > 0),
    duration_min         INT CHECK (duration_min > 0),
    -- არამედიკამენტური / ინსტრუქცია
    text                 TEXT,
    instructions         TEXT,
    -- დრო
    start_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    duration_days        SMALLINT CHECK (duration_days BETWEEN 1 AND 365),
    end_at               TIMESTAMPTZ,                             -- start_at + duration_days (NULL — გაუქმებამდე)
    -- სტატუსი
    status               VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'stopped', 'completed')),
    hold_reason          TEXT,
    stopped_at           TIMESTAMPTZ,
    stopped_by           UUID REFERENCES users(id),
    stop_reason          TEXT,
    replaces_id          UUID REFERENCES med_orders(id),
    -- ავტორი
    ordered_by           UUID NOT NULL REFERENCES users(id),      -- ექიმი (ზეპირზე — ვისი სახელით)
    entered_by           UUID NOT NULL REFERENCES users(id),      -- ვინ შეიყვანა
    is_verbal            BOOLEAN NOT NULL DEFAULT FALSE,
    verbal_confirmed_at  TIMESTAMPTZ,
    verbal_notified_at   TIMESTAMPTZ,
    set_id               UUID,                                    -- შაბლონიდან (ინფორმაციული)
    -- შემოწმებები
    checks               JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{code, level, message}]
    override_reason      TEXT,
    -- ფარმაცევტის ვერიფიკაცია
    verify_status        VARCHAR(12) NOT NULL DEFAULT 'not_required' CHECK (verify_status IN ('not_required', 'pending', 'verified', 'rejected')),
    verified_by          UUID REFERENCES users(id),
    verified_at          TIMESTAMPTZ,
    verify_note          TEXT,
    -- სარეზერვო ანტიბიოტიკის დამტკიცება
    approval_status      VARCHAR(12) NOT NULL DEFAULT 'not_required' CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
    approved_by          UUID REFERENCES users(id),
    approved_at          TIMESTAMPTZ,
    approval_note        TEXT,
    -- მომარაგება
    supply_mode          VARCHAR(10) CHECK (supply_mode IN ('ward', 'pharmacy')),
    stock_request_id     UUID REFERENCES stock_requests(id),
    end_notified_at      TIMESTAMPTZ,                             -- ანტიბიოტიკი: დასრულებამდე შეხსენება
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_mo_med CHECK (category <> 'medication' OR (
        (generic_id IS NOT NULL OR length(btrim(coalesce(drug_text, ''))) >= 2)
        AND order_type IS NOT NULL AND route_code IS NOT NULL AND supply_mode IS NOT NULL
        AND (order_type = 'continuous' OR (dose IS NOT NULL AND dose_unit IS NOT NULL))
        AND (order_type <> 'continuous' OR rate_ml_h IS NOT NULL)
        AND (order_type <> 'scheduled' OR frequency_code IS NOT NULL)
        AND (order_type <> 'prn' OR length(btrim(coalesce(prn_reason, ''))) >= 2)
        AND (dose_per_kg IS NULL OR weight_kg IS NOT NULL))),
    CONSTRAINT chk_mo_nonmed CHECK (category = 'medication' OR (length(btrim(coalesce(text, ''))) >= 2 AND generic_id IS NULL AND drug_text IS NULL
        AND verify_status = 'not_required' AND approval_status = 'not_required')),
    CONSTRAINT chk_mo_end CHECK (end_at IS NULL OR end_at > start_at),
    CONSTRAINT chk_mo_stopped CHECK ((status IN ('stopped', 'completed')) = (stopped_at IS NOT NULL)
        AND (status <> 'stopped' OR (stopped_by IS NOT NULL AND length(btrim(coalesce(stop_reason, ''))) >= 2))),
    CONSTRAINT chk_mo_hold CHECK (status <> 'on_hold' OR length(btrim(coalesce(hold_reason, ''))) >= 2),
    CONSTRAINT chk_mo_verified CHECK (verify_status NOT IN ('verified', 'rejected') OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
    CONSTRAINT chk_mo_rejected CHECK (verify_status <> 'rejected' OR length(btrim(coalesce(verify_note, ''))) >= 3),
    CONSTRAINT chk_mo_approved CHECK (approval_status NOT IN ('approved', 'rejected') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT chk_mo_verbal CHECK (is_verbal OR verbal_confirmed_at IS NULL),
    CONSTRAINT chk_mo_verbal_author CHECK (is_verbal = (entered_by <> ordered_by))
);
CREATE INDEX idx_med_orders_encounter ON med_orders (encounter_id, status, created_at DESC);
CREATE INDEX idx_med_orders_verify ON med_orders (created_at) WHERE verify_status = 'pending' AND status IN ('active', 'on_hold');
CREATE INDEX idx_med_orders_approval ON med_orders (created_at) WHERE approval_status = 'pending' AND status IN ('active', 'on_hold');
CREATE INDEX idx_med_orders_verbal ON med_orders (ordered_by) WHERE is_verbal AND verbal_confirmed_at IS NULL;
CREATE INDEX idx_med_orders_end ON med_orders (end_at) WHERE status IN ('active', 'on_hold') AND end_at IS NOT NULL;
CREATE TRIGGER trg_med_orders_updated BEFORE UPDATE ON med_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- შინაარსი არ იცვლება (შეცვლა = ახალი დანიშნულება); იცვლება მხოლოდ სტატუსი, ვერიფიკაცია, დამტკიცება, მომარაგება, შეხსენებები
CREATE OR REPLACE FUNCTION med_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.encounter_id, NEW.patient_id, NEW.category, NEW.generic_id, NEW.drug_text, NEW.order_type, NEW.dose, NEW.dose_unit, NEW.dose_per_kg, NEW.weight_kg,
        NEW.route_code, NEW.frequency_code, NEW.prn_reason, NEW.prn_max_per_day, NEW.prn_min_interval_h, NEW.diluent, NEW.volume_ml, NEW.rate_ml_h,
        NEW.duration_min, NEW.text, NEW.instructions, NEW.start_at, NEW.duration_days, NEW.end_at, NEW.ordered_by, NEW.entered_by, NEW.is_verbal,
        NEW.checks, NEW.override_reason, NEW.replaces_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.encounter_id, OLD.patient_id, OLD.category, OLD.generic_id, OLD.drug_text, OLD.order_type, OLD.dose, OLD.dose_unit, OLD.dose_per_kg, OLD.weight_kg,
        OLD.route_code, OLD.frequency_code, OLD.prn_reason, OLD.prn_max_per_day, OLD.prn_min_interval_h, OLD.diluent, OLD.volume_ml, OLD.rate_ml_h,
        OLD.duration_min, OLD.text, OLD.instructions, OLD.start_at, OLD.duration_days, OLD.end_at, OLD.ordered_by, OLD.entered_by, OLD.is_verbal,
        OLD.checks, OLD.override_reason, OLD.replaces_id, OLD.created_at) THEN
        RAISE EXCEPTION 'დანიშნულება არ რედაქტირდება — შეცვლა: შეწყვეტა + ახალი დანიშნულება' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status IN ('stopped', 'completed') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'შეწყვეტილი / დასრულებული დანიშნულება ვეღარ განახლდება' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_med_orders_guard BEFORE UPDATE ON med_orders FOR EACH ROW EXECUTE FUNCTION med_orders_guard();

-- ================================================================ 3. ისტორია
CREATE TABLE med_order_events (
    id          BIGSERIAL PRIMARY KEY,
    order_id    UUID NOT NULL REFERENCES med_orders(id),
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'held', 'resumed', 'stopped', 'modified', 'completed', 'verified', 'verify_rejected',
                                                     'approved', 'approval_rejected', 'verbal_confirmed', 'supply_requested', 'end_reminder', 'discharge_stop')),
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    user_id     UUID REFERENCES users(id),
    at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_med_order_events_order ON med_order_events (order_id, at);
CREATE OR REPLACE FUNCTION med_order_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'დანიშნულების ისტორია უცვლელია' USING ERRCODE = 'check_violation'; END $$;
CREATE TRIGGER trg_med_order_events_immutable BEFORE UPDATE OR DELETE ON med_order_events FOR EACH ROW EXECUTE FUNCTION med_order_events_immutable();

-- ================================================================ 4. შაბლონები
CREATE TABLE med_order_sets (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name           TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    department_id  UUID REFERENCES departments(id),     -- განყოფილების (ხელმძღვანელი) — ან
    owner_id       UUID REFERENCES users(id),           -- პირადი (ექიმი)
    items          JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 40),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_by     UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_mos_scope CHECK ((department_id IS NULL) <> (owner_id IS NULL))
);
CREATE INDEX idx_med_order_sets_dep ON med_order_sets (department_id) WHERE is_active;
CREATE INDEX idx_med_order_sets_owner ON med_order_sets (owner_id) WHERE is_active;
CREATE TRIGGER trg_med_order_sets_updated BEFORE UPDATE ON med_order_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
    -- 0042
    'orders_stopped'));

UPDATE system_modules SET settings = settings || '{
    "med_verification": "high_risk",
    "dose_rule": "warn",
    "interaction_rule": "warn",
    "antibiotic_default_days": 7,
    "verbal_orders": true,
    "verbal_confirm_hours": 24,
    "weight_max_age_days": 7
}'::jsonb
WHERE code = 'inpatient';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON med_orders, med_order_events FROM emr_app;
    REVOKE UPDATE ON med_order_events FROM emr_app;
  END IF;
END $$;
