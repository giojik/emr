-- 0013_radiology_workflow.sql
-- რადიოლოგია (dcm4chee-ს გარეშე — MWL/OHIF შემდეგ ეტაპზე):
--  1) როლები: radiographer (რენტგენ-ტექნიკოსი — პაციენტის მიღება, კვლევის შესრულება),
--             radiologist (დასკვნა + ხელმოწერა); users.is_section_head — განყოფილების ხელმძღვანელი (საერთო შაბლონები)
--  2) აპარატები/კაბინეტები + ჩაწერა დროზე (გადაფარვის აკრძალვა DB დონეზე; ერთი ვიზიტის კვლევები ერთ სლოტში შეიძლება)
--  3) სტატუსები: ordered → scheduled → arrived → performed → in_progress (დასკვნის draft) → validated (ხელმოწერილი)
--  4) დასკვნა სექციებად + ხელმოწერილი ვერსიების უცვლელი არქივი (ხელახლა გახსნა მიზეზით)
--  5) დასკვნის შაბლონები და სწრაფი ფრაზები: საერთო (owner NULL) + პირადი
-- ⚠️ საწყისი აპარატები და შაბლონები — ნიმუში: კლინიკამ/რადიოლოგებმა უნდა გადაამოწმონ.

-- ---------------------------------------------------------------- 1) როლები
ALTER TABLE users DROP CONSTRAINT chk_users_role;
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (
    role IN ('admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic', 'lab_doctor', 'lab_manager', 'phlebotomist',
             'radiographer', 'radiologist'));
ALTER TABLE users ADD COLUMN is_section_head BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------- 2) აპარატები
CREATE TABLE dx_devices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    section         VARCHAR(20) NOT NULL DEFAULT 'radiology' CHECK (section IN ('radiology', 'endoscopy')),
    name            TEXT NOT NULL UNIQUE,
    modalities      VARCHAR(10)[] NOT NULL CHECK (cardinality(modalities) > 0),   -- CT | MR | US | DX | RF | MG | DXA
    room            TEXT,
    ae_title        VARCHAR(16),                       -- dcm4chee MWL (ეტაპი გ) — ჯერ არ გამოიყენება
    slot_minutes    SMALLINT NOT NULL DEFAULT 20 CHECK (slot_minutes BETWEEN 5 AND 240),
    work_start      TIME NOT NULL DEFAULT '09:00',
    work_end        TIME NOT NULL DEFAULT '18:00',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    CHECK (work_start < work_end)
);

-- კვლევის ხანგრძლივობა (NULL = აპარატის სლოტი) და პაციენტის მომზადება (ჩაწერის ფურცელზე)
ALTER TABLE dx_services
    ADD COLUMN duration_minutes  SMALLINT CHECK (duration_minutes BETWEEN 5 AND 480),
    ADD COLUMN prep_instructions TEXT;

-- ---------------------------------------------------------------- 3) შეკვეთის ველები და სტატუსები
ALTER TABLE dx_order_items DROP CONSTRAINT dx_order_items_status_check;
ALTER TABLE dx_order_items ADD CONSTRAINT dx_order_items_status_check CHECK (
    status IN ('ordered', 'scheduled', 'arrived', 'performed', 'collected', 'in_progress', 'resulted', 'validated', 'cancelled'));

ALTER TABLE dx_order_items
    ADD COLUMN device_id          UUID REFERENCES dx_devices(id),
    ADD COLUMN scheduled_start    TIMESTAMPTZ,
    ADD COLUMN scheduled_end      TIMESTAMPTZ,
    ADD COLUMN scheduled_by       UUID REFERENCES users(id),
    ADD COLUMN arrived_at         TIMESTAMPTZ,
    ADD COLUMN arrived_by         UUID REFERENCES users(id),
    ADD COLUMN performed_at       TIMESTAMPTZ,
    ADD COLUMN technician_id      UUID REFERENCES users(id),
    ADD COLUMN contrast_agent     TEXT,                -- პრეპარატი (მაგ. იოჰექსოლი 350)
    ADD COLUMN contrast_volume_ml NUMERIC(6,1) CHECK (contrast_volume_ml > 0),
    ADD COLUMN dose_text          TEXT,                -- DLP (mGy·cm) / DAP / CTDIvol — თავისუფალი ფორმით
    ADD COLUMN tech_note          TEXT,                -- ტექნიკოსის შენიშვნა რადიოლოგისთვის
    ADD COLUMN safety             JSONB,               -- უსაფრთხოების კითხვარი (MRI / ორსულობა / კონტრასტი)
    ADD CONSTRAINT chk_dx_schedule CHECK (
        (scheduled_start IS NULL AND scheduled_end IS NULL) OR
        (scheduled_start IS NOT NULL AND scheduled_end > scheduled_start AND device_id IS NOT NULL));

-- ერთ აპარატზე ერთდროულად ორი სხვადასხვა ვიზიტის კვლევა არ ჩაიწერება (ერთი ვიზიტის რამდენიმე კვლევა — შეიძლება)
ALTER TABLE dx_order_items ADD CONSTRAINT excl_dx_device_overlap
    EXCLUDE USING gist (device_id WITH =, encounter_id WITH <>, tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status IN ('scheduled', 'arrived') AND device_id IS NOT NULL);
CREATE INDEX idx_dx_items_schedule ON dx_order_items (device_id, scheduled_start) WHERE scheduled_start IS NOT NULL;

-- ---------------------------------------------------------------- 4) დასკვნა
CREATE TABLE dx_reports (
    order_item_id        UUID PRIMARY KEY REFERENCES dx_order_items(id),
    technique            TEXT,
    findings             TEXT,                          -- აღწერა
    impression           TEXT,                          -- დასკვნა
    recommendation       TEXT,
    is_critical          BOOLEAN NOT NULL DEFAULT FALSE, -- კრიტიკული მიგნება
    critical_notified_to TEXT,                          -- ვის ეცნობა (ექიმი, ტელეფონით…)
    critical_notified_at TIMESTAMPTZ,
    version              INT NOT NULL DEFAULT 1,
    status               VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
    template_id          UUID,
    author_id            UUID REFERENCES users(id),
    signed_by            UUID REFERENCES users(id),
    signed_at            TIMESTAMPTZ,
    amend_reason         TEXT,                          -- ხელახლა გახსნის მიზეზი (ვერსია > 1)
    amended_by           UUID REFERENCES users(id),
    amended_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status = 'draft' OR (signed_by IS NOT NULL AND signed_at IS NOT NULL AND impression IS NOT NULL)),
    CHECK (NOT is_critical OR status = 'draft' OR critical_notified_to IS NOT NULL),
    CHECK (version = 1 OR amend_reason IS NOT NULL)
);
CREATE TRIGGER trg_dx_reports_updated BEFORE UPDATE ON dx_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ხელმოწერილი ვერსიების არქივი — მხოლოდ INSERT (UPDATE/DELETE იბლოკება ტრიგერით, აპლიკაციის როლის მიუხედავად)
CREATE TABLE dx_report_versions (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id        UUID NOT NULL REFERENCES dx_order_items(id),
    version              INT NOT NULL,
    technique            TEXT,
    findings             TEXT,
    impression           TEXT NOT NULL,
    recommendation       TEXT,
    is_critical          BOOLEAN NOT NULL,
    critical_notified_to TEXT,
    amend_reason         TEXT,
    signed_by            UUID NOT NULL REFERENCES users(id),
    signed_at            TIMESTAMPTZ NOT NULL,
    UNIQUE (order_item_id, version)
);
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% — ჩანაწერი უცვლელია', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER trg_dx_report_versions_immutable BEFORE UPDATE OR DELETE ON dx_report_versions
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- 5) შაბლონები და ფრაზები
CREATE TABLE dx_report_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    section         VARCHAR(20) NOT NULL CHECK (section IN ('radiology', 'endoscopy')),
    kind            VARCHAR(10) NOT NULL DEFAULT 'template' CHECK (kind IN ('template', 'phrase')),
    name            TEXT NOT NULL,
    modality        VARCHAR(10),                       -- NULL = ნებისმიერი
    service_id      UUID REFERENCES dx_services(id),   -- NULL = მოდალობის ყველა კვლევა
    owner_id        UUID REFERENCES users(id),         -- NULL = საერთო (ხელმძღვანელი / admin)
    technique       TEXT,
    findings        TEXT,
    impression      TEXT,
    recommendation  TEXT,
    target          VARCHAR(15) CHECK (target IN ('technique', 'findings', 'impression', 'recommendation')),  -- ფრაზა: სად ჩაისმება
    body            TEXT,                                                                                      -- ფრაზის ტექსტი
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (kind = 'template' OR (body IS NOT NULL AND target IS NOT NULL)),
    CHECK (kind = 'phrase' OR coalesce(technique, findings, impression, recommendation) IS NOT NULL)
);
CREATE INDEX idx_dx_templates_lookup ON dx_report_templates (section, kind, modality) WHERE is_active;
CREATE INDEX idx_dx_templates_owner ON dx_report_templates (owner_id);
CREATE TRIGGER trg_dx_templates_updated BEFORE UPDATE ON dx_report_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE dx_reports ADD CONSTRAINT fk_dx_reports_template FOREIGN KEY (template_id) REFERENCES dx_report_templates(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- საწყისი მონაცემები (ნიმუში)
INSERT INTO dx_devices (name, modalities, room, slot_minutes, sort_order) VALUES
    ('CT',                  '{CT}',     NULL, 20, 10),
    ('MRI',                 '{MR}',     NULL, 40, 20),
    ('ულტრაბგერა 1',        '{US}',     NULL, 20, 30),
    ('რენტგენი',            '{DX,RF}',  NULL, 10, 40),
    ('მამოგრაფი',           '{MG}',     NULL, 15, 50),
    ('დენსიტომეტრი',        '{DXA}',    NULL, 15, 60);

UPDATE dx_services SET duration_minutes = 40 WHERE code IN ('RAD_MR_BRAIN_C');
UPDATE dx_services SET duration_minutes = 30 WHERE code IN ('RAD_CT_ABD_C', 'RAD_RF_UGI');
UPDATE dx_services SET prep_instructions = 'უზმოზე (ბოლო კვება კვლევამდე 6 სთ-ით ადრე). თან იქონიეთ კრეატინინის ანალიზი (არაუმეტეს 30 დღის).' WHERE contrast = 'iodinated';
UPDATE dx_services SET prep_instructions = 'თან იქონიეთ კრეატინინის ანალიზი. აცნობეთ პერსონალს იმპლანტის, კარდიოსტიმულატორის ან კლაუსტროფობიის შესახებ.' WHERE contrast = 'gadolinium';
UPDATE dx_services SET prep_instructions = 'აცნობეთ პერსონალს იმპლანტის, კარდიოსტიმულატორის ან კლაუსტროფობიის შესახებ.' WHERE modality = 'MR' AND contrast IS NULL;
UPDATE dx_services SET prep_instructions = 'უზმოზე (6–8 სთ), კვლევამდე 1 დღით ადრე გამორიცხეთ გაზწარმომქმნელი საკვები.' WHERE code = 'RAD_US_ABD';
UPDATE dx_services SET prep_instructions = 'სავსე შარდის ბუშტით (კვლევამდე 1 სთ-ით ადრე დალიეთ 1 ლ წყალი).' WHERE code IN ('RAD_US_PELV');
UPDATE dx_services SET prep_instructions = 'უზმოზე (6 სთ).' WHERE code = 'RAD_RF_UGI';
UPDATE dx_services SET prep_instructions = 'კვლევის დღეს ნუ გამოიყენებთ დეოდორანტს/პუდრას. სასურველია ციკლის 5–12 დღე.' WHERE code = 'RAD_MG_BIL';

-- საერთო შაბლონები: „ნორმის“ ვარიანტები. ___ = შესავსები ადგილი (ხელმოწერამდე სავალდებულოა შევსება)
INSERT INTO dx_report_templates (section, kind, name, modality, technique, findings, impression, recommendation, sort_order) VALUES
('radiology', 'template', 'CT თავის ტვინი — ნორმა', 'CT',
 'თავის ტვინის CT, აქსიალური ჭრილები, კონტრასტის გარეშე. რეკონსტრუქცია რბილი ქსოვილისა და ძვლის ფანჯრებში.',
 E'ტვინის ნახევარსფეროების ნაცრისფერი და თეთრი ნივთიერების დიფერენციაცია შენარჩუნებულია.\nკეროვანი ცვლილებები, ინტრაკრანიული ჰემორაგიის ნიშნები არ ვლინდება.\nპარკუჭოვანი სისტემა სიმეტრიულია, არ არის გაფართოებული. შუა ხაზის სტრუქტურები არ არის წანაცვლებული.\nსუბარაქნოიდული სივრცეები და ცისტერნები დიფერენცირდება.\nქალას ძვლებში ტრავმული და დესტრუქციული ცვლილებები არ ვლინდება.\nცხვირის დანამატი წიაღები და დვრილისებრი მორჩის უჯრედები პნევმატიზებულია.',
 'თავის ტვინის CT კვლევით პათოლოგიური ცვლილებები არ ვლინდება.', NULL, 10),
('radiology', 'template', 'CT გულმკერდი — ნორმა', 'CT',
 'გულმკერდის CT, აქსიალური ჭრილები ___ მმ, MPR რეკონსტრუქცია, ფილტვისა და შუასაყრის ფანჯრები.',
 E'ფილტვის ქსოვილი ჰაეროვანია, კეროვანი და ინფილტრაციული ცვლილებები არ ვლინდება.\nტრაქეა და მთავარი ბრონქები გამავალია.\nპლევრის ღრუებში სითხე არ არის.\nშუასაყრის ლიმფური კვანძები არ არის გადიდებული.\nგული და მაგისტრალური სისხლძარღვები ჩვეული ზომისაა.\nძვლოვან სტრუქტურებში დესტრუქციული ცვლილებები არ ვლინდება.',
 'გულმკერდის ორგანოებში პათოლოგიური ცვლილებები არ ვლინდება.', NULL, 20),
('radiology', 'template', 'MRI თავის ტვინი — ნორმა', 'MR',
 'თავის ტვინის MRI: T1, T2, FLAIR, DWI/ADC, SWI მიმდევრობები, სამ სიბრტყეში.',
 E'ტვინის ნაცრისფერი და თეთრი ნივთიერების დიფერენციაცია შენარჩუნებულია.\nკეროვანი ცვლილებები, შეზღუდული დიფუზიის უბნები, ჰემოსიდერინის დეპოზიტები არ ვლინდება.\nპარკუჭოვანი სისტემა სიმეტრიულია, არ არის გაფართოებული.\nშუა ხაზის სტრუქტურები არ არის წანაცვლებული.\nჰიპოფიზი, ტვინის ღერო და ნათხემი ცვლილებების გარეშე.\nმთავარ სისხლძარღვებში ნაკადის სიგნალი შენარჩუნებულია.',
 'თავის ტვინის MRI კვლევით პათოლოგიური ცვლილებები არ ვლინდება.', NULL, 30),
('radiology', 'template', 'ულტრაბგერა მუცლის ღრუ — ნორმა', 'US',
 NULL,
 E'ღვიძლი: ზომები არ არის გადიდებული (მარჯვ. წილი ___ მმ), კონტური სწორი, ექოსტრუქტურა ერთგვაროვანი, კეროვანი ცვლილებები არ ვლინდება.\nნაღვლის ბუშტი: ჩვეული ფორმის, კედელი არ არის გასქელებული, კონკრემენტები არ ვლინდება.\nნაღვლის საერთო სადინარი: ___ მმ, არ არის გაფართოებული.\nპანკრეასი: ზომები ნორმის ფარგლებში, ექოსტრუქტურა ერთგვაროვანი.\nელენთა: ___ × ___ მმ, ექოსტრუქტურა ერთგვაროვანი.\nთირკმელები: ჩვეული მდებარეობის, ზომები ნორმის ფარგლებში, პარენქიმა ___ მმ, მენჯ-ფიალოვანი სისტემა არ არის გაფართოებული, კონკრემენტები არ ვლინდება.\nმუცლის ღრუში თავისუფალი სითხე არ არის.',
 'მუცლის ღრუს ორგანოებში ექოსკოპიური პათოლოგია არ ვლინდება.', NULL, 40),
('radiology', 'template', 'ულტრაბგერა ფარისებრი ჯირკვალი', 'US',
 NULL,
 E'მარჯვენა წილი: ___ × ___ × ___ მმ, მოცულობა ___ მლ.\nმარცხენა წილი: ___ × ___ × ___ მმ, მოცულობა ___ მლ.\nყელი: ___ მმ.\nჯამური მოცულობა: ___ მლ.\nექოსტრუქტურა ერთგვაროვანი, ექოგენობა ნორმალური. კვანძოვანი წარმონაქმნები არ ვლინდება.\nსისხლმომარაგება (CDI) არ არის გაძლიერებული.\nკისრის რეგიონული ლიმფური კვანძები არ არის გადიდებული.',
 'ფარისებრი ჯირკვლის ექოსკოპიური პათოლოგია არ ვლინდება.', NULL, 50),
('radiology', 'template', 'რენტგენოგრაფია გულმკერდი — ნორმა', 'DX',
 'გულმკერდის რენტგენოგრაფია, პირდაპირი პროექცია.',
 E'ფილტვის ველები ჰაეროვანია, კეროვანი და ინფილტრაციული ჩრდილები არ ვლინდება.\nფილტვის სურათი არ არის გაძლიერებული.\nფესვები სტრუქტურულია.\nდიაფრაგმის გუმბათები მკაფიო კონტურით, სინუსები თავისუფალია.\nგულის ჩრდილი არ არის გაფართოებული.',
 'გულმკერდის ორგანოებში რენტგენოლოგიური პათოლოგია არ ვლინდება.', NULL, 60),
('radiology', 'template', 'მამოგრაფია — BI-RADS', 'MG',
 'ორმხრივი მამოგრაფია, CC და MLO პროექციები.',
 E'სარძევე ჯირკვლების ქსოვილის სიმკვრივე: ACR ___.\nმარჯვენა: კვანძოვანი წარმონაქმნები, სტრუქტურის დეფორმაცია, საეჭვო მიკროკალციფიკატები არ ვლინდება.\nმარცხენა: კვანძოვანი წარმონაქმნები, სტრუქტურის დეფორმაცია, საეჭვო მიკროკალციფიკატები არ ვლინდება.\nიღლიის ლიმფური კვანძები ჩვეული სტრუქტურისაა.',
 'BI-RADS ___ (ორმხრივ).', 'სკრინინგული მამოგრაფია ___ თვის შემდეგ.', 70),
('radiology', 'template', 'დენსიტომეტრია (DXA)', 'DXA',
 'ორმაგი ენერგიის რენტგენული აბსორბციომეტრია (DXA): წელის მალები L1–L4, ბარძაყის პროქსიმალური ნაწილი.',
 E'L1–L4: BMD ___ გ/სმ², T-score ___, Z-score ___.\nბარძაყის ყელი: BMD ___ გ/სმ², T-score ___, Z-score ___.\nბარძაყი (სრული): BMD ___ გ/სმ², T-score ___, Z-score ___.',
 'ძვლის მინერალური სიმკვრივე: ___ (WHO კრიტერიუმებით).', NULL, 80),
('endoscopy', 'template', 'ეზოფაგოგასტროდუოდენოსკოპია — ნორმა', NULL,
 'მომზადება: ადექვატური. სედაცია: ___.',
 E'საყლაპავი: ლორწოვანი ვარდისფერი, გლუვი, გამავალი. Z-ხაზი ___ სმ-ზე საჭრელებიდან.\nკუჭი: შეიცავს მცირე რაოდენობით გამჭვირვალე სითხეს. ლორწოვანი ვარდისფერი, ნაკეცები ჩვეული. პილორუსი გამავალი.\nთორმეტგოჯა ნაწლავი: ბოლქვი და პოსტბულბარული ნაწილი ცვლილებების გარეშე.\nბიოფსია: არ აღებულა.',
 'ზედა კუჭ-ნაწლავის ტრაქტის ენდოსკოპიური პათოლოგია არ ვლინდება.', NULL, 10),
('endoscopy', 'template', 'კოლონოსკოპია — ნორმა', NULL,
 'მომზადება: ___ (ბოსტონის შკალა ___/9). სედაცია: ___. ინტუბირებულია: ___.',
 E'სწორი ნაწლავი, სიგმოიდური, დაღმავალი, განივი, აღმავალი კოლინჯი და ბრმა ნაწლავი: ლორწოვანი ვარდისფერი, სისხლძარღვოვანი სურათი შენარჩუნებული, ნეოპლაზიური და ანთებითი ცვლილებები არ ვლინდება.\nბაუჰინის სარქველი ცვლილებების გარეშე.\nბიოფსია: არ აღებულა.',
 'მსხვილი ნაწლავის ენდოსკოპიური პათოლოგია არ ვლინდება.', NULL, 20);

-- საერთო სწრაფი ფრაზები
INSERT INTO dx_report_templates (section, kind, name, modality, target, body, sort_order) VALUES
('radiology', 'phrase', 'კონტრასტით', NULL, 'technique', 'ინტრავენური კონტრასტირება: ___ ___ მლ.', 10),
('radiology', 'phrase', 'შედარება წინა კვლევასთან', NULL, 'findings', 'წინა კვლევასთან (___) შედარებით დინამიკა: ___.', 20),
('radiology', 'phrase', 'მოტორული არტეფაქტები', NULL, 'technique', 'კვლევა შესრულებულია მოძრაობის არტეფაქტებით, რაც ზღუდავს შეფასებას.', 30),
('radiology', 'phrase', 'კლინიკურ მონაცემებთან შეჯერება', NULL, 'recommendation', 'შედეგის შეჯერება კლინიკურ და ლაბორატორიულ მონაცემებთან.', 40),
('radiology', 'phrase', 'დინამიკაში კონტროლი', NULL, 'recommendation', 'საკონტროლო კვლევა ___ თვის შემდეგ.', 50),
('radiology', 'phrase', 'სპეციალისტის კონსულტაცია', NULL, 'recommendation', '___ კონსულტაცია.', 60),
('endoscopy', 'phrase', 'ბიოფსია აღებულია', NULL, 'findings', 'ბიოფსია: აღებულია ___ ფრაგმენტი (___), გაგზავნილია ჰისტოლოგიურ კვლევაზე.', 10),
('endoscopy', 'phrase', 'H. pylori სწრაფი ტესტი', NULL, 'findings', 'H. pylori სწრაფი ურეაზული ტესტი: ___.', 20);
