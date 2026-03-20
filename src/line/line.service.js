const pool = require('../db');

/* CREATE LINE */
exports.createLine = async (req) => {
  const { name } = req.body;
  // FIX: plant_id from authenticated user (was missing, caused NOT NULL violation)
  const plant_id = req.user.plant_id;

  if (!name) throw new Error('Line name required');

  const result = await pool.query(
    `INSERT INTO line (plant_id, name)
     VALUES ($1, $2)
     RETURNING *`,
    [plant_id, name]
  );

  return result.rows[0];
};

/* LIST LINES */
exports.getLines = async (req) => {
  // FIX: filter by plant_id so users only see their own plant's lines
  const plant_id = req.user.plant_id;

  const result = await pool.query(
    `SELECT id, name
     FROM line
     WHERE plant_id = $1
     ORDER BY name`,
    [plant_id]
  );

  return result.rows;
};

/* UPDATE LINE */
exports.updateLine = async (req) => {
  const { id } = req.params;
  const { name } = req.body;

  const result = await pool.query(
    `UPDATE line
     SET name = $1
     WHERE id = $2
     RETURNING *`,
    [name, id]
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

  await pool.query(`DELETE FROM line WHERE id = $1`, [id]);
};