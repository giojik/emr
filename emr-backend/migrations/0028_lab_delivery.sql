-- 0028_lab_delivery.sql
-- ლაბორატორიული პასუხის მიწოდება პაციენტს — ნაგულისხმევად გამორთულია (ადმინისტრირება → „პასუხის მიწოდება“):
--  • ელ-ფოსტა: PDF(-ები) დაშიფრული (პაროლი — პირადი ნომრის ბოლო 4 ციფრი; წერილში მხოლოდ მინიშნება)
--  • SMS: მხოლოდ შეტყობინება („პასუხი გაიგზავნა ელ-ფოსტაზე“ / „მზადაა, მიიღეთ კლინიკაში“) — ბმულისა და საჯარო გვერდის გარეშე
--  • ავტომატურად — როცა ვიზიტის ყველა ლაბ. ანალიზი დადასტურებულია, ერთხელ; ხელით — ვიზიტის ეკრანიდან
--  • პაციენტის თანხმობა (ბარათში): ელ-ფოსტა / SMS; ჟურნალი — ვის, რა, როდის
ALTER TABLE patients
    ADD COLUMN email        TEXT CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    ADD COLUMN result_email BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN result_sms   BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE lab_delivery_settings (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    auto_send       BOOLEAN NOT NULL DEFAULT TRUE,
    encrypt_pdf     BOOLEAN NOT NULL DEFAULT TRUE,
    email_subject   TEXT NOT NULL DEFAULT 'ლაბორატორიული კვლევის პასუხი — {clinic}',
    email_body      TEXT NOT NULL DEFAULT E'პატივცემულო {name},\n\nთქვენი ლაბორატორიული კვლევის პასუხი ({date}) თან ერთვის.\n{password_hint}\n\nკითხვების შემთხვევაში დაგვიკავშირდით: {phone}\n\n{clinic}',
    sms_email_sent  TEXT NOT NULL DEFAULT '{clinic}: ანალიზის პასუხი გაიგზავნა თქვენს ელ-ფოსტაზე. PDF-ის პაროლი — პირადი ნომრის ბოლო 4 ციფრი.',
    sms_ready       TEXT NOT NULL DEFAULT '{clinic}: თქვენი ანალიზის პასუხი მზადაა. შეგიძლიათ მიიღოთ კლინიკაში. ტელ: {phone}',
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO lab_delivery_settings (id) VALUES (1);

CREATE TABLE lab_result_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    encounter_id    UUID NOT NULL REFERENCES encounters(id),
    patient_id      UUID NOT NULL REFERENCES patients(id),
    channel         VARCHAR(5) NOT NULL CHECK (channel IN ('email', 'sms')),
    recipient       TEXT NOT NULL,
    status          VARCHAR(7) NOT NULL CHECK (status IN ('sent', 'failed')),
    error           TEXT,
    trigger         VARCHAR(6) NOT NULL CHECK (trigger IN ('auto', 'manual')),
    attachments     INT NOT NULL DEFAULT 0,
    item_ids        UUID[] NOT NULL DEFAULT '{}',
    sent_by         UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_lab_result_deliveries_enc ON lab_result_deliveries (encounter_id, created_at DESC);
