-- 0019_lab_gateway.sql
-- ანალიზატორების მიერთება (emr-lab-gateway): ASTM E1381/E1394 და HL7 v2 (MLLP), ორმხრივი
--  • lab_instruments        — კავშირი ანალიზატორთან (lab_methods-ის გაფართოება): პროტოკოლი, მისამართი/პორტი, შეკვეთების რეჟიმი, სტატუსი
--  • lab_instrument_codes   — ანალიზატორის კოდი → EMR-ის კომპონენტი (შედეგი) ან კვლევა (შეკვეთის პანელი)
--  • lab_instrument_messages— ნედლი შეტყობინებების ჟურნალი (30 დღე)
--  • lab_instrument_results — შემოსული შედეგები: მიბმული / დასამუშავებელი (მიზეზით) / უარყოფილი
--  • lab_instrument_orders  — ანალიზატორზე გაგზავნილი შეკვეთები (push რეჟიმი)

CREATE TABLE lab_instruments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    method_id       UUID NOT NULL UNIQUE REFERENCES lab_methods(id),
    protocol        VARCHAR(4) NOT NULL CHECK (protocol IN ('astm', 'hl7')),
    conn_mode       VARCHAR(6) NOT NULL CHECK (conn_mode IN ('client', 'server')),   -- client: gateway უკავშირდება host:port-ს; server: gateway უსმენს port-ს
    host            TEXT,
    port            INT NOT NULL CHECK (port BETWEEN 1 AND 65535),
    is_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    order_mode      VARCHAR(5) NOT NULL DEFAULT 'query' CHECK (order_mode IN ('none', 'query', 'push')),
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- მდგომარეობა (წერს gateway)
    status          VARCHAR(10) NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'connecting', 'listening', 'connected', 'error')),
    status_at       TIMESTAMPTZ,
    peer            TEXT,
    last_message_at TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (conn_mode = 'server' OR (host IS NOT NULL AND host <> ''))
);
CREATE UNIQUE INDEX uq_lab_instruments_listen_port ON lab_instruments (port) WHERE conn_mode = 'server' AND is_enabled;   -- გათიშული პორტს არ იკავებს
CREATE TRIGGER trg_lab_instruments_updated BEFORE UPDATE OF method_id, protocol, conn_mode, host, port, is_enabled, order_mode, settings
    ON lab_instruments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lab_instrument_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instrument_id   UUID NOT NULL REFERENCES lab_instruments(id) ON DELETE CASCADE,
    code            VARCHAR(40) NOT NULL,
    analyte_id      UUID REFERENCES lab_analytes(id),      -- შედეგის კოდი (და შეკვეთის, თუ send_order)
    service_id      UUID REFERENCES dx_services(id),       -- მხოლოდ შეკვეთის კოდი: პანელი (მაგ. CBC+DIFF ერთი კოდით)
    factor          NUMERIC NOT NULL DEFAULT 1 CHECK (factor > 0),   -- ერთეულის გადაყვანა: EMR = ანალიზატორი × factor
    send_order      BOOLEAN NOT NULL DEFAULT TRUE,
    CHECK ((analyte_id IS NULL) <> (service_id IS NULL))
);
CREATE UNIQUE INDEX uq_lab_instr_code ON lab_instrument_codes (instrument_id, upper(code));
CREATE UNIQUE INDEX uq_lab_instr_analyte ON lab_instrument_codes (instrument_id, analyte_id) WHERE analyte_id IS NOT NULL;
CREATE UNIQUE INDEX uq_lab_instr_service ON lab_instrument_codes (instrument_id, service_id) WHERE service_id IS NOT NULL;

CREATE TABLE lab_instrument_messages (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   UUID NOT NULL REFERENCES lab_instruments(id) ON DELETE CASCADE,
    direction       VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
    kind            VARCHAR(20) NOT NULL,          -- results / query / orders / ack / other
    summary         TEXT,
    raw             TEXT NOT NULL,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_lab_instr_msg ON lab_instrument_messages (instrument_id, created_at DESC);

CREATE TABLE lab_instrument_results (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   UUID NOT NULL REFERENCES lab_instruments(id) ON DELETE CASCADE,
    message_id      BIGINT REFERENCES lab_instrument_messages(id) ON DELETE SET NULL,
    barcode         TEXT,
    code            TEXT NOT NULL,
    value           TEXT,
    unit            TEXT,
    flags           TEXT,
    result_status   TEXT,                           -- ანალიზატორის სტატუსი (F / C / P / X …)
    measured_at     TIMESTAMPTZ,
    status          VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'unmatched', 'dismissed')),
    reason          TEXT,
    order_item_id   UUID REFERENCES dx_order_items(id),
    analyte_id      UUID REFERENCES lab_analytes(id),
    rerun           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at    TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX ix_lab_instr_res_open ON lab_instrument_results (created_at DESC) WHERE status IN ('pending', 'unmatched');
CREATE INDEX ix_lab_instr_res_item ON lab_instrument_results (order_item_id);

CREATE TABLE lab_instrument_orders (
    id              BIGSERIAL PRIMARY KEY,
    instrument_id   UUID NOT NULL REFERENCES lab_instruments(id) ON DELETE CASCADE,
    specimen_id     UUID NOT NULL REFERENCES lab_specimens(id),
    codes           TEXT[] NOT NULL,
    status          VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        INT NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at         TIMESTAMPTZ,
    UNIQUE (instrument_id, specimen_id)
);

-- შედეგი ანალიზატორიდან (entered_by = NULL)
ALTER TABLE lab_results ADD COLUMN instrument_id UUID REFERENCES lab_instruments(id);

-- gateway-ის პულსი (ერთი ხაზი) — ეკრანზე „gateway მუშაობს / არ მუშაობს“
CREATE TABLE lab_gateway_state (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    heartbeat_at    TIMESTAMPTZ NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    version         TEXT,
    hostname        TEXT
);
