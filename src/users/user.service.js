const db = require('../db');
const pwd = require('../utils/password');

exports.create = async (data, plant_id) => {
  if (!data.username || !data.email || !data.password) {
    throw { status: 400, message: 'Username, email, and password are required' };
  }

  const hash = await pwd.hash(data.password);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Check if email already exists
    const existingUser = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [data.email]
    );
    if (existingUser.rowCount > 0) {
      throw { status: 400, message: 'Email already exists' };
    }

    // Create user
    const { rows } = await client.query(
      `INSERT INTO users (username, email, password_hash, plant_id, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, username, email, plant_id, is_active`,
      [data.username, data.email, hash, plant_id]
    );

    const user = rows[0];
    const roleIds = data.role_ids || [];

    // Assign specific roles if provided
    if (roleIds.length > 0) {
      for (const roleId of roleIds) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
          [user.id, roleId]
        );
      }
    } else {
      // Assign default OPERATOR role
      const defaultRole = await client.query(
        `SELECT id FROM roles WHERE role_name = 'OPERATOR'`
      );

      if (defaultRole.rowCount === 0) {
        throw { status: 500, message: 'OPERATOR role does not exist. Create it first.' };
      }

      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [user.id, defaultRole.rows[0].id]
      );
    }

    // Fetch assigned roles for response
    const roleRes = await client.query(
      `SELECT r.id, r.role_name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [user.id]
    );

    user.roles = roleRes.rows;

    await client.query('COMMIT');
    return user;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.list = async plant_id => {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email, u.is_active
     FROM users u
     WHERE u.plant_id = $1
     ORDER BY u.id`,
    [plant_id]
  );

  // Fetch roles for each user
  for (const user of rows) {
    const roleRes = await db.query(
      `SELECT r.id, r.role_name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [user.id]
    );
    user.roles = roleRes.rows;
  }

  return rows;
};

exports.getById = async (userId, plant_id) => {
  const { rows } = await db.query(
    `SELECT id, username, email, is_active, plant_id
     FROM users
     WHERE id = $1 AND plant_id = $2`,
    [userId, plant_id]
  );

  if (!rows.length) throw { status: 404, message: 'User not found' };

  const user = rows[0];

  // Fetch roles
  const roleRes = await db.query(
    `SELECT r.id, r.role_name
     FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [userId]
  );
  user.roles = roleRes.rows;

  return user;
};

exports.update = async (userId, plant_id, data) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let query = `UPDATE users SET `;
    const params = [];
    const updates = [];
    let paramIndex = 1;

    if (data.username !== undefined) {
      updates.push(`username = $${paramIndex++}`);
      params.push(data.username);
    }
    if (data.email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      params.push(data.email);
    }
    if (data.password !== undefined) {
      const hash = await pwd.hash(data.password);
      updates.push(`password_hash = $${paramIndex++}`);
      params.push(hash);
    }
    if (data.is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(data.is_active);
    }

    if (!updates.length) {
      await client.query('ROLLBACK');
      throw { status: 400, message: 'No fields to update' };
    }

    query += updates.join(', ');
    query += ` WHERE id = $${paramIndex++} AND plant_id = $${paramIndex++}`;
    params.push(userId, plant_id);

    query += ` RETURNING id, username, email, is_active, plant_id`;

    const result = await client.query(query, params);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      throw { status: 404, message: 'User not found' };
    }

    const user = result.rows[0];

    // Fetch roles
    const roleRes = await client.query(
      `SELECT r.id, r.role_name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [userId]
    );
    user.roles = roleRes.rows;

    await client.query('COMMIT');
    return user;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.remove = async (userId, plant_id) => {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Delete user_roles first (foreign key constraint)
    await client.query(
      `DELETE FROM user_roles WHERE user_id = $1`,
      [userId]
    );

    // Delete user
    const { rowCount } = await client.query(
      `DELETE FROM users
       WHERE id = $1 AND plant_id = $2`,
      [userId, plant_id]
    );

    if (!rowCount) {
      await client.query('ROLLBACK');
      throw { status: 404, message: 'User not found' };
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
