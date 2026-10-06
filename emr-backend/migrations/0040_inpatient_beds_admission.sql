-- 0040_inpatient_beds_admission.sql
-- სტაციონარი (IPD), ეტაპი 1: საწოლფონდი + ჰოსპიტალიზაცია (მოდული „inpatient“; ყველა წესი — კლინიკის პარამეტრი)
--   საწოლფონდი: განყოფილება (type = inpatient) → პალატა (სქესი, იზოლაცია) → საწოლი (ტიპი — რედაქტირებადი ცნობარი; დამატებითი / overflow)
--     სტატუსები: თავისუფალი / დაჯავშნილი / დაკავებული / დასალაგებელი / დაბლოკილი (მიზეზით); ყველაფერი — ადმინისტრატორის პანელიდან
--     ისტორიის მქონე საწოლი / პალატა არ იშლება — ითიშება
--   ჰოსპიტალიზაცია: ახალი ვიზიტი type = 'inpatient' (წყარო ვიზიტთან — parent_encounter_id), ჰოსპიტალიზაციის № (IP26-000001),
--     მიმღები დიაგნოზი, მკურნალი ექიმი, წყარო (სასწრაფო / ამბულატორია / გეგმიური / სხვა კლინიკიდან / პირდაპირ)
--     საწოლის მინიჭება: ორ ნაბიჯად (მიმღები → განყოფილება, განყოფილება → საწოლი) ან პირდაპირ — პარამეტრი
--     ეპიზოდები (bed_assignments): განყოფილება + საწოლი, დრო, მიზეზი, ავტორი — გადაყვანა / გაწერა (0041) იმავე ცხრილს იყენებს
--   გეგმიური ჰოსპიტალიზაციის რიგი: თარიღი, საწოლის დაჯავშნა, SMS შეხსენება წინა დღეს (პაციენტის SMS თანხმობით)
--   სამაჯური: Zebra (ZPL, ქსელით TCP 9100) ან PDF; პრინტერების რეესტრი
--   ჰოსპიტალიზაციის თანხმობა — consent_types (ტექსტი ვერსიებით: ადმინისტრირება → თანხმობები)

INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('inpatient', 'სტაციონარი', 'საწოლფონდი (პალატები, საწოლები, სტატუსები), ჰოსპიტალიზაცია, საწოლის მინიჭება, განყოფილების დაფა, გეგმიური ჰოსპიტალიზაციის რიგი, სამაჯური', TRUE,
 '{"bed_assign_mode": "two_step", "cleaning_required": true, "sex_rule": "warn", "overflow_beds": true, "planned_queue": true, "planned_sms": true,
   "cancel_hours": 24, "wristband": true, "wristband_print": "zpl", "wristband_width_mm": 25, "wristband_length_mm": 279, "wristband_offset_mm": 50}', 30);

-- ---------------------------------------------------------------- ვიზიტი: წყარო ვიზიტი (ER / ამბულატორია → სტაციონარი)
ALTER TABLE encounters ADD COLUMN parent_encounter_id UUID REFERENCES encounters(id);
CREATE INDEX idx_encounters_parent ON encounters (parent_encounter_id) WHERE parent_encounter_id IS NOT NULL;
CREATE INDEX idx_encounters_type_status ON encounters (type, status);

-- ---------------------------------------------------------------- ცნობარები
CREATE TABLE bed_types (
    code        VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
    name        VARCHAR(80) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
INSERT INTO bed_types (code, name, sort_order) VALUES
('standard', 'ჩვეულებრივი', 10), ('icu', 'ინტენსიური (ICU)', 20), ('isolation', 'იზოლატორი', 30), ('pediatric', 'ბავშვის', 40),
('neonatal', 'ახალშობილის (ინკუბატორი)', 50), ('vip', 'გაუმჯობესებული', 60), ('day', 'დღის სტაციონარი', 70);

-- ---------------------------------------------------------------- საწოლფონდი
CREATE TABLE wards (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id     UUID NOT NULL REFERENCES departments(id),
    code              VARCHAR(20) NOT NULL CHECK (length(btrim(code)) >= 1),      -- პალატის № (მაგ. 301)
    name              VARCHAR(120),
    floor             VARCHAR(20),
    sex               VARCHAR(6) NOT NULL DEFAULT 'mixed' CHECK (sex IN ('male', 'female', 'mixed')),
    isolation_capable BOOLEAN NOT NULL DEFAULT FALSE,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order        INT NOT NULL DEFAULT 100,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (department_id, code)
);
CREATE TRIGGER trg_wards_updated_at BEFORE UPDATE ON wards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE beds (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ward_id       UUID NOT NULL REFERENCES wards(id),
    code          VARCHAR(20) NOT NULL CHECK (length(btrim(code)) >= 1),          -- საწოლის აღნიშვნა (მაგ. 301-1)
    type_code     VARCHAR(30) NOT NULL DEFAULT 'standard' REFERENCES bed_types(code),
    is_overflow   BOOLEAN NOT NULL DEFAULT FALSE,                                  -- დამატებითი (დერეფანი და სხვ.) — სტატისტიკაში ცალკე
    status        VARCHAR(10) NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'reserved', 'occupied', 'cleaning', 'blocked')),
    status_reason TEXT,
    status_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status_by     UUID REFERENCES users(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INT NOT NULL DEFAULT 100,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (ward_id, code),
    CONSTRAINT chk_bed_block_reason CHECK (status <> 'blocked' OR status_reason IS NOT NULL),
    CONSTRAINT chk_bed_inactive_free CHECK (is_active OR status IN ('free', 'blocked', 'cleaning'))
);
CREATE INDEX idx_beds_ward ON beds (ward_id) WHERE is_active;

-- ---------------------------------------------------------------- გეგმიური ჰოსპიტალიზაციის რიგი
CREATE TABLE inpatient_planned (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plan_no        VARCHAR(20) NOT NULL UNIQUE,                                    -- PL26-000001
    patient_id     UUID NOT NULL REFERENCES patients(id),
    department_id  UUID NOT NULL REFERENCES departments(id),
    doctor_id      UUID REFERENCES users(id),
    planned_date   DATE NOT NULL,
    icd10_code     VARCHAR(10),
    icd10_title    TEXT,
    reason         TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    notes          TEXT,
    bed_id         UUID REFERENCES beds(id),                                       -- დაჯავშნილი საწოლი
    status         VARCHAR(10) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'admitted', 'cancelled')),
    encounter_id   UUID REFERENCES encounters(id),
    sms_sent_at    TIMESTAMPTZ,
    cancel_reason  TEXT,
    created_by     UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_planned_cancel CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
    CONSTRAINT chk_planned_admitted CHECK (status <> 'admitted' OR encounter_id IS NOT NULL)
);
CREATE TRIGGER trg_inpatient_planned_updated_at BEFORE UPDATE ON inpatient_planned FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_inpatient_planned_date ON inpatient_planned (planned_date, department_id) WHERE status = 'waiting';
CREATE UNIQUE INDEX ux_inpatient_planned_bed ON inpatient_planned (bed_id) WHERE status = 'waiting' AND bed_id IS NOT NULL;

-- ---------------------------------------------------------------- ჰოსპიტალიზაცია
CREATE TABLE inpatient_stays (
    encounter_id          UUID PRIMARY KEY REFERENCES encounters(id),
    adm_no                VARCHAR(20) NOT NULL UNIQUE,                             -- IP26-000001 (სამაჯურის შტრიხკოდი)
    patient_id            UUID NOT NULL REFERENCES patients(id),
    source                VARCHAR(12) NOT NULL CHECK (source IN ('emergency', 'outpatient', 'planned', 'transfer_in', 'direct')),
    source_encounter_id   UUID REFERENCES encounters(id),
    referral_id           UUID REFERENCES referrals(id),
    planned_id            UUID REFERENCES inpatient_planned(id),
    referring_institution TEXT,                                                     -- სხვა კლინიკიდან გადმოყვანისას
    severity              VARCHAR(10) CHECK (severity IN ('stable', 'moderate', 'severe', 'critical')),
    isolation             VARCHAR(10) CHECK (isolation IN ('contact', 'droplet', 'airborne', 'protective')),
    admitted_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    admitted_by           UUID NOT NULL REFERENCES users(id),
    status                VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discharged', 'cancelled')),
    ended_at              TIMESTAMPTZ,
    cancel_reason         TEXT,
    CONSTRAINT chk_stay_transfer_in CHECK (source <> 'transfer_in' OR referring_institution IS NOT NULL),
    CONSTRAINT chk_stay_cancel CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE UNIQUE INDEX ux_inpatient_stays_patient_active ON inpatient_stays (patient_id) WHERE status = 'active';
CREATE INDEX idx_inpatient_stays_admitted ON inpatient_stays (admitted_at);

-- ეპიზოდი: სად არის პაციენტი (განყოფილება; საწოლი — NULL, სანამ განყოფილება არ მიანიჭებს)
-- საწოლის შეცვლა / გადაყვანა / გაწერა — ძველი იხურება (ended_at, end_kind), იქმნება ახალი
CREATE TABLE bed_assignments (
    id             BIGSERIAL PRIMARY KEY,
    encounter_id   UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    department_id  UUID NOT NULL REFERENCES departments(id),
    bed_id         UUID REFERENCES beds(id),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bed_at         TIMESTAMPTZ,                                                     -- როდის მიენიჭა საწოლი
    reason         TEXT,
    assigned_by    UUID NOT NULL REFERENCES users(id),
    bed_by         UUID REFERENCES users(id),
    ended_at       TIMESTAMPTZ,
    ended_by       UUID REFERENCES users(id),
    end_kind       VARCHAR(12) CHECK (end_kind IN ('bed_change', 'transfer', 'discharge', 'cancel')),
    CONSTRAINT chk_assignment_end CHECK ((ended_at IS NULL) = (end_kind IS NULL)),
    CONSTRAINT chk_assignment_bed CHECK ((bed_id IS NULL) = (bed_at IS NULL))
);
CREATE UNIQUE INDEX ux_bed_assignments_encounter ON bed_assignments (encounter_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX ux_bed_assignments_bed ON bed_assignments (bed_id) WHERE ended_at IS NULL AND bed_id IS NOT NULL;
CREATE INDEX idx_bed_assignments_department ON bed_assignments (department_id) WHERE ended_at IS NULL;

-- ისტორია (ჰოსპიტალიზაცია, საწოლი, ექიმი, მდგომარეობა, საწოლის სტატუსები, რიგი, სამაჯური) — უცვლელი
CREATE TABLE inpatient_events (
    id            BIGSERIAL PRIMARY KEY,
    encounter_id  UUID REFERENCES encounters(id),
    bed_id        UUID REFERENCES beds(id),
    planned_id    UUID REFERENCES inpatient_planned(id),
    kind          VARCHAR(24) NOT NULL CHECK (kind IN ('admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled',
                    'bed_cleaned', 'bed_blocked', 'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled',
                    'planned_sms', 'wristband')),
    data          JSONB NOT NULL DEFAULT '{}',
    user_id       UUID REFERENCES users(id),
    at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_inpatient_events_encounter ON inpatient_events (encounter_id, at) WHERE encounter_id IS NOT NULL;
CREATE INDEX idx_inpatient_events_bed ON inpatient_events (bed_id, at) WHERE bed_id IS NOT NULL;
CREATE OR REPLACE FUNCTION inpatient_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ისტორია არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'inpatient_events_immutable'; END $$;
CREATE TRIGGER trg_inpatient_events_immutable BEFORE UPDATE OR DELETE ON inpatient_events FOR EACH ROW EXECUTE FUNCTION inpatient_events_immutable();

-- ---------------------------------------------------------------- ეტიკეტების / სამაჯურის პრინტერები (ქსელური, RAW TCP)
CREATE TABLE label_printers (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name           VARCHAR(120) NOT NULL UNIQUE,
    kind           VARCHAR(12) NOT NULL DEFAULT 'wristband' CHECK (kind IN ('wristband', 'label')),
    host           VARCHAR(255) NOT NULL CHECK (host ~ '^[A-Za-z0-9.:-]+$'),
    port           INT NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
    dpi            INT NOT NULL DEFAULT 203 CHECK (dpi IN (203, 300, 600)),
    department_id  UUID REFERENCES departments(id),                                -- ნაგულისხმევი პრინტერი განყოფილებისთვის (NULL — საერთო)
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- ჰოსპიტალიზაციის თანხმობა (ტექსტი — ადმინისტრირება → თანხმობები)
INSERT INTO consent_types (code, name, scope, sort_order) VALUES
  ('HOSPITALIZATION', 'ინფორმირებული თანხმობა ჰოსპიტალიზაციაზე', 'encounter', 45);
INSERT INTO consent_type_versions (type_code, version, body_text) VALUES
  ('HOSPITALIZATION', 1, '[ტექსტი დასამტკიცებელია. ჰოსპიტალიზაციის თანხმობის სრული ტექსტი უნდა მოამზადოს კლინიკის იურისტმა და ადმინისტრატორმა ჩასვას სისტემაში: ადმინისტრირება → თანხმობები.]');

-- ისტორია: აპლიკაცია ვერ წაშლის
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON inpatient_stays, bed_assignments, inpatient_planned, wards, beds FROM emr_app;
  END IF;
END $$;
