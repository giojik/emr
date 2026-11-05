-- 0091_er_billing.sql
-- გადაუდებელი დახმარება (ER), ეტაპი 4 / 5 — ბილინგი, სამუშაო სიები, ER-ის ჯობები (KPI / ანგარიშები — 0092).
--
--  • er_fee_rules — ER-ის მომსახურების ტარიფის წესები (fee_mode): visit — ვიზიტზე; level — ტრიაჟის დონით (სკალა × დონე);
--    time_band — ER-ში ყოფნის ზოლი (from_min ≤ LOS < to_min); time_hour — ბოლო ზოლის შემდეგ ყოველი დაწყებული საათი (from_min-დან).
--    department_id — ER-ის კონკრეტული განყოფილების წესი (NULL — ყველა); ფასი — სატარიფო ფენიდან (tariff_line_price).
--  • invoice_line_items.er_fee_rule_id — ER-ის ტარიფის ხაზი (სინქრონიზაცია / გაუქმება); moved_from_invoice_id — ER-იდან სტაციონარში
--    გადატანილი ხაზი (admit_invoice = merge / ask); invoices.merged_into_invoice_id — ER-ის ინვოისი, რომლის ხაზები გადავიდა.
--  • er_dispositions.invoice_merge / er_admit_requests.invoice_merge — გადაწყვეტილება (ask-ზე — შემთხვევაზე).
--  • er_reminders_sent — ER-ის ჯობის შეხსენებების ჟურნალი (ერთი ჩანაწერი + ეტაპი ერთხელ; გამეორება — ეტაპის ნომრით).
--  • service_tariffs ER-VISIT (ფასი 0 — admin ადგენს) + წესი visit; ER-ის პარამეტრები (0091) — ნაგულისხმევი ემატება, არსებული არ იცვლება.

-- ================================================================ 1. ტარიფის წესები
CREATE TABLE er_fee_rules (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('visit', 'level', 'time_band', 'time_hour')),
    department_id  UUID REFERENCES departments(id),
    scale_code     VARCHAR(20),
    level          SMALLINT,
    from_min       INT CHECK (from_min IS NULL OR from_min BETWEEN 0 AND 20160),
    to_min         INT CHECK (to_min IS NULL OR to_min BETWEEN 1 AND 20160),
    tariff_id      UUID NOT NULL REFERENCES service_tariffs(id),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    note           TEXT,
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_er_fee_level CHECK ((kind = 'level') = (scale_code IS NOT NULL AND level IS NOT NULL)),
    CONSTRAINT chk_er_fee_band CHECK (kind <> 'time_band' OR (from_min IS NOT NULL AND (to_min IS NULL OR to_min > from_min))),
    CONSTRAINT chk_er_fee_hour CHECK (kind <> 'time_hour' OR (from_min IS NOT NULL AND to_min IS NULL)),
    CONSTRAINT chk_er_fee_plain CHECK (kind NOT IN ('visit', 'level') OR (from_min IS NULL AND to_min IS NULL)),
    FOREIGN KEY (scale_code, level) REFERENCES er_triage_levels (scale_code, level)
);
CREATE UNIQUE INDEX ux_er_fee_rules ON er_fee_rules (kind, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(scale_code, ''), coalesce(level, 0), coalesce(from_min, -1)) WHERE is_active;
CREATE TRIGGER trg_er_fee_rules_updated_at BEFORE UPDATE ON er_fee_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ================================================================ 2. ინვოისი
ALTER TABLE invoice_line_items
    ADD COLUMN er_fee_rule_id         UUID REFERENCES er_fee_rules(id),
    ADD COLUMN moved_from_invoice_id  UUID REFERENCES invoices(id);
CREATE INDEX idx_invoice_lines_er_fee ON invoice_line_items (invoice_id) WHERE er_fee_rule_id IS NOT NULL;
CREATE INDEX idx_invoice_lines_moved ON invoice_line_items (moved_from_invoice_id) WHERE moved_from_invoice_id IS NOT NULL;
ALTER TABLE invoices ADD COLUMN merged_into_invoice_id UUID REFERENCES invoices(id);

ALTER TABLE er_dispositions ADD COLUMN invoice_merge BOOLEAN;
ALTER TABLE er_admit_requests ADD COLUMN invoice_merge BOOLEAN;

-- ================================================================ 3. შეხსენებების ჟურნალი
CREATE TABLE er_reminders_sent (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind        VARCHAR(20) NOT NULL CHECK (kind IN ('verbal', 'stat', 'consult', 'admit_wait', 'retriage', 'doc_close')),
    ref_id      UUID NOT NULL,
    stage       VARCHAR(20) NOT NULL,
    recipients  INT NOT NULL DEFAULT 0,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (kind, ref_id, stage)
);
CREATE INDEX idx_er_reminders_sent_at ON er_reminders_sent (sent_at);

-- ================================================================ 4. ტარიფი + ნაგულისხმევი წესი
INSERT INTO service_tariffs (code, title, base_price) VALUES ('ER-VISIT', 'გადაუდებელი დახმარება — ვიზიტი', 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO er_fee_rules (kind, tariff_id, note)
SELECT 'visit', id, 'ნაგულისხმევი (0091): ფასი — ტარიფებში' FROM service_tariffs WHERE code = 'ER-VISIT'
  AND NOT EXISTS (SELECT 1 FROM er_fee_rules WHERE kind = 'visit');

-- ================================================================ 5. პარამეტრები
UPDATE system_modules SET settings = '{
    "fee_mode": "visit",
    "fee_at": "departure",
    "fee_level_basis": "last",
    "fee_exempt": ["lwbs"],
    "admit_invoice": "merge",
    "admit_fee": "charge",
    "invoice_close": "departure",
    "unpaid_check": "info",
    "payer_at_registration": "optional",
    "reminders": {"verbal": true, "stat": true, "consult": true, "admit_wait": true, "retriage": true, "doc_close": true},
    "remind_repeat_min": 0,
    "admit_wait_min": 60,
    "doc_close_warn_h": 2,
    "wl_to": {"er_verbal": "ordering", "er_stat": "nurses", "er_admit_req": "doctors", "er_retriage": "triage", "er_doc_open": "attending", "er_unpaid": "billing_reception"}
}'::jsonb || settings
WHERE code = 'er';

UPDATE system_modules SET description = 'ER: რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი (ESI / MTS / საკუთარი), დაფა / TV, ადგილები; ჩანაწერი, დიაგნოსტიკა, კონსულტაცია; დანიშვნა / მიცემა / ჩამოწერა; გამოსავალი (გაწერა / ჰოსპიტალიზაცია / გადაყვანა / AMA / LWBS / გარდაცვალება), ER-ის ფურცელი; ბილინგი (ტარიფი, ინვოისის დახურვა / გაერთიანება), სამუშაო სიები, შეხსენებები'
WHERE code = 'er';
