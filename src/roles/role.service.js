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

exports.LEGACY_API_PERMISSIONS = LEGACY_API_PERMISSIONS;
exports.syncDefaultRoles = syncDefaultRoles;

/**
 * Seed all system roles + legacy API permissions.
 * Called on app startup.
 */
exports.seedPagePermissions = async () => {
  const { APP_MODULES, ACTION_LABELS } = require('../plans/plan.service');
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

    // Seed page-level permissions (page:dashboard:partcount, etc.)
    let pageCount = 0;
    for (const mod of APP_MODULES) {
      for (const action of mod.actions) {
        const key = `page:${mod.key}:${action}`;
        const friendlyAction = ACTION_LABELS[action] || (action.charAt(0).toUpperCase() + action.slice(1));
        const desc = `${friendlyAction} — ${mod.label}`;
        await client.query(
          `INSERT INTO permissions (permission_key, description)
           VALUES ($1, $2) ON CONFLICT (permission_key) DO NOTHING`,
          [key, desc]
        );
        pageCount++;
      }
    }

    // SNT_SUPER gets ALL permissions
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
       WHERE r.role_name = 'SNT_SUPER'
       ON CONFLICT DO NOTHING`
    );

    const roles = await syncDefaultRoles(client);

    await client.query('COMMIT');
    return { seeded: LEGACY_API_PERMISSIONS.length, pages: pageCount, roles };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Bring the default system roles in line with default-roles.js.
 *
 * Runs on every start, and is authoritative for `page:%` keys: a key the
 * definition dropped is removed from the role, not left behind. That is what
 * makes "the same roles in every company" a fact rather than a hope — these
 * roles carry company_id NULL, so one row serves every tenant and no company
 * can end up with a Supervisor that means something different.
 *
 * Legacy `machine.view`-style keys are insert-only. They are shared with
 * LEGACY_API_PERMISSIONS above, which grants them to the older system roles
 * on the same pass, and deleting from that set here would fight it.
 *
 * Nothing here touches a company's own roles (company_id IS NOT NULL) or the
 * roles a company was given through Manage Access. role_name is UNIQUE across
 * every company, so a company may already hold one of these names: the upsert
 * is guarded on company_id IS NULL and the lookup below repeats the guard, so
 * that company keeps its own role rather than having it turned into a system
 * one underneath it.
 */
async function syncDefaultRoles(client) {
  const { resolveDefaultRoles } = require('./default-roles');
  const summary = [];

  for (const role of resolveDefaultRoles()) {
    await client.query(
      `INSERT INTO roles (role_name, description, is_system, company_id)
       VALUES ($1, $2, true, NULL)
       ON CONFLICT (role_name) DO UPDATE
         SET description = EXCLUDED.description, is_system = true, updated_at = NOW()
       WHERE roles.company_id IS NULL`,
      [role.name, role.description]
    );

    const { rows } = await client.query(
      `SELECT id FROM roles WHERE role_name = $1 AND company_id IS NULL`, [role.name]);
    if (!rows.length) continue;            // a company owns this name; leave it alone
    const roleId = rows[0].id;

    const removed = await client.query(
      `DELETE FROM role_permissions rp
        USING permissions p
        WHERE rp.role_id = $1
          AND p.id = rp.permission_id
          AND p.permission_key LIKE 'page:%'
          AND NOT (p.permission_key = ANY($2::text[]))`,
      [roleId, role.permissions]
    );

    const added = await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM permissions p
        WHERE p.permission_key = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [roleId, [...role.permissions, ...role.legacy]]
    );

    summary.push({ role: role.name, granted: added.rowCount, revoked: removed.rowCount });
  }

  return summary;
}

/* ── Who may be given which role ───────────────────────────────
 *
 * SNT_SUPER is not an ordinary role. auth.service derives the platform
 * super-admin flag straight from holding it (`roles.includes('SNT_SUPER')`),
 * and access.middleware lets that flag past every page and company check —
 * so granting this one role to a user makes them a full platform admin with
 * sight of every tenant.
 *
 * Both ways a role reaches a user — POST /api/roles/assign/:id and the
 * role_ids on POST /api/users — used to allow it. The first accepted any
 * system role, the second validated nothing at all, so any company admin
 * could mint themselves an S&T super user. Both now come through here.
 */
const PLATFORM_ONLY_ROLES = ['SNT_SUPER'];
exports.PLATFORM_ONLY_ROLES = PLATFORM_ONLY_ROLES;

/**
 * Refuse any role id the actor may not give to a user of targetCompanyId.
 * Takes a client so callers can run it inside their own transaction.
 */
async function assertAssignable(client, roleIds, { actor = {}, targetCompanyId }) {
  for (const roleId of roleIds) {
    /* FOR UPDATE, matching the lock remove() takes: without it a role could
       be deleted between this check and the insert, and the insert would
       fail on the foreign key with an error nobody can act on. */
    const { rows } = await client.query(
      `SELECT id, role_name, company_id, is_system FROM roles WHERE id = $1 FOR UPDATE`,
      [roleId]
    );
    const role = rows[0];
    if (!role) throw { status: 404, message: `Role ${roleId} not found` };

    if (PLATFORM_ONLY_ROLES.includes(role.role_name) && !actor.is_snt_super) {
      throw { status: 403, message: `Role ${role.role_name} can only be granted by S&T` };
    }
    if (!role.is_system && role.company_id !== targetCompanyId) {
      throw { status: 403, message: `Role ${roleId} belongs to another company` };
    }
  }
}
exports.assertAssignable = assertAssignable;

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
    /* Their own roles, plus the system roles every company shares — the
       default set (Supervisor, Maintenance, Quality, Setter, HR) lives with
       company_id NULL, so filtering on company_id alone hid all of them and
       left a company admin unable to see or assign any default role.

       SNT_SUPER is excluded: it is the platform's own role, and listing it
       here would offer a company admin a role they cannot be given anyway
       (see assertAssignable). An orphaned role — no company and not a system
       role — belongs to no one and stays hidden. */
    query  = `SELECT r.id, r.role_name, r.description, r.is_system, r.company_id
              FROM roles r
              WHERE (r.company_id = $1
                     OR (r.company_id IS NULL AND r.is_system = true
                         AND r.role_name <> ALL ($2::text[])))
              ORDER BY r.is_system DESC, r.role_name`;
    params = [company_id, PLATFORM_ONLY_ROLES];
  } else {
    /* Neither a confirmed super admin nor a known company: this used to run
       an unfiltered query and return every role from every company. Nothing
       legitimate reaches this branch — the only caller is the GET /api/roles
       handler, which always passes one or the other for a real admin — so
       it is reachable only when a company admin's company_id has come back
       null (the column is nullable), and returning everyone else's roles to
       that request is exactly the tenant leak this function exists to
       prevent. Fail closed. */
    return [];
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


/**
 * Load a role the caller is allowed to act on, or refuse.
 *
 * Every mutation below goes through this. Without it, update, remove and
 * assign took only a role id and trusted it: a company admin could rename
 * or delete another company's role by guessing an integer, and the API
 * would report success. list() and create() were already scoped, which is
 * what made the gap easy to miss — the read path looked correct.
 *
 * A role that does not exist and a role belonging to someone else both
 * return 404. Distinguishing them would confirm the id is real, which
 * tells an attacker something they should not learn from a permission
 * error.
 */
async function loadRoleFor(client, roleId, { company_id, is_snt_super = false } = {}, lock = false) {
  const { rows } = await client.query(
    `SELECT id, role_name, is_system, company_id FROM roles WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [roleId]
  );
  const role = rows[0];
  if (!role) throw { status: 404, message: 'Role not found' };

  // S&T staff administer every tenant; a company admin only their own.
  if (!is_snt_super) {
    if (!company_id || role.company_id !== company_id) {
      throw { status: 404, message: 'Role not found' };
    }
  }
  return role;
}

/* Took only the id, with no actor at all — any authenticated admin-tier
   user could read any company's role, permissions included, by requesting
   its id. db exposes the same .query(text, params) interface loadRoleFor
   expects from a transaction client, so it can stand in directly for a
   plain read with no transaction needed. */
exports.getById = async (roleId, actor = {}) => {
  const role = await loadRoleFor(db, roleId, actor);

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

exports.update = async (roleId, { role_name, description }, actor = {}) => {
  /* Scoped like every other mutation: without this a company admin could
     rename another tenant's role by guessing its id. */
  {
    const guardClient = await db.connect();
    try { await loadRoleFor(guardClient, roleId, actor); }
    finally { guardClient.release(); }
  }
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
exports.assignPermissions = async (roleId, permissionIds, actor = {}) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /* Same guard update/remove/assign already use: confirms this role is
       the caller's to touch before anything below writes to it, and — new
       here — refuses a system role. Without that second check, overwriting
       role_permissions for the SNT_SUPER row would corrupt what every
       super-admin account is entitled to; system roles get their
       permissions from seedPagePermissions(), not this per-company editor. */
    const role = await loadRoleFor(client, roleId, actor);
    if (role.is_system) throw { status: 403, message: 'Cannot edit permissions of a system role' };

    const company_id = actor.is_snt_super ? null : actor.company_id;

    // Validate against company_permissions (what super user allowed)
    if (company_id && permissionIds.length) {
      const { rows: companyPerms } = await client.query(
        `SELECT permission_id FROM company_permissions WHERE company_id = $1`,
        [company_id]
      );
      const allowedIds = new Set(companyPerms.map(r => r.permission_id));

      for (const pid of permissionIds) {
        if (!allowedIds.has(pid)) {
          const { rows: pInfo } = await client.query(
            `SELECT permission_key FROM permissions WHERE id = $1`, [pid]
          );
          const key = pInfo[0]?.permission_key || pid;
          throw { status: 403, message: `Permission '${key}' is not allowed for this company. Contact S&T admin.` };
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

/**
 * Delete a custom role.
 *
 * Refuses while the role is assigned to anyone. It previously did
 * `DELETE FROM user_roles WHERE role_id = $1` first, which did not fail —
 * it silently stripped the role from every user who held it. Those people
 * kept their accounts and lost their access, and the first anyone knew of
 * it was a support call about being locked out. The agreement asks for the
 * opposite behaviour: prevent deletion of roles currently assigned to
 * active users.
 */
exports.remove = async (roleId, actor = {}) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /* The role row itself is locked for the whole transaction. assign()
       takes the same lock before granting a role, so a delete and an
       assignment of the same role serialise against each other and a user
       cannot be given this role between the count below and the delete.

       Postgres refuses FOR UPDATE alongside an aggregate, so the lock has
       to be on this row rather than on the COUNT — which is the correct
       place for it anyway, since it is the role's existence being
       decided. */
    const role = await loadRoleFor(client, roleId, actor, true);
    if (role.is_system) throw { status: 403, message: 'Cannot delete a system role' };

    const { rows: [{ count }] } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
        WHERE ur.role_id = $1 AND u.is_active = true`,
      [roleId]
    );

    if (count > 0) {
      throw {
        status: 409,
        message: `"${role.role_name}" is assigned to ${count} active user${count === 1 ? '' : 's'}. ` +
                 `Move them to another role before deleting it.`,
        code: 'ROLE_IN_USE',
        assigned_users: count
      };
    }

    // Only inactive users can still hold it at this point, and those rows
    // would otherwise block the delete on the foreign key.
    await client.query(`DELETE FROM user_roles WHERE role_id = $1`, [roleId]);
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    await client.query(`DELETE FROM roles WHERE id = $1`, [roleId]);

    await client.query('COMMIT');
    return { id: roleId, role_name: role.role_name };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Replace a user's roles.
 *
 * Both sides are checked against the caller's company. Unscoped, this took
 * a user id and a list of role ids and trusted both — which meant a company
 * admin could grant their own role to a user in another tenant, or grant
 * another tenant's role to their own user. Either one is a privilege
 * escalation across a company boundary, and neither left a trace.
 */
exports.assign = async (user_id, role_ids, actor = {}) => {
  const ids = Array.isArray(role_ids) ? role_ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query(
      `SELECT id, company_id FROM users WHERE id = $1`, [user_id]);
    const target = userRows[0];
    if (!target) throw { status: 404, message: 'User not found' };

    if (!actor.is_snt_super && (!actor.company_id || target.company_id !== actor.company_id)) {
      throw { status: 404, message: 'User not found' };
    }

    await assertAssignable(client, ids, { actor, targetCompanyId: target.company_id });

    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [user_id]);
    for (const r of ids) {
      await client.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user_id, r]);
    }

    await client.query('COMMIT');
    return { user_id, role_ids: ids };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * List permissions grouped by module for the role editor UI.
 * If company_id provided, only return permissions that the company
 * has been granted access to by super user. SNT_SUPER sees all.
 */
exports.listPermissions = async ({ company_id, is_snt_super } = {}) => {
  const { APP_MODULES } = require('../plans/plan.service');

  let query, params;
  if (is_snt_super) {
    query = `SELECT id, permission_key, description FROM permissions WHERE permission_key LIKE 'page:%' ORDER BY permission_key`;
    params = [];
  } else if (!company_id) {
    // Same reasoning as list() above: an unconfirmed caller sees nothing,
    // not the full catalogue of what every other company can be granted.
    return [];
  } else {
    query = `SELECT p.id, p.permission_key, p.description
             FROM permissions p
             JOIN company_permissions cp ON cp.permission_id = p.id
             WHERE cp.company_id = $1 AND p.permission_key LIKE 'page:%'
             ORDER BY p.permission_key`;
    params = [company_id];
  }

  const { rows } = await db.query(query, params);

  // Group by module
  const grouped = {};
  for (const row of rows) {
    const parts  = row.permission_key.split(':');
    const module = parts.slice(1, -1).join(':');
    const action = parts[parts.length - 1];
    const def    = APP_MODULES.find(m => m.key === module);

    if (!grouped[module]) {
      grouped[module] = {
        module,
        label: def?.label || module,
        group: def?.group || 'Other',
        permissions: []
      };
    }
    const { ACTION_LABELS } = require('../plans/plan.service');
    const actionLabel = ACTION_LABELS[action] || (action.charAt(0).toUpperCase() + action.slice(1));
    grouped[module].permissions.push({ ...row, action, actionLabel });
  }

  return Object.values(grouped);
};
