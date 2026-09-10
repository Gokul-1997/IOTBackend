/**
 * Phase 2 · Screen 7 — Operator Performance.
 *
 * ── The attribution problem, stated plainly ────────────────────────────
 *
 * None of the production tables carry an operator. production_hourly,
 * oee_hourly and quality_entries are all keyed by machine and shift. The
 * only link to a person is operator_machine_assignments, and in this
 * database that link is not exclusive: 10 of 41 machines have two or three
 * operators assigned at once, and every assignment has assigned_to NULL,
 * so none of them has ever been closed.
 *
 * That means "this operator produced N parts" is not a fact the data
 * supports. What it supports is "these are the figures for the machines
 * this operator is responsible for".
 *
 * Two tempting shortcuts are both wrong:
 *   - dividing a machine's output between its operators invents numbers
 *     nobody measured;
 *   - attributing the full amount to each and then summing double-counts
 *     the shop's entire output.
 *
 * So: each operator's row carries the full figures for their machines, and
 * every row carries `shared_machines` — how many of those machines they
 * share with someone else. The screen shows that count, and the totals
 * across operators are deliberately not presented as a company total.
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

/** Defaults to the last 7 days; production_hourly grows every hour. */
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

/**
 * The per-operator aggregate.
 *
 * Each source is rolled up to one row per machine *before* anything is
 * joined. Joining production_hourly, oee_hourly and quality_entries
 * together first would multiply rows against each other and inflate every
 * sum — the classic fan-out that makes a dashboard confidently wrong.
 */
function operatorRowsSql({ machineFilter, shiftFilter, operatorFilter, searchFilter }) {
  return `
    WITH assign AS (
      SELECT DISTINCT a.operator_id, a.machine_id
        FROM operator_machine_assignments a
       WHERE a.company_id = $1
         AND a.is_active = TRUE
         AND a.assigned_from <= $3::timestamptz
         AND (a.assigned_to IS NULL OR a.assigned_to >= $2::timestamptz)
         ${machineFilter}
    ),
    /* how many operators share each machine — the caveat that makes the
       rest of the numbers readable */
    sharing AS (
      SELECT machine_id, COUNT(*)::int AS operators_on_machine
        FROM assign GROUP BY machine_id
    ),
    prod AS (
      SELECT p.machine_id,
             SUM(p.produced_qty)::bigint   AS produced,
             SUM(p.run_seconds)::bigint    AS run_seconds,
             SUM(p.idle_seconds)::bigint   AS idle_seconds
        FROM production_hourly p
       WHERE p.company_id = $1
         AND p.hour_start >= $2::timestamptz AND p.hour_start <= $3::timestamptz
         ${shiftFilter.replace('%TABLE%', 'p')}
       GROUP BY p.machine_id
    ),
    oee AS (
      /* Scoped through the machine, not oee_hourly.company_id — that column
         is NULL on 50,498 of its 50,502 rows, so filtering on it directly
         returns almost nothing and the screen reports no OEE at all. */
      SELECT o.machine_id,
             AVG(o.oee)          AS oee,
             AVG(o.performance)  AS performance,
             AVG(o.availability) AS availability
        FROM oee_hourly o
        JOIN machines om ON om.id = o.machine_id AND om.company_id = $1
       WHERE o.hour_start >= $2::timestamptz AND o.hour_start <= $3::timestamptz
         ${shiftFilter.replace('%TABLE%', 'o')}
       GROUP BY o.machine_id
    ),
    qual AS (
      /* total_qty is NULL on every row in this database, so produced comes
         from telemetry and only the reject counts are taken from here.

         quality_entries has no company_id of its own, so tenant scoping has
         to come through the machine. Without this join the table is global
         and one company's reject counts would leak into another's. */
      SELECT q.machine_id,
             SUM(COALESCE(q.reject_qty, 0) + COALESCE(q.rework_qty, 0))::bigint AS rejected
        FROM quality_entries q
        JOIN machines qm ON qm.id = q.machine_id AND qm.company_id = $1
       WHERE q.shift_date >= $2::timestamptz AND q.shift_date <= $3::timestamptz
         ${shiftFilter.replace('%TABLE%', 'q')}
       GROUP BY q.machine_id
    ),
    alarms AS (
      SELECT al.machine_id, COUNT(*)::int AS alarm_count
        FROM machine_alarms al
       WHERE al.company_id = $1
         AND al.started_at >= $2::timestamptz AND al.started_at <= $3::timestamptz
       GROUP BY al.machine_id
    ),
    downtime AS (
      SELECT d.machine_id,
             COALESCE(SUM(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(d.ended_at, NOW()), $3::timestamptz)
             - GREATEST(d.started_at, $2::timestamptz)))), 0)::bigint AS downtime_seconds
        FROM downtime_events d
       WHERE d.company_id = $1
         AND d.started_at <= $3::timestamptz
         AND COALESCE(d.ended_at, NOW()) >= $2::timestamptz
       GROUP BY d.machine_id
    )
    SELECT
      op.id                                     AS operator_id,
      op.operator_code,
      op.operator_name,
      op.skill_level,
      COUNT(DISTINCT a.machine_id)::int         AS machine_count,
      COUNT(DISTINCT a.machine_id) FILTER (WHERE sh.operators_on_machine > 1)::int
                                                AS shared_machines,
      COALESCE(SUM(pr.produced), 0)::bigint     AS produced,
      COALESCE(SUM(qu.rejected), 0)::bigint     AS rejected,
      COALESCE(SUM(pr.run_seconds), 0)::bigint  AS run_seconds,
      COALESCE(SUM(pr.idle_seconds), 0)::bigint AS idle_seconds,
      COALESCE(SUM(dt.downtime_seconds), 0)::bigint AS downtime_seconds,
      COALESCE(SUM(al.alarm_count), 0)::int     AS alarm_count,
      AVG(oe.oee)                               AS oee,
      AVG(oe.performance)                       AS performance
    FROM operators op
    JOIN assign a       ON a.operator_id = op.id
    LEFT JOIN sharing sh ON sh.machine_id = a.machine_id
    LEFT JOIN prod pr   ON pr.machine_id = a.machine_id
    LEFT JOIN oee oe    ON oe.machine_id = a.machine_id
    LEFT JOIN qual qu   ON qu.machine_id = a.machine_id
    LEFT JOIN alarms al ON al.machine_id = a.machine_id
    LEFT JOIN downtime dt ON dt.machine_id = a.machine_id
    WHERE op.company_id = $1
      AND op.is_active = TRUE
      ${operatorFilter}
      ${searchFilter}
    GROUP BY op.id, op.operator_code, op.operator_name, op.skill_level`;
}

/** Turn the raw aggregate into the rates the screen reports. */
function derive(r) {
  const produced = Number(r.produced);
  const rejected = Number(r.rejected);
  const good = Math.max(0, produced - rejected);
  const run = Number(r.run_seconds);
  const idle = Number(r.idle_seconds);
  const manned = run + idle;

  return {
    operator_id:      r.operator_id,
    operator_code:    r.operator_code,
    operator_name:    (r.operator_name || '').trim(),
    skill_level:      r.skill_level,
    machine_count:    Number(r.machine_count),
    shared_machines:  Number(r.shared_machines),
    produced,
    good,
    rejected,
    run_seconds:      run,
    idle_seconds:     idle,
    downtime_seconds: Number(r.downtime_seconds),
    alarm_count:      Number(r.alarm_count),
    // Every rate is null rather than 0 when its denominator is absent.
    // "0% quality" for an operator whose machines produced nothing is a
    // different claim from one who produced only scrap.
    quality_rate_pct:   produced > 0 ? Number(((good / produced) * 100).toFixed(1)) : null,
    rejection_rate_pct: produced > 0 ? Number(((rejected / produced) * 100).toFixed(1)) : null,
    utilization_pct:    manned > 0 ? Number(((run / manned) * 100).toFixed(1)) : null,
    oee_pct:            r.oee != null ? Number(Number(r.oee).toFixed(1)) : null,
    efficiency_pct:     r.performance != null ? Number(Number(r.performance).toFixed(1)) : null
  };
}

/**
 * Rank operators for the leaderboard.
 *
 * OEE first because it already folds availability, performance and
 * quality together; produced quantity breaks ties. Operators with no OEE
 * recorded sort last rather than counting as zero — absent is not bad.
 */
function rank(rows) {
  return [...rows].sort((a, b) => {
    if (a.oee_pct == null && b.oee_pct == null) return b.produced - a.produced;
    if (a.oee_pct == null) return 1;
    if (b.oee_pct == null) return -1;
    return b.oee_pct - a.oee_pct || b.produced - a.produced;
  });
}

exports.getOperators = async (q = {}) => {
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId  = parseId(q.machine_id, 'machine_id');
  const shiftId    = parseId(q.shift_id, 'shift_id');
  const operatorId = parseId(q.operator_id, 'operator_id');
  const search     = (q.search || '').trim();

  const params = [companyId, start, end];
  const machineFilter  = machineId  ? (params.push(machineId),  ` AND a.machine_id = $${params.length}`) : '';
  const shiftFilter    = shiftId    ? (params.push(shiftId),    ` AND %TABLE%.shift_id = $${params.length}`) : '';
  const operatorFilter = operatorId ? (params.push(operatorId), ` AND op.id = $${params.length}`) : '';
  const searchFilter   = search
    ? (params.push(`%${search}%`),
       ` AND (op.operator_name ILIKE $${params.length} OR op.operator_code ILIKE $${params.length})`)
    : '';

  const { rows } = await pool.query(
    operatorRowsSql({ machineFilter, shiftFilter, operatorFilter, searchFilter }),
    params
  );

  const all = rows.map(derive);
  const ranked = rank(all);

  /*
   * Fleet totals come from the machines, not from summing the operator
   * rows. Ten machines are shared, so adding the rows up would count their
   * output two or three times.
   */
  const machineTotals = await fleetTotals({ companyId, machineId, shiftId, start, end });

  const pageNum  = Math.max(1, Number(q.page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(q.limit) || 20));
  const offset   = (pageNum - 1) * limitNum;

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, shift_id: shiftId, operator_id: operatorId,
      search: search || null
    },
    kpis: machineTotals,
    // the caveat the screen must show, not bury
    attribution: {
      operators: all.length,
      shared_machines: all.reduce((n, r) => n + (r.shared_machines > 0 ? 1 : 0), 0),
      note: 'Figures are for the machines each operator is assigned to. Machines with more than one assigned operator appear in each of their rows.'
    },
    by_production: [...all].sort((a, b) => b.produced - a.produced).slice(0, 10),
    top_performers: ranked.slice(0, 5),
    operators: {
      data: ranked.slice(offset, offset + limitNum),
      total: ranked.length,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.max(1, Math.ceil(ranked.length / limitNum))
    },
    updated_at: new Date().toISOString()
  };
};

/** Shop-level figures, measured per machine so nothing is double-counted. */
async function fleetTotals({ companyId, machineId, shiftId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND machine_id = $${params.length}`) : '';
  const sf = shiftId   ? (params.push(shiftId),   ` AND shift_id = $${params.length}`)   : '';

  const [{ rows: [p] }, { rows: [o] }, { rows: [q] }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(produced_qty),0)::bigint  AS produced,
              COALESCE(SUM(run_seconds),0)::bigint   AS run_seconds,
              COALESCE(SUM(idle_seconds),0)::bigint  AS idle_seconds
         FROM production_hourly
        WHERE company_id = $1 AND hour_start >= $2::timestamptz AND hour_start <= $3::timestamptz
        ${mf}${sf}`, params),
    pool.query(
      `SELECT AVG(o.oee) AS oee
         FROM oee_hourly o
         JOIN machines m ON m.id = o.machine_id AND m.company_id = $1
        WHERE o.hour_start >= $2::timestamptz AND o.hour_start <= $3::timestamptz
        ${mf.replace('machine_id', 'o.machine_id')}${sf.replace('shift_id', 'o.shift_id')}`, params),
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(q.reject_qty,0)+COALESCE(q.rework_qty,0)),0)::bigint AS rejected
         FROM quality_entries q
         JOIN machines m ON m.id = q.machine_id AND m.company_id = $1
        WHERE q.shift_date >= $2::timestamptz AND q.shift_date <= $3::timestamptz
        ${mf.replace('machine_id', 'q.machine_id')}${sf.replace('shift_id', 'q.shift_id')}`, params)
  ]);

  const produced = Number(p.produced);
  const rejected = Number(q.rejected);
  const good = Math.max(0, produced - rejected);
  const manned = Number(p.run_seconds) + Number(p.idle_seconds);

  return {
    produced, good, rejected,
    run_seconds:  Number(p.run_seconds),
    idle_seconds: Number(p.idle_seconds),
    quality_rate_pct: produced > 0 ? Number(((good / produced) * 100).toFixed(1)) : null,
    utilization_pct:  manned > 0 ? Number(((Number(p.run_seconds) / manned) * 100).toFixed(1)) : null,
    oee_pct: o.oee != null ? Number(Number(o.oee).toFixed(1)) : null
  };
}

/** Flat rows for Excel / CSV / PDF. */
exports.getExportRows = async (q = {}) => {
  const d = await exports.getOperators({ ...q, page: 1, limit: 200 });
  const hhmm = s => `${Math.floor((Number(s) || 0) / 3600)}h ${String(Math.floor(((Number(s) || 0) % 3600) / 60)).padStart(2, '0')}m`;
  const pct = v => v === null || v === undefined ? '' : `${v}%`;

  return d.operators.data.map(r => ({
    'Operator ID':   r.operator_code || r.operator_id,
    'Operator':      r.operator_name,
    'Machines':      r.machine_count,
    'Shared':        r.shared_machines > 0 ? `${r.shared_machines} shared` : '',
    'Run time':      hhmm(r.run_seconds),
    'Down time':     hhmm(r.downtime_seconds),
    'Utilization':   pct(r.utilization_pct),
    'Produced':      r.produced,
    'Good':          r.good,
    'Rejected':      r.rejected,
    'Quality rate':  pct(r.quality_rate_pct),
    'Alarms':        r.alarm_count,
    'OEE':           pct(r.oee_pct),
    'Efficiency':    pct(r.efficiency_pct)
  }));
};

exports.resolveRange = resolveRange;
exports.derive = derive;
exports.rank = rank;
