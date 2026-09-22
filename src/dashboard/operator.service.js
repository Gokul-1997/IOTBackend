/**
 * Phase 2 · Screen 7 — Operator Performance.
 *
 * ── The attribution problem, stated plainly ────────────────────────────
 *
 * None of the production tables carry an operator. production_hourly and
 * quality_entries are keyed by machine and shift; the only link to a person
 * is operator_machine_assignments, and that link is not exclusive — several
 * operators can hold one machine at once, and assignments are rarely
 * closed. So "this operator produced N parts" is not a fact the data
 * supports; "these are the figures for the machines this operator is
 * responsible for" is. Each row carries its machines' full figures and says
 * how many of them are shared. Fleet totals are measured per machine, never
 * summed across operators, which would count shared output twice.
 *
 * ── Where every figure comes from ──────────────────────────────────────
 *
 * Per-machine totals and the OEE arithmetic are the OEE Dashboard's own
 * (oee.dashboard.service): OEE recomputed from summed run time, planned
 * time, output and rejects, with performance from the cycle time on the
 * machine's current job. This screen used to average oee_hourly instead,
 * which is 0 or empty for almost every hour — an hour with no parts has no
 * performance — so every operator read 0% OEE while the OEE Dashboard
 * showed real figures for the same machines.
 *
 *   Down Time      idle time from telemetry: the machine on, not cutting.
 *                  The same measured time the Downtime screen reports.
 *                  (Reasons people enter are a separate, often empty, table.)
 *   Utilisation    run / (run + idle)
 *   Efficiency     OEE performance: output against the cycle-time ideal
 *   Quality rate   good / produced
 *   Operator Score the average of utilisation, efficiency and quality rate,
 *                  over those that could be measured — how well the
 *                  machines in this operator's care kept running, ran at
 *                  speed and made good parts. It ranks operators and sets
 *                  their band.
 */

const pool = require('../db');
const oeeSvc = require('./oee.dashboard.service');

/** Score bands, lowest bound of each. Below `average` needs help. */
const SCORE_BANDS = { excellent: 75, good: 60, average: 45 };

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
 * Who is responsible for which machine over the period, and the shift each
 * operator is rostered to. An assignment counts when it overlaps the
 * window, open-ended ones included.
 */
async function assignments({ companyId, start, end, machineId, operatorId, search }) {
  const params = [companyId, start, end];
  const mf = machineId  ? (params.push(machineId),  ` AND a.machine_id = $${params.length}`) : '';
  const of = operatorId ? (params.push(operatorId), ` AND op.id = $${params.length}`)        : '';
  const sf = search
    ? (params.push(`%${search}%`),
       ` AND (op.operator_name ILIKE $${params.length} OR op.operator_code ILIKE $${params.length})`)
    : '';

  const { rows } = await pool.query(
    `SELECT op.id AS operator_id, op.operator_code, op.operator_name, op.skill_level,
            a.machine_id,
            (SELECT string_agg(DISTINCT s.shift_name, ', ')
               FROM operator_shift_assignments osa
               JOIN shifts s ON s.id = osa.shift_id
              WHERE osa.operator_id = op.id AND osa.company_id = $1 AND osa.is_active = TRUE
                AND osa.effective_from <= $3::date
                AND (osa.effective_to IS NULL OR osa.effective_to >= $2::date)) AS shift_name
       FROM operators op
       JOIN operator_machine_assignments a
         ON a.operator_id = op.id
        AND a.company_id = $1
        AND a.is_active = TRUE
        AND a.assigned_from <= $3::timestamptz
        AND (a.assigned_to IS NULL OR a.assigned_to >= $2::timestamptz)
        ${mf}
      WHERE op.company_id = $1 AND op.is_active = TRUE
        ${of}${sf}
      GROUP BY op.id, op.operator_code, op.operator_name, op.skill_level, a.machine_id`,
    params
  );
  return rows;
}

/** Every active operator, for the Operator filter — whatever else is set. */
async function operatorOptions(companyId) {
  const { rows } = await pool.query(
    `SELECT id, operator_code, operator_name FROM operators
      WHERE company_id = $1 AND is_active = TRUE ORDER BY operator_name`,
    [companyId]
  );
  return rows.map(r => ({ id: r.id, operator_code: r.operator_code, operator_name: (r.operator_name || '').trim() }));
}

const round1 = v => v == null ? null : Number(Number(v).toFixed(1));

/** The average of whichever of the three rates were measured. */
function scoreOf({ utilization_pct, efficiency_pct, quality_rate_pct }) {
  const parts = [utilization_pct, efficiency_pct, quality_rate_pct].filter(v => v != null);
  return parts.length ? round1(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

function bandOf(score) {
  if (score == null) return 'UNRATED';
  if (score >= SCORE_BANDS.excellent) return 'EXCELLENT';
  if (score >= SCORE_BANDS.good)      return 'GOOD';
  if (score >= SCORE_BANDS.average)   return 'AVERAGE';
  return 'NEEDS_HELP';
}

/**
 * One operator's row from the derived figures of their machines.
 * fleetOee does the OEE sums exactly as the OEE Dashboard's fleet row does
 * (performance weighted by run time), so the two screens agree.
 */
function derive(op, machines) {
  const f = oeeSvc.fleetOee(machines, oeeSvc.DEFAULT_THRESHOLDS);
  const run = f.run_seconds;
  const idle = f.idle_seconds;
  const manned = run + idle;
  const produced = f.produced;

  const r = {
    operator_id:      op.operator_id,
    operator_code:    op.operator_code,
    operator_name:    (op.operator_name || '').trim(),
    skill_level:      op.skill_level,
    shift_name:       op.shift_name || null,
    machines:         machines.map(m => ({ id: m.machine_id, name: m.machine_serial_no })),
    machine_names:    machines.map(m => m.machine_serial_no).join(', '),
    machine_count:    machines.length,
    shared_machines:  op.shared_machines || 0,
    produced,
    good:             f.good,
    rejected:         f.rejected,
    run_seconds:      run,
    idle_seconds:     idle,
    // measured, not declared: the machine on and not cutting
    downtime_seconds: idle,
    alarm_count:      f.alarm_count,
    // every rate is null rather than 0 when its denominator is absent
    utilization_pct:    manned > 0 ? round1((run / manned) * 100) : null,
    availability_pct:   f.availability_pct,
    efficiency_pct:     f.performance_pct,
    quality_rate_pct:   f.quality_pct,
    rejection_rate_pct: produced > 0 ? round1((f.rejected / produced) * 100) : null,
    oee_pct:            f.oee_pct
  };
  r.score = scoreOf(r);
  r.band = bandOf(r.score);
  return r;
}

/** Counted over every operator, so the tiles do not change with the page. */
function band(rows) {
  const out = { excellent: 0, good: 0, average: 0, needs_help: 0, unrated: 0 };
  for (const r of rows) {
    const b = r.band || bandOf(r.score);
    if (b === 'EXCELLENT') out.excellent++;
    else if (b === 'GOOD') out.good++;
    else if (b === 'AVERAGE') out.average++;
    else if (b === 'NEEDS_HELP') out.needs_help++;
    else out.unrated++;
  }
  return out;
}

/** Fields the table can be sorted on, and what they sort by. */
const SORTABLE = new Set([
  'operator_code', 'operator_name', 'shift_name', 'machine_names', 'score', 'run_seconds',
  'downtime_seconds', 'utilization_pct', 'produced', 'good', 'rejected', 'quality_rate_pct',
  'rejection_rate_pct', 'alarm_count', 'oee_pct', 'efficiency_pct'
]);

/**
 * Sort by one field. Unmeasured values sort last in either direction — an
 * operator with nothing measured is not the best or the worst, just unknown.
 * Ties fall back to score, then output, then name, so the order is stable.
 */
function sortRows(rows, field = 'score', dir = 'desc') {
  const key = SORTABLE.has(field) ? field : 'score';
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string' || typeof y === 'string') return sign * String(x).localeCompare(String(y));
    return sign * (x - y);
  };
  return [...rows].sort((a, b) =>
    cmp(a, b)
    || ((b.score ?? -1) - (a.score ?? -1))
    || (b.produced - a.produced)
    || a.operator_name.localeCompare(b.operator_name));
}

/** Kept for callers that rank without choosing a column: best score first. */
const rank = rows => sortRows(rows, 'score', 'desc');

/**
 * Top 5 and Bottom 5 for one measure, over every operator rather than the
 * page on screen. `top` is the highest values; for rejection and downtime
 * that is the worst five. Operators with the measure unknown are left out
 * of both — they are not the best or the worst of anything.
 */
function leaders(rows, field, keep = () => true) {
  const measured = rows.filter(r => r[field] != null && keep(r));
  const desc = sortRows(measured, field, 'desc');
  const pick = r => ({
    operator_id: r.operator_id,
    operator_name: r.operator_name,
    value: r[field],
    availability_pct: r.availability_pct,
    efficiency_pct: r.efficiency_pct,
    quality_rate_pct: r.quality_rate_pct,
    oee_pct: r.oee_pct
  });
  return {
    top: desc.slice(0, 5).map(pick),
    bottom: [...desc].reverse().slice(0, 5).map(pick)
  };
}

exports.getOperators = async (q = {}) => {
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId  = parseId(q.machine_id, 'machine_id');
  const shiftId    = parseId(q.shift_id, 'shift_id');
  const operatorId = parseId(q.operator_id, 'operator_id');
  const search     = (q.search || '').trim();
  const sort       = SORTABLE.has(q.sort) ? q.sort : 'score';
  const dir        = q.dir === 'asc' ? 'asc' : 'desc';

  const [links, machineRows, operator_list] = await Promise.all([
    assignments({ companyId, start, end, machineId, operatorId, search }),
    oeeSvc.machineTotals({ companyId, machineId, shiftId, start, end }),
    operatorOptions(companyId)
  ]);

  const machinesById = new Map(
    machineRows.map(r => [r.machine_id, oeeSvc.deriveOee(r, oeeSvc.DEFAULT_THRESHOLDS)])
  );

  // how many operators hold each machine — the caveat on every shared row
  const holders = new Map();
  for (const l of links) holders.set(l.machine_id, (holders.get(l.machine_id) || 0) + 1);

  const byOperator = new Map();
  for (const l of links) {
    const m = machinesById.get(l.machine_id);
    if (!m) continue;                               // an inactive or other-company machine
    const e = byOperator.get(l.operator_id)
      || { op: { ...l, shared_machines: 0 }, machines: [] };
    e.machines.push(m);
    if (holders.get(l.machine_id) > 1) e.op.shared_machines++;
    byOperator.set(l.operator_id, e);
  }

  const all = [...byOperator.values()].map(e => derive(e.op, e.machines));
  const sorted = sortRows(all, sort, dir);

  // Fleet figures over the machines these operators hold, each counted once.
  const held = [...new Set(links.map(l => l.machine_id))].map(id => machinesById.get(id)).filter(Boolean);
  const fleet = oeeSvc.fleetOee(held, oeeSvc.DEFAULT_THRESHOLDS);
  const producing = held.filter(m => m.produced > 0 || m.run_seconds > 0);

  const pageNum  = Math.max(1, Number(q.page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(q.limit) || 20));
  const offset   = (pageNum - 1) * limitNum;

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, shift_id: shiftId, operator_id: operatorId,
      search: search || null, sort, dir
    },
    kpis: {
      produced: fleet.produced, good: fleet.good, rejected: fleet.rejected,
      run_seconds: fleet.run_seconds, idle_seconds: fleet.idle_seconds,
      quality_rate_pct: fleet.quality_pct,
      utilization_pct: (fleet.run_seconds + fleet.idle_seconds) > 0
        ? round1((fleet.run_seconds / (fleet.run_seconds + fleet.idle_seconds)) * 100) : null,
      oee_pct: fleet.oee_pct
    },
    // OEE needs a cycle time; say how many of the running machines have one
    oee_coverage: {
      machines: producing.length,
      with_cycle_time: producing.filter(m => m.has_cycle_time).length
    },
    attribution: {
      operators: all.length,
      shared_machines: all.reduce((n, r) => n + (r.shared_machines > 0 ? 1 : 0), 0),
      note: 'Figures are for the machines each operator is assigned to. Machines with more than one assigned operator appear in each of their rows.'
    },
    score_bands: SCORE_BANDS,
    bands: band(all),
    leaders: {
      score:     leaders(all, 'score'),
      rejection: leaders(all, 'rejection_rate_pct'),
      // only operators whose machines reported any time at all
      downtime:  leaders(all, 'downtime_seconds', r => r.run_seconds + r.idle_seconds > 0),
      oee:       leaders(all, 'oee_pct')
    },
    operator_list,
    operators: {
      data: sorted.slice(offset, offset + limitNum),
      total: sorted.length,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.max(1, Math.ceil(sorted.length / limitNum))
    },
    updated_at: new Date().toISOString()
  };
};

/** Flat rows for Excel / CSV / PDF, in the table's order and columns. */
exports.getExportRows = async (q = {}) => {
  const d = await exports.getOperators({ ...q, page: 1, limit: 200 });
  const hhmm = s => `${Math.floor((Number(s) || 0) / 3600)}h ${String(Math.floor(((Number(s) || 0) % 3600) / 60)).padStart(2, '0')}m`;
  const pct = v => v === null || v === undefined ? '' : `${v}%`;
  const label = { EXCELLENT: 'Excellent', GOOD: 'Good', AVERAGE: 'Avg', NEEDS_HELP: 'Help', UNRATED: 'Unrated' };

  return d.operators.data.map(r => ({
    'Operator ID':   r.operator_code || r.operator_id,
    'Operator':      r.operator_name,
    'Shift':         r.shift_name || '',
    'Machines':      r.machine_names,
    'Shared':        r.shared_machines > 0 ? `${r.shared_machines} shared` : '',
    'Score':         pct(r.score),
    'Run time':      hhmm(r.run_seconds),
    'Down time':     hhmm(r.downtime_seconds),
    'Utilization':   pct(r.utilization_pct),
    'Produced':      r.produced,
    'Good':          r.good,
    'Rejected':      r.rejected,
    'Quality rate':  pct(r.quality_rate_pct),
    'Alarms':        r.alarm_count,
    'OEE':           pct(r.oee_pct),
    'Efficiency':    pct(r.efficiency_pct),
    'Status':        label[r.band] || ''
  }));
};

exports.resolveRange = resolveRange;
exports.derive = derive;
exports.rank = rank;
exports.band = band;
exports.bandOf = bandOf;
exports.scoreOf = scoreOf;
exports.sortRows = sortRows;
exports.leaders = leaders;
exports.SCORE_BANDS = SCORE_BANDS;
