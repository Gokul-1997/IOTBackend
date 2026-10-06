-- Undo 038: give machine_api_user back exactly what it had on 6 Oct 2026.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN RETURN; END IF;
  GRANT INSERT ON users, roles, permissions, role_permissions, user_roles, user_sessions,
               password_reset_tokens, operators, plants, quality_entries,
               operator_machine_assignments, operator_shift_assignments, machine_shift_config,
               oee_hourly, oee_shift_summary
    TO machine_api_user;
  GRANT INSERT, SELECT, UPDATE ON machine_current_job TO machine_api_user;
  GRANT INSERT, UPDATE ON shifts TO machine_api_user;
  GRANT INSERT ON machines TO machine_api_user;
  REVOKE UPDATE (controller_ip, cnc_series, cnc_version, cnc_type, cnc_machine_type,
                 controlled_axes, focas_result, controller_seen_at) ON machines FROM machine_api_user;
  GRANT SELECT, USAGE ON SEQUENCE users_id_seq, roles_id_seq, permissions_id_seq, user_sessions_id_seq,
               password_reset_tokens_id_seq, operators_id_seq, plants_id_seq, machines_id_seq,
               shifts_id_seq, quality_entries_id_seq, operator_machine_assignments_id_seq,
               operator_shift_assignments_id_seq, machine_current_job_id_seq
    TO machine_api_user;
END $$;
DELETE FROM schema_migrations WHERE filename = '038_collector_least_privilege.sql';
