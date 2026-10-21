-- 050 — Program Transfer, kept simple (21 Oct 2026)
--
-- The gateway at a machine downloads the machine's program and posts its
-- backups (/api/device/v1: status, program, backup). A person can ask it for
-- a backup from the Program Transfer page; that request is all this adds.
-- Files stay in program_files and tokens in program_devices (both 030).
--
-- The command-queue gateway that 049 described is retired and 049 is no
-- longer in this folder. Where 049 already ran, two of its guards would
-- refuse a machine's token once a gateway had been assigned, so they go;
-- its tables are left as they are (unused). Dropping them is
-- rollback/049_gateway_transfer_down.sql, run separately and deliberately.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS program_backup_requests (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INT         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id    INT         NOT NULL REFERENCES machines(id)  ON DELETE CASCADE,
  requested_by  INT REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_id       BIGINT REFERENCES program_files(id) ON DELETE SET NULL,   -- the backup that answered it
  closed_at     TIMESTAMPTZ                                               -- answered, or given up after 30 min
);

-- one open request per machine: a second click finds the first
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_backup_requests_open
  ON program_backup_requests (machine_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_program_backup_requests_company
  ON program_backup_requests (company_id, requested_at DESC);

DROP TRIGGER IF EXISTS legacy_program_device_gateway_guard ON program_devices;
DROP TRIGGER IF EXISTS program_gateway_job_guard ON program_jobs;
DROP FUNCTION IF EXISTS guard_legacy_program_device();
DROP FUNCTION IF EXISTS guard_program_gateway_job();

COMMIT;

SELECT '=== Migration 050 complete ===' AS status;
