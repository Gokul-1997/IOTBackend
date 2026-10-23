-- 060 — a machine's controller type: Fanuc or Mitsubishi (23 Oct 2026)
--
-- The user: "on the Machines page, one more dropdown for the controller —
-- Fanuc or Mitsubishi — and give it in the gateway's status". The
-- Controller box stays free text (the model: "Fanuc 0i-MF"); this is the
-- make, which a gateway uses to choose how it talks to the CNC. It is set on
-- the Machines page, never by telemetry: cnc_type and the rest of 021 are
-- what the controller reports, written by the collector.
--
-- A machine whose Controller text already names exactly one of the two is
-- given it, so existing machines need no edit; the rest stay unset (NULL)
-- until someone picks one.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS controller_type VARCHAR(16) CHECK (controller_type IN ('FANUC', 'MITSUBISHI'));

UPDATE machines
   SET controller_type = CASE WHEN controller ILIKE '%fanuc%' THEN 'FANUC' ELSE 'MITSUBISHI' END
 WHERE controller_type IS NULL
   AND (controller ILIKE '%fanuc%') <> (controller ILIKE '%mitsubishi%');

COMMIT;

SELECT '=== Migration 060 complete ===' AS status;
