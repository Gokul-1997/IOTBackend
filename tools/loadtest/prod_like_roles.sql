-- production's collector role and grants as found on 6 Oct 2026 (before 035/038)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machine_api_user') THEN CREATE ROLE machine_api_user LOGIN PASSWORD 'staging-only'; END IF; END $$;
GRANT USAGE ON SCHEMA public TO machine_api_user;
GRANT INSERT, SELECT ON telemetry_raw, energy_meter_readings TO machine_api_user;
GRANT INSERT, SELECT, UPDATE ON machine_alarms, machine_current_job, production_hourly, shifts TO machine_api_user;
GRANT INSERT, SELECT ON machines TO machine_api_user;
GRANT INSERT ON users, roles, permissions, role_permissions, user_roles, user_sessions, password_reset_tokens, operators, plants, quality_entries, operator_machine_assignments, operator_shift_assignments, machine_shift_config, oee_hourly, oee_shift_summary TO machine_api_user;
GRANT SELECT, USAGE ON SEQUENCE telemetry_raw_id_seq, users_id_seq, roles_id_seq, permissions_id_seq, user_sessions_id_seq, password_reset_tokens_id_seq, operators_id_seq, plants_id_seq, machines_id_seq, shifts_id_seq, quality_entries_id_seq, operator_machine_assignments_id_seq, operator_shift_assignments_id_seq, machine_current_job_id_seq TO machine_api_user;
GRANT USAGE ON SEQUENCE machine_alarms_id_seq TO machine_api_user;
