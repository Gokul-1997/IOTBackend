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
    settingsRes, machineRes, prodRes, oeeRes,
    shiftRes, downtimeRes, alarmRes, energyRes, planRes
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

    /* OEE averaged across the window */
    db.query(`
      SELECT ROUND(AVG(availability)::numeric,2)::float AS availability,
             ROUND(AVG(performance)::numeric,2)::float  AS performance,
             ROUND(AVG(quality)::numeric,2)::float      AS quality,
             ROUND(AVG(oee)::numeric,2)::float          AS oee
      FROM oee_hourly WHERE ${s.sql}`, s.params
    ),

    /* shift-wise production bar chart (whole day, ignores shift filter
       on purpose — the point of the chart is to compare shifts) */
    db.query(`
      SELECT sh.shift_code,
             COALESCE(SUM(p.produced_qty),0)::int AS produced
      FROM shifts sh
      LEFT JOIN production_hourly p
        ON p.shift_id = sh.id
       AND p.company_id = sh.company_id
       AND p.hour_start >= $2 AND p.hour_start < $3
       ${machineId ? 'AND p.machine_id = $4' : ''}
      WHERE sh.company_id = $1 AND sh.is_active
      GROUP BY sh.id, sh.shift_code
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

    /* hourly energy + production trend */
    db.query(`
      SELECT hour_start,
             COALESCE(SUM(energy_kwh),0)::float AS kwh,
             COALESCE(SUM(produced_qty),0)::int AS produced
      FROM production_hourly WHERE ${s.sql}
      GROUP BY hour_start ORDER BY hour_start`, s.params
    ),

    /* planned quantity for actual-vs-planned */
    db.query(`
      SELECT COALESCE(SUM(planned_qty),0)::int AS planned
      FROM production_plans
      WHERE company_id = $1 AND plan_date = $2::date
        ${machineId ? 'AND machine_id = $3' : ''}`,
      machineId ? [companyId, win.day, machineId] : [companyId, win.day]
    )
  ]);

  const settings   = settingsRes.rows[0] || {};
  const rate       = Number(settings.energy_rate_per_kwh || 0);
  const prod       = prodRes.rows[0];
  const planned    = planRes.rows[0]?.planned || 0;

  /* month-to-date energy, for the monthly cost figure */
  const monthRes = await db.query(`
    SELECT COALESCE(SUM(energy_kwh),0)::float AS kwh
    FROM production_hourly
    WHERE company_id = $1
      AND hour_start >= date_trunc('month', $2::date)
      AND hour_start <  (date_trunc('month', $2::date) + INTERVAL '1 month')
      ${machineId ? 'AND machine_id = $3' : ''}`,
    machineId ? [companyId, win.day, machineId] : [companyId, win.day]
  );

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
      planned,
      // "overall production percentage" — actual against plan
      percent: planned > 0 ? Number(((prod.produced / planned) * 100).toFixed(1)) : null
    },

    time: {
      run_seconds:  prod.run_seconds,
      idle_seconds: prod.idle_seconds,
      down_seconds: dtTotal
    },

    oee: {
      availability: oeeRes.rows[0]?.availability ?? 0,
      performance:  oeeRes.rows[0]?.performance  ?? 0,
      quality:      oeeRes.rows[0]?.quality      ?? 0,
      oee:          oeeRes.rows[0]?.oee          ?? 0,
      target:       Number(settings.oee_target_percent || 85)
    },

    energy: {
      kwh:        Number(prod.energy_kwh.toFixed(3)),
      month_kwh:  Number((monthRes.rows[0]?.kwh || 0).toFixed(3)),
      currency:   settings.currency || 'INR',
      rate_per_kwh: rate || null,
      // null, not 0, when no tariff is configured — a zero here would
      // read as "electricity is free" rather than "not set up yet"
      cost_day:   rate ? Number((prod.energy_kwh * rate).toFixed(2)) : null,
      cost_month: rate ? Number(((monthRes.rows[0]?.kwh || 0) * rate).toFixed(2)) : null
    },

    shiftwise: shiftRes.rows,

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

    trend: energyRes.rows.map(r => ({
      hour:     r.hour_start,
      kwh:      Number(r.kwh.toFixed(3)),
      produced: r.produced
    }))
  };
};
