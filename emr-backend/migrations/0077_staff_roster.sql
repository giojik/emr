-- 0077_staff_roster.sql
-- ცვლები / მორიგეობა, ეტაპი 1 — საფუძველი (ბლოკი D, მოდული 4).
--
--  • მოდული `roster` (ჩართვადი) + უფლებები: roster (თავისი განყოფილებ(ებ)ის განრიგი — rpt_user_scopes ∪ users.department_id),
--      roster_all (მთელი კლინიკა + ცნობარები), roster_view (ნახვა). 41 → 44. hr — თანამშრომლები / პოზიციები / დღესასწაულები + მთელი კლინიკის ნახვა.
--      შაბლონ-როლი „განრიგის შემდგენი“ (roster) — რედაქტირებადი.
--  • პოზიციები (staff_positions) — HR-ის ცნება (უფლებისგან / როლისგან დამოუკიდებელი); კატეგორია: ექიმი / ექთანი / უმცროსი / ტექნიკური / ადმინისტრაციული / სხვა.
--      seed არ არის — კლინიკა თავად ავსებს.
--  • თანამშრომელი (staff_members): user_id არჩევითია — გრაფიკში შეიძლება იყოს EMR-ის ანგარიშის გარეშე პერსონალი (სანიტარი, მძღოლი…).
--      ძირითადი + დამატებითი განყოფილებები, განაკვეთი (FTE), შრომითი ურთიერთობა (ტიპი, თარიღები).
--  • ცვლის შაბლონები (shift_templates): დრო (შუაღამის გადაკვეთით; 24 სთ — დასაწყისი = დასასრული), შესვენება, ჩასათვლელი საათები, სახე, განყოფილებები / კატეგორიები.
--      სტაციონარის shift_times (გადაბარება, 0044) — უცვლელი, შაბლონზე არ არის მიბმული.
--  • დღესასწაულები (public_holidays) — ადმინი / HR ავსებს (seed 2026–2027 — გადასამოწმებელი).
--  • მორიგის როლები (duty_roles): განყოფილება (ან ნებისმიერი), კატეგორიები, საჭირო რაოდენობა, დონე I / II, მორიგის ტელეფონი.
--  • განრიგი (rosters): განყოფილება × თვე; მონახაზი → გამოქვეყნებული (→ დახურული — 0079). ჩანაწერები (roster_entries) — ცვლა / მორიგეობა,
--      ერთ თანამშრომელს ერთდროულად ორ ადგილას ვერ ექნება (EXCLUDE, ყველა განრიგში). გამოქვეყნების შემდეგ — ცვლილება მიზეზით, ისტორიაში (roster_changes).
--  • შევსების ნორმა (staffing_norms): განყოფილება × ცვლა × კატეგორია, მინ. რაოდენობა (კვირის დღეებით) → ხარვეზები.
--  • როტაციის ნიმუშები (rotation_patterns): ციკლი (შაბლონი / დასვენება) — მასობრივი შევსება.

-- ================================================================ 0. მოდული, უფლებები, როლი
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('roster', 'ცვლები და მორიგეობა', 'თანამშრომლები / პოზიციები, ცვლის შაბლონები, თვის განრიგი განყოფილებაზე (მონახაზი → გამოქვეყნება), მორიგეობა და „ვინ არის მორიგე“, წესები, შევსების ნორმა, როტაცია; შვებულება / გაცვლა, საათები, ანგარიშები — შემდეგი ეტაპები',
 TRUE, TRUE,
 '{"rest_min_hours": 12,
   "rest_mode": "warn",
   "max_continuous_hours": 24,
   "continuous_mode": "block",
   "max_week_hours": 48,
   "week_mode": "warn",
   "max_consecutive_nights": 3,
   "nights_mode": "warn",
   "norm_mode": "warn",
   "cross_department": "warn",
   "publish_notify": true,
   "change_notify": true,
   "duty_phone": "all",
   "copy_mode": "weekday"}', 49)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer',
        'storekeeper', 'stock_manager',
        'or_schedule', 'anesthesiologist', 'or_nurse',
        'procurement', 'procurement_approve',
        'tariffs', 'tariffs_approve',
        'drg', 'drg_admin',
        'reports', 'reports_all', 'reports_phi',
        'quality', 'quality_dept', 'quality_view',
        'infection', 'infection_dept', 'infection_view',
        'bme_dept', 'bme_view',
        'roster', 'roster_all', 'roster_view']::VARCHAR(30)[]);

INSERT INTO roles (code, name, description, is_system, capabilities, sort_order)
SELECT 'roster_planner', 'განრიგის შემდგენი', 'ცვლები და მორიგეობა: თავისი განყოფილებ(ებ)ის თვის განრიგი (მონახაზი, გამოქვეყნება, ცვლილება მიზეზით), მორიგეები, შევსების ნორმა; თანამშრომლის დამატება ანგარიშის გარეშე', FALSE,
       '{roster}', coalesce((SELECT max(sort_order) FROM roles), 0) + 10
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'roster_planner');

-- ================================================================ 1. პოზიციები, თანამშრომლები
CREATE TABLE staff_positions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code         VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name         TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    category     VARCHAR(8) NOT NULL CHECK (category IN ('doctor', 'nurse', 'junior', 'tech', 'admin', 'other')),
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 100,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE staff_members (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID UNIQUE REFERENCES users(id),                 -- NULL — EMR-ის ანგარიშის გარეშე
    first_name       VARCHAR(100) NOT NULL CHECK (length(btrim(first_name)) >= 1),
    last_name        VARCHAR(100) NOT NULL CHECK (length(btrim(last_name)) >= 1),
    personal_number  VARCHAR(11) UNIQUE CHECK (personal_number ~ '^[0-9]{11}$'),
    phone            VARCHAR(50),
    position_id      UUID REFERENCES staff_positions(id),
    department_id    UUID NOT NULL REFERENCES departments(id),          -- ძირითადი
    fte              NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (fte > 0 AND fte <= 1.5),
    employment       VARCHAR(10) NOT NULL DEFAULT 'staff' CHECK (employment IN ('staff', 'part_time', 'contract', 'intern', 'resident')),
    hired_on         DATE,
    left_on          DATE,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    notes            TEXT,
    created_by       UUID NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_staff_dates CHECK (left_on IS NULL OR hired_on IS NULL OR left_on >= hired_on)
);
CREATE INDEX idx_staff_department ON staff_members (department_id) WHERE is_active;
CREATE INDEX idx_staff_name ON staff_members (lower(last_name), lower(first_name));

-- დამატებითი განყოფილებები (სადაც შეიძლება მისი დაგეგმვა)
CREATE TABLE staff_member_departments (
    staff_id       UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
    department_id  UUID NOT NULL REFERENCES departments(id),
    PRIMARY KEY (staff_id, department_id)
);
CREATE INDEX idx_staff_extra_dept ON staff_member_departments (department_id);

-- ================================================================ 2. ცვლის შაბლონები, დღესასწაულები, მორიგის როლები
CREATE TABLE shift_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(6) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{0,5}$'),   -- ბადეში ჩანს
    name            TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    kind            VARCHAR(12) NOT NULL CHECK (kind IN ('day', 'evening', 'night', '24h', 'oncall_site', 'oncall_home', 'other')),
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,                     -- ≤ დასაწყისი → მეორე დღეს; = დასაწყისი → 24 სთ
    break_min       SMALLINT NOT NULL DEFAULT 0 CHECK (break_min BETWEEN 0 AND 240),
    counted_hours   NUMERIC(4,2) CHECK (counted_hours >= 0 AND counted_hours <= 24),   -- NULL — ხანგრძლივობა − შესვენება
    color           VARCHAR(7) NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    department_ids  UUID[] NOT NULL DEFAULT '{}',      -- ცარიელი — ყველა განყოფილება
    categories      VARCHAR(8)[] NOT NULL DEFAULT '{}' CHECK (categories <@ ARRAY['doctor', 'nurse', 'junior', 'tech', 'admin', 'other']::VARCHAR(8)[]),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO shift_templates (code, name, kind, start_time, end_time, break_min, counted_hours, color, sort_order) VALUES
('D',  'დღის ცვლა (08–20)',            'day',         '08:00', '20:00', 0,  NULL, '#0ea5e9', 10),
('N',  'ღამის ცვლა (20–08)',           'night',       '20:00', '08:00', 0,  NULL, '#6366f1', 20),
('24', 'სადღეღამისო (08–08)',          '24h',         '08:00', '08:00', 0,  NULL, '#dc2626', 30),
('W',  'სამუშაო დღე (09–18)',          'day',         '09:00', '18:00', 60, NULL, '#16a34a', 40),
('OC', 'მორიგეობა სახლიდან (18–09)',   'oncall_home', '18:00', '09:00', 0,  0,    '#f59e0b', 50);

CREATE TABLE public_holidays (
    day         DATE PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- საორიენტაციო (შრომის კოდექსის უქმე დღეები + აღდგომა 2026 / 2027); მთავრობის დამატებითი დღეები — ხელით. გადაამოწმეთ.
INSERT INTO public_holidays (day, name)
SELECT (y || '-' || md)::date, nm FROM (VALUES ('2026'), ('2027')) yy(y), (VALUES
    ('01-01', 'ახალი წელი'), ('01-02', 'ახალი წელი'), ('01-07', 'შობა'), ('01-19', 'ნათლისღება'), ('03-03', 'დედის დღე'), ('03-08', 'ქალთა საერთაშორისო დღე'),
    ('04-09', 'ეროვნული ერთიანობის დღე'), ('05-09', 'ფაშიზმზე გამარჯვების დღე'), ('05-12', 'წმ. ანდრია პირველწოდებულის ხსენების დღე'), ('05-17', 'ოჯახის სიწმინდის დღე'),
    ('05-26', 'დამოუკიდებლობის დღე'), ('08-28', 'მარიამობა'), ('10-14', 'სვეტიცხოვლობა'), ('11-23', 'გიორგობა')) d(md, nm)
UNION ALL SELECT x::date, nm FROM (VALUES
    ('2026-04-10', 'წითელი პარასკევი'), ('2026-04-11', 'დიდი შაბათი'), ('2026-04-12', 'აღდგომა'), ('2026-04-13', 'აღდგომის მეორე დღე (მიცვალებულთა მოხსენიება)'),
    ('2027-04-30', 'წითელი პარასკევი'), ('2027-05-01', 'დიდი შაბათი'), ('2027-05-02', 'აღდგომა'), ('2027-05-03', 'აღდგომის მეორე დღე (მიცვალებულთა მოხსენიება)')) e(x, nm)
ON CONFLICT (day) DO NOTHING;

CREATE TABLE duty_roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name            TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    department_id   UUID REFERENCES departments(id),      -- NULL — ნებისმიერი განყოფილების განრიგში
    categories      VARCHAR(8)[] NOT NULL DEFAULT '{}' CHECK (categories <@ ARRAY['doctor', 'nurse', 'junior', 'tech', 'admin', 'other']::VARCHAR(8)[]),
    required_count  SMALLINT NOT NULL DEFAULT 1 CHECK (required_count BETWEEN 0 AND 20),   -- დღეში (I დონე); 0 — ხარვეზი არ ითვლება
    has_backup      BOOLEAN NOT NULL DEFAULT FALSE,       -- II დონე (backup)
    phone           VARCHAR(50),                          -- მორიგის საერთო ტელეფონი
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ================================================================ 3. განრიგი
CREATE TABLE rosters (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id  UUID NOT NULL REFERENCES departments(id),
    month          DATE NOT NULL CHECK (extract(day FROM month) = 1),
    status         VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
    version        INT NOT NULL DEFAULT 0,                -- გამოქვეყნების შემდეგ ყოველი ცვლილება +1
    note           TEXT,
    created_by     UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at   TIMESTAMPTZ,
    published_by   UUID REFERENCES users(id),
    closed_at      TIMESTAMPTZ,
    closed_by      UUID REFERENCES users(id),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (department_id, month),
    CONSTRAINT chk_roster_published CHECK ((status = 'draft') = (published_at IS NULL) AND (published_at IS NULL) = (published_by IS NULL)),
    CONSTRAINT chk_roster_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
CREATE INDEX idx_rosters_month ON rosters (month);

CREATE TABLE roster_entries (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    roster_id          UUID NOT NULL REFERENCES rosters(id),
    staff_id           UUID NOT NULL REFERENCES staff_members(id),
    day                DATE NOT NULL,                          -- ცვლის დაწყების დღე
    shift_template_id  UUID NOT NULL REFERENCES shift_templates(id),
    starts_at          TIMESTAMPTZ NOT NULL,
    ends_at            TIMESTAMPTZ NOT NULL,
    hours              NUMERIC(5,2) NOT NULL CHECK (hours >= 0 AND hours <= 48),   -- ჩასათვლელი (გეგმა)
    duty_role_id       UUID REFERENCES duty_roles(id),
    duty_level         SMALLINT CHECK (duty_level IN (1, 2)),
    note               TEXT,
    status             VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at       TIMESTAMPTZ,
    cancelled_by       UUID REFERENCES users(id),
    cancel_reason      TEXT,
    CONSTRAINT chk_re_time CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '48 hours'),
    CONSTRAINT chk_re_duty CHECK ((duty_role_id IS NULL) = (duty_level IS NULL)),
    CONSTRAINT chk_re_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL)),
    -- ერთი თანამშრომელი ერთდროულად ორ ადგილას (ნებისმიერ განრიგში) — არა
    CONSTRAINT ex_re_overlap EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'active')
);
CREATE INDEX idx_re_roster ON roster_entries (roster_id, day) WHERE status = 'active';
CREATE INDEX idx_re_staff ON roster_entries (staff_id, starts_at) WHERE status = 'active';
CREATE INDEX idx_re_duty ON roster_entries (duty_role_id, starts_at) WHERE status = 'active' AND duty_role_id IS NOT NULL;
CREATE INDEX idx_re_time ON roster_entries USING gist (tstzrange(starts_at, ends_at)) WHERE status = 'active';

-- ისტორია: გამოქვეყნება, ცვლილებები გამოქვეყნების შემდეგ (მიზეზით), მასობრივი ოპერაციები
CREATE TABLE roster_changes (
    id          BIGSERIAL PRIMARY KEY,
    roster_id   UUID NOT NULL REFERENCES rosters(id),
    entry_id    UUID REFERENCES roster_entries(id),
    staff_id    UUID REFERENCES staff_members(id),
    kind        VARCHAR(12) NOT NULL CHECK (kind IN ('created', 'add', 'change', 'remove', 'publish', 'copy', 'rotation', 'bulk')),
    reason      TEXT,
    data        JSONB NOT NULL DEFAULT '{}',
    user_id     UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_rc_roster ON roster_changes (roster_id, id DESC);

-- ================================================================ 4. შევსების ნორმა, როტაცია
CREATE TABLE staffing_norms (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id      UUID NOT NULL REFERENCES departments(id),
    shift_template_id  UUID NOT NULL REFERENCES shift_templates(id),
    category           VARCHAR(8) NOT NULL CHECK (category IN ('doctor', 'nurse', 'junior', 'tech', 'admin', 'other')),
    min_count          SMALLINT NOT NULL CHECK (min_count BETWEEN 1 AND 100),
    weekdays           SMALLINT[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]),   -- ISO; ცარიელი — ყოველდღე
    holidays           BOOLEAN NOT NULL DEFAULT TRUE,          -- დღესასწაულზეც მოქმედებს
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_norms_dept ON staffing_norms (department_id) WHERE is_active;

CREATE TABLE rotation_patterns (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_]{1,29}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    cycle       UUID[] NOT NULL CHECK (cardinality(cycle) BETWEEN 1 AND 56),   -- თითო დღე: shift_templates.id; დასვენება — ნულოვანი UUID
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- ნიმუშები: 24/72, დღე-ღამე-დასვენება-დასვენება, 5/2 (სამუშაო დღე)
INSERT INTO rotation_patterns (code, name, cycle)
SELECT 'R24_72', 'სადღეღამისო / 3 დღე დასვენება (24/72)', ARRAY[(SELECT id FROM shift_templates WHERE code = '24'), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']::UUID[]
UNION ALL
SELECT 'DNOO', 'დღე — ღამე — დასვენება — დასვენება', ARRAY[(SELECT id FROM shift_templates WHERE code = 'D'), (SELECT id FROM shift_templates WHERE code = 'N'), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']::UUID[]
UNION ALL
SELECT 'W5_2', 'სამუშაო კვირა 5/2 (ორშ.–პარ.)', ARRAY[(SELECT id FROM shift_templates WHERE code = 'W'), (SELECT id FROM shift_templates WHERE code = 'W'), (SELECT id FROM shift_templates WHERE code = 'W'),
       (SELECT id FROM shift_templates WHERE code = 'W'), (SELECT id FROM shift_templates WHERE code = 'W'), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']::UUID[];

-- ================================================================ 5. updated_at, უფლებები
CREATE TRIGGER trg_staff_positions_updated BEFORE UPDATE ON staff_positions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_members_updated BEFORE UPDATE ON staff_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_shift_templates_updated BEFORE UPDATE ON shift_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_duty_roles_updated BEFORE UPDATE ON duty_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_rosters_updated BEFORE UPDATE ON rosters FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_roster_entries_updated BEFORE UPDATE ON roster_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staffing_norms_updated BEFORE UPDATE ON staffing_norms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_rotation_patterns_updated BEFORE UPDATE ON rotation_patterns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON staff_positions, staff_members, staff_member_departments, shift_templates, public_holidays, duty_roles,
                                           rosters, roster_entries, staffing_norms, rotation_patterns TO emr_app;
    GRANT SELECT, INSERT ON roster_changes TO emr_app;
    GRANT USAGE, SELECT ON SEQUENCE roster_changes_id_seq TO emr_app;
  END IF;
END $$;
