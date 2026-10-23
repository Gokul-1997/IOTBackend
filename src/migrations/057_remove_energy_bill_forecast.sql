-- 057 — the electricity bill forecast is taken out
--
-- The bill forecast — 055 (bill dates, and each machine's energy hour by
-- hour kept for it) and 056 (EB service connections, their bills as printed
-- and EB meter readings) — was removed on 23 Oct 2026 at the user's request:
-- entering every bill was too much work for the people using it. 055 and 056
-- are gone from this folder (the runner only checks the files it has). This
-- drops whatever they made wherever they were applied, and does nothing
-- anywhere else. No rollback: the code that used these tables is gone too.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS energy_readings;
DROP TABLE IF EXISTS energy_bills;
DROP TABLE IF EXISTS energy_connections;
DROP TABLE IF EXISTS energy_billing;
DROP TABLE IF EXISTS energy_hourly_coverage;
DROP TABLE IF EXISTS energy_hourly;
COMMIT;
