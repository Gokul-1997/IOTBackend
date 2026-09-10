/**
 * Phase 2 · Screen 4 — the periodic-maintenance engine.
 *
 * Screen 3's engine watches alarms; this one watches the calendar. A
 * schedule says "grease the ways every week"; when that week comes round
 * the engine raises a ticket and moves the schedule on to the next
 * occurrence.
 *
 * Two properties matter more than anything else here:
 *
 *  1. Idempotence. The cron fires every 15 minutes, a user can trigger a
 *     run by hand, and pm2 runs several API instances — so the same tick
 *     can genuinely happen twice at once. Raising a second ticket for an
 *     occurrence that already has one would turn a weekly greasing job
 *     into ninety-six tickets a day.
 *
 *  2. Not skipping occurrences. A schedule that was due three times while
 *     nobody was looking (a long weekend, a server that was down) must
 *     produce the occurrences it missed, not silently jump to next week.
 *     Maintenance that was never done is the thing the compliance number
 *     exists to show.
 *
 * The work is set-based: one INSERT ... SELECT per pass rather than a
 * query per schedule, so a company with 500 schedules is one round trip.
 */

const pool = require('../db');

/* Statuses that mean an occurrence is still being worked. A ticket in any
   of these blocks a duplicate for the same schedule and due date; a
   RESOLVED or CLOSED one does not, so the next occurrence can be raised. */
const LIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];

/**
 * The Postgres interval for one step of each frequency.
 *
 * Kept as an explicit map rather than built from the enum name so the
 * quarterly and half-yearly steps are stated rather than inferred, and so
 * an unrecognised value fails loudly instead of producing a schedule that
 * silently never advances.
 */
const FREQUENCY_STEP = {
  DAILY:       '1 day',
  WEEKLY:      '1 week',
  MONTHLY:     '1 month',
  QUARTERLY:   '3 months',
  HALF_YEARLY: '6 months',
  YEARLY:      '1 year'
};

/**
 * How many occurrences a single schedule may catch up in one pass.
 *
 * A daily schedule whose next_due_at was left a year in the past would
 * otherwise raise 365 tickets in one tick and bury the queue. Catching up
 * a bounded number per pass means the backlog still clears — the next tick
 * takes the next batch — while no single run can flood the board.
 */
const MAX_CATCHUP_PER_PASS = 12;

/**
 * Raise the tickets that are due for one company and advance its
 * schedules.
 *
 * @param {number} companyId
 * @param {object} [opts]
 * @param {number} [opts.createdBy] user id recorded as the ticket author
 * @returns {Promise<{created: number, advanced: number}>}
 */
exports.evaluateCompany = async (companyId, { createdBy = null } = {}) => {
  const client = await pool.connect();
  let created = 0;
  let advanced = 0;

  try {
    await client.query('BEGIN');

    /*
     * Take the due schedules under a row lock for the duration of the
     * transaction. Two cluster instances ticking together would otherwise
     * both read the same rows as due, both insert, and both advance —
     * the unique index would reject the second insert, but the second
     * advance would still skip an occurrence. SKIP LOCKED lets the other
     * instance move on to different schedules instead of waiting.
     */
    const { rows: due } = await client.query(
      `SELECT id, machine_id, title, description, frequency, next_due_at,
              assigned_user_id, grace_days, maintenance_type
         FROM maintenance_schedules
        WHERE company_id = $1
          AND is_active = TRUE
          AND frequency IS NOT NULL
          AND next_due_at IS NOT NULL
          AND next_due_at <= NOW()
        ORDER BY next_due_at
        FOR UPDATE SKIP LOCKED`,
      [companyId]
    );

    for (const schedule of due) {
      const step = FREQUENCY_STEP[schedule.frequency];
      if (!step) {
        // Unrecognised frequency: leave the schedule alone rather than
        // guess a step and quietly put it on the wrong cycle.
        console.error(
          `[periodic] schedule ${schedule.id} has unknown frequency ${schedule.frequency}; skipped`
        );
        continue;
      }

      /*
       * Work forward from next_due_at in frequency steps until we reach
       * the future, raising a ticket for each occurrence passed. This is
       * what stops missed occurrences from vanishing.
       */
      let dueAt = new Date(schedule.next_due_at);
      let steps = 0;

      while (dueAt <= new Date() && steps < MAX_CATCHUP_PER_PASS) {
        const { rowCount } = await client.query(
          `INSERT INTO maintenance_tickets
             (company_id, machine_id, schedule_id, title, description,
              issue_type, priority, status, due_date, assigned_to, created_by)
           SELECT $1, $2, $3, $4, $5, 'PERIODIC', $6, $7, $8, $9, $10
            WHERE NOT EXISTS (
              SELECT 1 FROM maintenance_tickets mt
               WHERE mt.schedule_id = $3
                 AND mt.due_date    = $8
                 AND mt.status      = ANY($11)
            )`,
          [
            companyId,
            schedule.machine_id,
            schedule.id,
            schedule.title,
            schedule.description,
            priorityFor(schedule.frequency),
            schedule.assigned_user_id ? 'ASSIGNED' : 'OPEN',
            dueAt,
            schedule.assigned_user_id,
            createdBy,
            LIVE_STATUSES
          ]
        );
        created += rowCount;

        dueAt = await addStep(client, dueAt, step);
        steps += 1;
      }

      await client.query(
        `UPDATE maintenance_schedules
            SET next_due_at = $2, last_generated_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [schedule.id, dueAt]
      );
      advanced += 1;
    }

    await client.query('COMMIT');
    return { created, advanced };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Add one frequency step to a date, in the database rather than in JS.
 *
 * Postgres knows that one month after 31 January is 28 February and that a
 * day is not always 24 hours across a DST change. Doing this with
 * setMonth() would drift a monthly schedule onto the 3rd of March and keep
 * it there.
 */
async function addStep(client, from, step) {
  const { rows } = await client.query(
    `SELECT ($1::timestamptz + $2::interval) AS next`,
    [from, step]
  );

  /*
   * Coerce to a Date rather than trusting the driver to have done it.
   *
   * The catch-up loop compares this against `new Date()`. JavaScript's
   * relational comparison converts a Date to a NUMBER, so comparing it
   * against a timestamp *string* converts the string to NaN and every
   * comparison is false — the loop exits after one occurrence and the
   * missed ones vanish, with no error anywhere. node-postgres happens to
   * return a Date for timestamptz today, which means this would work
   * until a type parser somewhere changed it.
   */
  return new Date(rows[0].next);
}

/**
 * Longer-cycle work is the work nobody notices slipping, so it carries
 * more weight when it does come due. A daily greasing job missed once is
 * an inconvenience; a missed annual service is a machine running outside
 * its service interval.
 */
function priorityFor(frequency) {
  switch (frequency) {
    case 'YEARLY':
    case 'HALF_YEARLY': return 'HIGH';
    case 'QUARTERLY':
    case 'MONTHLY':     return 'MEDIUM';
    default:            return 'LOW';
  }
}

/**
 * Run every company that has at least one active recurring schedule.
 * One tenant's bad data must not stop maintenance for the others, so a
 * failure is recorded and the loop continues.
 */
exports.evaluateAll = async () => {
  const { rows: companies } = await pool.query(
    `SELECT DISTINCT company_id
       FROM maintenance_schedules
      WHERE is_active = TRUE AND frequency IS NOT NULL AND next_due_at IS NOT NULL`
  );

  let created = 0;
  let advanced = 0;
  const failed = [];

  for (const { company_id } of companies) {
    try {
      const res = await exports.evaluateCompany(company_id);
      created  += res.created;
      advanced += res.advanced;
    } catch (err) {
      failed.push({ company_id, error: err.message });
    }
  }

  return { companies: companies.length, created, advanced, failed };
};

exports.FREQUENCY_STEP = FREQUENCY_STEP;
exports.LIVE_STATUSES = LIVE_STATUSES;
exports.MAX_CATCHUP_PER_PASS = MAX_CATCHUP_PER_PASS;
