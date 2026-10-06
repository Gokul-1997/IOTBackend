-- 034 — what an hour of each machine costs
--
-- On 6 Oct 2026 S AND T sent a ₹/hour rate for each of its machines and asked
-- for the time machines lose — idle, and in alarm — to be shown in rupees on
-- the Downtime and OEE screens: hours lost × the machine's rate.
--
-- One nullable column. NULL means "no rate set": that machine's lost time is
-- not priced, and the screens say how many machines a ₹ figure covers rather
-- than counting the unpriced ones as free.

BEGIN;

-- machines is read on every telemetry message; a short lock or none
SET LOCAL lock_timeout = '5s';

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS hour_rate NUMERIC(10,2);

ALTER TABLE machines DROP CONSTRAINT IF EXISTS machines_hour_rate_not_negative;
ALTER TABLE machines
  ADD CONSTRAINT machines_hour_rate_not_negative CHECK (hour_rate IS NULL OR hour_rate >= 0);

COMMENT ON COLUMN machines.hour_rate IS
  'What an hour of this machine costs, in the company''s currency (INR). NULL = not set: its idle and alarm time is not priced.';

COMMIT;

SELECT '=== Migration 034 complete ===' AS status;
