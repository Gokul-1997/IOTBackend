const db = require('../db');
const redis = require('../redis'); 

exports.liveMachines = async ({ user_id, plant_id, role }) => {
  let machinesQuery;
  let params;

  // 1️⃣ Decide machine scope
  if (role === 'ADMIN') {
    machinesQuery = `
      SELECT id, machine_name
      FROM machines
      WHERE plant_id = $1
        AND is_active = TRUE
      ORDER BY machine_name
    `;
    params = [plant_id];
  } else {
    machinesQuery = `
      SELECT m.id, m.machine_name
      FROM machines m
      JOIN operator_machine_assignments oma
        ON oma.machine_id = m.id
       AND oma.operator_id = $1
       AND oma.is_active = TRUE
      WHERE m.plant_id = $2
        AND m.is_active = TRUE
      ORDER BY m.machine_name
    `;
    params = [user_id, plant_id];
  }

  const { rows: machines } = await db.query(machinesQuery, params);

  // 2️⃣ Fetch OEE in one shot
  const machineIds = machines.map(m => m.id);
  let oeeMap = {};

  if (machineIds.length) {
    const { rows: oees } = await db.query(
      `
      SELECT DISTINCT ON (machine_id)
        machine_id,
        oee
      FROM oee_hourly
      WHERE machine_id = ANY($1)
      ORDER BY machine_id, hour_start DESC
      `,
      [machineIds]
    );

    oees.forEach(o => {
      oeeMap[o.machine_id] = o.oee;
    });
  }

  // 3️⃣ Merge Redis live data
  const result = [];

  for (const m of machines) {
    const liveRaw = await redis.get(`machine:${m.id}:live`);
    const live = liveRaw ? JSON.parse(liveRaw) : null;

    result.push({
      machine_id: m.id,
      machine_name: m.machine_name,
      oee: oeeMap[m.id] ?? null,
      live
    });
  }

  return result;
};



exports.hourlyOee = async (plant_id, machine_id, date) => {
  const { rows } = await db.query(
    `
    SELECT
      hour_start,
      availability,
      performance,
      quality,
      oee
    FROM oee_hourly oh
    JOIN machines m ON m.id = oh.machine_id
    WHERE m.plant_id = $1
      AND oh.machine_id = $2
      AND DATE(hour_start) = $3
    ORDER BY hour_start
    `,
    [plant_id, machine_id, date]
  );
  return rows;
};

exports.shiftOee = async (plant_id, date) => {
  const { rows } = await db.query(
    `
    SELECT
      s.shift_name,
      m.machine_name,
      o.oee,
      o.availability,
      o.performance,
      o.quality
    FROM oee_shift_summary o
    JOIN machines m ON m.id = o.machine_id
    JOIN shifts s ON s.id = o.shift_id
    WHERE m.plant_id = $1
      AND o.shift_date = $2
    ORDER BY s.shift_name, m.machine_name
    `,
    [plant_id, date]
  );
  return rows;
};

exports.operatorLive = async plant_id => {
  const { rows } = await db.query(
    `
    SELECT
      o.operator_name,
      m.machine_name,
      s.shift_name
    FROM operators o
    JOIN operator_machine_assignments oma
      ON oma.operator_id = o.id AND oma.is_active = TRUE
    JOIN machines m ON m.id = oma.machine_id
    JOIN operator_shift_assignments osa
      ON osa.operator_id = o.id AND osa.is_active = TRUE
    JOIN shifts s ON s.id = osa.shift_id
    WHERE o.plant_id = $1
    ORDER BY o.operator_name
    `,
    [plant_id]
  );
  return rows;
};
