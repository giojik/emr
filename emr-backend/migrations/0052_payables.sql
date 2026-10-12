-- 0052_payables.sql
-- ფინანსები და შესყიდვები, ეტაპი 2 — მომწოდებლის ინვოისი, გადახდა, ხარჯების ჟურნალი (მოდული „procurement“, პარამეტრები ემატება).
--
--  • #6 მომწოდებლის ინვოისი (ap_invoices): ერთ ინვოისზე რამდენიმე მიღება (RC, ap_invoice_receipts) და / ან არა-მარაგის ხაზები
--      (მომსახურება, კომუნალური, რემონტი — ap_invoice_lines: ხარჯის კატეგორია + განყოფილება); გადახდის ვადა — მომწოდებლის პირობებიდან.
--      მონახაზი → გატარება (AP26-000001) → გაუქმება (მიზეზით, გადახდების გარეშე). გატარებული აღარ იცვლება.
--  • #7 შეჯერება — invoice_match: off / rc (ინვოისის მარაგის ნაწილი ↔ RC-ების ჯამი, ₾) / three_way (+ PO-ს ფასით მიღებული რაოდენობა);
--      სხვაობა > match_tolerance → match_status = mismatch → გადახდა იბლოკება, სანამ ბუღალტერი მიზეზით არ დაადასტურებს (accepted).
--  • #8 გადახდა (ap_payments, kind = payment): ხელით — თარიღი, თანხა (ინვოისის ვალუტაში), კურსი, მეთოდი, ბანკის საბუთი; ნაწილობრივიც;
--      ჯამი ინვოისზე მეტი ვერ იქნება (DB trigger). გაუქმება — მიზეზით.
--  • #9 კრედიტ-ნოტა (ap_payments, kind = credit_note): ამცირებს დავალიანებას; მარაგის დაბრუნება — RV (0031), არჩევით მიბმული.
--  • #10 ვალუტა: ₾ / USD / EUR, კურსი ხელით; ხარჯი და რეპორტები — ₾.
--  • #11 ხარჯების ჟურნალი: არა-მარაგის ხაზი → expenses (source ap_invoice / ap_payment / ap_credit), expense_recognition:
--      on_invoice (ინვოისის თარიღით) / on_payment (გადახდის თარიღით, წილის პროპორციით); მარაგის ინვოისი ჟურნალში არ ჩაიწერება
--      (ხარჯი — მოხმარებით). სისტემური ჩანაწერი ხელით არ იცვლება.
--  • #12 ხარჯის ცენტრი — განყოფილება (expenses.department_id, 0017); ინვოისის ხაზზეც.
--  • შეტყობინება: ვადა იწურება (ap_due_days) / ვადაგადაცილებულია — ბუღალტერს (ap_due_alert).

-- ================================================================ 0. პარამეტრები
UPDATE system_modules
   SET settings = settings || '{
     "invoice_match": "rc",
     "match_tolerance": 1,
     "expense_recognition": "on_invoice",
     "ap_due_alert": true,
     "ap_due_days": 3}',
       description = 'შესყიდვის მოთხოვნა (PR) და დამტკიცება, შეკვეთა მომწოდებელთან (PO), მომწოდებლის ფასები, მიღების მიბმა შეკვეთაზე, მომწოდებლის ინვოისი, შეჯერება, გადახდები, კრედიტ-ნოტა, ხანდაზმულობა, ხარჯების ჟურნალის კავშირი'
 WHERE code = 'procurement';

-- ================================================================ 1. ინვოისი
CREATE TABLE ap_invoices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ap_no           VARCHAR(20) UNIQUE,                                     -- გატარებისას: AP26-000001
    status          VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
    supplier_id     UUID NOT NULL REFERENCES stock_suppliers(id),
    invoice_no      VARCHAR(60) NOT NULL CHECK (length(btrim(invoice_no)) >= 1),   -- მომწოდებლის ანგარიშ-ფაქტურის №
    invoice_date    DATE NOT NULL,
    due_date        DATE NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'GEL' CHECK (currency IN ('GEL', 'USD', 'EUR')),
    fx_rate         NUMERIC(12,6) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    total           NUMERIC(14,2) NOT NULL CHECK (total > 0),               -- სულ (დღგ-ით), ინვოისის ვალუტაში — ქაღალდიდან
    total_vat       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_vat >= 0),
    total_gel       NUMERIC(14,2) NOT NULL DEFAULT 0,                       -- total × fx_rate
    expense_total   NUMERIC(14,2) NOT NULL DEFAULT 0,                       -- არა-მარაგის ხაზები (დღგ-ით, ვალუტაში)
    stock_gel       NUMERIC(14,2) NOT NULL DEFAULT 0,                       -- მიბმული RC-ების ჯამი (დღგ-ით, ₾) — გატარებისას
    match_status    VARCHAR(8) NOT NULL DEFAULT 'none' CHECK (match_status IN ('none', 'ok', 'mismatch', 'accepted')),
    match_diff      NUMERIC(14,2),                                          -- ინვოისის მარაგის ნაწილი − მიღებები (₾)
    match_note      TEXT,
    accepted_by     UUID REFERENCES users(id),
    accepted_at     TIMESTAMPTZ,
    notes           TEXT,
    due_notified    VARCHAR(8) CHECK (due_notified IN ('soon', 'overdue')),
    created_by      UUID NOT NULL REFERENCES users(id),
    posted_by       UUID REFERENCES users(id),
    posted_at       TIMESTAMPTZ,
    voided_by       UUID REFERENCES users(id),
    voided_at       TIMESTAMPTZ,
    void_reason     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ap_inv_gel_rate CHECK (currency <> 'GEL' OR fx_rate = 1),
    CONSTRAINT ap_inv_due CHECK (due_date >= invoice_date),
    CONSTRAINT ap_inv_vat CHECK (total_vat <= total),
    CONSTRAINT ap_inv_posted CHECK (status = 'draft' OR ap_no IS NOT NULL),
    CONSTRAINT ap_inv_void CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE TRIGGER trg_ap_invoices_updated BEFORE UPDATE ON ap_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- ერთი მომწოდებლის ერთი ფაქტურა — ერთხელ (გაუქმებულის გარდა)
CREATE UNIQUE INDEX ux_ap_invoices_supplier_no ON ap_invoices (supplier_id, upper(btrim(invoice_no))) WHERE status <> 'void';
CREATE INDEX idx_ap_invoices_supplier ON ap_invoices (supplier_id, invoice_date DESC);
CREATE INDEX idx_ap_invoices_open ON ap_invoices (due_date) WHERE status = 'posted';

-- გატარებული ინვოისი: იცვლება მხოლოდ შეჯერების დადასტურება, შეტყობინების ნიშანი და გაუქმება
CREATE OR REPLACE FUNCTION ap_invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'გატარებული ინვოისი არ იშლება — გამოიყენეთ გაუქმება' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_invoices_immutable'; END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'void' THEN RAISE EXCEPTION 'გაუქმებული ინვოისი არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_invoices_immutable'; END IF;
    IF OLD.status = 'posted' AND (to_jsonb(NEW) - ARRAY['match_status', 'match_note', 'accepted_by', 'accepted_at', 'due_notified', 'status', 'voided_by', 'voided_at', 'void_reason', 'updated_at'])
                              <> (to_jsonb(OLD) - ARRAY['match_status', 'match_note', 'accepted_by', 'accepted_at', 'due_notified', 'status', 'voided_by', 'voided_at', 'void_reason', 'updated_at']) THEN
        RAISE EXCEPTION 'გატარებული ინვოისი არ იცვლება — გააუქმეთ და შექმენით ახალი' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_invoices_immutable';
    END IF;
    IF OLD.status = 'posted' AND NEW.status = 'draft' THEN RAISE EXCEPTION 'გატარებული ინვოისი მონახაზში ვერ დაბრუნდება' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_invoices_immutable'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_ap_invoices_guard BEFORE UPDATE OR DELETE ON ap_invoices FOR EACH ROW EXECUTE FUNCTION ap_invoices_guard();

-- არა-მარაგის ხაზები (მომსახურება, კომუნალური, რემონტი…)
CREATE TABLE ap_invoice_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id      UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
    line_no         INT NOT NULL,
    description     TEXT NOT NULL CHECK (length(btrim(description)) >= 2),
    category        TEXT NOT NULL CHECK (length(btrim(category)) >= 2),     -- ხარჯის კატეგორია (expenses.category)
    department_id   UUID REFERENCES departments(id),                        -- ხარჯის ცენტრი (NULL — საერთო)
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),              -- დღგ-ით, ინვოისის ვალუტაში
    vat_rate        NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate IN (0, 18)),
    UNIQUE (invoice_id, line_no)
);
CREATE INDEX idx_ap_invoice_lines_inv ON ap_invoice_lines (invoice_id);

-- მიბმული მიღებები (RC) — ერთი RC ერთ (გაუქმებულის გარდა) ინვოისზე
CREATE TABLE ap_invoice_receipts (
    invoice_id      UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
    doc_id          UUID NOT NULL REFERENCES stock_docs(id),
    amount_gel      NUMERIC(14,2) NOT NULL,                                 -- RC-ის ჯამი (დღგ-ით) მიბმის მომენტში
    PRIMARY KEY (invoice_id, doc_id)
);
CREATE UNIQUE INDEX ux_ap_invoice_receipts_doc ON ap_invoice_receipts (doc_id);

-- ხაზები / მიღებები იცვლება მხოლოდ მონახაზში (გაუქმებისას მიღებები იხსნება — RC თავისუფლდება)
CREATE OR REPLACE FUNCTION ap_invoice_children_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
    SELECT status INTO st FROM ap_invoices WHERE id = coalesce(NEW.invoice_id, OLD.invoice_id);
    IF st IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF st = 'draft' OR (TG_OP = 'DELETE' AND TG_TABLE_NAME = 'ap_invoice_receipts' AND st = 'void') THEN RETURN coalesce(NEW, OLD); END IF;
    RAISE EXCEPTION 'ინვოისის შემადგენლობა მხოლოდ მონახაზში იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_invoices_immutable';
END $$;
CREATE TRIGGER trg_ap_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_invoice_lines FOR EACH ROW EXECUTE FUNCTION ap_invoice_children_guard();
CREATE TRIGGER trg_ap_invoice_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_invoice_receipts FOR EACH ROW EXECUTE FUNCTION ap_invoice_children_guard();

-- ================================================================ 2. გადახდა / კრედიტ-ნოტა
CREATE TABLE ap_payments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id      UUID NOT NULL REFERENCES ap_invoices(id),
    kind            VARCHAR(12) NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'credit_note')),
    pay_date        DATE NOT NULL,
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),              -- ინვოისის ვალუტაში
    fx_rate         NUMERIC(12,6) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    amount_gel      NUMERIC(14,2) NOT NULL,
    method          VARCHAR(15) CHECK (method IN ('bank_transfer', 'cash', 'card')),
    reference       VARCHAR(80),                                            -- ბანკის საბუთი № / კრედიტ-ნოტის №
    reversal_doc_id UUID REFERENCES stock_docs(id),                         -- კრედიტ-ნოტა: მარაგის დაბრუნება (RV)
    note            TEXT,
    is_void         BOOLEAN NOT NULL DEFAULT FALSE,
    void_reason     TEXT,
    voided_by       UUID REFERENCES users(id),
    voided_at       TIMESTAMPTZ,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ap_pay_method CHECK (kind <> 'payment' OR method IS NOT NULL),
    CONSTRAINT ap_pay_void CHECK (NOT is_void OR void_reason IS NOT NULL)
);
CREATE INDEX idx_ap_payments_inv ON ap_payments (invoice_id);
CREATE INDEX idx_ap_payments_date ON ap_payments (pay_date) WHERE NOT is_void;

-- გადახდა: მხოლოდ გატარებულ ინვოისზე; ჯამი ≤ ინვოისი; ჩანაწერი უცვლელია (მხოლოდ გაუქმება)
CREATE OR REPLACE FUNCTION ap_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv RECORD; paid NUMERIC;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'გადახდა არ იშლება — გამოიყენეთ გაუქმება' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_payments_immutable'; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.is_void OR (to_jsonb(NEW) - ARRAY['is_void', 'void_reason', 'voided_by', 'voided_at']) <> (to_jsonb(OLD) - ARRAY['is_void', 'void_reason', 'voided_by', 'voided_at']) THEN
            RAISE EXCEPTION 'გადახდა არ იცვლება — გააუქმეთ და შეიყვანეთ ხელახლა' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_payments_immutable';
        END IF;
        RETURN NEW;
    END IF;
    SELECT status, total INTO inv FROM ap_invoices WHERE id = NEW.invoice_id FOR UPDATE;
    IF inv.status <> 'posted' THEN RAISE EXCEPTION 'გადახდა — მხოლოდ გატარებულ ინვოისზე' USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_payments_invoice_status'; END IF;
    SELECT coalesce(sum(amount), 0) INTO paid FROM ap_payments WHERE invoice_id = NEW.invoice_id AND NOT is_void;
    IF paid + NEW.amount > inv.total THEN
        RAISE EXCEPTION 'თანხა აჭარბებს ინვოისის ნაშთს (%)', inv.total - paid USING ERRCODE = 'check_violation', CONSTRAINT = 'ap_payments_overpaid';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_ap_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON ap_payments FOR EACH ROW EXECUTE FUNCTION ap_payments_guard();

-- ================================================================ 3. ხარჯების ჟურნალის კავშირი
ALTER TABLE expenses ADD COLUMN source VARCHAR(12) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ap_invoice', 'ap_payment', 'ap_credit'));
ALTER TABLE expenses ADD COLUMN ap_invoice_id UUID REFERENCES ap_invoices(id);
ALTER TABLE expenses ADD COLUMN ap_payment_id UUID REFERENCES ap_payments(id);
ALTER TABLE expenses ADD COLUMN supplier_id UUID REFERENCES stock_suppliers(id);
-- კრედიტ-ნოტა ხარჯს ამცირებს (უარყოფითი ჩანაწერი); ხელით — მხოლოდ დადებითი
ALTER TABLE expenses DROP CONSTRAINT expenses_amount_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_amount_check CHECK (amount > 0 OR (source = 'ap_credit' AND amount < 0));
ALTER TABLE expenses ADD CONSTRAINT expenses_source_link CHECK (source = 'manual' OR ap_invoice_id IS NOT NULL);
CREATE INDEX idx_expenses_ap_invoice ON expenses (ap_invoice_id) WHERE ap_invoice_id IS NOT NULL;
CREATE INDEX idx_expenses_department ON expenses (department_id, expense_date) WHERE NOT is_void;

-- ================================================================ 4. ნომრები: AP26-000001 — document_counters (proc_AP)
