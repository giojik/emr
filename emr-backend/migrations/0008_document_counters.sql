-- 0008_document_counters.sql
-- ჟურნალის ნომრები უწყვეტი (gapless) უნდა იყოს: SEQUENCE წარუმატებელ ტრანზაქციაზეც "წვავს" ნომერს.
-- მრიცხველი ცხრილში, რომელიც ტრანზაქციასთან ერთად rollback-დება; წლიური ნუმერაცია.

CREATE TABLE document_counters (
    document_type  VARCHAR(50) NOT NULL,
    year           SMALLINT NOT NULL,
    last_value     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (document_type, year)
);

-- არსებული გაცემული ცნობების გათვალისწინება (dev/ტესტ ბაზებისთვის)
INSERT INTO document_counters (document_type, year, last_value)
SELECT document_type, extract(year FROM generated_at)::smallint,
       max(nullif(regexp_replace(document_number, '^.*-', ''), '')::int)
FROM generated_documents WHERE document_number IS NOT NULL
GROUP BY 1, 2;

DROP SEQUENCE IF EXISTS form100_number_seq;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    REVOKE DELETE, TRUNCATE ON document_counters FROM emr_app;
  END IF;
END $$;
