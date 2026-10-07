-- =====================================================================
-- 0046 — სტაციონარის ბილინგი: საწოლდღე (შუაღამის აღრიცხვა), პაკეტები, გადამხდელები (დაზღვევა / სახელმწიფო პროგრამა),
--        DRG ცნობარი, ავანსი, ფინანსური დახურვა (ფინალიზაცია)
--   ინვოისის ხაზს ემატება კატეგორია (ავტომატურად — წყაროდან) და „პაკეტშია“ ნიშანი (ჯამში არ ითვლება);
--   ფინალიზებული ინვოისის ხაზები იბლოკება (ცვლილება — მხოლოდ გახსნით, მიზეზით).
-- =====================================================================

-- ---------------------------------------------------------------- ინვოისის ხაზი: კატეგორია, პაკეტი, თარიღი, ავტორი
ALTER TABLE invoice_line_items
    ADD COLUMN category         VARCHAR(12) NOT NULL DEFAULT 'other' CHECK (category IN
                                 ('bed', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other')),
    ADD COLUMN package_included BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN service_date     DATE,
    ADD COLUMN added_by         UUID REFERENCES users(id),
    ADD COLUMN created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- არსებული ხაზები — კატეგორია წყაროდან
UPDATE invoice_line_items l SET category = x.section FROM dx_order_items x WHERE x.id = l.dx_order_item_id AND x.section IN ('lab', 'radiology', 'endoscopy');
UPDATE invoice_line_items l SET category = 'consult' WHERE l.consultation_id IS NOT NULL;
UPDATE invoice_line_items l SET category = CASE c.kind WHEN 'medication' THEN 'medication' WHEN 'medical_supply' THEN 'supply' WHEN 'implant' THEN 'implant' ELSE 'other' END
  FROM stock_doc_lines dl JOIN stock_items i ON i.id = dl.item_id JOIN stock_categories c ON c.id = i.category_id WHERE dl.id = l.stock_doc_line_id;
UPDATE invoice_line_items l SET category = 'service' WHERE l.category = 'other' AND l.tariff_id IS NOT NULL;

ALTER TABLE invoices
    ADD COLUMN writeoff_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (writeoff_amount >= 0),   -- DRG / ფიქსირებული: თანხა, რომელიც არც გადამხდელს, არც პაციენტს არ ეკისრება
    ADD COLUMN finalized_at    TIMESTAMPTZ,
    ADD COLUMN finalized_by    UUID REFERENCES users(id),
    ADD COLUMN reopen_count    INT NOT NULL DEFAULT 0;

-- ავანსის მიმართვა ინვოისზე — გადახდის მეთოდი 'deposit'
ALTER TABLE payments DROP CONSTRAINT chk_payment_method;
ALTER TABLE payments ADD CONSTRAINT chk_payment_method CHECK (method IN ('cash', 'card_terminal', 'bank_transfer', 'deposit'));

-- ---------------------------------------------------------------- საწოლდღის ტარიფი (საწოლის ტიპი [+ განყოფილება])
CREATE TABLE bed_day_tariffs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bed_type_code  VARCHAR(30) NOT NULL REFERENCES bed_types(code),
    department_id  UUID REFERENCES departments(id),                 -- NULL = ყველა განყოფილება
    tariff_id      UUID NOT NULL REFERENCES service_tariffs(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_bed_day_tariffs ON bed_day_tariffs (bed_type_code, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- პაკეტები
CREATE TABLE billing_packages (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                 VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{1,29}$'),
    name                 TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    price                NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    includes_bed         BOOLEAN NOT NULL DEFAULT TRUE,             -- საწოლდღეები შედის (included_days-მდე)
    included_days        INT CHECK (included_days > 0),             -- NULL = შეუზღუდავი
    extra_day_tariff_id  UUID REFERENCES service_tariffs(id),       -- ზედმეტი დღე; NULL = ჩვეულებრივი საწოლდღის ტარიფი
    department_id        UUID REFERENCES departments(id),           -- NULL = ყველა განყოფილება
    notes                TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (includes_bed OR included_days IS NULL)
);
CREATE TRIGGER trg_billing_packages_updated_at BEFORE UPDATE ON billing_packages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- რა შედის პაკეტში: კატეგორია (ყველა ამ ტიპის ხაზი) ან კონკრეტული ტარიფი
CREATE TABLE billing_package_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    package_id  UUID NOT NULL REFERENCES billing_packages(id) ON DELETE CASCADE,
    kind        VARCHAR(8) NOT NULL CHECK (kind IN ('category', 'tariff')),
    category    VARCHAR(12) CHECK (category IN ('service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant')),
    tariff_id   UUID REFERENCES service_tariffs(id),
    CHECK ((kind = 'category') = (category IS NOT NULL) AND (kind = 'tariff') = (tariff_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_package_items ON billing_package_items (package_id, kind, coalesce(category, ''), coalesce(tariff_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- გადამხდელები (სადაზღვევო კომპანიები, სახელმწიფო პროგრამები)
CREATE TABLE payers (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                 VARCHAR(30) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{1,29}$'),
    name                 TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    kind                 VARCHAR(10) NOT NULL CHECK (kind IN ('insurance', 'state', 'other')),
    tax_id               VARCHAR(20),
    contract_no          VARCHAR(60),
    phone                VARCHAR(40),
    email                VARCHAR(120),
    address              TEXT,
    default_mode         VARCHAR(8) NOT NULL DEFAULT 'percent' CHECK (default_mode IN ('percent', 'fixed', 'drg')),
    default_coverage_pct NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (default_coverage_pct BETWEEN 0 AND 100),
    default_limit        NUMERIC(10,2) CHECK (default_limit >= 0),
    default_deductible   NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (default_deductible >= 0),
    drg_base_rate        NUMERIC(10,2) CHECK (drg_base_rate > 0),           -- DRG: თანხა = ფარდობითი წონა × საბაზისო განაკვეთი
    writeoff_excess      BOOLEAN NOT NULL DEFAULT FALSE,                     -- fixed / DRG: ზედმეტი (ფაქტობრივი − ტარიფი) პაციენტს არ ეკისრება
    excluded_categories  TEXT[] NOT NULL DEFAULT '{}',
    notes                TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (default_mode <> 'drg' OR drg_base_rate IS NOT NULL)
);
CREATE TRIGGER trg_payers_updated_at BEFORE UPDATE ON payers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- DRG ჯგუფები (ცნობარი; იმპორტი CSV-ით)
CREATE TABLE drg_groups (
    code             VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
    title            TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    relative_weight  NUMERIC(8,4) NOT NULL CHECK (relative_weight > 0),
    alos             NUMERIC(5,1) CHECK (alos > 0),                          -- საშუალო ხანგრძლივობა (დღე) — საინფორმაციო
    mdc              VARCHAR(10),                                            -- ძირითადი დიაგნოსტიკური კატეგორია
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_drg_groups_updated_at BEFORE UPDATE ON drg_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- ჰოსპიტალიზაციის ბილინგი
CREATE TABLE stay_billing (
    encounter_id      UUID PRIMARY KEY REFERENCES inpatient_stays(encounter_id),
    package_id        UUID REFERENCES billing_packages(id),
    package_set_by    UUID REFERENCES users(id),
    package_set_at    TIMESTAMPTZ,
    alert_notified_on DATE,                                                  -- ავანსის გადაჭარბების შეხსენება (დღეში ერთხელ)
    bed_days_synced_at TIMESTAMPTZ
);

-- საწოლდღეები (შუაღამის აღრიცხვა): დღე = ღამე, რომელიც ამ თარიღზე დაიწყო
CREATE TABLE stay_bed_days (
    encounter_id      UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    day               DATE NOT NULL,
    department_id     UUID NOT NULL REFERENCES departments(id),
    bed_id            UUID REFERENCES beds(id),
    bed_type_code     VARCHAR(30) NOT NULL REFERENCES bed_types(code),
    on_leave          BOOLEAN NOT NULL DEFAULT FALSE,
    minimum           BOOLEAN NOT NULL DEFAULT FALSE,                        -- შუაღამე არ გადაკვეთა — მინიმუმ 1 დღე
    tariff_id         UUID REFERENCES service_tariffs(id),                   -- NULL = ტარიფი არ არის განსაზღვრული
    package_included  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (encounter_id, day)
);

-- გადამხდელი ჰოსპიტალიზაციაზე (საგარანტიო წერილი / პროგრამა); რამდენიმე — თანმიმდევრობით (seq)
CREATE TABLE stay_payers (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id         UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    payer_id             UUID NOT NULL REFERENCES payers(id),
    seq                  SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 9),
    mode                 VARCHAR(8) NOT NULL CHECK (mode IN ('percent', 'fixed', 'drg')),
    coverage_pct         NUMERIC(5,2) NOT NULL CHECK (coverage_pct BETWEEN 0 AND 100),
    limit_amount         NUMERIC(10,2) CHECK (limit_amount >= 0),
    deductible           NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (deductible >= 0),
    fixed_amount         NUMERIC(10,2) CHECK (fixed_amount >= 0),
    drg_code             VARCHAR(20) REFERENCES drg_groups(code),
    drg_weight           NUMERIC(8,4),
    drg_base_rate        NUMERIC(10,2),
    writeoff_excess      BOOLEAN NOT NULL DEFAULT FALSE,
    excluded_categories  TEXT[] NOT NULL DEFAULT '{}',
    policy_no            VARCHAR(60),
    guarantee_no         VARCHAR(60),
    guarantee_date       DATE,
    valid_until          DATE,
    file_id              UUID REFERENCES patient_files(id),
    override_amount      NUMERIC(10,2) CHECK (override_amount >= 0),          -- ბილინგის ხელით შესწორება (მიზეზით)
    override_reason      TEXT,
    covered_amount       NUMERIC(10,2),                                      -- ფინალიზაციისას დაფიქსირებული
    status               VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    cancel_reason        TEXT,
    created_by           UUID NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_sp_fixed    CHECK (mode <> 'fixed' OR fixed_amount IS NOT NULL),
    CONSTRAINT chk_sp_drg      CHECK (mode <> 'drg' OR (drg_code IS NOT NULL AND drg_weight IS NOT NULL AND drg_base_rate IS NOT NULL)),
    CONSTRAINT chk_sp_override CHECK (override_amount IS NULL OR length(btrim(coalesce(override_reason, ''))) >= 3),
    CONSTRAINT chk_sp_cancel   CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE UNIQUE INDEX ux_stay_payers_seq ON stay_payers (encounter_id, seq) WHERE status = 'active';
CREATE UNIQUE INDEX ux_stay_payers_payer ON stay_payers (encounter_id, payer_id) WHERE status = 'active';
CREATE INDEX idx_stay_payers_payer ON stay_payers (payer_id) WHERE status = 'active';

-- ავანსი / დაბრუნება
CREATE SEQUENCE deposit_receipt_seq;
CREATE TABLE stay_deposits (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    kind          VARCHAR(8) NOT NULL CHECK (kind IN ('deposit', 'refund')),
    amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    method        VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'card_terminal', 'bank_transfer')),
    terminal_ref  VARCHAR(100),
    receipt_no    VARCHAR(30) NOT NULL UNIQUE,
    note          TEXT,
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at     TIMESTAMPTZ,
    voided_by     UUID REFERENCES users(id),
    void_reason   TEXT,
    CONSTRAINT chk_deposit_card CHECK (method <> 'card_terminal' OR terminal_ref IS NOT NULL),
    CONSTRAINT chk_deposit_void CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX idx_stay_deposits_enc ON stay_deposits (encounter_id);

-- patient_files: საგარანტიო წერილი
ALTER TABLE patient_files DROP CONSTRAINT patient_files_doc_type_check;
ALTER TABLE patient_files ADD CONSTRAINT patient_files_doc_type_check CHECK (doc_type IN
    ('id_card', 'passport', 'birth_certificate', 'residence_permit', 'consent_scan', 'consent_signed', 'guarantee_letter', 'other'));

-- ---------------------------------------------------------------- პაკეტი ფარავს ხაზს?
CREATE OR REPLACE FUNCTION billing_package_covers(p_package UUID, p_category TEXT, p_tariff UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM billing_package_items i WHERE i.package_id = p_package
        AND ((i.kind = 'category' AND i.category = p_category) OR (i.kind = 'tariff' AND i.tariff_id = p_tariff)))
$$;

-- ხაზის ნაგულისხმევი მნიშვნელობები (კატეგორია წყაროდან; პაკეტი) + ფინალიზებული ინვოისის დაცვა
CREATE OR REPLACE FUNCTION invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_fin TIMESTAMPTZ; v_pkg UUID; v_inv UUID;
BEGIN
    v_inv := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
    SELECT i.finalized_at, sb.package_id INTO v_fin, v_pkg FROM invoices i LEFT JOIN stay_billing sb ON sb.encounter_id = i.encounter_id WHERE i.id = v_inv;
    IF v_fin IS NOT NULL THEN
        RAISE EXCEPTION 'ინვოისი ფინალიზებულია — ცვლილებისთვის საჭიროა გახსნა' USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_finalized';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.category = 'other' THEN
            NEW.category := coalesce(CASE
                WHEN NEW.dx_order_item_id IS NOT NULL THEN (SELECT x.section FROM dx_order_items x WHERE x.id = NEW.dx_order_item_id)
                WHEN NEW.consultation_id IS NOT NULL THEN 'consult'
                WHEN NEW.stock_doc_line_id IS NOT NULL THEN (SELECT CASE c.kind WHEN 'medication' THEN 'medication' WHEN 'medical_supply' THEN 'supply' WHEN 'implant' THEN 'implant' ELSE 'other' END
                    FROM stock_doc_lines dl JOIN stock_items i ON i.id = dl.item_id JOIN stock_categories c ON c.id = i.category_id WHERE dl.id = NEW.stock_doc_line_id)
                WHEN NEW.tariff_id IS NOT NULL OR NEW.referral_id IS NOT NULL THEN 'service'
            END, 'other');
        END IF;
        IF v_pkg IS NOT NULL AND NEW.category NOT IN ('bed', 'package') THEN
            NEW.package_included := billing_package_covers(v_pkg, NEW.category, NEW.tariff_id);
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_line_items FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();

-- ინვოისის გადათვლა: პაკეტში შემავალი ხაზები ჯამში არ ითვლება; ჩამოწერა (writeoff) პაციენტის წილს ამცირებს
CREATE OR REPLACE FUNCTION recalc_invoice(p_invoice UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_total NUMERIC(10,2); v_paid NUMERIC(10,2); v_share NUMERIC(10,2);
BEGIN
    SELECT coalesce(sum(line_total) FILTER (WHERE NOT package_included), 0) INTO v_total FROM invoice_line_items WHERE invoice_id = p_invoice;
    SELECT coalesce(sum(amount), 0) INTO v_paid FROM payments WHERE invoice_id = p_invoice;
    UPDATE invoices SET
        total_amount  = v_total,
        patient_share = greatest(v_total - insurance_share - state_share - writeoff_amount, 0),
        paid_status   = CASE
            WHEN v_paid >= greatest(v_total - insurance_share - state_share - writeoff_amount, 0) THEN 'paid'
            WHEN v_paid > 0 THEN 'partially_paid'
            ELSE 'unpaid' END
    WHERE id = p_invoice
    RETURNING patient_share INTO v_share;
    IF v_paid > v_share THEN
        RAISE EXCEPTION 'გადახდილი თანხა (%) აღემატება პაციენტის წილს (%)', v_paid, v_share
            USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_invoice_overpaid';
    END IF;
END $$;
DROP TRIGGER trg_invoice_shares_recalc ON invoices;
CREATE TRIGGER trg_invoice_shares_recalc AFTER UPDATE OF insurance_share, state_share, writeoff_amount ON invoices
    FOR EACH ROW EXECUTE FUNCTION trg_recalc_invoice();

-- ---------------------------------------------------------------- საწოლდღეების სინქრონიზაცია (შუაღამის აღრიცხვა)
--   დღე D ითვლება, თუ პაციენტი D+1 00:00-ზე (კლინიკის დროით) საწოლზე / განყოფილებაშია; გაწერის დღე არ ითვლება;
--   შუაღამე არ გადაკვეთა → მინიმუმ 1 დღე (ჰოსპიტალიზაციის თარიღით). ტარიფი — შუაღამის საწოლის ტიპით (+ განყოფილება).
--   დროებითი გასვლა: p_leave_billable = false → დღე არ ითვლება. პაკეტი: includes_bed → პირველი included_days დღე „პაკეტშია“,
--   დანარჩენი — extra_day_tariff_id (ან ჩვეულებრივი). ინვოისის „bed“ ხაზები ერთიანდება ტარიფით (რაოდენობა = დღეები).
--   ფინალიზებულ ინვოისზე არაფერს ცვლის.
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
    UPDATE stay_billing SET bed_days_synced_at = now() WHERE encounter_id = p_enc;
    RETURN v_n;
END $$;

-- პაკეტის (ხელახალი) მიმართვა არსებულ ხაზებზე + პაკეტის ხაზი
CREATE OR REPLACE FUNCTION ipd_apply_package(p_enc UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_inv invoices%ROWTYPE; v_pkg billing_packages%ROWTYPE;
BEGIN
    SELECT * INTO v_inv FROM invoices WHERE encounter_id = p_enc FOR UPDATE;
    IF NOT FOUND OR v_inv.finalized_at IS NOT NULL THEN RETURN; END IF;
    SELECT p.* INTO v_pkg FROM stay_billing sb JOIN billing_packages p ON p.id = sb.package_id WHERE sb.encounter_id = p_enc;
    DELETE FROM invoice_line_items WHERE invoice_id = v_inv.id AND category = 'package';
    UPDATE invoice_line_items SET package_included = CASE WHEN v_pkg.id IS NULL THEN FALSE ELSE billing_package_covers(v_pkg.id, category, tariff_id) END
     WHERE invoice_id = v_inv.id AND category NOT IN ('bed', 'package');
    IF v_pkg.id IS NOT NULL THEN
        INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, original_price, category)
        VALUES (v_inv.id, 'პაკეტი: ' || v_pkg.name || ' (' || v_pkg.code || ')', 1, v_pkg.price, v_pkg.price, 'package');
    END IF;
END $$;

-- ---------------------------------------------------------------- ისტორია
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
    -- 0046
    'billing_package', 'payer_added', 'payer_cancelled', 'deposit', 'deposit_refund', 'deposit_voided', 'billing_finalized', 'billing_reopened'));

-- ---------------------------------------------------------------- პარამეტრები
UPDATE system_modules SET settings = settings || '{
    "discharge_balance": "warn",
    "deposit_alert_amount": 500,
    "billing_amounts_visible": "heads",
    "staff_add_services": true
}'::jsonb
WHERE code = 'inpatient';

-- არსებული ჰოსპიტალიზაციები → stay_billing
INSERT INTO stay_billing (encounter_id) SELECT encounter_id FROM inpatient_stays ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON stay_deposits, stay_payers FROM emr_app;
    REVOKE TRUNCATE ON stay_billing, stay_bed_days, payers, drg_groups, billing_packages FROM emr_app;
    GRANT USAGE ON SEQUENCE deposit_receipt_seq TO emr_app;
  END IF;
END $$;
