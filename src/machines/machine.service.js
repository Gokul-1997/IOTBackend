const jwt = require('jsonwebtoken');
const pool = require('../db');
const crypto = require('crypto');

exports.createMachine = async (req) => {
  const {
    machine_code,
    machine_name,
    axis_model,
    controller_model,
    machine_year
  } = req.body;

  if (!machine_code || !machine_name) {
    throw new Error('Machine code and name required');
  }
  const apiKey = crypto.randomUUID();

  const result = await pool.query(
    `INSERT INTO machines
     (plant_id, machine_code, machine_name, axis_model, controller_model, machine_year, api_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      req.user.plant_id,
      machine_code,
      machine_name,
      axis_model,
      controller_model,
      machine_year,
      apiKey
    ]
  );

  return result.rows[0];
};

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

  // ✅ Allowed columns (prevent SQL injection)
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

  // 🔍 Search condition
  let whereSQL = `WHERE plant_id = $1`;
  const values = [plantId];

  if (search) {
    values.push(`%${search}%`);
    whereSQL += `
      AND (
        machine_code ILIKE $${values.length}
        OR machine_name ILIKE $${values.length}
        OR axis_model ILIKE $${values.length}
        OR controller_model ILIKE $${values.length}
      )
    `;
  }

  // 📄 Data query
  const dataQuery = `
    SELECT
      id,
      machine_code,
      machine_name,
      axis_model,
      controller_model,
      machine_year,
      is_active
    FROM machines
    ${whereSQL}
    ORDER BY ${orderColumn} ${orderDirection}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const dataValues = [...values, limit, offset];

  // 🔢 Count query
  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM machines
    ${whereSQL}
  `;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, dataValues),
    pool.query(countQuery, values)
  ]);

  return {
    data: dataRes.rows,
    total: countRes.rows[0].total
  };
};


exports.toggleMachineStatus = async (req) => {
  const { id } = req.params;

  await pool.query(
    `UPDATE machines
     SET is_active = NOT is_active
     WHERE id = $1 AND plant_id = $2`,
    [id, req.user.plant_id]
  );
};

exports.regenerateApiKey = async (req) => {
  const { id } = req.params;
  const newKey = crypto.randomUUID();

  await pool.query(
    `UPDATE machines
     SET api_key = $1,
         tokens = '{}'
     WHERE id = $2 AND plant_id = $3`,
    [newKey, id, req.user.plant_id]
  );

  return newKey;
};


exports.machineAuth = async (req) => {
  const machineCode = req.headers['x-machine-code'];
  const apiKey = req.headers['x-api-key'];

  if (!machineCode || !apiKey) {
    throw new Error('Machine credentials missing');
  }

  const result = await pool.query(
    `SELECT * FROM machines WHERE machine_code = $1 AND is_active = true`,
    [machineCode]
  );

  if (!result.rowCount) {
    throw new Error('Invalid machine');
  }

  const machine = result.rows[0];

  if (machine.api_key !== apiKey) {
    throw new Error('Invalid API key');
  }

  const payload = {
    type: 'MACHINE',
    machine_id: machine.id,
    plant_id: machine.plant_id,
    permissions: ['PUSH_TELEMETRY']
  };

  const token = jwt.sign(payload, process.env.SECRET_CODE, {
    expiresIn: '24h'
  });

  await pool.query(
    `UPDATE machines SET tokens = array_append(tokens, $1) WHERE id = $2`,
    [token, machine.id]
  );

  return { accessToken: token };
};