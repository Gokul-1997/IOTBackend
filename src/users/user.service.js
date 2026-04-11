const db = require('../db');
const pwd = require('../utils/password');

exports.create = async (data, reqUser) => {
  if (!data.username || !data.email || !data.password) {
    throw { status: 400, message: 'Username, email, and password are required' };
  }

  // SNT_SUPER must specify company_id; company admin uses own company
  let company_id = null;
  let plant_id = reqUser.plant_id || 1;

  if (reqUser.is_snt_super) {
    if (!data.company_id) throw { status: 400, message: 'Company is required when creating a user' };
    company_id = data.company_id;
  } else {
    company_id = reqUser.company_id;
  }

  const hash = await pwd.hash(data.password);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Check if email already exists
    const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [data.email]);
    if (existing.rowCount > 0) throw { status: 400, message: 'Email already exists' };

    // Create user
    const { rows } = await client.query(
      `INSERT INTO users (username, email, password_hash, plant_id, company_id, user_type, is_active)
       VALUES ($1, $2, $3, $4, $5, 'company_user', true)
       RETURNING id, username, email, plant_id, company_id, is_active`,
      [data.username, data.email, hash, plant_id, company_id]
    );

    const user = rows[0];
    const roleIds = data.role_ids || [];

    if (roleIds.length > 0) {
      for (const roleId of roleIds) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
          [user.id, roleId]
        );
      }
    } else {
      // Assign default OPERATOR role
      const defaultRole = await client.query(`SELECT id FROM roles WHERE role_name = 'OPERATOR'`);
      if (defaultRole.rowCount > 0) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
          [user.id, defaultRole.rows[0].id]
        );
      }
    }

    // Fetch assigned roles
    const roleRes = await client.query(
      `SELECT r.id, r.role_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
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

exports.list = async (reqUser) => {
  let query, params;

  if (reqUser.is_snt_super) {
    // SNT_SUPER sees all users (except self)
    query = `SELECT u.id, u.username, u.email, u.is_active, u.company_id, u.user_type,
                    c.company_name
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE u.user_type != 'snt_super'
             ORDER BY c.company_name NULLS LAST, u.username`;
    params = [];
  } else if (reqUser.company_id) {
    // Company admin sees only their company's users (excluding themselves)
    query = `SELECT u.id, u.username, u.email, u.is_active, u.company_id, u.user_type
             FROM users u
             WHERE u.company_id = $1 AND u.id != $2 AND u.user_type != 'snt_super'
             ORDER BY u.username`;
    params = [reqUser.company_id, reqUser.id];
  } else {
    query = `SELECT u.id, u.username, u.email, u.is_active, u.company_id, u.user_type
             FROM users u
             WHERE u.plant_id = $1
             ORDER BY u.username`;
    params = [reqUser.plant_id];
  }

  const { rows } = await db.query(query, params);

  // Fetch roles for each user
  for (const user of rows) {
    const roleRes = await db.query(
      `SELECT r.id, r.role_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
      [user.id]
    );
    user.roles = roleRes.rows;
  }

  return rows;
};

exports.getById = async (userId, reqUser) => {
  let query, params;

  if (reqUser.is_snt_super) {
    query = `SELECT id, username, email, is_active, plant_id, company_id, user_type FROM users WHERE id = $1`;
    params = [userId];
  } else {
    query = `SELECT id, username, email, is_active, plant_id, company_id, user_type FROM users WHERE id = $1 AND company_id = $2`;
    params = [userId, reqUser.company_id];
  }

  const { rows } = await db.query(query, params);
  if (!rows.length) throw { status: 404, message: 'User not found' };

  const user = rows[0];
  const roleRes = await db.query(
    `SELECT r.id, r.role_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
    [userId]
  );
  user.roles = roleRes.rows;
  return user;
};

exports.update = async (userId, reqUser, data) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let query = `UPDATE users SET `;
    const params = [];
    const updates = [];
    let paramIndex = 1;

    if (data.username !== undefined) { updates.push(`username = $${paramIndex++}`); params.push(data.username); }
    if (data.email !== undefined) { updates.push(`email = $${paramIndex++}`); params.push(data.email); }
    if (data.password !== undefined) {
      const hash = await pwd.hash(data.password);
      updates.push(`password_hash = $${paramIndex++}`); params.push(hash);
    }
    if (data.is_active !== undefined) { updates.push(`is_active = $${paramIndex++}`); params.push(data.is_active); }
    if (data.company_id !== undefined && reqUser.is_snt_super) {
      updates.push(`company_id = $${paramIndex++}`); params.push(data.company_id);
    }

    if (!updates.length) {
      await client.query('ROLLBACK');
      throw { status: 400, message: 'No fields to update' };
    }

    query += updates.join(', ');

    if (reqUser.is_snt_super) {
      query += ` WHERE id = $${paramIndex++}`;
      params.push(userId);
    } else {
      query += ` WHERE id = $${paramIndex++} AND company_id = $${paramIndex++}`;
      params.push(userId, reqUser.company_id);
    }

    query += ` RETURNING id, username, email, is_active, plant_id, company_id`;

    const result = await client.query(query, params);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      throw { status: 404, message: 'User not found' };
    }

    const user = result.rows[0];
    const roleRes = await client.query(
      `SELECT r.id, r.role_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
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

exports.remove = async (userId, reqUser) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);

    let result;
    if (reqUser.is_snt_super) {
      result = await client.query(`DELETE FROM users WHERE id = $1 AND user_type != 'snt_super'`, [userId]);
    } else {
      result = await client.query(`DELETE FROM users WHERE id = $1 AND company_id = $2`, [userId, reqUser.company_id]);
    }

    if (!result.rowCount) {
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
