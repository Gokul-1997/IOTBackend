const db = require('../db');

exports.getPlants = async (companyId, { search = '', page = 1, limit = 10 }) => {
  const offset = (page - 1) * limit;

  const data = await db.query(
    `SELECT * FROM plants
     WHERE company_id = $1
       AND (plant_name ILIKE $2 OR plant_code ILIKE $2)
     ORDER BY id DESC
     LIMIT $3 OFFSET $4`,
    [companyId, `%${search}%`, limit, offset]
  );

  const total = await db.query(
    `SELECT COUNT(*) FROM plants
     WHERE company_id = $1
       AND (plant_name ILIKE $2 OR plant_code ILIKE $2)`,
    [companyId, `%${search}%`]
  );

  return {
    data: data.rows,
    total: Number(total.rows[0].count)
  };
};

exports.getPlantById = async (id, companyId) => {
  const res = await db.query(
    `SELECT * FROM plants WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return res.rows[0] || null;
};

exports.createPlant = async (data, companyId) => {
  const { plant_code, plant_name, location } = data;

  const res = await db.query(
    `INSERT INTO plants (company_id, plant_code, plant_name, location)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [companyId, plant_code, plant_name, location || null]
  );

  return res.rows[0];
};

exports.updatePlant = async (id, data, companyId) => {
  const { plant_name, location } = data;

  const res = await db.query(
    `UPDATE plants
     SET plant_name = $1,
         location   = $2,
         updated_at = NOW()
     WHERE id = $3 AND company_id = $4
     RETURNING *`,
    [plant_name, location, id, companyId]
  );

  if (!res.rowCount) throw { status: 404, message: 'Plant not found' };
  return res.rows[0];
};

exports.togglePlantStatus = async (id, is_active, companyId) => {
  await db.query(
    `UPDATE plants SET is_active = $1 WHERE id = $2 AND company_id = $3`,
    [is_active, id, companyId]
  );
};

exports.deletePlant = async (id, companyId) => {
  const res = await db.query(
    `DELETE FROM plants WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!res.rowCount) throw { status: 404, message: 'Plant not found' };
};
