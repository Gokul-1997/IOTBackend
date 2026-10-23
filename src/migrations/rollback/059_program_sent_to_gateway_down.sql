-- Undo 059. The page no longer knows when the gateway took a program.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE program_files DROP COLUMN IF EXISTS sent_to_gateway_at;
COMMIT;
