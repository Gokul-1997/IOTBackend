const db = require('../db');

exports.create = async role =>
  (await db.query(
    `INSERT INTO roles (role_name) VALUES ($1) RETURNING *`,
    [role.role_name]
  )).rows[0];

exports.assign = async (user_id, role_ids) => {
  await db.query(`DELETE FROM user_roles WHERE user_id=$1`, [user_id]);
  for (const r of role_ids) {
    await db.query(
      `INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)`,
      [user_id, r]
    );
  }
};
