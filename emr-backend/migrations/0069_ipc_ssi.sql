-- 0069_ipc_ssi.sql
-- ინფექციის კონტროლი, ეტაპი 3 — ოპერაციის ადგილის ინფექცია (SSI) (ბლოკი D, მოდული 2).
--
--  • ჭრილობის კლასი (CDC I–IV) ოპერაციის ოქმში (or_op_notes.wound_class); სავალდებულოობა — wound_class_mode (optional / required / off);
--      IPC-ს შეუძლია შეასწოროს ზედამხედველობის ჩანაწერში (მიზეზით) — ოქმი არ იცვლება.
--  • SSI კატეგორიები (ipc_ssi_categories, ECDC HAI-Net SSI): დაკვირვების დღე (30; იმპლანტით — 90), T-წერტილი (წთ), NCSP პრეფიქსები (შეთავაზებისთვის);
--      ოპერაციების ცნობარი → კატეგორია (or_procedures.ssi_category); ზედამხედველობა — აქტიურ კატეგორიებზე.
--  • ზედამხედველობის ჩანაწერი (ipc_ssi_ops) — დასრულებულ ოპერაციაზე (worker / „გადათვლა“): დრო, ხანგრძლივობა, ASA, კლასი, იმპლანტი,
--      NNIS რისკის ინდექსი (0–3), ანტიბიოტიკური პროფილაქტიკის დრო, დაკვირვების ვადა, სტატუსი (აქტიური / დასრულებული / SSI / გამორიცხული).
--  • გაწერის შემდგომი კონტაქტი (ipc_ssi_followups): IPC-ის სამუშაო სია ვადის ბოლოს — ზარი + კითხვარი; SMS შეხსენება (სურვილისამებრ).
--  • სიგნალი ssi_postop: დაკვირვების პერიოდში — ხელახალი ჰოსპიტალიზაცია / ჭრილობის ინფექციის დიაგნოზი / დადებითი ჭრილობის კულტურა.
--  • HAI შემთხვევა (SSI): ოპერაციასთან მიბმა (or_case_id), დღე ოპერაციიდან, მიკუთვნება — ქირურგიული განყოფილება (attribution = operation).

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"wound_class_mode": "optional",
                    "ssi_surveillance": true,
                    "ssi_pd_calls": true,
                    "ssi_pd_attempts": 3,
                    "ssi_pd_sms": false,
                    "sig_ssi_postop": true,
                    "prophylaxis_window_min": 60}'::jsonb || settings
 WHERE code = 'ipc';

-- ================================================================ 1. SSI კატეგორიები
CREATE TABLE ipc_ssi_categories (
    code                   VARCHAR(10) PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,9}$'),
    name                   TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    followup_days          SMALLINT NOT NULL DEFAULT 30 CHECK (followup_days BETWEEN 7 AND 365),
    implant_followup_days  SMALLINT CHECK (implant_followup_days BETWEEN 7 AND 365),      -- იმპლანტით (ოქმის „იმპლანტები“) — 90
    t_point_min            SMALLINT CHECK (t_point_min BETWEEN 10 AND 1440),              -- ხანგრძლივობის 75-ე პერცენტილი (NNIS)
    ncsp_prefixes          TEXT[] NOT NULL DEFAULT '{}',                                  -- შეთავაზება ცნობარში (IPC ადასტურებს)
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,                                 -- ზედამხედველობა ამ კატეგორიაზე
    sort_order             INT NOT NULL DEFAULT 0,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_ipc_ssi_categories_updated BEFORE UPDATE ON ipc_ssi_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO ipc_ssi_categories (code, name, followup_days, implant_followup_days, t_point_min, ncsp_prefixes, sort_order) VALUES
  ('CABG', 'კორონარული შუნტირება (CABG)',                 30, 90,  300, '{FNA,FNB,FNC,FND,FNE}', 10),
  ('CHOL', 'ქოლეცისტექტომია',                              30, NULL, 120, '{JKA2}',                20),
  ('COLO', 'მსხვილი ნაწლავის ოპერაცია',                    30, NULL, 180, '{JFB,JFH}',             30),
  ('CSEC', 'საკეისრო კვეთა',                               30, NULL,  60, '{MCA}',                 40),
  ('HPRO', 'მენჯ-ბარძაყის სახსრის ენდოპროთეზირება',        90, NULL, 120, '{NFB,NFC}',             50),
  ('KPRO', 'მუხლის სახსრის ენდოპროთეზირება',               90, NULL, 120, '{NGB,NGC}',             60),
  ('LAM',  'ლამინექტომია / ხერხემლის დეკომპრესია',        30, 90,  120, '{ABC,ABD}',             70);

ALTER TABLE or_procedures ADD COLUMN ssi_category VARCHAR(10) REFERENCES ipc_ssi_categories(code);
CREATE INDEX idx_or_procedures_ssi ON or_procedures (ssi_category) WHERE ssi_category IS NOT NULL;

-- ================================================================ 2. ჭრილობის კლასი (ოქმი)
ALTER TABLE or_op_notes ADD COLUMN wound_class SMALLINT CHECK (wound_class BETWEEN 1 AND 4);   -- I სუფთა, II პირობით სუფთა, III დაბინძურებული, IV ჩირქოვანი

-- ================================================================ 3. ზედამხედველობის ჩანაწერი (ოპერაცია)
CREATE TABLE ipc_ssi_ops (
    case_id            UUID PRIMARY KEY REFERENCES or_cases(id),
    patient_id         UUID NOT NULL REFERENCES patients(id),
    encounter_id       UUID REFERENCES inpatient_stays(encounter_id),
    department_id      UUID NOT NULL REFERENCES departments(id),                         -- ქირურგიული განყოფილება (მიკუთვნება)
    category           VARCHAR(10) NOT NULL REFERENCES ipc_ssi_categories(code),
    category_manual    BOOLEAN NOT NULL DEFAULT FALSE,                                   -- IPC-მ შეცვალა (გადათვლა არ ცვლის)
    op_at              TIMESTAMPTZ NOT NULL,                                             -- განაკვეთი (ან ოთახში შესვლა)
    op_date            DATE NOT NULL,
    duration_min       INT,                                                              -- განაკვეთი → ნაკერი
    asa                SMALLINT,
    emergency          BOOLEAN NOT NULL DEFAULT FALSE,
    wound_class        SMALLINT CHECK (wound_class BETWEEN 1 AND 4),                     -- ოქმიდან
    wound_class_ipc    SMALLINT CHECK (wound_class_ipc BETWEEN 1 AND 4),                 -- IPC-ის შესწორება
    wound_class_note   TEXT,
    implant            BOOLEAN NOT NULL DEFAULT FALSE,
    risk_index         SMALLINT CHECK (risk_index BETWEEN 0 AND 3),                      -- NNIS; NULL — მონაცემი აკლია
    prophylaxis        VARCHAR(8) NOT NULL DEFAULT 'unknown' CHECK (prophylaxis IN ('timely', 'early', 'late', 'none', 'unknown')),
    prophylaxis_at     TIMESTAMPTZ,
    prophylaxis_drug   TEXT,
    followup_days      SMALLINT NOT NULL,
    followup_until     DATE NOT NULL,
    discharged_at      TIMESTAMPTZ,
    status             VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'ssi', 'excluded')),
    excluded_reason    TEXT,
    ssi_case_id        UUID REFERENCES ipc_hai_cases(id),
    computed_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_ssi_excluded CHECK (status <> 'excluded' OR length(btrim(coalesce(excluded_reason, ''))) >= 3),
    CONSTRAINT chk_ssi_wc_note CHECK (wound_class_ipc IS NULL OR length(btrim(coalesce(wound_class_note, ''))) >= 3),
    CONSTRAINT chk_ssi_case CHECK ((status = 'ssi') = (ssi_case_id IS NOT NULL))
);
CREATE INDEX idx_ipc_ssi_ops_date ON ipc_ssi_ops (op_date, category);
CREATE INDEX idx_ipc_ssi_ops_patient ON ipc_ssi_ops (patient_id, op_date);
CREATE INDEX idx_ipc_ssi_ops_status ON ipc_ssi_ops (status, followup_until);

-- ================================================================ 4. გაწერის შემდგომი კონტაქტი
CREATE TABLE ipc_ssi_followups (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id          UUID NOT NULL UNIQUE REFERENCES ipc_ssi_ops(case_id),
    due_date         DATE NOT NULL,
    status           VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'unreachable', 'cancelled')),
    attempts         SMALLINT NOT NULL DEFAULT 0,
    last_attempt_at  TIMESTAMPTZ,
    outcome          VARCHAR(12) CHECK (outcome IN ('no_infection', 'suspected')),
    answers          JSONB NOT NULL DEFAULT '{}',
    note             TEXT,
    contacted_by     UUID REFERENCES users(id),
    contacted_at     TIMESTAMPTZ,
    hai_case_id      UUID REFERENCES ipc_hai_cases(id),
    cancel_reason    TEXT,
    sms_sent_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_ssi_fu_done CHECK ((status = 'done') = (outcome IS NOT NULL)),
    CONSTRAINT chk_ssi_fu_cancel CHECK (status <> 'cancelled' OR length(btrim(coalesce(cancel_reason, ''))) >= 3)
);
CREATE INDEX idx_ipc_ssi_fu_due ON ipc_ssi_followups (status, due_date);

-- ================================================================ 5. HAI შემთხვევა ↔ ოპერაცია; სიგნალი ssi_postop
ALTER TABLE ipc_hai_cases ADD COLUMN or_case_id UUID REFERENCES or_cases(id),
    ADD COLUMN post_discharge BOOLEAN NOT NULL DEFAULT FALSE;                                    -- გამოვლინდა გაწერის შემდეგ
ALTER TABLE ipc_hai_cases DROP CONSTRAINT ipc_hai_cases_attribution_check;
ALTER TABLE ipc_hai_cases ADD CONSTRAINT ipc_hai_cases_attribution_check CHECK (attribution IN ('current', 'transfer', 'readmission', 'manual', 'operation'));
ALTER TABLE ipc_hai_cases ADD CONSTRAINT chk_hai_or_case CHECK (hai_type = 'ssi' OR or_case_id IS NULL);
CREATE INDEX idx_ipc_hai_or_case ON ipc_hai_cases (or_case_id) WHERE or_case_id IS NOT NULL;

ALTER TABLE ipc_signals DROP CONSTRAINT ipc_signals_kind_check;
ALTER TABLE ipc_signals ADD CONSTRAINT ipc_signals_kind_check CHECK (kind IN ('blood_culture', 'hospital_culture', 'fever_device', 'antibiotic_start', 'cluster', 'ssi_postop'));

-- ================================================================ 6. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON ipc_ssi_categories, ipc_ssi_ops, ipc_ssi_followups FROM emr_app;
  END IF;
END $$;
