-- 0011_diagnostics.sql
-- დიაგნოსტიკა: ლაბორატორია / რადიოლოგია / ენდოსკოპია
--  • კვლევების კატალოგი (თითოეულს საკუთარი ტარიფი)
--  • შეკვეთა კონკრეტულ კვლევებზე (ინვოისის ხაზი თითო კვლევაზე)
--  • ლაბორატორია: კომპონენტები, ნორმები (სქესი/ასაკი), ნიმუში+შტრიხკოდი, შედეგები, ვალიდაცია
-- ⚠️ საწყისი კატალოგი და ნორმები — შაბლონი: ლაბორატორიამ უნდა გადაამოწმოს, ფასები — კლინიკამ.

-- ახალი როლები: ლაბორატორიის ექიმი/ხელმძღვანელი (ვალიდაცია, ნორმების დამტკიცება),
--                ლაბორატორიის მენეჯერი (ანალიზების ფორმები/კატალოგი, ვალიდაციის გარეშე)
ALTER TABLE users DROP CONSTRAINT chk_users_role;
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (
    role IN ('admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager'));

-- ---------------------------------------------------------------- კატალოგი
CREATE TABLE dx_services (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    section         VARCHAR(20) NOT NULL CHECK (section IN ('lab', 'radiology', 'endoscopy')),
    code            VARCHAR(50) NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    group_name      TEXT NOT NULL,                     -- ლაბ: ჰემატოლოგია/ბიოქიმია…; რადიოლოგია: მოდალობა; ენდოსკოპია: ტიპი
    tariff_id       UUID NOT NULL REFERENCES service_tariffs(id),
    performed_by    VARCHAR(20) NOT NULL DEFAULT 'internal' CHECK (performed_by IN ('internal', 'external')),
    external_lab    TEXT,
    specimen_type   VARCHAR(20) CHECK (specimen_type IN ('blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'other')),
    container       TEXT,                              -- სინჯარა: EDTA, Serum gel, Citrate…
    modality        VARCHAR(10),                       -- DICOM: CT, MR, US, DX, RF, MG + DXA
    body_part       TEXT,
    contrast        VARCHAR(20) CHECK (contrast IN ('iodinated', 'gadolinium', 'barium')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    needs_review    BOOLEAN NOT NULL DEFAULT TRUE,     -- საწყისი შაბლონი — გადასამოწმებელი
    sort_order      INT NOT NULL DEFAULT 0,
    CONSTRAINT chk_dx_lab_specimen CHECK (section <> 'lab' OR specimen_type IS NOT NULL)
);
CREATE INDEX idx_dx_services_section ON dx_services (section, group_name, sort_order);
CREATE INDEX idx_dx_services_name_trgm ON dx_services USING gin (name gin_trgm_ops);

CREATE TABLE lab_analytes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_id      UUID NOT NULL REFERENCES dx_services(id) ON DELETE CASCADE,
    code            VARCHAR(30) NOT NULL,
    name            TEXT NOT NULL,
    unit            TEXT NOT NULL DEFAULT '',
    result_type     VARCHAR(10) NOT NULL CHECK (result_type IN ('numeric', 'text', 'select')),
    decimals        SMALLINT,
    options         TEXT,                              -- select: "უარყოფითი|დადებითი"
    critical_low    NUMERIC,
    critical_high   NUMERIC,
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (service_id, code)
);
CREATE TABLE lab_reference_ranges (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analyte_id      UUID NOT NULL REFERENCES lab_analytes(id) ON DELETE CASCADE,
    sex             VARCHAR(10) CHECK (sex IN ('male', 'female')),   -- NULL = ორივე
    age_min_days    INT NOT NULL DEFAULT 0,
    age_max_days    INT NOT NULL DEFAULT 54750,                      -- 150 წელი
    low             NUMERIC,
    high            NUMERIC,
    normal_text     TEXT,                                            -- ხარისხობრივი: "უარყოფითი"
    CHECK (age_min_days <= age_max_days)
);
CREATE INDEX idx_lab_ranges_analyte ON lab_reference_ranges (analyte_id);

-- ---------------------------------------------------------------- ნიმუშები
CREATE SEQUENCE lab_barcode_seq START 1000001;
CREATE SEQUENCE accession_seq START 100001;     -- რადიოლოგიის Accession Number
CREATE TABLE lab_specimens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    barcode         VARCHAR(20) NOT NULL UNIQUE,
    encounter_id    UUID NOT NULL REFERENCES encounters(id),
    patient_id      UUID NOT NULL REFERENCES patients(id),
    specimen_type   VARCHAR(20) NOT NULL,
    container       TEXT,
    status          VARCHAR(12) NOT NULL DEFAULT 'collected' CHECK (status IN ('collected', 'received', 'rejected')),
    collected_by    UUID REFERENCES users(id),
    collected_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    received_by     UUID REFERENCES users(id),
    received_at     TIMESTAMPTZ,
    reject_reason   TEXT
);

-- ---------------------------------------------------------------- შეკვეთები
CREATE TABLE dx_order_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id    UUID NOT NULL REFERENCES encounters(id),
    patient_id      UUID NOT NULL REFERENCES patients(id),
    service_id      UUID NOT NULL REFERENCES dx_services(id),
    section         VARCHAR(20) NOT NULL,
    status          VARCHAR(15) NOT NULL DEFAULT 'ordered'
                      CHECK (status IN ('ordered', 'collected', 'in_progress', 'resulted', 'validated', 'cancelled')),
    priority        VARCHAR(10) NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'urgent')),
    clinical_note   TEXT,
    specimen_id     UUID REFERENCES lab_specimens(id),
    accession_number VARCHAR(20) UNIQUE,              -- რადიოლოგია: dcm4chee Worklist-ისთვის (ეტაპი გ)
    report_text     TEXT,                              -- რადიოლოგია / ენდოსკოპია: დასკვნა
    allergy_override_reason TEXT,
    ordered_by      UUID NOT NULL REFERENCES users(id),
    ordered_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resulted_by     UUID REFERENCES users(id),
    resulted_at     TIMESTAMPTZ,
    validated_by    UUID REFERENCES users(id),
    validated_at    TIMESTAMPTZ,
    cancel_reason   TEXT
);
CREATE INDEX idx_dx_items_encounter ON dx_order_items (encounter_id);
CREATE INDEX idx_dx_items_worklist ON dx_order_items (section, status, ordered_at);
CREATE INDEX idx_dx_items_patient ON dx_order_items (patient_id, service_id);

ALTER TABLE invoice_line_items ADD COLUMN dx_order_item_id UUID REFERENCES dx_order_items(id);
CREATE UNIQUE INDEX uq_invoice_lines_dx ON invoice_line_items (dx_order_item_id) WHERE dx_order_item_id IS NOT NULL;

-- ---------------------------------------------------------------- ლაბორატორიის შედეგები
CREATE TABLE lab_results (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id   UUID NOT NULL REFERENCES dx_order_items(id),
    analyte_id      UUID NOT NULL REFERENCES lab_analytes(id),
    value_num       NUMERIC,
    value_text      TEXT,
    unit            TEXT NOT NULL DEFAULT '',          -- ასლი შედეგის მომენტში
    ref_low         NUMERIC,
    ref_high        NUMERIC,
    ref_text        TEXT,
    flag            VARCHAR(2) CHECK (flag IN ('N', 'L', 'H', 'LL', 'HH', 'A')),   -- A = ხარისხობრივი გადახრა
    entered_by      UUID REFERENCES users(id),
    entered_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (order_item_id, analyte_id)
);

-- ---------------------------------------------------------------- საწყისი კატალოგი
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_CBC', 'სისხლის საერთო ანალიზი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_CBC', 'სისხლის საერთო ანალიზი', 'ჰემატოლოგია', (SELECT id FROM service_tariffs WHERE code='LAB_CBC'), 'blood', 'EDTA', 0);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'WBC', 'ლეიკოციტები', '10^9/L', 'numeric', 1, NULL, 2.0, 30.0, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='WBC'), NULL, 4.0, 10.0, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'RBC', 'ერითროციტები', '10^12/L', 'numeric', 2, NULL, NULL, NULL, 1);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='RBC'), 'male', 4.5, 5.9, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='RBC'), 'female', 4.0, 5.2, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'HGB', 'ჰემოგლობინი', 'g/L', 'numeric', 0, NULL, 70, 200, 2);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='HGB'), 'male', 135, 175, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='HGB'), 'female', 120, 155, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'HCT', 'ჰემატოკრიტი', '%', 'numeric', 1, NULL, NULL, NULL, 3);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='HCT'), 'male', 40, 52, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='HCT'), 'female', 36, 46, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'MCV', 'MCV', 'fL', 'numeric', 1, NULL, NULL, NULL, 4);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='MCV'), NULL, 80, 100, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'MCH', 'MCH', 'pg', 'numeric', 1, NULL, NULL, NULL, 5);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='MCH'), NULL, 27, 33, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'MCHC', 'MCHC', 'g/L', 'numeric', 0, NULL, NULL, NULL, 6);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='MCHC'), NULL, 320, 360, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'PLT', 'თრომბოციტები', '10^9/L', 'numeric', 0, NULL, 20, 1000, 7);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='PLT'), NULL, 150, 400, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'NEU', 'ნეიტროფილები', '%', 'numeric', 1, NULL, NULL, NULL, 8);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='NEU'), NULL, 40, 75, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'LYM', 'ლიმფოციტები', '%', 'numeric', 1, NULL, NULL, NULL, 9);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='LYM'), NULL, 20, 45, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'MON', 'მონოციტები', '%', 'numeric', 1, NULL, NULL, NULL, 10);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='MON'), NULL, 2, 10, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'EOS', 'ეოზინოფილები', '%', 'numeric', 1, NULL, NULL, NULL, 11);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='EOS'), NULL, 0, 6, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CBC'), 'BAS', 'ბაზოფილები', '%', 'numeric', 1, NULL, NULL, NULL, 12);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CBC' AND a.code='BAS'), NULL, 0, 1, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_ESR', 'ედს (ერითროციტების დალექვის სიჩქარე)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_ESR', 'ედს (ერითროციტების დალექვის სიჩქარე)', 'ჰემატოლოგია', (SELECT id FROM service_tariffs WHERE code='LAB_ESR'), 'blood', 'EDTA', 10);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_ESR'), 'ESR', 'ედს', 'mm/h', 'numeric', 0, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_ESR' AND a.code='ESR'), 'male', 0, 15, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_ESR' AND a.code='ESR'), 'female', 0, 20, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_COAG', 'კოაგულოგრამა (PT/INR)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_COAG', 'კოაგულოგრამა (PT/INR)', 'კოაგულაცია', (SELECT id FROM service_tariffs WHERE code='LAB_COAG'), 'plasma', 'Citrate', 20);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_COAG'), 'PT', 'პროთრომბინის დრო', 's', 'numeric', 1, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_COAG' AND a.code='PT'), NULL, 11, 13.5, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_COAG'), 'INR', 'INR', '', 'numeric', 2, NULL, NULL, 5.0, 1);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_COAG' AND a.code='INR'), NULL, 0.8, 1.2, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_GLU', 'გლუკოზა (უზმოზე)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_GLU', 'გლუკოზა (უზმოზე)', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_GLU'), 'serum', 'Serum gel', 30);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_GLU'), 'GLU', 'გლუკოზა', 'mmol/L', 'numeric', 1, NULL, 2.5, 25, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_GLU' AND a.code='GLU'), NULL, 3.9, 6.1, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_HBA1C', 'გლიკირებული ჰემოგლობინი (HbA1c)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_HBA1C', 'გლიკირებული ჰემოგლობინი (HbA1c)', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_HBA1C'), 'blood', 'EDTA', 40);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_HBA1C'), 'HBA1C', 'HbA1c', '%', 'numeric', 1, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_HBA1C' AND a.code='HBA1C'), NULL, 4.0, 5.6, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_CREA', 'კრეატინინი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_CREA', 'კრეატინინი', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_CREA'), 'serum', 'Serum gel', 50);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CREA'), 'CREA', 'კრეატინინი', 'µmol/L', 'numeric', 0, NULL, NULL, 700, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CREA' AND a.code='CREA'), 'male', 62, 106, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CREA' AND a.code='CREA'), 'female', 44, 80, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_UREA', 'შარდოვანა', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_UREA', 'შარდოვანა', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_UREA'), 'serum', 'Serum gel', 60);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UREA'), 'UREA', 'შარდოვანა', 'mmol/L', 'numeric', 1, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UREA' AND a.code='UREA'), NULL, 2.5, 7.5, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_LIVER', 'ღვიძლის სინჯები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_LIVER', 'ღვიძლის სინჯები', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_LIVER'), 'serum', 'Serum gel', 70);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIVER'), 'ALT', 'ALT', 'U/L', 'numeric', 0, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIVER' AND a.code='ALT'), 'male', 0, 41, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIVER' AND a.code='ALT'), 'female', 0, 33, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIVER'), 'AST', 'AST', 'U/L', 'numeric', 0, NULL, NULL, NULL, 1);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIVER' AND a.code='AST'), 'male', 0, 40, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIVER' AND a.code='AST'), 'female', 0, 32, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIVER'), 'TBIL', 'ბილირუბინი საერთო', 'µmol/L', 'numeric', 1, NULL, NULL, NULL, 2);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIVER' AND a.code='TBIL'), NULL, 3.4, 20.5, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_LIPID', 'ლიპიდური პროფილი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_LIPID', 'ლიპიდური პროფილი', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_LIPID'), 'serum', 'Serum gel', 80);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIPID'), 'CHOL', 'ქოლესტერინი საერთო', 'mmol/L', 'numeric', 2, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIPID' AND a.code='CHOL'), NULL, NULL, 5.2, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIPID'), 'LDL', 'LDL ქოლესტერინი', 'mmol/L', 'numeric', 2, NULL, NULL, NULL, 1);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIPID' AND a.code='LDL'), NULL, NULL, 3.0, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIPID'), 'HDL', 'HDL ქოლესტერინი', 'mmol/L', 'numeric', 2, NULL, NULL, NULL, 2);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIPID' AND a.code='HDL'), 'male', 1.0, NULL, NULL);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIPID' AND a.code='HDL'), 'female', 1.2, NULL, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_LIPID'), 'TG', 'ტრიგლიცერიდები', 'mmol/L', 'numeric', 2, NULL, NULL, NULL, 3);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_LIPID' AND a.code='TG'), NULL, NULL, 1.7, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_ELEC', 'ელექტროლიტები (Na, K, Cl)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_ELEC', 'ელექტროლიტები (Na, K, Cl)', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_ELEC'), 'serum', 'Serum gel', 90);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_ELEC'), 'NA', 'ნატრიუმი', 'mmol/L', 'numeric', 0, NULL, 120, 160, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_ELEC' AND a.code='NA'), NULL, 135, 145, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_ELEC'), 'K', 'კალიუმი', 'mmol/L', 'numeric', 1, NULL, 2.8, 6.2, 1);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_ELEC' AND a.code='K'), NULL, 3.5, 5.1, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_ELEC'), 'CL', 'ქლორი', 'mmol/L', 'numeric', 0, NULL, NULL, NULL, 2);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_ELEC' AND a.code='CL'), NULL, 98, 107, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_CRP', 'C-რეაქტიული ცილა (CRP)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_CRP', 'C-რეაქტიული ცილა (CRP)', 'ბიოქიმია', (SELECT id FROM service_tariffs WHERE code='LAB_CRP'), 'serum', 'Serum gel', 100);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_CRP'), 'CRP', 'CRP', 'mg/L', 'numeric', 1, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_CRP' AND a.code='CRP'), NULL, 0, 5, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_TSH', 'TSH', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_TSH', 'TSH', 'ჰორმონები', (SELECT id FROM service_tariffs WHERE code='LAB_TSH'), 'serum', 'Serum gel', 110);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_TSH'), 'TSH', 'TSH', 'mIU/L', 'numeric', 2, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_TSH' AND a.code='TSH'), NULL, 0.4, 4.0, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_FT4', 'თავისუფალი T4', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_FT4', 'თავისუფალი T4', 'ჰორმონები', (SELECT id FROM service_tariffs WHERE code='LAB_FT4'), 'serum', 'Serum gel', 120);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_FT4'), 'FT4', 'FT4', 'pmol/L', 'numeric', 1, NULL, NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_FT4' AND a.code='FT4'), NULL, 12, 22, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_UA', 'შარდის საერთო ანალიზი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_UA', 'შარდის საერთო ანალიზი', 'შარდი', (SELECT id FROM service_tariffs WHERE code='LAB_UA'), 'urine', 'Urine container', 130);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'COLOR', 'ფერი', '', 'text', NULL, NULL, NULL, NULL, 0);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'CLAR', 'გამჭვირვალობა', '', 'text', NULL, NULL, NULL, NULL, 1);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'SG', 'ხვედრითი წონა', '', 'numeric', 3, NULL, NULL, NULL, 2);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='SG'), NULL, 1.005, 1.03, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'PH', 'pH', '', 'numeric', 1, NULL, NULL, NULL, 3);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='PH'), NULL, 5.0, 8.0, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'PRO', 'ცილა', '', 'select', NULL, 'უარყოფითი|კვალი|+|++|+++', NULL, NULL, 4);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='PRO'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'UGLU', 'გლუკოზა', '', 'select', NULL, 'უარყოფითი|კვალი|+|++|+++', NULL, NULL, 5);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='UGLU'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'KET', 'კეტონები', '', 'select', NULL, 'უარყოფითი|კვალი|+|++|+++', NULL, NULL, 6);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='KET'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'UBLD', 'სისხლი', '', 'select', NULL, 'უარყოფითი|კვალი|+|++|+++', NULL, NULL, 7);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='UBLD'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'UWBC', 'ლეიკოციტები', '/მხედვ. ველი', 'numeric', 0, NULL, NULL, NULL, 8);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='UWBC'), NULL, 0, 5, NULL);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_UA'), 'URBC', 'ერითროციტები', '/მხედვ. ველი', 'numeric', 0, NULL, NULL, NULL, 9);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_UA' AND a.code='URBC'), NULL, 0, 2, NULL);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_HBSAG', 'HBsAg', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_HBSAG', 'HBsAg', 'სეროლოგია', (SELECT id FROM service_tariffs WHERE code='LAB_HBSAG'), 'serum', 'Serum gel', 140);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_HBSAG'), 'HBSAG', 'HBsAg', '', 'select', NULL, 'უარყოფითი|დადებითი', NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_HBSAG' AND a.code='HBSAG'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_HCV', 'anti-HCV', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_HCV', 'anti-HCV', 'სეროლოგია', (SELECT id FROM service_tariffs WHERE code='LAB_HCV'), 'serum', 'Serum gel', 150);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_HCV'), 'AHCV', 'anti-HCV', '', 'select', NULL, 'უარყოფითი|დადებითი', NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_HCV' AND a.code='AHCV'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO service_tariffs (code, title, base_price) VALUES ('LAB_HIV', 'HIV Ag/Ab', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, specimen_type, container, sort_order) VALUES ('lab', 'LAB_HIV', 'HIV Ag/Ab', 'სეროლოგია', (SELECT id FROM service_tariffs WHERE code='LAB_HIV'), 'serum', 'Serum gel', 160);
INSERT INTO lab_analytes (service_id, code, name, unit, result_type, decimals, options, critical_low, critical_high, sort_order) VALUES ((SELECT id FROM dx_services WHERE code='LAB_HIV'), 'HIV', 'HIV Ag/Ab', '', 'select', NULL, 'უარყოფითი|დადებითი', NULL, NULL, 0);
INSERT INTO lab_reference_ranges (analyte_id, sex, low, high, normal_text) VALUES ((SELECT a.id FROM lab_analytes a JOIN dx_services s ON s.id=a.service_id WHERE s.code='LAB_HIV' AND a.code='HIV'), NULL, NULL, NULL, 'უარყოფითი');
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_CT_HEAD', 'CT — თავის ტვინი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_CT_HEAD', 'CT — თავის ტვინი', 'კომპიუტერული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_CT_HEAD'), 'CT', 'თავი', NULL, 0);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_CT_HEAD_C', 'CT — თავის ტვინი, კონტრასტით', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_CT_HEAD_C', 'CT — თავის ტვინი, კონტრასტით', 'კომპიუტერული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_CT_HEAD_C'), 'CT', 'თავი', 'iodinated', 10);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_CT_CHEST', 'CT — გულმკერდი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_CT_CHEST', 'CT — გულმკერდი', 'კომპიუტერული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_CT_CHEST'), 'CT', 'გულმკერდი', NULL, 20);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_CT_ABD_C', 'CT — მუცელი და მცირე მენჯი, კონტრასტით', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_CT_ABD_C', 'CT — მუცელი და მცირე მენჯი, კონტრასტით', 'კომპიუტერული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_CT_ABD_C'), 'CT', 'მუცელი', 'iodinated', 30);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_CT_LSPINE', 'CT — წელის მალები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_CT_LSPINE', 'CT — წელის მალები', 'კომპიუტერული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_CT_LSPINE'), 'CT', 'ხერხემალი', NULL, 40);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_MR_BRAIN', 'MRI — თავის ტვინი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_MR_BRAIN', 'MRI — თავის ტვინი', 'მაგნიტურ-რეზონანსული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_MR_BRAIN'), 'MR', 'თავი', NULL, 50);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_MR_BRAIN_C', 'MRI — თავის ტვინი, კონტრასტით', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_MR_BRAIN_C', 'MRI — თავის ტვინი, კონტრასტით', 'მაგნიტურ-რეზონანსული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_MR_BRAIN_C'), 'MR', 'თავი', 'gadolinium', 60);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_MR_LSPINE', 'MRI — წელის მალები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_MR_LSPINE', 'MRI — წელის მალები', 'მაგნიტურ-რეზონანსული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_MR_LSPINE'), 'MR', 'ხერხემალი', NULL, 70);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_MR_KNEE', 'MRI — მუხლის სახსარი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_MR_KNEE', 'MRI — მუხლის სახსარი', 'მაგნიტურ-რეზონანსული ტომოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_MR_KNEE'), 'MR', 'მუხლი', NULL, 80);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_US_ABD', 'ულტრაბგერა — მუცლის ღრუ', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_US_ABD', 'ულტრაბგერა — მუცლის ღრუ', 'ულტრაბგერა', (SELECT id FROM service_tariffs WHERE code='RAD_US_ABD'), 'US', 'მუცელი', NULL, 90);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_US_THY', 'ულტრაბგერა — ფარისებრი ჯირკვალი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_US_THY', 'ულტრაბგერა — ფარისებრი ჯირკვალი', 'ულტრაბგერა', (SELECT id FROM service_tariffs WHERE code='RAD_US_THY'), 'US', 'კისერი', NULL, 100);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_US_PELV', 'ულტრაბგერა — მცირე მენჯი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_US_PELV', 'ულტრაბგერა — მცირე მენჯი', 'ულტრაბგერა', (SELECT id FROM service_tariffs WHERE code='RAD_US_PELV'), 'US', 'მენჯი', NULL, 110);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_US_BREAST', 'ულტრაბგერა — სარძევე ჯირკვლები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_US_BREAST', 'ულტრაბგერა — სარძევე ჯირკვლები', 'ულტრაბგერა', (SELECT id FROM service_tariffs WHERE code='RAD_US_BREAST'), 'US', 'მკერდი', NULL, 120);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_US_KIDNEY', 'ულტრაბგერა — თირკმელები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_US_KIDNEY', 'ულტრაბგერა — თირკმელები', 'ულტრაბგერა', (SELECT id FROM service_tariffs WHERE code='RAD_US_KIDNEY'), 'US', 'თირკმელები', NULL, 130);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_US_NECKDOP', 'დოპლეროგრაფია — კისრის სისხლძარღვები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_US_NECKDOP', 'დოპლეროგრაფია — კისრის სისხლძარღვები', 'ულტრაბგერა', (SELECT id FROM service_tariffs WHERE code='RAD_US_NECKDOP'), 'US', 'კისერი', NULL, 140);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_DX_CHEST', 'რენტგენოგრაფია — გულმკერდი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_DX_CHEST', 'რენტგენოგრაფია — გულმკერდი', 'რენტგენოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_DX_CHEST'), 'DX', 'გულმკერდი', NULL, 150);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_DX_LSPINE', 'რენტგენოგრაფია — წელის მალები', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_DX_LSPINE', 'რენტგენოგრაფია — წელის მალები', 'რენტგენოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_DX_LSPINE'), 'DX', 'ხერხემალი', NULL, 160);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_DX_KNEE', 'რენტგენოგრაფია — მუხლის სახსარი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_DX_KNEE', 'რენტგენოგრაფია — მუხლის სახსარი', 'რენტგენოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_DX_KNEE'), 'DX', 'მუხლი', NULL, 170);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_DX_HAND', 'რენტგენოგრაფია — ხელის მტევანი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_DX_HAND', 'რენტგენოგრაფია — ხელის მტევანი', 'რენტგენოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_DX_HAND'), 'DX', 'მტევანი', NULL, 180);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_RF_UGI', 'რენტგენოსკოპია — საყლაპავი/კუჭი (კონტრასტით)', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_RF_UGI', 'რენტგენოსკოპია — საყლაპავი/კუჭი (კონტრასტით)', 'რენტგენოსკოპია', (SELECT id FROM service_tariffs WHERE code='RAD_RF_UGI'), 'RF', 'კუჭი', 'barium', 190);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_MG_BIL', 'მამოგრაფია — ორმხრივი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_MG_BIL', 'მამოგრაფია — ორმხრივი', 'მამოგრაფია', (SELECT id FROM service_tariffs WHERE code='RAD_MG_BIL'), 'MG', 'მკერდი', NULL, 200);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('RAD_DXA', 'დენსიტომეტრია (DXA) — ბარძაყი და წელი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, modality, body_part, contrast, sort_order) VALUES ('radiology', 'RAD_DXA', 'დენსიტომეტრია (DXA) — ბარძაყი და წელი', 'დენსიტომეტრია', (SELECT id FROM service_tariffs WHERE code='RAD_DXA'), 'DXA', 'ძვლები', NULL, 210);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('ENDO_EGD', 'ეზოფაგოგასტროდუოდენოსკოპია', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, sort_order) VALUES ('endoscopy', 'ENDO_EGD', 'ეზოფაგოგასტროდუოდენოსკოპია', 'ზედა ენდოსკოპია', (SELECT id FROM service_tariffs WHERE code='ENDO_EGD'), 0);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('ENDO_COLON', 'კოლონოსკოპია', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, sort_order) VALUES ('endoscopy', 'ENDO_COLON', 'კოლონოსკოპია', 'ქვედა ენდოსკოპია', (SELECT id FROM service_tariffs WHERE code='ENDO_COLON'), 10);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('ENDO_SIGM', 'სიგმოიდოსკოპია', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, sort_order) VALUES ('endoscopy', 'ENDO_SIGM', 'სიგმოიდოსკოპია', 'ქვედა ენდოსკოპია', (SELECT id FROM service_tariffs WHERE code='ENDO_SIGM'), 20);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('ENDO_BRONCH', 'ბრონქოსკოპია', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, sort_order) VALUES ('endoscopy', 'ENDO_BRONCH', 'ბრონქოსკოპია', 'ბრონქოსკოპია', (SELECT id FROM service_tariffs WHERE code='ENDO_BRONCH'), 30);
INSERT INTO service_tariffs (code, title, base_price) VALUES ('ENDO_CYSTO', 'ცისტოსკოპია', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO dx_services (section, code, name, group_name, tariff_id, sort_order) VALUES ('endoscopy', 'ENDO_CYSTO', 'ცისტოსკოპია', 'უროლოგია', (SELECT id FROM service_tariffs WHERE code='ENDO_CYSTO'), 40);
