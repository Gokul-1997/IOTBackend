-- Undo 050. Backup requests are short-lived (30 minutes), so nothing of value
-- is lost; the backups themselves are program_files rows and stay.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS program_backup_requests;
COMMIT;
