-- 038 — the collector's database user may do only what the collector does
--
-- The MQTT collector (pms-backend) connects as machine_api_user. Checked on
-- production on 6 Oct 2026, that user could also INSERT into users, roles,
-- role_permissions, user_roles, permissions, user_sessions and
-- password_reset_tokens — so anyone holding the collector's password (it
-- sits in a .env on the ingestion server) could create an administrator.
--
-- What the collector actually touches (every query in pms-backend):
--   telemetry_raw            INSERT, SELECT
--   production_hourly        INSERT, SELECT, UPDATE   (hourly totals upsert)
--   machine_alarms           INSERT, SELECT, UPDATE
--   energy_meter_readings    INSERT, SELECT
--   machines                 SELECT, and UPDATE of the controller identity
--                            columns only (controller-identity.js; it was
--                            switched off for want of this grant since 15 Sep)
--   shifts                   SELECT
--   ingest_checkpoint, telemetry_late   (035)
-- Everything else is revoked. Only where the role exists (other deployments
-- may name it differently). Rollback: rollback/038_collector_least_privilege_down.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN
    RAISE NOTICE 'machine_api_user does not exist here — nothing to change';
    RETURN;
  END IF;

  REVOKE ALL ON users, roles, permissions, role_permissions, user_roles, user_sessions,
               password_reset_tokens, operators, plants, quality_entries,
               operator_machine_assignments, operator_shift_assignments, machine_shift_config,
               oee_hourly, oee_shift_summary, machine_current_job
    FROM machine_api_user;
  REVOKE INSERT, UPDATE ON shifts FROM machine_api_user;
  REVOKE INSERT ON machines FROM machine_api_user;
  REVOKE ALL ON SEQUENCE users_id_seq, roles_id_seq, permissions_id_seq, user_sessions_id_seq,
               password_reset_tokens_id_seq, operators_id_seq, plants_id_seq, machines_id_seq,
               shifts_id_seq, quality_entries_id_seq, operator_machine_assignments_id_seq,
               operator_shift_assignments_id_seq, machine_current_job_id_seq
    FROM machine_api_user;

  GRANT UPDATE (controller_ip, cnc_series, cnc_version, cnc_type, cnc_machine_type,
                controlled_axes, focas_result, controller_seen_at)
    ON machines TO machine_api_user;
END $$;

SELECT '=== Migration 038 complete ===' AS status;
