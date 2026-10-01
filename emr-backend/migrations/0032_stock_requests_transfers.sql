-- 0032_stock_requests_transfers.sql
-- საწყობი, ეტაპი 3 — მოთხოვნა → დამტკიცება → გაცემა → მიღების დადასტურება (გადაწყვეტილება 1A), გადაცემა, დაბრუნება:
--   * ლოკაცია „გზაში“ (kind = transit, კოდი TRANSIT): გაცემისას მარაგი გამცემიდან გადადის „გზაში“, მიმღების დადასტურებისას — მიმღებთან;
--       უკან დაბრუნებისას (მიმღებმა არ მიიღო) — ისევ გამცემთან. სულ მარაგი არ იცვლება → საშუალო ფასი არ იცვლება
--   * მოთხოვნა (stock_requests + ხაზები): მონახაზი → გაგზავნილი → დამტკიცებული (ან ავტომატურად, თუ ლოკაციას დამტკიცება არ სჭირდება
--       და კონტროლირებადი საქონელი არ არის) → ნაწილობრივ / სრულად გაცემული → დახურული; უარყოფილი; გაუქმებული; ნომერი RQ26-000001
--       ხაზზე: მოთხოვნილი / დამტკიცებული / გაცემული (საბაზოში), პაციენტი („მხოლოდ პაციენტზე“ საქონელზე — სავალდებულო)
--   * გაცემის / გადაცემის / დაბრუნების დოკუმენტი = stock_docs (transfer / return): გამცემი, მიმღები, მოთხოვნა, გაგზავნა (posted) → მიღება (received_at)
--       ხაზზე — კონკრეტული ლოტი (FEFO; სხვა ლოტი — მიზეზით)

ALTER TABLE stock_locations DROP CONSTRAINT stock_locations_kind_check;
ALTER TABLE stock_locations ADD CONSTRAINT stock_locations_kind_check
    CHECK (kind IN ('central', 'pharmacy', 'household', 'department', 'operating', 'cssd', 'lab', 'icu', 'other', 'transit'));
INSERT INTO stock_locations (code, name, kind, requires_approval, sort_order) VALUES ('TRANSIT', 'გზაში', 'transit', FALSE, 999)
ON CONFLICT (code) DO NOTHING;
CREATE UNIQUE INDEX ux_stock_locations_transit ON stock_locations (kind) WHERE kind = 'transit';

-- ---------------------------------------------------------------- მოთხოვნები
CREATE TABLE stock_requests (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    req_no            VARCHAR(20) UNIQUE,                                   -- გაგზავნისას: RQ26-000001
    status            VARCHAR(12) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'submitted', 'approved', 'partial', 'issued', 'closed', 'rejected', 'cancelled')),
    from_location_id  UUID NOT NULL REFERENCES stock_locations(id),         -- ვისგან (აფთიაქი / საწყობი)
    to_location_id    UUID NOT NULL REFERENCES stock_locations(id),         -- ვისთვის (ქვესაწყობი)
    urgent            BOOLEAN NOT NULL DEFAULT FALSE,
    notes             TEXT,
    requires_approval BOOLEAN NOT NULL DEFAULT TRUE,                        -- გაგზავნისას ფიქსირდება
    created_by        UUID NOT NULL REFERENCES users(id),
    submitted_at      TIMESTAMPTZ,
    approved_by       UUID REFERENCES users(id),
    approved_at       TIMESTAMPTZ,
    rejected_by       UUID REFERENCES users(id),
    rejected_at       TIMESTAMPTZ,
    reason            TEXT,                                                 -- უარყოფის / დახურვის / გაუქმების მიზეზი
    closed_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (from_location_id <> to_location_id),
    CHECK (status = 'draft' OR status = 'cancelled' OR req_no IS NOT NULL)
);
CREATE TRIGGER trg_stock_requests_updated_at BEFORE UPDATE ON stock_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_stock_requests_status ON stock_requests (status, created_at DESC);
CREATE INDEX idx_stock_requests_to ON stock_requests (to_location_id, created_at DESC);
CREATE INDEX idx_stock_requests_from ON stock_requests (from_location_id, status);

CREATE TABLE stock_request_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id      UUID NOT NULL REFERENCES stock_requests(id) ON DELETE CASCADE,
    line_no         INT NOT NULL,
    item_id         UUID NOT NULL REFERENCES stock_items(id),
    pack_id         UUID REFERENCES stock_item_packs(id),
    qty             NUMERIC(14,3) NOT NULL CHECK (qty > 0),                  -- შეფუთვებში (ან საბაზოში)
    qty_base        NUMERIC(14,3) NOT NULL CHECK (qty_base > 0),             -- მოთხოვნილი
    qty_approved    NUMERIC(14,3) CHECK (qty_approved >= 0),                 -- NULL — ჯერ არ დამტკიცებულა
    qty_issued      NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
    patient_id      UUID REFERENCES patients(id),                            -- „მხოლოდ პაციენტზე“ საქონელი
    notes           TEXT,
    UNIQUE (request_id, line_no)
);
CREATE INDEX idx_stock_request_lines_req ON stock_request_lines (request_id);

-- ---------------------------------------------------------------- დოკუმენტი: გაცემა / გადაცემა / დაბრუნება
ALTER TABLE stock_docs ADD COLUMN request_id UUID REFERENCES stock_requests(id);
ALTER TABLE stock_docs ADD COLUMN received_by UUID REFERENCES users(id);
ALTER TABLE stock_docs ADD COLUMN received_at TIMESTAMPTZ;
ALTER TABLE stock_docs ADD COLUMN receive_status VARCHAR(10) CHECK (receive_status IN ('received', 'returned'));
ALTER TABLE stock_docs ADD COLUMN receive_note TEXT;
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_transfer_locations
    CHECK (doc_type NOT IN ('transfer', 'return') OR (from_location_id IS NOT NULL AND to_location_id IS NOT NULL AND from_location_id <> to_location_id));
CREATE INDEX idx_stock_docs_request ON stock_docs (request_id);
CREATE INDEX idx_stock_docs_transit ON stock_docs (to_location_id) WHERE status = 'posted' AND receive_status IS NULL AND doc_type IN ('transfer', 'return');

ALTER TABLE stock_doc_lines ADD COLUMN request_line_id UUID REFERENCES stock_request_lines(id);
ALTER TABLE stock_doc_lines ADD COLUMN patient_id UUID REFERENCES patients(id);
ALTER TABLE stock_doc_lines ADD COLUMN override_reason TEXT;                   -- FEFO-ს გარდა სხვა ლოტი
CREATE INDEX idx_stock_doc_lines_request_line ON stock_doc_lines (request_line_id);

-- გატარებულ დოკუმენტზე იცვლება მხოლოდ: შემობრუნების ბმა და მიღების დადასტურება (ერთხელ)
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
