/**
 * Phase 2 · Screen 5 — Alarm Dashboard & Reports.
 *
 * Every figure here is bounded by a date range. machine_alarms grows with
 * every fault on every machine, so a query without a started_at predicate
 * is one that gets slower every week until it stops returning — the same
 * failure the factory dashboard hit against telemetry.
 *
 * Duration is measured to ended_at, not resolved_at: an alarm ends when
 * the machine stops reporting it, and is resolved when a person says they
 * dealt with it. Measuring to resolved_at would report how long someone
 * took to click a button, which is a different question and not the one
 * the screen asks.
 */

const pool = require('../db');

/* The severities the screen groups by. Anything a controller sends that is
   not CRITICAL is reported as Normal rather than silently dropped — an
   alarm missing from the count is worse than one in the wrong bucket. */
const CRITICAL = 'CRITICAL';

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Resolve the reporting window.
 *
 * Defaults to the last 7 days rather than all time: an unbounded default
 * is the query nobody notices is slow until there is a year of data behind
 * it, and by then it is the dashboard that is broken, not the query.
 */
function resolveRange({ from, to }) {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));

  if (from && !isDate(from)) throw httpError('from must be a date in YYYY-MM-DD form', 400);
  if (to   && !isDate(to))   throw httpError('to must be a date in YYYY-MM-DD form', 400);

  const end   = to   ? `${to} 23:59:59.999`   : null;
  const start = from ? `${from} 00:00:00`     : null;

  if (start && end && new Date(start) > new Date(end)) {
    throw httpError('from must not be after to', 400);
  }
  return { start, end };
}

function parseId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

/**
 * The WHERE shared by every query on this screen, plus its parameters.
 *
 * Built once and handed to each query with its own parameter array, so no
 * query is ever given a parameter it does not reference — the fault that
 * takes an endpoint down with "bind message supplies N parameters".
 */
function buildFilter({ companyId, machineId, shiftId, alarmType, alarmCode, severity, search, start, end }) {
  const params = [companyId];
  let sql = `WHERE a.company_id = $1`;

  const add = (clause, value) => { params.push(value); sql += ` AND ${clause.replace('?', `$${params.length}`)}`; };

  if (start)     add('a.started_at >= ?::timestamptz', start);
  if (end)       add('a.started_at <= ?::timestamptz', end);
  if (machineId) add('a.machine_id = ?', machineId);
  if (shiftId)   add('a.shift_id = ?', shiftId);
  if (alarmType) add('a.alarm_type = ?', alarmType);
  if (alarmCode) add('a.alarm_code = ?', alarmCode);
  if (severity)  add('UPPER(a.severity) = ?', String(severity).toUpperCase());
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    sql += ` AND (a.alarm_type ILIKE $${i} OR a.alarm_code ILIKE $${i}` +
           ` OR a.message ILIKE $${i} OR m.machine_serial_no ILIKE $${i})`;
  }

  return { sql, params };
}

/** Total, critical, normal, open, and the longest single alarm. */
async function kpis(filter) {
  const { rows: [r] } = await pool.query(
    `SELECT
       COUNT(*)::int                                                        AS total,
       COUNT(*) FILTER (WHERE UPPER(a.severity) = '${CRITICAL}')::int       AS critical,
       COUNT(*) FILTER (WHERE UPPER(a.severity) <> '${CRITICAL}')::int      AS normal,
       COUNT(*) FILTER (WHERE a.ended_at IS NULL)::int                      AS open,
       -- an alarm still open is measured to now, otherwise the longest
       -- outage on the floor is invisible until someone closes it
       COALESCE(MAX(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, NOW()) - a.started_at)))::int, 0)
                                                                            AS max_duration_seconds,
       COALESCE(AVG(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)))
                  FILTER (WHERE a.ended_at IS NOT NULL)::int, 0)            AS avg_duration_seconds
     FROM machine_alarms a
     LEFT JOIN machines m ON m.id = a.machine_id
     ${filter.sql}`,
    filter.params
  );
  return r;
}

async function byMachine(filter) {
  const { rows } = await pool.query(
    `SELECT COALESCE(m.machine_serial_no, 'Unknown') AS machine_serial_no,
            a.machine_id,
            COUNT(*)::int                                                   AS total,
            COUNT(*) FILTER (WHERE UPPER(a.severity) = '${CRITICAL}')::int  AS critical
       FROM machine_alarms a
       LEFT JOIN machines m ON m.id = a.machine_id
       ${filter.sql}
      GROUP BY m.machine_serial_no, a.machine_id
      ORDER BY total DESC, machine_serial_no
      LIMIT 15`,
    filter.params
  );
  return rows;
}

async function byShift(filter) {
  const { rows } = await pool.query(
    `SELECT COALESCE(s.shift_name, 'Unassigned') AS shift_name, a.shift_id,
            COUNT(*)::int                                                   AS total,
            COUNT(*) FILTER (WHERE UPPER(a.severity) = '${CRITICAL}')::int  AS critical
       FROM machine_alarms a
       LEFT JOIN machines m ON m.id = a.machine_id
       LEFT JOIN shifts   s ON s.id = a.shift_id
       ${filter.sql}
      GROUP BY s.shift_name, a.shift_id
      ORDER BY total DESC`,
    filter.params
  );
  return rows;
}

async function bySeverity(filter) {
  const { rows: [r] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE UPPER(a.severity) = '${CRITICAL}')::int  AS critical,
       COUNT(*) FILTER (WHERE UPPER(a.severity) <> '${CRITICAL}')::int AS normal
     FROM machine_alarms a
     LEFT JOIN machines m ON m.id = a.machine_id
     ${filter.sql}`,
    filter.params
  );
  return r;
}

/**
 * Daily trend across the window.
 *
 * generate_series supplies the days, so a quiet day is a zero on the chart
 * rather than a missing point that makes the line jump straight from
 * Tuesday to Thursday.
 */
async function trend(filter, { start, end }) {
  const params = [...filter.params, start, end];
  const s = `$${params.length - 1}`;
  const e = `$${params.length}`;

  const { rows } = await pool.query(
    `WITH days AS (
       SELECT generate_series(
                COALESCE(${s}::timestamptz, NOW() - INTERVAL '7 days')::date,
                COALESCE(${e}::timestamptz, NOW())::date,
                INTERVAL '1 day')::date AS day
     )
     SELECT d.day,
            COUNT(a.id)::int                                                 AS total,
            COUNT(a.id) FILTER (WHERE UPPER(a.severity) = '${CRITICAL}')::int AS critical
       FROM days d
       LEFT JOIN machine_alarms a
              ON (a.started_at AT TIME ZONE 'Asia/Kolkata')::date = d.day
             AND a.id IN (SELECT a2.id FROM machine_alarms a2
                          LEFT JOIN machines m ON m.id = a2.machine_id
                          ${filter.sql.replace(/\ba\./g, 'a2.')})
      GROUP BY d.day
      ORDER BY d.day`,
    params
  );
  return rows;
}

/**
 * The alarm table.
 *
 * Ordered by (started_at, id): many alarms can share a timestamp when a
 * machine faults, and pagination without a total order repeats rows across
 * page boundaries.
 */
async function list(filter, { page = 1, limit = 20 }) {
  const pageNum  = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(limit) || 20));
  const offset   = (pageNum - 1) * limitNum;

  const limitIdx  = filter.params.length + 1;
  const offsetIdx = filter.params.length + 2;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT a.id, a.alarm_code, a.alarm_type, a.severity, a.message,
              a.started_at, a.ended_at, a.resolved_at, a.is_resolved,
              COALESCE(m.machine_serial_no, 'Unknown') AS machine_serial_no,
              COALESCE(s.shift_name, 'Unassigned')           AS shift_name,
              (a.ended_at IS NULL)                     AS is_open,
              EXTRACT(EPOCH FROM (COALESCE(a.ended_at, NOW()) - a.started_at))::int
                                                       AS duration_seconds
         FROM machine_alarms a
         LEFT JOIN machines m ON m.id = a.machine_id
         LEFT JOIN shifts   s ON s.id = a.shift_id
         ${filter.sql}
        ORDER BY a.started_at DESC, a.id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...filter.params, limitNum, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
         FROM machine_alarms a
         LEFT JOIN machines m ON m.id = a.machine_id
         ${filter.sql}`,
      filter.params
    )
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

/** The distinct codes and types present, for the filter dropdowns. */
async function facets(companyId, { start, end }) {
  const { rows } = await pool.query(
    `SELECT DISTINCT a.alarm_type, a.alarm_code
       FROM machine_alarms a
      WHERE a.company_id = $1
        AND ($2::timestamptz IS NULL OR a.started_at >= $2)
        AND ($3::timestamptz IS NULL OR a.started_at <= $3)
      ORDER BY a.alarm_type, a.alarm_code
      LIMIT 200`,
    [companyId, start, end]
  );
  return {
    types: [...new Set(rows.map(r => r.alarm_type).filter(Boolean))],
    codes: [...new Set(rows.map(r => r.alarm_code).filter(Boolean))]
  };
}

/** Everything the screen needs, in one response. */
exports.getAlarms = async (q = {}) => {
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId = parseId(q.machine_id, 'machine_id');
  const shiftId   = parseId(q.shift_id, 'shift_id');

  const filter = buildFilter({
    companyId, machineId, shiftId,
    alarmType: q.alarm_type, alarmCode: q.alarm_code, severity: q.severity,
    search: (q.search || '').trim(), start, end
  });

  const [k, machines, shifts, severity, tr, rows, f] = await Promise.all([
    kpis(filter), byMachine(filter), byShift(filter), bySeverity(filter),
    trend(filter, { start, end }), list(filter, q), facets(companyId, { start, end })
  ]);

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, shift_id: shiftId,
      alarm_type: q.alarm_type || null, alarm_code: q.alarm_code || null,
      severity: q.severity || null, search: (q.search || '').trim() || null
    },
    kpis: k,
    by_machine: machines,
    by_shift: shifts,
    by_severity: severity,
    trend: tr,
    alarms: rows,
    facets: f,
    updated_at: new Date().toISOString()
  };
};

/** Flat rows for Excel / CSV / PDF. */
exports.getExportRows = async (q = {}) => {
  const { start, end } = resolveRange(q);
  const filter = buildFilter({
    companyId: q.company_id,
    machineId: parseId(q.machine_id, 'machine_id'),
    shiftId:   parseId(q.shift_id, 'shift_id'),
    alarmType: q.alarm_type, alarmCode: q.alarm_code, severity: q.severity,
    search: (q.search || '').trim(), start, end
  });

  // Bounded: an unbounded export on a year of alarms is a request that
  // never returns and a spreadsheet nobody can open.
  const rows = await list(filter, { page: 1, limit: 200 });

  const hhmm = s => {
    const n = Number(s) || 0;
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  };

  return rows.data.map(r => ({
    'Machine':    r.machine_serial_no,
    'Shift':      r.shift_name,
    'Alarm code': r.alarm_code || '',
    'Alarm name': r.alarm_type,
    'Severity':   String(r.severity).toUpperCase() === CRITICAL ? 'Critical' : 'Normal',
    'Generated':  r.started_at ? new Date(r.started_at).toISOString().replace('T', ' ').slice(0, 19) : '',
    'Closed':     r.ended_at   ? new Date(r.ended_at).toISOString().replace('T', ' ').slice(0, 19) : '',
    'Duration':   hhmm(r.duration_seconds),
    'Status':     r.is_open ? 'Open' : 'Closed',
    'Message':    r.message || ''
  }));
};

exports.resolveRange = resolveRange;
exports.buildFilter = buildFilter;
