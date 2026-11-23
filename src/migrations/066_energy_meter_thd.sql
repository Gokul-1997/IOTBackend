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
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN
    GRANT UPDATE (thd_v1n, thd_v2n, thd_v3n, thd_v12, thd_v23, thd_v31,
                  thd_i1, thd_i2, thd_i3)
      ON energy_meter_readings TO machine_api_user;
  END IF;
END $$;

-- energy_meter_observed_v2 discovers measurement columns from the row JSON,
-- so new non-null channels automatically receive their own latest timestamp.
COMMIT;
