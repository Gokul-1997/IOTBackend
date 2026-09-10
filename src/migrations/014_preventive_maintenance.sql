-- ============================================================
-- 014_preventive_maintenance.sql
-- Phase 2 · Screen 3 — Preventive Maintenance.
--
-- Screen 3 is not a read-only dashboard. Its requirements describe a
-- loop: alarms cross a configured threshold, a PM ticket is raised
-- automatically with a due date, and the dashboard reports on that.
-- Three pieces of that loop had nowhere to live:
--
--   1. tickets had no due_date, but "due date" and "ticket age" are
--      both named in the PM ticket detail requirement
--   2. nothing distinguished a preventive ticket from a breakdown —
--      issue_type was BREAKDOWN / ALARM / INSPECTION / OTHER
--   3. "alarm name, threshold, number of triggers, PM tickets created"
--      needs a rules table; none existed anywhere in the database
--
-- Additive only: no DROP, no DELETE, no UPDATE of existing rows.
-- ============================================================

-- ADD VALUE cannot be used in the same transaction that creates it, so it
-- sits outside the block below. IF NOT EXISTS makes a re-run a no-op.
ALTER TYPE ticket_issue_type ADD VALUE IF NOT EXISTS 'PREVENTIVE';

BEGIN;

-- ── when the work is due ─────────────────────────────────────
-- Nullable: tickets raised before this migration, and any raised by hand
-- without a deadline, legitimately have none. "Ticket age" is derived from
-- created_at, so it keeps working either way.
ALTER TABLE maintenance_tickets
  ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;

COMMENT ON COLUMN maintenance_tickets.due_date IS
  'When the work should be completed. Set from the threshold rule''s due_hours for auto-raised PM tickets; NULL when a ticket was raised by hand.';

CREATE INDEX IF NOT EXISTS idx_tickets_due
  ON maintenance_tickets(company_id, due_date)
  WHERE due_date IS NOT NULL;

-- ── the rules that raise PM tickets ──────────────────────────
-- "this alarm, this many times, in this window, on this machine" → raise a
-- PM ticket at this priority, due in this many hours.
CREATE TABLE IF NOT EXISTS alarm_thresholds (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- NULL machine_id means the rule covers every machine in the company;
  -- a machine-specific rule overrides it for that machine.
  machine_id      INTEGER REFERENCES machines(id) ON DELETE CASCADE,

  alarm_type      VARCHAR(100) NOT NULL,
  threshold_count INTEGER NOT NULL DEFAULT 3,
  window_hours    INTEGER NOT NULL DEFAULT 24,
  due_hours       INTEGER NOT NULL DEFAULT 48,
  priority        ticket_priority NOT NULL DEFAULT 'MEDIUM',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE alarm_thresholds
  DROP CONSTRAINT IF EXISTS alarm_thresholds_positive_check;
ALTER TABLE alarm_thresholds
  ADD CONSTRAINT alarm_thresholds_positive_check
  CHECK (threshold_count > 0 AND window_hours > 0 AND due_hours > 0);

-- Two partial indexes rather than one UNIQUE: Postgres treats NULLs as
-- distinct, so a plain UNIQUE(company_id, machine_id, alarm_type) would
-- happily allow several company-wide rules for the same alarm.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alarm_threshold_machine
  ON alarm_thresholds(company_id, machine_id, alarm_type)
  WHERE machine_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_alarm_threshold_company
  ON alarm_thresholds(company_id, alarm_type)
  WHERE machine_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_alarm_thresholds_lookup
  ON alarm_thresholds(company_id, alarm_type) WHERE is_active;

-- ── which rule raised which ticket ───────────────────────────
-- Needed for "PM tickets created" per rule in the alarm trigger summary.
-- ON DELETE SET NULL: the ticket is the durable record; deleting a rule
-- later must not cascade away its history.
ALTER TABLE maintenance_tickets
  ADD COLUMN IF NOT EXISTS threshold_id INTEGER
    REFERENCES alarm_thresholds(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_threshold
  ON maintenance_tickets(threshold_id) WHERE threshold_id IS NOT NULL;

-- Lets the engine ask "is there already an open PM ticket for this rule on
-- this machine?" without scanning, which is what keeps it idempotent.
CREATE INDEX IF NOT EXISTS idx_tickets_pm_open
  ON maintenance_tickets(company_id, machine_id, threshold_id, status)
  WHERE threshold_id IS NOT NULL;

-- Alarm counting per machine/type/window is the engine's hot path.
CREATE INDEX IF NOT EXISTS idx_alarms_type_window
  ON machine_alarms(company_id, machine_id, alarm_type, started_at DESC);

COMMIT;

SELECT '=== Migration 014 complete ===' AS status;
