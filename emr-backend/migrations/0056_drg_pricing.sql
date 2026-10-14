-- 0056_drg_pricing.sql
-- DRG ბლოკი, ეტაპი 2 — თანხის ფორმულა (კონფიგურაცია DRG ვერსიაში).
--
--  • თანხა = საბაზისო განაკვეთი (გადამხდელის წესის ვერსიიდან, მინიჭებისას დაფიქსირებული — stay_payers.drg_base_rate)
--           × წონა (stay_payers.drg_weight) × კოეფიციენტები  ±  კომპონენტები (რიგით).
--  • კომპონენტი (drg_price_components) — ვერსიის ნაწილი (მხოლოდ მონახაზში იცვლება — drg_version_guard):
--      coef          — საბაზისოს კოეფიციენტი (კლინიკის კატეგორია / პროფილი / განყოფილება — პირობით);
--      high_los      — ხანგრძლივი დაყოვნება: (დღეები − ზედა ზღვარი) × საბაზისო / საშ. ხანგრძლივობა × კოეფ. (ან ფიქს. დღიური);
--      low_los       — მოკლე დაყოვნება: საბაზისო × max(მინ. %, დღეები / ქვედა ზღვარი);
--      transfer      — გადაყვანა სხვა კლინიკაში: min(საბაზისო, საბაზისო / საშ. ხანგრძლივობა × (დღეები + დამატებითი დღე));
--      percent       — ± % საბაზისოდან (მაგ. გარდაცვალება X დღეში — პირობით);
--      fixed         — ± ფიქსირებული თანხა;
--      per_unit      — ICU საათი / დღე, ვენტილაციის საათი, დღეები — ზღვარს ზემოთ × ერთეულის თანხა (ლიმიტით);
--      cost_outlier  — ძვირი შემთხვევა: ფაქტობრივი ხარჯი > ზღვარი (თანხა ან საბაზისოს ჯერადი) → ზედმეტის %;
--      cap           — შემთხვევის ზედა ლიმიტი (თანხა ან საბაზისოს ჯერადი).
--    პირობა — იგივე, რაც დაჯგუფების წესებში (+ ველი dept — განყოფილების კოდი); exclusive_group — ჯგუფში მხოლოდ პირველი შესაბამისი.
--  • ფინალიზაციისას თანხა და დაშლა ფიქსირდება (stay_payers.drg_amount, drg_breakdown); გახსნისას — იშლება.
--  • ვერსიის პარამეტრი rounding: total (ნაგ.) / component.

CREATE TABLE drg_price_components (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id       UUID NOT NULL REFERENCES drg_versions(id) ON DELETE CASCADE,
    seq              INT NOT NULL CHECK (seq > 0),
    kind             VARCHAR(14) NOT NULL CHECK (kind IN ('coef', 'high_los', 'low_los', 'transfer', 'percent', 'fixed', 'per_unit', 'cost_outlier', 'cap')),
    label            TEXT NOT NULL CHECK (length(btrim(label)) >= 2),
    conditions       JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
    params           JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),   -- ვალიდაცია — backend (სახეობის მიხედვით)
    exclusive_group  VARCHAR(30) CHECK (exclusive_group ~ '^[a-z0-9_]{1,30}$'),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    notes            TEXT
);
CREATE INDEX idx_drg_price_components ON drg_price_components (version_id, seq);
CREATE TRIGGER trg_drg_price_guard BEFORE INSERT OR UPDATE OR DELETE ON drg_price_components FOR EACH ROW EXECUTE FUNCTION drg_version_guard();

ALTER TABLE stay_payers
    ADD COLUMN drg_amount    NUMERIC(12,2),                                   -- ფინალიზაციისას დაფიქსირებული DRG თანხა (ტარიფი)
    ADD COLUMN drg_breakdown JSONB;                                          -- დაშლა: საბაზისო, კომპონენტები, ჯამი

DO $$
BEGIN
    REVOKE TRUNCATE ON drg_price_components FROM emr_app;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
