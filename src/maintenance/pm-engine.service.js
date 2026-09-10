/*
 * Phase 2 · Screen 3 — the preventive-maintenance engine.
 *
 * Screen 3's requirements describe a loop, not a report: alarms cross a
 * configured threshold, a PM ticket is raised automatically with a due
 * date, and the dashboard reports on it. This is the part that raises the
 * tickets. The read side lives in preventive.service.js.
 *
 * Evaluation is one set-based statement per company rather than a loop over
 * rules × machines. A shop with 20 machines and a dozen rules would
 * otherwise be 240 round trips every time the job ticks.
 *
 * It must be safe to run repeatedly — the cron fires every 15 minutes and a
 * user can trigger it by hand — so it never raises a second ticket while one
 * is still open for the same rule and machine.
 */
const db = require('../db');

/** Statuses that mean "someone is already dealing with this". */
const LIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];

/**
 * Raise PM tickets for every threshold this company has breached.
 *
 * @returns {Promise<{created: number, tickets: Array}>}
 */
exports.evaluateCompany = async (companyId, { createdBy = null } = {}) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /*
     * candidates  — every (rule, machine) pair whose alarm count within the
     *               rule's window has reached its threshold
     * to_raise    — those with no live ticket already open for that pair
     *
     * The NOT EXISTS is what makes this idempotent. Without it every tick
     * would raise another ticket for the same still-unresolved problem.
     */
    const { rows: created } = await client.query(
      `WITH candidates AS (
         SELECT t.id                AS threshold_id,
                m.id                AS machine_id,
                m.machine_serial_no,
                t.alarm_type,
                t.priority,
                t.due_hours,
                t.threshold_count,
                t.window_hours,
                COUNT(a.id)::int    AS alarm_count,
                MAX(a.id)           AS latest_alarm_id
         FROM alarm_thresholds t
         JOIN machines m
           ON m.company_id = t.company_id
          AND m.is_active
          AND (t.machine_id IS NULL OR m.id = t.machine_id)
         JOIN machine_alarms a
           ON a.machine_id = m.id
          AND a.company_id = t.company_id
          AND a.alarm_type = t.alarm_type
          AND a.started_at > NOW() - make_interval(hours => t.window_hours)
         WHERE t.company_id = $1
           AND t.is_active
         GROUP BY t.id, m.id, m.machine_serial_no
         HAVING COUNT(a.id) >= t.threshold_count
       ),
       to_raise AS (
         SELECT c.* FROM candidates c
         WHERE NOT EXISTS (
           SELECT 1 FROM maintenance_tickets mt
           WHERE mt.threshold_id = c.threshold_id
             AND mt.machine_id   = c.machine_id
             AND mt.status       = ANY($2::ticket_status[])
         )
       )
       INSERT INTO maintenance_tickets
         (company_id, machine_id, alarm_id, threshold_id, title, description,
          issue_type, priority, status, due_date, created_by)
       SELECT
         $1,
         r.machine_id,
         r.latest_alarm_id,
         r.threshold_id,
         format('PM: %s on %s', r.alarm_type, r.machine_serial_no),
         format('Raised automatically: %s alarms of type "%s" in the last %s hours (threshold %s).',
                r.alarm_count, r.alarm_type, r.window_hours, r.threshold_count),
         'PREVENTIVE',
         r.priority,
         'OPEN',
         NOW() + make_interval(hours => r.due_hours),
         $3
       FROM to_raise r
       RETURNING id, machine_id, threshold_id, priority, due_date, title`,
      [companyId, LIVE_STATUSES, createdBy]
    );

    /* Same append-only trail a hand-raised ticket gets, so the ticket detail
       view does not show a PM ticket appearing from nowhere. */
    if (created.length) {
      await client.query(
        `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, note, changed_by)
         SELECT id, NULL, 'OPEN', 'Raised automatically by the preventive maintenance engine', $2
         FROM unnest($1::bigint[]) AS id`,
        [created.map(t => t.id), createdBy]
      );
    }

    await client.query('COMMIT');
    return { created: created.length, tickets: created };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Run the engine for every company that has at least one active rule.
 *
 * One company failing must not stop the rest — a bad rule on one tenant
 * cannot be allowed to stall preventive maintenance for all of them.
 */
exports.evaluateAll = async () => {
  const { rows } = await db.query(
    `SELECT DISTINCT company_id FROM alarm_thresholds WHERE is_active`
  );

  const summary = { companies: rows.length, created: 0, failed: [] };

  for (const { company_id } of rows) {
    try {
      const r = await exports.evaluateCompany(company_id);
      summary.created += r.created;
    } catch (err) {
      console.error(`PM engine failed for company ${company_id}:`, err.message);
      summary.failed.push({ company_id, error: err.message });
    }
  }

  return summary;
};

exports.LIVE_STATUSES = LIVE_STATUSES;
