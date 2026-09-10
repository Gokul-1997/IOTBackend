/**
 * Phase 2 · Screen 4 — Periodic Maintenance Dashboard (read side).
 *
 * Answers the questions the screen asks, each as its own bounded query
 * rather than one wide join: what is due, what has slipped, is the plan
 * being kept to, and who is carrying it.
 *
 * Compliance is the number the screen exists for, so it is worth being
 * precise about what it means here: of the occurrences whose deadline has
 * passed, the share that were completed by that deadline. Grace days are
 * part of the deadline, not an excuse applied afterwards. Occurrences that
 * are not yet due are excluded entirely — counting them as compliant would
 * make a plant that has done nothing this year look perfect every January.
 */

const pool = require('../db');

/* Statuses that mean the work has not been done yet. */
const LIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];
/* Statuses that mean it has. */
const DONE_STATUSES = ['RESOLVED', 'CLOSED'];

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Reject a bad machine filter as a client error rather than a 500 from SQL. */
function parseMachineId(machineId) {
  if (machineId === undefined || machineId === null || machineId === '') return null;
  const n = Number(machineId);
  if (!Number.isInteger(n) || n <= 0) throw httpError('machine_id must be a positive integer', 400);
  return n;
}

/**
 * The headline counts.
 *
 * Every figure is scoped to schedule-generated tickets — a breakdown
 * ticket is not periodic maintenance and would inflate the plan's
 * compliance with work that was never planned.
 */
async function kpis(companyId, machineId) {
  const { rows: [row] } = await pool.query(
    `WITH occ AS (
       SELECT t.id, t.status, t.due_date, t.resolved_at, t.closed_at,
              COALESCE(s.grace_days, 0) AS grace_days
         FROM maintenance_tickets t
         JOIN maintenance_schedules s ON s.id = t.schedule_id
        WHERE t.company_id = $1
          AND t.schedule_id IS NOT NULL
          AND ($2::int IS NULL OR t.machine_id = $2)
     ),
     judged AS (
       SELECT *,
              due_date + make_interval(days => grace_days) AS deadline,
              COALESCE(resolved_at, closed_at)             AS finished_at
         FROM occ
     )
     SELECT
       COUNT(*)                                                             AS scheduled,
       COUNT(*) FILTER (WHERE status = ANY($3)
                          AND due_date::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
                                                                            AS due_today,
       COUNT(*) FILTER (WHERE status = ANY($3)
                          AND due_date >= NOW()
                          AND due_date <  NOW() + INTERVAL '7 days')        AS due_this_week,
       COUNT(*) FILTER (WHERE status = ANY($3) AND deadline < NOW())        AS overdue,
       COUNT(*) FILTER (WHERE status = ANY($4))                             AS completed,
       -- the compliance denominator: occurrences whose deadline has passed
       COUNT(*) FILTER (WHERE deadline < NOW())                             AS judged_total,
       COUNT(*) FILTER (WHERE deadline < NOW()
                          AND status = ANY($4)
                          AND finished_at IS NOT NULL
                          AND finished_at <= deadline)                      AS on_time
     FROM judged`,
    [companyId, machineId, LIVE_STATUSES, DONE_STATUSES]
  );

  const judged = Number(row.judged_total);
  return {
    scheduled:     Number(row.scheduled),
    due_today:     Number(row.due_today),
    due_this_week: Number(row.due_this_week),
    overdue:       Number(row.overdue),
    completed:     Number(row.completed),
    // null, not 0, when nothing has come due yet — "0% compliance" on a
    // plant with no deadlines behind it is a lie the screen would repeat.
    compliance_pct: judged > 0 ? Number(((Number(row.on_time) / judged) * 100).toFixed(1)) : null,
    compliance_basis: { on_time: Number(row.on_time), judged }
  };
}

/**
 * Compliance over the last 12 weeks, so the trend line shows whether the
 * plan is being kept to better or worse than it was.
 *
 * generate_series supplies the weeks, so a week in which nothing was due
 * appears as a gap rather than being missing from the chart entirely.
 */
async function complianceTrend(companyId, machineId) {
  const { rows } = await pool.query(
    `WITH weeks AS (
       SELECT generate_series(
                date_trunc('week', NOW() - INTERVAL '11 weeks'),
                date_trunc('week', NOW()),
                INTERVAL '1 week') AS week_start
     ),
     occ AS (
       SELECT date_trunc('week', t.due_date) AS week_start,
              t.status,
              t.due_date + make_interval(days => COALESCE(s.grace_days, 0)) AS deadline,
              COALESCE(t.resolved_at, t.closed_at) AS finished_at
         FROM maintenance_tickets t
         JOIN maintenance_schedules s ON s.id = t.schedule_id
        WHERE t.company_id = $1
          AND t.schedule_id IS NOT NULL
          AND ($2::int IS NULL OR t.machine_id = $2)
          AND t.due_date >= date_trunc('week', NOW() - INTERVAL '11 weeks')
     )
     SELECT w.week_start,
            COUNT(o.*) FILTER (WHERE o.deadline < NOW())                     AS judged,
            COUNT(o.*) FILTER (WHERE o.deadline < NOW()
                                 AND o.status = ANY($3)
                                 AND o.finished_at <= o.deadline)            AS on_time
       FROM weeks w
       LEFT JOIN occ o ON o.week_start = w.week_start
      GROUP BY w.week_start
      ORDER BY w.week_start`,
    [companyId, machineId, DONE_STATUSES]
  );

  return rows.map(r => ({
    week_start: r.week_start,
    judged:  Number(r.judged),
    on_time: Number(r.on_time),
    compliance_pct: Number(r.judged) > 0
      ? Number(((Number(r.on_time) / Number(r.judged)) * 100).toFixed(1))
      : null
  }));
}

/**
 * The calendar: how much work each frequency band has outstanding, and how
 * much of it has already slipped. This is the "Daily / Weekly / Monthly /
 * Quarterly / Half-Yearly / Yearly" breakdown the screen shows.
 */
async function byFrequency(companyId, machineId) {
  const { rows } = await pool.query(
    `SELECT s.frequency,
            COUNT(*) FILTER (WHERE t.status = ANY($3))                        AS open_count,
            COUNT(*) FILTER (WHERE t.status = ANY($3)
                               AND t.due_date + make_interval(days => COALESCE(s.grace_days,0)) < NOW())
                                                                              AS overdue_count,
            COUNT(*) FILTER (WHERE t.status = ANY($4))                        AS completed_count,
            MIN(t.due_date) FILTER (WHERE t.status = ANY($3))                 AS next_due_at
       FROM maintenance_tickets t
       JOIN maintenance_schedules s ON s.id = t.schedule_id
      WHERE t.company_id = $1
        AND t.schedule_id IS NOT NULL
        AND ($2::int IS NULL OR t.machine_id = $2)
      GROUP BY s.frequency
      ORDER BY s.frequency`,
    [companyId, machineId, LIVE_STATUSES, DONE_STATUSES]
  );

  return rows.map(r => ({
    frequency:       r.frequency,
    open:            Number(r.open_count),
    overdue:         Number(r.overdue_count),
    completed:       Number(r.completed_count),
    next_due_at:     r.next_due_at
  }));
}

/**
 * Who is carrying the work, and how much of theirs has slipped.
 *
 * Joins on assigned_to rather than the schedule's assigned_user_id: a
 * ticket can be handed to someone else after it is raised, and the
 * question is who holds it now.
 */
async function technicianWorkload(companyId, machineId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(u.username, 'Unassigned') AS technician,
            t.assigned_to                      AS user_id,
            COUNT(*) FILTER (WHERE t.status = ANY($3))                        AS open_count,
            COUNT(*) FILTER (WHERE t.status = ANY($3)
                               AND t.due_date + make_interval(days => COALESCE(s.grace_days,0)) < NOW())
                                                                              AS overdue_count
       FROM maintenance_tickets t
       JOIN maintenance_schedules s ON s.id = t.schedule_id
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.company_id = $1
        AND t.schedule_id IS NOT NULL
        AND ($2::int IS NULL OR t.machine_id = $2)
        AND t.status = ANY($3)
      GROUP BY u.username, t.assigned_to
      ORDER BY open_count DESC, technician`,
    [companyId, machineId, LIVE_STATUSES]
  );

  return rows.map(r => ({
    technician: r.technician,
    user_id:    r.user_id,
    open:       Number(r.open_count),
    overdue:    Number(r.overdue_count)
  }));
}

/** The next occurrences due, whether or not they have slipped yet. */
async function upcoming(companyId, machineId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.due_date, t.priority, t.status,
            s.frequency, m.machine_serial_no,
            COALESCE(u.username, NULL) AS assigned_to_name,
            (t.due_date + make_interval(days => COALESCE(s.grace_days,0)) < NOW()) AS is_overdue
       FROM maintenance_tickets t
       JOIN maintenance_schedules s ON s.id = t.schedule_id
       JOIN machines m ON m.id = t.machine_id
       LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.company_id = $1
        AND t.schedule_id IS NOT NULL
        AND ($2::int IS NULL OR t.machine_id = $2)
        AND t.status = ANY($3)
      ORDER BY t.due_date, t.id
      LIMIT $4`,
    [companyId, machineId, LIVE_STATUSES, limit]
  );
  return rows;
}

/**
 * The ticket table, paginated and searchable.
 *
 * Ordered by (due_date, id): due_date is not unique — a nightly batch
 * raises many occurrences at the same instant — and pagination without a
 * total order repeats rows across page boundaries.
 */
async function tickets(companyId, machineId, { search = '', status = '', page = 1, limit = 10 }) {
  const pageNum  = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 10));
  const offset   = (pageNum - 1) * limitNum;

  /*
   * The two queries do not take the same parameters, so they cannot share
   * one array. `where` is common to both; the live-status list is only used
   * by the data query's is_overdue expression, and limit/offset only by its
   * paging. Passing the union to both is what makes the count query receive
   * more parameters than it references — which Postgres rejects outright,
   * rather than ignoring the extras.
   */
  const values = [companyId, machineId];
  let where = `WHERE t.company_id = $1
                 AND t.schedule_id IS NOT NULL
                 AND ($2::int IS NULL OR t.machine_id = $2)`;

  if (search) {
    values.push(`%${search}%`);
    where += ` AND (t.title ILIKE $${values.length} OR m.machine_serial_no ILIKE $${values.length})`;
  }
  if (status) {
    values.push(String(status).toUpperCase());
    where += ` AND t.status = $${values.length}`;
  }

  const liveIdx   = values.length + 1;
  const limitIdx  = values.length + 2;
  const offsetIdx = values.length + 3;

  const dataQuery = `
    SELECT t.id, t.title, t.status, t.priority, t.due_date,
           COALESCE(t.resolved_at, t.closed_at) AS completed_at,
           s.frequency, s.grace_days,
           m.machine_serial_no,
           COALESCE(u.username, NULL) AS assigned_to_name,
           (t.status = ANY($${liveIdx})
            AND t.due_date + make_interval(days => COALESCE(s.grace_days,0)) < NOW()) AS is_overdue
      FROM maintenance_tickets t
      JOIN maintenance_schedules s ON s.id = t.schedule_id
      JOIN machines m ON m.id = t.machine_id
      LEFT JOIN users u ON u.id = t.assigned_to
      ${where}
     ORDER BY t.due_date DESC, t.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  const countQuery = `
    SELECT COUNT(*)::int AS total
      FROM maintenance_tickets t
      JOIN maintenance_schedules s ON s.id = t.schedule_id
      JOIN machines m ON m.id = t.machine_id
      ${where}`;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [...values, LIVE_STATUSES, limitNum, offset]),
    pool.query(countQuery, values)
  ]);

  const total = countRes.rows[0].total;
  return {
    data: dataRes.rows,
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum))
  };
}

/** Everything the screen needs, in one response. */
exports.getPeriodic = async ({ company_id, machine_id, search, status, page, limit }) => {
  const machineId = parseMachineId(machine_id);

  const [k, trend, freq, workload, next, list] = await Promise.all([
    kpis(company_id, machineId),
    complianceTrend(company_id, machineId),
    byFrequency(company_id, machineId),
    technicianWorkload(company_id, machineId),
    upcoming(company_id, machineId),
    tickets(company_id, machineId, { search, status, page, limit })
  ]);

  return {
    filters: { machine_id: machineId, search: search || null, status: status || null },
    kpis: k,
    compliance_trend: trend,
    by_frequency: freq,
    technician_workload: workload,
    upcoming: next,
    tickets: list,
    updated_at: new Date().toISOString()
  };
};

/** Flat rows for Excel / CSV / PDF export. */
exports.getExportRows = async ({ company_id, machine_id, search, status }) => {
  const machineId = parseMachineId(machine_id);
  // Bounded: an unbounded export on a plant with years of history is a
  // request that never returns and a spreadsheet nobody can open.
  const list = await tickets(company_id, machineId, { search, status, page: 1, limit: 100 });

  return list.data.map(r => ({
    'Ticket':       r.id,
    'Machine':      r.machine_serial_no,
    'Task':         r.title,
    'Frequency':    r.frequency,
    'Priority':     r.priority,
    'Status':       r.status,
    'Due date':     r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : '',
    'Completed':    r.completed_at ? new Date(r.completed_at).toISOString().slice(0, 10) : '',
    'Overdue':      r.is_overdue ? 'Yes' : 'No',
    'Technician':   r.assigned_to_name || 'Unassigned'
  }));
};

exports.LIVE_STATUSES = LIVE_STATUSES;
exports.DONE_STATUSES = DONE_STATUSES;

/* ─────────────────────────────────────────────────────────────
   Schedules — the plan itself

   Separate from the ticket read side above because these write. The
   dashboard shows what the plan produced; this is where the plan is set.
   ───────────────────────────────────────────────────────────── */

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];

exports.listSchedules = async ({ company_id, machine_id }) => {
  const machineId = parseMachineId(machine_id);
  const { rows } = await pool.query(
    `SELECT s.id, s.machine_id, s.title, s.description, s.frequency,
            s.next_due_at, s.last_generated_at, s.grace_days,
            s.assigned_user_id, s.is_active, s.checklist,
            m.machine_serial_no,
            COALESCE(u.username, NULL) AS assigned_to_name
       FROM maintenance_schedules s
       JOIN machines m ON m.id = s.machine_id
       LEFT JOIN users u ON u.id = s.assigned_user_id
      WHERE s.company_id = $1
        AND s.frequency IS NOT NULL
        AND ($2::int IS NULL OR s.machine_id = $2)
      ORDER BY s.is_active DESC, s.next_due_at NULLS LAST, s.id`,
    [company_id, machineId]
  );
  return rows;
};

/**
 * Create or update one schedule.
 *
 * next_due_at is required on create and is the first occurrence, not the
 * date the rule was written — a monthly schedule entered today for work
 * that starts next Monday should raise its first ticket next Monday.
 */
exports.upsertSchedule = async ({
  id, company_id, machine_id, title, description, frequency,
  next_due_at, grace_days, assigned_user_id, checklist, is_active, user_id
}) => {
  const machineId = parseMachineId(machine_id);
  if (!machineId)          throw httpError('machine_id is required', 400);
  if (!title?.trim())      throw httpError('title is required', 400);
  if (!FREQUENCIES.includes(String(frequency).toUpperCase())) {
    throw httpError(`frequency must be one of ${FREQUENCIES.join(', ')}`, 400);
  }
  if (!next_due_at || Number.isNaN(Date.parse(next_due_at))) {
    throw httpError('next_due_at must be a valid date', 400);
  }

  const grace = Number(grace_days);
  if (!Number.isInteger(grace) || grace < 0 || grace > 365) {
    throw httpError('grace_days must be a whole number of days between 0 and 365', 400);
  }

  // The machine has to belong to the caller's company; without this a
  // schedule could be hung off another tenant's machine.
  const { rowCount: ok } = await pool.query(
    `SELECT 1 FROM machines WHERE id = $1 AND company_id = $2`,
    [machineId, company_id]
  );
  if (!ok) throw httpError('Machine not found or access denied', 404);

  if (id) {
    const { rows, rowCount } = await pool.query(
      `UPDATE maintenance_schedules
          SET machine_id = $3, title = $4, description = $5, frequency = $6,
              next_due_at = $7, grace_days = $8, assigned_user_id = $9,
              checklist = $10, is_active = $11, updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING *`,
      [id, company_id, machineId, title.trim(), description || null,
       String(frequency).toUpperCase(), next_due_at, grace,
       assigned_user_id || null, checklist ? JSON.stringify(checklist) : null,
       is_active !== false]
    );
    if (!rowCount) throw httpError('Schedule not found or access denied', 404);
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO maintenance_schedules
       (company_id, machine_id, title, description, maintenance_type, frequency,
        scheduled_at, next_due_at, grace_days, assigned_user_id, checklist,
        is_active, created_by)
     VALUES ($1,$2,$3,$4,'PREVENTIVE',$5,$6,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [company_id, machineId, title.trim(), description || null,
     String(frequency).toUpperCase(), next_due_at, grace,
     assigned_user_id || null, checklist ? JSON.stringify(checklist) : null,
     is_active !== false, user_id]
  );
  return rows[0];
};

/**
 * Deactivate a schedule rather than delete it.
 *
 * Tickets it already produced reference it, and the compliance history is
 * read through that join — a hard delete would blank the frequency on
 * every past occurrence and quietly rewrite last quarter's numbers.
 */
exports.deleteSchedule = async ({ id, company_id }) => {
  const { rowCount } = await pool.query(
    `UPDATE maintenance_schedules
        SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [id, company_id]
  );
  if (!rowCount) throw httpError('Schedule not found or access denied', 404);
};

exports.FREQUENCIES = FREQUENCIES;
