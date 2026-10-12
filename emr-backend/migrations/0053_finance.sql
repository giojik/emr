-- 0053_finance.sql
-- ფინანსები და შესყიდვები, ეტაპი 3 — მარაგის ღირებულება / მოხმარება, შემოსავალი გადამხდელით / განყოფილებით, გადამხდელის დებიტორები
-- (ქლეიმები), საერთო ხარჯის განაწილება, პერიოდის დახურვა. ახალი მოდული „finance“ (ადმინისტრირება → მოდულები → ფინანსები).
--
--  • #2–#4 მარაგი: მოხმარება განყოფილებაზე ლოკაციის განყოფილებით — dept_consumption_basis: consumption (ფაქტობრივი ხარჯი
--      ქვესაწყობიდან) / issue (გაცემა / გადაცემა განყოფილების ლოკაციაზე, ნეტო); დანაკარგი (ჩამოწერა + ინვენტარიზაციის სხვაობა) ცალკე;
--      ლოკაცია განყოფილების გარეშე → „საერთო“ (განაწილებაში). ღირებულება — stock_settings.costing_method (fifo → cost_lot / average → cost_avg).
--  • #5 შემოსავლის თარიღი — revenue_basis: service_date (ხაზის მომსახურების თარიღი; საწოლდღე / ვენტილაციის დღე — თავის დღეზე) /
--      finalized (ამბულატორია — ინვოისის თარიღი, სტაციონარი — ფინალიზაციის თარიღი). ხაზს service_date ყოველთვის ივსება (trigger).
--  • #6 გადამხდელის წილი ხაზებზე — პროპორციულად (pro rata) ინვოისის წილებიდან (პაციენტი / გადამხდელები / ჩამოწერა); დაუფინალებელი
--      სტაციონარი — „განუსაზღვრელი“.
--  • #7 ხაზზე ordering_department_id + performing_department_id (trigger; ძველი ხაზები — აქვე); ლაბ. / რადიოლოგია / ენდოსკოპია →
--      პარამეტრი dx_performing_dept; რეპორტის ნაგულისხმევი — revenue_dept_basis.
--  • #8 ამბულატორიის გადამხდელი: invoices.insurance_payer_id / state_payer_id (თანხა — ხელით, opd_payer_mode = manual 0054-მდე);
--      opd_payer_required: წილი გადამხდელის გარეშე → 400.
--  • #9–#10 ქლეიმები (fin_claims): გადამხდელი × პერიოდი, ფინალიზებული სტაციონარი + ამბულატორია; მონახაზი → გაგზავნილი (CL26-000001)
--      → ნაწილობრივ → დაფარული; ანაზღაურება (fin_claim_payments + განაწილება შემთხვევებზე); დანაკლისი / უარი — პაციენტზე გადატანა ან
--      ჩამოწერა (მიზეზით); ვადა = გაგზავნა + payers.payment_terms_days; შეტყობინება ვადაგადაცილებაზე (claim_overdue_alert).
--  • #11–#12 საერთო ხარჯის განაწილება — overhead_allocation: none / revenue / bed_days / manual (overhead_manual: განყოფილება → %);
--      მხოლოდ რეპორტში („განყოფილების შედეგი“), ჩანაწერები არ იცვლება.
--  • #13 პერიოდის დახურვა (fin_periods, period_lock): დახურულ თვეში თარიღით ვერ დაემატება / შეიცვლება — ინვოისის ხაზი (ავტომატური
--      საწოლდღე / ვენტილაცია / პაკეტი / ოპერაცია — გარდა), პაციენტის გადახდა, ფინალიზაცია / გახსნა, ამბულატორიის წილი, მომწოდებლის
--      ინვოისი / გადახდა, ხარჯი, მარაგის მოძრაობა, ქლეიმის ანაზღაურება → 409 (period_locked). დახურვისას — სნეპშოტი.
--  • #14 უფლებები ახალი არ ემატება (კატალოგი 26): accountant — ქლეიმები / პერიოდები; billing — უარის გადაწყვეტა;
--      dept_finance_visible: heads (მენეჯერი — თავისი განყოფილება) / off.

-- ================================================================ 0. მოდული
INSERT INTO system_modules (code, name, description, enabled, settings, sort_order) VALUES
('finance', 'ფინანსები', 'შემოსავალი გადამხდელით და განყოფილებით, მარაგის ღირებულება და მოხმარება განყოფილებებზე, გადამხდელის დებიტორები (ქლეიმები), საერთო ხარჯის განაწილება, განყოფილების შედეგი, პერიოდის დახურვა', TRUE,
 '{"dept_consumption_basis": "consumption",
   "revenue_basis": "service_date",
   "revenue_dept_basis": "performing",
   "dx_performing_dept": {"lab": null, "radiology": null, "endoscopy": null},
   "opd_payer_required": false,
   "claim_overdue_alert": true,
   "overhead_allocation": "none",
   "overhead_manual": {},
   "period_lock": "off",
   "dept_finance_visible": "heads"}', 45)
ON CONFLICT (code) DO NOTHING;

-- ================================================================ 1. დამხმარე ფუნქციები
CREATE OR REPLACE FUNCTION fin_local_date(p_ts TIMESTAMPTZ) RETURNS DATE LANGUAGE sql STABLE AS $$
    SELECT (p_ts AT TIME ZONE 'Asia/Tbilisi')::date
$$;

-- ================================================================ 2. პერიოდები
CREATE TABLE fin_periods (
    month           DATE PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
    status          VARCHAR(6) NOT NULL CHECK (status IN ('open', 'closed')),
    closed_at       TIMESTAMPTZ,
    closed_by       UUID REFERENCES users(id),
    note            TEXT,
    checklist       JSONB,                                                    -- დახურვისას: გაფრთხილებები (მონახაზები, სხვაობები …)
    snapshot        JSONB,                                                    -- დახურვისას: შემოსავალი, ხარჯი, მარაგი, დებიტორები
    reopened_at     TIMESTAMPTZ,
    reopened_by     UUID REFERENCES users(id),
    reopen_reason   TEXT,
    CONSTRAINT fin_period_closed CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
    CONSTRAINT fin_period_reopen CHECK (reopened_at IS NULL OR length(btrim(coalesce(reopen_reason, ''))) >= 3)
);
CREATE TABLE fin_period_log (
    id          BIGSERIAL PRIMARY KEY,
    month       DATE NOT NULL REFERENCES fin_periods(month),
    action      VARCHAR(6) NOT NULL CHECK (action IN ('close', 'reopen')),
    reason      TEXT,
    data        JSONB,
    user_id     UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_fin_period_log_month ON fin_period_log (month, created_at DESC);

-- პერიოდი დახურულია? (მოდული ჩართულია + period_lock = on + თვე დახურულია)
CREATE OR REPLACE FUNCTION fin_period_locked(p_day DATE) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_day IS NOT NULL
       AND EXISTS (SELECT 1 FROM system_modules m WHERE m.code = 'finance' AND m.enabled AND m.settings->>'period_lock' = 'on')
       AND EXISTS (SELECT 1 FROM fin_periods p WHERE p.month = date_trunc('month', p_day)::date AND p.status = 'closed')
$$;

-- დახურულ პერიოდში ცვლილება → 409 (CONSTRAINT period_locked; HTTP-ში გადაყავს pg-errors / გლობალურ ფილტრს)
CREATE OR REPLACE FUNCTION fin_assert_open(p_day DATE, p_what TEXT) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF fin_period_locked(p_day) THEN
        RAISE EXCEPTION 'პერიოდი % დახურულია — % (გახსნა: ფინანსები → პერიოდები)', to_char(p_day, 'MM.YYYY'), p_what
            USING ERRCODE = 'check_violation', CONSTRAINT = 'period_locked';
    END IF;
END $$;

-- ================================================================ 3. ინვოისის ხაზი: თარიღი, განყოფილებები
ALTER TABLE invoice_line_items
    ADD COLUMN ordering_department_id   UUID REFERENCES departments(id),
    ADD COLUMN performing_department_id UUID REFERENCES departments(id);

-- ვიზიტის / ჰოსპიტალიზაციის განყოფილება მოცემულ დღეს (სტაციონარი — საწოლის განყოფილება იმ დღეს; ამბულატორია — ვიზიტის)
CREATE OR REPLACE FUNCTION fin_enc_department(p_enc UUID, p_day DATE) RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT coalesce(
        (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = p_enc AND a.end_kind IS DISTINCT FROM 'cancel'
            AND fin_local_date(a.started_at) <= p_day ORDER BY a.started_at DESC, a.id DESC LIMIT 1),
        (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = p_enc AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY a.started_at, a.id LIMIT 1),
        (SELECT e.department_id FROM encounters e WHERE e.id = p_enc))
$$;

-- შემსრულებელი განყოფილება წყაროდან; ვერ დადგინდა → ordering
CREATE OR REPLACE FUNCTION fin_line_performing(p_enc UUID, p_day DATE, p_category TEXT, p_dx UUID, p_consult UUID, p_stock_line UUID,
                                               p_or_case UUID, p_ordering UUID) RETURNS UUID LANGUAGE plpgsql STABLE AS $$
DECLARE v UUID; v_txt TEXT;
BEGIN
    IF p_or_case IS NOT NULL THEN
        SELECT coalesce(c.block_id, c.department_id) INTO v FROM or_cases c WHERE c.id = p_or_case;
    ELSIF p_category = 'bed' THEN
        SELECT d.department_id INTO v FROM stay_bed_days d WHERE d.encounter_id = p_enc AND d.day = p_day;
    ELSIF p_consult IS NOT NULL THEN
        SELECT coalesce(c.target_department_id, u.department_id, ua.department_id) INTO v FROM consultations c
          LEFT JOIN users u ON u.id = c.target_doctor_id LEFT JOIN users ua ON ua.id = c.answered_by WHERE c.id = p_consult;
    ELSIF p_dx IS NOT NULL THEN
        SELECT m.settings->'dx_performing_dept'->>x.section INTO v_txt FROM dx_order_items x, system_modules m WHERE x.id = p_dx AND m.code = 'finance';
        IF v_txt ~* '^[0-9a-f-]{36}$' THEN SELECT d.id INTO v FROM departments d WHERE d.id = v_txt::uuid; END IF;
    ELSIF p_stock_line IS NOT NULL THEN
        SELECT l.department_id INTO v FROM stock_doc_lines dl JOIN stock_docs d ON d.id = dl.doc_id
          JOIN stock_locations l ON l.id = coalesce(d.location_id, d.from_location_id) WHERE dl.id = p_stock_line;
    END IF;
    RETURN coalesce(v, p_ordering);
END $$;

-- ახალი ხაზი: service_date (ცარიელი → დღეს), ordering / performing (სახელი „z…“ — ეშვება invoice_lines_guard-ის შემდეგ: კატეგორია უკვე დადგენილია)
CREATE OR REPLACE FUNCTION fin_invoice_lines_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_enc UUID;
BEGIN
    NEW.service_date := coalesce(NEW.service_date, fin_local_date(now()));
    IF NEW.ordering_department_id IS NULL OR NEW.performing_department_id IS NULL THEN
        SELECT i.encounter_id INTO v_enc FROM invoices i WHERE i.id = NEW.invoice_id;
        NEW.ordering_department_id := coalesce(NEW.ordering_department_id, fin_enc_department(v_enc, NEW.service_date));
        NEW.performing_department_id := coalesce(NEW.performing_department_id, fin_line_performing(v_enc, NEW.service_date, NEW.category,
            NEW.dx_order_item_id, NEW.consultation_id, NEW.stock_doc_line_id, NEW.or_case_id, NEW.ordering_department_id));
    END IF;
    RETURN NEW;
END $$;

-- ძველი ხაზები: თარიღი წყაროდან (0046-მდე created_at სანდო არ არის) → განყოფილებები
ALTER TABLE invoice_line_items DISABLE TRIGGER USER;
UPDATE invoice_line_items l SET service_date = coalesce(
        (SELECT fin_local_date(x.ordered_at) FROM dx_order_items x WHERE x.id = l.dx_order_item_id),
        (SELECT d.doc_date FROM stock_doc_lines dl JOIN stock_docs d ON d.id = dl.doc_id WHERE dl.id = l.stock_doc_line_id),
        (SELECT fin_local_date(coalesce(c.answered_at, c.created_at)) FROM consultations c WHERE c.id = l.consultation_id),
        (SELECT fin_local_date(i.created_at) FROM invoices i WHERE i.id = l.invoice_id))
 WHERE l.service_date IS NULL;
UPDATE invoice_line_items l SET ordering_department_id = fin_enc_department(i.encounter_id, l.service_date)
  FROM invoices i WHERE i.id = l.invoice_id;
UPDATE invoice_line_items l SET performing_department_id = fin_line_performing(i.encounter_id, l.service_date, l.category, l.dx_order_item_id,
       l.consultation_id, l.stock_doc_line_id, l.or_case_id, l.ordering_department_id)
  FROM invoices i WHERE i.id = l.invoice_id;
ALTER TABLE invoice_line_items ENABLE TRIGGER USER;
ALTER TABLE invoice_line_items ALTER COLUMN service_date SET NOT NULL,
    ALTER COLUMN service_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Tbilisi')::date);

CREATE TRIGGER trg_invoice_lines_zfin BEFORE INSERT ON invoice_line_items FOR EACH ROW EXECUTE FUNCTION fin_invoice_lines_fill();
CREATE INDEX idx_invoice_lines_service_date ON invoice_line_items (service_date);
CREATE INDEX idx_invoice_lines_performing ON invoice_line_items (performing_department_id);
CREATE INDEX idx_invoice_lines_ordering ON invoice_line_items (ordering_department_id);

-- ================================================================ 4. ამბულატორიის გადამხდელი, გადამხდელის პირობები
ALTER TABLE invoices
    ADD COLUMN insurance_payer_id UUID REFERENCES payers(id),
    ADD COLUMN state_payer_id     UUID REFERENCES payers(id);
CREATE INDEX idx_invoices_ins_payer ON invoices (insurance_payer_id) WHERE insurance_payer_id IS NOT NULL;
CREATE INDEX idx_invoices_state_payer ON invoices (state_payer_id) WHERE state_payer_id IS NOT NULL;
ALTER TABLE payers ADD COLUMN payment_terms_days INT NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365);

-- ================================================================ 5. ქლეიმები
CREATE TABLE fin_claims (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_no         VARCHAR(20) UNIQUE,                                     -- გაგზავნისას: CL26-000001
    payer_id         UUID NOT NULL REFERENCES payers(id),
    period_from      DATE NOT NULL,
    period_to        DATE NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'partial', 'settled', 'cancelled')),
    total_claimed    NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_paid       NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_resolved   NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes            TEXT,
    sent_at          TIMESTAMPTZ,
    sent_by          UUID REFERENCES users(id),
    due_date         DATE,
    overdue_notified BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled_at     TIMESTAMPTZ,
    cancelled_by     UUID REFERENCES users(id),
    cancel_reason    TEXT,
    created_by       UUID NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fin_claim_period CHECK (period_to >= period_from),
    CONSTRAINT fin_claim_sent CHECK (status IN ('draft', 'cancelled') OR (claim_no IS NOT NULL AND sent_at IS NOT NULL AND due_date IS NOT NULL)),
    CONSTRAINT fin_claim_cancel CHECK (status <> 'cancelled' OR length(btrim(coalesce(cancel_reason, ''))) >= 3)
);
CREATE INDEX idx_fin_claims_payer ON fin_claims (payer_id, created_at DESC);
CREATE INDEX idx_fin_claims_open ON fin_claims (due_date) WHERE status IN ('sent', 'partial');
CREATE TRIGGER trg_fin_claims_updated BEFORE UPDATE ON fin_claims FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fin_claim_items (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id           UUID NOT NULL REFERENCES fin_claims(id) ON DELETE CASCADE,
    invoice_id         UUID NOT NULL REFERENCES invoices(id),
    payer_id           UUID NOT NULL REFERENCES payers(id),
    stay_payer_id      UUID REFERENCES stay_payers(id),                       -- სტაციონარი
    kind               VARCHAR(3) NOT NULL CHECK (kind IN ('ipd', 'opd')),
    share_slot         VARCHAR(9) NOT NULL CHECK (share_slot IN ('insurance', 'state')),  -- ინვოისის რომელ წილს ეკუთვნის
    claimed            NUMERIC(12,2) NOT NULL CHECK (claimed > 0),
    paid               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
    resolution         VARCHAR(8) CHECK (resolution IN ('patient', 'writeoff')),
    resolved_amount    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (resolved_amount >= 0),
    resolution_reason  TEXT,
    resolved_by        UUID REFERENCES users(id),
    resolved_at        TIMESTAMPTZ,
    CONSTRAINT fin_claim_item_amounts CHECK (paid + resolved_amount <= claimed),
    CONSTRAINT fin_claim_item_resolution CHECK ((resolution IS NULL) = (resolved_at IS NULL)
        AND (resolution IS NULL OR (resolved_amount > 0 AND length(btrim(coalesce(resolution_reason, ''))) >= 3))),
    CONSTRAINT fin_claim_item_ipd CHECK (kind <> 'ipd' OR stay_payer_id IS NOT NULL)
);
-- ერთი შემთხვევა × გადამხდელი — მხოლოდ ერთ ქლეიმში (გაუქმებული ქლეიმი ხაზებს შლის)
CREATE UNIQUE INDEX ux_fin_claim_items_case ON fin_claim_items (invoice_id, payer_id);
CREATE INDEX idx_fin_claim_items_claim ON fin_claim_items (claim_id);

CREATE TABLE fin_claim_payments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id     UUID NOT NULL REFERENCES fin_claims(id),
    paid_on      DATE NOT NULL,
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    ref_no       VARCHAR(60),
    note         TEXT,
    created_by   UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_void      BOOLEAN NOT NULL DEFAULT FALSE,
    void_reason  TEXT,
    voided_by    UUID REFERENCES users(id),
    voided_at    TIMESTAMPTZ,
    CONSTRAINT fin_claim_pay_void CHECK (NOT is_void OR length(btrim(coalesce(void_reason, ''))) >= 3)
);
CREATE INDEX idx_fin_claim_payments_claim ON fin_claim_payments (claim_id);
CREATE INDEX idx_fin_claim_payments_date ON fin_claim_payments (paid_on) WHERE NOT is_void;

CREATE TABLE fin_claim_allocations (
    payment_id  UUID NOT NULL REFERENCES fin_claim_payments(id) ON DELETE CASCADE,
    item_id     UUID NOT NULL REFERENCES fin_claim_items(id),
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    PRIMARY KEY (payment_id, item_id)
);
CREATE INDEX idx_fin_claim_alloc_item ON fin_claim_allocations (item_id);

-- ქლეიმის ჯამები და სტატუსი (გაგზავნილი → ნაწილობრივ → დაფარული)
CREATE OR REPLACE FUNCTION fin_claim_refresh(p_claim UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_cl NUMERIC(12,2); v_pd NUMERIC(12,2); v_rs NUMERIC(12,2);
BEGIN
    SELECT coalesce(sum(claimed), 0), coalesce(sum(paid), 0), coalesce(sum(resolved_amount), 0) INTO v_cl, v_pd, v_rs FROM fin_claim_items WHERE claim_id = p_claim;
    UPDATE fin_claims SET total_claimed = v_cl, total_paid = v_pd, total_resolved = v_rs,
        status = CASE WHEN status IN ('sent', 'partial', 'settled') THEN
                     CASE WHEN v_cl > 0 AND v_pd + v_rs >= v_cl THEN 'settled' WHEN v_pd + v_rs > 0 THEN 'partial' ELSE 'sent' END
                 ELSE status END
     WHERE id = p_claim;
END $$;

-- ხაზის „გადახდილი“ = გაუქმებელი ანაზღაურებების განაწილება
CREATE OR REPLACE FUNCTION fin_claim_item_sync(p_item UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE fin_claim_items i SET paid = coalesce((SELECT sum(a.amount) FROM fin_claim_allocations a JOIN fin_claim_payments p ON p.id = a.payment_id
                                                   WHERE a.item_id = i.id AND NOT p.is_void), 0)
     WHERE i.id = p_item;
END $$;

-- ხაზები — მხოლოდ მონახაზში (დამატება / წაშლა / თანხა); გაგზავნის შემდეგ — მხოლოდ paid (ტრიგერით) და გადაწყვეტა
CREATE OR REPLACE FUNCTION fin_claim_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_st TEXT;
BEGIN
    SELECT status INTO v_st FROM fin_claims WHERE id = coalesce(NEW.claim_id, OLD.claim_id);
    IF TG_OP = 'INSERT' AND v_st <> 'draft' THEN
        RAISE EXCEPTION 'ქლეიმი გაგზავნილია — შემთხვევის დამატება შეუძლებელია' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_not_draft';
    ELSIF TG_OP = 'DELETE' AND v_st NOT IN ('draft', 'cancelled') AND v_st IS NOT NULL THEN
        RAISE EXCEPTION 'ქლეიმი გაგზავნილია — შემთხვევის ამოღება შეუძლებელია' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_not_draft';
    ELSIF TG_OP = 'UPDATE' AND v_st <> 'draft' AND (NEW.claimed IS DISTINCT FROM OLD.claimed OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
            OR NEW.payer_id IS DISTINCT FROM OLD.payer_id) THEN
        RAISE EXCEPTION 'ქლეიმი გაგზავნილია — თანხა არ იცვლება' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_not_draft';
    ELSIF TG_OP = 'UPDATE' AND v_st = 'draft' AND (NEW.paid > 0 OR NEW.resolution IS NOT NULL) THEN
        RAISE EXCEPTION 'ქლეიმი ჯერ არ არის გაგზავნილი' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_not_sent';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_fin_claim_items_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_claim_items FOR EACH ROW EXECUTE FUNCTION fin_claim_items_guard();

CREATE OR REPLACE FUNCTION fin_claim_items_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM fin_claim_refresh(coalesce(NEW.claim_id, OLD.claim_id));
    RETURN NULL;
END $$;
CREATE TRIGGER trg_fin_claim_items_after AFTER INSERT OR UPDATE OR DELETE ON fin_claim_items FOR EACH ROW EXECUTE FUNCTION fin_claim_items_after();

-- ანაზღაურება: მხოლოდ გაგზავნილ / ნაწილობრივ ქლეიმზე; დახურულ პერიოდში — არა; ჩანაწერი უცვლელია — მხოლოდ გაუქმება
CREATE OR REPLACE FUNCTION fin_claim_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_st TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ანაზღაურება არ იშლება — გამოიყენეთ გაუქმება' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_pay_immutable';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT status INTO v_st FROM fin_claims WHERE id = NEW.claim_id;
        IF v_st NOT IN ('sent', 'partial') THEN
            RAISE EXCEPTION 'ანაზღაურება — მხოლოდ გაგზავნილ, დაუფარავ ქლეიმზე' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_not_open';
        END IF;
        PERFORM fin_assert_open(NEW.paid_on, 'ქლეიმის ანაზღაურება');
        RETURN NEW;
    END IF;
    IF NEW.claim_id <> OLD.claim_id OR NEW.paid_on <> OLD.paid_on OR NEW.amount <> OLD.amount OR OLD.is_void OR NOT NEW.is_void THEN
        RAISE EXCEPTION 'ანაზღაურება უცვლელია — მხოლოდ გაუქმება' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_pay_immutable';
    END IF;
    PERFORM fin_assert_open(OLD.paid_on, 'ქლეიმის ანაზღაურების გაუქმება');
    RETURN NEW;
END $$;
CREATE TRIGGER trg_fin_claim_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON fin_claim_payments FOR EACH ROW EXECUTE FUNCTION fin_claim_payments_guard();

CREATE OR REPLACE FUNCTION fin_claim_payments_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT item_id FROM fin_claim_allocations WHERE payment_id = NEW.id LOOP PERFORM fin_claim_item_sync(r.item_id); END LOOP;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_fin_claim_payments_after AFTER UPDATE OF is_void ON fin_claim_payments FOR EACH ROW EXECUTE FUNCTION fin_claim_payments_after();

CREATE OR REPLACE FUNCTION fin_claim_alloc_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM fin_claim_item_sync(coalesce(NEW.item_id, OLD.item_id));
    RETURN NULL;
END $$;
CREATE TRIGGER trg_fin_claim_alloc_after AFTER INSERT OR UPDATE OR DELETE ON fin_claim_allocations FOR EACH ROW EXECUTE FUNCTION fin_claim_alloc_after();

-- ================================================================ 6. პერიოდის დაცვა (period_lock) — ტრიგერები
-- ინვოისის ხაზი (service_date); ავტომატური სინქრონიზაციის ხაზები (საწოლდღე / ვენტილაცია / პაკეტი / ოპერაცია) — გარდა
CREATE OR REPLACE FUNCTION fin_lines_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.category NOT IN ('bed', 'ventilation', 'package') AND OLD.or_case_id IS NULL THEN
        PERFORM fin_assert_open(OLD.service_date, 'ინვოისის ხაზი');
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.category NOT IN ('bed', 'ventilation', 'package') AND NEW.or_case_id IS NULL THEN
        PERFORM fin_assert_open(NEW.service_date, 'ინვოისის ხაზი');
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_invoice_lines_zlock BEFORE INSERT OR UPDATE OR DELETE ON invoice_line_items FOR EACH ROW EXECUTE FUNCTION fin_lines_lock();

-- ინვოისი: ფინალიზაცია / გახსნა; ქლეიმში შემავალის გახსნა — არა; ამბულატორიის წილი / გადამხდელი დახურულ თვეში — არა
--   (ქლეიმის უარის გადაწყვეტა — emr.fin_resolution = on, ტრანზაქციის ფარგლებში)
CREATE OR REPLACE FUNCTION fin_invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ipd BOOLEAN;
BEGIN
    IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
        IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS NULL THEN
            IF EXISTS (SELECT 1 FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id WHERE ci.invoice_id = OLD.id AND c.status <> 'cancelled') THEN
                RAISE EXCEPTION 'შემთხვევა შედის გადამხდელის ქლეიმში — გახსნამდე ამოიღეთ ქლეიმიდან (ფინანსები → დებიტორები)'
                    USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_in_claim';
            END IF;
            PERFORM fin_assert_open(fin_local_date(OLD.finalized_at), 'ფინალიზებული ინვოისის გახსნა');
        END IF;
        IF NEW.finalized_at IS NOT NULL THEN PERFORM fin_assert_open(fin_local_date(NEW.finalized_at), 'ფინალიზაცია'); END IF;
    END IF;
    IF coalesce(current_setting('emr.fin_resolution', true), '') <> 'on'
       AND (NEW.insurance_share IS DISTINCT FROM OLD.insurance_share OR NEW.state_share IS DISTINCT FROM OLD.state_share
            OR NEW.insurance_payer_id IS DISTINCT FROM OLD.insurance_payer_id OR NEW.state_payer_id IS DISTINCT FROM OLD.state_payer_id) THEN
        v_ipd := EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = NEW.encounter_id);
        IF NOT v_ipd THEN PERFORM fin_assert_open(fin_local_date(OLD.created_at), 'ამბულატორიის ინვოისის გადამხდელის წილი'); END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_fin_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION fin_invoices_guard();

-- პაციენტის გადახდა (paid_at)
CREATE OR REPLACE FUNCTION fin_payments_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM fin_assert_open(fin_local_date(OLD.paid_at), 'პაციენტის გადახდა'); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM fin_assert_open(fin_local_date(NEW.paid_at), 'პაციენტის გადახდა'); END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_payments_fin_lock BEFORE INSERT OR UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION fin_payments_lock();

-- ხარჯების ჟურნალი (expense_date)
CREATE OR REPLACE FUNCTION fin_expenses_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM fin_assert_open(OLD.expense_date, 'ხარჯი'); END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM fin_assert_open(NEW.expense_date, 'ხარჯი'); END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_expenses_fin_lock BEFORE INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION fin_expenses_lock();

-- მომწოდებლის ინვოისი: გატარება / გაუქმება (invoice_date); მონახაზი — თავისუფლად
CREATE OR REPLACE FUNCTION fin_ap_invoices_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN PERFORM fin_assert_open(NEW.invoice_date, 'მომწოდებლის ინვოისი'); END IF;
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN PERFORM fin_assert_open(NEW.invoice_date, 'მომწოდებლის ინვოისი'); END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_ap_invoices_fin_lock BEFORE INSERT OR UPDATE ON ap_invoices FOR EACH ROW EXECUTE FUNCTION fin_ap_invoices_lock();

-- მომწოდებლის გადახდა / კრედიტ-ნოტა (pay_date)
CREATE OR REPLACE FUNCTION fin_ap_payments_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN PERFORM fin_assert_open(NEW.pay_date, 'მომწოდებლის გადახდა'); END IF;
    IF TG_OP = 'UPDATE' AND NEW.is_void IS DISTINCT FROM OLD.is_void THEN PERFORM fin_assert_open(OLD.pay_date, 'მომწოდებლის გადახდის გაუქმება'); END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_ap_payments_fin_lock BEFORE INSERT OR UPDATE ON ap_payments FOR EACH ROW EXECUTE FUNCTION fin_ap_payments_lock();

-- მარაგის მოძრაობა: დოკუმენტის თარიღი და მოძრაობის დღე (რეპორტები — created_at)
CREATE OR REPLACE FUNCTION fin_stock_moves_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_date DATE;
BEGIN
    SELECT d.doc_date INTO v_date FROM stock_docs d WHERE d.id = NEW.doc_id;
    PERFORM fin_assert_open(v_date, 'მარაგის მოძრაობა');
    PERFORM fin_assert_open(fin_local_date(coalesce(NEW.created_at, now())), 'მარაგის მოძრაობა');
    RETURN NEW;
END $$;
CREATE TRIGGER trg_stock_moves_fin_lock BEFORE INSERT ON stock_moves FOR EACH ROW EXECUTE FUNCTION fin_stock_moves_lock();
