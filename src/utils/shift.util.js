const db = require('../db');

exports.getCurrentShift = async (plant_id, time) => {
  const { rows } = await db.query(
    `
    SELECT *
    FROM shifts
    WHERE plant_id = $1
      AND is_active = TRUE
      AND (
        (start_time <= end_time AND $2::time BETWEEN start_time AND end_time)
        OR
        (start_time > end_time AND ($2::time >= start_time OR $2::time < end_time))
      )
    `,
    [plant_id, time]
  );
  return rows[0];
};
