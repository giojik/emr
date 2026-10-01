-- 0029_notifications.sql
-- თანამშრომლის შეტყობინებები (ზარი თავსართში): დამნიშნავ ექიმს — „ანალიზის პასუხი მზადაა“ (კრიტიკული მნიშვნელობისას — სასწრაფო),
-- მიკრობიოლოგიის წინასწარი პასუხი. ერთი ვიზიტის წაუკითხავი შეტყობინება ერთიანდება (count), ახალი არ მრავლდება.
CREATE TABLE user_notifications (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id),
    kind            VARCHAR(20) NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT,
    link            TEXT,
    entity_id       UUID,
    items           TEXT[] NOT NULL DEFAULT '{}',        -- დაჯგუფებული ელემენტები (მაგ. ანალიზების სახელები)
    urgent          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_user_notifications_open ON user_notifications (user_id, kind, entity_id) WHERE read_at IS NULL;
CREATE INDEX ix_user_notifications_user ON user_notifications (user_id, updated_at DESC);
