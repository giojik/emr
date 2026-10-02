-- 0035_pharmacy_controlled.sql
-- აფთიაქი — ნარკოტიკული და ფსიქოტროპული საშუალებების აღრიცხვა:
--   * მოწმე (მეორე პირი, საკუთარი პაროლით): კონტროლირებადის (ნარკოტიკული / ფსიქოტროპული) ხარჯი პაციენტზე და ჩამოწერა;
--       stock_docs.witness_id ≠ ავტორი
--   * დოზა ხაზზე: მიღებული (dose_given) და განადგურებული ნარჩენი (dose_wasted) — ჯენერიკის დოზის ერთეულში;
--       ჯამი = რაოდენობა × აქტიური ნივთიერება ერთეულში (თუ ჯენერიკზე მითითებულია)
--   * ცარიელი ამპულის / ფლაკონის დაბრუნება (ნარკოტიკული): ხარჯის ხაზზე empty_returned_at / _by — აფთიაქი ადასტურებს
--   * ცვლის ჩაბარება (stock_shift_counts): ლოკაციის კონტროლირებადი ნაშთის დათვლა ორი პირით; სხვაობა → სასწრაფო შეტყობინება
--   * ჟურნალი — stock_moves-იდან (უცვლელი), ლოკაცია × საქონელი, მიმდინარე ნაშთით (ცალკე ცხრილი არ სჭირდება)

ALTER TABLE stock_docs ADD COLUMN witness_id UUID REFERENCES users(id);
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_witness_other CHECK (witness_id IS NULL OR witness_id <> created_by);

ALTER TABLE stock_doc_lines ADD COLUMN dose_given NUMERIC(12,3) CHECK (dose_given >= 0);
ALTER TABLE stock_doc_lines ADD COLUMN dose_wasted NUMERIC(12,3) CHECK (dose_wasted >= 0);
ALTER TABLE stock_doc_lines ADD COLUMN dose_unit VARCHAR(10);
ALTER TABLE stock_doc_lines ADD COLUMN empty_returned_at TIMESTAMPTZ;
ALTER TABLE stock_doc_lines ADD COLUMN empty_returned_by UUID REFERENCES users(id);

-- გატარებული დოკუმენტის ხაზი: იცვლება მხოლოდ ცარიელის დაბრუნების დადასტურება (ერთხელ)
CREATE OR REPLACE FUNCTION stock_doc_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
    SELECT status INTO st FROM stock_docs WHERE id = coalesce(NEW.doc_id, OLD.doc_id);
    IF st IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;              -- მონახაზის წაშლის კასკადი
    IF st = 'posted' AND TG_OP = 'UPDATE' AND OLD.empty_returned_at IS NULL AND NEW.empty_returned_at IS NOT NULL
       AND (to_jsonb(NEW) - 'empty_returned_at' - 'empty_returned_by') = (to_jsonb(OLD) - 'empty_returned_at' - 'empty_returned_by') THEN
        RETURN NEW;
    END IF;
    IF st IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'მხოლოდ მონახაზის ხაზები იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_doc_lines_immutable';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$;

CREATE INDEX idx_stock_doc_lines_empty ON stock_doc_lines (item_id) WHERE empty_returned_at IS NULL AND dose_given IS NOT NULL;

-- ---------------------------------------------------------------- ცვლის ჩაბარება
CREATE TABLE stock_shift_counts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_no        VARCHAR(20) NOT NULL UNIQUE,                               -- SH26-000001
    location_id     UUID NOT NULL REFERENCES stock_locations(id),
    handed_by       UUID NOT NULL REFERENCES users(id),                        -- აბარებს (შესული მომხმარებელი)
    received_by     UUID NOT NULL REFERENCES users(id),                        -- იბარებს (მოწმე — საკუთარი პაროლით)
    status          VARCHAR(12) NOT NULL CHECK (status IN ('ok', 'discrepancy')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (handed_by <> received_by)
);
CREATE INDEX idx_stock_shift_counts_loc ON stock_shift_counts (location_id, created_at DESC);

CREATE TABLE stock_shift_count_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id        UUID NOT NULL REFERENCES stock_shift_counts(id),
    item_id         UUID NOT NULL REFERENCES stock_items(id),
    lot_id          UUID NOT NULL REFERENCES stock_lots(id),
    expected_qty    NUMERIC(14,3) NOT NULL,
    counted_qty     NUMERIC(14,3) NOT NULL CHECK (counted_qty >= 0),
    UNIQUE (shift_id, lot_id)
);

-- ცვლის ჩაბარება — ისტორია, არ იცვლება
CREATE OR REPLACE FUNCTION stock_shift_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ცვლის ჩაბარების ჩანაწერი არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_shift_immutable';
END $$;
CREATE TRIGGER trg_stock_shift_counts_immutable BEFORE UPDATE OR DELETE ON stock_shift_counts FOR EACH ROW EXECUTE FUNCTION stock_shift_immutable();
CREATE TRIGGER trg_stock_shift_lines_immutable BEFORE UPDATE OR DELETE ON stock_shift_count_lines FOR EACH ROW EXECUTE FUNCTION stock_shift_immutable();
