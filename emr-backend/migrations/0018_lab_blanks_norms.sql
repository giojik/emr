-- 0018_lab_blanks_norms.sql
-- ლაბორატორია:
--  • ანალიზატორები / მეთოდები (lab_methods) — ნორმის კრიტერიუმი და ბლანკზე ჩვენება
--  • ნორმის კრიტერიუმები: + ორსულობა/ტრიმესტრი, + ანალიზატორი/მეთოდი
--  • ნორმების ვერსიები (lab_norm_versions) — უცვლელი ისტორია: ვინ, როდის, რატომ, რა იყო → რა გახდა
--  • ბლანკების შაბლონები: ვერსიები (უცვლელი), სურათები (ლოგო/ხელმოწერა/ბეჭედი), მინიჭება ჯგუფზე/ანალიზზე
--  • ვალიდირებული შედეგი იმახსოვრებს ბლანკის ვერსიას და QR ვერიფიკაციის ტოკენს

-- ---------------------------------------------------------------- ანალიზატორები / მეთოდები
CREATE TABLE lab_methods (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,                                   -- „Mindray BC-6200“, „ხელით — მიკროსკოპია“
    kind            VARCHAR(10) NOT NULL DEFAULT 'analyzer' CHECK (kind IN ('analyzer', 'manual', 'method')),
    manufacturer    TEXT,
    serial_number   TEXT,
    note            TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_lab_methods_name ON lab_methods (lower(name));
CREATE TRIGGER trg_lab_methods_updated BEFORE UPDATE ON lab_methods FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ანალიზის ნაგულისხმევი ანალიზატორი + ბლანკზე დასაბეჭდი კომენტარი (მაგ. ინტერპრეტაციის ცხრილი)
ALTER TABLE dx_services
    ADD COLUMN default_method_id UUID REFERENCES lab_methods(id),
    ADD COLUMN report_comment    TEXT;

-- ---------------------------------------------------------------- ნორმის კრიტერიუმები
ALTER TABLE lab_reference_ranges
    ADD COLUMN pregnancy  VARCHAR(4) CHECK (pregnancy IN ('P', 'T1', 'T2', 'T3')),  -- NULL = ორსულობის მიუხედავად; P = ნებისმიერი ტრიმესტრი
    ADD COLUMN method_id  UUID REFERENCES lab_methods(id);                          -- NULL = ნებისმიერი ანალიზატორი
ALTER TABLE lab_reference_ranges ADD CONSTRAINT chk_lab_range_pregnancy_female CHECK (pregnancy IS NULL OR sex IS DISTINCT FROM 'male');

-- ორსულობის ვადა (კვირა) — აღებისას ან შედეგის შეტანისას; ტრიმესტრი გამოითვლება
ALTER TABLE dx_order_items
    ADD COLUMN pregnancy_weeks   SMALLINT CHECK (pregnancy_weeks BETWEEN 1 AND 45),
    ADD COLUMN lab_method_id     UUID REFERENCES lab_methods(id),
    ADD COLUMN blank_version_id  UUID,                                             -- FK ქვემოთ
    ADD COLUMN verify_token      UUID UNIQUE;

-- შედეგი: რომელი ნორმის ვერსიით შეფასდა; ნორმის შეცვლის შემდეგ ავტომატური გადათვლა
ALTER TABLE lab_results
    ADD COLUMN norm_version     INT,
    ADD COLUMN recalculated_at  TIMESTAMPTZ;

-- ---------------------------------------------------------------- ნორმების ვერსიები (უცვლელი ისტორია)
CREATE TABLE lab_norm_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analyte_id      UUID NOT NULL REFERENCES lab_analytes(id),
    version         INT NOT NULL,
    ranges          JSONB NOT NULL,          -- [{sex, age_min_days, age_max_days, pregnancy, method_id, low, high, normal_text}]
    critical_low    NUMERIC,
    critical_high   NUMERIC,
    unit            TEXT NOT NULL DEFAULT '',
    reason          TEXT NOT NULL,
    changed_by      UUID REFERENCES users(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recalculated    INT NOT NULL DEFAULT 0,  -- რამდენი დაუმტკიცებელი შედეგი გადაითვალა
    UNIQUE (analyte_id, version)
);
CREATE TRIGGER trg_lab_norm_versions_immutable BEFORE UPDATE OR DELETE ON lab_norm_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE lab_analytes ADD COLUMN norm_version INT NOT NULL DEFAULT 1;

-- საწყისი ვერსია არსებული ნორმებიდან
INSERT INTO lab_norm_versions (analyte_id, version, ranges, critical_low, critical_high, unit, reason)
SELECT a.id, 1,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('sex', r.sex, 'age_min_days', r.age_min_days, 'age_max_days', r.age_max_days,
                   'pregnancy', r.pregnancy, 'method_id', r.method_id, 'low', r.low, 'high', r.high, 'normal_text', r.normal_text)
                   ORDER BY r.sex NULLS FIRST, r.age_min_days)
                 FROM lab_reference_ranges r WHERE r.analyte_id = a.id), '[]'::jsonb),
       a.critical_low, a.critical_high, a.unit, 'საწყისი ნორმები (კატალოგის შაბლონი)'
FROM lab_analytes a;
UPDATE lab_results SET norm_version = 1;

-- ---------------------------------------------------------------- ბლანკები
-- სურათები (ლოგო, ხელმოწერა, ბეჭედი) — ბაზაში, შიგთავსის ჰეშით; იცვლება მხოლოდ ახლის ატვირთვით
CREATE TABLE lab_blank_images (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sha256          CHAR(64) NOT NULL UNIQUE,
    mime            VARCHAR(20) NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
    data            BYTEA NOT NULL CHECK (octet_length(data) <= 1048576),
    width           INT NOT NULL,
    height          INT NOT NULL,
    uploaded_by     UUID REFERENCES users(id),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_lab_blank_images_immutable BEFORE UPDATE OR DELETE ON lab_blank_images FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE lab_blank_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    current_version INT NOT NULL DEFAULT 1,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT is_default OR is_active)
);
CREATE UNIQUE INDEX uq_lab_blank_name ON lab_blank_templates (lower(name));
CREATE UNIQUE INDEX uq_lab_blank_default ON lab_blank_templates (is_default) WHERE is_default;
CREATE TRIGGER trg_lab_blank_templates_updated BEFORE UPDATE ON lab_blank_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ყოველი შენახვა = ახალი ვერსია; ძველი ვერსიით დაბეჭდილი პასუხი ხელახლაც იმავე სახით იბეჭდება
CREATE TABLE lab_blank_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id     UUID NOT NULL REFERENCES lab_blank_templates(id),
    version         INT NOT NULL,
    settings        JSONB NOT NULL,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (template_id, version)
);
CREATE TRIGGER trg_lab_blank_versions_immutable BEFORE UPDATE OR DELETE ON lab_blank_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE dx_order_items ADD CONSTRAINT fk_dx_items_blank_version FOREIGN KEY (blank_version_id) REFERENCES lab_blank_versions(id);

-- მინიჭება: ანალიზზე (dx_services.blank_template_id) → ჯგუფზე → ნაგულისხმევი
ALTER TABLE dx_services ADD COLUMN blank_template_id UUID REFERENCES lab_blank_templates(id);
CREATE TABLE lab_blank_group_assignments (
    group_name      TEXT PRIMARY KEY,
    template_id     UUID NOT NULL REFERENCES lab_blank_templates(id)
);

-- საწყისი შაბლონი — ახლანდელი ბლანკის მსგავსი
WITH t AS (
    INSERT INTO lab_blank_templates (name, is_default) VALUES ('სტანდარტული', TRUE) RETURNING id
)
INSERT INTO lab_blank_versions (template_id, version, settings)
SELECT id, 1, '{
  "paper": "A4", "margin_mm": 16, "font_size": 9, "accent_color": "#1F4E79",
  "header": { "logo_image_id": null, "logo_position": "left", "logo_height_mm": 16, "show_clinic": true, "extra_lines": [],
              "title": "ლაბორატორიული კვლევის პასუხი", "subtitle": "" },
  "patient_fields": ["personal_number", "birth_date", "age", "gender", "ordered_by", "referral"],
  "layout": "table", "group_headers": false,
  "columns": ["unit", "reference", "flag"],
  "flag_style": "words", "highlight_abnormal": true, "show_sample_info": true, "show_service_comment": true,
  "footer": { "note": "", "show_validator": true, "signer_title": "ლაბორატორიის ექიმი", "signature_image_id": null, "stamp_image_id": null,
              "show_qr": false, "show_page_numbers": true, "legend": true }
}'::jsonb FROM t;

-- ბლანკის შაბლონი ანალიზისთვის: ანალიზზე მინიჭებული → ჯგუფზე მინიჭებული → ნაგულისხმევი (მხოლოდ აქტიური)
CREATE FUNCTION lab_blank_template_for_service(p_service UUID) RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT t.id
    FROM dx_services s
    LEFT JOIN lab_blank_group_assignments g ON g.group_name = s.group_name
    JOIN lab_blank_templates t ON t.is_active AND (t.id = s.blank_template_id OR t.id = g.template_id OR t.is_default)
    WHERE s.id = p_service
    ORDER BY CASE WHEN t.id = s.blank_template_id THEN 0 WHEN t.id = g.template_id THEN 1 ELSE 2 END
    LIMIT 1
$$;
-- შეკვეთისთვის — შაბლონის მიმდინარე ვერსია (ფიქსირდება ვალიდაციისას)
CREATE FUNCTION lab_blank_version_for(p_item UUID) RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT v.id
    FROM dx_order_items i
    JOIN lab_blank_templates t ON t.id = lab_blank_template_for_service(i.service_id)
    JOIN lab_blank_versions v ON v.template_id = t.id AND v.version = t.current_version
    WHERE i.id = p_item
$$;

-- უკვე ვალიდირებულ შედეგებს — ნაგულისხმევი შაბლონის პირველი ვერსია და QR ტოკენი
UPDATE dx_order_items SET blank_version_id = lab_blank_version_for(id), verify_token = uuid_generate_v4()
WHERE section = 'lab' AND status = 'validated';
