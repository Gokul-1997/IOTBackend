-- 062 — structured Fanuc detector and CNC battery warnings.
-- Nullable JSONB preserves unknown readings and any reported axis (X/Y/Z/A/B…).
-- This is a metadata-only addition: do not infer or rewrite historical states.
-- Apply before deploying the collector which writes these columns.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE telemetry_raw
  ADD COLUMN IF NOT EXISTS acc_battery_status JSONB,
  ADD COLUMN IF NOT EXISTS cnc_battery_warning JSONB;

COMMENT ON COLUMN telemetry_raw.acc_battery_status IS
  'Fanuc detector battery diagnostics keyed by axis. Each axis may report low, ABP (bit 3), INP (bit 4), EXP (bit 5), raw, status and source. NULL is unreported, false means that warning was not reported; not proof of battery health. Controller make comes from machines.controller_type.';
COMMENT ON COLUMN telemetry_raw.cnc_battery_warning IS
  'Fanuc CNC battery warning: warning, raw_alarm_value, status and source. Separate from detector battery diagnostics; NULL means unreported. A false warning is not proof that both batteries are healthy.';

COMMIT;
