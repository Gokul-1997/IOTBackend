BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE machines,program_jobs,program_files,program_devices IN ACCESS EXCLUSIVE MODE;
DO $$ DECLARE table_name TEXT; used BOOLEAN;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['program_gateways','program_gateway_assignments','program_gateway_events'] LOOP
  IF to_regclass(table_name) IS NOT NULL THEN
   EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE',table_name);
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',table_name) INTO used;
   IF used THEN RAISE EXCEPTION 'Cannot roll back 049: gateway configuration or audit history exists. Preserve records and disable the gateway instead.'; END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM program_jobs WHERE protocol_version=3) THEN RAISE EXCEPTION 'Cannot roll back 049: gateway job history exists'; END IF;
END $$;
DROP TRIGGER IF EXISTS legacy_program_device_gateway_guard ON program_devices;
DROP TRIGGER IF EXISTS program_gateway_job_guard ON program_jobs;
DROP TRIGGER IF EXISTS program_gateway_assignment_guard ON program_gateway_assignments;
DROP FUNCTION IF EXISTS guard_legacy_program_device();DROP FUNCTION IF EXISTS guard_program_gateway_job();DROP FUNCTION IF EXISTS guard_program_gateway_assignment();
DROP TABLE IF EXISTS program_gateway_events;
DROP TABLE IF EXISTS program_gateway_assignments;
DROP INDEX IF EXISTS uq_program_gateway_upload_request;
ALTER TABLE program_files DROP CONSTRAINT IF EXISTS program_files_gateway_tenant_fk,DROP COLUMN IF EXISTS gateway_id,DROP COLUMN IF EXISTS provenance,DROP COLUMN IF EXISTS upload_request_key;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_gateway_tenant_fk,
 DROP COLUMN IF EXISTS gateway_id,DROP COLUMN IF EXISTS gateway_token_version,DROP COLUMN IF EXISTS lease_token,
 DROP COLUMN IF EXISTS configuration_version,DROP COLUMN IF EXISTS command_parameters,DROP COLUMN IF EXISTS result_json,
 DROP COLUMN IF EXISTS stage,DROP COLUMN IF EXISTS progress_bytes,DROP COLUMN IF EXISTS progress_total,DROP COLUMN IF EXISTS progress_at;
DROP INDEX IF EXISTS uq_program_gateway_open_machine;DROP INDEX IF EXISTS idx_program_gateway_queue;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_action_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_action_check CHECK(action IN('SEND','FETCH','BACKUP'));
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_program_name_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_program_name_check CHECK(action='BACKUP' OR program_name IS NOT NULL);
DROP TABLE IF EXISTS program_gateways;
DROP INDEX IF EXISTS uq_program_gateway_plant_tenant;
COMMIT;
