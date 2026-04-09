const db = require('../db');

// ── All app pages that can be assigned to roles ──────────────
const APP_PAGES = [
  { key: 'page:dashboard',       label: 'Dashboard',        group: 'Main' },
  { key: 'page:dashboard:live',  label: 'Live Dashboard',   group: 'Main' },
  { key: 'page:oee-reports',     label: 'OEE Reports',      group: 'Main' },
  { key: 'page:reports',         label: 'Reports',          group: 'Main' },
  { key: 'page:charts',          label: 'Charts',           group: 'Main' },
  { key: 'page:quality',         label: 'Quality',          group: 'Main' },
  { key: 'page:machines',        label: 'Machines',         group: 'Master' },
  { key: 'page:component',       label: 'Component',        group: 'Master' },
  { key: 'page:job',             label: 'Job',              group: 'Master' },
  { key: 'page:shifts',          label: 'Shifts',           group: 'Master' },
  { key: 'page:operators',       label: 'Operators',        group: 'Master' },
  { key: 'page:assignments',     label: 'Assignments',      group: 'Master' },
  { key: 'page:machine-shifts',  label: 'Machine Shifts',   group: 'Master' },
  { key: 'page:plants',          label: 'Plants',           group: 'Master' },
];

// ── API-level permissions used by backend routes ──────────────
// Roles: ADMIN=all, SUPERVISOR=view+create+update, OPERATOR=view+create+update, VIEWER=view
const API_PERMISSIONS = [
  { key: 'line.view',        desc: 'View lines',              roles: ['ADMIN','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'line.create',      desc: 'Create lines',            roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'line.update',      desc: 'Update lines',            roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'line.delete',      desc: 'Delete lines',            roles: ['ADMIN'] },

  { key: 'machine.view',     desc: 'View machines',           roles: ['ADMIN','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'machine.create',   desc: 'Create machines',         roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'machine.update',   desc: 'Update machines',         roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'machine.delete',   desc: 'Delete machines',         roles: ['ADMIN'] },

  { key: 'operator.view',    desc: 'View operators',          roles: ['ADMIN','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'operator.create',  desc: 'Create operators',        roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'operator.update',  desc: 'Update operators',        roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'operator.delete',  desc: 'Delete operators',        roles: ['ADMIN'] },

  { key: 'shift.view',       desc: 'View shifts',             roles: ['ADMIN','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'shift.create',     desc: 'Create shifts',           roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'shift.update',     desc: 'Update shifts',           roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'shift.delete',     desc: 'Delete shifts',           roles: ['ADMIN'] },

  { key: 'component.view',   desc: 'View components',         roles: ['ADMIN','SUPERVISOR','OPERATOR','VIEWER'] },
  { key: 'component.create', desc: 'Create components',       roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'component.update', desc: 'Update components',       roles: ['ADMIN','SUPERVISOR','OPERATOR'] },
  { key: 'component.delete', desc: 'Delete components',       roles: ['ADMIN'] },
];

/**
 * Seed page permissions into the permissions table.
 * Also seeds API permissions and auto-assigns them to default roles.
 * Inserts only missing ones (ON CONFLICT DO NOTHING).
 */
exports.seedPagePermissions = async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Seed page permissions
    for (const page of APP_PAGES) {
      await client.query(
        `INSERT INTO permissions (permission_key, description)
         VALUES ($1, $2)
         ON CONFLICT (permission_key) DO NOTHING`,
        [page.key, `Access to ${page.label} page`]
      );
    }

    // 2. Seed API permissions and auto-assign to roles
    for (const perm of API_PERMISSIONS) {
      // Insert permission (skip if exists)
      await client.query(
        `INSERT INTO permissions (permission_key, description)
         VALUES ($1, $2)
         ON CONFLICT (permission_key) DO NOTHING`,
        [perm.key, perm.desc]
      );

      // Assign to each role listed
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

    await client.query('COMMIT');
    return { seeded: APP_PAGES.length + API_PERMISSIONS.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Return page permissions grouped by category for the admin UI.
 */
exports.listPagePermissions = async () => {
  const { rows } = await db.query(
    `SELECT id, permission_key, description
     FROM permissions
     WHERE permission_key LIKE 'page:%'
     ORDER BY permission_key`
  );

  // Attach group info from APP_PAGES
  return rows.map(r => {
    const def = APP_PAGES.find(p => p.key === r.permission_key);
    return {
      ...r,
      label: def?.label || r.permission_key,
      group: def?.group || 'Other'
    };
  });
};

exports.create = async role =>
  (await db.query(
    `INSERT INTO roles (role_name) VALUES ($1) RETURNING *`,
    [role.role_name]
  )).rows[0];

exports.list = async () => {
  const { rows } = await db.query(
    `SELECT r.id, r.role_name
     FROM roles r
     ORDER BY r.role_name`
  );

  // Fetch permissions for each role
  for (const role of rows) {
    const permRes = await db.query(
      `SELECT p.id, p.permission_key, p.description
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [role.id]
    );
    role.permissions = permRes.rows;
  }

  return rows;
};

exports.getById = async roleId => {
  const { rows } = await db.query(
    `SELECT id, role_name FROM roles WHERE id = $1`,
    [roleId]
  );

  if (!rows.length) throw { status: 404, message: 'Role not found' };

  const role = rows[0];

  // Fetch permissions
  const permRes = await db.query(
    `SELECT p.id, p.permission_key, p.description
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = $1`,
    [roleId]
  );
  role.permissions = permRes.rows;

  return role;
};

exports.listPermissions = async () => {
  const { rows } = await db.query(
    `SELECT id, permission_key, description
     FROM permissions
     ORDER BY permission_key`
  );
  return rows;
};

exports.assignPermissions = async (roleId, permissionIds) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Delete existing permissions
    await client.query(
      `DELETE FROM role_permissions WHERE role_id = $1`,
      [roleId]
    );

    // Insert new permissions
    for (const permId of permissionIds) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, permId]
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

exports.remove = async roleId => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Delete user_roles associations
    await client.query(
      `DELETE FROM user_roles WHERE role_id = $1`,
      [roleId]
    );

    // Delete role_permissions associations
    await client.query(
      `DELETE FROM role_permissions WHERE role_id = $1`,
      [roleId]
    );

    // Delete the role
    const result = await client.query(
      `DELETE FROM roles WHERE id = $1`,
      [roleId]
    );

    if (!result.rowCount) {
      await client.query('ROLLBACK');
      throw { status: 404, message: 'Role not found' };
    }

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

    await client.query(
      `DELETE FROM user_roles WHERE user_id = $1`,
      [user_id]
    );

    for (const r of role_ids) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [user_id, r]
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
