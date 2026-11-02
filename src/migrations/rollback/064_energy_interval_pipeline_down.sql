-- Disable ENERGY_V2_ENABLED and stop the reconcile job before this rollback.
-- Export derived intervals/rules/events before deleting them. Raw readings and
-- legacy production_hourly are deliberately preserved.
BEGIN;
DO $$ BEGIN
 IF to_regclass('energy_counter_hourly') IS NOT NULL THEN
  RAISE EXCEPTION 'Roll back 065 derived aggregate views first';
 END IF;
 IF (EXISTS(SELECT 1 FROM energy_counter_intervals LIMIT 1)
     OR EXISTS(SELECT 1 FROM energy_meter_rules LIMIT 1)
     OR EXISTS(SELECT 1 FROM energy_counter_events LIMIT 1))
   AND current_setting('iot.energy_derived_backup_verified',TRUE) IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'Export and verify derived intervals, rules and events; set iot.energy_derived_backup_verified=true to acknowledge the recovery copy';
 END IF;
END $$;
DROP TRIGGER IF EXISTS energy_meter_observed_v2 ON energy_meter_readings;
DROP TRIGGER IF EXISTS energy_meter_deleted_v2 ON energy_meter_readings;
DROP TRIGGER IF EXISTS energy_rule_changed_v2 ON energy_meter_rules;
DROP TRIGGER IF EXISTS energy_event_changed_v2 ON energy_counter_events;
DROP FUNCTION IF EXISTS energy_meter_observed_v2();
DROP FUNCTION IF EXISTS energy_meter_deleted_v2();
DROP FUNCTION IF EXISTS energy_rule_changed_v2();
DROP FUNCTION IF EXISTS energy_enqueue(INT,INT,TIMESTAMPTZ);
-- TimescaleDB requires its hypertable to be dropped in its own statement.
DROP TABLE energy_counter_intervals;
DROP TABLE energy_counter_state,energy_reconcile_queue,energy_refresh_queue,energy_meter_latest,energy_counter_events,energy_meter_rules,energy_backfill_windows,energy_pipeline_state;
ALTER TABLE energy_meter_readings DROP CONSTRAINT IF EXISTS energy_meter_owner_v2;
ALTER TABLE energy_meter_readings DROP CONSTRAINT IF EXISTS energy_meter_company_required_v2;
DROP INDEX IF EXISTS energy_meter_tenant_machine_time;
DELETE FROM schema_migrations WHERE filename='064_energy_interval_pipeline.sql';
-- Source meter compression is lossless and may remain. See runbook for
-- optional decompress-before-removing-policy steps if capacity permits.
COMMIT;
