-- 0034_stock_expiry_minmax.sql
-- საწყობი, ეტაპი 5 — კონტროლი და რეპორტები:
--   * ლოტის სტატუსი: ქარანტინი / გაწვევა (recall) / აღდგენა — ისტორიით (stock_lot_events); დაბლოკილი ლოტი არ გაიცემა და არ იხარჯება
--       (ჩამოწერა — დასაშვებია); მიკვლევა: სად არის ნაშთი, რომელ პაციენტებს მოხმარდა
--   * მინ/მაქს (stock_minmax: ლოკაცია × საქონელი): მინიმუმზე ქვემოთ → შეტყობინება + ერთი დაჭერით მოთხოვნის მონახაზი მაქსიმუმამდე
--       (წყარო — ლოკაციის ნაგულისხმევი მომწოდებელი ლოკაცია, stock_locations.default_source_id)
--   * ყოველდღიური შემოწმება (emr-worker): ვადაგასული / ვადაგასვლადი (კატეგორიის / საქონლის ზღვარი) და მინიმუმზე ქვემოთ —
--       შეტყობინება ლოკაციის პასუხისმგებლებს; stock_alert_runs — დღეში ერთხელ

ALTER TABLE stock_locations ADD COLUMN default_source_id UUID REFERENCES stock_locations(id);
ALTER TABLE stock_locations ADD CONSTRAINT stock_locations_source_not_self CHECK (default_source_id IS NULL OR default_source_id <> id);

-- ---------------------------------------------------------------- ლოტის სტატუსის ისტორია
CREATE TABLE stock_lot_events (
    id            BIGSERIAL PRIMARY KEY,
    lot_id        UUID NOT NULL REFERENCES stock_lots(id),
    from_status   VARCHAR(12) NOT NULL,
    to_status     VARCHAR(12) NOT NULL CHECK (to_status IN ('active', 'quarantine', 'recalled')),
    reason        TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    reference     VARCHAR(100),                                            -- მწარმოებლის / მარეგულირებლის შეტყობინების №
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_stock_lot_events_lot ON stock_lot_events (lot_id, created_at DESC);
CREATE INDEX idx_stock_lots_status ON stock_lots (status) WHERE status <> 'active';

-- ---------------------------------------------------------------- მინ/მაქს
CREATE TABLE stock_minmax (
    location_id   UUID NOT NULL REFERENCES stock_locations(id),
    item_id       UUID NOT NULL REFERENCES stock_items(id),
    min_qty       NUMERIC(14,3) NOT NULL CHECK (min_qty >= 0),            -- საბაზო ერთეულებში
    max_qty       NUMERIC(14,3) NOT NULL CHECK (max_qty > 0),
    updated_by    UUID NOT NULL REFERENCES users(id),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (location_id, item_id),
    CONSTRAINT stock_minmax_range CHECK (max_qty >= min_qty)
);
CREATE INDEX idx_stock_minmax_item ON stock_minmax (item_id);

-- ---------------------------------------------------------------- ყოველდღიური შემოწმება
CREATE TABLE stock_alert_runs (
    kind          VARCHAR(20) NOT NULL,                                    -- expiry | minmax
    run_date      DATE NOT NULL,
    stats         JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kind, run_date)
);
ALTER TABLE stock_settings ADD COLUMN alert_hour SMALLINT NOT NULL DEFAULT 8 CHECK (alert_hour BETWEEN 0 AND 23);   -- კლინიკის დროით
