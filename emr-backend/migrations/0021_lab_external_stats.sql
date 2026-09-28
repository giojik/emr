-- 0021_lab_external_stats.sql
-- ლაბორატორია:
--  • გარე ლაბორატორიები (რეესტრი), ანალიზს — გარე ლაბორატორია, შესყიდვის ფასი, პასუხის ვადა (დღე)
--  • გაგზავნა (lab_ext_shipments: EX26-000001, გადაცემის აქტი) → პასუხს ელოდება (ვადის კონტროლი) → პასუხი = PDF კონკრეტულ ანალიზზე → ვალიდაცია
--  • ღირებულება ფიქსირდება გაგზავნისას (ext_cost) → თვიური ანგარიშსწორება ლაბორატორიით (lab_ext_settlements)
--  • delta-check: კომპონენტს — დასაშვები ცვლილება (%) წინა ვალიდირებულ შედეგთან, დროის ფანჯარაში (დღე)

CREATE TABLE lab_external_labs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    contact_person  TEXT,
    phone           TEXT,
    email           TEXT,
    note            TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_lab_external_labs_name ON lab_external_labs (lower(name));
CREATE TRIGGER trg_lab_external_labs_updated BEFORE UPDATE ON lab_external_labs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- არსებული ტექსტური „გარე ლაბორატორია“ → რეესტრი
INSERT INTO lab_external_labs (name)
SELECT DISTINCT trim(external_lab) FROM dx_services WHERE performed_by = 'external' AND coalesce(trim(external_lab), '') <> ''
ON CONFLICT DO NOTHING;

ALTER TABLE dx_services
    ADD COLUMN external_lab_id      UUID REFERENCES lab_external_labs(id),
    ADD COLUMN purchase_price       NUMERIC(10,2) CHECK (purchase_price IS NULL OR purchase_price >= 0),
    ADD COLUMN ext_turnaround_days  SMALLINT NOT NULL DEFAULT 7 CHECK (ext_turnaround_days BETWEEN 1 AND 120);
UPDATE dx_services s SET external_lab_id = l.id FROM lab_external_labs l
 WHERE s.performed_by = 'external' AND lower(trim(s.external_lab)) = lower(l.name);

CREATE SEQUENCE lab_ext_shipment_seq;
CREATE TABLE lab_ext_shipments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shipment_no     TEXT NOT NULL UNIQUE,
    lab_id          UUID NOT NULL REFERENCES lab_external_labs(id),
    courier         TEXT,
    note            TEXT,
    sent_by         UUID REFERENCES users(id),
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_lab_ext_shipments_lab ON lab_ext_shipments (lab_id, sent_at DESC);

ALTER TABLE dx_order_items
    ADD COLUMN ext_shipment_id      UUID REFERENCES lab_ext_shipments(id),
    ADD COLUMN ext_lab_id           UUID REFERENCES lab_external_labs(id),
    ADD COLUMN ext_cost             NUMERIC(10,2),
    ADD COLUMN ext_due_at           TIMESTAMPTZ,
    ADD COLUMN ext_result_path      TEXT,
    ADD COLUMN ext_result_name      TEXT,
    ADD COLUMN ext_result_at        TIMESTAMPTZ,
    ADD COLUMN ext_result_by        UUID REFERENCES users(id);
CREATE INDEX ix_dx_items_ext_open ON dx_order_items (ext_due_at) WHERE ext_shipment_id IS NOT NULL AND ext_result_at IS NULL;

CREATE TABLE lab_ext_settlements (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lab_id          UUID NOT NULL REFERENCES lab_external_labs(id),
    period          DATE NOT NULL CHECK (extract(day FROM period) = 1),   -- თვის პირველი დღე
    items_count     INT NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,
    invoice_no      TEXT,
    note            TEXT,
    paid_at         DATE,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (lab_id, period)
);

-- delta-check
ALTER TABLE lab_analytes
    ADD COLUMN delta_limit_pct   NUMERIC(6,1) CHECK (delta_limit_pct IS NULL OR delta_limit_pct > 0),
    ADD COLUMN delta_window_days SMALLINT NOT NULL DEFAULT 7 CHECK (delta_window_days BETWEEN 1 AND 365);
