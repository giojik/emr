-- 0025_lab_gateway_ext.sql
-- ანალიზატორების gateway — გაფართოება:
--  • ცალმხრივი ტექსტური პროტოკოლი ('text'): Urisys 1100, Roller 20 და მსგავსი „პრინტერის“ გამოტანა; parser — რეგულარული გამოსახულებებით (settings)
--  • ჰისტოგრამები / სურათები შეკვეთაზე (lab_result_images): სურათი (PNG/JPEG/BMP, საცავში) ან ჰისტოგრამის რიცხვები (points)
--  • HL7: ქვერის პასუხი DSR^Q03 (settings.hl7_query_reply = 'dsr')
ALTER TABLE lab_instruments DROP CONSTRAINT IF EXISTS lab_instruments_protocol_check;
DROP TRIGGER trg_lab_instruments_updated ON lab_instruments;             -- სვეტის ტიპის შესაცვლელად (ტრიგერი protocol-ს ეყრდნობა)
ALTER TABLE lab_instruments ALTER COLUMN protocol TYPE VARCHAR(5);
CREATE TRIGGER trg_lab_instruments_updated BEFORE UPDATE OF method_id, protocol, conn_mode, host, port, is_enabled, order_mode, settings, listen_only
    ON lab_instruments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE lab_instruments ADD CONSTRAINT lab_instruments_protocol_check CHECK (protocol IN ('astm', 'hl7', 'text'));

CREATE TABLE lab_result_images (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id   UUID NOT NULL REFERENCES dx_order_items(id),
    instrument_id   UUID REFERENCES lab_instruments(id) ON DELETE SET NULL,
    code            TEXT NOT NULL,                    -- ანალიზატორის კოდი (WBC_HIST, RBC, PLT …)
    title           TEXT,
    kind            VARCHAR(9) NOT NULL CHECK (kind IN ('image', 'histogram')),
    mime            TEXT,
    storage_path    TEXT,                             -- image
    points          JSONB,                            -- histogram: [n1, n2, …]
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((kind = 'image' AND storage_path IS NOT NULL) OR (kind = 'histogram' AND points IS NOT NULL))
);
-- განმეორებითი გაზომვა — იმავე კოდის გრაფიკა იცვლება
CREATE UNIQUE INDEX uq_lab_result_images ON lab_result_images (order_item_id, upper(code));
