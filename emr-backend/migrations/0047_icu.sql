-- 0047_icu.sql
-- რეანიმაცია (ICU) და ინტენსიური პალატა — მოდული „icu“.
--
--  • განყოფილების დონე (departments.care_level): ward / intensive / icu; ფუნქციები — დონის ნაგულისხმევიდან (მოდულის პარამეტრი)
--      ან განყოფილების საკუთარი სიიდან (icu_features). intensive — ნაგულისხმევად: ფურცელი, ინფუზიები / ტიტრაცია, ABG, დაფა.
--  • icu_episodes — ეპიზოდი იქმნება / იხურება ავტომატურად bed_assignments-ის trigger-ით (გადაყვანა / მიღება / გაწერა / გაუქმება):
--      საიდან (მიმღები / საოპერაციო / განყოფილება / სხვა კლინიკა / პირდაპირ), მიზეზი, წონა, გასვლა (სად / რა მდგომარეობით),
--      ხელახლა შემოსვლა readmit_hours-ში (სტატისტიკა); ფურცლის ინტერვალი — პაციენტზე დროებით 15 / 30 წთ.
--  • მონიტორინგის ფურცელი — encounter_vitals + ICU სვეტები (MAP, CVP, EtCO₂, გუგები, GCS E/V/M, RASS); შარდი → fluid_entries (vitals_id).
--  • ვენტილაცია: icu_ventilation (ინვაზიური / NIV / HFNC; ინტუბაცია — ტუბი, სიღრმე, ვინ; ექსტუბაცია) + icu_vent_settings (საათობრივი).
--  • ვაზოაქტიური ინფუზია / ტიტრაცია: med_orders (dose_rate + ერთეული, კონცენტრაცია, დიაპაზონი, მიზანი) → მლ/სთ ავტომატურად;
--      mar_entries.dose_rate (ყოველ მოქმედებაზე); უწყვეტი ინფუზიის მოცულობა → fluid_entries (auto_hour, worker).
--  • ABG: ლაბ. (LAB_ABG სერვისი — შაბლონი) + POC ხელით (icu_abg).
--  • შკალები: SOFA (ყოველდღე), APACHE II (პირველი 24 სთ) — icu_scores (ნახევრად ავტომატური შევსება → ექიმი ადასტურებს);
--      RASS, CAM-ICU — scale_defs (0044 ძრავა).
--  • bundle-ები (VAP / CLABSI): პუნქტები — ადმინისტრირება; ყოველდღიური შემოწმება (icu_bundle_checks).
--  • ექიმი: ჩანაწერის ტიპები icu_daily (A–F) და icu_out (გაყვანის შეჯამება).
--  • ბილინგი: ინვაზიური ვენტილაციის დღე (შუაღამის წესი, მინ. 1) — stay_vent_days + ინვოისის კატეგორია „ventilation“
--      (ipd_sync_vent_days — ეშვება ipd_sync_bed_days-დან).

-- ================================================================ 0. მოდული
INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('icu', 'რეანიმაცია / ინტენსიური', 'ICU ეპიზოდი, მონიტორინგის ფურცელი, ვენტილაცია, ვაზოპრესორების ტიტრაცია, SOFA / APACHE II, ABG, bundle-ები, რეანიმაციის დაფა', TRUE,
 '{"monitor_interval_min": 60,
   "fast_interval_max_hours": 12,
   "monitor_gap_hours": 2,
   "intensive_features": ["sheet", "infusions", "abg", "board"],
   "news2_alerts": false,
   "infusion_to_balance": true,
   "titration_reason": true,
   "bundle_reminder_time": "11:00",
   "sofa_reminder_time": "12:00",
   "readmit_hours": 48,
   "vent_billing": true,
   "vent_day_tariff_id": null,
   "vasoactive": {
     "norepinephrine": ["norepinephrine", "noradrenaline", "ნორეპინეფრინი", "ნორადრენალინი"],
     "epinephrine": ["epinephrine", "adrenaline", "ეპინეფრინი", "ადრენალინი"],
     "dopamine": ["dopamine", "დოფამინი"],
     "dobutamine": ["dobutamine", "დობუტამინი"],
     "vasopressin": ["vasopressin", "ვაზოპრესინი"]
   },
   "lab_map": {
     "platelets": "LAB_CBC:PLT", "wbc": "LAB_CBC:WBC", "hct": "LAB_CBC:HCT",
     "bilirubin": "LAB_LIVER:TBIL", "creatinine": "LAB_CREA:CREA", "sodium": "LAB_ELEC:NA", "potassium": "LAB_ELEC:K",
     "ph": "LAB_ABG:PH", "pao2": "LAB_ABG:PO2", "paco2": "LAB_ABG:PCO2", "hco3": "LAB_ABG:HCO3", "be": "LAB_ABG:BE",
     "lactate": "LAB_ABG:LAC", "sao2": "LAB_ABG:SO2", "fio2": "LAB_ABG:FIO2"
   }}', 32)
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 1. განყოფილების დონე
ALTER TABLE departments
    ADD COLUMN care_level            VARCHAR(10) NOT NULL DEFAULT 'ward' CHECK (care_level IN ('ward', 'intensive', 'icu')),
    ADD COLUMN icu_features          TEXT[] CHECK (icu_features IS NULL OR icu_features <@ ARRAY['sheet', 'ventilation', 'infusions', 'sofa', 'apache', 'abg', 'bundles', 'icu_note', 'board']::text[]),
    ADD COLUMN monitor_interval_min  SMALLINT CHECK (monitor_interval_min IN (15, 30, 60)),
    ADD CONSTRAINT chk_dep_care_level CHECK (care_level = 'ward' OR type = 'inpatient');

-- ================================================================ 2. ICU ეპიზოდი
CREATE TABLE icu_episodes (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id            UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id              UUID NOT NULL REFERENCES patients(id),
    department_id           UUID NOT NULL REFERENCES departments(id),
    care_level              VARCHAR(10) NOT NULL CHECK (care_level IN ('intensive', 'icu')),
    assignment_id           BIGINT REFERENCES bed_assignments(id),
    started_at              TIMESTAMPTZ NOT NULL,
    origin                  VARCHAR(12) NOT NULL CHECK (origin IN ('er', 'or', 'ward', 'other_clinic', 'direct')),
    from_department_id      UUID REFERENCES departments(id),
    reason                  TEXT,
    admission_weight_kg     NUMERIC(5,1) CHECK (admission_weight_kg BETWEEN 0.3 AND 400),
    readmission             BOOLEAN NOT NULL DEFAULT FALSE,                     -- წინა ICU ეპიზოდიდან readmit_hours-ში
    monitor_interval_min    SMALLINT CHECK (monitor_interval_min IN (15, 30, 60)),   -- პაციენტზე დროებით (არასტაბილური პერიოდი)
    monitor_interval_from   TIMESTAMPTZ,
    monitor_interval_until  TIMESTAMPTZ,
    monitor_interval_by     UUID REFERENCES users(id),
    ended_at                TIMESTAMPTZ,
    exit_kind               VARCHAR(10) CHECK (exit_kind IN ('transfer', 'discharge', 'cancel')),
    exit_department_id      UUID REFERENCES departments(id),
    exit_condition          VARCHAR(10) CHECK (exit_condition IN ('improved', 'stable', 'worse', 'died')),
    exit_note               TEXT,
    updated_by              UUID REFERENCES users(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_icu_end CHECK ((ended_at IS NULL) = (exit_kind IS NULL) AND (ended_at IS NULL OR ended_at >= started_at)),
    CONSTRAINT chk_icu_interval CHECK ((monitor_interval_min IS NULL) = (monitor_interval_until IS NULL) AND (monitor_interval_min IS NULL) = (monitor_interval_from IS NULL))
);
CREATE UNIQUE INDEX ux_icu_episode_open ON icu_episodes (encounter_id) WHERE ended_at IS NULL;
CREATE INDEX idx_icu_episodes_dep ON icu_episodes (department_id, started_at);
CREATE INDEX idx_icu_episodes_patient ON icu_episodes (patient_id, started_at);
CREATE TRIGGER trg_icu_episodes_updated BEFORE UPDATE ON icu_episodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ეპიზოდის ავტომატური გახსნა / დახურვა საწოლის ეპიზოდიდან (მიღება, გადაყვანა, გაწერა, გაუქმება, გაწერის გაუქმება)
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

    -- INSERT: ახალი საწოლის ეპიზოდი
    SELECT * INTO v_open FROM icu_episodes WHERE encounter_id = NEW.encounter_id AND ended_at IS NULL;
    IF FOUND THEN
        IF v_open.department_id = NEW.department_id THEN RETURN NEW; END IF;          -- საწოლის შეცვლა იმავე განყოფილებაში
        UPDATE icu_episodes SET ended_at = NEW.started_at, exit_kind = 'transfer', exit_department_id = NEW.department_id,
               monitor_interval_min = NULL, monitor_interval_from = NULL, monitor_interval_until = NULL WHERE id = v_open.id;
    END IF;
    -- გადაყვანით დახურულ ეპიზოდს — სად გავიდა
    UPDATE icu_episodes SET exit_department_id = NEW.department_id
     WHERE encounter_id = NEW.encounter_id AND exit_kind = 'transfer' AND exit_department_id IS NULL AND ended_at >= NEW.started_at - interval '1 minute';

    SELECT care_level INTO v_level FROM departments WHERE id = NEW.department_id;
    IF v_level IS NULL OR v_level NOT IN ('icu', 'intensive') THEN RETURN NEW; END IF;

    -- გაწერის გაუქმება → იგივე ეპიზოდი თავიდან იხსნება
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
    v_origin := CASE WHEN v_prev.id IS NOT NULL THEN 'ward'
                     WHEN v_source = 'emergency' THEN 'er'
                     WHEN v_source = 'transfer_in' THEN 'other_clinic'
                     ELSE 'direct' END;
    SELECT coalesce((settings->>'readmit_hours')::int, 48) INTO v_hours FROM system_modules WHERE code = 'icu';
    INSERT INTO icu_episodes (encounter_id, patient_id, department_id, care_level, assignment_id, started_at, origin, from_department_id, readmission)
    VALUES (NEW.encounter_id, v_patient, NEW.department_id, v_level, NEW.id, NEW.started_at, v_origin, v_prev.department_id,
            EXISTS (SELECT 1 FROM icu_episodes p WHERE p.patient_id = v_patient AND p.exit_kind = 'transfer'
                     AND p.ended_at > NEW.started_at - make_interval(hours => coalesce(v_hours, 48))
                     -- პირდაპირ ICU → ICU (ინტენსიური) გადაყვანა ხელახლა შემოსვლად არ ითვლება
                     AND NOT EXISTS (SELECT 1 FROM departments xd WHERE xd.id = p.exit_department_id AND xd.care_level IN ('icu', 'intensive'))));
    INSERT INTO inpatient_events (encounter_id, kind, data, user_id)
    VALUES (NEW.encounter_id, 'icu_in', jsonb_build_object('origin', v_origin, 'from', v_prev.department_id), NEW.assigned_by);
    RETURN NEW;
END $$;
CREATE TRIGGER trg_icu_episode_sync AFTER INSERT OR UPDATE OF ended_at ON bed_assignments FOR EACH ROW EXECUTE FUNCTION icu_episode_sync();

-- ================================================================ 3. მონიტორინგის ფურცელი (ვიტალები + ICU სვეტები)
ALTER TABLE encounter_vitals
    ADD COLUMN map_mmhg       SMALLINT CHECK (map_mmhg BETWEEN 15 AND 250),
    ADD COLUMN map_invasive   BOOLEAN NOT NULL DEFAULT FALSE,               -- არტერიული ხაზიდან
    ADD COLUMN cvp            SMALLINT CHECK (cvp BETWEEN -10 AND 40),
    ADD COLUMN etco2          SMALLINT CHECK (etco2 BETWEEN 0 AND 150),
    ADD COLUMN pupil_l        NUMERIC(2,1) CHECK (pupil_l BETWEEN 1 AND 9),
    ADD COLUMN pupil_r        NUMERIC(2,1) CHECK (pupil_r BETWEEN 1 AND 9),
    ADD COLUMN pupil_l_react  VARCHAR(8) CHECK (pupil_l_react IN ('brisk', 'sluggish', 'fixed')),
    ADD COLUMN pupil_r_react  VARCHAR(8) CHECK (pupil_r_react IN ('brisk', 'sluggish', 'fixed')),
    ADD COLUMN gcs_e          SMALLINT CHECK (gcs_e BETWEEN 1 AND 4),
    ADD COLUMN gcs_v          SMALLINT CHECK (gcs_v BETWEEN 1 AND 5),
    ADD COLUMN gcs_m          SMALLINT CHECK (gcs_m BETWEEN 1 AND 6),
    ADD COLUMN gcs_intubated  BOOLEAN NOT NULL DEFAULT FALSE,               -- V = „T“ (ქულაში 1)
    ADD COLUMN gcs_total      SMALLINT CHECK (gcs_total BETWEEN 3 AND 15),
    ADD COLUMN rass           SMALLINT CHECK (rass BETWEEN -5 AND 4),
    ADD COLUMN icu_sheet      BOOLEAN NOT NULL DEFAULT FALSE,               -- ICU ფურცლიდან
    ADD COLUMN source         VARCHAR(8) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'monitor')),
    ADD CONSTRAINT chk_vitals_gcs_v CHECK (NOT gcs_intubated OR gcs_v IS NULL);
CREATE INDEX idx_vitals_icu ON encounter_vitals (encounter_id, recorded_at DESC) WHERE icu_sheet AND voided_at IS NULL;

ALTER TABLE fluid_entries
    ADD COLUMN vitals_id  UUID REFERENCES encounter_vitals(id),            -- ფურცლიდან (შარდი)
    ADD COLUMN auto_hour  TIMESTAMPTZ;                                     -- უწყვეტი ინფუზიის საათობრივი მოცულობა (worker)
CREATE UNIQUE INDEX ux_fluid_auto ON fluid_entries (order_id, auto_hour) WHERE auto_hour IS NOT NULL AND voided_at IS NULL;

-- ================================================================ 4. ვენტილაცია
CREATE TABLE icu_ventilation (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id       UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id         UUID NOT NULL REFERENCES patients(id),
    episode_id         UUID REFERENCES icu_episodes(id),
    kind               VARCHAR(8) NOT NULL CHECK (kind IN ('invasive', 'niv', 'hfnc')),
    airway             VARCHAR(8) NOT NULL CHECK (airway IN ('ett', 'trach', 'mask', 'nasal', 'helmet')),
    started_at         TIMESTAMPTZ NOT NULL,
    performed_by       UUID REFERENCES users(id),                         -- ვინ ინტუბირა (ჩვენი თანამშრომელი)
    performed_where    TEXT,                                              -- ან სად (მიმღები / სხვა კლინიკა / სასწრაფო)
    ett_size           NUMERIC(3,1) CHECK (ett_size BETWEEN 2 AND 10),
    ett_depth_cm       NUMERIC(3,1) CHECK (ett_depth_cm BETWEEN 5 AND 35),
    attempts           SMALLINT CHECK (attempts BETWEEN 1 AND 10),
    difficult          BOOLEAN NOT NULL DEFAULT FALSE,
    notes              TEXT,
    ended_at           TIMESTAMPTZ,
    ended_by           UUID REFERENCES users(id),
    end_reason         VARCHAR(12) CHECK (end_reason IN ('extubated', 'self_extub', 'accidental', 'switch', 'trach', 'death', 'transfer')),
    end_note           TEXT,
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at          TIMESTAMPTZ,
    voided_by          UUID REFERENCES users(id),
    void_reason        TEXT,
    CONSTRAINT chk_vent_airway CHECK ((kind = 'invasive' AND airway IN ('ett', 'trach')) OR (kind = 'niv' AND airway IN ('mask', 'nasal', 'helmet')) OR (kind = 'hfnc' AND airway = 'nasal')),
    CONSTRAINT chk_vent_ett CHECK (airway IN ('ett', 'trach') OR (ett_size IS NULL AND ett_depth_cm IS NULL)),
    CONSTRAINT chk_vent_end CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL OR ended_at >= started_at)),
    CONSTRAINT chk_vent_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX ux_vent_open ON icu_ventilation (encounter_id) WHERE ended_at IS NULL AND voided_at IS NULL;
CREATE INDEX idx_vent_encounter ON icu_ventilation (encounter_id, started_at) WHERE voided_at IS NULL;

CREATE TABLE icu_vent_settings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ventilation_id  UUID NOT NULL REFERENCES icu_ventilation(id),
    encounter_id    UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    recorded_at     TIMESTAMPTZ NOT NULL,
    mode            VARCHAR(12) NOT NULL CHECK (length(btrim(mode)) >= 2),
    fio2            SMALLINT CHECK (fio2 BETWEEN 21 AND 100),
    peep            NUMERIC(3,1) CHECK (peep BETWEEN 0 AND 30),
    vt_ml           SMALLINT CHECK (vt_ml BETWEEN 10 AND 2500),
    rate_set        SMALLINT CHECK (rate_set BETWEEN 0 AND 80),
    rate_total      SMALLINT CHECK (rate_total BETWEEN 0 AND 100),
    ppeak           SMALLINT CHECK (ppeak BETWEEN 0 AND 80),
    pplat           SMALLINT CHECK (pplat BETWEEN 0 AND 80),
    ps              NUMERIC(3,1) CHECK (ps BETWEEN 0 AND 40),
    ipap            NUMERIC(3,1) CHECK (ipap BETWEEN 0 AND 40),
    epap            NUMERIC(3,1) CHECK (epap BETWEEN 0 AND 30),
    flow_lpm        SMALLINT CHECK (flow_lpm BETWEEN 1 AND 80),
    mv_l            NUMERIC(4,1) CHECK (mv_l BETWEEN 0 AND 60),
    note            TEXT,
    recorded_by     UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at       TIMESTAMPTZ,
    voided_by       UUID REFERENCES users(id),
    void_reason     TEXT,
    CONSTRAINT chk_vs_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_vent_settings ON icu_vent_settings (encounter_id, recorded_at DESC) WHERE voided_at IS NULL;

-- ================================================================ 5. ვაზოაქტიური ინფუზია / ტიტრაცია
ALTER TABLE med_orders
    ADD COLUMN titratable      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN dose_rate       NUMERIC(12,4) CHECK (dose_rate > 0),
    ADD COLUMN dose_rate_unit  VARCHAR(12) CHECK (dose_rate_unit IN ('mcg/kg/min', 'mcg/min', 'mg/h', 'mg/kg/h', 'mcg/kg/h', 'units/h', 'units/min')),
    ADD COLUMN conc_amount     NUMERIC(12,4) CHECK (conc_amount > 0),
    ADD COLUMN conc_unit       VARCHAR(6) CHECK (conc_unit IN ('mg', 'mcg', 'units')),
    ADD COLUMN conc_volume_ml  NUMERIC(8,1) CHECK (conc_volume_ml > 0),
    ADD COLUMN titrate_min     NUMERIC(12,4) CHECK (titrate_min >= 0),
    ADD COLUMN titrate_max     NUMERIC(12,4) CHECK (titrate_max > 0),
    ADD COLUMN titrate_goal    TEXT,
    ADD CONSTRAINT chk_mo_dose_rate CHECK (dose_rate IS NULL OR (order_type = 'continuous' AND dose_rate_unit IS NOT NULL AND conc_amount IS NOT NULL AND conc_unit IS NOT NULL
        AND conc_volume_ml IS NOT NULL AND (dose_rate_unit NOT LIKE '%/kg/%' OR weight_kg IS NOT NULL)
        AND ((conc_unit = 'units') = (dose_rate_unit LIKE 'units/%')))),
    ADD CONSTRAINT chk_mo_titratable CHECK (NOT titratable OR dose_rate IS NOT NULL),
    ADD CONSTRAINT chk_mo_titrate_range CHECK (titrate_min IS NULL OR titrate_max IS NULL OR titrate_min <= titrate_max);

-- შინაარსი არ იცვლება — ახალი ველებიც (0042-ის guard + ტიტრაციის ველები)
CREATE OR REPLACE FUNCTION med_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.encounter_id, NEW.patient_id, NEW.category, NEW.generic_id, NEW.drug_text, NEW.order_type, NEW.dose, NEW.dose_unit, NEW.dose_per_kg, NEW.weight_kg,
        NEW.route_code, NEW.frequency_code, NEW.prn_reason, NEW.prn_max_per_day, NEW.prn_min_interval_h, NEW.diluent, NEW.volume_ml, NEW.rate_ml_h,
        NEW.duration_min, NEW.text, NEW.instructions, NEW.start_at, NEW.duration_days, NEW.end_at, NEW.ordered_by, NEW.entered_by, NEW.is_verbal,
        NEW.checks, NEW.override_reason, NEW.replaces_id, NEW.created_at,
        NEW.titratable, NEW.dose_rate, NEW.dose_rate_unit, NEW.conc_amount, NEW.conc_unit, NEW.conc_volume_ml, NEW.titrate_min, NEW.titrate_max, NEW.titrate_goal)
       IS DISTINCT FROM
       (OLD.encounter_id, OLD.patient_id, OLD.category, OLD.generic_id, OLD.drug_text, OLD.order_type, OLD.dose, OLD.dose_unit, OLD.dose_per_kg, OLD.weight_kg,
        OLD.route_code, OLD.frequency_code, OLD.prn_reason, OLD.prn_max_per_day, OLD.prn_min_interval_h, OLD.diluent, OLD.volume_ml, OLD.rate_ml_h,
        OLD.duration_min, OLD.text, OLD.instructions, OLD.start_at, OLD.duration_days, OLD.end_at, OLD.ordered_by, OLD.entered_by, OLD.is_verbal,
        OLD.checks, OLD.override_reason, OLD.replaces_id, OLD.created_at,
        OLD.titratable, OLD.dose_rate, OLD.dose_rate_unit, OLD.conc_amount, OLD.conc_unit, OLD.conc_volume_ml, OLD.titrate_min, OLD.titrate_max, OLD.titrate_goal) THEN
        RAISE EXCEPTION 'დანიშნულება არ რედაქტირდება — შეცვლა: შეწყვეტა + ახალი დანიშნულება' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status IN ('stopped', 'completed') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'შეწყვეტილი / დასრულებული დანიშნულება ვეღარ განახლდება' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

ALTER TABLE mar_entries ADD COLUMN dose_rate NUMERIC(12,4) CHECK (dose_rate >= 0);    -- ინფუზიის დოზის სიჩქარე ამ მოქმედებისას (order.dose_rate_unit)

-- ================================================================ 6. სისხლის აირები (POC — ხელით) + ლაბ. შაბლონი
CREATE TABLE icu_abg (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    sampled_at    TIMESTAMPTZ NOT NULL,
    sample        VARCHAR(10) NOT NULL DEFAULT 'arterial' CHECK (sample IN ('arterial', 'venous', 'capillary')),
    ph            NUMERIC(4,2) CHECK (ph BETWEEN 6.5 AND 8.0),
    pco2          NUMERIC(5,1) CHECK (pco2 BETWEEN 5 AND 200),        -- mmHg
    po2           NUMERIC(5,1) CHECK (po2 BETWEEN 10 AND 700),        -- mmHg
    hco3          NUMERIC(4,1) CHECK (hco3 BETWEEN 1 AND 60),
    be            NUMERIC(4,1) CHECK (be BETWEEN -40 AND 40),
    lactate       NUMERIC(4,1) CHECK (lactate BETWEEN 0 AND 40),
    sao2          NUMERIC(4,1) CHECK (sao2 BETWEEN 0 AND 100),
    fio2          SMALLINT CHECK (fio2 BETWEEN 21 AND 100),
    na            NUMERIC(4,1) CHECK (na BETWEEN 90 AND 200),
    k             NUMERIC(3,1) CHECK (k BETWEEN 1 AND 12),
    glucose       NUMERIC(4,1) CHECK (glucose BETWEEN 0.5 AND 60),
    note          TEXT,
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at     TIMESTAMPTZ,
    voided_by     UUID REFERENCES users(id),
    void_reason   TEXT,
    CONSTRAINT chk_abg_any CHECK (coalesce(ph, pco2, po2, hco3, lactate) IS NOT NULL),
    CONSTRAINT chk_abg_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_icu_abg ON icu_abg (encounter_id, sampled_at DESC) WHERE voided_at IS NULL;

INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_ABG', 'სისხლის აირები (ABG)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order)
SELECT 'lab', 'LAB_ABG', 'სისხლის აირები (ABG)', 'სისხლის აირები', t.id, 'blood', 'ჰეპარინიზებული შპრიცი', 90 FROM service_tariffs t WHERE t.code = 'LAB_ABG'
ON CONFLICT (code) DO NOTHING;
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, critical_low, critical_high, sort_order)
SELECT s.id, x.code, x.name, x.unit, 'numeric', x.dec, x.cl, x.ch, x.ord
  FROM dx_services s CROSS JOIN (VALUES
    ('PH',   'pH',                      '',       2, 7.20, 7.60, 0),
    ('PCO2', 'pCO₂',                    'mmHg',   0, 20,   70,   1),
    ('PO2',  'pO₂',                     'mmHg',   0, 40,   NULL, 2),
    ('HCO3', 'HCO₃⁻',                   'mmol/L', 1, 10,   40,   3),
    ('BE',   'ფუძეთა სიჭარბე (BE)',      'mmol/L', 1, NULL, NULL, 4),
    ('LAC',  'ლაქტატი',                 'mmol/L', 1, NULL, 4,    5),
    ('SO2',  'SO₂',                     '%',      0, 85,   NULL, 6),
    ('FIO2', 'FiO₂ (აღების მომენტში)',   '%',      0, NULL, NULL, 7)
  ) AS x(code, name, unit, dec, cl, ch, ord)
 WHERE s.code = 'LAB_ABG'
ON CONFLICT (service_id, code) DO NOTHING;
INSERT INTO lab_reference_ranges (analyte_id, low, high)
SELECT a.id, r.lo, r.hi FROM lab_analytes a JOIN dx_services s ON s.id = a.service_id
  JOIN (VALUES ('PH', 7.35, 7.45), ('PCO2', 35, 45), ('PO2', 80, 100), ('HCO3', 22, 26), ('BE', -2, 2), ('LAC', 0.5, 2.0), ('SO2', 95, 100)) AS r(code, lo, hi) ON r.code = a.code
 WHERE s.code = 'LAB_ABG' AND NOT EXISTS (SELECT 1 FROM lab_reference_ranges x WHERE x.analyte_id = a.id);
INSERT INTO lab_norm_versions (analyte_id, version, ranges, critical_low, critical_high, unit, reason)
SELECT a.id, 1,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sex', r.sex, 'age_min_days', r.age_min_days, 'age_max_days', r.age_max_days,
                   'pregnancy', r.pregnancy, 'method_id', r.method_id, 'low', r.low, 'high', r.high, 'normal_text', r.normal_text))
                 FROM lab_reference_ranges r WHERE r.analyte_id = a.id), '[]'::jsonb),
       a.critical_low, a.critical_high, a.unit, 'საწყისი ნორმები (კატალოგის შაბლონი, 0047)'
  FROM lab_analytes a JOIN dx_services s ON s.id = a.service_id
 WHERE s.code = 'LAB_ABG' AND NOT EXISTS (SELECT 1 FROM lab_norm_versions v WHERE v.analyte_id = a.id);

-- ================================================================ 7. SOFA / APACHE II
CREATE TABLE icu_apache_categories (
    code        VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{2,30}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    operative   BOOLEAN NOT NULL,
    weight      NUMERIC(6,3) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
-- დიაგნოსტიკური კატეგორიის წონა (Knaus და სხვ., 1985) — სიკვდილობის რისკი მხოლოდ საინფორმაციოა; კლინიკამ გადაამოწმოს
INSERT INTO icu_apache_categories (code, name, operative, weight, sort_order) VALUES
 ('n_resp_asthma',      'სუნთქვის უკმარისობა: ასთმა / ალერგია',                 FALSE, -2.108, 10),
 ('n_resp_copd',        'სუნთქვის უკმარისობა: ფქოდ',                            FALSE, -0.367, 11),
 ('n_resp_edema',       'სუნთქვის უკმარისობა: არაკარდიოგენული შეშუპება',        FALSE, -0.251, 12),
 ('n_resp_arrest',      'სუნთქვის გაჩერების შემდეგ',                           FALSE, -0.168, 13),
 ('n_resp_aspiration',  'ასპირაცია / მოწამვლა / ტოქსიკური',                     FALSE, -0.142, 14),
 ('n_resp_pe',          'ფილტვის არტერიის თრომბოემბოლია',                       FALSE, -0.128, 15),
 ('n_resp_infection',   'სუნთქვის უკმარისობა: ინფექცია',                        FALSE,  0.000, 16),
 ('n_resp_neoplasm',    'სუნთქვის უკმარისობა: სიმსივნე',                        FALSE,  0.891, 17),
 ('n_cv_hypertension',  'ცირკულაცია: ჰიპერტენზია',                              FALSE, -1.798, 20),
 ('n_cv_rhythm',        'ცირკულაცია: რიტმის დარღვევა',                          FALSE, -1.368, 21),
 ('n_cv_chf',           'ცირკულაცია: გულის შეგუბებითი უკმარისობა',              FALSE, -0.424, 22),
 ('n_cv_hemorrhagic',   'ჰემორაგიული შოკი / ჰიპოვოლემია',                       FALSE,  0.493, 23),
 ('n_cv_cad',           'გულის იშემიური დაავადება',                             FALSE, -0.191, 24),
 ('n_cv_sepsis',        'სეფსისი',                                              FALSE,  0.113, 25),
 ('n_cv_arrest',        'გულის გაჩერების შემდეგ',                              FALSE,  0.393, 26),
 ('n_cv_cardiogenic',   'კარდიოგენული შოკი',                                    FALSE, -0.259, 27),
 ('n_cv_aneurysm',      'აორტის განშრევება / ანევრიზმა',                         FALSE,  0.731, 28),
 ('n_trauma_multi',     'პოლიტრავმა',                                           FALSE, -1.228, 30),
 ('n_trauma_head',      'თავის ტრავმა',                                         FALSE, -0.517, 31),
 ('n_neuro_seizure',    'კრუნჩხვითი სინდრომი',                                  FALSE, -0.584, 40),
 ('n_neuro_ich',        'ქალასშიდა სისხლჩაქცევა (ICH / SDH / SAH)',             FALSE,  0.723, 41),
 ('n_overdose',         'მედიკამენტით მოწამვლა (overdose)',                     FALSE, -3.353, 50),
 ('n_dka',              'დიაბეტური კეტოაციდოზი',                                FALSE, -1.507, 51),
 ('n_gi_bleed',         'კუჭ-ნაწლავის სისხლდენა',                               FALSE,  0.334, 52),
 ('n_other_metabolic',  'სხვა: მეტაბოლური / თირკმლის',                          FALSE, -0.885, 60),
 ('n_other_resp',       'სხვა: სასუნთქი',                                       FALSE, -0.890, 61),
 ('n_other_neuro',      'სხვა: ნევროლოგიური',                                   FALSE, -0.759, 62),
 ('n_other_cv',         'სხვა: გულ-სისხლძარღვთა',                               FALSE,  0.470, 63),
 ('n_other_gi',         'სხვა: გასტროინტესტინური',                              FALSE,  0.501, 64),
 ('p_multi_trauma',     'ოპერაციის შემდეგ: პოლიტრავმა',                         TRUE,  -1.684, 110),
 ('p_chronic_cv',       'ოპერაციის შემდეგ: ქრონიკული გულ-სისხლძარღვთა',         TRUE,  -1.376, 111),
 ('p_peripheral_vasc',  'პერიფერიული სისხლძარღვების ოპერაცია',                  TRUE,  -1.315, 112),
 ('p_valve',            'გულის სარქვლის ოპერაცია',                              TRUE,  -1.261, 113),
 ('p_crani_neoplasm',   'კრანიოტომია (სიმსივნე)',                               TRUE,  -1.245, 114),
 ('p_renal_neoplasm',   'თირკმლის ოპერაცია (სიმსივნე)',                         TRUE,  -1.204, 115),
 ('p_renal_tx',         'თირკმლის ტრანსპლანტაცია',                              TRUE,  -1.042, 116),
 ('p_head_trauma',      'ოპერაციის შემდეგ: თავის ტრავმა',                       TRUE,  -0.955, 117),
 ('p_thoracic_neo',     'გულმკერდის ოპერაცია (სიმსივნე)',                       TRUE,  -0.802, 118),
 ('p_crani_ich',        'კრანიოტომია (ICH / SDH / SAH)',                        TRUE,  -0.788, 119),
 ('p_spine',            'ლამინექტომია / ზურგის ტვინის ოპერაცია',                TRUE,  -0.699, 120),
 ('p_hemorrhagic',      'ოპერაციის შემდეგ: ჰემორაგიული შოკი',                   TRUE,  -0.682, 121),
 ('p_gi_bleed',         'ოპერაციის შემდეგ: კუჭ-ნაწლავის სისხლდენა',             TRUE,  -0.617, 122),
 ('p_gi_neoplasm',      'კუჭ-ნაწლავის ოპერაცია (სიმსივნე)',                     TRUE,  -0.248, 123),
 ('p_resp_insuff',      'ოპერაციის შემდგომი სუნთქვის უკმარისობა',               TRUE,  -0.140, 124),
 ('p_gi_perforation',   'კუჭ-ნაწლავის პერფორაცია / გაუვალობა',                  TRUE,   0.060, 125),
 ('p_other_neuro',      'ოპერაციის შემდეგ, სხვა: ნევროლოგიური',                  TRUE,  -1.150, 130),
 ('p_other_cv',         'ოპერაციის შემდეგ, სხვა: გულ-სისხლძარღვთა',              TRUE,  -0.797, 131),
 ('p_other_resp',       'ოპერაციის შემდეგ, სხვა: სასუნთქი',                      TRUE,  -0.610, 132),
 ('p_other_gi',         'ოპერაციის შემდეგ, სხვა: გასტროინტესტინური',             TRUE,  -0.613, 133),
 ('p_other_metabolic',  'ოპერაციის შემდეგ, სხვა: მეტაბოლური / თირკმლის',         TRUE,  -0.196, 134);

CREATE TABLE icu_scores (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id         UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id           UUID NOT NULL REFERENCES patients(id),
    episode_id           UUID NOT NULL REFERENCES icu_episodes(id),
    kind                 VARCHAR(8) NOT NULL CHECK (kind IN ('sofa', 'apache2')),
    window_from          TIMESTAMPTZ NOT NULL,
    window_to            TIMESTAMPTZ NOT NULL,
    score_date           DATE NOT NULL,                                -- კლინიკის დღე (SOFA — დღეში ერთი)
    components           JSONB NOT NULL,                               -- {key: {value, points, source: auto|manual|missing, at, unit}}
    total                SMALLINT NOT NULL CHECK (total >= 0),
    missing              TEXT[] NOT NULL DEFAULT '{}',                 -- დაუდგენელი კომპონენტები (ნორმად არ ითვლება)
    apache_category      VARCHAR(30) REFERENCES icu_apache_categories(code),
    emergency_surgery    BOOLEAN,
    predicted_mortality  NUMERIC(5,2) CHECK (predicted_mortality BETWEEN 0 AND 100),
    note                 TEXT,
    confirmed_by         UUID NOT NULL REFERENCES users(id),
    confirmed_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at            TIMESTAMPTZ,
    voided_by            UUID REFERENCES users(id),
    void_reason          TEXT,
    CONSTRAINT chk_score_window CHECK (window_to > window_from),
    CONSTRAINT chk_score_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX ux_icu_sofa_day ON icu_scores (encounter_id, score_date) WHERE kind = 'sofa' AND voided_at IS NULL;
CREATE UNIQUE INDEX ux_icu_apache_episode ON icu_scores (episode_id) WHERE kind = 'apache2' AND voided_at IS NULL;
CREATE INDEX idx_icu_scores ON icu_scores (encounter_id, kind, window_to DESC) WHERE voided_at IS NULL;

-- RASS, CAM-ICU — შკალების ძრავა (0044). CAM-ICU: ნიშანი 1 (4) + ნიშანი 2 (2) + [ნიშანი 3 ან 4] (1) → ≥ 7 = დადებითი
INSERT INTO scale_defs (code, name, description, required, reassess_hours, risk_label, sort_order, items, bands) VALUES
('rass', 'RASS — აგზნება / სედაცია', 'Richmond Agitation-Sedation Scale (+4 … −5)', FALSE, NULL, NULL, 40,
 '[{"key":"rass","label":"RASS","options":[{"label":"+4 აგრესიული","points":4},{"label":"+3 ძლიერ აგზნებული","points":3},{"label":"+2 აგზნებული","points":2},{"label":"+1 მოუსვენარი","points":1},{"label":"0 ფხიზელი, მშვიდი","points":0},{"label":"−1 თვლემს (ხმაზე > 10 წმ)","points":-1},{"label":"−2 მსუბუქი სედაცია (ხმაზე < 10 წმ)","points":-2},{"label":"−3 ზომიერი სედაცია (ხმაზე მოძრაობა, მზერის გარეშე)","points":-3},{"label":"−4 ღრმა სედაცია (მხოლოდ ფიზიკურ სტიმულზე)","points":-4},{"label":"−5 არ იღვიძებს","points":-5}]}]',
 '[{"min":1,"max":4,"label":"აგზნება","level":"high"},{"min":0,"max":0,"label":"მშვიდი","level":"none"},{"min":-2,"max":-1,"label":"მსუბუქი სედაცია","level":"low"},{"min":-3,"max":-3,"label":"ზომიერი სედაცია","level":"medium"},{"min":-5,"max":-4,"label":"ღრმა სედაცია","level":"high"}]'),
('cam_icu', 'CAM-ICU — დელირიუმი', 'Confusion Assessment Method for the ICU (RASS −4 / −5 — არ ფასდება)', FALSE, 24, 'დელირიუმი', 41,
 '[{"key":"f1","label":"1. ცნობიერების მწვავე ცვლილება ან მერყეობა","options":[{"label":"არა","points":0},{"label":"კი","points":4}]},
   {"key":"f2","label":"2. ყურადღების დარღვევა (> 2 შეცდომა)","options":[{"label":"არა","points":0},{"label":"კი","points":2}]},
   {"key":"f3","label":"3. ცნობიერების დონის ცვლილება (RASS ≠ 0)","options":[{"label":"არა","points":0},{"label":"კი","points":1}]},
   {"key":"f4","label":"4. აზროვნების დეზორგანიზაცია (> 1 შეცდომა)","options":[{"label":"არა","points":0},{"label":"კი","points":1}]}]',
 '[{"min":0,"max":6,"label":"უარყოფითი","level":"none"},{"min":7,"max":8,"label":"დადებითი — დელირიუმი","level":"high"}]')
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 8. bundle-ები (VAP / CLABSI)
CREATE TABLE icu_bundle_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bundle      VARCHAR(8) NOT NULL CHECK (bundle IN ('vap', 'clabsi')),
    label       TEXT NOT NULL CHECK (length(btrim(label)) >= 3),
    sort_order  INT NOT NULL DEFAULT 100,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO icu_bundle_items (bundle, label, sort_order) VALUES
 ('vap', 'საწოლის თავი აწეულია 30–45°', 10),
 ('vap', 'სედაციის დღიური შეწყვეტა / RASS მიზანი შეფასებულია', 20),
 ('vap', 'სპონტანური სუნთქვის ცდის (SBT) მზადყოფნა შეფასებულია', 30),
 ('vap', 'პირის ღრუს მოვლა (ქლორჰექსიდინი)', 40),
 ('vap', 'მანჟეტის წნევა 20–30 სმ H₂O / სუბგლოტური ასპირაცია', 50),
 ('vap', 'სტრეს-წყლულის პროფილაქტიკა', 60),
 ('vap', 'ვენური თრომბოემბოლიის პროფილაქტიკა', 70),
 ('clabsi', 'ცენტრალური ხაზის საჭიროება დღეს გადაფასებულია', 10),
 ('clabsi', 'სახვევი სუფთა, მშრალი, მთლიანი', 20),
 ('clabsi', 'სახვევის შეცვლის ვადა დაცულია', 30),
 ('clabsi', 'კონექტორის / ჰაბის დეზინფექცია ყოველ შეხებაზე', 40),
 ('clabsi', 'ჩადგმის ადგილას ინფექციის ნიშანი არ არის', 50),
 ('clabsi', 'ქლორჰექსიდინით დაბანა', 60);

CREATE TABLE icu_bundle_checks (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    bundle        VARCHAR(8) NOT NULL CHECK (bundle IN ('vap', 'clabsi')),
    check_date    DATE NOT NULL,                                   -- კლინიკის დღე
    answers       JSONB NOT NULL,                                  -- [{item_id, label, answer: yes|no|na}]
    compliant     BOOLEAN NOT NULL,                                -- ყველა „კი“ ან „არ ეხება“
    note          TEXT,
    checked_by    UUID NOT NULL REFERENCES users(id),
    checked_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at     TIMESTAMPTZ,
    voided_by     UUID REFERENCES users(id),
    void_reason   TEXT,
    CONSTRAINT chk_bundle_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX ux_bundle_day ON icu_bundle_checks (encounter_id, bundle, check_date) WHERE voided_at IS NULL;

-- ჩანაწერები არ რედაქტირდება (მხოლოდ გაუქმება / დასრულება)
CREATE TRIGGER trg_vent_guard BEFORE UPDATE ON icu_ventilation FOR EACH ROW
    EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason', 'ended_at', 'ended_by', 'end_reason', 'end_note', 'episode_id');
CREATE TRIGGER trg_vent_settings_guard BEFORE UPDATE ON icu_vent_settings FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');
CREATE TRIGGER trg_abg_guard BEFORE UPDATE ON icu_abg FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');
CREATE TRIGGER trg_scores_guard BEFORE UPDATE ON icu_scores FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');
CREATE TRIGGER trg_bundle_guard BEFORE UPDATE ON icu_bundle_checks FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');

-- ================================================================ 9. ექიმის ჩანაწერები: ICU დღიური (A–F), გაყვანის შეჯამება
ALTER TABLE doctor_notes DROP CONSTRAINT doctor_notes_kind_check;
ALTER TABLE doctor_notes ADD CONSTRAINT doctor_notes_kind_check CHECK (kind IN ('admission', 'progress', 'rounds', 'consult', 'icu_daily', 'icu_out'));
ALTER TABLE note_templates DROP CONSTRAINT note_templates_kind_check;
ALTER TABLE note_templates ADD CONSTRAINT note_templates_kind_check CHECK (kind IN ('admission', 'progress', 'rounds', 'consult', 'icu_daily', 'icu_out'));

-- ================================================================ 10. ბილინგი: ვენტილაციის დღე
ALTER TABLE invoice_line_items DROP CONSTRAINT invoice_line_items_category_check;
ALTER TABLE invoice_line_items ADD CONSTRAINT invoice_line_items_category_check CHECK (category IN
    ('bed', 'ventilation', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'));
ALTER TABLE billing_package_items DROP CONSTRAINT billing_package_items_category_check;
ALTER TABLE billing_package_items ADD CONSTRAINT billing_package_items_category_check CHECK (category IN
    ('service', 'ventilation', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant'));

CREATE TABLE stay_vent_days (
    encounter_id      UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    day               DATE NOT NULL,
    minimum           BOOLEAN NOT NULL DEFAULT FALSE,                   -- შუაღამე არ გადაკვეთა — მინიმუმ 1 დღე
    tariff_id         UUID REFERENCES service_tariffs(id),
    package_included  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (encounter_id, day)
);

-- ინვაზიური ვენტილაციის დღეები (შუაღამის წესი: დღე D — თუ D+1 00:00-ზე ვენტილაციაზეა; მინიმუმ 1) + ინვოისის „ventilation“ ხაზი.
--   ტარიფი — icu.vent_day_tariff_id; vent_billing = false ან მოდული გამორთულია → დღეები აღირიცხება, ინვოისში არ ემატება.
CREATE OR REPLACE FUNCTION ipd_sync_vent_days(p_enc UUID, p_tz TEXT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_inv invoices%ROWTYPE; v_pkg UUID; v_on BOOLEAN; v_tariff UUID; v_n INT;
BEGIN
    SELECT * INTO v_inv FROM invoices WHERE encounter_id = p_enc;
    IF NOT FOUND OR v_inv.finalized_at IS NOT NULL THEN RETURN -1; END IF;
    SELECT m.enabled AND coalesce((m.settings->>'vent_billing')::boolean, TRUE), nullif(m.settings->>'vent_day_tariff_id', '')::uuid INTO v_on, v_tariff
      FROM system_modules m WHERE m.code = 'icu';
    SELECT sb.package_id INTO v_pkg FROM stay_billing sb WHERE sb.encounter_id = p_enc;
    IF v_tariff IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_tariffs t WHERE t.id = v_tariff AND t.is_active) THEN v_tariff := NULL; END IF;

    DELETE FROM stay_vent_days WHERE encounter_id = p_enc;
    INSERT INTO stay_vent_days (encounter_id, day)
    SELECT DISTINCT p_enc, (g.dd::date - 1)
      FROM icu_ventilation v
      CROSS JOIN LATERAL generate_series((v.started_at AT TIME ZONE p_tz)::date + 1, (coalesce(v.ended_at, now()) AT TIME ZONE p_tz)::date, interval '1 day') g(dd)
     WHERE v.encounter_id = p_enc AND v.kind = 'invasive' AND v.voided_at IS NULL
       AND (g.dd::date::timestamp AT TIME ZONE p_tz) > v.started_at
       AND (v.ended_at IS NULL OR v.ended_at > (g.dd::date::timestamp AT TIME ZONE p_tz))
       AND (g.dd::date::timestamp AT TIME ZONE p_tz) <= now();
    IF NOT EXISTS (SELECT 1 FROM stay_vent_days WHERE encounter_id = p_enc) THEN
        INSERT INTO stay_vent_days (encounter_id, day, minimum)
        SELECT p_enc, (min(v.started_at) AT TIME ZONE p_tz)::date, TRUE FROM icu_ventilation v
         WHERE v.encounter_id = p_enc AND v.kind = 'invasive' AND v.voided_at IS NULL HAVING count(*) > 0;
    END IF;
    UPDATE stay_vent_days SET tariff_id = v_tariff,
           package_included = v_pkg IS NOT NULL AND billing_package_covers(v_pkg, 'ventilation', v_tariff)
     WHERE encounter_id = p_enc;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND category = 'ventilation';
    IF v_on AND v_tariff IS NOT NULL THEN
        INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, package_included, service_date)
        SELECT v_inv.id, s.id, s.title || ' (ხელოვნური ვენტილაციის დღე)', count(*)::int, s.base_price, s.base_price, 'ventilation', d.package_included, min(d.day)
          FROM stay_vent_days d JOIN service_tariffs s ON s.id = d.tariff_id
         WHERE d.encounter_id = p_enc
         GROUP BY s.id, s.title, s.base_price, d.package_included;
    END IF;
    RETURN v_n;
END $$;

-- 0046-ის საწოლდღეების სინქრონიზაცია + ვენტილაციის დღეები (ერთი გამოძახებით — ყველა არსებული გამომძახებელი)
CREATE OR REPLACE FUNCTION ipd_sync_bed_days(p_enc UUID, p_tz TEXT, p_leave_billable BOOLEAN) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_st inpatient_stays%ROWTYPE; v_inv invoices%ROWTYPE; v_pkg billing_packages%ROWTYPE; v_end TIMESTAMPTZ; v_n INT;
BEGIN
    SELECT * INTO v_st FROM inpatient_stays WHERE encounter_id = p_enc;
    IF NOT FOUND THEN RETURN 0; END IF;
    SELECT * INTO v_inv FROM invoices WHERE encounter_id = p_enc FOR UPDATE;
    IF NOT FOUND OR v_inv.finalized_at IS NOT NULL THEN RETURN -1; END IF;
    INSERT INTO stay_billing (encounter_id) VALUES (p_enc) ON CONFLICT DO NOTHING;
    SELECT p.* INTO v_pkg FROM stay_billing sb JOIN billing_packages p ON p.id = sb.package_id WHERE sb.encounter_id = p_enc;
    v_end := CASE WHEN v_st.status = 'active' THEN now() ELSE coalesce(v_st.ended_at, now()) END;

    IF to_regclass('pg_temp._bd') IS NULL THEN
        CREATE TEMP TABLE _bd (day DATE PRIMARY KEY, department_id UUID, bed_id UUID, bed_type_code VARCHAR(30), on_leave BOOLEAN, minimum BOOLEAN) ON COMMIT DROP;
    END IF;
    TRUNCATE _bd;
    IF v_st.status <> 'cancelled' THEN
        INSERT INTO _bd
        SELECT m.d - 1, a.department_id, a.bed_id, coalesce(b.type_code, 'standard'),
               EXISTS (SELECT 1 FROM inpatient_leaves l WHERE l.encounter_id = p_enc AND l.started_at <= (m.d::timestamp AT TIME ZONE p_tz)
                       AND (l.returned_at IS NULL OR l.returned_at > (m.d::timestamp AT TIME ZONE p_tz))), FALSE
          FROM generate_series((v_st.admitted_at AT TIME ZONE p_tz)::date + 1, (v_end AT TIME ZONE p_tz)::date, interval '1 day') g(dd)
          CROSS JOIN LATERAL (SELECT g.dd::date AS d) m
          JOIN LATERAL (SELECT * FROM bed_assignments a WHERE a.encounter_id = p_enc AND a.end_kind IS DISTINCT FROM 'cancel'
                          AND a.started_at <= (m.d::timestamp AT TIME ZONE p_tz) AND (a.ended_at IS NULL OR a.ended_at > (m.d::timestamp AT TIME ZONE p_tz))
                        ORDER BY a.started_at DESC LIMIT 1) a ON TRUE
          LEFT JOIN beds b ON b.id = a.bed_id
         WHERE (m.d::timestamp AT TIME ZONE p_tz) <= v_end;
        IF NOT p_leave_billable THEN DELETE FROM _bd WHERE on_leave; END IF;
        IF NOT EXISTS (SELECT 1 FROM _bd) THEN
            INSERT INTO _bd
            SELECT (v_st.admitted_at AT TIME ZONE p_tz)::date, a.department_id, a.bed_id, coalesce(b.type_code, 'standard'), FALSE, TRUE
              FROM bed_assignments a LEFT JOIN beds b ON b.id = a.bed_id
             WHERE a.encounter_id = p_enc AND a.end_kind IS DISTINCT FROM 'cancel'
             ORDER BY (a.bed_id IS NOT NULL) DESC, a.started_at LIMIT 1;
        END IF;
    END IF;

    DELETE FROM stay_bed_days WHERE encounter_id = p_enc;
    INSERT INTO stay_bed_days (encounter_id, day, department_id, bed_id, bed_type_code, on_leave, minimum, tariff_id, package_included)
    SELECT p_enc, x.day, x.department_id, x.bed_id, x.bed_type_code, x.on_leave, x.minimum,
           CASE WHEN v_pkg.id IS NOT NULL AND v_pkg.includes_bed AND v_pkg.included_days IS NOT NULL AND x.rn > v_pkg.included_days AND v_pkg.extra_day_tariff_id IS NOT NULL
                THEN v_pkg.extra_day_tariff_id ELSE x.tariff_id END,
           v_pkg.id IS NOT NULL AND v_pkg.includes_bed AND (v_pkg.included_days IS NULL OR x.rn <= v_pkg.included_days)
      FROM (SELECT d.*, row_number() OVER (ORDER BY d.day) AS rn,
                   (SELECT t.tariff_id FROM bed_day_tariffs t JOIN service_tariffs s ON s.id = t.tariff_id
                     WHERE t.bed_type_code = d.bed_type_code AND (t.department_id = d.department_id OR t.department_id IS NULL) AND s.is_active
                     ORDER BY t.department_id IS NULL LIMIT 1) AS tariff_id
              FROM _bd d) x;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND category = 'bed';
    INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, package_included, service_date)
    SELECT v_inv.id, s.id, s.title || ' (საწოლდღე)', count(*)::int, s.base_price, s.base_price, 'bed', d.package_included, min(d.day)
      FROM stay_bed_days d JOIN service_tariffs s ON s.id = d.tariff_id
     WHERE d.encounter_id = p_enc
     GROUP BY s.id, s.title, s.base_price, d.package_included;
    PERFORM ipd_sync_vent_days(p_enc, p_tz);                                   -- 0047
    UPDATE stay_billing SET bed_days_synced_at = now() WHERE encounter_id = p_enc;
    RETURN v_n;
END $$;

-- ================================================================ 11. ისტორია
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
    -- 0047
    'icu_in', 'icu_out', 'icu_interval', 'vent_started', 'vent_ended', 'icu_score'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON icu_episodes, icu_ventilation, icu_vent_settings, icu_abg, icu_scores, icu_bundle_checks FROM emr_app;
    REVOKE TRUNCATE ON stay_vent_days, icu_bundle_items, icu_apache_categories FROM emr_app;
  END IF;
END $$;
