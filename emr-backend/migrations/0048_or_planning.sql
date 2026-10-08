-- 0048_or_planning.sql
-- საოპერაციო ბლოკი, ნაწილი 1 — დაგეგმვა (მოდული „or“). ნაწილი 2 (0049): ანესთეზიის რუკა, ოქმი, მასალები / დათვლა, CSSD, PACU, ბილინგი, სტატისტიკა.
--
--  • #0 სტრუქტურა: departments.type = 'or' (საოპერაციო ბლოკი); ბლოკს მიბმული საწყობის ლოკაცია (departments.or_stock_location_id);
--      ოთახები — or_rooms (სამუშაო საათები / დღეები, სპეციალობები, აქტიური); სპეციალობები — or_specialties (ადმინისტრირება).
--  • #2 პროცედურების კატალოგი — or_procedures (კოდი თავისუფალი + NCSP-თავსებადი ველი, სპეციალობა, ხანგრძლივობა, ტარიფი, მხარე).
--  • #1 მოთხოვნა / დაგეგმვა — or_cases: ყოველთვის ჰოსპიტალიზაციაზე (encounter_id) ან გეგმიურ რიგზე (planned_id → მიღებისას encounter_id
--      ავტომატურად); პროცედურ(ებ)ი + მხარე (or_case_procedures); სასწრაფოობა; ანესთეზიის ტიპი; იმპლანტი / აპარატურა / სისხლი;
--      ოთახი + დრო (ვინ გეგმავს — or_scheduling); გადადება / გაუქმება მიზეზით (or_cancel_reasons).
--  • #3 გუნდი — or_case_team (როლები — or_team_roles); დაწყების შემდეგ — შემოსვლა / გასვლა / შეცვლა დროით; or_cases.locked_at (0049: ოქმი).
--  • #4 წინასაოპერაციო — ანესთეზიოლოგის გასინჯვა (or_preop_assessments) + მზადყოფნის ჩეკლისტი (or_readiness_items / or_case_readiness);
--      თანხმობები OR_SURGERY / OR_ANESTHESIA (document_templates); სიმკაცრე — preop_readiness.
--  • #5 WHO ჩეკლისტი — Sign in → Time out → Sign out (or_who_items / or_who_checks). Time out-ის გარეშე „განაკვეთი“ — DB-ის დონეზე აკრძალულია;
--      Sign out-ის გარეშე „ოთახიდან გასვლა“ (დასრულება) — აკრძალულია.
--  • #6 სტატუსები / დროის ნიშნულები — or_case_times (შესწორება: ახალი ჩანაწერი + მიზეზი, ძველი — superseded).
--  • #14 უფლებები: or_schedule (კოორდინატორი / ბლოკის უფროსი), anesthesiologist, or_nurse — კატალოგში (როლებს კლინიკა ქმნის).
--  • ICU ეპიზოდი (0047): წყარო „საოპერაციო“, თუ პაციენტი ბოლო 12 სთ-ში ოპერაციიდან გამოვიდა.

-- ================================================================ 0. მოდული
INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('or', 'საოპერაციო ბლოკი', 'ოთახები, პროცედურების კატალოგი, მოთხოვნა / დაგეგმვა, ბლოკის დაფა, გუნდი, წინასაოპერაციო მზადყოფნა, WHO ჩეკლისტი, დროის ნიშნულები', TRUE,
 '{"or_scheduling": "coordinator",
   "anesthesia_team_by": "anesthesia_head",
   "preop_readiness": "warn",
   "turnover_min": 30,
   "default_duration_min": 60,
   "self_booking_days": 30,
   "notify_requests": true}', 33)
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 1. უფლებები
ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer',
        'storekeeper', 'stock_manager',
        'or_schedule', 'anesthesiologist', 'or_nurse']::VARCHAR(30)[]);

-- ================================================================ 2. სტრუქტურა: ბლოკი, სპეციალობები, ოთახები
ALTER TABLE departments DROP CONSTRAINT chk_departments_type;
ALTER TABLE departments ADD CONSTRAINT chk_departments_type CHECK (type IN ('inpatient', 'outpatient', 'diagnostic', 'administrative', 'or'));
ALTER TABLE departments
    ADD COLUMN or_stock_location_id UUID REFERENCES stock_locations(id),
    ADD CONSTRAINT chk_dep_or_location CHECK (or_stock_location_id IS NULL OR type = 'or');

CREATE TABLE or_specialties (
    code        VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
INSERT INTO or_specialties (code, name, sort_order) VALUES
 ('general',   'ზოგადი ქირურგია', 10), ('ortho', 'ორთოპედია / ტრავმატოლოგია', 20), ('gyn', 'გინეკოლოგია / მეანობა', 30),
 ('uro',       'უროლოგია', 40), ('neuro', 'ნეიროქირურგია', 50), ('ent', 'ოტორინოლარინგოლოგია', 60), ('ophth', 'ოფთალმოლოგია', 70),
 ('vascular',  'სისხლძარღვთა ქირურგია', 80), ('thoracic', 'თორაკალური ქირურგია', 90), ('cardiac', 'კარდიოქირურგია', 100),
 ('plastic',   'პლასტიკური ქირურგია', 110), ('pediatric', 'ბავშვთა ქირურგია', 120), ('maxfac', 'ყბა-სახის ქირურგია', 130);

CREATE TABLE or_rooms (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id  UUID NOT NULL REFERENCES departments(id),          -- ბლოკი (type = 'or')
    code           VARCHAR(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9_.-]{1,20}$'),
    name           TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    work_start     TIME NOT NULL DEFAULT '08:00',
    work_end       TIME NOT NULL DEFAULT '18:00',
    work_days      SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}' CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ '{1,2,3,4,5,6,7}'),   -- ISO: 1 = ორშაბათი
    specialties    VARCHAR(30)[] NOT NULL DEFAULT '{}',              -- ცარიელი = ნებისმიერი სპეციალობა
    emergency_only BOOLEAN NOT NULL DEFAULT FALSE,                    -- გადაუდებლის ოთახი (გეგმიური — გაფრთხილებით)
    notes          TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INT NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (department_id, code),
    CONSTRAINT chk_or_room_hours CHECK (work_end > work_start)
);
CREATE TRIGGER trg_or_rooms_updated BEFORE UPDATE ON or_rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ოთახი — მხოლოდ საოპერაციო ბლოკში; ბლოკის ლოკაცია — საწყობის ლოკაცია
CREATE OR REPLACE FUNCTION or_room_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.type = 'or') THEN
        RAISE EXCEPTION 'ოთახი მხოლოდ საოპერაციო ბლოკს (განყოფილების ტიპი „or“) ეკუთვნის' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.specialties) s WHERE s NOT IN (SELECT code FROM or_specialties)) THEN
        RAISE EXCEPTION 'უცნობი სპეციალობა' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_room_check BEFORE INSERT OR UPDATE ON or_rooms FOR EACH ROW EXECUTE FUNCTION or_room_check();

-- ================================================================ 3. პროცედურების კატალოგი
CREATE TABLE or_procedures (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                  VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),   -- კლინიკის კოდი (თავისუფალი)
    ncsp_code             VARCHAR(10) CHECK (ncsp_code ~ '^[A-Z]{3}[0-9]{2}[A-Z0-9]?$'),                      -- NCSP-თავსებადი (DRG grouper-ისთვის)
    name                  TEXT NOT NULL CHECK (length(btrim(name)) >= 3),
    specialty_code        VARCHAR(30) REFERENCES or_specialties(code),
    default_duration_min  SMALLINT NOT NULL DEFAULT 60 CHECK (default_duration_min BETWEEN 5 AND 1440),
    laterality            BOOLEAN NOT NULL DEFAULT FALSE,             -- მხარე სავალდებულოა (მარცხ. / მარჯვ. / ორმხრივი)
    tariff_id             UUID REFERENCES service_tariffs(id),         -- ბილინგი — 0049
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_or_procedures_name ON or_procedures USING gin (to_tsvector('simple', name));
CREATE TRIGGER trg_or_procedures_updated BEFORE UPDATE ON or_procedures FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ================================================================ 4. ცნობარები: გუნდის როლები, გაუქმების მიზეზები
CREATE TABLE or_team_roles (
    code        VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    grp         VARCHAR(10) NOT NULL CHECK (grp IN ('surgical', 'anesthesia', 'nursing')),   -- ვინ ნიშნავს: ქირურგიული / ანესთეზიის (anesthesia_team_by) / საექთნო
    capability  VARCHAR(30) NOT NULL CHECK (capability IN ('doctor', 'anesthesiologist', 'or_nurse', 'nurse')),   -- ვის შეიძლება მიენიჭოს
    multiple    BOOLEAN NOT NULL DEFAULT FALSE,
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,                 -- surgeon / anesthesiologist — სისტემაში გამოიყენება
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100,
    CONSTRAINT chk_or_role_system CHECK (NOT (is_system AND NOT is_active))
);
INSERT INTO or_team_roles (code, name, grp, capability, multiple, is_system, sort_order) VALUES
 ('surgeon',           'ოპერატორი ქირურგი',            'surgical',   'doctor',           FALSE, TRUE,  10),
 ('assistant',         'ასისტენტი',                    'surgical',   'doctor',           TRUE,  FALSE, 20),
 ('anesthesiologist',  'ანესთეზიოლოგი',                'anesthesia', 'anesthesiologist', FALSE, TRUE,  30),
 ('anesthesia_nurse',  'ანესთეზიის ექთანი',            'anesthesia', 'or_nurse',         TRUE,  FALSE, 40),
 ('scrub_nurse',       'საოპერაციო (სკრაბ) ექთანი',     'nursing',    'or_nurse',         TRUE,  FALSE, 50),
 ('circulating_nurse', 'მოძრავი ექთანი',               'nursing',    'or_nurse',         TRUE,  FALSE, 60);

CREATE TABLE or_cancel_reasons (
    code        VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
INSERT INTO or_cancel_reasons (code, name, sort_order) VALUES
 ('patient_condition', 'პაციენტის მდგომარეობა (უკუჩვენება)', 10), ('patient_refused', 'პაციენტის უარი', 20),
 ('not_ready', 'წინასაოპერაციო მზადება არ დასრულდა', 30), ('no_bed', 'ICU / პალატის საწოლი არ არის', 40),
 ('equipment', 'აპარატურა / ინსტრუმენტი / იმპლანტი', 50), ('staff', 'ქირურგი / ანესთეზიოლოგი არ არის', 60),
 ('time_overrun', 'წინა ოპერაცია გაგრძელდა', 70), ('emergency', 'გადაუდებელმა ოპერაციამ გადაწია', 80), ('other', 'სხვა', 900);

-- ================================================================ 5. ოპერაცია (მოთხოვნა → დაგეგმვა → მსვლელობა)
CREATE TABLE or_cases (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_no                   VARCHAR(20) NOT NULL UNIQUE,                                  -- OR26-000001
    patient_id                UUID NOT NULL REFERENCES patients(id),
    encounter_id              UUID REFERENCES inpatient_stays(encounter_id),                -- ჰოსპიტალიზაცია (დღის სტაციონარიც)
    planned_id                UUID REFERENCES inpatient_planned(id),                        -- გეგმიური რიგიდან (მიღებამდე)
    department_id             UUID NOT NULL REFERENCES departments(id),                     -- ქირურგიული განყოფილება (ხელმძღვანელის უფლება)
    surgeon_id                UUID NOT NULL REFERENCES users(id),                           -- ოპერატორი ქირურგი
    requested_by              UUID NOT NULL REFERENCES users(id),
    requested_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    urgency                   VARCHAR(10) NOT NULL DEFAULT 'elective' CHECK (urgency IN ('elective', 'urgent', 'emergency')),
    icd10_code                VARCHAR(10) REFERENCES icd10_codes(code),                     -- წინასაოპერაციო დიაგნოზი
    icd10_title               TEXT,
    preferred_date            DATE,
    preferred_time            TIME,
    duration_min              SMALLINT NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
    anesthesia_type           VARCHAR(12) NOT NULL CHECK (anesthesia_type IN ('general', 'spinal', 'epidural', 'combined', 'regional', 'sedation', 'local', 'none')),
    preferred_anesthesiologist_id UUID REFERENCES users(id),                                -- ქირურგის სურვილი (anesthesia_team_by = anesthesia_head)
    needs_implant             BOOLEAN NOT NULL DEFAULT FALSE,
    needs_equipment           TEXT,                                                         -- აპარატურა (C-რკალი, ლაპაროსკოპი…)
    needs_blood               BOOLEAN NOT NULL DEFAULT FALSE,
    blood_note                TEXT,                                                         -- კომპონენტი / დოზა
    needs_icu                 BOOLEAN NOT NULL DEFAULT FALSE,                               -- ოპერაციის შემდეგ ICU საწოლი
    notes                     TEXT,
    status                    VARCHAR(12) NOT NULL DEFAULT 'requested'
                              CHECK (status IN ('requested', 'tentative', 'scheduled', 'in_progress', 'completed', 'cancelled')),
    block_id                  UUID REFERENCES departments(id),
    room_id                   UUID REFERENCES or_rooms(id),
    scheduled_start           TIMESTAMPTZ,
    scheduled_end             TIMESTAMPTZ,
    scheduled_by              UUID REFERENCES users(id),
    scheduled_at              TIMESTAMPTZ,
    schedule_warnings         TEXT[],                                                       -- დადასტურებული გაფრთხილებები (გადაფარვა, საათები…)
    readiness_override        TEXT,                                                         -- preop_readiness = warn: დასაბუთება
    readiness_override_by     UUID REFERENCES users(id),
    cancel_reason_code        VARCHAR(30) REFERENCES or_cancel_reasons(code),
    cancel_note               TEXT,
    cancelled_by              UUID REFERENCES users(id),
    cancelled_at              TIMESTAMPTZ,
    postpone_count            SMALLINT NOT NULL DEFAULT 0,
    locked_at                 TIMESTAMPTZ,                                                  -- 0049: ოქმის ხელმოწერა → გუნდი / ნიშნულები დაბლოკილია
    updated_by                UUID REFERENCES users(id),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_or_case_source CHECK (encounter_id IS NOT NULL OR planned_id IS NOT NULL),
    CONSTRAINT chk_or_case_slot CHECK ((room_id IS NULL) = (scheduled_start IS NULL) AND (scheduled_start IS NULL) = (scheduled_end IS NULL)
                                       AND (scheduled_end IS NULL OR scheduled_end > scheduled_start) AND (room_id IS NULL) = (block_id IS NULL)),
    CONSTRAINT chk_or_case_scheduled CHECK (status IN ('requested', 'cancelled') OR room_id IS NOT NULL),
    CONSTRAINT chk_or_case_requested CHECK (status <> 'requested' OR room_id IS NULL),
    CONSTRAINT chk_or_case_started CHECK (status NOT IN ('in_progress', 'completed') OR encounter_id IS NOT NULL),
    CONSTRAINT chk_or_case_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (status <> 'cancelled' OR cancel_reason_code IS NOT NULL))
);
CREATE INDEX idx_or_cases_room ON or_cases (room_id, scheduled_start) WHERE status IN ('tentative', 'scheduled', 'in_progress');
CREATE INDEX idx_or_cases_queue ON or_cases (status, urgency, requested_at) WHERE status = 'requested';
CREATE INDEX idx_or_cases_encounter ON or_cases (encounter_id);
CREATE INDEX idx_or_cases_planned ON or_cases (planned_id) WHERE planned_id IS NOT NULL;
CREATE INDEX idx_or_cases_patient ON or_cases (patient_id, requested_at);
CREATE INDEX idx_or_cases_start ON or_cases (scheduled_start) WHERE scheduled_start IS NOT NULL;
CREATE TRIGGER trg_or_cases_updated BEFORE UPDATE ON or_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE or_case_procedures (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       UUID NOT NULL REFERENCES or_cases(id) ON DELETE CASCADE,
    procedure_id  UUID NOT NULL REFERENCES or_procedures(id),
    side          VARCHAR(10) NOT NULL DEFAULT 'na' CHECK (side IN ('left', 'right', 'bilateral', 'na')),
    is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order    SMALLINT NOT NULL DEFAULT 0,
    note          TEXT
);
CREATE UNIQUE INDEX ux_or_case_primary ON or_case_procedures (case_id) WHERE is_primary;
CREATE INDEX idx_or_case_procedures ON or_case_procedures (case_id, sort_order);

-- გეგმიური რიგიდან მიღება → ოპერაციას ჰოსპიტალიზაცია ებმება; რიგის გაუქმება → მოთხოვნა რჩება (დაფაზე — გაფრთხილება)
CREATE OR REPLACE FUNCTION or_planned_admitted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'admitted' AND OLD.status IS DISTINCT FROM 'admitted' AND NEW.encounter_id IS NOT NULL THEN
        UPDATE or_cases SET encounter_id = NEW.encounter_id WHERE planned_id = NEW.id AND encounter_id IS NULL AND status <> 'cancelled';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_planned_admitted AFTER UPDATE OF status ON inpatient_planned FOR EACH ROW EXECUTE FUNCTION or_planned_admitted();

-- ================================================================ 6. გუნდი
CREATE TABLE or_case_team (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id        UUID NOT NULL REFERENCES or_cases(id),
    role_code      VARCHAR(30) NOT NULL REFERENCES or_team_roles(code),
    user_id        UUID NOT NULL REFERENCES users(id),
    added_by       UUID NOT NULL REFERENCES users(id),
    added_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    in_at          TIMESTAMPTZ,                       -- დაწყების შემდეგ დამატებული — როდის შემოვიდა
    out_at         TIMESTAMPTZ,                       -- დაწყების შემდეგ — როდის გავიდა
    replaced_by    UUID REFERENCES or_case_team(id),  -- ვინ შეცვალა
    removed_at     TIMESTAMPTZ,                       -- დაწყებამდე მოხსნა (ან შეცდომით დამატებული)
    removed_by     UUID REFERENCES users(id),
    remove_reason  TEXT,
    CONSTRAINT chk_or_team_out CHECK (out_at IS NULL OR in_at IS NULL OR out_at >= in_at),
    CONSTRAINT chk_or_team_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX ux_or_team_member ON or_case_team (case_id, role_code, user_id) WHERE removed_at IS NULL AND out_at IS NULL;
CREATE INDEX idx_or_team_user ON or_case_team (user_id) WHERE removed_at IS NULL;
CREATE INDEX idx_or_team_case ON or_case_team (case_id);

-- ================================================================ 7. წინასაოპერაციო: ანესთეზიოლოგის გასინჯვა + მზადყოფნა
CREATE TABLE or_preop_assessments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id             UUID NOT NULL REFERENCES or_cases(id),
    patient_id          UUID NOT NULL REFERENCES patients(id),
    asa_class           SMALLINT CHECK (asa_class BETWEEN 1 AND 6),
    asa_emergency       BOOLEAN NOT NULL DEFAULT FALSE,              -- ASA „E“
    mallampati          SMALLINT CHECK (mallampati BETWEEN 1 AND 4),
    weight_kg           NUMERIC(5,1) CHECK (weight_kg BETWEEN 0.3 AND 400),
    height_cm           NUMERIC(4,1) CHECK (height_cm BETWEEN 20 AND 250),
    fasting_solids_at   TIMESTAMPTZ,                                 -- ბოლო საკვები
    fasting_liquids_at  TIMESTAMPTZ,                                 -- ბოლო გამჭვირვალე სითხე
    allergies           JSONB NOT NULL DEFAULT '[]',                 -- პაციენტის ალერგიები (ავტომატურად, ხელმოწერის მომენტისთვის)
    airway_notes        TEXT,
    comorbidities       TEXT,
    risks               TEXT[] NOT NULL DEFAULT '{}' CHECK (risks <@ ARRAY['difficult_airway', 'aspiration', 'cardiac', 'pulmonary', 'renal', 'hepatic',
                            'diabetes', 'obesity', 'bleeding', 'ponv', 'malignant_hyperthermia', 'allergy', 'other']::text[]),
    risk_notes          TEXT,
    planned_anesthesia  VARCHAR(12) CHECK (planned_anesthesia IN ('general', 'spinal', 'epidural', 'combined', 'regional', 'sedation', 'local', 'none')),
    plan_notes          TEXT,
    status              VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    signed_by           UUID REFERENCES users(id),
    signed_at           TIMESTAMPTZ,
    voided_at           TIMESTAMPTZ,
    voided_by           UUID REFERENCES users(id),
    void_reason         TEXT,
    CONSTRAINT chk_preop_signed CHECK ((status = 'signed') = (signed_at IS NOT NULL) AND (signed_at IS NULL) = (signed_by IS NULL)),
    CONSTRAINT chk_preop_sign_fields CHECK (status = 'draft' OR (asa_class IS NOT NULL AND mallampati IS NOT NULL AND planned_anesthesia IS NOT NULL)),
    CONSTRAINT chk_preop_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX ux_or_preop_case ON or_preop_assessments (case_id) WHERE voided_at IS NULL;
CREATE TRIGGER trg_or_preop_updated BEFORE UPDATE ON or_preop_assessments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- ხელმოწერილი გასინჯვა უცვლელია (მხოლოდ გაუქმება მიზეზით → ახალი)
CREATE OR REPLACE FUNCTION or_preop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'გაუქმებული გასინჯვა არ იცვლება' USING ERRCODE = 'check_violation'; END IF;
    IF OLD.status = 'signed' AND (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at']) THEN
        RAISE EXCEPTION 'ხელმოწერილი გასინჯვა არ რედაქტირდება — გააუქმეთ (მიზეზით) და შეავსეთ თავიდან' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_preop_guard BEFORE UPDATE ON or_preop_assessments FOR EACH ROW EXECUTE FUNCTION or_preop_guard();

-- მზადყოფნის ჩეკლისტის პუნქტები: წყარო — ხელით ან ავტომატური (თანხმობა / გასინჯვა); როდის ეხება — ყოველთვის / ანესთეზია / მხარე / სისხლი / იმპლანტი
CREATE TABLE or_readiness_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    label       TEXT NOT NULL CHECK (length(btrim(label)) >= 3),
    source      VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'consent_surgery', 'consent_anesthesia', 'assessment')),
    applies     VARCHAR(12) NOT NULL DEFAULT 'always' CHECK (applies IN ('always', 'anesthesia', 'laterality', 'blood', 'implant')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_or_readiness_auto ON or_readiness_items (source) WHERE source <> 'manual';
INSERT INTO or_readiness_items (label, source, applies, sort_order) VALUES
 ('ოპერაციის თანხმობა ხელმოწერილია', 'consent_surgery', 'always', 10),
 ('ანესთეზიის თანხმობა ხელმოწერილია', 'consent_anesthesia', 'anesthesia', 20),
 ('ანესთეზიოლოგის წინასაოპერაციო გასინჯვა (ხელმოწერილი)', 'assessment', 'anesthesia', 30),
 ('ოპერაციის ადგილი მონიშნულია', 'manual', 'laterality', 40),
 ('სისხლი / კომპონენტები მომზადებულია (ჯგუფი, თავსებადობა)', 'manual', 'blood', 50),
 ('კვლევები / ანალიზები განხილულია', 'manual', 'always', 60),
 ('შიმშილის რეჟიმი დაცულია', 'manual', 'anesthesia', 70),
 ('იმპლანტი / აპარატურა მზადაა', 'manual', 'implant', 80),
 ('სამაჯური / პაციენტის იდენტიფიკაცია შემოწმებულია', 'manual', 'always', 90);

CREATE TABLE or_case_readiness (
    case_id     UUID NOT NULL REFERENCES or_cases(id),
    item_id     UUID NOT NULL REFERENCES or_readiness_items(id),
    answer      VARCHAR(3) NOT NULL CHECK (answer IN ('yes', 'no', 'na')),
    note        TEXT,
    checked_by  UUID NOT NULL REFERENCES users(id),
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (case_id, item_id)
);

-- ოპერაციის / ანესთეზიის თანხმობა (0041 შაბლონები; ტექსტი — იურისტმა დაამტკიცოს)
INSERT INTO document_templates (code, kind, name, scope, is_system, required_on_admission, sort_order) VALUES
  ('OR_SURGERY',    'consent', 'ინფორმირებული თანხმობა ქირურგიულ ჩარევაზე', 'encounter', TRUE, FALSE, 150),
  ('OR_ANESTHESIA', 'consent', 'ინფორმირებული თანხმობა ანესთეზიაზე',        'encounter', TRUE, FALSE, 160)
ON CONFLICT (code) DO NOTHING;
INSERT INTO document_template_versions (template_code, version, status, body, published_at)
SELECT x.code, 1, 'published', jsonb_build_object('blocks', jsonb_build_array(jsonb_build_object('type', 'text', 'text', x.body))), CURRENT_TIMESTAMP
  FROM (VALUES
    ('OR_SURGERY', '[ტექსტი დასამტკიცებელია. მე, {{patient.full_name}} (პირადი № {{patient.id_number}}), ვადასტურებ, რომ {{clinic.name}}-ის ექიმმა '
                || 'ამიხსნა დაგეგმილი ქირურგიული ჩარევის არსი, მოსალოდნელი შედეგი, შესაძლო გართულებები და ალტერნატივები; თანახმა ვარ ოპერაციაზე.]'),
    ('OR_ANESTHESIA', '[ტექსტი დასამტკიცებელია. მე, {{patient.full_name}} (პირადი № {{patient.id_number}}), ვადასტურებ, რომ ანესთეზიოლოგმა ამიხსნა '
                || 'ანესთეზიის სახე, რისკები და შესაძლო გართულებები; თანახმა ვარ ანესთეზიაზე.]')) AS x(code, body)
 WHERE NOT EXISTS (SELECT 1 FROM document_template_versions v WHERE v.template_code = x.code);

-- ================================================================ 8. WHO ჩეკლისტი (Sign in → Time out → Sign out)
CREATE TABLE or_who_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phase       VARCHAR(8) NOT NULL CHECK (phase IN ('sign_in', 'time_out', 'sign_out')),
    label       TEXT NOT NULL CHECK (length(btrim(label)) >= 3),
    sort_order  INT NOT NULL DEFAULT 100,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- WHO Surgical Safety Checklist (2009) — კლინიკა ადაპტირებს (ადმინისტრირება → საოპერაციო)
INSERT INTO or_who_items (phase, label, sort_order) VALUES
 ('sign_in',  'პაციენტმა დაადასტურა ვინაობა, ოპერაციის ადგილი, პროცედურა და თანხმობა', 10),
 ('sign_in',  'ოპერაციის ადგილი მონიშნულია / არ ეხება', 20),
 ('sign_in',  'ანესთეზიის აპარატი და მედიკამენტები შემოწმებულია', 30),
 ('sign_in',  'პულსოქსიმეტრი დაყენებულია და მუშაობს', 40),
 ('sign_in',  'ალერგიები შემოწმებულია', 50),
 ('sign_in',  'რთული სასუნთქი გზები / ასპირაციის რისკი შეფასებულია — აღჭურვილობა და დახმარება მზადაა', 60),
 ('sign_in',  'სისხლის დაკარგვის რისკი > 500 მლ (ბავშვში 7 მლ/კგ) შეფასებულია — ვენური მიდგომა და სისხლი მზადაა', 70),
 ('time_out', 'გუნდის ყველა წევრმა წარადგინა თავი სახელითა და როლით', 10),
 ('time_out', 'ქირურგმა, ანესთეზიოლოგმა და ექთანმა სიტყვიერად დაადასტურეს პაციენტი, ადგილი და პროცედურა', 20),
 ('time_out', 'ანტიბიოტიკური პროფილაქტიკა ჩატარდა ბოლო 60 წუთში / არ ეხება', 30),
 ('time_out', 'ქირურგი: კრიტიკული ეტაპები, ხანგრძლივობა, მოსალოდნელი სისხლის დაკარგვა', 40),
 ('time_out', 'ანესთეზიოლოგი: პაციენტისთვის სპეციფიკური რისკები', 50),
 ('time_out', 'ექთანი: სტერილობა დადასტურებულია (ინდიკატორები), აღჭურვილობის პრობლემა არ არის', 60),
 ('time_out', 'საჭირო გამოსახულებები (რენტგენი, CT…) გამოტანილია / არ ეხება', 70),
 ('sign_out', 'ჩატარებული პროცედურის დასახელება დადასტურებულია', 10),
 ('sign_out', 'ინსტრუმენტების, საფენების და ნემსების დათვლა სწორია', 20),
 ('sign_out', 'ნიმუში ეტიკეტირებულია (პაციენტის სახელით) / არ ეხება', 30),
 ('sign_out', 'აღჭურვილობის პრობლემები დაფიქსირებულია / არ ეხება', 40),
 ('sign_out', 'ქირურგმა, ანესთეზიოლოგმა და ექთანმა განიხილეს პოსტოპერაციული მართვის ძირითადი საკითხები', 50);

CREATE TABLE or_who_checks (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id      UUID NOT NULL REFERENCES or_cases(id),
    phase        VARCHAR(8) NOT NULL CHECK (phase IN ('sign_in', 'time_out', 'sign_out')),
    answers      JSONB NOT NULL CHECK (jsonb_typeof(answers) = 'array'),   -- [{item_id, label, answer: yes|na}]
    note         TEXT,
    done_by      UUID NOT NULL REFERENCES users(id),
    done_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at    TIMESTAMPTZ,
    voided_by    UUID REFERENCES users(id),
    void_reason  TEXT,
    CONSTRAINT chk_who_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX ux_or_who_phase ON or_who_checks (case_id, phase) WHERE voided_at IS NULL;
CREATE TRIGGER trg_or_who_guard BEFORE UPDATE ON or_who_checks FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');

-- ================================================================ 9. დროის ნიშნულები
CREATE TABLE or_case_times (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id            UUID NOT NULL REFERENCES or_cases(id),
    kind               VARCHAR(16) NOT NULL CHECK (kind IN ('in_room', 'anesthesia_start', 'incision', 'closure', 'anesthesia_end', 'out_of_room', 'pacu_in', 'pacu_out')),
    at                 TIMESTAMPTZ NOT NULL,
    destination        VARCHAR(8) CHECK (destination IN ('ward', 'icu', 'pacu', 'other')),   -- out_of_room / pacu_out: სად
    recorded_by        UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correction_reason  TEXT,                                          -- შესწორება (ახალი ჩანაწერი)
    superseded_by      UUID REFERENCES or_case_times(id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT chk_or_time_dest CHECK (destination IS NULL OR kind IN ('out_of_room', 'pacu_out'))
);
CREATE UNIQUE INDEX ux_or_case_time ON or_case_times (case_id, kind) WHERE superseded_by IS NULL;
CREATE INDEX idx_or_case_times_case ON or_case_times (case_id, at);
-- ნიშნული არ იცვლება — შესწორება ახალი ჩანაწერით (მიზეზით), ძველს ენიშნება superseded_by
CREATE OR REPLACE FUNCTION or_case_times_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ნიშნული არ იშლება' USING ERRCODE = 'check_violation'; END IF;
    IF OLD.superseded_by IS NOT NULL OR (to_jsonb(NEW) - 'superseded_by') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by') THEN
        RAISE EXCEPTION 'ნიშნული არ რედაქტირდება — შესწორება ახალი ჩანაწერით (მიზეზით)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_case_times_guard BEFORE UPDATE OR DELETE ON or_case_times FOR EACH ROW EXECUTE FUNCTION or_case_times_guard();

-- არაარჩევადი წესები (ტექნიკური დავალება): Time out-ის გარეშე „განაკვეთი“ არ ფიქსირდება; Sign out-ის გარეშე — „ოთახიდან გასვლა“ (დასრულება)
CREATE OR REPLACE FUNCTION or_case_times_who() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'incision' AND NOT EXISTS (SELECT 1 FROM or_who_checks w WHERE w.case_id = NEW.case_id AND w.phase = 'time_out' AND w.voided_at IS NULL) THEN
        RAISE EXCEPTION 'WHO: Time out-ის გარეშე განაკვეთი ვერ დაფიქსირდება' USING ERRCODE = 'check_violation', CONSTRAINT = 'or_who_time_out';
    END IF;
    IF NEW.kind = 'out_of_room' AND NOT EXISTS (SELECT 1 FROM or_who_checks w WHERE w.case_id = NEW.case_id AND w.phase = 'sign_out' AND w.voided_at IS NULL) THEN
        RAISE EXCEPTION 'WHO: Sign out-ის გარეშე ოპერაცია ვერ დასრულდება' USING ERRCODE = 'check_violation', CONSTRAINT = 'or_who_sign_out';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_case_times_who BEFORE INSERT ON or_case_times FOR EACH ROW EXECUTE FUNCTION or_case_times_who();

-- ================================================================ 10. ისტორია
CREATE TABLE or_case_events (
    id        BIGSERIAL PRIMARY KEY,
    case_id   UUID NOT NULL REFERENCES or_cases(id),
    kind      VARCHAR(24) NOT NULL CHECK (kind IN ('requested', 'updated', 'tentative', 'scheduled', 'confirmed', 'rescheduled', 'unscheduled', 'cancelled',
                'surgeon_changed', 'team_added', 'team_removed', 'team_out', 'preop_signed', 'preop_voided', 'readiness', 'readiness_override',
                'who', 'who_voided', 'time', 'time_corrected', 'encounter_linked')),
    data      JSONB NOT NULL DEFAULT '{}',
    user_id   UUID REFERENCES users(id),
    at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_or_case_events ON or_case_events (case_id, at);
CREATE TRIGGER trg_or_case_events_immutable BEFORE UPDATE OR DELETE ON or_case_events FOR EACH ROW EXECUTE FUNCTION inpatient_events_immutable();

-- ჰოსპიტალიზაციის ისტორიაშიც (0040 ცხრილი)
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
    'note_signed', 'note_amended', 'consult_requested', 'consult_answered', 'consult_cancelled', 'form100_issued',
    'billing_package', 'payer_added', 'payer_cancelled', 'deposit', 'deposit_refund', 'deposit_voided', 'billing_finalized', 'billing_reopened',
    'icu_in', 'icu_out', 'icu_interval', 'vent_started', 'vent_ended', 'icu_score',
    -- 0048
    'or_requested', 'or_scheduled', 'or_cancelled', 'or_started', 'or_completed'));

-- ================================================================ 11. ICU ეპიზოდი: წყარო „საოპერაციო“ (0047-ის ფუნქცია — ცვლილება მხოლოდ v_origin-ში)
CREATE OR REPLACE FUNCTION icu_episode_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_level   TEXT;
    v_open    icu_episodes%ROWTYPE;
    v_prev    bed_assignments%ROWTYPE;
    v_source  TEXT;
    v_patient UUID;
    v_reopen  UUID;
    v_origin  TEXT;
    v_hours   INT;
    v_cond    TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND NEW.end_kind IN ('transfer', 'discharge', 'cancel') THEN
            IF NEW.end_kind = 'discharge' THEN
                SELECT CASE WHEN discharge_type = 'death' THEN 'died' END INTO v_cond FROM inpatient_stays WHERE encounter_id = NEW.encounter_id;
            END IF;
            UPDATE icu_episodes SET ended_at = NEW.ended_at, exit_kind = NEW.end_kind, exit_condition = coalesce(v_cond, exit_condition),
                   monitor_interval_min = NULL, monitor_interval_from = NULL, monitor_interval_until = NULL
             WHERE encounter_id = NEW.encounter_id AND ended_at IS NULL;
            IF FOUND THEN
                INSERT INTO inpatient_events (encounter_id, kind, data, user_id)
                VALUES (NEW.encounter_id, 'icu_out', jsonb_build_object('exit', NEW.end_kind, 'condition', v_cond), NEW.ended_by);
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    SELECT * INTO v_open FROM icu_episodes WHERE encounter_id = NEW.encounter_id AND ended_at IS NULL;
    IF FOUND THEN
        IF v_open.department_id = NEW.department_id THEN RETURN NEW; END IF;
        UPDATE icu_episodes SET ended_at = NEW.started_at, exit_kind = 'transfer', exit_department_id = NEW.department_id,
               monitor_interval_min = NULL, monitor_interval_from = NULL, monitor_interval_until = NULL WHERE id = v_open.id;
    END IF;
    UPDATE icu_episodes SET exit_department_id = NEW.department_id
     WHERE encounter_id = NEW.encounter_id AND exit_kind = 'transfer' AND exit_department_id IS NULL AND ended_at >= NEW.started_at - interval '1 minute';

    SELECT care_level INTO v_level FROM departments WHERE id = NEW.department_id;
    IF v_level IS NULL OR v_level NOT IN ('icu', 'intensive') THEN RETURN NEW; END IF;

    SELECT e.id INTO v_reopen FROM icu_episodes e
     WHERE e.encounter_id = NEW.encounter_id AND e.exit_kind = 'discharge' AND e.department_id = NEW.department_id
       AND NOT EXISTS (SELECT 1 FROM icu_episodes x WHERE x.encounter_id = e.encounter_id AND x.started_at > e.started_at)
     ORDER BY e.started_at DESC LIMIT 1;
    IF v_reopen IS NOT NULL THEN
        UPDATE icu_episodes SET ended_at = NULL, exit_kind = NULL, exit_condition = NULL, exit_department_id = NULL, assignment_id = NEW.id WHERE id = v_reopen;
        INSERT INTO inpatient_events (encounter_id, kind, data, user_id) VALUES (NEW.encounter_id, 'icu_in', jsonb_build_object('reopened', true), NEW.assigned_by);
        RETURN NEW;
    END IF;

    SELECT source, patient_id INTO v_source, v_patient FROM inpatient_stays WHERE encounter_id = NEW.encounter_id;
    SELECT * INTO v_prev FROM bed_assignments WHERE encounter_id = NEW.encounter_id AND id <> NEW.id AND end_kind IS DISTINCT FROM 'cancel'
     ORDER BY started_at DESC, id DESC LIMIT 1;
    v_origin := CASE
        -- 0048: ბოლო 12 სთ-ში ოპერაციიდან გამოსული (ოთახიდან გასვლა / PACU) → „საოპერაციო“
        WHEN EXISTS (SELECT 1 FROM or_case_times t JOIN or_cases c ON c.id = t.case_id
                      WHERE c.encounter_id = NEW.encounter_id AND c.status <> 'cancelled' AND t.superseded_by IS NULL
                        AND t.kind IN ('out_of_room', 'pacu_out') AND t.at BETWEEN NEW.started_at - interval '12 hours' AND NEW.started_at + interval '5 minutes') THEN 'or'
        WHEN v_prev.id IS NOT NULL THEN 'ward'
        WHEN v_source = 'emergency' THEN 'er'
        WHEN v_source = 'transfer_in' THEN 'other_clinic'
        ELSE 'direct' END;
    SELECT coalesce((settings->>'readmit_hours')::int, 48) INTO v_hours FROM system_modules WHERE code = 'icu';
    INSERT INTO icu_episodes (encounter_id, patient_id, department_id, care_level, assignment_id, started_at, origin, from_department_id, readmission)
    VALUES (NEW.encounter_id, v_patient, NEW.department_id, v_level, NEW.id, NEW.started_at, v_origin, v_prev.department_id,
            EXISTS (SELECT 1 FROM icu_episodes p WHERE p.patient_id = v_patient AND p.exit_kind = 'transfer'
                     AND p.ended_at > NEW.started_at - make_interval(hours => coalesce(v_hours, 48))
                     AND NOT EXISTS (SELECT 1 FROM departments xd WHERE xd.id = p.exit_department_id AND xd.care_level IN ('icu', 'intensive'))));
    INSERT INTO inpatient_events (encounter_id, kind, data, user_id)
    VALUES (NEW.encounter_id, 'icu_in', jsonb_build_object('origin', v_origin, 'from', v_prev.department_id), NEW.assigned_by);
    RETURN NEW;
END $$;

-- ================================================================ 12. აპლიკაციის როლი
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON or_cases, or_case_team, or_preop_assessments, or_who_checks, or_case_times, or_case_events FROM emr_app;
    REVOKE TRUNCATE ON or_rooms, or_procedures, or_specialties, or_team_roles, or_cancel_reasons, or_readiness_items, or_who_items, or_case_readiness FROM emr_app;
  END IF;
END $$;
