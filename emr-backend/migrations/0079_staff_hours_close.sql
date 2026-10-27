-- 0079_staff_hours_close.sql
-- ცვლები / მორიგეობა, ეტაპი 3 (ბლოკი D, მოდული 4): საათები / ტაბელი, ზეგანაკვეთური, თვის დახურვა, HR ექსპორტი, კავშირი სხვა მოდულებთან.
--
--  • ფაქტი (roster_entries.att_*): ნაგულისხმევად = გეგმა; შემდგენი ასწორებს გადახრას — რეალური დრო / საათები („ნამუშევარი“), „არ გამოცხადდა“;
--      „მორიგეობა სახლიდან“ — გამოძახებით ნამუშევარი საათები. ისტორია — roster_changes.kind = 'actual' (მიზეზით).
--  • ტაბელი: ნორმა (სამუშაო დღეები × week_norm_hours / 5 × FTE − არყოფნის სამუშაო დღეები), ზეგანაკვეთი (თვის ნორმაზე მეტი; overtime_basis),
--      ღამის (night_from–night_to) / დღესასწაულის / შაბათ-კვირის საათები — საათობრივი გადაფარვით, ჩასათვლელ საათებთან პროპორციულად.
--  • თვის დახურვა: შემდგენი — „წარდგენა“ (rosters.timesheet_submitted_*), HR — „დახურვა“ (status = closed) → snapshot (roster_timesheets);
--      HR — ხელახლა გახსნა (მიზეზით). ისტორია: submit / close / reopen.
--  • ზეგანაკვეთი → ნაცვლად დასვენება: დახურვისას HR-ის არჩევანით — COMP ბალანსში (absence_balance_entries.kind = 'comp', roster_id);
--      ხელახლა გახსნისას — საპირისპირო ჩანაწერი (ჟურნალი კვლავ მხოლოდ INSERT).
--  • კავშირები (RosterLookup): კონსულტაცია (link_consult), ბიომედ-ინჟინერი (link_bme), საოპერაციოს გუნდი (link_or), სტაციონარის / ICU დატვირთვა (nurse_ratio).

-- ================================================================ 0. პარამეტრები
UPDATE system_modules SET settings = '{"week_norm_hours": 40,
   "overtime_basis": "month",
   "overtime_default": "pay",
   "comp_absence_type": "COMP",
   "night_from": "22:00",
   "night_to": "06:00",
   "close_requires_submit": true,
   "link_consult": "hint",
   "link_bme": "hint",
   "link_or": "absence",
   "nurse_ratio": {"ward": 8, "intensive": 4, "icu": 2}}'::jsonb || settings,
  description = 'თანამშრომლები / პოზიციები, ცვლის შაბლონები, თვის განრიგი განყოფილებაზე (მონახაზი → გამოქვეყნება → დახურვა), მორიგეობა და „ვინ არის მორიგე“, წესები, შევსების ნორმა, როტაცია; შვებულება / არყოფნა და ბალანსი, დასაფარი ცვლები, გაცვლა / ჩანაცვლება, „არ შემიძლია“ დღეები; ფაქტი / ტაბელი, ზეგანაკვეთი, ღამის / დღესასწაულის საათები, თვის დახურვა, HR ექსპორტი; კავშირი კონსულტაციასთან / ბიომედთან / საოპერაციოსთან / სტაციონარის დატვირთვასთან; ანგარიშები — შემდეგი ეტაპი'
WHERE code = 'roster';

-- განრიგის ისტორია: + ფაქტი / ტაბელის წარდგენა / დახურვა / ხელახლა გახსნა
ALTER TABLE roster_changes DROP CONSTRAINT roster_changes_kind_check;
ALTER TABLE roster_changes ADD CONSTRAINT roster_changes_kind_check CHECK (kind IN ('created', 'add', 'change', 'remove', 'publish', 'copy', 'rotation', 'bulk',
    'swap', 'give', 'replace', 'absence', 'fill', 'actual', 'submit', 'close', 'reopen'));

-- ================================================================ 1. ფაქტი
ALTER TABLE roster_entries
    ADD COLUMN att_status    VARCHAR(8) NOT NULL DEFAULT 'plan' CHECK (att_status IN ('plan', 'worked', 'no_show')),   -- plan — ფაქტი = გეგმა
    ADD COLUMN actual_start  TIMESTAMPTZ,                         -- worked: რეალური დრო (არჩევითი — მხოლოდ საათებიც შეიძლება)
    ADD COLUMN actual_end    TIMESTAMPTZ,
    ADD COLUMN actual_hours  NUMERIC(5,2) CHECK (actual_hours >= 0 AND actual_hours <= 48),   -- worked: ჩასათვლელი ფაქტი
    ADD COLUMN actual_note   TEXT,
    ADD COLUMN actual_by     UUID REFERENCES users(id),
    ADD COLUMN actual_at     TIMESTAMPTZ,
    ADD CONSTRAINT chk_re_actual_pair CHECK ((actual_start IS NULL) = (actual_end IS NULL)),
    ADD CONSTRAINT chk_re_actual_time CHECK (actual_start IS NULL OR (actual_end > actual_start AND actual_end - actual_start <= interval '48 hours')),
    ADD CONSTRAINT chk_re_actual_status CHECK ((att_status = 'worked') = (actual_hours IS NOT NULL) AND (att_status = 'worked' OR actual_start IS NULL));

-- ================================================================ 2. ტაბელის წარდგენა / დახურვა
ALTER TABLE rosters
    ADD COLUMN timesheet_submitted_at  TIMESTAMPTZ,
    ADD COLUMN timesheet_submitted_by  UUID REFERENCES users(id),
    ADD COLUMN close_note              TEXT,
    ADD CONSTRAINT chk_roster_submitted CHECK ((timesheet_submitted_at IS NULL) = (timesheet_submitted_by IS NULL));

-- დახურვის snapshot (განრიგი × თანამშრომელი). home — ნორმა / ზეგანაკვეთი ითვლება აქ (ძირითადი განყოფილება, ყველა განრიგის საათებით)
CREATE TABLE roster_timesheets (
    roster_id        UUID NOT NULL REFERENCES rosters(id),
    staff_id         UUID NOT NULL REFERENCES staff_members(id),
    home             BOOLEAN NOT NULL,
    fte              NUMERIC(3,2) NOT NULL,
    shifts           SMALLINT NOT NULL DEFAULT 0,
    plan_hours       NUMERIC(6,2) NOT NULL DEFAULT 0,      -- ამ განრიგის
    worked_hours     NUMERIC(6,2) NOT NULL DEFAULT 0,      -- ამ განრიგის (ფაქტი)
    night_hours      NUMERIC(6,2) NOT NULL DEFAULT 0,
    holiday_hours    NUMERIC(6,2) NOT NULL DEFAULT 0,
    weekend_hours    NUMERIC(6,2) NOT NULL DEFAULT 0,
    no_show          SMALLINT NOT NULL DEFAULT 0,
    total_hours      NUMERIC(6,2),                         -- home: ყველა განრიგის ფაქტი
    credit_hours     NUMERIC(6,2),                         -- home: „ნამუშევრად ჩათვლილი“ არყოფნა
    norm_hours       NUMERIC(6,2),                         -- home
    overtime_hours   NUMERIC(6,2),                         -- home
    ot_pay_hours     NUMERIC(6,2),
    ot_comp_hours    NUMERIC(6,2),
    comp_days        NUMERIC(5,1),
    absence          JSONB NOT NULL DEFAULT '[]',          -- [{type_id, code, short, name, paid, counts_as_work, days, workdays}]
    days             JSONB NOT NULL DEFAULT '{}',          -- {"YYYY-MM-DD": "12" | "შ" | "გ"}
    person           JSONB NOT NULL DEFAULT '{}',          -- home: ყველა განრიგის ღამე / დღესასწაული / შაბ.–კვ. / გაცდენა
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (roster_id, staff_id)
);
CREATE INDEX idx_rts_staff ON roster_timesheets (staff_id);

-- ================================================================ 3. ზეგანაკვეთი → ნაცვლად დასვენება (COMP ბალანსი)
ALTER TABLE absence_balance_entries DROP CONSTRAINT absence_balance_entries_kind_check;
ALTER TABLE absence_balance_entries ADD CONSTRAINT absence_balance_entries_kind_check CHECK (kind IN ('accrual', 'adjust', 'carry', 'use', 'restore', 'comp'));
ALTER TABLE absence_balance_entries DROP CONSTRAINT chk_abe_sign;
ALTER TABLE absence_balance_entries ADD CONSTRAINT chk_abe_sign CHECK ((kind = 'use' AND days <= 0) OR (kind IN ('accrual', 'restore') AND days >= 0) OR kind IN ('adjust', 'carry', 'comp'));
ALTER TABLE absence_balance_entries ADD COLUMN roster_id UUID REFERENCES rosters(id);     -- comp: რომელი თვის დახურვიდან
ALTER TABLE absence_balance_entries ADD CONSTRAINT chk_abe_comp CHECK ((kind = 'comp') = (roster_id IS NOT NULL));
CREATE INDEX idx_abe_roster ON absence_balance_entries (roster_id) WHERE roster_id IS NOT NULL;

-- ================================================================ 4. უფლებები
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON roster_timesheets TO emr_app;
  END IF;
END $$;
