-- 0066_quality_reports.sql
-- ხარისხი და ინციდენტები, ეტაპი 3 — ანგარიშები, ინდიკატორები, მენეჯერული დაფის KPI-ები, „ყურადღება“, თვიური ანგარიშის სექცია.
--
--  • მომსახურების ტიპი (qm_incidents.service_type): სტაციონარი / ამბულატორია / გადაუდებელი / საოპერაციო / დიაგნოსტიკა / ლაბორატორია / არაკლინიკური.
--      ავტომატურად წყაროდან (qm_service_type) — შეტყობინებისას და ავტორის რედაქტირებისას; ხარისხის მენეჯერი ასწორებს ტრიაჟზე / შესწორებისას.
--  • ინდიკატორები (qm_indicators): მრიცხველი (კატეგორიები — ძირეული მოიცავს ქვეკატეგორიებს, ტიპები, მინ. ზიანი, მხოლოდ პაციენტი,
--      მომსახურების ტიპები) / მნიშვნელი (საწოლ-დღე / ჰოსპიტალიზაცია / ვიზიტი) × მამრავლი (1000 / 100). ყოველ ინდიკატორს — KPI qm_ind_<code>.
--  • rpt_fact_quality — დღე × განყოფილება × კატეგორია × ტიპი × ზიანი × მომსახურების ტიპი × ვის შეეხო × სენტინელური: რაოდენობა, ანონიმური,
--      ტრიაჟი (ვადაში, ჰისტოგრამა წუთებში — TAT_EDGES). მხოლოდ მიღებული ინციდენტები (investigation … closed). ყოველ გადათვლაზე — მთლიანად
--      (კლასიფიკაციის შესწორება ძველ ინციდენტზეც აისახება). rpt_quality_snapshot — ღია / ვადაგადაცილებული CAPA, ტრიაჟი / ანალიზი ვადაგადაცილებით.
--  • KPI ცნობარი: ახალი ჯგუფი quality (11 KPI); ჩაღრმავება — არა (დაფაზე მხოლოდ აგრეგატები).
--  • პარამეტრები: report_date_basis (occurred / reported), view_min_cell (0 — გამორთული), dashboard_visibility (report_users / quality_only), monthly_section.

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"report_date_basis": "occurred",
                    "view_min_cell": 0,
                    "dashboard_visibility": "report_users",
                    "monthly_section": true}'::jsonb || settings
 WHERE code = 'quality';

-- ================================================================ 1. მომსახურების ტიპი
ALTER TABLE qm_incidents ADD COLUMN service_type VARCHAR(12)
    CHECK (service_type IN ('inpatient', 'outpatient', 'emergency', 'or', 'diagnostic', 'lab', 'non_clinical'));

/** წყაროდან / ვიზიტიდან / განყოფილებიდან (fallback) */
CREATE OR REPLACE FUNCTION qm_service_type(p_source_type TEXT, p_source_id UUID, p_encounter_id UUID, p_patient_id UUID, p_affected TEXT, p_department_id UUID)
RETURNS VARCHAR LANGUAGE plpgsql STABLE AS $$
DECLARE v TEXT; k TEXT;
BEGIN
  IF p_source_type IN ('stay', 'mar_entry', 'med_order') THEN RETURN 'inpatient'; END IF;
  IF p_source_type = 'or_case' THEN RETURN 'or'; END IF;
  IF p_source_type = 'lab_specimen' THEN RETURN 'lab'; END IF;
  IF p_source_type = 'dx_order_item' THEN
    SELECT section INTO v FROM dx_order_items WHERE id = p_source_id;
    RETURN CASE WHEN v = 'lab' THEN 'lab' ELSE 'diagnostic' END;
  END IF;
  IF p_encounter_id IS NOT NULL THEN
    SELECT e.type::text, e.visit_kind INTO v, k FROM encounters e WHERE e.id = p_encounter_id;
    IF v = 'inpatient' THEN RETURN 'inpatient'; END IF;
    IF v = 'emergency' THEN RETURN 'emergency'; END IF;
    IF v = 'outpatient' THEN RETURN CASE WHEN k = 'lab' THEN 'lab' ELSE 'outpatient' END; END IF;
  END IF;
  IF p_patient_id IS NULL AND coalesce(p_affected, '') <> 'patient' THEN RETURN 'non_clinical'; END IF;
  SELECT type INTO v FROM departments WHERE id = p_department_id;
  RETURN CASE v WHEN 'inpatient' THEN 'inpatient' WHEN 'outpatient' THEN 'outpatient' WHEN 'diagnostic' THEN 'diagnostic' WHEN 'or' THEN 'or' ELSE 'non_clinical' END;
END $$;

UPDATE qm_incidents SET service_type = qm_service_type(source_type, source_id, encounter_id, patient_id, affected, department_id);
ALTER TABLE qm_incidents ALTER COLUMN service_type SET NOT NULL;
CREATE INDEX idx_qm_incidents_report ON qm_incidents (occurred_at) WHERE status IN ('investigation', 'analysis', 'capa', 'closed');

-- ================================================================ 2. ინდიკატორები
CREATE TABLE qm_indicators (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code           VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,29}$'),
    name           TEXT NOT NULL CHECK (length(btrim(name)) >= 3),
    description    TEXT,
    category_ids   UUID[] NOT NULL CHECK (cardinality(category_ids) BETWEEN 1 AND 50),           -- qm_classifiers (category); ძირეული — ქვეკატეგორიებითაც
    event_types    VARCHAR(10)[] NOT NULL DEFAULT '{harm,no_harm}'
                   CHECK (cardinality(event_types) >= 1 AND event_types <@ ARRAY['harm', 'no_harm', 'near_miss', 'hazard']::varchar[]),
    min_harm       VARCHAR(10) CHECK (min_harm IN ('mild', 'moderate', 'severe', 'death')),
    patient_only   BOOLEAN NOT NULL DEFAULT TRUE,
    service_types  VARCHAR(12)[] NOT NULL DEFAULT '{inpatient}'                                      -- ცარიელი — ყველა
                   CHECK (service_types <@ ARRAY['inpatient', 'outpatient', 'emergency', 'or', 'diagnostic', 'lab', 'non_clinical']::varchar[]),
    denominator    VARCHAR(12) NOT NULL DEFAULT 'bed_days' CHECK (denominator IN ('bed_days', 'admissions', 'visits')),
    per            INT NOT NULL DEFAULT 1000 CHECK (per IN (100, 1000, 10000)),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INT NOT NULL DEFAULT 100,
    updated_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_qm_indicators_updated BEFORE UPDATE ON qm_indicators FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO qm_indicators (code, name, description, category_ids, sort_order)
SELECT v.code, v.name, v.descr, ARRAY[c.id], v.ord
  FROM (VALUES ('falls',          'დაცემა 1000 საწოლ-დღეზე',                    'პაციენტის დაცემა სტაციონარში (ზიანით / ზიანის გარეშე; near-miss არ ითვლება)', 'fall',           10),
               ('medication',     'მედიკამენტური შეცდომა 1000 საწოლ-დღეზე',     'მედიკამენტური ინციდენტი სტაციონარში (ზიანით / ზიანის გარეშე)',             'medication',     20),
               ('pressure_ulcer', 'ნაწოლი 1000 საწოლ-დღეზე',                    'სტაციონარში გაჩენილი ნაწოლი',                                              'pressure_ulcer', 30)) AS v(code, name, descr, cat, ord)
  JOIN qm_classifiers c ON c.kind = 'category' AND c.code = v.cat AND c.parent_id IS NULL;

-- ================================================================ 3. აგრეგაცია
CREATE TABLE rpt_fact_quality (
    day             DATE NOT NULL,
    department_id   UUID NOT NULL REFERENCES departments(id),
    category_id     UUID NOT NULL REFERENCES qm_classifiers(id),
    event_type      VARCHAR(10) NOT NULL,
    harm            VARCHAR(10) NOT NULL,
    service_type    VARCHAR(12) NOT NULL,
    affected        VARCHAR(10) NOT NULL,
    is_sentinel     BOOLEAN NOT NULL,
    n               INT NOT NULL DEFAULT 0,
    anonymous       INT NOT NULL DEFAULT 0,
    triaged         INT NOT NULL DEFAULT 0,
    triage_on_time  INT NOT NULL DEFAULT 0,
    triage_hist     INT[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0}' CHECK (cardinality(triage_hist) = 12)   -- წუთები, TAT_EDGES
);
CREATE INDEX idx_rpt_fact_quality ON rpt_fact_quality (day, department_id);

CREATE TABLE rpt_quality_snapshot (
    department_id     UUID REFERENCES departments(id),      -- NULL — განყოფილების გარეშე CAPA
    open_capa         INT NOT NULL DEFAULT 0,
    overdue_capa      INT NOT NULL DEFAULT 0,
    triage_overdue    INT NOT NULL DEFAULT 0,
    analysis_overdue  INT NOT NULL DEFAULT 0,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ================================================================ 4. KPI ცნობარი — ჯგუფი „ხარისხი“
ALTER TABLE rpt_kpis DROP CONSTRAINT IF EXISTS rpt_kpis_category_check;
ALTER TABLE rpt_kpis ADD CONSTRAINT rpt_kpis_category_check CHECK (category IN ('flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance', 'quality'));

INSERT INTO rpt_kpis (code, category, name, unit, direction, definition, formula, source, finance, snapshot, drill, sort_order) VALUES
('qm_reported',         'quality', 'ინციდენტები (მიღებული)',            'count', 'none', 'ხარისხის მენეჯერის მიერ მიღებული შეტყობინებები ყველა ტიპით (ზიანით / ზიანის გარეშე / near-miss / სახიფათო); უარყოფილი და დუბლიკატი არ ითვლება',
  'status ∈ investigation / analysis / capa / closed; დღე — მოვლენის (ან შეტყობინების) თარიღი, report_date_basis', 'qm_incidents → rpt_fact_quality', FALSE, FALSE, NULL, 80),
('qm_harm',             'quality', 'ინციდენტი ზიანით',                  'count', 'down', 'მიღებული ინციდენტები, რომლებმაც ზიანი გამოიწვია (საბოლოო კლასიფიკაციით)',
  'event_type = harm', 'qm_incidents → rpt_fact_quality', FALSE, FALSE, NULL, 81),
('qm_sentinel',         'quality', 'სენტინელური მოვლენა',               'count', 'down', 'სენტინელური (განსაკუთრებით მძიმე) მოვლენები',
  'is_sentinel = true', 'qm_incidents → rpt_fact_quality', FALSE, FALSE, NULL, 82),
('qm_near_miss_ratio',  'quality', 'near-miss თანაფარდობა',             'ratio', 'up',   'რამდენი near-miss მოდის ერთ ინციდენტზე (ზიანით ან ზიანის გარეშე). მაღალი — შეტყობინების კარგი კულტურის ნიშანი',
  'near_miss / (harm + no_harm)', 'qm_incidents → rpt_fact_quality', FALSE, FALSE, NULL, 83),
('qm_report_rate',      'quality', 'შეტყობინება 1000 საწოლ-დღეზე',      'ratio', 'up',   'სტაციონარის მიღებული შეტყობინებები (ყველა ტიპი) 1000 დაკავებულ საწოლ-დღეზე — უსაფრთხოების კულტურის მაჩვენებელი',
  'service_type = inpatient / საწოლ-დღე × 1000 (საწოლ-დღე — occupancy_basis-ის წესით)', 'rpt_fact_quality, rpt_fact_beds', FALSE, FALSE, NULL, 84),
('qm_ind_falls',        'quality', 'დაცემა 1000 საწოლ-დღეზე',           'ratio', 'down', 'პაციენტის დაცემა სტაციონარში 1000 დაკავებულ საწოლ-დღეზე (ინდიკატორი „falls“ — ხარისხი → ცნობარები → ინდიკატორები)',
  'ინდიკატორის მრიცხველი / საწოლ-დღე × 1000', 'rpt_fact_quality, rpt_fact_beds', FALSE, FALSE, NULL, 85),
('qm_ind_medication',   'quality', 'მედიკამენტური შეცდომა 1000 საწოლ-დღეზე', 'ratio', 'down', 'მედიკამენტური ინციდენტები სტაციონარში 1000 დაკავებულ საწოლ-დღეზე (ინდიკატორი „medication“)',
  'ინდიკატორის მრიცხველი / საწოლ-დღე × 1000', 'rpt_fact_quality, rpt_fact_beds', FALSE, FALSE, NULL, 86),
('qm_ind_pressure_ulcer','quality', 'ნაწოლი 1000 საწოლ-დღეზე',          'ratio', 'down', 'სტაციონარში გაჩენილი ნაწოლი 1000 დაკავებულ საწოლ-დღეზე (ინდიკატორი „pressure_ulcer“)',
  'ინდიკატორის მრიცხველი / საწოლ-დღე × 1000', 'rpt_fact_quality, rpt_fact_beds', FALSE, FALSE, NULL, 87),
('qm_triage_median_h',  'quality', 'დრო ტრიაჟამდე (მედიანა)',           'hours', 'down', 'შეტყობინებიდან ხარისხის მენეჯერის გადაწყვეტილებამდე (მიღებული ინციდენტები); ≈ — ჰისტოგრამიდან',
  'მედიანა(triaged_at − reported_at)', 'qm_incidents → rpt_fact_quality', FALSE, FALSE, NULL, 88),
('qm_triage_on_time',   'quality', 'ტრიაჟი ვადაში',                     'pct',   'up',   'ტრიაჟის ვადაში (triage_hours / სენტინელურზე sentinel_triage_hours) განხილული შეტყობინებების წილი',
  'triaged_at ≤ triage_due_at / ტრიაჟგავლილი × 100', 'qm_incidents → rpt_fact_quality', FALSE, FALSE, NULL, 89),
('qm_capa_overdue',     'quality', 'ვადაგადაცილებული CAPA',             'count', 'down', 'ღია / შესრულებაში მყოფი მაკორექტირებელი ქმედებები, რომელთა ვადა გავიდა (მომენტალური)',
  'status ∈ open / in_progress AND due_date < დღეს; განყოფილება — CAPA-ს ან პირველი ინციდენტის', 'qm_capas → rpt_quality_snapshot', FALSE, TRUE, NULL, 90);
