const pool = require('../db');
const { idOrNull, resolvePlantId } = require('../lib/plant-scope');
function name(value) {
  const n = String(value || '').trim();
  if (!n || n.length > 100) throw { status: 400, message: 'Line name must be 1 to 100 characters' };
  return n;
}
function active(value) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw { status: 400, message: 'is_active must be true or false' };
  return value;
}
async function currentLine(client, req) {
  const { rows } = await client.query(
    `SELECT id, plant_id FROM line WHERE id = $1 AND company_id = $2
       AND ($3::int IS NULL OR plant_id = $3) FOR UPDATE`,
    [idOrNull(req.params.id, 'Line'), req.user.company_id, req.user.plant_id ?? null]
  );
  if (!rows.length) throw { status: 404, message: 'Line not found' };
  return rows[0];
}
exports.createLine = async req => {
  const lineName = name(req.body.name), enabled = active(req.body.is_active);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plant = await resolvePlantId(client, req.user, req.body.plant_id);
    const { rows } = await client.query(
      'INSERT INTO line (plant_id, company_id, name, is_active) VALUES ($1,$2,$3,$4) RETURNING *',
      [plant, req.user.company_id, lineName, enabled]
    );
    await client.query('COMMIT'); return rows[0];
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
};
exports.getLines = async req => {
  const plant = req.user.plant_id || idOrNull(req.query?.plant_id, 'Plant');
  const { rows } = await pool.query(
    `SELECT id, name, is_active, plant_id FROM line WHERE company_id = $1
       AND ($2::int IS NULL OR plant_id = $2) ORDER BY name`, [req.user.company_id, plant ?? null]
  );
  return rows;
};
exports.updateLine = async req => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = name(req.body.name);
  if (req.body.is_active !== undefined) patch.is_active = active(req.body.is_active);
  if (!Object.keys(patch).length && req.body.plant_id === undefined) throw { status: 400, message: 'No fields to update' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await currentLine(client, req);
    const plant = await resolvePlantId(client, req.user, req.body.plant_id !== undefined ? req.body.plant_id : current.plant_id);
    if (plant !== Number(current.plant_id)) {
      const { rows } = await client.query('SELECT id FROM machines WHERE line_id = $1 AND company_id = $2 AND plant_id IS DISTINCT FROM $3 LIMIT 1', [current.id, req.user.company_id, plant]);
      if (rows.length) throw { status: 409, message: 'Reassign the machines on this line before changing its plant' };
    }
    patch.plant_id = plant;
    const values = Object.values(patch); values.push(current.id, req.user.company_id);
    const { rows } = await client.query(
      `UPDATE line SET ${Object.keys(patch).map((key, i) => `${key} = $${i + 1}`).join(', ')}
        WHERE id = $${values.length - 1} AND company_id = $${values.length} RETURNING *`, values
    );
    await client.query('COMMIT'); return rows[0];
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
};
exports.deleteLine = async req => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await currentLine(client, req);
    const { rows } = await client.query('SELECT id FROM machines WHERE line_id = $1 AND company_id = $2 LIMIT 1', [current.id, req.user.company_id]);
    if (rows.length) throw { status: 409, message: 'Cannot delete line. Machines are assigned.' };
    await client.query('DELETE FROM line WHERE id = $1 AND company_id = $2', [current.id, req.user.company_id]);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
};
