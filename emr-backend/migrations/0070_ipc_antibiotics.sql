-- 0070_ipc_antibiotics.sql
-- ინფექციის კონტროლი, ეტაპი 4 — ანტიბიოტიკების მართვა (antimicrobial stewardship) (ბლოკი D, მოდული 2).
--
--  • DDD (WHO ATC/DDD) და AWaRe (WHO 2023) — ჯენერიკზე (med_generics); საცნობარო ცხრილი ipc_abx_reference (~38 ხშირი ანტიმიკრობული,
--      რედაქტირებადი) — ავტომატური შევსება ATC-ით (ცარიელ ველებზე); ფარმაცევტი ავსებს / ასწორებს.
--  • ანტიმიკრობული = ATC პრეფიქსით (abx_atc_prefixes, ნაგულისხმევად J01). დანიშვნისას — ჩვენება (ემპირიული / მიზნობრივი / პროფილაქტიკა) + დიაგნოზი.
--  • შეზღუდული ანტიბიოტიკი = „სარეზერვო“ დროშა (0030) ან AWaRe Reserve (abx_restrict_reserve); რეჟიმი abx_restrict_mode:
--      approve (როგორც 0042 — დამტკიცებამდე მხოლოდ პირველი დოზა) / notify (დამტკიცება საჭიროა, MAR არ იბლოკება) / off; ამტკიცებს — abx_approver.
--  • „Time-out“: abx_timeout_hours (72) დაწყებიდან → ექიმს შეხსენება; გადახედვა: გაგრძელება / დე-ესკალაცია / IV → per os / შეწყვეტა.
--  • მოხმარება — MAR-იდან (მიცემული დოზები): DDD / 100 პაციენტ-დღე, DOT / 1000 პაციენტ-დღე (პაციენტ-დღე — rpt_fact_ipc_daily, 0068), AWaRe წილი.

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"abx_atc_prefixes": ["J01"],
                    "abx_indication_required": true,
                    "abx_restrict_mode": "approve",
                    "abx_restrict_reserve": true,
                    "abx_approver": "any",
                    "abx_timeout_hours": 72,
                    "aware_access_target": 60}'::jsonb || settings
 WHERE code = 'ipc';

-- ================================================================ 1. საცნობარო ცხრილი (WHO ATC/DDD 2024, AWaRe 2023)
CREATE TABLE ipc_abx_reference (
    atc_code          VARCHAR(7) PRIMARY KEY CHECK (atc_code ~ '^[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}$'),
    name              TEXT NOT NULL,
    ddd_oral          NUMERIC(12,4) CHECK (ddd_oral > 0),
    ddd_parenteral    NUMERIC(12,4) CHECK (ddd_parenteral > 0),
    ddd_unit          VARCHAR(4) NOT NULL DEFAULT 'g' CHECK (ddd_unit IN ('g', 'mg', 'MU')),
    aware_oral        VARCHAR(16) CHECK (aware_oral IN ('access', 'watch', 'reserve', 'not_recommended')),
    aware_parenteral  VARCHAR(16) CHECK (aware_parenteral IN ('access', 'watch', 'reserve', 'not_recommended')),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (ddd_oral IS NOT NULL OR ddd_parenteral IS NOT NULL)
);
CREATE TRIGGER trg_ipc_abx_reference_updated BEFORE UPDATE ON ipc_abx_reference FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO ipc_abx_reference (atc_code, name, ddd_oral, ddd_parenteral, ddd_unit, aware_oral, aware_parenteral) VALUES
  ('J01CA04', 'ამოქსიცილინი',                    1.5,  3,    'g',  'access',  'access'),
  ('J01CA01', 'ამპიცილინი',                      2,    6,    'g',  'access',  'access'),
  ('J01CE01', 'ბენზილპენიცილინი',                NULL, 3.6,  'g',  NULL,      'access'),
  ('J01CF02', 'კლოქსაცილინი',                    2,    2,    'g',  'access',  'access'),
  ('J01CR02', 'ამოქსიცილინი + კლავულანის მჟავა', 1.5,  3,    'g',  'access',  'access'),
  ('J01CR01', 'ამპიცილინი + სულბაქტამი',          NULL, 6,    'g',  NULL,      'access'),
  ('J01CR05', 'პიპერაცილინი + ტაზობაქტამი',      NULL, 14,   'g',  NULL,      'watch'),
  ('J01DB01', 'ცეფალექსინი',                     2,    NULL, 'g',  'access',  NULL),
  ('J01DB04', 'ცეფაზოლინი',                      NULL, 3,    'g',  NULL,      'access'),
  ('J01DC02', 'ცეფუროქსიმი',                     0.5,  3,    'g',  'watch',   'watch'),
  ('J01DD01', 'ცეფოტაქსიმი',                     NULL, 4,    'g',  NULL,      'watch'),
  ('J01DD02', 'ცეფტაზიდიმი',                     NULL, 4,    'g',  NULL,      'watch'),
  ('J01DD04', 'ცეფტრიაქსონი',                    NULL, 2,    'g',  NULL,      'watch'),
  ('J01DE01', 'ცეფეპიმი',                        NULL, 4,    'g',  NULL,      'watch'),
  ('J01DD52', 'ცეფტაზიდიმი + ავიბაქტამი',        NULL, 6,    'g',  NULL,      'reserve'),
  ('J01DH02', 'მეროპენემი',                      NULL, 3,    'g',  NULL,      'watch'),
  ('J01DH51', 'იმიპენემი + ცილასტატინი',          NULL, 2,    'g',  NULL,      'watch'),
  ('J01DH03', 'ერტაპენემი',                      NULL, 1,    'g',  NULL,      'watch'),
  ('J01MA01', 'ოფლოქსაცინი',                     0.4,  0.4,  'g',  'watch',   'watch'),
  ('J01MA02', 'ციპროფლოქსაცინი',                 1,    0.8,  'g',  'watch',   'watch'),
  ('J01MA12', 'ლევოფლოქსაცინი',                  0.5,  0.5,  'g',  'watch',   'watch'),
  ('J01MA14', 'მოქსიფლოქსაცინი',                 0.4,  0.4,  'g',  'watch',   'watch'),
  ('J01FA10', 'აზითრომიცინი',                    0.3,  0.5,  'g',  'watch',   'watch'),
  ('J01FA09', 'კლარითრომიცინი',                  0.5,  1,    'g',  'watch',   'watch'),
  ('J01FF01', 'კლინდამიცინი',                    1.2,  1.8,  'g',  'access',  'access'),
  ('J01XA01', 'ვანკომიცინი',                     2,    2,    'g',  'watch',   'watch'),
  ('J01XA02', 'ტეიკოპლანინი',                    NULL, 0.4,  'g',  NULL,      'watch'),
  ('J01XX08', 'ლინეზოლიდი',                      1.2,  1.2,  'g',  'reserve', 'reserve'),
  ('J01XX09', 'დაპტომიცინი',                     NULL, 0.28, 'g',  NULL,      'reserve'),
  ('J01GB03', 'გენტამიცინი',                     NULL, 0.24, 'g',  NULL,      'access'),
  ('J01GB06', 'ამიკაცინი',                       NULL, 1,    'g',  NULL,      'access'),
  ('J01AA02', 'დოქსიციკლინი',                    0.1,  0.1,  'g',  'access',  'access'),
  ('J01AA12', 'ტიგეციკლინი',                     NULL, 0.1,  'g',  NULL,      'reserve'),
  ('J01XD01', 'მეტრონიდაზოლი (IV)',              NULL, 1.5,  'g',  NULL,      'access'),
  ('P01AB01', 'მეტრონიდაზოლი (per os)',          2,    NULL, 'g',  'access',  NULL),
  ('J01XE01', 'ნიტროფურანტოინი',                 0.2,  NULL, 'g',  'access',  NULL),
  ('J01XX01', 'ფოსფომიცინი',                     3,    8,    'g',  'watch',   'reserve'),
  ('J01XB01', 'კოლისტინი',                       NULL, 9,    'MU', NULL,      'reserve');

-- ================================================================ 2. ჯენერიკი: DDD + AWaRe
ALTER TABLE med_generics
    ADD COLUMN ddd_oral        NUMERIC(12,4) CHECK (ddd_oral > 0),
    ADD COLUMN ddd_parenteral  NUMERIC(12,4) CHECK (ddd_parenteral > 0),
    ADD COLUMN ddd_unit        VARCHAR(4) CHECK (ddd_unit IN ('g', 'mg', 'MU')),
    ADD COLUMN aware           VARCHAR(16) CHECK (aware IN ('access', 'watch', 'reserve', 'not_recommended')),
    ADD CONSTRAINT chk_generic_ddd_unit CHECK ((ddd_oral IS NULL AND ddd_parenteral IS NULL) OR ddd_unit IS NOT NULL);
UPDATE med_generics g
   SET ddd_oral = r.ddd_oral, ddd_parenteral = r.ddd_parenteral, ddd_unit = r.ddd_unit,
       aware = CASE WHEN g.form_code IN ('INJ_SOL', 'INJ_PWD', 'INF_SOL', 'INF_CONC') THEN coalesce(r.aware_parenteral, r.aware_oral)
                    ELSE coalesce(r.aware_oral, r.aware_parenteral) END
  FROM ipc_abx_reference r
 WHERE r.atc_code = g.atc_code AND g.ddd_oral IS NULL AND g.ddd_parenteral IS NULL AND g.aware IS NULL;

-- ================================================================ 3. დანიშნულება: ჩვენება, time-out
ALTER TABLE med_orders
    ADD COLUMN abx_indication       VARCHAR(12) CHECK (abx_indication IN ('empiric', 'targeted', 'prophylaxis')),
    ADD COLUMN abx_icd10            VARCHAR(10) REFERENCES icd10_codes(code),
    ADD COLUMN abx_review_due       TIMESTAMPTZ,                                          -- time-out (დაწყება + abx_timeout_hours)
    ADD COLUMN abx_timeout_notified_at TIMESTAMPTZ,
    ADD COLUMN abx_reviewed_at      TIMESTAMPTZ,
    ADD COLUMN abx_reviewed_by      UUID REFERENCES users(id),
    ADD COLUMN abx_review_decision  VARCHAR(12) CHECK (abx_review_decision IN ('continue', 'deescalate', 'iv_to_po', 'stop')),
    ADD COLUMN abx_review_note      TEXT,
    ADD CONSTRAINT chk_mo_abx_review CHECK ((abx_reviewed_at IS NULL) = (abx_review_decision IS NULL) AND (abx_reviewed_at IS NULL) = (abx_reviewed_by IS NULL));
-- ჩვენება / დიაგნოზი — დანიშნულების შინაარსია (შეცვლა = ახალი დანიშნულება)
CREATE OR REPLACE FUNCTION med_orders_abx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.abx_indication, NEW.abx_icd10) IS DISTINCT FROM (OLD.abx_indication, OLD.abx_icd10) THEN
        RAISE EXCEPTION 'დანიშნულება არ რედაქტირდება — შეცვლა: შეწყვეტა + ახალი დანიშნულება' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_med_orders_abx_guard BEFORE UPDATE OF abx_indication, abx_icd10 ON med_orders FOR EACH ROW EXECUTE FUNCTION med_orders_abx_guard();
CREATE INDEX idx_med_orders_abx_due ON med_orders (abx_review_due) WHERE abx_review_due IS NOT NULL AND abx_reviewed_at IS NULL AND status IN ('active', 'on_hold');

ALTER TABLE med_order_events DROP CONSTRAINT med_order_events_kind_check;
ALTER TABLE med_order_events ADD CONSTRAINT med_order_events_kind_check CHECK (kind IN ('created', 'held', 'resumed', 'stopped', 'modified', 'completed', 'verified',
    'verify_rejected', 'approved', 'approval_rejected', 'verbal_confirmed', 'supply_requested', 'end_reminder', 'discharge_stop',
    'administered',
    -- 0070
    'abx_timeout', 'abx_review'));

-- ================================================================ 4. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON ipc_abx_reference FROM emr_app;
  END IF;
END $$;
