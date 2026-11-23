-- The nested meter payload reports independent voltage/current THD channels.
-- Missing or null readings remain unknown; existing rows are not backfilled.
BEGIN;

ALTER TABLE energy_meter_readings
  ADD COLUMN IF NOT EXISTS thd_v1n REAL,
  ADD COLUMN IF NOT EXISTS thd_v2n REAL,
  ADD COLUMN IF NOT EXISTS thd_v3n REAL,
  ADD COLUMN IF NOT EXISTS thd_v12 REAL,
  ADD COLUMN IF NOT EXISTS thd_v23 REAL,
  ADD COLUMN IF NOT EXISTS thd_v31 REAL,
  ADD COLUMN IF NOT EXISTS thd_i1 REAL,
  ADD COLUMN IF NOT EXISTS thd_i2 REAL,
  ADD COLUMN IF NOT EXISTS thd_i3 REAL;

-- Table-level SELECT/INSERT already cover added columns; the sparse UPSERT
-- also needs UPDATE for each new measurement without granting identity edits.
DO $$
DECLARE
  grant_sql TEXT := 'GRANT UPDATE (thd_v1n, thd_v2n, thd_v3n, thd_v12, thd_v23, thd_v31,
                                thd_i1, thd_i2, thd_i3)
                       ON energy_meter_readings TO machine_api_user';
  restoring_before TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN
    BEGIN
      EXECUTE grant_sql;
    EXCEPTION WHEN undefined_column THEN
      -- TimescaleDB 2.19 adds columns to compressed chunks but not their
      -- legacy compressed parent. Its GRANT hook forwards column names to
      -- that parent anyway, where PostgreSQL correctly rejects them.
      -- https://github.com/timescale/timescaledb/blob/2.19.3/src/process_utility.c
      -- Suppress that hook only for this root-table ACL change. ALTER TABLE
      -- above must run with normal Timescale propagation. Queries/writes via
      -- the hypertable check its ACL; direct internal-table access is unneeded.
      IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE;
      END IF;
      restoring_before := current_setting('timescaledb.restoring');
      BEGIN
        PERFORM set_config('timescaledb.restoring', 'on', true);
        EXECUTE grant_sql;
        PERFORM set_config('timescaledb.restoring', restoring_before, true);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'Migration 066 needs administrator permission for the legacy TimescaleDB column-grant workaround',
          HINT = 'Rerun this migration as a database superuser (or a role allowed to SET timescaledb.restoring).';
      END;
    END;
  END IF;
END $$;

-- energy_meter_observed_v2 discovers measurement columns from the row JSON,
-- so new non-null channels automatically receive their own latest timestamp.
COMMIT;
