-- 035 — what the collector needs to write telemetry exactly once
--
-- pms-backend now writes every accepted reading to a journal on its own disk
-- first, and moves it into the database in one transaction with the journal
-- position it reached. After a restart it carries on from that position, so a
-- deploy, a crash or a database outage no longer loses readings or adds the
-- same hourly production twice.
--
--   ingest_checkpoint  the journal position each collector has written up to
--   telemetry_late     readings that arrived more than 5 minutes late or out
--                      of order — kept for audit and back-filling, but not
--                      mixed into live data (they used to be thrown away)
--
-- Additive only. The collector refuses to start until both tables exist.
-- Rollback: rollback/035_ingest_journal_down.sql (after stopping the new
-- collector build).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ingest_checkpoint (
  collector_id TEXT PRIMARY KEY,
  last_seq     BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telemetry_late (
  id          BIGSERIAL PRIMARY KEY,
  machine_id  INTEGER NOT NULL,
  company_id  INTEGER,
  device_time BIGINT,
  received_at TIMESTAMPTZ NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('stale', 'out_of_order')),
  payload     JSONB
);
CREATE INDEX IF NOT EXISTS telemetry_late_machine_received ON telemetry_late (machine_id, received_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_late_received ON telemetry_late (received_at);

COMMENT ON TABLE ingest_checkpoint IS 'Journal position each MQTT collector has written up to (pms-backend flusher). Written in the same transaction as the readings.';
COMMENT ON TABLE telemetry_late IS 'Readings received >5 min late or out of order: kept, not used by dashboards. Cleared after 30 days by the collector.';

-- The collector connects as its own, narrower user in production
-- (machine_api_user); give it exactly what it needs, where that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN
    GRANT SELECT, INSERT, UPDATE ON ingest_checkpoint TO machine_api_user;
    GRANT SELECT, INSERT, DELETE ON telemetry_late TO machine_api_user;
    GRANT USAGE ON SEQUENCE telemetry_late_id_seq TO machine_api_user;
  END IF;
END $$;

COMMIT;

SELECT '=== Migration 035 complete ===' AS status;
