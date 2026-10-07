-- 0041_ipd_documents_transfer_discharge.sql
-- სტაციონარი, ეტაპი 0041 (გადაწყვეტილებები: EMR_0041_ღია_საკითხები, ყველა რეკომენდაციით).
--
--  ნაწილი A — დოკუმენტების შაბლონები + ეპიკრიზი
--  ნაწილი B — გადაყვანა განყოფილებებს შორის (მიმღების დადასტურებით)
--  ნაწილი C — გაწერა (4 ტიპი), გარდაცვალება, დროებითი გასვლა, ისტორია, მოდულის პარამეტრები
--
-- ნაწილი A:
--  • document_templates / document_template_versions — ერთიანი შაბლონები (თანხმობა, ხელწერილი, ეპიკრიზი);
--    მართავს მხოლოდ admin. ვერსია: draft → published → archived; გამოქვეყნებული ვერსია უცვლელია;
--    ერთ შაბლონს — მაქსიმუმ ერთი published და ერთი draft.
--  • შაბლონის სხეული — ბლოკები (JSONB). ცვლადების whitelist და ბლოკების ვალიდაცია — კოდში (გამოქვეყნებისას).
--  • 0010-ის consent_types / consent_type_versions → გადმოდის ახალ ცხრილებში (ვერსიების id უცვლელია),
--    patient_consents-ის FK-ები გადაებმება, ძველი ცხრილები იშლება.
--  • epicrises — ეპიკრიზის ინსტანსი თითო ჰოსპიტალიზაციაზე: draft → (awaiting_cosign) → signed;
--    შესწორება — ხელახლა გახსნით (მიზეზი), წინა რედაქცია epicrisis_revisions-ში, წინა გაცემული PDF — revoked.

-- ================================================================ 1. შაბლონები
CREATE TABLE document_templates (
    code                  VARCHAR(40) PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]+$'),
    kind                  VARCHAR(20) NOT NULL CHECK (kind IN ('consent', 'refusal', 'epicrisis', 'other')),
    name                  TEXT NOT NULL,
    scope                 VARCHAR(20) NOT NULL CHECK (scope IN ('patient', 'encounter')),   -- ჰოსპიტალიზაცია = მისი encounter
    required_on_admission BOOLEAN NOT NULL DEFAULT FALSE,     -- გაფრთხილება (არა ბლოკი) დაფაზე / ბარათზე / გაწერისას
    is_system             BOOLEAN NOT NULL DEFAULT FALSE,     -- კოდი სისტემაში გამოიყენება (EPICRISIS, SELF_DISCHARGE…) — არ ითიშება
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order            INT NOT NULL DEFAULT 100,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_tpl_required_kind   CHECK (NOT required_on_admission OR kind = 'consent'),
    CONSTRAINT chk_tpl_epicrisis_scope CHECK (kind <> 'epicrisis' OR scope = 'encounter'),
    CONSTRAINT chk_tpl_system_active   CHECK (NOT (is_system AND NOT is_active))
);
CREATE TRIGGER trg_document_templates_updated BEFORE UPDATE ON document_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE document_template_versions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_code  VARCHAR(40) NOT NULL REFERENCES document_templates(code) ON UPDATE CASCADE,
    version        INT NOT NULL CHECK (version > 0),
    status         VARCHAR(12) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    body           JSONB NOT NULL CHECK (jsonb_typeof(body -> 'blocks') = 'array'),
    text_approved  BOOLEAN NOT NULL DEFAULT FALSE,        -- იურისტის მიერ დამტკიცებული (თანხმობა / ხელწერილი)
    change_note    TEXT,
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by   UUID REFERENCES users(id),
    published_at   TIMESTAMPTZ,
    archived_at    TIMESTAMPTZ,
    UNIQUE (template_code, version),
    CONSTRAINT chk_tpl_ver_published CHECK (status = 'draft' OR published_at IS NOT NULL),
    CONSTRAINT chk_tpl_ver_archived  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_tpl_ver_one_published ON document_template_versions (template_code) WHERE status = 'published';
CREATE UNIQUE INDEX ux_tpl_ver_one_draft     ON document_template_versions (template_code) WHERE status = 'draft';

-- გამოქვეყნებული / დაარქივებული ვერსია უცვლელია; დასაშვებია მხოლოდ draft → published → archived
CREATE OR REPLACE FUNCTION tpl_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'draft' AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.text_approved IS DISTINCT FROM OLD.text_approved
                                  OR NEW.version <> OLD.version OR NEW.template_code <> OLD.template_code) THEN
        RAISE EXCEPTION 'გამოქვეყნებული შაბლონის ვერსია არ იცვლება — შექმენით ახალი ვერსია' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD.status = NEW.status)
         OR (OLD.status = 'draft'     AND NEW.status = 'published')
         OR (OLD.status = 'published' AND NEW.status = 'archived')) THEN
        RAISE EXCEPTION 'შაბლონის ვერსიის სტატუსის დაუშვებელი ცვლილება: % → %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_tpl_version_guard BEFORE UPDATE ON document_template_versions FOR EACH ROW EXECUTE FUNCTION tpl_version_guard();

CREATE OR REPLACE FUNCTION tpl_version_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'draft' THEN
        RAISE EXCEPTION 'გამოქვეყნებული შაბლონის ვერსია არ იშლება' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER trg_tpl_version_no_delete BEFORE DELETE ON document_template_versions FOR EACH ROW EXECUTE FUNCTION tpl_version_no_delete();

-- ================================================================ 2. 0010-ის თანხმობების გადმოტანა
INSERT INTO document_templates (code, kind, name, scope, is_active, sort_order)
SELECT code, 'consent', name, scope, is_active, sort_order FROM consent_types;

-- ბოლო ვერსია → published, დანარჩენი → archived. id უცვლელია (patient_consents.version_id ისევ სწორზე მიუთითებს).
INSERT INTO document_template_versions (id, template_code, version, status, body, text_approved, created_by, created_at,
                                        published_by, published_at, archived_at)
SELECT v.id, v.type_code, v.version,
       CASE WHEN v.version = m.max_v THEN 'published' ELSE 'archived' END,
       jsonb_build_object('blocks', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v.body_text))),
       v.text_approved, v.created_by, v.created_at, v.created_by, v.created_at,
       CASE WHEN v.version = m.max_v THEN NULL ELSE v.created_at END
FROM consent_type_versions v
JOIN (SELECT type_code, max(version) AS max_v FROM consent_type_versions GROUP BY type_code) m USING (type_code);

ALTER TABLE patient_consents DROP CONSTRAINT patient_consents_type_code_fkey;
ALTER TABLE patient_consents DROP CONSTRAINT patient_consents_version_id_fkey;
ALTER TABLE patient_consents ADD CONSTRAINT fk_patient_consents_template
    FOREIGN KEY (type_code) REFERENCES document_templates(code) ON UPDATE CASCADE;
ALTER TABLE patient_consents ADD CONSTRAINT fk_patient_consents_version
    FOREIGN KEY (version_id) REFERENCES document_template_versions(id);

-- მხოლოდ consent / refusal; ვერსია უნდა ეკუთვნოდეს იმავე შაბლონს და იყოს გამოქვეყნებული ხელმოწერის მომენტში
CREATE OR REPLACE FUNCTION patient_consent_version_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v RECORD;
BEGIN
    SELECT tv.template_code, tv.status, t.kind INTO v
    FROM document_template_versions tv JOIN document_templates t ON t.code = tv.template_code WHERE tv.id = NEW.version_id;
    IF v.kind NOT IN ('consent', 'refusal') THEN
        RAISE EXCEPTION 'patient_consents — მხოლოდ თანხმობა ან ხელწერილი (და არა %)', v.kind USING ERRCODE = 'check_violation';
    END IF;
    IF v.template_code <> NEW.type_code THEN
        RAISE EXCEPTION 'თანხმობის ვერსია სხვა შაბლონს ეკუთვნის' USING ERRCODE = 'check_violation';
    END IF;
    IF v.status <> 'published' THEN
        RAISE EXCEPTION 'ხელმოწერა შესაძლებელია მხოლოდ გამოქვეყნებულ ვერსიაზე' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_patient_consent_version BEFORE INSERT ON patient_consents FOR EACH ROW EXECUTE FUNCTION patient_consent_version_check();

DROP TABLE consent_type_versions;
DROP TABLE consent_types;

-- ================================================================ 3. სისტემური შაბლონები
-- ჰოსპიტალიზაციის თანხმობა (0040: HOSPITALIZATION) — სავალდებულო მიღებისას (გაფრთხილება, არა ბლოკი)
UPDATE document_templates SET required_on_admission = TRUE WHERE code = 'HOSPITALIZATION';

-- ⚠️ ტექსტები — ჩანაცვლების ადგილი: იურისტი ამზადებს, admin ასწორებს და აქვეყნებს (ადმინისტრირება → დოკუმენტების შაბლონები).
INSERT INTO document_templates (code, kind, name, scope, is_system, required_on_admission, sort_order) VALUES
  ('SELF_DISCHARGE',        'refusal',   'ხელწერილი — სტაციონარის თვითნებური დატოვება / მკურნალობაზე უარი', 'encounter', TRUE,  FALSE, 200),
  ('EPICRISIS',             'epicrisis', 'ეპიკრიზი (ამონაწერი სამედიცინო ბარათიდან, №IV-100/ა სტრუქტურით)', 'encounter', TRUE,  FALSE, 300);

INSERT INTO document_template_versions (template_code, version, status, body, published_at)
VALUES
  ('SELF_DISCHARGE', 1, 'published', jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type', 'text', 'text',
        '[ტექსტი დასამტკიცებელია. მე, {{patient.full_name}} (პირადი № {{patient.id_number}}), ვტოვებ {{clinic.name}}-ის '
        || '{{stay.department}}-ს ექიმის რეკომენდაციის საწინააღმდეგოდ. მკურნალმა ექიმმა ({{stay.attending_doctor}}) ამიხსნა '
        || 'სტაციონარის დატოვების შესაძლო შედეგები; პასუხისმგებლობას ვიღებ საკუთარ თავზე.]'))), CURRENT_TIMESTAMP),
  -- ეპიკრიზი: №IV-100/ა-ს პუნქტები (form100.types.ts); field = ექიმის მიერ შესავსები სექცია (prefill — ცვლადიდან)
  ('EPICRISIS', 1, 'published', jsonb_build_object('blocks', jsonb_build_array(
      jsonb_build_object('type', 'header'),                                                        -- პ.1 დაწესებულება + ნომერი + QR
      jsonb_build_object('type', 'heading', 'text', 'ეპიკრიზი'),
      jsonb_build_object('type', 'patient'),                                                       -- პ.3–7
      jsonb_build_object('type', 'text', 'text',                                                   -- პ.8
        'განყოფილება: {{stay.department}}. ჰოსპიტალიზაცია: {{stay.admitted_at}}. გაწერა: {{stay.discharged_at}} ({{stay.discharge_type}}). საწოლდღე: {{stay.bed_days}}.'),
      jsonb_build_object('type', 'diagnoses', 'which', 'final',     'label', 'საბოლოო კლინიკური დიაგნოზი'),   -- primary + secondary + complication
      jsonb_build_object('type', 'diagnoses', 'which', 'admission', 'label', 'დიაგნოზი შემოსვლისას'),
      jsonb_build_object('type', 'field', 'key', 'past_diseases',      'label', 'გადატანილი დაავადებები',                'required', false),  -- პ.10
      jsonb_build_object('type', 'field', 'key', 'anamnesis',          'label', 'მოკლე ანამნეზი',                        'required', true),   -- პ.11
      jsonb_build_object('type', 'lab_results', 'label', 'ჩატარებული გამოკვლევები — ლაბორატორია'),                                         -- პ.12
      jsonb_build_object('type', 'dx_results',  'label', 'ჩატარებული გამოკვლევები — რადიოლოგია / ენდოსკოპია'),
      jsonb_build_object('type', 'field', 'key', 'investigations',     'label', 'გამოკვლევები — დამატებით',             'required', false),
      jsonb_build_object('type', 'field', 'key', 'course',             'label', 'დაავადების მიმდინარეობა',              'required', true),   -- პ.13
      jsonb_build_object('type', 'field', 'key', 'treatment',          'label', 'ჩატარებული მკურნალობა',                'required', true),   -- პ.14
      jsonb_build_object('type', 'field', 'key', 'state_on_admission', 'label', 'მდგომარეობა შემოსვლისას',             'required', false),  -- პ.15
      jsonb_build_object('type', 'field', 'key', 'state_on_discharge', 'label', 'მდგომარეობა გაწერისას',               'required', true),   -- პ.16
      jsonb_build_object('type', 'field', 'key', 'recommendations',    'label', 'სამკურნალო და შრომითი რეკომენდაციები', 'required', true),   -- პ.17
      jsonb_build_object('type', 'signatures', 'signers', jsonb_build_array('attending', 'department_head'))                               -- პ.18–19
  )), CURRENT_TIMESTAMP);

-- ================================================================ 4. ეპიკრიზი
CREATE TABLE epicrises (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id         UUID NOT NULL UNIQUE REFERENCES inpatient_stays(encounter_id),   -- ერთი თითო ჰოსპიტალიზაციაზე
    patient_id           UUID NOT NULL REFERENCES patients(id),
    template_version_id  UUID NOT NULL REFERENCES document_template_versions(id),
    status               VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'awaiting_cosign', 'signed')),
    revision             INT NOT NULL DEFAULT 1 CHECK (revision > 0),
    content              JSONB NOT NULL DEFAULT '{}'::jsonb,    -- { field_key: text }
    selected_lab_ids     UUID[] NOT NULL DEFAULT '{}',          -- lab_results.id, რომლებიც ეპიკრიზში შედის
    selected_dx_ids      UUID[] NOT NULL DEFAULT '{}',          -- dx_order_items.id (რადიოლოგია / ენდოსკოპია)
    signed_by            UUID REFERENCES users(id),
    signed_at            TIMESTAMPTZ,
    cosigned_by          UUID REFERENCES users(id),
    cosigned_at          TIMESTAMPTZ,
    document_id          UUID REFERENCES generated_documents(id),   -- გაცემული PDF (ნომერი + QR)
    created_by           UUID NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_epi_signed CHECK (status = 'draft' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL)),
    CONSTRAINT chk_epi_final  CHECK (status <> 'signed' OR document_id IS NOT NULL),
    CONSTRAINT chk_epi_draft  CHECK (status <> 'draft' OR (signed_by IS NULL AND cosigned_by IS NULL AND document_id IS NULL)),
    CONSTRAINT chk_epi_cosign CHECK ((cosigned_by IS NULL) = (cosigned_at IS NULL))
);
CREATE INDEX idx_epicrises_patient ON epicrises (patient_id, created_at DESC);
CREATE INDEX idx_epicrises_pending ON epicrises (status) WHERE status <> 'signed';
CREATE TRIGGER trg_epicrises_updated BEFORE UPDATE ON epicrises FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ხელმოწერილი (ან თანახელმოწერის მომლოდინე) ეპიკრიზის შიგთავსი არ იცვლება; შესწორება = ხელახლა გახსნა (status → draft, revision + 1)
CREATE OR REPLACE FUNCTION epicrisis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'draft' AND NEW.status <> 'draft'
       AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.selected_lab_ids IS DISTINCT FROM OLD.selected_lab_ids
            OR NEW.selected_dx_ids IS DISTINCT FROM OLD.selected_dx_ids OR NEW.template_version_id <> OLD.template_version_id) THEN
        RAISE EXCEPTION 'ხელმოწერილი ეპიკრიზი არ რედაქტირდება — გახსენით ხელახლა (მიზეზით)' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'draft' AND NEW.status = 'draft' AND NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'ხელახლა გახსნა: revision უნდა გაიზარდოს' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.encounter_id <> OLD.encounter_id OR NEW.patient_id <> OLD.patient_id THEN
        RAISE EXCEPTION 'ეპიკრიზის მიბმა არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_epicrisis_guard BEFORE UPDATE ON epicrises FOR EACH ROW EXECUTE FUNCTION epicrisis_guard();

-- წინა რედაქციები (ხელახლა გახსნისას — სრული snapshot)
CREATE TABLE epicrisis_revisions (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    epicrisis_id         UUID NOT NULL REFERENCES epicrises(id),
    revision             INT NOT NULL,
    template_version_id  UUID NOT NULL REFERENCES document_template_versions(id),
    content              JSONB NOT NULL,
    selected_lab_ids     UUID[] NOT NULL,
    selected_dx_ids      UUID[] NOT NULL,
    signed_by            UUID NOT NULL REFERENCES users(id),
    signed_at            TIMESTAMPTZ NOT NULL,
    cosigned_by          UUID REFERENCES users(id),
    cosigned_at          TIMESTAMPTZ,
    document_id          UUID REFERENCES generated_documents(id),    -- revoked
    reopened_by          UUID NOT NULL REFERENCES users(id),
    reopened_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reopen_reason        TEXT NOT NULL CHECK (length(trim(reopen_reason)) >= 5),
    UNIQUE (epicrisis_id, revision)
);

-- ================================================================ ნაწილი B — გადაყვანა განყოფილებებს შორის
-- requested → accepted / rejected / cancelled. მოთხოვნის დროს ძველი ეპიზოდი (და საწოლი) ღიაა — პაციენტი ძველ საწოლზეა;
-- მიღებისას ერთ ტრანზაქციაში: ძველი ეპიზოდი იხურება (end_kind = 'transfer'), ძველი საწოლი → დასალაგებელი / თავისუფალი,
-- იქმნება ახალი ეპიზოდი მიმღებ განყოფილებაში (საწოლით — ან მის გარეშე, თუ bed_assign_mode = two_step) + ახალი მკურნალი ექიმი.
-- შიდა გადაადგილება (იმავე განყოფილებაში) — 0040-ის bed_change, ამ ცხრილს არ იყენებს.
CREATE TABLE inpatient_transfers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id        UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    from_assignment_id  BIGINT NOT NULL REFERENCES bed_assignments(id),
    from_department_id  UUID NOT NULL REFERENCES departments(id),
    to_department_id    UUID NOT NULL REFERENCES departments(id),
    reason              TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    status              VARCHAR(10) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'rejected', 'cancelled')),
    requested_by        UUID NOT NULL REFERENCES users(id),
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_by          UUID REFERENCES users(id),
    decided_at          TIMESTAMPTZ,
    decision_reason     TEXT,                                            -- უარყოფა / გაუქმება
    to_assignment_id    BIGINT REFERENCES bed_assignments(id),
    new_attending_id    UUID REFERENCES users(id),
    overdue_notified_at TIMESTAMPTZ,
    CONSTRAINT chk_transfer_departments CHECK (from_department_id <> to_department_id),
    CONSTRAINT chk_transfer_decided     CHECK ((status = 'requested') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)),
    CONSTRAINT chk_transfer_accepted    CHECK (status <> 'accepted' OR (to_assignment_id IS NOT NULL AND new_attending_id IS NOT NULL)),
    CONSTRAINT chk_transfer_reason      CHECK (status NOT IN ('rejected', 'cancelled') OR length(btrim(coalesce(decision_reason, ''))) >= 3)
);
CREATE UNIQUE INDEX ux_inpatient_transfers_open ON inpatient_transfers (encounter_id) WHERE status = 'requested';
CREATE INDEX idx_inpatient_transfers_to ON inpatient_transfers (to_department_id) WHERE status = 'requested';
CREATE INDEX idx_inpatient_transfers_encounter ON inpatient_transfers (encounter_id, requested_at);

-- ================================================================ ნაწილი C — გაწერა
-- გაწერა (status = discharged, ended_at) ≠ შემთხვევის დახურვა (closed_at — დოკუმენტაცია სრულია: ხელმოწერილი ეპიკრიზი + საბოლოო დიაგნოზი).
--   home / other_clinic        — ბლოკი გაწერამდე → closed_at = ended_at
--   against_advice / death     — პაციენტი / საწოლი მაშინვე თავისუფლდება; closed_at — მოგვიანებით („დოკუმენტაცია მოსალოდნელია“)
-- საბოლოო დიაგნოზი = ჰოსპიტალიზაციის encounter_diagnoses: ზუსტად ერთი primary (+ secondary / complication) — ახალი ტიპი არ სჭირდება.
-- გარდაცვალება: საწოლი → blocked („გვამის გატანამდე“), გატანისას → დასალაგებელი; patients.is_deceased — კოდიდან.

-- სხვა კლინიკების ცნობარი (გადაყვანა / გადმოყვანა) — admin ავსებს; თავისუფალი ტექსტიც დასაშვებია
CREATE TABLE external_institutions (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(200) NOT NULL UNIQUE,
    address     TEXT,
    phone       VARCHAR(50),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE inpatient_stays
    ADD COLUMN discharge_type          VARCHAR(16) CHECK (discharge_type IN ('home', 'other_clinic', 'against_advice', 'death')),
    ADD COLUMN discharged_by           UUID REFERENCES users(id),
    ADD COLUMN discharge_note          TEXT,
    ADD COLUMN discharge_overrides     JSONB,                       -- [{code, message}] + reason — გაფრთხილებები, რომლებიც გადალახეს
    ADD COLUMN destination_id          UUID REFERENCES external_institutions(id),
    ADD COLUMN destination_text        TEXT,
    ADD COLUMN transport               VARCHAR(16) CHECK (transport IN ('own', 'ambulance', 'clinic_transport', 'other')),
    ADD COLUMN refusal_consent_id      UUID REFERENCES patient_consents(id),     -- თვითნებური: ხელწერილი (SELF_DISCHARGE)
    ADD COLUMN refusal_witnesses       UUID[],                                     -- ხელმოწერაზე უარი → 2 თანამშრომელი
    ADD COLUMN death_at                TIMESTAMPTZ,
    ADD COLUMN death_icd10_code        VARCHAR(10) REFERENCES icd10_codes(code),
    ADD COLUMN death_icd10_title       TEXT,
    ADD COLUMN autopsy_required        BOOLEAN,
    ADD COLUMN body_released_at        TIMESTAMPTZ,
    ADD COLUMN body_released_by        UUID REFERENCES users(id),
    ADD COLUMN closed_at               TIMESTAMPTZ,
    ADD COLUMN closed_by               UUID REFERENCES users(id),
    ADD CONSTRAINT chk_stay_discharged      CHECK ((status = 'discharged') = (discharge_type IS NOT NULL)
                                                   AND (status = 'discharged') = (discharged_by IS NOT NULL)
                                                   AND (status <> 'discharged' OR ended_at IS NOT NULL)),
    ADD CONSTRAINT chk_stay_closed          CHECK (closed_at IS NULL OR (status = 'discharged' AND closed_by IS NOT NULL AND closed_at >= ended_at)),
    ADD CONSTRAINT chk_stay_closed_regular  CHECK (discharge_type IS NULL OR discharge_type NOT IN ('home', 'other_clinic') OR closed_at IS NOT NULL),
    ADD CONSTRAINT chk_stay_other_clinic    CHECK (discharge_type IS DISTINCT FROM 'other_clinic'
                                                   OR destination_id IS NOT NULL OR length(btrim(coalesce(destination_text, ''))) >= 3),
    ADD CONSTRAINT chk_stay_against_advice  CHECK (discharge_type IS DISTINCT FROM 'against_advice'
                                                   OR refusal_consent_id IS NOT NULL OR cardinality(coalesce(refusal_witnesses, '{}')) >= 2),
    ADD CONSTRAINT chk_stay_death           CHECK ((discharge_type = 'death') = (death_at IS NOT NULL)
                                                   AND (death_at IS NULL OR (death_icd10_code IS NOT NULL AND autopsy_required IS NOT NULL))),
    ADD CONSTRAINT chk_stay_body            CHECK (body_released_at IS NULL OR (death_at IS NOT NULL AND body_released_by IS NOT NULL AND body_released_at >= death_at));

CREATE INDEX idx_inpatient_stays_docs_pending ON inpatient_stays (ended_at) WHERE status = 'discharged' AND closed_at IS NULL;
CREATE INDEX idx_inpatient_stays_ended ON inpatient_stays (ended_at) WHERE status = 'discharged';

-- ---------------------------------------------------------------- დროებითი გასვლა (leave) — საწოლი დაკავებული რჩება
CREATE TABLE inpatient_leaves (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id        UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expected_return_at  TIMESTAMPTZ NOT NULL,
    returned_at         TIMESTAMPTZ,
    reason              TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    permitted_by        UUID NOT NULL REFERENCES users(id),             -- ექიმი
    created_by          UUID NOT NULL REFERENCES users(id),
    returned_by         UUID REFERENCES users(id),
    overdue_notified_at TIMESTAMPTZ,
    CONSTRAINT chk_leave_times    CHECK (expected_return_at > started_at AND (returned_at IS NULL OR returned_at >= started_at)),
    CONSTRAINT chk_leave_returned CHECK ((returned_at IS NULL) = (returned_by IS NULL))
);
CREATE UNIQUE INDEX ux_inpatient_leaves_open ON inpatient_leaves (encounter_id) WHERE returned_at IS NULL;
CREATE INDEX idx_inpatient_leaves_overdue ON inpatient_leaves (expected_return_at) WHERE returned_at IS NULL;

-- ---------------------------------------------------------------- ისტორიის ახალი მოვლენები
ALTER TABLE inpatient_events DROP CONSTRAINT inpatient_events_kind_check;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_events_kind_check CHECK (kind IN (
    'admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled',
    'bed_cleaned', 'bed_blocked', 'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled',
    'planned_sms', 'wristband',
    -- 0041
    'transfer_requested', 'transfer_accepted', 'transfer_rejected', 'transfer_cancelled', 'transfer_overdue',
    'leave_started', 'leave_returned', 'leave_overdue',
    'discharged', 'discharge_cancelled', 'death', 'body_released', 'closed',
    'epicrisis_created', 'epicrisis_signed', 'epicrisis_cosigned', 'epicrisis_reopened'));

-- ---------------------------------------------------------------- მოდულის პარამეტრები (ნაგულისხმევი = შეთანხმებული რეკომენდაციები)
UPDATE system_modules SET settings = settings || '{
    "transfer_wait_hours": 2,
    "epicrisis_cosign": false,
    "discharge_cancel_hours": 24,
    "leave_counts_bed_day": true,
    "leave_max_hours": 72,
    "docs_pending_alert_hours": 24
}'::jsonb
WHERE code = 'inpatient';

-- ---------------------------------------------------------------- უფლებები
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON inpatient_transfers, inpatient_leaves, epicrisis_revisions, epicrises FROM emr_app;
    REVOKE UPDATE ON epicrisis_revisions FROM emr_app;
  END IF;
END $$;
