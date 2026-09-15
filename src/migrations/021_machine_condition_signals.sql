-- 021 — machine condition signals from the FOCAS collector
--
-- Phase 2 Screen 2 (Maintenance) specifies gauges for servo load per axis,
-- temperatures, batteries, insulation resistance and cooling fans. Until now
-- nothing could store them, so the screen listed them as "not collected".
--
-- The embedded team's sample payload shows which the controller can actually
-- supply today (servo load X/Y/Z, servo motor temperature X/Y/Z, spindle
-- motor temperature, spindle speed, servo pulse diagnostic) and which come
-- back null on this controller (batteries, encoder temperatures, insulation
-- resistance, all ten fans). Both sets get columns: a signal that is null
-- today lands the moment the firmware or the controller starts supplying it,
-- with no further migration.
--
-- Per-axis signals are separate nullable columns rather than one JSONB
-- because they are read individually and, on some machines, only one axis
-- reports at all — a per-axis null has to stay distinguishable from zero.
-- A 0 °C servo is a very different claim from a servo with no sensor.

BEGIN;

-- telemetry_raw takes an insert every second from every machine. ADD COLUMN
-- with no default is metadata-only here (compression is off), but it still
-- needs an exclusive lock on the hypertable and its chunks. Without a timeout
-- that lock request would queue behind in-flight inserts, and every insert
-- after it would queue behind the lock — stalling ingestion for the whole
-- plant. Five seconds, then fail cleanly and retry later.
SET LOCAL lock_timeout = '5s';

-- ── telemetry_raw: the time-varying signals ────────────────────────────
-- All nullable. Postgres stores absent values in the row's null bitmap, so
-- the columns that stay empty cost a couple of bytes per row, not a value.

ALTER TABLE telemetry_raw
  -- spindle
  ADD COLUMN IF NOT EXISTS spindle_speed            INTEGER,
  ADD COLUMN IF NOT EXISTS spindle_motor_temp       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS spindle_insulation_res   DOUBLE PRECISION,

  -- servo load per axis, percent
  ADD COLUMN IF NOT EXISTS servo_load_x             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_load_y             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_load_z             DOUBLE PRECISION,

  -- servo motor temperature per axis, celsius
  ADD COLUMN IF NOT EXISTS servo_temp_x             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_temp_y             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_temp_z             DOUBLE PRECISION,

  -- encoder temperature per axis, celsius (empty on the sampled controller)
  ADD COLUMN IF NOT EXISTS encoder_temp_x           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS encoder_temp_y           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS encoder_temp_z           DOUBLE PRECISION,

  -- servo motor insulation resistance per axis
  ADD COLUMN IF NOT EXISTS servo_insulation_res_x   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_insulation_res_y   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_insulation_res_z   DOUBLE PRECISION,

  -- servo pulse diagnostic per axis (FOCAS DGN 403)
  ADD COLUMN IF NOT EXISTS servo_pulse_x            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_pulse_y            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS servo_pulse_z            DOUBLE PRECISION,

  -- batteries, volts
  ADD COLUMN IF NOT EXISTS cnc_battery_voltage      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS apc_battery_voltage      DOUBLE PRECISION,

  -- where the controller is in the running program
  ADD COLUMN IF NOT EXISTS sequence_number          INTEGER,

  -- Ten named fans whose set differs by controller, so one JSONB rather
  -- than ten columns. Written only when at least one fan reports, so it is
  -- NULL — not an object of ten nulls — on controllers that have none.
  ADD COLUMN IF NOT EXISTS fan_status               JSONB,

  -- Axes beyond X/Y/Z on 4- and 5-axis machines. Same rule: NULL unless
  -- the controller actually reports one, so nothing is silently dropped
  -- for a machine wider than the three columns above.
  ADD COLUMN IF NOT EXISTS extra_axes               JSONB;

COMMENT ON COLUMN telemetry_raw.fan_status IS
  'Cooling fan states keyed by fan name, e.g. {"radiator_fan1_servo_spindle_amplifier": 1}. NULL when the controller reports no fan at all.';
COMMENT ON COLUMN telemetry_raw.extra_axes IS
  'Per-axis signals for axes beyond X/Y/Z, e.g. {"A": {"servo_load": 12}}. NULL on 3-axis machines.';

-- ── machines: identity the controller reports, which never varies ──────
-- These arrive on every telemetry message but describe the machine, not the
-- moment, so they belong here rather than on 450,000 rows a day.

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS controller_ip        VARCHAR(45),
  ADD COLUMN IF NOT EXISTS cnc_series           VARCHAR(32),
  ADD COLUMN IF NOT EXISTS cnc_version          VARCHAR(32),
  ADD COLUMN IF NOT EXISTS cnc_type             VARCHAR(16),
  ADD COLUMN IF NOT EXISTS cnc_machine_type     VARCHAR(16),
  ADD COLUMN IF NOT EXISTS controlled_axes      SMALLINT,
  ADD COLUMN IF NOT EXISTS controller_seen_at   TIMESTAMPTZ,
  -- The collector's per-call FOCAS return codes. Stable per machine, and the
  -- only way to tell "this controller has no Y-axis temperature sensor" from
  -- "the collector's read for Y failed" when a servo reports null.
  ADD COLUMN IF NOT EXISTS focas_result         JSONB;

COMMENT ON COLUMN machines.controller_seen_at IS
  'When the controller last reported its own identity, so a silently swapped controller is visible.';

COMMIT;
