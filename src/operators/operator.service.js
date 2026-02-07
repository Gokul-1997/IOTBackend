const db = require('../db');

exports.create = async (data, plant_id) => {
  const { rows } = await db.query(
    `INSERT INTO operators (plant_id, operator_code, operator_name, skill_level)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [plant_id, data.operator_code, data.operator_name, data.skill_level]
  );
  return rows[0];
};

exports.list = async plant_id => {
  const { rows } = await db.query(
    `SELECT * FROM operators WHERE plant_id=$1 AND is_active=TRUE`,
    [plant_id]
  );
  return rows;
};
