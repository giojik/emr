-- 0050_or_pacu_billing.sql
-- საოპერაციო ბლოკი, ნაწილი 3 — PACU, ბილინგი, სტატისტიკა (მოდული „or“).
--
--  • #11 PACU (გამოღვიძების განყოფილება): or_pacu (პაციენტის PACU ეპიზოდი — „PACU — შემოსვლა“ ნიშნულიდან; პასუხისმგებელი ექთანი, ადგილი,
--      გართულებები, გამოწერა); ვიტალები 15-წთ ბადეზე — encounter_vitals.or_case_id + or_phase = 'pacu' (+ ტკივილი 0–10);
--      სითხეები — fluid_entries.or_phase = 'pacu' (→ ბალანსი); Aldrete — or_pacu_scores (5 კომპონენტი × 0–2, ჯამი 0–10, ტკივილი, PONV).
--      გამოწერა: განყოფილებაში / სხვაგან — ბოლო Aldrete ≥ pacu_aldrete_min (ნაგ. 9; DB trigger-ითაც); ICU-ში — ზღვრის გარეშე
--      (მონიტორინგი გრძელდება რეანიმაციაში); სხვა განყოფილებაში / ICU-ში — გადაყვანის მოთხოვნა (0041), ICU ეპიზოდის წყარო — „საოპერაციო“ (0048).
--  • #12 ბილინგი: ინვოისის ახალი კატეგორიები surgery (ოპერაცია) / anesthesia (ანესთეზია) — or_sync_case_billing():
--      პროცედურები — ხელმოწერილი ოქმიდან (თუ არ არის — მოთხოვნიდან), ტარიფი — or_procedures.tariff_id;
--      multi_procedure_billing: all · primary_plus_pct (ძირითადი — სრული, დანარჩენი — multi_procedure_pct %);
--      anesthesia_billing: fixed (ტარიფი ტიპზე — or_anesthesia_tariffs) · hourly (ანესთეზიის დაწყება → დასრულება, anesthesia_round_min ბლოკებით, ზემოთ) · off;
--      ტარიფი არ არის → or_case_billing.missing → სტაციონარის ფინალიზაცია იბლოკება (OR_TARIFF_MISSING). პაკეტი — კატეგორიის / ტარიფის წესით.
--      ხელით შეცვლილი ფასი (ბილინგი) — გადათვლისას ნარჩუნდება. ფინალიზებულ ინვოისს არ ეხება.
--  • #13 სტატისტიკა — API-ში (დატვირთვა, პირველი ოპერაციის დროული დაწყება — first_case_tolerance_min, მომზადების დრო, გაუქმებები, გართულებები, PACU).

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"pacu_aldrete_min": 9,
                    "multi_procedure_billing": "all",
                    "multi_procedure_pct": 50,
                    "anesthesia_billing": "fixed",
                    "anesthesia_round_min": 15,
                    "first_case_tolerance_min": 15}'::jsonb || settings,
       description = 'ოთახები, კატალოგი, მოთხოვნა / დაგეგმვა, დაფა, გუნდი, წინასაოპერაციო, WHO, ნიშნულები, ანესთეზიის რუკა, ოქმი, მასალები / დათვლა, CSSD, PACU, ბილინგი, სტატისტიკა'
 WHERE code = 'or';

-- ================================================================ 1. PACU
-- ვიტალები / სითხეები: ოპერაციის ფაზა (ანესთეზიის რუკა / PACU) — ერთი სლოტი ფაზაში
ALTER TABLE encounter_vitals ADD COLUMN or_phase VARCHAR(8) CHECK (or_phase IN ('intraop', 'pacu'));
ALTER TABLE encounter_vitals DISABLE TRIGGER trg_encounter_vitals_guard;          -- არსებული (0049) ჩანაწერები → intraop
UPDATE encounter_vitals SET or_phase = 'intraop' WHERE or_case_id IS NOT NULL;
ALTER TABLE encounter_vitals ENABLE TRIGGER trg_encounter_vitals_guard;
ALTER TABLE encounter_vitals ADD CONSTRAINT chk_vitals_or_phase CHECK ((or_case_id IS NULL) = (or_phase IS NULL));
DROP INDEX ux_vitals_or_slot;
CREATE UNIQUE INDEX ux_vitals_or_slot ON encounter_vitals (or_case_id, or_phase, recorded_at) WHERE or_case_id IS NOT NULL AND voided_at IS NULL;

ALTER TABLE fluid_entries ADD COLUMN or_phase VARCHAR(8) CHECK (or_phase IN ('intraop', 'pacu'));
ALTER TABLE fluid_entries DISABLE TRIGGER trg_fluid_guard;
UPDATE fluid_entries SET or_phase = 'intraop' WHERE or_case_id IS NOT NULL;
ALTER TABLE fluid_entries ENABLE TRIGGER trg_fluid_guard;
ALTER TABLE fluid_entries ADD CONSTRAINT chk_fluid_or_phase CHECK ((or_case_id IS NULL) = (or_phase IS NULL));

CREATE TABLE or_pacu (
    case_id                UUID PRIMARY KEY REFERENCES or_cases(id),
    patient_id             UUID NOT NULL REFERENCES patients(id),
    encounter_id           UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    nurse_id               UUID REFERENCES users(id),                         -- პასუხისმგებელი ექთანი
    bay                    VARCHAR(20),                                       -- ადგილი / საწოლი PACU-ში
    complications          TEXT,                                              -- PACU-ს გართულებები (სტატისტიკა)
    notes                  TEXT,
    discharge_destination  VARCHAR(8) CHECK (discharge_destination IN ('ward', 'icu', 'other')),
    discharge_score_id     UUID,                                              -- Aldrete, რომლითაც გაეწერა
    discharge_aldrete      SMALLINT CHECK (discharge_aldrete BETWEEN 0 AND 10),
    discharge_note         TEXT,
    to_department_id       UUID REFERENCES departments(id),                   -- სხვა განყოფილება / ICU → გადაყვანის მოთხოვნა
    transfer_id            UUID REFERENCES inpatient_transfers(id),
    discharged_by          UUID REFERENCES users(id),
    discharged_at          TIMESTAMPTZ,
    created_by             UUID NOT NULL REFERENCES users(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_pacu_discharge CHECK ((discharged_at IS NULL) = (discharged_by IS NULL) AND (discharged_at IS NULL) = (discharge_destination IS NULL))
);
CREATE INDEX idx_or_pacu_open ON or_pacu (created_at) WHERE discharged_at IS NULL;
CREATE TRIGGER trg_or_pacu_updated BEFORE UPDATE ON or_pacu FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE or_pacu_scores (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id        UUID NOT NULL REFERENCES or_pacu(case_id),
    recorded_at    TIMESTAMPTZ NOT NULL,
    activity       SMALLINT NOT NULL CHECK (activity BETWEEN 0 AND 2),          -- მოძრაობა (კიდურები)
    respiration    SMALLINT NOT NULL CHECK (respiration BETWEEN 0 AND 2),       -- სუნთქვა
    circulation    SMALLINT NOT NULL CHECK (circulation BETWEEN 0 AND 2),       -- ცირკულაცია (წნევა საწყისთან)
    consciousness  SMALLINT NOT NULL CHECK (consciousness BETWEEN 0 AND 2),     -- ცნობიერება
    oxygenation    SMALLINT NOT NULL CHECK (oxygenation BETWEEN 0 AND 2),       -- SpO₂ (ჟანგბადი)
    total          SMALLINT GENERATED ALWAYS AS (activity + respiration + circulation + consciousness + oxygenation) STORED,
    pain           SMALLINT CHECK (pain BETWEEN 0 AND 10),
    ponv           BOOLEAN NOT NULL DEFAULT FALSE,                              -- გულისრევა / ღებინება
    note           TEXT,
    recorded_by    UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at      TIMESTAMPTZ,
    voided_by      UUID REFERENCES users(id),
    void_reason    TEXT,
    CONSTRAINT chk_pacu_score_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_or_pacu_scores ON or_pacu_scores (case_id, recorded_at);
-- total — GENERATED (BEFORE trigger-ში NEW.total ჯერ არ არის გამოთვლილი) → შედარებიდან გამოირიცხება
CREATE TRIGGER trg_or_pacu_score_guard BEFORE UPDATE ON or_pacu_scores FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason', 'total');
ALTER TABLE or_pacu ADD CONSTRAINT fk_or_pacu_score FOREIGN KEY (discharge_score_id) REFERENCES or_pacu_scores(id);

-- გამოწერილი ეპიზოდი არ იცვლება; განყოფილებაში / სხვაგან გამოწერა — Aldrete ≥ ზღვარი (ICU — ზღვრის გარეშე)
CREATE OR REPLACE FUNCTION or_pacu_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_min INT;
BEGIN
    IF OLD.discharged_at IS NOT NULL THEN
        IF (to_jsonb(NEW) - 'transfer_id' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'transfer_id' - 'updated_at') THEN
            RAISE EXCEPTION 'PACU: გამოწერილი ეპიზოდი არ იცვლება' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.discharged_at IS NOT NULL AND NEW.discharge_destination <> 'icu' THEN
        SELECT coalesce((settings->>'pacu_aldrete_min')::int, 9) INTO v_min FROM system_modules WHERE code = 'or';
        IF NEW.discharge_aldrete IS NULL OR NEW.discharge_aldrete < coalesce(v_min, 9) THEN
            RAISE EXCEPTION 'PACU: Aldrete (%) ზღვარზე (%) ნაკლებია — გამოწერა შეუძლებელია', NEW.discharge_aldrete, v_min
                USING ERRCODE = 'check_violation', CONSTRAINT = 'or_pacu_aldrete';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_pacu_guard BEFORE UPDATE ON or_pacu FOR EACH ROW EXECUTE FUNCTION or_pacu_guard();

-- ================================================================ 2. ბილინგი
ALTER TABLE invoice_line_items DROP CONSTRAINT invoice_line_items_category_check;
ALTER TABLE invoice_line_items ADD CONSTRAINT invoice_line_items_category_check CHECK (category IN
    ('bed', 'ventilation', 'surgery', 'anesthesia', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'));
ALTER TABLE billing_package_items DROP CONSTRAINT billing_package_items_category_check;
ALTER TABLE billing_package_items ADD CONSTRAINT billing_package_items_category_check CHECK (category IN
    ('service', 'ventilation', 'surgery', 'anesthesia', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant'));
ALTER TABLE invoice_line_items ADD COLUMN or_case_id UUID REFERENCES or_cases(id);
CREATE INDEX idx_invoice_lines_or ON invoice_line_items (or_case_id) WHERE or_case_id IS NOT NULL;

-- ანესთეზიის ტარიფები: ტიპზე — ფიქსირებული (ერთჯერადი) და / ან საათობრივი (1 საათის ფასი)
CREATE TABLE or_anesthesia_tariffs (
    anesthesia_type  VARCHAR(12) NOT NULL CHECK (anesthesia_type IN ('general', 'spinal', 'epidural', 'combined', 'regional', 'sedation', 'local', 'none')),
    mode             VARCHAR(6) NOT NULL CHECK (mode IN ('fixed', 'hourly')),
    tariff_id        UUID NOT NULL REFERENCES service_tariffs(id),
    updated_by       UUID REFERENCES users(id),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (anesthesia_type, mode)
);

-- ოპერაციის ბილინგის მდგომარეობა (ბოლო გადათვლა): ტარიფის გარეშე პოზიციები → ფინალიზაცია იბლოკება
CREATE TABLE or_case_billing (
    case_id            UUID PRIMARY KEY REFERENCES or_cases(id),
    encounter_id       UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    missing            TEXT[] NOT NULL DEFAULT '{}',
    anesthesia_type    VARCHAR(12),
    anesthesia_min     INT,
    anesthesia_units   INT,
    synced_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_or_case_billing_enc ON or_case_billing (encounter_id);

-- ოპერაციის ხაზების (surgery / anesthesia) სინქრონიზაცია ინვოისში — იდემპოტენტური:
--   სასურველი ხაზები გამოითვლება; თუ არსებულს ემთხვევა — არაფერი იცვლება; სხვა შემთხვევაში — ძველი იშლება, ახალი ემატება
--   (ბილინგის მიერ ხელით შეცვლილი ფასი — adjusted_by — ნარჩუნდება იმავე ტარიფზე / კატეგორიაზე). ფინალიზებულ ინვოისს არ ეხება (-1).
CREATE OR REPLACE FUNCTION or_sync_case_billing(p_case UUID, p_tz TEXT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    c        or_cases%ROWTYPE;
    v_inv    invoices%ROWTYPE;
    v_set    JSONB;
    v_mpb    TEXT;
    v_pct    NUMERIC;
    v_ab     TEXT;
    v_round  INT;
    v_procs  JSONB;
    v_day    DATE;
    v_type   TEXT;
    v_missing TEXT[] := '{}';
    v_i      INT := 0;
    v_price  NUMERIC(10,2);
    v_as     TIMESTAMPTZ;
    v_ae     TIMESTAMPTZ;
    v_min    INT;
    v_units  INT;
    v_n      INT;
    p        RECORD;
    t        RECORD;
BEGIN
    SELECT * INTO c FROM or_cases WHERE id = p_case;
    IF NOT FOUND OR c.encounter_id IS NULL THEN RETURN 0; END IF;
    SELECT * INTO v_inv FROM invoices WHERE encounter_id = c.encounter_id;
    IF NOT FOUND OR v_inv.finalized_at IS NOT NULL THEN RETURN -1; END IF;

    IF to_regclass('pg_temp._orl') IS NULL THEN
        CREATE TEMP TABLE _orl (tariff_id UUID, description TEXT, quantity INT, unit_price NUMERIC(10,2), original_price NUMERIC(10,2), category VARCHAR(12),
                                discount_reason TEXT, service_date DATE, adjusted_by UUID) ON COMMIT DROP;
    END IF;
    TRUNCATE _orl;

    IF c.status = 'completed' THEN
        SELECT settings INTO v_set FROM system_modules WHERE code = 'or';
        v_mpb   := coalesce(v_set->>'multi_procedure_billing', 'all');
        v_pct   := coalesce((v_set->>'multi_procedure_pct')::numeric, 50);
        v_ab    := coalesce(v_set->>'anesthesia_billing', 'fixed');
        v_round := coalesce((v_set->>'anesthesia_round_min')::int, 15);
        SELECT (x.at AT TIME ZONE p_tz)::date INTO v_day FROM or_case_times x WHERE x.case_id = p_case AND x.kind = 'in_room' AND x.superseded_by IS NULL;

        -- პროცედურები: ხელმოწერილი (მოქმედი) ოქმიდან, თუ არ არის — მოთხოვნიდან; ძირითადი — პირველი
        SELECT n.procedures INTO v_procs FROM or_op_notes n WHERE n.case_id = p_case AND n.status = 'signed' AND n.superseded_at IS NULL;
        IF v_procs IS NULL OR jsonb_typeof(v_procs) <> 'array' OR jsonb_array_length(v_procs) = 0 THEN
            SELECT jsonb_agg(jsonb_build_object('procedure_id', cp.procedure_id, 'side', cp.side, 'is_primary', cp.is_primary) ORDER BY cp.is_primary DESC, cp.sort_order)
              INTO v_procs FROM or_case_procedures cp WHERE cp.case_id = p_case;
        END IF;
        FOR p IN
            SELECT x.side, pr.code, pr.name, s.id AS sid, s.title, s.base_price, s.is_active AS s_active
              FROM ROWS FROM (jsonb_to_recordset(coalesce(v_procs, '[]'::jsonb)) AS (procedure_id UUID, side TEXT, is_primary BOOLEAN)) WITH ORDINALITY AS x(procedure_id, side, is_primary, ord)
              JOIN or_procedures pr ON pr.id = x.procedure_id
              LEFT JOIN service_tariffs s ON s.id = pr.tariff_id
             ORDER BY coalesce(x.is_primary, FALSE) DESC, x.ord
        LOOP
            v_i := v_i + 1;
            IF p.sid IS NULL OR NOT p.s_active THEN
                v_missing := v_missing || ('პროცედურა „' || p.name || '“ (' || p.code || ') — ტარიფი არ არის');
                CONTINUE;
            END IF;
            v_price := CASE WHEN v_mpb = 'primary_plus_pct' AND v_i > 1 THEN round(p.base_price * v_pct / 100, 2) ELSE p.base_price END;
            INSERT INTO _orl VALUES (p.sid,
                p.title || ' — ოპერაცია ' || c.case_no || CASE p.side WHEN 'left' THEN ' (მარცხ.)' WHEN 'right' THEN ' (მარჯვ.)' WHEN 'bilateral' THEN ' (ორმხრ.)' ELSE '' END,
                1, v_price, p.base_price, 'surgery',
                CASE WHEN v_price <> p.base_price THEN 'მრავლობითი პროცედურა — ' || v_pct::int::text || '%' END, v_day, NULL);
        END LOOP;
        IF v_i = 0 THEN v_missing := v_missing || 'პროცედურა არ არის მითითებული'::TEXT; END IF;

        -- ანესთეზია: ფაქტობრივი ტიპი (რუკიდან), თუ არ არის — დაგეგმილი
        v_type := coalesce((SELECT a.anesthesia_type FROM or_anesthesia_records a WHERE a.case_id = p_case), c.anesthesia_type);
        IF v_ab = 'fixed' THEN
            SELECT s.id, s.title, s.base_price INTO t FROM or_anesthesia_tariffs a JOIN service_tariffs s ON s.id = a.tariff_id
             WHERE a.anesthesia_type = v_type AND a.mode = 'fixed' AND s.is_active;
            IF FOUND THEN
                INSERT INTO _orl VALUES (t.id, t.title || ' — ანესთეზია, ' || c.case_no, 1, t.base_price, t.base_price, 'anesthesia', NULL, v_day, NULL);
            ELSIF v_type NOT IN ('local', 'none') THEN
                v_missing := v_missing || ('ანესთეზია (' || v_type || ') — ფიქსირებული ტარიფი არ არის');
            END IF;
        ELSIF v_ab = 'hourly' THEN
            SELECT x.at INTO v_as FROM or_case_times x WHERE x.case_id = p_case AND x.kind = 'anesthesia_start' AND x.superseded_by IS NULL;
            SELECT x.at INTO v_ae FROM or_case_times x WHERE x.case_id = p_case AND x.kind = 'anesthesia_end' AND x.superseded_by IS NULL;
            SELECT s.id, s.title, s.base_price INTO t FROM or_anesthesia_tariffs a JOIN service_tariffs s ON s.id = a.tariff_id
             WHERE a.anesthesia_type = v_type AND a.mode = 'hourly' AND s.is_active;
            IF NOT FOUND THEN
                IF v_type NOT IN ('local', 'none') THEN v_missing := v_missing || ('ანესთეზია (' || v_type || ') — საათობრივი ტარიფი არ არის'); END IF;
            ELSIF v_as IS NULL OR v_ae IS NULL THEN
                v_missing := v_missing || 'ანესთეზია (საათობრივი): საჭიროა ნიშნულები „ანესთეზიის დაწყება / დასრულება“'::TEXT;
            ELSE
                v_min   := ceil(extract(epoch FROM (v_ae - v_as)) / 60)::int;
                v_units := greatest(1, ceil(v_min::numeric / v_round)::int);
                v_price := round(t.base_price * v_round / 60, 2);
                INSERT INTO _orl VALUES (t.id, t.title || ' — ანესთეზია, ' || c.case_no || ' (' || (v_min / 60) || ' სთ ' || (v_min % 60) || ' წთ → ' || v_units || ' × ' || v_round || ' წთ)',
                    v_units, v_price, v_price, 'anesthesia', NULL, v_day, NULL);
            END IF;
        END IF;
    END IF;

    -- ბილინგის მიერ ხელით შეცვლილი ფასი (adjusted_by) — იმავე ტარიფზე / კატეგორიაზე ნარჩუნდება
    UPDATE _orl l SET unit_price = a.unit_price, discount_reason = a.discount_reason, adjusted_by = a.adjusted_by
      FROM (SELECT DISTINCT ON (tariff_id, category) tariff_id, category, unit_price, discount_reason, adjusted_by FROM invoice_line_items
             WHERE invoice_id = v_inv.id AND or_case_id = p_case AND adjusted_by IS NOT NULL ORDER BY tariff_id, category, created_at DESC) a
     WHERE a.tariff_id = l.tariff_id AND a.category = l.category;
    -- შედარება: არსებული ↔ სასურველი (თუ იგივეა — ხაზები არ იცვლება)
    SELECT count(*) INTO v_n FROM (
        (SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM _orl
         EXCEPT ALL SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM invoice_line_items WHERE invoice_id = v_inv.id AND or_case_id = p_case)
        UNION ALL
        (SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM invoice_line_items WHERE invoice_id = v_inv.id AND or_case_id = p_case
         EXCEPT ALL SELECT tariff_id, description, quantity, unit_price, original_price, category, discount_reason FROM _orl)) d;
    IF v_n > 0 THEN
        DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND or_case_id = p_case;
        INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, discount_reason, service_date, or_case_id, adjusted_by)
        SELECT v_inv.id, tariff_id, description, quantity, unit_price, original_price, category, discount_reason, service_date, p_case, adjusted_by FROM _orl;
    END IF;

    IF c.status = 'completed' THEN
        INSERT INTO or_case_billing (case_id, encounter_id, missing, anesthesia_type, anesthesia_min, anesthesia_units, synced_at)
        VALUES (p_case, c.encounter_id, v_missing, v_type, v_min, v_units, now())
        ON CONFLICT (case_id) DO UPDATE SET missing = EXCLUDED.missing, anesthesia_type = EXCLUDED.anesthesia_type, anesthesia_min = EXCLUDED.anesthesia_min,
            anesthesia_units = EXCLUDED.anesthesia_units, synced_at = now();
    ELSE
        DELETE FROM or_case_billing WHERE case_id = p_case;
    END IF;
    RETURN v_n;
END $$;

-- ჰოსპიტალიზაციის ყველა ოპერაცია (დასრულებული ან ინვოისში უკვე მყოფი)
CREATE OR REPLACE FUNCTION or_sync_encounter_billing(p_enc UUID, p_tz TEXT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_n INT := 0;
BEGIN
    FOR r IN SELECT c.id FROM or_cases c WHERE c.encounter_id = p_enc
               AND (c.status = 'completed' OR EXISTS (SELECT 1 FROM or_case_billing b WHERE b.case_id = c.id)
                    OR EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.or_case_id = c.id))
    LOOP
        PERFORM or_sync_case_billing(r.id, p_tz);
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END $$;

-- 0047-ის ipd_sync_bed_days — ცვლილება მხოლოდ ბოლოში: + ოპერაციების ხაზები (ბილინგის ხედი / ფინალიზაცია ყოველთვის აქტუალურია)
CREATE OR REPLACE FUNCTION ipd_sync_bed_days(p_enc UUID, p_tz TEXT, p_leave_billable BOOLEAN) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_st inpatient_stays%ROWTYPE; v_inv invoices%ROWTYPE; v_pkg billing_packages%ROWTYPE; v_end TIMESTAMPTZ; v_n INT;
BEGIN
    SELECT * INTO v_st FROM inpatient_stays WHERE encounter_id = p_enc;
    IF NOT FOUND THEN RETURN 0; END IF;
    SELECT * INTO v_inv FROM invoices WHERE encounter_id = p_enc FOR UPDATE;
    IF NOT FOUND OR v_inv.finalized_at IS NOT NULL THEN RETURN -1; END IF;
    INSERT INTO stay_billing (encounter_id) VALUES (p_enc) ON CONFLICT DO NOTHING;
    SELECT p.* INTO v_pkg FROM stay_billing sb JOIN billing_packages p ON p.id = sb.package_id WHERE sb.encounter_id = p_enc;
    v_end := CASE WHEN v_st.status = 'active' THEN now() ELSE coalesce(v_st.ended_at, now()) END;

    IF to_regclass('pg_temp._bd') IS NULL THEN
        CREATE TEMP TABLE _bd (day DATE PRIMARY KEY, department_id UUID, bed_id UUID, bed_type_code VARCHAR(30), on_leave BOOLEAN, minimum BOOLEAN) ON COMMIT DROP;
    END IF;
    TRUNCATE _bd;
    IF v_st.status <> 'cancelled' THEN
        INSERT INTO _bd
        SELECT m.d - 1, a.department_id, a.bed_id, coalesce(b.type_code, 'standard'),
               EXISTS (SELECT 1 FROM inpatient_leaves l WHERE l.encounter_id = p_enc AND l.started_at <= (m.d::timestamp AT TIME ZONE p_tz)
                       AND (l.returned_at IS NULL OR l.returned_at > (m.d::timestamp AT TIME ZONE p_tz))), FALSE
          FROM generate_series((v_st.admitted_at AT TIME ZONE p_tz)::date + 1, (v_end AT TIME ZONE p_tz)::date, interval '1 day') g(dd)
          CROSS JOIN LATERAL (SELECT g.dd::date AS d) m
          JOIN LATERAL (SELECT * FROM bed_assignments a WHERE a.encounter_id = p_enc AND a.end_kind IS DISTINCT FROM 'cancel'
                          AND a.started_at <= (m.d::timestamp AT TIME ZONE p_tz) AND (a.ended_at IS NULL OR a.ended_at > (m.d::timestamp AT TIME ZONE p_tz))
                        ORDER BY a.started_at DESC LIMIT 1) a ON TRUE
          LEFT JOIN beds b ON b.id = a.bed_id
         WHERE (m.d::timestamp AT TIME ZONE p_tz) <= v_end;
        IF NOT p_leave_billable THEN DELETE FROM _bd WHERE on_leave; END IF;
        IF NOT EXISTS (SELECT 1 FROM _bd) THEN
            INSERT INTO _bd
            SELECT (v_st.admitted_at AT TIME ZONE p_tz)::date, a.department_id, a.bed_id, coalesce(b.type_code, 'standard'), FALSE, TRUE
              FROM bed_assignments a LEFT JOIN beds b ON b.id = a.bed_id
             WHERE a.encounter_id = p_enc AND a.end_kind IS DISTINCT FROM 'cancel'
             ORDER BY (a.bed_id IS NOT NULL) DESC, a.started_at LIMIT 1;
        END IF;
    END IF;

    DELETE FROM stay_bed_days WHERE encounter_id = p_enc;
    INSERT INTO stay_bed_days (encounter_id, day, department_id, bed_id, bed_type_code, on_leave, minimum, tariff_id, package_included)
    SELECT p_enc, x.day, x.department_id, x.bed_id, x.bed_type_code, x.on_leave, x.minimum,
           CASE WHEN v_pkg.id IS NOT NULL AND v_pkg.includes_bed AND v_pkg.included_days IS NOT NULL AND x.rn > v_pkg.included_days AND v_pkg.extra_day_tariff_id IS NOT NULL
                THEN v_pkg.extra_day_tariff_id ELSE x.tariff_id END,
           v_pkg.id IS NOT NULL AND v_pkg.includes_bed AND (v_pkg.included_days IS NULL OR x.rn <= v_pkg.included_days)
      FROM (SELECT d.*, row_number() OVER (ORDER BY d.day) AS rn,
                   (SELECT t.tariff_id FROM bed_day_tariffs t JOIN service_tariffs s ON s.id = t.tariff_id
                     WHERE t.bed_type_code = d.bed_type_code AND (t.department_id = d.department_id OR t.department_id IS NULL) AND s.is_active
                     ORDER BY t.department_id IS NULL LIMIT 1) AS tariff_id
              FROM _bd d) x;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND category = 'bed';
    INSERT INTO invoice_line_items (invoice_id, tariff_id, description, quantity, unit_price, original_price, category, package_included, service_date)
    SELECT v_inv.id, s.id, s.title || ' (საწოლდღე)', count(*)::int, s.base_price, s.base_price, 'bed', d.package_included, min(d.day)
      FROM stay_bed_days d JOIN service_tariffs s ON s.id = d.tariff_id
     WHERE d.encounter_id = p_enc
     GROUP BY s.id, s.title, s.base_price, d.package_included;
    PERFORM ipd_sync_vent_days(p_enc, p_tz);                                   -- 0047
    PERFORM or_sync_encounter_billing(p_enc, p_tz);                            -- 0050
    UPDATE stay_billing SET bed_days_synced_at = now() WHERE encounter_id = p_enc;
    RETURN v_n;
END $$;

-- ================================================================ 3. ისტორია
ALTER TABLE or_case_events DROP CONSTRAINT or_case_events_kind_check;
ALTER TABLE or_case_events ADD CONSTRAINT or_case_events_kind_check CHECK (kind IN ('requested', 'updated', 'tentative', 'scheduled', 'confirmed', 'rescheduled', 'unscheduled', 'cancelled',
    'surgeon_changed', 'team_added', 'team_removed', 'team_out', 'preop_signed', 'preop_voided', 'readiness', 'readiness_override',
    'who', 'who_voided', 'time', 'time_corrected', 'encounter_linked',
    'team_auto', 'anesthesia_signed', 'anesthesia_med', 'note_signed', 'note_amend', 'items_posted', 'count', 'count_override',
    'pack_added', 'pack_removed', 'packs_used', 'pathology',
    -- 0050
    'pacu_updated', 'pacu_score', 'pacu_score_voided', 'pacu_discharged', 'billing_synced'));

ALTER TABLE inpatient_events DROP CONSTRAINT inpatient_events_kind_check;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_events_kind_check CHECK (kind IN (
    'admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled',
    'bed_cleaned', 'bed_blocked', 'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled',
    'planned_sms', 'wristband',
    'transfer_requested', 'transfer_accepted', 'transfer_rejected', 'transfer_cancelled', 'transfer_overdue',
    'leave_started', 'leave_returned', 'leave_overdue',
    'discharged', 'discharge_cancelled', 'death', 'body_released', 'closed',
    'epicrisis_created', 'epicrisis_signed', 'epicrisis_cosigned', 'epicrisis_reopened',
    'orders_stopped',
    'mar_missed',
    'news2_alert', 'line_inserted', 'line_removed', 'handover',
    'note_signed', 'note_amended', 'consult_requested', 'consult_answered', 'consult_cancelled', 'form100_issued',
    'billing_package', 'payer_added', 'payer_cancelled', 'deposit', 'deposit_refund', 'deposit_voided', 'billing_finalized', 'billing_reopened',
    'icu_in', 'icu_out', 'icu_interval', 'vent_started', 'vent_ended', 'icu_score',
    'or_requested', 'or_scheduled', 'or_cancelled', 'or_started', 'or_completed',
    'or_note_signed', 'or_implant',
    -- 0050
    'or_pacu_discharged'));

-- ================================================================ 4. აპლიკაციის როლი
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON or_pacu, or_pacu_scores FROM emr_app;
    REVOKE TRUNCATE ON or_anesthesia_tariffs, or_case_billing FROM emr_app;
  END IF;
END $$;
