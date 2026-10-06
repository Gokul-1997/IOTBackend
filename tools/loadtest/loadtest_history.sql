-- 24 hours of 1 Hz telemetry for the 100 LOADTEST machines (8.64 M rows),
-- and 30 days of hourly production. Staging only.
\timing on
SET statement_timeout = 0;
INSERT INTO telemetry_raw (company_id, plant_id, machine_id, machine_status, alarm, status, parts_count,
       spindle_load, feed_rate, cutting_speed, device_time, mode, received_at, spindle_speed,
       spindle_motor_temp, servo_load_x, servo_load_y, servo_load_z, servo_temp_x, servo_temp_y, servo_temp_z)
SELECT 900, NULL, m.id,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 'IDLE' ELSE 'RUNNING' END,
       (alarm_hour AND (s % 60) >= 50),
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 1 ELSE 3 END,
       10000 + (s / 60)::int,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 2 ELSE 30 + (m.id * 7 + s) % 50 END,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 0 ELSE 800 + (m.id * 13 + s) % 700 END,
       180, extract(epoch FROM ts)::bigint, 'AUTO', ts,
       CASE WHEN idle_hour OR (s % 60) >= 50 THEN 0 ELSE 2000 + (m.id * 11) % 3000 END,
       38 + (m.id % 9), 10 + (s % 30), 5 + (s % 20), 20 + (s % 25), 30 + (m.id % 6), 31, 33
  FROM machines m
  CROSS JOIN LATERAL (
    SELECT ts, extract(epoch FROM ts)::bigint AS s,
           ((extract(hour FROM ts)::int + m.id) % 7 = 0) AS idle_hour,
           ((extract(hour FROM ts)::int + m.id) % 23 = 0) AS alarm_hour
      FROM generate_series(date_trunc('minute', now()) - interval '24 hours', date_trunc('minute', now()) - interval '1 second', interval '1 second') ts
  ) g
 WHERE m.company_id = 900;

INSERT INTO production_hourly (company_id, machine_id, shift_id, hour_start, run_seconds, idle_seconds, manual_seconds, produced_qty, energy_kwh)
SELECT 900, m.id,
       CASE WHEN extract(hour FROM h AT TIME ZONE 'Asia/Kolkata') >= 6 AND extract(hour FROM h AT TIME ZONE 'Asia/Kolkata') < 14 THEN 20
            WHEN extract(hour FROM h AT TIME ZONE 'Asia/Kolkata') >= 14 AND extract(hour FROM h AT TIME ZONE 'Asia/Kolkata') < 22 THEN 21 ELSE 22 END,
       h,
       CASE WHEN (extract(hour FROM h)::int + m.id) % 7 = 0 THEN 0 ELSE 3000 END,
       CASE WHEN (extract(hour FROM h)::int + m.id) % 7 = 0 THEN 3600 ELSE 600 END,
       0,
       CASE WHEN (extract(hour FROM h)::int + m.id) % 7 = 0 THEN 0 ELSE 60 END,
       4.5 + (m.id % 5)
  FROM machines m
  CROSS JOIN generate_series(date_trunc('hour', now()) - interval '30 days', date_trunc('hour', now()) - interval '1 hour', interval '1 hour') h
 WHERE m.company_id = 900
ON CONFLICT DO NOTHING;
ANALYZE telemetry_raw; ANALYZE production_hourly;
