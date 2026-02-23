const db = require('../db');
const redis = require('../redis');

/* =====================================================
   1️⃣ MACHINE CARD LIST
===================================================== */
exports.dashboardPaged = async (plant_id, page = 1, limit = 6) => {

  const offset = (page - 1) * limit;

  // 1️⃣ Get machines
  const { rows: machines } = await db.query(`
    SELECT id, machine_name, image_url
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
    ORDER BY machine_name
    LIMIT $2 OFFSET $3
  `, [plant_id, limit, offset]);

  if (!machines.length) {
    return {
      success: true,
      page,
      per_page: limit,
      machines: []
    };
  }

  const ids = machines.map(m => m.id);

  // 2️⃣ Latest OEE
  const { rows: oeeRows } = await db.query(`
    SELECT DISTINCT ON (machine_id)
      machine_id,
      oee
    FROM oee_hourly
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, hour_start DESC
  `, [ids]);

  const oeeMap = {};
  oeeRows.forEach(o => {
    oeeMap[o.machine_id] = Number(o.oee);
  });

  // 3️⃣ Latest production
  const { rows: prodRows } = await db.query(`
    SELECT DISTINCT ON (machine_id)
      machine_id,
      run_minutes,
      idle_minutes,
      off_minutes,
      produced_qty
    FROM production_hourly
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, hour_start DESC
  `, [ids]);

  const prodMap = {};
  prodRows.forEach(p => {
    prodMap[p.machine_id] = p;
  });

  // 4️⃣ Active Job + Operator
  const { rows: jobRows } = await db.query(`
    SELECT
      j.machine_id,
      j.part_name,
      j.component_id,
      j.target_qty,
      j.achieved_qty,
      o.operator_name
    FROM machine_current_job j
    LEFT JOIN operators o ON o.id = j.operator_id
    WHERE j.machine_id = ANY($1)
      AND j.is_active = TRUE
  `, [ids]);

  const jobMap = {};
  jobRows.forEach(j => {
    jobMap[j.machine_id] = j;
  });

  // 5️⃣ Redis Live
  const keys = ids.map(id => `machine:${id}:live`);
  const liveData = await redis.mget(keys);

  const final = machines.map((m, i) => ({
    machine_id: m.id,
    machine_name: m.machine_name,
    mage_url: m.mage_url,

    oee: oeeMap[m.id] || 0,

    production: prodMap[m.id] || {
      run_minutes: 0,
      idle_minutes: 0,
      off_minutes: 0,
      produced_qty: 0
    },

    job: jobMap[m.id] || {
      operator_name: null,
      part_name: null,
      component_id: null,
      target_qty: 0,
      achieved_qty: 0
    },

    live: liveData[i] ? JSON.parse(liveData[i]) : null
  }));

  return {
    success: true,
    page,
    per_page: limit,
    machines: final
  };
};




/* =====================================================
   2️⃣ MACHINE DETAIL
===================================================== */
exports.machineDetail = async (plant_id, machine_id) => {

  const { rows: machineRows } = await db.query(`
    SELECT id, machine_name, image_url
    FROM machines
    WHERE id = $1 AND plant_id = $2
  `, [machine_id, plant_id]);

  if (!machineRows.length) throw new Error("Machine not found");

  // Proper shift detection including night shift
  const { rows: shiftRows } = await db.query(`
    SELECT id, shift_code, shift_name, start_time, end_time, break_minutes
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

  const shift = shiftRows[0] || null;

  // Active job
  const { rows: jobRows } = await db.query(`
    SELECT j.part_name, j.component_id,
           j.target_qty, j.achieved_qty,
           o.operator_name
    FROM machine_current_job j
    LEFT JOIN operators o ON o.id = j.operator_id
    WHERE j.machine_id = $1
      AND j.is_active = TRUE
  `, [machine_id]);

  const job = jobRows[0] || {};

  // Production summary
  let production = {
    run_minutes: 0,
    idle_minutes: 0,
    off_minutes: 0,
    produced_qty: 0
  };

  if (shift?.id) {
    const { rows } = await db.query(`
      SELECT
        COALESCE(SUM(run_minutes),0) as run_minutes,
        COALESCE(SUM(idle_minutes),0) as idle_minutes,
        COALESCE(SUM(off_minutes),0) as off_minutes,
        COALESCE(MAX(produced_qty),0) as produced_qty
      FROM production_hourly
      WHERE machine_id = $1
        AND shift_id = $2
    `, [machine_id, shift.id]);

    production = rows[0];
  }

  // OEE shift summary
  let oee = {
    availability: 0,
    performance: 0,
    quality: 0,
    oee: 0
  };

  if (shift?.id) {
    const { rows } = await db.query(`
      SELECT availability, performance, quality, oee
      FROM oee_shift_summary
      WHERE machine_id = $1
        AND shift_id = $2
        AND shift_date = CURRENT_DATE
    `, [machine_id, shift.id]);

    if (rows.length) oee = rows[0];
  }

  return {
    machine: machineRows[0],
    shift,
    job,
    production,
    oee
  };
};


/* =====================================================
   3️⃣ LIVE
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


/* =====================================================
   4️⃣ TIMELINE
===================================================== */
exports.machineTimeline = async (machine_id) => {

  const { rows } = await db.query(`
    SELECT
      time_bucket('10 seconds', received_at) AS bucket,
      max(machine_status) as machine_status
    FROM telemetry_raw
    WHERE machine_id = $1
      AND received_at >= NOW() - INTERVAL '8 hours'
    GROUP BY bucket
    ORDER BY bucket;
  `, [machine_id]);

  return rows;
};


/* =====================================================
   5️⃣ TREND
===================================================== */
exports.machineTrend = async (machine_id) => {

  const { rows } = await db.query(`
    SELECT
      time_bucket('10 seconds', received_at) AS bucket,
      avg(rpm) as avg_rpm
    FROM telemetry_raw
    WHERE machine_id = $1
      AND received_at >= NOW() - INTERVAL '1 hour'
    GROUP BY bucket
    ORDER BY bucket;
  `, [machine_id]);

  return rows;
};


/* =====================================================
   6️⃣ DASHBOARD SUMMARY
===================================================== */
exports.dashboardSummary = async (plant_id) => {

  const { rows: shiftRows } = await db.query(`
    SELECT id, shift_name, start_time, end_time
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

  const shift = shiftRows[0] || null;

  const { rows: machines } = await db.query(`
    SELECT id
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
  `, [plant_id]);

  const ids = machines.map(m => m.id);

  const keys = ids.map(id => `machine:${id}:live`);
  const liveData = ids.length ? await redis.mget(keys) : [];

  let running = 0;
  let idle = 0;
  let stop = 0;

  liveData.forEach(raw => {

    if (!raw) {
      stop++;
      return;
    }

    const status = JSON.parse(raw).machine_status;

    if (['RUN','CUTTING'].includes(status)) running++;
    else if (['READY','HOLD','IDLE'].includes(status)) idle++;
    else stop++;
  });

  return {
    shift,
    total: machines.length,
    running,
    idle,
    stop
  };
};