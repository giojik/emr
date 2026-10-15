-- 0063_reporting_finance.sql
-- მენეჯერული რეპორტინგი, ეტაპი 4 — ფინანსური დაფა, შემოსავალი ექიმზე, თვის მენეჯერული ანგარიში, განრიგით გაგზავნა, „ყურადღების“ შეტყობინებები.
--
--  • rpt_fact_payer — შემოსავალი გადამხდელებით (დღე × განყოფილება × გადამხდელი × სახე) — იგივე წყარო / წესი, რაც rpt_fact_finance (0053-ის revenueCte).
--  • rpt_fact_doctor_rev — შემოსავალი ექიმზე: basis = performer (შემსრულებელი) / referrer (დამნიშნავი); ხაზის ექიმი:
--      ოპერაცია → ქირურგი; კონსულტაცია → პასუხის ავტორი (დამნიშნავი — მომთხოვნი); ინსტრუმენტული კვლევა → ვალიდატორი (დამნიშნავი — დანიშვნის ავტორი);
--      ლაბორატორია → შემსრულებელი არ არის (მხოლოდ დამნიშნავი); სხვა (საწოლ-დღე, მედიკამენტი, ვიზიტი…) → შემთხვევის მკურნალი ექიმი; ვერ დადგინდა → NULL.
--    ორივე ფაქტი — დახურულ ფინანსურ თვეში გაყინულია (როგორც rpt_fact_finance).
--  • rpt_balance_snapshot — დებიტორები / კრედიტორები დღის ბოლოს: გადამხდელი (ქლეიმები + შეუტანელი), პაციენტის ვალი, მომწოდებელი (AP);
--      იწერება დღევანდელ დღეზე ყოველი გადათვლისას (ისტორია რჩება → თვის ბოლოს ტრენდი).
--  • rpt_schedules / rpt_deliveries — მენეჯერული ანგარიშის (xlsx / PDF) გაგზავნა ელფოსტით განრიგით; მხოლოდ აგრეგატები (PHI-ის გარეშე).
--  • rpt_attention_sent — „ყურადღების“ შეტყობინება: ერთ მომხმარებელს ერთი წესი დღეში ერთხელ.
--  • პარამეტრები: doctor_revenue (on / off), attention_notify (off / in_app / in_app_email), attention_notify_hour (0–23), attention_notify_level (red / all).

UPDATE system_modules
   SET settings = '{"doctor_revenue": "on", "attention_notify": "in_app", "attention_notify_hour": 8, "attention_notify_level": "red"}'::jsonb || settings
 WHERE code = 'reporting';

-- ================================================================ 1. შემოსავალი გადამხდელებით
CREATE TABLE rpt_fact_payer (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    payer_id       UUID REFERENCES payers(id),                 -- NULL — პაციენტი / ჩამოწერა / დაუზუსტებელი
    kind           VARCHAR(16) NOT NULL,                        -- patient / insurance / state / other / undetermined / writeoff / denied
    amount         NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_payer ON rpt_fact_payer (day, department_id);

-- ================================================================ 2. შემოსავალი ექიმზე
CREATE TABLE rpt_fact_doctor_rev (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    doctor_id      UUID REFERENCES users(id),                  -- NULL — ექიმი ვერ დადგინდა
    basis          VARCHAR(10) NOT NULL CHECK (basis IN ('performer', 'referrer')),
    category       VARCHAR(30) NOT NULL,
    kind           VARCHAR(16) NOT NULL,
    amount         NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_doctor_rev ON rpt_fact_doctor_rev (day, basis, department_id);

-- ================================================================ 3. დებიტორები / კრედიტორები
CREATE TABLE rpt_balance_snapshot (
    day            DATE NOT NULL,
    kind           VARCHAR(12) NOT NULL CHECK (kind IN ('ar_payer', 'ar_patient', 'ap')),
    party_id       UUID,                                        -- გადამხდელი / მომწოდებელი; პაციენტი — NULL (ჯამი)
    party_name     VARCHAR(255) NOT NULL,
    party_kind     VARCHAR(16),                                 -- გადამხდელის სახე (insurance / state / other)
    unclaimed      NUMERIC(14,2) NOT NULL DEFAULT 0,            -- ქლეიმში შეუტანელი
    draft          NUMERIC(14,2) NOT NULL DEFAULT 0,            -- ქლეიმის მონახაზი
    not_due        NUMERIC(14,2) NOT NULL DEFAULT 0,            -- ვადამდე (პაციენტი — იმავე დღეს)
    d1_30          NUMERIC(14,2) NOT NULL DEFAULT 0,            -- ვადაგადაცილება 1–30 დღე (პაციენტი — ანგარიშის თარიღიდან)
    d31_60         NUMERIC(14,2) NOT NULL DEFAULT 0,
    d61_90         NUMERIC(14,2) NOT NULL DEFAULT 0,
    d90            NUMERIC(14,2) NOT NULL DEFAULT 0,
    total          NUMERIC(14,2) NOT NULL DEFAULT 0,
    items          INT NOT NULL DEFAULT 0,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rpt_balance ON rpt_balance_snapshot (day, kind);

-- ================================================================ 4. განრიგით გაგზავნა
CREATE TABLE rpt_schedules (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(120) NOT NULL,
    frequency        VARCHAR(8) NOT NULL CHECK (frequency IN ('monthly', 'weekly')),
    send_day         SMALLINT NOT NULL,                         -- monthly: თვის N-ე სამუშაო დღე (1–10); weekly: კვირის დღე (1 ორშ … 7 კვი)
    send_hour        SMALLINT NOT NULL DEFAULT 9 CHECK (send_hour BETWEEN 0 AND 23),
    department_id    UUID REFERENCES departments(id),           -- NULL — მიმღების მთელი ხედვის არე
    formats          VARCHAR(4)[] NOT NULL DEFAULT '{xlsx,pdf}',
    include_doctors  BOOLEAN NOT NULL DEFAULT FALSE,            -- ექიმის ფურცლები xlsx-ში (მხოლოდ თუ მიმღებს წვდომა აქვს)
    recipients       UUID[] NOT NULL DEFAULT '{}',              -- users.id
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    last_period      VARCHAR(10),                               -- 2026-09 / 2026-W41 — ბოლოს გაგზავნილი
    last_run_at      TIMESTAMPTZ,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((frequency = 'monthly' AND send_day BETWEEN 1 AND 10) OR (frequency = 'weekly' AND send_day BETWEEN 1 AND 7))
);

CREATE TABLE rpt_deliveries (
    id             BIGSERIAL PRIMARY KEY,
    schedule_id    UUID REFERENCES rpt_schedules(id) ON DELETE SET NULL,
    period         VARCHAR(10) NOT NULL,
    date_from      DATE NOT NULL,
    date_to        DATE NOT NULL,
    user_id        UUID REFERENCES users(id),
    email          VARCHAR(255),
    status         VARCHAR(8) NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
    error          TEXT,
    files          TEXT[] NOT NULL DEFAULT '{}',
    bytes          INT NOT NULL DEFAULT 0,
    manual         BOOLEAN NOT NULL DEFAULT FALSE,
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rpt_deliveries ON rpt_deliveries (created_at DESC);

-- ================================================================ 5. „ყურადღების“ შეტყობინებები
CREATE TABLE rpt_attention_sent (
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day       DATE NOT NULL,
    item_key  VARCHAR(60) NOT NULL,
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day, item_key)
);
