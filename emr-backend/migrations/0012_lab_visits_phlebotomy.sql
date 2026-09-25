-- 0012_lab_visits_phlebotomy.sql
-- 1) ფლებოტომისტის როლი — ხედავს მხოლოდ ნიმუშის აღების რიგს
-- 2) ლაბორატორიული ვიზიტი ექიმის გარეშე (რეგისტრატურიდან; შესაძლოა გარე მიმართვით)
-- 3) ნიმუშის აღების პრობლემა ("ვერ აიღო") — მიზეზით

ALTER TABLE users DROP CONSTRAINT chk_users_role;
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (
    role IN ('admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager', 'phlebotomist'));

ALTER TABLE encounters
    ADD COLUMN visit_kind VARCHAR(15) NOT NULL DEFAULT 'consultation' CHECK (visit_kind IN ('consultation', 'lab')),
    ADD COLUMN external_referral TEXT;          -- გარე მიმართვა: ექიმი / დაწესებულება

ALTER TABLE dx_order_items
    ADD COLUMN collection_issue    TEXT,        -- "ვერ აიღო": ვენა, უარი, არ არის უზმოზე…
    ADD COLUMN collection_issue_at TIMESTAMPTZ;
