-- Undo 055. The bill dates and the worked-out hours go; nothing else reads them.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS energy_hourly_coverage;
DROP TABLE IF EXISTS energy_hourly;
DROP TABLE IF EXISTS energy_billing;
COMMIT;
