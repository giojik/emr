-- 0026_lab_qc.sql
-- ლაბორატორიის ხარისხის კონტროლი (QC):
--  • საკონტროლო მასალები (დონე, ლოტი, ვადა, „შტრიხკოდი“ — რითაც ანალიზატორი QC-ს აგზავნის)
--  • სამიზნეები: მასალა × კომპონენტი × ანალიზატორი → mean, SD
--  • Westgard-ის წესები და მოქმედება (დაბლოკვა / გაფრთხილება) — კომპონენტის მიხედვით, ლაბორატორიის ხელმძღვანელი აკონფიგურირებს
--    (ჩანაწერის არარსებობა = სრული ნაკრები + დაბლოკვა)
--  • QC-ის შედეგები (ანალიზატორიდან ან ხელით), z-ქულა, შეფასება; დარღვევები (ღია → განხილული: მიზეზი + მაკორექტირებელი ქმედება)
CREATE TABLE lab_qc_materials (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    manufacturer    TEXT,
    level           TEXT NOT NULL,                     -- L1 / L2 / L3 / ნორმა / პათოლოგია
    lot             TEXT NOT NULL,
    expires_on      DATE,
    barcode         TEXT,                              -- QC ნიმუშის ID ანალიზატორზე (მაგ. QC-L1-2604)
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_lab_qc_material_barcode ON lab_qc_materials (upper(barcode)) WHERE barcode IS NOT NULL AND is_active;

CREATE TABLE lab_qc_targets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    material_id     UUID NOT NULL REFERENCES lab_qc_materials(id),
    analyte_id      UUID NOT NULL REFERENCES lab_analytes(id),
    method_id       UUID NOT NULL REFERENCES lab_methods(id),
    mean            NUMERIC NOT NULL,
    sd              NUMERIC NOT NULL CHECK (sd > 0),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (material_id, analyte_id, method_id)
);

CREATE TABLE lab_qc_rules (
    analyte_id      UUID PRIMARY KEY REFERENCES lab_analytes(id),
    rules           TEXT[] NOT NULL CHECK (rules <@ ARRAY['1_2s','1_3s','2_2s','R_4s','4_1s','10x']::text[]),
    action          VARCHAR(5) NOT NULL CHECK (action IN ('block', 'warn')),
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lab_qc_results (
    id              BIGSERIAL PRIMARY KEY,
    target_id       UUID NOT NULL REFERENCES lab_qc_targets(id),
    value           NUMERIC NOT NULL,
    z               NUMERIC NOT NULL,
    measured_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source          VARCHAR(10) NOT NULL CHECK (source IN ('instrument', 'manual')),
    instrument_result_id BIGINT REFERENCES lab_instrument_results(id) ON DELETE SET NULL,
    status          VARCHAR(6) NOT NULL CHECK (status IN ('accept', 'warn', 'reject')),
    violations      TEXT[] NOT NULL DEFAULT '{}',
    entered_by      UUID REFERENCES users(id),
    excluded_at     TIMESTAMPTZ,
    excluded_by     UUID REFERENCES users(id),
    exclude_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_lab_qc_results_target ON lab_qc_results (target_id, measured_at DESC);

CREATE TABLE lab_qc_violations (
    id              BIGSERIAL PRIMARY KEY,
    method_id       UUID NOT NULL REFERENCES lab_methods(id),
    analyte_id      UUID NOT NULL REFERENCES lab_analytes(id),
    result_id       BIGINT NOT NULL REFERENCES lab_qc_results(id),
    rules           TEXT[] NOT NULL,
    action          VARCHAR(5) NOT NULL CHECK (action IN ('block', 'warn')),
    status          VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id),
    cause           TEXT,
    corrective_action TEXT
);
CREATE UNIQUE INDEX uq_lab_qc_violation_open ON lab_qc_violations (method_id, analyte_id) WHERE status = 'open';

-- ანალიზატორის QC ჩანაწერი → QC-ის შედეგი
ALTER TABLE lab_instrument_results DROP CONSTRAINT IF EXISTS lab_instrument_results_status_check;
ALTER TABLE lab_instrument_results ADD CONSTRAINT lab_instrument_results_status_check CHECK (status IN ('pending', 'applied', 'unmatched', 'dismissed', 'qc'));
