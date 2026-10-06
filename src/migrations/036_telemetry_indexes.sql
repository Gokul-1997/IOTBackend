-- migrate: statement-by-statement
-- 036 — telemetry_raw: drop the indexes nothing uses, index the meter readings
--
-- Every reading is written into every index of telemetry_raw. Measured on
-- production (6 Oct 2026, 211 daily chunks, 7.8 GB of rows, 13.4 GB of
-- indexes), three of the nine cost space and write time for nothing:
--   idx_machine_time       the same columns as idx_telemetry_machine_time,
--                          which every chunk also has (3.4 GB; 23 thousand
--                          uses against 451 million)
--   idx_machine_status     a two-value column (0.7 GB; 88 uses in 7 months)
--   idx_plant_time         plants do not scope telemetry (1.5 GB; no row ever
--                          read through it)
-- idx_telemetry_machine (machine_id alone) stays: production reads 89 million
-- rows through it, and the planner prefers it for some per-machine scans.
-- production_hourly has the same unique index three times; the primary key
-- stays, the two copies go.
--
-- The Energy screen reads telemetry_raw for the rows that carry a meter
-- reading (energy > 0; power, voltage or current) — about 3 % of rows in
-- production. Without an index it read every row of the company in the
-- range. Two small partial indexes take the Energy endpoint for a 100-machine
-- company from 0.88 s to 8 ms in staging (and it grew with every day of range).
--
-- Runs statement by statement: TimescaleDB builds the new index one chunk at
-- a time (transaction_per_chunk), so writes to a chunk wait only while that
-- chunk is indexed, not for the whole build. The collector keeps readings in
-- its journal meanwhile. Rollback: rollback/036_telemetry_indexes_down.sql.
SET statement_timeout = 0;
SET lock_timeout = '10s';

DROP INDEX IF EXISTS idx_machine_time;
DROP INDEX IF EXISTS idx_machine_status;
DROP INDEX IF EXISTS idx_plant_time;
DROP INDEX IF EXISTS idx_prod_hour;
DROP INDEX IF EXISTS production_hourly_unique;

CREATE INDEX IF NOT EXISTS idx_telemetry_energy_readings
  ON telemetry_raw (company_id, received_at)
  WITH (timescaledb.transaction_per_chunk)
  WHERE energy > 0;

CREATE INDEX IF NOT EXISTS idx_telemetry_electrical_readings
  ON telemetry_raw (company_id, received_at)
  WITH (timescaledb.transaction_per_chunk)
  WHERE power IS NOT NULL OR voltage IS NOT NULL OR current IS NOT NULL;
