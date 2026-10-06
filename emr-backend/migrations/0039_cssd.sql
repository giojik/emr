-- 0039_cssd.sql
-- CSSD — სტერილიზაცია (მოდული „cssd“; ყველა წესი — კლინიკის პარამეტრი):
--   ორგანიზაცია: დამუშავების ერთეული = stock_locations.kind = 'cssd', მიბმული განყოფილებაზე — ერთი (ცენტრალური CSSD)
--     ან რამდენიმე (დეცენტრალიზებული: განყოფილება თავისას თავად ამუშავებს)
--   ნაკრების ტიპი (შაბლონი: შემადგენლობა, შეფუთვა, იმპლანტი) → ფიზიკური ნაკრები (შტრიხკოდი) → ციკლის შეფუთვა (pack: ეტიკეტი, ვადა)
--   ნაკადი: ბინძური მიღება → რეცხვა → შემოწმება / შეფუთვა (ჩეკლისტი) → სტერილიზაცია (ციკლი: აპარატი, პროგრამა, პარამეტრები, ჩატვირთვა,
--     ქიმიური ინდიკატორი თითო შეფუთვაზე) → გაშვება (BI — პარამეტრით) → შენახვა (ვადა შეფუთვის ტიპით) → გაცემა → გამოყენება (პაციენტი) → დაბრუნება
--   Bowie-Dick (ორთქლის აპარატი, დღის პირველ ციკლამდე), BI (სიხშირე, მოლოდინი იმპლანტზე / ყველაზე), ჩავარდნილი BI → გაწვევა
--   ინსტრუმენტების ცალკე აღრიცხვა (C2) — ჩასართავი; შეფუთვის მასალის ავტომატური ჩამოწერა CSSD-ის ქვესაწყობიდან — ჩასართავი

INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('cssd', 'სტერილიზაცია (CSSD)', 'ნაკრებები, რეცხვა, შეფუთვა, ავტოკლავის ციკლები, ინდიკატორები (Bowie-Dick, ქიმიური, ბიოლოგიური), სტერილობის ვადა, გაცემა, პაციენტზე მიკვლევა, გაწვევა', TRUE,
 '{"instrument_tracking": false, "cycle_entry": "manual", "wash_record": true, "bd_required": true, "bi_frequency": "weekly", "bi_hold": "implant",
   "shelf_life_mode": "time", "patient_trace": true, "auto_consume": true, "label_size": "50x25", "label_code": "qr"}', 20);

-- ---------------------------------------------------------------- ცნობარები
CREATE TABLE cssd_packaging_types (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(120) NOT NULL UNIQUE,
    shelf_days    INT CHECK (shelf_days BETWEEN 1 AND 3650),                 -- NULL — მოვლენაზე დამოკიდებული (ვადა არ აქვს)
    consumables   JSONB NOT NULL DEFAULT '[]',                               -- [{item_id, qty}] — ავტომატური ჩამოწერა შეფუთვისას
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INT NOT NULL DEFAULT 100
);
INSERT INTO cssd_packaging_types (name, shelf_days, sort_order) VALUES
('ქაღალდ-პლასტიკური პაკეტი', 180, 10), ('სტერილიზაციის ქსოვილი (ორმაგი)', 30, 20), ('არაქსოვილოვანი შეფუთვა', 90, 30), ('მყარი კონტეინერი', 180, 40);

CREATE TABLE cssd_machines (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(120) NOT NULL,
    kind          VARCHAR(12) NOT NULL CHECK (kind IN ('steam', 'plasma', 'eo', 'dry_heat', 'washer')),
    location_id   UUID NOT NULL REFERENCES stock_locations(id),
    manufacturer  VARCHAR(120),
    model         VARCHAR(120),
    serial_no     VARCHAR(120),
    programs      JSONB NOT NULL DEFAULT '[]',                               -- [{name, temp, minutes}] — ნაგულისხმევი პარამეტრები
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cssd_templates (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
    name                VARCHAR(200) NOT NULL,
    owner_department_id UUID REFERENCES departments(id),
    packaging_type_id   UUID REFERENCES cssd_packaging_types(id),
    is_implant          BOOLEAN NOT NULL DEFAULT FALSE,                      -- იმპლანტი / იმპლანტის ნაკრები — BI-ს მოლოდინი (პარამეტრით)
    program_hint        VARCHAR(60),                                         -- მაგ. „134° 5 წთ“
    notes               TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE cssd_template_items (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id   UUID NOT NULL REFERENCES cssd_templates(id) ON DELETE CASCADE,
    line_no       INT NOT NULL,
    name          VARCHAR(200) NOT NULL,
    qty           INT NOT NULL CHECK (qty > 0),
    UNIQUE (template_id, line_no)
);

-- ---------------------------------------------------------------- ნაკრები (ფიზიკური) და ინსტრუმენტი
CREATE TABLE cssd_sets (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    barcode           VARCHAR(40) NOT NULL UNIQUE,                           -- CS-000001 / ხელით
    template_id       UUID NOT NULL REFERENCES cssd_templates(id),
    serial            VARCHAR(20),                                           -- „№3“
    home_location_id  UUID NOT NULL REFERENCES stock_locations(id),          -- რომელი CSSD ამუშავებს
    status            VARCHAR(12) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'received', 'washed', 'packed', 'in_use', 'retired')),
    holder_department_id UUID REFERENCES departments(id),                    -- სად არის (გაცემის შემდეგ)
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_cssd_sets_updated_at BEFORE UPDATE ON cssd_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cssd_instruments (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code          VARCHAR(60) NOT NULL UNIQUE,                               -- ლაზერული / UDI
    name          VARCHAR(200) NOT NULL,
    set_id        UUID REFERENCES cssd_sets(id),
    cycles        INT NOT NULL DEFAULT 0,
    max_cycles    INT CHECK (max_cycles > 0),
    status        VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'repair', 'retired')),
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- ციკლი (რეცხვა / სტერილიზაცია / Bowie-Dick)
CREATE TABLE cssd_cycles (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cycle_no      VARCHAR(30) NOT NULL,
    machine_id    UUID NOT NULL REFERENCES cssd_machines(id),
    kind          VARCHAR(12) NOT NULL CHECK (kind IN ('sterilize', 'bowie_dick', 'wash')),
    program       VARCHAR(60),
    temp_c        NUMERIC(5,1),
    minutes       NUMERIC(6,1),
    pressure_bar  NUMERIC(5,2),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result        VARCHAR(6) NOT NULL CHECK (result IN ('pass', 'fail')),
    bi_used       BOOLEAN NOT NULL DEFAULT FALSE,
    bi_lot        VARCHAR(40),
    bi_result     VARCHAR(8) CHECK (bi_result IN ('pending', 'pass', 'fail')),
    bi_read_at    TIMESTAMPTZ,
    bi_read_by    UUID REFERENCES users(id),
    attachment_key VARCHAR(300),                                             -- ამობეჭდილის ფოტო (MinIO)
    notes         TEXT,
    operator_id   UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (machine_id, cycle_no),
    CHECK ((bi_used AND bi_result IS NOT NULL) OR (NOT bi_used AND bi_result IS NULL))
);
CREATE INDEX idx_cssd_cycles_machine ON cssd_cycles (machine_id, started_at DESC);

-- ---------------------------------------------------------------- შეფუთვა (ნაკრების ერთი სტერილიზაცია)
CREATE TABLE cssd_packs (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pack_no           VARCHAR(30) NOT NULL UNIQUE,                           -- SP26-000001 (ეტიკეტზე)
    set_id            UUID NOT NULL REFERENCES cssd_sets(id),
    location_id       UUID NOT NULL REFERENCES stock_locations(id),          -- CSSD, სადაც დამუშავდა
    packaging_type_id UUID NOT NULL REFERENCES cssd_packaging_types(id),
    wash_cycle_id     UUID REFERENCES cssd_cycles(id),
    checklist         JSONB NOT NULL DEFAULT '[]',                           -- [{name, expected, counted, note}]
    incomplete        BOOLEAN NOT NULL DEFAULT FALSE,
    packed_by         UUID NOT NULL REFERENCES users(id),
    packed_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cycle_id          UUID REFERENCES cssd_cycles(id),
    ci_pass           BOOLEAN,                                               -- ქიმიური ინდიკატორი
    expires_on        DATE,
    status            VARCHAR(12) NOT NULL DEFAULT 'packed' CHECK (status IN ('packed', 'sterile', 'quarantine', 'failed', 'issued', 'used', 'expired', 'recalled', 'reprocess')),
    issued_department_id UUID REFERENCES departments(id),
    issued_at         TIMESTAMPTZ,
    issued_by         UUID REFERENCES users(id),
    used_at           TIMESTAMPTZ,
    used_by           UUID REFERENCES users(id),
    patient_id        UUID REFERENCES patients(id),
    encounter_id      UUID REFERENCES encounters(id),
    note              TEXT
);
CREATE INDEX idx_cssd_packs_set ON cssd_packs (set_id, packed_at DESC);
CREATE INDEX idx_cssd_packs_cycle ON cssd_packs (cycle_id);
CREATE INDEX idx_cssd_packs_status ON cssd_packs (status, expires_on);
CREATE INDEX idx_cssd_packs_patient ON cssd_packs (patient_id) WHERE patient_id IS NOT NULL;
-- ნაკრებს ერთდროულად ერთი „ცოცხალი“ შეფუთვა
CREATE UNIQUE INDEX ux_cssd_packs_live ON cssd_packs (set_id) WHERE status IN ('packed', 'sterile', 'quarantine', 'issued');

-- ისტორია (ნაკრები + შეფუთვა) — უცვლელი
CREATE TABLE cssd_events (
    id          BIGSERIAL PRIMARY KEY,
    set_id      UUID NOT NULL REFERENCES cssd_sets(id),
    pack_id     UUID REFERENCES cssd_packs(id),
    kind        VARCHAR(20) NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}',
    user_id     UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_cssd_events_set ON cssd_events (set_id, id DESC);
CREATE OR REPLACE FUNCTION cssd_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ისტორია არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'cssd_events_immutable'; END $$;
CREATE TRIGGER trg_cssd_events_immutable BEFORE UPDATE OR DELETE ON cssd_events FOR EACH ROW EXECUTE FUNCTION cssd_events_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON cssd_cycles, cssd_packs, cssd_sets FROM emr_app;
  END IF;
END $$;

-- შეფუთვის მასალის ავტომატური ჩამოწერა — ჩამოწერის მიზეზი cssd_use (დამტკიცების გარეშე)
ALTER TABLE stock_docs DROP CONSTRAINT stock_docs_writeoff_reason_check;
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_writeoff_reason_check
    CHECK (writeoff_reason IN ('expired', 'damaged', 'lost', 'department_use', 'recall', 'other', 'lab_use', 'cssd_use'));
