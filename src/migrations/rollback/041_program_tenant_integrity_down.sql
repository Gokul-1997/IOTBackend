BEGIN;
ALTER TABLE program_devices DROP CONSTRAINT IF EXISTS program_devices_machine_tenant_fk;
ALTER TABLE program_files DROP CONSTRAINT IF EXISTS program_files_machine_tenant_fk,
  DROP CONSTRAINT IF EXISTS program_files_job_tenant_fk, DROP CONSTRAINT IF EXISTS program_files_device_tenant_fk;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_machine_tenant_fk,
  DROP CONSTRAINT IF EXISTS program_jobs_file_tenant_fk, DROP CONSTRAINT IF EXISTS program_jobs_backup_tenant_fk;
ALTER TABLE program_current DROP CONSTRAINT IF EXISTS program_current_file_tenant_fk;
DROP INDEX IF EXISTS uq_program_devices_tenant_machine;
DROP INDEX IF EXISTS uq_program_files_tenant_machine;
DROP INDEX IF EXISTS uq_program_jobs_tenant_machine;
-- Keep the machines company key: later integrity migrations may reference it.
COMMIT;
