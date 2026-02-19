const pool = require('../db');

exports.getShifts = async (req) => {
  console.log('Fetching shifts for plant_id:', req.user);
  const result = await pool.query(
    `
    SELECT
      id,
      shift_code,
      shift_name,
      start_time,
      end_time,
      break_minutes,
      is_active
    FROM shifts
    WHERE plant_id = $1
    ORDER BY start_time
    `,
    [req.user.plant_id]
  );

  return result.rows;
};


exports.createShift = async (req) => {
  const {
    shift_code,
    shift_name,
    start_time,
    end_time,
    break_minutes
  } = req.body;

  if (!shift_code || !start_time || !end_time) {
    throw new Error('Shift code, start time and end time are required');
  }

  await pool.query(
    `
    INSERT INTO shifts
    (plant_id, shift_code, shift_name, start_time, end_time, break_minutes)
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      req.user.plant_id,
      shift_code,
      shift_name,
      start_time,
      end_time,
      break_minutes || 0
    ]
  );
};


exports.updateShift = async (req) => {
  const { id } = req.params;
  const {
    shift_code,
    shift_name,
    start_time,
    end_time,
    break_minutes,
    is_active
  } = req.body;

  const result = await pool.query(
    `
    UPDATE shifts
    SET
      shift_code = $1,
      shift_name = $2,
      start_time = $3,
      end_time = $4,
      break_minutes = $5,
      is_active = $6
    WHERE id = $7
      AND plant_id = $8
    `,
    [
      shift_code,
      shift_name,
      start_time,
      end_time,
      break_minutes,
      is_active,
      id,
      req.user.plant_id
    ]
  );

  if (result.rowCount === 0) {
    throw new Error('Shift not found');
  }
};


exports.toggleShift = async (req) => {
  const { id } = req.params;
  const { is_active } = req.body;

  await pool.query(
    `
    UPDATE shifts
    SET is_active = $1
    WHERE id = $2
      AND plant_id = $3
    `,
    [is_active, id, req.user.plant_id]
  );
};
