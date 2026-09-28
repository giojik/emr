-- 0020_lab_gateway_admin.sql
-- ანალიზატორების gateway-ის მართვის პანელი (ადმინისტრირება → ანალიზატორები, IT):
--  • lab_gateway_commands     — ბრძანებები gateway-სთვის (კავშირის შემოწმება, ASTM ბმის ტესტი, ხელახლა დაკავშირება); შედეგს gateway წერს
--  • lab_instruments.listen_only — „მოსმენის რეჟიმი“: შეტყობინებები იწერება ჟურნალში, EMR-ში შედეგი არ იწერება, შეკვეთა არ იგზავნება
--  • lab_instrument_seen_codes — ანალიზატორის მიერ გამოგზავნილი კოდები (რუკის შესავსებად ერთი დაწკაპუნებით)
--  • lab_gateway_alert_settings / lab_gateway_alerts — გაფრთხილებები (კავშირის გაწყვეტა, „ჩუმი“ ანალიზატორი): ეკრანი + SMS + ელ-ფოსტა

CREATE TABLE lab_gateway_commands (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   UUID REFERENCES lab_instruments(id) ON DELETE CASCADE,
    kind            VARCHAR(12) NOT NULL CHECK (kind IN ('tcp_test', 'link_test', 'reconnect')),
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          VARCHAR(8) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    result          JSONB,
    requested_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     TIMESTAMPTZ
);
CREATE INDEX ix_lab_gw_cmd_pending ON lab_gateway_commands (id) WHERE status = 'pending';

ALTER TABLE lab_instruments
    ADD COLUMN listen_only     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN silent_minutes  INT CHECK (silent_minutes IS NULL OR silent_minutes BETWEEN 10 AND 10080),   -- „ჩუმი“: X წუთი შეტყობინების გარეშე (სამუშაო საათებში); NULL — საერთო პარამეტრი
    ADD COLUMN alerts_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN down_since      TIMESTAMPTZ;   -- კავშირი არ არის ამ დროიდან (NULL — დაკავშირებულია / უსმენს); წერს gateway
DROP TRIGGER trg_lab_instruments_updated ON lab_instruments;
CREATE TRIGGER trg_lab_instruments_updated BEFORE UPDATE OF method_id, protocol, conn_mode, host, port, is_enabled, order_mode, settings, listen_only
    ON lab_instruments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lab_instrument_seen_codes (
    instrument_id   UUID NOT NULL REFERENCES lab_instruments(id) ON DELETE CASCADE,
    code            VARCHAR(40) NOT NULL,
    last_value      TEXT,
    last_unit       TEXT,
    seen_count      INT NOT NULL DEFAULT 1,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (instrument_id, code)
);

CREATE TABLE lab_gateway_alert_settings (
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    disconnect_minutes  INT NOT NULL DEFAULT 5 CHECK (disconnect_minutes BETWEEN 1 AND 1440),
    silent_minutes      INT NOT NULL DEFAULT 120 CHECK (silent_minutes BETWEEN 10 AND 10080),
    work_start          TIME NOT NULL DEFAULT '08:00',
    work_end            TIME NOT NULL DEFAULT '20:00',
    work_days           SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',   -- ISO: 1 = ორშაბათი … 7 = კვირა
    sms_phones          TEXT[] NOT NULL DEFAULT '{}',
    emails              TEXT[] NOT NULL DEFAULT '{}',
    notify_resolved     BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO lab_gateway_alert_settings (id) VALUES (1);

CREATE TABLE lab_gateway_alerts (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   UUID REFERENCES lab_instruments(id) ON DELETE CASCADE,   -- NULL = თავად gateway
    kind            VARCHAR(12) NOT NULL CHECK (kind IN ('disconnected', 'silent', 'gateway')),
    message         TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at     TIMESTAMPTZ,
    notified        JSONB,                        -- {sms: [...], email: [...], errors: [...]}
    notified_resolved JSONB
);
CREATE UNIQUE INDEX uq_lab_gw_alert_open ON lab_gateway_alerts (coalesce(instrument_id, '00000000-0000-0000-0000-000000000000'::uuid), kind) WHERE resolved_at IS NULL;
CREATE INDEX ix_lab_gw_alert_time ON lab_gateway_alerts (started_at DESC);
