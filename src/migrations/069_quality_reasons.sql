BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE quality_entries
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(500),
  ADD COLUMN IF NOT EXISTS rework_reason VARCHAR(500);

COMMENT ON COLUMN quality_entries.rejection_reason IS
  'Operator-entered reason for the rejected quantity for this machine, shift and day.';
COMMENT ON COLUMN quality_entries.rework_reason IS
  'Operator-entered reason for the rework quantity for this machine, shift and day.';

COMMIT;
