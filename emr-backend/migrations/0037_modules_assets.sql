-- 0037_modules_assets.sql
-- 1) მოდულები და პარამეტრები (system_modules): კლინიკის ადმინისტრატორი რთავს / თიშავს მოდულს და ცვლის მის პარამეტრებს —
--    სისტემა სხვა კლინიკაშიც ერგება ადგილობრივ წესებს; ნაგულისხმევი = მიმდინარე ქცევა. ყველა ცვლილება აუდიტში.
-- 2) ინვენტარის რეესტრი (ძირითადი საშუალებები: ავეჯი, IT, ტექნიკა; სამედიცინო აპარატურა — devices-ში რჩება):
--    საინვენტარო ნომერი (ფორმატი — პარამეტრი), კატეგორიები და მდგომარეობები (რედაქტირებადი), განყოფილება + ოთახი, პასუხისმგებელი,
--    გადაადგილება (პირდაპირ / მიმღების დადასტურებით), ჩამოწერის აქტი (პირდაპირ / ერთი დამმტკიცებელი / კომისია), ისტორია, ეტიკეტი

-- ---------------------------------------------------------------- მოდულები
CREATE TABLE system_modules (
    code        VARCHAR(40) PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    description TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    settings    JSONB NOT NULL DEFAULT '{}',
    sort_order  INT NOT NULL DEFAULT 100,
    updated_by  UUID REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('asset_register', 'ინვენტარის რეესტრი', 'ძირითადი საშუალებები (ავეჯი, IT, ტექნიკა): საინვენტარო ნომერი, ადგილი, პასუხისმგებელი, გადაადგილება, ჩამოწერა', TRUE,
 '{"inv_prefix": "INV", "inv_year": true, "inv_digits": 5, "require_room": true, "require_responsible": true,
   "move_mode": "confirm", "writeoff_mode": "single", "writeoff_committee": [], "committee_quorum": 2,
   "track_value": true, "label_size": "50x25", "label_code": "qr"}', 10);

-- ---------------------------------------------------------------- ცნობარები
CREATE TABLE asset_categories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name        VARCHAR(120) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
INSERT INTO asset_categories (code, name, sort_order) VALUES
('FURNITURE', 'ავეჯი', 10), ('IT', 'IT ტექნიკა (კომპიუტერი, პრინტერი, ქსელი)', 20), ('APPLIANCE', 'საყოფაცხოვრებო ტექნიკა', 30),
('OFFICE', 'საოფისე აღჭურვილობა', 40), ('OTHER', 'სხვა', 90);

CREATE TABLE asset_conditions (
    code        VARCHAR(30) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
    name        VARCHAR(80) NOT NULL,
    usable      BOOLEAN NOT NULL DEFAULT TRUE,                   -- გამოსაყენებელია თუ არა (რეპორტისთვის)
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100
);
INSERT INTO asset_conditions (code, name, usable, sort_order) VALUES
('good', 'კარგი', TRUE, 10), ('repair', 'საჭიროებს შეკეთებას', TRUE, 20), ('unusable', 'გამოუსადეგარი', FALSE, 30);

-- ---------------------------------------------------------------- რეესტრი
CREATE TABLE assets (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inv_no              VARCHAR(40) NOT NULL UNIQUE,
    name                VARCHAR(200) NOT NULL CHECK (length(btrim(name)) >= 2),
    category_id         UUID NOT NULL REFERENCES asset_categories(id),
    manufacturer        VARCHAR(120),
    model               VARCHAR(120),
    serial_no           VARCHAR(120),
    department_id       UUID REFERENCES departments(id),
    room                VARCHAR(60),
    responsible_user_id UUID REFERENCES users(id),
    condition_code      VARCHAR(30) NOT NULL DEFAULT 'good' REFERENCES asset_conditions(code),
    purchase_date       DATE,
    purchase_value      NUMERIC(14,2) CHECK (purchase_value >= 0),
    supplier_id         UUID REFERENCES stock_suppliers(id),
    warranty_until      DATE,
    status              VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'written_off')),
    notes               TEXT,
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_assets_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_assets_department ON assets (department_id, room) WHERE status = 'active';
CREATE INDEX idx_assets_responsible ON assets (responsible_user_id) WHERE status = 'active';
CREATE INDEX idx_assets_search ON assets (lower(name) text_pattern_ops);
CREATE UNIQUE INDEX ux_assets_serial ON assets (upper(serial_no), coalesce(manufacturer, '')) WHERE serial_no IS NOT NULL;

-- ისტორია (შექმნა, ცვლილება, მდგომარეობა, გადაადგილება, ჩამოწერა) — უცვლელი
CREATE TABLE asset_events (
    id          BIGSERIAL PRIMARY KEY,
    asset_id    UUID NOT NULL REFERENCES assets(id),
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'updated', 'condition', 'move_requested', 'moved', 'move_rejected', 'move_cancelled', 'writeoff_requested', 'written_off', 'writeoff_rejected')),
    data        JSONB NOT NULL DEFAULT '{}',
    user_id     UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_asset_events_asset ON asset_events (asset_id, id DESC);
CREATE OR REPLACE FUNCTION asset_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ისტორია არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_events_immutable'; END $$;
CREATE TRIGGER trg_asset_events_immutable BEFORE UPDATE OR DELETE ON asset_events FOR EACH ROW EXECUTE FUNCTION asset_events_immutable();

-- გადაადგილება (move_mode = confirm: მიმღები ადასტურებს; direct: მაშინვე)
CREATE TABLE asset_moves (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id            UUID NOT NULL REFERENCES assets(id),
    from_department_id  UUID REFERENCES departments(id),
    from_room           VARCHAR(60),
    from_responsible_id UUID REFERENCES users(id),
    to_department_id    UUID REFERENCES departments(id),
    to_room             VARCHAR(60),
    to_responsible_id   UUID REFERENCES users(id),
    status              VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'done', 'rejected', 'cancelled')),
    reason              TEXT,
    decision_note       TEXT,
    requested_by        UUID NOT NULL REFERENCES users(id),
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by          UUID REFERENCES users(id),
    decided_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX ux_asset_moves_pending ON asset_moves (asset_id) WHERE status = 'pending';
CREATE INDEX idx_asset_moves_to ON asset_moves (to_responsible_id, to_department_id) WHERE status = 'pending';

-- ჩამოწერის აქტი (writeoff_mode: direct / single / committee)
CREATE TABLE asset_writeoffs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    act_no        VARCHAR(20) UNIQUE,                                   -- AW26-000001 (დამტკიცებისას)
    status        VARCHAR(10) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    mode          VARCHAR(10) NOT NULL CHECK (mode IN ('direct', 'single', 'committee')),
    quorum        INT NOT NULL DEFAULT 1 CHECK (quorum >= 1),
    reason        TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    method        VARCHAR(20) NOT NULL DEFAULT 'disposal' CHECK (method IN ('disposal', 'sale', 'donation', 'transfer', 'other')),
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at    TIMESTAMPTZ
);
CREATE TABLE asset_writeoff_lines (
    writeoff_id   UUID NOT NULL REFERENCES asset_writeoffs(id),
    asset_id      UUID NOT NULL REFERENCES assets(id),
    PRIMARY KEY (writeoff_id, asset_id)
);
CREATE TABLE asset_writeoff_votes (
    writeoff_id   UUID NOT NULL REFERENCES asset_writeoffs(id),
    user_id       UUID NOT NULL REFERENCES users(id),
    approve       BOOLEAN NOT NULL,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (writeoff_id, user_id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON assets, asset_moves, asset_writeoffs, asset_writeoff_votes FROM emr_app;
  END IF;
END $$;
