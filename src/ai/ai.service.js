const db = require('../db');

exports.machineRisk = async plant_id => {
  const { rows } = await db.query(
    `
    SELECT
      m.id AS machine_id,
      m.machine_name,

      AVG(o.oee) FILTER (WHERE o.hour_start >= NOW() - INTERVAL '3 hours') AS avg_oee,
      SUM(p.off_minutes) FILTER (WHERE p.hour_start >= NOW() - INTERVAL '4 hours') AS off_time

    FROM machines m
    LEFT JOIN oee_hourly o ON o.machine_id = m.id
    LEFT JOIN production_hourly p ON p.machine_id = m.id
    WHERE m.plant_id = $1
    GROUP BY m.id, m.machine_name
    `,
    [plant_id]
  );

  return rows.map(r => ({
    ...r,
    risk:
      r.off_time > 90 ? 'HIGH' :
      r.avg_oee < 60 ? 'MEDIUM' :
      'LOW'
  }));
};
