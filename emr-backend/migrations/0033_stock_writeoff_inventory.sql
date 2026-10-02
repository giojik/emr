-- 0033_stock_writeoff_inventory.sql
-- საწყობი, ეტაპი 4 — ჩამოწერა, ინვენტარიზაცია, ხარჯი პაციენტზე:
--   * ჩამოწერა (stock_docs.doc_type = writeoff): მიზეზი (ვადაგასული, დაზიანებული, დაკარგული, განყოფილების ხარჯი, გაწვევა, სხვა);
--       ღირებულება > ზღვარი (stock_settings.writeoff_approval_threshold) ან კონტროლირებადი საქონელი → საწყობის მენეჯერის დამტკიცება; WO26-000001
--   * ინვენტარიზაცია (stock_counts + ხაზები) — გადაწყვეტილება 4A: დაწყებისას ლოკაცია იბლოკება (ნებისმიერი მოძრაობა, კორექტირების გარდა),
--       „ბრმა“ დათვლა (მთვლელი სისტემურ ნაშთს ვერ ხედავს), ნაპოვნი ზედმეტი — ახალი ხაზით; დამტკიცება (საწყობის მენეჯერი) →
--       სხვაობა ცალკე კორექტირების დოკუმენტით (AD26-…) და ლოკაციის განბლოკვა; IC26-000001
--   * ხარჯი პაციენტზე (doc_type = consumption): ლოკაცია, პაციენტი, ვიზიტი; ხაზზე — ლოტი (FEFO); მოძრაობას ახლავს patient_id / encounter_id;
--       ბილინგი — კლინიკის კონფიგურაციით (საქონელი → კატეგორია): „ინვოისში“ → ვიზიტის ინვოისს ემატება ხაზი გასაყიდი ფასით
--       (საქონლის ფასი, ან თვითღირებულება კლინიკის მეთოდით + კატეგორიის ფასნამატი); CN26-000001
--   * ჩამოწერისა და ხარჯის შემობრუნება (საწყობის მენეჯერი) — მარაგი ბრუნდება, ინვოისის ხაზი იშლება (თუ გადახდა არ აჭარბებს)

ALTER TABLE stock_settings ADD COLUMN writeoff_approval_threshold NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (writeoff_approval_threshold >= 0);

-- ---------------------------------------------------------------- დოკუმენტი: ჩამოწერა / ხარჯი
ALTER TABLE stock_docs ADD COLUMN writeoff_reason VARCHAR(16)
    CHECK (writeoff_reason IN ('expired', 'damaged', 'lost', 'department_use', 'recall', 'other'));
ALTER TABLE stock_docs ADD COLUMN approval_status VARCHAR(10) CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE stock_docs ADD COLUMN approved_by UUID REFERENCES users(id);
ALTER TABLE stock_docs ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE stock_docs ADD COLUMN patient_id UUID REFERENCES patients(id);
ALTER TABLE stock_docs ADD COLUMN encounter_id UUID REFERENCES encounters(id);
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_writeoff_reason CHECK (doc_type <> 'writeoff' OR writeoff_reason IS NOT NULL);
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_consumption_patient CHECK (doc_type <> 'consumption' OR (patient_id IS NOT NULL AND location_id IS NOT NULL));
CREATE INDEX idx_stock_docs_pending ON stock_docs (approval_status) WHERE approval_status = 'pending';
CREATE INDEX idx_stock_docs_patient ON stock_docs (patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX idx_stock_docs_encounter ON stock_docs (encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX idx_stock_moves_patient ON stock_moves (patient_id) WHERE patient_id IS NOT NULL;

ALTER TABLE stock_doc_lines ADD COLUMN sale_price NUMERIC(12,2) CHECK (sale_price >= 0);    -- ხარჯი: ინვოისში ჩაწერილი ფასი (საბაზო ერთეულზე)

-- ინვოისის ხაზი ← ხარჯის ხაზი (შემობრუნებისას იშლება)
ALTER TABLE invoice_line_items ADD COLUMN stock_doc_line_id UUID REFERENCES stock_doc_lines(id);
CREATE UNIQUE INDEX ux_invoice_lines_stock ON invoice_line_items (stock_doc_line_id) WHERE stock_doc_line_id IS NOT NULL;

-- გატარებულზე იცვლება მხოლოდ: შემობრუნების ბმა, მიღების დადასტურება (ერთხელ); მონახაზზე — დამტკიცების ველები
CREATE OR REPLACE FUNCTION stock_docs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'გატარებული / გაუქმებული დოკუმენტი არ იშლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_docs_immutable'; END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'posted' THEN
        IF NEW.status <> 'posted'
           OR (to_jsonb(NEW) - 'reversed_by' - 'updated_at' - 'received_by' - 'received_at' - 'receive_status' - 'receive_note')
              <> (to_jsonb(OLD) - 'reversed_by' - 'updated_at' - 'received_by' - 'received_at' - 'receive_status' - 'receive_note')
           OR (OLD.receive_status IS NOT NULL AND (NEW.receive_status IS DISTINCT FROM OLD.receive_status OR NEW.received_at IS DISTINCT FROM OLD.received_at)) THEN
            RAISE EXCEPTION 'გატარებული დოკუმენტი არ იცვლება — გამოიყენეთ შემობრუნება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_docs_immutable';
        END IF;
    END IF;
    IF OLD.status = 'cancelled' THEN
        RAISE EXCEPTION 'გაუქმებული დოკუმენტი არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_docs_immutable';
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------- ინვენტარიზაცია
CREATE TABLE stock_counts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    count_no        VARCHAR(20) NOT NULL UNIQUE,                                -- IC26-000001
    location_id     UUID NOT NULL REFERENCES stock_locations(id),
    status          VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'counted', 'approved', 'cancelled')),
    blind           BOOLEAN NOT NULL DEFAULT TRUE,                              -- მთვლელი სისტემურ ნაშთს ვერ ხედავს
    category_id     UUID REFERENCES stock_categories(id),                       -- NULL — მთელი ლოკაცია
    notes           TEXT,
    reason          TEXT,                                                       -- გაუქმების / ხელახალი დათვლის მიზეზი
    started_by      UUID NOT NULL REFERENCES users(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_by    UUID REFERENCES users(id),
    submitted_at    TIMESTAMPTZ,
    approved_by     UUID REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    adjustment_doc_id UUID REFERENCES stock_docs(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_stock_counts_updated_at BEFORE UPDATE ON stock_counts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- ერთ ლოკაციაზე ერთდროულად ერთი აქტიური ინვენტარიზაცია
CREATE UNIQUE INDEX ux_stock_counts_active ON stock_counts (location_id) WHERE status IN ('open', 'counted');

CREATE TABLE stock_count_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    count_id        UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    item_id         UUID NOT NULL REFERENCES stock_items(id),
    lot_id          UUID REFERENCES stock_lots(id),                             -- NULL — ნაპოვნი ლოტი, რომელიც სისტემაში არ არის
    lot_no          VARCHAR(40),
    serial_no       VARCHAR(60),
    expires_on      DATE,
    expected_qty    NUMERIC(14,3) NOT NULL DEFAULT 0,                           -- ნაშთი დაწყებისას (ბრმა დათვლისას მთვლელი ვერ ხედავს)
    counted_qty     NUMERIC(14,3) CHECK (counted_qty >= 0),
    counted_by      UUID REFERENCES users(id),
    counted_at      TIMESTAMPTZ,
    is_extra        BOOLEAN NOT NULL DEFAULT FALSE,                             -- დაწყების შემდეგ დამატებული (ნაპოვნი)
    note            TEXT
);
CREATE INDEX idx_stock_count_lines_count ON stock_count_lines (count_id);
CREATE UNIQUE INDEX ux_stock_count_lines_lot ON stock_count_lines (count_id, lot_id) WHERE lot_id IS NOT NULL;

ALTER TABLE stock_docs ADD COLUMN count_id UUID REFERENCES stock_counts(id);

-- ---------------------------------------------------------------- ბლოკი (4A): ინვენტარიზაციის დროს ლოკაციაზე მოძრაობა მხოლოდ კორექტირებით
CREATE OR REPLACE FUNCTION stock_moves_count_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c_no TEXT;
BEGIN
    SELECT count_no INTO c_no FROM stock_counts WHERE location_id = NEW.location_id AND status IN ('open', 'counted');
    IF c_no IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_docs d WHERE d.id = NEW.doc_id AND d.doc_type = 'adjustment') THEN
        RAISE EXCEPTION 'ლოკაციაზე მიმდინარეობს ინვენტარიზაცია % — მოძრაობა დაბლოკილია', c_no
            USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_location_counting';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_moves_count_lock BEFORE INSERT ON stock_moves FOR EACH ROW EXECUTE FUNCTION stock_moves_count_lock();
-- (ტრიგერები ანბანური რიგით სრულდება: trg_stock_moves_apply → trg_stock_moves_count_lock; ორივე BEFORE — შეცდომისას ჩანაწერი არ ჩაიწერება)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON stock_counts FROM emr_app;
  END IF;
END $$;
