const db = require('../db');
const pwd = require('../utils/password');
const { setSupervisedMachines, listSupervisedMachines } = require('../programs/authorization.service');

exports.create = async (data, reqUser) => {
  /* A company's admin is made with the company, and that admin adds
     everyone else — a second full-access person included. S&T adds no one. */
  if (reqUser.is_snt_super) {
    throw { status: 403, message: "A company's admin is created with the company. The company admin adds everyone else." };
  }
  if (!data.username || !data.email || !data.password) {
    throw { status: 400, message: 'Username, email, and password are required' };
  }
  /* A role is required. With none, this used to hand out OPERATOR — one of
     the retired system roles — so a user created without a choice got a role
     nobody manages. Checked before anything is written. */
  if (!(Array.isArray(data.role_ids) && data.role_ids.some(n => Number.isInteger(Number(n)) && Number(n) > 0))) {
    throw { status: 400, message: 'Choose a role for this user' };
  }

  // the new user joins the creator's own company
  const company_id = reqUser.company_id;
  let plant_id   = null;

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
       and hand themselves the whole platform. */
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

/* S&T's side of users is one admin per company: the one made with the
   company. Each company creates and manages its own users — a second
   full-access admin included — so S&T has no reason to read or change
   anyone else in a company. This is the one condition every S&T query
   below adds.

   "The one made with the company" is the company's earliest user holding
   the shared Company Admin role. Company create adds that admin in the
   same transaction as the company, so it always has the company's lowest
   user id; if the company later removes that person, S&T sees whichever
   admin it made next. */
const isTheCompanyAdmin = alias => `${alias}.id = (
  SELECT MIN(xa.user_id) FROM user_roles xa
    JOIN roles xr ON xr.id = xa.role_id
    JOIN users xu ON xu.id = xa.user_id
   WHERE xu.company_id = ${alias}.company_id
     AND xr.role_name = 'COMPANY_ADMIN' AND xr.company_id IS NULL)`;

/** What S&T may change about a company's admin. The company is not on the
 *  list: the admin belongs to the company they were created with. */
const SNT_EDITABLE = ['username', 'email', 'password', 'is_active'];

exports.list = async (reqUser) => {
  let query, params;

  if (reqUser.is_snt_super) {
    // S&T sees each company's admin — not the users a company creates
    query = `SELECT u.id, u.username, u.email, u.is_active, u.company_id, u.user_type,
                    c.company_name, COALESCE(c.is_active, true) AS company_active
             FROM users u
             LEFT JOIN companies c ON c.id = u.company_id
             WHERE u.user_type != 'snt_super' AND ${isTheCompanyAdmin('u')}
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
               FROM users u WHERE u.id = $1 AND ${isTheCompanyAdmin('u')}`;
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
  if (reqUser.is_snt_super) {
    const other = Object.keys(data || {}).filter(k => data[k] !== undefined && !SNT_EDITABLE.includes(k));
    if (other.length) {
      throw {
        status: 400,
        message: "S&T can change a company admin's name, email, password and active status only. The company can't be changed."
      };
    }
  }

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
      query += ` WHERE id = $${paramIndex++} AND ${isTheCompanyAdmin('users')}`;
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
  /* S&T can't add a company admin, so it can't take one away either — the
     company would be left with nobody to run it. The admin goes with the
     company; to hand the account to someone else, edit its name, email and
     password. */
  if (reqUser.is_snt_super) {
    throw { status: 403, message: "A company's admin is removed only with the company. To give the account to someone else, edit its name, email and password." };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Locked so the answer holds until the delete
    const target = await client.query(
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
