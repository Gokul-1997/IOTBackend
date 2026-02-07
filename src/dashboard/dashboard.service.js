const db = require('../db');

exports.liveMachines = async plant_id => {
  const { rows } = await db.query(
    `
    SELECT
      m.id AS machine_id,
      m.machine_name,
      t.status,
      t.received_at,

      o.operator_name,
      s.shift_name,

      oh.oee

    FROM machines m

    LEFT JOIN LATERAL (
      SELECT status, received_at
      FROM telemetry_raw
      WHERE machine_id = m.id
      ORDER BY received_at DESC
      LIMIT 1
    ) t ON TRUE

    LEFT JOIN operator_machine_assignments oma
      ON oma.machine_id = m.id AND oma.is_active = TRUE

    LEFT JOIN operators o
      ON o.id = oma.operator_id

    LEFT JOIN operator_shift_assignments osa
      ON osa.operator_id = o.id AND osa.is_active = TRUE

    LEFT JOIN shifts s
      ON s.id = osa.shift_id

    LEFT JOIN LATERAL (
      SELECT oee
      FROM oee_hourly
      WHERE machine_id = m.id
      ORDER BY hour_start DESC
      LIMIT 1
    ) oh ON TRUE

    WHERE m.plant_id = $1
      AND m.is_active = TRUE
    ORDER BY m.machine_name
    `,
    [plant_id]
  );

  return rows;
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
