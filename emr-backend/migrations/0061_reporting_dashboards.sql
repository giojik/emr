-- 0061_reporting_dashboards.sql
-- მენეჯერული რეპორტინგი, ეტაპი 2 — თემატური დაფები: ხელმძღვანელობა და განყოფილება.
--
--  • ძირითადი KPI-ები (ზედა ზოლი) — თითო დაფაზე admin ირჩევს (მაქს. 8, რიგით) — rpt_dashboard_kpis.
--  • „ახლა“ პანელი — ცოცხალი, მსუბუქი დათვლები ოპერაციულ ბაზაზე (60 წმ ქეში, backend): საწოლები ახლა, დღევანდელი ნაკადი,
--    საოპერაციო დღეს, ვადაგადაცილებული ღია კვლევები.
--  • „ყურადღება“ პანელი — წითელი KPI-ები (თვე დღემდე), დაბალი მარაგი, ვადაგასასვლელი, მოძრაობის გარეშე მარაგი, ვადაგადაცილებული კვლევები.
--  • ახალი პარამეტრები (reporting): lab_overdue_min, dx_overdue_hours, dead_stock_days, tv_refresh_min.

-- ================================================================ 0. პარამეტრები (არსებულ მნიშვნელობებს ემატება)
UPDATE system_modules
   SET settings = '{"lab_overdue_min": 120, "dx_overdue_hours": 24, "dead_stock_days": 90, "tv_refresh_min": 5}'::jsonb || settings
 WHERE code = 'reporting';

-- ================================================================ 1. დაფების ძირითადი KPI-ები
CREATE TABLE rpt_dashboard_kpis (
    dashboard   VARCHAR(12) NOT NULL CHECK (dashboard IN ('executive', 'department')),
    kpi_code    VARCHAR(40) NOT NULL REFERENCES rpt_kpis(code) ON DELETE CASCADE,
    sort_order  INT NOT NULL CHECK (sort_order BETWEEN 1 AND 8),
    updated_by  UUID REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (dashboard, kpi_code),
    UNIQUE (dashboard, sort_order)
);

INSERT INTO rpt_dashboard_kpis (dashboard, kpi_code, sort_order) VALUES
('executive', 'enc_total', 1), ('executive', 'admissions', 2), ('executive', 'occupancy_pct', 3), ('executive', 'alos', 4),
('executive', 'or_cases', 5), ('executive', 'lab_tat_median_min', 6), ('executive', 'rev_net', 7), ('executive', 'margin_pct', 8),
('department', 'enc_total', 1), ('department', 'admissions', 2), ('department', 'discharges', 3), ('department', 'occupancy_pct', 4),
('department', 'alos', 5), ('department', 'mortality_pct', 6), ('department', 'stock_consumption', 7), ('department', 'rev_net', 8);

-- ================================================================ 2. ინდექსები „ახლა“ პანელისთვის (ღია კვლევები, დღევანდელი ოპერაციები)
CREATE INDEX IF NOT EXISTS idx_dx_items_open ON dx_order_items (section, status) WHERE status NOT IN ('validated', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_or_cases_sched_start ON or_cases (scheduled_start) WHERE scheduled_start IS NOT NULL;
