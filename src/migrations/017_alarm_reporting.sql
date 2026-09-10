-- 017 — Screen 5: Alarm Dashboard & Reports.
--
-- machine_alarms exists but has never held a row, and it is missing two
-- things the screen is specified to filter and group by: the alarm code the
-- controller reports, and which shift the alarm belongs to.
--
-- Shift is stored rather than derived. Deriving it at read time means
-- re-running the shift-window logic — including the overnight case where a
-- shift starts before midnight and ends after — for every alarm on every
-- query, and it silently rewrites history when someone edits a shift's
-- hours. The shift an alarm happened in is a fact about the past.
--
-- Also adds ended_at, which is not the same as resolved_at. An alarm ends
-- when the machine stops reporting it; it is resolved when a person says
-- they have dealt with it. Collapsing the two makes "how long was this
-- machine alarming?" unanswerable, because it would measure how long
-- someone took to click a button.

BEGIN;

ALTER TABLE machine_alarms
  ADD COLUMN IF NOT EXISTS alarm_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS shift_id   INT REFERENCES shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ended_at   TIMESTAMPTZ;

COMMENT ON COLUMN machine_alarms.alarm_code IS
  'The code the controller reported, e.g. "SV0401". alarm_type is the human name.';
COMMENT ON COLUMN machine_alarms.shift_id IS
  'The shift this alarm started in, resolved once at ingest. Not derived at read time — editing a shift''s hours must not rewrite last month''s alarm report.';
COMMENT ON COLUMN machine_alarms.ended_at IS
  'When the machine stopped reporting the alarm. resolved_at is when a person acknowledged it; the two are different questions and alarm duration is measured against this one.';

/* The dashboard's every query starts "this company, this date range", and
   the list pages through it. Without a matching index each page scans the
   whole table, which is fine at zero rows and not at a year of them. */
CREATE INDEX IF NOT EXISTS idx_alarms_company_started
  ON machine_alarms (company_id, started_at DESC);

/* "Which alarms are still open?" is asked by the KPI tiles and by the
   notification job, and open alarms are a small fraction of the table —
   so a partial index stays small however much history accumulates. */
CREATE INDEX IF NOT EXISTS idx_alarms_open
  ON machine_alarms (company_id, started_at DESC)
  WHERE ended_at IS NULL;

/* Distribution by shift and by machine are both group-bys over the same
   window. */
CREATE INDEX IF NOT EXISTS idx_alarms_shift
  ON machine_alarms (company_id, shift_id, started_at DESC)
  WHERE shift_id IS NOT NULL;

/*
 * One open alarm per machine per code.
 *
 * The collector opens a row when a machine starts alarming and closes it
 * when the alarm clears. Telemetry arrives every second or so, and the
 * broker replays messages after a restart, so "is this alarm already open?"
 * gets asked concurrently by several pm2 instances. Without this, a machine
 * alarming for an hour produces thousands of rows and every count on the
 * screen is meaningless.
 */
CREATE UNIQUE INDEX IF NOT EXISTS uq_alarm_open_per_machine_code
  ON machine_alarms (machine_id, COALESCE(alarm_code, alarm_type))
  WHERE ended_at IS NULL;

COMMIT;
