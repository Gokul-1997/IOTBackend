const pool = require('../db');

exports.getShifts = async (req) => {
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

  const result = await pool.query(
    `
    INSERT INTO shifts
    (plant_id, shift_code, shift_name, start_time, end_time, break_minutes)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id
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

  const newShiftId = result.rows[0].id;

  // Auto link all existing machines to this shift
  await pool.query(`
    INSERT INTO machine_shift_config (plant_id, machine_id, shift_id)
    SELECT $1, id, $2
    FROM machines
    WHERE plant_id = $1
  `, [req.user.plant_id, newShiftId]);

  return { message: 'Shift created successfully' };
};


exports.updateShift = async (id, data, plant_id) => {

  const allowedFields = [
    'shift_code',
    'shift_name',
    'start_time',
    'end_time',
    'break_minutes'
  ];

  const fields = [];
  const values = [];
  let index = 1;

  for (const key of allowedFields) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${index}`);
      values.push(data[key]);
      index++;
    }
  }

  if (fields.length === 0) {
    throw new Error('No fields provided for update');
  }

  const query = `
    UPDATE shifts
    SET ${fields.join(', ')}
    WHERE id = $${index}
      AND plant_id = $${index + 1}
    RETURNING *
  `;

  values.push(id, plant_id);

  const result = await pool.query(query, values);

  if (result.rowCount === 0) {
    throw new Error('Shift not found or access denied');
  }

  return result.rows[0];
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
