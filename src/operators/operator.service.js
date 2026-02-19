const db = require('../db');
const { validateCreate } = require('../helpers/validators/operator.validator');

exports.create = async (data, plant_id) => {
  validateCreate(data);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO operators
       (plant_id, operator_code, operator_name, skill_level)
       VALUES ($1,$2,$3,$4)
       RETURNING id`,
      [plant_id, data.operator_code, data.operator_name, data.skill_level]
    );

    const operatorId = rows[0].id;

    await client.query(
      `INSERT INTO operator_shift_assignments
       (plant_id, operator_id, shift_id, effective_from)
       VALUES ($1,$2,$3,CURRENT_DATE)`,
      [plant_id, operatorId, data.shift_id]
    );

    for (const m of data.machine_ids || []) {
      await client.query(
        `INSERT INTO operator_machine_assignments
         (plant_id, operator_id, machine_id, assigned_from)
         VALUES ($1,$2,$3,CURRENT_DATE)`,
        [plant_id, operatorId, m]
      );
    }

    await client.query('COMMIT');

    return {
      status: 'success',
      message: 'Operator created successfully',
      data: { operator_id: operatorId }
    };

  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};


exports.list = async (plant_id, query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = query.search || '';
  const sortBy = query.sortBy || 'o.created_at';
  const order = query.order === 'asc' ? 'ASC' : 'DESC';

  const values = [plant_id];
  let where = `WHERE o.plant_id = $1`;

  if (search) {
    values.push(`%${search}%`);
    where += `
      AND (
        o.operator_code ILIKE $${values.length}
        OR o.operator_name ILIKE $${values.length}
        OR s.shift_name ILIKE $${values.length}
      )
    `;
  }

  const totalQuery = `
    SELECT COUNT(DISTINCT o.id) AS total
    FROM operators o
    LEFT JOIN operator_shift_assignments os
      ON os.operator_id=o.id AND os.is_active=TRUE
    LEFT JOIN shifts s ON s.id=os.shift_id
    ${where}
  `;

  const listQuery = `
    SELECT
      o.id,
      o.operator_code,
      o.operator_name,
      o.skill_level,
      o.is_active,

      s.shift_name,
      s.start_time,
      s.end_time,

      COUNT(om.machine_id) AS machine_count

    FROM operators o
    LEFT JOIN operator_shift_assignments os
      ON os.operator_id=o.id AND os.is_active=TRUE
    LEFT JOIN shifts s ON s.id=os.shift_id
    LEFT JOIN operator_machine_assignments om
      ON om.operator_id=o.id AND om.is_active=TRUE

    ${where}
    GROUP BY o.id, s.shift_name, s.start_time, s.end_time
    ORDER BY ${sortBy} ${order}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totalRes = await db.query(totalQuery, values);
  const dataRes = await db.query(listQuery, values);

  const total = parseInt(totalRes.rows[0].total);

  return {
    status: 'success',
    data: dataRes.rows,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
};
