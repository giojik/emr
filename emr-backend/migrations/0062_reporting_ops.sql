-- 0062_reporting_ops.sql
-- მენეჯერული რეპორტინგი, ეტაპი 3 — ოპერაციული დაფები და ექიმის ჭრილი.
--
--  • rpt_fact_hourly — დღე × საათი × განყოფილება × ფენა (ვიზიტი / ჰოსპიტალიზაცია / ლაბ. ნიმუშის აღება) → სითბური რუკა „კვირის დღე × საათი“.
--  • rpt_fact_dx_dim — კვლევები განზომილებებით: აპარატი (რადიოლოგია / ენდოსკოპია), ანალიზატორი (ლაბ. — პირველი შედეგის აპარატი;
--      აპარატის გარეშე — „ხელით“), კატალოგის ჯგუფი, მოდალობა. დანიშვნა — დანიშვნის დღით; შესრულება + TAT — ვალიდაციის დღით (როგორც rpt_fact_dx).
--  • rpt_fact_doctor — ექიმის ჭრილი: ქირურგი (ოპერაციები), მკურნალი ექიმი (ჰოსპიტალიზაცია / გაწერა), ვალიდატორი (კვლევები).
--  • პარამეტრები: doctor_breakdown (off / all_only / scoped, ნაგულისხმევი all_only), min_cases (1–50, ნაგულისხმევი 5).

UPDATE system_modules
   SET settings = '{"doctor_breakdown": "all_only", "min_cases": 5}'::jsonb || settings
 WHERE code = 'reporting';

-- ================================================================ 1. საათობრივი ნაკადი
CREATE TABLE rpt_fact_hourly (
    day            DATE NOT NULL,
    hour           SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
    department_id  UUID REFERENCES departments(id),
    layer          VARCHAR(12) NOT NULL CHECK (layer IN ('visit', 'admission', 'lab_collect')),
    sub            VARCHAR(20) NOT NULL DEFAULT '',     -- ვიზიტი: outpatient / lab / emergency / inpatient
    n              INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_rpt_hourly ON rpt_fact_hourly (day, layer, department_id);

-- ================================================================ 2. კვლევები განზომილებებით
CREATE TABLE rpt_fact_dx_dim (
    day            DATE NOT NULL,
    department_id  UUID REFERENCES departments(id),
    section        VARCHAR(20) NOT NULL,
    device_key     VARCHAR(40) NOT NULL DEFAULT '',     -- აპარატის / ანალიზატორის id; 'manual' — ხელით (ლაბ.); '' — მიუთითებელი
    group_name     TEXT NOT NULL DEFAULT '',
    modality       VARCHAR(20) NOT NULL DEFAULT '',
    ordered        INT NOT NULL DEFAULT 0,
    cancelled      INT NOT NULL DEFAULT 0,
    external       INT NOT NULL DEFAULT 0,
    resulted       INT NOT NULL DEFAULT 0,
    tat_sum_min    NUMERIC(14,1) NOT NULL DEFAULT 0,
    tat_hist       INT[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0}' CHECK (cardinality(tat_hist) = 12)
);
CREATE INDEX idx_rpt_dx_dim ON rpt_fact_dx_dim (day, section, department_id);

-- ================================================================ 3. ექიმის ჭრილი
CREATE TABLE rpt_fact_doctor (
    day             DATE NOT NULL,
    department_id   UUID REFERENCES departments(id),
    doctor_id       UUID NOT NULL REFERENCES users(id),
    role            VARCHAR(10) NOT NULL CHECK (role IN ('surgeon', 'attending', 'validator')),
    -- ქირურგი
    or_scheduled    INT NOT NULL DEFAULT 0,
    or_done         INT NOT NULL DEFAULT 0,
    or_cancelled    INT NOT NULL DEFAULT 0,
    or_surgery_cases INT NOT NULL DEFAULT 0,
    or_surgery_min  INT NOT NULL DEFAULT 0,
    or_first_cases  INT NOT NULL DEFAULT 0,
    or_first_on_time INT NOT NULL DEFAULT 0,
    -- მკურნალი ექიმი
    admissions      INT NOT NULL DEFAULT 0,
    discharges      INT NOT NULL DEFAULT 0,
    deaths          INT NOT NULL DEFAULT 0,
    los_days_sum    INT NOT NULL DEFAULT 0,
    readmissions_30 INT NOT NULL DEFAULT 0,
    -- ვალიდატორი / რადიოლოგი
    dx_resulted     INT NOT NULL DEFAULT 0,
    dx_tat_sum_min  NUMERIC(14,1) NOT NULL DEFAULT 0,
    dx_tat_hist     INT[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0}' CHECK (cardinality(dx_tat_hist) = 12)
);
CREATE INDEX idx_rpt_doctor ON rpt_fact_doctor (day, role, department_id);
CREATE INDEX idx_rpt_doctor_doc ON rpt_fact_doctor (doctor_id, day);
