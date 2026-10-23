-- 059 — Program Transfer: when the gateway took a program (23 Oct 2026)
--
-- A program the gateway had downloaded but never reported on looked exactly
-- like one it had not picked up yet ("waiting for the gateway"), while every
-- later upload for the machine queued behind it — what a gateway flow that
-- forgets POST /report leaves behind. GET /program now stamps the program it
-- hands out, and the page says "sent to the gateway at …, waiting for its
-- report". Downloading it again (a retry) moves the time on.
--
-- A new name: production still has 049's program_files columns
-- (gateway_id, provenance, upload_request_key), unused.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE program_files ADD COLUMN IF NOT EXISTS sent_to_gateway_at TIMESTAMPTZ;

COMMIT;

SELECT '=== Migration 059 complete ===' AS status;
