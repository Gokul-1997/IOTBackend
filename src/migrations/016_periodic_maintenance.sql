-- 016 — Screen 4: Periodic Maintenance.
--
-- Screen 3 (Preventive) is condition-based: alarms cross a threshold and a
-- ticket is raised. This is the other half — time-based work that is due
-- because the calendar says so, whether or not anything has gone wrong.
-- Greasing, filter changes, calibration, the annual service.
--
-- maintenance_schedules already exists from 007 but has never held a row,
-- and its `recurrence` is free text defaulting to 'NONE'. Free text cannot
-- drive a scheduler: "monthly", "Monthly", "1 month" and "30 days" all mean
-- the same thing to a person and nothing to a query. This replaces it with
-- a real frequency and the two dates a recurring schedule needs — when it
-- is next due, and how far it has already been generated.
--
-- Extending that table rather than adding another: it is empty, it already
-- carries company/machine/title/type and is already wired to
-- maintenance_logs by FK. A parallel table would leave two answers to
-- "what maintenance is planned for this machine".

/* Enum values cannot be added inside a transaction that later uses them,
   so these run first and on their own. IF NOT EXISTS makes the migration
   safe to re-run. */
ALTER TYPE ticket_issue_type ADD VALUE IF NOT EXISTS 'PERIODIC';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_frequency') THEN
    CREATE TYPE maintenance_frequency AS ENUM
      ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');
  END IF;
END $$;

BEGIN;

ALTER TABLE maintenance_schedules
  ADD COLUMN IF NOT EXISTS frequency         maintenance_frequency,
  ADD COLUMN IF NOT EXISTS next_due_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grace_days        INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checklist         JSONB;

COMMENT ON COLUMN maintenance_schedules.frequency IS
  'How often this recurs. NULL means a one-off, which the periodic engine ignores.';
COMMENT ON COLUMN maintenance_schedules.next_due_at IS
  'When the next occurrence is due. The engine raises a ticket at this date and then advances it by one frequency step.';
COMMENT ON COLUMN maintenance_schedules.grace_days IS
  'Days after the due date before an occurrence counts as overdue. Compliance is measured against due_date + grace_days.';
COMMENT ON COLUMN maintenance_schedules.assigned_user_id IS
  'The technician this work falls to. The existing assigned_to is a free-text name and cannot answer "who is overloaded".';

/* Tickets raised by the periodic engine point back at the schedule that
   produced them. Without this the dashboard cannot say which schedules are
   being kept to and which are quietly slipping — the compliance number is
   exactly this join. */
ALTER TABLE maintenance_tickets
  ADD COLUMN IF NOT EXISTS schedule_id INT REFERENCES maintenance_schedules(id) ON DELETE SET NULL;

COMMENT ON COLUMN maintenance_tickets.schedule_id IS
  'The periodic schedule this ticket was generated from. NULL for tickets raised any other way.';

/* The engine asks one question on every tick — "which schedules are due?" —
   and it must not get slower as completed schedules accumulate. */
CREATE INDEX IF NOT EXISTS idx_schedules_due
  ON maintenance_schedules (company_id, next_due_at)
  WHERE is_active = TRUE AND frequency IS NOT NULL;

/* Compliance and the calendar both group tickets by schedule and due date. */
CREATE INDEX IF NOT EXISTS idx_tickets_schedule_due
  ON maintenance_tickets (schedule_id, due_date DESC)
  WHERE schedule_id IS NOT NULL;

/* One live ticket per schedule per due date. The engine relies on a
   NOT EXISTS to stay idempotent, but a unique index is what makes that
   guarantee hold when two cron instances tick at the same moment — pm2
   runs the API as a cluster, so "only one process does this" is not true.
   Partial on the live statuses so a completed occurrence does not block
   the next one at the same date after a re-open. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_schedule_occurrence
  ON maintenance_tickets (schedule_id, due_date)
  WHERE schedule_id IS NOT NULL
    AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS');

COMMIT;
