-- 0015_roles.sql
-- როლები ბაზაში: როლი = უფლებების (capabilities) ნაკრები; მომხმარებელს — რამდენიმე როლი.
--  • უფლებები — ფიქსირებული კატალოგი (კოდში მოწმდება; ახალი უფლება = ახალი migration)
--  • 14 სისტემური როლი (თითო უფლებით) — იცვლება მხოლოდ დასახელება/აღწერა; admin-ის გათიშვა აკრძალულია
--  • users.role რჩება "ძირითად როლად" (საწყისი გვერდი, ჩვენება); ეფექტური უფლებები = ყველა აქტიური როლის გაერთიანება

CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(40) NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
    name            TEXT NOT NULL,
    description     TEXT,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    capabilities    VARCHAR(30)[] NOT NULL CHECK (
        cardinality(capabilities) > 0 AND capabilities <@ ARRAY[
            'admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager',
            'phlebotomist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse']::VARCHAR(30)[]),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT (code = 'admin' AND NOT is_active))
);
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO roles (code, name, description, is_system, capabilities, sort_order) VALUES
    ('admin',           'ადმინისტრატორი',                    'სრული წვდომა, ადმინისტრირება',                                  TRUE, '{admin}', 10),
    ('doctor',          'ექიმი',                             'ვიზიტები, დანიშნულება, კვლევების შეკვეთა, ფორმა 100',          TRUE, '{doctor}', 20),
    ('nurse',           'ექთანი',                            'ვიტალები, ალერგიები, ნიმუშის აღება',                            TRUE, '{nurse}', 30),
    ('receptionist',    'რეგისტრატორი',                      'პაციენტები, ჩაწერა, ვიზიტები, განრიგი',                          TRUE, '{receptionist}', 40),
    ('billing',         'მოლარე',                            'სალარო, ფასდაკლება, ტარიფები',                                   TRUE, '{billing}', 50),
    ('pharmacist',      'ფარმაცევტი',                        'ალერგენული ჯგუფები, override-ების რეპორტი',                      TRUE, '{pharmacist}', 60),
    ('diagnostic',      'ლაბორანტი',                         'ნიმუშის მიღება, შედეგების შეტანა',                               TRUE, '{diagnostic}', 70),
    ('lab_doctor',      'ლაბორატორიის ექიმი / ხელმძღვანელი', 'ვალიდაცია, ნორმების დამტკიცება',                                 TRUE, '{lab_doctor}', 80),
    ('lab_manager',     'ლაბორატორიის მენეჯერი',             'ანალიზების ფორმები და კატალოგი',                                 TRUE, '{lab_manager}', 90),
    ('phlebotomist',    'ფლებოტომისტი',                      'მხოლოდ ნიმუშის აღება',                                           TRUE, '{phlebotomist}', 100),
    ('radiographer',    'რენტგენ-ტექნიკოსი',                 'რადიოლოგია: მიღება, კვლევის შესრულება',                          TRUE, '{radiographer}', 110),
    ('radiologist',     'რადიოლოგი',                         'რადიოლოგიის დასკვნა, შაბლონები',                                 TRUE, '{radiologist}', 120),
    ('endoscopist',     'ენდოსკოპისტი',                      'ენდოსკოპიის ოქმი, სურათები, ბიოფსია',                           TRUE, '{endoscopist}', 130),
    ('endoscopy_nurse', 'ენდოსკოპიის ექთანი',                'ჩეკლისტი, სედაცია, ენდოსკოპები/დეზინფექცია, ნიმუშები',          TRUE, '{endoscopy_nurse}', 140);

CREATE TABLE user_roles (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     UUID NOT NULL REFERENCES roles(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_role ON user_roles (role_id);

INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.code = u.role;

-- ძირითადი როლი → roles.code (ფიქსირებული CHECK-ის ნაცვლად)
ALTER TABLE users DROP CONSTRAINT chk_users_role;
ALTER TABLE users ADD CONSTRAINT fk_users_role FOREIGN KEY (role) REFERENCES roles(code) ON UPDATE CASCADE;

-- ძირითადი როლი ყოველთვის user_roles-შიც არის
CREATE OR REPLACE FUNCTION ensure_primary_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO user_roles (user_id, role_id) SELECT NEW.id, r.id FROM roles r WHERE r.code = NEW.role ON CONFLICT DO NOTHING;
    RETURN NULL;
END $$;
CREATE TRIGGER trg_users_primary_role AFTER INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION ensure_primary_role();

-- ეფექტური უფლებები (მხოლოდ აქტიური როლებიდან)
CREATE VIEW user_capabilities AS
    SELECT ur.user_id, array_agg(DISTINCT c ORDER BY c)::VARCHAR(30)[] AS capabilities
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.is_active
    CROSS JOIN LATERAL unnest(r.capabilities) AS c
    GROUP BY ur.user_id;
