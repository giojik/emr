-- 0057_claim_scrubber.sql
-- DRG ბლოკი, ეტაპი 3 — claim scrubber: შემთხვევის შემოწმება გადამხდელთან (SSA / მზღვეველი) გაგზავნამდე.
-- ახალი მოდული „scrubber“ (ადმინისტრირება → მოდულები → ქლეიმის შემოწმება).
--
--  • წესები (scrub_rules): მზა კატალოგი (builtin, კოდით — ლოგიკა backend-ში) + საკუთარი (custom — პირობები DRG-ის კონსტრუქტორით).
--      თითოეულს: ჩართვა, სიმძიმე (error — ბლოკავს / warn — გაფრთხილება), გავრცელება (გადამხდელის ტიპები / კონკრეტული გადამხდელები;
--      ცარიელი — ყველა), პარამეტრები, ტექსტი, გამონაკლისი დაშვებულია თუ არა. ვერსიონირება არ არის — ცვლილება აუდიტშია.
--  • გამონაკლისი (scrub_overrides): კონკრეტულ შემთხვევაზე (ინვოისი × წესი [× გადამხდელი]) — მიზეზით; გაუქმება — მიზეზით.
--  • როდის ეშვება (მოდულის პარამეტრები): finalize_check — სტაციონარის ფინალიზაცია; claim_check — ქლეიმში დამატება და გაგზავნა.
--      off — არ მოწმდება; warn — მხოლოდ ჩვენება; block — შეცდომა (გამონაკლისის გარეშე) ბლოკავს.
--  • შემოწმება ეშვება მხოლოდ შემთხვევაზე, რომელსაც გადამხდელი ჰყავს (თვითდაფინანსებაზე — არა).

INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('scrubber', 'ქლეიმის შემოწმება', 'შემთხვევის შემოწმება გადამხდელთან გაგზავნამდე: მზა და საკუთარი წესები, სიმძიმე, გამონაკლისები; ფინალიზაციისა და ქლეიმის დაბლოკვა',
 TRUE, TRUE, '{"finalize_check": "block", "claim_check": "block"}', 44)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE scrub_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(40) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    builtin         BOOLEAN NOT NULL DEFAULT FALSE,
    grp             VARCHAR(12) NOT NULL CHECK (grp IN ('patient', 'diagnosis', 'drg', 'dates', 'guarantee', 'amount', 'procedure', 'document', 'duplicate', 'custom')),
    title           TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    message         TEXT,                                                   -- ბილინგს გამოსაჩენი ტექსტი (ცარიელი — დასახელება)
    severity        VARCHAR(5) NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warn')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    applies_kind    VARCHAR(4) NOT NULL DEFAULT 'ipd' CHECK (applies_kind IN ('ipd', 'opd', 'all')),
    payer_kinds     TEXT[] NOT NULL DEFAULT '{}' CHECK (payer_kinds <@ ARRAY['insurance', 'state', 'other']),
    payer_ids       UUID[] NOT NULL DEFAULT '{}',
    params          JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
    conditions      JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),   -- custom
    allow_override  BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 100,
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_scrub_custom CHECK (builtin OR grp = 'custom'),
    CONSTRAINT chk_scrub_custom_ipd CHECK (builtin OR applies_kind = 'ipd')
);

INSERT INTO scrub_rules (code, builtin, grp, title, severity, applies_kind, params, allow_override, sort_order) VALUES
('PATIENT_PN',         TRUE, 'patient',   'პირადი ნომერი არ არის / არასწორი ფორმატი (საქართველოს მოქალაქე — 11 ციფრი)', 'error', 'all', '{}', TRUE, 10),
('PDX_MISSING',        TRUE, 'diagnosis', 'ძირითადი (საბოლოო) დიაგნოზი არ არის',                                           'error', 'ipd', '{}', FALSE, 20),
('ICD_INVALID',        TRUE, 'diagnosis', 'დიაგნოზის კოდი ICD-10 ცნობარში არ არის / გათიშულია',                              'error', 'all', '{}', TRUE, 21),
('ICD_NONSPECIFIC',    TRUE, 'diagnosis', 'დიაგნოზი კატეგორიის დონეზეა (ქვეკოდის გარეშე)',                                   'warn',  'all', '{}', TRUE, 22),
('DX_SEX',             TRUE, 'diagnosis', 'დიაგნოზი არ შეესაბამება პაციენტის სქესს',                                         'error', 'all',
   '{"female_only": ["O00-O99", "N70-N98", "C51-C58", "Z32-Z39"], "male_only": ["N40-N51", "C60-C63"]}', TRUE, 23),
('DRG_NOT_CONFIRMED',  TRUE, 'drg',       'DRG დაუდასტურებელია ან დადასტურების შემდეგ შეიცვალა მონაცემები',                  'error', 'ipd', '{}', FALSE, 30),
('DRG_MISMATCH',       TRUE, 'drg',       'გადამხდელის DRG კოდი ≠ დადასტურებული',                                             'error', 'ipd', '{}', FALSE, 31),
('DRG_FALLBACK',       TRUE, 'drg',       'DRG — ნაგულისხმევი ჯგუფი („ვერ დაჯგუფდა“)',                                         'warn',  'ipd', '{}', TRUE, 32),
('LINE_OUTSIDE_STAY',  TRUE, 'dates',     'მომსახურების თარიღი ჰოსპიტალიზაციის პერიოდის გარეთაა',                             'error', 'ipd', '{}', TRUE, 40),
('LOS_LONG',           TRUE, 'dates',     'ხანგრძლივი ჰოსპიტალიზაცია',                                                        'warn',  'ipd', '{"days": 30}', TRUE, 41),
('GUARANTEE_MISSING',  TRUE, 'guarantee', 'საგარანტიო წერილის ნომერი არ არის',                                                'warn',  'ipd', '{}', TRUE, 50),
('GUARANTEE_FILE',     TRUE, 'guarantee', 'საგარანტიო წერილის ფაილი (სკანი) არ არის მიმაგრებული',                              'warn',  'ipd', '{}', TRUE, 51),
('GUARANTEE_EXPIRED',  TRUE, 'guarantee', 'საგარანტიო წერილის ვადა გასულია (მიღების / გაწერის დღეს)',                         'error', 'ipd', '{}', TRUE, 52),
('PAYER_ZERO',         TRUE, 'amount',    'გადამხდელის თანხა 0',                                                              'warn',  'ipd', '{}', TRUE, 60),
('PAYER_OVERRIDE',     TRUE, 'amount',    'გადამხდელის თანხა ხელით არის შესწორებული',                                         'warn',  'ipd', '{}', TRUE, 61),
('OR_NOTE_UNSIGNED',   TRUE, 'procedure', 'დასრულებული ოპერაციის ოქმი ხელმოუწერელია',                                         'error', 'ipd', '{}', TRUE, 70),
('OR_NCSP_MISSING',    TRUE, 'procedure', 'ოპერაციის პროცედურას NCSP კოდი არ აქვს',                                            'warn',  'ipd', '{}', TRUE, 71),
('EPICRISIS_UNSIGNED', TRUE, 'document',  'ეპიკრიზი ხელმოუწერელია',                                                          'warn',  'ipd', '{}', TRUE, 80),
('DUPLICATE_STAY',     TRUE, 'duplicate', 'იგივე პაციენტის სხვა ჰოსპიტალიზაცია იმავე გადამხდელთან გადაფარავს პერიოდს',            'warn',  'ipd', '{}', TRUE, 90);

CREATE TABLE scrub_overrides (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id     UUID NOT NULL REFERENCES invoices(id),
    rule_code      VARCHAR(40) NOT NULL REFERENCES scrub_rules(code) ON UPDATE CASCADE,
    payer_id       UUID REFERENCES payers(id),                              -- NULL — ყველა გადამხდელზე
    reason         TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
    created_by     UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at     TIMESTAMPTZ,
    revoked_by     UUID REFERENCES users(id),
    revoke_reason  TEXT,
    CONSTRAINT chk_scrub_revoke CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL OR length(btrim(coalesce(revoke_reason, ''))) >= 5))
);
CREATE UNIQUE INDEX ux_scrub_override_active ON scrub_overrides (invoice_id, rule_code, coalesce(payer_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;
CREATE INDEX idx_scrub_overrides_invoice ON scrub_overrides (invoice_id);

DO $$
BEGIN
    REVOKE TRUNCATE ON scrub_rules, scrub_overrides FROM emr_app;
    REVOKE DELETE ON scrub_overrides FROM emr_app;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
