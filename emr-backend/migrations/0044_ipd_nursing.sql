-- 0044_ipd_nursing.sql
-- სტაციონარი, ეტაპი 0044 — ექთნის დოკუმენტაცია.
--
--  • ვიტალური ნიშნები: არსებული encounter_vitals (ამბულატორია / დანიშნულებების წონა) + ცნობიერება (ACVPU), ჟანგბადი, ტკივილი, გლუკოზა,
--      NEWS2 (ქულა + კომპონენტები, მხოლოდ მინიშნება — ტექნიკური დავალება: გადაწყვეტილება ავტომატურ შეფასებას არ ეფუძნება);
--      ჩანაწერი არ რედაქტირდება — გაუქმება მიზეზით; MAR-ის მოვლის დავალებასთან კავშირი (mar_entry_id).
--  • fluid_entries — მიღება / გამოყოფა (ბალანსის დღე — fluid_day_start).
--  • scale_defs / scale_assessments — შკალების უნივერსალური მექანიზმი (კითხვები / ქულები / დიაპაზონები ბაზაში): Morse, Braden, GCS.
--  • lines_drains — კათეტერები, დრენაჟები, ზონდები: ჩადგმა / ამოღება, დღეების მთვლელი, შეხსენება.
--  • nursing_notes — ექთნის ჩანაწერი და ცვლის გადაბარება (SBAR + ავტომატური შეჯამება, მიმღების დადასტურება).
--  • med_orders.nursing_task — მოვლის დანიშნულების ტიპი (vitals / fluid / scale / other): MAR-ში ჩაწერა ხსნის შესაბამის ფორმას.

-- ================================================================ 1. ვიტალური ნიშნები
ALTER TABLE encounter_vitals
    ADD COLUMN consciousness  VARCHAR(1) CHECK (consciousness IN ('A', 'C', 'V', 'P', 'U')),
    ADD COLUMN o2_supplement  BOOLEAN,
    ADD COLUMN o2_flow        NUMERIC(4,1) CHECK (o2_flow BETWEEN 0 AND 80),
    ADD COLUMN spo2_scale     SMALLINT NOT NULL DEFAULT 1 CHECK (spo2_scale IN (1, 2)),
    ADD COLUMN pain           SMALLINT CHECK (pain BETWEEN 0 AND 10),
    ADD COLUMN glucose        NUMERIC(4,1) CHECK (glucose BETWEEN 0.5 AND 60),
    ADD COLUMN notes          TEXT,
    ADD COLUMN news2          SMALLINT,
    ADD COLUMN news2_parts    JSONB,
    ADD COLUMN news2_level    VARCHAR(8) CHECK (news2_level IN ('low', 'low_red', 'medium', 'high')),
    ADD COLUMN mar_entry_id   UUID REFERENCES mar_entries(id),
    ADD COLUMN voided_at      TIMESTAMPTZ,
    ADD COLUMN voided_by      UUID REFERENCES users(id),
    ADD COLUMN void_reason    TEXT,
    ADD COLUMN created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD CONSTRAINT chk_vitals_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3));
CREATE INDEX idx_vitals_valid ON encounter_vitals (encounter_id, recorded_at DESC) WHERE voided_at IS NULL;

-- ჩანაწერი არ იცვლება — მხოლოდ გაუქმება (voided_*)
CREATE OR REPLACE FUNCTION encounter_vitals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'გაუქმებული ვიტალები არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason']) THEN
        RAISE EXCEPTION 'ვიტალები არ რედაქტირდება — გააუქმეთ (მიზეზით) და ჩაწერეთ თავიდან' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_encounter_vitals_guard BEFORE UPDATE ON encounter_vitals FOR EACH ROW EXECUTE FUNCTION encounter_vitals_guard();

-- ================================================================ 2. სითხის ბალანსი
CREATE TABLE fluid_entries (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    direction     VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
    category      VARCHAR(10) NOT NULL CHECK (category IN ('po', 'iv', 'tube', 'blood', 'other_in', 'urine', 'drain', 'vomit', 'stool', 'other_out')),
    volume_ml     NUMERIC(7,1) NOT NULL CHECK (volume_ml > 0 AND volume_ml <= 20000),
    recorded_at   TIMESTAMPTZ NOT NULL,                       -- ფაქტობრივი დრო (ან პერიოდის ბოლო)
    order_id      UUID REFERENCES med_orders(id),             -- ინფუზია (MAR) — მინიშნებიდან
    note          TEXT,
    mar_entry_id  UUID REFERENCES mar_entries(id),
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at     TIMESTAMPTZ,
    voided_by     UUID REFERENCES users(id),
    void_reason   TEXT,
    CONSTRAINT chk_fluid_dir CHECK ((direction = 'in') = (category IN ('po', 'iv', 'tube', 'blood', 'other_in'))),
    CONSTRAINT chk_fluid_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_fluid_encounter ON fluid_entries (encounter_id, recorded_at) WHERE voided_at IS NULL;

-- ================================================================ 3. შკალები
CREATE TABLE scale_defs (
    code            VARCHAR(20) PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    items           JSONB NOT NULL,          -- [{key, label, options: [{label, points}]}]
    bands           JSONB NOT NULL,          -- [{min, max, label, level: none|low|medium|high}]
    required        BOOLEAN NOT NULL DEFAULT FALSE,   -- ჰოსპიტალიზაციისას სავალდებულო (24 სთ-ში) + პერიოდული
    reassess_hours  INT CHECK (reassess_hours BETWEEN 1 AND 720),
    risk_label      TEXT,                    -- ჩიპი დაფაზე (მაგ. „დაცემის რისკი“)
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0
);
CREATE TABLE scale_assessments (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id  UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    scale_code    VARCHAR(20) NOT NULL REFERENCES scale_defs(code),
    answers       JSONB NOT NULL,            -- {item_key: option_index}
    score         INT NOT NULL,
    band_label    TEXT,
    level         VARCHAR(8) CHECK (level IN ('none', 'low', 'medium', 'high')),
    note          TEXT,
    assessed_at   TIMESTAMPTZ NOT NULL,
    assessed_by   UUID NOT NULL REFERENCES users(id),
    mar_entry_id  UUID REFERENCES mar_entries(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at     TIMESTAMPTZ,
    voided_by     UUID REFERENCES users(id),
    void_reason   TEXT,
    CONSTRAINT chk_scale_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_scale_encounter ON scale_assessments (encounter_id, scale_code, assessed_at DESC) WHERE voided_at IS NULL;

INSERT INTO scale_defs (code, name, description, required, reassess_hours, risk_label, sort_order, items, bands) VALUES
('morse', 'Morse — დაცემის რისკი', 'Morse Fall Scale', TRUE, 24, 'დაცემის რისკი', 10,
 '[{"key":"history","label":"დაცემა ბოლო 3 თვეში","options":[{"label":"არა","points":0},{"label":"კი","points":25}]},
   {"key":"secondary","label":"ერთზე მეტი დიაგნოზი","options":[{"label":"არა","points":0},{"label":"კი","points":15}]},
   {"key":"aid","label":"გადაადგილების დამხმარე საშუალება","options":[{"label":"არ სჭირდება / წოლითი რეჟიმი / ექთნის დახმარება","points":0},{"label":"ყავარჯენი / ხელჯოხი / ჩარჩო","points":15},{"label":"ავეჯს ეყრდნობა","points":30}]},
   {"key":"iv","label":"ინტრავენური ინფუზია / კათეტერი","options":[{"label":"არა","points":0},{"label":"კი","points":20}]},
   {"key":"gait","label":"სიარული","options":[{"label":"ნორმალური / წოლითი / ეტლით","points":0},{"label":"სუსტი","points":10},{"label":"დარღვეული","points":20}]},
   {"key":"mental","label":"ფსიქიკური სტატუსი","options":[{"label":"აფასებს საკუთარ შესაძლებლობებს","points":0},{"label":"ავიწყდება / გადააფასებს შეზღუდვებს","points":15}]}]',
 '[{"min":0,"max":24,"label":"დაბალი რისკი","level":"low"},{"min":25,"max":44,"label":"საშუალო რისკი","level":"medium"},{"min":45,"max":125,"label":"მაღალი რისკი","level":"high"}]'),
('braden', 'Braden — ნაწოლის რისკი', 'Braden Scale (დაბალი ქულა = მაღალი რისკი)', TRUE, 24, 'ნაწოლის რისკი', 20,
 '[{"key":"sensory","label":"მგრძნობელობა","options":[{"label":"სრულად შეზღუდული","points":1},{"label":"ძლიერ შეზღუდული","points":2},{"label":"ოდნავ შეზღუდული","points":3},{"label":"შეუზღუდავი","points":4}]},
   {"key":"moisture","label":"სინოტივე","options":[{"label":"მუდმივად სველი","points":1},{"label":"ძალიან სველი","points":2},{"label":"ხანდახან სველი","points":3},{"label":"იშვიათად სველი","points":4}]},
   {"key":"activity","label":"აქტივობა","options":[{"label":"წოლითი","points":1},{"label":"სავარძელში","points":2},{"label":"ხანდახან დადის","points":3},{"label":"ხშირად დადის","points":4}]},
   {"key":"mobility","label":"მობილურობა","options":[{"label":"სრულად უძრავი","points":1},{"label":"ძლიერ შეზღუდული","points":2},{"label":"ოდნავ შეზღუდული","points":3},{"label":"შეუზღუდავი","points":4}]},
   {"key":"nutrition","label":"კვება","options":[{"label":"ძალიან ცუდი","points":1},{"label":"სავარაუდოდ არასაკმარისი","points":2},{"label":"ადეკვატური","points":3},{"label":"შესანიშნავი","points":4}]},
   {"key":"friction","label":"ხახუნი და ძვრა","options":[{"label":"პრობლემა","points":1},{"label":"პოტენციური პრობლემა","points":2},{"label":"პრობლემა არ არის","points":3}]}]',
 '[{"min":6,"max":12,"label":"მაღალი რისკი","level":"high"},{"min":13,"max":14,"label":"საშუალო რისკი","level":"medium"},{"min":15,"max":18,"label":"რისკი","level":"low"},{"min":19,"max":23,"label":"რისკი არ არის","level":"none"}]'),
('gcs', 'GCS — გლაზგოს კომის შკალა', 'Glasgow Coma Scale', FALSE, NULL, NULL, 30,
 '[{"key":"eye","label":"თვალის გახელა (E)","options":[{"label":"არ ახელს","points":1},{"label":"ტკივილზე","points":2},{"label":"ხმაზე","points":3},{"label":"სპონტანურად","points":4}]},
   {"key":"verbal","label":"ვერბალური პასუხი (V)","options":[{"label":"არ არის","points":1},{"label":"გაუგებარი ბგერები","points":2},{"label":"შეუსაბამო სიტყვები","points":3},{"label":"დაბნეული","points":4},{"label":"ორიენტირებული","points":5}]},
   {"key":"motor","label":"მოტორული პასუხი (M)","options":[{"label":"არ არის","points":1},{"label":"ექსტენზია","points":2},{"label":"პათოლოგიური ფლექსია","points":3},{"label":"ტკივილზე უკუწევა","points":4},{"label":"ტკივილის ლოკალიზება","points":5},{"label":"ასრულებს ბრძანებას","points":6}]}]',
 '[{"min":3,"max":8,"label":"მძიმე","level":"high"},{"min":9,"max":12,"label":"საშუალო","level":"medium"},{"min":13,"max":15,"label":"მსუბუქი / ნორმა","level":"low"}]');

-- ================================================================ 4. ხაზები / დრენაჟები
CREATE TABLE lines_drains (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id     UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id       UUID NOT NULL REFERENCES patients(id),
    kind             VARCHAR(12) NOT NULL CHECK (kind IN ('pvc', 'cvc', 'picc', 'arterial', 'urinary', 'ng_tube', 'drain', 'trach', 'other')),
    site             TEXT,
    size             VARCHAR(40),
    details          TEXT,
    inserted_at      TIMESTAMPTZ NOT NULL,
    inserted_by      UUID REFERENCES users(id),
    inserted_where   TEXT,                       -- „სხვა დაწესებულებაში“ / „მიმღებში“ — თუ ჩვენთან არ ჩადგმულა
    removed_at       TIMESTAMPTZ,
    removed_by       UUID REFERENCES users(id),
    removal_reason   TEXT,
    alert_notified_at TIMESTAMPTZ,
    created_by       UUID NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at        TIMESTAMPTZ,
    voided_by        UUID REFERENCES users(id),
    void_reason      TEXT,
    CONSTRAINT chk_line_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL) AND (removed_at IS NULL OR removed_at >= inserted_at)),
    CONSTRAINT chk_line_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_lines_open ON lines_drains (encounter_id) WHERE removed_at IS NULL AND voided_at IS NULL;

-- ================================================================ 5. ექთნის ჩანაწერი / ცვლის გადაბარება
CREATE TABLE nursing_notes (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    encounter_id     UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    patient_id       UUID NOT NULL REFERENCES patients(id),
    department_id    UUID REFERENCES departments(id),
    kind             VARCHAR(10) NOT NULL CHECK (kind IN ('note', 'handover')),
    text             TEXT,                       -- note
    sbar             JSONB,                      -- handover: {s, b, a, r}
    summary          JSONB,                      -- handover: ავტომატური შეჯამება (ჩაწერის მომენტში)
    shift_start      TIMESTAMPTZ,                -- handover: რომელ ცვლას აბარებს
    author_id        UUID NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ack_by           UUID REFERENCES users(id),
    ack_at           TIMESTAMPTZ,
    voided_at        TIMESTAMPTZ,
    voided_by        UUID REFERENCES users(id),
    void_reason      TEXT,
    CONSTRAINT chk_nn_kind CHECK ((kind = 'note' AND length(btrim(coalesce(text, ''))) >= 2) OR (kind = 'handover' AND sbar IS NOT NULL AND shift_start IS NOT NULL)),
    CONSTRAINT chk_nn_ack CHECK ((ack_at IS NULL) = (ack_by IS NULL)),
    CONSTRAINT chk_nn_void CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 3))
);
CREATE INDEX idx_nn_encounter ON nursing_notes (encounter_id, created_at DESC);
CREATE UNIQUE INDEX ux_nn_handover ON nursing_notes (encounter_id, shift_start) WHERE kind = 'handover' AND voided_at IS NULL;

-- ჩანაწერები არ რედაქტირდება (მხოლოდ გაუქმება / ამოღება / დადასტურება)
CREATE OR REPLACE FUNCTION nursing_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed TEXT[] := TG_ARGV;
BEGIN
    IF OLD.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'გაუქმებული ჩანაწერი არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
        RAISE EXCEPTION 'ჩანაწერი არ რედაქტირდება — გააუქმეთ (მიზეზით) და ჩაწერეთ თავიდან' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_fluid_guard BEFORE UPDATE ON fluid_entries FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');
CREATE TRIGGER trg_scale_guard BEFORE UPDATE ON scale_assessments FOR EACH ROW EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason');
CREATE TRIGGER trg_lines_guard BEFORE UPDATE ON lines_drains FOR EACH ROW
    EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason', 'removed_at', 'removed_by', 'removal_reason', 'alert_notified_at');
CREATE TRIGGER trg_nn_guard BEFORE UPDATE ON nursing_notes FOR EACH ROW
    EXECUTE FUNCTION nursing_immutable_guard('voided_at', 'voided_by', 'void_reason', 'ack_by', 'ack_at');

-- ================================================================ 6. მოვლის დანიშნულების ტიპი (MAR → ფორმა)
ALTER TABLE med_orders
    ADD COLUMN nursing_task VARCHAR(8) CHECK (nursing_task IN ('vitals', 'fluid', 'scale', 'other')),
    ADD COLUMN task_scale_code VARCHAR(20) REFERENCES scale_defs(code),
    ADD CONSTRAINT chk_mo_task CHECK ((nursing_task IS NULL OR category = 'nursing') AND ((task_scale_code IS NOT NULL) = (nursing_task IS NOT DISTINCT FROM 'scale')));

-- შეხსენებების დუბლირების თავიდან აცილება (შკალის ვადა და სხვ.)
CREATE TABLE ipd_reminders (
    encounter_id UUID NOT NULL REFERENCES inpatient_stays(encounter_id),
    kind         VARCHAR(20) NOT NULL,
    ref          TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (encounter_id, kind, ref)
);

-- ================================================================ 7. ისტორია / პარამეტრები
ALTER TABLE inpatient_events DROP CONSTRAINT inpatient_events_kind_check;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_events_kind_check CHECK (kind IN (
    'admitted', 'bed_assigned', 'bed_changed', 'attending_changed', 'severity', 'isolation', 'cancelled',
    'bed_cleaned', 'bed_blocked', 'bed_unblocked', 'bed_reserved', 'bed_released', 'planned_created', 'planned_updated', 'planned_cancelled',
    'planned_sms', 'wristband',
    'transfer_requested', 'transfer_accepted', 'transfer_rejected', 'transfer_cancelled', 'transfer_overdue',
    'leave_started', 'leave_returned', 'leave_overdue',
    'discharged', 'discharge_cancelled', 'death', 'body_released', 'closed',
    'epicrisis_created', 'epicrisis_signed', 'epicrisis_cosigned', 'epicrisis_reopened',
    'orders_stopped',
    'mar_missed',
    -- 0044
    'news2_alert', 'line_inserted', 'line_removed', 'handover'));

UPDATE system_modules SET settings = settings || '{
    "news2_enabled": true,
    "news2_alert": 5,
    "news2_urgent": 7,
    "glucose_low": 3.9,
    "glucose_high": 11.1,
    "fluid_day_start": "08:00",
    "shift_times": ["08:00", "20:00"],
    "scale_reminders": true,
    "line_alert_hours": {"pvc": 96, "urinary": 720, "cvc": 0, "picc": 0, "arterial": 0, "ng_tube": 0, "drain": 0, "trach": 0, "other": 0}
}'::jsonb
WHERE code = 'inpatient';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON fluid_entries, scale_assessments, lines_drains, nursing_notes FROM emr_app;
    GRANT SELECT ON scale_defs TO emr_app;
    GRANT SELECT, INSERT, UPDATE ON fluid_entries, scale_assessments, lines_drains, nursing_notes, ipd_reminders TO emr_app;
    GRANT DELETE ON ipd_reminders TO emr_app;
    GRANT INSERT, UPDATE ON scale_defs TO emr_app;
  END IF;
END $$;
