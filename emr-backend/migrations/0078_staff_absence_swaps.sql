-- 0078_staff_absence_swaps.sql
-- ცვლები / მორიგეობა, ეტაპი 2 (ბლოკი D, მოდული 4): შვებულება / არყოფნა, დასაფარი ცვლები, გაცვლა / გადაცემა, ჩანაცვლება, „არ შემიძლია“ / სურვილები.
--
--  • არყოფნის ტიპები (absence_types) — კლინიკის ცნობარი: ანაზღაურება, ბალანსი (წლიური ნორმა), ერთეული (სამუშაო / კალენდარული დღე),
--      დადასტურების მარშრუტი (ხელმძღვანელი → HR / ხელმძღვანელი / HR / მხოლოდ რეგისტრაცია), დოკუმენტი, თვითმომსახურება, „ნამუშევრად ითვლება“ (0079).
--      seed: ANNUAL (24 სამუშაო დღე — შრომის კოდექსის მინიმუმი), UNPAID, SICK, MATERNITY, STUDY, TRIP, COMP, OTHER.
--  • ბალანსი — ჟურნალი (absence_balance_entries): დარიცხვა / კორექცია / გადატანა / გამოყენება / აღდგენა; ნაშთი = ჯამი (ხელით არ იცვლება).
--      აპლიკაციას — მხოლოდ INSERT / SELECT. ინდივიდუალური ნორმა — absence_entitlements.
--  • მოთხოვნა (absence_requests): head → hr → approved (ან rejected / cancelled); ერთი თანამშრომლის აქტიური მოთხოვნები არ გადაიფარება (EXCLUDE).
--      საბოლოო დადასტურებისას: მონახაზში ცვლები იშლება, გამოქვეყნებულში — უქმდება და ხდება „დასაფარი“.
--  • დასაფარი ცვლები (roster_open_shifts) + მოხალისეები „ავიღებ“ (roster_open_shift_offers).
--  • გაცვლა / გადაცემა (roster_swaps): ინიციატორი → კოლეგა → ხელმძღვანელი (swap_approval) → ატომური შესრულება.
--  • „არ შემიძლია“ / „მირჩევნია“ (staff_prefs) — თვის განრიგის შედგენამდე.
--  • უფლება absence_approve (არყოფნის დადასტურება თავის განყოფილებ(ებ)ში, განრიგის რედაქტირების გარეშე). 44 → 45.

-- ================================================================ 0. პარამეტრები, უფლება
UPDATE system_modules SET settings = '{"absence_unit_mode": "weekdays",
   "accrual": "annual",
   "balance_overdraw": "block",
   "swap_approval": "head",
   "swap_min_notice_hours": 12,
   "open_shift_volunteer": true,
   "open_shift_notify": true,
   "prefs_mode": "warn",
   "prefs_deadline_day": 0,
   "unavailable_max_per_month": 4}'::jsonb || settings,
  description = 'თანამშრომლები / პოზიციები, ცვლის შაბლონები, თვის განრიგი განყოფილებაზე (მონახაზი → გამოქვეყნება), მორიგეობა და „ვინ არის მორიგე“, წესები, შევსების ნორმა, როტაცია; შვებულება / არყოფნა და ბალანსი, დასაფარი ცვლები, გაცვლა / ჩანაცვლება, „არ შემიძლია“ დღეები; საათები, ანგარიშები — შემდეგი ეტაპები'
WHERE code = 'roster';

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
        'roster', 'roster_all', 'roster_view', 'absence_approve']::VARCHAR(30)[]);

-- განრიგის ისტორია: + გაცვლა / გადაცემა / ჩანაცვლება / არყოფნა / დასაფარის შევსება
ALTER TABLE roster_changes DROP CONSTRAINT roster_changes_kind_check;
ALTER TABLE roster_changes ADD CONSTRAINT roster_changes_kind_check CHECK (kind IN ('created', 'add', 'change', 'remove', 'publish', 'copy', 'rotation', 'bulk',
    'swap', 'give', 'replace', 'absence', 'fill'));

-- ================================================================ 1. არყოფნის ტიპები, ინდივიდუალური ნორმა
CREATE TABLE absence_types (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code               VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
    name               TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    short              VARCHAR(3) NOT NULL CHECK (length(btrim(short)) >= 1),          -- ბადეში ჩანს
    color              VARCHAR(7) NOT NULL DEFAULT '#94a3b8' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    paid               BOOLEAN NOT NULL DEFAULT TRUE,
    counts_as_work     BOOLEAN NOT NULL DEFAULT FALSE,                                  -- 0079 ტაბელი (მაგ. მივლინება)
    unit               VARCHAR(8) NOT NULL DEFAULT 'workday' CHECK (unit IN ('workday', 'calendar')),
    has_balance        BOOLEAN NOT NULL DEFAULT FALSE,
    default_days       NUMERIC(5,1) CHECK (default_days IS NULL OR (default_days >= 0 AND default_days <= 366)),   -- წლიური ნორმა (ბალანსიანზე); NULL — მხოლოდ ხელით
    route              VARCHAR(8) NOT NULL DEFAULT 'head_hr' CHECK (route IN ('head_hr', 'head', 'hr', 'none')),
    requires_document  BOOLEAN NOT NULL DEFAULT FALSE,
    self_request       BOOLEAN NOT NULL DEFAULT TRUE,                                   -- თანამშრომელს შეუძლია თავად მოთხოვნა
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order         INT NOT NULL DEFAULT 100,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_at_balance CHECK (has_balance OR default_days IS NULL)
);
INSERT INTO absence_types (code, name, short, color, paid, counts_as_work, unit, has_balance, default_days, route, requires_document, self_request, sort_order) VALUES
('ANNUAL',    'წლიური ანაზღაურებადი შვებულება',            'შ',  '#16a34a', TRUE,  FALSE, 'workday',  TRUE,  24,   'head_hr', FALSE, TRUE,  10),
('UNPAID',    'ანაზღაურების გარეშე შვებულება',              'შა', '#64748b', FALSE, FALSE, 'calendar', FALSE, NULL, 'head_hr', FALSE, TRUE,  20),
('SICK',      'ავადმყოფობა (ბიულეტენი)',                    'ბ',  '#dc2626', TRUE,  FALSE, 'calendar', FALSE, NULL, 'hr',      TRUE,  TRUE,  30),
('MATERNITY', 'დეკრეტული / ბავშვის მოვლის შვებულება',       'დ',  '#db2777', TRUE,  FALSE, 'calendar', FALSE, NULL, 'hr',      TRUE,  TRUE,  40),
('STUDY',     'სასწავლო შვებულება',                         'სწ', '#7c3aed', FALSE, FALSE, 'workday',  FALSE, NULL, 'head_hr', TRUE,  TRUE,  50),
('TRIP',      'მივლინება / კონფერენცია',                    'მ',  '#0891b2', TRUE,  TRUE,  'workday',  FALSE, NULL, 'head',    FALSE, TRUE,  60),
('COMP',      'ნაცვლად დასვენება (ზეგანაკვეთის / მორიგეობის)', 'ნდ', '#ca8a04', TRUE,  FALSE, 'workday',  TRUE,  NULL, 'head',    FALSE, TRUE,  70),
('OTHER',     'სხვა (ოჯახური მიზეზი…)',                     'სხ', '#94a3b8', FALSE, FALSE, 'workday',  FALSE, NULL, 'head',    FALSE, TRUE,  80);

-- ინდივიდუალური წლიური ნორმა (ხელშეკრულებით მეტი შვებულება და სხვ.)
CREATE TABLE absence_entitlements (
    staff_id         UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
    absence_type_id  UUID NOT NULL REFERENCES absence_types(id),
    days_per_year    NUMERIC(5,1) NOT NULL CHECK (days_per_year >= 0 AND days_per_year <= 366),
    note             TEXT,
    updated_by       UUID NOT NULL REFERENCES users(id),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (staff_id, absence_type_id)
);

-- ================================================================ 2. მოთხოვნები
CREATE TABLE absence_requests (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    no                   BIGSERIAL NOT NULL UNIQUE,                       -- ეკრანზე „#N“
    staff_id             UUID NOT NULL REFERENCES staff_members(id),
    absence_type_id      UUID NOT NULL REFERENCES absence_types(id),
    date_from            DATE NOT NULL,
    date_to              DATE NOT NULL,
    days                 NUMERIC(6,1) NOT NULL CHECK (days >= 0),          -- ტიპის ერთეულით (სამუშაო / კალენდარული დღე)
    counted_days         DATE[] NOT NULL DEFAULT '{}',                      -- ჩათვლილი დღეები (ადრე დასრულებისას — გადათვლა)
    balance_year         SMALLINT NOT NULL,                                -- ბალანსის წელი = დაწყების წელი
    status               VARCHAR(10) NOT NULL CHECK (status IN ('head', 'hr', 'approved', 'rejected', 'cancelled')),
    route                VARCHAR(8) NOT NULL CHECK (route IN ('head_hr', 'head', 'hr', 'none')),   -- შექმნისას (ტიპის შეცვლა არსებულს არ ცვლის)
    note                 TEXT,
    document_no          VARCHAR(60),
    doc_path             TEXT,
    doc_mime             VARCHAR(40),
    doc_name             TEXT,
    overdraw_reason      TEXT,                                             -- ნაშთის გადაჭარბება (HR-ის დადასტურებით)
    created_by           UUID NOT NULL REFERENCES users(id),
    on_behalf            BOOLEAN NOT NULL DEFAULT FALSE,                    -- შეიტანა ხელმძღვანელმა / HR-მა
    head_by              UUID REFERENCES users(id),
    head_at              TIMESTAMPTZ,
    head_note            TEXT,
    head_skipped         BOOLEAN NOT NULL DEFAULT FALSE,                    -- მომთხოვნი თავადაა ერთადერთი ხელმძღვანელი
    hr_by                UUID REFERENCES users(id),
    hr_at                TIMESTAMPTZ,
    hr_note              TEXT,
    decided_by           UUID REFERENCES users(id),
    decided_at           TIMESTAMPTZ,
    reject_reason        TEXT,
    cancel_requested_at  TIMESTAMPTZ,                                       -- დადასტურებულის გაუქმების თხოვნა (დაწყებამდე)
    cancel_request_note  TEXT,
    cancelled_by         UUID REFERENCES users(id),
    cancelled_at         TIMESTAMPTZ,
    cancel_reason        TEXT,
    shortened_from       DATE,                                              -- ადრე დასრულება (HR) — თავდაპირველი date_to
    roster_applied       JSONB,                                             -- დადასტურებისას: წაშლილი / გაუქმებული ცვლები
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_ar_dates CHECK (date_to >= date_from AND date_to - date_from <= 731),
    CONSTRAINT chk_ar_reject CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
    CONSTRAINT chk_ar_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
    -- ერთი თანამშრომლის აქტიური (განხილვაში / დადასტურებული) არყოფნები არ გადაიფარება
    CONSTRAINT ex_ar_overlap EXCLUDE USING gist (staff_id WITH =, daterange(date_from, date_to, '[]') WITH &&) WHERE (status IN ('head', 'hr', 'approved'))
);
CREATE INDEX idx_ar_staff ON absence_requests (staff_id, date_from);
CREATE INDEX idx_ar_status ON absence_requests (status) WHERE status IN ('head', 'hr') OR cancel_requested_at IS NOT NULL;
CREATE INDEX idx_ar_period ON absence_requests USING gist (daterange(date_from, date_to, '[]')) WHERE status IN ('head', 'hr', 'approved');

-- ================================================================ 3. ბალანსის ჟურნალი
CREATE TABLE absence_balance_entries (
    id               BIGSERIAL PRIMARY KEY,
    staff_id         UUID NOT NULL REFERENCES staff_members(id),
    absence_type_id  UUID NOT NULL REFERENCES absence_types(id),
    year             SMALLINT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
    kind             VARCHAR(8) NOT NULL CHECK (kind IN ('accrual', 'adjust', 'carry', 'use', 'restore')),
    period           SMALLINT NOT NULL DEFAULT 0 CHECK (period BETWEEN 0 AND 12),   -- დარიცხვა: 0 — წლიური, 1–12 — თვიური
    days             NUMERIC(6,1) NOT NULL,                                          -- + / − (გამოყენება — უარყოფითი)
    request_id       UUID REFERENCES absence_requests(id),
    reason           TEXT,
    user_id          UUID REFERENCES users(id),                                      -- NULL — ავტომატური დარიცხვა
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_abe_sign CHECK ((kind = 'use' AND days <= 0) OR (kind IN ('accrual', 'restore') AND days >= 0) OR kind IN ('adjust', 'carry')),
    CONSTRAINT chk_abe_reason CHECK (kind IN ('accrual', 'use', 'restore') OR length(btrim(coalesce(reason, ''))) >= 3)
);
CREATE INDEX idx_abe_staff ON absence_balance_entries (staff_id, absence_type_id, year);
-- ავტომატური დარიცხვა — ერთხელ (წელი / თვე)
CREATE UNIQUE INDEX uq_abe_accrual ON absence_balance_entries (staff_id, absence_type_id, year, period) WHERE kind = 'accrual';

-- ================================================================ 4. დასაფარი ცვლები, მოხალისეები
CREATE TABLE roster_open_shifts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    roster_id           UUID NOT NULL REFERENCES rosters(id),
    day                 DATE NOT NULL,
    shift_template_id   UUID NOT NULL REFERENCES shift_templates(id),
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,
    hours               NUMERIC(5,2) NOT NULL CHECK (hours >= 0 AND hours <= 48),
    duty_role_id        UUID REFERENCES duty_roles(id),
    duty_level          SMALLINT CHECK (duty_level IN (1, 2)),
    category            VARCHAR(8) CHECK (category IN ('doctor', 'nurse', 'junior', 'tech', 'admin', 'other')),   -- NULL — ნებისმიერი
    source              VARCHAR(8) NOT NULL CHECK (source IN ('absence', 'cancel', 'manual')),
    source_entry_id     UUID REFERENCES roster_entries(id),
    absence_request_id  UUID REFERENCES absence_requests(id),
    note                TEXT,
    status              VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
    filled_entry_id     UUID REFERENCES roster_entries(id),
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_by           UUID REFERENCES users(id),
    closed_at           TIMESTAMPTZ,
    cancel_reason       TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_os_time CHECK (ends_at > starts_at),
    CONSTRAINT chk_os_duty CHECK ((duty_role_id IS NULL) = (duty_level IS NULL)),
    CONSTRAINT chk_os_filled CHECK ((status = 'filled') = (filled_entry_id IS NOT NULL)),
    CONSTRAINT chk_os_closed CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX idx_os_roster ON roster_open_shifts (roster_id, day);
CREATE INDEX idx_os_open ON roster_open_shifts (starts_at) WHERE status = 'open';

CREATE TABLE roster_open_shift_offers (
    open_shift_id  UUID NOT NULL REFERENCES roster_open_shifts(id),
    staff_id       UUID NOT NULL REFERENCES staff_members(id),
    status         VARCHAR(10) NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'withdrawn')),
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (open_shift_id, staff_id)
);

-- ================================================================ 5. გაცვლა / გადაცემა
CREATE TABLE roster_swaps (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    no              BIGSERIAL NOT NULL UNIQUE,
    kind            VARCHAR(4) NOT NULL CHECK (kind IN ('swap', 'give')),
    from_staff_id   UUID NOT NULL REFERENCES staff_members(id),
    from_entry_id   UUID NOT NULL REFERENCES roster_entries(id),
    to_staff_id     UUID NOT NULL REFERENCES staff_members(id),
    to_entry_id     UUID REFERENCES roster_entries(id),               -- გაცვლა — კოლეგის ცვლა; გადაცემა — NULL
    status          VARCHAR(10) NOT NULL DEFAULT 'peer' CHECK (status IN ('peer', 'head', 'approved', 'rejected', 'declined', 'cancelled', 'expired')),
    note            TEXT,
    warnings        JSONB NOT NULL DEFAULT '[]',                       -- ბოლო შემოწმების გაფრთხილებები (ხელმძღვანელისთვის)
    expires_at      TIMESTAMPTZ NOT NULL,                              -- ადრეული ცვლის დაწყება − მინ. წინასწარობა
    created_by      UUID NOT NULL REFERENCES users(id),
    peer_at         TIMESTAMPTZ,
    peer_note       TEXT,
    head_by         UUID REFERENCES users(id),
    head_at         TIMESTAMPTZ,
    head_note       TEXT,
    reason          TEXT,                                              -- უარი / გაუქმება
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_sw_kind CHECK ((kind = 'swap') = (to_entry_id IS NOT NULL)),
    CONSTRAINT chk_sw_people CHECK (from_staff_id <> to_staff_id)
);
-- ერთ ცვლაზე ერთდროულად ერთი აქტიური გაცვლა (ორივე მხრიდან — აპლიკაცია)
CREATE UNIQUE INDEX uq_sw_from ON roster_swaps (from_entry_id) WHERE status IN ('peer', 'head');
CREATE UNIQUE INDEX uq_sw_to ON roster_swaps (to_entry_id) WHERE status IN ('peer', 'head') AND to_entry_id IS NOT NULL;
CREATE INDEX idx_sw_staff ON roster_swaps (from_staff_id, created_at DESC);
CREATE INDEX idx_sw_to_staff ON roster_swaps (to_staff_id, created_at DESC);

-- ================================================================ 6. „არ შემიძლია“ / „მირჩევნია“
CREATE TABLE staff_prefs (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id           UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
    day                DATE NOT NULL,
    kind               VARCHAR(12) NOT NULL CHECK (kind IN ('unavailable', 'prefer')),
    part               VARCHAR(5) NOT NULL DEFAULT 'all' CHECK (part IN ('all', 'day', 'night')),   -- unavailable: მთელი დღე / დღის / ღამის ცვლა
    shift_template_id  UUID REFERENCES shift_templates(id),                                         -- prefer: სასურველი ცვლა (არჩევითი)
    note               VARCHAR(300),
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (staff_id, day, kind),
    CONSTRAINT chk_sp_kind CHECK (kind = 'prefer' OR shift_template_id IS NULL)
);
CREATE INDEX idx_sp_day ON staff_prefs (day, staff_id);

-- ================================================================ 7. updated_at, უფლებები
CREATE TRIGGER trg_absence_types_updated BEFORE UPDATE ON absence_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_absence_requests_updated BEFORE UPDATE ON absence_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_roster_open_shifts_updated BEFORE UPDATE ON roster_open_shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_roster_open_shift_offers_updated BEFORE UPDATE ON roster_open_shift_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_roster_swaps_updated BEFORE UPDATE ON roster_swaps FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON absence_types, absence_entitlements, absence_requests, roster_open_shifts, roster_open_shift_offers,
                                           roster_swaps, staff_prefs TO emr_app;
    GRANT USAGE, SELECT ON SEQUENCE absence_requests_no_seq, roster_swaps_no_seq, absence_balance_entries_id_seq TO emr_app;
    -- ბალანსის ჟურნალი უცვლელია: მხოლოდ INSERT / SELECT (კორექცია — ახალი ჩანაწერით)
    GRANT SELECT, INSERT ON absence_balance_entries TO emr_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON absence_balance_entries FROM emr_app;
  END IF;
END $$;
