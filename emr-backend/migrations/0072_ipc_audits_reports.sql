-- 0072_ipc_audits_reports.sql
-- ინფექციის კონტროლი, ეტაპი 6 — ჩეკლისტები / აუდიტები, ანგარიშები, KPI ipc_*, „ყურადღება“, თვიური ანგარიში (ბლოკი D, მოდული 2 — დასრულება).
--
--  • შაბლონები (ipc_audit_templates): hand_hygiene — WHO „5 მომენტი“ (დაკვირვება: პროფესია, მომენტ(ებ)ი, ქმედება — rub / wash / missed);
--      checklist — კითხვები (კი / არა / არ ეხება). წინასწარ: ხელის ჰიგიენა, იზოლაციის შესაბამისობა, გარემოს დასუფთავება. რედაქტირებადი.
--  • აუდიტი (ipc_audits): განყოფილება, დრო, ავტორი; draft → completed (შესაბამისობა % ფიქსირდება) / წაშლა (მხოლოდ draft).
--      ავსებს: infection (ყველა), infection_dept (თავისი განყოფილებები), განყოფილების ხელმძღვანელი — audit_by_dept_head.
--  • rpt_fact_ipc — დღე × განყოფილება: HAI (CLABSI / CAUTI / VAP), SSI, ჰოსპიტალური MDRO, DDD / Access / DOT (MAR), ხელის ჰიგიენა, ანტისეპტიკი;
--      მნიშვნელები — rpt_fact_ipc_daily (0068). რეპორტინგის გადათვლაში (ფანჯარა); IPC ანგარიში — იგივე გამოთვლა წყაროდან.
--  • KPI ცნობარი: ახალი ჯგუფი ipc (10 KPI); ხედვა — dashboard_visibility (report_users / ipc_only).

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"audit_by_dept_head": false,
                    "hh_target": 80,
                    "hh_min_obs": 200,
                    "signal_overdue_days": 3,
                    "dashboard_visibility": "report_users",
                    "monthly_section": true}'::jsonb || settings
 WHERE code = 'ipc';

-- ================================================================ 1. შაბლონები
CREATE TABLE ipc_audit_templates (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code         VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,19}$'),
    name         TEXT NOT NULL CHECK (length(btrim(name)) >= 3),
    kind         VARCHAR(14) NOT NULL CHECK (kind IN ('hand_hygiene', 'checklist')),
    description  TEXT,
    target       NUMERIC(5,1) CHECK (target IS NULL OR (target >= 0 AND target <= 100)),   -- შესაბამისობის სამიზნე, %
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_ipc_audit_templates_updated BEFORE UPDATE ON ipc_audit_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ipc_audit_items (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id  UUID NOT NULL REFERENCES ipc_audit_templates(id),
    section      TEXT,
    text         TEXT NOT NULL CHECK (length(btrim(text)) >= 3),
    sort_order   INT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_ipc_audit_items_tpl ON ipc_audit_items (template_id, sort_order);

INSERT INTO ipc_audit_templates (code, name, kind, description, target, sort_order) VALUES
  ('hand_hygiene', 'ხელის ჰიგიენა — WHO „5 მომენტი“', 'hand_hygiene',
   'პირდაპირი დაკვირვება: თითო შესაძლებლობა — პროფესია, მომენტ(ებ)ი (1 — პაციენტთან შეხებამდე; 2 — ასეპტიკურ პროცედურამდე; 3 — სხეულის სითხეებთან კონტაქტის შემდეგ; 4 — პაციენტთან შეხების შემდეგ; 5 — პაციენტის გარემოსთან შეხების შემდეგ), ქმედება', 80, 10),
  ('isolation', 'იზოლაციის შესაბამისობა', 'checklist', 'იზოლირებული პაციენტის პალატა: ნიშანი, PPE, აღჭურვილობა, ნარჩენები', 90, 20),
  ('cleaning', 'გარემოს დასუფთავება და დეზინფექცია', 'checklist', 'პალატა / მანიპულაციის ოთახი: ზედაპირები, აღჭურვილობა, ხსნარები, ჟურნალი', 90, 30);

INSERT INTO ipc_audit_items (template_id, section, text, sort_order)
SELECT t.id, x.section, x.text, x.ord FROM ipc_audit_templates t JOIN (VALUES
  ('isolation', 'ნიშანი', 'კარზე იზოლაციის ნიშანი გამოკრულია და შეესაბამება ტიპს', 10),
  ('isolation', 'PPE', 'PPE ხელმისაწვდომია პალატის შესასვლელთან (ხალათი, ხელთათმანი, ნიღაბი / რესპირატორი)', 20),
  ('isolation', 'PPE', 'პერსონალი PPE-ს სწორად იცვამს და იხდის', 30),
  ('isolation', 'ხელის ჰიგიენა', 'ალკოჰოლიანი ანტისეპტიკი ხელმისაწვდომია პალატაში / შესასვლელთან', 40),
  ('isolation', 'აღჭურვილობა', 'პაციენტს აქვს ინდივიდუალური აღჭურვილობა (სტეტოსკოპი, თერმომეტრი, წნევის აპარატი)', 50),
  ('isolation', 'პალატა', 'კარი დახურულია (წვეთოვანი / საჰაერო იზოლაციისას)', 60),
  ('isolation', 'ნარჩენები', 'სამედიცინო ნარჩენების კონტეინერი პალატაშია, არ არის გადავსებული', 70),
  ('isolation', 'ინფორმირება', 'პაციენტი / ვიზიტორი ინფორმირებულია იზოლაციის წესებზე', 80),
  ('cleaning', 'ზედაპირები', 'ხშირად შეხებადი ზედაპირები (სახელურები, ლოგინის მოაჯირი, გადამრთველები) სუფთაა', 10),
  ('cleaning', 'ზედაპირები', 'სანიტარიული კვანძი სუფთაა და დეზინფიცირებულია', 20),
  ('cleaning', 'აღჭურვილობა', 'სამედიცინო აღჭურვილობა გაწმენდილია პაციენტებს შორის (მონიშნულია „სუფთა“)', 30),
  ('cleaning', 'ხსნარები', 'სადეზინფექციო ხსნარი სწორი კონცენტრაციითაა და ვადაში (მომზადების თარიღი)', 40),
  ('cleaning', 'ინვენტარი', 'დასუფთავების ინვენტარი მონიშნულია ზონების მიხედვით (ფერით)', 50),
  ('cleaning', 'ჟურნალი', 'დასუფთავების ჟურნალი შევსებულია', 60),
  ('cleaning', 'ნარჩენები', 'ნარჩენები დახარისხებულია (ბასრი, ინფექციური, საყოფაცხოვრებო)', 70),
  ('cleaning', 'გაწერის შემდეგ', 'გაწერის / გადაყვანის შემდეგ ტერმინალური დასუფთავება ჩატარებულია', 80)
) AS x(code, section, text, ord) ON x.code = t.code;

-- ================================================================ 2. აუდიტები
CREATE TABLE ipc_audits (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id     UUID NOT NULL REFERENCES ipc_audit_templates(id),
    department_id   UUID NOT NULL REFERENCES departments(id),
    audited_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    location        TEXT,                                        -- პალატა / ოთახი (თავისუფალი ტექსტი)
    note            TEXT,
    status          VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
    auditor_id      UUID NOT NULL REFERENCES users(id),
    completed_at    TIMESTAMPTZ,
    -- შედეგი (completed): checklist — კი / არა / არ ეხება; hand_hygiene — შესაძლებლობა / შესრულება
    yes_n           INT, no_n INT, na_n INT,
    opps_n          INT, done_n INT,
    compliance      NUMERIC(5,1),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE TRIGGER trg_ipc_audits_updated BEFORE UPDATE ON ipc_audits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_ipc_audits_dept ON ipc_audits (department_id, audited_at DESC);
CREATE INDEX idx_ipc_audits_tpl ON ipc_audits (template_id, audited_at DESC);

CREATE TABLE ipc_audit_answers (
    audit_id   UUID NOT NULL REFERENCES ipc_audits(id) ON DELETE CASCADE,
    item_id    UUID NOT NULL REFERENCES ipc_audit_items(id),
    answer     VARCHAR(3) NOT NULL CHECK (answer IN ('yes', 'no', 'na')),
    comment    TEXT,
    PRIMARY KEY (audit_id, item_id)
);

CREATE TABLE ipc_hh_observations (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id    UUID NOT NULL REFERENCES ipc_audits(id) ON DELETE CASCADE,
    profession  VARCHAR(10) NOT NULL CHECK (profession IN ('doctor', 'nurse', 'assistant', 'student', 'other')),
    moments     SMALLINT[] NOT NULL CHECK (cardinality(moments) BETWEEN 1 AND 5 AND moments <@ ARRAY[1, 2, 3, 4, 5]::SMALLINT[]),
    action      VARCHAR(6) NOT NULL CHECK (action IN ('rub', 'wash', 'missed')),
    gloves      BOOLEAN NOT NULL DEFAULT FALSE,              -- ხელთათმანი ჰიგიენის ნაცვლად (WHO ფორმის შენიშვნა)
    comment     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ipc_hh_obs_audit ON ipc_hh_observations (audit_id);

-- დასრულებული აუდიტი — უცვლელი (პასუხები / დაკვირვებები)
CREATE OR REPLACE FUNCTION ipc_audit_locked() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
    SELECT status INTO st FROM ipc_audits WHERE id = coalesce(NEW.audit_id, OLD.audit_id);
    IF st = 'completed' THEN RAISE EXCEPTION 'დასრულებული აუდიტი უცვლელია'; END IF;
    RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER trg_ipc_audit_answers_locked BEFORE INSERT OR UPDATE OR DELETE ON ipc_audit_answers FOR EACH ROW EXECUTE FUNCTION ipc_audit_locked();
CREATE TRIGGER trg_ipc_hh_obs_locked BEFORE INSERT OR UPDATE OR DELETE ON ipc_hh_observations FOR EACH ROW EXECUTE FUNCTION ipc_audit_locked();
CREATE OR REPLACE FUNCTION ipc_audits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'completed' THEN RAISE EXCEPTION 'დასრულებული აუდიტის წაშლა აკრძალულია'; END IF;
        RETURN OLD;
    END IF;
    IF OLD.status = 'completed' THEN RAISE EXCEPTION 'დასრულებული აუდიტი უცვლელია'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_ipc_audits_guard BEFORE UPDATE OR DELETE ON ipc_audits FOR EACH ROW EXECUTE FUNCTION ipc_audits_guard();

-- ================================================================ 3. რეპორტინგის ფაქტი
CREATE TABLE rpt_fact_ipc (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    hai            INT NOT NULL DEFAULT 0,
    clabsi         INT NOT NULL DEFAULT 0,
    cauti          INT NOT NULL DEFAULT 0,
    vap            INT NOT NULL DEFAULT 0,
    ssi_ops        INT NOT NULL DEFAULT 0,       -- დასრულებული დაკვირვება (completed / ssi), ოპერაციის დღით
    ssi            INT NOT NULL DEFAULT 0,
    mdro_hosp      INT NOT NULL DEFAULT 0,       -- ახალი ჰოსპიტალური MDRO ფლაგი (ნიმუშის დღით)
    mdro_all       INT NOT NULL DEFAULT 0,
    ddd            NUMERIC(14,4) NOT NULL DEFAULT 0,
    ddd_access     NUMERIC(14,4) NOT NULL DEFAULT 0,
    dot            INT NOT NULL DEFAULT 0,
    hh_opps        INT NOT NULL DEFAULT 0,
    hh_done        INT NOT NULL DEFAULT 0,
    handrub_l      NUMERIC(14,4) NOT NULL DEFAULT 0,
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_rpt_fact_ipc ON rpt_fact_ipc (day, department_id);

-- ================================================================ 4. KPI ცნობარი
ALTER TABLE rpt_kpis DROP CONSTRAINT IF EXISTS rpt_kpis_category_check;
ALTER TABLE rpt_kpis ADD CONSTRAINT rpt_kpis_category_check CHECK (category IN ('flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance', 'quality', 'ipc'));
INSERT INTO rpt_kpis (code, category, name, unit, direction, definition, formula, source, finance, snapshot, drill, sort_order) VALUES
 ('ipc_hai_rate', 'ipc', 'HAI 1000 პაციენტ-დღეზე', 'ratio', 'down',
  'დადასტურებული ჰოსპიტალური ინფექციები (ინფექციის დღით, მიკუთვნებული განყოფილება)', 'HAI (confirmed) / პაციენტ-დღე × 1000', 'ipc_hai_cases → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 100),
 ('ipc_clabsi_rate', 'ipc', 'CLABSI 1000 ცენტრ. ხაზის დღეზე', 'ratio', 'down',
  'ცენტრალურ ხაზთან ასოცირებული სისხლის ინფექცია', 'CLABSI / central-line days × 1000', 'ipc_hai_cases → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 101),
 ('ipc_cauti_rate', 'ipc', 'CAUTI 1000 კათეტერ-დღეზე', 'ratio', 'down',
  'შარდის კათეტერთან ასოცირებული ინფექცია', 'CAUTI / urinary catheter days × 1000', 'ipc_hai_cases → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 102),
 ('ipc_vap_rate', 'ipc', 'VAP 1000 ვენტილაციის დღეზე', 'ratio', 'down',
  'ვენტილატორთან ასოცირებული პნევმონია', 'VAP / ventilator days × 1000', 'ipc_hai_cases → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 103),
 ('ipc_ssi_pct', 'ipc', 'SSI, %', 'pct', 'down',
  'ოპერაციის ადგილის ინფექცია დაკვირვებადასრულებულ ოპერაციებში (ოპერაციის დღით)', 'SSI / ოპერაციები (completed + ssi) × 100', 'ipc_ssi_ops → rpt_fact_ipc', FALSE, FALSE, NULL, 104),
 ('ipc_mdro_rate', 'ipc', 'ჰოსპიტალური MDRO 1000 პაციენტ-დღეზე', 'ratio', 'down',
  'ახალი MDRO ფლაგი, შეძენა — ჰოსპიტალური (ნიმუშის დღით)', 'MDRO (onset = hospital) / პაციენტ-დღე × 1000', 'ipc_patient_flags → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 105),
 ('ipc_ddd_100', 'ipc', 'ანტიბიოტიკი, DDD 100 პაციენტ-დღეზე', 'ratio', 'none',
  'მიცემული დოზები (MAR), WHO ATC/DDD', 'DDD / პაციენტ-დღე × 100', 'mar_entries → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 106),
 ('ipc_access_pct', 'ipc', 'AWaRe Access, % DDD', 'pct', 'up',
  'Access ჯგუფის წილი მოხმარებულ DDD-ში (WHO სამიზნე ≥ 60%)', 'DDD (Access) / DDD × 100', 'mar_entries → rpt_fact_ipc', FALSE, FALSE, NULL, 107),
 ('ipc_hh_pct', 'ipc', 'ხელის ჰიგიენა, %', 'pct', 'up',
  'WHO „5 მომენტი“ — დაკვირვება (დასრულებული აუდიტი)', '(rub + wash) / შესაძლებლობები × 100', 'ipc_hh_observations → rpt_fact_ipc', FALSE, FALSE, NULL, 108),
 ('ipc_handrub_l', 'ipc', 'ხელის ანტისეპტიკი, ლ 1000 პაციენტ-დღეზე', 'ratio', 'up',
  'მასალების ჯგუფი hand_rub, განყოფილების ლოკაციები (material_source)', 'ლ / პაციენტ-დღე × 1000', 'stock_moves → rpt_fact_ipc; rpt_fact_ipc_daily', FALSE, FALSE, NULL, 109);

-- ================================================================ 5. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON ipc_audit_templates, ipc_audit_items FROM emr_app;
  END IF;
END $$;
