-- 0036_lab_stock.sql
-- ლაბორატორია ↔ საწყობი (გადაწყვეტილება 7A — ხარჯვა ნაკრების გახსნისას):
--   * ლაბორატორიის ქვესაწყობი (stock_locations.kind = 'lab'): ლაბორატორიის თანამშრომლები (lab_doctor, lab_manager, diagnostic) მუშაობენ
--       მოთხოვნით / მიღებით / ინვენტარიზაციით, როგორც განყოფილება
--   * ნაკრების / ფლაკონის გახსნა (stock_lab_kits): ჩამოიწერება საწყობიდან (writeoff, მიზეზი lab_use — დამტკიცების გარეშე, WO26-),
--       ფიქსირდება გახსნის დრო, ანალიზატორი (lab_methods), სურვილით — ანალიტი, გახსნის შემდეგი სტაბილურობა (on-board) →
--       on-board ვადა = min(გახსნა + დღეები, ლოტის ვადა); სტატუსი: გამოყენებაში → დასრულდა / გადაიყარა
--   * საქონელზე ლაბორატორიის ნაგულისხმევი: ტესტები ერთეულზე (ნომინალური), on-board დღეები, ანალიზატორი, ანალიტი
--   * QC მასალა ← საწყობის ლოტი (lab_qc_materials.stock_lot_id): ლოტი და ვადა ხელახლა აღარ იწერება
--   * დილის შემოწმება: on-board ვადაგასული / დღეს იწურება → შეტყობინება ლაბორატორიას

ALTER TABLE stock_docs DROP CONSTRAINT stock_docs_writeoff_reason_check;
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_writeoff_reason_check
    CHECK (writeoff_reason IN ('expired', 'damaged', 'lost', 'department_use', 'recall', 'other', 'lab_use'));

ALTER TABLE stock_items ADD COLUMN lab_tests_per_unit INT CHECK (lab_tests_per_unit > 0);          -- ნომინალური ტესტები ერთ ერთეულზე (კასეტა = 400)
ALTER TABLE stock_items ADD COLUMN lab_onboard_days INT CHECK (lab_onboard_days BETWEEN 1 AND 730); -- გახსნის შემდეგ სტაბილურობა
ALTER TABLE stock_items ADD COLUMN lab_method_id UUID REFERENCES lab_methods(id);                  -- ნაგულისხმევი ანალიზატორი
ALTER TABLE stock_items ADD COLUMN lab_analyte_id UUID REFERENCES lab_analytes(id);                -- სურვილით: კონკრეტული ანალიტის რეაგენტი

CREATE TABLE stock_lab_kits (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    location_id         UUID NOT NULL REFERENCES stock_locations(id),
    item_id             UUID NOT NULL REFERENCES stock_items(id),
    lot_id              UUID NOT NULL REFERENCES stock_lots(id),
    doc_id              UUID NOT NULL REFERENCES stock_docs(id),                 -- ჩამოწერა (lab_use)
    qty_base            NUMERIC(14,3) NOT NULL CHECK (qty_base > 0),
    method_id           UUID REFERENCES lab_methods(id),
    analyte_id          UUID REFERENCES lab_analytes(id),
    tests_planned       INT CHECK (tests_planned > 0),                          -- ნომინალი × რაოდენობა (გახსნისას)
    opened_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_by           UUID NOT NULL REFERENCES users(id),
    onboard_expires_on  DATE,
    status              VARCHAR(10) NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'finished', 'discarded')),
    closed_at           TIMESTAMPTZ,
    closed_by           UUID REFERENCES users(id),
    close_reason        TEXT,
    notes               TEXT,
    CHECK (status = 'in_use' OR closed_at IS NOT NULL)
);
CREATE INDEX idx_stock_lab_kits_open ON stock_lab_kits (location_id, onboard_expires_on) WHERE status = 'in_use';
CREATE INDEX idx_stock_lab_kits_method ON stock_lab_kits (method_id, opened_at);

ALTER TABLE lab_qc_materials ADD COLUMN stock_lot_id UUID REFERENCES stock_lots(id);
