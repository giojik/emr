-- 0090_er_disposition.sql
-- გადაუდებელი დახმარება (ER), ეტაპი 3 / 4 — გამოსავალი.
--
--  • er_visits.status + 'departed' (გამოსავალი გაფორმებულია); disposition — home / admitted / transfer / ama / lwbs / death;
--    doc_closes_at — დოკუმენტაციის ფანჯრის დასასრული (doc_window_h; 0 → გამოსავლისთანავე).
--  • er_dispositions — გამოსავლის ჩანაწერი (სახის ველები, გაფრთხილებების დასაბუთება, დანიშნულებების გეგმა, ER-ის ფურცელი);
--    გაუქმებისას (reopen) რჩება ისტორიად (reopened_at), აქტიური — ერთი შემთხვევაზე.
--  • er_admit_requests — ჰოსპიტალიზაციის მოთხოვნა (admit_mode = request): ER-ის ექიმი → განყოფილება იღებს / უარყოფს.
--  • med_orders.er_order_id — ER-ის დანიშნულების გაგრძელება სტაციონარში (transfer_orders = reconcile).
--  • შაბლონები: ER_SUMMARY (kind er_summary — ER-ის ფურცელი, summary_mode = template), ER_SELF_DISCHARGE (ხელწერილი, AMA).
--  • ER-ის პარამეტრები (0090) — ნაგულისხმევი ემატება, არსებული არ იცვლება.

-- ================================================================ 1. er_visits
ALTER TABLE er_visits DROP CONSTRAINT er_visits_status_check;
ALTER TABLE er_visits ADD CONSTRAINT er_visits_status_check CHECK (status IN ('waiting', 'triaged', 'in_treatment', 'departed', 'cancelled'));
ALTER TABLE er_visits
    ADD COLUMN disposition    VARCHAR(10) CHECK (disposition IN ('home', 'admitted', 'transfer', 'ama', 'lwbs', 'death')),
    ADD COLUMN doc_closes_at  TIMESTAMPTZ,
    ADD CONSTRAINT chk_er_visit_disposition CHECK ((status = 'departed') = (disposition IS NOT NULL));
CREATE INDEX idx_er_visits_departed ON er_visits (ended_at DESC) WHERE status = 'departed';

-- ================================================================ 2. ჰოსპიტალიზაციის მოთხოვნა (admit_mode = request)
CREATE TABLE er_admit_requests (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id            UUID NOT NULL REFERENCES er_visits(encounter_id),
    patient_id              UUID NOT NULL REFERENCES patients(id),
    department_id           UUID NOT NULL REFERENCES departments(id),
    attending_doctor_id     UUID REFERENCES users(id),                               -- სასურველი (განყოფილება ადასტურებს / ცვლის)
    icd10_code              VARCHAR(10) NOT NULL,
    icd10_title             TEXT NOT NULL,
    severity                VARCHAR(10) CHECK (severity IN ('stable', 'moderate', 'severe', 'critical')),
    isolation               VARCHAR(10) CHECK (isolation IN ('contact', 'droplet', 'airborne', 'protective')),
    note                    VARCHAR(2000),
    orders_plan             JSONB NOT NULL DEFAULT '{}',                             -- {er_order_id: continue | stop} — ER-ის ექიმის წინადადება
    overrides               JSONB,                                                    -- გაფრთხილებები + დასაბუთება (მოთხოვნისას)
    status                  VARCHAR(10) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'rejected', 'cancelled')),
    requested_by            UUID NOT NULL REFERENCES users(id),
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by              UUID REFERENCES users(id),
    decided_at              TIMESTAMPTZ,
    decision_reason         VARCHAR(1000),
    inpatient_encounter_id  UUID REFERENCES encounters(id),
    CONSTRAINT chk_er_admit_decided CHECK ((status = 'requested') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)),
    CONSTRAINT chk_er_admit_reason CHECK (status NOT IN ('rejected', 'cancelled') OR length(btrim(coalesce(decision_reason, ''))) >= 3),
    CONSTRAINT chk_er_admit_accepted CHECK (status <> 'accepted' OR inpatient_encounter_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_er_admit_open ON er_admit_requests (encounter_id) WHERE status = 'requested';
CREATE INDEX idx_er_admit_department ON er_admit_requests (department_id, requested_at) WHERE status = 'requested';

-- ================================================================ 3. გამოსავალი
CREATE TABLE er_dispositions (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id            UUID NOT NULL REFERENCES er_visits(encounter_id),
    kind                    VARCHAR(10) NOT NULL CHECK (kind IN ('home', 'admitted', 'transfer', 'ama', 'lwbs', 'death')),
    decided_at              TIMESTAMPTZ NOT NULL DEFAULT now(),                      -- გაფორმება
    departed_at             TIMESTAMPTZ NOT NULL,                                    -- ფაქტობრივი გასვლა / შენიშვნა (LWBS) / გარდაცვალება
    decided_by              UUID NOT NULL REFERENCES users(id),
    prev_status             VARCHAR(16) NOT NULL,                                    -- გაუქმებისას (reopen) — სტატუსის აღდგენა
    recommendations         VARCHAR(4000),
    note                    VARCHAR(2000),
    -- გადაყვანა სხვა კლინიკაში
    destination_id          UUID REFERENCES external_institutions(id),
    destination_text        VARCHAR(300),
    transport               VARCHAR(20) CHECK (transport IN ('own', 'ambulance', 'clinic_transport', 'other')),
    transfer_reason         VARCHAR(1000),
    receiver                VARCHAR(300),                                            -- მიმღები ექიმი / ტელეფონი
    -- AMA
    refusal_consent_id      UUID REFERENCES patient_consents(id),
    refusal_witnesses       UUID[],
    ama_reason              VARCHAR(1000),
    -- გარდაცვალება
    death_at                TIMESTAMPTZ,
    death_icd10_code        VARCHAR(10),
    death_icd10_title       TEXT,
    autopsy_required        BOOLEAN,
    dead_on_arrival         BOOLEAN NOT NULL DEFAULT FALSE,
    -- ჰოსპიტალიზაცია
    inpatient_encounter_id  UUID REFERENCES encounters(id),
    admit_request_id        UUID REFERENCES er_admit_requests(id),
    orders_plan             JSONB NOT NULL DEFAULT '{}',                             -- {er_order_id: continue | stop}
    orders_result           JSONB NOT NULL DEFAULT '{}',                             -- {continued: [{er_order_id, med_order_id}], stopped: [...]}
    -- გაფრთხილებები / დოკუმენტი
    overrides               JSONB,
    summary_document_id     UUID REFERENCES generated_documents(id),
    -- გაუქმება (შეცდომა)
    reopened_at             TIMESTAMPTZ,
    reopened_by             UUID REFERENCES users(id),
    reopen_reason           VARCHAR(1000),
    CONSTRAINT chk_er_disp_transfer CHECK (kind <> 'transfer' OR ((destination_id IS NOT NULL OR length(btrim(coalesce(destination_text, ''))) >= 3)
                                                                   AND length(btrim(coalesce(transfer_reason, ''))) >= 3)),
    CONSTRAINT chk_er_disp_death CHECK (kind <> 'death' OR (death_at IS NOT NULL AND death_icd10_code IS NOT NULL AND autopsy_required IS NOT NULL)),
    CONSTRAINT chk_er_disp_admitted CHECK (kind <> 'admitted' OR inpatient_encounter_id IS NOT NULL),
    CONSTRAINT chk_er_disp_reopen CHECK ((reopened_at IS NULL) = (reopened_by IS NULL) AND (reopened_at IS NULL OR length(btrim(coalesce(reopen_reason, ''))) >= 3))
);
CREATE UNIQUE INDEX ux_er_disposition_active ON er_dispositions (encounter_id) WHERE reopened_at IS NULL;
CREATE INDEX idx_er_dispositions_enc ON er_dispositions (encounter_id, decided_at);

-- ================================================================ 4. სტაციონარის დანიშნულება ← ER
ALTER TABLE med_orders ADD COLUMN er_order_id UUID REFERENCES er_orders(id);
CREATE UNIQUE INDEX ux_med_orders_er_order ON med_orders (er_order_id) WHERE er_order_id IS NOT NULL;

-- ================================================================ 5. შაბლონები
ALTER TABLE document_templates DROP CONSTRAINT document_templates_kind_check;
ALTER TABLE document_templates ADD CONSTRAINT document_templates_kind_check CHECK (kind IN ('consent', 'refusal', 'epicrisis', 'er_summary', 'other'));
ALTER TABLE document_templates ADD CONSTRAINT chk_tpl_er_summary_scope CHECK (kind <> 'er_summary' OR scope = 'encounter');

-- ⚠️ ტექსტი — ჩანაცვლების ადგილი: იურისტი ამზადებს, admin ასწორებს და აქვეყნებს (ადმინისტრირება → დოკუმენტების შაბლონები).
INSERT INTO document_templates (code, kind, name, scope, is_system, required_on_admission, sort_order) VALUES
  ('ER_SELF_DISCHARGE', 'refusal',    'ხელწერილი — გადაუდებელი განყოფილების დატოვება ექიმის რეკომენდაციის საწინააღმდეგოდ / მკურნალობაზე უარი', 'encounter', TRUE, FALSE, 210),
  ('ER_SUMMARY',        'er_summary', 'ER-ის ფურცელი (ამონაწერი გადაუდებელი განყოფილებიდან)', 'encounter', TRUE, FALSE, 310)
ON CONFLICT (code) DO NOTHING;

INSERT INTO document_template_versions (template_code, version, status, body, published_at)
SELECT 'ER_SELF_DISCHARGE', 1, 'published', jsonb_build_object('blocks', jsonb_build_array(
    jsonb_build_object('type', 'text', 'text',
      '[ტექსტი დასამტკიცებელია. მე, {{patient.full_name}} (პირადი № {{patient.id_number}}), ვტოვებ {{clinic.name}}-ის გადაუდებელ განყოფილებას '
      || '(შემთხვევა {{er.visit_no}}) ექიმის რეკომენდაციის საწინააღმდეგოდ / ვამბობ უარს შემოთავაზებულ მკურნალობაზე. ექიმმა ({{er.doctor}}) ამიხსნა '
      || 'ამ გადაწყვეტილების შესაძლო შედეგები; პასუხისმგებლობას ვიღებ საკუთარ თავზე.]'))), CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM document_template_versions WHERE template_code = 'ER_SELF_DISCHARGE');

-- ER-ის ფურცელი: სისტემური ნაგულისხმევი (summary_mode = template — admin ასწორებს / აქვეყნებს ახალ ვერსიას)
INSERT INTO document_template_versions (template_code, version, status, body, published_at)
SELECT 'ER_SUMMARY', 1, 'published', jsonb_build_object('blocks', jsonb_build_array(
    jsonb_build_object('type', 'header'),
    jsonb_build_object('type', 'heading', 'text', 'ამონაწერი გადაუდებელი განყოფილებიდან'),
    jsonb_build_object('type', 'patient'),
    jsonb_build_object('type', 'er_section', 'section', 'arrival',     'label', 'შემოსვლა'),
    jsonb_build_object('type', 'er_section', 'section', 'triage',      'label', 'ტრიაჟი / ვიტალური ნიშნები'),
    jsonb_build_object('type', 'er_section', 'section', 'notes',       'label', 'ექიმის ჩანაწერები'),
    jsonb_build_object('type', 'diagnoses', 'which', 'final',          'label', 'დიაგნოზი (ICD-10)'),
    jsonb_build_object('type', 'lab_results',                          'label', 'ლაბორატორიული კვლევები'),
    jsonb_build_object('type', 'dx_results',                           'label', 'ინსტრუმენტული კვლევები'),
    jsonb_build_object('type', 'er_section', 'section', 'consults',    'label', 'კონსულტაციები'),
    jsonb_build_object('type', 'er_section', 'section', 'orders',      'label', 'ჩატარებული მკურნალობა / მანიპულაციები'),
    jsonb_build_object('type', 'er_section', 'section', 'disposition', 'label', 'გამოსავალი'),
    jsonb_build_object('type', 'field', 'key', 'recommendations', 'label', 'რეკომენდაციები', 'required', false),
    jsonb_build_object('type', 'signatures', 'signers', jsonb_build_array('attending')))), CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM document_template_versions WHERE template_code = 'ER_SUMMARY');

-- ================================================================ 6. ER-ის პარამეტრები (0090; არსებული მნიშვნელობები არ იცვლება)
UPDATE system_modules SET settings = '{
    "admit_mode": "direct",
    "transfer_orders": "reconcile",
    "require_initial_note": "block",
    "require_diagnosis": "block",
    "verbal_unconfirmed": "block",
    "open_items_check": "warn",
    "recommendations_required": true,
    "ama_proof": "consent_or_witnesses",
    "doc_window_h": 24,
    "reopen_h": 4,
    "summary_mode": "builtin",
    "summary_sections": ["arrival", "triage", "notes", "diagnoses", "lab", "dx", "consults", "orders", "disposition", "recommendations"]
}'::jsonb || settings
WHERE code = 'er';

UPDATE system_modules SET description = 'ER: რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი (ESI / MTS / საკუთარი), დაფა / TV, ადგილები; ჩანაწერი, დიაგნოსტიკა, კონსულტაცია; დანიშვნა / მიცემა / ჩამოწერა; გამოსავალი (გაწერა / ჰოსპიტალიზაცია / გადაყვანა / AMA / LWBS / გარდაცვალება), ER-ის ფურცელი'
WHERE code = 'er';
