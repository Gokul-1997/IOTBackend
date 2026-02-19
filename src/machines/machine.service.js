const pool = require('../db');
const crypto = require('crypto');

/* CREATE MACHINE (ADMIN) */
exports.createMachine = async (req) => {
  const {
    machine_name,
    image_url,
    axis_model,
    controller_model,
    machine_year
  } = req.body;

  if (!machine_name) {
    throw new Error('Machine name required');
  }

  const apiKey = crypto.randomBytes(16).toString('hex');

  const result = await pool.query(
    `INSERT INTO machines
     (plant_id, machine_name, image_url, axis_model, controller_model, machine_year, api_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, machine_name, api_key`,
    [
      req.user.plant_id,
      machine_name,
      image_url,
      axis_model,
      controller_model,
      machine_year,
      apiKey
    ]
  );

  return result.rows[0];
};

/* LIST MACHINES */
exports.getMachines = async (req) => {
  const {
    search = '',
    page = 1,
    limit = 10,
    sortBy = 'id',
    sortDir = 'desc'
  } = req.query;

  const plantId = req.user.plant_id;
  const offset = (page - 1) * limit;

  const sortableColumns = [
    'id',
    'machine_name',
    'axis_model',
    'controller_model',
    'machine_year',
    'is_active'
  ];

  const orderColumn = sortableColumns.includes(sortBy) ? sortBy : 'id';
  const orderDirection = sortDir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let whereSQL = `WHERE plant_id = $1`;
  const values = [plantId];

  if (search) {
    values.push(`%${search}%`);
    whereSQL += `
      AND (
        machine_name ILIKE $${values.length}
        OR axis_model ILIKE $${values.length}
        OR controller_model ILIKE $${values.length}
      )
    `;
  }

  const dataQuery = `
    SELECT id, machine_name,image_url,axis_model, controller_model,
           machine_year, is_active
    FROM machines
    ${whereSQL}
    ORDER BY ${orderColumn} ${orderDirection}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM machines
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
