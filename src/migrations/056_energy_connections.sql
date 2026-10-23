-- 056 — the EB bills as printed, per service connection
--
-- A factory can have more than one EB supply (S AND T: SC 1212 and SC 2309),
-- each with its own reading dates, rate, fixed charges, penalties and taxes.
-- The bill forecast is worked out the way those bills are, so the bills
-- themselves are kept, one row per bill, with every charge as printed:
--
--   energy_connections  one per EB service connection (number, a name, and
--                       optionally the machine whose energy meter measures
--                       the whole supply)
--   energy_bills        each bill: From and To reading dates, units, rate,
--                       peak hour charges, electricity charges, fixed charges,
--                       ED/LPF penalty, welding surcharge, E tax & TCS, any
--                       other charges, and the net bill
--   energy_readings     EB meter readings (kWh register) entered by date —
--                       with them the units so far are exact, not estimated
--
-- energy_billing (055), one set of bill dates per company, is dropped: each
-- connection's bills carry their own dates. It was never released.
-- Additive otherwise. Rollback: rollback/056_energy_connections_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS energy_connections (
  id                SERIAL PRIMARY KEY,
  company_id        INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sc_number         VARCHAR(40) NOT NULL,
  name              VARCHAR(80),
  meter_machine_id  INT REFERENCES machines(id) ON DELETE SET NULL,
  created_by        INT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_energy_connections_number UNIQUE (company_id, sc_number),
  -- the target of the bills' and readings' company-and-connection keys
  CONSTRAINT uq_energy_connections_tenant UNIQUE (company_id, id),
  CONSTRAINT energy_connections_number_not_blank CHECK (length(btrim(sc_number)) > 0)
);

CREATE TABLE IF NOT EXISTS energy_bills (
  id                   SERIAL PRIMARY KEY,
  company_id           INT NOT NULL,
  connection_id        INT NOT NULL,
  period_from          DATE NOT NULL,          -- the reading the bill starts from
  period_to            DATE NOT NULL,          -- this bill's reading: the next bill starts here
  units                NUMERIC(14,2) NOT NULL,
  rate                 NUMERIC(10,4),
  electricity_charges  NUMERIC(14,2) NOT NULL,
  peak_charges         NUMERIC(14,2) NOT NULL DEFAULT 0,
  fixed_charges        NUMERIC(14,2) NOT NULL DEFAULT 0,
  penalty_charges      NUMERIC(14,2) NOT NULL DEFAULT 0,   -- ED / LPF penalty
  welding_charges      NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_charges          NUMERIC(14,2) NOT NULL DEFAULT 0,   -- E tax & TCS
  other_charges        NUMERIC(14,2) NOT NULL DEFAULT 0,   -- arrears, adjustments: may be negative
  net_amount           NUMERIC(14,2) NOT NULL,
  created_by           INT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT energy_bills_connection_fk FOREIGN KEY (company_id, connection_id)
    REFERENCES energy_connections (company_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_energy_bills_period UNIQUE (connection_id, period_from),
  CONSTRAINT energy_bills_period CHECK (period_to > period_from AND period_to <= period_from + 93),
  CONSTRAINT energy_bills_amounts CHECK (
    units >= 0 AND (rate IS NULL OR rate >= 0) AND electricity_charges >= 0 AND peak_charges >= 0
    AND fixed_charges >= 0 AND penalty_charges >= 0 AND welding_charges >= 0 AND tax_charges >= 0)
);
CREATE INDEX IF NOT EXISTS idx_energy_bills_connection ON energy_bills (connection_id, period_to DESC);

CREATE TABLE IF NOT EXISTS energy_readings (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL,
  connection_id  INT NOT NULL,
  read_on        DATE NOT NULL,
  kwh            NUMERIC(16,2) NOT NULL,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT energy_readings_connection_fk FOREIGN KEY (company_id, connection_id)
    REFERENCES energy_connections (company_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_energy_readings_day UNIQUE (connection_id, read_on),
  CONSTRAINT energy_readings_kwh CHECK (kwh >= 0)
);

DROP TABLE IF EXISTS energy_billing;

COMMIT;
