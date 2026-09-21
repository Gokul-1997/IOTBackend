const db = require('../db');
const pwd = require('../utils/password');
const { setSupervisedMachines, listSupervisedMachines } = require('../programs/authorization.service');

exports.create = async (data, reqUser) => {
  if (!data.username || !data.email || !data.password) {
    throw { status: 400, message: 'Username, email, and password are required' };
  }
  /* A role is required. With none, this used to hand out OPERATOR — one of
     the retired system roles — so a user created without a choice got a role
     nobody manages. Checked before anything is written. */
  if (!(Array.isArray(data.role_ids) && data.role_ids.some(n => Number.isInteger(Number(n)) && Number(n) > 0))) {
    throw { status: 400, message: 'Choose a role for this user' };
  }

  // SNT_SUPER must specify company_id; company admin uses own company
  let company_id = null;
  let plant_id   = null;

  if (reqUser.is_snt_super) {
    if (!data.company_id) throw { status: 400, message: 'Company is required when creating a user' };
    company_id = data.company_id;
    // SNT_SUPER can optionally assign a plant
    plant_id   = data.plant_id || null;
  } else {
    company_id = reqUser.company_id;

    // COMPANY_ADMIN (plant_id = NULL) can assign user to any plant in their company.
    // PLANT_ADMIN can only assign to their own plant.
    if (data.plant_id) {
      if (reqUser.plant_id && Number(reqUser.plant_id) !== Number(data.plant_id)) {
        throw { status: 403, message: 'You can only assign users to your own plant' };
      }
      // Validate the plant belongs to this company
      const plantCheck = await db.query(
        `SELECT id FROM plants WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [data.plant_id, company_id]
      );
      if (!plantCheck.rowCount) {
        throw { status: 400, message: 'Invalid plant — plant does not exist or does not belong to your company' };
      }
      plant_id = data.plant_id;
    } else {
      // No plant specified — inherit from creator (NULL for company admin, their plant for plant admin)
      plant_id = reqUser.plant_id || null;
    }
  }

  const hash = await pwd.hash(data.password);
  const client = await db.connect();
  let user;

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

    user = rows[0];
    const roleIds = (Array.isArray(data.role_ids) ? data.role_ids : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0);

    /* These used to go straight into user_roles. Nothing checked that the
       role belonged to this company, or that the caller was allowed to
       grant it — so a company admin could create a user holding SNT_SUPER
       and hand themselves the whole platform. assertAssignable also limits
       S&T to creating a company's admin: the company admin creates everyone
       else. */
    await require('../roles/role.service')
      .assertAssignable(client, roleIds, { actor: reqUser, targetCompanyId: company_id });

    for (const roleId of roleIds) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [user.id, roleId]
      );
    }

    // Fetch assigned roles
    const roleRes = await client.query(
      `SELECT r.id, r.role_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
      [user.id]
    );
    user.roles = roleRes.rows;

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Machines this user supervises — the people who authorise program
  // transfers to them. Applied after the user transaction commits so the
  // two never share a client, and skipped entirely when the caller did
  // not send the field.
  if (Array.isArray(data.supervised_machine_ids)) {
    user.supervised_machine_ids = await setSupervisedMachines(
      user.id, user.company_id, data.supervised_machine_ids, reqUser.id
    );
  }

  return user;
};

/* S&T's side of users is company admins only. Each company creates and
   manages its own users; S&T creates the company's admin and nothing else,
   so it has no reason to read — or change — anyone else in a company.
   This is the one condition every S&T query below adds. */
const isCompanyAdmin = alias => `EXISTS (
  SELECT 1 FROM user_roles xa JOIN roles xr ON xr.id = xa.role_id
   WHERE xa.user_id = ${alias}.id AND xr.role_name = 'COMPANY_ADMIN' AND xr.company_id IS NULL)`;

exports.list = async (reqUser) => {
  let query, params;

  if (reqUser.is_snt_super) {
    // S&T sees each company's admins — not the users a company creates
    query = `SELECT u.id, u.username, u.email, u.is_active, u.company_id, u.user_type,
                    c.company_name
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE u.user_type != 'snt_super' AND ${isCompanyAdmin('u')}
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
    query = `SELECT u.id, u.username, u.email, u.is_active, u.plant_id, u.company_id, u.user_type
               FROM users u WHERE u.id = $1 AND ${isCompanyAdmin('u')}`;
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
  user.supervised_machine_ids = await listSupervisedMachines(userId, user.company_id);
  return user;
};

exports.update = async (userId, reqUser, data) => {
  const client = await db.connect();
  const wantsSupervisorChange = Array.isArray(data.supervised_machine_ids);
  let user;

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
    // COMPANY_ADMIN can reassign a user to a different plant within their company
    if (data.plant_id !== undefined && !reqUser.is_snt_super) {
      if (data.plant_id === null || data.plant_id === '') {
        // Allow setting plant_id to NULL (company-wide scope)
        updates.push(`plant_id = $${paramIndex++}`); params.push(null);
      } else {
        // Validate plant belongs to same company
        const plantCheck = await client.query(
          `SELECT id FROM plants WHERE id = $1 AND company_id = $2 AND is_active = true`,
          [data.plant_id, reqUser.company_id]
        );
        if (!plantCheck.rowCount) {
          await client.query('ROLLBACK');
          throw { status: 400, message: 'Invalid plant — plant does not exist or does not belong to your company' };
        }
        updates.push(`plant_id = $${paramIndex++}`); params.push(data.plant_id);
      }
    }
    if (data.plant_id !== undefined && reqUser.is_snt_super) {
      updates.push(`plant_id = $${paramIndex++}`); params.push(data.plant_id || null);
    }

    if (!updates.length && !wantsSupervisorChange) {
      await client.query('ROLLBACK');
      throw { status: 400, message: 'No fields to update' };
    }

    // Changing only the supervised machines touches no user column, but the
    // statement still has to run so the company-scoped WHERE below decides
    // whether this caller may see the user at all (and 404s if not).
    if (!updates.length) updates.push('username = username');

    query += updates.join(', ');

    if (reqUser.is_snt_super) {
      query += ` WHERE id = $${paramIndex++} AND ${isCompanyAdmin('users')}`;
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

    user = result.rows[0];
    const roleRes = await client.query(
      `SELECT r.id, r.role_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
      [userId]
    );
    user.roles = roleRes.rows;

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (wantsSupervisorChange) {
    user.supervised_machine_ids = await setSupervisedMachines(
      user.id, user.company_id, data.supervised_machine_ids, reqUser.id
    );
  }

  return user;
};

exports.remove = async (userId, reqUser) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /* Decide first whether this caller may delete this user, and only then
       touch user_roles — the S&T check reads the user's roles, so clearing
       them first would make every company admin look like an ordinary user.
       Locked so the answer holds until the delete. */
    const target = reqUser.is_snt_super
      ? await client.query(
          `SELECT u.id FROM users u
            WHERE u.id = $1 AND u.user_type != 'snt_super' AND ${isCompanyAdmin('u')} FOR UPDATE`, [userId])
      : await client.query(
          `SELECT id FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`, [userId, reqUser.company_id]);

    if (!target.rowCount) {
      await client.query('ROLLBACK');
      throw { status: 404, message: 'User not found' };
    }

    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
