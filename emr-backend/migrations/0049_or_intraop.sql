-- 0049_or_intraop.sql
-- საოპერაციო ბლოკი, ნაწილი 2 — ოპერაციის მსვლელობა (მოდული „or“). 0050: PACU, ბილინგი, სტატისტიკა.
--
--  • A. საექთნო გუნდი: nursing_team_by (surgeon / or_head_nurse / both); ოთახის გუნდი (room_teams):
--      მუდმივი — or_room_staff (ოთახი × თანამშრომელი × როლი: ექთნები + ანესთეზიოლოგი), დღის ცვლილება — or_room_staff_days
--      („დღეს X → OR2“ / „დღეს Y არ არის“); დაგეგმვისას დღის გუნდი ოპერაციის გუნდს ემატება ავტომატურად (or_case_team.auto).
--  • #9 ანესთეზიის რუკა — or_anesthesia_records (ტიპი, სასუნთქი გზები, ტექნიკა; ხელმოწერა → უცვლელი);
--      ვიტალები 5-წთ ბადეზე — encounter_vitals.or_case_id; სითხეები / სისხლის დაკარგვა / შარდი — fluid_entries.or_case_id (→ ბალანსი);
--      მედიკამენტები — anesthesia_meds: direct (ჟურნალი or_anesthesia_meds + ჩამოწერა ბლოკის ლოკაციიდან) / orders (CPOE → MAR) / both;
--      ნარკოტიკულზე / ფსიქოტროპულზე — მოწმე + ნარჩენი (არაარჩევადი, DB CHECK).
--  • #10 ოქმი — or_op_notes (ვერსიებით; ხელმოწერა → უცვლელი; შესწორება — ახალი ვერსია მიზეზით); შაბლონები — or_note_templates
--      (პროცედურაზე / პერსონალური); დრენაჟები → lines_drains (0044); ბიოფსია → path_requests (გარე პათოლოგია, 0014);
--      იმპლანტები — ავტომატურად; სავალდებულო ველები (note_required) ბლოკავს დასრულებას. ხელმოწერა → or_cases.locked_at.
--  • #7 მასალები / იმპლანტები / დათვლა — preference card (or_preference_cards, preference_cards: off / procedure / procedure_surgeon);
--      ოპერაციის მასალები — or_case_items → ექთანი ადასტურებს → ჩამოწერა ბლოკის ლოკაციიდან (FEFO) + ინვოისი (კატეგორიის წესით);
--      იმპლანტი — ლოტი + სერია სავალდებულო → პაციენტის იმპლანტების რეესტრი (patient_implants);
--      დათვლა — or_counts (initial / pre_closure / final), count_mode: off / warn / block.
--  • #8 CSSD — or_case_packs: შეფუთვა სკანირდება; არასტერილური / ვადაგასული → ბლოკი (DB trigger, არაარჩევადი); დასრულებისას → used.

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"nursing_team_by": "both",
                    "room_teams": true,
                    "anesthesia_meds": "direct",
                    "preference_cards": "procedure_surgeon",
                    "count_mode": "block",
                    "note_required": ["postop_dx", "procedures", "description", "complications", "blood_loss"]}'::jsonb || settings,
       description = 'ოთახები, კატალოგი, მოთხოვნა / დაგეგმვა, დაფა, გუნდი (ოთახის გუნდი), წინასაოპერაციო, WHO, ნიშნულები, ანესთეზიის რუკა, ოქმი, მასალები / იმპლანტები / დათვლა, CSSD'
 WHERE code = 'or';

-- ================================================================ 1. ოთახის გუნდი (roster)
ALTER TABLE or_case_team
    ADD COLUMN auto          BOOLEAN NOT NULL DEFAULT FALSE,     -- ოთახის დღის გუნდიდან (ავტომატურად)
    ADD COLUMN removed_auto  BOOLEAN NOT NULL DEFAULT FALSE;     -- სისტემამ მოხსნა (ოთახის / გუნდის ცვლილება); ხელით მოხსნილი ავტომატური აღარ ბრუნდება

CREATE TABLE or_room_staff (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id     UUID NOT NULL REFERENCES or_rooms(id),
    user_id     UUID NOT NULL REFERENCES users(id),
    role_code   VARCHAR(30) NOT NULL REFERENCES or_team_roles(code),
    added_by    UUID NOT NULL REFERENCES users(id),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at  TIMESTAMPTZ,
    removed_by  UUID REFERENCES users(id),
    CONSTRAINT chk_or_room_staff_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
-- თანამშრომელი მუდმივად — ერთ ოთახში (ერთი როლით); სხვა ოთახში — დღის ცვლილებით
CREATE UNIQUE INDEX ux_or_room_staff_user ON or_room_staff (user_id) WHERE removed_at IS NULL;
CREATE INDEX idx_or_room_staff_room ON or_room_staff (room_id) WHERE removed_at IS NULL;

CREATE TABLE or_room_staff_days (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    day           DATE NOT NULL,
    user_id       UUID NOT NULL REFERENCES users(id),
    room_id       UUID REFERENCES or_rooms(id),                         -- NULL = დღეს არ არის
    role_code     VARCHAR(30) REFERENCES or_team_roles(code),
    note          TEXT,
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at  TIMESTAMPTZ,
    cancelled_by  UUID REFERENCES users(id),
    CONSTRAINT chk_or_staff_day_role CHECK ((room_id IS NULL) = (role_code IS NULL)),
    CONSTRAINT chk_or_staff_day_cancel CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE UNIQUE INDEX ux_or_room_staff_day ON or_room_staff_days (day, user_id) WHERE cancelled_at IS NULL;
CREATE INDEX idx_or_room_staff_day_room ON or_room_staff_days (day, room_id) WHERE cancelled_at IS NULL;

-- ოთახის გუნდში — მხოლოდ ანესთეზიის / საექთნო როლები (ქირურგიული — ოპერაციაზე)
CREATE OR REPLACE FUNCTION or_room_staff_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM or_team_roles r WHERE r.code = NEW.role_code AND r.grp IN ('anesthesia', 'nursing')) THEN
        RAISE EXCEPTION 'ოთახის გუნდში — მხოლოდ ანესთეზიის / საექთნო როლები' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_room_staff_check BEFORE INSERT OR UPDATE ON or_room_staff FOR EACH ROW EXECUTE FUNCTION or_room_staff_check();
CREATE TRIGGER trg_or_room_staff_days_check BEFORE INSERT OR UPDATE ON or_room_staff_days FOR EACH ROW EXECUTE FUNCTION or_room_staff_check();

-- ================================================================ 2. ანესთეზიის რუკა
CREATE TABLE or_anesthesia_records (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id              UUID NOT NULL UNIQUE REFERENCES or_cases(id),
    patient_id           UUID NOT NULL REFERENCES patients(id),
    anesthesia_type      VARCHAR(12) NOT NULL CHECK (anesthesia_type IN ('general', 'spinal', 'epidural', 'combined', 'regional', 'sedation', 'local', 'none')),
    airway_device        VARCHAR(10) CHECK (airway_device IN ('none', 'nasal', 'mask', 'lma', 'ett', 'trach', 'other')),
    ett_size             NUMERIC(3,1) CHECK (ett_size BETWEEN 2 AND 10),
    intubation_attempts  SMALLINT CHECK (intubation_attempts BETWEEN 1 AND 10),
    cormack_lehane       SMALLINT CHECK (cormack_lehane BETWEEN 1 AND 4),
    difficult_airway     BOOLEAN NOT NULL DEFAULT FALSE,
    airway_notes         TEXT,
    technique_notes      TEXT,                                -- რეგიონული / ნეიროაქსიალური: დონე, ნემსი, პრეპარატი
    position             TEXT,                                -- პაციენტის პოზიცია
    complications        TEXT,
    notes                TEXT,
    status               VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
    created_by           UUID NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    signed_by            UUID REFERENCES users(id),
    signed_at            TIMESTAMPTZ,
    CONSTRAINT chk_or_anest_signed CHECK ((status = 'signed') = (signed_at IS NOT NULL) AND (signed_at IS NULL) = (signed_by IS NULL)),
    CONSTRAINT chk_or_anest_ett CHECK (airway_device = 'ett' OR (ett_size IS NULL AND intubation_attempts IS NULL))
);
CREATE TRIGGER trg_or_anest_updated BEFORE UPDATE ON or_anesthesia_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION or_anesthesia_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'signed' THEN
        RAISE EXCEPTION 'ხელმოწერილი ანესთეზიის რუკა არ რედაქტირდება' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_anest_guard BEFORE UPDATE ON or_anesthesia_records FOR EACH ROW EXECUTE FUNCTION or_anesthesia_guard();

-- ვიტალები (5-წთ ბადე) და სითხეები — არსებულ ცხრილებში (ბალანსი, ისტორია), ოპერაციაზე მიბმით
ALTER TABLE encounter_vitals ADD COLUMN or_case_id UUID REFERENCES or_cases(id);
CREATE UNIQUE INDEX ux_vitals_or_slot ON encounter_vitals (or_case_id, recorded_at) WHERE or_case_id IS NOT NULL AND voided_at IS NULL;
ALTER TABLE fluid_entries ADD COLUMN or_case_id UUID REFERENCES or_cases(id);
CREATE INDEX idx_fluid_or ON fluid_entries (or_case_id, recorded_at) WHERE or_case_id IS NOT NULL AND voided_at IS NULL;
-- სისხლის დაკარგვა — ცალკე კატეგორია (გამოყოფა)
ALTER TABLE fluid_entries DROP CONSTRAINT fluid_entries_category_check;
ALTER TABLE fluid_entries ADD CONSTRAINT fluid_entries_category_check CHECK (category IN ('po', 'iv', 'tube', 'blood', 'other_in', 'urine', 'drain', 'vomit', 'stool', 'blood_loss', 'other_out'));

-- მედიკამენტები (anesthesia_meds = direct / both): ჟურნალი + ხარჯი ბლოკის ლოკაციიდან
CREATE TABLE or_anesthesia_meds (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       UUID NOT NULL REFERENCES or_cases(id),
    given_at      TIMESTAMPTZ NOT NULL,
    item_id       UUID NOT NULL REFERENCES stock_items(id),
    name          TEXT NOT NULL,                                      -- დასახელება (ჩაწერის მომენტისთვის)
    dose          NUMERIC(14,4) NOT NULL CHECK (dose > 0),
    dose_unit     VARCHAR(20),
    route_code    VARCHAR(10) REFERENCES med_routes(code),
    qty_base      NUMERIC(14,3) NOT NULL CHECK (qty_base > 0),       -- ჩამოწერილი (საბაზო ერთეული)
    dose_wasted   NUMERIC(14,4) CHECK (dose_wasted >= 0),            -- ნარჩენი (განადგურება — მოწმით)
    controlled    BOOLEAN NOT NULL DEFAULT FALSE,
    witness_id    UUID REFERENCES users(id),
    stock_doc_id  UUID REFERENCES stock_docs(id),
    note          TEXT,
    recorded_by   UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- არაარჩევადი: ნარკოტიკული / ფსიქოტროპული — მოწმე და ნარჩენის აღრიცხვა ყოველთვის
    CONSTRAINT chk_or_med_controlled CHECK (NOT controlled OR (witness_id IS NOT NULL AND dose_wasted IS NOT NULL AND witness_id <> recorded_by))
);
CREATE INDEX idx_or_anest_meds ON or_anesthesia_meds (case_id, given_at);

-- ================================================================ 3. ოქმი
CREATE TABLE or_note_templates (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    procedure_id  UUID REFERENCES or_procedures(id),                  -- პროცედურის შაბლონი (admin) ან პერსონალურის მიბმა
    owner_id      UUID REFERENCES users(id),                          -- პერსონალური (ქირურგი)
    description   TEXT,
    findings      TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_or_nt_scope CHECK (procedure_id IS NOT NULL OR owner_id IS NOT NULL)
);
CREATE TRIGGER trg_or_note_templates_updated BEFORE UPDATE ON or_note_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE or_op_notes (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id             UUID NOT NULL REFERENCES or_cases(id),
    patient_id          UUID NOT NULL REFERENCES patients(id),
    version             INT NOT NULL DEFAULT 1 CHECK (version > 0),
    root_id             UUID REFERENCES or_op_notes(id),
    amends_id           UUID REFERENCES or_op_notes(id),
    amend_reason        TEXT,
    preop_icd10_code    VARCHAR(10) REFERENCES icd10_codes(code),
    preop_icd10_title   TEXT,
    postop_icd10_code   VARCHAR(10) REFERENCES icd10_codes(code),
    postop_icd10_title  TEXT,
    procedures          JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(procedures) = 'array'),   -- [{procedure_id, code, name, ncsp_code, side, is_primary}]
    description         TEXT,
    findings            TEXT,
    complications       TEXT,
    complications_none  BOOLEAN NOT NULL DEFAULT FALSE,
    blood_loss_ml       INT CHECK (blood_loss_ml BETWEEN 0 AND 50000),
    drains              JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(drains) = 'array'),       -- [{kind, site, size, details, line_id}]
    specimens           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(specimens) = 'array'),    -- [{jar_no, site, pieces, description}]
    path_lab            TEXT,
    path_clinical_info  TEXT,
    implants            JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(implants) = 'array'),     -- ხელმოწერისას (რეესტრიდან)
    template_id         UUID REFERENCES or_note_templates(id),
    status              VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
    superseded_at       TIMESTAMPTZ,
    author_id           UUID NOT NULL REFERENCES users(id),
    signed_by           UUID REFERENCES users(id),
    signed_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_or_note_signed CHECK ((status = 'signed') = (signed_at IS NOT NULL) AND (signed_at IS NULL) = (signed_by IS NULL)),
    CONSTRAINT chk_or_note_amend CHECK ((amends_id IS NULL) = (amend_reason IS NULL) AND (amend_reason IS NULL OR length(btrim(amend_reason)) >= 3)),
    CONSTRAINT chk_or_note_superseded CHECK (superseded_at IS NULL OR status = 'signed'),
    CONSTRAINT chk_or_note_compl CHECK (NOT (complications_none AND length(btrim(coalesce(complications, ''))) > 0))
);
CREATE UNIQUE INDEX ux_or_note_draft ON or_op_notes (case_id) WHERE status = 'draft';
CREATE UNIQUE INDEX ux_or_note_current ON or_op_notes (case_id) WHERE status = 'signed' AND superseded_at IS NULL;
CREATE INDEX idx_or_notes_case ON or_op_notes (case_id, version);
CREATE TRIGGER trg_or_op_notes_updated BEFORE UPDATE ON or_op_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- ხელმოწერილი ოქმი არ იცვლება (მხოლოდ superseded_at); შესწორება — ახალი ვერსია მიზეზით
CREATE OR REPLACE FUNCTION or_op_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'ხელმოწერილი ოქმი არ იშლება' USING ERRCODE = 'check_violation'; END IF;
        RETURN OLD;
    END IF;
    IF NEW.case_id <> OLD.case_id OR NEW.version <> OLD.version OR NEW.root_id IS DISTINCT FROM OLD.root_id OR NEW.amends_id IS DISTINCT FROM OLD.amends_id THEN
        RAISE EXCEPTION 'ოქმის მიბმა არ იცვლება' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'signed' AND ((to_jsonb(NEW) - ARRAY['superseded_at', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_at', 'updated_at'])
                                  OR OLD.superseded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'ხელმოწერილი ოქმი არ რედაქტირდება — შექმენით შესწორებული ვერსია (მიზეზით)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_op_notes_guard BEFORE UPDATE OR DELETE ON or_op_notes FOR EACH ROW EXECUTE FUNCTION or_op_notes_guard();

-- დრენაჟები (0044) — ოპერაციიდან
ALTER TABLE lines_drains ADD COLUMN or_case_id UUID REFERENCES or_cases(id);

-- ბიოფსია → გარე პათოლოგია (0014): მიმართვა ენდოსკოპიიდან ან ოპერაციიდან
ALTER TABLE path_requests ALTER COLUMN order_item_id DROP NOT NULL;
ALTER TABLE path_requests ADD COLUMN or_case_id UUID UNIQUE REFERENCES or_cases(id),
    ADD CONSTRAINT chk_path_source CHECK ((order_item_id IS NULL) <> (or_case_id IS NULL));

-- ================================================================ 4. მასალები / preference card / იმპლანტები / დათვლა
CREATE TABLE or_preference_cards (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    procedure_id  UUID NOT NULL REFERENCES or_procedures(id),
    surgeon_id    UUID REFERENCES users(id),                         -- NULL = პროცედურის ზოგადი ბარათი
    notes         TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_or_pref_card ON or_preference_cards (procedure_id, coalesce(surgeon_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TRIGGER trg_or_pref_cards_updated BEFORE UPDATE ON or_preference_cards FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE or_preference_card_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    card_id     UUID NOT NULL REFERENCES or_preference_cards(id) ON DELETE CASCADE,
    item_id     UUID NOT NULL REFERENCES stock_items(id),
    qty         NUMERIC(12,3) NOT NULL CHECK (qty > 0),
    note        TEXT,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    UNIQUE (card_id, item_id)
);

CREATE TABLE or_case_items (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       UUID NOT NULL REFERENCES or_cases(id),
    item_id       UUID NOT NULL REFERENCES stock_items(id),
    qty           NUMERIC(14,3) NOT NULL CHECK (qty > 0),             -- საბაზო ერთეული
    lot_id        UUID REFERENCES stock_lots(id),                     -- სკანირებით / არჩევით (იმპლანტი — სავალდებულო); სხვა — FEFO
    source        VARCHAR(6) NOT NULL DEFAULT 'manual' CHECK (source IN ('card', 'manual', 'scan')),
    is_implant    BOOLEAN NOT NULL DEFAULT FALSE,
    implant_site  TEXT,
    note          TEXT,
    added_by      UUID NOT NULL REFERENCES users(id),
    added_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_at     TIMESTAMPTZ,                                        -- ექთანმა დაადასტურა → ჩამოწერილია
    posted_by     UUID REFERENCES users(id),
    stock_doc_id  UUID REFERENCES stock_docs(id),
    CONSTRAINT chk_or_item_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL) AND (posted_at IS NULL) = (stock_doc_id IS NULL)),
    CONSTRAINT chk_or_item_implant CHECK (NOT is_implant OR posted_at IS NULL OR lot_id IS NOT NULL)
);
CREATE INDEX idx_or_case_items ON or_case_items (case_id, added_at);
-- ჩამოწერილი ხაზი არ იცვლება / არ იშლება
CREATE OR REPLACE FUNCTION or_case_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.posted_at IS NOT NULL THEN
        RAISE EXCEPTION 'ჩამოწერილი მასალა არ იცვლება (შესწორება — საწყობის დოკუმენტით)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_or_case_items_guard BEFORE UPDATE OR DELETE ON or_case_items FOR EACH ROW EXECUTE FUNCTION or_case_items_guard();

-- პაციენტის იმპლანტების რეესტრი
CREATE TABLE patient_implants (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id         UUID NOT NULL REFERENCES patients(id),
    case_id            UUID REFERENCES or_cases(id),
    encounter_id       UUID REFERENCES encounters(id),
    item_id            UUID REFERENCES stock_items(id),
    name               TEXT NOT NULL,
    manufacturer       TEXT,
    lot_no             VARCHAR(40) NOT NULL CHECK (length(btrim(lot_no)) >= 1),
    serial_no          VARCHAR(60) NOT NULL CHECK (length(btrim(serial_no)) >= 1),
    expires_on         DATE,
    site               TEXT,
    implanted_at       TIMESTAMPTZ NOT NULL,
    stock_doc_line_id  UUID REFERENCES stock_doc_lines(id),
    recorded_by        UUID NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at         TIMESTAMPTZ,
    removed_reason     TEXT,
    CONSTRAINT chk_implant_removed CHECK (removed_at IS NULL OR length(btrim(coalesce(removed_reason, ''))) >= 3)
);
CREATE INDEX idx_patient_implants ON patient_implants (patient_id, implanted_at DESC);
CREATE INDEX idx_patient_implants_serial ON patient_implants (upper(serial_no));
CREATE INDEX idx_patient_implants_lot ON patient_implants (item_id, upper(lot_no));

-- დათვლა: საფენები / ნემსები / ინსტრუმენტები (დაწყება / დახურვამდე / ბოლოს)
CREATE TABLE or_counts (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id      UUID NOT NULL REFERENCES or_cases(id),
    phase        VARCHAR(12) NOT NULL CHECK (phase IN ('initial', 'pre_closure', 'final')),
    lines        JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),   -- [{kind, label, expected, counted}]
    correct      BOOLEAN NOT NULL,
    explanation  TEXT,                                                   -- შეუსაბამობა: ახსნა
    xray         BOOLEAN NOT NULL DEFAULT FALSE,                         -- რენტგენით შემოწმდა (შეუსაბამობისას)
    second_by    UUID REFERENCES users(id),                              -- მეორე დამთვლელი
    done_by      UUID NOT NULL REFERENCES users(id),
    done_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_or_count_expl CHECK (correct OR length(btrim(coalesce(explanation, ''))) >= 3),
    CONSTRAINT chk_or_count_second CHECK (second_by IS NULL OR second_by <> done_by)
);
CREATE INDEX idx_or_counts ON or_counts (case_id, phase, done_at);
CREATE TRIGGER trg_or_counts_immutable BEFORE UPDATE OR DELETE ON or_counts FOR EACH ROW EXECUTE FUNCTION inpatient_events_immutable();

-- ================================================================ 5. CSSD ნაკრები ოპერაციაზე
CREATE TABLE or_case_packs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id        UUID NOT NULL REFERENCES or_cases(id),
    pack_id        UUID NOT NULL REFERENCES cssd_packs(id),
    added_by       UUID NOT NULL REFERENCES users(id),
    added_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at     TIMESTAMPTZ,
    removed_by     UUID REFERENCES users(id),
    remove_reason  TEXT,
    used_at        TIMESTAMPTZ,
    CONSTRAINT chk_or_pack_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL) AND NOT (removed_at IS NOT NULL AND used_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_or_case_pack ON or_case_packs (pack_id) WHERE removed_at IS NULL;
CREATE INDEX idx_or_case_packs ON or_case_packs (case_id);
-- არაარჩევადი (ტექნიკური დავალება): არასტერილური / ვადაგასული / გაწვეული შეფუთვა ოპერაციაზე ვერ დაემატება
CREATE OR REPLACE FUNCTION or_case_packs_sterile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v cssd_packs%ROWTYPE;
BEGIN
    SELECT * INTO v FROM cssd_packs WHERE id = NEW.pack_id;
    IF v.status NOT IN ('sterile', 'issued') OR (v.expires_on IS NOT NULL AND v.expires_on < (now() AT TIME ZONE 'Asia/Tbilisi')::date) THEN
        RAISE EXCEPTION 'CSSD: შეფუთვა % არ არის სტერილური (%) — გამოყენება აკრძალულია', v.pack_no, v.status USING ERRCODE = 'check_violation', CONSTRAINT = 'or_pack_not_sterile';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_or_case_packs_sterile BEFORE INSERT ON or_case_packs FOR EACH ROW EXECUTE FUNCTION or_case_packs_sterile();

-- ================================================================ 6. ისტორია
ALTER TABLE or_case_events DROP CONSTRAINT or_case_events_kind_check;
ALTER TABLE or_case_events ADD CONSTRAINT or_case_events_kind_check CHECK (kind IN ('requested', 'updated', 'tentative', 'scheduled', 'confirmed', 'rescheduled', 'unscheduled', 'cancelled',
    'surgeon_changed', 'team_added', 'team_removed', 'team_out', 'preop_signed', 'preop_voided', 'readiness', 'readiness_override',
    'who', 'who_voided', 'time', 'time_corrected', 'encounter_linked',
    -- 0049
    'team_auto', 'anesthesia_signed', 'anesthesia_med', 'note_signed', 'note_amend', 'items_posted', 'count', 'count_override',
    'pack_added', 'pack_removed', 'packs_used', 'pathology'));

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
    'news2_alert', 'line_inserted', 'line_removed', 'handover',
    'note_signed', 'note_amended', 'consult_requested', 'consult_answered', 'consult_cancelled', 'form100_issued',
    'billing_package', 'payer_added', 'payer_cancelled', 'deposit', 'deposit_refund', 'deposit_voided', 'billing_finalized', 'billing_reopened',
    'icu_in', 'icu_out', 'icu_interval', 'vent_started', 'vent_ended', 'icu_score',
    'or_requested', 'or_scheduled', 'or_cancelled', 'or_started', 'or_completed',
    -- 0049
    'or_note_signed', 'or_implant'));

-- ================================================================ 7. აპლიკაციის როლი
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON or_room_staff, or_room_staff_days, or_anesthesia_records, or_anesthesia_meds, or_op_notes, patient_implants, or_counts, or_case_packs FROM emr_app;
    REVOKE TRUNCATE ON or_note_templates, or_preference_cards, or_preference_card_items, or_case_items FROM emr_app;
  END IF;
END $$;
