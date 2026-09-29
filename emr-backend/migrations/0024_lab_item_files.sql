-- 0024_lab_item_files.sql
-- გარე ლაბორატორიის ანალიზს — რამდენიმე ფაილი (პასუხი, დანართი, გრაფიკი…): ერთი წერილის რამდენიმე PDF ერთმანეთს აღარ ცვლის,
-- მოგვიანებით მოსული ფაილი ემატება; იგივე ფაილი (sha256) ორჯერ არ ემატება; ვალიდაციამდე — მოხსნა მიზეზით (ისტორიაში რჩება).
-- dx_order_items.ext_result_* რჩება: ext_result_at — პირველი ფაილის დრო, ext_result_path/name — ბოლო აქტიური ფაილი (თავსებადობა).
CREATE TABLE dx_item_files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id   UUID NOT NULL REFERENCES dx_order_items(id),
    storage_path    TEXT NOT NULL,
    filename        TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size_bytes      INT,
    sha256          CHAR(64),
    source          VARCHAR(6) NOT NULL CHECK (source IN ('upload', 'mail')),
    mail_file_id    UUID REFERENCES lab_ext_mail_files(id) ON DELETE SET NULL,
    uploaded_by     UUID REFERENCES users(id),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at      TIMESTAMPTZ,
    removed_by      UUID REFERENCES users(id),
    remove_reason   TEXT
);
CREATE INDEX ix_dx_item_files_item ON dx_item_files (order_item_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX uq_dx_item_files_sha ON dx_item_files (order_item_id, sha256) WHERE removed_at IS NULL AND sha256 IS NOT NULL;

ALTER TABLE lab_ext_mail_files ADD COLUMN sha256 CHAR(64);

-- არსებული პასუხები → ფაილების სია
INSERT INTO dx_item_files (order_item_id, storage_path, filename, mime, source, uploaded_by, uploaded_at)
SELECT id, ext_result_path, coalesce(ext_result_name, 'result'),
       CASE WHEN ext_result_path LIKE '%.pdf' THEN 'application/pdf' WHEN ext_result_path LIKE '%.png' THEN 'image/png' ELSE 'image/jpeg' END,
       CASE WHEN ext_result_path LIKE 'lab-external/mail/%' THEN 'mail' ELSE 'upload' END, ext_result_by, coalesce(ext_result_at, CURRENT_TIMESTAMP)
FROM dx_order_items WHERE ext_result_path IS NOT NULL;
