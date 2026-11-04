-- 0089_er_orders.sql
-- გადაუდებელი დახმარება (ER), ეტაპი 2 / 4 — კლინიკური ნაწილი (II): დანიშვნა / მიცემა / ჩამოწერა (ყოფილი „0088b“).
--
--  • er_orders — ER-ის მარტივი დანიშნულება (სტაციონარის med_orders / mar-ის გარეშე — ER inpatient-ზე არ არის დამოკიდებული):
--      სახე: medication / infusion / procedure; ტიპი: stat / once / prn (PRN — prn_max_h საათით, შემდეგ expired);
--      მედიკამენტი — კატალოგიდან (med_generics, საწყობის ნომენკლატურა) ან თავისუფალი ტექსტით; ზეპირი — ექთანი ექიმის სახელით (დადასტურება verbal_confirm_h-ში).
--  • er_administrations — მიცემა / შესრულება: given / partial / held / refused (მიზეზით), ინფუზია — start / stop;
--      ჩამოწერა (stock აქტიური) — ER-ის განყოფილების ქვესაწყობიდან (FEFO, პაციენტზე) — stock_doc_id; გაუქმება — შემობრუნებით.
--  • ER-ის პარამეტრები: prn_max_h, verbal_orders, verbal_confirm_h, double_check, dose_rule, allow_no_stock, stock_deduct, stat_due_min.
--  • რბილი კავშირები (კოდში, რეესტრი): er → stock (ჩამოწერა), er → pharmacy (დოზის ზღვრები / ურთიერთქმედება).

-- ================================================================ 1. დანიშნულება
CREATE TABLE er_orders (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id         UUID NOT NULL REFERENCES er_visits(encounter_id),
    patient_id           UUID NOT NULL REFERENCES patients(id),
    kind                 VARCHAR(12) NOT NULL CHECK (kind IN ('medication', 'infusion', 'procedure')),
    order_type           VARCHAR(8)  NOT NULL CHECK (order_type IN ('stat', 'once', 'prn')),
    generic_id           UUID REFERENCES med_generics(id),
    drug_text            VARCHAR(300),
    dose                 NUMERIC(14, 4) CHECK (dose > 0),
    dose_unit            VARCHAR(10),
    route_code           VARCHAR(10) REFERENCES med_routes(code),
    weight_kg            NUMERIC(6, 2),
    volume_ml            NUMERIC(8, 1) CHECK (volume_ml > 0),
    rate_ml_h            NUMERIC(8, 1) CHECK (rate_ml_h > 0),
    diluent              VARCHAR(200),
    prn_reason           VARCHAR(300),
    prn_min_interval_h   NUMERIC(5, 1) CHECK (prn_min_interval_h > 0),
    prn_max_doses        SMALLINT CHECK (prn_max_doses BETWEEN 1 AND 48),
    expires_at           TIMESTAMPTZ,                                   -- PRN: შექმნიდან prn_max_h
    text                 VARCHAR(2000),                                 -- პროცედურა (აღწერა)
    instructions         VARCHAR(2000),
    high_alert           BOOLEAN NOT NULL DEFAULT FALSE,                -- ჯენერიკიდან (შექმნისას)
    controlled_class     VARCHAR(20),
    status               VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped', 'expired')),
    is_verbal            BOOLEAN NOT NULL DEFAULT FALSE,
    verbal_due_at        TIMESTAMPTZ,
    verbal_confirmed_at  TIMESTAMPTZ,
    verbal_confirmed_by  UUID REFERENCES users(id),
    ordered_by           UUID NOT NULL REFERENCES users(id),
    entered_by           UUID NOT NULL REFERENCES users(id),
    checks               JSONB NOT NULL DEFAULT '[]',
    override_reason      VARCHAR(1000),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at           TIMESTAMPTZ,
    stopped_by           UUID REFERENCES users(id),
    stop_reason          VARCHAR(1000),
    CONSTRAINT chk_er_order_drug CHECK (kind = 'procedure' OR ((generic_id IS NOT NULL) <> (drug_text IS NOT NULL))),
    CONSTRAINT chk_er_order_proc CHECK (kind <> 'procedure' OR (text IS NOT NULL AND generic_id IS NULL AND drug_text IS NULL)),
    CONSTRAINT chk_er_order_med  CHECK (kind = 'procedure' OR route_code IS NOT NULL),
    CONSTRAINT chk_er_order_prn  CHECK (order_type <> 'prn' OR (prn_reason IS NOT NULL AND expires_at IS NOT NULL)),
    CONSTRAINT chk_er_order_end  CHECK ((status = 'active') = (stopped_at IS NULL)),
    CONSTRAINT chk_er_order_verbal CHECK (NOT is_verbal OR verbal_due_at IS NOT NULL)
);
CREATE INDEX idx_er_orders_enc ON er_orders (encounter_id, created_at);
CREATE INDEX idx_er_orders_active ON er_orders (encounter_id) WHERE status = 'active';
CREATE INDEX idx_er_orders_verbal ON er_orders (ordered_by) WHERE is_verbal AND verbal_confirmed_at IS NULL;

-- ================================================================ 2. მიცემა / შესრულება
CREATE TABLE er_administrations (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id          UUID NOT NULL REFERENCES er_orders(id),
    encounter_id      UUID NOT NULL REFERENCES er_visits(encounter_id),
    patient_id        UUID NOT NULL REFERENCES patients(id),
    outcome           VARCHAR(8) NOT NULL CHECK (outcome IN ('given', 'partial', 'held', 'refused')),
    infusion_action   VARCHAR(6) CHECK (infusion_action IN ('start', 'stop')),
    administered_at   TIMESTAMPTZ NOT NULL,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    documented_by     UUID NOT NULL REFERENCES users(id),
    dose              NUMERIC(14, 4),
    dose_unit         VARCHAR(10),
    route_code        VARCHAR(10) REFERENCES med_routes(code),
    rate_ml_h         NUMERIC(8, 1),
    site              VARCHAR(100),
    reason            VARCHAR(1000),                                  -- უარი / გადადება / შენიშვნა
    stock_doc_id      UUID REFERENCES stock_docs(id),
    stock_item_id     UUID REFERENCES stock_items(id),
    qty_base          NUMERIC(14, 3),
    witness_id        UUID REFERENCES users(id),
    double_check_by   UUID REFERENCES users(id),
    no_stock          BOOLEAN NOT NULL DEFAULT FALSE,
    warnings          JSONB NOT NULL DEFAULT '[]',
    override_reason   VARCHAR(1000),
    voided_at         TIMESTAMPTZ,
    voided_by         UUID REFERENCES users(id),
    void_reason       VARCHAR(1000),
    void_stock_doc_id UUID REFERENCES stock_docs(id),
    CONSTRAINT chk_er_adm_reason CHECK (outcome NOT IN ('held', 'refused') OR reason IS NOT NULL),
    CONSTRAINT chk_er_adm_void CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX idx_er_adm_order ON er_administrations (order_id, administered_at);
CREATE INDEX idx_er_adm_enc ON er_administrations (encounter_id);

-- ================================================================ 3. ER-ის პარამეტრები (არსებული მნიშვნელობები არ იცვლება)
UPDATE system_modules SET settings = '{
    "prn_max_h": 12,
    "verbal_orders": true,
    "verbal_confirm_h": 4,
    "double_check": "off",
    "dose_rule": "warn",
    "allow_no_stock": true,
    "stock_deduct": true,
    "stat_due_min": 15
}'::jsonb || settings
WHERE code = 'er';

UPDATE system_modules SET description = 'ER: რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი (ESI / MTS / საკუთარი), დაფა / TV, ადგილები; ჩანაწერი, დიაგნოსტიკა, კონსულტაცია; დანიშვნა / მიცემა / ჩამოწერა'
WHERE code = 'er';
