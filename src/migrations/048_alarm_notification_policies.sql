-- Company opt-in for critical notifications and a transactional alarm outbox.
-- Migration 047 and its historical rules remain unchanged; delays are a later phase.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS alarm_notification_policies (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  enabled_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE machine_alarms
  ADD COLUMN IF NOT EXISTS notification_priority_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS severity_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS severity_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_delivered_priorities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS alarm_priority TEXT;
UPDATE notifications n SET alarm_priority = CASE
  WHEN UPPER(BTRIM(a.severity)) IN('CRITICAL','FATAL','EMERGENCY') THEN 'critical'
  WHEN UPPER(BTRIM(a.severity)) IN('INFO','INFORMATION','INFORMATIONAL','LOW','MESSAGE') THEN 'info' ELSE 'noncritical' END
FROM machine_alarms a WHERE n.alarm_id=a.id AND n.alarm_priority IS NULL;
UPDATE machine_alarms a SET notification_delivered_priorities=ARRAY[CASE
  WHEN UPPER(BTRIM(a.severity)) IN('CRITICAL','FATAL','EMERGENCY') THEN 'critical'
  WHEN UPPER(BTRIM(a.severity)) IN('INFO','INFORMATION','INFORMATIONAL','LOW','MESSAGE') THEN 'info' ELSE 'noncritical' END]
WHERE a.notification_sent_at IS NOT NULL AND cardinality(a.notification_delivered_priorities)=0;
DROP INDEX IF EXISTS uq_notifications_alarm_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_alarm_user_priority
  ON notifications(alarm_id,user_id,alarm_priority) WHERE alarm_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS alarm_notification_events (
  id BIGSERIAL PRIMARY KEY,
  alarm_id BIGINT NOT NULL REFERENCES machine_alarms(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL,
  severity_class TEXT NOT NULL CHECK(severity_class IN('critical','noncritical','info')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  alarm_type TEXT,alarm_code TEXT,severity TEXT,message TEXT,
  processed_at TIMESTAMPTZ,checked_at TIMESTAMPTZ,outcome TEXT,
  UNIQUE(alarm_id,severity_class,occurred_at),
  FOREIGN KEY(machine_id,company_id) REFERENCES machines(id,company_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_alarm_notification_events_pending
  ON alarm_notification_events(checked_at NULLS FIRST,id) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alarm_notification_events_retention
  ON alarm_notification_events(processed_at) WHERE processed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alarm_notification_policies_open
  ON machine_alarms(notification_checked_at NULLS FIRST,started_at,id)
  WHERE ended_at IS NULL AND UPPER(BTRIM(severity)) IN('CRITICAL','FATAL','EMERGENCY')
    AND NOT ('critical'=ANY(notification_delivered_priorities));
COMMENT ON TABLE alarm_notification_policies IS 'Explicit company administrator opt-in for immediate critical notifications across the company. Unconfigured companies remain off. Migration 047 delay rules are retained as history only.';
COMMENT ON TABLE alarm_notification_events IS 'Accepted critical alarm opens/escalations. Transactional NOTIFY wakes the API; this outbox survives disconnects. Processed work expires after 7 days; alarm/inbox dedup persists.';
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='machine_api_user') THEN
    GRANT SELECT,INSERT ON alarm_notification_events TO machine_api_user;
    GRANT USAGE,SELECT ON SEQUENCE alarm_notification_events_id_seq TO machine_api_user;
  END IF;
END $$;
COMMIT;
