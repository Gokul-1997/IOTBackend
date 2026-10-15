BEGIN;
SET LOCAL lock_timeout = '5s';
-- Stop the notification worker and the updated collector before attempting
-- rollback. Never discard saved company policy or delivery/deduplication data.
LOCK TABLE machine_alarms, notifications IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF to_regclass('alarm_notification_rules') IS NOT NULL THEN
    LOCK TABLE alarm_notification_rules IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM alarm_notification_rules) THEN
      RAISE EXCEPTION 'Cannot roll back 047: alarm notification rules exist. Preserve these records and disable rules instead.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('notifications')
      AND attname = 'alarm_id' AND NOT attisdropped) THEN
    IF EXISTS (SELECT 1 FROM notifications WHERE alarm_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot roll back 047: alarm delivery history exists. Preserve these records and disable rules instead.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('machine_alarms')
      AND attname = 'notification_sent_at' AND NOT attisdropped) THEN
    IF EXISTS (SELECT 1 FROM machine_alarms WHERE notification_sent_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot roll back 047: alarm delivery history exists. Preserve these records and disable rules instead.';
    END IF;
  END IF;
END $$;
DROP INDEX IF EXISTS uq_notifications_alarm_user;
ALTER TABLE notifications DROP COLUMN IF EXISTS alarm_id;
DROP INDEX IF EXISTS idx_alarm_notifications_pending;
ALTER TABLE machine_alarms
  DROP COLUMN IF EXISTS notification_checked_at,
  DROP COLUMN IF EXISTS notification_sent_at,
  DROP COLUMN IF EXISTS notification_continuity_started_at;
DROP TABLE IF EXISTS alarm_notification_rules;
DROP INDEX IF EXISTS uq_machines_id_company_alarm_rules;
COMMIT;
