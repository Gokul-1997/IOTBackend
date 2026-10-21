-- Multi-machine gateways, durable controller work, immutable local files.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_gateway_plant_tenant ON plants(company_id,id);
CREATE TABLE IF NOT EXISTS program_gateways(
 id SERIAL PRIMARY KEY,company_id INT NOT NULL REFERENCES companies(id),plant_id INT REFERENCES plants(id),
 name VARCHAR(100) NOT NULL,token_hash CHAR(64) UNIQUE,token_prefix VARCHAR(16),token_version INT NOT NULL DEFAULT 1,
 max_concurrency INT NOT NULL DEFAULT 2 CHECK(max_concurrency BETWEEN 1 AND 16),
 is_active BOOLEAN NOT NULL DEFAULT TRUE,last_seen_at TIMESTAMPTZ,last_seen_ip VARCHAR(45),agent_version VARCHAR(50),
 created_by INT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(company_id,id),FOREIGN KEY(company_id,plant_id) REFERENCES plants(company_id,id));
CREATE TABLE IF NOT EXISTS program_gateway_assignments(
 company_id INT NOT NULL,machine_id INT PRIMARY KEY,gateway_id INT NOT NULL,
 controller_key VARCHAR(100) NOT NULL,protocol VARCHAR(12) NOT NULL CHECK(protocol IN('embedded','ftp','ftps','sftp','focas','smb')),
 program_path VARCHAR(255) NOT NULL,configuration_version INT NOT NULL DEFAULT 1,
 capabilities JSONB NOT NULL DEFAULT '{}',limitations JSONB NOT NULL DEFAULT '[]',current_program VARCHAR(255),
 controller_status VARCHAR(40),reported_at TIMESTAMPTZ,updated_by INT REFERENCES users(id),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id),
 FOREIGN KEY(company_id,gateway_id) REFERENCES program_gateways(company_id,id),UNIQUE(company_id,machine_id,gateway_id),UNIQUE(gateway_id,controller_key));
CREATE INDEX IF NOT EXISTS idx_program_gateway_assignments_gateway ON program_gateway_assignments(gateway_id,machine_id);
ALTER TABLE program_jobs ADD COLUMN IF NOT EXISTS gateway_id INT,
 ADD COLUMN IF NOT EXISTS gateway_token_version INT,ADD COLUMN IF NOT EXISTS lease_token CHAR(64),
 ADD COLUMN IF NOT EXISTS configuration_version INT,ADD COLUMN IF NOT EXISTS command_parameters JSONB NOT NULL DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS result_json JSONB,ADD COLUMN IF NOT EXISTS stage VARCHAR(40),
 ADD COLUMN IF NOT EXISTS progress_bytes BIGINT NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS progress_total BIGINT,
 ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ;
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_action_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_action_check CHECK(action IN('SEND','FETCH','BACKUP','RESTORE','LIST'));
ALTER TABLE program_jobs DROP CONSTRAINT IF EXISTS program_jobs_program_name_check;
ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_program_name_check CHECK(action IN('BACKUP','LIST') OR program_name IS NOT NULL);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_jobs_gateway_tenant_fk') THEN
  ALTER TABLE program_jobs ADD CONSTRAINT program_jobs_gateway_tenant_fk FOREIGN KEY(company_id,gateway_id) REFERENCES program_gateways(company_id,id);
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_gateway_open_machine ON program_jobs(machine_id)
 WHERE protocol_version=3 AND status IN('QUEUED','DELIVERED');
CREATE INDEX IF NOT EXISTS idx_program_gateway_queue ON program_jobs(gateway_id,requested_at,id)
 WHERE protocol_version=3 AND status IN('QUEUED','DELIVERED');
ALTER TABLE program_files ADD COLUMN IF NOT EXISTS gateway_id INT,
 ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS upload_request_key VARCHAR(80);
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_gateway_upload_request
 ON program_files(company_id,machine_id,uploaded_by,upload_request_key) WHERE upload_request_key IS NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='program_files_gateway_tenant_fk') THEN
  ALTER TABLE program_files ADD CONSTRAINT program_files_gateway_tenant_fk FOREIGN KEY(company_id,gateway_id) REFERENCES program_gateways(company_id,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS program_gateway_events(
 id BIGSERIAL PRIMARY KEY,company_id INT NOT NULL REFERENCES companies(id),gateway_id INT,
 machine_id INT,job_id BIGINT,file_id BIGINT,actor_id INT REFERENCES users(id),action VARCHAR(60) NOT NULL,
 details JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(company_id,gateway_id) REFERENCES program_gateways(company_id,id),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id),
 FOREIGN KEY(company_id,machine_id,job_id) REFERENCES program_jobs(company_id,machine_id,id),
 FOREIGN KEY(company_id,machine_id,file_id) REFERENCES program_files(company_id,machine_id,id));
CREATE INDEX IF NOT EXISTS idx_program_gateway_events_company ON program_gateway_events(company_id,created_at DESC,id DESC);

-- Protect against an older API/agent process writing a newly assigned machine.
CREATE OR REPLACE FUNCTION guard_program_gateway_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE machine INT; tenant INT; gateway_plant INT; machine_plant INT;
BEGIN
 machine:=CASE WHEN TG_OP='DELETE' THEN OLD.machine_id ELSE NEW.machine_id END;
 SELECT company_id,plant_id INTO tenant,machine_plant FROM machines WHERE id=machine FOR UPDATE;
 PERFORM pg_advisory_xact_lock(61427,machine);
 IF EXISTS(SELECT 1 FROM program_jobs WHERE machine_id=machine AND status IN('QUEUED','DELIVERED')) THEN
  RAISE EXCEPTION 'Finish or reconcile the open controller operation before changing gateway assignment' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF tenant IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'Machine company mismatch' USING ERRCODE='23514'; END IF;
 SELECT plant_id INTO gateway_plant FROM program_gateways WHERE id=NEW.gateway_id AND company_id=NEW.company_id AND is_active=TRUE;
 IF NOT FOUND OR (gateway_plant IS NOT NULL AND gateway_plant IS DISTINCT FROM machine_plant) THEN
  RAISE EXCEPTION 'Gateway must belong to this company and plant' USING ERRCODE='23514'; END IF;
 UPDATE program_devices SET revoked_at=NOW(),revoked_by=NEW.updated_by WHERE machine_id=NEW.machine_id AND revoked_at IS NULL;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS program_gateway_assignment_guard ON program_gateway_assignments;
CREATE TRIGGER program_gateway_assignment_guard BEFORE INSERT OR UPDATE OF gateway_id,controller_key,protocol,program_path,configuration_version OR DELETE
 ON program_gateway_assignments FOR EACH ROW EXECUTE FUNCTION guard_program_gateway_assignment();
CREATE OR REPLACE FUNCTION guard_program_gateway_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assignment program_gateway_assignments%ROWTYPE;
BEGIN
 PERFORM 1 FROM machines WHERE id=NEW.machine_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(61427,NEW.machine_id);
 SELECT * INTO assignment FROM program_gateway_assignments WHERE machine_id=NEW.machine_id;
 IF NEW.protocol_version<3 AND FOUND THEN RAISE EXCEPTION 'Machine uses an assigned gateway; use Program Transfer v3' USING ERRCODE='23514'; END IF;
 IF NEW.protocol_version=3 AND (assignment.machine_id IS NULL OR assignment.company_id IS DISTINCT FROM NEW.company_id
   OR assignment.gateway_id IS DISTINCT FROM NEW.gateway_id OR assignment.configuration_version IS DISTINCT FROM NEW.configuration_version) THEN
  RAISE EXCEPTION 'Gateway assignment changed; reload the machine configuration' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS program_gateway_job_guard ON program_jobs;
CREATE TRIGGER program_gateway_job_guard BEFORE INSERT ON program_jobs FOR EACH ROW EXECUTE FUNCTION guard_program_gateway_job();
CREATE OR REPLACE FUNCTION guard_legacy_program_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM machines WHERE id=NEW.machine_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(61427,NEW.machine_id);
 IF NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM program_gateway_assignments WHERE machine_id=NEW.machine_id) THEN
  RAISE EXCEPTION 'Machine uses a gateway token; legacy device tokens are disabled' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS legacy_program_device_gateway_guard ON program_devices;
CREATE TRIGGER legacy_program_device_gateway_guard BEFORE INSERT OR UPDATE OF revoked_at ON program_devices
 FOR EACH ROW EXECUTE FUNCTION guard_legacy_program_device();
COMMIT;
