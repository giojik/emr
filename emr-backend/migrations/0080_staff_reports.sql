-- 0080_staff_reports.sql
-- ცვლები / მორიგეობა, ეტაპი 4 — D4-ის ბოლო (ბლოკი D, მოდული 4): ანგარიშები / KPI / მენეჯერული დაფა.
--
--  • თვიური (ადამიანი × თვე, ძირითადი განყოფილება): ნორმა / ფაქტი / ჩათვლილი / ზეგანაკვეთი (ანაზღ. / COMP), ნორმის შესრულება, არყოფნა / ბიულეტენი
--      სამუშაო დღეებით, ღამე / დღესასწაული / შაბ.–კვ. — დახურული თვე: snapshot (roster_timesheets), დაუხურავი: ცოცხალი გამოთვლა („წინასწარი“).
--  • დღიური (დღე × განრიგის განყოფილება): გეგმიური ცვლები / „არ გამოცხადდა“, შევსების ნორმის / მორიგის ხარვეზები (გეგმით / ფაქტით),
--      სამუშაო დროის წესების დარღვევები (ფაქტით), დასაფარი ცვლები (დაწყების დღით: დაფარვა დაწყებამდე / გვიან / დაუფარავი, დაფარვის დრო),
--      გაცვლები (შექმნის დღით: შედეგი, გადაწყვეტის დრო), დატვირთვა (სტაციონარი: პაციენტ-საათი / ექთან-საათი, ზღვარზე მეტი / ექთნის გარეშე საათები).
--  • მენეჯერული დაფა: rpt_fact_roster (დღე × განყოფილება), rpt_fact_roster_month (თვე × ძირითადი განყოფილება), KPI ჯგუფი roster (12),
--      „ყურადღება“, თვიური სექცია (dashboard_visibility / monthly_section). ახალი უფლება არ არის (45).

-- ================================================================ 0. პარამეტრები
UPDATE system_modules SET settings = '{"rpt_norm_low_pct": 90,
   "rpt_chronic_ot_months": 3,
   "rpt_open_urgent_hours": 24,
   "rpt_close_late_days": 5,
   "rpt_min_group": 3,
   "rpt_bradford": false,
   "rpt_sick_types": ["SICK"],
   "dashboard_visibility": "report_users",
   "monthly_section": true}'::jsonb || settings,
  description = 'თანამშრომლები / პოზიციები, ცვლის შაბლონები, თვის განრიგი განყოფილებაზე (მონახაზი → გამოქვეყნება → დახურვა), მორიგეობა და „ვინ არის მორიგე“, წესები, შევსების ნორმა, როტაცია; შვებულება / არყოფნა და ბალანსი, დასაფარი ცვლები, გაცვლა / ჩანაცვლება, „არ შემიძლია“ დღეები; ფაქტი / ტაბელი, ზეგანაკვეთი, ღამის / დღესასწაულის საათები, თვის დახურვა, HR ექსპორტი; კავშირი კონსულტაციასთან / ბიომედთან / საოპერაციოსთან / სტაციონარის დატვირთვასთან; ანგარიშები / KPI (ზეგანაკვეთი, ნორმა, გაცდენა / არყოფნა, დასაფარი, გაცვლები, ხარვეზები, წესები, დატვირთვა)'
WHERE code = 'roster';

-- ================================================================ 1. რეპორტინგის ფაქტები
-- დღე × განრიგის განყოფილება (დატვირთვა — სტაციონარის განყოფილება, რომელსაც თვის განრიგი აქვს)
CREATE TABLE rpt_fact_roster (
    day              DATE NOT NULL,
    department_id    UUID NOT NULL REFERENCES departments(id),
    shifts           INT NOT NULL DEFAULT 0,             -- გეგმიური ცვლები (გამოქვეყნებული / დახურული, დღემდე)
    no_show          INT NOT NULL DEFAULT 0,
    norm_gaps_plan   INT NOT NULL DEFAULT 0,             -- შევსების ნორმა: დაკლებული ადამიანი (need − have)
    norm_gaps_fact   INT NOT NULL DEFAULT 0,             -- იგივე, „არ გამოცხადდა“ — აკლია
    duty_gaps_plan   INT NOT NULL DEFAULT 0,             -- მორიგე (I დონე): დაკლებული
    duty_gaps_fact   INT NOT NULL DEFAULT 0,
    viol_rest        INT NOT NULL DEFAULT 0,             -- წესის დარღვევა (ფაქტით): დასვენება
    viol_continuous  INT NOT NULL DEFAULT 0,
    viol_week        INT NOT NULL DEFAULT 0,
    viol_nights      INT NOT NULL DEFAULT 0,
    open_n           INT NOT NULL DEFAULT 0,             -- დასაფარი ცვლა (დაწყების დღით), დაწყება დღემდე
    open_ontime      INT NOT NULL DEFAULT 0,             -- დაიფარა დაწყებამდე
    open_late        INT NOT NULL DEFAULT 0,             -- დაიფარა დაწყების შემდეგ
    open_unfilled    INT NOT NULL DEFAULT 0,             -- გაუქმდა / დაწყებისას ღიაა
    open_volunteer   INT NOT NULL DEFAULT 0,             -- დაფარულიდან — მოხალისე („ავიღებ“ → მინიჭება)
    open_fill_h      NUMERIC(14,4) NOT NULL DEFAULT 0,   -- Σ (დაფარვა − შექმნა)
    open_lead_h      NUMERIC(14,4) NOT NULL DEFAULT 0,   -- Σ (ცვლის დაწყება − შექმნა)
    swaps            INT NOT NULL DEFAULT 0,             -- გაცვლა / გადაცემა (შექმნის დღით)
    swaps_approved   INT NOT NULL DEFAULT 0,
    swaps_refused    INT NOT NULL DEFAULT 0,             -- ხელმძღვანელის უარი / კოლეგის უარი
    swaps_lapsed     INT NOT NULL DEFAULT 0,             -- ვადა გავიდა / გაუქმდა
    swaps_decided_h  NUMERIC(14,4) NOT NULL DEFAULT 0,   -- Σ (საბოლოო გადაწყვეტა − შექმნა), დადასტურებული / უარყოფილი
    pt_h             NUMERIC(14,4) NOT NULL DEFAULT 0,   -- პაციენტ-საათი
    nurse_h          NUMERIC(14,4) NOT NULL DEFAULT 0,   -- ექთან-საათი (ფაქტით)
    census_h         INT NOT NULL DEFAULT 0,             -- საათები, როცა პაციენტი იყო
    over_h           INT NOT NULL DEFAULT 0,             -- მათგან: პაციენტი / ექთანი > ზღვარი (ექთნის გარეშე — ჩათვლით)
    nonurse_h        INT NOT NULL DEFAULT 0,             -- მათგან: ექთანი არ იყო
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (day, department_id)
);

-- თვე × ძირითადი განყოფილება (ადამიანზე ერთხელ, ყველა განრიგით)
CREATE TABLE rpt_fact_roster_month (
    month            DATE NOT NULL CHECK (extract(day FROM month) = 1),
    department_id    UUID NOT NULL REFERENCES departments(id),
    staff            INT NOT NULL DEFAULT 0,
    closed_staff     INT NOT NULL DEFAULT 0,             -- მათგან დახურული ტაბელიდან (snapshot); დანარჩენი — წინასწარი
    norm_h           NUMERIC(14,2) NOT NULL DEFAULT 0,
    fact_h           NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_h         NUMERIC(14,2) NOT NULL DEFAULT 0,
    ot_h             NUMERIC(14,2) NOT NULL DEFAULT 0,
    ot_pay_h         NUMERIC(14,2) NOT NULL DEFAULT 0,   -- დახურული: HR-ის არჩევანით; წინასწარი — overtime_default-ით
    ot_comp_h        NUMERIC(14,2) NOT NULL DEFAULT 0,
    ot_staff         INT NOT NULL DEFAULT 0,             -- ზეგანაკვეთის მქონე
    under_staff      INT NOT NULL DEFAULT 0,             -- ნორმის შესრულება < rpt_norm_low_pct
    emp_wd           INT NOT NULL DEFAULT 0,             -- შრომითი ურთიერთობის სამუშაო დღეები
    abs_wd           INT NOT NULL DEFAULT 0,             -- არყოფნის სამუშაო დღეები („ნამუშევრად ითვლება“ — გარდა)
    sick_wd          INT NOT NULL DEFAULT 0,             -- მათგან ბიულეტენი (rpt_sick_types)
    night_h          NUMERIC(14,2) NOT NULL DEFAULT 0,
    holiday_h        NUMERIC(14,2) NOT NULL DEFAULT 0,
    weekend_h        NUMERIC(14,2) NOT NULL DEFAULT 0,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (month, department_id)
);

-- ანგარიშების ინდექსები
CREATE INDEX idx_os_starts ON roster_open_shifts (starts_at);
CREATE INDEX idx_sw_created ON roster_swaps (created_at);
CREATE INDEX idx_bed_assignments_period ON bed_assignments (department_id, started_at);

-- ================================================================ 2. KPI ცნობარი
ALTER TABLE rpt_kpis DROP CONSTRAINT IF EXISTS rpt_kpis_category_check;
ALTER TABLE rpt_kpis ADD CONSTRAINT rpt_kpis_category_check CHECK (category IN ('flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance', 'quality', 'ipc', 'bme', 'roster'));
INSERT INTO rpt_kpis (code, category, name, unit, direction, definition, formula, source, finance, snapshot, drill, sort_order) VALUES
 ('roster_overtime_h', 'roster', 'ზეგანაკვეთი, სთ', 'hours', 'down',
  'თვის ნორმაზე მეტი (ფაქტი ყველა განრიგით + „ნამუშევრად ჩათვლილი“ − ნორმა), ადამიანზე ერთხელ — ძირითად განყოფილებაში; თვე ითვლება, თუ მისი 1-ელი რიცხვი პერიოდშია; დაუხურავი თვე — წინასწარი',
  'Σ max(0, ფაქტი + ჩათვლილი − ნორმა)', 'roster_timesheets / roster_entries → rpt_fact_roster_month', FALSE, FALSE, NULL, 140),
 ('roster_overtime_pct', 'roster', 'ზეგანაკვეთი ნორმასთან, %', 'pct', 'down',
  'ზეგანაკვეთის საათები / ნორმის საათები (იგივე თვეები)', 'ზეგანაკვეთი / ნორმა × 100', 'rpt_fact_roster_month', FALSE, FALSE, NULL, 141),
 ('roster_norm_fulfil_pct', 'roster', 'ნორმის შესრულება, %', 'pct', 'none',
  '(ფაქტი ყველა განრიგით + „ნამუშევრად ჩათვლილი“) / ნორმა; ნორმა = სამუშაო დღეები × week_norm_hours / 5 × FTE − არყოფნის სამუშაო დღეები',
  '(ფაქტი + ჩათვლილი) / ნორმა × 100', 'rpt_fact_roster_month', FALSE, FALSE, NULL, 142),
 ('roster_no_show_pct', 'roster', '„არ გამოცხადდა“, %', 'pct', 'down',
  'გამოქვეყნებული / დახურული განრიგის ცვლები დღემდე; „არ გამოცხადდა“ — ფაქტის შესწორებით', '„არ გამოცხადდა“ / გეგმიური ცვლები × 100', 'roster_entries → rpt_fact_roster', FALSE, FALSE, NULL, 143),
 ('roster_absence_pct', 'roster', 'არყოფნის მაჩვენებელი, %', 'pct', 'down',
  'დადასტურებული არყოფნის სამუშაო დღეები (ორშ.–პარ., დღესასწაულის გარეშე; „ნამუშევრად ითვლება“ ტიპები — არა) / შრომითი ურთიერთობის სამუშაო დღეები',
  'არყოფნის სამუშაო დღე / სამუშაო დღე × 100', 'absence_requests → rpt_fact_roster_month', FALSE, FALSE, NULL, 144),
 ('roster_sick_pct', 'roster', 'ბიულეტენი, %', 'pct', 'down',
  'ბიულეტენის ტიპის (rpt_sick_types) არყოფნის სამუშაო დღეები / სამუშაო დღეები', 'ბიულეტენის სამუშაო დღე / სამუშაო დღე × 100', 'absence_requests → rpt_fact_roster_month', FALSE, FALSE, NULL, 145),
 ('roster_open_filled_pct', 'roster', 'დასაფარი ცვლა დაფარულია დაწყებამდე, %', 'pct', 'up',
  'დასაფარი ცვლები დაწყების დღით, დაწყება გასულია; დაუფარავი = გაუქმებული ან დაწყებისას ღია', 'დაფარული დაწყებამდე / დასაფარი × 100', 'roster_open_shifts → rpt_fact_roster', FALSE, FALSE, NULL, 146),
 ('roster_open_fill_h', 'roster', 'დასაფარის დაფარვამდე დრო, სთ', 'hours', 'down',
  'დაფარული დასაფარი ცვლები (დაწყების დღით): შექმნიდან დაფარვამდე, საშუალო', 'Σ (დაფარვა − შექმნა) / დაფარული', 'roster_open_shifts → rpt_fact_roster', FALSE, FALSE, NULL, 147),
 ('roster_norm_gaps', 'roster', 'შევსების ნორმის ხარვეზი (ფაქტით)', 'count', 'down',
  'განყოფილება × დღე × ცვლა × კატეგორია: მინ. რაოდენობას დაკლებული ადამიანი; „არ გამოცხადდა“ — აკლია; ნორმა — მიმდინარე (ვერსიონირებული არ არის)',
  'Σ max(0, საჭირო − ფაქტი)', 'staffing_norms, roster_entries → rpt_fact_roster', FALSE, FALSE, NULL, 148),
 ('roster_duty_gaps', 'roster', 'მორიგის ხარვეზი (ფაქტით)', 'count', 'down',
  'მორიგის როლი (I დონე) × დღე: საჭირო რაოდენობას დაკლებული; „არ გამოცხადდა“ — აკლია', 'Σ max(0, საჭირო − ფაქტი)', 'duty_roles, roster_entries → rpt_fact_roster', FALSE, FALSE, NULL, 149),
 ('roster_nurse_ratio', 'roster', 'პაციენტი ერთ ექთანზე (სტაციონარი)', 'ratio', 'down',
  'საათობრივად: პაციენტი (საწოლზე მიმაგრება) / ექთანი ცვლაში (ფაქტით, „მორიგეობა სახლიდან“ გარდა); მხოლოდ განყოფილებები თვის განრიგით',
  'პაციენტ-საათი / ექთან-საათი', 'bed_assignments, roster_entries → rpt_fact_roster', FALSE, FALSE, NULL, 150),
 ('roster_load_over_pct', 'roster', 'დატვირთვა ზღვარზე მეტი, % საათების', 'pct', 'down',
  'საათები პაციენტით, როცა პაციენტი / ექთანი > nurse_ratio ზღვარი (care_level) ან ექთანი არ იყო', 'ზღვარზე მეტი საათი / საათი პაციენტით × 100', 'bed_assignments, roster_entries → rpt_fact_roster', FALSE, FALSE, NULL, 151);

-- ================================================================ 3. უფლებები ბაზაში — ფაქტი იცვლება მხოლოდ გადათვლით (DELETE → INSERT)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    GRANT SELECT, INSERT, DELETE ON rpt_fact_roster, rpt_fact_roster_month TO emr_app;
  END IF;
END $$;
