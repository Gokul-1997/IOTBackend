-- LOADTEST company: 100 machines, three 8-hour shifts (one across midnight),
-- a component with a 60 s cycle on every machine. Staging only.
BEGIN;
INSERT INTO companies (id, company_code, company_name, is_active) VALUES (900, 'LT', 'LOADTEST Industries', true)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO shifts (shift_code, shift_name, start_time, end_time, break_minutes, is_active, company_id) VALUES
  ('A', 'Shift A', '06:00', '14:00', 30, true, 900),
  ('B', 'Shift B', '14:00', '22:00', 30, true, 900),
  ('C', 'Shift C', '22:00', '06:00', 30, true, 900);
INSERT INTO machines (api_key, is_active, machine_serial_no, model, controller, company_id, plant_id, hour_rate)
SELECT format('lt-api-%s', lpad(i::text, 4, '0')), true, format('LT-%s', lpad(i::text, 3, '0')), 'VL850', 'FANUC', 900, NULL, 400
  FROM generate_series(1, 100) i;
INSERT INTO components (machine_id, part_name, part_number, target, multiplication_factor, cycle_time_seconds, cycle_time, company_id)
SELECT m.id, 'HOUSING_OP10', 'P-' || m.id, 400, 1, 60, interval '60 seconds', 900 FROM machines m WHERE m.company_id = 900;
INSERT INTO machine_current_job (machine_id, part_name, component_id, target_qty, achieved_qty, started_at, is_active, company_id)
SELECT c.machine_id, c.part_name, c.id, 400, 0, now() - interval '30 days', true, 900 FROM components c WHERE c.company_id = 900;
INSERT INTO users (username, email, password_hash, is_active, company_id, user_type)
VALUES ('lt_admin', 'lt_admin@loadtest.local', '$2a$10$abcdefghijklmnopqrstuuJ3QpS7c1Y8m2l9c1QnV5WcYxk9kq3XG', true, 900, 'COMPANY_ADMIN');
COMMIT;
