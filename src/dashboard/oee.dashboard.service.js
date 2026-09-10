/**
 * Phase 2 · Screen 8 — OEE Dashboard.
 *
 * ── Why this does not read oee_hourly ──────────────────────────────────
 *
 * oee_hourly stores OEE per machine per hour, and the obvious thing would
 * be to average it over the reporting window. That is wrong, and against
 * this database it is wrong by a lot.
 *
 * OEE is a product of three ratios. Averaging a ratio over periods with
 * different denominators does not give the ratio for the whole period —
 * and an hour in which a machine produced nothing has performance 0 and
 * quality 0, so every idle hour drags the average toward zero for reasons
 * that are not about how the machine ran when it was running. Over the
 * last seven days, averaging gives 0.00% OEE and 15.78% availability;
 * recomputing from the totals gives 23.99% availability.
 *
 * So this recomputes from summed totals:
 *   availability = total run time / total planned time
 *   performance  = total produced / (total run time / cycle time)
 *   quality      = good / produced
 *   OEE          = availability x performance x quality
 *
 * ── What is genuinely unknown ──────────────────────────────────────────
 *
 * Performance needs a cycle time, which comes from the component on the
 * machine's current job. Only 10 of the 18 machines producing in the last
 * week have one. For the rest, performance is not zero — it is unknown,
 * and so is OEE. Reporting 0% would be a judgement the data cannot
 * support, so those come back null and the screen says how many machines
 * are affected.
 */

const pool = require('../db');

/* Classification bands, world-class OEE being 85%. Overridable per request
   so a plant can set its own bar without a schema change. */
const DEFAULT_THRESHOLDS = { good: 85, fair: 60 };

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

function resolveThresholds(q) {
  const num = (v, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw httpError('OEE thresholds must be between 0 and 100', 400);
    }
    return n;
  };
  const good = num(q.threshold_good, DEFAULT_THRESHOLDS.good);
  const fair = num(q.threshold_fair, DEFAULT_THRESHOLDS.fair);
  if (fair > good) throw httpError('threshold_fair must not exceed threshold_good', 400);
  return { good, fair };
}

/**
 * Per-machine totals over the window.
 *
 * Each source is rolled up separately before joining. Joining
 * production_hourly, quality_entries, alarms and downtime together first
 * would multiply rows against one another and inflate every sum.
 */
async function machineTotals({ companyId, machineId, shiftId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), `$${params.length}`) : null;
  const sf = shiftId   ? (params.push(shiftId),   `$${params.length}`) : null;

  const { rows } = await pool.query(
    `WITH prod AS (
       SELECT ph.machine_id,
              SUM(ph.run_seconds)::bigint  AS run_seconds,
              SUM(ph.idle_seconds)::bigint AS idle_seconds,
              SUM(ph.produced_qty)::bigint AS produced,
              COUNT(*)::int                AS hours
         FROM production_hourly ph
         JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1
        WHERE ph.hour_start >= $2::timestamptz AND ph.hour_start <= $3::timestamptz
          ${mf ? `AND ph.machine_id = ${mf}` : ''}
          ${sf ? `AND ph.shift_id = ${sf}` : ''}
        GROUP BY ph.machine_id
     ),
     cycle AS (
       /* Cycle time comes from the component on the machine's current job.
          A machine with no job, or a job with no component, has no cycle
          time — and therefore no knowable performance. */
       SELECT mcj.machine_id,
              MAX(EXTRACT(EPOCH FROM c.cycle_time))::numeric AS cycle_seconds,
              MAX(COALESCE(c.multiplication_factor, 1))::numeric AS mult
         FROM machine_current_job mcj
         JOIN components c ON c.id = mcj.component_id
        WHERE mcj.is_active = TRUE
        GROUP BY mcj.machine_id
     ),
     qual AS (
       /* quality_entries carries no company_id, so scoping is through the
          machine — without it the table is global across tenants. */
       SELECT q.machine_id,
              SUM(COALESCE(q.reject_qty,0) + COALESCE(q.rework_qty,0))::bigint AS rejected
         FROM quality_entries q
         JOIN machines qm ON qm.id = q.machine_id AND qm.company_id = $1
        WHERE q.shift_date >= $2::timestamptz AND q.shift_date <= $3::timestamptz
          ${sf ? `AND q.shift_id = ${sf}` : ''}
        GROUP BY q.machine_id
     ),
     alarms AS (
       SELECT a.machine_id, COUNT(*)::int AS alarm_count
         FROM machine_alarms a
        WHERE a.company_id = $1
          AND a.started_at >= $2::timestamptz AND a.started_at <= $3::timestamptz
        GROUP BY a.machine_id
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
     ),
     live AS (
       /* Latest telemetry per machine, bounded to the last hour. Without
          the bound this scans every chunk of the hypertable; with it the
          planner prunes to one. A machine silent for over an hour is
          offline, which is exactly what the absence of a row means. */
       SELECT DISTINCT ON (t.machine_id)
              t.machine_id, t.machine_status, t.alarm
         FROM telemetry_raw t
        WHERE t.company_id = $1
          AND t.received_at > NOW() - INTERVAL '1 hour'
        ORDER BY t.machine_id, t.received_at DESC
     )
     SELECT m.id AS machine_id, m.machine_serial_no, m.model,
            COALESCE(p.run_seconds, 0)::bigint  AS run_seconds,
            COALESCE(p.idle_seconds, 0)::bigint AS idle_seconds,
            COALESCE(p.produced, 0)::bigint     AS produced,
            COALESCE(p.hours, 0)::int           AS hours,
            cy.cycle_seconds, cy.mult,
            COALESCE(q.rejected, 0)::bigint     AS rejected,
            COALESCE(al.alarm_count, 0)::int    AS alarm_count,
            COALESCE(dt.downtime_seconds, 0)::bigint AS downtime_seconds,
            lv.machine_status, lv.alarm
       FROM machines m
       LEFT JOIN prod p      ON p.machine_id = m.id
       LEFT JOIN cycle cy    ON cy.machine_id = m.id
       LEFT JOIN qual q      ON q.machine_id = m.id
       LEFT JOIN alarms al   ON al.machine_id = m.id
       LEFT JOIN downtime dt ON dt.machine_id = m.id
       LEFT JOIN live lv     ON lv.machine_id = m.id
      WHERE m.company_id = $1 AND m.is_active = TRUE
        ${mf ? `AND m.id = ${mf}` : ''}
      ORDER BY m.machine_serial_no`,
    params
  );
  return rows;
}

/** Live status, in the four states the screen reports. */
function statusOf(row) {
  if (!row.machine_status) return 'OFFLINE';       // no telemetry in the last hour
  if (row.alarm) return 'ALARM';
  return String(row.machine_status).toUpperCase() === 'RUNNING' ? 'RUNNING' : 'IDLE';
}

/**
 * Turn one machine's totals into the four OEE figures.
 *
 * Every ratio is null when its denominator is missing, and OEE is null
 * unless all three parts are known — a product of an unknown is unknown,
 * not zero.
 */
function deriveOee(row, thresholds) {
  const run      = Number(row.run_seconds);
  const idle     = Number(row.idle_seconds);
  const produced = Number(row.produced);
  const rejected = Number(row.rejected);
  const planned  = Number(row.hours) * 3600;
  const cycle    = row.cycle_seconds != null ? Number(row.cycle_seconds) : null;
  const mult     = row.mult != null ? Number(row.mult) : 1;

  const good = Math.max(0, produced - rejected);

  const availability = planned > 0 ? Math.min(100, (run / planned) * 100) : null;

  /* Ideal output is run time divided by cycle time, times whatever the
     component makes per cycle. Capped at 100: a figure over 100 means the
     configured cycle time is shorter than reality, which is a data problem
     to fix rather than a performance to celebrate. */
  let performance = null;
  if (cycle && cycle > 0 && run > 0) {
    const ideal = (run / cycle) * (mult || 1);
    performance = ideal > 0 ? Math.min(100, (produced / ideal) * 100) : null;
  }

  const quality = produced > 0 ? (good / produced) * 100 : null;

  const oee = (availability != null && performance != null && quality != null)
    ? (availability / 100) * (performance / 100) * (quality / 100) * 100
    : null;

  const round = v => v == null ? null : Number(v.toFixed(1));

  return {
    machine_id:        row.machine_id,
    machine_serial_no: row.machine_serial_no,
    model:             row.model,
    status:            statusOf(row),
    run_seconds:       run,
    idle_seconds:      idle,
    downtime_seconds:  Number(row.downtime_seconds),
    planned_seconds:   planned,
    produced, good, rejected,
    alarm_count:       Number(row.alarm_count),
    has_cycle_time:    cycle != null && cycle > 0,
    availability_pct:  round(availability),
    performance_pct:   round(performance),
    quality_pct:       round(quality),
    oee_pct:           round(oee),
    rejection_rate_pct: produced > 0 ? Number(((rejected / produced) * 100).toFixed(1)) : null,
    band: classify(oee, thresholds)
  };
}

/** Good / fair / poor, or unknown when OEE could not be computed. */
function classify(oee, { good, fair }) {
  if (oee == null) return 'UNKNOWN';
  if (oee >= good) return 'GOOD';
  if (oee >= fair) return 'FAIR';
  return 'POOR';
}

/**
 * Fleet OEE, recomputed from the summed totals rather than averaged from
 * the per-machine percentages — the same reason this does not average
 * oee_hourly. Machines with no cycle time are excluded from performance
 * and from OEE, but still counted in availability and production.
 */
function fleetOee(machines, thresholds) {
  const sum = (f, rows = machines) => rows.reduce((n, r) => n + (Number(f(r)) || 0), 0);

  const planned  = sum(r => r.planned_seconds);
  const run      = sum(r => r.run_seconds);
  const produced = sum(r => r.produced);
  const rejected = sum(r => r.rejected);
  const good     = Math.max(0, produced - rejected);

  const measurable = machines.filter(r => r.has_cycle_time && r.run_seconds > 0);
  const mRun = sum(r => r.run_seconds, measurable);

  const availability = planned > 0 ? Math.min(100, (run / planned) * 100) : null;
  const quality      = produced > 0 ? (good / produced) * 100 : null;

  /* Fleet performance is each machine's performance weighted by how long
     it actually ran. A plain average would weight a machine that ran ten
     minutes the same as one that ran three days. */
  const weighted = measurable.reduce((n, r) => n + (r.performance_pct ?? 0) * r.run_seconds, 0);
  const performance = (measurable.length && mRun > 0)
    ? Math.min(100, weighted / mRun)
    : null;

  const oee = (availability != null && performance != null && quality != null)
    ? (availability / 100) * (performance / 100) * (quality / 100) * 100
    : null;

  const round = v => v == null ? null : Number(v.toFixed(1));

  return {
    availability_pct: round(availability),
    performance_pct:  round(performance),
    quality_pct:      round(quality),
    oee_pct:          round(oee),
    band:             classify(oee, thresholds),
    produced, good, rejected,
    run_seconds: run,
    planned_seconds: planned,
    idle_seconds: sum(r => r.idle_seconds),
    downtime_seconds: sum(r => r.downtime_seconds),
    alarm_count: sum(r => r.alarm_count),
    machines_measurable: measurable.length,
    machines_total: machines.length
  };
}

/** Daily OEE trend, each day recomputed from that day's totals. */
async function trend({ companyId, machineId, shiftId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), `$${params.length}`) : null;
  const sf = shiftId   ? (params.push(shiftId),   `$${params.length}`) : null;

  const { rows } = await pool.query(
    `WITH days AS (
       SELECT generate_series($2::timestamptz::date, $3::timestamptz::date, INTERVAL '1 day')::date AS day
     ),
     per_day AS (
       SELECT (ph.hour_start AT TIME ZONE 'Asia/Kolkata')::date AS day,
              SUM(ph.run_seconds)::bigint  AS run_seconds,
              SUM(ph.produced_qty)::bigint AS produced,
              COUNT(*)::int                AS hours
         FROM production_hourly ph
         JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1
        WHERE ph.hour_start >= $2::timestamptz AND ph.hour_start <= $3::timestamptz
          ${mf ? `AND ph.machine_id = ${mf}` : ''}
          ${sf ? `AND ph.shift_id = ${sf}` : ''}
        GROUP BY 1
     )
     SELECT d.day,
            COALESCE(p.run_seconds, 0)::bigint AS run_seconds,
            COALESCE(p.produced, 0)::bigint    AS produced,
            COALESCE(p.hours, 0)::int          AS hours
       FROM days d LEFT JOIN per_day p ON p.day = d.day
      ORDER BY d.day`,
    params
  );

  return rows.map(r => {
    const planned = Number(r.hours) * 3600;
    const run = Number(r.run_seconds);
    return {
      day: r.day,
      produced: Number(r.produced),
      run_seconds: run,
      // a day with no recorded hours has no availability, rather than 0%
      availability_pct: planned > 0 ? Number(Math.min(100, (run / planned) * 100).toFixed(1)) : null
    };
  });
}

exports.getOee = async (q = {}) => {
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId = parseId(q.machine_id, 'machine_id');
  const shiftId   = parseId(q.shift_id, 'shift_id');
  const thresholds = resolveThresholds(q);
  const search = (q.search || '').trim().toLowerCase();

  const [rows, tr] = await Promise.all([
    machineTotals({ companyId, machineId, shiftId, start, end }),
    trend({ companyId, machineId, shiftId, start, end })
  ]);

  let machines = rows.map(r => deriveOee(r, thresholds));
  if (search) {
    machines = machines.filter(m =>
      String(m.machine_serial_no || '').toLowerCase().includes(search) ||
      String(m.model || '').toLowerCase().includes(search));
  }

  /* Ranked only among machines whose OEE could actually be computed —
     "bottom 5" filled with machines that have no cycle time would blame
     them for a configuration gap. */
  const ranked = machines.filter(m => m.oee_pct != null).sort((a, b) => b.oee_pct - a.oee_pct);

  const statusCounts = machines.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, { RUNNING: 0, IDLE: 0, ALARM: 0, OFFLINE: 0 });

  const pageNum  = Math.max(1, Number(q.page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(q.limit) || 20));
  const offset   = (pageNum - 1) * limitNum;
  const sorted = [...machines].sort((a, b) => {
    if (a.oee_pct == null && b.oee_pct == null) return b.produced - a.produced;
    if (a.oee_pct == null) return 1;
    if (b.oee_pct == null) return -1;
    return b.oee_pct - a.oee_pct;
  });

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, shift_id: shiftId,
      search: (q.search || '').trim() || null
    },
    thresholds,
    kpis: fleetOee(machines, thresholds),
    /* Stated because it decides how much of this screen is meaningful:
       performance and OEE need a cycle time, and most machines here
       do not have one. */
    coverage: {
      machines: machines.length,
      with_cycle_time: machines.filter(m => m.has_cycle_time).length,
      oee_computable: ranked.length,
      note: 'Performance and OEE need a cycle time from the component on the machine’s current job. Machines without one report availability and production only.'
    },
    status_counts: statusCounts,
    top_machines: ranked.slice(0, 5),
    /* Start the bottom list after the top one. With fewer than ten
       computable machines the two slices would otherwise overlap and the
       same machine would appear as both best and worst on one screen. */
    bottom_machines: ranked.slice(Math.max(5, ranked.length - 5)).reverse(),
    trend: tr,
    machines: {
      data: sorted.slice(offset, offset + limitNum),
      total: sorted.length,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.max(1, Math.ceil(sorted.length / limitNum))
    },
    updated_at: new Date().toISOString()
  };
};

exports.getExportRows = async (q = {}) => {
  const d = await exports.getOee({ ...q, page: 1, limit: 200 });
  const hhmm = s => `${Math.floor((Number(s) || 0) / 3600)}h ${String(Math.floor(((Number(s) || 0) % 3600) / 60)).padStart(2, '0')}m`;
  const pct = v => v === null || v === undefined ? '' : `${v}%`;

  return d.machines.data.map(r => ({
    'Machine':        r.machine_serial_no,
    'Status':         r.status,
    'Availability':   pct(r.availability_pct),
    'Performance':    pct(r.performance_pct),
    'Quality':        pct(r.quality_pct),
    'OEE':            pct(r.oee_pct),
    'Band':           r.band,
    'Production':     r.produced,
    'Good parts':     r.good,
    'Rejections':     r.rejected,
    'Rejection rate': pct(r.rejection_rate_pct),
    'Downtime':       hhmm(r.downtime_seconds),
    'Alarms':         r.alarm_count
  }));
};

exports.resolveRange = resolveRange;
exports.resolveThresholds = resolveThresholds;
exports.deriveOee = deriveOee;
exports.classify = classify;
exports.fleetOee = fleetOee;
exports.statusOf = statusOf;
exports.DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS;
