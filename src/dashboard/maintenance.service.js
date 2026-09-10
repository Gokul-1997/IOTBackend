/*
 * Phase 2 · Screen 2 — Maintenance Dashboard.
 *
 * Machine-condition view: how healthy the fleet is right now, what is
 * alarming, and per-machine detail for whatever the operator selected.
 *
 * SCOPE NOTE — read before adding widgets.
 * The agreement also asks for servo load per axis, machine temperature,
 * CNC/APC battery voltage, insulation resistance (+ its trend) and cooling
 * fan / amplifier status. None of those exist: telemetry_raw carries 19
 * columns and none of them is a servo, temperature, battery, insulation or
 * fan reading, and no other table in the database has one either. The MQTT
 * collector that writes telemetry_raw is not in this repository, so adding
 * them is a change to that service plus a migration, not a change here.
 * Those panels are deliberately absent rather than filled with invented
 * numbers. See the Phase 2 gap list.
 *
 * Everything below reads the same rollup tables as Screens 1 and the
 * machine dashboard (production_hourly, oee_hourly) so the three always
 * agree with each other.
 */
const db = require('../db');
const { resolveWindow, scope, parseMachineId } = require('./window');

/* Stored as LOW/MEDIUM/HIGH/CRITICAL; the agreement asks for
   Critical / Non-Critical / Information. */
const SEVERITY_CLASS = `
  CASE
    WHEN severity = 'CRITICAL'         THEN 'CRITICAL'
    WHEN severity IN ('HIGH','MEDIUM') THEN 'NON_CRITICAL'
    ELSE 'INFORMATION'
  END`;

/*
 * Any telemetry_raw read needs a received_at bound. It is a Timescale
 * hypertable with ~180 chunks; without one the planner cannot prune and a
 * DISTINCT ON walks every chunk — measured at over 227 seconds on this
 * database against ~20ms bounded. An hour is far wider than the 60s
 * freshness rule, so it cannot change any machine's computed state.
 */
const TELEMETRY_LOOKBACK = `INTERVAL '1 hour'`;
const FRESH_WINDOW       = `INTERVAL '60 seconds'`;

exports.getMaintenanceDashboard = async (req) => {
  const companyId = req.user.company_id;
  const machineId = parseMachineId(req.query.machine_id);
  const win       = await resolveWindow(companyId, req.query);
  const s         = scope(companyId, win, machineId);

  const alarmParams = machineId
    ? [companyId, win.from, win.to, machineId]
    : [companyId, win.from, win.to];

  const [healthRes, rowsRes, alarmRes, oeeRes, prodRes, trendRes] = await Promise.all([

    /* fleet health: how many machines are reporting and not alarming.
       "Health" is not defined in the agreement, so it is stated plainly
       here — a machine counts as healthy when it has sent telemetry within
       the freshness window and is not currently in alarm. */
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (t.machine_id)
               t.machine_id, t.machine_status, t.alarm, t.received_at
        FROM telemetry_raw t
        JOIN machines m ON m.id = t.machine_id
        WHERE m.company_id = $1 AND m.is_active
          AND t.received_at > NOW() - ${TELEMETRY_LOOKBACK}
          ${machineId ? 'AND t.machine_id = $2' : ''}
        ORDER BY t.machine_id, t.received_at DESC
      ),
      fresh AS (
        SELECT * FROM latest WHERE received_at > NOW() - ${FRESH_WINDOW}
      ),
      counted AS (
        SELECT
          COUNT(*) FILTER (WHERE alarm IS TRUE)::int                                    AS breakdown,
          COUNT(*) FILTER (WHERE alarm IS NOT TRUE AND machine_status = 'RUNNING')::int AS running,
          COUNT(*) FILTER (WHERE alarm IS NOT TRUE AND machine_status = 'IDLE')::int    AS idle
        FROM fresh
      )
      SELECT
        tot.total,
        c.running, c.idle, c.breakdown,
        (tot.total - c.running - c.idle - c.breakdown)::int AS offline
      FROM counted c
      CROSS JOIN (
        SELECT COUNT(*)::int AS total FROM machines
        WHERE company_id = $1 AND is_active ${machineId ? 'AND id = $2' : ''}
      ) tot`,
      machineId ? [companyId, machineId] : [companyId]
    ),

    /* per-machine detail: what is on the machine and who is running it.
       LEFT JOINs throughout — a machine with no job, no component or no
       operator still has to appear in the list, just with blanks.

       The operator comes through a LATERAL rather than a plain join: a
       machine can carry several active operator assignments (machine 15 has
       three on this database), and joining them directly would emit that
       machine once per operator and inflate the list. */
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (t.machine_id)
               t.machine_id, t.machine_status, t.alarm, t.spindle_load,
               t.feed_rate, t.received_at
        FROM telemetry_raw t
        JOIN machines m ON m.id = t.machine_id
        WHERE m.company_id = $1 AND m.is_active
          AND t.received_at > NOW() - ${TELEMETRY_LOOKBACK}
          ${machineId ? 'AND t.machine_id = $4' : ''}
        ORDER BY t.machine_id, t.received_at DESC
      ),
      runtime AS (
        SELECT machine_id, SUM(run_seconds)::int AS run_seconds
        FROM production_hourly
        WHERE company_id = $1 AND hour_start >= $2 AND hour_start < $3
          ${machineId ? 'AND machine_id = $4' : ''}
        GROUP BY machine_id
      )
      SELECT
        m.id AS machine_id,
        m.machine_serial_no,
        j.component_id,
        j.part_name,
        j.target_qty,
        op.operator_name,
        l.machine_status,
        l.alarm,
        l.spindle_load,
        l.feed_rate,
        l.received_at,
        COALESCE(rt.run_seconds, 0)::int AS run_seconds
      FROM machines m
      LEFT JOIN latest  l  ON l.machine_id  = m.id
      LEFT JOIN runtime rt ON rt.machine_id = m.id
      LEFT JOIN machine_current_job j
             ON j.machine_id = m.id AND j.is_active = TRUE
      LEFT JOIN LATERAL (
        SELECT o.operator_name
        FROM operator_machine_assignments oma
        JOIN operators o ON o.id = oma.operator_id
        WHERE oma.machine_id = m.id AND oma.is_active = TRUE
        ORDER BY oma.assigned_from DESC NULLS LAST, oma.id DESC
        LIMIT 1
      ) op ON TRUE
      WHERE m.company_id = $1 AND m.is_active
        ${machineId ? 'AND m.id = $4' : ''}
      ORDER BY m.machine_serial_no`,
      machineId
        ? [companyId, win.from, win.to, machineId]
        : [companyId, win.from, win.to]
    ),

    /* alarm summary for the window, split the way the agreement asks */
    db.query(`
      SELECT ${SEVERITY_CLASS} AS class,
             COUNT(*)::int                                        AS total,
             COUNT(*) FILTER (WHERE is_resolved IS NOT TRUE)::int  AS open
      FROM machine_alarms
      WHERE company_id = $1 AND started_at >= $2 AND started_at < $3
        ${machineId ? 'AND machine_id = $4' : ''}
      GROUP BY 1`, alarmParams
    ),

    /* average OEE across the window */
    db.query(`
      SELECT ROUND(AVG(availability)::numeric,2)::float AS availability,
             ROUND(AVG(performance)::numeric,2)::float  AS performance,
             ROUND(AVG(quality)::numeric,2)::float      AS quality,
             ROUND(AVG(oee)::numeric,2)::float          AS oee
      FROM oee_hourly WHERE ${s.sql}`, s.params
    ),

    /* production status for the window */
    db.query(`
      SELECT COALESCE(SUM(produced_qty),0)::int AS produced,
             COALESCE(SUM(run_seconds),0)::int  AS run_seconds,
             COALESCE(SUM(idle_seconds),0)::int AS idle_seconds
      FROM production_hourly WHERE ${s.sql}`, s.params
    ),

    /* cycle-time trend: seconds of cutting per part, hour by hour.
       NULLIF guards the hours where nothing was produced — dividing by a
       zero part count would make the chart spike to infinity. */
    db.query(`
      SELECT hour_start,
             COALESCE(SUM(produced_qty),0)::int AS produced,
             ROUND((SUM(run_seconds)::numeric / NULLIF(SUM(produced_qty),0)), 1)::float
               AS avg_cycle_seconds
      FROM production_hourly WHERE ${s.sql}
      GROUP BY hour_start ORDER BY hour_start`, s.params
    )
  ]);

  const machines = healthRes.rows[0] || { total: 0, running: 0, idle: 0, breakdown: 0, offline: 0 };

  /* healthy = reporting and not alarming. Stated explicitly because the
     agreement asks for "machine health as a percentage" without defining it. */
  const healthy = machines.running + machines.idle;
  const health  = {
    healthy,
    unhealthy: machines.total - healthy,
    percent:   machines.total ? Math.round((healthy / machines.total) * 100) : 0,
    basis:     'Reporting within 60s and not in alarm'
  };

  const alarms = { total: 0, open: 0, critical: 0, non_critical: 0, information: 0 };
  for (const r of alarmRes.rows) {
    alarms.total += r.total;
    alarms.open  += r.open;
    if (r.class === 'CRITICAL')          alarms.critical     = r.total;
    else if (r.class === 'NON_CRITICAL') alarms.non_critical = r.total;
    else                                 alarms.information  = r.total;
  }

  return {
    filters: {
      date:       win.day,
      shift_id:   win.shift ? win.shift.id : null,
      shift_code: win.shift ? win.shift.shift_code : null,
      machine_id: machineId
    },
    updated_at: new Date().toISOString(),
    machines,
    health,
    alarms,
    oee:        oeeRes.rows[0]  || { availability: null, performance: null, quality: null, oee: null },
    production: prodRes.rows[0] || { produced: 0, run_seconds: 0, idle_seconds: 0 },
    rows:       rowsRes.rows,
    cycle_time_trend: trendRes.rows,

    /* Named so the client can say what is missing rather than render an
       empty panel with no explanation. */
    unavailable: [
      'servo_load_per_axis',
      'machine_temperature',
      'battery_status',
      'insulation_resistance',
      'fan_amplifier_status'
    ]
  };
};
