-- Stop/downgrade the collector first: it requires these columns to write.
-- Rollback removes only the new diagnostics and their recorded history.
-- The legacy apc_battery_status column is retained.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE telemetry_raw
  DROP COLUMN IF EXISTS acc_battery_status,
  DROP COLUMN IF EXISTS cnc_battery_warning;
COMMIT;
