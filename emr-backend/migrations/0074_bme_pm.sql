-- 0074_bme_pm.sql
-- ბიომედ-აპარატურა, ეტაპი 2 — გეგმიური მომსახურება (PM), კალიბრაცია, ელ. უსაფრთხოება (IEC 62353), მეტროლოგიური დამოწმება (ბლოკი D, მოდული 3).
--
--  • სამუშაოს სახეები (bme_work_kinds) — ცნობარი ადმინიდან; ინტერვალი: ტიპის სვეტიდან (pm / calibration / safety_months) ან სახის ნაგულისხმევიდან (ჯგუფებზე).
--  • გეგმა აპარატზე (bme_plans): ინტერვალი ტიპიდან, აპარატზე გადაფარვადი; ახალ აპარატს — ავტომატურად; არსებულებს — backfill (პირველი ვადა — დასადგენი).
--      შემდეგი ვადა: ბოლო შესრულებიდან (ნაგულისხმევი) / კალენდრით — პარამეტრი; სერტიფიკატის ვადა → შემდეგი ვადა (პარამეტრი).
--  • ჩეკლისტის შაბლონი (bme_checklists / _items) ტიპზე + სახეზე (ან ზოგადი — სახეზე): pass/fail ან გაზომვა (ნორმა ± დასაშვები / ზღვრები → ავტომატური fail).
--  • სამუშაო (bme_works): დაგეგმვა / შემსრულებლის მინიჭება (შიდა / გარე მომწოდებელი) → შესრულება (ჩეკლისტის ასლი — bme_work_items) →
--      შედეგი: გავლილი / პირობითად / ვერ გაიარა; „ვერ გაიარა“ / „პირობითად“ → სტატუსის შეთავაზება (ავტომატურად არ იცვლება); აქტის PDF → დოკუმენტებში;
--      სერტიფიკატი / აქტი ფაილად (ნომერი, ვადა) → დოკუმენტებში. შეკეთების ორდერი — 0075.
--  • შეხსენებები (worker, დღეში ერთხელ): 30 / 7 დღით ადრე + ვადაგადაცილება → ინჟინრები, შემსრულებელი, განყოფილების bme_dept; ეკრანი, ელფოსტა / SMS არჩევითი.
--  • ვადაგადაცილება: მხოლოდ გაფრთხილება (ნაგულისხმევი) / ავტომატური „შეზღუდულად მუშა“ — პარამეტრი.
--  • მოხმარების მთვლელი (საათები / ციკლები / ექსპოზიციები) — ხელით ჩანაწერი.

-- ================================================================ 0. პარამეტრები
UPDATE system_modules SET settings = settings || '{
  "pm_due_basis": "last_done",
  "pm_cert_sets_due": true,
  "pm_auto_plans": true,
  "pm_remind_days": [30, 7],
  "pm_remind_hour": 9,
  "pm_remind_email": false,
  "pm_remind_sms": false,
  "pm_overdue_action": "warn",
  "pm_fail_notify_dept": true,
  "pm_act_dept_sign": true,
  "pm_work_prefix": "PM"
}'::jsonb,
  description = 'სამედიცინო აპარატების რეესტრი (პასპორტი), სტატუსი და მისი ასახვა დაგეგმვაზე, გადაადგილება, დოკუმენტები, QR ეტიკეტი; გეგმიური მომსახურება (PM) / კალიბრაცია / ელ. უსაფრთხოება — გეგმები, ჩეკლისტები, აქტი, შეხსენებები; შეკეთება, კონტრაქტები, ანგარიშები — შემდეგი ეტაპები'
WHERE code = 'bme';

-- ================================================================ 1. სამუშაოს სახეები
CREATE TABLE bme_work_kinds (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code               VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
    name               TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    short_name         VARCHAR(30) NOT NULL,
    -- ინტერვალის წყარო: ტიპის სვეტი (pm_months / calibration_months / safety_months) ან default_months (groups-ში ჩამოთვლილ ჯგუფებზე)
    type_field         VARCHAR(20) CHECK (type_field IN ('pm_months', 'calibration_months', 'safety_months')),
    default_months     SMALLINT CHECK (default_months BETWEEN 1 AND 120),
    groups             VARCHAR(16)[] NOT NULL DEFAULT '{}',
    standard           TEXT,                                                     -- მაგ. IEC 62353
    needs_certificate  BOOLEAN NOT NULL DEFAULT FALSE,                           -- სერტიფიკატის № + ვადა სავალდებულოა შესრულებისას
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order         INT NOT NULL DEFAULT 100,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (type_field IS NULL OR default_months IS NULL)
);

INSERT INTO bme_work_kinds (code, name, short_name, type_field, default_months, groups, standard, needs_certificate, sort_order) VALUES
('PM',          'გეგმიური ტექნიკური მომსახურება (PM)',           'PM',             'pm_months',          NULL, '{}',          'მწარმოებლის ინსტრუქცია',      FALSE, 10),
('CALIBRATION', 'კალიბრაცია / შესრულების შემოწმება',            'კალიბრაცია',     'calibration_months', NULL, '{}',          NULL,                           FALSE, 20),
('SAFETY',      'ელექტრო-უსაფრთხოების ტესტი',                    'ელ. უსაფრთხოება', 'safety_months',     NULL, '{}',          'IEC 62353',                    FALSE, 30),
('METROLOGY',   'მეტროლოგიური დამოწმება (საზომი საშუალება)',     'მეტროლოგია',     NULL,                 12,   '{measuring}', 'საქართველოს კანონი მეტროლოგიის შესახებ', TRUE, 40);

-- საზომ საშუალებებზე (სასწორი, ტონომეტრი, თერმომეტრი) კალიბრაციას მეტროლოგიური დამოწმება ცვლის (0073-ის seed-ის 12 თვე) — ორმაგი გეგმა რომ არ შეიქმნას
UPDATE bme_device_types SET calibration_months = NULL, updated_at = now()
 WHERE code IN ('SCALE', 'BP_METER', 'THERMOMETER') AND grp = 'measuring' AND calibration_months = 12;

-- ================================================================ 2. ჩეკლისტის შაბლონები
CREATE TABLE bme_checklists (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind_id     UUID NOT NULL REFERENCES bme_work_kinds(id),
    type_id     UUID REFERENCES bme_device_types(id),                          -- NULL — ზოგადი (სახის ყველა ტიპზე)
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    version     INT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- ერთ (სახე, ტიპი)-ზე ერთი აქტიური შაბლონი
CREATE UNIQUE INDEX ux_bme_checklist_active ON bme_checklists (kind_id, coalesce(type_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_active;

CREATE TABLE bme_checklist_items (
    id            BIGSERIAL PRIMARY KEY,
    checklist_id  UUID NOT NULL REFERENCES bme_checklists(id) ON DELETE CASCADE,
    sort_order    INT NOT NULL,
    text          TEXT NOT NULL CHECK (length(btrim(text)) >= 2),
    item_type     VARCHAR(8) NOT NULL CHECK (item_type IN ('check', 'measure')),
    unit          VARCHAR(20),
    nominal       NUMERIC(14,4),                                                -- ნორმა (± tolerance)
    tolerance     NUMERIC(14,4) CHECK (tolerance >= 0),
    limit_low     NUMERIC(14,4),                                                -- ან ზღვრები (≥ / ≤)
    limit_high    NUMERIC(14,4),
    critical      BOOLEAN NOT NULL DEFAULT TRUE,                                -- fail → „ვერ გაიარა“; არაკრიტიკული fail → „პირობითად“
    required      BOOLEAN NOT NULL DEFAULT TRUE,
    CHECK (item_type = 'check' OR (tolerance IS NOT NULL AND nominal IS NOT NULL) OR (tolerance IS NULL AND (limit_low IS NOT NULL OR limit_high IS NOT NULL))),
    CHECK (limit_low IS NULL OR limit_high IS NULL OR limit_low <= limit_high),
    UNIQUE (checklist_id, sort_order)
);

-- ნიმუში-შაბლონები (ზღვრები — ნიმუშია: გადაამოწმეთ მწარმოებლის ინსტრუქციასთან / სტანდარტთან)
WITH k AS (SELECT id, code FROM bme_work_kinds), t AS (SELECT id, code FROM bme_device_types),
c AS (
  INSERT INTO bme_checklists (kind_id, type_id, name)
  SELECT k.id, t.id, x.name FROM (VALUES
    ('PM', NULL, 'PM — ზოგადი'),
    ('SAFETY', NULL, 'ელ. უსაფრთხოება — IEC 62353 (კლასი I, ჩართული ნაწილი BF)'),
    ('CALIBRATION', NULL, 'კალიბრაცია — ზოგადი'),
    ('METROLOGY', NULL, 'მეტროლოგიური დამოწმება — ზოგადი'),
    ('CALIBRATION', 'PATIENT_MONITOR', 'პაციენტის მონიტორი — სიმულატორით შემოწმება'),
    ('CALIBRATION', 'INFUSION_PUMP', 'ინფუზომატი — ნაკადის სიზუსტე'),
    ('CALIBRATION', 'DEFIBRILLATOR', 'დეფიბრილატორი — გამონადენის ენერგია'),
    ('METROLOGY', 'SCALE', 'სამედიცინო სასწორი — საკონტროლო წონით')
  ) AS x(kind, typ, name) JOIN k ON k.code = x.kind LEFT JOIN t ON t.code = x.typ
  RETURNING id, kind_id, type_id
), cc AS (
  SELECT c.id, k.code AS kind, t.code AS typ FROM c JOIN k ON k.id = c.kind_id LEFT JOIN t ON t.id = c.type_id
)
INSERT INTO bme_checklist_items (checklist_id, sort_order, text, item_type, unit, nominal, tolerance, limit_low, limit_high, critical, required)
SELECT cc.id, i.ord, i.text, i.itype, i.unit, i.nominal, i.tol, i.lo, i.hi, i.crit, TRUE
  FROM cc JOIN (VALUES
    ('PM', NULL, 10, 'გარეგანი დათვალიერება: კორპუსი, კაბელები, შტეფსელი, კონექტორები — დაზიანების გარეშე', 'check', NULL, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, TRUE),
    ('PM', NULL, 20, 'გაწმენდა / დეზინფექცია; ფილტრების შემოწმება / შეცვლა', 'check', NULL, NULL, NULL, NULL, NULL, FALSE),
    ('PM', NULL, 30, 'აკუმულატორი: დამუხტვა / ავტონომიური მუშაობა', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('PM', NULL, 40, 'განგაშის სიგნალები (ხმა / სინათლე) მუშაობს', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('PM', NULL, 50, 'ფუნქციური ტესტი მწარმოებლის ინსტრუქციით', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('PM', NULL, 60, 'ეტიკეტები, მარკირება, ინსტრუქცია ადგილზეა', 'check', NULL, NULL, NULL, NULL, NULL, FALSE),
    ('SAFETY', NULL, 10, 'გარეგანი დათვალიერება (IEC 62353 §5.2)', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('SAFETY', NULL, 20, 'დამცავი დამიწების წინაღობა (კაბელით)', 'measure', 'Ω', NULL, NULL, NULL, 0.3, TRUE),
    ('SAFETY', NULL, 30, 'იზოლაციის წინაღობა', 'measure', 'MΩ', NULL, NULL, 2, NULL, TRUE),
    ('SAFETY', NULL, 40, 'აპარატის გაჟონვის დენი (პირდაპირი მეთოდი, კლასი I)', 'measure', 'µA', NULL, NULL, NULL, 500, TRUE),
    ('SAFETY', NULL, 50, 'ჩართული ნაწილის გაჟონვის დენი (BF)', 'measure', 'µA', NULL, NULL, NULL, 5000, TRUE),
    ('SAFETY', NULL, 60, 'ფუნქციური შემოწმება ტესტის შემდეგ', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('CALIBRATION', NULL, 10, 'საეტალონო საშუალება — ვადიანი სერტიფიკატით', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('CALIBRATION', NULL, 20, 'ჩვენებები დასაშვებ ცდომილებაშია (მწარმოებლის სპეციფიკაცია)', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('METROLOGY', NULL, 10, 'დამოწმება ჩატარებულია აკრედიტებული ორგანოს მიერ', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('METROLOGY', NULL, 20, 'დამოწმების ნიშანი / ლუქი დატანილია', 'check', NULL, NULL, NULL, NULL, NULL, FALSE),
    ('CALIBRATION', 'PATIENT_MONITOR', 10, 'ეკგ: გულისცემის სიხშირე (სიმულატორი 60)', 'measure', 'დარტ./წთ', 60, 1, NULL, NULL, TRUE),
    ('CALIBRATION', 'PATIENT_MONITOR', 20, 'NIBP: სისტოლური (სიმულატორი 120)', 'measure', 'mmHg', 120, 3, NULL, NULL, TRUE),
    ('CALIBRATION', 'PATIENT_MONITOR', 30, 'NIBP: დიასტოლური (სიმულატორი 80)', 'measure', 'mmHg', 80, 3, NULL, NULL, TRUE),
    ('CALIBRATION', 'PATIENT_MONITOR', 40, 'SpO2 (სიმულატორი 97)', 'measure', '%', 97, 2, NULL, NULL, TRUE),
    ('CALIBRATION', 'PATIENT_MONITOR', 50, 'ტემპერატურა (სიმულატორი 37.0)', 'measure', '°C', 37, 0.2, NULL, NULL, FALSE),
    ('CALIBRATION', 'PATIENT_MONITOR', 60, 'განგაშის ზღვრები ამოქმედდა', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('CALIBRATION', 'INFUSION_PUMP', 10, 'ნაკადი 100 მლ/სთ (ანალიზატორი)', 'measure', 'მლ/სთ', 100, 5, NULL, NULL, TRUE),
    ('CALIBRATION', 'INFUSION_PUMP', 20, 'ოკლუზიის განგაში — წნევა', 'measure', 'mmHg', NULL, NULL, NULL, 750, TRUE),
    ('CALIBRATION', 'INFUSION_PUMP', 30, 'ჰაერის ბუშტის დეტექტორი მუშაობს', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('CALIBRATION', 'DEFIBRILLATOR', 10, 'გამონადენი — დაყენებული 200 ჯ', 'measure', 'ჯ', 200, 30, NULL, NULL, TRUE),
    ('CALIBRATION', 'DEFIBRILLATOR', 20, 'დამუხტვის დრო მაქს. ენერგიაზე', 'measure', 'წმ', NULL, NULL, NULL, 15, TRUE),
    ('CALIBRATION', 'DEFIBRILLATOR', 30, 'სინქრონიზაციის რეჟიმი', 'check', NULL, NULL, NULL, NULL, NULL, TRUE),
    ('METROLOGY', 'SCALE', 10, 'საკონტროლო წონა 10 კგ', 'measure', 'კგ', 10, 0.05, NULL, NULL, TRUE),
    ('METROLOGY', 'SCALE', 20, 'ნულზე დაყენება / ტარირება', 'check', NULL, NULL, NULL, NULL, NULL, TRUE)
  ) AS i(kind, typ, ord, text, itype, unit, nominal, tol, lo, hi, crit)
    ON i.kind = cc.kind AND i.typ IS NOT DISTINCT FROM cc.typ;

-- ================================================================ 3. გეგმა აპარატზე
CREATE TABLE bme_plans (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id        UUID NOT NULL REFERENCES bme_devices(id),
    kind_id          UUID NOT NULL REFERENCES bme_work_kinds(id),
    interval_months  SMALLINT CHECK (interval_months BETWEEN 1 AND 120),         -- NULL — ტიპიდან / სახიდან; მნიშვნელობა — აპარატზე გადაფარვა
    next_due         DATE,                                                      -- NULL — პირველი ვადა დასადგენია
    last_done_on     DATE,
    last_work_id     UUID,
    last_result      VARCHAR(12) CHECK (last_result IN ('pass', 'conditional', 'fail')),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    source           VARCHAR(10) NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual', 'backfill')),
    notes            TEXT,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (device_id, kind_id)
);
CREATE INDEX idx_bme_plans_due ON bme_plans (next_due) WHERE is_active;

-- ================================================================ 4. სამუშაოები
CREATE TABLE bme_works (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_no            VARCHAR(30) NOT NULL UNIQUE,
    device_id          UUID NOT NULL REFERENCES bme_devices(id),
    plan_id            UUID REFERENCES bme_plans(id),                           -- NULL — გეგმის გარეშე (ერთჯერადი)
    kind_id            UUID NOT NULL REFERENCES bme_work_kinds(id),
    checklist_id       UUID REFERENCES bme_checklists(id),
    status             VARCHAR(12) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'done', 'cancelled')),
    due_date           DATE,                                                    -- გეგმის ვადა შექმნისას
    scheduled_date     DATE,                                                    -- დაგეგმილი შესრულების დღე
    performer_kind     VARCHAR(10) NOT NULL DEFAULT 'internal' CHECK (performer_kind IN ('internal', 'external')),
    assignee_id        UUID REFERENCES users(id),                               -- შიდა შემსრულებელი
    supplier_id        UUID REFERENCES stock_suppliers(id),                     -- გარე: მომწოდებელი / სერვის-კომპანია
    external_person    TEXT,
    started_at         TIMESTAMPTZ,
    performed_on       DATE,
    result             VARCHAR(12) CHECK (result IN ('pass', 'conditional', 'fail')),
    result_note        TEXT,
    suggested_status   VARCHAR(12) CHECK (suggested_status IN ('restricted', 'down')),
    status_applied     BOOLEAN NOT NULL DEFAULT FALSE,
    cert_no            VARCHAR(60),
    cert_valid_until   DATE,
    next_due           DATE,                                                    -- შესრულებისას დათვლილი შემდეგი ვადა
    completed_by       UUID REFERENCES users(id),
    completed_at       TIMESTAMPTZ,
    cancel_reason      TEXT,
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status <> 'done' OR (result IS NOT NULL AND performed_on IS NOT NULL AND completed_at IS NOT NULL)),
    CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
    CHECK (performer_kind = 'internal' OR supplier_id IS NOT NULL OR external_person IS NOT NULL)
);
-- გეგმაზე ერთი ღია სამუშაო
CREATE UNIQUE INDEX ux_bme_work_open ON bme_works (plan_id) WHERE status IN ('planned', 'in_progress') AND plan_id IS NOT NULL;
CREATE INDEX idx_bme_works_dev ON bme_works (device_id, created_at DESC);
CREATE INDEX idx_bme_works_open ON bme_works (scheduled_date) WHERE status IN ('planned', 'in_progress');
CREATE INDEX idx_bme_works_assignee ON bme_works (assignee_id) WHERE status IN ('planned', 'in_progress');
ALTER TABLE bme_plans ADD CONSTRAINT bme_plans_last_work_fk FOREIGN KEY (last_work_id) REFERENCES bme_works(id);

-- ჩეკლისტის ასლი სამუშაოზე (შაბლონის ცვლილება ძველ სამუშაოს არ ცვლის)
CREATE TABLE bme_work_items (
    id          BIGSERIAL PRIMARY KEY,
    work_id     UUID NOT NULL REFERENCES bme_works(id),
    sort_order  INT NOT NULL,
    text        TEXT NOT NULL,
    item_type   VARCHAR(8) NOT NULL CHECK (item_type IN ('check', 'measure')),
    unit        VARCHAR(20),
    nominal     NUMERIC(14,4),
    tolerance   NUMERIC(14,4),
    limit_low   NUMERIC(14,4),
    limit_high  NUMERIC(14,4),
    critical    BOOLEAN NOT NULL,
    required    BOOLEAN NOT NULL,
    value_num   NUMERIC(14,4),
    outcome     VARCHAR(4) CHECK (outcome IN ('pass', 'fail', 'na')),
    note        TEXT,
    UNIQUE (work_id, sort_order)
);

-- დოკუმენტი ↔ სამუშაო (აქტი / სერტიფიკატი)
ALTER TABLE bme_documents ADD COLUMN work_id UUID REFERENCES bme_works(id);
CREATE INDEX idx_bme_docs_work ON bme_documents (work_id) WHERE work_id IS NOT NULL;

-- ================================================================ 5. მოხმარების მთვლელი (ხელით)
CREATE TABLE bme_meter_readings (
    id          BIGSERIAL PRIMARY KEY,
    device_id   UUID NOT NULL REFERENCES bme_devices(id),
    unit        VARCHAR(12) NOT NULL CHECK (unit IN ('hours', 'cycles', 'exposures', 'scans', 'other')),
    value       NUMERIC(14,1) NOT NULL CHECK (value >= 0),
    read_on     DATE NOT NULL,
    note        TEXT,
    user_id     UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bme_meter_dev ON bme_meter_readings (device_id, read_on DESC, id DESC);

-- ================================================================ 6. შეხსენებები (ერთხელ თითო გეგმა / ვადა / ეტაპი)
CREATE TABLE bme_reminders (
    plan_id   UUID NOT NULL REFERENCES bme_plans(id),
    due_date  DATE NOT NULL,
    stage     SMALLINT NOT NULL,                                                -- დღეები ვადამდე (30, 7…); 0 — ვადაგადაცილებული
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (plan_id, due_date, stage)
);

-- ================================================================ 7. ისტორიის ახალი სახეები
ALTER TABLE bme_events DROP CONSTRAINT bme_events_kind_check;
ALTER TABLE bme_events ADD CONSTRAINT bme_events_kind_check CHECK (kind IN ('created', 'updated', 'status', 'move_requested', 'moved', 'move_rejected', 'move_cancelled',
    'linked', 'unlinked', 'document', 'document_removed', 'reviewed',
    'plan', 'work_planned', 'work_done', 'work_cancelled', 'meter'));

-- ================================================================ 8. backfill — არსებულ აპარატებს გეგმები (პირველი ვადა — დასადგენი)
INSERT INTO bme_plans (device_id, kind_id, source)
SELECT b.id, k.id, 'backfill'
  FROM bme_devices b JOIN bme_device_types t ON t.id = b.type_id
  JOIN bme_work_kinds k ON k.is_active
       AND ((k.type_field = 'pm_months' AND t.pm_months IS NOT NULL)
         OR (k.type_field = 'calibration_months' AND t.calibration_months IS NOT NULL)
         OR (k.type_field = 'safety_months' AND t.safety_months IS NOT NULL)
         OR (k.type_field IS NULL AND t.grp = ANY (k.groups)))
 WHERE b.status <> 'retired'
ON CONFLICT (device_id, kind_id) DO NOTHING;
