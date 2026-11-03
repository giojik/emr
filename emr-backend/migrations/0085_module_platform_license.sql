-- 0085_module_platform_license.sql
-- მოდულური პლატფორმა + ლიცენზია (ეტაპი 1 / 2; 0086 — რბილი კავშირები, frontend, პროფილები, e2e მატრიცა).
--
--  • რეესტრი კოდშია (src/modules/registry.ts: ჯგუფი, მკაცრი / რბილი კავშირები, უფლებები); ბაზაში — მხოლოდ enabled / settings.
--  • ბირთვი (4, არ ითიშება, ლიცენზია არ სჭირდება): core, mpi, encounters, billing.
--  • ახალი ოპციური მოდულები (12): outpatient, ipd_orders, mar, lab, lab_gateway, lab_external, lab_qc, lab_micro,
--      radiology, endoscopy, pharmacy, lab_stock. სულ ოპციური — 29 (er — 0087-ში).
--  • stock / tariffs — აქამდე „არ ითიშება“; ახლა ოპციურია (ფასისა და გადამხდელის ძრავა ბირთვშია).
--  • დანიშნულებების (0042) / MAR-ის (0043) პარამეტრები რჩება inpatient-ის ჩანაწერში (მონაცემი არ გადაიტანება).
--  • აქტიური = ლიცენზიაშია ∧ ადმინმა ჩართო ∧ მკაცრი წინაპირობები აქტიურია. სქემა სრულია, გამორთვა მონაცემს არ შლის.
--  • ლიცენზია: system_install (ინსტალაციის ID, საათის დაცვა), system_licenses (ატვირთვების ისტორია; მიმდინარე = ბოლო არაწაშლილი).
--  • rpt_kpis.module_code — დაფა არააქტიური მოდულის KPI-ს მალავს (NULL — ბირთვი).
--  • ცვლილება ეცნობება backend / worker-ს: pg_notify('emr_modules').

-- ================================================================ 1. მოდულები
ALTER TABLE system_modules ADD COLUMN is_core BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO system_modules (code, name, description, enabled, can_disable, is_core, settings, sort_order) VALUES
('core',        'ბირთვი',                   'ავტორიზაცია / LDAP, მომხმარებლები, როლები, განყოფილებები, აუდიტი, პარამეტრები, მოდულები / ლიცენზია, შეტყობინებები, ფაილები, შაბლონები', TRUE, FALSE, TRUE, '{}', 1),
('mpi',         'პაციენტები',               'პაციენტის რეესტრი, თანხმობები, ფაილები, ალერგიები, ICD-10', TRUE, FALSE, TRUE, '{}', 2),
('encounters',  'შემთხვევები და რეგისტრატურა', 'შემთხვევა, ჩაწერა / რიგი, რეგისტრატურა, დიაგნოზები', TRUE, FALSE, TRUE, '{}', 3),
('billing',     'ბილინგი და სალარო',        'ხაზები, სალარო, გადახდები, ფასისა და გადამხდელის ძრავა, ფასების მარტივი რედაქტირება', TRUE, FALSE, TRUE, '{}', 4),
('outpatient',  'ამბულატორია',              'ვიზიტის დოკუმენტაცია: ვიტალები, რეცეპტი, მიმართვები, დასრულება', TRUE, TRUE, FALSE, '{}', 10),
('ipd_orders',  'დანიშნულებები (სტაციონარი)', 'სტაციონარის დანიშნულებები, ვერიფიკაცია (პარამეტრები — „სტაციონარში“)', TRUE, TRUE, FALSE, '{}', 31),
('mar',         'მედიკამენტის მიცემა (MAR)', 'მიცემის აღრიცხვა, ორმაგი შემოწმება, ბარკოდი (პარამეტრები — „სტაციონარში“)', TRUE, TRUE, FALSE, '{}', 32),
('lab',         'ლაბორატორია',              'ლაბ. ვიზიტი, ნიმუშის აღება, მიღება, შედეგი, ვალიდაცია, პასუხი', TRUE, TRUE, FALSE, '{}', 20),
('lab_gateway', 'ანალიზატორები (gateway)',  'ანალიზატორების კავშირი, ინსტრუმენტების კოდები, მიუბმელი პასუხები', TRUE, TRUE, FALSE, '{}', 21),
('lab_external','გარე ლაბორატორია',          'გაგზავნა გარე ლაბორატორიაში, პასუხი ელფოსტით', TRUE, TRUE, FALSE, '{}', 22),
('lab_qc',      'ლაბ. ხარისხის კონტროლი',    'QC მასალები, Westgard, დარღვევები', TRUE, TRUE, FALSE, '{}', 23),
('lab_micro',   'მიკრობიოლოგია',            'კულტურა, იდენტიფიკაცია, ანტიბიოტიკომგრძნობელობა', TRUE, TRUE, FALSE, '{}', 24),
('radiology',   'რადიოლოგია',               'დაგეგმვა, შესრულება, დასკვნა', TRUE, TRUE, FALSE, '{}', 25),
('endoscopy',   'ენდოსკოპია',               'დაგეგმვა, შესრულება, დასკვნა, ბიოფსია, ენდოსკოპების აღრიცხვა', TRUE, TRUE, FALSE, '{}', 26),
('pharmacy',    'აფთიაქი',                  'მედიკამენტების კატალოგი, კონტროლირებადი საშუალებები', TRUE, TRUE, FALSE, '{}', 36),
('lab_stock',   'ლაბ. მარაგი',              'რეაგენტები, ლოტები, ხარჯვა ტესტზე', TRUE, TRUE, FALSE, '{}', 37);

UPDATE system_modules SET can_disable = TRUE WHERE code IN ('stock', 'tariffs');
UPDATE system_modules SET name = 'საწყობი' WHERE code = 'stock';
UPDATE system_modules SET sort_order = v.s FROM (VALUES
  ('inpatient', 30), ('icu', 33), ('or', 34),
  ('stock', 35), ('procurement', 38), ('cssd', 39), ('asset_register', 40), ('bme', 41),
  ('tariffs', 42), ('finance', 43), ('drg', 44), ('scrubber', 45),
  ('reporting', 50), ('quality', 51), ('ipc', 52), ('roster', 53), ('worklist', 54)) AS v(c, s) WHERE code = v.c;

-- ================================================================ 2. ინსტალაცია / ლიცენზია
CREATE TABLE system_install (
    singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    install_id      UUID NOT NULL DEFAULT uuid_generate_v4(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    /** საათის უკან გადაწევის დაცვა: ეფექტური „ახლა“ = max(now, clock_max_seen) */
    clock_max_seen  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO system_install DEFAULT VALUES;

CREATE TABLE system_licenses (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw          JSONB NOT NULL,
    sha256       CHAR(64) NOT NULL,
    kid          VARCHAR(40) NOT NULL,
    clinic       VARCHAR(200) NOT NULL,
    modules      TEXT[] NOT NULL,
    issued       DATE NOT NULL,
    expires      DATE,                        -- NULL — უვადო
    max_users    INT CHECK (max_users IS NULL OR max_users > 0),
    uploaded_by  UUID REFERENCES users(id),
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_by   UUID REFERENCES users(id),
    removed_at   TIMESTAMPTZ
);
CREATE INDEX idx_system_licenses_current ON system_licenses (uploaded_at DESC) WHERE removed_at IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
        REVOKE INSERT, DELETE, TRUNCATE ON system_install FROM emr_app;
        GRANT SELECT, UPDATE ON system_install TO emr_app;
        REVOKE DELETE, TRUNCATE ON system_licenses FROM emr_app;
        GRANT SELECT, INSERT, UPDATE ON system_licenses TO emr_app;
    END IF;
END
$$;

-- ================================================================ 3. KPI → მოდული
ALTER TABLE rpt_kpis ADD COLUMN module_code VARCHAR(40) REFERENCES system_modules(code);
UPDATE rpt_kpis SET module_code = CASE category
    WHEN 'beds' THEN 'inpatient' WHEN 'bme' THEN 'bme' WHEN 'finance' THEN 'finance' WHEN 'ipc' THEN 'ipc'
    WHEN 'lab' THEN 'lab' WHEN 'or' THEN 'or' WHEN 'quality' THEN 'quality' WHEN 'roster' THEN 'roster'
    WHEN 'stock' THEN 'stock' WHEN 'worklist' THEN 'worklist' ELSE NULL END;
UPDATE rpt_kpis SET module_code = 'lab_external' WHERE code IN ('lab_external_pct', 'lab_ext_cost');

-- ================================================================ 4. ტარიფები: ძრავა — ბირთვი, მოდული — ოპციური
-- მოდული „ტარიფები“ არააქტიურია (ლიცენზია / გამორთვა) → ფასი პირდაპირ რედაქტირდება (backend აყენებს emr.tariffs_inactive = 1)
CREATE OR REPLACE FUNCTION tariff_legacy_guard() RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF coalesce(current_setting('emr.tariffs_inactive', true), '') = '1' THEN RETURN; END IF;
    IF coalesce(tariff_settings()->>'tariff_change_approval', 'off') = 'required' THEN
        RAISE EXCEPTION 'ფასის ცვლილება საჭიროებს დამტკიცებას — ადმინისტრირება → ტარიფები → ცვლილების მოთხოვნა'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'tariff_approval_required';
    END IF;
END $$;
