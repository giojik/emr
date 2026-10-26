-- 0075_bme_repairs_contracts.sql
-- ბიომედ-აპარატურა, ეტაპი 3 — გაუმართაობის მოთხოვნა → შეკეთების ორდერი, სერვისის კონტრაქტები / SLA / გარანტია (ბლოკი D, მოდული 3).
--
--  • ერთი ობიექტი (bme_repairs, № RO26-00001): requested → triaged → in_progress ⇄ waiting_parts / waiting_vendor → done → closed; rejected / duplicate.
--      წყარო: განყოფილების მოთხოვნა / PM-ის „ვერ გაიარა“ (0074, ავტომატურად ან ღილაკით) / ინჟინერი.
--      მოთხოვნა: მდგომარეობა (არ მუშაობს / შეზღუდულად / პრობლემა) + სასწრაფოობა (პაციენტის უსაფრთხოება / სასწრაფო / ჩვეულებრივი);
--      „არ მუშაობს“ → აპარატი მაშინვე „გაუმართავი“ (პარამეტრი); სტატუსის პერიოდი ორდერს მიება (bme_status_periods.repair_id → downtime / MTTR 0076-ში).
--      ტრიაჟი: პრიორიტეტი P1–P4 (შეთავაზება კრიტიკულობით), შემსრულებელი შიდა / გარე (გარანტია / კონტრაქტი → მომწოდებლის შეთავაზება).
--      ნაწილები: ჩამოწერა საწყობიდან (writeoff_reason = bme_use, FEFO) ან შესყიდვის მოთხოვნის მონახაზი (0051, source = bme_repair).
--      ხარჯი: ნაწილები + შრომა (საათები × განაკვეთი, ნაგულისხმევად 0) + გარე (თანხა, ინვოისი, არჩევითი ბმა ap_invoices-ზე; ხარჯის ჟურნალში — არა).
--      დასრულება → სტატუსის შეთავაზება („მუშა“ / „გამოყვანილი“), შემოწმება შეკეთების შემდეგ (0074-ის სამუშაო, ორდერზე მიბმული);
--      დახურვა: განყოფილების დადასტურებით (ავტომატურად N დღეში) ან ინჟინრით — პარამეტრი; ხელახლა გახსნა მიზეზით.
--  • ინციდენტი (0064): qm_incidents.source_type += bme_device; „შენახვა გამოძიებისთვის“ (hold) — შეკეთება და აღდგენა იბლოკება, ხსნის ხარისხის მენეჯერი.
--  • კონტრაქტები (bme_contracts + აპარატები M:N + ფაილები): სახე, პერიოდი, ღირებულება, რეაგირების / აღდგენის საათები P1–P4, uptime %, PM ვიზიტები,
--      რომელ სამუშაოს სახეებს ფარავს (0074 — გარე შემსრულებლის შეთავაზება). ქარხნული გარანტია — პასპორტის ველი (warranty_until), უცვლელი.
--  • SLA: რეაგირება (შიდა — მოთხოვნიდან დაწყებამდე; გარე — გამოძახებიდან ჩამოსვლამდე), აღდგენა (მოთხოვნიდან შესრულებამდე); კალენდარული საათები;
--      80% → გაფრთხილება, დარღვევა → ნიშანი + შეტყობინება (worker).
--  • შეხსენებები: კონტრაქტის ვადა 90 / 30 დღით ადრე (ინჟინრები + შესყიდვები), ქარხნული გარანტია 60 / 30 (ინჟინრები) — ერთხელ თითო ეტაპზე.

-- ================================================================ 0. პარამეტრები
UPDATE system_modules SET settings = settings || '{
  "rep_who": "all_staff",
  "rep_sets_down": true,
  "rep_notify_email": false,
  "rep_notify_sms": false,
  "rep_close_mode": "confirm",
  "rep_close_auto_days": 3,
  "rep_post_check": "suggest",
  "rep_pm_fail": "auto",
  "rep_sla_response": [1, 4, 24, 72],
  "rep_sla_restore": [24, 72, 168, 336],
  "rep_sla_warn_pct": 80,
  "rep_labor_rate": 0,
  "rep_parts_location_id": null,
  "rep_prefix": "RO",
  "ct_remind_days": [90, 30],
  "wr_remind_days": [60, 30]
}'::jsonb,
  description = 'სამედიცინო აპარატების რეესტრი (პასპორტი), სტატუსი და მისი ასახვა დაგეგმვაზე, გადაადგილება, დოკუმენტები, QR ეტიკეტი; გეგმიური მომსახურება (PM) / კალიბრაცია / ელ. უსაფრთხოება; გაუმართაობის მოთხოვნა → შეკეთების ორდერი, სერვისის კონტრაქტები / SLA / გარანტია; ანგარიშები — შემდეგი ეტაპი'
WHERE code = 'bme';

-- ================================================================ 1. კლასიფიკატორი: მიზეზი / ქმედება
CREATE TABLE bme_repair_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind        VARCHAR(8) NOT NULL CHECK (kind IN ('cause', 'action')),
    code        VARCHAR(30) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (kind, code)
);
INSERT INTO bme_repair_codes (kind, code, name, sort_order) VALUES
('cause', 'WEAR',        'ცვეთა / ბუნებრივი დაძველება',          10),
('cause', 'DAMAGE',      'ფიზიკური დაზიანება (დავარდნა, დარტყმა)', 20),
('cause', 'LIQUID',      'სითხის მოხვედრა',                       30),
('cause', 'USER_ERROR',  'მომხმარებლის შეცდომა / არასწორი გამოყენება', 40),
('cause', 'SOFTWARE',    'პროგრამული',                            50),
('cause', 'POWER',       'ელ. კვება / ქსელი',                     60),
('cause', 'ACCESSORY',   'აქსესუარი / სახარჯი მასალა',           70),
('cause', 'UNKNOWN',     'უცნობი',                                90),
('action', 'ADJUST',     'რეგულირება / კალიბრაცია',               10),
('action', 'PART',       'ნაწილის შეცვლა',                        20),
('action', 'SOFTWARE',   'პროგრამის განახლება / აღდგენა',         30),
('action', 'CLEAN',      'გაწმენდა',                              40),
('action', 'TRAINING',   'ინსტრუქტაჟი (მომხმარებელს)',            50),
('action', 'VENDOR',     'მომწოდებლის სერვისი',                   60),
('action', 'NOT_FIXED',  'შეკეთება ვერ მოხერხდა',                 90);

-- ================================================================ 2. კონტრაქტები
CREATE TABLE bme_contracts (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contract_no          VARCHAR(60) NOT NULL,
    title                TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    supplier_id          UUID NOT NULL REFERENCES stock_suppliers(id),
    kind                 VARCHAR(14) NOT NULL CHECK (kind IN ('full_service', 'pm_only', 'parts', 'on_call', 'ext_warranty')),
    start_date           DATE NOT NULL,
    end_date             DATE NOT NULL,
    cost                 NUMERIC(14,2) CHECK (cost >= 0),
    cost_period          VARCHAR(8) CHECK (cost_period IN ('once', 'month', 'quarter', 'year')),
    response_hours       SMALLINT[] CHECK (response_hours IS NULL OR (cardinality(response_hours) = 4 AND 0 < ALL (response_hours))),   -- P1..P4
    restore_hours        SMALLINT[] CHECK (restore_hours IS NULL OR (cardinality(restore_hours) = 4 AND 0 < ALL (restore_hours))),
    uptime_pct           NUMERIC(5,2) CHECK (uptime_pct BETWEEN 0 AND 100),
    pm_visits_per_year   SMALLINT CHECK (pm_visits_per_year BETWEEN 0 AND 52),
    covers_kinds         UUID[] NOT NULL DEFAULT '{}',                          -- bme_work_kinds (0074): გარე შემსრულებლის შეთავაზება
    covers_parts         BOOLEAN NOT NULL DEFAULT FALSE,
    contact              TEXT,
    notes                TEXT,
    status               VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    cancel_reason        TEXT,
    created_by           UUID NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (end_date >= start_date),
    CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
    CHECK ((cost IS NULL) = (cost_period IS NULL))
);
CREATE UNIQUE INDEX ux_bme_contract_no ON bme_contracts (supplier_id, upper(contract_no));
CREATE INDEX idx_bme_contract_end ON bme_contracts (end_date) WHERE status = 'active';

CREATE TABLE bme_contract_devices (
    contract_id  UUID NOT NULL REFERENCES bme_contracts(id),
    device_id    UUID NOT NULL REFERENCES bme_devices(id),
    added_by     UUID REFERENCES users(id),
    added_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contract_id, device_id)
);
CREATE INDEX idx_bme_contract_dev ON bme_contract_devices (device_id);

CREATE TABLE bme_contract_files (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contract_id    UUID NOT NULL REFERENCES bme_contracts(id),
    title          TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    mime_type      VARCHAR(40) NOT NULL,
    size_bytes     INT NOT NULL,
    sha256         CHAR(64) NOT NULL,
    original_name  TEXT,
    uploaded_by    UUID NOT NULL REFERENCES users(id),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bme_contract_files ON bme_contract_files (contract_id) WHERE is_active;

-- ================================================================ 3. შეკეთების ორდერი
CREATE TABLE bme_repairs (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repair_no             VARCHAR(30) NOT NULL UNIQUE,
    device_id             UUID NOT NULL REFERENCES bme_devices(id),
    source                VARCHAR(10) NOT NULL CHECK (source IN ('request', 'pm_work', 'engineer')),
    pm_work_id            UUID REFERENCES bme_works(id),
    status                VARCHAR(14) NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'triaged', 'in_progress', 'waiting_parts', 'waiting_vendor', 'done', 'closed', 'rejected', 'duplicate')),
    -- მოთხოვნა
    condition             VARCHAR(12) NOT NULL CHECK (condition IN ('not_working', 'limited', 'issue')),
    urgency               VARCHAR(8) NOT NULL DEFAULT 'normal' CHECK (urgency IN ('safety', 'urgent', 'normal')),
    description           TEXT NOT NULL CHECK (length(btrim(description)) >= 5),
    patient_involved      BOOLEAN NOT NULL DEFAULT FALSE,                      -- „შეეხო პაციენტს / თანამშრომელს?“ → ინციდენტის შეთავაზება
    reported_by           UUID NOT NULL REFERENCES users(id),
    reported_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reporter_department_id UUID REFERENCES departments(id),
    contact_phone         VARCHAR(40),
    device_status_before  VARCHAR(12),                                         -- მოთხოვნისას (უარყოფისას აღდგენისთვის)
    -- ტრიაჟი
    priority              SMALLINT CHECK (priority BETWEEN 1 AND 4),
    suggested_priority    SMALLINT NOT NULL CHECK (suggested_priority BETWEEN 1 AND 4),
    triaged_by            UUID REFERENCES users(id),
    triaged_at            TIMESTAMPTZ,
    triage_note           TEXT,
    reject_reason         VARCHAR(12) CHECK (reject_reason IN ('no_fault', 'user_error', 'duplicate', 'other')),
    reject_note           TEXT,
    duplicate_of          UUID REFERENCES bme_repairs(id),
    -- შემსრულებელი / დაფარვა
    performer_kind        VARCHAR(10) NOT NULL DEFAULT 'internal' CHECK (performer_kind IN ('internal', 'external')),
    assignee_id           UUID REFERENCES users(id),
    supplier_id           UUID REFERENCES stock_suppliers(id),
    external_person       TEXT,
    coverage              VARCHAR(10) CHECK (coverage IN ('warranty', 'contract')),
    contract_id           UUID REFERENCES bme_contracts(id),
    vendor_called_at      TIMESTAMPTZ,
    vendor_ref            VARCHAR(60),                                         -- მომწოდებლის ბილეთის №
    vendor_arrived_at     TIMESTAMPTZ,
    started_at            TIMESTAMPTZ,                                         -- შიდა რეაგირება (სამუშაოს დაწყება)
    wait_reason           TEXT,
    -- SLA (კალენდარული საათები)
    sla_response_hours    SMALLINT,
    sla_restore_hours     SMALLINT,
    sla_response_due      TIMESTAMPTZ,
    sla_restore_due       TIMESTAMPTZ,
    sla_warned_at         TIMESTAMPTZ,
    sla_breach_notified_at TIMESTAMPTZ,
    -- შედეგი
    done_at               TIMESTAMPTZ,
    done_by               UUID REFERENCES users(id),
    outcome               VARCHAR(14) CHECK (outcome IN ('repaired', 'not_repairable', 'no_fault')),
    cause_id              UUID REFERENCES bme_repair_codes(id),
    action_id             UUID REFERENCES bme_repair_codes(id),
    resolution            TEXT,
    labor_hours           NUMERIC(8,2) CHECK (labor_hours >= 0),
    labor_cost            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (labor_cost >= 0),
    parts_cost            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (parts_cost >= 0),
    external_cost         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (external_cost >= 0),
    invoice_no            VARCHAR(60),
    ap_invoice_id         UUID REFERENCES ap_invoices(id),
    suggested_status      VARCHAR(12) CHECK (suggested_status IN ('operational', 'retired')),
    status_applied        BOOLEAN NOT NULL DEFAULT FALSE,
    post_check_required   BOOLEAN NOT NULL DEFAULT FALSE,
    post_check_work_id    UUID REFERENCES bme_works(id),
    loaner_device_id      UUID REFERENCES bme_devices(id),
    loaner_text           TEXT,
    -- დახურვა
    closed_at             TIMESTAMPTZ,
    closed_by             UUID REFERENCES users(id),
    close_kind            VARCHAR(10) CHECK (close_kind IN ('confirmed', 'auto', 'engineer')),
    close_note            TEXT,
    reopen_count          SMALLINT NOT NULL DEFAULT 0,
    -- ინციდენტი / მტკიცებულების შენახვა
    incident_id           UUID REFERENCES qm_incidents(id),
    hold                  BOOLEAN NOT NULL DEFAULT FALSE,
    hold_by               UUID REFERENCES users(id),
    hold_at               TIMESTAMPTZ,
    hold_note             TEXT,
    hold_released_by      UUID REFERENCES users(id),
    hold_released_at      TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status = 'requested' OR status IN ('rejected', 'duplicate') OR (priority IS NOT NULL AND triaged_at IS NOT NULL)),
    CHECK (status NOT IN ('rejected', 'duplicate') OR reject_reason IS NOT NULL),
    CHECK (status <> 'duplicate' OR duplicate_of IS NOT NULL),
    CHECK (duplicate_of IS NULL OR duplicate_of <> id),
    CHECK (status NOT IN ('done', 'closed') OR (done_at IS NOT NULL AND outcome IS NOT NULL)),
    CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND close_kind IS NOT NULL)),
    CHECK (performer_kind = 'internal' OR supplier_id IS NOT NULL OR external_person IS NOT NULL),
    CHECK ((coverage = 'contract') = (contract_id IS NOT NULL)),
    CHECK (source <> 'pm_work' OR pm_work_id IS NOT NULL),
    CHECK (loaner_device_id IS NULL OR loaner_device_id <> device_id)
);
CREATE INDEX idx_bme_rep_dev ON bme_repairs (device_id, reported_at DESC);
CREATE INDEX idx_bme_rep_open ON bme_repairs (status, priority) WHERE status NOT IN ('closed', 'rejected', 'duplicate');
CREATE INDEX idx_bme_rep_assignee ON bme_repairs (assignee_id) WHERE status NOT IN ('closed', 'rejected', 'duplicate');
CREATE INDEX idx_bme_rep_reporter ON bme_repairs (reported_by);
CREATE INDEX idx_bme_rep_pm ON bme_repairs (pm_work_id) WHERE pm_work_id IS NOT NULL;
-- PM სამუშაოდან — ერთი ორდერი
CREATE UNIQUE INDEX ux_bme_rep_pm_work ON bme_repairs (pm_work_id) WHERE pm_work_id IS NOT NULL AND status NOT IN ('rejected', 'duplicate');

CREATE TABLE bme_repair_events (
    id          BIGSERIAL PRIMARY KEY,
    repair_id   UUID NOT NULL REFERENCES bme_repairs(id),
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('requested', 'triaged', 'assigned', 'vendor_called', 'vendor_arrived', 'started', 'waiting', 'resumed',
                                                     'parts_issued', 'purchase', 'cost', 'done', 'status_applied', 'confirmed', 'closed', 'reopened', 'rejected', 'duplicate',
                                                     'hold', 'hold_released', 'incident', 'post_check', 'file', 'note', 'sla_warn', 'sla_breach')),
    data        JSONB NOT NULL DEFAULT '{}',
    user_id     UUID REFERENCES users(id),                                       -- NULL — სისტემა (worker)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bme_rep_events ON bme_repair_events (repair_id, id);

-- ================================================================ 4. ბმები არსებულ ცხრილებთან
-- სტატუსის პერიოდი ↔ ორდერი (downtime / MTTR)
ALTER TABLE bme_status_periods ADD COLUMN repair_id UUID REFERENCES bme_repairs(id);
CREATE INDEX idx_bme_period_repair ON bme_status_periods (repair_id) WHERE repair_id IS NOT NULL;
-- დოკუმენტი ↔ ორდერი (სერვისის აქტი, ფოტო)
ALTER TABLE bme_documents ADD COLUMN repair_id UUID REFERENCES bme_repairs(id);
CREATE INDEX idx_bme_docs_repair ON bme_documents (repair_id) WHERE repair_id IS NOT NULL;
-- სამუშაო (0074) ↔ ორდერი: შემოწმება შეკეთების შემდეგ
ALTER TABLE bme_works ADD COLUMN repair_id UUID REFERENCES bme_repairs(id);
CREATE INDEX idx_bme_works_repair ON bme_works (repair_id) WHERE repair_id IS NOT NULL;

-- საწყობი: ნაწილების ჩამოწერა ორდერზე
ALTER TABLE stock_docs DROP CONSTRAINT stock_docs_writeoff_reason_check;
ALTER TABLE stock_docs ADD CONSTRAINT stock_docs_writeoff_reason_check
    CHECK (writeoff_reason IN ('expired', 'damaged', 'lost', 'department_use', 'recall', 'other', 'lab_use', 'cssd_use', 'bme_use'));
ALTER TABLE stock_docs ADD COLUMN bme_repair_id UUID REFERENCES bme_repairs(id);
CREATE INDEX idx_stock_docs_bme_repair ON stock_docs (bme_repair_id) WHERE bme_repair_id IS NOT NULL;

-- შესყიდვის მოთხოვნა (0051) ორდერიდან
ALTER TABLE proc_requisitions DROP CONSTRAINT proc_requisitions_source_check;
ALTER TABLE proc_requisitions ADD CONSTRAINT proc_requisitions_source_check CHECK (source IN ('manual', 'minmax', 'request', 'bme_repair'));
ALTER TABLE proc_requisitions ADD COLUMN bme_repair_id UUID REFERENCES bme_repairs(id);
ALTER TABLE proc_requisitions ADD CONSTRAINT proc_pr_bme_repair CHECK (source <> 'bme_repair' OR bme_repair_id IS NOT NULL);
CREATE INDEX idx_proc_pr_bme_repair ON proc_requisitions (bme_repair_id) WHERE bme_repair_id IS NOT NULL;

-- ინციდენტის წყარო: ბიომედ-აპარატი (პასპორტი)
ALTER TABLE qm_incidents DROP CONSTRAINT qm_incidents_source_type_check;
ALTER TABLE qm_incidents ADD CONSTRAINT qm_incidents_source_type_check
    CHECK (source_type IN ('encounter', 'stay', 'med_order', 'mar_entry', 'or_case', 'dx_order_item', 'lab_specimen', 'asset', 'dx_device', 'hai_case', 'bme_device'));

-- აპარატის ისტორიის ახალი სახეები
ALTER TABLE bme_events DROP CONSTRAINT bme_events_kind_check;
ALTER TABLE bme_events ADD CONSTRAINT bme_events_kind_check CHECK (kind IN ('created', 'updated', 'status', 'move_requested', 'moved', 'move_rejected', 'move_cancelled',
    'linked', 'unlinked', 'document', 'document_removed', 'reviewed',
    'plan', 'work_planned', 'work_done', 'work_cancelled', 'meter',
    'repair_requested', 'repair_done', 'repair_closed', 'repair_rejected', 'contract'));

-- ================================================================ 5. ვადის შეხსენებები (კონტრაქტი / ქარხნული გარანტია) — ერთხელ თითო ეტაპზე
CREATE TABLE bme_expiry_reminders (
    ref_kind  VARCHAR(10) NOT NULL CHECK (ref_kind IN ('contract', 'warranty')),
    ref_id    UUID NOT NULL,                                                     -- bme_contracts.id / bme_devices.id
    end_date  DATE NOT NULL,
    stage     SMALLINT NOT NULL,                                                 -- დღეები ვადამდე (90, 30…)
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ref_kind, ref_id, end_date, stage)
);

-- ორდერები / კონტრაქტები არ იშლება (ისტორია)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON bme_repairs, bme_repair_events, bme_contracts FROM emr_app;
  END IF;
END $$;
