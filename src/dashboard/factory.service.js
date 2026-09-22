/*
 * Phase 2 · Screen 1 — Factory Overall Dashboard.
 *
 * One aggregate for the whole shop floor, filterable by shift, machine
 * and date. Everything here reads the rollup tables the MQTT processor
 * maintains (production_hourly, oee_hourly) rather than telemetry_raw —
 * same source the machine dashboard uses, so the two always agree.
 *
 * The existing dashboard.service covers the per-machine grid; this is
 * the factory-level view that sits above it.
 */
const db = require('../db');
// resolveWindow/scope moved to ./window.js when the Maintenance dashboard
// needed the same filter behaviour — two screens filtered identically must
// resolve identically, so there is one copy rather than two.
const { resolveWindow, scope, parseMachineId } = require('./window');
const oeeSvc = require('./oee.dashboard.service');

/* Alarm severities are stored as LOW/MEDIUM/HIGH/CRITICAL, but the
   agreement asks for Critical / Non-Critical / Information. */
const SEVERITY_CLASS = `
  CASE
    WHEN severity = 'CRITICAL'        THEN 'CRITICAL'
    WHEN severity IN ('HIGH','MEDIUM') THEN 'NON_CRITICAL'
    ELSE 'INFORMATION'
  END`;

/**
 * Resolve the reporting window.
 * A date alone means that whole day; adding a shift narrows it to that
 * shift's window, handling the overnight case where a shift starts on
 * one date and ends on the next.
 */
exports.getFactoryDashboard = async (req) => {
  const companyId  = req.user.company_id;
  const machineId  = parseMachineId(req.query.machine_id);
  const win        = await resolveWindow(companyId, req.query);

  const s = scope(companyId, win, machineId);

  const [
    settingsRes, machineRes, prodRes, machineTotals,
    shiftRes, downtimeRes, alarmRes, energyRes, targetRes, yesterdayRes
  ] = await Promise.all([

    /* company tariff — cost is unavailable rather than zero when unset */
    db.query(
      `SELECT energy_rate_per_kwh, currency, oee_target_percent
       FROM company_settings WHERE company_id = $1`, [companyId]
    ),

    /* live machine states: running / idle / breakdown / offline
     *
     * The LOOKBACK bound is load-bearing, not cosmetic. telemetry_raw is a
     * Timescale hypertable with ~180 chunks covering months of data; without
     * a received_at predicate the planner cannot prune chunks, so this
     * DISTINCT ON walks every chunk. Measured against production: unbounded
     * had not finished after 227 seconds, bounded returns in ~20ms.
     *
     * An hour is far more than the 60s freshness cut-off below, so it cannot
     * change which machines count as fresh — it only stops the scan reading
     * data that could never win the DISTINCT ON. Do not remove it.
     *
     * offline is derived rather than counted so the four states are mutually
     * exclusive and always sum to total. Counting it separately meant a
     * machine that was both stale and alarmed landed in breakdown AND
     * offline, and the numbers on the card did not add up. */
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (t.machine_id)
               t.machine_id, t.machine_status, t.alarm, t.received_at
        FROM telemetry_raw t
        JOIN machines m ON m.id = t.machine_id
        WHERE m.company_id = $1 AND m.is_active
          AND t.received_at > NOW() - INTERVAL '1 hour'
          ${machineId ? 'AND t.machine_id = $2' : ''}
        ORDER BY t.machine_id, t.received_at DESC
      ),
      fresh AS (
        SELECT * FROM latest WHERE received_at > NOW() - INTERVAL '60 seconds'
      ),
      counted AS (
        SELECT
          COUNT(*) FILTER (WHERE alarm IS TRUE)::int AS breakdown,
          COUNT(*) FILTER (WHERE alarm IS NOT TRUE AND machine_status = 'RUNNING')::int AS running,
          COUNT(*) FILTER (WHERE alarm IS NOT TRUE AND machine_status = 'IDLE')::int    AS idle
        FROM fresh
      )
      SELECT
        tot.total,
        c.running,
        c.idle,
        c.breakdown,
        (tot.total - c.running - c.idle - c.breakdown)::int AS offline
      FROM counted c
      CROSS JOIN (
        SELECT COUNT(*)::int AS total FROM machines
        WHERE company_id = $1 AND is_active ${machineId ? 'AND id = $2' : ''}
      ) tot`,
      machineId ? [companyId, machineId] : [companyId]
    ),

    /* production + run/idle + energy for the window */
    db.query(`
      SELECT COALESCE(SUM(produced_qty),0)::int   AS produced,
             COALESCE(SUM(run_seconds),0)::int    AS run_seconds,
             COALESCE(SUM(idle_seconds),0)::int   AS idle_seconds,
             COALESCE(SUM(energy_kwh),0)::float   AS energy_kwh
      FROM production_hourly WHERE ${s.sql}`, s.params
    ),

    /* OEE, worked out exactly as the OEE Dashboard does: from the window's
       summed run time, planned time, output and rejects, performance from
       the cycle time on each machine's current job.

       This tile used to average oee_hourly. An hour in which a machine made
       nothing has no performance, so nearly every hourly OEE row is 0 or
       empty and the tile read 0% — while the OEE Dashboard showed the real
       figure for the same machines on the same day. */
    oeeSvc.machineTotals({ companyId, machineId, shiftId: win.shift?.id || null, start: win.from, end: win.to }),

    /* shift-wise production (whole day, ignores the shift filter on purpose
       — the point of the chart is to compare shifts), per machine so each
       machine's output can be set against its own job target */
    db.query(`
      SELECT sh.id AS shift_id, sh.shift_code, sh.shift_name, sh.start_time, sh.end_time,
             p.machine_id,
             COALESCE(SUM(p.produced_qty),0)::int AS produced
      FROM shifts sh
      LEFT JOIN production_hourly p
        ON p.shift_id = sh.id
       AND p.company_id = sh.company_id
       AND p.hour_start >= $2 AND p.hour_start < $3
       ${machineId ? 'AND p.machine_id = $4' : ''}
      WHERE sh.company_id = $1 AND sh.is_active
      GROUP BY sh.id, sh.shift_code, sh.shift_name, sh.start_time, sh.end_time, p.machine_id
      ORDER BY sh.shift_code`,
      machineId
        ? [companyId, `${win.day}T00:00:00+05:30`, `${win.day}T23:59:59.999+05:30`, machineId]
        : [companyId, `${win.day}T00:00:00+05:30`, `${win.day}T23:59:59.999+05:30`]
    ),

    /* downtime split by reason and planned/unplanned */
    db.query(`
      SELECT COALESCE(r.name,'Unclassified') AS reason,
             COALESCE(r.category,'UNPLANNED') AS category,
             COALESCE(SUM(d.duration_seconds),0)::int AS seconds,
             COUNT(*)::int AS events
      FROM downtime_events d
      LEFT JOIN downtime_reasons r ON r.id = d.downtime_reason_id
      WHERE d.company_id = $1 AND d.started_at >= $2 AND d.started_at < $3
        ${machineId ? 'AND d.machine_id = $4' : ''}
      GROUP BY r.name, r.category
      ORDER BY seconds DESC`,
      machineId ? [companyId, win.from, win.to, machineId] : [companyId, win.from, win.to]
    ),

    /* alarm summary by class */
    db.query(`
      SELECT ${SEVERITY_CLASS} AS class,
             COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE is_resolved IS NOT TRUE)::int AS open
      FROM machine_alarms
      WHERE company_id = $1 AND started_at >= $2 AND started_at < $3
        ${machineId ? 'AND machine_id = $4' : ''}
      GROUP BY 1`,
      machineId ? [companyId, win.from, win.to, machineId] : [companyId, win.from, win.to]
    ),

    /* hourly energy + production trend, per machine and shift so output
       can be counted in parts and set against the hourly target */
    db.query(`
      SELECT hour_start, machine_id, shift_id,
             COALESCE(SUM(energy_kwh),0)::float AS kwh,
             COALESCE(SUM(produced_qty),0)::int AS produced
      FROM production_hourly WHERE ${s.sql}
      GROUP BY hour_start, machine_id, shift_id ORDER BY hour_start`, s.params
    ),

    /* Each machine's target for a shift: the target quantity on its current
       job — the same figure the live dashboard measures a shift against. */
    db.query(`
      SELECT j.machine_id, j.target_qty::numeric AS target,
             COALESCE(c.multiplication_factor, 1)::numeric AS mult
        FROM machine_current_job j
        JOIN machines m ON m.id = j.machine_id AND m.company_id = $1 AND m.is_active
        LEFT JOIN components c ON c.id = j.component_id
       WHERE j.is_active = TRUE
         ${machineId ? 'AND j.machine_id = $2' : ''}`,
      machineId ? [companyId, machineId] : [companyId]
    ),

    /* yesterday's energy and output, for the "vs yesterday" comparisons */
    db.query(`
      SELECT COALESCE(SUM(energy_kwh),0)::float AS kwh,
             COALESCE(SUM(produced_qty),0)::int AS produced
        FROM production_hourly
       WHERE company_id = $1
         AND hour_start >= ($2::date - 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
         AND hour_start <  ($2::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
         ${machineId ? 'AND machine_id = $3' : ''}`,
      machineId ? [companyId, win.day, machineId] : [companyId, win.day]
    )
  ]);

  const settings   = settingsRes.rows[0] || {};
  const rate       = Number(settings.energy_rate_per_kwh || 0);
  const prod       = prodRes.rows[0];

  /* month-to-date energy, for the monthly cost figure, and the same days
     of last month for the "vs last month" comparison */
  const monthRes = await db.query(`
    SELECT COALESCE(SUM(energy_kwh) FILTER (
             WHERE hour_start >= date_trunc('month', $2::date)
               AND hour_start <  (date_trunc('month', $2::date) + INTERVAL '1 month')), 0)::float AS kwh,
           COALESCE(SUM(energy_kwh) FILTER (
             WHERE hour_start >= date_trunc('month', $2::date) - INTERVAL '1 month'
               AND hour_start <  ($2::date - INTERVAL '1 month' + INTERVAL '1 day')), 0)::float AS prev_kwh
    FROM production_hourly
    WHERE company_id = $1
      AND hour_start >= date_trunc('month', $2::date) - INTERVAL '1 month'
      AND hour_start <  (date_trunc('month', $2::date) + INTERVAL '1 month')
      ${machineId ? 'AND machine_id = $3' : ''}`,
    machineId ? [companyId, win.day, machineId] : [companyId, win.day]
  );

  /* ── OEE: the OEE Dashboard's own sums ── */
  const derived = machineTotals.map(r => oeeSvc.deriveOee(r, oeeSvc.DEFAULT_THRESHOLDS));
  const fleet = oeeSvc.fleetOee(derived, oeeSvc.DEFAULT_THRESHOLDS);

  /* ── targets ── */
  const targetOf = new Map(targetRes.rows.map(r => [r.machine_id, { target: Number(r.target) || 0, mult: Number(r.mult) || 1 }]));
  const multOf = id => targetOf.get(id)?.mult || 1;
  const shiftTarget = [...targetOf.values()].reduce((a, t) => a + t.target, 0);
  const targetMachines = [...targetOf.entries()].filter(([, t]) => t.target > 0).map(([id]) => id);

  /* One row per shift: all output (as before), and the output of machines
     with a target set against the sum of those targets. */
  const shifts = new Map();
  for (const r of shiftRes.rows) {
    const e = shifts.get(r.shift_id) || {
      shift_id: r.shift_id, shift_code: r.shift_code, shift_name: r.shift_name,
      start_time: r.start_time, end_time: r.end_time, produced: 0, actual: 0
    };
    e.produced += r.produced;
    if (r.machine_id && targetMachines.includes(r.machine_id)) e.actual += Math.round(r.produced * multOf(r.machine_id));
    shifts.set(r.shift_id, e);
  }
  const shiftwise = [...shifts.values()].map(e => ({ ...e, target: shiftTarget || null }));

  /* Overall production against target, over the shifts in the window. */
  const inScope = win.shift ? shiftwise.filter(r => r.shift_id === win.shift.id) : shiftwise;
  const actualInScope = inScope.reduce((a, r) => a + r.actual, 0);
  const targetInScope = shiftTarget * inScope.length;

  /* Hourly trend: output in parts, and each hour's share of the targets —
     a shift's target spread evenly over its hours. */
  const shiftHours = new Map(shiftwise.map(r => {
    const [sh, sm] = String(r.start_time).split(':').map(Number);
    const [eh, em] = String(r.end_time).split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;                       // overnight
    return [r.shift_id, mins / 60];
  }));
  /* Rows start on the hour and on the half hour (older rows were cut on
     IST hours, newer ones on UTC hours), so bucket by the IST clock hour —
     otherwise every hour is drawn twice. */
  const IST = 5.5 * 3600 * 1000, HOUR = 3600 * 1000;
  const byHour = new Map();
  for (const r of energyRes.rows) {
    const t = new Date(r.hour_start).getTime();
    const bucket = new Date(Math.floor((t + IST) / HOUR) * HOUR - IST);
    const key = bucket.toISOString();
    const e = byHour.get(key) || { hour: bucket, kwh: 0, produced: 0, shift_id: r.shift_id };
    e.kwh += r.kwh;
    e.produced += Math.round(r.produced * multOf(r.machine_id));
    byHour.set(key, e);
  }
  const trend = [...byHour.values()].map(e => {
    const hrs = shiftHours.get(e.shift_id);
    return {
      hour: e.hour,
      kwh: Number(e.kwh.toFixed(3)),
      produced: e.produced,
      target: shiftTarget && hrs ? Math.round(shiftTarget / hrs) : null
    };
  });

  const yday = yesterdayRes.rows[0] || { kwh: 0, produced: 0 };
  const pctChange = (now, before) => (before > 0 ? Number((((now - before) / before) * 100).toFixed(1)) : null);
  const perPart = (kwh, produced) => (rate && produced > 0 ? Number(((kwh * rate) / produced).toFixed(2)) : null);

  const alarmBy = Object.fromEntries(alarmRes.rows.map(r => [r.class, r]));
  const dtRows  = downtimeRes.rows;
  const dtTotal = dtRows.reduce((a, r) => a + r.seconds, 0);

  return {
    filters: {
      date: win.day,
      shift_id: win.shift?.id || null,
      shift_code: win.shift?.shift_code || null,
      machine_id: machineId
    },
    updated_at: new Date().toISOString(),

    machines: machineRes.rows[0],

    production: {
      produced: prod.produced,
      // against the job targets of the machines that have one; null when none do
      actual: actualInScope,
      target: targetInScope || null,
      target_pct: targetInScope > 0 ? Number(((actualInScope / targetInScope) * 100).toFixed(1)) : null,
      machines_with_target: targetMachines.length
    },

    time: {
      run_seconds:  prod.run_seconds,
      idle_seconds: prod.idle_seconds,
      down_seconds: dtTotal
    },

    // null, not 0, when a factor cannot be measured (no cycle time, nothing made)
    oee: {
      availability: fleet.availability_pct,
      performance:  fleet.performance_pct,
      quality:      fleet.quality_pct,
      oee:          fleet.oee_pct,
      target:       Number(settings.oee_target_percent || 85),
      machines_measurable: fleet.machines_measurable
    },

    energy: {
      kwh:        Number(prod.energy_kwh.toFixed(3)),
      month_kwh:  Number((monthRes.rows[0]?.kwh || 0).toFixed(3)),
      currency:   settings.currency || 'INR',
      rate_per_kwh: rate || null,
      // null, not 0, when no tariff is configured — a zero here would
      // read as "electricity is free" rather than "not set up yet"
      cost_day:   rate ? Number((prod.energy_kwh * rate).toFixed(2)) : null,
      cost_month: rate ? Number(((monthRes.rows[0]?.kwh || 0) * rate).toFixed(2)) : null,
      // comparisons, null when there is nothing to compare against
      day_vs_yesterday_pct:   pctChange(prod.energy_kwh, yday.kwh),
      month_vs_last_pct:      pctChange(monthRes.rows[0]?.kwh || 0, monthRes.rows[0]?.prev_kwh || 0),
      cost_per_part:          perPart(prod.energy_kwh, prod.produced),
      cost_per_part_vs_yesterday_pct: pctChange(perPart(prod.energy_kwh, prod.produced) || 0, perPart(yday.kwh, yday.produced) || 0)
    },

    shiftwise,

    downtime: {
      total_seconds:     dtTotal,
      planned_seconds:   dtRows.filter(r => r.category === 'PLANNED').reduce((a, r) => a + r.seconds, 0),
      unplanned_seconds: dtRows.filter(r => r.category !== 'PLANNED').reduce((a, r) => a + r.seconds, 0),
      by_reason:         dtRows
    },

    alarms: {
      total:        alarmRes.rows.reduce((a, r) => a + r.count, 0),
      critical:     alarmBy.CRITICAL?.count     || 0,
      non_critical: alarmBy.NON_CRITICAL?.count || 0,
      information:  alarmBy.INFORMATION?.count  || 0,
      open:         alarmRes.rows.reduce((a, r) => a + r.open, 0)
    },

    trend
  };
};
