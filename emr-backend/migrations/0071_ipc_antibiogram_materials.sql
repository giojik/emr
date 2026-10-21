-- 0071_ipc_antibiogram_materials.sql
-- ინფექციის კონტროლი, ეტაპი 5 — კუმულაციური ანტიბიოგრამა (CLSI M39) და IPC მასალები (ბლოკი D, მოდული 2).
--
--  • ანტიბიოგრამა — მიკრობიოლოგიიდან (0027): მხოლოდ საბოლოო პასუხი (micro_reports.kind = final); ყველა ტესტირებული ანტიბიოტიკი
--      (მათ შორის „ექიმთან“ დამალული / სარეზერვო); დუბლიკატები — პირველი იზოლატი პაციენტზე × მიკროორგანიზმზე პერიოდში (abg_dedup);
--      %S („I“ — არა მგრძნობიარე); n < abg_min_n — მონიშნული; სკრინინგის ანალიზები — გამორიცხული (abg_exclude_services);
--      MDRO წილი (MRSA / VRE / ESBL / CRE / CRAB / CRPA) — 0067-ის წესებით.
--  • გამოქვეყნება — ფიქსირებული ვერსია (snapshot): ხედავს ყველა კლინიცისტი (ანტიბიოგრამის გვერდი, დანიშვნის ფორმის ბმული); xlsx / PDF.
--  • მასალები — ჯგუფები (ხელის ანტისეპტიკი და სხვ.): საწყობის საქონელი × კოეფიციენტი (საბაზო ერთეული → ჯგუფის ერთეული);
--      ხარჯი განყოფილების ლოკაციებზე — material_source: issue (გაცემა / გადატანა, ნეტო) / consumption (ხარჯი + ჩამოწერა);
--      მნიშვნელი — პაციენტ-დღე (rpt_fact_ipc_daily).

-- ================================================================ 0. პარამეტრები (არსებული მნიშვნელობები რჩება)
UPDATE system_modules
   SET settings = '{"abg_dedup": "first_patient",
                    "abg_min_n": 30,
                    "abg_exclude_services": [],
                    "material_source": "issue"}'::jsonb || settings
 WHERE code = 'ipc';

-- ================================================================ 1. გამოქვეყნებული ანტიბიოგრამა
CREATE TABLE ipc_antibiograms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title           TEXT NOT NULL CHECK (length(btrim(title)) >= 3),
    period_from     DATE NOT NULL,
    period_to       DATE NOT NULL,
    filters         JSONB NOT NULL DEFAULT '{}'::jsonb,       -- department_id / care / setting / service_id / dedup / min_n
    filters_label   TEXT NOT NULL DEFAULT '',                 -- წასაკითხი აღწერა („მთელი კლინიკა · სტაციონარი“)
    data            JSONB NOT NULL,                           -- გამოთვლილი ცხრილი (snapshot)
    isolates        INT NOT NULL DEFAULT 0,
    note            TEXT,
    status          VARCHAR(10) NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'withdrawn')),
    published_by    UUID NOT NULL REFERENCES users(id),
    published_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    withdrawn_by    UUID REFERENCES users(id),
    withdrawn_at    TIMESTAMPTZ,
    withdraw_reason TEXT,
    CHECK (period_from <= period_to),
    CHECK (status <> 'withdrawn' OR (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdraw_reason IS NOT NULL))
);
CREATE INDEX idx_ipc_antibiograms_pub ON ipc_antibiograms (status, published_at DESC);

-- ცხრილი (data / პერიოდი / ფილტრები) — უცვლელი; შეიძლება მხოლოდ გაუქმება
CREATE OR REPLACE FUNCTION ipc_antibiograms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ანტიბიოგრამის წაშლა აკრძალულია (გამოიყენეთ გაუქმება)'; END IF;
    IF NEW.data IS DISTINCT FROM OLD.data OR NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to
       OR NEW.filters IS DISTINCT FROM OLD.filters OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at
       OR NEW.isolates IS DISTINCT FROM OLD.isolates THEN
        RAISE EXCEPTION 'გამოქვეყნებული ანტიბიოგრამა უცვლელია';
    END IF;
    IF OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn' THEN RAISE EXCEPTION 'გაუქმებული ანტიბიოგრამა ვერ აღდგება'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_ipc_antibiograms_guard BEFORE UPDATE OR DELETE ON ipc_antibiograms FOR EACH ROW EXECUTE FUNCTION ipc_antibiograms_guard();

-- ================================================================ 2. IPC მასალები
CREATE TABLE ipc_material_groups (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(20) NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,19}$'),
    name        TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
    unit_label  VARCHAR(12) NOT NULL,                         -- ჯგუფის ერთეული: ლ, წყვილი, ც
    per_days    INT NOT NULL DEFAULT 1000 CHECK (per_days IN (1, 10, 100, 1000)),   -- X / per_days პაციენტ-დღე
    target      NUMERIC(12,2) CHECK (target IS NULL OR target >= 0),               -- მინიმალური სამიზნე (მაგ. WHO ≥ 20 ლ / 1000)
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trg_ipc_material_groups_updated BEFORE UPDATE ON ipc_material_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ipc_material_items (
    group_id    UUID NOT NULL REFERENCES ipc_material_groups(id) ON DELETE CASCADE,
    item_id     UUID NOT NULL REFERENCES stock_items(id),
    factor      NUMERIC(14,6) NOT NULL CHECK (factor > 0),   -- 1 საბაზო ერთეული = factor ჯგუფის ერთეული (500 მლ ფლაკონი → 0.5 ლ)
    PRIMARY KEY (group_id, item_id)
);
CREATE INDEX idx_ipc_material_items_item ON ipc_material_items (item_id);

INSERT INTO ipc_material_groups (code, name, unit_label, per_days, target, sort_order) VALUES
  ('hand_rub', 'ხელის ალკოჰოლიანი ანტისეპტიკი', 'ლ', 1000, 20, 10);

-- ================================================================ 3. უფლებები ბაზაში
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON ipc_antibiograms FROM emr_app;
  END IF;
END $$;
