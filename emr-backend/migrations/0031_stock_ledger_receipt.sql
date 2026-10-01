-- 0031_stock_ledger_receipt.sql
-- საწყობი + აფთიაქი, ეტაპი 2 — მოძრაობების ჟურნალი და მიღება:
--   * ლოტები (stock_lots): საქონელი + ლოტი + სერიული; ვადა, ლოტის ფასი (საბაზო ერთეულზე, დღგ-ს გარეშე), სტატუსი (active / quarantine / recalled — 0034)
--       ლოტის გარეშე აღრიცხვადი საქონელი — ერთი „ლოტი“ (lot_no NULL) — მისი ფასი = შეწონილი საშუალო
--   * დოკუმენტები (stock_docs + stock_doc_lines): მონახაზი → გატარება → (შემობრუნება — ახალი დოკუმენტით); ნომერი RC26-000001 (უწყვეტი, წლიური)
--   * მოძრაობების ჟურნალი (stock_moves) — უცვლელი: UPDATE/DELETE აკრძალულია (ტრიგერი + უფლებები)
--       ყოველ ხაზზე ორივე ღირებულება: cost_lot (ლოტის ფასი) და cost_avg (შეწონილი საშუალო ამ მომენტში) — მეთოდს კლინიკა ირჩევს (stock_settings)
--   * ნაშთები (stock_balances: ლოკაცია × ლოტი) და საშუალო ფასი (stock_item_costs) — მხოლოდ ჟურნალის ტრიგერით (SECURITY DEFINER);
--       აპლიკაციას პირდაპირი ჩაწერის უფლება არ აქვს; ნაშთი < 0 — შეუძლებელია (CHECK)
--   * საბაზო ერთეულის შეცვლა ლოტების შემდეგ — აკრძალულია

-- ---------------------------------------------------------------- ლოტები
CREATE TABLE stock_lots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id         UUID NOT NULL REFERENCES stock_items(id),
    lot_no          VARCHAR(40) CHECK (lot_no IS NULL OR length(btrim(lot_no)) >= 1),
    serial_no       VARCHAR(60) CHECK (serial_no IS NULL OR length(btrim(serial_no)) >= 1),
    expires_on      DATE,
    produced_on     DATE,
    unit_cost       NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),      -- ლოტის ფასი: საბაზო ერთეულზე, დღგ-ს გარეშე (შეწონილი ლოტის შიგნით)
    received_qty    NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),   -- სულ მიღებული (ფასის შეწონისთვის)
    received_value  NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (received_value >= 0), -- მიღებულის ღირებულება (unit_cost = value / qty)
    status          VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantine', 'recalled')),
    status_reason   TEXT,
    first_supplier_id UUID REFERENCES stock_suppliers(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (produced_on IS NULL OR expires_on IS NULL OR produced_on <= expires_on)
);
CREATE TRIGGER trg_stock_lots_updated_at BEFORE UPDATE ON stock_lots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX ux_stock_lots_key ON stock_lots (item_id, coalesce(lot_no, ''), coalesce(serial_no, ''));
CREATE INDEX idx_stock_lots_expiry ON stock_lots (expires_on) WHERE expires_on IS NOT NULL;
CREATE INDEX idx_stock_lots_lot ON stock_lots (upper(lot_no) text_pattern_ops);

-- საბაზო ერთეული ლოტების შემდეგ აღარ იცვლება (ნაშთები მასშია)
CREATE OR REPLACE FUNCTION stock_items_lock_unit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.base_unit IS DISTINCT FROM OLD.base_unit AND EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id = NEW.id) THEN
        RAISE EXCEPTION 'საბაზო ერთეული მოძრაობების შემდეგ არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_items_unit_locked';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_items_lock_unit BEFORE UPDATE OF base_unit ON stock_items FOR EACH ROW EXECUTE FUNCTION stock_items_lock_unit();

-- ---------------------------------------------------------------- დოკუმენტები
CREATE TABLE stock_docs (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    doc_type          VARCHAR(12) NOT NULL CHECK (doc_type IN ('receipt', 'transfer', 'issue', 'return', 'writeoff', 'adjustment', 'consumption', 'reversal')),
    doc_no            VARCHAR(20) UNIQUE,                                  -- გატარებისას: RC26-000001
    status            VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
    doc_date          DATE NOT NULL,
    location_id       UUID REFERENCES stock_locations(id),                 -- მიღება: სად შემოვიდა
    from_location_id  UUID REFERENCES stock_locations(id),
    to_location_id    UUID REFERENCES stock_locations(id),
    supplier_id       UUID REFERENCES stock_suppliers(id),
    invoice_no        VARCHAR(60),                                         -- ანგარიშ-ფაქტურა / ზედნადები
    invoice_date      DATE,
    waybill_no        VARCHAR(40),                                         -- RS.ge ზედნადების № (ინტეგრაციის გარეშე)
    prices_include_vat BOOLEAN NOT NULL DEFAULT TRUE,
    total_net         NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_vat         NUMERIC(14,2) NOT NULL DEFAULT 0,
    notes             TEXT,
    reversal_of       UUID REFERENCES stock_docs(id),
    reversed_by       UUID REFERENCES stock_docs(id),
    reason            TEXT,                                                -- შემობრუნების / გაუქმების მიზეზი
    created_by        UUID NOT NULL REFERENCES users(id),
    posted_by         UUID REFERENCES users(id),
    posted_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (doc_type <> 'receipt' OR location_id IS NOT NULL),
    CHECK (status <> 'posted' OR (doc_no IS NOT NULL AND posted_at IS NOT NULL)),
    CHECK (doc_type <> 'reversal' OR reversal_of IS NOT NULL)
);
CREATE TRIGGER trg_stock_docs_updated_at BEFORE UPDATE ON stock_docs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_stock_docs_type_date ON stock_docs (doc_type, doc_date DESC);
CREATE INDEX idx_stock_docs_status ON stock_docs (status) WHERE status = 'draft';
CREATE INDEX idx_stock_docs_supplier ON stock_docs (supplier_id);
CREATE UNIQUE INDEX ux_stock_docs_reversal ON stock_docs (reversal_of) WHERE reversal_of IS NOT NULL AND status <> 'cancelled';

CREATE TABLE stock_doc_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    doc_id          UUID NOT NULL REFERENCES stock_docs(id) ON DELETE CASCADE,
    line_no         INT NOT NULL,
    item_id         UUID NOT NULL REFERENCES stock_items(id),
    pack_id         UUID REFERENCES stock_item_packs(id),                  -- NULL — საბაზო ერთეულით
    pack_qty_base   NUMERIC(14,3) NOT NULL DEFAULT 1 CHECK (pack_qty_base >= 1),  -- შეფუთვის ზომა შეყვანის მომენტში
    qty             NUMERIC(14,3) NOT NULL CHECK (qty > 0),                -- შეფუთვებში (ან საბაზოში)
    qty_base        NUMERIC(14,3) NOT NULL CHECK (qty_base > 0),
    lot_no          VARCHAR(40),
    serial_no       VARCHAR(60),
    expires_on      DATE,
    produced_on     DATE,
    price           NUMERIC(14,4) CHECK (price >= 0),                      -- შეყვანილი ფასი შეფუთვაზე (დღგ-ით / გარეშე — დოკუმენტის მიხედვით)
    vat_rate        NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (vat_rate IN (0, 18)),
    unit_cost       NUMERIC(14,6) CHECK (unit_cost >= 0),                  -- საბაზო ერთეულზე, დღგ-ს გარეშე
    line_net        NUMERIC(14,2),
    line_vat        NUMERIC(14,2),
    lot_id          UUID REFERENCES stock_lots(id),                        -- გატარებისას
    short_expiry_reason TEXT,
    notes           TEXT,
    UNIQUE (doc_id, line_no)
);
CREATE INDEX idx_stock_doc_lines_doc ON stock_doc_lines (doc_id);
CREATE INDEX idx_stock_doc_lines_item ON stock_doc_lines (item_id);

-- გატარებული დოკუმენტი: ხაზები უცვლელია; თავში — მხოლოდ შემობრუნების ბმა
CREATE OR REPLACE FUNCTION stock_docs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'გატარებული / გაუქმებული დოკუმენტი არ იშლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_docs_immutable'; END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'posted' AND (NEW.status <> 'posted' OR (to_jsonb(NEW) - 'reversed_by' - 'updated_at') <> (to_jsonb(OLD) - 'reversed_by' - 'updated_at')) THEN
        RAISE EXCEPTION 'გატარებული დოკუმენტი არ იცვლება — გამოიყენეთ შემობრუნება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_docs_immutable';
    END IF;
    IF OLD.status = 'cancelled' THEN
        RAISE EXCEPTION 'გაუქმებული დოკუმენტი არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_docs_immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_docs_guard BEFORE UPDATE OR DELETE ON stock_docs FOR EACH ROW EXECUTE FUNCTION stock_docs_guard();

CREATE OR REPLACE FUNCTION stock_doc_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
    SELECT status INTO st FROM stock_docs WHERE id = coalesce(NEW.doc_id, OLD.doc_id);
    IF st IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;              -- მონახაზის წაშლის კასკადი
    -- გატარების ტრანზაქციაში ხაზს ევსება lot_id / unit_cost (სტატუსი ჯერ draft-ია); შემდეგ — აღარაფერი
    IF st IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'მხოლოდ მონახაზის ხაზები იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_doc_lines_immutable';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER trg_stock_doc_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_doc_lines FOR EACH ROW EXECUTE FUNCTION stock_doc_lines_guard();

-- ---------------------------------------------------------------- ნაშთები და საშუალო ფასი (მხოლოდ ტრიგერით)
CREATE TABLE stock_balances (
    location_id   UUID NOT NULL REFERENCES stock_locations(id),
    lot_id        UUID NOT NULL REFERENCES stock_lots(id),
    item_id       UUID NOT NULL REFERENCES stock_items(id),
    qty           NUMERIC(14,3) NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (location_id, lot_id),
    CONSTRAINT stock_balances_non_negative CHECK (qty >= 0)
);
CREATE INDEX idx_stock_balances_item ON stock_balances (item_id, location_id) WHERE qty > 0;

CREATE TABLE stock_item_costs (
    item_id       UUID PRIMARY KEY REFERENCES stock_items(id),
    qty_on_hand   NUMERIC(14,3) NOT NULL DEFAULT 0,                        -- ყველა ლოკაციაზე
    value_on_hand NUMERIC(20,8) NOT NULL DEFAULT 0,                        -- მარაგის ღირებულება (საშუალო = value / qty — დამრგვალების დაგროვების გარეშე)
    avg_cost      NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),  -- შეწონილი საშუალო, საბაზო ერთეულზე, დღგ-ს გარეშე
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- მოძრაობების ჟურნალი (უცვლელი)
CREATE TABLE stock_moves (
    id            BIGSERIAL PRIMARY KEY,
    doc_id        UUID NOT NULL REFERENCES stock_docs(id),
    line_id       UUID REFERENCES stock_doc_lines(id),
    move_type     VARCHAR(12) NOT NULL CHECK (move_type IN ('receipt', 'transfer', 'issue', 'return', 'writeoff', 'adjustment', 'consumption')),
    location_id   UUID NOT NULL REFERENCES stock_locations(id),
    lot_id        UUID NOT NULL REFERENCES stock_lots(id),
    item_id       UUID NOT NULL REFERENCES stock_items(id),
    qty           NUMERIC(14,3) NOT NULL CHECK (qty <> 0),                 -- საბაზო ერთეულებში: + შემოსვლა, − გასვლა
    cost_lot      NUMERIC(14,6) NOT NULL CHECK (cost_lot >= 0),            -- ლოტის ფასი
    cost_avg      NUMERIC(14,6),                                           -- შეწონილი საშუალო (ტრიგერი ავსებს)
    patient_id    UUID REFERENCES patients(id),                            -- ხარჯი პაციენტზე (0033)
    encounter_id  UUID REFERENCES encounters(id),
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_stock_moves_item ON stock_moves (item_id, created_at DESC);
CREATE INDEX idx_stock_moves_lot ON stock_moves (lot_id);
CREATE INDEX idx_stock_moves_doc ON stock_moves (doc_id);
CREATE INDEX idx_stock_moves_location ON stock_moves (location_id, created_at DESC);

CREATE OR REPLACE FUNCTION stock_moves_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c stock_item_costs%ROWTYPE; lot_item UUID; new_qty NUMERIC; new_val NUMERIC; cur_avg NUMERIC; new_avg NUMERIC;
BEGIN
    SELECT item_id INTO lot_item FROM stock_lots WHERE id = NEW.lot_id;
    IF lot_item IS DISTINCT FROM NEW.item_id THEN RAISE EXCEPTION 'ლოტი სხვა საქონელს ეკუთვნის'; END IF;
    -- საშუალო ფასი: მიღება (და მისი შემობრუნება) ღირებულებას ცვლის თავისი ფასით; დანარჩენი მოძრაობა — მიმდინარე საშუალოთი
    INSERT INTO stock_item_costs (item_id) VALUES (NEW.item_id) ON CONFLICT (item_id) DO NOTHING;
    SELECT * INTO c FROM stock_item_costs WHERE item_id = NEW.item_id FOR UPDATE;
    cur_avg := CASE WHEN c.qty_on_hand > 0 THEN c.value_on_hand / c.qty_on_hand ELSE c.avg_cost END;
    new_qty := c.qty_on_hand + NEW.qty;
    new_val := c.value_on_hand + NEW.qty * CASE WHEN NEW.move_type = 'receipt' THEN NEW.cost_lot ELSE cur_avg END;
    IF new_qty <= 0 THEN new_val := 0; END IF;
    new_avg := CASE WHEN new_qty > 0 THEN greatest(0, new_val / new_qty) WHEN NEW.move_type = 'receipt' AND NEW.qty > 0 THEN NEW.cost_lot ELSE cur_avg END;
    UPDATE stock_item_costs SET qty_on_hand = new_qty, value_on_hand = greatest(0, new_val), avg_cost = round(new_avg, 6), updated_at = now() WHERE item_id = NEW.item_id;
    NEW.cost_avg := round(CASE WHEN NEW.move_type = 'receipt' THEN new_avg ELSE cur_avg END, 6);
    -- ნაშთი (CHECK qty >= 0 — უარყოფითი შეუძლებელია); ჯერ UPDATE — INSERT … ON CONFLICT უარყოფით ჩანაწერს CHECK-ზე მანამდე ამოწმებს
    UPDATE stock_balances SET qty = qty + NEW.qty, updated_at = now() WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id;
    IF NOT FOUND THEN
        INSERT INTO stock_balances (location_id, lot_id, item_id, qty) VALUES (NEW.location_id, NEW.lot_id, NEW.item_id, NEW.qty);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_moves_apply BEFORE INSERT ON stock_moves FOR EACH ROW EXECUTE FUNCTION stock_moves_apply();

CREATE OR REPLACE FUNCTION stock_moves_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'მოძრაობების ჟურნალი უცვლელია' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_moves_immutable';
END $$;
CREATE TRIGGER trg_stock_moves_immutable BEFORE UPDATE OR DELETE ON stock_moves FOR EACH ROW EXECUTE FUNCTION stock_moves_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON stock_moves FROM emr_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON stock_balances, stock_item_costs FROM emr_app;
    REVOKE DELETE, TRUNCATE ON stock_lots FROM emr_app;
  END IF;
END $$;
