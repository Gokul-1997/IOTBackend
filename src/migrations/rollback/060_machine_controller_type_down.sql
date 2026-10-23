-- Undo 060. The Controller text stays; the Fanuc / Mitsubishi choice goes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE machines DROP COLUMN IF EXISTS controller_type;
COMMIT;
