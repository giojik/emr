-- 0010_patient_address_files_consents.sql
-- 1) სტრუქტურირებული მისამართი (ქალაქი/მუნიციპალიტეტი → თბილისის რაიონი / სოფელი → ქუჩა)
-- 2) პაციენტის დოკუმენტები (სკანები) — MinIO-ში, მხოლოდ ავტორიზებული წვდომით
-- 3) თანხმობების რეესტრი: ტიპები, ვერსიები, ხელმოწერა (ქაღალდი+სკანი / ელექტრონული)

-- ---------------------------------------------------------------- 1. მისამართი
CREATE TABLE address_units (
    code         VARCHAR(40) PRIMARY KEY,
    name         TEXT NOT NULL,
    type         VARCHAR(20) NOT NULL CHECK (type IN ('city', 'municipality', 'district')),
    parent_code  VARCHAR(40) REFERENCES address_units(code),
    region       TEXT NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO address_units (code, name, type, parent_code, region) VALUES
  ('TBILISI', 'თბილისი', 'city', NULL, 'თბილისი'),
  ('BATUMI', 'ბათუმი', 'city', NULL, 'აჭარის ა/რ'),
  ('KEDA', 'ქედა', 'municipality', NULL, 'აჭარის ა/რ'),
  ('KOBULETI', 'ქობულეთი', 'municipality', NULL, 'აჭარის ა/რ'),
  ('SHUAKHEVI', 'შუახევი', 'municipality', NULL, 'აჭარის ა/რ'),
  ('KHELVACHAURI', 'ხელვაჩაური', 'municipality', NULL, 'აჭარის ა/რ'),
  ('KHULO', 'ხულო', 'municipality', NULL, 'აჭარის ა/რ'),
  ('OZURGETI', 'ოზურგეთი', 'municipality', NULL, 'გურია'),
  ('LANCHKHUTI', 'ლანჩხუთი', 'municipality', NULL, 'გურია'),
  ('CHOKHATAURI', 'ჩოხატაური', 'municipality', NULL, 'გურია'),
  ('KUTAISI', 'ქუთაისი', 'city', NULL, 'იმერეთი'),
  ('BAGHDATI', 'ბაღდათი', 'municipality', NULL, 'იმერეთი'),
  ('VANI', 'ვანი', 'municipality', NULL, 'იმერეთი'),
  ('ZESTAPONI', 'ზესტაფონი', 'municipality', NULL, 'იმერეთი'),
  ('TERJOLA', 'თერჯოლა', 'municipality', NULL, 'იმერეთი'),
  ('SAMTREDIA', 'სამტრედია', 'municipality', NULL, 'იმერეთი'),
  ('SACHKHERE', 'საჩხერე', 'municipality', NULL, 'იმერეთი'),
  ('TKIBULI', 'ტყიბული', 'municipality', NULL, 'იმერეთი'),
  ('TSKALTUBO', 'წყალტუბო', 'municipality', NULL, 'იმერეთი'),
  ('CHIATURA', 'ჭიათურა', 'municipality', NULL, 'იმერეთი'),
  ('KHARAGAULI', 'ხარაგაული', 'municipality', NULL, 'იმერეთი'),
  ('KHONI', 'ხონი', 'municipality', NULL, 'იმერეთი'),
  ('AKHMETA', 'ახმეტა', 'municipality', NULL, 'კახეთი'),
  ('GURJAANI', 'გურჯაანი', 'municipality', NULL, 'კახეთი'),
  ('DEDOPLISTSKARO', 'დედოფლისწყარო', 'municipality', NULL, 'კახეთი'),
  ('TELAVI', 'თელავი', 'municipality', NULL, 'კახეთი'),
  ('LAGODEKHI', 'ლაგოდეხი', 'municipality', NULL, 'კახეთი'),
  ('SAGAREJO', 'საგარეჯო', 'municipality', NULL, 'კახეთი'),
  ('SIGHNAGHI', 'სიღნაღი', 'municipality', NULL, 'კახეთი'),
  ('KVARELI', 'ყვარელი', 'municipality', NULL, 'კახეთი'),
  ('DUSHETI', 'დუშეთი', 'municipality', NULL, 'მცხეთა-მთიანეთი'),
  ('TIANETI', 'თიანეთი', 'municipality', NULL, 'მცხეთა-მთიანეთი'),
  ('MTSKHETA', 'მცხეთა', 'municipality', NULL, 'მცხეთა-მთიანეთი'),
  ('KAZBEGI', 'ყაზბეგი', 'municipality', NULL, 'მცხეთა-მთიანეთი'),
  ('AMBROLAURI', 'ამბროლაური', 'municipality', NULL, 'რაჭა-ლეჩხუმი და ქვემო სვანეთი'),
  ('LENTEKHI', 'ლენტეხი', 'municipality', NULL, 'რაჭა-ლეჩხუმი და ქვემო სვანეთი'),
  ('ONI', 'ონი', 'municipality', NULL, 'რაჭა-ლეჩხუმი და ქვემო სვანეთი'),
  ('TSAGERI', 'ცაგერი', 'municipality', NULL, 'რაჭა-ლეჩხუმი და ქვემო სვანეთი'),
  ('POTI', 'ფოთი', 'city', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('ABASHA', 'აბაშა', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('ZUGDIDI', 'ზუგდიდი', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('MARTVILI', 'მარტვილი', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('MESTIA', 'მესტია', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('SENAKI', 'სენაკი', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('CHKHOROTSKU', 'ჩხოროწყუ', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('TSALENJIKHA', 'წალენჯიხა', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('KHOBI', 'ხობი', 'municipality', NULL, 'სამეგრელო-ზემო სვანეთი'),
  ('ADIGENI', 'ადიგენი', 'municipality', NULL, 'სამცხე-ჯავახეთი'),
  ('ASPINDZA', 'ასპინძა', 'municipality', NULL, 'სამცხე-ჯავახეთი'),
  ('AKHALKALAKI', 'ახალქალაქი', 'municipality', NULL, 'სამცხე-ჯავახეთი'),
  ('AKHALTSIKHE', 'ახალციხე', 'municipality', NULL, 'სამცხე-ჯავახეთი'),
  ('BORJOMI', 'ბორჯომი', 'municipality', NULL, 'სამცხე-ჯავახეთი'),
  ('NINOTSMINDA', 'ნინოწმინდა', 'municipality', NULL, 'სამცხე-ჯავახეთი'),
  ('RUSTAVI', 'რუსთავი', 'city', NULL, 'ქვემო ქართლი'),
  ('BOLNISI', 'ბოლნისი', 'municipality', NULL, 'ქვემო ქართლი'),
  ('GARDABANI', 'გარდაბანი', 'municipality', NULL, 'ქვემო ქართლი'),
  ('DMANISI', 'დმანისი', 'municipality', NULL, 'ქვემო ქართლი'),
  ('TETRITSKARO', 'თეთრიწყარო', 'municipality', NULL, 'ქვემო ქართლი'),
  ('MARNEULI', 'მარნეული', 'municipality', NULL, 'ქვემო ქართლი'),
  ('TSALKA', 'წალკა', 'municipality', NULL, 'ქვემო ქართლი'),
  ('GORI', 'გორი', 'municipality', NULL, 'შიდა ქართლი'),
  ('KASPI', 'კასპი', 'municipality', NULL, 'შიდა ქართლი'),
  ('KARELI', 'ქარელი', 'municipality', NULL, 'შიდა ქართლი'),
  ('KHASHURI', 'ხაშური', 'municipality', NULL, 'შიდა ქართლი'),
  ('TB_MTATSMINDA', 'მთაწმინდა', 'district', 'TBILISI', 'თბილისი'),
  ('TB_VAKE', 'ვაკე', 'district', 'TBILISI', 'თბილისი'),
  ('TB_SABURTALO', 'საბურთალო', 'district', 'TBILISI', 'თბილისი'),
  ('TB_KRTSANISI', 'კრწანისი', 'district', 'TBILISI', 'თბილისი'),
  ('TB_ISANI', 'ისანი', 'district', 'TBILISI', 'თბილისი'),
  ('TB_SAMGORI', 'სამგორი', 'district', 'TBILISI', 'თბილისი'),
  ('TB_CHUGHURETI', 'ჩუღურეთი', 'district', 'TBILISI', 'თბილისი'),
  ('TB_DIDUBE', 'დიდუბე', 'district', 'TBILISI', 'თბილისი'),
  ('TB_NADZALADEVI', 'ნაძალადევი', 'district', 'TBILISI', 'თბილისი'),
  ('TB_GLDANI', 'გლდანი', 'district', 'TBILISI', 'თბილისი');

ALTER TABLE patients
    ADD COLUMN address_unit_code      VARCHAR(40) REFERENCES address_units(code),   -- ქალაქი / მუნიციპალიტეტი
    ADD COLUMN address_district_code  VARCHAR(40) REFERENCES address_units(code),   -- თბილისის რაიონი
    ADD COLUMN address_village        TEXT,                                          -- სოფელი / დაბა
    ADD COLUMN address_line           TEXT,                                          -- ქუჩა, სახლი, ბინა
    ADD COLUMN address_country        VARCHAR(3);                                    -- უცხოელისთვის
-- patients.address რჩება: სრული მისამართი ტექსტად (ფორმა 100, ძველი ჩანაწერები) — ივსება აპლიკაციიდან
CREATE INDEX idx_patients_village_trgm ON patients USING gin (address_village gin_trgm_ops);

-- ---------------------------------------------------------------- 2. დოკუმენტები
CREATE TABLE patient_files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id      UUID NOT NULL REFERENCES patients(id),
    doc_type        VARCHAR(30) NOT NULL CHECK (doc_type IN
                      ('id_card', 'passport', 'birth_certificate', 'residence_permit', 'consent_scan', 'consent_signed', 'other')),
    file_path       TEXT NOT NULL,
    mime_type       VARCHAR(50) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
    size_bytes      INT NOT NULL CHECK (size_bytes > 0),
    sha256          CHAR(64) NOT NULL,
    original_name   TEXT,
    note            TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,              -- წაშლა არ არის — მხოლოდ დეაქტივაცია
    deactivated_reason TEXT,
    uploaded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_patient_files_patient ON patient_files (patient_id, doc_type);

-- ---------------------------------------------------------------- 3. თანხმობები
CREATE TABLE consent_types (
    code        VARCHAR(40) PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]+$'),
    name        TEXT NOT NULL,
    scope       VARCHAR(20) NOT NULL CHECK (scope IN ('patient', 'encounter')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0
);
-- ტექსტის ყოველი ცვლილება = ახალი ვერსია; ხელმოწერილი თანხმობა კონკრეტულ ვერსიაზეა მიბმული
CREATE TABLE consent_type_versions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type_code     VARCHAR(40) NOT NULL REFERENCES consent_types(code),
    version       INT NOT NULL,
    body_text     TEXT NOT NULL,
    text_approved BOOLEAN NOT NULL DEFAULT FALSE,     -- იურისტის მიერ დამტკიცებული ტექსტი
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (type_code, version)
);

CREATE TABLE patient_consents (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id            UUID NOT NULL REFERENCES patients(id),
    encounter_id          UUID REFERENCES encounters(id),
    type_code             VARCHAR(40) NOT NULL REFERENCES consent_types(code),
    version_id            UUID NOT NULL REFERENCES consent_type_versions(id),
    decision              VARCHAR(10) NOT NULL CHECK (decision IN ('granted', 'refused')),
    method                VARCHAR(12) NOT NULL CHECK (method IN ('paper', 'electronic')),
    signer_type           VARCHAR(20) NOT NULL CHECK (signer_type IN ('patient', 'representative')),
    representative_name   TEXT,
    representative_relation TEXT,
    representative_id_number TEXT,
    file_id               UUID NOT NULL REFERENCES patient_files(id),   -- სკანი ან ელექტრონულად ხელმოწერილი PDF
    signed_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recorded_by           UUID NOT NULL REFERENCES users(id),           -- თანამშრომელი, ვის თანდასწრებითაც მოეწერა
    revoked_at            TIMESTAMPTZ,
    revoke_reason         TEXT,
    revoked_by            UUID REFERENCES users(id),
    CONSTRAINT chk_consent_representative CHECK (
        signer_type = 'patient' OR (representative_name IS NOT NULL AND representative_relation IS NOT NULL)),
    CONSTRAINT chk_consent_revoke CHECK (
        (revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX idx_patient_consents ON patient_consents (patient_id, type_code, signed_at DESC);

-- კლინიკა ირჩევს ხელმოწერის მეთოდებს
ALTER TABLE clinic_settings ADD COLUMN consent_methods TEXT[] NOT NULL DEFAULT ARRAY['paper', 'electronic'];

-- საწყისი ტიპები. ⚠️ ტექსტი — ჩანაცვლების ადგილი; იურისტმა უნდა მოამზადოს და admin-მა ჩასვას.
INSERT INTO consent_types (code, name, scope, sort_order) VALUES
  ('DATA_PROCESSING',      'თანხმობა პერსონალური მონაცემების დამუშავებაზე',             'patient',   10),
  ('DATA_SHARING_CLINICS', 'თანხმობა სამედიცინო ინფორმაციის ხილულობაზე სხვა კლინიკისთვის', 'patient',   20),
  ('SMS_NOTIFICATIONS',    'თანხმობა SMS / შეტყობინებების მიღებაზე',                    'patient',   30),
  ('TREATMENT_INFORMED',   'ინფორმირებული თანხმობა სამედიცინო მომსახურებაზე / მანიპულაციაზე', 'encounter', 40);
INSERT INTO consent_type_versions (type_code, version, body_text)
SELECT code, 1, '[ტექსტი დასამტკიცებელია. თანხმობის სრული ტექსტი უნდა მოამზადოს კლინიკის იურისტმა და ადმინისტრატორმა ჩასვას სისტემაში: ადმინისტრირება → თანხმობები.]'
FROM consent_types;

-- ფაილები და თანხმობები ისტორიაა: აპლიკაცია ვერ წაშლის
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON patient_files, patient_consents, consent_type_versions FROM emr_app;
    REVOKE UPDATE ON consent_type_versions FROM emr_app;
  END IF;
END $$;
