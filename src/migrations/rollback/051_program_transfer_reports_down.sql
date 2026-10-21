-- Undo 051. The reports are status lines; the files themselves stay.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE program_files
  DROP COLUMN IF EXISTS delivery_status,
  DROP COLUMN IF EXISTS delivery_message,
  DROP COLUMN IF EXISTS delivered_at;
ALTER TABLE program_backup_requests DROP COLUMN IF EXISTS error_message;
COMMIT;
