-- Do not remove acknowledged command history or pretend an active command stopped.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM program_jobs WHERE protocol_version = 2) THEN
    RAISE EXCEPTION 'Protocol 2 command history exists. Roll back application code with this additive schema retained.';
  END IF;
END $$;
DROP INDEX IF EXISTS uq_program_command_request;
DROP INDEX IF EXISTS uq_program_command_open;
DROP INDEX IF EXISTS idx_program_commands_expiry;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_program_name_check;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_action_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_action_check CHECK (action IN ('SEND', 'FETCH'));
ALTER TABLE program_jobs ALTER COLUMN program_name SET NOT NULL;
ALTER TABLE program_jobs DROP COLUMN IF EXISTS protocol_version, DROP COLUMN IF EXISTS controller_ip,
  DROP COLUMN IF EXISTS request_key, DROP COLUMN IF EXISTS error_code, DROP COLUMN IF EXISTS expires_at;
COMMIT;
