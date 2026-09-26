-- 0017_management_capabilities.sql
-- ახალი უფლებები (კატალოგში; როლებს კლინიკა თავად ქმნის პანელიდან):
--   accountant   — ბუღალტერი: ფინანსური რეპორტები, ხარჯების ჟურნალი
--   manager      — მენეჯერი: პაციენტების ნაკადი (დღის დაფა, ჩაწერა, დიაგნოსტიკის განრიგი), აქტივობის რეპორტი, საკუთარი განყოფილების თანამშრომლები
--   hr           — HR: მომხმარებლები და როლების მინიჭება (ადმინისტრატორის უფლების გარეშე)
--   med_engineer — სამედიცინო ინჟინერი: აპარატები/ოთახები, ენდოსკოპების რეესტრი
--   viewer       — ხელმძღვანელობა: რეპორტები და განრიგები — მხოლოდ ნახვა
-- + ხარჯების ჟურნალი (expenses)

ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer']::VARCHAR(30)[]);

-- ხარჯების ჟურნალი — წაშლის ნაცვლად გაუქმება (მიზეზით)
CREATE TABLE expenses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expense_date    DATE NOT NULL,
    category        TEXT NOT NULL,                     -- ხელფასი, კომუნალური, სახარჯი მასალა, იჯარა…
    description     TEXT,
    amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method  VARCHAR(15) NOT NULL DEFAULT 'bank_transfer' CHECK (payment_method IN ('cash', 'card', 'bank_transfer')),
    supplier        TEXT,
    doc_number      TEXT,                              -- ინვოისი / ზედნადები / ხელშეკრულება
    department_id   UUID REFERENCES departments(id),
    is_void         BOOLEAN NOT NULL DEFAULT FALSE,
    void_reason     TEXT,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT is_void OR void_reason IS NOT NULL)
);
CREATE INDEX idx_expenses_date ON expenses (expense_date) WHERE NOT is_void;
CREATE TRIGGER trg_expenses_updated BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments (paid_at);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices (created_at);
