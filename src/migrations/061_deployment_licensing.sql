-- Phase 3 is dormant until the owner enables it. No existing company is enrolled.
CREATE TABLE IF NOT EXISTS deployment_licenses (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL UNIQUE,
  company_id INT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  deployment_mode TEXT NOT NULL CHECK (deployment_mode IN ('cloud', 'on_prem')),
  max_machines INT NOT NULL DEFAULT 10 CHECK (max_machines BETWEEN 1 AND 100000),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  activation_token_hash CHAR(64) NOT NULL UNIQUE CHECK (activation_token_hash ~ '^[0-9a-f]{64}$'),
  note VARCHAR(1000),
  payment_reference VARCHAR(200),
  last_seen_at TIMESTAMPTZ,
  last_reported_machines INT,
  active_boot_id UUID,
  lease_until TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  updated_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deployment_license_events (
  id BIGSERIAL PRIMARY KEY,
  license_id UUID NOT NULL REFERENCES deployment_licenses(id) ON DELETE RESTRICT,
  actor_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'token_rotated')),
  before_state JSONB,
  after_state JSONB NOT NULL,
  note VARCHAR(1000),
  payment_reference VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deployment_license_events_history ON deployment_license_events(license_id, id DESC);

CREATE OR REPLACE FUNCTION reject_deployment_license_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deployment license events are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS deployment_license_events_immutable ON deployment_license_events;
CREATE TRIGGER deployment_license_events_immutable
BEFORE UPDATE OR DELETE ON deployment_license_events
FOR EACH ROW EXECUTE FUNCTION reject_deployment_license_event_mutation();
