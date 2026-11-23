-- Keep the controller's raw downtime value while its PLC meaning is unmapped.
-- Zero is a supplied value; NULL means this telemetry packet supplied none.
-- This does not create operator-declared downtime events or assign units.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Leave TimescaleDB's normal ADD COLUMN propagation enabled so existing
-- compressed chunks gain the nullable field without decompressing history.
ALTER TABLE telemetry_raw
  ADD COLUMN IF NOT EXISTS controller_downtime_value DOUBLE PRECISION;

COMMIT;
