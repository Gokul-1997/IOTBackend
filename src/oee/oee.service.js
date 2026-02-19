const db = require('../db'); // pg pool

exports.getMeta = async (plantId) => {

  const machines = await db.query(`
    SELECT id, machine_name
    FROM machines
    WHERE plant_id = $1 AND is_active = true
    ORDER BY machine_name
  `, [plantId]);

  const shifts = await db.query(`
    SELECT id, shift_name, start_time, end_time
    FROM shifts
    WHERE plant_id = $1 AND is_active = true
    ORDER BY start_time
  `, [plantId]);

  return {
    machines: machines.rows,
    shifts: shifts.rows
  };
};


exports.getReports = async (query, plantId) => {

  const {
    machine_id,
    shift_id,
    from,
    to,
    page = 1,
    limit = 10,
    sort = 'shift_date',
    order = 'desc'
  } = query;

  const offset = (page - 1) * limit;

  const where = [];
  const values = [];
  let i = 1;

  if (machine_id) {
    where.push(`os.machine_id = $${i++}`);
    values.push(machine_id);
  }

  if (shift_id) {
    where.push(`os.shift_id = $${i++}`);
    values.push(shift_id);
  }

  if (from && to) {
    where.push(`os.shift_date BETWEEN $${i++} AND $${i++}`);
    values.push(from, to);
  }

  where.push(`m.plant_id = $${i++}`);
  values.push(plantId);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // 🧮 TOTAL COUNT
  const countQuery = `
    SELECT COUNT(*) 
    FROM oee_shift_summary os
    JOIN machines m ON m.id = os.machine_id
    ${whereSql}
  `;

  const totalResult = await db.query(countQuery, values);
  const total = parseInt(totalResult.rows[0].count);

  // 📊 DATA QUERY
  const dataQuery = `
    SELECT
      os.shift_date,
      m.machine_name,
      s.shift_name,
      os.availability,
      os.performance,
      os.quality,
      os.oee
    FROM oee_shift_summary os
    JOIN machines m ON m.id = os.machine_id
    JOIN shifts s ON s.id = os.shift_id
    ${whereSql}
    ORDER BY ${sort} ${order}
    LIMIT $${i++} OFFSET $${i++}
  `;

  values.push(limit, offset);

  const data = await db.query(dataQuery, values);

  return {
    data: data.rows,
    page: Number(page),
    limit: Number(limit),
    total
  };
};
