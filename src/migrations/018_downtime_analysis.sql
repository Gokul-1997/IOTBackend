-- 018 — Screen 6: Downtime Reason Loss Analysis.
--
-- downtime_events already exists from 007 with machine, shift, reason and a
-- start/end. The screen additionally reports a sub-reason, the operator who
-- was on the machine, and whether the downtime is still running — so those
-- are what this adds.
--
-- Status is deliberately NOT a column. An event is open exactly when
-- ended_at IS NULL, and storing that separately creates a second source of
-- truth that drifts the first time something closes an event without
-- updating the flag.
--
-- Operator is stored on the event rather than looked up at read time.
-- operator_machine_assignments changes as people move between machines, so
-- deriving it later would re-attribute last month's downtime to whoever is
-- standing there now.

BEGIN;

ALTER TABLE downtime_events
  ADD COLUMN IF NOT EXISTS sub_reason  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS operator_id INT REFERENCES operators(id) ON DELETE SET NULL;

COMMENT ON COLUMN downtime_events.sub_reason IS
  'Free-text detail under the reason code, e.g. reason "Machine Breakdown", sub-reason "Spindle bearing".';
COMMENT ON COLUMN downtime_events.operator_id IS
  'The operator on the machine when this downtime started, captured at entry. Not derived from current assignments — those change, and last month''s downtime must not be re-attributed.';

/* Every query on this screen is "this company, this date range", and the
   detail list pages through it. Without a matching index each page scans
   the whole table. */
CREATE INDEX IF NOT EXISTS idx_downtime_company_started
  ON downtime_events (company_id, started_at DESC);

/* The Pareto and the reason summary both group by reason inside a window. */
CREATE INDEX IF NOT EXISTS idx_downtime_reason
  ON downtime_events (company_id, downtime_reason_id, started_at DESC);

/* "What is down right now?" for the live tiles, kept small because open
   events are a tiny fraction of history. */
CREATE INDEX IF NOT EXISTS idx_downtime_open
  ON downtime_events (company_id, machine_id)
  WHERE ended_at IS NULL;

/*
 * One open downtime event per machine.
 *
 * An operator entering a reason while an earlier event is still open would
 * otherwise leave two running at once, and every duration afterwards is
 * double-counted. The index makes that impossible rather than relying on
 * the entry form to check.
 */
CREATE UNIQUE INDEX IF NOT EXISTS uq_downtime_open_per_machine
  ON downtime_events (machine_id)
  WHERE ended_at IS NULL;

COMMIT;
