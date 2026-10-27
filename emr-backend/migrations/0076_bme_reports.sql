-- 0076_bme_reports.sql
-- ბიომედ-აპარატურა, ეტაპი 4 (D3-ის ბოლო) — ანგარიშები / KPI (ბლოკი D, მოდული 3).
--
--  • ხელმისაწვდომობა / მოცდენა: bme_status_periods (კალენდარული საათები, 24/7); მოცდენა = down (+ restricted × წონა, პარამეტრი);
--      მნიშვნელი — standby / retired / install_date-მდე დრო გამოკლებულია; არადაგეგმილი = down პერიოდი ორდერის ბმით (repair_id).
--      განყოფილება — იმ დროს მოქმედი (bme_moves, done → decided_at), პერიოდი იჭრება გადაადგილების მომენტზე.
--  • MTBF / MTTR: მწყობრიდან გამოსვლა = ორდერი (არა rejected / duplicate, შედეგი ≠ no_fault; USER_ERROR — პარამეტრით გამორიცხვადი);
--      MTTR = მოთხოვნა → შესრულება; ხელახლა გახსნა — ერთი მწყობრიდან გამოსვლა, ცალკე წილი.
--  • SLA: კოჰორტა reported_at-ით; ღია + ვადაგასული → დარღვეული, ვადაში მყოფი ღია — წილში არ ითვლება; ლოდინის საათები ცალკე.
--  • ხარჯი: ნაწილები (საწყობის ჟურნალი, შემობრუნების გამოკლებით) + შრომა + გარე (ორდერი) + PM / კალიბრაცია (ახალი ველები bme_works-ზე)
--      + კონტრაქტი (წლიური ექვივალენტი / 365 დღეზე, აპარატებზე თანაბრად ან შეძენის ღირებულებით); TCO = შეძენა + სერვისი; COSR.
--  • PM ვადაში: სამუშაოები due_date-ით + აქტიური გეგმა ვადით, სამუშაოს გარეშე; ვადაში = performed_on ≤ due_date + grace.
--  • მენეჯერული დაფა: rpt_fact_bme (დღე × განყოფილება), KPI ჯგუფი bme (9), „ყურადღება“, თვიური სექცია (dashboard_visibility / monthly_section).

-- ================================================================ 0. პარამეტრები
UPDATE system_modules SET settings = '{
  "rpt_restricted_weight": 0,
  "rpt_mtbf_exclude_user_error": false,
  "rpt_contract_alloc": "equal",
  "rpt_cosr_warn_pct": 10,
  "rpt_pm_grace_days": 0,
  "dashboard_visibility": "report_users",
  "monthly_section": true
}'::jsonb || settings,
  description = 'სამედიცინო აპარატების რეესტრი (პასპორტი), სტატუსი და მისი ასახვა დაგეგმვაზე, გადაადგილება, დოკუმენტები, QR ეტიკეტი; გეგმიური მომსახურება (PM) / კალიბრაცია / ელ. უსაფრთხოება; გაუმართაობის მოთხოვნა → შეკეთების ორდერი, სერვისის კონტრაქტები / SLA / გარანტია; ანგარიშები / KPI (ხელმისაწვდომობა, MTBF / MTTR, SLA, ხარჯი / TCO, PM ვადაში, მიზეზები)'
WHERE code = 'bme';

-- ================================================================ 1. PM / კალიბრაციის სამუშაოს ხარჯი (არჩევითი, შესრულებისას)
ALTER TABLE bme_works ADD COLUMN labor_hours   NUMERIC(8,2) CHECK (labor_hours >= 0);
ALTER TABLE bme_works ADD COLUMN labor_cost    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (labor_cost >= 0);
ALTER TABLE bme_works ADD COLUMN external_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (external_cost >= 0);
ALTER TABLE bme_works ADD COLUMN invoice_no    VARCHAR(60);

-- ანგარიშების ინდექსები
CREATE INDEX idx_bme_rep_reported ON bme_repairs (reported_at);
CREATE INDEX idx_bme_rep_done ON bme_repairs (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX idx_bme_works_due ON bme_works (due_date) WHERE due_date IS NOT NULL AND status <> 'cancelled';
CREATE INDEX idx_bme_works_performed ON bme_works (performed_on) WHERE status = 'done';
CREATE INDEX idx_bme_moves_done ON bme_moves (device_id, decided_at) WHERE status = 'done';
CREATE INDEX idx_bme_period_range ON bme_status_periods (started_at, ended_at);

-- ================================================================ 2. რეპორტინგის ფაქტი (დღე × განყოფილება)
CREATE TABLE rpt_fact_bme (
    day             DATE NOT NULL,
    department_id   UUID REFERENCES departments(id),
    avail_h         NUMERIC(16,6) NOT NULL DEFAULT 0,   -- ექსპლუატაციის საათები (operational / restricted / down)
    down_h          NUMERIC(16,6) NOT NULL DEFAULT 0,
    down_unpl_h     NUMERIC(16,6) NOT NULL DEFAULT 0,   -- down + ორდერის ბმა
    restricted_h    NUMERIC(16,6) NOT NULL DEFAULT 0,
    ls_avail_h      NUMERIC(16,6) NOT NULL DEFAULT 0,   -- სიცოცხლის შემანარჩუნებელი
    ls_down_h       NUMERIC(16,6) NOT NULL DEFAULT 0,
    ls_restricted_h NUMERIC(16,6) NOT NULL DEFAULT 0,
    failures        INT NOT NULL DEFAULT 0,             -- მოთხოვნის დღით
    failures_ue     INT NOT NULL DEFAULT 0,             -- მათ შორის მიზეზი USER_ERROR
    reopened        INT NOT NULL DEFAULT 0,
    requests        INT NOT NULL DEFAULT 0,             -- ყველა მოთხოვნა, დუბლიკატის გარეშე
    user_error      INT NOT NULL DEFAULT 0,
    nff             INT NOT NULL DEFAULT 0,             -- დაზიანება არ დადასტურდა
    sla_resp_n      INT NOT NULL DEFAULT 0,
    sla_resp_met    INT NOT NULL DEFAULT 0,
    sla_rest_n      INT NOT NULL DEFAULT 0,
    sla_rest_met    INT NOT NULL DEFAULT 0,
    repairs_done    INT NOT NULL DEFAULT 0,             -- შესრულების დღით (შედეგი ≠ no_fault)
    restore_h       NUMERIC(16,6) NOT NULL DEFAULT 0,   -- Σ (done_at − reported_at)
    rep_down_h      NUMERIC(16,6) NOT NULL DEFAULT 0,   -- Σ ორდერზე მიბმული down
    pm_due          INT NOT NULL DEFAULT 0,             -- ვადის დღით
    pm_ontime       INT NOT NULL DEFAULT 0,
    pm_fail         INT NOT NULL DEFAULT 0,
    cost_parts      NUMERIC(14,2) NOT NULL DEFAULT 0,
    cost_labor      NUMERIC(14,2) NOT NULL DEFAULT 0,
    cost_external   NUMERIC(14,2) NOT NULL DEFAULT 0,
    cost_pm         NUMERIC(14,2) NOT NULL DEFAULT 0,
    cost_contract   NUMERIC(14,2) NOT NULL DEFAULT 0,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_rpt_fact_bme ON rpt_fact_bme (day, department_id);

-- ================================================================ 3. KPI ცნობარი
ALTER TABLE rpt_kpis DROP CONSTRAINT IF EXISTS rpt_kpis_category_check;
ALTER TABLE rpt_kpis ADD CONSTRAINT rpt_kpis_category_check CHECK (category IN ('flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance', 'quality', 'ipc', 'bme'));
INSERT INTO rpt_kpis (code, category, name, unit, direction, definition, formula, source, finance, snapshot, drill, sort_order) VALUES
 ('bme_availability_pct', 'bme', 'აპარატების ხელმისაწვდომობა, %', 'pct', 'up',
  'კალენდარული საათები (24/7); standby / გამოყვანილი / ექსპლუატაციაში შეყვანამდე დრო არ ითვლება; შეზღუდული — წონით (rpt_restricted_weight)',
  '1 − (down + restricted × წონა) / ექსპლუატაციის საათები × 100', 'bme_status_periods → rpt_fact_bme', FALSE, FALSE, NULL, 120),
 ('bme_avail_ls_pct', 'bme', 'ხელმისაწვდომობა — სიცოცხლის შემანარჩუნებელი, %', 'pct', 'up',
  'იგივე, მხოლოდ კრიტიკულობა „სიცოცხლის შემანარჩუნებელი“', '1 − (down + restricted × წონა) / ექსპლუატაციის საათები × 100', 'bme_status_periods → rpt_fact_bme', FALSE, FALSE, NULL, 121),
 ('bme_mttr_h', 'bme', 'MTTR — აღდგენის საშუალო დრო, სთ', 'hours', 'down',
  'შესრულებული ორდერები (შედეგი ≠ „დაზიანება არ დადასტურდა“), შესრულების დღით', 'Σ (შესრულება − მოთხოვნა) / ორდერები', 'bme_repairs → rpt_fact_bme', FALSE, FALSE, NULL, 122),
 ('bme_mtbf_d', 'bme', 'MTBF — მწყობრიდან გამოსვლებს შორის, დღე', 'days', 'up',
  'სამუშაო დრო / მწყობრიდან გამოსვლა (ორდერი, არა უარყოფილი / დუბლიკატი / no_fault; USER_ERROR — პარამეტრით)', '(ექსპლუატაცია − down) / 24 / მწყობრიდან გამოსვლა', 'bme_status_periods, bme_repairs → rpt_fact_bme', FALSE, FALSE, NULL, 123),
 ('bme_sla_response_pct', 'bme', 'SLA — რეაგირება ვადაში, %', 'pct', 'up',
  'კოჰორტა მოთხოვნის დღით; ღია + ვადაგასული → დარღვეული, ვადაში მყოფი ღია — არ ითვლება', 'ვადაში / (ვადაში + დარღვეული) × 100', 'bme_repairs → rpt_fact_bme', FALSE, FALSE, NULL, 124),
 ('bme_sla_restore_pct', 'bme', 'SLA — აღდგენა ვადაში, %', 'pct', 'up',
  'კოჰორტა მოთხოვნის დღით; ღია + ვადაგასული → დარღვეული', 'ვადაში / (ვადაში + დარღვეული) × 100', 'bme_repairs → rpt_fact_bme', FALSE, FALSE, NULL, 125),
 ('bme_pm_ontime_pct', 'bme', 'PM / კალიბრაცია ვადაში, %', 'pct', 'up',
  'ვადა პერიოდში: სამუშაო (due_date) ან აქტიური გეგმა სამუშაოს გარეშე; ვადაში — შესრულება ≤ ვადა + rpt_pm_grace_days', 'ვადაში შესრულებული / ვადიანი × 100', 'bme_works, bme_plans → rpt_fact_bme', FALSE, FALSE, NULL, 126),
 ('bme_user_error_pct', 'bme', 'მომხმარებლის შეცდომის წილი, %', 'pct', 'down',
  'მიზეზი USER_ERROR ან უარყოფა „მომხმარებლის შეცდომა“ — ყველა მოთხოვნაში (დუბლიკატის გარეშე)', 'მომხმ. შეცდომა / მოთხოვნები × 100', 'bme_repairs → rpt_fact_bme', FALSE, FALSE, NULL, 127),
 ('bme_service_cost', 'bme', 'აპარატების სერვისის ხარჯი, ₾', 'gel', 'none',
  'ნაწილები (საწყობი) + შრომა + გარე (ორდერი) + PM / კალიბრაცია + კონტრაქტი (დღიური წილი)', 'Σ ხარჯი', 'bme_repairs, stock_docs, bme_works, bme_contracts → rpt_fact_bme', TRUE, FALSE, NULL, 128);

-- ================================================================ 4. უფლებები ბაზაში — ფაქტი იცვლება მხოლოდ გადათვლით (emr_app-ს DELETE სჭირდება: DELETE → INSERT)
