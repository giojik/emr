-- 0064_quality_incidents.sql
-- ხარისხი და ინციდენტები, ეტაპი 1 — რეესტრი და ტრიაჟი (ბლოკი D, მოდული 1).
--
--  • შეტყობინება — ნებისმიერი ავტორიზებული თანამშრომლისგან; ავტორის რეჟიმი: ღია / კონფიდენციალური (ავტორი ჩანს მხოლოდ
--      ხარისხის მენეჯერთან) / ანონიმური (ავტორი არსად ინახება — არც ინციდენტში, არც აუდიტში; სტატუსის სანახავად — ერთჯერადი კოდი,
--      ბაზაში მხოლოდ მისი SHA-256). დაშვებული რეჟიმები / ნაგულისხმევი — პარამეტრი.
--  • მოვლენის ტიპი (WHO ICPS ლოგიკა): ზიანით / ზიანის გარეშე / near-miss / სახიფათო მდგომარეობა; ვის შეეხო: პაციენტი / თანამშრომელი / ვიზიტორი.
--  • კლასიფიკაცია: 2-დონიანი ცნობარი (კატეგორია → ქვეკატეგორია) + ხელშემწყობი ფაქტორები (London Protocol; გამოიყენება RCA-ში, 0065).
--      ქვეკატეგორია შეიძლება იყოს „სენტინელური“ → ინციდენტი ავტომატურად სასწრაფოა (ტრიაჟის ვადა — sentinel_triage_hours).
--  • სიმძიმე: ზიანის სკალა (არ არის / მსუბუქი / საშუალო / მძიმე / სიკვდილი) — ავტორის წინასწარი, ტრიაჟზე საბოლოო;
--      მედიკამენტზე (არჩევითი) NCC MERP A–I. რისკი: 5×5 (ალბათობა × შედეგი), დონის ზღვრები — პარამეტრი.
--  • მიბმა: პაციენტი / ვიზიტი + ზოგადი წყარო (source_type, source_id): MAR, დანიშნულება, ოპერაცია, კვლევა / ანალიზი, ნიმუში,
--      ჰოსპიტალიზაცია, ინვენტარი, დიაგნოსტიკის აპარატი. ინციდენტი პაციენტის კლინიკურ ჩანაწერში არ ჩანს.
--  • სტატუსები: submitted → (ტრიაჟი) investigation | rejected; შემდეგი (analysis, capa, closed) — 0065.
--  • უფლებები: quality (სრული), quality_dept (თავისი განყოფილება, ავტორისა და მონაწილეების გარეშე), quality_view (მხოლოდ აგრეგატები, 0066). 33 → 36.
--      admin ინციდენტებს ავტომატურად ვერ ხედავს. როლი „ხარისხის მენეჯერი“ (quality + reports_all) — რედაქტირებადი.

-- ================================================================ 0. მოდული, უფლებები, როლი
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('quality', 'ხარისხი და ინციდენტები', 'პაციენტის უსაფრთხოების ინციდენტები და near-miss: შეტყობინება (ღია / კონფიდენციალური / ანონიმური), ტრიაჟი, რისკის შეფასება, ანალიზი, მაკორექტირებელი ქმედებები, დახურვა',
 TRUE, TRUE,
 '{"identity_modes": ["open", "confidential", "anonymous"],
   "identity_default": "confidential",
   "ncc_merp": true,
   "risk_low_max": 3,
   "risk_medium_max": 6,
   "risk_high_max": 12,
   "triage_hours": 72,
   "sentinel_triage_hours": 24,
   "alert_harm": "severe",
   "alert_user_ids": [],
   "alert_sms": false,
   "alert_email": false,
   "event_prompts": true,
   "author_feedback": true,
   "anonymous_tracking": true}', 46)
ON CONFLICT (code) DO NOTHING;

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
        'quality', 'quality_dept', 'quality_view']::VARCHAR(30)[]);

INSERT INTO roles (code, name, description, is_system, capabilities, sort_order)
SELECT 'quality_manager', 'ხარისხის მენეჯერი', 'ინციდენტების რეესტრი, ტრიაჟი, ანალიზი, CAPA, ცნობარები; მენეჯერული დაფა (მთელი კლინიკა)', FALSE,
       '{quality,reports_all}', coalesce((SELECT max(sort_order) FROM roles), 0) + 10
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'quality_manager');

-- ================================================================ 1. ცნობარები: კატეგორიები, ხელშემწყობი ფაქტორები
CREATE TABLE qm_classifiers (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('category', 'factor')),
    parent_id      UUID REFERENCES qm_classifiers(id),
    code           VARCHAR(40) NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    name           TEXT NOT NULL CHECK (length(trim(name)) >= 2),
    description    TEXT,
    is_medication  BOOLEAN NOT NULL DEFAULT FALSE,        -- კატეგორია: NCC MERP ველი ჩანს
    is_sentinel    BOOLEAN NOT NULL DEFAULT FALSE,        -- ქვეკატეგორია: სენტინელური მოვლენა
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (kind, code),
    CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX idx_qm_classifiers_parent ON qm_classifiers (parent_id);
CREATE TRIGGER trg_qm_classifiers_updated BEFORE UPDATE ON qm_classifiers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ორი დონე: მშობელი იმავე სახისაა და თვითონ ძირეულია
CREATE OR REPLACE FUNCTION qm_classifiers_level_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE p RECORD;
BEGIN
    IF NEW.parent_id IS NOT NULL THEN
        SELECT kind, parent_id INTO p FROM qm_classifiers WHERE id = NEW.parent_id;
        IF p.kind IS DISTINCT FROM NEW.kind THEN RAISE EXCEPTION 'qm_classifiers: მშობელი სხვა სახისაა'; END IF;
        IF p.parent_id IS NOT NULL THEN RAISE EXCEPTION 'qm_classifiers: მხოლოდ ორი დონე'; END IF;
        IF EXISTS (SELECT 1 FROM qm_classifiers c WHERE c.parent_id = NEW.id) THEN RAISE EXCEPTION 'qm_classifiers: ქვეელემენტების მქონე ძირეული ვერ გახდება ქვეელემენტი'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_qm_classifiers_level BEFORE INSERT OR UPDATE OF parent_id, kind ON qm_classifiers FOR EACH ROW EXECUTE FUNCTION qm_classifiers_level_trg();

-- seed: კატეგორიები
INSERT INTO qm_classifiers (kind, code, name, is_medication, sort_order) VALUES
('category', 'medication',     'მედიკამენტი',                               TRUE,  10),
('category', 'fall',           'დაცემა',                                    FALSE, 20),
('category', 'infection',      'ინფექცია (HAI)',                            FALSE, 30),
('category', 'device',         'აპარატი / სამედიცინო მასალა',               FALSE, 40),
('category', 'identification', 'პაციენტის იდენტიფიკაცია',                  FALSE, 50),
('category', 'surgery',        'ქირურგია / პროცედურა',                      FALSE, 60),
('category', 'diagnostics',    'დიაგნოსტიკა / ლაბორატორია',                 FALSE, 70),
('category', 'transfusion',    'ტრანსფუზია',                                FALSE, 80),
('category', 'pressure_ulcer', 'ნაწოლი',                                    FALSE, 90),
('category', 'documentation',  'დოკუმენტაცია / კომუნიკაცია',                FALSE, 100),
('category', 'behaviour',      'ქცევა / ძალადობა',                          FALSE, 110),
('category', 'infrastructure', 'ინფრასტრუქტურა / გარემო',                   FALSE, 120),
('category', 'other',          'სხვა',                                      FALSE, 999);

INSERT INTO qm_classifiers (kind, parent_id, code, name, is_sentinel, sort_order)
SELECT 'category', p.id, v.code, v.name, v.sentinel, v.ord
FROM (VALUES
  ('medication',     'med_wrong_drug',      'არასწორი მედიკამენტი',                          FALSE, 10),
  ('medication',     'med_wrong_dose',      'არასწორი დოზა / სიჩქარე',                       FALSE, 20),
  ('medication',     'med_wrong_patient',   'არასწორი პაციენტი',                             FALSE, 30),
  ('medication',     'med_wrong_route',     'არასწორი გზა / დრო',                            FALSE, 40),
  ('medication',     'med_omission',        'გამოტოვებული დოზა',                             FALSE, 50),
  ('medication',     'med_allergy',         'ცნობილი ალერგიის მიუხედავად',                   FALSE, 60),
  ('medication',     'med_adverse',         'გვერდითი რეაქცია',                              FALSE, 70),
  ('fall',           'fall_bed',            'საწოლიდან',                                     FALSE, 10),
  ('fall',           'fall_walking',        'სიარულისას / სააბაზანოში',                      FALSE, 20),
  ('fall',           'fall_death',          'დაცემა, რომელსაც მოჰყვა სიკვდილი / მძიმე ტრავმა', TRUE, 90),
  ('infection',      'inf_ssi',             'ოპერაციის ადგილის ინფექცია (SSI)',              FALSE, 10),
  ('infection',      'inf_line',            'კათეტერთან ასოცირებული (CLABSI / CAUTI)',       FALSE, 20),
  ('infection',      'inf_vap',             'ვენტილატორთან ასოცირებული (VAP)',               FALSE, 30),
  ('device',         'dev_failure',         'აპარატის გაუმართაობა',                          FALSE, 10),
  ('device',         'dev_use_error',       'არასწორი გამოყენება',                           FALSE, 20),
  ('device',         'dev_supply',          'მასალა ხარვეზით / ვადაგასული',                  FALSE, 30),
  ('identification', 'id_wrong_patient',    'არასწორი პაციენტი (პროცედურა / კვლევა)',        FALSE, 10),
  ('identification', 'id_wristband',        'სამაჯური არ არის / შეცდომით',                   FALSE, 20),
  ('surgery',        'surg_wrong_site',     'არასწორი მხარე / ადგილი / პაციენტი ოპერაციაზე', TRUE, 10),
  ('surgery',        'surg_retained',       'სხეულში დარჩენილი უცხო სხეული',                 TRUE, 20),
  ('surgery',        'surg_complication',   'მოულოდნელი გართულება',                          FALSE, 30),
  ('surgery',        'surg_count',          'დათვლის შეუსაბამობა',                           FALSE, 40),
  ('diagnostics',    'dx_specimen',         'ნიმუშის ეტიკეტი / დაკარგვა',                    FALSE, 10),
  ('diagnostics',    'dx_result',           'შედეგის შეცდომა / დაგვიანება',                  FALSE, 20),
  ('diagnostics',    'dx_critical',         'კრიტიკული შედეგი არ ეცნობა',                    FALSE, 30),
  ('transfusion',    'tx_wrong_blood',      'შეუთავსებელი სისხლის გადასხმა',                 TRUE, 10),
  ('transfusion',    'tx_reaction',         'ტრანსფუზიული რეაქცია',                          FALSE, 20),
  ('pressure_ulcer', 'pu_hospital',         'სტაციონარში განვითარებული',                     FALSE, 10),
  ('documentation',  'doc_handover',        'გადაბარების ხარვეზი',                           FALSE, 10),
  ('documentation',  'doc_record',          'ჩანაწერის შეცდომა / ნაკლებობა',                 FALSE, 20),
  ('behaviour',      'beh_aggression',      'აგრესია / ძალადობა',                            FALSE, 10),
  ('behaviour',      'beh_absconding',      'პაციენტმა დატოვა ნებართვის გარეშე',             FALSE, 20),
  ('behaviour',      'beh_suicide',         'თვითდაზიანება სტაციონარში',                     TRUE, 30),
  ('infrastructure', 'inf_power',           'ელექტრო / წყალი / გათბობა',                     FALSE, 10),
  ('infrastructure', 'inf_it',              'IT სისტემა მიუწვდომელია',                       FALSE, 20)
) AS v(parent, code, name, sentinel, ord)
JOIN qm_classifiers p ON p.kind = 'category' AND p.code = v.parent AND p.parent_id IS NULL;

-- seed: ხელშემწყობი ფაქტორები (London Protocol)
INSERT INTO qm_classifiers (kind, code, name, sort_order) VALUES
('factor', 'patient',      'პაციენტის ფაქტორები',          10),
('factor', 'individual',   'პერსონალის ფაქტორები',         20),
('factor', 'task',         'ამოცანა და ტექნოლოგია',        30),
('factor', 'team',         'გუნდი და კომუნიკაცია',         40),
('factor', 'environment',  'სამუშაო გარემო',               50),
('factor', 'organisation', 'ორგანიზაცია და მართვა',        60);
INSERT INTO qm_classifiers (kind, parent_id, code, name, sort_order)
SELECT 'factor', p.id, v.code, v.name, v.ord
FROM (VALUES
  ('patient',      'pf_condition',     'მდგომარეობის სიმძიმე / სირთულე', 10),
  ('patient',      'pf_communication', 'ენა / კომუნიკაციის ბარიერი',     20),
  ('individual',   'if_knowledge',     'ცოდნა / გამოცდილება',            10),
  ('individual',   'if_fatigue',       'დაღლილობა / დატვირთვა',          20),
  ('task',         'tf_protocol',      'პროტოკოლი არ არის / გაურკვეველია', 10),
  ('task',         'tf_equipment',     'აღჭურვილობა / IT',               20),
  ('team',         'tm_handover',      'გადაბარება',                     10),
  ('team',         'tm_supervision',   'ზედამხედველობა',                 20),
  ('environment',  'env_staffing',     'პერსონალის ნაკლებობა',           10),
  ('environment',  'env_physical',     'განათება / ხმაური / სივრცე',     20),
  ('organisation', 'org_policy',       'პოლიტიკა / რესურსები',           10),
  ('organisation', 'org_culture',      'უსაფრთხოების კულტურა',           20)
) AS v(parent, code, name, ord)
JOIN qm_classifiers p ON p.kind = 'factor' AND p.code = v.parent AND p.parent_id IS NULL;

-- ================================================================ 2. ინციდენტი
CREATE TABLE qm_incidents (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inc_no             VARCHAR(20) NOT NULL UNIQUE,                              -- INC26-000001
    status             VARCHAR(16) NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted', 'rejected', 'investigation', 'analysis', 'capa', 'closed')),
    event_type         VARCHAR(10) NOT NULL CHECK (event_type IN ('harm', 'no_harm', 'near_miss', 'hazard')),
    affected           VARCHAR(10) NOT NULL CHECK (affected IN ('patient', 'staff', 'visitor', 'none')),
    occurred_at        TIMESTAMPTZ NOT NULL,
    reported_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    department_id      UUID NOT NULL REFERENCES departments(id),
    location_text      TEXT,
    category_id        UUID NOT NULL REFERENCES qm_classifiers(id),
    harm_reported      VARCHAR(10) NOT NULL CHECK (harm_reported IN ('none', 'mild', 'moderate', 'severe', 'death')),
    harm               VARCHAR(10) CHECK (harm IN ('none', 'mild', 'moderate', 'severe', 'death')),  -- საბოლოო (ტრიაჟი)
    merp_category      CHAR(1) CHECK (merp_category IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I')),
    description        TEXT NOT NULL CHECK (length(trim(description)) >= 10),
    immediate_actions  TEXT,
    patient_id         UUID REFERENCES patients(id),
    patient_text       TEXT,                                                     -- პაციენტის ძებნის უფლების გარეშე: სახელი / პალატა (ტრიაჟზე მიება)
    encounter_id       UUID REFERENCES encounters(id),
    source_type        VARCHAR(16) CHECK (source_type IN ('encounter', 'stay', 'med_order', 'mar_entry', 'or_case', 'dx_order_item', 'lab_specimen', 'asset', 'dx_device')),
    source_id          UUID,
    source_label       TEXT,
    identity_mode      VARCHAR(12) NOT NULL CHECK (identity_mode IN ('open', 'confidential', 'anonymous')),
    reporter_id        UUID REFERENCES users(id),
    track_hash         CHAR(64) UNIQUE,                                          -- ანონიმური: SHA-256(კოდი)
    is_sentinel        BOOLEAN NOT NULL DEFAULT FALSE,
    urgent             BOOLEAN NOT NULL DEFAULT FALSE,
    triage_due_at      TIMESTAMPTZ NOT NULL,
    overdue_notified_at TIMESTAMPTZ,
    -- ტრიაჟი
    triaged_at         TIMESTAMPTZ,
    triaged_by         UUID REFERENCES users(id),
    triage_note        TEXT,
    reject_reason      VARCHAR(16) CHECK (reject_reason IN ('duplicate', 'not_incident', 'insufficient', 'other')),
    duplicate_of       UUID REFERENCES qm_incidents(id),
    likelihood         SMALLINT CHECK (likelihood BETWEEN 1 AND 5),
    consequence        SMALLINT CHECK (consequence BETWEEN 1 AND 5),
    risk_score         SMALLINT GENERATED ALWAYS AS (likelihood * consequence) STORED,
    risk_level         VARCHAR(10) CHECK (risk_level IN ('low', 'medium', 'high', 'extreme')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (identity_mode <> 'anonymous' OR reporter_id IS NULL),
    CHECK (identity_mode = 'anonymous' OR (reporter_id IS NOT NULL AND track_hash IS NULL)),
    CHECK ((source_type IS NULL) = (source_id IS NULL)),
    CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
    CHECK (reject_reason IS DISTINCT FROM 'duplicate' OR duplicate_of IS NOT NULL),
    CHECK (status IN ('submitted', 'rejected') OR (harm IS NOT NULL AND likelihood IS NOT NULL AND consequence IS NOT NULL AND risk_level IS NOT NULL)),
    CHECK (duplicate_of IS NULL OR duplicate_of <> id)
);
CREATE INDEX idx_qm_incidents_status ON qm_incidents (status, triage_due_at);
CREATE INDEX idx_qm_incidents_dept ON qm_incidents (department_id, occurred_at);
CREATE INDEX idx_qm_incidents_reporter ON qm_incidents (reporter_id) WHERE reporter_id IS NOT NULL;
CREATE INDEX idx_qm_incidents_patient ON qm_incidents (patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX idx_qm_incidents_source ON qm_incidents (source_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_qm_incidents_category ON qm_incidents (category_id);
CREATE TRIGGER trg_qm_incidents_updated BEFORE UPDATE ON qm_incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ანონიმურობის დაცვა: შექმნის შემდეგ ავტორის რეჟიმი / ავტორი არ იცვლება
CREATE OR REPLACE FUNCTION qm_incidents_identity_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.identity_mode IS DISTINCT FROM OLD.identity_mode OR NEW.reporter_id IS DISTINCT FROM OLD.reporter_id OR NEW.track_hash IS DISTINCT FROM OLD.track_hash THEN
        RAISE EXCEPTION 'qm_incidents: ავტორის რეჟიმი / ავტორი არ იცვლება';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_qm_incidents_identity BEFORE UPDATE ON qm_incidents FOR EACH ROW EXECUTE FUNCTION qm_incidents_identity_trg();

-- მონაწილეები (ჩანს მხოლოდ quality-სთან; ანგარიშებში პირის მიხედვით რეიტინგი არ კეთდება)
CREATE TABLE qm_incident_people (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_id  UUID NOT NULL REFERENCES qm_incidents(id) ON DELETE CASCADE,
    role         VARCHAR(10) NOT NULL CHECK (role IN ('involved', 'witness', 'affected')),
    user_id      UUID REFERENCES users(id),
    name_text    TEXT,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (user_id IS NOT NULL OR length(trim(coalesce(name_text, ''))) >= 2)
);
CREATE INDEX idx_qm_people_incident ON qm_incident_people (incident_id);

-- ფაილები (ფოტო / დოკუმენტი) — ფაილსაცავში qm/<incident>/<id>.<ext>
CREATE TABLE qm_incident_files (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_id    UUID NOT NULL REFERENCES qm_incidents(id) ON DELETE CASCADE,
    file_path      TEXT NOT NULL,
    mime_type      VARCHAR(40) NOT NULL,
    size_bytes     INT NOT NULL,
    sha256         CHAR(64) NOT NULL,
    original_name  TEXT,
    uploaded_by    UUID REFERENCES users(id),                                  -- NULL — ანონიმური ავტორი
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_qm_files_incident ON qm_incident_files (incident_id);

-- ქრონოლოგია: შეტყობინება, რედაქტირება, კომენტარი, ტრიაჟი, უარყოფა, … (user_id NULL — ანონიმური ავტორი / სისტემა)
CREATE TABLE qm_incident_events (
    id           BIGSERIAL PRIMARY KEY,
    incident_id  UUID NOT NULL REFERENCES qm_incidents(id) ON DELETE CASCADE,
    at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id      UUID REFERENCES users(id),
    kind         VARCHAR(20) NOT NULL,
    text         TEXT,
    data         JSONB,
    internal     BOOLEAN NOT NULL DEFAULT FALSE                               -- TRUE — მხოლოდ quality (არა განყოფილება)
);
CREATE INDEX idx_qm_events_incident ON qm_incident_events (incident_id, at);

-- შეთავაზებები (event_prompts): MAR-ის გაფრთხილების გადალახვა / გამოტოვებული დოზა, საოპერაციო დათვლის შეუსაბამობა —
--   მომხმარებელმა „არ არის ინციდენტი“ → აღარ შესთავაზდება
CREATE TABLE qm_prompt_dismissals (
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type  VARCHAR(16) NOT NULL,
    source_id    UUID NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, source_type, source_id)
);
