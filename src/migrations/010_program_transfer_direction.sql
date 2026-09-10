-- ============================================================
-- Phase 2 · Screen 10 — Program Transfer
-- Transfers can now go both ways (Local PC → CNC and CNC → Local PC),
-- so the history has to record which way each one went, and how big
-- the file was, for the audit log.
-- ============================================================
BEGIN;

ALTER TABLE program_transfers
  ADD COLUMN IF NOT EXISTS direction VARCHAR(10) NOT NULL DEFAULT 'UPLOAD',
  ADD COLUMN IF NOT EXISTS file_size INTEGER;

-- Everything logged before this migration was an upload to the machine.
COMMENT ON COLUMN program_transfers.direction IS 'UPLOAD = server → CNC, DOWNLOAD = CNC → server';

ALTER TABLE program_transfers
  DROP CONSTRAINT IF EXISTS program_transfers_direction_check;
ALTER TABLE program_transfers
  ADD CONSTRAINT program_transfers_direction_check
  CHECK (direction IN ('UPLOAD', 'DOWNLOAD'));

CREATE INDEX IF NOT EXISTS idx_program_transfers_direction
  ON program_transfers(company_id, direction, started_at DESC);

-- Programs pulled off a controller have no uploaded file on disk, so the
-- uploader column must tolerate rows that were never uploaded by a user.
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'UPLOAD';
COMMENT ON COLUMN programs.source IS 'UPLOAD = added by a user, CNC = pulled from a controller';

COMMIT;

SELECT '=== Migration 010 complete ===' AS status;
