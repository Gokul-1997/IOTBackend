const db = require('../db');
const redis = require('../redis');

exports.dashboardPaged = async (plant_id, page = 1, limit = 6) => {

  const offset = (page - 1) * limit;

  // 1️⃣ Get machines
  const { rows: machines } = await db.query(`
    SELECT id, machine_name, mage_url
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



// =====================================================
// 2️⃣ MACHINE DETAIL (PLANT SAFE)
// =====================================================

exports.machineDetail = async (machine_id) => {

  const { rows } = await db.query(`
    SELECT
      m.machine_name,
      m.mage_url,
      COALESCE(o.oee,0) as oee,
      p.run_minutes,
      p.idle_minutes,
      p.off_minutes,
      p.produced_qty
    FROM machines m
    LEFT JOIN LATERAL (
       SELECT oee
       FROM oee_hourly
       WHERE machine_id = m.id
       ORDER BY hour_start DESC
       LIMIT 1
    ) o ON TRUE
    LEFT JOIN LATERAL (
       SELECT run_minutes, idle_minutes, off_minutes, produced_qty
       FROM production_hourly
       WHERE machine_id = m.id
       ORDER BY hour_start DESC
       LIMIT 1
    ) p ON TRUE
    WHERE m.id = $1
  `, [machine_id]);

  const liveRaw = await redis.get(`machine:${machine_id}:live`);

  return {
    machine: rows[0],
    live: liveRaw ? JSON.parse(liveRaw) : null
  };
};




// =====================================================
// 3️⃣ MACHINE LIVE (1 SECOND SAFE CACHE)
// =====================================================

exports.machineLive = async (machine_id) => {

  const cacheKey = `machine:${machine_id}:live_cache`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const liveRaw = await redis.get(`machine:${machine_id}:live`);

  const live = liveRaw
    ? JSON.parse(liveRaw)
    : { machine_status: 'OFFLINE' };

  await redis.set(cacheKey, JSON.stringify(live), { EX: 1 });

  return live;
};
