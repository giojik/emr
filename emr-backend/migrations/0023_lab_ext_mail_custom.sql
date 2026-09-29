-- 0023_lab_ext_mail_custom.sql
-- გარე ლაბორატორია, რომელიც ჩვენს ფორმატს ვერ იცავს (საკუთარი წერილის სტრუქტურა):
--  • ლაბორატორიის შაბლონი (რეგულარული გამოსახულება) ჩვენი შტრიხკოდისთვის: „Sample: 1000123“, „Ref#1000123“ …
--  • პაციენტით ამოცნობა: თემა / ტექსტი / ფაილის სახელი / PDF-ის ტექსტი — პირადი № ან სახელი+გვარი+დაბადების თარიღი
--    (მხოლოდ ამ ლაბორატორიაში გაგზავნილ, პასუხის მომლოდინე ანალიზებს შორის, ბოლო N დღე); რამდენიმე პაციენტი → ხელით
--  • ფაილს — რით ამოიცნო (match_method) და შესაძლო კანდიდატები (ხელით მიბმის მინიშნება)
ALTER TABLE lab_external_labs
    ADD COLUMN mail_id_regex          TEXT CHECK (mail_id_regex IS NULL OR length(mail_id_regex) <= 200),
    ADD COLUMN mail_match_patient     BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN mail_match_window_days SMALLINT NOT NULL DEFAULT 60 CHECK (mail_match_window_days BETWEEN 1 AND 365);
ALTER TABLE lab_ext_mail_files
    ADD COLUMN match_method TEXT,
    ADD COLUMN candidates   JSONB;
