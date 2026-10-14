BEGIN;

-- Roll back the matching API release before removing its session column.
ALTER TABLE users DROP COLUMN IF EXISTS auth_revision;

COMMIT;
