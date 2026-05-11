const db = require('../db');

/** Return a Date whose .getFullYear/.getHours/… reflect IST, regardless of server TZ */
function nowIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

/** Format a JS Date (assumed IST-local) as 'YYYY-MM-DD' */
function toDateStr(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

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

exports.dashboard = async (plant_id, company_id) => {

  const realNow     = new Date();                      // real epoch for comparisons
  const now         = nowIST();                        // IST-local for date/time strings
  const currentTime = now.toTimeString().slice(0, 8);  // always IST

  /* ================= SHIFT ================= */

  const { rows: shiftRows } = await db.query(`
    SELECT id,shift_code,start_time,end_time,break_minutes
    FROM shifts
    WHERE company_id=$1
      AND (
        (start_time<=end_time AND
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time
         BETWEEN start_time AND end_time)
        OR
        (start_time>end_time AND (
           (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time >= start_time
           OR
           (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time <= end_time
        ))
      )
      AND is_active=TRUE
    LIMIT 1
  `, [company_id]);

  const shift = shiftRows[0];

  if (!shift) {
    return {
      shift: null,
      summary: { total: 0, running: 0, idle: 0 },
      machines: []
    };
  }

  /* ================= SHIFT TIME ================= */

  const today = toDateStr(now);
  let shiftStart;

  if (shift.start_time <= shift.end_time) {
    shiftStart = new Date(`${today}T${shift.start_time}+05:30`);
  } else {
    if (currentTime >= shift.start_time) {
      shiftStart = new Date(`${today}T${shift.start_time}+05:30`);
    } else {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      shiftStart = new Date(`${toDateStr(y)}T${shift.start_time}+05:30`);
    }
  }

  const startMin = timeToMinutes(shift.start_time);
  const endMin   = timeToMinutes(shift.end_time);

  const shiftDurationMinutes = calculateDuration(startMin, endMin);

  const shiftEnd = new Date(shiftStart);
  shiftEnd.setMinutes(shiftEnd.getMinutes() + shiftDurationMinutes);

  const effectiveNow = realNow > shiftEnd ? shiftEnd : realNow;

  const shiftElapsedMinutes =
    Math.max(0, Math.floor((effectiveNow - shiftStart) / 60000));

  const plannedMinutes =
    Math.max(0, shiftDurationMinutes - Number(shift.break_minutes || 0));

  /* ================= MACHINES ================= */

  const { rows: machines } = await db.query(`
    SELECT id,machine_serial_no,image_url
    FROM machines
    WHERE company_id=$1
    AND is_active=TRUE
    ORDER BY id
  `, [company_id]);

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
    SELECT j.machine_id, j.target_qty AS target, COALESCE(c.multiplication_factor, 1) AS multiplication_factor
    FROM machine_current_job j
    LEFT JOIN components c ON c.id=j.component_id
    WHERE j.machine_id=ANY($1)
    AND j.is_active=TRUE
  `, [machineIds]);

  const componentMap  = {};
  const multiFactorMap = {};
  componentRows.forEach(r => {
    componentMap[r.machine_id]   = Number(r.target || 0);
    multiFactorMap[r.machine_id] = Number(r.multiplication_factor || 1);
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
      AND hour_start >= date_trunc('hour', $3::timestamptz)
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
   * Only need the latest telemetry row per machine for:
   *   - machine_status  (RUNNING / IDLE)
   *   - alarm           (boolean)
   *   - received_at     (freshness → online/offline detection)
   *
   * Parts count comes from production_hourly (prodMap) which is
   * computed by the MQTT processor with proper delta logic that
   * handles counter resets, connection drops, and stale counters.
   * telemetry_raw's raw parts_count is unreliable for shift totals
   * because connection drops cause false resets and inflated counts.
   */

  const { rows: liveRows } = await db.query(`
    SELECT DISTINCT ON (machine_id)
      machine_id, machine_status, alarm, received_at
    FROM telemetry_raw
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, received_at DESC
  `, [machineIds]);

  const liveMap = {};
  liveRows.forEach(r => {
    liveMap[r.machine_id] = r;
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
    const alarm         = !!live.alarm; // handles boolean true, integer 1, string "true"

    const nowSec        = Math.floor(Date.now() / 1000);
    // received_at is TIMESTAMPTZ → JS Date; convert to epoch seconds
    const receivedAtSec = live.received_at
      ? Math.floor(new Date(live.received_at).getTime() / 1000)
      : 0;

    const OFFLINE_THRESHOLD = 60; // 60s — tolerate brief network gaps in industrial environments
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

    // If production_hourly over-accumulated (small per-message overcounts add up),
    // scale BOTH run and idle proportionally so they sum to shift-elapsed.
    // Previously we capped run then forced idle = max - run, which made idle=0
    // whenever raw run >= maxSeconds — masking actual idle time on the card.
    const totalSeconds = runSeconds + idleSeconds;
    if (totalSeconds > maxSeconds && totalSeconds > 0) {
      const scale = maxSeconds / totalSeconds;
      runSeconds  = Math.floor(runSeconds  * scale);
      idleSeconds = Math.floor(idleSeconds * scale);
    } else {
      runSeconds  = Math.min(runSeconds,  maxSeconds);
      idleSeconds = Math.min(idleSeconds, maxSeconds);
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

    /* ================= ACHIEVED QTY ================= */
    /*
     * Use production_hourly.produced_qty as the single source of truth.
     * The MQTT processor computes deltas with proper handling for:
     *   - Counter resets (machine power cycle)
     *   - Connection drops (stale counter recovery)
     *   - Absolute counters (non-resetting)
     *
     * This matches what charts and reports show — one consistent value.
     */

    const multFactor = multiFactorMap[m.id] || 1;
    let achieved = Math.max(0, Number(prod.produced_qty || 0)) * multFactor;

    /* ================= UTILIZATION ================= */

    const _target = componentMap[m.id] || 0;

    const _rawUtil = _target > 0
      ? (achieved * 100) / _target
      : plannedMinutes > 0
        ? (Math.min(runSeconds / 60, shiftElapsedMinutes) * 100) / plannedMinutes
        : 0;

    const utilization = Number(Math.min(_rawUtil, 100).toFixed(2));

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

exports.machineDetail = async (plantId, machineId, companyId) => {

  try {

    /* ================= MACHINE ================= */

    const { rows: machineRows } = await db.query(`
      SELECT id, machine_serial_no, image_url
      FROM machines
      WHERE id = $1 AND company_id = $2
    `, [machineId, companyId]);
 
    if (!machineRows.length) return null;
 
    const machine = machineRows[0];
 
    /* ================= CURRENT SHIFT ================= */
 
    const { rows: shiftRows } = await db.query(`
      SELECT id, shift_code, start_time, end_time
      FROM shifts
      WHERE company_id = $1
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
    `, [companyId]);

    const shift = shiftRows[0] || null;
 
    /* ── Compute shiftStart / shiftEnd for date-scoped queries ── */
    let detailShiftStart = null;
    let detailShiftEnd   = null;
 
    if (shift) {
      const nowD         = nowIST();
      const todayD       = toDateStr(nowD);
      const currentTimeD = nowD.toTimeString().slice(0, 8);
 
      if (shift.start_time <= shift.end_time) {
        detailShiftStart = new Date(`${todayD}T${shift.start_time}+05:30`);
      } else {
        if (currentTimeD >= shift.start_time) {
          detailShiftStart = new Date(`${todayD}T${shift.start_time}+05:30`);
        } else {
          const yd = new Date(nowD);
          yd.setDate(yd.getDate() - 1);
          detailShiftStart = new Date(`${toDateStr(yd)}T${shift.start_time}+05:30`);
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
      SELECT o.operator_name, o.operator_code
      FROM operator_machine_assignments a
      JOIN operator_shift_assignments osa
        ON osa.operator_id = a.operator_id
       AND osa.shift_id = $2
       AND osa.is_active = TRUE
      JOIN operators o ON o.id = a.operator_id
        AND o.is_active = TRUE
      WHERE a.machine_id = $1
        AND a.is_active = TRUE
      LIMIT 1
    `, [machineId, shift?.id]);
 
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
        j.target_qty AS target,
        COALESCE(c.multiplication_factor, 1) AS multiplication_factor
      FROM machine_current_job j
      LEFT JOIN components c ON c.id = j.component_id
      WHERE j.machine_id = $1
        AND j.is_active = TRUE
      LIMIT 1
    `, [machineId]);

    const component = jobDetailRows[0] || null;
    const detailMultFactor = Number(component?.multiplication_factor || 1);
 
    /* ================= PRODUCTION ================= */
 
    let runSeconds          = 0;
    let idleSeconds         = 0;
    let manualSeconds       = 0;
    let producedQty         = 0;
    let shiftEnergyKwh      = 0;
    let energyAtShiftStart  = null;

    if (shift) {
 
      /* FIX: scope to today's shift only — shift_id repeats daily */
      const { rows: prodRows } = await db.query(`
        SELECT
          COALESCE(SUM(run_seconds),0)    AS run_seconds,
          COALESCE(SUM(idle_seconds),0)   AS idle_seconds,
          COALESCE(SUM(manual_seconds),0) AS manual_seconds,
          COALESCE(SUM(produced_qty),0)   AS produced_qty
        FROM production_hourly
        WHERE machine_id = $1
          AND shift_id   = $2
          AND hour_start >= date_trunc('hour', $3::timestamptz)
          AND hour_start <  $4
      `, [machineId, shift.id, detailShiftStart, detailShiftEnd]);
 
      const prod = prodRows[0] || {};
 
      runSeconds    = Number(prod.run_seconds    || 0);
      idleSeconds   = Number(prod.idle_seconds   || 0);
      manualSeconds  = Number(prod.manual_seconds || 0);
      producedQty    = Number(prod.produced_qty   || 0);

      // shift_kwh = current_energy − first energy reading of this shift
      // More reliable than summing deltas (unaffected by missed MQTT messages)
      const { rows: energyRows } = await db.query(`
        SELECT energy
        FROM telemetry_raw
        WHERE machine_id  = $1
          AND received_at >= $2
          AND received_at <  $3
          AND energy IS NOT NULL
        ORDER BY received_at ASC
        LIMIT 1
      `, [machineId, detailShiftStart, detailShiftEnd]);

      energyAtShiftStart = energyRows[0]?.energy ?? null;
    }

 
    /* ================= QUALITY ================= */
 
    const { rows: qualityRows } = await db.query(`
      SELECT
        COALESCE(SUM(reject_qty), 0) AS rejected,
        COALESCE(SUM(rework_qty), 0) AS rework
      FROM quality_entries
      WHERE machine_id = $1
        AND shift_id = $2
        AND COALESCE(shift_date, created_at::date) = $3::date
    `, [machineId, shift?.id, detailShiftStart]);
 
    const quality = qualityRows[0] || {};
    const qualityRejected = Number(quality.rejected || 0);
    const qualityRework   = Number(quality.rework   || 0);
    // qualityAccepted is computed after production_hourly totals are known
 
    /* ================= OEE ================= */
 
    // Scope OEE to current shift + current shift-date only.
    // Without this, a newly-started shift shows the previous shift's OEE.
    // If the cron hasn't written a row yet for this shift, return zeros.
    const shiftDateForOee = detailShiftStart
      ? toDateStr(new Date(detailShiftStart.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })))
      : null;

    let oee = {};
    if (shift && shiftDateForOee) {
      const { rows: oeeRows } = await db.query(`
        SELECT availability, performance, quality, oee
        FROM oee_shift_summary
        WHERE machine_id = $1
          AND shift_id   = $2
          AND shift_date::date = $3::date
        LIMIT 1
      `, [machineId, shift.id, shiftDateForOee]);
      oee = oeeRows[0] || {};

      // Fallback for in-progress shift: cron only writes after shift end,
      // so compute OEE on-the-fly using the same formula. This way the
      // dashboard shows live OEE during the shift (refreshes hourly as
      // production_hourly accumulates) and the precomputed row takes over
      // once the shift ends.
      if (!oeeRows.length) {
        const startMinO = timeToMinutes(shift.start_time);
        const endMinO   = timeToMinutes(shift.end_time);
        const shiftDurO = calculateDuration(startMinO, endMinO);
        const plannedSecO = Math.max(1,
          (shiftDurO - Number(shift.break_minutes || 0)) * 60);

        const cycleSecO = component?.cycle_time
          ? (Number(component.cycle_time.hours   || 0) * 3600
           + Number(component.cycle_time.minutes || 0) * 60
           + Number(component.cycle_time.seconds || 0))
          : 0;

        const totalRunO    = Number(runSeconds   || 0);
        const totalQtyO    = Number(producedQty  || 0) * detailMultFactor;
        const acceptedO    = Math.max(0, totalQtyO - qualityRejected - qualityRework);

        const availability = plannedSecO > 0
          ? Math.min(100, (totalRunO / plannedSecO) * 100) : 0;
        const idealQtyO    = cycleSecO > 0 ? totalRunO / cycleSecO : 0;
        const performance  = idealQtyO > 0
          ? Math.min(100, (totalQtyO / idealQtyO) * 100) : 0;
        const qualityPct   = totalQtyO > 0
          ? Math.min(100, (acceptedO / totalQtyO) * 100) : 0;
        const oeePct       = (availability/100) * (performance/100) * (qualityPct/100) * 100;

        oee = {
          availability: Number(availability.toFixed(2)),
          performance:  Number(performance.toFixed(2)),
          quality:      Number(qualityPct.toFixed(2)),
          oee:          Number(oeePct.toFixed(2))
        };
      }
    }
 
    /* ================= LIVE STATUS ================= */
    /*
     * Only need the latest telemetry for status, spindle, feed, alarm, energy.
     * Parts count comes from production_hourly (producedQty) — same as dashboard.
     */

    const { rows: liveRows } = await db.query(`
      SELECT machine_status, spindle_load, feed_rate, received_at, alarm, mode, energy
      FROM telemetry_raw
      WHERE machine_id = $1
      ORDER BY received_at DESC
      LIMIT 1
    `, [machineId]);

    const live = liveRows[0] || {};

    /* ================= ACCEPTED QTY ================= */
    /*
     * Use production_hourly.produced_qty as the source — same as dashboard.
     * The MQTT processor handles counter resets, connection drops, and
     * stale counters properly via delta logic.
     */
    /* ================= REALTIME SECONDS (same logic as dashboard) ================= */
    /*
     * production_hourly is written in hourly batches — the current open hour
     * has no row yet.  Add seconds elapsed since last telemetry so the times
     * match the dashboard card in real time.
     * freshDiff guard (<=15 s) prevents adding stale time when offline.
     */

    const nowRT          = new Date(); // real epoch — correct for comparisons
    const effectiveNowRT = (detailShiftEnd && nowRT > detailShiftEnd) ? detailShiftEnd : nowRT;
    const shiftElapsedRT = detailShiftStart
      ? Math.max(0, Math.floor((effectiveNowRT - detailShiftStart) / 60000))
      : 0;
    const maxSecondsRT   = shiftElapsedRT * 60;

    // received_at is TIMESTAMPTZ → JS Date; convert to epoch seconds
    const receivedAtRT   = live.received_at
      ? Math.floor(new Date(live.received_at).getTime() / 1000)
      : 0;
    const nowSecRT       = Math.floor(Date.now() / 1000);
    const freshDiffRT    = receivedAtRT ? (nowSecRT - receivedAtRT) : null;

    const OFFLINE_THRESHOLD_RT = 60; // seconds — same as dashboard

    const rawStatus  = (live.machine_status || '').toUpperCase();
    const isOnline   = receivedAtRT && freshDiffRT !== null && freshDiffRT <= OFFLINE_THRESHOLD_RT;
    const isRunning  = isOnline && ['RUN', 'RUNNING', 'CUTTING'].includes(rawStatus);
    const isIdle     = isOnline && !isRunning && rawStatus !== '';

    /* Derived status — matches dashboard card logic */
    const detailStatus = !receivedAtRT
      ? 'OFFLINE'
      : freshDiffRT > OFFLINE_THRESHOLD_RT
        ? 'OFFLINE'
        : isRunning ? 'RUNNING' : 'IDLE';

    // shift_kwh = current energy − first energy reading this shift
    const currentEnergy = live?.energy != null ? Number(live.energy) : null;
    if (currentEnergy !== null && energyAtShiftStart !== null) {
      shiftEnergyKwh = Math.max(0, currentEnergy - Number(energyAtShiftStart));
    }

    // Use production_hourly as single source — same as dashboard
    const achievedBase = Math.max(0, producedQty) * detailMultFactor;
    const qualityAccepted = Math.max(0, achievedBase - qualityRejected - qualityRework);

    if (receivedAtRT && freshDiffRT !== null && freshDiffRT >= 0 && freshDiffRT <= OFFLINE_THRESHOLD_RT) {
      if (isRunning) {
        runSeconds  += freshDiffRT;
      } else if (isIdle) {
        idleSeconds += freshDiffRT;
      }
    }

    const totalRT = runSeconds + idleSeconds;
    if (totalRT > maxSecondsRT && totalRT > 0) {
      const scale = maxSecondsRT / totalRT;
      runSeconds  = Math.floor(runSeconds  * scale);
      idleSeconds = Math.floor(idleSeconds * scale);
    } else {
      runSeconds  = Math.min(runSeconds,  maxSecondsRT);
      idleSeconds = Math.min(idleSeconds, maxSecondsRT);
    }

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
        operator_name: operator?.operator_name || '--',
        employee_id:   operator?.operator_code || '--'
      },

      job: {
        part_name: component?.part_name || '--',
        // part_number from components table; fallback to component_id FK from machine_current_job
        component_id: component?.part_number || component?.component_id || '--',
        target_qty:   component?.target      || 0,
        achieved_qty: achievedBase,
        cycle_time: component?.cycle_time || null
      },

      production: {
        run_minutes:    Math.floor(runSeconds    / 60),
        idle_minutes:   Math.floor(idleSeconds   / 60),
        manual_seconds: manualSeconds,
        setup_time:     formatDuration(manualSeconds),
        run_time:       formatDuration(runSeconds),
        idle_time:      formatDuration(idleSeconds)
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

      power: {
        shift_kwh: Number(shiftEnergyKwh.toFixed(3)),
        total_kwh: live?.energy != null ? Number(Number(live.energy).toFixed(3)) : null
      },

      live: {
        // Use derived status (same OFFLINE threshold as dashboard card)
        machine_status:  detailStatus,
        mode:            live?.mode || null,
        spindle_load:    isOnline ? Number(live?.spindle_load || 0) : 0,
        feed_rate:       isOnline ? Number(live?.feed_rate    || 0) : 0,
        // adjusted (reset-offset included); falls back to producedQty when OFFLINE
        parts_count:     achievedBase,
        total_energy:    live?.energy != null ? Number(live.energy) : null
      }
 
    };
 
  } catch (err) {
    console.error("Machine detail service error:", err);
    throw err;
  }
};
 