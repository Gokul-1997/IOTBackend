-- Opt-in, per-machine sustained-alarm notifications. No telemetry or alarm
-- history is rewritten. Duration is confirmed by accepted device observations.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_machines_id_company_alarm_rules ON machines(id, company_id);
CREATE TABLE IF NOT EXISTS alarm_notification_rules (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delay_seconds INTEGER NOT NULL DEFAULT 600 CHECK (delay_seconds BETWEEN 1 AND 86400),
  enabled_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, machine_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines(id, company_id) ON DELETE CASCADE
);

ALTER TABLE machine_alarms
  ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_continuity_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_alarm_notifications_pending
  ON machine_alarms (notification_checked_at NULLS FIRST, started_at, id)
  WHERE ended_at IS NULL AND notification_sent_at IS NULL;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS alarm_id BIGINT REFERENCES machine_alarms(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_alarm_user
  ON notifications(alarm_id, user_id) WHERE alarm_id IS NOT NULL;

COMMENT ON TABLE alarm_notification_rules IS 'Explicit company-admin opt-in per machine; waits for a sustained, freshly confirmed controller alarm. Disable or timing changes restart the qualification window.';
COMMENT ON COLUMN machine_alarms.notification_sent_at IS 'In-app inbox delivery committed for this physical alarm occurrence; independent of manual acknowledgement.';
COMMENT ON COLUMN machine_alarms.notification_continuity_started_at IS 'Qualification restarts when ingestion reconciles an open alarm without a trustworthy previous observation. Historical started_at is unchanged.';
COMMIT;
