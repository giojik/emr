-- =====================================================================
-- 0087 — გადაუდებელი დახმარება (ER), ეტაპი 1 / 4: მოდული, რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი, დაფა
--
--  • patients: უცნობი / დაუდასტურებელი იდენტობა („უცნობი #N“), შეფასებული დაბადების თარიღი, იდენტიფიკაცია,
--    გაერთიანება ნამდვილ ჩანაწერთან (merged_into_id) — patient_merge() (ყველა FK → patients, ერთ ტრანზაქციაში);
--  • departments.type = 'emergency' (ER-ის განყოფილება; შეიძლება რამდენიმე — მოზრდილთა / ბავშვთა);
--  • უფლებები: er_triage, er_doctor, er_manage;
--  • system_modules('er') + პარამეტრები;
--  • ცნობარები: er_arrival_modes (შემოსვლის გზა), er_triage_scales / er_triage_levels (ESI — ნაგულისხმევი, MTS; საკუთარი — ადმინი);
--  • er_spots — ER-ის ადგილები (ტახტი / სავარძელი / დერეფანი / რეანიმაციული / იზოლაცია) — სტაციონარის საწოლფონდისგან ცალკე;
--  • er_visits — ER-ის შემთხვევა (encounters.type = 'emergency'): შემოსვლა, სტატუსი, ადგილი, დროები (კარი / ტრიაჟი / ექიმი);
--  • er_triage — ტრიაჟის ისტორია (ვიტალები — encounter_vitals, NEWS2 — მინიშნება).
-- =====================================================================

-- ================================================================ 1. პაციენტი: უცნობი / იდენტიფიკაცია / გაერთიანება
CREATE SEQUENCE patient_unknown_seq;

ALTER TABLE patients
    ADD COLUMN is_unknown            BOOLEAN NOT NULL DEFAULT FALSE,     -- იდენტობა დაუდასტურებელია (ER: საბუთის გარეშე)
    ADD COLUMN unknown_no            INT UNIQUE,                         -- „უცნობი #N“ (რჩება იდენტიფიკაციის შემდეგაც — ისტორიისთვის)
    ADD COLUMN birth_date_estimated  BOOLEAN NOT NULL DEFAULT FALSE,     -- დაბადების თარიღი შეფასებული ასაკიდანაა (01.01)
    ADD COLUMN identified_at         TIMESTAMPTZ,
    ADD COLUMN identified_by         UUID REFERENCES users(id),
    ADD COLUMN merged_into_id        UUID REFERENCES patients(id),       -- გაერთიანდა ნამდვილ ჩანაწერთან (ძებნაში არ ჩანს)
    ADD COLUMN merged_at             TIMESTAMPTZ,
    ADD COLUMN merged_by             UUID REFERENCES users(id),
    ADD CONSTRAINT chk_patient_unknown_no CHECK (NOT is_unknown OR unknown_no IS NOT NULL),
    ADD CONSTRAINT chk_patient_merge CHECK (merged_into_id IS NULL OR (merged_into_id <> id AND merged_at IS NOT NULL));

ALTER TABLE patients DROP CONSTRAINT chk_patient_identity;
ALTER TABLE patients ADD CONSTRAINT chk_patient_identity CHECK (is_unknown OR personal_number IS NOT NULL OR passport_number IS NOT NULL);
CREATE INDEX idx_patients_unknown ON patients (unknown_no) WHERE is_unknown AND merged_into_id IS NULL;

-- გაერთიანება: უცნობი (src) → ნამდვილი (dst). ყველა სვეტი, რომელიც patients(id)-ს მიუთითებს, გადადის dst-ზე.
-- ხელმოწერილი / უცვლელი ჩანაწერების guard-ტრიგერები (doctor_notes, mar_entries, stock_moves …) ამ ერთ ოპერაციაზე არ ეშვება
-- (session_replication_role = replica — მხოლოდ ფუნქციის შიგნით); უნიკალურობა (ინდექსები) მოქმედებს → კონფლიქტზე ყველაფერი ბრუნდება.
CREATE OR REPLACE FUNCTION patient_merge(p_src UUID, p_dst UUID, p_user UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET session_replication_role = replica AS $$
DECLARE
    s patients%ROWTYPE; d patients%ROWTYPE; r RECORD; n INT; out JSONB := '{}'::jsonb;
BEGIN
    IF p_src = p_dst THEN RAISE EXCEPTION 'MERGE_SAME' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO s FROM patients WHERE id = p_src FOR UPDATE;
    SELECT * INTO d FROM patients WHERE id = p_dst FOR UPDATE;
    IF s.id IS NULL OR d.id IS NULL THEN RAISE EXCEPTION 'MERGE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
    IF NOT s.is_unknown THEN RAISE EXCEPTION 'MERGE_SRC_NOT_UNKNOWN' USING ERRCODE = 'P0001'; END IF;
    IF s.merged_into_id IS NOT NULL OR d.merged_into_id IS NOT NULL THEN RAISE EXCEPTION 'MERGE_ALREADY' USING ERRCODE = 'P0001'; END IF;
    IF d.is_unknown THEN RAISE EXCEPTION 'MERGE_DST_UNKNOWN' USING ERRCODE = 'P0001'; END IF;
    FOR r IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
          FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid = 'patients'::regclass AND array_length(c.conkey, 1) = 1
           AND NOT (c.conrelid = 'patients'::regclass)
         ORDER BY 1, 2
    LOOP
        BEGIN
            EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col) USING p_dst, p_src;
        EXCEPTION WHEN unique_violation OR exclusion_violation THEN
            RAISE EXCEPTION 'MERGE_CONFLICT:%', r.tbl USING ERRCODE = 'P0001';
        END;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN out := out || jsonb_build_object(r.tbl::text, n); END IF;
    END LOOP;
    UPDATE patients SET merged_into_id = p_dst, merged_at = now(), merged_by = p_user, updated_at = now() WHERE id = p_src;
    RETURN out;
END $$;
REVOKE ALL ON FUNCTION patient_merge(UUID, UUID, UUID) FROM PUBLIC;
-- runtime როლი (EMR_APP_USER) — ვისაც patients-ზე UPDATE აქვს
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name = 'patients' AND privilege_type = 'UPDATE' AND grantee <> current_user
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION patient_merge(UUID, UUID, UUID) TO %I', r.grantee);
    END LOOP;
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        RAISE WARNING 'patient_merge: migration-ის როლი (%) superuser არ არის — გაერთიანება guard-ტრიგერიან ცხრილებზე ვერ შესრულდება', current_user;
    END IF;
END $$;

-- ================================================================ 2. განყოფილების ტიპი: emergency
ALTER TABLE departments DROP CONSTRAINT chk_departments_type;
ALTER TABLE departments ADD CONSTRAINT chk_departments_type CHECK (type IN ('inpatient', 'outpatient', 'diagnostic', 'administrative', 'or', 'emergency'));

-- ================================================================ 3. უფლებები
ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer',
        'storekeeper', 'stock_manager',
        'or_schedule', 'anesthesiologist', 'or_nurse',
        'procurement', 'procurement_approve',
        'tariffs', 'tariffs_approve',
        'drg', 'drg_admin',
        'reports', 'reports_all', 'reports_phi',
        'quality', 'quality_dept', 'quality_view',
        'infection', 'infection_dept', 'infection_view',
        'bme_dept', 'bme_view',
        'roster', 'roster_all', 'roster_view', 'absence_approve',
        'worklist_manage', 'worklist_all',
        'er_triage', 'er_doctor', 'er_manage']::VARCHAR(30)[]);

-- ================================================================ 4. მოდული
INSERT INTO system_modules (code, name, description, enabled, can_disable, is_core, settings, sort_order) VALUES
('er', 'გადაუდებელი დახმარება', 'ER: რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი (ESI / MTS / საკუთარი), დაფა / TV, ადგილები', TRUE, TRUE, FALSE,
 '{"triage_scale": "ESI", "triage_target_min": 10, "doctor_before_triage": "allow", "ambulance_fields": "optional",
   "retriage_alert": true, "news2_hint": true, "show_on_duty": true, "board_refresh_sec": 30, "tv_patient_names": "initials"}', 11)
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 5. ცნობარები
CREATE TABLE er_arrival_modes (
    code        VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,19}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    kind        VARCHAR(12) NOT NULL CHECK (kind IN ('walk_in', 'ambulance', 'transfer', 'police', 'other')),   -- რომელი დამატებითი ველები ჩანს
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
INSERT INTO er_arrival_modes (code, name, kind, sort_order) VALUES
 ('walk_in', 'თვითდინება', 'walk_in', 10), ('ambulance', 'სასწრაფო დახმარება', 'ambulance', 20),
 ('transfer', 'გადმოყვანა სხვა კლინიკიდან', 'transfer', 30), ('police', 'პოლიცია', 'police', 40), ('other', 'სხვა', 'other', 90);

CREATE TABLE er_triage_scales (
    code        VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    description TEXT,
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
CREATE TABLE er_triage_levels (
    scale_code         VARCHAR(20) NOT NULL REFERENCES er_triage_scales(code),
    level              SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 9),          -- 1 — ყველაზე სასწრაფო
    name               TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    color              VARCHAR(7) NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    target_doctor_min  INT NOT NULL CHECK (target_doctor_min BETWEEN 0 AND 1440), -- სამიზნე: ტრიაჟი → ექიმი (0 — მაშინვე)
    retriage_min       INT CHECK (retriage_min IS NULL OR retriage_min BETWEEN 5 AND 1440),   -- განმეორებითი ტრიაჟი ექიმამდე (NULL — არა)
    description        TEXT,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (scale_code, level)
);
INSERT INTO er_triage_scales (code, name, description, is_system, sort_order) VALUES
 ('ESI', 'ESI — Emergency Severity Index (5 დონე)', 'დონე 1–2 — სიცოცხლისთვის საშიში / მაღალი რისკი; 3–5 — საჭირო რესურსების რაოდენობით', TRUE, 10),
 ('MTS', 'MTS — მანჩესტერის ტრიაჟი (5 ფერი)', 'წითელი / ნარინჯისფერი / ყვითელი / მწვანე / ლურჯი', TRUE, 20);
-- სამიზნე დროები — ნაგულისხმევი, კლინიკა ადასტურებს / ცვლის (ადმინისტრირება → ER → ტრიაჟის შკალები)
INSERT INTO er_triage_levels (scale_code, level, name, color, target_doctor_min, retriage_min, description) VALUES
 ('ESI', 1, 'ESI 1 — რეანიმაცია', '#c62828', 0, NULL, 'დაუყოვნებელი სიცოცხლის გადამრჩენი ჩარევა'),
 ('ESI', 2, 'ESI 2 — მაღალი რისკი', '#ef6c00', 10, 15, 'მაღალი რისკი / ცნობიერების დარღვევა / ძლიერი ტკივილი'),
 ('ESI', 3, 'ESI 3 — სტაბილური, ≥ 2 რესურსი', '#f9a825', 30, 30, NULL),
 ('ESI', 4, 'ESI 4 — 1 რესურსი', '#2e7d32', 60, 60, NULL),
 ('ESI', 5, 'ESI 5 — რესურსის გარეშე', '#1565c0', 120, 120, NULL),
 ('MTS', 1, 'წითელი — დაუყოვნებლივ', '#c62828', 0, NULL, NULL),
 ('MTS', 2, 'ნარინჯისფერი — ძალიან სასწრაფო', '#ef6c00', 10, 15, NULL),
 ('MTS', 3, 'ყვითელი — სასწრაფო', '#f9a825', 60, 30, NULL),
 ('MTS', 4, 'მწვანე — სტანდარტული', '#2e7d32', 120, 60, NULL),
 ('MTS', 5, 'ლურჯი — არასასწრაფო', '#1565c0', 240, 120, NULL);

-- ================================================================ 6. ER-ის ადგილები
CREATE TABLE er_spots (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id  UUID NOT NULL REFERENCES departments(id),
    code           VARCHAR(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
    name           TEXT NOT NULL CHECK (length(btrim(name)) >= 1),
    kind           VARCHAR(12) NOT NULL DEFAULT 'bed' CHECK (kind IN ('bed', 'chair', 'corridor', 'resus', 'isolation', 'other')),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INT NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (department_id, code)
);

-- ================================================================ 7. ER-ის შემთხვევა
CREATE TABLE er_visits (
    encounter_id            UUID PRIMARY KEY REFERENCES encounters(id),
    visit_no                VARCHAR(20) NOT NULL UNIQUE,                       -- ER26-000001
    patient_id              UUID NOT NULL REFERENCES patients(id),
    department_id           UUID NOT NULL REFERENCES departments(id),
    arrived_at              TIMESTAMPTZ NOT NULL DEFAULT now(),                -- „კარი“
    arrival_mode            VARCHAR(20) NOT NULL REFERENCES er_arrival_modes(code),
    ambulance_crew          VARCHAR(40),                                        -- ბრიგადის № (სასწრაფო)
    ambulance_call_at       TIMESTAMPTZ,                                        -- გამოძახების დრო
    referral_institution_id UUID REFERENCES external_institutions(id),          -- გადმოყვანა სხვა კლინიკიდან
    arrival_note            TEXT,
    chief_complaint         TEXT NOT NULL CHECK (length(btrim(chief_complaint)) >= 2),
    status                  VARCHAR(16) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'triaged', 'in_treatment', 'cancelled')),
    spot_id                 UUID REFERENCES er_spots(id),
    triage_scale            VARCHAR(20),
    triage_level            SMALLINT,
    first_triage_at         TIMESTAMPTZ,
    last_triage_at          TIMESTAMPTZ,
    doctor_id               UUID REFERENCES users(id),                          -- ER-ის ექიმი (მინიჭებული / აყვანილი)
    doctor_at               TIMESTAMPTZ,                                        -- ექიმმა აიყვანა („კარი → ექიმი“)
    nurse_id                UUID REFERENCES users(id),
    waiting_for             TEXT[] NOT NULL DEFAULT '{}' CHECK (waiting_for <@ ARRAY['lab', 'imaging', 'consult', 'bed', 'transport', 'other']::text[]),
    ended_at                TIMESTAMPTZ,
    end_reason              TEXT,
    created_by              UUID REFERENCES users(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (triage_scale, triage_level) REFERENCES er_triage_levels(scale_code, level),
    CHECK ((ended_at IS NULL) = (status IN ('waiting', 'triaged', 'in_treatment'))),
    CHECK (doctor_at IS NULL OR doctor_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_er_visit_active_patient ON er_visits (patient_id) WHERE ended_at IS NULL;   -- პაციენტი ER-ში ერთხელ
CREATE UNIQUE INDEX uq_er_visit_active_spot ON er_visits (spot_id) WHERE ended_at IS NULL AND spot_id IS NOT NULL;
CREATE INDEX idx_er_visits_board ON er_visits (department_id, arrived_at) WHERE ended_at IS NULL;
CREATE INDEX idx_er_visits_arrived ON er_visits (arrived_at);

CREATE TABLE er_triage (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id   UUID NOT NULL REFERENCES er_visits(encounter_id),
    scale_code     VARCHAR(20) NOT NULL,
    level          SMALLINT NOT NULL,
    is_retriage    BOOLEAN NOT NULL DEFAULT FALSE,
    vitals_id      UUID REFERENCES encounter_vitals(id),
    news2_score    SMALLINT,
    news2_level    VARCHAR(8) CHECK (news2_level IN ('low', 'low_red', 'medium', 'high')),
    gcs            SMALLINT CHECK (gcs BETWEEN 3 AND 15),
    discriminator  TEXT,                                                       -- მთავარი ნიშანი / წარდგენა (MTS) / მიზეზი
    note           TEXT,
    user_id        UUID NOT NULL REFERENCES users(id),
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (scale_code, level) REFERENCES er_triage_levels(scale_code, level)
);
CREATE INDEX idx_er_triage_enc ON er_triage (encounter_id, recorded_at DESC);

-- ტრიაჟი უცვლელი ჟურნალია (შესწორება — ახალი ტრიაჟით)
CREATE OR REPLACE FUNCTION er_triage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ტრიაჟის ჩანაწერი არ იცვლება / არ იშლება — შეიყვანეთ ახალი (განმეორებითი) ტრიაჟი'; END $$;
CREATE TRIGGER trg_er_triage_guard BEFORE UPDATE OR DELETE ON er_triage FOR EACH ROW EXECUTE FUNCTION er_triage_guard();

CREATE OR REPLACE FUNCTION er_visits_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_er_visits_updated BEFORE UPDATE ON er_visits FOR EACH ROW EXECUTE FUNCTION er_visits_touch();
