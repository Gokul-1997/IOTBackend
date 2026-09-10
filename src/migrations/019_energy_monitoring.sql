-- 019 — Screen 9: Energy Monitoring.
--
-- telemetry_raw already has an `energy` column and it is NULL on every one
-- of its rows, because no device has ever sent the field. The agreement's
-- energy module is specified as "KWh, Volts, Amps", so the two electrical
-- readings it is missing are added here alongside instantaneous power.
--
-- Adding them before the devices send them is deliberate. The collector
-- now reads all three; a column that does not exist would mean the first
-- firmware that does send them has its readings silently dropped, and
-- nobody would know until someone went looking for a month of missing
-- data.
--
-- Energy cost and the overload threshold are per company, not per row:
-- they are settings someone types in once, and storing a tariff against
-- every telemetry row would be both wasteful and wrong the moment the
-- tariff changes.

BEGIN;

ALTER TABLE telemetry_raw
  ADD COLUMN IF NOT EXISTS voltage DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS current DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS power   DOUBLE PRECISION;

COMMENT ON COLUMN telemetry_raw.voltage IS 'Volts, as reported by the machine or its energy meter.';
COMMENT ON COLUMN telemetry_raw.current IS 'Amperes.';
COMMENT ON COLUMN telemetry_raw.power   IS 'Instantaneous power in kW. energy is the cumulative kWh counter.';

/* Per-machine energy settings: what a unit costs and what counts as an
   overload. Nullable everywhere — a plant that has not configured a tariff
   should see energy in kWh with no cost column, not a cost of zero. */
CREATE TABLE IF NOT EXISTS energy_settings (
  id                  SERIAL PRIMARY KEY,
  company_id          INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id          INT REFERENCES machines(id) ON DELETE CASCADE,
  cost_per_kwh        NUMERIC(10,4),
  currency            VARCHAR(8) NOT NULL DEFAULT 'INR',
  overload_kw         NUMERIC(10,2),
  created_by          INT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE energy_settings IS
  'Tariff and overload threshold. machine_id NULL is the company-wide default; a row with a machine_id overrides it for that machine.';

/* One default row per company and one override per machine. A second row
   for the same scope would make "what does a unit cost here?" have two
   answers, and which one won would depend on row order. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_energy_settings_company_default
  ON energy_settings (company_id) WHERE machine_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_energy_settings_machine
  ON energy_settings (machine_id) WHERE machine_id IS NOT NULL;

COMMIT;
