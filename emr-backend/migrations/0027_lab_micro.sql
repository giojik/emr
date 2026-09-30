-- 0027_lab_micro.sql
-- მიკრობიოლოგია: კულტურა → გრამის შეღებვა / ზრდა → იდენტიფიკაცია (რამდენიმე მიკროორგანიზმი) → ანტიბიოგრამა (MIC / ზონა, S/I/R)
--  • წინასწარი პასუხი(ები) და საბოლოო — ლაბ. ექიმის დადასტურებით; ექიმი ხედავს მხოლოდ „ანგარიშში ჩასმულ“ ანტიბიოტიკებს
--  • სარეზერვო ანტიბიოტიკი (პანელში) — ნაგულისხმევად დამალულია; ჩანს რეზისტენტობისას ან ლაბ. ექიმის მონიშვნით
--  • ცნობარი: მიკროორგანიზმები (WHONET-ის კოდებით), ანტიბიოტიკები, პანელები — რედაქტირებადი
ALTER TABLE dx_services ADD COLUMN is_micro BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE micro_organisms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), code VARCHAR(12) NOT NULL, name TEXT NOT NULL,
    gram VARCHAR(6) NOT NULL CHECK (gram IN ('pos', 'neg', 'fungus', 'other')), group_code VARCHAR(6) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE UNIQUE INDEX uq_micro_org_code ON micro_organisms (lower(code));
CREATE TABLE micro_antibiotics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), code VARCHAR(12) NOT NULL, name TEXT NOT NULL, class TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE UNIQUE INDEX uq_micro_abx_code ON micro_antibiotics (upper(code));
CREATE TABLE micro_panels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), code VARCHAR(12) NOT NULL UNIQUE, name TEXT NOT NULL, group_code VARCHAR(6), is_active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE micro_panel_items (
    panel_id UUID NOT NULL REFERENCES micro_panels(id) ON DELETE CASCADE, antibiotic_id UUID NOT NULL REFERENCES micro_antibiotics(id),
    sort_order INT NOT NULL DEFAULT 0, reserve BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (panel_id, antibiotic_id));

CREATE TABLE micro_cultures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), order_item_id UUID NOT NULL UNIQUE REFERENCES dx_order_items(id),
    stage VARCHAR(10) NOT NULL DEFAULT 'incubating' CHECK (stage IN ('incubating', 'no_growth', 'growth', 'contaminated')),
    gram_stain TEXT, growth_summary TEXT, comment TEXT, updated_by UUID REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE micro_isolates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), culture_id UUID NOT NULL REFERENCES micro_cultures(id) ON DELETE CASCADE, seq INT NOT NULL,
    organism_id UUID REFERENCES micro_organisms(id), quantity TEXT, comment TEXT, panel_id UUID REFERENCES micro_panels(id), UNIQUE (culture_id, seq));
CREATE TABLE micro_ast (
    isolate_id UUID NOT NULL REFERENCES micro_isolates(id) ON DELETE CASCADE, antibiotic_id UUID NOT NULL REFERENCES micro_antibiotics(id),
    mic TEXT, zone_mm NUMERIC, interp VARCHAR(1) CHECK (interp IN ('S', 'I', 'R')), reported BOOLEAN NOT NULL DEFAULT TRUE, reserve BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0, PRIMARY KEY (isolate_id, antibiotic_id));
-- გაცემული პასუხები (წინასწარი / საბოლოო) — ანაბეჭდი: რაც ექიმმა ნახა, უცვლელად
CREATE TABLE micro_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), order_item_id UUID NOT NULL REFERENCES dx_order_items(id),
    kind VARCHAR(7) NOT NULL CHECK (kind IN ('prelim', 'final')), snapshot JSONB NOT NULL,
    issued_by UUID REFERENCES users(id), issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ix_micro_reports_item ON micro_reports (order_item_id, issued_at DESC);
CREATE TRIGGER trg_micro_reports_immutable BEFORE UPDATE OR DELETE ON micro_reports FOR EACH ROW EXECUTE FUNCTION forbid_change();


INSERT INTO micro_organisms (code, name, gram, group_code) VALUES
  ('eco', 'Escherichia coli', 'neg', 'ENT'),
  ('kpn', 'Klebsiella pneumoniae', 'neg', 'ENT'),
  ('kox', 'Klebsiella oxytoca', 'neg', 'ENT'),
  ('kae', 'Klebsiella aerogenes', 'neg', 'ENT'),
  ('ecl', 'Enterobacter cloacae complex', 'neg', 'ENT'),
  ('cfr', 'Citrobacter freundii', 'neg', 'ENT'),
  ('cko', 'Citrobacter koseri', 'neg', 'ENT'),
  ('pmi', 'Proteus mirabilis', 'neg', 'ENT'),
  ('pvu', 'Proteus vulgaris', 'neg', 'ENT'),
  ('mmo', 'Morganella morganii', 'neg', 'ENT'),
  ('sma', 'Serratia marcescens', 'neg', 'ENT'),
  ('pro', 'Providencia spp.', 'neg', 'ENT'),
  ('sal', 'Salmonella spp.', 'neg', 'ENT'),
  ('shi', 'Shigella spp.', 'neg', 'ENT'),
  ('pae', 'Pseudomonas aeruginosa', 'neg', 'PSE'),
  ('ps-', 'Pseudomonas spp.', 'neg', 'PSE'),
  ('aba', 'Acinetobacter baumannii complex', 'neg', 'ACI'),
  ('smt', 'Stenotrophomonas maltophilia', 'neg', 'NFR'),
  ('bce', 'Burkholderia cepacia complex', 'neg', 'NFR'),
  ('hin', 'Haemophilus influenzae', 'neg', 'HAE'),
  ('mca', 'Moraxella catarrhalis', 'neg', 'HAE'),
  ('ngo', 'Neisseria gonorrhoeae', 'neg', 'NEI'),
  ('nme', 'Neisseria meningitidis', 'neg', 'NEI'),
  ('cje', 'Campylobacter jejuni', 'neg', 'CAM'),
  ('sau', 'Staphylococcus aureus', 'pos', 'STA'),
  ('sep', 'Staphylococcus epidermidis', 'pos', 'STA'),
  ('shl', 'Staphylococcus haemolyticus', 'pos', 'STA'),
  ('ssa', 'Staphylococcus saprophyticus', 'pos', 'STA'),
  ('scn', 'კოაგულაზა-უარყოფითი სტაფილოკოკი', 'pos', 'STA'),
  ('efa', 'Enterococcus faecalis', 'pos', 'ENC'),
  ('efm', 'Enterococcus faecium', 'pos', 'ENC'),
  ('spy', 'Streptococcus pyogenes (A ჯგუფი)', 'pos', 'STR'),
  ('sag', 'Streptococcus agalactiae (B ჯგუფი)', 'pos', 'STR'),
  ('spn', 'Streptococcus pneumoniae', 'pos', 'STR'),
  ('svi', 'Viridans ჯგუფის სტრეპტოკოკი', 'pos', 'STR'),
  ('lmo', 'Listeria monocytogenes', 'pos', 'GPR'),
  ('cor', 'Corynebacterium spp.', 'pos', 'GPR'),
  ('cdi', 'Clostridioides difficile', 'pos', 'ANA'),
  ('bfr', 'Bacteroides fragilis', 'neg', 'ANA'),
  ('cal', 'Candida albicans', 'fungus', 'FUN'),
  ('cgl', 'Candida glabrata', 'fungus', 'FUN'),
  ('cpa', 'Candida parapsilosis', 'fungus', 'FUN'),
  ('ctr', 'Candida tropicalis', 'fungus', 'FUN'),
  ('ckr', 'Candida krusei', 'fungus', 'FUN'),
  ('can', 'Candida spp.', 'fungus', 'FUN'),
  ('afu', 'Aspergillus fumigatus', 'fungus', 'FUN');

INSERT INTO micro_antibiotics (code, name, class) VALUES
  ('AMP', 'ამპიცილინი', 'პენიცილინები'),
  ('AMX', 'ამოქსიცილინი', 'პენიცილინები'),
  ('AMC', 'ამოქსიცილინი/კლავულანატი', 'პენიცილინები'),
  ('TZP', 'პიპერაცილინი/ტაზობაქტამი', 'პენიცილინები'),
  ('PEN', 'ბენზილპენიცილინი', 'პენიცილინები'),
  ('OXA', 'ოქსაცილინი', 'პენიცილინები'),
  ('CFZ', 'ცეფაზოლინი', 'ცეფალოსპორინები'),
  ('CXM', 'ცეფუროქსიმი', 'ცეფალოსპორინები'),
  ('FOX', 'ცეფოქსიტინი (სკრინინგი)', 'ცეფალოსპორინები'),
  ('CTX', 'ცეფოტაქსიმი', 'ცეფალოსპორინები'),
  ('CRO', 'ცეფტრიაქსონი', 'ცეფალოსპორინები'),
  ('CAZ', 'ცეფტაზიდიმი', 'ცეფალოსპორინები'),
  ('FEP', 'ცეფეპიმი', 'ცეფალოსპორინები'),
  ('CZA', 'ცეფტაზიდიმი/ავიბაქტამი', 'ცეფალოსპორინები'),
  ('ATM', 'აზტრეონამი', 'მონობაქტამები'),
  ('ETP', 'ერტაპენემი', 'კარბაპენემები'),
  ('IPM', 'იმიპენემი', 'კარბაპენემები'),
  ('MEM', 'მეროპენემი', 'კარბაპენემები'),
  ('GEN', 'გენტამიცინი', 'ამინოგლიკოზიდები'),
  ('TOB', 'ტობრამიცინი', 'ამინოგლიკოზიდები'),
  ('AMK', 'ამიკაცინი', 'ამინოგლიკოზიდები'),
  ('CIP', 'ციპროფლოქსაცინი', 'ფტორქინოლონები'),
  ('LVX', 'ლევოფლოქსაცინი', 'ფტორქინოლონები'),
  ('MFX', 'მოქსიფლოქსაცინი', 'ფტორქინოლონები'),
  ('SXT', 'ტრიმეთოპრიმი/სულფამეთოქსაზოლი', 'სულფანილამიდები'),
  ('NIT', 'ნიტროფურანტოინი', 'სხვა'),
  ('FOS', 'ფოსფომიცინი', 'სხვა'),
  ('COL', 'კოლისტინი', 'პოლიმიქსინები'),
  ('TGC', 'ტიგეციკლინი', 'ტეტრაციკლინები'),
  ('TCY', 'ტეტრაციკლინი', 'ტეტრაციკლინები'),
  ('DOX', 'დოქსიციკლინი', 'ტეტრაციკლინები'),
  ('ERY', 'ერითრომიცინი', 'მაკროლიდები'),
  ('AZM', 'აზითრომიცინი', 'მაკროლიდები'),
  ('CLI', 'კლინდამიცინი', 'ლინკოზამიდები'),
  ('VAN', 'ვანკომიცინი', 'გლიკოპეპტიდები'),
  ('TEC', 'ტეიკოპლანინი', 'გლიკოპეპტიდები'),
  ('LNZ', 'ლინეზოლიდი', 'ოქსაზოლიდინონები'),
  ('DAP', 'დაპტომიცინი', 'ლიპოპეპტიდები'),
  ('RIF', 'რიფამპიცინი', 'სხვა'),
  ('FUS', 'ფუზიდინის მჟავა', 'სხვა'),
  ('MUP', 'მუპიროცინი', 'სხვა'),
  ('CHL', 'ქლორამფენიკოლი', 'სხვა'),
  ('MTR', 'მეტრონიდაზოლი', 'სხვა'),
  ('FLU', 'ფლუკონაზოლი', 'სოკოს საწინააღმდეგო'),
  ('VOR', 'ვორიკონაზოლი', 'სოკოს საწინააღმდეგო'),
  ('AMB', 'ამფოტერიცინი B', 'სოკოს საწინააღმდეგო'),
  ('CAS', 'კასპოფუნგინი', 'სოკოს საწინააღმდეგო');

INSERT INTO micro_panels (code, name, group_code) VALUES
  ('ENT', 'Enterobacterales', 'ENT'),
  ('PSE', 'Pseudomonas', 'PSE'),
  ('ACI', 'Acinetobacter', 'ACI'),
  ('STA', 'Staphylococcus', 'STA'),
  ('ENC', 'Enterococcus', 'ENC'),
  ('STR', 'Streptococcus', 'STR'),
  ('FUN', 'სოკოები (Candida)', 'FUN');

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('AMP', 0, FALSE),
  ('AMC', 1, FALSE),
  ('TZP', 2, FALSE),
  ('CXM', 3, FALSE),
  ('CRO', 4, FALSE),
  ('CAZ', 5, FALSE),
  ('FEP', 6, FALSE),
  ('GEN', 7, FALSE),
  ('AMK', 8, FALSE),
  ('CIP', 9, FALSE),
  ('SXT', 10, FALSE),
  ('NIT', 11, FALSE),
  ('FOS', 12, FALSE),
  ('ETP', 13, TRUE),
  ('MEM', 14, TRUE),
  ('CZA', 15, TRUE),
  ('COL', 16, TRUE),
  ('TGC', 17, TRUE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'ENT';

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('TZP', 0, FALSE),
  ('CAZ', 1, FALSE),
  ('FEP', 2, FALSE),
  ('ATM', 3, FALSE),
  ('TOB', 4, FALSE),
  ('AMK', 5, FALSE),
  ('CIP', 6, FALSE),
  ('LVX', 7, FALSE),
  ('IPM', 8, TRUE),
  ('MEM', 9, TRUE),
  ('CZA', 10, TRUE),
  ('COL', 11, TRUE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'PSE';

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('GEN', 0, FALSE),
  ('TOB', 1, FALSE),
  ('AMK', 2, FALSE),
  ('CIP', 3, FALSE),
  ('LVX', 4, FALSE),
  ('SXT', 5, FALSE),
  ('IPM', 6, TRUE),
  ('MEM', 7, TRUE),
  ('COL', 8, TRUE),
  ('TGC', 9, TRUE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'ACI';

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('PEN', 0, FALSE),
  ('FOX', 1, FALSE),
  ('OXA', 2, FALSE),
  ('GEN', 3, FALSE),
  ('CIP', 4, FALSE),
  ('LVX', 5, FALSE),
  ('ERY', 6, FALSE),
  ('CLI', 7, FALSE),
  ('SXT', 8, FALSE),
  ('TCY', 9, FALSE),
  ('RIF', 10, FALSE),
  ('FUS', 11, FALSE),
  ('NIT', 12, FALSE),
  ('VAN', 13, TRUE),
  ('TEC', 14, TRUE),
  ('LNZ', 15, TRUE),
  ('DAP', 16, TRUE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'STA';

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('AMP', 0, FALSE),
  ('IPM', 1, FALSE),
  ('GEN', 2, FALSE),
  ('NIT', 3, FALSE),
  ('VAN', 4, FALSE),
  ('TEC', 5, FALSE),
  ('LNZ', 6, TRUE),
  ('TGC', 7, TRUE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'ENC';

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('PEN', 0, FALSE),
  ('AMX', 1, FALSE),
  ('CRO', 2, FALSE),
  ('ERY', 3, FALSE),
  ('CLI', 4, FALSE),
  ('LVX', 5, FALSE),
  ('TCY', 6, FALSE),
  ('SXT', 7, FALSE),
  ('VAN', 8, TRUE),
  ('LNZ', 9, TRUE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'STR';

INSERT INTO micro_panel_items (panel_id, antibiotic_id, sort_order, reserve)
SELECT p.id, a.id, v.s, v.r FROM (VALUES
  ('FLU', 0, FALSE),
  ('VOR', 1, FALSE),
  ('AMB', 2, FALSE),
  ('CAS', 3, FALSE)) v(code, s, r)
JOIN micro_antibiotics a ON upper(a.code) = v.code JOIN micro_panels p ON p.code = 'FUN';
