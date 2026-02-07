const db = require('../db');

exports.getPlants = async ({ search = '', page = 1, limit = 10 }) => {
  const offset = (page - 1) * limit;

  const data = await db.query(
    `
    SELECT * FROM plants
    WHERE plant_name ILIKE $1 OR plant_code ILIKE $1
    ORDER BY id DESC
    LIMIT $2 OFFSET $3
    `,
    [`%${search}%`, limit, offset]
  );

  const total = await db.query(
    `SELECT COUNT(*) FROM plants WHERE plant_name ILIKE $1 OR plant_code ILIKE $1`,
    [`%${search}%`]
  );

  return {
    data: data.rows,
    total: Number(total.rows[0].count)
  };
};

exports.getPlantById = async (id) => {
  const res = await db.query(`SELECT * FROM plants WHERE id = $1`, [id]);
  return res.rows[0];
};

exports.createPlant = async (data) => {
  const { plant_code, plant_name, location } = data;

  const res = await db.query(
    `
    INSERT INTO plants (plant_code, plant_name, location)
    VALUES ($1, $2, $3)
    RETURNING *
    `,
    [plant_code, plant_name, location]
  );

  return res.rows[0];
};

exports.updatePlant = async (id, data) => {
  const { plant_name, location } = data;

  const res = await db.query(
    `
    UPDATE plants
    SET plant_name = $1,
        location = $2,
        updated_at = NOW()
    WHERE id = $3
    RETURNING *
    `,
    [plant_name, location, id]
  );

  return res.rows[0];
};

exports.togglePlantStatus = async (id, is_active) => {
  await db.query(
    `UPDATE plants SET is_active = $1 WHERE id = $2`,
    [is_active, id]
  );
};

exports.deletePlant = async (id) => {
  await db.query(`DELETE FROM plants WHERE id = $1`, [id]);
};
