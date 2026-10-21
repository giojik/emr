-- 0073_bme_registry.sql
-- ბიომედ-აპარატურა, ეტაპი 1 — აპარატის პასპორტი, სტატუსი და მისი ასახვა დაგეგმვაზე (ბლოკი D, მოდული 3).
--
--  • მოდული `bme` (ჩართვადი) + უფლებები: med_engineer (სრული — უკვე არსებობს), bme_dept (თავისი განყოფილებ(ებ)ის აპარატები, გადაადგილების მიღება),
--      bme_view (მთელი რეესტრის ნახვა). 39 → 41. შაბლონ-როლი „სამედიცინო ინჟინერი“ (med_engineer + reports_all) — რედაქტირებადი.
--  • აპარატის ტიპები (bme_device_types): ჯგუფი, ნაგულისხმევი კრიტიკულობა / რისკის კლასი, PM / კალიბრაციის / ელ. უსაფრთხოების ინტერვალი (თვე — 0074-ის გეგმები).
--  • პასპორტი (bme_devices) — ერთიანი რეესტრი; ოპერაციული ცხრილები (dx_devices, lab_methods, cssd_machines, endo_scopes) უცვლელია,
--      პასპორტი მათ 1:1 მიებმება (მაქს. ერთი ბმა). ბუღალტრული ინვენტარი (assets) — არჩევითი ბმა.
--      მდებარეობა: განყოფილება + ოთახი (+ საოპერაციო ოთახი); გადაადგილება — პირდაპირ ან მიმღების დადასტურებით (პარამეტრი).
--  • სტატუსი: operational / restricted / down / standby / retired; ყოველი ცვლილება — მიზეზით, პერიოდებად (bme_status_periods → downtime 0076-ში).
--      ასახვა: რადიოლოგიის / ენდოსკოპიის ჩაწერა, ენდოსკოპის არჩევა, CSSD ციკლი — block / warn / off (პარამეტრი); ლაბ. და საოპერაციო — warn / off.
--  • დოკუმენტები (bme_documents): ინსტრუქცია, სერტიფიკატი, ლიცენზია, აქტი, გარანტია… — PDF / JPG / PNG, ვადით; მოხსნა — მიზეზით (ფაილი რჩება).
--  • backfill: არსებული აპარატებიდან ავტომატურად იქმნება პასპორტები (needs_review — „შესავსები“).

-- ================================================================ 0. მოდული, უფლებები, როლი
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('bme', 'ბიომედ-აპარატურა', 'სამედიცინო აპარატების რეესტრი (პასპორტი), სტატუსი და მისი ასახვა დაგეგმვაზე, გადაადგილება, დოკუმენტები, QR ეტიკეტი; PM / კალიბრაცია, შეკეთება, კონტრაქტები, ანგარიშები — შემდეგი ეტაპები',
 TRUE, TRUE,
 '{"inv_prefix": "BME",
   "inv_year": false,
   "inv_digits": 5,
   "require_department": true,
   "move_mode": "direct",
   "area_radiology": "block",
   "area_endoscopy": "block",
   "area_scopes": "block",
   "area_cssd": "block",
   "area_lab": "warn",
   "area_or": "warn",
   "or_alert_criticality": "high",
   "label_size": "50x25",
   "label_code": "qr"}', 48)
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
        'quality', 'quality_dept', 'quality_view',
        'infection', 'infection_dept', 'infection_view',
        'bme_dept', 'bme_view']::VARCHAR(30)[]);

INSERT INTO roles (code, name, description, is_system, capabilities, sort_order)
SELECT 'biomed_engineer', 'სამედიცინო ინჟინერი', 'ბიომედ-აპარატურის რეესტრი: პასპორტი, სტატუსი, გადაადგილება, დოკუმენტები, ეტიკეტები; რადიოლოგიის / ენდოსკოპიის აპარატები; მენეჯერული დაფა (მთელი კლინიკა)', FALSE,
       '{med_engineer,reports_all}', coalesce((SELECT max(sort_order) FROM roles), 0) + 10
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'biomed_engineer');

-- ================================================================ 1. აპარატის ტიპები
CREATE TABLE bme_device_types (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                 VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name                 TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    grp                  VARCHAR(16) NOT NULL CHECK (grp IN ('imaging', 'life_support', 'monitoring', 'therapy', 'surgical', 'lab', 'sterilization', 'endoscopy', 'measuring', 'other')),
    default_criticality  VARCHAR(12) NOT NULL DEFAULT 'medium' CHECK (default_criticality IN ('life_support', 'high', 'medium', 'low')),
    default_risk_class   VARCHAR(4) CHECK (default_risk_class IN ('I', 'IIa', 'IIb', 'III')),
    pm_months            SMALLINT CHECK (pm_months BETWEEN 1 AND 120),             -- გეგმიური მომსახურება (0074)
    calibration_months   SMALLINT CHECK (calibration_months BETWEEN 1 AND 120),    -- კალიბრაცია / მეტროლოგიური დამოწმება (0074)
    safety_months        SMALLINT CHECK (safety_months BETWEEN 1 AND 120),         -- ელ. უსაფრთხოების ტესტი, IEC 62353 (0074)
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order           INT NOT NULL DEFAULT 100,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO bme_device_types (code, name, grp, default_criticality, default_risk_class, pm_months, calibration_months, safety_months, sort_order) VALUES
-- სიცოცხლის შემანარჩუნებელი
('VENTILATOR',     'ხელოვნური სუნთქვის აპარატი (ვენტილატორი)', 'life_support', 'life_support', 'IIb',  6, 12, 12, 10),
('ANESTHESIA',     'ანესთეზიის აპარატი',                       'life_support', 'life_support', 'IIb',  6, 12, 12, 20),
('DEFIBRILLATOR',  'დეფიბრილატორი',                            'life_support', 'life_support', 'IIb',  6, 12, 12, 30),
('INCUBATOR',      'ახალშობილის ინკუბატორი',                  'life_support', 'life_support', 'IIb',  6, 12, 12, 40),
('DIALYSIS',       'დიალიზის აპარატი',                         'life_support', 'life_support', 'IIb',  6, 12, 12, 50),
-- მონიტორინგი
('PATIENT_MONITOR','პაციენტის მონიტორი',                       'monitoring',   'high',         'IIb', 12, 12, 12, 60),
('ECG',            'ელექტროკარდიოგრაფი (ECG)',                 'monitoring',   'medium',       'IIa', 12, 12, 12, 70),
('PULSE_OXIMETER', 'პულსოქსიმეტრი',                            'monitoring',   'medium',       'IIb', 12, 12, NULL, 80),
('CTG',            'კარდიოტოკოგრაფი (CTG)',                    'monitoring',   'high',         'IIb', 12, 12, 12, 90),
-- თერაპია
('INFUSION_PUMP',  'ინფუზომატი (მოცულობითი ტუმბო)',            'therapy',      'high',         'IIb', 12, 12, 12, 100),
('SYRINGE_PUMP',   'შპრიცის ტუმბო (პერფუზორი)',               'therapy',      'high',         'IIb', 12, 12, 12, 110),
('SUCTION',        'ასპირატორი (ვაკუუმ-ექსტრაქტორი)',          'therapy',      'medium',       'IIa', 12, NULL, 12, 120),
('O2_CONCENTRATOR','ჟანგბადის კონცენტრატორი',                  'therapy',      'high',         'IIa', 12, NULL, 12, 130),
('INFANT_WARMER',  'ახალშობილის გამათბობელი',                  'therapy',      'high',         'IIb', 12, 12, 12, 140),
-- ქირურგია
('ESU',            'ელექტროქირურგიული ბლოკი (კოაგულატორი)',    'surgical',     'high',         'IIb', 12, 12, 12, 150),
('OR_TABLE',       'საოპერაციო მაგიდა',                        'surgical',     'medium',       'I',   12, NULL, 12, 160),
('SURGICAL_LIGHT', 'საოპერაციო სანათი',                        'surgical',     'medium',       'I',   12, NULL, 12, 170),
-- გამოსახულება
('CT',             'კომპიუტერული ტომოგრაფი (CT)',               'imaging',      'high',         'IIb',  3, 12, 12, 200),
('MRI',            'მაგნიტურ-რეზონანსული ტომოგრაფი (MRI)',      'imaging',      'high',         'IIa',  3, 12, 12, 210),
('XRAY',           'რენტგენის აპარატი (სტაციონარული)',         'imaging',      'high',         'IIb',  6, 12, 12, 220),
('XRAY_MOBILE',    'მობილური რენტგენი',                        'imaging',      'medium',       'IIb',  6, 12, 12, 230),
('FLUORO',         'რენტგენოსკოპია / C-რკალი',                 'imaging',      'high',         'IIb',  6, 12, 12, 240),
('MAMMO',          'მამოგრაფი',                                'imaging',      'medium',       'IIb',  6, 12, 12, 250),
('US',             'ულტრაბგერითი აპარატი (ექოსკოპი)',          'imaging',      'medium',       'IIa', 12, NULL, 12, 260),
('DXA',            'დენსიტომეტრი (DXA)',                       'imaging',      'low',          'IIb', 12, 12, 12, 270),
-- ენდოსკოპია
('ENDO_TOWER',     'ენდოსკოპიური სისტემა (ვიდეოპროცესორი / სვეტი)', 'endoscopy', 'high',        'IIa', 12, NULL, 12, 300),
('ENDOSCOPE',      'ენდოსკოპი (მოქნილი)',                      'endoscopy',    'high',         'IIa', 12, NULL, NULL, 310),
-- ლაბორატორია
('LAB_ANALYZER',   'ლაბორატორიული ანალიზატორი',                'lab',          'high',         NULL,   6, NULL, 12, 400),
('CENTRIFUGE',     'ცენტრიფუგა',                               'lab',          'low',          NULL,  12, 12, 12, 410),
('MICROSCOPE',     'მიკროსკოპი',                               'lab',          'low',          NULL,  12, NULL, NULL, 420),
('MED_FRIDGE',     'სამედიცინო მაცივარი (ვაქცინა / სისხლი / რეაქტივი)', 'lab',  'high',         NULL,  12, 12, 12, 430),
-- სტერილიზაცია
('STERILIZER',     'სტერილიზატორი (ავტოკლავი / პლაზმური)',     'sterilization','high',         'IIb',  6, 12, 12, 500),
('WASHER_DIS',     'სარეცხ-სადეზინფექციო მანქანა',             'sterilization','medium',       'IIb',  6, 12, 12, 510),
-- საზომი (მეტროლოგია)
('SCALE',          'სამედიცინო სასწორი',                       'measuring',    'low',          'I',   NULL, 12, NULL, 600),
('BP_METER',       'წნევის საზომი (ტონომეტრი)',                 'measuring',    'low',          'IIa', NULL, 12, NULL, 610),
('THERMOMETER',    'თერმომეტრი (ელექტრონული)',                 'measuring',    'low',          'IIa', NULL, 12, NULL, 620),
('OTHER',          'სხვა სამედიცინო აპარატი',                  'other',        'medium',       NULL,  12, NULL, NULL, 900);

-- ================================================================ 2. პასპორტი
CREATE TABLE bme_devices (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inv_no               VARCHAR(40) NOT NULL UNIQUE,
    name                 TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    type_id              UUID NOT NULL REFERENCES bme_device_types(id),
    manufacturer         VARCHAR(120),
    model                VARCHAR(120),
    serial_no            VARCHAR(120),
    gmdn_code            VARCHAR(20),
    risk_class           VARCHAR(4) CHECK (risk_class IN ('I', 'IIa', 'IIb', 'III')),
    criticality          VARCHAR(12) NOT NULL DEFAULT 'medium' CHECK (criticality IN ('life_support', 'high', 'medium', 'low')),
    -- მდებარეობა (იცვლება მხოლოდ გადაადგილებით)
    department_id        UUID REFERENCES departments(id),
    room                 VARCHAR(60),
    or_room_id           UUID REFERENCES or_rooms(id),
    responsible_user_id  UUID REFERENCES users(id),
    -- სტატუსი (იცვლება მხოლოდ სტატუსის ცვლილებით → bme_status_periods)
    status               VARCHAR(12) NOT NULL DEFAULT 'operational' CHECK (status IN ('operational', 'restricted', 'down', 'standby', 'retired')),
    status_reason        TEXT,
    status_since         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- შეძენა / გარანტია
    manufacture_year     SMALLINT CHECK (manufacture_year BETWEEN 1950 AND 2100),
    install_date         DATE,                                                   -- ექსპლუატაციაში შეყვანა
    purchase_date        DATE,
    purchase_value       NUMERIC(14,2) CHECK (purchase_value >= 0),
    supplier_id          UUID REFERENCES stock_suppliers(id),
    warranty_until       DATE,
    -- ბმები (1:1): ბუღალტრული ინვენტარი + მაქს. ერთი ოპერაციული ჩანაწერი
    asset_id             UUID UNIQUE REFERENCES assets(id),
    dx_device_id         UUID UNIQUE REFERENCES dx_devices(id),
    lab_method_id        UUID UNIQUE REFERENCES lab_methods(id),
    cssd_machine_id      UUID UNIQUE REFERENCES cssd_machines(id),
    endo_scope_id        UUID UNIQUE REFERENCES endo_scopes(id),
    needs_review         BOOLEAN NOT NULL DEFAULT FALSE,                         -- ავტომატურად შექმნილი — შესავსები
    notes                TEXT,
    created_by           UUID REFERENCES users(id),                              -- NULL — მიგრაცია (backfill)
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_bme_one_link CHECK (num_nonnulls(dx_device_id, lab_method_id, cssd_machine_id, endo_scope_id) <= 1)
);
CREATE UNIQUE INDEX ux_bme_serial ON bme_devices (lower(coalesce(manufacturer, '')), upper(serial_no)) WHERE serial_no IS NOT NULL;
CREATE INDEX idx_bme_dept ON bme_devices (department_id) WHERE status <> 'retired';
CREATE INDEX idx_bme_status ON bme_devices (status);
CREATE INDEX idx_bme_type ON bme_devices (type_id);
CREATE INDEX idx_bme_or_room ON bme_devices (or_room_id) WHERE or_room_id IS NOT NULL;

-- სტატუსის პერიოდები: ერთ აპარატზე ერთი ღია (ended_at IS NULL) — downtime / ხელმისაწვდომობა (0076)
CREATE TABLE bme_status_periods (
    id          BIGSERIAL PRIMARY KEY,
    device_id   UUID NOT NULL REFERENCES bme_devices(id),
    status      VARCHAR(12) NOT NULL CHECK (status IN ('operational', 'restricted', 'down', 'standby', 'retired')),
    reason      TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at    TIMESTAMPTZ,
    started_by  UUID REFERENCES users(id),
    ended_by    UUID REFERENCES users(id),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX ux_bme_period_open ON bme_status_periods (device_id) WHERE ended_at IS NULL;
CREATE INDEX idx_bme_period_dev ON bme_status_periods (device_id, started_at);

-- ისტორია
CREATE TABLE bme_events (
    id          BIGSERIAL PRIMARY KEY,
    device_id   UUID NOT NULL REFERENCES bme_devices(id),
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'updated', 'status', 'move_requested', 'moved', 'move_rejected', 'move_cancelled',
                                                     'linked', 'unlinked', 'document', 'document_removed', 'reviewed')),
    data        JSONB NOT NULL DEFAULT '{}',
    user_id     UUID REFERENCES users(id),                                       -- NULL — მიგრაცია / სისტემა
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bme_events_dev ON bme_events (device_id, id DESC);

-- გადაადგილება (move_mode = confirm → pending, მიმღები განყოფილება ადასტურებს)
CREATE TABLE bme_moves (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id           UUID NOT NULL REFERENCES bme_devices(id),
    from_department_id  UUID REFERENCES departments(id),
    from_room           VARCHAR(60),
    from_or_room_id     UUID REFERENCES or_rooms(id),
    to_department_id    UUID NOT NULL REFERENCES departments(id),
    to_room             VARCHAR(60),
    to_or_room_id       UUID REFERENCES or_rooms(id),
    to_responsible_id   UUID REFERENCES users(id),
    status              VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'done', 'rejected', 'cancelled')),
    reason              TEXT,
    decision_note       TEXT,
    requested_by        UUID NOT NULL REFERENCES users(id),
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by          UUID REFERENCES users(id),
    decided_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX ux_bme_move_pending ON bme_moves (device_id) WHERE status = 'pending';
CREATE INDEX idx_bme_moves_to ON bme_moves (to_department_id) WHERE status = 'pending';

-- დოკუმენტები
CREATE TABLE bme_documents (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id      UUID NOT NULL REFERENCES bme_devices(id),
    kind           VARCHAR(16) NOT NULL CHECK (kind IN ('manual', 'service_manual', 'certificate', 'license', 'act', 'warranty', 'photo', 'other')),
    title          TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    valid_until    DATE,
    file_path      TEXT NOT NULL,
    mime_type      VARCHAR(40) NOT NULL,
    size_bytes     INT NOT NULL,
    sha256         CHAR(64) NOT NULL,
    original_name  TEXT,
    uploaded_by    UUID NOT NULL REFERENCES users(id),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    removed_by     UUID REFERENCES users(id),
    removed_at     TIMESTAMPTZ,
    remove_reason  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (is_active OR (removed_at IS NOT NULL AND remove_reason IS NOT NULL))
);
CREATE INDEX idx_bme_docs_dev ON bme_documents (device_id) WHERE is_active;
CREATE INDEX idx_bme_docs_valid ON bme_documents (valid_until) WHERE is_active AND valid_until IS NOT NULL;

-- ================================================================ 3. backfill — არსებული აპარატებიდან
WITH src AS (
    -- რადიოლოგია / ენდოსკოპიის ოთახები-აპარატები
    SELECT 1 AS ord, d.sort_order AS ord2, d.name AS dname, d.name, d.room,
           CASE WHEN d.section = 'endoscopy' THEN 'ENDO_TOWER'
                ELSE CASE d.modalities[1] WHEN 'CT' THEN 'CT' WHEN 'MR' THEN 'MRI' WHEN 'US' THEN 'US' WHEN 'DX' THEN 'XRAY'
                                          WHEN 'RF' THEN 'FLUORO' WHEN 'MG' THEN 'MAMMO' WHEN 'DXA' THEN 'DXA' ELSE 'OTHER' END END AS type_code,
           NULL::text AS manufacturer, NULL::text AS model, NULL::text AS serial_no, NULL::uuid AS department_id,
           d.is_active, d.id AS dx_device_id, NULL::uuid AS lab_method_id, NULL::uuid AS cssd_machine_id, NULL::uuid AS endo_scope_id
      FROM dx_devices d
    UNION ALL
    -- ლაბორატორიული ანალიზატორები
    SELECT 2, 0, m.name, m.name, NULL, 'LAB_ANALYZER', m.manufacturer, NULL, nullif(btrim(m.serial_number), ''), NULL,
           m.is_active, NULL, m.id, NULL, NULL
      FROM lab_methods m WHERE m.kind = 'analyzer'
    UNION ALL
    -- CSSD აპარატები
    SELECT 3, 0, c.name, c.name, NULL, CASE WHEN c.kind = 'washer' THEN 'WASHER_DIS' ELSE 'STERILIZER' END, c.manufacturer, c.model, nullif(btrim(c.serial_no), ''), l.department_id,
           c.is_active, NULL, NULL, c.id, NULL
      FROM cssd_machines c JOIN stock_locations l ON l.id = c.location_id
    UNION ALL
    -- ენდოსკოპები
    SELECT 4, 0, s.name, s.name, NULL, 'ENDOSCOPE', NULL, NULL, nullif(btrim(s.serial_number), ''), NULL,
           s.is_active, NULL, NULL, NULL, s.id
      FROM endo_scopes s
), numbered AS (
    SELECT s.*, row_number() OVER (ORDER BY s.ord, s.ord2, s.dname) AS n,
           -- იგივე მწარმოებელი + სერიული ორჯერ (ძველ ჩანაწერებში) — მეორეს სერიული არ გადაეცემა (ux_bme_serial)
           row_number() OVER (PARTITION BY lower(coalesce(s.manufacturer, '')), upper(s.serial_no) ORDER BY s.ord, s.dname) AS dup
      FROM src s
)
INSERT INTO bme_devices (inv_no, name, type_id, manufacturer, model, serial_no, risk_class, criticality, department_id, room, status, status_reason,
                         dx_device_id, lab_method_id, cssd_machine_id, endo_scope_id, needs_review, notes)
SELECT 'BME-' || lpad(n::text, 5, '0'), n2.name, t.id, n2.manufacturer, n2.model, CASE WHEN n2.serial_no IS NOT NULL AND n2.dup = 1 THEN n2.serial_no END,
       t.default_risk_class, t.default_criticality, n2.department_id, n2.room,
       CASE WHEN n2.is_active THEN 'operational' ELSE 'standby' END,
       CASE WHEN n2.is_active THEN NULL ELSE 'მიგრაცია: ჩანაწერი გათიშული იყო' END,
       n2.dx_device_id, n2.lab_method_id, n2.cssd_machine_id, n2.endo_scope_id, TRUE,
       CASE WHEN n2.serial_no IS NOT NULL AND n2.dup > 1 THEN 'მიგრაცია: სერიული ნომერი (' || n2.serial_no || ') სხვა ჩანაწერს ემთხვევა — გადაამოწმეთ' END
  FROM numbered n2 JOIN bme_device_types t ON t.code = n2.type_code;

INSERT INTO document_counters (document_type, year, last_value)
SELECT 'bme_BME', 0, count(*) FROM bme_devices HAVING count(*) > 0
ON CONFLICT (document_type, year) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);

INSERT INTO bme_status_periods (device_id, status, reason, started_at)
SELECT id, status, status_reason, status_since FROM bme_devices;

INSERT INTO bme_events (device_id, kind, data)
SELECT id, 'created', jsonb_build_object('inv_no', inv_no, 'backfill', TRUE,
       'link', CASE WHEN dx_device_id IS NOT NULL THEN 'dx_device' WHEN lab_method_id IS NOT NULL THEN 'lab_method'
                    WHEN cssd_machine_id IS NOT NULL THEN 'cssd_machine' WHEN endo_scope_id IS NOT NULL THEN 'endo_scope' END)
  FROM bme_devices;
