-- 051 — the gateway says what happened (21 Oct 2026)
--
-- A program the machine refused (memory full, program running, a format it
-- cannot read) or a backup it could not read: the gateway reports it with
-- POST /api/device/v1/report, the Program Transfer page shows it and the
-- person who uploaded or asked is notified. A program the machine took is
-- reported the same way, so the page can say "on the machine".
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE program_files
  ADD COLUMN IF NOT EXISTS delivery_status  VARCHAR(8) CHECK (delivery_status IN ('DONE', 'FAILED')),
  ADD COLUMN IF NOT EXISTS delivery_message VARCHAR(500),
  ADD COLUMN IF NOT EXISTS delivered_at     TIMESTAMPTZ;

ALTER TABLE program_backup_requests
  ADD COLUMN IF NOT EXISTS error_message VARCHAR(500);

COMMIT;

SELECT '=== Migration 051 complete ===' AS status;
