const db = require('../db');
const redis = require('../redis');

exports.dashboardPaged = async (plant_id, page = 1, limit = 6) => {

  const offset = (page - 1) * limit;

  /* ---------- TOTAL MACHINES ---------- */
  const { rows: countRows } = await db.query(`
    SELECT COUNT(*)
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
  `, [plant_id]);

  const total = Number(countRows[0].count);

  /* ---------- MACHINE LIST ---------- */
  const { rows: machines } = await db.query(`
    SELECT id, machine_name, image_url
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
    ORDER BY machine_name
    LIMIT $2 OFFSET $3
  `, [plant_id, limit, offset]);

  if (!machines.length) {
    return { page, per_page: limit, total, machines: [] };
  }

  const ids = machines.map(m => m.id);

  /* =====================================================
     CURRENT SHIFT
  ===================================================== */
  const { rows: shiftRows } = await db.query(`
    SELECT id, shift_code, start_time, end_time
    FROM shifts
    WHERE plant_id = $1
      AND (
        (start_time <= end_time AND NOW()::time BETWEEN start_time AND end_time)
        OR
        (start_time > end_time AND 
          (NOW()::time >= start_time OR NOW()::time <= end_time)
        )
      )
      AND is_active = TRUE
    LIMIT 1
  `, [plant_id]);

  const currentShift = shiftRows[0] || null;

  /* =====================================================
     CALCULATE SHIFT START IN NODE (PRODUCTION SAFE)
  ===================================================== */
  let shiftStart = null;

  if (currentShift) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const startTime = currentShift.start_time;
    const endTime = currentShift.end_time;

    if (startTime <= endTime) {
      shiftStart = new Date(`${today}T${startTime}`);
    } else {
      // Night shift
      if (now.toTimeString().slice(0, 8) >= startTime) {
        shiftStart = new Date(`${today}T${startTime}`);
      } else {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yDate = yesterday.toISOString().split('T')[0];
        shiftStart = new Date(`${yDate}T${startTime}`);
      }
    }
  }

  /* =====================================================
     OPERATOR
  ===================================================== */
  let operatorMap = {};

  if (currentShift) {
    const { rows: operatorRows } = await db.query(`
      SELECT
        oma.machine_id,
        o.operator_name
      FROM operator_machine_assignments oma
      JOIN operator_shift_assignments osa
        ON osa.operator_id = oma.operator_id
        AND osa.shift_id = $1
        AND osa.is_active = TRUE
      JOIN operators o
        ON o.id = oma.operator_id
        AND o.is_active = TRUE
      WHERE oma.machine_id = ANY($2)
        AND oma.is_active = TRUE
    `, [currentShift.id, ids]);

    operatorRows.forEach(r => {
      operatorMap[r.machine_id] = r.operator_name;
    });
  }

  /* =====================================================
     REALTIME PRODUCTION
  ===================================================== */
  let prodMap = {};

  if (shiftStart) {
    const { rows: prodRows } = await db.query(`
      SELECT
        machine_id,
        COUNT(*) FILTER (WHERE machine_status IN ('RUN','CUTTING')) / 6 AS run_minutes,
        COUNT(*) FILTER (WHERE machine_status IN ('READY','HOLD')) / 6 AS idle_minutes,
        COUNT(*) FILTER (WHERE machine_status IN ('STOP','ALARM','EMERGENCY','UNKNOWN')) / 6 AS off_minutes,
        MAX(parts_count) AS produced_qty
      FROM telemetry_raw
      WHERE machine_id = ANY($1)
        AND received_at >= $2
      GROUP BY machine_id
    `, [ids, shiftStart]);

    prodRows.forEach(r => {
      prodMap[r.machine_id] = r;
    });
  }

  /* =====================================================
     OEE
  ===================================================== */
  const { rows: oeeRows } = await db.query(`
    SELECT DISTINCT ON (machine_id)
      machine_id, oee
    FROM oee_hourly
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, hour_start DESC
  `, [ids]);

  const oeeMap = {};
  oeeRows.forEach(r => oeeMap[r.machine_id] = Number(r.oee));

  /* =====================================================
     CURRENT JOB
  ===================================================== */
  const { rows: jobRows } = await db.query(`
    SELECT machine_id, part_name, component_id, target_qty, achieved_qty
    FROM machine_current_job
    WHERE machine_id = ANY($1)
      AND is_active = TRUE
  `, [ids]);

  const jobMap = {};
  jobRows.forEach(r => jobMap[r.machine_id] = r);

  /* =====================================================
     REDIS LIVE
  ===================================================== */
  const keys = ids.map(id => `machine:${id}:live`);
  const liveData = await redis.mget(keys);

  /* =====================================================
     FINAL RESPONSE
  ===================================================== */
  const machinesFinal = machines.map((m, i) => ({
    machine_id: m.id,
    machine_name: m.machine_name,
    image_url: m.image_url,
    oee: oeeMap[m.id] || 0,
    production: prodMap[m.id] || {
      run_minutes: 0,
      idle_minutes: 0,
      off_minutes: 0,
      produced_qty: 0
    },
    job: {
      operator_name: operatorMap[m.id] || '--',
      part_name: jobMap[m.id]?.part_name || null,
      component_id: jobMap[m.id]?.component_id || null,
      target_qty: jobMap[m.id]?.target_qty || 0,
      achieved_qty: jobMap[m.id]?.achieved_qty || 0
    },
    live: liveData[i]
      ? JSON.parse(liveData[i])
      : { machine_status: "OFFLINE", rpm: 0, feed_rate: 0 }
  }));

  return {
    page,
    per_page: limit,
    total,
    shift: currentShift,
    machines: machinesFinal
  };
};/* =====================================================
   DASHBOARD SUMMARY (SHIFT BASED)
===================================================== */
exports.dashboardSummary = async (plant_id) => {

  /* ---------- 1️⃣ GET CURRENT SHIFT ---------- */
  const { rows: shiftRows } = await db.query(`
    SELECT id, shift_code
    FROM shifts
    WHERE plant_id = $1
      AND (
        (start_time <= end_time AND NOW()::time BETWEEN start_time AND end_time)
        OR
        (start_time > end_time AND 
          (NOW()::time >= start_time OR NOW()::time <= end_time)
        )
      )
      AND is_active = TRUE
    LIMIT 1
  `, [plant_id]);

  const currentShift = shiftRows[0];

  if (!currentShift) {
    return {
      shift: null,
      total: 0,
      running: 0,
      idle: 0,
      stopped: 0
    };
  }

  /* ---------- 2️⃣ GET MACHINES IN CURRENT SHIFT ---------- */
/* ---------- 2️⃣ GET ALL ACTIVE MACHINES ---------- */
const { rows: machineRows } = await db.query(`
  SELECT id
  FROM machines
  WHERE plant_id = $1
    AND is_active = TRUE
`, [plant_id]);

const machineIds = machineRows.map(m => m.id);

if (!machineIds.length) {
    return {
      shift: currentShift,
      total: 0,
      running: 0,
      idle: 0,
      stopped: 0
    };
  }

  /* ---------- 3️⃣ GET LATEST STATUS FROM TELEMETRY ---------- */
  const { rows: statusRows } = await db.query(`
    SELECT machine_status, COUNT(*) as count
    FROM (
      SELECT DISTINCT ON (machine_id)
             machine_id,
             machine_status
      FROM telemetry_raw
      WHERE machine_id = ANY($1)
      ORDER BY machine_id, received_at DESC
    ) t
    GROUP BY machine_status
  `, [machineIds]);

  let running = 0;
  let idle = 0;
  let stopped = 0;

  statusRows.forEach(r => {
    const status = r.machine_status;
    const count = Number(r.count);

    if (['RUN','CUTTING'].includes(status)) running += count;
    else if (['READY','HOLD'].includes(status)) idle += count;
    else stopped += count;
  });

  return {
    shift: currentShift,
    total: machineIds.length,
    running,
    idle,
    stopped
  };
};

/* =====================================================
   3️⃣ MACHINE DETAIL
===================================================== */
exports.machineDetail = async (plant_id, machine_id) => {

  const { rows: machineRows } = await db.query(`
    SELECT id, machine_name, image_url
    FROM machines
    WHERE id = $1 AND plant_id = $2
  `, [machine_id, plant_id]);

  if (!machineRows.length) throw new Error("Machine not found");

  const { rows: prodRows } = await db.query(`
    SELECT
      SUM(run_minutes) as run_minutes,
      SUM(idle_minutes) as idle_minutes,
      SUM(off_minutes) as off_minutes,
      MAX(produced_qty) as produced_qty
    FROM production_hourly_mv
    WHERE machine_id = $1
      AND hour_start >= NOW() - INTERVAL '8 hours'
  `, [machine_id]);

  return {
    machine: machineRows[0],
    production: prodRows[0]
  };
};


/* =====================================================
   4️⃣ LIVE
===================================================== */
exports.machineLive = async (machine_id) => {

  const raw = await redis.get(`machine:${machine_id}:live`);

  if (!raw) {
    return {
      machine_status: "UNKNOWN",
      rpm: 0,
      feed_rate: 0,
      parts_count: 0
    };
  }

  return JSON.parse(raw);
};