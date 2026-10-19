-- 0065_quality_analysis.sql
-- ხარისხი და ინციდენტები, ეტაპი 2 — გამოძიება, ანალიზი (მოკლე მიმოხილვა / RCA), მაკორექტირებელი ქმედებები (CAPA), ინფორმირება, დახურვა.
--
--  • გამომძიებელი: ხარისხის მენეჯერი ნიშნავს (ტრიაჟზე ან შემდეგ) — ნებისმიერ აქტიურ თანამშრომელს; ხედავს მხოლოდ მინიჭებულ ინციდენტს
--      (ავტორის გარეშე, თუ შეტყობინება ღია არ არის; მონაწილეებით — გასაუბრებისთვის). RCA გუნდის წევრებიც ასევე.
--  • ანალიზის დონე: review (მოკლე მიმოხილვა) / rca. ტრიაჟზე ავტომატურად: სენტინელური → rca; რისკი ≥ rca_required_risk ან ზიანი ≥ rca_required_harm → rca;
--      სხვა → review. ხარისხის მენეჯერი დონეს მაღლა წევს თავისუფლად, დაბლა — მიზეზით. ვადა: review_days / rca_days ტრიაჟიდან.
--  • ანალიზი (qm_analyses, ერთი ინციდენტზე): მიმოხილვა — რა მოხდა / ძირეული მიზეზი / მიღებული ზომა; RCA — ქრონოლოგია, ხელშემწყობი ფაქტორები
--      (ცნობარიდან, კომენტარით), „5 რატომ“, ძირეული მიზეზები, გუნდი, დასკვნა. სტატუსი: draft → submitted → approved | returned (→ draft).
--      analysis_approval = false → გაგზავნა = დამტკიცება.
--  • ინციდენტის სტატუსი: investigation (ანალიზი იწერება) → analysis (დამტკიცებას ელოდება) → capa (დამტკიცებულია, ქმედებები) → closed.
--  • CAPA (qm_capas): ქმედება, ტიპი (corrective / preventive), პასუხისმგებელი, ვადა, განყოფილება, სტატუსი (open → in_progress → done | cancelled),
--      შესრულების აღწერა + მტკიცებულება (ფაილი); ერთი CAPA — რამდენიმე ინციდენტი (qm_capa_incidents). ვადის შეცვლა — მოთხოვნით (qm_capa_due_requests).
--      ეფექტიანობის შემოწმება (capa_effectiveness, effectiveness_days შესრულებიდან) — შეიძლება ინციდენტის დახურვის შემდეგ.
--  • ინფორმირება (open disclosure): ჩატარდა (ვინ, როდის, როგორ) / არ ეცნობა (მიზეზით); დახურვამდე სავალდებულო, თუ პაციენტს შეეხო და ზიანი ≥ disclosure_required_harm.
--  • დახურვა: ანალიზი დამტკიცებულია, ყველა CAPA შესრულებული / გაუქმებული, დასკვნა, ინფორმირება (საჭიროებისას); ავტორს — „განხილვა დასრულდა“ + არჩევითი ტექსტი
--      (ანონიმურს — კოდით). ხელახლა გახსნა — მხოლოდ ხარისხის მენეჯერი, მიზეზით → investigation.

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"investigator_at_triage": true,
                    "rca_required_risk": "high",
                    "rca_required_harm": "severe",
                    "review_days": 14,
                    "rca_days": 45,
                    "due_warn_days": 3,
                    "analysis_approval": true,
                    "capa_effectiveness": true,
                    "effectiveness_days": 90,
                    "disclosure_required_harm": "moderate",
                    "closure_feedback": true,
                    "report_mask_patient": true}'::jsonb || settings
 WHERE code = 'quality';

-- ================================================================ 1. ინციდენტი: გამომძიებელი, დონე, ვადა, ინფორმირება, დახურვა
ALTER TABLE qm_incidents
    ADD COLUMN investigator_id          UUID REFERENCES users(id),
    ADD COLUMN investigator_at          TIMESTAMPTZ,
    ADD COLUMN analysis_level           VARCHAR(8) CHECK (analysis_level IN ('review', 'rca')),
    ADD COLUMN analysis_due_at          TIMESTAMPTZ,
    ADD COLUMN analysis_warn_sent_at    TIMESTAMPTZ,
    ADD COLUMN analysis_overdue_sent_at TIMESTAMPTZ,
    ADD COLUMN disclosure_status        VARCHAR(14) CHECK (disclosure_status IN ('done', 'not_disclosed')),
    ADD COLUMN disclosed_at             TIMESTAMPTZ,
    ADD COLUMN disclosure_by            UUID REFERENCES users(id),
    ADD COLUMN disclosure_method        VARCHAR(10) CHECK (disclosure_method IN ('in_person', 'phone', 'letter', 'other')),
    ADD COLUMN disclosure_to            TEXT,                       -- პაციენტი / ოჯახის წევრი (ვინ)
    ADD COLUMN disclosure_note          TEXT,
    ADD COLUMN disclosure_recorded_by   UUID REFERENCES users(id),
    ADD COLUMN disclosure_recorded_at   TIMESTAMPTZ,
    ADD COLUMN closed_at                TIMESTAMPTZ,
    ADD COLUMN closed_by                UUID REFERENCES users(id),
    ADD COLUMN closure_summary          TEXT,                       -- შიდა დასკვნა
    ADD COLUMN feedback_text            TEXT;                       -- ავტორს (ანონიმურს — კოდით)
ALTER TABLE qm_incidents ADD CONSTRAINT chk_qm_disclosure CHECK (
    disclosure_status IS NULL
    OR (disclosure_status = 'done' AND disclosed_at IS NOT NULL AND disclosure_method IS NOT NULL)
    OR (disclosure_status = 'not_disclosed' AND length(btrim(coalesce(disclosure_note, ''))) >= 3));
ALTER TABLE qm_incidents ADD CONSTRAINT chk_qm_closed CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND length(btrim(coalesce(closure_summary, ''))) >= 10));
CREATE INDEX idx_qm_incidents_investigator ON qm_incidents (investigator_id) WHERE investigator_id IS NOT NULL;

-- უკვე მიღებული (0064) ინციდენტები: დონე და ვადა ტრიაჟიდან
UPDATE qm_incidents i
   SET analysis_level = CASE WHEN i.is_sentinel OR i.risk_level IN ('high', 'extreme') OR i.harm IN ('severe', 'death') THEN 'rca' ELSE 'review' END,
       analysis_due_at = i.triaged_at + make_interval(days => CASE WHEN i.is_sentinel OR i.risk_level IN ('high', 'extreme') OR i.harm IN ('severe', 'death') THEN 45 ELSE 14 END)
 WHERE i.status IN ('investigation', 'analysis', 'capa') AND i.triaged_at IS NOT NULL;

-- ================================================================ 2. ანალიზი
CREATE TABLE qm_analyses (
    incident_id     UUID PRIMARY KEY REFERENCES qm_incidents(id) ON DELETE CASCADE,
    level           VARCHAR(8) NOT NULL CHECK (level IN ('review', 'rca')),
    status          VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
    what_happened   TEXT,
    root_cause      TEXT,                                       -- მიმოხილვა: ძირეული მიზეზი
    action_taken    TEXT,                                       -- მიმოხილვა: მიღებული ზომა
    whys            JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(whys) = 'array' AND jsonb_array_length(whys) <= 5),
    root_causes     TEXT,                                       -- RCA: ძირეული მიზეზები
    conclusion      TEXT,
    submitted_at    TIMESTAMPTZ,
    submitted_by    UUID REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    approved_by     UUID REFERENCES users(id),
    return_reason   TEXT,
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_qm_analyses_updated BEFORE UPDATE ON qm_analyses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE qm_analysis_timeline (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_id  UUID NOT NULL REFERENCES qm_analyses(incident_id) ON DELETE CASCADE,
    at           TIMESTAMPTZ,
    text         TEXT NOT NULL CHECK (length(btrim(text)) >= 2),
    sort_order   INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_qm_timeline ON qm_analysis_timeline (incident_id, sort_order);

CREATE TABLE qm_analysis_factors (
    incident_id  UUID NOT NULL REFERENCES qm_analyses(incident_id) ON DELETE CASCADE,
    factor_id    UUID NOT NULL REFERENCES qm_classifiers(id),
    comment      TEXT,
    PRIMARY KEY (incident_id, factor_id)
);

CREATE TABLE qm_analysis_team (
    incident_id  UUID NOT NULL REFERENCES qm_analyses(incident_id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id),
    role_text    TEXT,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (incident_id, user_id)
);
CREATE INDEX idx_qm_team_user ON qm_analysis_team (user_id);

-- ================================================================ 3. CAPA
CREATE TABLE qm_capas (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    capa_no               VARCHAR(20) NOT NULL UNIQUE,                 -- CAPA26-000001
    title                 TEXT NOT NULL CHECK (length(btrim(title)) >= 5),
    description           TEXT,
    kind                  VARCHAR(10) NOT NULL CHECK (kind IN ('corrective', 'preventive')),
    owner_id              UUID NOT NULL REFERENCES users(id),
    department_id         UUID REFERENCES departments(id),
    due_date              DATE NOT NULL,
    status                VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
    started_at            TIMESTAMPTZ,
    done_at               TIMESTAMPTZ,
    done_by               UUID REFERENCES users(id),
    done_note             TEXT,
    cancelled_at          TIMESTAMPTZ,
    cancelled_by          UUID REFERENCES users(id),
    cancel_reason         TEXT,
    effectiveness_due     DATE,
    effectiveness_result  VARCHAR(12) CHECK (effectiveness_result IN ('effective', 'ineffective')),
    effectiveness_note    TEXT,
    effectiveness_at      TIMESTAMPTZ,
    effectiveness_by      UUID REFERENCES users(id),
    follow_up_of          UUID REFERENCES qm_capas(id),                -- არაეფექტიანის შემდეგ ახალი CAPA
    warn_sent_at          TIMESTAMPTZ,
    overdue_sent_at       TIMESTAMPTZ,
    effectiveness_sent_at TIMESTAMPTZ,
    created_by            UUID NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status <> 'done' OR (done_at IS NOT NULL AND length(btrim(coalesce(done_note, ''))) >= 3)),
    CHECK (status <> 'cancelled' OR length(btrim(coalesce(cancel_reason, ''))) >= 3),
    CHECK (effectiveness_result IS NULL OR status = 'done')
);
CREATE INDEX idx_qm_capas_owner ON qm_capas (owner_id, status);
CREATE INDEX idx_qm_capas_due ON qm_capas (status, due_date);
CREATE TRIGGER trg_qm_capas_updated BEFORE UPDATE ON qm_capas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE qm_capa_incidents (
    capa_id      UUID NOT NULL REFERENCES qm_capas(id) ON DELETE CASCADE,
    incident_id  UUID NOT NULL REFERENCES qm_incidents(id),
    linked_by    UUID REFERENCES users(id),
    linked_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (capa_id, incident_id)
);
CREATE INDEX idx_qm_capa_incidents_inc ON qm_capa_incidents (incident_id);

CREATE TABLE qm_capa_files (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    capa_id        UUID NOT NULL REFERENCES qm_capas(id) ON DELETE CASCADE,
    file_path      TEXT NOT NULL,
    mime_type      VARCHAR(40) NOT NULL,
    size_bytes     INT NOT NULL,
    sha256         CHAR(64) NOT NULL,
    original_name  TEXT,
    uploaded_by    UUID NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_qm_capa_files ON qm_capa_files (capa_id);

CREATE TABLE qm_capa_due_requests (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    capa_id       UUID NOT NULL REFERENCES qm_capas(id) ON DELETE CASCADE,
    old_due       DATE NOT NULL,
    new_due       DATE NOT NULL,
    reason        TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
    requested_by  UUID NOT NULL REFERENCES users(id),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by    UUID REFERENCES users(id),
    decided_at    TIMESTAMPTZ,
    decision_note TEXT
);
CREATE UNIQUE INDEX uq_qm_capa_due_pending ON qm_capa_due_requests (capa_id) WHERE status = 'pending';

CREATE TABLE qm_capa_events (
    id        BIGSERIAL PRIMARY KEY,
    capa_id   UUID NOT NULL REFERENCES qm_capas(id) ON DELETE CASCADE,
    at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id   UUID REFERENCES users(id),
    kind      VARCHAR(20) NOT NULL,
    text      TEXT,
    data      JSONB
);
CREATE INDEX idx_qm_capa_events ON qm_capa_events (capa_id, at);
