-- 0059_drg_tools.sql
-- DRG ბლოკი, ეტაპი 5 — ინსტრუმენტები:
--  • სიმულაცია (DRG ვერსიის გავლენა პერიოდის შემთხვევებზე) — სქემის ცვლილება არ სჭირდება (გამოთვლა მეხსიერებაში, არ ინახება).
--  • კონფიგურაციის პაკეტი (DRG ვერსიები + შემოწმების წესები + ფაილის შაბლონები + უარის მიზეზები + მოდულების პარამეტრები + გადამხდელის მიბმა)
--      — ექსპორტი / იმპორტი (შემოწმება → ჩაწერა); ჟურნალი — აუდიტში (CONFIG_PACKAGE_IMPORT).
--  • უარის მიზეზი → შემოწმების წესები (denial_reasons.scrub_rules): რომელმა წესმა უნდა დაიჭიროს ეს უარი;
--      უარის ანგარიში აჩვენებს წესის ეფექტიანობას (იჭერს / გამორთულია / ვერ იჭერს / მიუბმელი).

ALTER TABLE denial_reasons ADD COLUMN scrub_rules TEXT[] NOT NULL DEFAULT '{}';

-- საწყისი მიბმა (მზა წესები 0057) — შესაცვლელი
UPDATE denial_reasons SET scrub_rules = ARRAY['GUARANTEE_MISSING', 'GUARANTEE_FILE', 'GUARANTEE_EXPIRED'] WHERE code = 'GUARANTEE';
UPDATE denial_reasons SET scrub_rules = ARRAY['PDX_MISSING', 'ICD_INVALID', 'ICD_NONSPECIFIC', 'DX_SEX', 'OR_NCSP_MISSING'] WHERE code = 'CODING';
UPDATE denial_reasons SET scrub_rules = ARRAY['DRG_NOT_CONFIRMED', 'DRG_MISMATCH', 'DRG_FALLBACK'] WHERE code = 'DRG';
UPDATE denial_reasons SET scrub_rules = ARRAY['LOS_LONG'] WHERE code = 'LOS';
UPDATE denial_reasons SET scrub_rules = ARRAY['EPICRISIS_UNSIGNED', 'OR_NOTE_UNSIGNED'] WHERE code = 'DOCS';
UPDATE denial_reasons SET scrub_rules = ARRAY['DUPLICATE_STAY'] WHERE code = 'DUPLICATE';
UPDATE denial_reasons SET scrub_rules = ARRAY['PAYER_ZERO', 'PAYER_OVERRIDE', 'LINE_OUTSIDE_STAY'] WHERE code = 'TARIFF';
