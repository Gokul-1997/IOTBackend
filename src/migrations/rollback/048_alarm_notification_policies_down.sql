BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE machine_alarms,notifications IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE table_name TEXT; has_data BOOLEAN;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['alarm_notification_policies','alarm_notification_events'] LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE',table_name);
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',table_name) INTO has_data;
      IF has_data THEN RAISE EXCEPTION 'Cannot roll back 048: saved configuration or alarm delivery history exists. Preserve these records and disable critical alerts instead.'; END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('machine_alarms') AND attname='notification_delivered_priorities' AND NOT attisdropped) THEN
    IF EXISTS(SELECT 1 FROM machine_alarms WHERE cardinality(notification_delivered_priorities)>0) THEN RAISE EXCEPTION 'Cannot roll back 048: alarm delivery history exists.'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('notifications') AND attname='alarm_priority' AND NOT attisdropped) THEN
    IF EXISTS(SELECT 1 FROM notifications WHERE alarm_priority IS NOT NULL) THEN RAISE EXCEPTION 'Cannot roll back 048: alarm delivery history exists.'; END IF;
  END IF;
END $$;
DROP TABLE IF EXISTS alarm_notification_events;
DROP INDEX IF EXISTS uq_notifications_alarm_user_priority;
ALTER TABLE notifications DROP COLUMN IF EXISTS alarm_priority;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_alarm_user ON notifications(alarm_id,user_id) WHERE alarm_id IS NOT NULL;
DROP INDEX IF EXISTS idx_alarm_notification_policies_open;
ALTER TABLE machine_alarms DROP COLUMN IF EXISTS notification_priority_changed_at,
  DROP COLUMN IF EXISTS severity_observed_at,DROP COLUMN IF EXISTS severity_received_at,
  DROP COLUMN IF EXISTS ended_received_at,DROP COLUMN IF EXISTS notification_delivered_priorities;
DROP TABLE IF EXISTS alarm_notification_policies;
COMMIT;
