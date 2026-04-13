const pool = require('../db');
const crypto = require('crypto');

/* CREATE MACHINE (ADMIN) */
exports.createMachine = async (req) => {
  const {
    machine_serial_no,
    line_id,
    x_axis,
    y_axis,
    z_axis,
    fourth_axis,
    twin_spindle,
    twin_table,
    atc_tool_capacity,
    model,
    mmc_no,
    controller,
    spindle_rpm,
    image_url
  } = req.body;

  if (!machine_serial_no) {
    throw new Error("Machine serial number is required");
  }

  const apiKey = crypto.randomBytes(16).toString("hex");

  const result = await pool.query(
    `
    INSERT INTO machines (
      plant_id,
      company_id,
      line_id,
      machine_serial_no,
      x_axis,
      y_axis,
      z_axis,
      fourth_axis,
      twin_spindle,
      twin_table,
      atc_tool_capacity,
      model,
      mmc_no,
      controller,
      spindle_rpm,
      image_url,
      api_key
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )
    RETURNING id, machine_serial_no, api_key
    `,
    [
      req.user.plant_id,
      req.user.company_id,
      line_id || null,
      machine_serial_no,
      x_axis,
      y_axis,
      z_axis,
      fourth_axis,
      twin_spindle,
      twin_table,
      atc_tool_capacity,
      model,
      mmc_no,
      controller,
      spindle_rpm,
      image_url,
      apiKey
    ]
  );

  const newMachineId = result.rows[0].id;

  // Auto link machine to all shifts in same company
  await pool.query(
    `
    INSERT INTO machine_shift_config (plant_id, machine_id, shift_id)
    SELECT $1, $2, id
    FROM shifts
    WHERE company_id = $3
    `,
    [req.user.plant_id, newMachineId, req.user.company_id]
  );

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

  const companyId = req.user.company_id;
  const offset = (page - 1) * limit;

  const sortableColumns = [
    'm.id',
    'm.machine_serial_no',
    'm.model',
    'm.controller',
    'm.spindle_rpm',
    'm.is_active',
    'l.name'     // FIX: was 'l.line_name' but column is 'name' in line table
  ];

  const orderColumn = sortableColumns.includes(sortBy)
    ? sortBy
    : 'm.id';

  const orderDirection =
    sortDir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let whereSQL = `WHERE m.company_id = $1`;
  const values = [companyId];

  if (search) {
    values.push(`%${search}%`);

    whereSQL += `
      AND (
        m.machine_serial_no ILIKE $${values.length}
        OR m.model ILIKE $${values.length}
        OR m.controller ILIKE $${values.length}
        OR l.name ILIKE $${values.length}    /* FIX: was l.line_name (wrong column name) */
      )
    `;
  }

  const dataQuery = `
    SELECT 
      m.id,
      m.machine_serial_no,
      m.line_id,
      l.name,
      m.image_url,
      m.x_axis,
      m.y_axis,
      m.z_axis,
      m.fourth_axis,
      m.twin_spindle,
      m.twin_table,
      m.atc_tool_capacity,
      m.model,
      m.mmc_no,
      m.controller,
      m.spindle_rpm,
      m.api_key,
      m.is_active,
      m.created_at
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
    LEFT JOIN line l ON l.id = m.line_id
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
     WHERE id = $1 AND company_id = $2`,
    [id, req.user.company_id]
  );
};

/* REGENERATE API KEY */
exports.regenerateApiKey = async (req) => {
  const { id } = req.params;
  const newKey = crypto.randomBytes(16).toString('hex');

  await pool.query(
    `UPDATE machines
     SET api_key = $1
     WHERE id = $2 AND company_id = $3`,
    [newKey, id, req.user.company_id]
  );

  return newKey;
};


/* DELETE MACHINE */
exports.deleteMachine = async (req) => {
  const { id } = req.params;

  const result = await pool.query(
    `DELETE FROM machines
     WHERE id = $1 AND company_id = $2
     RETURNING id`,
    [id, req.user.company_id]
  );

  if (result.rowCount === 0) {
    throw new Error('Machine not found or access denied');
  }
};

/* UPDATE MACHINE (ADMIN) */
exports.updateMachine = async (req) => {

  const { id } = req.params;
  const companyId = req.user.company_id;

  const allowedFields = [
    'machine_serial_no',
    'line_id',
    'x_axis',
    'y_axis',
    'z_axis',
    'fourth_axis',
    'twin_spindle',
    'twin_table',
    'atc_tool_capacity',
    'model',
    'mmc_no',
    'controller',
    'spindle_rpm',
    'image_url'
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
      AND company_id = $${index + 1}
    RETURNING *
  `;

  values.push(id, companyId);

  const result = await pool.query(query, values);

  if (result.rowCount === 0) {
    throw new Error('Machine not found or access denied');
  }

  return result.rows[0];
};