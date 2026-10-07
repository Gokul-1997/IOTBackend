-- History for the multi-company test: 14 days of hourly production, the last
-- 6 hours of 1 Hz telemetry, and alarms, for every machine of the companies in
-- :companies (e.g. psql -v companies='11,12,13'). Local test databases only.
\timing on
SET statement_timeout = 0;

-- hourly production on IST hours, each hour in the shift that covers it
INSERT INTO production_hourly (company_id, machine_id, shift_id, hour_start, run_seconds, idle_seconds, manual_seconds, produced_qty, energy_kwh)
SELECT m.company_id, m.id,
       (SELECT s.id FROM shifts s WHERE s.company_id = m.company_id AND s.is_active
          AND ((s.start_time < s.end_time AND (h AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time AND (h AT TIME ZONE 'Asia/Kolkata')::time < s.end_time)
            OR (s.start_time > s.end_time AND ((h AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time OR (h AT TIME ZONE 'Asia/Kolkata')::time < s.end_time)))
        ORDER BY s.id LIMIT 1),
       h,
       CASE WHEN (extract(hour FROM h)::int + m.id) % 7 = 0 THEN 0 ELSE 2400 + (m.id * 37) % 900 END,
       CASE WHEN (extract(hour FROM h)::int + m.id) % 7 = 0 THEN 3600 ELSE 1200 - (m.id * 37) % 900 END,
       0,
       CASE WHEN (extract(hour FROM h)::int + m.id) % 7 = 0 THEN 0 ELSE 40 + m.id % 15 END,
       4.5 + (m.id % 5)
  FROM machines m
  CROSS JOIN generate_series(date_trunc('hour', now()) - interval '14 days' - interval '30 minutes',
                             date_trunc('hour', now()) - interval '90 minutes', interval '1 hour') h
 WHERE m.company_id = ANY (string_to_array(:'companies', ',')::int[])
ON CONFLICT DO NOTHING;

-- the last 6 hours, one reading a second per machine
INSERT INTO telemetry_raw (company_id, plant_id, machine_id, machine_status, alarm, status, parts_count,
       spindle_load, feed_rate, cutting_speed, device_time, mode, received_at, spindle_speed,
       spindle_motor_temp, servo_load_x, servo_load_y, servo_load_z, servo_temp_x, servo_temp_y, servo_temp_z)
SELECT m.company_id, NULL, m.id,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 'IDLE' ELSE 'RUNNING' END,
       (alarm_hour AND (s % 60) >= 50),
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 1 ELSE 3 END,
       10000 + (s / 60)::int,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 2 ELSE 30 + (m.id * 7 + s) % 50 END,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 0 ELSE 800 + (m.id * 13 + s) % 700 END,
       180, s, 'AUTO', ts,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 0 ELSE 2000 + (m.id * 11) % 3000 END,
       38 + (m.id % 9), 10 + (s % 30), 5 + (s % 20), 20 + (s % 25), 30 + (m.id % 6), 31, 33
  FROM machines m
  CROSS JOIN LATERAL (
    SELECT ts, extract(epoch FROM ts)::bigint AS s,
           ((extract(hour FROM ts)::int + m.id) % 7 = 0) AS idle_hour,
           ((extract(hour FROM ts)::int + m.id) % 23 = 0) AS alarm_hour
      FROM generate_series(date_trunc('minute', now()) - interval '6 hours', date_trunc('minute', now()) - interval '1 minute', interval '1 second') ts
  ) g
 WHERE m.company_id = ANY (string_to_array(:'companies', ',')::int[]);

-- a few alarms per machine over the two weeks
INSERT INTO machine_alarms (machine_id, company_id, alarm_type, alarm_code, message, severity, started_at, ended_at, is_resolved)
SELECT m.id, m.company_id, (ARRAY['SERVO','SPINDLE','COOLANT','DOOR'])[1 + (k % 4)],
       format('%s-%s', left(split_part(m.machine_serial_no, '-', 1), 3), 400 + k), format('alarm %s on %s', k, m.machine_serial_no),
       (ARRAY['LOW','MEDIUM','HIGH','CRITICAL'])[1 + (k % 4)],
       now() - make_interval(hours => k * 29 + m.id % 7), now() - make_interval(hours => k * 29 + m.id % 7) + interval '9 minutes', true
  FROM machines m CROSS JOIN generate_series(1, 10) k
 WHERE m.company_id = ANY (string_to_array(:'companies', ',')::int[]);

ANALYZE telemetry_raw; ANALYZE production_hourly; ANALYZE machine_alarms;
