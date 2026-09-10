-- ============================================================
-- 012_maintenance_tickets.sql
-- Maintenance ticket lifecycle — the gap flagged in the Phase 2
-- review: machine_alarms and maintenance_schedules/logs existed,
-- but nothing tracked a breakdown from report through resolution.
--
-- Adds: maintenance_tickets (the ticket itself, optionally linked
--       to the alarm that raised it), ticket_status_history (an
--       append-only audit trail of every status change).
-- ============================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE ticket_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ticket_issue_type AS ENUM ('BREAKDOWN', 'ALARM', 'INSPECTION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  machine_id        INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  -- Optional: the alarm that prompted this ticket (Alarm Details -> "Create ticket").
  -- ON DELETE SET NULL: the ticket and its history are the durable record;
  -- losing the source alarm row later shouldn't cascade-delete a ticket.
  alarm_id          BIGINT REFERENCES machine_alarms(id) ON DELETE SET NULL,
  title             VARCHAR(200) NOT NULL,
  description       TEXT,
  issue_type        ticket_issue_type NOT NULL DEFAULT 'BREAKDOWN',
  priority          ticket_priority NOT NULL DEFAULT 'MEDIUM',
  status            ticket_status NOT NULL DEFAULT 'OPEN',
  assigned_to       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parts_used        TEXT,
  downtime_minutes  INTEGER,
  resolution_note   TEXT,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_company ON maintenance_tickets(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_machine ON maintenance_tickets(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_alarm   ON maintenance_tickets(alarm_id) WHERE alarm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON maintenance_tickets(assigned_to) WHERE assigned_to IS NOT NULL;

-- Append-only: every status transition, who made it and when — the
-- "timestamped history of every status change" the ticket detail view needs.
CREATE TABLE IF NOT EXISTS ticket_status_history (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   BIGINT NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
  from_status ticket_status,
  to_status   ticket_status NOT NULL,
  note        TEXT,
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_history_ticket ON ticket_status_history(ticket_id, created_at);

COMMIT;
