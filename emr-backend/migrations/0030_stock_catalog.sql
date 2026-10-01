-- 0030_stock_catalog.sql
-- საწყობი + აფთიაქი, ეტაპი 1 — ნომენკლატურა (ნაშთები და მოძრაობები — 0031-დან):
--   * უფლებები: storekeeper (მესაწყობე), stock_manager (საწყობის მენეჯერი)
--   * პარამეტრები (stock_settings): თვითღირებულების მეთოდი (კლინიკის არჩევანი: ლოტის ფასი / საშუალო შეწონილი),
--     მოკლევადიანის ზღვარი მიღებისას
--   * ცნობარები: ერთეულები, წამლის ფორმები, შეყვანის გზები, კატეგორიები (ნაგულისხმევი დროშები, ვადის გაფრთხილება, ბილინგის რეჟიმი)
--   * ორდონიანი კატალოგი (გადაწყვეტილება 2A):
--       med_generics — INN + ფორმა + დოზა + ATC; ნარკ./ფსიქოტროპ. კლასი, მაღალი რისკი, სარეზერვო ანტიბიოტიკი,
--                      „მხოლოდ პაციენტზე“, შეყვანის გზები, დოზის ზღვრები (მოზრდილი / ბავშვთა მგ/კგ), ალერგენული ჯგუფები
--       stock_items  — საქონელი (SKU): სავაჭრო დასახელება, მწარმოებელი, საბაზო ერთეული, შეფუთვები, შტრიხკოდები (GTIN-14)
--     მედიკამენტის კატეგორიაზე ჯენერიკი სავალდებულოა (ტრიგერი); სხვა კატეგორიებზე — არა
--   * ურთიერთქმედებები (med_interactions): ჯენერიკი ან ATC-ჯგუფი × ჯენერიკი ან ATC-ჯგუფი, სიმძიმე, წყარო (საკუთარი / გარე ბაზა)
--   * მომწოდებლები, ლოკაციები (აფთიაქი, სამეურნეო, განყოფილებების ქვესაწყობები…)

-- ---------------------------------------------------------------- უფლებები
ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer',
        'storekeeper', 'stock_manager']::VARCHAR(30)[]);

-- ---------------------------------------------------------------- პარამეტრები
CREATE TABLE stock_settings (
    id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    costing_method       VARCHAR(10) NOT NULL DEFAULT 'fifo' CHECK (costing_method IN ('fifo', 'average')),
    short_expiry_months  SMALLINT NOT NULL DEFAULT 6 CHECK (short_expiry_months BETWEEN 0 AND 60),
    updated_by           UUID REFERENCES users(id),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO stock_settings (id) VALUES (1);

-- ---------------------------------------------------------------- ცნობარები
CREATE TABLE stock_units (
    code        VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,19}$'),
    name        TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO stock_units (code, name, sort_order) VALUES
 ('piece', 'ცალი', 10), ('tablet', 'ტაბლეტი', 20), ('capsule', 'კაფსულა', 30), ('ampoule', 'ამპულა', 40), ('vial', 'ფლაკონი', 50),
 ('bottle', 'ბოთლი', 60), ('bag', 'პარკი', 70), ('tube', 'ტუბი', 80), ('sachet', 'პაკეტი', 90), ('suppository', 'სუპოზიტორია', 100),
 ('syringe', 'შპრიცი (წინასწარ შევსებული)', 110), ('patch', 'პლასტირი', 120), ('ml', 'მლ', 130), ('l', 'ლ', 140), ('g', 'გ', 150),
 ('kg', 'კგ', 160), ('m', 'მ', 170), ('pair', 'წყვილი', 180), ('set', 'ნაკრები', 190), ('roll', 'რულონი', 200), ('test', 'ტესტი', 210), ('pack', 'შეფუთვა', 220);

CREATE TABLE med_dosage_forms (
    code        VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{0,19}$'),
    name        TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO med_dosage_forms (code, name, sort_order) VALUES
 ('TAB', 'ტაბლეტი', 10), ('TAB_FC', 'ტაბლეტი, აფსკით დაფარული', 20), ('TAB_MR', 'ტაბლეტი, მოდიფიცირებული გამოთავისუფლებით', 30),
 ('CAP', 'კაფსულა', 40), ('INJ_SOL', 'საინექციო ხსნარი', 50), ('INJ_PWD', 'ფხვნილი საინექციო ხსნარისთვის', 60),
 ('INF_SOL', 'საინფუზიო ხსნარი', 70), ('INF_CONC', 'კონცენტრატი საინფუზიო ხსნარისთვის', 80), ('SYR', 'სიროფი', 90),
 ('SUSP', 'სუსპენზია', 100), ('ORAL_SOL', 'ხსნარი შინაგანი მიღებისთვის', 110), ('DROPS', 'წვეთები', 120),
 ('EYE_DROPS', 'თვალის წვეთები', 130), ('SUPP', 'სუპოზიტორია', 140), ('OINT', 'მალამო', 150), ('CREAM', 'კრემი', 160),
 ('GEL', 'გელი', 170), ('INH', 'საინჰალაციო ფორმა', 180), ('SPRAY', 'სპრეი', 190), ('PATCH', 'ტრანსდერმული სისტემა', 200),
 ('POWDER', 'ფხვნილი', 210), ('GAS', 'სამედიცინო აირი', 220), ('OTHER', 'სხვა', 900);

CREATE TABLE med_routes (
    code        VARCHAR(10) PRIMARY KEY CHECK (code ~ '^[A-Z]{2,10}$'),
    name        TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO med_routes (code, name, sort_order) VALUES
 ('PO', 'შიგნით (per os)', 10), ('SL', 'ენისქვეშ', 20), ('IV', 'ინტრავენურად', 30), ('IM', 'ინტრამუსკულურად', 40), ('SC', 'კანქვეშ', 50),
 ('ID', 'ინტრადერმულად', 60), ('IO', 'ინტრაოსალურად', 70), ('PR', 'რექტალურად', 80), ('VAG', 'ვაგინალურად', 90), ('TOP', 'ადგილობრივად', 100),
 ('INH', 'ინჰალაციით', 110), ('NAS', 'ცხვირში', 120), ('OPH', 'თვალში', 130), ('OT', 'ყურში', 140), ('NG', 'ზონდით', 150),
 ('EPI', 'ეპიდურულად', 160), ('IT', 'ინტრათეკალურად', 170);

CREATE TABLE stock_categories (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code               VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name               TEXT NOT NULL,
    kind               VARCHAR(20) NOT NULL CHECK (kind IN ('medication', 'medical_supply', 'implant', 'reagent', 'qc_material', 'household', 'office', 'other')),
    parent_id          UUID REFERENCES stock_categories(id),
    -- ახალი საქონლის ნაგულისხმევი დროშები (საქონელზე იცვლება)
    requires_lot       BOOLEAN NOT NULL DEFAULT TRUE,
    requires_expiry    BOOLEAN NOT NULL DEFAULT TRUE,
    serial_tracked     BOOLEAN NOT NULL DEFAULT FALSE,
    expiry_warn_days   SMALLINT CHECK (expiry_warn_days BETWEEN 0 AND 730),
    -- პაციენტზე ხარჯის ბილინგი (კლინიკის არჩევანი): none — მხოლოდ აღრიცხვა; invoice — ინვოისში გასაყიდი ფასით
    billing_mode       VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (billing_mode IN ('none', 'invoice')),
    markup_pct         NUMERIC(6,2) CHECK (markup_pct >= 0),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order         INT NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (requires_lot OR NOT serial_tracked),
    CHECK (parent_id IS DISTINCT FROM id)
);
CREATE TRIGGER trg_stock_categories_updated_at BEFORE UPDATE ON stock_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO stock_categories (code, name, kind, requires_lot, requires_expiry, serial_tracked, expiry_warn_days, sort_order) VALUES
 ('MED', 'მედიკამენტები', 'medication', TRUE, TRUE, FALSE, 90, 10),
 ('MEDSUP', 'სამედიცინო მასალა', 'medical_supply', TRUE, TRUE, FALSE, 60, 20),
 ('IMPLANT', 'იმპლანტები', 'implant', TRUE, TRUE, TRUE, 90, 30),
 ('REAGENT', 'რეაგენტები', 'reagent', TRUE, TRUE, FALSE, 30, 40),
 ('QC', 'QC მასალები', 'qc_material', TRUE, TRUE, FALSE, 30, 50),
 ('HOUSE', 'სამეურნეო', 'household', FALSE, FALSE, FALSE, NULL, 60),
 ('OFFICE', 'საოფისე', 'office', FALSE, FALSE, FALSE, NULL, 70);

-- ---------------------------------------------------------------- ჯენერიკი (INN + ფორმა + დოზა)
CREATE TABLE med_generics (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inn                  TEXT NOT NULL CHECK (length(btrim(inn)) >= 2),          -- ცეფტრიაქსონი
    inn_latin            TEXT,                                                   -- Ceftriaxone
    atc_code             VARCHAR(7) CHECK (atc_code ~ '^[A-Z]([0-9]{2}([A-Z]([A-Z]([0-9]{2})?)?)?)?$'),
    form_code            VARCHAR(20) NOT NULL REFERENCES med_dosage_forms(code),
    strength             TEXT,                                                   -- „1 გ“, „500 მგ/5 მლ“
    -- აქტიური ნივთიერება საბაზო ერთეულში (დოზის შემოწმებისთვის): მაგ. 1 ფლაკონი = 1000 mg
    dose_unit            VARCHAR(10) CHECK (dose_unit IN ('mg', 'mcg', 'g', 'IU', 'ml', 'mmol', 'mEq')),
    dose_per_unit        NUMERIC(14,4) CHECK (dose_per_unit > 0),
    routes               VARCHAR(10)[] NOT NULL DEFAULT '{}',
    controlled_class     VARCHAR(15) CHECK (controlled_class IN ('narcotic', 'psychotropic', 'precursor', 'potent')),
    high_alert           BOOLEAN NOT NULL DEFAULT FALSE,     -- მაღალი რისკის (კალიუმი, ინსულინი, ჰეპარინი…)
    reserve_antibiotic   BOOLEAN NOT NULL DEFAULT FALSE,     -- სარეზერვო: დანიშნულება დამატებით დამტკიცებას ითხოვს (სტაციონარის ეტაპი)
    patient_only         BOOLEAN NOT NULL DEFAULT FALSE,     -- გაიცემა მხოლოდ კონკრეტულ პაციენტზე (არა განყოფილების მარაგად)
    -- დოზის ზღვრები (dose_unit-ში)
    max_single_dose      NUMERIC(14,4) CHECK (max_single_dose > 0),
    max_daily_dose       NUMERIC(14,4) CHECK (max_daily_dose > 0),
    ped_max_single_per_kg NUMERIC(14,4) CHECK (ped_max_single_per_kg > 0),
    ped_max_daily_per_kg NUMERIC(14,4) CHECK (ped_max_daily_per_kg > 0),
    min_age_days         INT CHECK (min_age_days >= 0),
    notes                TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_by           UUID REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (max_daily_dose IS NULL OR max_single_dose IS NULL OR max_daily_dose >= max_single_dose),
    CHECK ((max_single_dose IS NULL AND max_daily_dose IS NULL AND ped_max_single_per_kg IS NULL AND ped_max_daily_per_kg IS NULL) OR dose_unit IS NOT NULL)
);
CREATE TRIGGER trg_med_generics_updated_at BEFORE UPDATE ON med_generics FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX ux_med_generics_active ON med_generics (lower(btrim(inn)), form_code, lower(coalesce(btrim(strength), ''))) WHERE is_active;
CREATE INDEX idx_med_generics_atc ON med_generics (atc_code);
CREATE INDEX idx_med_generics_inn ON med_generics (lower(inn) text_pattern_ops);

CREATE TABLE med_generic_allergens (
    generic_id   UUID NOT NULL REFERENCES med_generics(id) ON DELETE CASCADE,
    group_code   VARCHAR(50) NOT NULL REFERENCES allergen_groups(code) ON DELETE CASCADE,
    PRIMARY KEY (generic_id, group_code)
);

-- ---------------------------------------------------------------- ურთიერთქმედებები
CREATE TABLE med_interactions (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    a_generic_id     UUID REFERENCES med_generics(id),
    a_atc            VARCHAR(7) CHECK (a_atc ~ '^[A-Z]([0-9]{2}([A-Z]([A-Z]([0-9]{2})?)?)?)?$'),
    b_generic_id     UUID REFERENCES med_generics(id),
    b_atc            VARCHAR(7) CHECK (b_atc ~ '^[A-Z]([0-9]{2}([A-Z]([A-Z]([0-9]{2})?)?)?)?$'),
    severity         VARCHAR(20) NOT NULL CHECK (severity IN ('contraindicated', 'major', 'moderate', 'minor')),
    effect           TEXT NOT NULL CHECK (length(btrim(effect)) >= 3),
    recommendation   TEXT,
    source           VARCHAR(10) NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'external')),
    source_ref       TEXT,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((a_generic_id IS NULL) <> (a_atc IS NULL)),
    CHECK ((b_generic_id IS NULL) <> (b_atc IS NULL))
);
CREATE TRIGGER trg_med_interactions_updated_at BEFORE UPDATE ON med_interactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- ერთი წყვილი — ერთხელ (მიმართულების მიუხედავად)
CREATE UNIQUE INDEX ux_med_interactions_pair ON med_interactions (
    LEAST(coalesce(a_generic_id::text, 'ATC:' || a_atc), coalesce(b_generic_id::text, 'ATC:' || b_atc)),
    GREATEST(coalesce(a_generic_id::text, 'ATC:' || a_atc), coalesce(b_generic_id::text, 'ATC:' || b_atc))) WHERE is_active;

-- ---------------------------------------------------------------- საქონელი (SKU)
CREATE SEQUENCE stock_item_code_seq;
CREATE TABLE stock_items (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code              VARCHAR(30) NOT NULL UNIQUE DEFAULT ('I' || lpad(nextval('stock_item_code_seq')::text, 6, '0'))
                          CHECK (code ~ '^[A-Za-z0-9_.-]{2,30}$'),
    name              TEXT NOT NULL CHECK (length(btrim(name)) >= 2),      -- სავაჭრო დასახელება
    category_id       UUID NOT NULL REFERENCES stock_categories(id),
    generic_id        UUID REFERENCES med_generics(id),
    manufacturer      TEXT,
    country           TEXT,
    base_unit         VARCHAR(20) NOT NULL REFERENCES stock_units(code),
    requires_lot      BOOLEAN NOT NULL DEFAULT TRUE,
    requires_expiry   BOOLEAN NOT NULL DEFAULT TRUE,
    serial_tracked    BOOLEAN NOT NULL DEFAULT FALSE,
    storage           VARCHAR(10) NOT NULL DEFAULT 'room' CHECK (storage IN ('room', 'cool', 'fridge', 'frozen')),
    expiry_warn_days  SMALLINT CHECK (expiry_warn_days BETWEEN 0 AND 730),     -- NULL = კატეგორიის
    sale_price        NUMERIC(12,4) CHECK (sale_price >= 0),                   -- საბაზო ერთეულზე (ბილინგი: invoice)
    billing_mode      VARCHAR(10) CHECK (billing_mode IN ('none', 'invoice')), -- NULL = კატეგორიის
    notes             TEXT,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by        UUID REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (requires_lot OR NOT serial_tracked),
    CHECK (requires_lot OR NOT requires_expiry)
);
CREATE TRIGGER trg_stock_items_updated_at BEFORE UPDATE ON stock_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_stock_items_category ON stock_items (category_id);
CREATE INDEX idx_stock_items_generic ON stock_items (generic_id);
CREATE INDEX idx_stock_items_name ON stock_items (lower(name) text_pattern_ops);

-- მედიკამენტის კატეგორიაზე ჯენერიკი სავალდებულოა
CREATE OR REPLACE FUNCTION stock_items_check_generic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.generic_id IS NULL AND EXISTS (SELECT 1 FROM stock_categories c WHERE c.id = NEW.category_id AND c.kind = 'medication') THEN
        RAISE EXCEPTION 'მედიკამენტს ჯენერიკი (INN + ფორმა + დოზა) სავალდებულოა' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_items_generic_required';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_items_generic BEFORE INSERT OR UPDATE OF generic_id, category_id ON stock_items FOR EACH ROW EXECUTE FUNCTION stock_items_check_generic();

-- შეფუთვები: საბაზო ერთეული ყოველთვის 1; შეფუთვა = N საბაზო ერთეული (კოლოფი = 100 ტაბლეტი)
CREATE TABLE stock_item_packs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id         UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (length(btrim(name)) >= 1),            -- კოლოფი, ბლისტერი, ყუთი
    qty_base        NUMERIC(14,3) NOT NULL CHECK (qty_base > 1),
    is_receipt_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX ux_stock_item_packs_name ON stock_item_packs (item_id, lower(btrim(name))) WHERE is_active;
CREATE UNIQUE INDEX ux_stock_item_packs_qty ON stock_item_packs (item_id, qty_base) WHERE is_active;
CREATE UNIQUE INDEX ux_stock_item_packs_default ON stock_item_packs (item_id) WHERE is_active AND is_receipt_default;

-- შტრიხკოდები: GTIN/EAN — ნორმალიზებული GTIN-14-ად; pack_id NULL = საბაზო ერთეულის კოდი
CREATE TABLE stock_item_barcodes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id     UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    pack_id     UUID REFERENCES stock_item_packs(id),
    barcode     VARCHAR(60) NOT NULL CHECK (barcode ~ '^[A-Z0-9._/-]{4,60}$'),
    kind        VARCHAR(10) NOT NULL DEFAULT 'gtin' CHECK (kind IN ('gtin', 'internal')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_stock_item_barcodes_active ON stock_item_barcodes (barcode) WHERE is_active;
CREATE INDEX idx_stock_item_barcodes_item ON stock_item_barcodes (item_id);

-- ---------------------------------------------------------------- მომწოდებლები
CREATE TABLE stock_suppliers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    tax_id          VARCHAR(20) CHECK (tax_id ~ '^[0-9]{9,11}$'),            -- საიდენტიფიკაციო კოდი / პ/ნ
    vat_payer       BOOLEAN NOT NULL DEFAULT TRUE,
    address         TEXT,
    phone           TEXT,
    email           CITEXT,
    contact_person  TEXT,
    notes           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_stock_suppliers_updated_at BEFORE UPDATE ON stock_suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX ux_stock_suppliers_tax ON stock_suppliers (tax_id) WHERE tax_id IS NOT NULL;

-- ---------------------------------------------------------------- ლოკაციები
CREATE TABLE stock_locations (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code               VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name               TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    kind               VARCHAR(15) NOT NULL CHECK (kind IN ('central', 'pharmacy', 'household', 'department', 'operating', 'cssd', 'lab', 'icu', 'other')),
    department_id      UUID REFERENCES departments(id),
    requires_approval  BOOLEAN NOT NULL DEFAULT TRUE,        -- განყოფილების მოთხოვნას ამტკიცებს ხელმძღვანელი (ნარკოტიკულზე — ყოველთვის)
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order         INT NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_stock_locations_updated_at BEFORE UPDATE ON stock_locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_stock_locations_department ON stock_locations (department_id);
INSERT INTO stock_locations (code, name, kind, requires_approval, sort_order) VALUES
 ('PHARMACY', 'აფთიაქი', 'pharmacy', FALSE, 10),
 ('HOUSEHOLD', 'სამეურნეო საწყობი', 'household', FALSE, 20);
-- თითო ქვესაწყობი თითო აქტიურ კლინიკურ განყოფილებაზე (ახალს — „ლოკაციები“ ჩანართიდან)
INSERT INTO stock_locations (code, name, kind, department_id, sort_order)
SELECT left('D_' || regexp_replace(upper(d.code), '[^A-Z0-9_]', '_', 'g'), 30), d.name, 'department', d.id, 100
FROM departments d WHERE d.is_active AND d.type <> 'administrative'
ON CONFLICT (code) DO NOTHING;
