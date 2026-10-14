-- Tenant ownership is enforced even when a caller misses an application predicate.
-- Existing invalid references fail validation; no customer rows are changed/deleted.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_machines_company_id ON machines(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_devices_tenant_machine ON program_devices(company_id,machine_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_files_tenant_machine ON program_files(company_id,machine_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_jobs_tenant_machine ON program_jobs(company_id,machine_id,id);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_devices_machine_tenant_fk' AND conrelid='program_devices'::regclass) THEN
    ALTER TABLE program_devices ADD CONSTRAINT program_devices_machine_tenant_fk FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_files_machine_tenant_fk' AND conrelid='program_files'::regclass) THEN
    ALTER TABLE program_files ADD CONSTRAINT program_files_machine_tenant_fk FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_jobs_machine_tenant_fk' AND conrelid='program_jobs'::regclass) THEN
    ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_machine_tenant_fk FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_current_file_tenant_fk' AND conrelid='program_current'::regclass) THEN
    ALTER TABLE program_current ADD CONSTRAINT program_current_file_tenant_fk FOREIGN KEY(company_id,machine_id,file_id) REFERENCES program_files(company_id,machine_id,id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_jobs_file_tenant_fk' AND conrelid='program_jobs'::regclass) THEN
    ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_file_tenant_fk FOREIGN KEY(company_id,machine_id,file_id) REFERENCES program_files(company_id,machine_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_jobs_backup_tenant_fk' AND conrelid='program_jobs'::regclass) THEN
    ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_backup_tenant_fk FOREIGN KEY(company_id,machine_id,backup_file_id) REFERENCES program_files(company_id,machine_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_files_job_tenant_fk' AND conrelid='program_files'::regclass) THEN
    ALTER TABLE program_files ADD CONSTRAINT program_files_job_tenant_fk FOREIGN KEY(company_id,machine_id,job_id) REFERENCES program_jobs(company_id,machine_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_files_device_tenant_fk' AND conrelid='program_files'::regclass) THEN
    ALTER TABLE program_files ADD CONSTRAINT program_files_device_tenant_fk FOREIGN KEY(company_id,machine_id,device_id) REFERENCES program_devices(company_id,machine_id,id) NOT VALID;
  END IF;
END $$;
ALTER TABLE program_devices VALIDATE CONSTRAINT program_devices_machine_tenant_fk;
ALTER TABLE program_files VALIDATE CONSTRAINT program_files_machine_tenant_fk;
ALTER TABLE program_jobs VALIDATE CONSTRAINT program_jobs_machine_tenant_fk;
ALTER TABLE program_current VALIDATE CONSTRAINT program_current_file_tenant_fk;
ALTER TABLE program_jobs VALIDATE CONSTRAINT program_jobs_file_tenant_fk;
ALTER TABLE program_jobs VALIDATE CONSTRAINT program_jobs_backup_tenant_fk;
ALTER TABLE program_files VALIDATE CONSTRAINT program_files_job_tenant_fk;
ALTER TABLE program_files VALIDATE CONSTRAINT program_files_device_tenant_fk;
COMMIT;
