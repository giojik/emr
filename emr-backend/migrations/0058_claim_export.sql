-- 0058_claim_export.sql
-- DRG ბლოკი, ეტაპი 4 — გადამხდელის (საყოველთაო / SSA, მზღვეველი) ექსპორტი, პასუხები და უარის მიზეზები, CMI ანგარიში.
--
--  • შაბლონები (claim_templates) — კონფიგურირებადი, კოდის შეცვლის გარეშე:
--      kind = export   — ქლეიმის ფაილი: ფორმატი (xlsx / csv / xml), სვეტები (ველი / მუდმივი, სათაური, ფორმატი, მნიშვნელობების შესაბამისობა),
--                        ფაილის სახელი, თარიღის / ათწილადის ფორმატი, შემთხვევის ტიპები (სტაც. / ამბ.).
--      kind = response — გადამხდელის პასუხის ფაილის წაკითხვა: საიდენტიფიკაციო ველი, სვეტები, სტატუსების შესაბამისობა.
--      ცვლილება ზრდის revision-ს; ექსპორტი ინახავს შაბლონის ასლს (snapshot) — ძველი ფაილი ზუსტად აღდგება.
--      გადამხდელს — ნაგულისხმევი შაბლონები (payers.export_template_id / response_template_id).
--  • ექსპორტის ჟურნალი (fin_claim_exports): ფაილი (bytea), sha256, ხაზები, ჯამი, შაბლონის ვერსია; უცვლელი.
--      ექსპორტი — მხოლოდ გაგზავნილი ქლეიმიდან (მონახაზზე — მხოლოდ გადახედვა); შემოწმება (0057) — scrubber.claim_check.
--  • პასუხი (fin_claim_items.resp_*): მიღებულია / ნაწილობრივ / უარყოფილია / განხილვაში — თანხით და უარის მიზეზით.
--      უარის მიზეზები (denial_reasons) — ცნობარი: კატეგორია, გადამხდელის კოდი (იმპორტისთვის), ნაგულისხმევი გადაწყვეტა (პაციენტზე / ჩამოწერა).
--      პასუხის იმპორტი (fin_claim_response_imports) — ფაილიდან, შაბლონით; ჟურნალი: დაემთხვა / ვერ დაემთხვა.
--      პასუხი თანხას არ ცვლის — ანაზღაურება (0053) და გადაწყვეტა (0053) რჩება; უარზე — გადაწყვეტა მიზეზის ნაგულისხმევი ქმედებით.

-- ================================================================ 1. შაბლონები
CREATE TABLE claim_templates (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(40) NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    kind        VARCHAR(8) NOT NULL CHECK (kind IN ('export', 'response')),
    format      VARCHAR(4) NOT NULL CHECK (format IN ('xlsx', 'csv', 'xml')),
    config      JSONB NOT NULL DEFAULT '{}',
    revision    INT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    notes       TEXT,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  UUID REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_claim_tpl_xml CHECK (kind = 'export' OR format <> 'xml')
);
CREATE TRIGGER trg_claim_templates_updated BEFORE UPDATE ON claim_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payers
    ADD COLUMN export_template_id   UUID REFERENCES claim_templates(id),
    ADD COLUMN response_template_id UUID REFERENCES claim_templates(id);

-- ================================================================ 2. ექსპორტის ჟურნალი
CREATE TABLE fin_claim_exports (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id          UUID NOT NULL REFERENCES fin_claims(id),
    template_id       UUID NOT NULL REFERENCES claim_templates(id),
    template_revision INT NOT NULL,
    template_snapshot JSONB NOT NULL,
    file_name         TEXT NOT NULL,
    content_type      TEXT NOT NULL,
    content           BYTEA NOT NULL,
    sha256            CHAR(64) NOT NULL,
    rows              INT NOT NULL CHECK (rows >= 0),
    total             NUMERIC(12,2) NOT NULL DEFAULT 0,
    scrub_warnings    INT NOT NULL DEFAULT 0,
    note              TEXT,
    created_by        UUID NOT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_fin_claim_exports_claim ON fin_claim_exports (claim_id, created_at DESC);

CREATE OR REPLACE FUNCTION fin_claim_exports_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ექსპორტის ჩანაწერი უცვლელია' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_export_immutable';
END $$;
CREATE TRIGGER trg_fin_claim_exports_immutable BEFORE UPDATE OR DELETE ON fin_claim_exports FOR EACH ROW EXECUTE FUNCTION fin_claim_exports_immutable();

-- ================================================================ 3. უარის მიზეზები
CREATE TABLE denial_reasons (
    code            VARCHAR(20) PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
    title           TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    category        VARCHAR(10) NOT NULL DEFAULT 'other' CHECK (category IN ('clinical', 'coding', 'admin', 'tariff', 'duplicate', 'other')),
    external_codes  TEXT[] NOT NULL DEFAULT '{}',                       -- გადამხდელის კოდები / ტექსტები (იმპორტისას შესაბამისობა)
    default_action  VARCHAR(8) CHECK (default_action IN ('patient', 'writeoff')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO denial_reasons (code, title, category, default_action, sort_order) VALUES
('DOCS',        'დოკუმენტაცია არასრულია / არ არის წარმოდგენილი', 'admin',     NULL,       10),
('GUARANTEE',   'საგარანტიო წერილი არ არის / ვადაგასულია',       'admin',     NULL,       20),
('NOT_COVERED', 'მომსახურება პროგრამით არ ფინანსდება',             'admin',     'patient',  30),
('CODING',      'კოდირების შეცდომა (ICD / NCSP)',                 'coding',    NULL,       40),
('DRG',         'DRG ჯგუფი შეიცვალა',                             'coding',    'writeoff', 50),
('LOS',         'ხანგრძლივობა დაუსაბუთებელია',                    'clinical',  'writeoff', 60),
('MEDICAL',     'სამედიცინო ჩვენება დაუსაბუთებელია',               'clinical',  'writeoff', 70),
('TARIFF',      'ტარიფის / თანხის შეუსაბამობა',                   'tariff',    'writeoff', 80),
('DUPLICATE',   'დუბლიკატი',                                      'duplicate', 'writeoff', 90),
('LATE',        'ვადაგადაცილებული წარდგენა',                       'admin',     'writeoff', 100),
('OTHER',       'სხვა',                                           'other',     NULL,       999);

-- ================================================================ 4. პასუხის იმპორტი
CREATE TABLE fin_claim_response_imports (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id     UUID NOT NULL REFERENCES fin_claims(id),
    template_id  UUID REFERENCES claim_templates(id),
    file_name    TEXT NOT NULL,
    sha256       CHAR(64) NOT NULL,
    rows         INT NOT NULL DEFAULT 0,
    matched      INT NOT NULL DEFAULT 0,
    applied      INT NOT NULL DEFAULT 0,
    problems     JSONB NOT NULL DEFAULT '[]',                           -- ვერ დაემთხვა / შეცდომა: [{row, key, message}]
    created_by   UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_fin_claim_resp_imports_claim ON fin_claim_response_imports (claim_id, created_at DESC);

-- ================================================================ 5. პასუხი შემთხვევაზე
ALTER TABLE fin_claim_items
    ADD COLUMN resp_status    VARCHAR(8) CHECK (resp_status IN ('accepted', 'partial', 'rejected', 'pending')),
    ADD COLUMN resp_amount    NUMERIC(12,2) CHECK (resp_amount >= 0),               -- დამტკიცებული თანხა
    ADD COLUMN resp_reason    VARCHAR(20) REFERENCES denial_reasons(code) ON UPDATE CASCADE,
    ADD COLUMN resp_note      TEXT,
    ADD COLUMN resp_ref       VARCHAR(60),                                          -- გადამხდელის შემთხვევის / წერილის №
    ADD COLUMN resp_at        TIMESTAMPTZ,
    ADD COLUMN resp_by        UUID REFERENCES users(id),
    ADD COLUMN resp_import_id UUID REFERENCES fin_claim_response_imports(id),
    ADD CONSTRAINT fin_claim_item_resp CHECK (
        (resp_status IS NULL AND resp_amount IS NULL AND resp_reason IS NULL AND resp_at IS NULL)
     OR (resp_status = 'pending'  AND resp_amount IS NULL AND resp_at IS NOT NULL)
     OR (resp_status = 'accepted' AND resp_amount = claimed AND resp_at IS NOT NULL)
     OR (resp_status = 'partial'  AND resp_amount > 0 AND resp_amount < claimed AND resp_reason IS NOT NULL AND resp_at IS NOT NULL)
     OR (resp_status = 'rejected' AND resp_amount = 0 AND resp_reason IS NOT NULL AND resp_at IS NOT NULL));
CREATE INDEX idx_fin_claim_items_resp ON fin_claim_items (resp_reason) WHERE resp_reason IS NOT NULL;

-- მონახაზზე პასუხი არ ფიქსირდება (0053-ის დაცვა + პასუხი)
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
    ELSIF TG_OP = 'UPDATE' AND v_st = 'draft' AND (NEW.paid > 0 OR NEW.resolution IS NOT NULL OR NEW.resp_status IS NOT NULL) THEN
        RAISE EXCEPTION 'ქლეიმი ჯერ არ არის გაგზავნილი' USING ERRCODE = 'check_violation', CONSTRAINT = 'fin_claim_not_sent';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- ================================================================ 6. მაგალითი-შაბლონები (შესაცვლელი — ოფიციალური ფორმატი არ არის)
INSERT INTO claim_templates (code, name, kind, format, notes, config) VALUES
('EXAMPLE_EXPORT', 'მაგალითი — ქლეიმის რეესტრი (xlsx)', 'export', 'xlsx',
 'მაგალითია: სვეტები / ფორმატი შეცვალეთ გადამხდელის (SSA) მოთხოვნის მიხედვით.',
 '{"kinds": ["ipd", "opd"], "header_row": true, "total_row": true, "date_format": "DD.MM.YYYY", "decimal_sep": ".", "list_sep": ", ",
   "sheet_name": "რეესტრი", "file_name": "{payer_code}_{claim_no}",
   "columns": [
     {"header": "№", "field": "seq", "width": 5},
     {"header": "პირადი №", "field": "personal_number", "width": 13},
     {"header": "გვარი", "field": "last_name", "width": 16},
     {"header": "სახელი", "field": "first_name", "width": 14},
     {"header": "დაბ. თარიღი", "field": "birth_date", "width": 12},
     {"header": "სქესი", "field": "sex", "map": {"M": "1", "F": "2"}, "width": 6},
     {"header": "ისტორიის №", "field": "adm_no", "width": 12},
     {"header": "შემოსვლა", "field": "admit_date", "width": 12},
     {"header": "გაწერა", "field": "discharge_date", "width": 12},
     {"header": "დღეები", "field": "los", "width": 7},
     {"header": "ძირითადი დიაგნოზი", "field": "pdx_code", "width": 10},
     {"header": "თანმხლები", "field": "sdx_codes", "width": 18},
     {"header": "ოპერაცია (NCSP)", "field": "proc_codes", "width": 16},
     {"header": "DRG", "field": "drg_code", "width": 8},
     {"header": "წონა", "field": "drg_weight", "format": "0.0000", "width": 8},
     {"header": "საგარანტიო №", "field": "guarantee_no", "width": 14},
     {"header": "მოთხოვნილი", "field": "claimed", "format": "0.00", "width": 12}
   ]}'),
('EXAMPLE_RESPONSE', 'მაგალითი — გადამხდელის პასუხი (csv / xlsx)', 'response', 'csv',
 'მაგალითია: სვეტები — სათაურით (ან ასოთი: A, B …); სტატუსების მნიშვნელობები შეცვალეთ გადამხდელის ფაილის მიხედვით.',
 '{"header_row": true, "csv_sep": ";", "decimal_sep": ".", "key_field": "invoice_number", "amount_kind": "approved",
   "columns": {"key": "ინვოისი", "status": "სტატუსი", "amount": "დამტკიცებული", "reason": "მიზეზი", "note": "შენიშვნა", "ref": "№"},
   "status_map": {"accepted": ["მიღებულია", "accepted", "1"], "partial": ["ნაწილობრივ", "partial", "2"], "rejected": ["უარყოფილია", "rejected", "0"], "pending": ["განხილვაში", "pending"]}}');

DO $$
BEGIN
    REVOKE TRUNCATE ON claim_templates, fin_claim_exports, fin_claim_response_imports, denial_reasons FROM emr_app;
    REVOKE DELETE ON fin_claim_exports, fin_claim_response_imports FROM emr_app;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
