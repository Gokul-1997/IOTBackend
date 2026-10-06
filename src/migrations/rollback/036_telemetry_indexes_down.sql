-- migrate: statement-by-statement
-- Undo 036: put the dropped indexes back (each build reads every chunk:
-- minutes on production; inserts into a chunk wait while it is indexed).
SET statement_timeout = 0;
DROP INDEX IF EXISTS idx_telemetry_energy_readings;
DROP INDEX IF EXISTS idx_telemetry_electrical_readings;
CREATE INDEX IF NOT EXISTS idx_machine_time ON telemetry_raw (machine_id, received_at DESC) WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_machine_status ON telemetry_raw (machine_status) WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_plant_time ON telemetry_raw (plant_id, received_at DESC) WITH (timescaledb.transaction_per_chunk);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_hour ON production_hourly (machine_id, shift_id, hour_start);
CREATE UNIQUE INDEX IF NOT EXISTS production_hourly_unique ON production_hourly (machine_id, shift_id, hour_start);
DELETE FROM schema_migrations WHERE filename = '036_telemetry_indexes.sql';
