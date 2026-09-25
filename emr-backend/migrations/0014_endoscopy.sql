-- 0014_endoscopy.sql
-- ენდოსკოპია:
--  1) როლები: endoscopist (ოქმი, სურათები, ბიოფსია, ხელმოწერა), endoscopy_nurse (მიღება, ჩეკლისტი, სედაცია, დეზინფექცია, ნიმუშები)
--  2) ოთახები — dx_devices (section='endoscopy', modality 'ES'); ჩაწერა — იგივე მექანიზმი, რაც რადიოლოგიაში
--  3) პროცედურის ჩანაწერი: ჩეკლისტი, სედაცია/მონიტორინგი, ენდოსკოპი, მანიპულაციები, გართულებები, გაღვიძება
--  4) ენდოსკოპების რეესტრი + დეზინფექციის ჟურნალი (მიკვლევადობა)
--  5) სურათები (ატვირთვა / კადრი ვიდეოდან) — დიაგნოსტიკის ნებისმიერ შეკვეთაზე
--  6) ბიოფსია → გარე პათოლოგია: მიმართვა, ქილები, პასუხი (ტექსტი + სკანი), ენდოსკოპისტის გაცნობა
-- ⚠️ საწყისი ოთახები — ნიმუში.

-- ---------------------------------------------------------------- 1) როლები
ALTER TABLE users DROP CONSTRAINT chk_users_role;
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (
    role IN ('admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager', 'phlebotomist',
             'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse'));

-- ---------------------------------------------------------------- 2) ოთახები
INSERT INTO dx_devices (section, name, modalities, room, slot_minutes, sort_order) VALUES
    ('endoscopy', 'ენდოსკოპია 1', '{ES}', NULL, 30, 100),
    ('endoscopy', 'ენდოსკოპია 2', '{ES}', NULL, 30, 110);
UPDATE dx_services SET modality = 'ES' WHERE section = 'endoscopy' AND modality IS NULL;
UPDATE dx_services SET duration_minutes = 45 WHERE code IN ('ENDO_COLON', 'ENDO_BRONCH');
UPDATE dx_services SET prep_instructions = 'უზმოზე: ბოლო კვება კვლევამდე 8 სთ-ით, წყალი — 4 სთ-ით ადრე. ანტიკოაგულანტების მიღების შესახებ აცნობეთ ექიმს წინასწარ. სედაციის შემთხვევაში — თანმხლები პირი, საჭის მართვა იმ დღეს აკრძალულია.' WHERE code = 'ENDO_EGD';
UPDATE dx_services SET prep_instructions = 'ნაწლავის მომზადება ექიმის მიერ მოცემული სქემით (მაკროგოლი). კვლევამდე 3 დღით — უწიდო დიეტა, 1 დღით — მხოლოდ გამჭვირვალე სითხეები. ანტიკოაგულანტების/რკინის პრეპარატების შესახებ აცნობეთ ექიმს. სედაციის შემთხვევაში — თანმხლები პირი.' WHERE code IN ('ENDO_COLON', 'ENDO_SIGM');

-- ---------------------------------------------------------------- 4) ენდოსკოპები და დეზინფექცია
CREATE TABLE endo_scopes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,                     -- მაგ. Olympus GIF-H190 #1
    scope_type      VARCHAR(20) NOT NULL CHECK (scope_type IN ('gastroscope', 'colonoscope', 'duodenoscope', 'bronchoscope', 'cystoscope', 'enteroscope', 'other')),
    serial_number   VARCHAR(60) NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- დეზინფექციის ჟურნალი — მხოლოდ INSERT (შესწორება = ახალი ჩანაწერი)
CREATE TABLE endo_reprocessing (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scope_id        UUID NOT NULL REFERENCES endo_scopes(id),
    method          VARCHAR(10) NOT NULL CHECK (method IN ('aer', 'manual')),   -- ავტომატური სარეცხი მანქანა / ხელით
    machine         TEXT,                               -- AER / ციკლის №
    disinfectant    TEXT,                               -- საშუალება + სერია
    leak_test       BOOLEAN NOT NULL,
    result          VARCHAR(10) NOT NULL CHECK (result IN ('passed', 'failed')),
    note            TEXT,
    performed_by    UUID NOT NULL REFERENCES users(id),
    performed_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_endo_reproc_scope ON endo_reprocessing (scope_id, performed_at DESC);
CREATE TRIGGER trg_endo_reprocessing_immutable BEFORE UPDATE OR DELETE ON endo_reprocessing FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- 3) პროცედურა
CREATE TABLE endo_procedures (
    order_item_id       UUID PRIMARY KEY REFERENCES dx_order_items(id),
    -- ჩეკლისტი (ექთანი, პროცედურამდე)
    consent_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
    fasting_hours       NUMERIC(4,1),
    anticoagulants      VARCHAR(12) CHECK (anticoagulants IN ('none', 'stopped', 'continued')),
    anticoag_note       TEXT,
    allergies_reviewed  BOOLEAN NOT NULL DEFAULT FALSE,
    asa_class           SMALLINT CHECK (asa_class BETWEEN 1 AND 5),
    bowel_prep          VARCHAR(12) CHECK (bowel_prep IN ('excellent', 'good', 'fair', 'poor', 'na')),
    checklist_note      TEXT,
    checklist_by        UUID REFERENCES users(id),
    checklist_at        TIMESTAMPTZ,
    -- სედაცია / ანესთეზია
    sedation_type       VARCHAR(10) CHECK (sedation_type IN ('none', 'topical', 'moderate', 'deep', 'general')),
    sedation_by         TEXT,                           -- ანესთეზიოლოგი / ექიმი (სახელი)
    sedation_drugs      JSONB NOT NULL DEFAULT '[]',    -- [{drug, dose, unit, time}]
    monitoring          JSONB NOT NULL DEFAULT '[]',    -- [{time, hr, spo2, sys, dia}]
    -- პროცედურა
    scope_id            UUID REFERENCES endo_scopes(id),
    scope_used_at       TIMESTAMPTZ,                    -- ენდოსკოპის "გამოყენების" მომენტი (პროცედურის დასრულების აღრიცხვა) — დეზინფექციის კონტროლი
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    extent_reached      TEXT,                           -- მაგ. ბრმა ნაწლავი (სეკუმი), თორმეტგოჯა ნაწლავის II ნაწილი
    withdrawal_minutes  NUMERIC(4,1),
    bbps_score          SMALLINT CHECK (bbps_score BETWEEN 0 AND 9),   -- ბოსტონის შკალა (კოლონოსკოპია)
    interventions       JSONB NOT NULL DEFAULT '[]',    -- [{type, site, details}]
    complications       VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (complications IN ('none', 'minor', 'major')),
    complication_note   TEXT,
    -- გაღვიძება / გაწერა
    recovery_score      SMALLINT CHECK (recovery_score BETWEEN 0 AND 10),  -- Aldrete
    discharged_at       TIMESTAMPTZ,
    nurse_id            UUID REFERENCES users(id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    CHECK (complications = 'none' OR complication_note IS NOT NULL)
);
CREATE INDEX idx_endo_proc_scope ON endo_procedures (scope_id, scope_used_at);
CREATE TRIGGER trg_endo_proc_updated BEFORE UPDATE ON endo_procedures FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- 5) სურათები
CREATE TABLE dx_images (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id       UUID NOT NULL REFERENCES dx_order_items(id),
    file_path           TEXT NOT NULL,
    mime_type           VARCHAR(20) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
    size_bytes          INT NOT NULL,
    sha256              CHAR(64) NOT NULL,
    source              VARCHAR(10) NOT NULL CHECK (source IN ('upload', 'capture')),
    caption             TEXT,
    in_report           BOOLEAN NOT NULL DEFAULT FALSE,   -- ბლანკზე ჩასვმა
    sort_order          INT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,    -- წაშლა არ არის — მხოლოდ დეაქტივაცია
    deactivated_reason  TEXT,
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_dx_images_item ON dx_images (order_item_id, sort_order);

-- ---------------------------------------------------------------- 6) პათოლოგია (გარე)
CREATE SEQUENCE path_request_seq START 1;
CREATE TABLE path_requests (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id       UUID NOT NULL UNIQUE REFERENCES dx_order_items(id),
    patient_id          UUID NOT NULL REFERENCES patients(id),
    request_no          VARCHAR(20) NOT NULL UNIQUE,      -- P26-000001
    external_lab        TEXT,
    clinical_info       TEXT,
    status              VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'resulted', 'cancelled')),
    sent_at             TIMESTAMPTZ,
    sent_by             UUID REFERENCES users(id),
    result_text         TEXT,
    result_file_path    TEXT,
    result_received_at  TIMESTAMPTZ,
    result_entered_by   UUID REFERENCES users(id),
    reviewed_by         UUID REFERENCES users(id),        -- ენდოსკოპისტი გაეცნო
    reviewed_at         TIMESTAMPTZ,
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND external_lab IS NOT NULL)),
    CHECK (status <> 'resulted' OR (result_received_at IS NOT NULL AND (result_text IS NOT NULL OR result_file_path IS NOT NULL)))
);
CREATE INDEX idx_path_requests_status ON path_requests (status, sent_at);
CREATE TRIGGER trg_path_requests_updated BEFORE UPDATE ON path_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE path_specimens (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id          UUID NOT NULL REFERENCES path_requests(id) ON DELETE CASCADE,
    jar_no              SMALLINT NOT NULL CHECK (jar_no BETWEEN 1 AND 30),
    site                TEXT NOT NULL,                    -- ლოკალიზაცია
    pieces              SMALLINT NOT NULL DEFAULT 1 CHECK (pieces BETWEEN 1 AND 50),
    description         TEXT,                             -- მაგ. პოლიპი 8 მმ, ჰოლოდინი
    fixative            TEXT NOT NULL DEFAULT 'ფორმალინი 10%',
    UNIQUE (request_id, jar_no)
);
