-- 0051_procurement.sql
-- ფინანსები და შესყიდვები, ეტაპი 1 — შესყიდვები (მოდული „procurement“). ეტაპი 2 (0052): მომწოდებლის ინვოისი, გადახდა, ხარჯების ჟურნალი.
--
--  • #1 ჯაჭვი: შესყიდვის მოთხოვნა (PR) → შეკვეთა მომწოდებელთან (PO) → მიღება (RC, 0031). PO-ს რეჟიმი — po_mode (off / optional / required).
--  • #2 PR-ის წყარო: ხელით (კატალოგის საქონელი ან „თავისუფალი ხაზი“ — ჯერ კატალოგში არმყოფი), მინ/მაქს-იდან ერთი დაჭერით,
--      განყოფილების მოთხოვნიდან (RQ) — გაუცემელი ნაწილი, რომელსაც გამცემის მარაგი ვერ ფარავს.
--  • #3 დამტკიცება: დონე 1 — საწყობის მენეჯერი; დონე 2 (pr_approval_levels = 2, ჯამი > pr_finance_threshold) — ფინანსური (procurement_approve);
--      კონტროლირებადი (ნარკოტიკული / ფსიქოტროპული) — + ფარმაცევტი (controlled_pharmacist). საკუთარს ავტორი ვერ ამტკიცებს (admin — კი);
--      დონე 1 და 2 — სხვადასხვა პირი (admin-ის გარდა). PO PR-ის გარეშე: ზღვარს ზემოთ — ფინანსური დამტკიცება გაგზავნამდე.
--  • #4 PO-ს ფასი: მომწოდებლის ფასთა ნუსხა (proc_supplier_prices, ვადით) → PR-ის სავარაუდო ფასი → ბოლო მიღების ფასი.
--      RC-ზე ფასის გადახრა PO-დან > price_tolerance_pct → მიზეზი სავალდებულო; PO-ზე მეტი რაოდენობა — qty_over_delivery (warn / block).
--  • #5 ნაწილობრივი მიწოდება: ერთ PO-ზე რამდენიმე RC; მიღებული რაოდენობა და PO-ს სტატუსი — proc_sync_order()
--      (RC-ის გატარება / შემობრუნება — ტრიგერით); ვადაგადაცილებული (expected_date) — ყოველდღიური შეტყობინება (po_overdue_alert).
--  • #10 ვალუტა: PO — ₾ / USD / EUR, კურსი ხელით; RC და რეპორტები — ₾.
--  • #21 უფლებები: procurement (PR / PO, ფასები), procurement_approve (ფინანსური დამტკიცება) — კატალოგში (როლებს კლინიკა ქმნის).
--  • მომწოდებელი: გადახდის ვადა (დღე), მიწოდების ვადა (დღე), IBAN, ბანკი, ხელშეკრულება.

-- ================================================================ 0. მოდული
INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('procurement', 'შესყიდვები', 'შესყიდვის მოთხოვნა (PR) და დამტკიცება, შეკვეთა მომწოდებელთან (PO), მომწოდებლის ფასები, მიღების მიბმა შეკვეთაზე, ვადაგადაცილებული მიწოდება', TRUE,
 '{"po_mode": "optional",
   "pr_approval_levels": 2,
   "pr_finance_threshold": 1000,
   "controlled_pharmacist": true,
   "price_tolerance_pct": 5,
   "qty_over_delivery": "warn",
   "po_overdue_alert": true}', 40)
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 1. უფლებები
ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer',
        'storekeeper', 'stock_manager',
        'or_schedule', 'anesthesiologist', 'or_nurse',
        'procurement', 'procurement_approve']::VARCHAR(30)[]);

-- ================================================================ 2. მომწოდებელი — პირობები
ALTER TABLE stock_suppliers
    ADD COLUMN payment_terms_days SMALLINT CHECK (payment_terms_days BETWEEN 0 AND 365),           -- გადახდის ვადა (0052: ინვოისის ვადა)
    ADD COLUMN lead_time_days     SMALLINT CHECK (lead_time_days BETWEEN 0 AND 365),               -- მიწოდების ვადა → PO-ს მოსალოდნელი თარიღი
    ADD COLUMN iban               VARCHAR(34) CHECK (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
    ADD COLUMN bank_name          TEXT,
    ADD COLUMN contract_no        VARCHAR(60),
    ADD COLUMN contract_until     DATE;

-- ================================================================ 3. მომწოდებლის ფასთა ნუსხა
CREATE TABLE proc_supplier_prices (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_id  UUID NOT NULL REFERENCES stock_suppliers(id),
    item_id      UUID NOT NULL REFERENCES stock_items(id),
    pack_id      UUID REFERENCES stock_item_packs(id),                       -- NULL — საბაზო ერთეულზე
    price        NUMERIC(14,4) NOT NULL CHECK (price >= 0),                  -- შეფუთვაზე (ან საბაზოზე), დღგ-ს გარეშე, ₾
    vat_rate     NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (vat_rate IN (0, 18)),
    min_qty      NUMERIC(14,3) CHECK (min_qty > 0),                          -- მინ. შეკვეთა (შეფუთვებში) — მინიშნება
    valid_from   DATE NOT NULL,
    valid_to     DATE,
    contract_no  VARCHAR(60),
    notes        TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT proc_prices_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
    -- ერთ მომწოდებელს ერთ საქონელზე (ერთეულზე) ერთ დღეს — ერთი აქტიური ფასი
    CONSTRAINT proc_prices_no_overlap EXCLUDE USING gist (
        supplier_id WITH =, item_id WITH =, (coalesce(pack_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&) WHERE (is_active)
);
CREATE TRIGGER trg_proc_supplier_prices_updated BEFORE UPDATE ON proc_supplier_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_proc_prices_item ON proc_supplier_prices (item_id) WHERE is_active;
CREATE INDEX idx_proc_prices_supplier ON proc_supplier_prices (supplier_id);

-- ================================================================ 4. შესყიდვის მოთხოვნა (PR)
CREATE TABLE proc_requisitions (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pr_no            VARCHAR(20) UNIQUE,                                     -- გაგზავნისას: PR26-000001
    status           VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled')),
    location_id      UUID NOT NULL REFERENCES stock_locations(id),           -- სად მიიწოდება
    source           VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'minmax', 'request')),
    request_id       UUID REFERENCES stock_requests(id),                     -- source = request
    urgent           BOOLEAN NOT NULL DEFAULT FALSE,
    needed_by        DATE,
    notes            TEXT,
    est_total        NUMERIC(14,2) NOT NULL DEFAULT 0,                       -- სავარაუდო ჯამი (დღგ-ს გარეშე, ₾)
    -- დამტკიცების გზა — გაგზავნისას ფიქსირდება პარამეტრებიდან
    needs_finance    BOOLEAN NOT NULL DEFAULT FALSE,
    needs_pharmacist BOOLEAN NOT NULL DEFAULT FALSE,
    l1_by            UUID REFERENCES users(id),
    l1_at            TIMESTAMPTZ,
    finance_by       UUID REFERENCES users(id),
    finance_at       TIMESTAMPTZ,
    pharm_by         UUID REFERENCES users(id),
    pharm_at         TIMESTAMPTZ,
    rejected_by      UUID REFERENCES users(id),
    rejected_at      TIMESTAMPTZ,
    reason           TEXT,                                                   -- უარყოფის / დახურვის / გაუქმების მიზეზი
    closed_at        TIMESTAMPTZ,
    created_by       UUID NOT NULL REFERENCES users(id),
    submitted_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT proc_pr_no CHECK (status IN ('draft', 'cancelled') OR pr_no IS NOT NULL),
    CONSTRAINT proc_pr_approved CHECK (status NOT IN ('approved', 'closed')
        OR (l1_at IS NOT NULL AND (NOT needs_finance OR finance_at IS NOT NULL) AND (NOT needs_pharmacist OR pharm_at IS NOT NULL))),
    CONSTRAINT proc_pr_request CHECK (source <> 'request' OR request_id IS NOT NULL)
);
CREATE TRIGGER trg_proc_requisitions_updated BEFORE UPDATE ON proc_requisitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_proc_pr_status ON proc_requisitions (status, created_at DESC);
CREATE INDEX idx_proc_pr_location ON proc_requisitions (location_id);

CREATE TABLE proc_requisition_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    requisition_id  UUID NOT NULL REFERENCES proc_requisitions(id) ON DELETE CASCADE,
    line_no         INT NOT NULL,
    item_id         UUID REFERENCES stock_items(id),                         -- NULL — „თავისუფალი ხაზი“ (PO-მდე კატალოგს უნდა მიებას)
    free_name       TEXT,
    pack_id         UUID REFERENCES stock_item_packs(id),
    pack_qty_base   NUMERIC(14,3) NOT NULL DEFAULT 1 CHECK (pack_qty_base >= 1),
    qty             NUMERIC(14,3) NOT NULL CHECK (qty > 0),                  -- შეფუთვებში (ან საბაზოში)
    qty_base        NUMERIC(14,3) NOT NULL CHECK (qty_base > 0),
    est_price       NUMERIC(14,4) CHECK (est_price >= 0),                    -- სავარაუდო ფასი შეფუთვაზე, დღგ-ს გარეშე, ₾
    supplier_id     UUID REFERENCES stock_suppliers(id),                     -- სასურველი მომწოდებელი (PO-ზე გადაყვანისას სავალდებულო)
    request_line_id UUID REFERENCES stock_request_lines(id),
    notes           TEXT,
    UNIQUE (requisition_id, line_no),
    CONSTRAINT proc_pr_line_item CHECK (item_id IS NOT NULL OR length(btrim(coalesce(free_name, ''))) >= 2),
    CONSTRAINT proc_pr_line_pack CHECK (pack_id IS NULL OR item_id IS NOT NULL)
);
CREATE INDEX idx_proc_pr_lines_pr ON proc_requisition_lines (requisition_id);
CREATE INDEX idx_proc_pr_lines_item ON proc_requisition_lines (item_id);
CREATE INDEX idx_proc_pr_lines_rq ON proc_requisition_lines (request_line_id) WHERE request_line_id IS NOT NULL;

-- მონახაზის შემდეგ ხაზი იცვლება მხოლოდ შეკვეთისთვის მოსამზადებლად: მომწოდებელი, სავარაუდო ფასი, „თავისუფალი ხაზის“ მიბმა კატალოგზე
CREATE OR REPLACE FUNCTION proc_pr_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
    SELECT status INTO st FROM proc_requisitions WHERE id = coalesce(NEW.requisition_id, OLD.requisition_id);
    IF st IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;              -- მონახაზის წაშლის კასკადი
    IF st = 'draft' THEN RETURN coalesce(NEW, OLD); END IF;
    IF TG_OP = 'UPDATE' AND st IN ('submitted', 'approved')
       AND (to_jsonb(NEW) - 'supplier_id' - 'est_price' - 'item_id') = (to_jsonb(OLD) - 'supplier_id' - 'est_price' - 'item_id')
       AND (NEW.item_id IS NOT DISTINCT FROM OLD.item_id OR OLD.item_id IS NULL) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'მოთხოვნის ხაზი მონახაზის შემდეგ არ იცვლება (მხოლოდ მომწოდებელი, ფასი, კატალოგზე მიბმა)' USING ERRCODE = 'check_violation', CONSTRAINT = 'proc_pr_lines_locked';
END $$;
CREATE TRIGGER trg_proc_pr_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON proc_requisition_lines FOR EACH ROW EXECUTE FUNCTION proc_pr_lines_guard();

-- ================================================================ 5. შეკვეთა მომწოდებელთან (PO)
CREATE TABLE proc_orders (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_no             VARCHAR(20) UNIQUE,                                    -- გაგზავნისას (ან დასამტკიცებლად გადაცემისას): PO26-000001
    status            VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'sent', 'partial', 'received', 'closed', 'cancelled')),
    supplier_id       UUID NOT NULL REFERENCES stock_suppliers(id),
    location_id       UUID NOT NULL REFERENCES stock_locations(id),          -- მიწოდების ადგილი
    order_date        DATE NOT NULL,
    expected_date     DATE,
    currency          CHAR(3) NOT NULL DEFAULT 'GEL' CHECK (currency IN ('GEL', 'USD', 'EUR')),
    fx_rate           NUMERIC(12,6) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),   -- 1 ერთეული ვალუტა = fx_rate ₾
    prices_include_vat BOOLEAN NOT NULL DEFAULT FALSE,
    total_net         NUMERIC(14,2) NOT NULL DEFAULT 0,                      -- PO-ს ვალუტაში
    total_vat         NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_gel         NUMERIC(14,2) NOT NULL DEFAULT 0,                      -- დღგ-ს გარეშე, ₾ (დამტკიცების ზღვრისთვის)
    contract_no       VARCHAR(60),
    notes             TEXT,
    needs_approval    BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by       UUID REFERENCES users(id),
    approved_at       TIMESTAMPTZ,
    sent_by           UUID REFERENCES users(id),
    sent_at           TIMESTAMPTZ,
    closed_by         UUID REFERENCES users(id),
    closed_at         TIMESTAMPTZ,
    reason            TEXT,                                                  -- დაბრუნების / დახურვის / გაუქმების მიზეზი
    overdue_notified  DATE,                                                  -- ბოლო შეტყობინება ვადაგადაცილებაზე
    created_by        UUID NOT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT proc_po_gel_rate CHECK (currency <> 'GEL' OR fx_rate = 1),
    CONSTRAINT proc_po_no CHECK (status IN ('draft', 'cancelled') OR po_no IS NOT NULL),
    CONSTRAINT proc_po_expected CHECK (expected_date IS NULL OR expected_date >= order_date)
);
CREATE TRIGGER trg_proc_orders_updated BEFORE UPDATE ON proc_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_proc_po_status ON proc_orders (status, order_date DESC);
CREATE INDEX idx_proc_po_supplier ON proc_orders (supplier_id);
CREATE INDEX idx_proc_po_open ON proc_orders (location_id) WHERE status IN ('sent', 'partial');

CREATE TABLE proc_order_lines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id            UUID NOT NULL REFERENCES proc_orders(id) ON DELETE CASCADE,
    line_no             INT NOT NULL,
    item_id             UUID NOT NULL REFERENCES stock_items(id),
    pack_id             UUID REFERENCES stock_item_packs(id),
    pack_qty_base       NUMERIC(14,3) NOT NULL DEFAULT 1 CHECK (pack_qty_base >= 1),
    qty                 NUMERIC(14,3) NOT NULL CHECK (qty > 0),              -- შეფუთვებში (ან საბაზოში)
    qty_base            NUMERIC(14,3) NOT NULL CHECK (qty_base > 0),
    price               NUMERIC(14,4) NOT NULL CHECK (price >= 0),           -- შეფუთვაზე, PO-ს ვალუტაში (დღგ-ით / გარეშე — PO-ს მიხედვით)
    vat_rate            NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (vat_rate IN (0, 18)),
    unit_cost_gel       NUMERIC(14,6) NOT NULL CHECK (unit_cost_gel >= 0),   -- საბაზო ერთეულზე, დღგ-ს გარეშე, ₾ (RC-ის შედარებისთვის)
    line_net            NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_vat            NUMERIC(14,2) NOT NULL DEFAULT 0,
    requisition_line_id UUID REFERENCES proc_requisition_lines(id),
    qty_received        NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),   -- proc_sync_order()
    notes               TEXT,
    UNIQUE (order_id, line_no)
);
CREATE INDEX idx_proc_po_lines_po ON proc_order_lines (order_id);
CREATE INDEX idx_proc_po_lines_item ON proc_order_lines (item_id);
CREATE INDEX idx_proc_po_lines_pr ON proc_order_lines (requisition_line_id) WHERE requisition_line_id IS NOT NULL;

-- PO-ს ხაზი იცვლება მხოლოდ მონახაზში; შემდეგ — მხოლოდ მიღებული რაოდენობა (proc_sync_order)
CREATE OR REPLACE FUNCTION proc_po_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
    SELECT status INTO st FROM proc_orders WHERE id = coalesce(NEW.order_id, OLD.order_id);
    IF st IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF st = 'draft' THEN RETURN coalesce(NEW, OLD); END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'qty_received') = (to_jsonb(OLD) - 'qty_received') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'შეკვეთის ხაზი მონახაზის შემდეგ არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'proc_po_lines_locked';
END $$;
CREATE TRIGGER trg_proc_po_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON proc_order_lines FOR EACH ROW EXECUTE FUNCTION proc_po_lines_guard();

-- ================================================================ 6. მიღება ↔ შეკვეთა
ALTER TABLE stock_docs ADD COLUMN po_id UUID REFERENCES proc_orders(id);
ALTER TABLE stock_docs ADD COLUMN no_po_reason TEXT;                         -- po_mode = required: მიღება PO-ს გარეშე (საწყობის მენეჯერი / admin)
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_po_receipt CHECK (po_id IS NULL OR doc_type IN ('receipt', 'reversal'));
CREATE INDEX idx_stock_docs_po ON stock_docs (po_id) WHERE po_id IS NOT NULL;
ALTER TABLE stock_doc_lines ADD COLUMN po_line_id UUID REFERENCES proc_order_lines(id);
ALTER TABLE stock_doc_lines ADD COLUMN price_reason TEXT;                    -- ფასის გადახრა PO-დან
CREATE INDEX idx_stock_doc_lines_po_line ON stock_doc_lines (po_line_id) WHERE po_line_id IS NOT NULL;

-- PO-ს მიღებული რაოდენობა = გატარებული, შეუბრუნებელი RC-ების ხაზები; სტატუსი sent → partial → received (დახურული / გაუქმებული — უცვლელი)
CREATE OR REPLACE FUNCTION proc_sync_order(p_order UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE st TEXT; n_all INT; n_full INT; n_any INT;
BEGIN
    UPDATE proc_order_lines ol SET qty_received = coalesce((
        SELECT sum(x.qty_base) FROM stock_doc_lines x JOIN stock_docs d ON d.id = x.doc_id
         WHERE x.po_line_id = ol.id AND d.doc_type = 'receipt' AND d.status = 'posted' AND d.reversed_by IS NULL), 0)
     WHERE ol.order_id = p_order;
    SELECT status INTO st FROM proc_orders WHERE id = p_order FOR UPDATE;
    IF st NOT IN ('sent', 'partial', 'received') THEN RETURN; END IF;
    SELECT count(*), count(*) FILTER (WHERE qty_received >= qty_base), count(*) FILTER (WHERE qty_received > 0)
      INTO n_all, n_full, n_any FROM proc_order_lines WHERE order_id = p_order;
    UPDATE proc_orders SET status = CASE WHEN n_all > 0 AND n_full = n_all THEN 'received' WHEN n_any > 0 THEN 'partial' ELSE 'sent' END
     WHERE id = p_order;
END $$;

CREATE OR REPLACE FUNCTION stock_docs_po_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.po_id IS NOT NULL AND NEW.doc_type = 'receipt'
       AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by) THEN
        PERFORM proc_sync_order(NEW.po_id);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_stock_docs_po_sync AFTER UPDATE ON stock_docs FOR EACH ROW EXECUTE FUNCTION stock_docs_po_sync();

-- ================================================================ 7. ნომრები: PR26-000001, PO26-000001 — document_counters (proc_PR, proc_PO)
