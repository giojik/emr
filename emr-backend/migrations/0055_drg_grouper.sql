-- 0055_drg_grouper.sql
-- DRG ბლოკი, ეტაპი 1 — DRG grouper (დაჯგუფება). ახალი მოდული „drg“ (ადმინისტრირება → მოდულები → DRG).
--
--  პრინციპი: კოდში მხოლოდ ძრავაა; სახელმწიფო სტანდარტი (ჯგუფები, წონები, კოდების სიები, CC/MCC, დაჯგუფების წესები)
--  მთლიანად კონფიგურაციაა, რომელსაც ფინანსური სამსახური ადმინისტრირებიდან მართავს (drg_admin).
--
--  • სქემა (drg_schemes) — სტანდარტების ოჯახი (მაგ. „SSA — საყოველთაო ჯანდაცვა“); გადამხდელი მიებმება სქემას (payers.drg_scheme_id;
--      NULL — ნაგულისხმევი სქემა).
--  • ვერსია (drg_versions) — მოქმედებს თარიღიდან (valid_from); სტატუსი: draft (რედაქტირდება) → active (უცვლელი) → retired.
--      შემთხვევაზე მოქმედებს სქემის active ვერსია, რომლის valid_from ≤ საბაზისო თარიღი (გაწერის / მიღების — მოდულის პარამეტრი).
--      ცვლილება აქტიურ ვერსიაში — მხოლოდ ახალი ვერსიით (ასლი → draft → გააქტიურება).
--  • ვერსიის შემადგენლობა (მხოლოდ draft-ში იცვლება — trigger):
--      drg_version_groups — ჯგუფები: კოდი, დასახელება, წონა, საშუალო ხანგრძლივობა, დღეების ზღვრები (low / high trim), MDC, ტიპი;
--      drg_code_lists + drg_code_list_items — კოდების დასახელებული სიები (დიაგნოზი / პროცედურა / მომსახურება):
--        ჩანაწერი = კოდის დასაწყისი („K35“ ფარავს K35, K35.8 …) ან დიაპაზონი („K35-K37“); წერტილი არ ითვლება;
--      drg_cc — თანმხლები დიაგნოზის სიმძიმე (CC / MCC) + გამონაკლისი ძირითადი დიაგნოზები;
--      drg_rules — დაჯგუფების წესები: რიგით (seq), პირველი შესაბამისი იძლევა ჯგუფს; პირობები (JSONB) — ყველა უნდა სრულდებოდეს.
--  • შედეგი შემთხვევაზე (stay_drg): შეთავაზება ცოცხლად ითვლება; ბილინგი ადასტურებს ან ცვლის (მიზეზით); შენახულია შემავალი
--      მონაცემების ასლი, ჰეში და „რატომ“ (trace). დადასტურებისას DRG რეჟიმის გადამხდელს ეწერება კოდი და ვერსიის წონა.
--  • ფინალიზაცია: DRG გადამხდელზე (მოქმედი ვერსიით) — დადასტურება სავალდებულო (confirm_required); მონაცემების შეცვლის შემდეგ —
--      recheck_on_finalize (block / warn / off).
--  • უფლებები: drg (დადასტურება / შეცვლა), drg_admin (კონფიგურაცია, ვერსიები). 28 → 30.

-- ================================================================ 0. მოდული, უფლებები
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('drg', 'DRG', 'DRG დაჯგუფება: სქემები და ვერსიები (ჯგუფები, წონები, კოდების სიები, CC/MCC, წესები), შემთხვევის შეთავაზება და დადასტურება',
 TRUE, TRUE,
 '{"version_date_basis": "discharge",
   "confirm_required": true,
   "recheck_on_finalize": "block",
   "manual_payer_drg": "allowed",
   "version_approval": "off"}', 43)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE roles DROP CONSTRAINT roles_capabilities_check;
ALTER TABLE roles ADD CONSTRAINT roles_capabilities_check CHECK (
    capabilities <@ ARRAY[
        'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
        'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse',
        'accountant', 'manager', 'hr', 'med_engineer', 'viewer',
        'storekeeper', 'stock_manager',
        'or_schedule', 'anesthesiologist', 'or_nurse',
        'procurement', 'procurement_approve',
        'tariffs', 'tariffs_approve',
        'drg', 'drg_admin']::VARCHAR(30)[]);

CREATE OR REPLACE FUNCTION drg_settings() RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT settings FROM system_modules WHERE code = 'drg'), '{}'::jsonb)
$$;

-- ================================================================ 1. სქემები
CREATE TABLE drg_schemes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{1,19}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    notes       TEXT,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_drg_scheme_default CHECK (NOT (is_default AND NOT is_active))
);
CREATE UNIQUE INDEX ux_drg_scheme_default ON drg_schemes (is_default) WHERE is_default;
CREATE TRIGGER trg_drg_schemes_updated BEFORE UPDATE ON drg_schemes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO drg_schemes (code, name, notes, is_default) VALUES
('SSA', 'საყოველთაო ჯანდაცვა (SSA)', 'ნაგულისხმევი სქემა — გადამხდელი, რომელსაც სქემა არ აქვს მითითებული, ამ სქემით ჯგუფდება', TRUE);

ALTER TABLE payers ADD COLUMN drg_scheme_id UUID REFERENCES drg_schemes(id);

-- ================================================================ 2. ვერსიები
CREATE TABLE drg_versions (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheme_id          UUID NOT NULL REFERENCES drg_schemes(id),
    version_no         INT NOT NULL CHECK (version_no > 0),
    label              TEXT NOT NULL CHECK (length(btrim(label)) >= 2),
    valid_from         DATE NOT NULL,
    status             VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
    -- ძრავის პარამეტრები (ვალიდაცია — backend): los_basis, age_basis, pdx_source, cc_sources, cc_exclude_same_category,
    --   cc_count_to_mcc, proc_sources, or_statuses, vent_kinds, fallback_code
    settings           JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
    notes              TEXT,
    source_version_id  UUID REFERENCES drg_versions(id),                   -- ასლი რომელი ვერსიიდან
    created_by         UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by         UUID REFERENCES users(id),                          -- ბოლო ცვლილება (შემადგენლობაც) — დამტკიცებისთვის
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_by       UUID REFERENCES users(id),
    activated_at       TIMESTAMPTZ,
    retired_by         UUID REFERENCES users(id),
    retired_at         TIMESTAMPTZ,
    retire_reason      TEXT,
    UNIQUE (scheme_id, version_no),
    CONSTRAINT chk_drg_v_active  CHECK (status = 'draft' OR activated_at IS NOT NULL),
    CONSTRAINT chk_drg_v_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
-- ერთ სქემაში ერთ თარიღზე — ერთი აქტიური ვერსია
CREATE UNIQUE INDEX ux_drg_version_active_from ON drg_versions (scheme_id, valid_from) WHERE status = 'active';
CREATE INDEX idx_drg_versions_scheme ON drg_versions (scheme_id, status, valid_from DESC);

-- მოქმედი ვერსია სქემაზე თარიღისთვის
CREATE OR REPLACE FUNCTION drg_version_at(p_scheme UUID, p_date DATE) RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT id FROM drg_versions WHERE scheme_id = p_scheme AND status = 'active' AND valid_from <= p_date ORDER BY valid_from DESC LIMIT 1
$$;

-- შემადგენლობა იცვლება მხოლოდ draft ვერსიაში
CREATE OR REPLACE FUNCTION drg_version_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_status TEXT;
BEGIN
    v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
    SELECT status INTO v_status FROM drg_versions WHERE id = v_id;
    -- NULL: ვერსია იშლება (მონახაზის წაშლა — cascade) → დასაშვებია
    IF v_status IN ('active', 'retired') THEN
        RAISE EXCEPTION 'DRG ვერსია % არ არის მონახაზი — ცვლილება მხოლოდ ახალ ვერსიაში', v_id USING ERRCODE = 'check_violation', CONSTRAINT = 'drg_version_locked';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.version_id <> OLD.version_id THEN
        RAISE EXCEPTION 'ვერსიის შეცვლა დაუშვებელია' USING ERRCODE = 'check_violation', CONSTRAINT = 'drg_version_locked';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- ================================================================ 3. ჯგუფები (ვერსიაში)
CREATE TABLE drg_version_groups (
    version_id  UUID NOT NULL REFERENCES drg_versions(id) ON DELETE CASCADE,
    code        VARCHAR(20) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]{0,19}$'),
    title       TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    weight      NUMERIC(8,4) NOT NULL CHECK (weight > 0),
    alos        NUMERIC(5,1) CHECK (alos > 0),                         -- საშუალო ხანგრძლივობა (დღე)
    los_low     SMALLINT CHECK (los_low >= 0),                         -- ქვედა ზღვარი (low trim) — 0056-ის outlier-ისთვის
    los_high    SMALLINT CHECK (los_high > 0),                         -- ზედა ზღვარი (high trim)
    mdc         VARCHAR(10),
    kind        VARCHAR(10) NOT NULL DEFAULT 'medical' CHECK (kind IN ('medical', 'surgical', 'other')),
    notes       TEXT,
    PRIMARY KEY (version_id, code),
    CONSTRAINT chk_drg_g_trim CHECK (los_low IS NULL OR los_high IS NULL OR los_low <= los_high)
);
CREATE TRIGGER trg_drg_groups_guard BEFORE INSERT OR UPDATE OR DELETE ON drg_version_groups FOR EACH ROW EXECUTE FUNCTION drg_version_guard();

-- ================================================================ 4. კოდების სიები (ვერსიაში)
CREATE TABLE drg_code_lists (
    version_id  UUID NOT NULL REFERENCES drg_versions(id) ON DELETE CASCADE,
    code        VARCHAR(40) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    title       TEXT NOT NULL CHECK (length(btrim(title)) >= 2),
    kind        VARCHAR(8) NOT NULL CHECK (kind IN ('dx', 'proc', 'service')),
    notes       TEXT,
    PRIMARY KEY (version_id, code)
);
CREATE TRIGGER trg_drg_lists_guard BEFORE INSERT OR UPDATE OR DELETE ON drg_code_lists FOR EACH ROW EXECUTE FUNCTION drg_version_guard();

CREATE TABLE drg_code_list_items (
    version_id  UUID NOT NULL,
    list_code   VARCHAR(40) NOT NULL,
    pattern     VARCHAR(50) NOT NULL CHECK (pattern ~ '^[A-Z0-9_]+(-[A-Z0-9_]+)?$'),   -- დასაწყისი ან დიაპაზონი (წერტილის გარეშე, დიდი ასოებით)
    title       TEXT,
    PRIMARY KEY (version_id, list_code, pattern),
    FOREIGN KEY (version_id, list_code) REFERENCES drg_code_lists(version_id, code) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TRIGGER trg_drg_list_items_guard BEFORE INSERT OR UPDATE OR DELETE ON drg_code_list_items FOR EACH ROW EXECUTE FUNCTION drg_version_guard();

-- ================================================================ 5. CC / MCC (ვერსიაში)
CREATE TABLE drg_cc (
    version_id  UUID NOT NULL REFERENCES drg_versions(id) ON DELETE CASCADE,
    pattern     VARCHAR(20) NOT NULL CHECK (pattern ~ '^[A-Z0-9]+(-[A-Z0-9]+)?$'),
    level       VARCHAR(3) NOT NULL CHECK (level IN ('cc', 'mcc')),
    excl_pdx    TEXT[] NOT NULL DEFAULT '{}',                           -- არ ითვლება, თუ ძირითადი დიაგნოზი ემთხვევა (დასაწყისი / დიაპაზონი / @სია)
    notes       TEXT,
    PRIMARY KEY (version_id, pattern)
);
CREATE TRIGGER trg_drg_cc_guard BEFORE INSERT OR UPDATE OR DELETE ON drg_cc FOR EACH ROW EXECUTE FUNCTION drg_version_guard();

-- ================================================================ 6. დაჯგუფების წესები (ვერსიაში)
CREATE TABLE drg_rules (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id  UUID NOT NULL REFERENCES drg_versions(id) ON DELETE CASCADE,
    seq         INT NOT NULL CHECK (seq > 0),                            -- რიგი: პირველი შესაბამისი მოქმედებს
    drg_code    VARCHAR(20) NOT NULL,
    label       TEXT,
    conditions  JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),   -- [{f, op, v}] — ყველა (AND); ვალიდაცია — backend
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    notes       TEXT,
    FOREIGN KEY (version_id, drg_code) REFERENCES drg_version_groups(version_id, code) ON UPDATE CASCADE
);
CREATE INDEX idx_drg_rules_version ON drg_rules (version_id, seq);
CREATE TRIGGER trg_drg_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON drg_rules FOR EACH ROW EXECUTE FUNCTION drg_version_guard();

-- ================================================================ 7. შედეგი შემთხვევაზე
CREATE TABLE stay_drg (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id     UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    scheme_id        UUID NOT NULL REFERENCES drg_schemes(id),
    version_id       UUID NOT NULL REFERENCES drg_versions(id),
    inputs           JSONB NOT NULL,                                     -- შემავალი მონაცემების ასლი (დიაგნოზები, პროცედურები, ასაკი, დღეები …)
    inputs_hash      VARCHAR(64) NOT NULL,
    suggested_code   VARCHAR(20),                                        -- NULL — ვერ დაჯგუფდა
    suggested_rule_id UUID REFERENCES drg_rules(id),
    trace            JSONB NOT NULL DEFAULT '{}',
    status           VARCHAR(10) NOT NULL CHECK (status IN ('confirmed', 'overridden')),
    final_code       VARCHAR(20) NOT NULL,
    final_weight     NUMERIC(8,4) NOT NULL CHECK (final_weight > 0),
    reason           TEXT,
    confirmed_by     UUID NOT NULL REFERENCES users(id),
    confirmed_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_at    TIMESTAMPTZ,
    superseded_by    UUID REFERENCES users(id),
    supersede_reason TEXT,
    FOREIGN KEY (version_id, final_code) REFERENCES drg_version_groups(version_id, code),
    CONSTRAINT chk_stay_drg_override CHECK (status <> 'overridden' OR length(btrim(coalesce(reason, ''))) >= 5)
);
CREATE UNIQUE INDEX ux_stay_drg_current ON stay_drg (encounter_id, scheme_id) WHERE superseded_at IS NULL;
CREATE INDEX idx_stay_drg_version ON stay_drg (version_id);

-- გადამხდელის DRG: საიდან მოვიდა კოდი (ხელით / grouper-იდან) და რომელი ვერსიის წონაა
ALTER TABLE stay_payers
    ADD COLUMN drg_source     VARCHAR(8) CHECK (drg_source IN ('manual', 'grouper')),
    ADD COLUMN drg_version_id UUID REFERENCES drg_versions(id),
    ADD COLUMN stay_drg_id    UUID REFERENCES stay_drg(id);
UPDATE stay_payers SET drg_source = 'manual' WHERE mode = 'drg' AND drg_code IS NOT NULL;

-- ჰოსპიტალიზაციის ისტორია: DRG-ის დადასტურება / გაუქმება
ALTER TABLE inpatient_events DROP CONSTRAINT inpatient_events_kind_check;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_events_kind_check CHECK (kind IN (
    'admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled', 'bed_cleaned', 'bed_blocked',
    'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled', 'planned_sms', 'wristband',
    'transfer_requested', 'transfer_accepted', 'transfer_rejected', 'transfer_cancelled', 'transfer_overdue', 'leave_started', 'leave_returned',
    'leave_overdue', 'discharged', 'discharge_cancelled', 'death', 'body_released', 'closed', 'epicrisis_created', 'epicrisis_signed',
    'epicrisis_cosigned', 'epicrisis_reopened', 'orders_stopped', 'mar_missed', 'news2_alert', 'line_inserted', 'line_removed', 'handover',
    'note_signed', 'note_amended', 'consult_requested', 'consult_answered', 'consult_cancelled', 'form100_issued', 'billing_package', 'payer_added',
    'payer_cancelled', 'deposit', 'deposit_refund', 'deposit_voided', 'billing_finalized', 'billing_reopened', 'icu_in', 'icu_out', 'icu_interval',
    'vent_started', 'vent_ended', 'icu_score', 'or_requested', 'or_scheduled', 'or_cancelled', 'or_started', 'or_completed', 'or_note_signed',
    'or_implant', 'or_pacu_discharged', 'drg_confirmed', 'drg_reset'));

DO $$
BEGIN
    REVOKE TRUNCATE ON drg_schemes, drg_versions, drg_version_groups, drg_code_lists, drg_code_list_items, drg_cc, drg_rules, stay_drg FROM emr_app;
    REVOKE DELETE ON stay_drg FROM emr_app;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
