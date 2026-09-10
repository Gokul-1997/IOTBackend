/**
 * Phase 2 · Screen 6 — Downtime Reason Loss Analysis.
 *
 * This screen draws on two sources that answer different halves of the
 * question, and keeping them straight is the whole design:
 *
 *   production_hourly  — how long each machine ran and sat idle. Derived
 *                        from telemetry, so it exists for every machine
 *                        whether or not anyone recorded a reason. This is
 *                        where availability, running time and idle time
 *                        come from, and it holds five months of real data.
 *
 *   downtime_events    — why a machine was down, entered by an operator.
 *                        This is where the Pareto, the categories and the
 *                        reason summary come from, and it is only as
 *                        complete as the reasons people actually enter.
 *
 * Reporting idle time as "downtime by reason" would be the tempting
 * shortcut and a lie: idle time is measured, reasons are declared, and the
 * gap between them is itself worth seeing. The screen shows both and names
 * the difference as unaccounted.
 */

const pool = require('../db');

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

/**
 * Resolve the reporting window, defaulting to the last 7 days.
 *
 * production_hourly holds over a hundred thousand rows and grows every
 * hour, so an unbounded default is the query that works in testing and
 * stops returning a year later.
 */
function resolveRange({ from, to }) {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
  if (from && !isDate(from)) throw httpError('from must be a date in YYYY-MM-DD form', 400);
  if (to && !isDate(to))     throw httpError('to must be a date in YYYY-MM-DD form', 400);

  const end   = to   ? `${to} 23:59:59.999` : new Date().toISOString();
  const start = from ? `${from} 00:00:00`
                     : new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10) + ' 00:00:00';

  if (new Date(start) > new Date(end)) throw httpError('from must not be after to', 400);
  return { start, end };
}

/* ─────────────────────────────────────────────────────────────
   Measured time — from telemetry, not from what anyone typed
   ───────────────────────────────────────────────────────────── */

async function measuredTime({ companyId, machineId, shiftId, start, end }) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(run_seconds), 0)::bigint    AS run_seconds,
            COALESCE(SUM(idle_seconds), 0)::bigint   AS idle_seconds,
            COALESCE(SUM(manual_seconds), 0)::bigint AS manual_seconds
       FROM production_hourly
      WHERE company_id = $1
        AND hour_start >= $2::timestamptz
        AND hour_start <= $3::timestamptz
        AND ($4::int IS NULL OR machine_id = $4)
        AND ($5::int IS NULL OR shift_id  = $5)`,
    [companyId, start, end, machineId, shiftId]
  );

  const run  = Number(r.run_seconds);
  const idle = Number(r.idle_seconds);
  const total = run + idle;

  return {
    run_seconds: run,
    idle_seconds: idle,
    manual_seconds: Number(r.manual_seconds),
    // null rather than 0 when nothing was recorded — "0% available" for a
    // machine that reported no telemetry is a different claim from a
    // machine that ran badly, and the screen must not conflate them
    availability_pct: total > 0 ? Number(((run / total) * 100).toFixed(1)) : null
  };
}

/** How long machines spent in an alarm state, from the alarm records. */
async function alarmTime({ companyId, machineId, start, end }) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(
              EXTRACT(EPOCH FROM (LEAST(COALESCE(a.ended_at, NOW()), $3::timestamptz)
                                - GREATEST(a.started_at, $2::timestamptz)))
            ), 0)::bigint AS alarm_seconds
       FROM machine_alarms a
      WHERE a.company_id = $1
        AND a.started_at <= $3::timestamptz
        AND COALESCE(a.ended_at, NOW()) >= $2::timestamptz
        AND ($4::int IS NULL OR a.machine_id = $4)`,
    [companyId, start, end, machineId]
  );
  // clamped to the window at both ends, so an alarm spanning the boundary
  // contributes only the part inside it
  return Number(r.alarm_seconds);
}

/* ─────────────────────────────────────────────────────────────
   Declared downtime — from what operators entered
   ───────────────────────────────────────────────────────────── */

/** Shared WHERE for every downtime_events query, with its own parameters. */
function eventFilter({ companyId, machineId, shiftId, operatorId, category, reasonId, search, start, end }) {
  const params = [companyId, start, end];
  let sql = `WHERE e.company_id = $1
               AND e.started_at <= $3::timestamptz
               AND COALESCE(e.ended_at, NOW()) >= $2::timestamptz`;

  const add = (clause, value) => { params.push(value); sql += ` AND ${clause.replace('?', `$${params.length}`)}`; };

  if (machineId)  add('e.machine_id = ?', machineId);
  if (shiftId)    add('e.shift_id = ?', shiftId);
  if (operatorId) add('e.operator_id = ?', operatorId);
  if (reasonId)   add('e.downtime_reason_id = ?', reasonId);
  if (category)   add('UPPER(r.category) = ?', String(category).toUpperCase());
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    sql += ` AND (r.name ILIKE $${i} OR e.sub_reason ILIKE $${i}` +
           ` OR e.notes ILIKE $${i} OR m.machine_serial_no ILIKE $${i})`;
  }
  return { sql, params };
}

/**
 * Seconds of an event that fall inside the window.
 *
 * An event that started before the window or is still running must
 * contribute only its overlap, or a single long stoppage inflates every
 * day it touches.
 */
const CLAMPED = `EXTRACT(EPOCH FROM (
                   LEAST(COALESCE(e.ended_at, NOW()), $3::timestamptz)
                 - GREATEST(e.started_at, $2::timestamptz)))`;

async function declaredTotals(filter) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int                         AS events,
            COALESCE(SUM(${CLAMPED}), 0)::bigint  AS downtime_seconds,
            COUNT(*) FILTER (WHERE e.ended_at IS NULL)::int AS open_events
       FROM downtime_events e
       LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
       LEFT JOIN machines m         ON m.id = e.machine_id
       ${filter.sql}`,
    filter.params
  );
  return {
    events: Number(r.events),
    downtime_seconds: Number(r.downtime_seconds),
    open_events: Number(r.open_events)
  };
}

/**
 * Downtime by reason, ordered biggest first, with a running cumulative
 * share — which is what makes it a Pareto rather than a bar chart.
 */
async function byReason(filter) {
  const { rows } = await pool.query(
    `WITH per_reason AS (
       SELECT COALESCE(r.name, 'Unspecified') AS reason,
              COALESCE(r.category, 'UNKNOWN') AS category,
              e.downtime_reason_id            AS reason_id,
              COUNT(*)::int                   AS events,
              COALESCE(SUM(${CLAMPED}), 0)::bigint AS seconds
         FROM downtime_events e
         LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
         LEFT JOIN machines m         ON m.id = e.machine_id
         ${filter.sql}
        GROUP BY r.name, r.category, e.downtime_reason_id
     )
     SELECT *,
            SUM(seconds) OVER ()                                  AS grand_total,
            SUM(seconds) OVER (ORDER BY seconds DESC, reason)      AS cumulative
       FROM per_reason
      ORDER BY seconds DESC, reason`,
    filter.params
  );

  const total = rows.length ? Number(rows[0].grand_total) : 0;
  return rows.map(r => ({
    reason: r.reason,
    reason_id: r.reason_id,
    category: r.category,
    events: Number(r.events),
    seconds: Number(r.seconds),
    share_pct:      total > 0 ? Number(((Number(r.seconds) / total) * 100).toFixed(1)) : 0,
    cumulative_pct: total > 0 ? Number(((Number(r.cumulative) / total) * 100).toFixed(1)) : 0
  }));
}

async function byCategory(filter) {
  const { rows } = await pool.query(
    `SELECT COALESCE(r.category, 'UNKNOWN')      AS category,
            COUNT(*)::int                        AS events,
            COALESCE(SUM(${CLAMPED}), 0)::bigint AS seconds
       FROM downtime_events e
       LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
       LEFT JOIN machines m         ON m.id = e.machine_id
       ${filter.sql}
      GROUP BY r.category
      ORDER BY seconds DESC`,
    filter.params
  );
  return rows.map(r => ({ category: r.category, events: Number(r.events), seconds: Number(r.seconds) }));
}

async function byShift(filter) {
  const { rows } = await pool.query(
    `SELECT COALESCE(s.shift_name, 'Unassigned') AS shift_name, e.shift_id,
            COUNT(*)::int                        AS events,
            COALESCE(SUM(${CLAMPED}), 0)::bigint AS seconds
       FROM downtime_events e
       LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
       LEFT JOIN machines m         ON m.id = e.machine_id
       LEFT JOIN shifts s           ON s.id = e.shift_id
       ${filter.sql}
      GROUP BY s.shift_name, e.shift_id
      ORDER BY seconds DESC`,
    filter.params
  );
  return rows.map(r => ({ shift_name: r.shift_name, shift_id: r.shift_id,
                          events: Number(r.events), seconds: Number(r.seconds) }));
}

/** Hourly profile across the window — when in the day machines stop. */
async function hourlyTrend(filter) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(HOUR FROM (e.started_at AT TIME ZONE 'Asia/Kolkata'))::int AS hour,
            COUNT(*)::int                        AS events,
            COALESCE(SUM(${CLAMPED}), 0)::bigint AS seconds
       FROM downtime_events e
       LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
       LEFT JOIN machines m         ON m.id = e.machine_id
       ${filter.sql}
      GROUP BY 1
      ORDER BY 1`,
    filter.params
  );

  // Fill the missing hours here rather than in SQL: a 24-slot array is
  // cheaper to complete in JS than a generate_series join, and the chart
  // needs all 24 or the x-axis lies about which hour a bar belongs to.
  const byHour = new Map(rows.map(r => [Number(r.hour), r]));
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    events:  byHour.has(h) ? Number(byHour.get(h).events) : 0,
    seconds: byHour.has(h) ? Number(byHour.get(h).seconds) : 0
  }));
}

/**
 * The detail table.
 * Ordered by (started_at, id) — several machines can stop in the same
 * second, and pagination without a total order repeats rows.
 */
async function list(filter, { page = 1, limit = 20 }) {
  const pageNum  = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 20));
  const offset   = (pageNum - 1) * limitNum;

  const limitIdx  = filter.params.length + 1;
  const offsetIdx = filter.params.length + 2;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT e.id, e.started_at, e.ended_at, e.sub_reason, e.notes,
              COALESCE(r.name, 'Unspecified')      AS reason,
              COALESCE(r.category, 'UNKNOWN')      AS category,
              COALESCE(m.machine_serial_no, '--')  AS machine_serial_no,
              COALESCE(s.shift_name, 'Unassigned') AS shift_name,
              COALESCE(o.operator_name, NULL)      AS operator_name,
              (e.ended_at IS NULL)                 AS is_open,
              EXTRACT(EPOCH FROM (COALESCE(e.ended_at, NOW()) - e.started_at))::int
                                                   AS duration_seconds
         FROM downtime_events e
         LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
         LEFT JOIN machines m         ON m.id = e.machine_id
         LEFT JOIN shifts s           ON s.id = e.shift_id
         LEFT JOIN operators o        ON o.id = e.operator_id
         ${filter.sql}
        ORDER BY e.started_at DESC, e.id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...filter.params, limitNum, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
         FROM downtime_events e
         LEFT JOIN downtime_reasons r ON r.id = e.downtime_reason_id
         LEFT JOIN machines m         ON m.id = e.machine_id
         ${filter.sql}`,
      filter.params
    )
  ]);

  const total = countRes.rows[0].total;
  return {
    data: dataRes.rows, total, page: pageNum, limit: limitNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum))
  };
}

/** Everything the screen needs. */
exports.getDowntime = async (q = {}) => {
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId  = parseId(q.machine_id, 'machine_id');
  const shiftId    = parseId(q.shift_id, 'shift_id');
  const operatorId = parseId(q.operator_id, 'operator_id');
  const reasonId   = parseId(q.reason_id, 'reason_id');

  const filter = eventFilter({
    companyId, machineId, shiftId, operatorId, reasonId,
    category: q.category, search: (q.search || '').trim(), start, end
  });

  const [measured, alarmSeconds, declared, reasons, categories, shifts, hourly, rows] =
    await Promise.all([
      measuredTime({ companyId, machineId, shiftId, start, end }),
      alarmTime({ companyId, machineId, start, end }),
      declaredTotals(filter),
      byReason(filter),
      byCategory(filter),
      byShift(filter),
      hourlyTrend(filter),
      list(filter, q)
    ]);

  /*
   * Idle time is measured; declared downtime is typed in by people. The
   * remainder is idle time nobody gave a reason for, and naming it is the
   * point — it is the number that tells a plant whether its downtime
   * reporting is worth anything.
   */
  const unaccounted = Math.max(0, measured.idle_seconds - declared.downtime_seconds);

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, shift_id: shiftId, operator_id: operatorId,
      reason_id: reasonId, category: q.category || null,
      search: (q.search || '').trim() || null
    },
    kpis: {
      total_downtime_seconds: declared.downtime_seconds,
      downtime_events:        declared.events,
      open_events:            declared.open_events,
      run_seconds:            measured.run_seconds,
      idle_seconds:           measured.idle_seconds,
      alarm_seconds:          alarmSeconds,
      availability_pct:       measured.availability_pct,
      unaccounted_seconds:    unaccounted,
      // how much of the idle time actually has a reason against it
      reason_coverage_pct: measured.idle_seconds > 0
        ? Number(((declared.downtime_seconds / measured.idle_seconds) * 100).toFixed(1))
        : null
    },
    by_reason:   reasons,
    top_reasons: reasons.slice(0, 5),
    by_category: categories,
    by_shift:    shifts,
    hourly:      hourly,
    events:      rows,
    updated_at:  new Date().toISOString()
  };
};

/** Flat rows for Excel / CSV / PDF. */
exports.getExportRows = async (q = {}) => {
  const { start, end } = resolveRange(q);
  const filter = eventFilter({
    companyId: q.company_id,
    machineId:  parseId(q.machine_id, 'machine_id'),
    shiftId:    parseId(q.shift_id, 'shift_id'),
    operatorId: parseId(q.operator_id, 'operator_id'),
    reasonId:   parseId(q.reason_id, 'reason_id'),
    category: q.category, search: (q.search || '').trim(), start, end
  });

  const rows = await list(filter, { page: 1, limit: 200 });
  const hhmm = s => {
    const n = Number(s) || 0;
    return `${Math.floor(n / 3600)}h ${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}m`;
  };
  const stamp = d => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '';

  return rows.data.map(r => ({
    'Machine':     r.machine_serial_no,
    'Shift':       r.shift_name,
    'Start':       stamp(r.started_at),
    'End':         stamp(r.ended_at),
    'Duration':    hhmm(r.duration_seconds),
    'Reason':      r.reason,
    'Category':    r.category,
    'Sub reason':  r.sub_reason || '',
    'Operator':    r.operator_name || 'Unassigned',
    'Status':      r.is_open ? 'Open' : 'Closed'
  }));
};

exports.resolveRange = resolveRange;
exports.eventFilter = eventFilter;
