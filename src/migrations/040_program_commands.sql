-- A durable, acknowledged controller command. Existing integrations keep protocol 1.
BEGIN;
ALTER TABLE program_jobs
  ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS controller_ip VARCHAR(45),
  ADD COLUMN IF NOT EXISTS request_key VARCHAR(80),
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(60),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_action_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_action_check CHECK (action IN ('SEND', 'FETCH', 'BACKUP'));
ALTER TABLE program_jobs ALTER COLUMN program_name DROP NOT NULL;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_program_name_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_program_name_check CHECK (action = 'BACKUP' OR program_name IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_command_request ON program_jobs(company_id, machine_id, requested_by, request_key) WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_command_open ON program_jobs(machine_id) WHERE protocol_version = 2 AND status IN ('QUEUED', 'DELIVERED');
CREATE INDEX IF NOT EXISTS idx_program_commands_expiry ON program_jobs(expires_at) WHERE protocol_version = 2 AND status IN ('QUEUED', 'DELIVERED');
COMMIT;
