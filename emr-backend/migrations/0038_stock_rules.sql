-- 0038_stock_rules.sql
-- საწყობის / აფთიაქის წესები → კლინიკის პარამეტრები (system_modules.code = 'stock'): ნაგულისხმევი = 0030–0036-ის ქცევა.
--   issue_mode            two_step (გაცემა → მიმღების დადასტურება, 1A) | one_step (გაცემისთანავე ჩაირიცხება)
--   witness_classes       კონტროლის კლასები, რომლებზეც ხარჯსა და ჩამოწერას მოწმე სჭირდება (ცარიელი — გამორთულია); ჟურნალი / ცვლის ჩაბარებაც ამ კლასებზეა
--   empty_return_classes  ცარიელი ამპულის დაბრუნება (ცარიელი — გამორთულია)
--   dose_required         მოწმის კლასებზე ხარჯისას — მიღებული დოზა სავალდებულო
--   count_lock            ინვენტარიზაციისას ლოკაციის ბლოკი (4A) — ბაზის ტრიგერიც ამას კითხულობს
--   count_blind_default   ახალი ინვენტარიზაცია — ნაგულისხმევად ბრმა
--   pharmacist_scope      pharmacy (მიღება / გაცემა მხოლოდ აფთიაქში) | any (ნებისმიერ ლოკაციაზე)
--   lost_requires_approval  „დაკარგულის“ ჩამოწერა — ყოველთვის დამტკიცებით
--   alert_expiry / alert_minmax / alert_lab  დილის შემოწმების შემადგენლობა
-- თვითღირებულების მეთოდი, მოკლე ვადა, ჩამოწერის ზღვარი, შემოწმების საათი — stock_settings-ში რჩება (იმავე „მოდულები“ გვერდიდან იცვლება).

ALTER TABLE system_modules ADD COLUMN can_disable BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO system_modules (code, name, description, enabled, can_disable, settings, sort_order) VALUES
('stock', 'საწყობი და აფთიაქი', 'გაცემის წესი, კონტროლირებადი საშუალებები (მოწმე, ცარიელი ამპულა, დოზა), ინვენტარიზაცია, ფარმაცევტის უფლებები, დილის შემოწმება', TRUE, FALSE,
 '{"issue_mode": "two_step", "witness_classes": ["narcotic", "psychotropic"], "empty_return_classes": ["narcotic"], "dose_required": true,
   "count_lock": true, "count_blind_default": true, "pharmacist_scope": "pharmacy", "lost_requires_approval": true,
   "alert_expiry": true, "alert_minmax": true, "alert_lab": true}', 5);

-- ბლოკი (4A) — მხოლოდ თუ count_lock ჩართულია
CREATE OR REPLACE FUNCTION stock_moves_count_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c_no TEXT;
BEGIN
    IF NOT coalesce((SELECT (settings->>'count_lock')::boolean FROM system_modules WHERE code = 'stock'), TRUE) THEN RETURN NEW; END IF;
    SELECT count_no INTO c_no FROM stock_counts WHERE location_id = NEW.location_id AND status IN ('open', 'counted');
    IF c_no IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_docs d WHERE d.id = NEW.doc_id AND d.doc_type = 'adjustment') THEN
        RAISE EXCEPTION 'ლოკაციაზე მიმდინარეობს ინვენტარიზაცია % — მოძრაობა დაბლოკილია', c_no
            USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_location_counting';
    END IF;
    RETURN NEW;
END $$;
