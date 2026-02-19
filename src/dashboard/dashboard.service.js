const db = require('../db');
const redis = require('../redis');

exports.dashboardPaged = async ({ plant_id, page = 1, limit = 6 }) => {
  const offset = (page - 1) * limit;

  // 🔥 Single optimized DB query
  const { rows: machines } = await db.query(`
    SELECT
      m.id,
      m.machine_name,
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
    WHERE m.plant_id = $1
      AND m.is_active = TRUE
    ORDER BY m.machine_name
    LIMIT $2 OFFSET $3
  `, [plant_id, limit, offset]);

  if (!machines.length) {
    return {
      success: true,
      total: 0,
      page,
      per_page: limit,
      machines: []
    };
  }

  // 🔥 Bulk Redis fetch
const redisKeys = machines.map(m => `machine:${m.id}:live`);

const liveData = redisKeys.length
  ? await redis.mget(...redisKeys)
  : [];

const final = machines.map((m, index) => ({
  machine_id: m.id,
  machine_name: m.machine_name,
  oee: m.oee,
  production: {
    run_minutes: m.run_minutes ?? 0,
    idle_minutes: m.idle_minutes ?? 0,
    off_minutes: m.off_minutes ?? 0,
    produced_qty: m.produced_qty ?? 0
  },
  live: liveData[index] ? JSON.parse(liveData[index]) : null
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
