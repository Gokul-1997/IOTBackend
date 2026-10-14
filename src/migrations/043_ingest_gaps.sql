-- Unallocated counter changes across missing machine observations.
-- Additive only; no retroactive allocation or telemetry deletion.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS ingest_gaps (
  collector_id TEXT NOT NULL,
  journal_seq BIGINT NOT NULL,
  company_id INT NOT NULL,
  machine_id INT NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  resumed_at TIMESTAMPTZ NOT NULL,
  gap_seconds BIGINT NOT NULL CHECK (gap_seconds > 60),
  known_state_seconds INT NOT NULL DEFAULT 60 CHECK (known_state_seconds BETWEEN 0 AND 60),
  unallocated_parts INT NOT NULL CHECK (unallocated_parts >= 0),
  unallocated_energy_kwh DOUBLE PRECISION CHECK (unallocated_energy_kwh IS NULL OR unallocated_energy_kwh >= 0),
  reason TEXT NOT NULL CHECK (reason = 'observations_missing'),
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (collector_id,journal_seq),
  FOREIGN KEY (company_id,machine_id) REFERENCES machines(company_id,id),
  CHECK (resumed_at > last_observed_at)
);
CREATE INDEX IF NOT EXISTS idx_ingest_gaps_tenant_machine_time ON ingest_gaps(company_id,machine_id,resumed_at DESC);
COMMENT ON TABLE ingest_gaps IS 'Counter deltas retained for reconciliation when more than 60 seconds separate observations. Parts/energy are not silently assigned to an unverified hour or shift.';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN
    GRANT SELECT, INSERT ON ingest_gaps TO machine_api_user;
  END IF;
END $$;
COMMIT;
