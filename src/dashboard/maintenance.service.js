/*
 * Phase 2 · Screen 2 — Maintenance Dashboard.
 *
 * Machine-condition view: how healthy the fleet is right now, what is
 * alarming, and per-machine detail for whatever the operator selected.
 *
 * Condition signals come from the FOCAS collector (pms-backend, columns added
 * by migration 021): spindle speed/load/temperature, servo load and
 * temperature per axis, encoder temperature, insulation resistance, CNC/APC
 * battery voltage, the battery alarm per axis (migration 032) and fan status.
 * Controllers differ in what they supply — in September 2026 no machine sent
 * insulation resistance, batteries or fans; from October some send fans as
 * {on, fault, rpm} and the battery as a flag per axis, with no voltage — so
 * every value is nullable and `unavailable` names the signals no machine has
 * reported. The screen draws a "not reported" state for those, never an
 * invented number.
 *
 * Everything below reads the same rollup tables as Screens 1 and the
 * machine dashboard (production_hourly, oee_hourly) so the three always
 * agree with each other.
 */
const db = require('../db');
const { severityClass } = require('./severity');
const { resolveWindow, scope, parseMachineId } = require('./window');
const oeeSvc = require('./oee.dashboard.service');
const { LIMITS: METER_LIMITS } = require('./energy-meter.service');

/* Critical / Non-Critical / Information — one definition, see severity.js. */
const SEVERITY_CLASS = severityClass('severity');

/*
 * Any telemetry_raw read needs a received_at bound. It is a Timescale
 * hypertable with ~180 chunks; without one the planner cannot prune and a
 * DISTINCT ON walks every chunk — measured at over 227 seconds on this
 * database against ~20ms bounded. An hour is far wider than the 60s
 * freshness rule, so it cannot change any machine's computed state.
 */
const TELEMETRY_LOOKBACK = `INTERVAL '1 hour'`;
/* For one selected machine the readings are its latest within the selected
   day or shift instead: after a machine stops, the screen keeps showing its
   last condition (with the time it was taken) rather than going blank an
   hour later. One machine over one day is bounded and indexed — ~0.1 s
   measured on production. */
const FRESH_WINDOW       = `INTERVAL '60 seconds'`;

/*
 * The battery flag per axis is migration 032's column. Until that has run,
 * the latest-reading query is tried again with the column read as NULL, so
 * the screen keeps working and this build can go out before the migration —
 * as energy-meter.service does for 029's table.
 */
/*
 * The supply voltage, from the machine's energy meter (migration 029 keeps
 * every PowerData value): each phase to neutral (L-N) and each pair of
 * phases (L-L), as the embedded team asked them shown — two groups, not the
 * one line-to-line average telemetry_raw keeps. Only a machine with a meter
 * has a reading; before 029 there is no table and so no meter yet.
 */
const SUPPLY_STALE_MS = 120e3;   // the meter writes at most every 15 s
async function latestSupply(companyId, machineId, from, to) {
  try {
    return await db.query(`
      SELECT r.read_at, r.v1n, r.v2n, r.v3n, r.v_ln_avg, r.v12, r.v23, r.v31, r.v_ll_avg
        FROM energy_meter_readings r
        JOIN machines m ON m.id = r.machine_id AND m.company_id = $1
       WHERE r.machine_id = $4 AND r.read_at >= $2 AND r.read_at < $3
       ORDER BY r.read_at DESC
       LIMIT 1`, [companyId, from, to, machineId]);
  } catch (err) {
    if (err?.code === '42P01') return { rows: [] };
    throw err;
  }
}

/** The latest meter reading as the screen shows it: two groups of three phases, their averages, and the limits they are judged by. */
function supplyOf(r, nowMs = Date.now()) {
  if (!r) return null;
  const n = v => (v === null || v === undefined ? null : Number(v));
  const at = new Date(r.read_at).getTime();
  return {
    read_at: r.read_at,
    stale: !Number.isFinite(at) || nowMs - at > SUPPLY_STALE_MS,
    ln: { v1n: n(r.v1n), v2n: n(r.v2n), v3n: n(r.v3n), avg: n(r.v_ln_avg) },
    ll: { v12: n(r.v12), v23: n(r.v23), v31: n(r.v31), avg: n(r.v_ll_avg) },
    limits: {
      ll_nominal: METER_LIMITS.v_ll_nominal,
      // phase to neutral on the same supply: 415 / √3
      ln_nominal: Math.round(METER_LIMITS.v_ll_nominal / Math.sqrt(3)),
      tolerance_pct: METER_LIMITS.v_tolerance_pct,
      imbalance_pct: METER_LIMITS.v_imbalance_pct
    }
  };
}

async function withBatteryFlags(query) {
  try {
    return await query('t.apc_battery_status');
  } catch (err) {
    if (err?.code !== '42703' || !/apc_battery_status/.test(err.message || '')) throw err;
    return query('NULL::jsonb AS apc_battery_status');
  }
}

exports.getMaintenanceDashboard = async (req) => {
  const companyId = req.user.company_id;
  const machineId = parseMachineId(req.query.machine_id);
  const win       = await resolveWindow(companyId, req.query);
  const s         = scope(companyId, win, machineId);

  const alarmParams = machineId
    ? [companyId, win.from, win.to, machineId]
    : [companyId, win.from, win.to];

  const [healthRes, rowsRes, alarmRes, oeeRes, prodRes, conditionRes, cycleRes, supplyRes] = await Promise.all([

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
    withBatteryFlags(flags => db.query(`
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
               t.fan_status, ${flags}
        FROM telemetry_raw t
        JOIN machines m ON m.id = t.machine_id
        WHERE m.company_id = $1 AND m.is_active
          ${machineId
            ? 'AND t.machine_id = $4 AND t.received_at >= $2 AND t.received_at < $3'
            : `AND t.received_at > NOW() - ${TELEMETRY_LOOKBACK}`}
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
        m.image_url,
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
        l.fan_status, l.apc_battery_status,
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
    )),

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

    /* OEE over the window, worked out as the OEE Dashboard does (summed
       run/planned time, output, rejects; performance from the job's cycle
       time). Averaging oee_hourly read 0 — an hour with no parts has no
       performance — while the OEE Dashboard showed the real figure. */
    oeeSvc.machineTotals({ companyId, machineId, shiftId: win.shift ? win.shift.id : null, start: win.from, end: win.to }),

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
      : Promise.resolve({ rows: [] }),

    /* cycle time, hour by hour: run time over parts made in that hour, for
       the one machine selected. An hour with no part has no cycle time
       (null), not a cycle of zero. */
    machineId
      ? db.query(`
          SELECT hour_start,
                 COALESCE(SUM(produced_qty), 0)::int AS produced,
                 COALESCE(SUM(run_seconds), 0)::int  AS run_seconds
            FROM production_hourly
           WHERE ${s.sql}
           GROUP BY hour_start ORDER BY hour_start`, s.params)
      : Promise.resolve({ rows: [] }),

    /* the supply voltage on the one machine selected: its meter's latest
       reading within the day or shift, like every other reading here */
    machineId
      ? latestSupply(companyId, machineId, win.from, win.to)
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
    oee:        oeeOf(oeeRes),
    production: prodRes.rows[0] || { produced: 0, run_seconds: 0, idle_seconds: 0 },
    rows:       rowsRes.rows,
    condition_trend: conditionRes.rows,
    cycle_trend: cycleTrend(cycleRes.rows),
    supply:     supplyOf(supplyRes.rows[0]),

    /* Measured, not declared. This used to be a fixed list, true only while
       nothing could store these signals. Now a signal is named here when no
       machine in the selection has reported any value for it — so the list
       shrinks by itself as controllers start supplying data, and a signal
       one machine lacks does not hide another machine's readings. */
    unavailable: unavailableSignals(rowsRes.rows)
  };
};

/** Hourly cycle time in seconds: run time per part, null for an hour with none. */
function cycleTrend(rows) {
  return (Array.isArray(rows) ? rows : []).map(r => {
    const produced = Number(r.produced) || 0;
    const run = Number(r.run_seconds) || 0;
    return {
      hour_start: r.hour_start,
      produced,
      cycle_seconds: produced > 0 ? Math.round((run / produced) * 10) / 10 : null
    };
  });
}

exports.cycleTrend = cycleTrend;
exports.supplyOf = supplyOf;

/** The machine totals as the four OEE figures, null where unmeasurable. */
function oeeOf(machineRows) {
  const f = oeeSvc.fleetOee(machineRows.map(r => oeeSvc.deriveOee(r, oeeSvc.DEFAULT_THRESHOLDS)), oeeSvc.DEFAULT_THRESHOLDS);
  return { availability: f.availability_pct, performance: f.performance_pct, quality: f.quality_pct, oee: f.oee_pct };
}

/* Which telemetry columns back each condition signal on Screen 2. */
const SIGNAL_COLUMNS = {
  servo_load_per_axis:   ['servo_load_x', 'servo_load_y', 'servo_load_z'],
  servo_temperature:     ['servo_temp_x', 'servo_temp_y', 'servo_temp_z'],
  spindle_temperature:   ['spindle_motor_temp'],
  encoder_temperature:   ['encoder_temp_x', 'encoder_temp_y', 'encoder_temp_z'],
  battery_status:        ['cnc_battery_voltage', 'apc_battery_voltage', 'apc_battery_status'],
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
