-- 0084_worklist_dx_recurring_kpi.sql
-- სამუშაო სიები (D5), ეტაპი 4 / 4 — დიაგნოსტიკა, განმეორებადი დავალებები, ზარის ჩახშობა, ანგარიშები / KPI. D5 და ბლოკი D სრულდება.
--
--  • 22 დიაგნოსტიკური წყარო (ვირტუალური, 0081-ის A1): ლაბორატორია (10), პასუხის გაცნობა / კრიტიკული (2), რადიოლოგია / ენდოსკოპია (6),
--      ამბულატორიული მიმართვები (2: referrals; ამბულატორიულად დანიშნული, შეუსრულებელი კვლევა).
--  • პასუხის გაცნობა: dx_result_acks (უცვლელი ჟურნალი) — „გავეცანი“; კრიტიკულზე — ქმედება სავალდებულოა.
--  • ლაბ. კრიტიკული მნიშვნელობის შეტყობინება: dx_order_items.crit_notified_* (ვის / როგორ / read-back).
--  • განმეორებადი დავალებები: wl_task_schedules (გრაფიკი: ყოველდღე / კვირის დღეებით / თვის რიცხვი / ყოველ N საათში) → wl_tasks (schedule_id, occurrence_at).
--  • ზარის ჩახშობა: user_notifications.suppressed (ჩახშობილი იწერება წაკითხულად — ისტორიაში ჩანს, მთვლელს არ ზრდის).
--  • KPI: wl_item_log (სისტემური ჩანაწერის გამოჩენა / დახურვა — worker-ის აღრიცხვით), wl_kpi_open (ბოლო აღრიცხვა), wl_snapshot_daily,
--      wl_kpi_runs; მენეჯერული დაფა — rpt_fact_worklist, KPI ჯგუფი worklist (4).
--  • ახალი უფლება არ ემატება (47). არსებული ზარის შეტყობინებები უცვლელია, სანამ bell_suppress = off (ნაგულისხმევი).

-- ================================================================ 1. პასუხის გაცნობა (ექიმი)
CREATE TABLE dx_result_acks (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id  UUID NOT NULL REFERENCES dx_order_items(id),
    patient_id     UUID NOT NULL REFERENCES patients(id),
    kind           VARCHAR(8) NOT NULL CHECK (kind IN ('ack', 'critical')),
    action         VARCHAR(12) CHECK (action IN ('monitor', 'treatment', 'repeat', 'escalated', 'other')),
    note           TEXT,
    acked_by       UUID NOT NULL REFERENCES users(id),
    acked_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_dx_ack_critical CHECK (kind <> 'critical' OR action IS NOT NULL),
    CONSTRAINT chk_dx_ack_note CHECK (action IS DISTINCT FROM 'other' OR length(btrim(coalesce(note, ''))) >= 3)
);
CREATE INDEX idx_dx_acks_item ON dx_result_acks (order_item_id, acked_at DESC);
CREATE INDEX idx_dx_acks_patient ON dx_result_acks (patient_id, acked_at DESC);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON dx_result_acks FROM emr_app;
        GRANT SELECT, INSERT ON dx_result_acks TO emr_app;
    END IF;
END $$;

-- ================================================================ 2. ლაბ. — კრიტიკული მნიშვნელობის შეტყობინება (ISO 15189: ვის / როგორ / read-back)
ALTER TABLE dx_order_items
    ADD COLUMN crit_notified_to   TEXT,
    ADD COLUMN crit_notified_via  VARCHAR(10) CHECK (crit_notified_via IN ('phone', 'in_person', 'message', 'other')),
    ADD COLUMN crit_readback      BOOLEAN,
    ADD COLUMN crit_notified_at   TIMESTAMPTZ,
    ADD COLUMN crit_notified_by   UUID REFERENCES users(id),
    ADD CONSTRAINT chk_dx_crit_call CHECK ((crit_notified_at IS NULL) = (crit_notified_by IS NULL)
        AND (crit_notified_at IS NULL OR (length(btrim(coalesce(crit_notified_to, ''))) >= 2 AND crit_notified_via IS NOT NULL)));

-- ================================================================ 3. განმეორებადი (გრაფიკით) ხელით დავალებები
CREATE TABLE wl_task_schedules (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title                 VARCHAR(200) NOT NULL CHECK (length(btrim(title)) >= 3),
    description           TEXT,
    category_id           UUID REFERENCES wl_categories(id),
    priority              VARCHAR(8) NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
    due_hours             INT NOT NULL DEFAULT 0 CHECK (due_hours BETWEEN 0 AND 720),     -- ვადა = დგომა + N სთ; 0 — კატეგორიის SLA / პრიორიტეტის ნაგულისხმევი
    target_kind           VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'role', 'department', 'role_department', 'duty')),
    assignee_id           UUID REFERENCES users(id),
    target_role_id        UUID REFERENCES roles(id),
    target_department_id  UUID REFERENCES departments(id),
    target_duty_role_id   UUID REFERENCES duty_roles(id),
    department_id         UUID REFERENCES departments(id),                                  -- ხელმძღვანელის ხედვის განყოფილება
    freq                  VARCHAR(8) NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly', 'hourly')),
    times                 VARCHAR(5)[] NOT NULL DEFAULT '{}',                                -- HH:MI (კლინიკის დრო); hourly — პირველი დრო (ათვლა)
    weekdays              SMALLINT[] NOT NULL DEFAULT '{}',                                  -- 1 (ორშ) … 7 (კვ) — weekly
    month_day             SMALLINT CHECK (month_day BETWEEN 0 AND 28),                      -- 1–28; 0 — თვის ბოლო დღე — monthly
    every_hours           SMALLINT CHECK (every_hours BETWEEN 1 AND 24),                    -- hourly
    starts_on             DATE NOT NULL,
    ends_on               DATE,
    prev_open             VARCHAR(8) NOT NULL DEFAULT 'skip' CHECK (prev_open IN ('skip', 'create', 'replace')),
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    next_at               TIMESTAMPTZ,                                                       -- შემდეგი დგომა (worker)
    last_occurrence_at    TIMESTAMPTZ,
    created_by            UUID NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by            UUID REFERENCES users(id),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_wls_target CHECK (
        target_kind = 'user'            AND assignee_id IS NOT NULL AND target_role_id IS NULL AND target_department_id IS NULL AND target_duty_role_id IS NULL
     OR target_kind = 'role'            AND assignee_id IS NULL AND target_role_id IS NOT NULL AND target_department_id IS NULL AND target_duty_role_id IS NULL
     OR target_kind = 'department'      AND assignee_id IS NULL AND target_role_id IS NULL AND target_department_id IS NOT NULL AND target_duty_role_id IS NULL
     OR target_kind = 'role_department' AND assignee_id IS NULL AND target_role_id IS NOT NULL AND target_department_id IS NOT NULL AND target_duty_role_id IS NULL
     OR target_kind = 'duty'            AND assignee_id IS NULL AND target_role_id IS NULL AND target_department_id IS NULL AND target_duty_role_id IS NOT NULL),
    CONSTRAINT chk_wls_freq CHECK (
        freq = 'daily'   AND cardinality(times) BETWEEN 1 AND 6
     OR freq = 'weekly'  AND cardinality(times) BETWEEN 1 AND 6 AND cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
     OR freq = 'monthly' AND cardinality(times) BETWEEN 1 AND 6 AND month_day IS NOT NULL
     OR freq = 'hourly'  AND cardinality(times) = 1 AND every_hours IS NOT NULL),
    CONSTRAINT chk_wls_dates CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX idx_wls_due ON wl_task_schedules (next_at) WHERE is_active;
CREATE INDEX idx_wls_dept ON wl_task_schedules (department_id);
CREATE TRIGGER trg_wls_updated BEFORE UPDATE ON wl_task_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE wl_tasks
    ADD COLUMN schedule_id    UUID REFERENCES wl_task_schedules(id),
    ADD COLUMN occurrence_at  TIMESTAMPTZ,
    ADD CONSTRAINT chk_wl_schedule CHECK ((schedule_id IS NULL) = (occurrence_at IS NULL));
CREATE UNIQUE INDEX ux_wl_schedule_occurrence ON wl_tasks (schedule_id, occurrence_at) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_wl_schedule_open ON wl_tasks (schedule_id) WHERE schedule_id IS NOT NULL AND status IN ('open', 'in_progress');

-- გრაფიკის ჟურნალი: შეიქმნა / გამოტოვდა (წინა ღიაა) / ჩანაცვლდა
CREATE TABLE wl_schedule_runs (
    id             BIGSERIAL PRIMARY KEY,
    schedule_id    UUID NOT NULL REFERENCES wl_task_schedules(id),
    occurrence_at  TIMESTAMPTZ NOT NULL,
    result         VARCHAR(8) NOT NULL CHECK (result IN ('created', 'skipped', 'replaced')),
    task_id        UUID REFERENCES wl_tasks(id),
    prev_task_id   UUID REFERENCES wl_tasks(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wl_schedule_runs ON wl_schedule_runs (schedule_id, id DESC);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON wl_schedule_runs FROM emr_app;
        GRANT SELECT, INSERT ON wl_schedule_runs TO emr_app;
    END IF;
END $$;

-- ================================================================ 4. ზარის ჩახშობა
ALTER TABLE user_notifications ADD COLUMN suppressed BOOLEAN NOT NULL DEFAULT FALSE;

-- ================================================================ 5. KPI — სისტემური ჩანაწერების აღრიცხვა (worker, kpi_interval_min)
-- ერთი ხაზი = ჩანაწერის ერთი „ეპიზოდი“ (key = წყარო:ობიექტი); დახურვის შემდეგ თავიდან გამოჩენა — ახალი ხაზი. პაციენტის / სათაურის ტექსტი არ ინახება.
CREATE TABLE wl_item_log (
    id             BIGSERIAL PRIMARY KEY,
    key            TEXT NOT NULL,
    source         VARCHAR(24) NOT NULL,
    department_id  UUID REFERENCES departments(id),
    priority       VARCHAR(8) NOT NULL CHECK (priority IN ('normal', 'high', 'urgent')),
    created_at     TIMESTAMPTZ,                       -- წყაროს შექმნის დრო (თუ წყაროს აქვს); არ არის — first_seen
    due_at         TIMESTAMPTZ,
    first_seen     TIMESTAMPTZ NOT NULL,
    last_seen      TIMESTAMPTZ NOT NULL,
    closed_at      TIMESTAMPTZ,
    close_kind     VARCHAR(8) CHECK (close_kind IN ('done', 'disabled')),
    overdue_seen   BOOLEAN NOT NULL DEFAULT FALSE,
    owners         SMALLINT NOT NULL DEFAULT 1,       -- რამდენ მომხმარებელს უჩანდა (მაქს.)
    CONSTRAINT chk_wl_item_closed CHECK ((closed_at IS NULL) = (close_kind IS NULL))
);
CREATE UNIQUE INDEX ux_wl_item_open ON wl_item_log (key) WHERE closed_at IS NULL;
CREATE INDEX idx_wl_item_closed ON wl_item_log (closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX idx_wl_item_source ON wl_item_log (source, first_seen);

-- ბოლო აღრიცხვის სურათი (ღია ახლა): წყარო × განყოფილება
CREATE TABLE wl_kpi_open (
    source         VARCHAR(24) NOT NULL,
    department_id  UUID REFERENCES departments(id),
    open           INT NOT NULL,
    overdue        INT NOT NULL,
    urgent         INT NOT NULL
);
CREATE UNIQUE INDEX ux_wl_kpi_open ON wl_kpi_open (source, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- დღიური პიკი: წყარო × განყოფილება (ტრენდი)
CREATE TABLE wl_snapshot_daily (
    day            DATE NOT NULL,
    source         VARCHAR(24) NOT NULL,
    department_id  UUID REFERENCES departments(id),
    open_peak      INT NOT NULL DEFAULT 0,
    overdue_peak   INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_wl_snapshot_daily ON wl_snapshot_daily (day, source, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE wl_kpi_runs (
    id           BIGSERIAL PRIMARY KEY,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at  TIMESTAMPTZ,
    users        INT,
    items        INT,
    opened       INT,
    closed       INT,
    failed       TEXT[] NOT NULL DEFAULT '{}',        -- წყაროები, რომლებმაც შეცდომა დააბრუნა (მათი ჩანაწერები ამ გაშვებაზე არ იხურება)
    error        TEXT
);

-- ================================================================ 6. მენეჯერული დაფა — rpt_fact_worklist (დღე × განყოფილება), KPI ჯგუფი worklist
CREATE TABLE rpt_fact_worklist (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    closed         INT NOT NULL DEFAULT 0,             -- სისტემური ჩანაწერი დაიხურა (close_kind = done), ვადით
    closed_due     INT NOT NULL DEFAULT 0,             -- მათ შორის — ვადიანი
    closed_late    INT NOT NULL DEFAULT 0,             -- ვადის შემდეგ
    resp_n         INT NOT NULL DEFAULT 0,
    resp_hist      INT[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0}',   -- რეაგირების დრო (წთ), TAT_EDGES-ის ინტერვალებით
    tasks_done     INT NOT NULL DEFAULT 0,             -- ხელით დავალება შესრულდა (ვადიანი)
    tasks_on_time  INT NOT NULL DEFAULT 0,
    crit_n         INT NOT NULL DEFAULT 0,             -- კრიტიკული პასუხის პირველი დადასტურება (ექიმი)
    crit_hist      INT[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0}'
);
CREATE INDEX idx_rpt_fact_worklist ON rpt_fact_worklist (day, department_id);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
        GRANT SELECT, INSERT, DELETE ON rpt_fact_worklist TO emr_app;
    END IF;
END $$;

ALTER TABLE rpt_kpis DROP CONSTRAINT IF EXISTS rpt_kpis_category_check;
ALTER TABLE rpt_kpis ADD CONSTRAINT rpt_kpis_category_check CHECK (category IN ('flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance', 'quality', 'ipc', 'bme', 'roster', 'worklist'));
INSERT INTO rpt_kpis (code, category, name, unit, direction, definition, formula, source, finance, snapshot, drill, sort_order) VALUES
 ('wl_late_pct', 'worklist', 'სისტემური დავალება ვადის შემდეგ დაიხურა, %', 'pct', 'down',
  '„ჩემი დავალებების“ სისტემური ჩანაწერები ვადით, რომლებიც პერიოდში დაიხურა (საქმე თავის მოდულში შესრულდა); წყაროს გამორთვით გაქრობა არ ითვლება; სიზუსტე — აღრიცხვის ინტერვალი (kpi_interval_min)',
  'ვადის შემდეგ დახურული / ვადიანი დახურული × 100', 'wl_item_log → rpt_fact_worklist', FALSE, FALSE, NULL, 160),
 ('wl_response_median_h', 'worklist', 'რეაგირების დრო (მედიანა), სთ', 'hours', 'down',
  'სისტემური ჩანაწერი: შექმნიდან (წყაროს დრო; არ არის — პირველი გამოჩენა) დახურვამდე, დახურვის დღით', 'მედიანა (დახურვა − შექმნა)', 'wl_item_log → rpt_fact_worklist', FALSE, FALSE, NULL, 161),
 ('wl_tasks_ontime_pct', 'worklist', 'ხელით დავალება შესრულდა ვადაში, %', 'pct', 'up',
  'ვადიანი ხელით შექმნილი დავალებები, შესრულების დღით', 'ვადაში შესრულებული / შესრულებული (ვადით) × 100', 'wl_tasks → rpt_fact_worklist', FALSE, FALSE, NULL, 162),
 ('wl_crit_ack_median_min', 'worklist', 'კრიტიკული პასუხის დადასტურება ექიმის მიერ (მედიანა), წთ', 'min', 'down',
  'ლაბ. HH / LL და რადიოლოგიის კრიტიკული მიგნება: ვალიდაცია / ხელმოწერიდან ექიმის პირველ დადასტურებამდე („გავეცანი“ — ქმედებით), დადასტურების დღით',
  'მედიანა (დადასტურება − ვალიდაცია)', 'dx_result_acks → rpt_fact_worklist', FALSE, FALSE, NULL, 163)
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 7. პარამეტრები (ნაგულისხმევი; არსებული მნიშვნელობები უპირატესია)
UPDATE system_modules
   SET settings = '{"dx_list_mode": "attention", "lab_collect_min": {"routine": 120, "urgent": 30}, "lab_transit_min": 60,
                    "lab_tat_hours": {"routine": 24, "urgent": 2, "micro": 72}, "rad_tat_hours": {"routine": 24, "urgent": 1},
                    "ack_scope": "abnormal", "ack_hours": 24, "ack_days": 30, "critical_ack_min": 30, "lab_crit_call": "task",
                    "rad_scheduler": "radiographer", "ref_due_days": 3, "amb_dx_days": 14, "path_due_days": 10,
                    "bell_suppress": "off", "kpi_tracker": true, "kpi_interval_min": 30}'::jsonb || settings,
       description = '„ჩემი დავალებები“: სხვა მოდულების ღია საქმეები (სისტემური — დიაგნოსტიკა: ლაბორატორია, პასუხის გაცნობა / კრიტიკული, რადიოლოგია / ენდოსკოპია, მიმართვები; კლინიკური: დოკუმენტაცია, დანიშნულებები / MAR, კონსულტაცია / გადაყვანა, საექთნო / NEWS2, ICU, საოპერაციო; ხარისხი, IPC, ბიომედი, ცვლები, მარაგი, შესყიდვები, ფინანსები, ტარიფები, CSSD, ინვენტარი, რეგისტრატურა) + ხელით შექმნილი დავალებები (პირზე / როლზე / განყოფილებაზე / მორიგეზე; განმეორებადი — გრაფიკით), ვადა, პრიორიტეტი, ესკალაცია; ზარის ჩახშობა; ხელმძღვანელის ხედი; ანგარიშები / KPI'
 WHERE code = 'worklist';
UPDATE system_modules
   SET settings = jsonb_set(settings, '{sla_hours}', '{"lab_validate": 4}'::jsonb || coalesce(settings->'sla_hours', '{}'::jsonb))
 WHERE code = 'worklist';

-- ================================================================ 8. ინდექსები (წყაროების მოთხოვნებისთვის)
CREATE INDEX IF NOT EXISTS idx_dx_items_open      ON dx_order_items (section, status, ordered_at) WHERE status IN ('ordered', 'scheduled', 'arrived', 'collected', 'in_progress', 'performed', 'resulted');
CREATE INDEX IF NOT EXISTS idx_dx_items_validated ON dx_order_items (validated_at) WHERE status = 'validated';
CREATE INDEX IF NOT EXISTS idx_dx_items_issue     ON dx_order_items (encounter_id) WHERE collection_issue IS NOT NULL AND status IN ('ordered', 'scheduled', 'arrived');
CREATE INDEX IF NOT EXISTS idx_lab_results_crit   ON lab_results (order_item_id) WHERE flag IN ('HH', 'LL');
CREATE INDEX IF NOT EXISTS idx_lab_specimens_coll ON lab_specimens (collected_at) WHERE status = 'collected';
CREATE INDEX IF NOT EXISTS idx_qc_viol_open       ON lab_qc_violations (opened_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_path_open          ON path_requests (status, sent_at) WHERE status IN ('draft', 'sent') OR (status = 'resulted' AND reviewed_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_referrals_open     ON referrals (target_department_id, created_at) WHERE status IN ('requested', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_dx_reports_crit    ON dx_reports (order_item_id) WHERE is_critical AND status = 'signed';
