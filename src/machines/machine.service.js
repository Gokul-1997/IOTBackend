const pool = require('../db');
const crypto = require('crypto');

/* CREATE MACHINE (ADMIN) */
exports.createMachine = async (req) => {
  const {
    machine_name,
    line_id,
    image_url,
    axis_model,
    controller_model,
    machine_year
  } = req.body;

  if (!machine_name || !line_id) {
    throw new Error('Machine name and line required');
  }

  const apiKey = crypto.randomBytes(16).toString('hex');

  const result = await pool.query(
    `
    INSERT INTO machines
    (plant_id, machine_name, line_id,
     image_url, axis_model, controller_model, machine_year, api_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, machine_name, line_id, api_key
    `,
    [
      req.user.plant_id,
      machine_name,
      line_id,
      image_url,
      axis_model,
      controller_model,
      machine_year,
      apiKey
    ]
  );

  const newMachineId = result.rows[0].id;

  // Auto link machine to all existing shifts
  await pool.query(`
    INSERT INTO machine_shift_config (plant_id, machine_id, shift_id)
    SELECT $1, $2, id
    FROM shifts
    WHERE plant_id = $1
  `, [req.user.plant_id, newMachineId]);

  return result.rows[0];
};

/* LIST MACHINES */
exports.getMachines = async (req) => {
  const {
    search = '',
    page = 1,
    limit = 10,
    sortBy = 'm.id',
    sortDir = 'desc'
  } = req.query;

  const plantId = req.user.plant_id;
  const offset = (page - 1) * limit;

  const sortableColumns = [
    'm.id',
    'm.machine_name',
    'm.axis_model',
    'm.controller_model',
    'm.machine_year',
    'm.is_active'
  ];

  const orderColumn = sortableColumns.includes(sortBy)
    ? sortBy
    : 'm.id';

  const orderDirection =
    sortDir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let whereSQL = `WHERE m.plant_id = $1`;
  const values = [plantId];

  if (search) {
    values.push(`%${search}%`);
    whereSQL += `
      AND (
        m.machine_name ILIKE $${values.length}
        OR m.axis_model ILIKE $${values.length}
        OR m.controller_model ILIKE $${values.length}
      )
    `;
  }

  const dataQuery = `
    SELECT m.id,
           m.machine_name,
           m.image_url,
           m.axis_model,
           m.controller_model,
           m.machine_year,
           m.is_active,
           m.line_id,
           l.name AS line_name
    FROM machines m
    LEFT JOIN line l ON l.id = m.line_id
    ${whereSQL}
    ORDER BY ${orderColumn} ${orderDirection}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM machines m
    ${whereSQL}
  `;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [...values, limit, offset]),
    pool.query(countQuery, values)
  ]);

  return {
    data: dataRes.rows,
    total: countRes.rows[0].total
  };
};

/* ENABLE / DISABLE MACHINE */
exports.toggleMachineStatus = async (req) => {
  const { id } = req.params;

  await pool.query(
    `UPDATE machines
     SET is_active = NOT is_active
     WHERE id = $1 AND plant_id = $2`,
    [id, req.user.plant_id]
  );
};

/* REGENERATE API KEY */
exports.regenerateApiKey = async (req) => {
  const { id } = req.params;
  const newKey = crypto.randomBytes(16).toString('hex');

  await pool.query(
    `UPDATE machines
     SET api_key = $1
     WHERE id = $2 AND plant_id = $3`,
    [newKey, id, req.user.plant_id]
  );

  return newKey;
};


/* DELETE MACHINE */
exports.deleteMachine = async (req) => {
  const { id } = req.params;

  const result = await pool.query(
    `DELETE FROM machines
     WHERE id = $1 AND plant_id = $2
     RETURNING id`,
    [id, req.user.plant_id]
  );

  if (result.rowCount === 0) {
    throw new Error('Machine not found or access denied');
  }
};

/* UPDATE MACHINE (ADMIN) */
exports.updateMachine = async (req) => {
  const { id } = req.params;
  const plantId = req.user.plant_id;

  const allowedFields = [
    'machine_name',
    'line_id',
    'image_url',
    'axis_model',
    'controller_model',
    'machine_year'
  ];

  const fields = [];
  const values = [];
  let index = 1;

  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = $${index}`);
      values.push(req.body[key]);
      index++;
    }
  }

  if (fields.length === 0) {
    throw new Error('No fields provided for update');
  }

  const query = `
    UPDATE machines
    SET ${fields.join(', ')}
    WHERE id = $${index}
      AND plant_id = $${index + 1}
    RETURNING *
  `;

  values.push(id, plantId);

  const result = await pool.query(query, values);

  if (result.rowCount === 0) {
    throw new Error('Machine not found or access denied');
  }

  return result.rows[0];
};