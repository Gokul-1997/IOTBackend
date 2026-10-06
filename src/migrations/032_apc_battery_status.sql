-- 032 — the battery alarm per axis, as the collector now sends it
--
-- Since 5 Oct 2026 the embedded team's collector reports the battery as one
-- flag per axis, `"battery": {"X": false, "Y": false, "Z": false}` — the
-- alarm the controller keeps for each axis's absolute-encoder (APC) battery
-- — and no voltage. Migration 021's cnc_battery_voltage and
-- apc_battery_voltage hold volts, so this needs a column of its own.
--
-- One JSONB keyed by axis rather than a column per axis: it is read as a
-- whole ("is any axis low?"), never trended, and a 4- or 5-axis machine
-- needs no further migration. NULL unless the controller sends a flag.
--
-- The fans (`cnc_fans`, {on, fault, rpm} per fan) need no migration: they go
-- into 021's fan_status JSONB.
--
-- Must be applied BEFORE the collector (pms-backend) that writes the column
-- is deployed: that build refuses to start while the column is missing.

BEGIN;

-- telemetry_raw takes an insert every second from every machine. ADD COLUMN
-- with no default is metadata-only (compression is off) but still needs an
-- exclusive lock; without a timeout the request would queue behind in-flight
-- inserts and stall ingestion for the plant. Five seconds, then fail cleanly
-- and retry later.
SET LOCAL lock_timeout = '5s';

ALTER TABLE telemetry_raw
  ADD COLUMN IF NOT EXISTS apc_battery_status JSONB;

COMMENT ON COLUMN telemetry_raw.apc_battery_status IS
  'Battery flag per axis as the collector sends it, e.g. {"X": false, "Y": false, "Z": false}. NULL when the controller reports none. Meaning of true: MQTT_PAYLOAD_CONTRACT.md.';

COMMIT;

SELECT '=== Migration 032 complete ===' AS status;
