const db = require('../db');
const pwd = require('../utils/password');

exports.create = async (data, plant_id) => {
  const hash = await pwd.hash(data.password);

  const { rows } = await db.query(
    `INSERT INTO users (username,password_hash,plant_id)
     VALUES ($1,$2,$3) RETURNING id,username,plant_id`,
    [data.username, hash, plant_id]
  );
  return rows[0];
};

exports.list = async plant_id => {
  const { rows } = await db.query(
    `SELECT id,username FROM users WHERE plant_id=$1`,
    [plant_id]
  );
  return rows;
};
