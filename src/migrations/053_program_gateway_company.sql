-- 053 — one gateway token per company, and programs wait in line (22 Oct 2026)
--
-- Until now every machine had its own gateway token (program_devices, 030)
-- and the gateway asked about one machine per call: 20–30 machines meant
-- 20–30 tokens to keep and 20–30 status calls every 15 seconds. From 053 a
-- company has ONE token (program_gateways). One GET /status answers for
-- every machine, and a call about one machine names it (or its IP).
--
-- Programs now wait in line per machine: two uploads for one machine go one
-- after the other, oldest first; when the gateway reports the first DONE (or
-- FAILED) the next one is offered. Waiting = an upload the gateway has not
-- reported on yet (delivery_status NULL).
--
-- Uploads from before the line that were never reported would now all wait,
-- the oldest first — test files from weeks ago included. Only the newest
-- upload of a machine was ever its program, so the older ones are marked
-- SKIPPED: still listed and downloadable, never sent.
--
-- Machine tokens stop working (nothing reads program_devices any more);
-- their rows stay as history.
BEGIN;
SET LOCAL lock_timeout = '5s';

/* ── the company's gateway, and its token ───────────────────────────────
   Only the token's SHA-256 is kept; the token is shown once when made.   */
CREATE TABLE IF NOT EXISTS program_gateways (
  id            SERIAL PRIMARY KEY,
  company_id    INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_prefix  VARCHAR(16)  NOT NULL,
  token_hash    CHAR(64)     NOT NULL UNIQUE,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ,
  last_seen_ip  VARCHAR(45),
  agent_version VARCHAR(50),
  revoked_at    TIMESTAMPTZ,
  revoked_by    INT REFERENCES users(id) ON DELETE SET NULL
);

-- one live token per company
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_gateways_live
  ON program_gateways (company_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_gateways_tenant
  ON program_gateways (company_id, id);

-- the gateway that sent a backup (device_id stays on files machine tokens sent)
ALTER TABLE program_files
  ADD COLUMN IF NOT EXISTS gateway_id INT REFERENCES program_gateways(id) ON DELETE SET NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'program_files_gateway_tenant_fk' AND conrelid = 'program_files'::regclass) THEN
    ALTER TABLE program_files ADD CONSTRAINT program_files_gateway_tenant_fk
      FOREIGN KEY (company_id, gateway_id) REFERENCES program_gateways (company_id, id);
  END IF;
END $$;

/* ── the line ─────────────────────────────────────────────────────────── */
ALTER TABLE program_files DROP CONSTRAINT IF EXISTS program_files_delivery_status_check;
ALTER TABLE program_files ADD CONSTRAINT program_files_delivery_status_check
  CHECK (delivery_status IN ('DONE', 'FAILED', 'SKIPPED'));

UPDATE program_files f
   SET delivery_status = 'SKIPPED'
 WHERE f.kind = 'NEW' AND f.delivery_status IS NULL AND f.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM program_files newer
                WHERE newer.machine_id = f.machine_id AND newer.kind = 'NEW' AND newer.deleted_at IS NULL
                  AND (newer.created_at, newer.id) > (f.created_at, f.id));

-- what GET /status reads every 15 s: each machine's waiting uploads, oldest first
CREATE INDEX IF NOT EXISTS idx_program_files_waiting
  ON program_files (machine_id, created_at, id)
  WHERE kind = 'NEW' AND delivery_status IS NULL AND deleted_at IS NULL;

COMMIT;

SELECT '=== Migration 053 complete ===' AS status;
