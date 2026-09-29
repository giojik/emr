-- 0022_lab_ext_mail.sql
-- გარე ლაბორატორიის პასუხები ელ-ფოსტით (lab-results@…): EMR ყუთს IMAP-ით ამოწმებს (emr-worker) ან .eml იტვირთება ხელით.
--  ფორმატი (ლაბორატორიას ვთხოვთ): თემა „EMR <შტრიხკოდი>“, მიმაგრება <შტრიხკოდი>.pdf ან <შტრიხკოდი>_<ანალიზის კოდი>.pdf
--  • მიიღება მხოლოდ რეესტრში მითითებული გამგზავნებიდან (lab_external_labs.emails); სხვა — „უცნობი გამგზავნი“, ავტომატურად არ ებმება
--  • ფაილი ებმება ამ ლაბორატორიაში გაგზავნილ, ჯერ პასუხის გარეშე ანალიზ(ებ)ს; ვერ მოიძებნა — „მისაბმელი“ სიაში, ხელით
--  • ანალიზს პასუხი ებმება როგორც ხელით ატვირთვისას → ლაბ. ექიმის ვალიდაცია

ALTER TABLE lab_external_labs ADD COLUMN emails TEXT[] NOT NULL DEFAULT '{}';   -- ნებადართული გამგზავნები (მცირე ასოებით)
UPDATE lab_external_labs SET emails = ARRAY[lower(email)] WHERE coalesce(email, '') <> '';

CREATE TABLE lab_ext_mail (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id      TEXT NOT NULL UNIQUE,              -- Message-ID (ან ჰეში) — ერთი წერილი ერთხელ
    from_addr       TEXT,
    subject         TEXT,
    sent_at         TIMESTAMPTZ,
    lab_id          UUID REFERENCES lab_external_labs(id),
    source          VARCHAR(6) NOT NULL DEFAULT 'imap' CHECK (source IN ('imap', 'upload')),
    status          VARCHAR(10) NOT NULL CHECK (status IN ('matched', 'partial', 'unmatched', 'rejected')),
    note            TEXT,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    uploaded_by     UUID REFERENCES users(id)
);
CREATE INDEX ix_lab_ext_mail_time ON lab_ext_mail (received_at DESC);

CREATE TABLE lab_ext_mail_files (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mail_id         UUID NOT NULL REFERENCES lab_ext_mail(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size_bytes      INT NOT NULL,
    storage_path    TEXT,
    barcode         TEXT,                               -- ფაილის სახელიდან / თემიდან
    service_code    TEXT,
    item_ids        UUID[] NOT NULL DEFAULT '{}',       -- რომელ ანალიზებს მიება
    status          VARCHAR(10) NOT NULL CHECK (status IN ('attached', 'unmatched', 'dismissed', 'ignored')),
    reason          TEXT,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX ix_lab_ext_mail_files_open ON lab_ext_mail_files (mail_id) WHERE status = 'unmatched';

-- IMAP-ის მდგომარეობა (ერთი ხაზი): ბოლო შემოწმება / შეცდომა — ეკრანზე
CREATE TABLE lab_ext_mail_state (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    checked_at      TIMESTAMPTZ,
    ok              BOOLEAN,
    error           TEXT,
    processed_total INT NOT NULL DEFAULT 0
);
INSERT INTO lab_ext_mail_state (id) VALUES (1);
