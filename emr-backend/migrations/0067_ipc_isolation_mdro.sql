-- 0067_ipc_isolation_mdro.sql
-- ინფექციის კონტროლი, ეტაპი 1 — იზოლაცია და რეზისტენტული მიკროორგანიზმები (ბლოკი D, მოდული 2).
--
--  • მოდული `ipc` (ჩართვადი) + უფლებები: infection (სრული), infection_dept (თავისი განყოფილება), infection_view (აგრეგატები — 0070). 36 → 39.
--      შაბლონ-როლი „ინფექციის კონტროლის სპეციალისტი“ (infection + reports_all) — რედაქტირებადი.
--  • იზოლაციის ეპიზოდები (ipc_isolations): ტიპი, მიზეზი, დაწყება / დასრულება, ვინ; ერთ ჰოსპიტალიზაციაზე რამდენიმე ტიპი ერთდროულად.
--      inpatient_stays.isolation რჩება — ავტომატურად = უმკაცრესი აქტიური ტიპი (ტრიგერი), ძველი ეკრანები / API უცვლელია.
--      ჰოსპიტალიზაციის დასრულება (გაწერა / გაუქმება) → აქტიური იზოლაციები ავტომატურად იხურება.
--      ეპიზოდები ყოველთვის იწერება (სტაციონარის ნაწილია); `ipc` მოდულის გამორთვა მალავს ფლაგებს / ცნობარებს / სიას.
--  • ტიპები (ipc_isolation_types): კონტაქტური / გაძლიერებული კონტაქტური (C. diff, CRE) / წვეთოვანი / საჰაერო / დამცავი;
--      ტექსტები (PPE, კარის ნიშანი), ფერი — რედაქტირებადი (infection); ტიპების სია — ფიქსირებული.
--  • MDRO: ტიპები (ipc_mdro_types) + ამოცნობის წესები (ipc_mdro_rules: მიკროორგანიზმი / ჯგუფი + R ანტიბიოტიკ(ებ)ზე / ლაბ. მარკერი);
--      ლაბ. მარკერები იზოლატზე (micro_isolates.markers: ESBL, კარბაპენემაზა, AmpC, MLSb, PBP2a, van);
--      პაციენტის ფლაგი (ipc_patient_flags) — მიკრობიოლოგიის საბოლოო პასუხიდან ავტომატურად (ან შეთავაზებით — პარამეტრი) / ხელით;
--      ფლაგი პაციენტს ეკუთვნის (ხელახალ ვიზიტზეც ჩანს); მოხსნა — ინფექციის კონტროლი, მიზეზით (+ უარყოფითი სკრინინგები).

-- ================================================================ 0. მოდული, უფლებები, როლი
INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('ipc', 'ინფექციის კონტროლი', 'იზოლაცია, რეზისტენტული მიკროორგანიზმები (MDRO) — პაციენტის ფლაგი, ამოცნობის წესები, კარის ნიშანი; HAI შემთხვევები, ანტიბიოტიკები, ანგარიშები (შემდეგი ეტაპები)',
 TRUE, TRUE,
 '{"isolation_remove_mdro": "ipc",
   "ward_conflict": "warn",
   "wristband_symbol": false,
   "door_sign": true,
   "mdro_flag_mode": "auto",
   "mdro_clear_negatives": 3,
   "mdro_suggest_isolation": true,
   "hospital_onset_day": 3,
   "alert_new_flag": true,
   "alert_sms": false,
   "alert_email": false}', 47)
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
        'drg', 'drg_admin',
        'reports', 'reports_all', 'reports_phi',
        'quality', 'quality_dept', 'quality_view',
        'infection', 'infection_dept', 'infection_view']::VARCHAR(30)[]);

INSERT INTO roles (code, name, description, is_system, capabilities, sort_order)
SELECT 'ipc_specialist', 'ინფექციის კონტროლის სპეციალისტი', 'იზოლაცია, MDRO ფლაგები და წესები, HAI შემთხვევები, ანგარიშები; მენეჯერული დაფა (მთელი კლინიკა)', FALSE,
       '{infection,reports_all}', coalesce((SELECT max(sort_order) FROM roles), 0) + 10
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'ipc_specialist');

-- ================================================================ 1. იზოლაციის ტიპები
CREATE TABLE ipc_isolation_types (
    code        VARCHAR(16) PRIMARY KEY CHECK (code IN ('contact', 'contact_plus', 'droplet', 'airborne', 'protective')),
    name        TEXT NOT NULL CHECK (length(trim(name)) >= 2),
    short_name  VARCHAR(12) NOT NULL,                                     -- დაფის ხატულა / სამაჯური
    color       VARCHAR(7) NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    ppe         TEXT NOT NULL DEFAULT '',                                 -- პერსონალის დამცავი აღჭურვილობა (ხაზი = პუნქტი)
    door_text   TEXT NOT NULL DEFAULT '',                                 -- კარის ნიშნის დამატებითი ინსტრუქცია (ხაზი = პუნქტი)
    priority    SMALLINT NOT NULL,                                        -- მეტი = უფრო მკაცრი (inpatient_stays.isolation)
    sort_order  INT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_ipc_iso_types_updated BEFORE UPDATE ON ipc_isolation_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO ipc_isolation_types (code, name, short_name, color, priority, sort_order, ppe, door_text) VALUES
('contact', 'კონტაქტური', 'კონტ.', '#B26B00', 20, 10,
 E'ხელთათმანი — ოთახში შესვლისას\nხალათი — პაციენტთან / გარემოსთან კონტაქტისას\nხელის ჰიგიენა — შესვლამდე და გამოსვლისას',
 E'ინდივიდუალური აღჭურვილობა (სტეტოსკოპი, თერმომეტრი, მანჟეტი)\nზედაპირების დასუფთავება — ყოველდღე\nვიზიტორები — პერსონალთან შეთანხმებით'),
('contact_plus', 'გაძლიერებული კონტაქტური', 'კონტ.+', '#A23B12', 30, 20,
 E'ხელთათმანი და ხალათი — ოთახში შესვლისას ყოველთვის\nხელის ჰიგიენა — საპნით და წყლით (სპირტი C. difficile-ის სპორებზე არ მოქმედებს)',
 E'ქლორის შემცველი სადეზინფექციო ხსნარი\nინდივიდუალური აღჭურვილობა\nცალკე სველი წერტილი, თუ შესაძლებელია'),
('droplet', 'წვეთოვანი', 'წვეთ.', '#1F5FA8', 40, 30,
 E'ქირურგიული ნიღაბი — პაციენტიდან 1–2 მ-ზე\nხელის ჰიგიენა — შესვლამდე და გამოსვლისას',
 E'პაციენტის ტრანსპორტირებისას — ნიღაბი პაციენტზე\nკარი შეიძლება იყოს ღია'),
('airborne', 'საჰაერო (აეროზოლური)', 'საჰაერო', '#B3261E', 50, 40,
 E'რესპირატორი FFP2 / FFP3 (N95) — ოთახში შესვლამდე\nხელის ჰიგიენა — შესვლამდე და გამოსვლისას',
 E'კარი ყოველთვის დახურული\nუარყოფითი წნევის ოთახი, თუ არის\nპაციენტის ტრანსპორტირება — მხოლოდ აუცილებლობისას, ნიღბით'),
('protective', 'დამცავი (იმუნოსუპრესია)', 'დამცავი', '#2E7D4F', 10, 50,
 E'ხელის ჰიგიენა — შესვლამდე\nნიღაბი — რესპირატორული სიმპტომების მქონე პერსონალს / ვიზიტორს',
 E'ცოცხალი ყვავილები და მცენარეები — აკრძალულია\nვიზიტორები — შეზღუდულად; ავადმყოფი ვიზიტორი — არა');

ALTER TABLE inpatient_stays DROP CONSTRAINT inpatient_stays_isolation_check;
ALTER TABLE inpatient_stays ALTER COLUMN isolation TYPE VARCHAR(16);
ALTER TABLE inpatient_stays ADD CONSTRAINT inpatient_stays_isolation_check CHECK (isolation IN ('contact', 'contact_plus', 'droplet', 'airborne', 'protective'));

-- ================================================================ 2. MDRO: ტიპები, წესები, ლაბ. მარკერები
CREATE TABLE ipc_mdro_types (
    code            VARCHAR(16) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,15}$'),
    name            TEXT NOT NULL CHECK (length(trim(name)) >= 2),
    isolation_type  VARCHAR(16) NOT NULL REFERENCES ipc_isolation_types(code),   -- შეთავაზებული იზოლაცია
    urgent          BOOLEAN NOT NULL DEFAULT FALSE,                              -- SMS / ელფოსტა (alert_sms / alert_email)
    expiry_days     INT CHECK (expiry_days IS NULL OR expiry_days BETWEEN 30 AND 3650),   -- NULL — ვადის გარეშე
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_ipc_mdro_types_updated BEFORE UPDATE ON ipc_mdro_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO ipc_mdro_types (code, name, isolation_type, urgent, sort_order) VALUES
('mrsa',  'MRSA — მეთიცილინ-რეზისტენტული S. aureus',            'contact',      FALSE, 10),
('vre',   'VRE — ვანკომიცინ-რეზისტენტული ენტეროკოკი',            'contact',      FALSE, 20),
('esbl',  'ESBL — გაფართოებული სპექტრის β-ლაქტამაზა',            'contact',      FALSE, 30),
('cre',   'CRE / CPE — კარბაპენემ-რეზისტენტული ენტერობაქტერიები', 'contact_plus', TRUE,  40),
('crab',  'CRAB — კარბაპენემ-რეზისტენტული A. baumannii',         'contact_plus', TRUE,  50),
('crpa',  'CRPA — კარბაპენემ-რეზისტენტული P. aeruginosa',        'contact',      FALSE, 60),
('cdiff', 'C. difficile (ტოქსიგენური)',                          'contact_plus', TRUE,  70);

ALTER TABLE micro_isolates ADD COLUMN markers VARCHAR(16)[] NOT NULL DEFAULT '{}'
    CHECK (markers <@ ARRAY['esbl', 'carbapenemase', 'ampc', 'mlsb', 'pbp2a', 'van']::VARCHAR(16)[]);

-- წესი ემთხვევა იზოლატს, თუ: მიკროორგანიზმი ∈ organism_codes ან მისი ჯგუფი ∈ group_codes
--   და (abx_codes ცარიელია ან რომელიმე მათგანზე R) და (marker ცარიელია ან იზოლატს აქვს ეს მარკერი)
CREATE TABLE ipc_mdro_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mdro_code       VARCHAR(16) NOT NULL REFERENCES ipc_mdro_types(code),
    organism_codes  TEXT[] NOT NULL DEFAULT '{}',                -- micro_organisms.code (პატარა ასოებით)
    group_codes     TEXT[] NOT NULL DEFAULT '{}',                -- micro_organisms.group_code (ENT, STA, …)
    abx_codes       TEXT[] NOT NULL DEFAULT '{}',                -- micro_antibiotics.code — რომელიმეზე R
    marker          VARCHAR(16) CHECK (marker IN ('esbl', 'carbapenemase', 'ampc', 'mlsb', 'pbp2a', 'van')),
    note            TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_mdro_rule_target CHECK (cardinality(organism_codes) + cardinality(group_codes) > 0),
    CONSTRAINT chk_mdro_rule_cond CHECK (cardinality(abx_codes) > 0 OR marker IS NOT NULL OR cardinality(organism_codes) > 0)
);
CREATE INDEX idx_ipc_mdro_rules_code ON ipc_mdro_rules (mdro_code);
CREATE TRIGGER trg_ipc_mdro_rules_updated BEFORE UPDATE ON ipc_mdro_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO ipc_mdro_rules (mdro_code, organism_codes, group_codes, abx_codes, marker, note) VALUES
('mrsa',  '{sau}', '{}',    '{OXA,FOX}',     NULL,            'S. aureus — ოქსაცილინი / ცეფოქსიტინი R'),
('mrsa',  '{sau}', '{}',    '{}',            'pbp2a',         'S. aureus — PBP2a / mecA დადებითი'),
('vre',   '{}',    '{ENC}', '{VAN}',         NULL,            'ენტეროკოკი — ვანკომიცინი R'),
('vre',   '{}',    '{ENC}', '{}',            'van',           'ენტეროკოკი — vanA / vanB'),
('esbl',  '{}',    '{ENT}', '{}',            'esbl',          'Enterobacterales — ESBL მარკერი (ლაბ.)'),
('cre',   '{}',    '{ENT}', '{ETP,IPM,MEM}', NULL,            'Enterobacterales — რომელიმე კარბაპენემი R'),
('cre',   '{}',    '{ENT}', '{}',            'carbapenemase', 'Enterobacterales — კარბაპენემაზა (CPE)'),
('crab',  '{aba}', '{}',    '{IPM,MEM}',     NULL,            'A. baumannii — იმიპენემი / მეროპენემი R'),
('crpa',  '{pae}', '{}',    '{IPM,MEM}',     NULL,            'P. aeruginosa — იმიპენემი / მეროპენემი R'),
('cdiff', '{cdi}', '{}',    '{}',            NULL,            'C. difficile — ზრდა / ტოქსინი დადებითი');

-- ================================================================ 3. პაციენტის ფლაგი
CREATE TABLE ipc_patient_flags (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id       UUID NOT NULL REFERENCES patients(id),
    mdro_code        VARCHAR(16) NOT NULL REFERENCES ipc_mdro_types(code),
    status           VARCHAR(10) NOT NULL CHECK (status IN ('suggested', 'active', 'cleared', 'dismissed')),
    source           VARCHAR(10) NOT NULL CHECK (source IN ('micro', 'manual', 'external')),
    onset            VARCHAR(10) CHECK (onset IN ('community', 'hospital', 'unknown')),   -- შეძენის ადგილი (პირველი აღმოჩენით)
    encounter_id     UUID REFERENCES encounters(id),            -- ვიზიტი / ჰოსპიტალიზაცია აღმოჩენისას
    order_item_id    UUID REFERENCES dx_order_items(id),        -- პირველი დადებითი ნიმუში (micro)
    organism_id      UUID REFERENCES micro_organisms(id),
    specimen_at      TIMESTAMPTZ,                               -- ნიმუშის აღების დრო (micro) / გარე პასუხის თარიღი
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by       UUID REFERENCES users(id),                 -- NULL — ავტომატური (მიკრობიოლოგია)
    note             TEXT,
    reviewed_at      TIMESTAMPTZ,                               -- ინფექციის კონტროლმა გადახედა / დაადასტურა
    reviewed_by      UUID REFERENCES users(id),
    cleared_at       TIMESTAMPTZ,
    cleared_by       UUID REFERENCES users(id),
    clear_reason     TEXT,
    clear_negatives  SMALLINT CHECK (clear_negatives BETWEEN 0 AND 20),
    expires_at       TIMESTAMPTZ,
    CONSTRAINT chk_flag_cleared CHECK ((status IN ('cleared', 'dismissed')) = (cleared_at IS NOT NULL)
        AND (cleared_at IS NULL OR length(btrim(coalesce(clear_reason, ''))) >= 3)),
    CONSTRAINT chk_flag_manual CHECK (source = 'micro' OR created_by IS NOT NULL)
);
CREATE UNIQUE INDEX ux_ipc_flag_open ON ipc_patient_flags (patient_id, mdro_code) WHERE status IN ('suggested', 'active');
CREATE INDEX idx_ipc_flags_patient ON ipc_patient_flags (patient_id);
CREATE INDEX idx_ipc_flags_status ON ipc_patient_flags (status, detected_at DESC);

-- ყოველი დადებითი იზოლატი, რომელმაც ფლაგი შექმნა / დაადასტურა (განმეორებითი აღმოჩენაც)
CREATE TABLE ipc_flag_detections (
    id             BIGSERIAL PRIMARY KEY,
    flag_id        UUID NOT NULL REFERENCES ipc_patient_flags(id),
    order_item_id  UUID NOT NULL REFERENCES dx_order_items(id),
    isolate_id     UUID REFERENCES micro_isolates(id) ON DELETE SET NULL,
    organism_id    UUID REFERENCES micro_organisms(id),
    rule_id        UUID REFERENCES ipc_mdro_rules(id),
    specimen_at    TIMESTAMPTZ,
    detected_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_ipc_detection ON ipc_flag_detections (flag_id, order_item_id, organism_id);

-- მიკრობიოლოგიის საბოლოო პასუხები, რომლებიც MDRO-ს წესებით უკვე შემოწმდა (worker — გამოტოვებულის დაჭერა)
CREATE TABLE ipc_micro_scans (
    report_id   UUID PRIMARY KEY REFERENCES micro_reports(id),
    scanned_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    flags       SMALLINT NOT NULL DEFAULT 0
);
-- 0067-მდე გაცემული პასუხები რეტროსპექტულად არ მოწმდება (ძველ პაციენტზე ფლაგს ინფექციის კონტროლი ხელით ამატებს)
INSERT INTO ipc_micro_scans (report_id, scanned_at) SELECT id, issued_at FROM micro_reports WHERE kind = 'final';

-- ================================================================ 4. იზოლაციის ეპიზოდები
CREATE TABLE ipc_isolations (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    type          VARCHAR(16) NOT NULL REFERENCES ipc_isolation_types(code),
    reason        VARCHAR(16) NOT NULL CHECK (reason IN ('mdro', 'suspected', 'confirmed', 'screening', 'immunosuppressed', 'other')),
    reason_text   TEXT,
    flag_id       UUID REFERENCES ipc_patient_flags(id),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_by    UUID REFERENCES users(id),
    ended_at      TIMESTAMPTZ,
    ended_by      UUID REFERENCES users(id),                  -- NULL — ავტომატურად (გაწერა / გაუქმება)
    end_reason    TEXT,
    auto_ended    BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT chk_iso_reason CHECK (reason <> 'mdro' OR flag_id IS NOT NULL),
    CONSTRAINT chk_iso_reason_text CHECK (reason NOT IN ('other', 'suspected', 'confirmed') OR length(btrim(coalesce(reason_text, ''))) >= 2),
    CONSTRAINT chk_iso_end CHECK ((ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL OR ended_at >= started_at)
        AND (ended_at IS NULL OR auto_ended OR ended_by IS NOT NULL))
);
CREATE UNIQUE INDEX ux_ipc_iso_active ON ipc_isolations (encounter_id, type) WHERE ended_at IS NULL;
CREATE INDEX idx_ipc_iso_patient ON ipc_isolations (patient_id, started_at DESC);
CREATE INDEX idx_ipc_iso_active ON ipc_isolations (encounter_id) WHERE ended_at IS NULL;

-- inpatient_stays.isolation = უმკაცრესი აქტიური ტიპი (ძველი ეკრანები / API / სამაჯური)
CREATE OR REPLACE FUNCTION ipc_isolation_sync_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v VARCHAR(16);
BEGIN
    SELECT i.type INTO v FROM ipc_isolations i JOIN ipc_isolation_types t ON t.code = i.type
     WHERE i.encounter_id = NEW.encounter_id AND i.ended_at IS NULL ORDER BY t.priority DESC LIMIT 1;
    UPDATE inpatient_stays SET isolation = v WHERE encounter_id = NEW.encounter_id AND isolation IS DISTINCT FROM v;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_ipc_isolation_sync AFTER INSERT OR UPDATE OF ended_at, type ON ipc_isolations FOR EACH ROW EXECUTE FUNCTION ipc_isolation_sync_trg();

-- ჰოსპიტალიზაცია დასრულდა (გაწერა / გაუქმება) → აქტიური იზოლაციები ავტომატურად იხურება
CREATE OR REPLACE FUNCTION ipc_stay_end_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ipc_isolations SET ended_at = greatest(started_at, coalesce(NEW.ended_at, now())), auto_ended = TRUE,
           end_reason = CASE NEW.status WHEN 'cancelled' THEN 'ჰოსპიტალიზაცია გაუქმდა' ELSE 'გაწერა' END
     WHERE encounter_id = NEW.encounter_id AND ended_at IS NULL;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_ipc_stay_end AFTER UPDATE OF status ON inpatient_stays FOR EACH ROW
    WHEN (OLD.status = 'active' AND NEW.status <> 'active') EXECUTE FUNCTION ipc_stay_end_trg();

-- არსებული აქტიური ჰოსპიტალიზაციების იზოლაცია → ეპიზოდი (მიზეზი „სხვა“, დაწყება = მიღება)
INSERT INTO ipc_isolations (encounter_id, patient_id, type, reason, reason_text, started_at, started_by)
SELECT st.encounter_id, st.patient_id, st.isolation, 'other', 'მიგრაცია (0067) — ჰოსპიტალიზაციისას მითითებული', st.admitted_at, st.admitted_by
  FROM inpatient_stays st WHERE st.status = 'active' AND st.isolation IS NOT NULL;

-- ================================================================ 5. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON ipc_isolations, ipc_patient_flags, ipc_flag_detections, ipc_isolation_types, ipc_mdro_types FROM emr_app;
    REVOKE TRUNCATE ON ipc_mdro_rules FROM emr_app;
  END IF;
END $$;
