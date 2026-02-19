const db = require('../db');

exports.hourlyOee = async (plant_id, date) => {
  const { rows } = await db.query(
    `
    SELECT
      m.machine_name,
      hour_start,
      availability,
      performance,
      quality,
      oee
    FROM oee_hourly o
    JOIN machines m ON m.id = o.machine_id
    WHERE m.plant_id = $1
      AND DATE(hour_start) = $2
    ORDER BY m.machine_name, hour_start
    `,
    [plant_id, date]
  );
  return rows;
};

exports.shiftOee = async (plant_id, date) => {
  const { rows } = await db.query(
    `
    SELECT
      s.shift_name,
      m.machine_name,
      availability,
      performance,
      quality,
      oee
    FROM oee_shift_summary o
    JOIN machines m ON m.id = o.machine_id
    JOIN shifts s ON s.id = o.shift_id
    WHERE m.plant_id = $1
      AND shift_date = $2
    ORDER BY s.shift_name, m.machine_name
    `,
    [plant_id, date]
  );
  return rows;
};

exports.production = async (plant_id, date) => {
  const { rows } = await db.query(
    `
    SELECT
      m.machine_name,
      hour_start,
      run_minutes,
      idle_minutes,
      off_minutes,
      produced_qty
    FROM production_hourly p
    JOIN machines m ON m.id = p.machine_id
    WHERE m.plant_id = $1
      AND DATE(hour_start) = $2
    ORDER BY m.machine_name, hour_start
    `,
    [plant_id, date]
  );
  return rows;
};
