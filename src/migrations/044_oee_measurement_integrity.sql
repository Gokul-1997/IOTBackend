-- Unknown historical measurements remain NULL. Never backfill cycle snapshots
-- from today's component values or assign shift rejects to an invented hour.
BEGIN;
ALTER TABLE oee_shift_summary ADD COLUMN IF NOT EXISTS company_id INT;
-- Existing summary ownership can be derived from the referenced machine.
-- Preserve measured values; orphan/unowned legacy rows remain for review.
UPDATE oee_shift_summary summary SET company_id = machine.company_id
  FROM machines machine
 WHERE summary.machine_id = machine.id AND summary.company_id IS NULL
   AND machine.company_id IS NOT NULL;
ALTER TABLE oee_shift_summary ALTER COLUMN performance DROP NOT NULL,
  ALTER COLUMN quality DROP NOT NULL, ALTER COLUMN oee DROP NOT NULL;
ALTER TABLE oee_hourly ALTER COLUMN performance DROP NOT NULL,
  ALTER COLUMN quality DROP NOT NULL, ALTER COLUMN oee DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oee_shift_company_date ON oee_shift_summary(company_id,shift_date DESC);
COMMIT;
