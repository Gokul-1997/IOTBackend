const db = require('../db');

// ── Legacy: kept for backward-compat seed on startup ─────────
const LEGACY_API_PERMISSIONS = [
  { key: 'line.view',        desc: 'View lines',              roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'line.create',      desc: 'Create lines',            roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR'] },
  { key: 'line.update',      desc: 'Update lines',            roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR'] },
  { key: 'line.delete',      desc: 'Delete lines',            roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'machine.view',     desc: 'View machines',           roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'machine.create',   desc: 'Create machines',         roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'machine.update',   desc: 'Update machines',         roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'machine.delete',   desc: 'Delete machines',         roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'operator.view',    desc: 'View operators',          roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'operator.create',  desc: 'Create operators',        roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR'] },
  { key: 'operator.update',  desc: 'Update operators',        roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR'] },
  { key: 'operator.delete',  desc: 'Delete operators',        roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'shift.view',       desc: 'View shifts',             roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'shift.create',     desc: 'Create shifts',           roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'shift.update',     desc: 'Update shifts',           roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'shift.delete',     desc: 'Delete shifts',           roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'component.view',   desc: 'View components',         roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'component.create', desc: 'Create components',       roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR'] },
  { key: 'component.update', desc: 'Update components',       roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR'] },
  { key: 'component.delete', desc: 'Delete components',       roles: ['SNT_SUPER','COMPANY_ADMIN'] },
];

/**
 * Seed all system roles + legacy API permissions.
 * Called on app startup.
 */
exports.seedPagePermissions = async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Seed legacy API permissions
    for (const perm of LEGACY_API_PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (permission_key, description)
         VALUES ($1, $2) ON CONFLICT (permission_key) DO NOTHING`,
        [perm.key, perm.desc]
      );
      for (const roleName of perm.roles) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id
           FROM roles r, permissions p
           WHERE r.role_name = $1 AND p.permission_key = $2
           ON CONFLICT DO NOTHING`,
          [roleName, perm.key]
        );
      }
    }

    // SNT_SUPER gets ALL permissions
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
       WHERE r.role_name = 'SNT_SUPER'
       ON CONFLICT DO NOTHING`
    );

    await client.query('COMMIT');
    return { seeded: LEGACY_API_PERMISSIONS.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// ── Role CRUD (company-scoped) ─────────────────────────────────

/**
 * List roles for a company (+ system roles that apply to all).
 * SNT_SUPER sees all.
 */
exports.list = async ({ company_id, is_snt_super = false } = {}) => {
  let query, params;

  if (is_snt_super) {
    query  = `SELECT r.id, r.role_name, r.description, r.is_system, r.company_id,
                     c.company_name
              FROM roles r
              LEFT JOIN companies c ON c.id = r.company_id
              ORDER BY r.is_system DESC, r.role_name`;
    params = [];
  } else if (company_id) {
    query  = `SELECT r.id, r.role_name, r.description, r.is_system, r.company_id
              FROM roles r
              WHERE r.company_id = $1 OR r.is_system = true
              ORDER BY r.is_system DESC, r.role_name`;
    params = [company_id];
  } else {
    query  = `SELECT r.id, r.role_name, r.description, r.is_system, r.company_id
              FROM roles r ORDER BY r.is_system DESC, r.role_name`;
    params = [];
  }

  const { rows } = await db.query(query, params);

  for (const role of rows) {
    const { rows: perms } = await db.query(
      `SELECT p.id, p.permission_key, p.description
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1 ORDER BY p.permission_key`,
      [role.id]
    );
    role.permissions = perms;
  }

  return rows;
};

exports.getById = async (roleId) => {
  const { rows } = await db.query(
    `SELECT r.id, r.role_name, r.description, r.is_system, r.company_id
     FROM roles r WHERE r.id = $1`,
    [roleId]
  );
  if (!rows.length) throw { status: 404, message: 'Role not found' };

  const role = rows[0];
  const { rows: perms } = await db.query(
    `SELECT p.id, p.permission_key, p.description
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = $1 ORDER BY p.permission_key`,
    [roleId]
  );
  role.permissions = perms;
  return role;
};

/**
 * Create a custom role scoped to a company.
 */
exports.create = async ({ role_name, description, company_id, is_system = false, permission_ids = [] }) => {
  if (!role_name) throw { status: 400, message: 'role_name is required' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO roles (role_name, description, company_id, is_system)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [role_name, description || null, company_id || null, is_system]
    );
    const role = rows[0];

    if (permission_ids.length) {
      for (const pid of permission_ids) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role.id, pid]
        );
      }
    }

    await client.query('COMMIT');
    return role;
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw { status: 409, message: 'Role name already exists' };
    throw e;
  } finally {
    client.release();
  }
};

exports.update = async (roleId, { role_name, description }) => {
  const { rows } = await db.query(
    `UPDATE roles SET
       role_name   = COALESCE($1, role_name),
       description = COALESCE($2, description),
       updated_at  = now()
     WHERE id = $3 AND is_system = false
     RETURNING *`,
    [role_name, description, roleId]
  );
  if (!rows.length) throw { status: 404, message: 'Role not found or is a system role (cannot modify)' };
  return rows[0];
};

/**
 * Replace a role's permissions entirely.
 * Validates that permissions are allowed by the company's plan.
 */
exports.assignPermissions = async (roleId, permissionIds, company_id) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Validate plan features if company_id provided
    if (company_id) {
      const { rows: planFeatures } = await client.query(
        `SELECT pf.feature_key FROM company_plans cp
         JOIN plan_features pf ON pf.plan_id = cp.plan_id
         WHERE cp.company_id = $1 AND cp.is_active = true AND pf.is_enabled = true`,
        [company_id]
      );
      const allowedModules = new Set(planFeatures.map(f => f.feature_key));

      if (permissionIds.length) {
        const { rows: perms } = await client.query(
          `SELECT permission_key FROM permissions WHERE id = ANY($1)`,
          [permissionIds]
        );
        for (const perm of perms) {
          if (perm.permission_key.startsWith('page:')) {
            const module = perm.permission_key.split(':').slice(0, 2).join(':');
            if (!allowedModules.has(module)) {
              throw { status: 403, message: `Permission '${perm.permission_key}' is not available on your plan` };
            }
          }
        }
      }
    }

    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    for (const pid of permissionIds) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [roleId, pid]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.remove = async (roleId) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(`SELECT is_system FROM roles WHERE id = $1`, [roleId]);
    if (!check.rows.length) throw { status: 404, message: 'Role not found' };
    if (check.rows[0].is_system) throw { status: 403, message: 'Cannot delete a system role' };

    await client.query(`DELETE FROM user_roles WHERE role_id = $1`, [roleId]);
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    await client.query(`DELETE FROM roles WHERE id = $1`, [roleId]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.assign = async (user_id, role_ids) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [user_id]);
    for (const r of role_ids) {
      await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user_id, r]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.listPermissions = async () => {
  const { rows } = await db.query(
    `SELECT id, permission_key, description FROM permissions ORDER BY permission_key`
  );
  return rows;
};
