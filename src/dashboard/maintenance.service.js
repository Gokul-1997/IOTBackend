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
const { resolveWindow, scope, scopeViaMachine, parseMachineId } = require('./window');

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
  const sm        = scopeViaMachine(companyId, win, machineId);

  const alarmParams = machineId
    ? [companyId, win.from, win.to, machineId]
    : [companyId, win.from, win.to];

  const [healthRes, rowsRes, alarmRes, oeeRes, prodRes, conditionRes] = await Promise.all([

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
               t.feed_rate, t.received_at,
               t.spindle_speed, t.spindle_motor_temp, t.spindle_insulation_res,
               t.servo_load_x, t.servo_load_y, t.servo_load_z,
               t.servo_temp_x, t.servo_temp_y, t.servo_temp_z,
               t.encoder_temp_x, t.encoder_temp_y, t.encoder_temp_z,
               t.servo_insulation_res_x, t.servo_insulation_res_y, t.servo_insulation_res_z,
               t.servo_pulse_x, t.servo_pulse_y, t.servo_pulse_z,
               t.cnc_battery_voltage, t.apc_battery_voltage, t.sequence_number,
               t.fan_status
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
        l.spindle_speed, l.spindle_motor_temp, l.spindle_insulation_res,
        l.servo_load_x, l.servo_load_y, l.servo_load_z,
        l.servo_temp_x, l.servo_temp_y, l.servo_temp_z,
        l.encoder_temp_x, l.encoder_temp_y, l.encoder_temp_z,
        l.servo_insulation_res_x, l.servo_insulation_res_y, l.servo_insulation_res_z,
        l.servo_pulse_x, l.servo_pulse_y, l.servo_pulse_z,
        l.cnc_battery_voltage, l.apc_battery_voltage, l.sequence_number,
        l.fan_status,
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
      /* Scoped through the machine — oee_hourly.company_id is NULL on
         almost every row, so the company filter matched nothing and this
         tile read 0% for every company. */
      SELECT ROUND(AVG(o.availability)::numeric,2)::float AS availability,
             ROUND(AVG(o.performance)::numeric,2)::float  AS performance,
             ROUND(AVG(o.quality)::numeric,2)::float      AS quality,
             ROUND(AVG(o.oee)::numeric,2)::float          AS oee
      FROM oee_hourly o
      JOIN machines m ON m.id = o.machine_id
      WHERE ${sm.sql}`, sm.params
    ),

    /* production status for the window */
    db.query(`
      SELECT COALESCE(SUM(produced_qty),0)::int AS produced,
             COALESCE(SUM(run_seconds),0)::int  AS run_seconds,
             COALESCE(SUM(idle_seconds),0)::int AS idle_seconds
      FROM production_hourly WHERE ${s.sql}`, s.params
    ),

    /* condition trend: servo and spindle temperature and insulation
       resistance, hour by hour, for one machine.

       Only when a machine is selected. Averaging servo temperatures across
       a fleet produces a number that describes no motor, and the scan —
       every telemetry row for every machine across the window — is the
       most expensive query this screen could run. The received_at bounds
       are what let TimescaleDB prune to the window's chunks. */
    machineId
      ? db.query(`
          SELECT date_trunc('hour', t.received_at)              AS hour_start,
                 ROUND(AVG(t.servo_temp_x)::numeric, 1)::float  AS servo_temp_x,
                 ROUND(AVG(t.servo_temp_y)::numeric, 1)::float  AS servo_temp_y,
                 ROUND(AVG(t.servo_temp_z)::numeric, 1)::float  AS servo_temp_z,
                 ROUND(AVG(t.spindle_motor_temp)::numeric, 1)::float AS spindle_motor_temp,
                 ROUND(AVG(t.servo_insulation_res_x)::numeric, 1)::float AS servo_insulation_res_x,
                 ROUND(AVG(t.servo_insulation_res_y)::numeric, 1)::float AS servo_insulation_res_y,
                 ROUND(AVG(t.servo_insulation_res_z)::numeric, 1)::float AS servo_insulation_res_z
            FROM telemetry_raw t
            JOIN machines m ON m.id = t.machine_id AND m.company_id = $1
           WHERE t.machine_id = $4
             AND t.received_at >= $2 AND t.received_at < $3
           GROUP BY 1 ORDER BY 1`,
          [companyId, win.from, win.to, machineId])
      : Promise.resolve({ rows: [] })
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
    condition_trend: conditionRes.rows,

    /* Measured, not declared. This used to be a fixed list, true only while
       nothing could store these signals. Now a signal is named here when no
       machine in the selection has reported any value for it — so the list
       shrinks by itself as controllers start supplying data, and a signal
       one machine lacks does not hide another machine's readings. */
    unavailable: unavailableSignals(rowsRes.rows)
  };
};

/* Which telemetry columns back each condition signal on Screen 2. */
const SIGNAL_COLUMNS = {
  servo_load_per_axis:   ['servo_load_x', 'servo_load_y', 'servo_load_z'],
  servo_temperature:     ['servo_temp_x', 'servo_temp_y', 'servo_temp_z'],
  spindle_temperature:   ['spindle_motor_temp'],
  encoder_temperature:   ['encoder_temp_x', 'encoder_temp_y', 'encoder_temp_z'],
  battery_status:        ['cnc_battery_voltage', 'apc_battery_voltage'],
  insulation_resistance: ['spindle_insulation_res', 'servo_insulation_res_x',
                          'servo_insulation_res_y', 'servo_insulation_res_z'],
  fan_amplifier_status:  ['fan_status']
};

/**
 * Signals no machine in `rows` has any value for.
 *
 * A signal counts as available if a single axis on a single machine
 * reports it: one servo with a temperature sensor is enough for the panel
 * to exist, and the other axes then show as "--" rather than hiding the
 * reading that is there.
 */
function unavailableSignals(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return Object.entries(SIGNAL_COLUMNS)
    .filter(([, cols]) => !list.some(r => cols.some(c => r?.[c] !== null && r?.[c] !== undefined)))
    .map(([key]) => key);
}

exports.unavailableSignals = unavailableSignals;
exports.SIGNAL_COLUMNS = SIGNAL_COLUMNS;
