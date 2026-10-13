-- 0054_tariffs.sql
-- ფინანსები და შესყიდვები, ეტაპი 4 (ბოლო) — სატარიფო ფენა. ახალი მოდული „tariffs“ (ადმინისტრირება → მოდულები → ტარიფები; არ ითიშება).
--
--  ნაწილი A — ფასთა ნუსხები
--  • #3 ნუსხა (tariff_lists): საბაზო (ერთი) / განყოფილების (თითო განყოფილებას — ერთი) / გადამხდელის (ხელშეკრულების ფასები; თითო გადამხდელს — ერთი).
--      ჩანაწერი (tariff_list_items): ტარიფი (service_tariffs — მომსახურება, კონსულტაცია, საწოლდღე, ოპერაცია, ანესთეზია, კვლევა …) /
--      საქონელი (ფასი) / საქონლის კატეგორია (ფასნამატი %); მოქმედების ვადა valid_from / valid_to ჩანაწერის დონეზე (NULL — შეუზღუდავი);
--      ერთ ნუსხაში ერთ ერთეულზე ვადები არ იფარება (EXCLUDE); შეცვლილი სამომავლო ჩანაწერი რჩება „superseded“ (ისტორია, ხაზის მითითება).
--  • #4 ძებნა — SQL: tariff_resolve (გადამხდელი → განყოფილება → საბაზო), tariff_line_price (ინვოისის კონტექსტით), tariff_stock_price;
--      ხაზზე იწერება price_item_id (საიდან მოვიდა ფასი).
--  • #5 ფასის თარიღი — ხაზის service_date (საწოლდღე / ვენტილაცია — თავისი დღის, ოპერაცია — ოპერაციის დღის).
--  • #6 გადამხდელის ფასი (payer_price_mode = primary): სტაციონარი — stay_payers-ის პირველი (seq), ამბულატორია — insurance_payer_id,
--      მერე state_payer_id; ამ გადამხდელისთვის გამორიცხული კატეგორია / კოდი → განყოფილების / საბაზო ფასი; off — გადამხდელის ნუსხა არ გამოიყენება.
--  • #7 ფასი ვერ მოიძებნა — ქცევა უცვლელია (გადაცემული ფასი რჩება).
--  • #8 პაკეტი (billing_packages.price) და DRG — უცვლელად, ნუსხის გარეთ.
--  • #9 მიგრაცია: service_tariffs.base_price, stock_items.sale_price, stock_categories.markup_pct → საბაზო ნუსხა (valid_from = NULL);
--      ძველი API ჩაწერს ახალ ფენაშიც (ტრიგერები: ცვლილება — დღეიდან), ძველი სვეტები = საბაზო ნუსხის მიმდინარე ფასი (სარკე).
--      ექიმის კონსულტაცია (users.consultation_tariff_id), საწოლდღე (bed_day_tariffs), ანესთეზია (or_anesthesia_tariffs) — ტარიფებზე
--      მიმართვაა, ფასი — ტარიფის ჩანაწერში; განყოფილების საკუთარი საწოლდღის ტარიფი (bed_day_tariffs.department_id) — უცვლელად.
--  • #10–#11 ფასი ფიქსირდება ხაზის შექმნისას (ტრიგერი trg_invoice_lines_zprice + სინქრონიზაციის ფუნქციები); „გადაფასება“ — ცალკე
--      (invoice_line_reprices: ძველი / ახალი ფასი, მიზეზი, ვინ) — ფინალიზებული (invoice_finalized), დახურული პერიოდი (period_locked),
--      ქლეიმში შემავალი — 409; გადამხდელის ცვლილებისას — reprice_on_payer_change (auto_unpaid / manual).
--  • #18–#20 ცვლილება (tariff_changes, TC26-000001): tariff_change_approval = off — მაშინვე; required — მეორე პირი (tariffs_approve / admin,
--      არა ავტორი); valid_from ≥ დღეს. ძველი API-ით ფასის პირდაპირი ცვლილება required-ზე → 409 (tariff_approval_required).
--  ნაწილი B (0054a) — გადამხდელის წესები
--  • #12–#13 ვერსიები (payer_rule_versions): ნაგულისხმევი პირობები (%, ლიმიტი, ფრანშიზა, ფიქს. / DRG, თანაგადახდა, გამორიცხული
--      კატეგორიები / კოდები) + დალაგებული პუნქტები (payer_rule_clauses: კატეგორია / კოდი, ასაკი, სქესი, ICD-10 პრეფიქსი → გამორიცხვა /
--      სხვა % / ხაზის ლიმიტი; პირველი შესაბამისი). ვერსია 1 — payers.default_*-დან; stay_payers.rule_version_id.
--  • #14 ლიმიტი / ფრანშიზა / თანაგადახდა — შემთხვევაზე. #15 დიაგნოზი — ვიზიტის / ჰოსპიტალიზაციის diagnoses.
--  • #16 ხაზობრივი წილი (invoice_line_shares) — სტაციონარის ფინალიზაციისას და ამბ. წესებით გაანგარიშებისას; შემოსავლის რეპორტი იყენებს.
--  • #17 opd_payer_mode = rules: ამბ. წილი — ძრავით (ხაზის / გადამხდელის ცვლილება → payer_shares_stale; გადათვლა ნახვისას / გადახდისას /
--      worker-ში); ხელით შესწორება მიზეზით (payer_shares_manual) → „წესებით აღდგენა“.

-- ================================================================ 0. მოდული, უფლებები
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('tariffs', 'ტარიფები', 'ფასთა ნუსხები (საბაზო / განყოფილება / გადამხდელი) მოქმედების ვადით, გადამხდელის წესების ვერსიები, გადაფასება, ფასის ცვლილების დამტკიცება, ამბულატორიის წილი წესებით',
 TRUE, FALSE,
 '{"tariff_change_approval": "off",
   "opd_payer_mode": "manual",
   "payer_price_mode": "primary",
   "reprice_on_payer_change": "auto_unpaid"}', 42)
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
        'tariffs', 'tariffs_approve']::VARCHAR(30)[]);

CREATE OR REPLACE FUNCTION tariff_settings() RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT settings FROM system_modules WHERE code = 'tariffs'), '{}'::jsonb)
$$;

-- ================================================================ 1. ცვლილების მოთხოვნა (დამტკიცება)
CREATE TABLE tariff_changes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    change_no       VARCHAR(20) NOT NULL UNIQUE,
    kind            VARCHAR(6) NOT NULL CHECK (kind IN ('prices', 'rules')),
    status          VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
    title           TEXT NOT NULL CHECK (length(btrim(title)) >= 3),
    reason          TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    source          VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'legacy')),
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by      UUID REFERENCES users(id),
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT,
    applied_at      TIMESTAMPTZ,
    approval        VARCHAR(8) NOT NULL DEFAULT 'off' CHECK (approval IN ('off', 'required')),   -- რეჟიმი შექმნისას
    CONSTRAINT chk_tc_decided CHECK (status = 'pending' OR decided_at IS NOT NULL),
    CONSTRAINT chk_tc_reject CHECK (status NOT IN ('rejected', 'cancelled') OR length(btrim(coalesce(decision_note, ''))) >= 3),
    CONSTRAINT chk_tc_second CHECK (approval = 'off' OR status <> 'applied' OR decided_by IS DISTINCT FROM created_by)
);
CREATE INDEX idx_tariff_changes_status ON tariff_changes (status, created_at DESC);

-- ================================================================ 2. ნუსხები და ჩანაწერები
CREATE TABLE tariff_lists (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{1,29}$'),
    name            TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    scope           VARCHAR(10) NOT NULL CHECK (scope IN ('base', 'department', 'payer')),
    department_id   UUID REFERENCES departments(id),
    payer_id        UUID REFERENCES payers(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_tl_scope CHECK ((scope = 'base' AND department_id IS NULL AND payer_id IS NULL)
                                OR (scope = 'department' AND department_id IS NOT NULL AND payer_id IS NULL)
                                OR (scope = 'payer' AND payer_id IS NOT NULL AND department_id IS NULL)),
    CONSTRAINT chk_tl_base_active CHECK (scope <> 'base' OR is_active)
);
CREATE UNIQUE INDEX ux_tariff_lists_base ON tariff_lists (scope) WHERE scope = 'base';
CREATE UNIQUE INDEX ux_tariff_lists_dept ON tariff_lists (department_id) WHERE scope = 'department';
CREATE UNIQUE INDEX ux_tariff_lists_payer ON tariff_lists (payer_id) WHERE scope = 'payer';

CREATE TABLE tariff_list_items (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    list_id            UUID NOT NULL REFERENCES tariff_lists(id),
    kind               VARCHAR(14) NOT NULL CHECK (kind IN ('tariff', 'stock_item', 'stock_category')),
    tariff_id          UUID REFERENCES service_tariffs(id),
    stock_item_id      UUID REFERENCES stock_items(id),
    stock_category_id  UUID REFERENCES stock_categories(id),
    ref                UUID GENERATED ALWAYS AS (coalesce(tariff_id, stock_item_id, stock_category_id)) STORED,
    price              NUMERIC(12,2) CHECK (price >= 0 AND price <= 99999999),
    markup_pct         NUMERIC(7,2) CHECK (markup_pct >= 0 AND markup_pct <= 1000),
    valid_from         DATE,                                                   -- NULL — შეუზღუდავი (მიგრაციის ჩანაწერი)
    valid_to           DATE,
    superseded         BOOLEAN NOT NULL DEFAULT FALSE,                         -- შეცვლილი სამომავლო / იმავე დღის ჩანაწერი
    change_id          UUID REFERENCES tariff_changes(id),
    created_by         UUID REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_tli_kind CHECK (
        (kind = 'tariff' AND tariff_id IS NOT NULL AND stock_item_id IS NULL AND stock_category_id IS NULL AND price IS NOT NULL AND markup_pct IS NULL)
     OR (kind = 'stock_item' AND stock_item_id IS NOT NULL AND tariff_id IS NULL AND stock_category_id IS NULL AND price IS NOT NULL AND markup_pct IS NULL)
     OR (kind = 'stock_category' AND stock_category_id IS NOT NULL AND tariff_id IS NULL AND stock_item_id IS NULL AND markup_pct IS NOT NULL AND price IS NULL)),
    CONSTRAINT chk_tli_range CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT ex_tariff_list_items EXCLUDE USING gist (list_id WITH =, ref WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (NOT superseded)
);
CREATE INDEX idx_tli_lookup ON tariff_list_items (list_id, ref) WHERE NOT superseded;
CREATE INDEX idx_tli_ref ON tariff_list_items (ref);
CREATE INDEX idx_tli_change ON tariff_list_items (change_id) WHERE change_id IS NOT NULL;

CREATE TABLE tariff_change_items (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    change_id          UUID NOT NULL REFERENCES tariff_changes(id) ON DELETE CASCADE,
    list_id            UUID NOT NULL REFERENCES tariff_lists(id),
    kind               VARCHAR(14) NOT NULL CHECK (kind IN ('tariff', 'stock_item', 'stock_category')),
    ref                UUID NOT NULL,
    action             VARCHAR(4) NOT NULL CHECK (action IN ('set', 'end')),
    price              NUMERIC(12,2) CHECK (price >= 0 AND price <= 99999999),
    markup_pct         NUMERIC(7,2) CHECK (markup_pct >= 0 AND markup_pct <= 1000),
    valid_from         DATE NOT NULL,
    prev_price         NUMERIC(12,2),                                          -- ამ თარიღზე მოქმედი (ჩვენებისთვის)
    prev_markup        NUMERIC(7,2),
    CONSTRAINT chk_tci_value CHECK (action = 'end' OR (kind = 'stock_category') = (markup_pct IS NOT NULL AND price IS NULL)),
    CONSTRAINT chk_tci_set CHECK (action = 'end' OR price IS NOT NULL OR markup_pct IS NOT NULL)
);
CREATE INDEX idx_tci_change ON tariff_change_items (change_id);

-- ერთეულის მოქმედი ჩანაწერი ნუსხაში თარიღზე
CREATE OR REPLACE FUNCTION tariff_find(p_list UUID, p_ref UUID, p_date DATE) RETURNS tariff_list_items LANGUAGE sql STABLE AS $$
    SELECT i.* FROM tariff_list_items i
     WHERE i.list_id = p_list AND i.ref = p_ref AND NOT i.superseded
       AND (i.valid_from IS NULL OR i.valid_from <= p_date) AND (i.valid_to IS NULL OR i.valid_to >= p_date)
     ORDER BY i.valid_from DESC NULLS LAST LIMIT 1
$$;

-- ძებნა: გადამხდელი → განყოფილება → საბაზო (აქტიური ნუსხები)
CREATE OR REPLACE FUNCTION tariff_resolve(p_ref UUID, p_date DATE, p_dept UUID, p_payer UUID)
RETURNS TABLE (item_id UUID, price NUMERIC, markup_pct NUMERIC, scope TEXT, list_id UUID) LANGUAGE sql STABLE AS $$
    SELECT x.id, x.price, x.markup_pct, l.scope::text, l.id
      FROM tariff_lists l
      CROSS JOIN LATERAL tariff_find(l.id, p_ref, coalesce(p_date, fin_local_date(now()))) x
     WHERE l.is_active AND x.id IS NOT NULL
       AND ((l.scope = 'payer' AND p_payer IS NOT NULL AND l.payer_id = p_payer)
         OR (l.scope = 'department' AND p_dept IS NOT NULL AND l.department_id = p_dept)
         OR l.scope = 'base')
     ORDER BY CASE l.scope WHEN 'payer' THEN 1 WHEN 'department' THEN 2 ELSE 3 END
     LIMIT 1
$$;

-- ================================================================ 3. გადამხდელის წესების ვერსიები (ნაწილი B)
CREATE TABLE payer_rule_versions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payer_id            UUID NOT NULL REFERENCES payers(id),
    version_no          INT NOT NULL CHECK (version_no >= 1),
    status              VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'active', 'rejected')),
    valid_from          DATE,                                                  -- NULL — ვერსია 1 (მიგრაცია)
    applies_to          VARCHAR(4) NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'opd', 'ipd')),
    mode                VARCHAR(8) NOT NULL CHECK (mode IN ('percent', 'fixed', 'drg')),
    coverage_pct        NUMERIC(5,2) NOT NULL CHECK (coverage_pct BETWEEN 0 AND 100),
    limit_amount        NUMERIC(10,2) CHECK (limit_amount >= 0),
    deductible          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (deductible >= 0),
    fixed_amount        NUMERIC(10,2) CHECK (fixed_amount >= 0),
    drg_base_rate       NUMERIC(10,2) CHECK (drg_base_rate > 0),
    writeoff_excess     BOOLEAN NOT NULL DEFAULT FALSE,
    copay_amount        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (copay_amount >= 0),   -- თანაგადახდა შემთხვევაზე (პაციენტი)
    excluded_categories TEXT[] NOT NULL DEFAULT '{}',
    excluded_codes      TEXT[] NOT NULL DEFAULT '{}',                                  -- service_tariffs.code
    notes               TEXT,
    change_id           UUID REFERENCES tariff_changes(id),
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (payer_id, version_no),
    CONSTRAINT chk_prv_drg CHECK (mode <> 'drg' OR drg_base_rate IS NOT NULL)
);
CREATE UNIQUE INDEX ux_prv_active_from ON payer_rule_versions (payer_id, coalesce(valid_from, '1900-01-01'::date)) WHERE status = 'active';

CREATE TABLE payer_rule_clauses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id      UUID NOT NULL REFERENCES payer_rule_versions(id) ON DELETE CASCADE,
    seq             SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 99),
    label           TEXT,
    categories      TEXT[] NOT NULL DEFAULT '{}',                              -- ცარიელი — ყველა
    codes           TEXT[] NOT NULL DEFAULT '{}',                              -- ცარიელი — ყველა
    age_min         SMALLINT CHECK (age_min BETWEEN 0 AND 130),
    age_max         SMALLINT CHECK (age_max BETWEEN 0 AND 130),
    sex             VARCHAR(6) CHECK (sex IN ('male', 'female')),
    dx_prefixes     TEXT[] NOT NULL DEFAULT '{}',                              -- ICD-10 პრეფიქსი (ერთ-ერთი)
    effect          VARCHAR(7) NOT NULL CHECK (effect IN ('exclude', 'cover')),
    coverage_pct    NUMERIC(5,2) CHECK (coverage_pct BETWEEN 0 AND 100),
    line_limit      NUMERIC(10,2) CHECK (line_limit >= 0),
    UNIQUE (version_id, seq),
    CONSTRAINT chk_prc_age CHECK (age_min IS NULL OR age_max IS NULL OR age_max >= age_min)
);

-- ვერსია 1 — ნაგულისხმევი პირობებიდან
INSERT INTO payer_rule_versions (payer_id, version_no, status, valid_from, mode, coverage_pct, limit_amount, deductible, drg_base_rate, writeoff_excess, excluded_categories)
SELECT id, 1, 'active', NULL, default_mode, default_coverage_pct, default_limit, default_deductible, drg_base_rate, writeoff_excess, excluded_categories FROM payers;

-- მოქმედი ვერსია თარიღზე
CREATE OR REPLACE FUNCTION payer_rule_version_at(p_payer UUID, p_date DATE, p_setting TEXT) RETURNS payer_rule_versions LANGUAGE sql STABLE AS $$
    SELECT v.* FROM payer_rule_versions v
     WHERE v.payer_id = p_payer AND v.status = 'active' AND (v.valid_from IS NULL OR v.valid_from <= coalesce(p_date, fin_local_date(now())))
       AND (p_setting IS NULL OR v.applies_to IN ('all', p_setting))
     ORDER BY v.valid_from DESC NULLS LAST LIMIT 1
$$;

ALTER TABLE stay_payers ADD COLUMN rule_version_id UUID REFERENCES payer_rule_versions(id);
UPDATE stay_payers sp SET rule_version_id = v.id FROM payer_rule_versions v WHERE v.payer_id = sp.payer_id AND v.version_no = 1;

-- ================================================================ 4. საბაზო ნუსხა და მიგრაცია
INSERT INTO tariff_lists (code, name, scope) VALUES ('BASE', 'საბაზო ფასები', 'base');

INSERT INTO tariff_list_items (list_id, kind, tariff_id, price)
SELECT l.id, 'tariff', t.id, t.base_price FROM service_tariffs t CROSS JOIN tariff_lists l WHERE l.scope = 'base';
INSERT INTO tariff_list_items (list_id, kind, stock_item_id, price)
SELECT l.id, 'stock_item', i.id, round(i.sale_price, 2) FROM stock_items i CROSS JOIN tariff_lists l WHERE l.scope = 'base' AND i.sale_price IS NOT NULL;
INSERT INTO tariff_list_items (list_id, kind, stock_category_id, markup_pct)
SELECT l.id, 'stock_category', c.id, c.markup_pct FROM stock_categories c CROSS JOIN tariff_lists l WHERE l.scope = 'base' AND c.markup_pct IS NOT NULL;

-- ================================================================ 5. ცვლილების გატარება (ერთადერთი გზა ჩანაწერის შესაცვლელად)
-- p_price / p_markup — NULL ორივე: „დასრულება“ p_from-იდან (ერთეული ამ ნუსხიდან ქრება → შემდეგი დონე).
-- p_from-ზე / შემდეგ დაწყებული ჩანაწერები → superseded; p_from-ს გადამფარავი → valid_to = p_from − 1.
CREATE OR REPLACE FUNCTION tariff_set_item(p_list UUID, p_kind TEXT, p_ref UUID, p_price NUMERIC, p_markup NUMERIC, p_from DATE, p_change UUID, p_by UUID)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_scope TEXT; v_today DATE := fin_local_date(now());
BEGIN
    SELECT scope INTO v_scope FROM tariff_lists WHERE id = p_list;
    UPDATE tariff_list_items SET superseded = TRUE
     WHERE list_id = p_list AND ref = p_ref AND NOT superseded AND valid_from IS NOT NULL AND valid_from >= p_from;
    UPDATE tariff_list_items SET valid_to = p_from - 1
     WHERE list_id = p_list AND ref = p_ref AND NOT superseded AND (valid_from IS NULL OR valid_from < p_from) AND (valid_to IS NULL OR valid_to >= p_from);
    IF p_price IS NOT NULL OR p_markup IS NOT NULL THEN
        INSERT INTO tariff_list_items (list_id, kind, tariff_id, stock_item_id, stock_category_id, price, markup_pct, valid_from, change_id, created_by)
        VALUES (p_list, p_kind, CASE WHEN p_kind = 'tariff' THEN p_ref END, CASE WHEN p_kind = 'stock_item' THEN p_ref END,
                CASE WHEN p_kind = 'stock_category' THEN p_ref END,
                CASE WHEN p_kind <> 'stock_category' THEN round(p_price, 2) END, CASE WHEN p_kind = 'stock_category' THEN p_markup END,
                p_from, p_change, p_by)
        RETURNING id INTO v_id;
    END IF;
    IF v_scope = 'base' AND p_from <= v_today THEN PERFORM tariff_sync_base(p_ref); END IF;
    RETURN v_id;
END $$;

-- საბაზო ნუსხის მიმდინარე ფასი → ძველ სვეტებში (სარკე); p_ref = NULL — ყველა (worker: სამომავლო ცვლილება ამოქმედდა)
CREATE OR REPLACE FUNCTION tariff_sync_base(p_ref UUID DEFAULT NULL) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_list UUID; v_today DATE := fin_local_date(now()); v_n INT := 0; v_k INT;
BEGIN
    SELECT id INTO v_list FROM tariff_lists WHERE scope = 'base';
    PERFORM set_config('emr.tariff_apply', 'on', true);
    UPDATE service_tariffs t SET base_price = (SELECT f.price FROM tariff_find(v_list, t.id, v_today) f)
     WHERE (p_ref IS NULL OR t.id = p_ref) AND (SELECT f.price FROM tariff_find(v_list, t.id, v_today) f) IS NOT NULL
       AND t.base_price IS DISTINCT FROM (SELECT f.price FROM tariff_find(v_list, t.id, v_today) f);
    GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
    UPDATE stock_items i SET sale_price = (SELECT f.price FROM tariff_find(v_list, i.id, v_today) f)
     WHERE (p_ref IS NULL OR i.id = p_ref)
       AND round(i.sale_price, 2) IS DISTINCT FROM (SELECT f.price FROM tariff_find(v_list, i.id, v_today) f)
       AND (i.sale_price IS NOT NULL OR EXISTS (SELECT 1 FROM tariff_list_items x WHERE x.list_id = v_list AND x.ref = i.id));
    GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
    UPDATE stock_categories c SET markup_pct = (SELECT f.markup_pct FROM tariff_find(v_list, c.id, v_today) f)
     WHERE (p_ref IS NULL OR c.id = p_ref)
       AND c.markup_pct IS DISTINCT FROM (SELECT f.markup_pct FROM tariff_find(v_list, c.id, v_today) f)
       AND (c.markup_pct IS NOT NULL OR EXISTS (SELECT 1 FROM tariff_list_items x WHERE x.list_id = v_list AND x.ref = c.id));
    GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
    PERFORM set_config('emr.tariff_apply', '', true);
    RETURN v_n;
END $$;

-- ================================================================ 6. ძველი API → ახალი ფენა (ფასის ცვლილება — დღეიდან)
CREATE OR REPLACE FUNCTION tariff_legacy_guard() RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF coalesce(tariff_settings()->>'tariff_change_approval', 'off') = 'required' THEN
        RAISE EXCEPTION 'ფასის ცვლილება საჭიროებს დამტკიცებას — ადმინისტრირება → ტარიფები → ცვლილების მოთხოვნა'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'tariff_approval_required';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION tariff_legacy_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_list UUID; v_kind TEXT; v_new NUMERIC; v_old NUMERIC; v_user UUID;
BEGIN
    IF coalesce(current_setting('emr.tariff_apply', true), '') = 'on' THEN RETURN NULL; END IF;
    SELECT id INTO v_list FROM tariff_lists WHERE scope = 'base';
    v_user := nullif(current_setting('emr.user_id', true), '')::uuid;
    IF TG_TABLE_NAME = 'service_tariffs' THEN
        v_kind := 'tariff'; v_new := NEW.base_price; v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.base_price END;
    ELSIF TG_TABLE_NAME = 'stock_items' THEN
        v_kind := 'stock_item'; v_new := round(NEW.sale_price, 2); v_old := CASE WHEN TG_OP = 'UPDATE' THEN round(OLD.sale_price, 2) END;
    ELSE
        v_kind := 'stock_category'; v_new := NEW.markup_pct; v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.markup_pct END;
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- ახალი ერთეული: ისტორია არ აქვს — ფასი შეუზღუდავი ვადით
        IF v_new IS NOT NULL THEN
            INSERT INTO tariff_list_items (list_id, kind, tariff_id, stock_item_id, stock_category_id, price, markup_pct, created_by)
            VALUES (v_list, v_kind, CASE WHEN v_kind = 'tariff' THEN NEW.id END, CASE WHEN v_kind = 'stock_item' THEN NEW.id END,
                    CASE WHEN v_kind = 'stock_category' THEN NEW.id END, CASE WHEN v_kind <> 'stock_category' THEN v_new END,
                    CASE WHEN v_kind = 'stock_category' THEN v_new END, v_user);
        END IF;
    ELSIF v_new IS DISTINCT FROM v_old THEN
        PERFORM tariff_legacy_guard();
        PERFORM tariff_set_item(v_list, v_kind, NEW.id, CASE WHEN v_kind <> 'stock_category' THEN v_new END,
                                CASE WHEN v_kind = 'stock_category' THEN v_new END, fin_local_date(now()), NULL, v_user);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_service_tariffs_tariff AFTER INSERT OR UPDATE OF base_price ON service_tariffs FOR EACH ROW EXECUTE FUNCTION tariff_legacy_sync();
CREATE TRIGGER trg_stock_items_tariff AFTER INSERT OR UPDATE OF sale_price ON stock_items FOR EACH ROW EXECUTE FUNCTION tariff_legacy_sync();
CREATE TRIGGER trg_stock_categories_tariff AFTER INSERT OR UPDATE OF markup_pct ON stock_categories FOR EACH ROW EXECUTE FUNCTION tariff_legacy_sync();

-- გადამხდელის ნაგულისხმევი პირობები (ძველი API: ადმინისტრირება → სტაციონარის ბილინგი → გადამხდელები) → ახალი ვერსია დღეიდან
CREATE OR REPLACE FUNCTION payer_rules_legacy_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prev payer_rule_versions; v_id UUID; v_today DATE := fin_local_date(now()); v_no INT;
BEGIN
    IF coalesce(current_setting('emr.tariff_apply', true), '') = 'on' THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO payer_rule_versions (payer_id, version_no, status, valid_from, mode, coverage_pct, limit_amount, deductible, drg_base_rate, writeoff_excess, excluded_categories, created_by)
        VALUES (NEW.id, 1, 'active', NULL, NEW.default_mode, NEW.default_coverage_pct, NEW.default_limit, NEW.default_deductible, NEW.drg_base_rate, NEW.writeoff_excess,
                NEW.excluded_categories, nullif(current_setting('emr.user_id', true), '')::uuid);
        RETURN NULL;
    END IF;
    IF (NEW.default_mode, NEW.default_coverage_pct, NEW.default_limit, NEW.default_deductible, NEW.drg_base_rate, NEW.writeoff_excess, NEW.excluded_categories)
       IS NOT DISTINCT FROM (OLD.default_mode, OLD.default_coverage_pct, OLD.default_limit, OLD.default_deductible, OLD.drg_base_rate, OLD.writeoff_excess, OLD.excluded_categories) THEN
        RETURN NULL;
    END IF;
    PERFORM tariff_legacy_guard();
    v_prev := payer_rule_version_at(NEW.id, v_today, NULL);
    SELECT coalesce(max(version_no), 0) + 1 INTO v_no FROM payer_rule_versions WHERE payer_id = NEW.id;
    -- იმავე დღის ვერსია (დღეს უკვე შეცვლილი) — ჩანაცვლება
    IF v_prev.id IS NOT NULL AND v_prev.valid_from = v_today THEN
        UPDATE payer_rule_versions SET mode = NEW.default_mode, coverage_pct = NEW.default_coverage_pct, limit_amount = NEW.default_limit, deductible = NEW.default_deductible,
               drg_base_rate = NEW.drg_base_rate, writeoff_excess = NEW.writeoff_excess, excluded_categories = NEW.excluded_categories
         WHERE id = v_prev.id;
        RETURN NULL;
    END IF;
    UPDATE payer_rule_versions SET status = 'rejected', notes = coalesce(notes || ' · ', '') || 'ჩანაცვლდა ' || v_today
     WHERE payer_id = NEW.id AND status = 'active' AND valid_from > v_today;
    INSERT INTO payer_rule_versions (payer_id, version_no, status, valid_from, applies_to, mode, coverage_pct, limit_amount, deductible, fixed_amount, drg_base_rate, writeoff_excess,
           copay_amount, excluded_categories, excluded_codes, created_by)
    VALUES (NEW.id, v_no, 'active', v_today, coalesce(v_prev.applies_to, 'all'), NEW.default_mode, NEW.default_coverage_pct, NEW.default_limit, NEW.default_deductible,
            v_prev.fixed_amount, NEW.drg_base_rate, NEW.writeoff_excess, coalesce(v_prev.copay_amount, 0), NEW.excluded_categories, coalesce(v_prev.excluded_codes, '{}'),
            nullif(current_setting('emr.user_id', true), '')::uuid)
    RETURNING id INTO v_id;
    INSERT INTO payer_rule_clauses (version_id, seq, label, categories, codes, age_min, age_max, sex, dx_prefixes, effect, coverage_pct, line_limit)
    SELECT v_id, seq, label, categories, codes, age_min, age_max, sex, dx_prefixes, effect, coverage_pct, line_limit FROM payer_rule_clauses WHERE version_id = v_prev.id;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_payers_rules AFTER INSERT OR UPDATE ON payers FOR EACH ROW EXECUTE FUNCTION payer_rules_legacy_sync();

-- ================================================================ 7. ინვოისის ხაზი: ფასის წყარო, გადაფასება, წილები
ALTER TABLE invoice_line_items ADD COLUMN price_item_id UUID REFERENCES tariff_list_items(id);
CREATE INDEX idx_invoice_lines_price_item ON invoice_line_items (price_item_id) WHERE price_item_id IS NOT NULL;

ALTER TABLE stay_bed_days ADD COLUMN unit_price NUMERIC(10,2), ADD COLUMN price_item_id UUID REFERENCES tariff_list_items(id);
ALTER TABLE stay_vent_days ADD COLUMN unit_price NUMERIC(10,2), ADD COLUMN price_item_id UUID REFERENCES tariff_list_items(id);

ALTER TABLE invoices
    ADD COLUMN payer_shares_manual BOOLEAN NOT NULL DEFAULT FALSE,             -- ამბ. (rules): ბილინგმა წილი ხელით შეცვალა
    ADD COLUMN payer_shares_reason TEXT,
    ADD COLUMN payer_shares_stale  BOOLEAN NOT NULL DEFAULT FALSE,             -- ამბ. (rules): ხაზი / გადამხდელი შეიცვალა — გადასათვლელი
    ADD COLUMN payer_shares_at     TIMESTAMPTZ;                                -- ბოლო გაანგარიშება წესებით

CREATE TABLE invoice_line_reprices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_id         UUID NOT NULL REFERENCES invoice_line_items(id) ON DELETE CASCADE,
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    kind            VARCHAR(12) NOT NULL CHECK (kind IN ('manual', 'payer_change')),
    old_price       NUMERIC(10,2) NOT NULL,
    new_price       NUMERIC(10,2) NOT NULL,
    old_item_id     UUID REFERENCES tariff_list_items(id),
    new_item_id     UUID REFERENCES tariff_list_items(id),
    reason          TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_line_reprices_invoice ON invoice_line_reprices (invoice_id, created_at);

CREATE TABLE invoice_line_shares (
    line_id         UUID NOT NULL REFERENCES invoice_line_items(id) ON DELETE CASCADE,
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    kind            VARCHAR(10) NOT NULL CHECK (kind IN ('patient', 'insurance', 'state', 'other', 'writeoff')),
    payer_id        UUID REFERENCES payers(id),
    amount          NUMERIC(12,4) NOT NULL
);
CREATE UNIQUE INDEX ux_invoice_line_shares ON invoice_line_shares (line_id, kind, coalesce(payer_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_invoice_line_shares_invoice ON invoice_line_shares (invoice_id);

-- ქლეიმის დანაკლისი → პაციენტზე (0053): ხაზობრივი წილიც გადადის გადამხდელიდან პაციენტზე, პროპორციულად
CREATE OR REPLACE FUNCTION fin_line_shares_to_patient(p_invoice UUID, p_payer UUID, p_amount NUMERIC) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_tot NUMERIC;
BEGIN
    SELECT sum(amount) INTO v_tot FROM invoice_line_shares WHERE invoice_id = p_invoice AND payer_id = p_payer AND kind NOT IN ('patient', 'writeoff');
    IF coalesce(v_tot, 0) <= 0 OR coalesce(p_amount, 0) <= 0 THEN RETURN; END IF;
    WITH d AS (SELECT line_id, kind, amount * least(p_amount / v_tot, 1) AS delta FROM invoice_line_shares
                WHERE invoice_id = p_invoice AND payer_id = p_payer AND kind NOT IN ('patient', 'writeoff')),
         u AS (UPDATE invoice_line_shares s SET amount = s.amount - d.delta FROM d
                WHERE s.line_id = d.line_id AND s.payer_id = p_payer AND s.kind = d.kind RETURNING s.line_id, d.delta)
    INSERT INTO invoice_line_shares (line_id, invoice_id, kind, payer_id, amount)
    SELECT line_id, p_invoice, 'patient', NULL, sum(delta) FROM u GROUP BY line_id
    ON CONFLICT (line_id, kind, (coalesce(payer_id, '00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET amount = invoice_line_shares.amount + EXCLUDED.amount;
END $$;

-- ფასის გამოყენებადი გადამხდელი (#6): სტაციონარი — stay_payers-ის პირველი, ამბ. — დაზღვევა, მერე სახელმწიფო; გამორიცხული → NULL
CREATE OR REPLACE FUNCTION tariff_invoice_payer(p_invoice UUID, p_category TEXT, p_code TEXT, p_date DATE) RETURNS UUID LANGUAGE plpgsql STABLE AS $$
DECLARE v_enc UUID; v_ins UUID; v_state UUID; v_payer UUID; v_excl TEXT[]; v_codes TEXT[]; v_ver payer_rule_versions; v_ipd BOOLEAN;
BEGIN
    IF coalesce(tariff_settings()->>'payer_price_mode', 'primary') = 'off' THEN RETURN NULL; END IF;
    SELECT i.encounter_id, i.insurance_payer_id, i.state_payer_id, EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)
      INTO v_enc, v_ins, v_state, v_ipd FROM invoices i WHERE i.id = p_invoice;
    IF v_ipd THEN
        SELECT sp.payer_id, sp.excluded_categories, v.excluded_codes INTO v_payer, v_excl, v_codes
          FROM stay_payers sp LEFT JOIN payer_rule_versions v ON v.id = sp.rule_version_id
         WHERE sp.encounter_id = v_enc AND sp.status = 'active' ORDER BY sp.seq LIMIT 1;
    ELSE
        v_payer := coalesce(v_ins, v_state);
        IF v_payer IS NOT NULL THEN
            v_ver := payer_rule_version_at(v_payer, p_date, 'opd');
            v_excl := coalesce(v_ver.excluded_categories, (SELECT excluded_categories FROM payers WHERE id = v_payer));
            v_codes := v_ver.excluded_codes;
        END IF;
    END IF;
    IF v_payer IS NULL OR p_category = ANY (coalesce(v_excl, '{}')) OR (p_code IS NOT NULL AND p_code = ANY (coalesce(v_codes, '{}'))) THEN RETURN NULL; END IF;
    RETURN v_payer;
END $$;

-- ტარიფის ფასი ინვოისის კონტექსტით: განყოფილება (NULL — ვიზიტის / საწოლის განყოფილება ამ დღეს), გადამხდელი
CREATE OR REPLACE FUNCTION tariff_line_price(p_invoice UUID, p_tariff UUID, p_date DATE, p_dept UUID, p_category TEXT)
RETURNS TABLE (price NUMERIC, item_id UUID, scope TEXT) LANGUAGE plpgsql STABLE AS $$
DECLARE v_date DATE := coalesce(p_date, fin_local_date(now())); v_dept UUID := p_dept; v_code TEXT;
BEGIN
    IF v_dept IS NULL THEN
        SELECT fin_enc_department(i.encounter_id, v_date) INTO v_dept FROM invoices i WHERE i.id = p_invoice;
    END IF;
    SELECT t.code INTO v_code FROM service_tariffs t WHERE t.id = p_tariff;
    RETURN QUERY SELECT r.price, r.item_id, r.scope FROM tariff_resolve(p_tariff, v_date, v_dept, tariff_invoice_payer(p_invoice, p_category, v_code, v_date)) r;
END $$;

-- საქონლის ფასი: (გადამხდელი → განყოფილება → საბაზო) — საქონლის ფასი, თუ არა — კატეგორიის ფასნამატი × თვითღირებულება
CREATE OR REPLACE FUNCTION tariff_stock_price(p_invoice UUID, p_item UUID, p_unit_cost NUMERIC, p_date DATE)
RETURNS TABLE (price NUMERIC, item_id UUID, scope TEXT) LANGUAGE plpgsql STABLE AS $$
DECLARE v_date DATE := coalesce(p_date, fin_local_date(now())); v_dept UUID; v_payer UUID; v_cat UUID; v_catkind TEXT; v_category TEXT; l RECORD; x tariff_list_items;
BEGIN
    SELECT i.category_id, c.kind INTO v_cat, v_catkind FROM stock_items i JOIN stock_categories c ON c.id = i.category_id WHERE i.id = p_item;
    v_category := CASE v_catkind WHEN 'medication' THEN 'medication' WHEN 'medical_supply' THEN 'supply' WHEN 'implant' THEN 'implant' ELSE 'other' END;
    IF p_invoice IS NOT NULL THEN
        SELECT fin_enc_department(i.encounter_id, v_date) INTO v_dept FROM invoices i WHERE i.id = p_invoice;
        v_payer := tariff_invoice_payer(p_invoice, v_category, NULL, v_date);
    END IF;
    FOR l IN SELECT tl.id, tl.scope FROM tariff_lists tl
              WHERE tl.is_active AND ((tl.scope = 'payer' AND v_payer IS NOT NULL AND tl.payer_id = v_payer)
                 OR (tl.scope = 'department' AND v_dept IS NOT NULL AND tl.department_id = v_dept) OR tl.scope = 'base')
              ORDER BY CASE tl.scope WHEN 'payer' THEN 1 WHEN 'department' THEN 2 ELSE 3 END
    LOOP
        x := tariff_find(l.id, p_item, v_date);
        IF x.id IS NOT NULL THEN price := x.price; item_id := x.id; scope := l.scope; RETURN NEXT; RETURN; END IF;
        x := tariff_find(l.id, v_cat, v_date);
        IF x.id IS NOT NULL AND p_unit_cost IS NOT NULL THEN
            price := round(p_unit_cost * (1 + x.markup_pct / 100), 2); item_id := x.id; scope := l.scope; RETURN NEXT; RETURN;
        END IF;
    END LOOP;
END $$;

-- ხაზის შექმნისას ფასი ნუსხიდან (ტარიფიანი ხაზი; გადაცემული ფასი = original_price, ანუ „ნაგულისხმევი“ — არა ხელით შესწორებული)
CREATE OR REPLACE FUNCTION invoice_lines_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
    IF NEW.tariff_id IS NOT NULL AND NEW.price_item_id IS NULL AND NEW.adjusted_by IS NULL
       AND (NEW.original_price IS NULL OR NEW.original_price = NEW.unit_price)
       AND coalesce(current_setting('emr.price_keep', true), '') <> 'on' THEN
        SELECT * INTO r FROM tariff_line_price(NEW.invoice_id, NEW.tariff_id, NEW.service_date, NEW.ordering_department_id, NEW.category);
        IF r.item_id IS NOT NULL THEN
            NEW.unit_price := r.price; NEW.original_price := r.price; NEW.price_item_id := r.item_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_lines_zprice BEFORE INSERT ON invoice_line_items FOR EACH ROW EXECUTE FUNCTION invoice_lines_price();

-- ხაზის ახალი ფასი გადაფასებისთვის (ტარიფი / საქონელი); NULL — არ გადაფასდება
CREATE OR REPLACE FUNCTION tariff_reprice_quote(p_line UUID) RETURNS TABLE (price NUMERIC, item_id UUID) LANGUAGE plpgsql STABLE AS $$
DECLARE l invoice_line_items; d stock_doc_lines; r RECORD; v_qty NUMERIC;
BEGIN
    SELECT * INTO l FROM invoice_line_items WHERE id = p_line;
    IF NOT FOUND THEN RETURN; END IF;
    IF l.tariff_id IS NOT NULL THEN
        SELECT * INTO r FROM tariff_line_price(l.invoice_id, l.tariff_id, l.service_date, l.ordering_department_id, l.category);
        IF r.item_id IS NOT NULL THEN price := r.price; item_id := r.item_id; RETURN NEXT; END IF;
    ELSIF l.stock_doc_line_id IS NOT NULL THEN
        SELECT * INTO d FROM stock_doc_lines WHERE id = l.stock_doc_line_id;
        v_qty := nullif(d.qty_base, 0);
        SELECT * INTO r FROM tariff_stock_price(l.invoice_id, d.item_id, CASE WHEN v_qty IS NOT NULL THEN d.line_net / v_qty END, l.service_date);
        IF r.item_id IS NOT NULL THEN
            -- წილადი რაოდენობა — ერთი ხაზი ჯამური ფასით (0033)
            price := CASE WHEN v_qty IS NOT NULL AND v_qty <> trunc(v_qty) THEN round(r.price * v_qty, 2) ELSE r.price END;
            item_id := r.item_id; RETURN NEXT;
        END IF;
    END IF;
END $$;

-- ამბ. (opd_payer_mode = rules): ხაზის ცვლილება → წილი გადასათვლელია
CREATE OR REPLACE FUNCTION invoice_lines_shares_stale() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_inv UUID := coalesce(NEW.invoice_id, OLD.invoice_id);
BEGIN
    IF coalesce(tariff_settings()->>'opd_payer_mode', 'manual') = 'rules' THEN
        UPDATE invoices i SET payer_shares_stale = TRUE
         WHERE i.id = v_inv AND NOT i.payer_shares_stale AND NOT i.payer_shares_manual AND i.finalized_at IS NULL
           AND (i.insurance_payer_id IS NOT NULL OR i.state_payer_id IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_invoice_lines_shares AFTER INSERT OR DELETE OR UPDATE OF unit_price, quantity, package_included ON invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION invoice_lines_shares_stale();

-- ================================================================ 8. ავტომატური ხაზები — ფასი ნუსხიდან (დღის მიხედვით)
CREATE OR REPLACE FUNCTION ipd_sync_bed_days(p_enc uuid, p_tz text, p_leave_billable boolean)
 RETURNS integer LANGUAGE plpgsql AS $function$
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
    -- 0054: დღის ფასი — ნუსხიდან (დღე, განყოფილება, გადამხდელი); ვერ მოიძებნა — ტარიფის საბაზო ფასი
    UPDATE stay_bed_days d SET (unit_price, price_item_id) = (
           SELECT coalesce(r.price, s.base_price), r.item_id FROM service_tariffs s
             LEFT JOIN LATERAL tariff_line_price(v_inv.id, d.tariff_id, d.day, d.department_id, 'bed') r ON TRUE WHERE s.id = d.tariff_id)
     WHERE d.encounter_id = p_enc AND d.tariff_id IS NOT NULL;

    DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND category = 'bed';
    INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, package_included, service_date, price_item_id)
    SELECT v_inv.id, s.id, s.title || ' (საწოლდღე)', count(*)::int, d.unit_price, d.unit_price, 'bed', d.package_included, min(d.day), d.price_item_id
      FROM stay_bed_days d JOIN service_tariffs s ON s.id = d.tariff_id
     WHERE d.encounter_id = p_enc
     GROUP BY s.id, s.title, d.unit_price, d.price_item_id, d.package_included;
    PERFORM ipd_sync_vent_days(p_enc, p_tz);                                   -- 0047
    PERFORM or_sync_encounter_billing(p_enc, p_tz);                            -- 0050
    UPDATE stay_billing SET bed_days_synced_at = now() WHERE encounter_id = p_enc;
    RETURN v_n;
END $function$;

CREATE OR REPLACE FUNCTION ipd_sync_vent_days(p_enc uuid, p_tz text)
 RETURNS integer LANGUAGE plpgsql AS $function$
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
    -- 0054: დღის ფასი — ნუსხიდან
    UPDATE stay_vent_days d SET (unit_price, price_item_id) = (
           SELECT coalesce(r.price, s.base_price), r.item_id FROM service_tariffs s
             LEFT JOIN LATERAL tariff_line_price(v_inv.id, d.tariff_id, d.day, NULL, 'ventilation') r ON TRUE WHERE s.id = d.tariff_id)
     WHERE d.encounter_id = p_enc AND d.tariff_id IS NOT NULL;

    DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND category = 'ventilation';
    IF v_on AND v_tariff IS NOT NULL THEN
        INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, package_included, service_date, price_item_id)
        SELECT v_inv.id, s.id, s.title || ' (ხელოვნური ვენტილაციის დღე)', count(*)::int, d.unit_price, d.unit_price, 'ventilation', d.package_included, min(d.day), d.price_item_id
          FROM stay_vent_days d JOIN service_tariffs s ON s.id = d.tariff_id
         WHERE d.encounter_id = p_enc
         GROUP BY s.id, s.title, d.unit_price, d.price_item_id, d.package_included;
    END IF;
    RETURN v_n;
END $function$;

CREATE OR REPLACE FUNCTION or_sync_case_billing(p_case uuid, p_tz text)
 RETURNS integer LANGUAGE plpgsql AS $function$
DECLARE
    c        or_cases%ROWTYPE;
    v_inv    invoices%ROWTYPE;
    v_set    JSONB;
    v_mpb    TEXT;
    v_pct    NUMERIC;
    v_ab     TEXT;
    v_round  INT;
    v_procs  JSONB;
    v_day    DATE;
    v_type   TEXT;
    v_missing TEXT[] := '{}';
    v_i      INT := 0;
    v_price  NUMERIC(10,2);
    v_base   NUMERIC(10,2);
    v_item   UUID;
    v_as     TIMESTAMPTZ;
    v_ae     TIMESTAMPTZ;
    v_min    INT;
    v_units  INT;
    v_n      INT;
    p        RECORD;
    t        RECORD;
    r        RECORD;
BEGIN
    SELECT * INTO c FROM or_cases WHERE id = p_case;
    IF NOT FOUND OR c.encounter_id IS NULL THEN RETURN 0; END IF;
    SELECT * INTO v_inv FROM invoices WHERE encounter_id = c.encounter_id;
    IF NOT FOUND OR v_inv.finalized_at IS NOT NULL THEN RETURN -1; END IF;

    IF to_regclass('pg_temp._orl2') IS NULL THEN
        CREATE TEMP TABLE _orl2 (tariff_id UUID, description TEXT, quantity INT, unit_price NUMERIC(10,2), original_price NUMERIC(10,2), category VARCHAR(12),
                                 discount_reason TEXT, service_date DATE, adjusted_by UUID, price_item_id UUID) ON COMMIT DROP;
    END IF;
    TRUNCATE _orl2;

    IF c.status = 'completed' THEN
        SELECT settings INTO v_set FROM system_modules WHERE code = 'or';
        v_mpb   := coalesce(v_set->>'multi_procedure_billing', 'all');
        v_pct   := coalesce((v_set->>'multi_procedure_pct')::numeric, 50);
        v_ab    := coalesce(v_set->>'anesthesia_billing', 'fixed');
        v_round := coalesce((v_set->>'anesthesia_round_min')::int, 15);
        SELECT (x.at AT TIME ZONE p_tz)::date INTO v_day FROM or_case_times x WHERE x.case_id = p_case AND x.kind = 'in_room' AND x.superseded_by IS NULL;

        SELECT n.procedures INTO v_procs FROM or_op_notes n WHERE n.case_id = p_case AND n.status = 'signed' AND n.superseded_at IS NULL;
        IF v_procs IS NULL OR jsonb_typeof(v_procs) <> 'array' OR jsonb_array_length(v_procs) = 0 THEN
            SELECT jsonb_agg(jsonb_build_object('procedure_id', cp.procedure_id, 'side', cp.side, 'is_primary', cp.is_primary) ORDER BY cp.is_primary DESC, cp.sort_order)
              INTO v_procs FROM or_case_procedures cp WHERE cp.case_id = p_case;
        END IF;
        FOR p IN
            SELECT x.side, pr.code, pr.name, s.id AS sid, s.title, s.base_price, s.is_active AS s_active
              FROM ROWS FROM (jsonb_to_recordset(coalesce(v_procs, '[]'::jsonb)) AS (procedure_id UUID, side TEXT, is_primary BOOLEAN)) WITH ORDINALITY AS x(procedure_id, side, is_primary, ord)
              JOIN or_procedures pr ON pr.id = x.procedure_id
              LEFT JOIN service_tariffs s ON s.id = pr.tariff_id
             ORDER BY coalesce(x.is_primary, FALSE) DESC, x.ord
        LOOP
            v_i := v_i + 1;
            IF p.sid IS NULL OR NOT p.s_active THEN
                v_missing := v_missing || ('პროცედურა „' || p.name || '“ (' || p.code || ') — ტარიფი არ არის');
                CONTINUE;
            END IF;
            -- 0054: ფასი ნუსხიდან (ოპერაციის დღე, განყოფილება, გადამხდელი)
            SELECT * INTO r FROM tariff_line_price(v_inv.id, p.sid, v_day, NULL, 'surgery');
            v_base := coalesce(r.price, p.base_price); v_item := r.item_id;
            v_price := CASE WHEN v_mpb = 'primary_plus_pct' AND v_i > 1 THEN round(v_base * v_pct / 100, 2) ELSE v_base END;
            INSERT INTO _orl2 VALUES (p.sid,
                p.title || ' — ოპერაცია ' || c.case_no || CASE p.side WHEN 'left' THEN ' (მარცხ.)' WHEN 'right' THEN ' (მარჯვ.)' WHEN 'bilateral' THEN ' (ორმხრ.)' ELSE '' END,
                1, v_price, v_base, 'surgery',
                CASE WHEN v_price <> v_base THEN 'მრავლობითი პროცედურა — ' || v_pct::int::text || '%' END, v_day, NULL, v_item);
        END LOOP;
        IF v_i = 0 THEN v_missing := v_missing || 'პროცედურა არ არის მითითებული'::TEXT; END IF;

        v_type := coalesce((SELECT a.anesthesia_type FROM or_anesthesia_records a WHERE a.case_id = p_case), c.anesthesia_type);
        IF v_ab = 'fixed' THEN
            SELECT s.id, s.title, s.base_price INTO t FROM or_anesthesia_tariffs a JOIN service_tariffs s ON s.id = a.tariff_id
             WHERE a.anesthesia_type = v_type AND a.mode = 'fixed' AND s.is_active;
            IF FOUND THEN
                SELECT * INTO r FROM tariff_line_price(v_inv.id, t.id, v_day, NULL, 'anesthesia');
                v_base := coalesce(r.price, t.base_price);
                INSERT INTO _orl2 VALUES (t.id, t.title || ' — ანესთეზია, ' || c.case_no, 1, v_base, v_base, 'anesthesia', NULL, v_day, NULL, r.item_id);
            ELSIF v_type NOT IN ('local', 'none') THEN
                v_missing := v_missing || ('ანესთეზია (' || v_type || ') — ფიქსირებული ტარიფი არ არის');
            END IF;
        ELSIF v_ab = 'hourly' THEN
            SELECT x.at INTO v_as FROM or_case_times x WHERE x.case_id = p_case AND x.kind = 'anesthesia_start' AND x.superseded_by IS NULL;
            SELECT x.at INTO v_ae FROM or_case_times x WHERE x.case_id = p_case AND x.kind = 'anesthesia_end' AND x.superseded_by IS NULL;
            SELECT s.id, s.title, s.base_price INTO t FROM or_anesthesia_tariffs a JOIN service_tariffs s ON s.id = a.tariff_id
             WHERE a.anesthesia_type = v_type AND a.mode = 'hourly' AND s.is_active;
            IF NOT FOUND THEN
                IF v_type NOT IN ('local', 'none') THEN v_missing := v_missing || ('ანესთეზია (' || v_type || ') — საათობრივი ტარიფი არ არის'); END IF;
            ELSIF v_as IS NULL OR v_ae IS NULL THEN
                v_missing := v_missing || 'ანესთეზია (საათობრივი): საჭიროა ნიშნულები „ანესთეზიის დაწყება / დასრულება“'::TEXT;
            ELSE
                SELECT * INTO r FROM tariff_line_price(v_inv.id, t.id, v_day, NULL, 'anesthesia');
                v_base  := coalesce(r.price, t.base_price);
                v_min   := ceil(extract(epoch FROM (v_ae - v_as)) / 60)::int;
                v_units := greatest(1, ceil(v_min::numeric / v_round)::int);
                v_price := round(v_base * v_round / 60, 2);
                INSERT INTO _orl2 VALUES (t.id, t.title || ' — ანესთეზია, ' || c.case_no || ' (' || (v_min / 60) || ' სთ ' || (v_min % 60) || ' წთ → ' || v_units || ' × ' || v_round || ' წთ)',
                    v_units, v_price, v_price, 'anesthesia', NULL, v_day, NULL, r.item_id);
            END IF;
        END IF;
    END IF;

    UPDATE _orl2 l SET unit_price = a.unit_price, discount_reason = a.discount_reason, adjusted_by = a.adjusted_by
      FROM (SELECT DISTINCT ON (tariff_id, category) tariff_id, category, unit_price, discount_reason, adjusted_by FROM invoice_line_items
             WHERE invoice_id = v_inv.id AND or_case_id = p_case AND adjusted_by IS NOT NULL ORDER BY tariff_id, category, created_at DESC) a
     WHERE a.tariff_id = l.tariff_id AND a.category = l.category;
    SELECT count(*) INTO v_n FROM (
        (SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM _orl2
         EXCEPT ALL SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM invoice_line_items WHERE invoice_id = v_inv.id AND or_case_id = p_case)
        UNION ALL
        (SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM invoice_line_items WHERE invoice_id = v_inv.id AND or_case_id = p_case
         EXCEPT ALL SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM _orl2)) d;
    IF v_n > 0 THEN
        DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND or_case_id = p_case;
        INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, discount_reason, service_date, or_case_id, adjusted_by, price_item_id)
        SELECT v_inv.id, tariff_id, description, quantity, unit_price, original_price, category, discount_reason, service_date, p_case, adjusted_by, price_item_id FROM _orl2;
    END IF;

    IF c.status = 'completed' THEN
        INSERT INTO or_case_billing (case_id, encounter_id, missing, anesthesia_type, anesthesia_min, anesthesia_units, synced_at)
        VALUES (p_case, c.encounter_id, v_missing, v_type, v_min, v_units, now())
        ON CONFLICT (case_id) DO UPDATE SET missing = EXCLUDED.missing, anesthesia_type = EXCLUDED.anesthesia_type, anesthesia_min = EXCLUDED.anesthesia_min,
            anesthesia_units = EXCLUDED.anesthesia_units, synced_at = now();
    ELSE
        DELETE FROM or_case_billing WHERE case_id = p_case;
    END IF;
    RETURN v_n;
END $function$;

-- არსებული ხაზები: ფასის წყარო (საბაზო ნუსხის მიგრაციის ჩანაწერი, თუ ფასი ემთხვევა)
ALTER TABLE invoice_line_items DISABLE TRIGGER USER;
UPDATE invoice_line_items l SET price_item_id = x.id
  FROM tariff_list_items x JOIN tariff_lists tl ON tl.id = x.list_id AND tl.scope = 'base'
 WHERE x.tariff_id = l.tariff_id AND x.valid_from IS NULL AND x.price = l.original_price AND l.price_item_id IS NULL;
ALTER TABLE invoice_line_items ENABLE TRIGGER USER;
UPDATE stay_bed_days d SET unit_price = s.base_price FROM service_tariffs s WHERE s.id = d.tariff_id AND d.unit_price IS NULL;
UPDATE stay_vent_days d SET unit_price = s.base_price FROM service_tariffs s WHERE s.id = d.tariff_id AND d.unit_price IS NULL;
