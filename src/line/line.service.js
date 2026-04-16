const pool = require('../db');

/* CREATE LINE */
exports.createLine = async (req) => {
  const { name, is_active } = req.body;
  const company_id = req.user.company_id;

  if (!name) throw new Error('Line name required');

  const result = await pool.query(
    `INSERT INTO line (plant_id, company_id, name, is_active)
     VALUES (NULL, $1, $2, $3)
     RETURNING *`,
    [company_id, name, is_active !== false]
  );

  return result.rows[0];
};

/* LIST LINES */
exports.getLines = async (req) => {
  const company_id = req.user.company_id;

  const result = await pool.query(
    `SELECT id, name, is_active
     FROM line
     WHERE company_id = $1
     ORDER BY name`,
    [company_id]
  );

  return result.rows;
};

/* UPDATE LINE */
exports.updateLine = async (req) => {
  const { id } = req.params;
  const { name, is_active } = req.body;
  const company_id = req.user.company_id;

  const updates = [];
  const values = [];
  let paramCount = 1;

  if (name !== undefined) {
    updates.push(`name = $${paramCount++}`);
    values.push(name);
  }

  if (is_active !== undefined) {
    updates.push(`is_active = $${paramCount++}`);
    values.push(is_active);
  }

  if (updates.length === 0) {
    throw new Error('No fields to update');
  }

  values.push(id);
  values.push(company_id);

  const result = await pool.query(
    `UPDATE line
     SET ${updates.join(', ')}
     WHERE id = $${paramCount++} AND company_id = $${paramCount++}
     RETURNING *`,
    values
  );

  if (result.rowCount === 0) {
    throw new Error('Line not found');
  }

  return result.rows[0];
};

/* DELETE LINE (SAFE DELETE) */
exports.deleteLine = async (req) => {
  const { id } = req.params;

  // check if machines exist
  const check = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM machines
     WHERE line_id = $1`,
    [id]
  );

  if (check.rows[0].count > 0) {
    throw new Error('Cannot delete line. Machines are assigned.');
  }

  await pool.query(`DELETE FROM line WHERE id = $1 AND company_id = $2`, [id, req.user.company_id]);
};