const db = require('../db');

/* CREATE */
exports.create = async (data, plant_id, company_id) => {

  const result = await db.query(`
    INSERT INTO components
    (plant_id, company_id, machine_id, part_name, part_number,
     operation_number, cycle_time, target,
     multiplication_factor)
    VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
  `, [
    company_id,
    data.machine_id,
    data.part_name,
    data.part_number,
    data.operation_number,
    data.cycle_time,
    data.target,
    data.multiplication_factor || 1
  ]);

  const newComponent = result.rows[0];

  // Auto-switch: if this machine has an active job, update it to use the new component
  await db.query(`
    UPDATE machine_current_job
    SET component_id = $1, target_qty = $2, part_name = $3
    WHERE machine_id = $4 AND is_active = TRUE
  `, [newComponent.id, data.target, data.part_name, data.machine_id]);

  return {
    status: 'success',
    data: newComponent
  };
};


/* ===========================
   LIST WITH SEARCH + PAGINATION
=========================== */
exports.list = async (plant_id, query, company_id) => {

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 6;
  const offset = (page - 1) * limit;
  const search = query.search || '';

  const machine_id = query.machine_id || '';

  const values = [company_id];
  let where = `WHERE c.company_id = $1`;

  if (machine_id) {
    values.push(machine_id);
    where += ` AND c.machine_id = $${values.length}`;
  }

  if (search) {
    values.push(`%${search}%`);
    where += `
      AND (
        c.part_name ILIKE $${values.length}
        OR c.part_number ILIKE $${values.length}
        OR m.machine_serial_no ILIKE $${values.length}
      )
    `;
  }

  const totalQuery = `
    SELECT COUNT(*) AS total
    FROM components c
    JOIN machines m ON m.id = c.machine_id
    ${where}
  `;

  const listQuery = `
    SELECT c.*, m.machine_serial_no
    FROM components c
    JOIN machines m ON m.id = c.machine_id
    ${where}
    ORDER BY c.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totalRes = await db.query(totalQuery, values);
  const dataRes = await db.query(listQuery, values);

  return {
    status: 'success',
    data: dataRes.rows,
    meta: {
      page,
      limit,
      total: parseInt(totalRes.rows[0].total),
      totalPages: Math.ceil(totalRes.rows[0].total / limit)
    }
  };
};

/* UPDATE */
exports.update = async (id, data, plant_id, company_id) => {

  const result = await db.query(`
    UPDATE components
    SET part_name=$1,
        part_number=$2,
        operation_number=$3,
        cycle_time=$4,
        target=$5,
        multiplication_factor=$6
    WHERE id=$7 AND company_id=$8
    RETURNING *
  `, [
    data.part_name,
    data.part_number,
    data.operation_number,
    data.cycle_time,
    data.target,
    data.multiplication_factor,
    id,
    company_id
  ]);

  // Cascade: keep active jobs in sync when component target changes
  await db.query(`
    UPDATE machine_current_job
    SET target_qty = $1, part_name = $2
    WHERE component_id = $3 AND is_active = TRUE
  `, [data.target, data.part_name, id]);

  return {
    status: 'success',
    data: result.rows[0]
  };
};


/* DELETE */
exports.remove = async (id, plant_id, company_id) => {

  await db.query(`
    DELETE FROM components
    WHERE id=$1 AND company_id=$2
  `, [id, company_id]);

  return { status: 'success' };
};