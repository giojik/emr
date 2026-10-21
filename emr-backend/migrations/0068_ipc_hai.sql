-- 0068_ipc_hai.sql
-- ინფექციის კონტროლი, ეტაპი 2 — სიგნალები, HAI რეესტრი, device-days (ბლოკი D, მოდული 2).
--
--  • ნიმუშის ტიპები (dx_services.specimen_type): + ნახველი, BAL / ტრაქეალური ასპირატი, ჭრილობა, ლიქვორი, კათეტერის წვერი, ქსოვილი, პუნქტატი.
--  • მიკროორგანიზმი — „კომენსალი“ (კანის ფლორა): ჰემოკულტურაში სიგნალი მხოლოდ 2 დამოუკიდებელ ნიმუშზე (commensal_window_hours).
--  • ხაზები: + „დიალიზის კათეტერი“ (ცენტრალური ხაზი); რომელი ტიპები ითვლება ცენტრალურად — პარამეტრი.
--  • სიგნალები (ipc_signals, worker / „შემოწმება“): ჰემოკულტურა, ჰოსპიტალური დადებითი კულტურა, ცხელება მოწყობილობით / ოპერაციის შემდეგ,
--      ანტიბიოტიკის დაწყება ≥ hospital_onset_day, კლასტერი (განყოფილება × მიკროორგანიზმი). მხოლოდ შეთავაზება — შემთხვევა ავტომატურად არ იქმნება.
--  • HAI რეესტრი (ipc_hai_cases): ტიპი (ECDC HAI-Net: BSI / UTI / PN / SSI / CDI / სხვა), კრიტერიუმების ჩეკლისტი (ნაკრები — ვერსიებით),
--      მოწყობილობასთან კავშირი (ავტომატურად, IPC ცვლის მიზეზით), მიკუთვნება (განყოფილება ინფექციის დღეს; გადაყვანის წესი), ხელახალი ჰოსპიტალიზაცია,
--      სტატუსები ეჭვი → განხილვა → დადასტურებული / უარყოფილი; ქრონოლოგია; ხარისხის ინციდენტის წყარო (source_type = hai_case).
--  • device-days (rpt_fact_ipc_daily): დღე × განყოფილება — პაციენტ-დღე, ცენტრალური ხაზი, შარდის კათეტერი, ინვაზიური ვენტილაცია.

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"sig_blood_culture": true,
                    "sig_hospital_culture": true,
                    "sig_fever_device": true,
                    "sig_antibiotic_start": true,
                    "sig_cluster": true,
                    "fever_threshold": 38.0,
                    "commensal_window_hours": 48,
                    "cluster_count": 3,
                    "cluster_days": 14,
                    "signal_dedupe_days": 7,
                    "postop_fever_days": 30,
                    "hai_criteria_set": "ecdc",
                    "hai_transfer_days": 2,
                    "hai_readmit_days": 30,
                    "device_min_days": 3,
                    "device_days_basis": "calendar_day",
                    "census_hour": 0,
                    "central_line_kinds": ["cvc", "picc", "dialysis"]}'::jsonb || settings
 WHERE code = 'ipc';

-- ================================================================ 1. ნიმუშის ტიპები, კომენსალები, დიალიზის კათეტერი
ALTER TABLE dx_services DROP CONSTRAINT dx_services_specimen_type_check;
ALTER TABLE dx_services ADD CONSTRAINT dx_services_specimen_type_check CHECK (specimen_type IN (
    'blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'other',
    'sputum', 'bal', 'wound', 'csf', 'catheter_tip', 'tissue', 'fluid'));

ALTER TABLE micro_organisms ADD COLUMN is_commensal BOOLEAN NOT NULL DEFAULT FALSE;
INSERT INTO micro_organisms (code, name, gram, group_code) VALUES
  ('bac', 'Bacillus spp. (არა anthracis)', 'pos', 'GPR'),
  ('mic', 'Micrococcus spp.', 'pos', 'GPR'),
  ('cac', 'Cutibacterium acnes', 'pos', 'ANA')
ON CONFLICT (lower(code)) DO NOTHING;
UPDATE micro_organisms SET is_commensal = TRUE WHERE lower(code) IN ('sep', 'shl', 'scn', 'ssa', 'cor', 'svi', 'bac', 'mic', 'cac');

ALTER TABLE lines_drains DROP CONSTRAINT lines_drains_kind_check;
ALTER TABLE lines_drains ADD CONSTRAINT lines_drains_kind_check CHECK (kind IN ('pvc', 'cvc', 'picc', 'dialysis', 'arterial', 'urinary', 'ng_tube', 'drain', 'trach', 'other'));
UPDATE system_modules SET settings = jsonb_set(settings, '{line_alert_hours,dialysis}', '0'::jsonb, TRUE)
 WHERE code = 'inpatient' AND settings ? 'line_alert_hours' AND NOT (settings->'line_alert_hours' ? 'dialysis');

-- ================================================================ 2. HAI ტიპები და კრიტერიუმები
CREATE TABLE ipc_hai_types (
    code         VARCHAR(12) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,11}$'),
    name         TEXT NOT NULL CHECK (length(trim(name)) >= 2),
    short_name   VARCHAR(12) NOT NULL,
    device_kind  VARCHAR(12) CHECK (device_kind IN ('central_line', 'urinary', 'ventilator')),   -- CLABSI / CAUTI / VAP
    device_name  VARCHAR(12),                                                                    -- CLABSI, CAUTI, VAP
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0
);
INSERT INTO ipc_hai_types (code, name, short_name, device_kind, device_name, sort_order) VALUES
('bsi',   'სისხლის ნაკადის ინფექცია',              'BSI',   'central_line', 'CLABSI', 10),
('uti',   'საშარდე გზების ინფექცია',               'UTI',   'urinary',      'CAUTI',  20),
('pn',    'პნევმონია',                              'PN',    'ventilator',   'VAP',    30),
('ssi',   'ოპერაციის ადგილის ინფექცია',            'SSI',   NULL,           NULL,     40),
('cdi',   'C. difficile ინფექცია',                  'CDI',   NULL,           NULL,     50),
('other', 'სხვა ჰოსპიტალური ინფექცია',              'სხვა',  NULL,           NULL,     90);

CREATE TABLE ipc_criteria_sets (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(16) NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,15}$'),
    version     VARCHAR(20) NOT NULL,
    name        TEXT NOT NULL,
    note        TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (code, version)
);
CREATE TABLE ipc_criteria_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    set_id      UUID NOT NULL REFERENCES ipc_criteria_sets(id),
    hai_type    VARCHAR(12) NOT NULL REFERENCES ipc_hai_types(code),
    grp         VARCHAR(40),                  -- ქვეჯგუფი (მაგ. SSI-ის სიღრმე, PN-ის დონე)
    text        TEXT NOT NULL CHECK (length(trim(text)) >= 3),
    required    BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_ipc_criteria_items ON ipc_criteria_items (set_id, hai_type, sort_order);

-- seed: ECDC HAI-Net (მოკლე, პერიფრაზირებული ჩეკლისტი — სრული განმარტება ECDC-ის პროტოკოლშია; კლინიკამ შეიძლება შეცვალოს / ახალი ვერსია დაამატოს)
WITH s AS (INSERT INTO ipc_criteria_sets (code, version, name, note) VALUES
  ('ecdc', 'HAI-Net 6', 'ECDC HAI-Net (მოკლე ჩეკლისტი)', 'დამხმარე ჩეკლისტი — საბოლოო გადაწყვეტილებას იღებს ინფექციის კონტროლის ექიმი. დეტალები: ECDC-ის PPS / ICU პროტოკოლი.') RETURNING id)
INSERT INTO ipc_criteria_items (set_id, hai_type, grp, text, required, sort_order)
SELECT s.id, x.t, x.g, x.txt, x.req, x.o FROM s, (VALUES
  ('bsi', NULL, 'აღიარებული პათოგენი — მინიმუმ ერთ ჰემოკულტურაში', FALSE, 10),
  ('bsi', NULL, 'ან: კანის ფლორის (კომენსალის) ერთი და იგივე მიკროორგანიზმი ორ ცალკე ჰემოკულტურაში 48 სთ-ში + ცხელება > 38 °C, შემცივნება ან ჰიპოტენზია', FALSE, 20),
  ('bsi', NULL, 'წყარო: კათეტერი (CRI) / სხვა ადგილის ინფექცია (მეორადი) / უცნობი — მითითებულია', TRUE, 30),
  ('uti', NULL, 'სიმპტომი: ცხელება > 38 °C, ხშირი / მტკივნეული შარდვა, სუპრაპუბური მტკივნეულობა', TRUE, 10),
  ('uti', NULL, 'შარდის კულტურა ≥ 10^5 CFU/მლ, არაუმეტეს ორი სახეობის', FALSE, 20),
  ('uti', NULL, 'ან: დაბალი რაოდენობა (≥ 10^3) + პიურია / დადებითი ნიტრიტები (მიკრობიოლოგიურად დაუდასტურებელი)', FALSE, 30),
  ('pn',  NULL, 'გულმკერდის რენტგენი / CT: ახალი ან პროგრესირებადი ინფილტრატი (გულ-ფილტვის ფონური დაავადებისას — ორი გამოსახულება)', TRUE, 10),
  ('pn',  NULL, 'ცხელება > 38 °C (სხვა მიზეზის გარეშე) ან ლეიკოციტოზი / ლეიკოპენია', TRUE, 20),
  ('pn',  NULL, 'ახალი ან გაძლიერებული ჩირქოვანი ნახველი / სეკრეცია, ხველა, დისპნოე, ჟანგბადის საჭიროების ზრდა (მინ. ერთი)', TRUE, 30),
  ('pn',  'PN1–PN3', 'მიკრობიოლოგია: რაოდენობრივი კულტურა მინიმალურად კონტამინირებული ნიმუშიდან (BAL, დაცული ჯაგრისი) / ენდოტრაქეალური ასპირატი / ჰემოკულტურა', FALSE, 40),
  ('pn',  'PN4–PN5', 'მიკრობიოლოგიის გარეშე: ნახველის კულტურა ან მხოლოდ კლინიკური კრიტერიუმები', FALSE, 50),
  ('ssi', NULL, 'ოპერაციიდან 30 დღეში (იმპლანტით — 90 დღე)', TRUE, 10),
  ('ssi', 'ზედაპირული', 'კანი / კანქვეშა: ჩირქი, დადებითი კულტურა ან ქირურგმა ჭრილობა გახსნა + ტკივილი / შეშუპება / სიწითლე', FALSE, 20),
  ('ssi', 'ღრმა', 'ფასცია / კუნთი: ჩირქი, სპონტანური დეჰისცენცია ან გახსნა + ცხელება / ტკივილი, აბსცესი', FALSE, 30),
  ('ssi', 'ორგანო / სივრცე', 'ჩირქი დრენაჟიდან, დადებითი კულტურა ორგანოდან / სივრციდან ან აბსცესი (გასინჯვა / ვიზუალიზაცია)', FALSE, 40),
  ('cdi', NULL, 'დიარეა (≥ 3 თხიერი განავალი 24 სთ-ში) ან ტოქსიკური მეგაკოლონი', TRUE, 10),
  ('cdi', NULL, 'ტოქსინის A / B ან ტოქსიგენური შტამის დადასტურება განავალში', FALSE, 20),
  ('cdi', NULL, 'ან: ფსევდომემბრანული კოლიტი (ენდოსკოპია / ჰისტოლოგია)', FALSE, 30),
  ('other', NULL, 'ლოკალიზაცია და კრიტერიუმები — აღწერეთ შემთხვევის ბარათში', TRUE, 10)
) AS x(t, g, txt, req, o);

-- ================================================================ 3. სიგნალები
CREATE TABLE ipc_signals (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind           VARCHAR(20) NOT NULL CHECK (kind IN ('blood_culture', 'hospital_culture', 'fever_device', 'antibiotic_start', 'cluster')),
    ref_key        TEXT NOT NULL,                              -- დუბლირების გასაღები (მაგ. dx:<item>, vital:<id>, order:<id>, cluster:<dept>:<org>:<დღე>)
    patient_id     UUID REFERENCES patients(id),               -- კლასტერი — NULL
    encounter_id   UUID REFERENCES encounters(id),
    department_id  UUID REFERENCES departments(id),
    organism_id    UUID REFERENCES micro_organisms(id),
    order_item_id  UUID REFERENCES dx_order_items(id),
    summary        TEXT NOT NULL,
    data           JSONB NOT NULL DEFAULT '{}',
    event_at       TIMESTAMPTZ NOT NULL,                       -- ნიმუშის / გაზომვის / დანიშნულების დრო
    detected_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status         VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'watch', 'dismissed', 'case')),
    watch_until    TIMESTAMPTZ,
    handled_by     UUID REFERENCES users(id),
    handled_at     TIMESTAMPTZ,
    dismiss_reason TEXT,
    case_id        UUID,
    CONSTRAINT chk_sig_dismiss CHECK (status <> 'dismissed' OR length(btrim(coalesce(dismiss_reason, ''))) >= 3),
    CONSTRAINT chk_sig_watch CHECK (status <> 'watch' OR watch_until IS NOT NULL),
    CONSTRAINT chk_sig_patient CHECK (kind = 'cluster' OR patient_id IS NOT NULL),
    UNIQUE (kind, ref_key)
);
CREATE INDEX idx_ipc_signals_status ON ipc_signals (status, detected_at DESC);
CREATE INDEX idx_ipc_signals_patient ON ipc_signals (patient_id, kind, detected_at DESC);

-- ================================================================ 4. HAI შემთხვევები
CREATE TABLE ipc_hai_cases (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_no            VARCHAR(16) NOT NULL UNIQUE,                         -- HAI26-000001
    patient_id         UUID NOT NULL REFERENCES patients(id),
    encounter_id       UUID REFERENCES inpatient_stays(encounter_id),       -- ჰოსპიტალიზაცია, რომელსაც მიეკუთვნება
    hai_type           VARCHAR(12) NOT NULL REFERENCES ipc_hai_types(code),
    ssi_depth          VARCHAR(12) CHECK (ssi_depth IN ('superficial', 'deep', 'organ')),
    status             VARCHAR(10) NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected', 'review', 'confirmed', 'rejected')),
    onset_date         DATE NOT NULL,                                       -- ინფექციის დღე (პირველი სიმპტომი / ნიმუში)
    onset_day          INT,                                                 -- ჰოსპიტალიზაციის დღე (მიღება = 1)
    department_id      UUID REFERENCES departments(id),                     -- მიკუთვნებული განყოფილება
    attribution        VARCHAR(12) NOT NULL DEFAULT 'current' CHECK (attribution IN ('current', 'transfer', 'readmission', 'manual')),
    attribution_note   TEXT,
    readmission        BOOLEAN NOT NULL DEFAULT FALSE,                      -- წინა ჰოსპიტალიზაციიდან hai_readmit_days-ში დაბრუნება
    device_kind        VARCHAR(12) CHECK (device_kind IN ('central_line', 'urinary', 'ventilator')),
    device_assoc       BOOLEAN NOT NULL DEFAULT FALSE,                      -- CLABSI / CAUTI / VAP
    device_days        INT,                                                 -- მოწყობილობის დღე ინფექციის დღეს
    device_override    BOOLEAN NOT NULL DEFAULT FALSE,
    device_note        TEXT,
    criteria_set_id    UUID REFERENCES ipc_criteria_sets(id),
    criteria_met       UUID[] NOT NULL DEFAULT '{}',
    organism_ids       UUID[] NOT NULL DEFAULT '{}',
    order_item_ids     UUID[] NOT NULL DEFAULT '{}',
    bsi_source         VARCHAR(12) CHECK (bsi_source IN ('catheter', 'secondary', 'unknown')),
    description        TEXT,
    outcome            VARCHAR(12) CHECK (outcome IN ('recovered', 'transferred', 'died', 'ongoing')),
    hai_contributed    VARCHAR(8) CHECK (hai_contributed IN ('yes', 'no', 'unknown')),
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_by       UUID REFERENCES users(id),
    confirmed_at       TIMESTAMPTZ,
    rejected_reason    TEXT,
    CONSTRAINT chk_hai_confirm CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL) AND (confirmed_at IS NULL) = (confirmed_by IS NULL)),
    CONSTRAINT chk_hai_reject CHECK (status <> 'rejected' OR length(btrim(coalesce(rejected_reason, ''))) >= 3),
    CONSTRAINT chk_hai_ssi CHECK (hai_type = 'ssi' OR ssi_depth IS NULL),
    CONSTRAINT chk_hai_device_note CHECK (NOT device_override OR length(btrim(coalesce(device_note, ''))) >= 3)
);
CREATE INDEX idx_ipc_hai_patient ON ipc_hai_cases (patient_id);
CREATE INDEX idx_ipc_hai_status ON ipc_hai_cases (status, onset_date DESC);
CREATE INDEX idx_ipc_hai_dept ON ipc_hai_cases (department_id, onset_date);
CREATE TRIGGER trg_ipc_hai_updated BEFORE UPDATE ON ipc_hai_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE ipc_signals ADD CONSTRAINT fk_ipc_signal_case FOREIGN KEY (case_id) REFERENCES ipc_hai_cases(id);

CREATE TABLE ipc_hai_events (
    id        BIGSERIAL PRIMARY KEY,
    case_id   UUID NOT NULL REFERENCES ipc_hai_cases(id),
    at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id   UUID REFERENCES users(id),
    kind      VARCHAR(20) NOT NULL,
    text      TEXT,
    data      JSONB
);
CREATE INDEX idx_ipc_hai_events ON ipc_hai_events (case_id, at);

-- ხარისხის ინციდენტის წყარო: HAI შემთხვევა („ხარისხს გადაცემა“)
ALTER TABLE qm_incidents DROP CONSTRAINT qm_incidents_source_type_check;
ALTER TABLE qm_incidents ADD CONSTRAINT qm_incidents_source_type_check CHECK (source_type IN (
    'encounter', 'stay', 'med_order', 'mar_entry', 'or_case', 'dx_order_item', 'lab_specimen', 'asset', 'dx_device', 'hai_case'));

-- ================================================================ 5. device-days (დღე × განყოფილება)
CREATE TABLE rpt_fact_ipc_daily (
    day              DATE NOT NULL,
    department_id    UUID NOT NULL REFERENCES departments(id),
    patient_days     INT NOT NULL DEFAULT 0,
    central_line_days INT NOT NULL DEFAULT 0,
    urinary_days     INT NOT NULL DEFAULT 0,
    vent_days        INT NOT NULL DEFAULT 0,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (day, department_id)
);

-- ================================================================ 6. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON ipc_signals, ipc_hai_cases, ipc_hai_events, ipc_hai_types, ipc_criteria_sets, ipc_criteria_items FROM emr_app;
    REVOKE TRUNCATE ON rpt_fact_ipc_daily FROM emr_app;
  END IF;
END $$;
