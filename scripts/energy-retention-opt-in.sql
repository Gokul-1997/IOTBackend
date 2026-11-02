-- OPTIONAL operator action, never called by migrations or application startup.
-- Export original measurements to verified recoverable storage first. Confirm
-- every other raw-data consumer can use that archive beyond these horizons.
-- Example session acknowledgements (set only after completing those steps):
-- SET iot.energy_archive_verified = 'true';
-- SET iot.raw_consumer_horizon_verified = 'true';
BEGIN;
DO $$ BEGIN
 IF current_setting('iot.energy_archive_verified',TRUE) IS DISTINCT FROM 'true'
   OR current_setting('iot.raw_consumer_horizon_verified',TRUE) IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'Retention refused: archive recovery and all raw-consumer horizons must be verified';
 END IF;
 IF EXISTS(SELECT 1 FROM energy_pipeline_state WHERE NOT ready)
   OR EXISTS(SELECT 1 FROM energy_meter_readings r LEFT JOIN energy_pipeline_state p ON p.company_id=r.company_id WHERE p.ready IS DISTINCT FROM TRUE)
   OR EXISTS(SELECT 1 FROM energy_reconcile_queue)
   OR EXISTS(SELECT 1 FROM energy_refresh_queue)
   OR NOT EXISTS(SELECT 1 FROM energy_pipeline_state WHERE ready) THEN
  RAISE EXCEPTION 'Retention refused: finish and verify backfill/reconciliation first';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') THEN
  RAISE EXCEPTION 'TimescaleDB is required';
 END IF;
 -- These are proposed minimum horizons, not a deletion default. They are
 -- deliberately outside every continuous-aggregate refresh window.
 PERFORM add_retention_policy('energy_meter_readings',INTERVAL '365 days',if_not_exists=>TRUE);
 PERFORM add_retention_policy('energy_counter_intervals',INTERVAL '730 days',if_not_exists=>TRUE);
 -- telemetry_raw also serves nonenergy reports. Its retention is a separate
 -- business decision and is deliberately not changed by this energy script.
END $$;
COMMIT;
