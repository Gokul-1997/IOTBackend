const db = require('../db');

exports.hourlyOee = async (plant_id, date) => {
  const { rows } = await db.query(
    `
    SELECT
      m.machine_serial_no,
      hour_start,
      availability,
      performance,
      quality,
      oee
    FROM oee_hourly o
    JOIN machines m ON m.id = o.machine_id
    WHERE m.plant_id = $1
      AND DATE(hour_start) = $2
    ORDER BY m.machine_serial_no, hour_start
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
      m.machine_serial_no,
      availability,
      performance,
      quality,
      oee
    FROM oee_shift_summary o
    JOIN machines m ON m.id = o.machine_id
    JOIN shifts s ON s.id = o.shift_id
    WHERE m.plant_id = $1
      AND shift_date = $2
    ORDER BY s.shift_name, m.machine_serial_no
    `,
    [plant_id, date]
  );
  return rows;
};

exports.production = async (plant_id, date) => {
  // FIX: production_hourly stores run_seconds/idle_seconds, not run_minutes/idle_minutes/off_minutes
  // Those column names only exist on the production_hourly_mv materialized view
  const { rows } = await db.query(
    `
    SELECT
      m.machine_serial_no,
      TO_CHAR(hour_start AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS hour,
      run_seconds,
      idle_seconds,
      COALESCE(manual_seconds, 0)                                AS manual_seconds,
      (3600 - run_seconds - idle_seconds)                        AS off_seconds,
      produced_qty,
      ROUND(COALESCE(energy_kwh, 0)::numeric, 3)                 AS energy_kwh
    FROM production_hourly p
    JOIN machines m ON m.id = p.machine_id
    WHERE m.plant_id = $1
      AND DATE(hour_start AT TIME ZONE 'Asia/Kolkata') = $2
    ORDER BY m.machine_serial_no, hour_start
    `,
    [plant_id, date]
  );
  return rows;
};
