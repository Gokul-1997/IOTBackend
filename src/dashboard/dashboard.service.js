const db = require('../db');
const redis = require('../redis');

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function calculateDuration(startMin, endMin) {
  if (startMin === endMin) return 1440; // 24h shift
  if (endMin > startMin) return endMin - startMin;
  return (1440 - startMin) + endMin; // night shift
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Number(totalSeconds || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

exports.dashboard = async (plant_id) => {

  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 8);

  /* ================= SHIFT ================= */

  const { rows: shiftRows } = await db.query(`
    SELECT id,shift_code,start_time,end_time,break_minutes
    FROM shifts
    WHERE plant_id=$1
      AND (
        (start_time<=end_time AND $2 BETWEEN start_time AND end_time)
        OR
        (start_time>end_time AND ($2>=start_time OR $2<=end_time))
      )
      AND is_active=TRUE
    LIMIT 1
  `, [plant_id, currentTime]);

  const shift = shiftRows[0];

  if (!shift) {
    return {
      shift: null,
      summary: { total: 0, running: 0, idle: 0 },
      machines: []
    };
  }

  /* ================= SHIFT TIME ================= */

  const today = now.toISOString().split('T')[0];
  let shiftStart;

  if (shift.start_time <= shift.end_time) {
    shiftStart = new Date(`${today}T${shift.start_time}`);
  } else {
    if (currentTime >= shift.start_time) {
      shiftStart = new Date(`${today}T${shift.start_time}`);
    } else {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      shiftStart = new Date(`${y.toISOString().split('T')[0]}T${shift.start_time}`);
    }
  }

  const startMin = timeToMinutes(shift.start_time);
  const endMin   = timeToMinutes(shift.end_time);

  const shiftDurationMinutes = calculateDuration(startMin, endMin);

  const shiftEnd = new Date(shiftStart);
  shiftEnd.setMinutes(shiftEnd.getMinutes() + shiftDurationMinutes);

  const effectiveNow = now > shiftEnd ? shiftEnd : now;

  const shiftElapsedMinutes =
    Math.max(0, Math.floor((effectiveNow - shiftStart) / 60000));

  const plannedMinutes =
    Math.max(0, shiftDurationMinutes - Number(shift.break_minutes || 0));

  /* ================= MACHINES ================= */

  const { rows: machines } = await db.query(`
    SELECT id,machine_serial_no,image_url
    FROM machines
    WHERE plant_id=$1
    AND is_active=TRUE
    ORDER BY id
  `, [plant_id]);

  const machineIds = machines.map(m => m.id);

  if (!machineIds.length) {
    return {
      shift: {
        shift_code: shift.shift_code,
        shiftElapsedMinutes,
        plannedMinutes
      },
      summary: { total: 0, running: 0, idle: 0 },
      machines: []
    };
  }

  /* ================= OPERATORS ================= */

  const { rows: operatorRows } = await db.query(`
    SELECT DISTINCT ON (oma.machine_id)
      oma.machine_id,
      o.operator_name
    FROM operator_machine_assignments oma
    JOIN operator_shift_assignments osa
      ON osa.operator_id=oma.operator_id
     AND osa.shift_id=$1
     AND osa.is_active=TRUE
    JOIN operators o
      ON o.id=oma.operator_id
     AND o.is_active=TRUE
    WHERE oma.machine_id=ANY($2)
      AND oma.is_active=TRUE
  `, [shift.id, machineIds]);

  const operatorMap = {};
  operatorRows.forEach(r => {
    operatorMap[r.machine_id] = r.operator_name;
  });

  /* ================= CURRENT JOB ================= */

  const { rows: jobRows } = await db.query(`
    SELECT machine_id,part_name,component_id,target_qty
    FROM machine_current_job
    WHERE machine_id=ANY($1)
    AND is_active=TRUE
  `, [machineIds]);

  const jobMap = {};
  jobRows.forEach(r => {
    jobMap[r.machine_id] = r;
  });

  /* ================= COMPONENT TARGET ================= */

  const { rows: componentRows } = await db.query(`
    SELECT j.machine_id,c.target
    FROM machine_current_job j
    JOIN components c ON c.id=j.component_id
    WHERE j.machine_id=ANY($1)
    AND j.is_active=TRUE
  `, [machineIds]);

  const componentMap = {};
  componentRows.forEach(r => {
    componentMap[r.machine_id] = Number(r.target || 0);
  });

  /* ================= PRODUCTION ================= */
  /*
   * FIX: shift_id alone repeats every day (same shift runs
   * daily with the same id). Without a date filter, SUM()
   * accumulates across ALL days for that shift — giving
   * inflated run_seconds / produced_qty totals.
   *
   * We add hour_start >= shiftStart AND hour_start < shiftEnd
   * to pin the query to THIS shift instance only.
   *
   * ⚠️  If your date column is named differently, change
   *     "hour_start" below to match:
   *       • created_at   → most common
   *       • hour_start    → if you store the hour bucket
   *       • shift_date   → if you store the date separately
   */

  const { rows: prodRows } = await db.query(`
    SELECT
      machine_id,
      SUM(run_seconds)  AS run_seconds,
      SUM(idle_seconds) AS idle_seconds,
      SUM(produced_qty) AS produced_qty
    FROM production_hourly
    WHERE machine_id = ANY($1)
      AND shift_id   = $2
      AND hour_start >= $3
      AND hour_start <  $4
    GROUP BY machine_id
  `, [machineIds, shift.id, shiftStart, shiftEnd]);

  const prodMap = {};
  prodRows.forEach(r => {
    prodMap[r.machine_id] = {
      run_seconds:  Number(r.run_seconds  || 0),
      idle_seconds: Number(r.idle_seconds || 0),
      produced_qty: Number(r.produced_qty || 0)
    };
  });

  /* ================= LIVE STATUS ================= */
  /*
   * Two scenarios for parts_count:
   *
   * 1. Machine resets at shift boundary (normal): parts_count goes 0→N during
   *    the shift. Use it directly — shiftStart filter handles isolation.
   *
   * 2. Machine resets MID-SHIFT (e.g. machine restart): parts_count drops from
   *    54 → 0 then climbs again. We detect each drop inside the shift window,
   *    accumulate the pre-reset values as an offset, and add it to the current
   *    reading: adjusted = offset + current_parts_count → shows 64 not 10.
   *
   * received_at is stored as a Unix epoch integer (seconds) in telemetry_raw.
   */

  const shiftStartEpoch = Math.floor(shiftStart.getTime() / 1000);

  const { rows: liveRows } = await db.query(`
    WITH shift_raw AS (
      SELECT
        machine_id,
        parts_count,
        received_at,
        LAG(parts_count) OVER (PARTITION BY machine_id ORDER BY received_at) AS prev_count
      FROM telemetry_raw
      WHERE machine_id = ANY($1)
        AND received_at >= to_timestamp($2)
    ),
    resets AS (
      SELECT machine_id, COALESCE(SUM(prev_count), 0) AS total_offset
      FROM shift_raw
      WHERE prev_count IS NOT NULL AND parts_count < prev_count
      GROUP BY machine_id
    ),
    latest AS (
      SELECT DISTINCT ON (machine_id)
        machine_id, machine_status, alarm, parts_count, received_at
      FROM telemetry_raw
      WHERE machine_id = ANY($1)
      ORDER BY machine_id, received_at DESC
    )
    SELECT
      l.machine_id,
      l.machine_status,
      l.alarm,
      l.received_at,
      l.parts_count + COALESCE(r.total_offset, 0) AS adjusted_parts_count,
      l.parts_count AS raw_parts_count
    FROM latest l
    LEFT JOIN resets r ON r.machine_id = l.machine_id
  `, [machineIds, shiftStartEpoch]);

  const liveMap = {};
  liveRows.forEach(r => {
    liveMap[r.machine_id] = {
      ...r,
      parts_count: Number(r.adjusted_parts_count || 0)
    };
  });

  /* ================= BUILD RESPONSE ================= */

  let total   = 0;
  let running = 0;
  let idle    = 0;

  const machinesList = [];

  for (const m of machines) {

    const live = liveMap[m.id] || {};
    const prod = prodMap[m.id] || {};
    const job  = jobMap[m.id]  || {};

    const rawStatus     = (live.machine_status || '').toUpperCase();
    const alarm         = live.alarm === true;

    const nowSec        = Math.floor(Date.now() / 1000);
    const receivedAtSec = Number(live.received_at || 0);

    const OFFLINE_THRESHOLD = 10;
    const freshDiff = receivedAtSec ? (nowSec - receivedAtSec) : null;

    let status = 'OFFLINE';

    if (receivedAtSec) {
      if (freshDiff > OFFLINE_THRESHOLD) {
        status = 'OFFLINE';
      } else if (['RUN', 'RUNNING', 'CUTTING'].includes(rawStatus)) {
        status = 'RUNNING';
      } else {
        status = 'IDLE';
      }
    }

    if (status === 'RUNNING') running++;
    else if (status === 'IDLE') idle++;

    total++;

    /* ===== REALTIME SECONDS ===== */

    let runSeconds  = Number(prod.run_seconds  || 0);
    let idleSeconds = Number(prod.idle_seconds || 0);

    if (receivedAtSec && freshDiff >= 0 && freshDiff <= 15) {
      if (status === 'RUNNING') {
        runSeconds  += freshDiff;
      } else if (status === 'IDLE') {
        idleSeconds += freshDiff;
      }
    }

    const maxSeconds = shiftElapsedMinutes * 60;

    runSeconds  = Math.min(runSeconds,  maxSeconds);
    idleSeconds = Math.min(idleSeconds, maxSeconds);

    const totalSeconds = runSeconds + idleSeconds;
    if (totalSeconds > maxSeconds) {
      idleSeconds = Math.max(0, maxSeconds - runSeconds);
    }

    const runMinutes  = Math.floor(runSeconds  / 60);
    const idleMinutes = Math.floor(idleSeconds / 60);

    const runTime  = formatDuration(runSeconds);
    const idleTime = formatDuration(idleSeconds);

    /* ================= UTILIZATION ================= */
    /*
     * Utilization = achieved_qty / target_qty × 100
     *
     * Example: 12hr shift, 1hr break → plannedMinutes=660
     *   achieved=35, target=60 → utilization = 35/60×100 = 58.33%
     *
     * target_qty comes from componentMap (components table).
     * achieved comes from parts_count (machine shift counter).
     *
     * FALLBACK: if no target is set (target=0), fall back to
     * time-based utilization: runMinutes / plannedMinutes × 100
     */

    const _target   = componentMap[m.id] || 0;
    const _achieved = status !== 'OFFLINE' && receivedAtSec
      ? Number(live.parts_count || 0)
      : Number(prod.produced_qty || 0);

    const _rawUtil = _target > 0
      ? (_achieved * 100) / _target
      : plannedMinutes > 0
        ? (Math.min(runSeconds / 60, shiftElapsedMinutes) * 100) / plannedMinutes
        : 0;

    // Cap at 100 — achieved can exceed target but utilization never goes over 100%
    const utilization = Number(Math.min(_rawUtil, 100).toFixed(2));

    /* ================= ACHIEVED QTY ================= */
    /*
     * parts_count IS the achieved_qty.
     * There is no separate achieved_qty column in telemetry_raw.
     *
     * The machine sends parts_count as a shift-scoped counter
     * (resets to 0 at shift start). Use it directly.
     *
     * FALLBACK: machine OFFLINE → use production_hourly.produced_qty
     */

    let achieved = 0;

    if (status !== 'OFFLINE' && receivedAtSec) {
      // PRIMARY: parts_count is the shift-scoped counter from machine
      achieved = Number(live.parts_count || 0);
    } else {
      // FALLBACK: machine offline, use production_hourly
      achieved = Number(prod.produced_qty || 0);
    }

    if (achieved < 0) achieved = 0;

    machinesList.push({
      machine_id:        m.id,
      machine_serial_no: m.machine_serial_no,
      image_url:         m.image_url,

      operator_name: operatorMap[m.id] || '--',

      part_name:    job.part_name    || null,
      component_id: job.component_id || null,

      status,
      alarm,

      run_minutes:  runMinutes,
      idle_minutes: idleMinutes,

      run_time:  runTime,
      idle_time: idleTime,

      produced_qty: prod.produced_qty || 0,

      utilization,

      target_qty: componentMap[m.id] || 0,

      achieved_qty: achieved
    });
  }

  return {
    shift: {
      shift_code: shift.shift_code,
      shiftElapsedMinutes,
      plannedMinutes
    },
    summary: { total, running, idle },
    machines: machinesList
  };
};

exports.machineDetail = async (plantId, machineId) => {
 
  try {
 
    /* ================= MACHINE ================= */
 
    const { rows: machineRows } = await db.query(`
      SELECT id, machine_serial_no, image_url
      FROM machines
      WHERE id = $1 AND plant_id = $2
    `, [machineId, plantId]);
 
    if (!machineRows.length) return null;
 
    const machine = machineRows[0];
 
    /* ================= CURRENT SHIFT ================= */
 
    const { rows: shiftRows } = await db.query(`
      SELECT id, shift_code, start_time, end_time
      FROM shifts
      WHERE plant_id = $1
      AND is_active = true
      AND (
        (start_time <= end_time AND
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time
         BETWEEN start_time AND end_time)
        OR
        (start_time > end_time AND
         (
           (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time >= start_time
           OR
           (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time <= end_time
         ))
      )
      LIMIT 1
    `, [plantId]);
 
    const shift = shiftRows[0] || null;
 
    /* ── Compute shiftStart / shiftEnd for date-scoped queries ── */
    let detailShiftStart = null;
    let detailShiftEnd   = null;
 
    if (shift) {
      const nowD         = new Date();
      const todayD       = nowD.toISOString().split('T')[0];
      const currentTimeD = nowD.toTimeString().slice(0, 8);
 
      if (shift.start_time <= shift.end_time) {
        detailShiftStart = new Date(`${todayD}T${shift.start_time}`);
      } else {
        if (currentTimeD >= shift.start_time) {
          detailShiftStart = new Date(`${todayD}T${shift.start_time}`);
        } else {
          const yd = new Date(nowD);
          yd.setDate(yd.getDate() - 1);
          detailShiftStart = new Date(`${yd.toISOString().split('T')[0]}T${shift.start_time}`);
        }
      }
 
      const startMinD = timeToMinutes(shift.start_time);
      const endMinD   = timeToMinutes(shift.end_time);
      const durationD = calculateDuration(startMinD, endMinD);
 
      detailShiftEnd = new Date(detailShiftStart);
      detailShiftEnd.setMinutes(detailShiftEnd.getMinutes() + durationD);
    }
 
    /* ================= OPERATOR ================= */
 
    const { rows: operatorRows } = await db.query(`
      SELECT o.operator_name
      FROM operator_machine_assignments a
      JOIN operators o ON o.id = a.operator_id
      WHERE a.machine_id = $1
      AND a.is_active = TRUE
      LIMIT 1
    `, [machineId]);
 
    const operator = operatorRows[0] || null;
 
    /* ================= CURRENT JOB + COMPONENT ================= */
    /*
     * FIX: use machine_current_job → components (same as dashboard)
     * The old query hit components directly by machine_id + date range
     * which returned a different row (target:2 instead of target:60).
     * Dashboard correctly joins machine_current_job → components via
     * component_id — machineDetail now does the same.
     */
 
    const { rows: jobDetailRows } = await db.query(`
      SELECT
        j.part_name,
        j.component_id,
        c.part_number,
        c.cycle_time,
        c.target
      FROM machine_current_job j
      LEFT JOIN components c ON c.id = j.component_id
      WHERE j.machine_id = $1
        AND j.is_active = TRUE
      LIMIT 1
    `, [machineId]);
 
    const component = jobDetailRows[0] || null;
 
    /* ================= PRODUCTION ================= */
 
    let runSeconds  = 0;
    let idleSeconds = 0;
    let producedQty = 0;
 
    if (shift) {
 
      /* FIX: scope to today's shift only — shift_id repeats daily */
      const { rows: prodRows } = await db.query(`
        SELECT
          COALESCE(SUM(run_seconds),0)  AS run_seconds,
          COALESCE(SUM(idle_seconds),0) AS idle_seconds,
          COALESCE(SUM(produced_qty),0) AS produced_qty
        FROM production_hourly
        WHERE machine_id = $1
          AND shift_id   = $2
          AND hour_start >= $3
          AND hour_start <  $4
      `, [machineId, shift.id, detailShiftStart, detailShiftEnd]);
 
      const prod = prodRows[0] || {};
 
      runSeconds  = Number(prod.run_seconds  || 0);
      idleSeconds = Number(prod.idle_seconds || 0);
      producedQty = Number(prod.produced_qty || 0);
    }
 
    /* ================= QUALITY ================= */
 
    const { rows: qualityRows } = await db.query(`
      SELECT
        COALESCE(SUM(reject_qty), 0) AS rejected,
        COALESCE(SUM(rework_qty), 0) AS rework
      FROM quality_entries
      WHERE machine_id = $1
        AND shift_id = $2
        AND created_at::date = $3::date
    `, [machineId, shift?.id, detailShiftStart]);
 
    const quality = qualityRows[0] || {};
    const qualityRejected = Number(quality.rejected || 0);
    const qualityRework   = Number(quality.rework   || 0);
    const qualityAccepted = Math.max(0, producedQty - qualityRejected - qualityRework);
 
    /* ================= OEE ================= */
 
    const { rows: oeeRows } = await db.query(`
      SELECT availability, performance, quality, oee
      FROM oee_shift_summary
      WHERE machine_id = $1
      ORDER BY shift_date DESC
      LIMIT 1
    `, [machineId]);
 
    const oee = oeeRows[0] || {};
 
    /* ================= LIVE ================= */
 
    const { rows: liveRows } = await db.query(`
      SELECT machine_status, rpm, feed_rate, parts_count
      FROM telemetry_raw
      WHERE machine_id = $1
      ORDER BY received_at DESC
      LIMIT 1
    `, [machineId]);
 
    const live = liveRows[0] || {};
 
    /* ================= TIME FORMAT ================= */
 
    const formatDuration = (sec) => {
      sec = Number(sec || 0);
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return `${h}:${m}:${s}`;
    };
 
    /* ================= RESPONSE ================= */
 
    return {
 
      machine: {
        id:    machine.id,
        name:  machine.machine_serial_no,
        image: machine.image_url
      },
 
      shift: {
        shift_code: shift?.shift_code || '--'
      },
 
      operator: {
        operator_name: operator?.operator_name || '--'
      },
 
      job: {
        part_name: component?.part_name || '--',
        // part_number from components table; fallback to component_id FK from machine_current_job
        component_id: component?.part_number || component?.component_id || '--',
        target_qty:   component?.target      || 0,
        // parts_count IS the achieved_qty (shift-scoped counter from machine)
        achieved_qty: live.parts_count != null
          ? Number(live.parts_count || 0)
          : producedQty,
        cycle_time: component?.cycle_time || null
      },
 
      production: {
        run_minutes:  Math.floor(runSeconds  / 60),
        idle_minutes: Math.floor(idleSeconds / 60),
        run_time:     formatDuration(runSeconds),
        idle_time:    formatDuration(idleSeconds)
      },
 
      quality: {
        accepted: qualityAccepted,
        rejected: qualityRejected
      },
 
      oee: {
        availability: Number(oee.availability || 0),
        performance:  Number(oee.performance  || 0),
        quality:      Number(oee.quality      || 0),
        oee:          Number(oee.oee          || 0)
      },
 
      live: {
        machine_status: live?.machine_status || 'UNKNOWN',
        rpm:            Number(live?.rpm         || 0),
        feed_rate:      Number(live?.feed_rate   || 0),
        parts_count:    Number(live?.parts_count || 0)
      }
 
    };
 
  } catch (err) {
    console.error("Machine detail service error:", err);
    throw err;
  }
};
 