-- 0081_worklists.sql
-- სამუშაო სიები (worklists), ეტაპი 1 — საფუძველი (ბლოკი D, მოდული 5).
--
--  • მოდული `worklist` (ჩართვადი) + უფლებები: worklist_manage (ხელმძღვანელის ხედი / გადანაწილება თავის განყოფილებ(ებ)ში — rpt_user_scopes ∪ users.department_id),
--      worklist_all (მთელი კლინიკა + კატეგორიების ცნობარი). 45 → 47. შაბლონ-როლი არ იქმნება.
--  • სისტემური დავალებები ცხრილში არ ინახება — „ვირტუალური წყაროები“ (A1): თითო მოდულის ღია საქმე პირდაპირ წყაროს ცხრილიდან ითვლება,
--      მოდულის არსებული წვდომის წესით (C1); წყარო ჩართვადია პარამეტრით `sources` (C2). 0081 — D-ბლოკის წყაროები (ხარისხი, IPC, BME, ცვლები).
--  • ხელით შექმნილი დავალება (wl_tasks): სამიზნე — პირი / როლი / განყოფილება / როლი + განყოფილება / მორიგე (D4-ის მორიგის როლი, ნახვის მომენტში);
--      ჯგუფური — „ავიღებ“ (claim); სტატუსი ღია → შესრულებაში → შესრულებული / გაუქმებული (მიზეზით); ხელახლა გახსნა (reopen_days);
--      პრიორიტეტი, ვადა (ან კატეგორიის SLA / პრიორიტეტის ნაგულისხმევი), შეხსენება ვადაზე, ესკალაცია (escalate_hours); პაციენტი — არჩევითი („არ არის დანიშნულება“).
--  • ისტორია / კომენტარები (wl_task_events) — აპლიკაციას მხოლოდ INSERT / SELECT.
--  • კატეგორიები (wl_categories): ნაგულისხმევი სამიზნე (განყოფილება / როლი) + SLA საათები; seed 5 — კლინიკა ასწორებს.

-- ================================================================ 0. მოდული, უფლებები
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('worklist', 'სამუშაო სიები', '„ჩემი დავალებები“: სხვა მოდულების ღია საქმეები (სისტემური) + ხელით შექმნილი დავალებები (პირზე / როლზე / განყოფილებაზე / მორიგეზე), ვადა, პრიორიტეტი, ესკალაცია; ხელმძღვანელის ხედი',
 TRUE, TRUE,
 '{"assign_scope": "any",
   "done_comment": "urgent",
   "reopen_days": 7,
   "remind_at_due": true,
   "escalate_hours": 0,
   "due_default_hours": [0, 24, 4],
   "notify_assign": true,
   "notify_done": true,
   "patient_tasks": true,
   "sources": {},
   "badge": "all",
   "refresh_seconds": 60,
   "home_tasks": false}', 50)
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
        'roster', 'roster_all', 'roster_view', 'absence_approve',
        'worklist_manage', 'worklist_all']::VARCHAR(30)[]);

-- ================================================================ 1. კატეგორიები
CREATE TABLE wl_categories (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                   VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
    name                   TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    description            TEXT,
    -- ნაგულისხმევი სამიზნე („მოთხოვნა სამსახურს“): NULL — ფორმაში ირჩევენ
    default_target_kind    VARCHAR(16) CHECK (default_target_kind IN ('department', 'role', 'role_department')),
    default_role_id        UUID REFERENCES roles(id),
    default_department_id  UUID REFERENCES departments(id),
    sla_hours              INT CHECK (sla_hours BETWEEN 1 AND 2160),            -- ვადა შექმნიდან (თუ ვადა ხელით არ არის)
    allow_patient          BOOLEAN NOT NULL DEFAULT TRUE,
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order             INT NOT NULL DEFAULT 100,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_wlc_target CHECK (
        default_target_kind IS NULL AND default_role_id IS NULL AND default_department_id IS NULL
        OR default_target_kind = 'department' AND default_department_id IS NOT NULL AND default_role_id IS NULL
        OR default_target_kind = 'role' AND default_role_id IS NOT NULL AND default_department_id IS NULL
        OR default_target_kind = 'role_department' AND default_role_id IS NOT NULL AND default_department_id IS NOT NULL)
);

INSERT INTO wl_categories (code, name, description, allow_patient, sort_order) VALUES
('ADMIN',    'ადმინისტრაციული', 'დოკუმენტი, ზარი, ორგანიზაციული საკითხი', FALSE, 10),
('CLINICAL', 'კლინიკური (არა დანიშნულება)', 'პაციენტთან დაკავშირებული საქმე. მედიკამენტი / კვლევა ინიშნება მხოლოდ დანიშნულებით (CPOE / MAR)', TRUE, 20),
('TECH',     'ტექნიკური', 'შენობა, ავეჯი, IT. სამედიცინო აპარატის გაუმართაობა — ბიომედ-აპარატურის შეკეთების მოთხოვნით', FALSE, 30),
('CLEANING', 'დასუფთავება / სანიტარია', 'პალატის / ოთახის დასუფთავება, ნარჩენები', FALSE, 40),
('OTHER',    'სხვა', NULL, TRUE, 90);

-- ================================================================ 2. დავალებები
CREATE TABLE wl_tasks (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_no               VARCHAR(20) NOT NULL UNIQUE,                       -- TK26-00001
    title                 VARCHAR(200) NOT NULL CHECK (length(btrim(title)) >= 3),
    description           TEXT,
    category_id           UUID REFERENCES wl_categories(id),
    priority              VARCHAR(8) NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'urgent')),
    due_at                TIMESTAMPTZ,
    target_kind           VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'role', 'department', 'role_department', 'duty')),
    assignee_id           UUID REFERENCES users(id),
    target_role_id        UUID REFERENCES roles(id),
    target_department_id  UUID REFERENCES departments(id),
    target_duty_role_id   UUID REFERENCES duty_roles(id),
    department_id         UUID REFERENCES departments(id),                   -- ხელმძღვანელის ხედვის განყოფილება (სამიზნის / შემსრულებლის / შემქმნელის)
    claimed_by            UUID REFERENCES users(id),
    claimed_at            TIMESTAMPTZ,
    patient_id            UUID REFERENCES patients(id),
    encounter_id          UUID REFERENCES encounters(id),
    status                VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
    created_by            UUID NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at            TIMESTAMPTZ,
    done_at               TIMESTAMPTZ,
    done_by               UUID REFERENCES users(id),
    done_note             TEXT,
    cancelled_at          TIMESTAMPTZ,
    cancelled_by          UUID REFERENCES users(id),
    cancel_reason         TEXT,
    reminded_at           TIMESTAMPTZ,                                       -- ვადის შეხსენება (ერთხელ; ვადის შეცვლისას — თავიდან)
    escalated_at          TIMESTAMPTZ,                                       -- ესკალაცია ხელმძღვანელზე (ერთხელ)
    CONSTRAINT chk_wl_target CHECK (
        target_kind = 'user'            AND assignee_id IS NOT NULL AND target_role_id IS NULL AND target_department_id IS NULL AND target_duty_role_id IS NULL
     OR target_kind = 'role'            AND assignee_id IS NULL AND target_role_id IS NOT NULL AND target_department_id IS NULL AND target_duty_role_id IS NULL
     OR target_kind = 'department'      AND assignee_id IS NULL AND target_role_id IS NULL AND target_department_id IS NOT NULL AND target_duty_role_id IS NULL
     OR target_kind = 'role_department' AND assignee_id IS NULL AND target_role_id IS NOT NULL AND target_department_id IS NOT NULL AND target_duty_role_id IS NULL
     OR target_kind = 'duty'            AND assignee_id IS NULL AND target_role_id IS NULL AND target_department_id IS NULL AND target_duty_role_id IS NOT NULL),
    CONSTRAINT chk_wl_claim CHECK ((claimed_by IS NULL) = (claimed_at IS NULL) AND (target_kind <> 'user' OR claimed_by IS NULL)),
    CONSTRAINT chk_wl_done CHECK ((status = 'done') = (done_at IS NOT NULL) AND (done_at IS NULL) = (done_by IS NULL)),
    CONSTRAINT chk_wl_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL)
        AND (status <> 'cancelled' OR length(btrim(coalesce(cancel_reason, ''))) >= 3)),
    CONSTRAINT chk_wl_encounter CHECK (encounter_id IS NULL OR patient_id IS NOT NULL)
);
CREATE INDEX idx_wl_open_assignee ON wl_tasks (assignee_id) WHERE status IN ('open', 'in_progress');
CREATE INDEX idx_wl_open_claimed ON wl_tasks (claimed_by) WHERE status IN ('open', 'in_progress');
CREATE INDEX idx_wl_open_dept ON wl_tasks (department_id, due_at) WHERE status IN ('open', 'in_progress');
CREATE INDEX idx_wl_open_due ON wl_tasks (due_at) WHERE status IN ('open', 'in_progress') AND due_at IS NOT NULL;
CREATE INDEX idx_wl_created_by ON wl_tasks (created_by, created_at DESC);
CREATE INDEX idx_wl_patient ON wl_tasks (patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX idx_wl_role ON wl_tasks (target_role_id) WHERE status IN ('open', 'in_progress') AND target_role_id IS NOT NULL;
CREATE INDEX idx_wl_tdept ON wl_tasks (target_department_id) WHERE status IN ('open', 'in_progress') AND target_department_id IS NOT NULL;

CREATE TABLE wl_task_events (
    id          BIGSERIAL PRIMARY KEY,
    task_id     UUID NOT NULL REFERENCES wl_tasks(id) ON DELETE CASCADE,
    kind        VARCHAR(16) NOT NULL CHECK (kind IN ('created', 'edited', 'reassigned', 'claimed', 'released', 'started', 'done', 'cancelled', 'reopened',
                                                     'comment', 'reminded', 'escalated')),
    user_id     UUID REFERENCES users(id),
    note        TEXT,
    data        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wl_events_task ON wl_task_events (task_id, id);

-- ================================================================ 3. წყაროების ინდექსები (სისტემური დავალებები)
CREATE INDEX IF NOT EXISTS idx_qm_inc_submitted ON qm_incidents (triage_due_at) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS idx_bme_works_open_assignee ON bme_works (assignee_id) WHERE status IN ('planned', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_bme_repairs_open_assignee ON bme_repairs (assignee_id) WHERE status IN ('triaged', 'in_progress', 'waiting_parts', 'waiting_vendor');
CREATE INDEX IF NOT EXISTS idx_med_orders_abx_due ON med_orders (abx_review_due) WHERE abx_review_due IS NOT NULL AND abx_reviewed_at IS NULL;

-- ================================================================ 4. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON wl_categories, wl_tasks TO emr_app;
    GRANT SELECT, INSERT ON wl_task_events TO emr_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON wl_task_events FROM emr_app;
    GRANT USAGE, SELECT ON SEQUENCE wl_task_events_id_seq TO emr_app;
  END IF;
END $$;
