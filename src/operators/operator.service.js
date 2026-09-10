const db = require('../db');
const { validateCreate } = require('../helpers/validators/operator.validator');

exports.create = async (data, plant_id, company_id) => {
  validateCreate(data);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO operators
       (plant_id, company_id, operator_code, operator_name, skill_level)
       VALUES (NULL,$1,$2,$3,$4)
       RETURNING id`,
      [company_id, data.operator_code, data.operator_name, data.skill_level]
    );

    const operatorId = rows[0].id;

    await client.query(
      `INSERT INTO operator_shift_assignments
       (company_id, operator_id, shift_id, effective_from)
       VALUES ($1,$2,$3,CURRENT_DATE)`,
      [company_id, operatorId, data.shift_id]
    );

    for (const m of data.machine_ids || []) {
      await client.query(
        `INSERT INTO operator_machine_assignments
         (company_id, operator_id, machine_id, assigned_from)
         VALUES ($1,$2,$3,CURRENT_DATE)`,
        [company_id, operatorId, m]
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


exports.list = async (plant_id, query, company_id) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = query.search || '';
  const sortBy = query.sortBy || 'o.created_at';
  const order = query.order === 'asc' ? 'ASC' : 'DESC';

  const values = [company_id];
  let where = `WHERE o.company_id = $1`;

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

// operator.service.js

exports.update = async (id, data, plant_id, company_id) => {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 🔹 Update basic operator fields (dynamic)
    const fields = [];
    const values = [];
    let index = 1;

    const allowedFields = [
      'operator_code',
      'operator_name',
      'skill_level',
      'is_active'
    ];

    allowedFields.forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = $${index}`);
        values.push(data[field]);
        index++;
      }
    });

    if (fields.length > 0) {
      values.push(id);
      values.push(company_id);

      await client.query(
        `
        UPDATE operators
        SET ${fields.join(', ')}
        WHERE id = $${index} AND company_id = $${index + 1}
        `,
        values
      );
    }

    // 🔹 Update shift assignment
    if (data.shift_id) {
      await client.query(
        `
        UPDATE operator_shift_assignments
        SET is_active = FALSE
        WHERE operator_id = $1
        `,
        [id]
      );

      await client.query(
        `
        INSERT INTO operator_shift_assignments
        (company_id, operator_id, shift_id, effective_from)
        VALUES ($1,$2,$3,CURRENT_DATE)
        `,
        [company_id, id, data.shift_id]
      );
    }

    // 🔹 Update machine assignments
    if (data.machine_ids) {
      await client.query(
        `
        UPDATE operator_machine_assignments
        SET is_active = FALSE
        WHERE operator_id = $1
        `,
        [id]
      );

      for (const m of data.machine_ids) {
        await client.query(
          `
          INSERT INTO operator_machine_assignments
          (company_id, operator_id, machine_id, assigned_from)
          VALUES ($1,$2,$3,CURRENT_DATE)
          `,
          [company_id, id, m]
        );
      }
    }

    await client.query('COMMIT');

    return {
      status: 'success',
      message: 'Operator updated successfully'
    };

  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.getById = async (id, plant_id, company_id) => {

  // Basic operator
  const operator = await db.query(
    `SELECT id, operator_code, operator_name, skill_level, is_active
     FROM operators
     WHERE id = $1 AND company_id = $2`,
    [id, company_id]
  );

  if (operator.rowCount === 0) {
    throw new Error('Operator not found');
  }

  // Active shift
  const shift = await db.query(
    `SELECT shift_id
     FROM operator_shift_assignments
     WHERE operator_id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [id]
  );

  // Active machines
  const machines = await db.query(
    `SELECT machine_id
     FROM operator_machine_assignments
     WHERE operator_id = $1
       AND is_active = TRUE`,
    [id]
  );

  return {
    status: 'success',
    data: {
      ...operator.rows[0],
      shift_id: shift.rows[0]?.shift_id || null,
      machine_ids: machines.rows.map(m => m.machine_id)
    }
  };
};
exports.remove = async (id, plant_id, company_id) => {
  const result = await db.query(
    `DELETE FROM operators WHERE id = $1 AND company_id = $2 RETURNING id`,
    [id, company_id]
  );

  if (result.rowCount === 0) {
    const err = new Error('Operator not found');
    err.status = 404;
    throw err;
  }

  return { status: 'success', message: 'Operator deleted successfully' };
};
