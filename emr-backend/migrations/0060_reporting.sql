-- 0060_reporting.sql
-- მენეჯერული დაფა და რეპორტინგი, ეტაპი 1 — საძირკველი (აგრეგაციის ფენა, KPI ცნობარი, ხედვის არე, უფლებები).
--
--  პრინციპი: მძიმე რეპორტები ოპერაციულ ცხრილებს არ კითხულობენ. worker (ან admin ხელით) ითვლის დღიურ ფაქტებს
--  (rpt_fact_*: დღე × განყოფილება × ჭრილი) და მარაგის მომენტალურ სურათს (rpt_stock_snapshot); დაფები და ექსპორტი კითხულობენ
--  მხოლოდ ამ ცხრილებს. REPORTING_DB_URL (არასავალდებულო) — წყაროს წაკითხვა რეპლიკიდან; ჩაწერა ყოველთვის მთავარ ბაზაში.
--  ცხრილები public სქემაშია `rpt_` პრეფიქსით — არსებული უფლებები (emr_app), ბექაპი და db:codegen უცვლელად მუშაობს.
--
--  • განახლება: დღევანდელი დღე — ყოველ refresh_today_min წუთში; ღამით (nightly_hour) — ბოლო recompute_days დღე
--      (დაგვიანებული შესწორებები). დახურული ფინანსური თვე (fin_periods.status = closed) — ფინანსური ფაქტი აღარ გადაითვლება
--      (freeze_closed_periods). ჟურნალი — rpt_refresh_runs. ერთდროულად ერთი გადათვლა (advisory lock).
--  • KPI ცნობარი (rpt_kpis): განმარტება, ფორმულა, წყარო, ერთეული, მიმართულება; გამოთვლა — კოდში (ფორმულა არ არის DSL).
--      სამიზნე / გაფრთხილების ზღვარი — კლინიკაზე ან განყოფილებაზე (rpt_kpi_targets).
--  • ხედვის არე: reports — თავისი განყოფილებები (rpt_user_scopes ∪ users.department_id); reports_all — მთელი კლინიკა;
--      reports_phi — ჩაღრმავებისა და ექსპორტის პერსონალური ველები. 30 → 33 უფლება.
--  • საწოლის სტატუსის ისტორია (bed_status_log) — დაბლოკილი საწოლი ხელმისაწვდომი საწოლ-საათებიდან აკლდება.

-- ================================================================ 0. მოდული, უფლებები
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('reporting', 'მენეჯერული რეპორტინგი', 'მენეჯერული დაფა: დღიური აგრეგაცია (ნაკადი, საწოლები, საოპერაციო, კვლევები, ლაბორატორია, მარაგი, ფინანსები), KPI-ები და სამიზნეები, ექსპორტი',
 TRUE, TRUE,
 '{"refresh_today_min": 15,
   "nightly_hour": 2,
   "recompute_days": 35,
   "freeze_closed_periods": true,
   "occupancy_basis": "hours",
   "stock_days_window": 30,
   "stock_days_alert": 7,
   "compare_default": "prev",
   "lab_tat_start": "collected"}', 44)
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
        'reports', 'reports_all', 'reports_phi']::VARCHAR(30)[]);

-- ================================================================ 1. საწოლის სტატუსის ისტორია
CREATE TABLE bed_status_log (
    id         BIGSERIAL PRIMARY KEY,
    bed_id     UUID NOT NULL REFERENCES beds(id),
    status     VARCHAR(10) NOT NULL,
    is_active  BOOLEAN NOT NULL,
    at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bed_status_log_bed ON bed_status_log (bed_id, at);

CREATE OR REPLACE FUNCTION bed_status_log_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        INSERT INTO bed_status_log (bed_id, status, is_active, at) VALUES (NEW.id, NEW.status, NEW.is_active, CURRENT_TIMESTAMP);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_beds_status_log AFTER INSERT OR UPDATE OF status, is_active ON beds FOR EACH ROW EXECUTE FUNCTION bed_status_log_trg();

-- საწყისი მდგომარეობა: არსებული საწოლი — შექმნიდან აქტიური / თავისუფალი, ბოლო ცვლილებიდან (status_at) — ახლანდელი სტატუსი
INSERT INTO bed_status_log (bed_id, status, is_active, at)
SELECT b.id, 'free', TRUE, b.created_at FROM beds b WHERE b.status_at > b.created_at;
INSERT INTO bed_status_log (bed_id, status, is_active, at)
SELECT b.id, b.status, b.is_active, greatest(b.status_at, b.created_at) FROM beds b;

-- ================================================================ 2. ხედვის არე
CREATE TABLE rpt_user_scopes (
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department_id  UUID NOT NULL REFERENCES departments(id),
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, department_id)
);

-- ================================================================ 3. KPI ცნობარი და სამიზნეები
CREATE TABLE rpt_kpis (
    code        VARCHAR(40) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    category    VARCHAR(12) NOT NULL CHECK (category IN ('flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance')),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    unit        VARCHAR(8) NOT NULL CHECK (unit IN ('count', 'pct', 'days', 'hours', 'min', 'gel', 'ratio')),
    direction   VARCHAR(4) NOT NULL CHECK (direction IN ('up', 'down', 'none')),
    definition  TEXT NOT NULL,
    formula     TEXT NOT NULL,           -- გამოთვლის წესი (ტექსტი, ეკრანზე ⓘ) — თავად გამოთვლა კოდშია
    source      TEXT NOT NULL,           -- საიდან მოდის მონაცემი
    finance     BOOLEAN NOT NULL DEFAULT FALSE,   -- ფინანსური მაჩვენებელი — ჩანს ფინანსების ხედვის წესით
    snapshot    BOOLEAN NOT NULL DEFAULT FALSE,   -- მომენტალური (პერიოდზე არ არის დამოკიდებული)
    drill       VARCHAR(20) CHECK (drill IN ('encounters', 'admissions', 'discharges', 'deaths', 'or_cases', 'dx_orders', 'lab_orders', 'stock_low')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100,
    updated_by  UUID REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_rpt_kpis_updated BEFORE UPDATE ON rpt_kpis FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rpt_kpi_targets (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kpi_code       VARCHAR(40) NOT NULL REFERENCES rpt_kpis(code) ON DELETE CASCADE,
    department_id  UUID REFERENCES departments(id),            -- NULL — მთელი კლინიკა (და ნაგულისხმევი განყოფილებებისთვის)
    target         NUMERIC(14,2) NOT NULL,                     -- მწვანე: ≥ (up) / ≤ (down)
    warn           NUMERIC(14,2),                              -- ყვითელი ზღვარი; NULL — მხოლოდ მწვანე / წითელი
    note           TEXT,
    updated_by     UUID REFERENCES users(id),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_rpt_kpi_target ON rpt_kpi_targets (kpi_code, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

INSERT INTO rpt_kpis (code, category, name, unit, direction, definition, formula, source, finance, snapshot, drill, sort_order) VALUES
-- ნაკადი
('enc_total', 'flow', 'ვიზიტები (სულ)', 'count', 'none', 'ყველა შემთხვევა (ამბულატორია, ლაბორატორია, გადაუდებელი, სტაციონარი), გარდა გაუქმებულისა', 'შემთხვევების რაოდენობა დაწყების დღით (კლინიკის დროით)', 'encounters.start_time, status ≠ cancelled', FALSE, FALSE, 'encounters', 10),
('enc_outpatient', 'flow', 'ამბულატორიული ვიზიტები', 'count', 'none', 'ექიმის ამბულატორიული ვიზიტი', 'type = outpatient, visit_kind = consultation', 'encounters', FALSE, FALSE, 'encounters', 11),
('enc_lab_only', 'flow', 'ლაბორატორიული ვიზიტები', 'count', 'none', 'პირდაპირ ლაბორატორიაში მოსული პაციენტი (ექიმის ვიზიტის გარეშე)', 'visit_kind = lab', 'encounters', FALSE, FALSE, 'encounters', 12),
('enc_emergency', 'flow', 'გადაუდებელი შემთხვევები', 'count', 'none', 'გადაუდებელი ტიპის შემთხვევა', 'type = emergency', 'encounters', FALSE, FALSE, 'encounters', 13),
('new_patients', 'flow', 'ახალი პაციენტები', 'count', 'up', 'პაციენტის პირველი (არაგაუქმებული) შემთხვევა კლინიკაში', 'შემთხვევა, რომლის წინაც პაციენტს სხვა შემთხვევა არ ჰქონია', 'encounters', FALSE, FALSE, NULL, 14),
('enc_cancel_pct', 'flow', 'გაუქმებული ვიზიტები', 'pct', 'down', 'გაუქმებული შემთხვევების წილი', 'გაუქმებული / (ყველა, გაუქმებულის ჩათვლით) × 100', 'encounters.status', FALSE, FALSE, NULL, 15),
-- საწოლები
('occupancy_pct', 'beds', 'საწოლების დატვირთვა', 'pct', 'up', 'საწოლფონდის გამოყენება', 'occupancy_basis = hours: დაკავებული საწოლ-საათები / ხელმისაწვდომი საწოლ-საათები × 100 (დაბლოკილი და გათიშული საწოლი მნიშვნელში არ ითვლება; overflow საწოლი — მხოლოდ მრიცხველში). midnight: შუაღამის დაკავება / საშუალო ხელმისაწვდომი საწოლი × 100', 'bed_assignments, beds, bed_status_log', FALSE, FALSE, NULL, 20),
('census_avg', 'beds', 'საშუალო დაკავება (შუაღამე)', 'count', 'none', 'პაციენტები საწოლზე დღის ბოლოს (24:00), საშუალოდ დღეზე', 'Σ შუაღამის დაკავება / დღეების რაოდენობა', 'bed_assignments', FALSE, FALSE, NULL, 21),
('admissions', 'beds', 'ჰოსპიტალიზაცია', 'count', 'none', 'მიღებული პაციენტები (განყოფილება — პირველი განთავსების)', 'inpatient_stays.admitted_at, status ≠ cancelled', 'inpatient_stays, bed_assignments', FALSE, FALSE, 'admissions', 22),
('discharges', 'beds', 'გაწერა', 'count', 'none', 'გაწერილი პაციენტები, გარდაცვლილის ჩათვლით (განყოფილება — ბოლო განთავსების)', 'inpatient_stays.ended_at, status = discharged', 'inpatient_stays', FALSE, FALSE, 'discharges', 23),
('alos', 'beds', 'საშუალო დაყოვნება', 'days', 'down', 'გაწერილი პაციენტის საშუალო ხანგრძლივობა', 'Σ (გაწერის თარიღი − მიღების თარიღი, მინ. 1) / გაწერილები', 'inpatient_stays', FALSE, FALSE, NULL, 24),
('bed_turnover', 'beds', 'საწოლის ბრუნვა', 'ratio', 'up', 'რამდენი პაციენტი გაიარა ერთმა საწოლმა პერიოდში', 'გაწერილები / საშუალო ხელმისაწვდომი საწოლი', 'inpatient_stays, beds', FALSE, FALSE, NULL, 25),
('turnover_interval', 'beds', 'ბრუნვის ინტერვალი', 'days', 'down', 'საშუალოდ რამდენი დღე დგას საწოლი ცარიელი პაციენტებს შორის', '(ხელმისაწვდომი − დაკავებული საწოლ-საათები) / 24 / გაწერილები', 'bed_assignments, beds', FALSE, FALSE, NULL, 26),
('mortality_pct', 'beds', 'ლეტალობა', 'pct', 'down', 'გარდაცვლილთა წილი გაწერილებში', 'გარდაცვლილი / გაწერილები × 100', 'inpatient_stays.death_at', FALSE, FALSE, 'deaths', 27),
('readmit30_pct', 'beds', 'განმეორებითი ჰოსპიტალიზაცია 30 დღეში', 'pct', 'down', 'ჰოსპიტალიზაცია, რომელსაც წინა 30 დღეში იმავე პაციენტის გაწერა უსწრებს', 'განმეორებითი / ჰოსპიტალიზაცია × 100', 'inpatient_stays', FALSE, FALSE, NULL, 28),
-- საოპერაციო
('or_cases', 'or', 'ოპერაციები', 'count', 'none', 'დასრულებული ოპერაციები (ოთახში შესვლის დღით; განყოფილება — ქირურგიული)', 'or_cases.status = completed', 'or_cases, or_case_times', FALSE, FALSE, 'or_cases', 30),
('or_emergency_pct', 'or', 'გადაუდებელი ოპერაციები', 'pct', 'none', 'გადაუდებელის წილი დასრულებულ ოპერაციებში', 'urgency = emergency / დასრულებული × 100', 'or_cases', FALSE, FALSE, NULL, 31),
('or_utilization_pct', 'or', 'საოპერაციოს დატვირთვა', 'pct', 'up', 'ოთახების გამოყენება სამუშაო საათებში', 'ოთახში ყოფნის წუთები (სამუშაო საათებში) / ოთახების სამუშაო წუთები × 100 (ოთახის ბლოკით)', 'or_case_times, or_rooms', FALSE, FALSE, NULL, 32),
('or_first_on_time_pct', 'or', 'პირველი ოპერაციის დროული დაწყება', 'pct', 'up', 'ოთახის დღის პირველი გეგმიური ოპერაცია დაიწყო დროზე (first_case_tolerance_min-ის ფარგლებში)', 'დროული / პირველი ოპერაციები × 100', 'or_cases, or_case_times', FALSE, FALSE, NULL, 33),
('or_cancel_pct', 'or', 'გაუქმებული ოპერაციები', 'pct', 'down', 'გაუქმებულის წილი დაგეგმილში (როგორც საოპერაციოს სტატისტიკაში)', 'გაუქმებული (გაუქმების დღით) / დაგეგმილი (scheduled_start დღით) × 100', 'or_cases', FALSE, FALSE, NULL, 34),
('or_surgery_min_avg', 'or', 'ოპერაციის საშუალო ხანგრძლივობა', 'min', 'none', 'განაკვეთიდან გაკერვამდე', 'Σ (closure − incision) / ოპერაციები, სადაც ორივე დრო ჩაწერილია', 'or_case_times', FALSE, FALSE, NULL, 35),
-- კვლევები
('dx_orders', 'dx', 'ინსტრუმენტული კვლევები', 'count', 'none', 'რადიოლოგია და ენდოსკოპია, დანიშვნის დღით (გაუქმებულის გარეშე)', 'dx_order_items.section ≠ lab', 'dx_order_items', FALSE, FALSE, 'dx_orders', 40),
('dx_tat_median_h', 'dx', 'კვლევის პასუხის დრო (მედიანა)', 'hours', 'down', 'დანიშვნიდან ხელმოწერილ დასკვნამდე', 'მედიანა (validated_at − ordered_at); ≈ — ინტერვალების ჰისტოგრამიდან', 'dx_order_items', FALSE, FALSE, NULL, 41),
('dx_cancel_pct', 'dx', 'გაუქმებული კვლევები', 'pct', 'down', 'გაუქმებულის წილი დანიშნულში', 'გაუქმებული / დანიშნული × 100', 'dx_order_items', FALSE, FALSE, NULL, 42),
-- ლაბორატორია
('lab_orders', 'lab', 'ლაბორატორიული კვლევები', 'count', 'none', 'დანიშნული ლაბორატორიული კვლევები (გაუქმებულის გარეშე)', 'dx_order_items.section = lab', 'dx_order_items', FALSE, FALSE, 'lab_orders', 50),
('lab_tat_median_min', 'lab', 'ლაბ. პასუხის დრო (მედიანა)', 'min', 'down', 'ნიმუშის აღებიდან ვალიდაციამდე (lab_tat_start = ordered — დანიშვნიდან)', 'მედიანა; ≈ — ინტერვალების ჰისტოგრამიდან', 'dx_order_items, lab_specimens', FALSE, FALSE, NULL, 51),
('lab_tat_p90_min', 'lab', 'ლაბ. პასუხის დრო (P90)', 'min', 'down', '90% პასუხი ამ დროში ან უფრო სწრაფად', '90-ე პროცენტილი; ≈ — ჰისტოგრამიდან', 'dx_order_items, lab_specimens', FALSE, FALSE, NULL, 52),
('lab_external_pct', 'lab', 'გარე ლაბორატორიის წილი', 'pct', 'none', 'გარე ლაბორატორიაში გაგზავნილი კვლევები', 'ext_lab_id IS NOT NULL / ლაბ. კვლევები × 100', 'dx_order_items', FALSE, FALSE, NULL, 53),
('lab_ext_cost', 'lab', 'გარე ლაბორატორიის ღირებულება', 'gel', 'down', 'გარე ლაბორატორიის შესყიდვის ფასი', 'Σ ext_cost (დანიშვნის დღით)', 'dx_order_items.ext_cost', TRUE, FALSE, NULL, 54),
-- მარაგი
('stock_consumption', 'stock', 'მარაგის ხარჯი', 'gel', 'none', 'პაციენტზე / განყოფილებაში მოხმარებული მასალა და მედიკამენტი', 'Σ consumption მოძრაობის ღირებულება (კლინიკის ღირებულების მეთოდით)', 'stock_moves', TRUE, FALSE, NULL, 60),
('stock_loss', 'stock', 'ჩამოწერა და დანაკარგი', 'gel', 'down', 'ჩამოწერა (ვადა, დაზიანება) და ინვენტარიზაციის სხვაობა', 'Σ writeoff + adjustment (−)', 'stock_moves', TRUE, FALSE, NULL, 61),
('stock_low_items', 'stock', 'დაბალი მარაგი (პოზიციები)', 'count', 'down', 'პოზიცია × ლოკაცია, რომლის მარაგი stock_days_alert დღეზე ნაკლებს ყოფნის', 'ნაშთი / საშუალო დღიური ხარჯი (ბოლო stock_days_window დღე) < stock_days_alert', 'stock_balances, stock_moves', FALSE, TRUE, 'stock_low', 62),
('stock_expiring_90', 'stock', 'ვადაგასასვლელი 90 დღეში', 'gel', 'down', 'ნაშთის ღირებულება, რომლის ვადა 90 დღეში იწურება', 'Σ ნაშთი × ლოტის ფასი, expires_on ≤ დღეს + 90', 'stock_balances, stock_lots', TRUE, TRUE, NULL, 63),
-- ფინანსები
('rev_net', 'finance', 'შემოსავალი (წმინდა)', 'gel', 'up', 'გაწეული მომსახურება გადამხდელებით, ჩამოწერისა და უარის გარეშე (0053-ის წესით)', 'პაციენტი + დაზღვევა + სახელმწიფო + სხვა + დაუზუსტებელი (revenue_basis, revenue_dept_basis — ფინანსების პარამეტრებიდან)', 'invoices, invoice_line_items, stay_bed_days, fin_claim_items', TRUE, FALSE, NULL, 70),
('rev_state_pct', 'finance', 'სახელმწიფოს წილი', 'pct', 'none', 'სახელმწიფო დაფინანსების წილი წმინდა შემოსავალში', 'სახელმწიფო / წმინდა შემოსავალი × 100', 'იგივე', TRUE, FALSE, NULL, 71),
('rev_insurance_pct', 'finance', 'დაზღვევის წილი', 'pct', 'none', 'კერძო დაზღვევის წილი წმინდა შემოსავალში', 'დაზღვევა / წმინდა შემოსავალი × 100', 'იგივე', TRUE, FALSE, NULL, 72),
('payments', 'finance', 'შემოსული გადახდები (კასა)', 'gel', 'up', 'პაციენტის გადახდები (ნაღდი, ბარათი, გადარიცხვა)', 'Σ payments.amount გადახდის დღით (განყოფილება — შემთხვევის)', 'payments', TRUE, FALSE, NULL, 73),
('costs_total', 'finance', 'ხარჯი', 'gel', 'down', 'პირდაპირი ხარჯი: ხარჯების ჟურნალი + მარაგის ხარჯი (საერთო ხარჯი არ ნაწილდება)', 'Σ expenses (გაუქმებულის გარეშე) + მარაგის ღირებულება (dept_consumption_basis)', 'expenses, stock_moves', TRUE, FALSE, NULL, 74),
('result', 'finance', 'შედეგი', 'gel', 'up', 'წმინდა შემოსავალს გამოკლებული პირდაპირი ხარჯი', 'rev_net − costs_total', 'იგივე', TRUE, FALSE, NULL, 75),
('margin_pct', 'finance', 'მარჟა', 'pct', 'up', 'შედეგის წილი შემოსავალში', 'შედეგი / წმინდა შემოსავალი × 100', 'იგივე', TRUE, FALSE, NULL, 76),
('denied_amount', 'finance', 'გადამხდელის უარი (ჩამოწერილი)', 'gel', 'down', 'ქლეიმის უარი, რომელიც ჩამოიწერა', 'Σ denied', 'fin_claim_items', TRUE, FALSE, NULL, 77);

-- ================================================================ 4. დღიური ფაქტები
-- ნაკადი: დღე × განყოფილება × ტიპი × ვიზიტის სახე
CREATE TABLE rpt_fact_flow (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    enc_type       VARCHAR(12) NOT NULL,
    visit_kind     VARCHAR(15) NOT NULL,
    encounters     INT NOT NULL DEFAULT 0,     -- გაუქმებულის გარეშე
    cancelled      INT NOT NULL DEFAULT 0,
    completed      INT NOT NULL DEFAULT 0,     -- status = discharged
    new_patients   INT NOT NULL DEFAULT 0,
    patients       INT NOT NULL DEFAULT 0      -- უნიკალური პაციენტები ამ დღეს (დღეებზე არ იკრიბება)
);
CREATE INDEX idx_rpt_flow ON rpt_fact_flow (day, department_id);

-- საწოლები: დღე × განყოფილება
CREATE TABLE rpt_fact_beds (
    day              DATE NOT NULL,
    department_id    UUID NOT NULL REFERENCES departments(id),
    available_hours  NUMERIC(14,4) NOT NULL DEFAULT 0,   -- აქტიური, არადაბლოკილი, არა-overflow საწოლ-საათები
    occupied_hours   NUMERIC(14,4) NOT NULL DEFAULT 0,   -- პაციენტი საწოლზე (overflow-ის ჩათვლით)
    midnight_census  INT NOT NULL DEFAULT 0,
    admissions       INT NOT NULL DEFAULT 0,
    discharges       INT NOT NULL DEFAULT 0,
    deaths           INT NOT NULL DEFAULT 0,
    los_days_sum     INT NOT NULL DEFAULT 0,             -- გაწერილების ხანგრძლივობა (დღე)
    transfers_in     INT NOT NULL DEFAULT 0,
    transfers_out    INT NOT NULL DEFAULT 0,
    readmissions_30  INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_beds ON rpt_fact_beds (day, department_id);

-- საოპერაციო: დღე × ქირურგიული განყოფილება
CREATE TABLE rpt_fact_or (
    day             DATE NOT NULL,
    department_id   UUID NOT NULL REFERENCES departments(id),
    scheduled       INT NOT NULL DEFAULT 0,      -- დაგეგმილი (scheduled_start დღით) — გაუქმების % მნიშვნელი (როგორც or/stats)
    done            INT NOT NULL DEFAULT 0,
    emergency       INT NOT NULL DEFAULT 0,
    cancelled       INT NOT NULL DEFAULT 0,
    cancelled_same_day INT NOT NULL DEFAULT 0,
    surgery_cases   INT NOT NULL DEFAULT 0,      -- incision + closure ჩაწერილია
    surgery_min     INT NOT NULL DEFAULT 0,
    first_cases     INT NOT NULL DEFAULT 0,
    first_on_time   INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_or ON rpt_fact_or (day, department_id);
-- ოთახის დატვირთვა: დღე × ოთახი (department_id — ბლოკი)
CREATE TABLE rpt_fact_or_room (
    day            DATE NOT NULL,
    room_id        UUID NOT NULL REFERENCES or_rooms(id),
    department_id  UUID NOT NULL REFERENCES departments(id),
    avail_min      INT NOT NULL DEFAULT 0,
    used_min       INT NOT NULL DEFAULT 0,
    cases          INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_or_room ON rpt_fact_or_room (day, department_id);

-- კვლევები / ლაბორატორია: დღე × განყოფილება (შემთხვევის) × სექცია
--   ordered / cancelled / external / ext_cost — დანიშვნის დღით; resulted / tat_* — ვალიდაციის დღით
--   tat_hist — წუთების ჰისტოგრამა (საზღვრები: 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10080, ∞)
CREATE TABLE rpt_fact_dx (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    section        VARCHAR(20) NOT NULL,
    ordered        INT NOT NULL DEFAULT 0,
    cancelled      INT NOT NULL DEFAULT 0,
    external       INT NOT NULL DEFAULT 0,
    ext_cost       NUMERIC(14,2) NOT NULL DEFAULT 0,
    resulted       INT NOT NULL DEFAULT 0,
    tat_sum_min    NUMERIC(14,1) NOT NULL DEFAULT 0,
    tat_hist       INT[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0}' CHECK (cardinality(tat_hist) = 12)
);
CREATE INDEX idx_rpt_dx ON rpt_fact_dx (day, department_id);

-- მარაგი: დღე × ლოკაცია
CREATE TABLE rpt_fact_stock (
    day            DATE NOT NULL,
    location_id    UUID NOT NULL REFERENCES stock_locations(id),
    department_id  UUID REFERENCES departments(id),
    consumption    NUMERIC(14,2) NOT NULL DEFAULT 0,
    loss           NUMERIC(14,2) NOT NULL DEFAULT 0,
    receipts       NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_stock ON rpt_fact_stock (day, department_id);

-- ფინანსები: დღე × განყოფილება (NULL — საერთო)
CREATE TABLE rpt_fact_finance (
    day               DATE NOT NULL,
    department_id     UUID REFERENCES departments(id),
    rev_patient       NUMERIC(14,2) NOT NULL DEFAULT 0,
    rev_insurance     NUMERIC(14,2) NOT NULL DEFAULT 0,
    rev_state         NUMERIC(14,2) NOT NULL DEFAULT 0,
    rev_other         NUMERIC(14,2) NOT NULL DEFAULT 0,
    rev_undetermined  NUMERIC(14,2) NOT NULL DEFAULT 0,
    rev_writeoff      NUMERIC(14,2) NOT NULL DEFAULT 0,
    rev_denied        NUMERIC(14,2) NOT NULL DEFAULT 0,
    stock_cost        NUMERIC(14,2) NOT NULL DEFAULT 0,
    expenses          NUMERIC(14,2) NOT NULL DEFAULT 0,
    payments          NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_finance ON rpt_fact_finance (day, department_id);

-- მარაგის მომენტალური სურათი: ლოკაცია × პოზიცია (ყოველი გადათვლისას მთლიანად იცვლება)
CREATE TABLE rpt_stock_snapshot (
    location_id      UUID NOT NULL REFERENCES stock_locations(id),
    item_id          UUID NOT NULL REFERENCES stock_items(id),
    department_id    UUID REFERENCES departments(id),
    qty              NUMERIC(14,3) NOT NULL,
    value            NUMERIC(14,2) NOT NULL,
    used_qty_window  NUMERIC(14,3) NOT NULL DEFAULT 0,     -- ხარჯი ბოლო stock_days_window დღეში
    avg_daily_use    NUMERIC(14,4) NOT NULL DEFAULT 0,
    days_of_supply   NUMERIC(10,1),                        -- NULL — ხარჯი არ ყოფილა
    expiring_value_90 NUMERIC(14,2) NOT NULL DEFAULT 0,
    expired_value    NUMERIC(14,2) NOT NULL DEFAULT 0,
    last_move_at     TIMESTAMPTZ,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (location_id, item_id)
);

-- ================================================================ 5. გადათვლის ჟურნალი
CREATE TABLE rpt_refresh_runs (
    id            BIGSERIAL PRIMARY KEY,
    kind          VARCHAR(8) NOT NULL CHECK (kind IN ('today', 'nightly', 'manual')),
    date_from     DATE NOT NULL,
    date_to       DATE NOT NULL,
    status        VARCHAR(8) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error', 'skipped')),
    facts         JSONB,                 -- ფაქტი → ხაზების რაოდენობა; frozen_days — დახურული თვის ფინანსები
    error         TEXT,
    requested_by  UUID REFERENCES users(id),
    source        VARCHAR(8) NOT NULL DEFAULT 'primary' CHECK (source IN ('primary', 'replica')),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at   TIMESTAMPTZ,
    duration_ms   INT,
    CONSTRAINT chk_rpt_run_range CHECK (date_from <= date_to)
);
CREATE INDEX idx_rpt_runs ON rpt_refresh_runs (started_at DESC);
CREATE INDEX idx_rpt_runs_kind ON rpt_refresh_runs (kind, status, started_at DESC);
