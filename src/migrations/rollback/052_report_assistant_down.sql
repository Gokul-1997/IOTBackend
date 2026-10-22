-- Undo 052. Usage counts and the allowance setting go; nothing else used them.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS assistant_usage;
DROP TABLE IF EXISTS assistant_settings;
ALTER TABLE companies DROP COLUMN IF EXISTS timezone;
COMMIT;
