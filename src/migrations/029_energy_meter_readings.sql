-- Energy meter readings: everything a machine's 3-phase meter reports.
--
-- The Fanuc collector sends the meter as a PowerData block of ~50 values on
-- every message (VMC - 1 - F first, 3 Oct 2026). telemetry_raw keeps four of
-- them on every message (energy, voltage, current, power) for the Energy
-- screen's totals. This table keeps the whole set — each phase, kVA and kVAr,
-- power factor, frequency, demand, the meter's highest values and its
-- import/export registers — so they can be shown and trended.
--
-- One row per machine at most every 15 seconds (pms-backend
-- src/lib/meter-writer.js): the values move slowly, and the meter's own
-- demand and maximum registers keep the peaks in between. Typed columns, not
-- JSON: ~250 bytes a row instead of ~2 KB, and every value averages without a
-- cast. The column names and order match METER_FIELDS in
-- pms-backend src/lib/power-signals.js.
--
-- Running totals are double precision; everything else is real, which is the
-- precision the meter itself sends.

BEGIN;

CREATE TABLE IF NOT EXISTS energy_meter_readings (
  machine_id   INT         NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  company_id   INT,
  read_at      TIMESTAMPTZ NOT NULL,            -- the collector's time for the reading
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- voltage, V: each phase to neutral, each pair of phases, and the averages
  v1n REAL, v2n REAL, v3n REAL, v_ln_avg REAL,
  v12 REAL, v23 REAL, v31 REAL, v_ll_avg REAL,
  -- current, A
  i1 REAL, i2 REAL, i3 REAL, i_avg REAL,
  -- power per phase and in total: kW, kVAr, kVA
  kw1 REAL, kw2 REAL, kw3 REAL, kw_total REAL,
  kvar1 REAL, kvar2 REAL, kvar3 REAL, kvar_total REAL,
  kva1 REAL, kva2 REAL, kva3 REAL, kva_total REAL,
  -- power factor per phase and average; supply frequency, Hz
  pf1 REAL, pf2 REAL, pf3 REAL, pf_avg REAL,
  frequency_hz REAL,
  -- demand over the meter's own window: kW, kVAr, kVA
  kw_demand_max REAL, kw_demand_min REAL,
  kvar_demand_max REAL, kvar_demand_min REAL,
  kva_demand_max REAL,
  -- the highest values the meter has recorded
  v1n_max REAL, v2n_max REAL, v3n_max REAL,
  v12_max REAL, v23_max REAL, v31_max REAL,
  i1_max REAL, i2_max REAL, i3_max REAL,
  -- running totals: kWh, kVArh, kVAh; hours the meter has run
  kwh_import DOUBLE PRECISION, kwh_export DOUBLE PRECISION, kwh_total DOUBLE PRECISION,
  kvarh_import DOUBLE PRECISION, kvarh_export DOUBLE PRECISION, kvarh_total DOUBLE PRECISION,
  kvah_total DOUBLE PRECISION,
  run_hours DOUBLE PRECISION,
  aux_interrupts INT,

  PRIMARY KEY (machine_id, read_at)
);

-- Read by company and time range on the Energy screen.
CREATE INDEX IF NOT EXISTS idx_energy_meter_readings_company_time
  ON energy_meter_readings (company_id, read_at DESC);

-- A hypertable where TimescaleDB is installed (production is), so time
-- ranges prune whole weeks; a plain table works the same everywhere else.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('energy_meter_readings', 'read_at',
                              chunk_time_interval => INTERVAL '7 days',
                              if_not_exists => TRUE);
  END IF;
END $$;

-- The collector connects as machine_api_user on the production server; it
-- only adds rows. Other installations without that role skip this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN
    GRANT SELECT, INSERT ON energy_meter_readings TO machine_api_user;
  END IF;
END $$;

COMMIT;
