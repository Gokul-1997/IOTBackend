-- 055 — the electricity bill: its dates, and each machine's energy hour by hour
--
-- Tariff & Rates takes the dates of the current electricity bill (reading
-- date to reading date, as printed on the EB bill). The Energy Dashboard
-- forecasts what that bill's energy will cost: what the meters counted from
-- the bill's first day until now, and the rest of the bill at this factory's
-- usual use, hour by hour, over the last four weeks.
--
--   energy_billing          one row per company: the bill period as entered.
--                           The next periods follow on by themselves — a
--                           month (or two, or three) later when the dates are
--                           whole months apart, otherwise the same length.
--   energy_hourly           kWh per machine per IST hour, worked out from the
--                           meter counters exactly as the Energy screen does
--                           (differences of consecutive real readings; a reset
--                           or a misread counts nothing). Kept so a month of
--                           history is read in milliseconds instead of being
--                           differenced again from compressed telemetry on
--                           every request. Derived data: a row deleted is
--                           worked out again.
--   energy_hourly_coverage  per company, the hours [from_hour, to_hour) that
--                           have been worked out — so an hour with no row is
--                           known to have used nothing, not to be missing.
--
-- Filled by the energy-hourly job (src/cron, every 10 minutes). Additive
-- only. Rollback: rollback/055_energy_billing_down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS energy_billing (
  company_id    INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  updated_by    INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- a week to three months: anything else is a typing mistake, not a bill
  CONSTRAINT energy_billing_period_length
    CHECK (period_end >= period_start + 6 AND period_end <= period_start + 92)
);

CREATE TABLE IF NOT EXISTS energy_hourly (
  machine_id  INT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  hour_start  TIMESTAMPTZ NOT NULL,          -- the IST hour of the later reading of each difference
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kwh         DOUBLE PRECISION NOT NULL,
  readings    INT NOT NULL,                  -- a row means the meter reported in that hour
  PRIMARY KEY (machine_id, hour_start),
  CONSTRAINT energy_hourly_values CHECK (kwh >= 0 AND readings > 0)
);
CREATE INDEX IF NOT EXISTS idx_energy_hourly_company_hour ON energy_hourly (company_id, hour_start);

CREATE TABLE IF NOT EXISTS energy_hourly_coverage (
  company_id  INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  from_hour   TIMESTAMPTZ NOT NULL,
  to_hour     TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT energy_hourly_coverage_order CHECK (to_hour >= from_hour)
);

COMMIT;
