const db = require('../db');
const redis = require('../redis');


// =====================================================
// 1️⃣ PAGINATED DASHBOARD (PLANT ONLY)
// =====================================================

exports.dashboardPaged = async ({
  plant_id,
  page = 1,
  limit = 6
}) => {

  const offset = (page - 1) * limit;

  // Total count
  const totalResult = await db.query(`
    SELECT COUNT(*)
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
  `, [plant_id]);

  const total = Number(totalResult.rows[0].count);

  // Paginated machines
  const { rows: machines } = await db.query(`
    SELECT id, machine_name
    FROM machines
    WHERE plant_id = $1
      AND is_active = TRUE
    ORDER BY machine_name
    LIMIT $2 OFFSET $3
  `, [plant_id, limit, offset]);

  const machineIds = machines.map(m => m.id);

  if (!machineIds.length) {
    return {
      total,
      page,
      per_page: limit,
      machines: []
    };
  }

  // Latest OEE
  const { rows: oees } = await db.query(`
    SELECT DISTINCT ON (machine_id)
      machine_id,
      oee
    FROM oee_hourly
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, hour_start DESC
  `, [machineIds]);

  const oeeMap = {};
  oees.forEach(o => oeeMap[o.machine_id] = o.oee);

  // Latest Production
  const { rows: production } = await db.query(`
    SELECT DISTINCT ON (machine_id)
      machine_id,
      run_minutes,
      idle_minutes,
      off_minutes,
      produced_qty
    FROM production_hourly
    WHERE machine_id = ANY($1)
    ORDER BY machine_id, hour_start DESC
  `, [machineIds]);

  const prodMap = {};
  production.forEach(p => prodMap[p.machine_id] = p);

  return {
    total,
    page,
    per_page: limit,
    machines: machines.map(m => ({
      machine_id: m.id,
      machine_name: m.machine_name,
      oee: oeeMap[m.id] ?? 0,
      production: prodMap[m.id] ?? null
    }))
  };
};



// =====================================================
// 2️⃣ MACHINE DETAIL (PLANT SAFE)
// =====================================================

exports.machineDetail = async (plant_id, machine_id) => {

  const { rows: machine } = await db.query(`
    SELECT id, machine_name, mage_url
    FROM machines
    WHERE id = $1
      AND plant_id = $2
  `, [machine_id, plant_id]);

  if (!machine.length) {
    throw new Error('Machine not found');
  }

  const { rows: prod } = await db.query(`
    SELECT run_minutes,
           idle_minutes,
           off_minutes,
           produced_qty
    FROM production_hourly
    WHERE machine_id = $1
    ORDER BY hour_start DESC
    LIMIT 1
  `, [machine_id]);

  const { rows: oee } = await db.query(`
    SELECT oee
    FROM oee_hourly
    WHERE machine_id = $1
    ORDER BY hour_start DESC
    LIMIT 1
  `, [machine_id]);

  const liveRaw = await redis.get(`machine:${machine_id}:live`);

  return {
    machine: machine[0],
    production: prod[0] ?? null,
    oee: oee[0]?.oee ?? 0,
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
