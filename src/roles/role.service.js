const db = require('../db');

// ── Legacy: kept for backward-compat seed on startup ─────────
/* SUPERVISOR is not listed here. It is one of the default roles, and those
   are defined completely — page keys and these older keys alike — by
   default-roles.js. Being listed here too handed it create/update on lines,
   operators and components through the API, which a view-only supervisor
   was never meant to have. */
const LEGACY_API_PERMISSIONS = [
  { key: 'line.view',        desc: 'View lines',              roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','OPERATOR','VIEWER'] },
  { key: 'line.create',      desc: 'Create lines',            roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'line.update',      desc: 'Update lines',            roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'line.delete',      desc: 'Delete lines',            roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'machine.view',     desc: 'View machines',           roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','OPERATOR','VIEWER'] },
  { key: 'machine.create',   desc: 'Create machines',         roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'machine.update',   desc: 'Update machines',         roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'machine.delete',   desc: 'Delete machines',         roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'operator.view',    desc: 'View operators',          roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','OPERATOR','VIEWER'] },
  { key: 'operator.create',  desc: 'Create operators',        roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'operator.update',  desc: 'Update operators',        roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'operator.delete',  desc: 'Delete operators',        roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'shift.view',       desc: 'View shifts',             roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','OPERATOR','VIEWER'] },
  { key: 'shift.create',     desc: 'Create shifts',           roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'shift.update',     desc: 'Update shifts',           roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'shift.delete',     desc: 'Delete shifts',           roles: ['SNT_SUPER','COMPANY_ADMIN'] },
  { key: 'component.view',   desc: 'View components',         roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER','OPERATOR','VIEWER'] },
  { key: 'component.create', desc: 'Create components',       roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'component.update', desc: 'Update components',       roles: ['SNT_SUPER','COMPANY_ADMIN','MANAGER'] },
  { key: 'component.delete', desc: 'Delete components',       roles: ['SNT_SUPER','COMPANY_ADMIN'] },
];

exports.LEGACY_API_PERMISSIONS = LEGACY_API_PERMISSIONS;

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
           WHERE r.role_name = $1 AND r.company_id IS NULL AND p.permission_key = $2
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
       WHERE r.role_name = 'SNT_SUPER' AND r.company_id IS NULL
       ON CONFLICT DO NOTHING`
    );

    await client.query('COMMIT');
    return { seeded: LEGACY_API_PERMISSIONS.length, pages: pageCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Give a company its own copy of each default role (default-roles.js),
 * holding only the pages the company has been granted. Called when S&T
 * creates a company; from then on the roles are the company admin's to
 * change. A name the company already uses is left as it is — that role is
 * theirs — and no template is forced onto it.
 *
 * This used to keep ONE shared, locked set of default rows for every
 * company. The customer asked instead for each company to start with the
 * defaults and adjust them itself, with S&T taking no action on roles.
 */
async function createDefaultRolesForCompany(client, companyId) {
  const { resolveDefaultRoles } = require('./default-roles');
  const grants = await companyPageGrants(client, companyId);
  const created = [];

  for (const tpl of resolveDefaultRoles()) {
    const { rows } = await client.query(
      `INSERT INTO roles (role_name, description, company_id, is_system)
       VALUES ($1, $2, $3, false)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [tpl.name, tpl.description, companyId]
    );
    if (!rows.length) continue;              // the company already has this name

    const { rows: pages } = await client.query(
      `SELECT id FROM permissions WHERE permission_key = ANY($1::text[])`, [tpl.permissions]);
    const pageIds = pages.map(p => p.id).filter(id => !grants || grants.has(id));
    await writeRolePermissions(client, rows[0].id, pageIds);
    created.push({ role: tpl.name, id: rows[0].id, pages: pageIds.length });
  }
  return created;
}
exports.createDefaultRolesForCompany = createDefaultRolesForCompany;

/**
 * Re-derive the older API keys for these roles from the pages they still
 * hold. Manage Access strips a revoked page from a company's roles; without
 * this the machine.view-style keys that page needed would stay behind, and
 * the role-only routes that check them would keep answering.
 */
async function rederiveLegacyKeys(client, roleIds) {
  for (const roleId of [...new Set(roleIds)]) {
    const { rows } = await client.query(
      `SELECT p.id FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND p.permission_key LIKE 'page:%'`, [roleId]);
    await writeRolePermissions(client, roleId, rows.map(r => r.id));
  }
}
exports.rederiveLegacyKeys = rederiveLegacyKeys;

/* ── The roles model (AWS-style) ───────────────────────────────
 *
 *   S&T super admin   creates the company and its admin, and sets what the
 *                     company paid for (Manage Access). No action on roles.
 *   Default roles     SUPERVISOR, MAINTENANCE, QUALITY, SETTER, HR — each
 *                     company gets its OWN copy when it is created, holding
 *                     only the pages it was given (default-roles.js).
 *   Company admin     creates users, and manages all of the company's roles:
 *                     changes the defaults, copies, creates, deletes — but
 *                     only ever with pages the company paid for.
 *
 * A user can open a page only if their role has it AND their company paid
 * for it (access.middleware), so no role can reach past the plan.
 */

/* SNT_SUPER is not an ordinary role. auth.service derives the platform
   super-admin flag straight from holding it, and access.middleware waves
   that flag past every page and company check — so granting it makes a user
   a full platform admin with sight of every tenant. */
const PLATFORM_ONLY_ROLES = ['SNT_SUPER'];

/* Shared (company_id NULL) rows that are no longer used: the old MANAGER,
   OPERATOR and VIEWER, and the shared copies of the default roles, which
   every company now owns separately (migration 027 moved their users and
   removed them). Matched as system rows only, so a company's own SUPERVISOR
   is unaffected; never listed, never granted. */
const RETIRED_SYSTEM_ROLES = ['MANAGER', 'OPERATOR', 'VIEWER',
                              'SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR'];

/* Names the code itself treats as privileged (auth.service, role.middleware,
   access.middleware, alarm routing). A company role called one of these
   would inherit that privilege by name alone. Migration 025 enforces the
   same list in the database. */
const RESERVED_ROLE_NAMES = ['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN'];

exports.PLATFORM_ONLY_ROLES  = PLATFORM_ONLY_ROLES;
exports.RETIRED_SYSTEM_ROLES = RETIRED_SYSTEM_ROLES;
exports.RESERVED_ROLE_NAMES  = RESERVED_ROLE_NAMES;

function forbidden(message) { return { status: 403, message }; }

/* S&T gives no one a role. A company's admin is made with the company, and
   that admin gives everyone else theirs — a second admin included. */
const SNT_ASSIGNS_NO_ROLES = "S&T doesn't assign roles. A company's admin is set when the company is created, and the admin assigns every other role.";

/** Creating, editing, copying and deleting roles is the company admin's job. */
function requireCompanyAdmin(actor = {}) {
  if (actor.is_snt_super) {
    throw forbidden("Roles are managed by each company's admin. S&T sets what a company can use in Manage Access.");
  }
  if (!actor.company_id) throw forbidden('No company on this account');
}

/**
 * The page permission ids a company paid for, or null when it has no page
 * grants at all — a fresh company, which everywhere else in the app is
 * unrestricted. Treating that as "nothing allowed" used to leave a fresh
 * company unable to build any role.
 */
async function companyPageGrants(client, companyId) {
  const { rows } = await client.query(
    `SELECT cp.permission_id
       FROM company_permissions cp
       JOIN permissions p ON p.id = cp.permission_id
      WHERE cp.company_id = $1 AND p.permission_key LIKE 'page:%'`,
    [companyId]
  );
  return rows.length ? new Set(rows.map(r => r.permission_id)) : null;
}

/** Only whole positive integers survive; everything else is dropped. */
function cleanIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(Number)
    .filter(n => Number.isInteger(n) && n > 0))];
}

/**
 * Keep only ids that are page permissions. A role is defined by its pages;
 * the older API keys are derived from them (writeRolePermissions), never
 * chosen. The role editor has always sent back every id the role held,
 * derived keys included — ignoring those keeps that working, and means a
 * machine.view-style key can never be granted directly.
 */
async function pageIdsOnly(client, ids) {
  if (!ids.length) return [];
  const { rows } = await client.query(
    `SELECT id FROM permissions WHERE id = ANY($1::int[]) AND permission_key LIKE 'page:%' ORDER BY id`, [ids]);
  return rows.map(r => r.id);
}

/** Refuse any page the company has not paid for, naming it. */
async function assertCompanyMayGrant(client, companyId, pageIds) {
  const grants = await companyPageGrants(client, companyId);
  if (!grants) return;
  const missing = pageIds.filter(id => !grants.has(id));
  if (!missing.length) return;
  const { rows } = await client.query(
    `SELECT permission_key FROM permissions WHERE id = ANY($1::int[]) ORDER BY permission_key`, [missing]);
  const keys = rows.map(r => r.permission_key).join(', ') || missing.join(', ');
  throw forbidden(`Your company's plan does not include: ${keys}. Contact S&T to add it.`);
}

/**
 * Replace a role's permissions with these pages, plus the older API keys
 * those pages depend on (default-roles.legacyKeysFor). Without the second
 * half a company's own role opened its pages and got 403 from the calls
 * behind them.
 */
async function writeRolePermissions(client, roleId, pageIds) {
  const { legacyKeysFor } = require('./default-roles');
  const { rows: pages } = await client.query(
    `SELECT id, permission_key FROM permissions
      WHERE id = ANY($1::int[]) AND permission_key LIKE 'page:%'`, [pageIds]);
  pageIds = pages.map(p => p.id);
  const legacy = legacyKeysFor(pages.map(p => p.permission_key));

  await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
  await client.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM permissions p
      WHERE p.id = ANY($2::int[]) OR p.permission_key = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [roleId, pageIds, legacy]
  );
  return { pages: pages.length, legacy };
}

/**
 * Tidy and check a name for a company's own role. Two companies may each
 * have a "Line Lead"; one company may not have two, nor take a reserved or
 * system role's name.
 */
async function assertRoleNameUsable(client, rawName, companyId, exceptRoleId = null) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 50) {
    throw { status: 400, message: 'Role name must be 2 to 50 characters' };
  }
  if (RESERVED_ROLE_NAMES.includes(name.toUpperCase())) {
    throw { status: 400, message: `"${name}" is reserved. Choose another name.` };
  }
  const { rows } = await client.query(
    `SELECT id, company_id FROM roles
      WHERE lower(role_name) = lower($1)
        AND ((company_id IS NULL AND NOT (role_name = ANY($4::text[])))
             OR company_id = $2)
        AND ($3::int IS NULL OR id <> $3)`,
    [name, companyId, exceptRoleId, RETIRED_SYSTEM_ROLES]
  );
  if (rows.some(r => r.company_id === null)) {
    throw { status: 409, message: `"${name}" is a system role name. Choose another name.` };
  }
  if (rows.length) throw { status: 409, message: `Your company already has a role called "${name}"` };
  return name;
}

/* Until migration 025 role_name is still unique across every company, so a
   name another company already uses fails in the database rather than in
   the check above. Say so plainly instead of leaking a 500. */
function nameTaken(e, name) {
  if (e && e.code === '23505') return { status: 409, message: `The name "${name}" is already taken. Choose another.` };
  return e;
}

/**
 * Refuse any role id the actor may not give to a user of targetCompanyId.
 * Takes a client so callers can run it inside their own transaction.
 */
async function assertAssignable(client, roleIds, { actor = {}, targetCompanyId }) {
  if (actor.is_snt_super) throw forbidden(SNT_ASSIGNS_NO_ROLES);
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

    if (role.is_system && RETIRED_SYSTEM_ROLES.includes(role.role_name)) {
      throw forbidden(`Role ${role.role_name} is no longer in use`);
    }
    if (PLATFORM_ONLY_ROLES.includes(role.role_name)) {
      throw forbidden(`Role ${role.role_name} can only be granted by S&T`);
    }
    if (!role.is_system && role.company_id !== targetCompanyId) {
      throw forbidden(`Role ${roleId} belongs to another company`);
    }
    /* A system row must also be a shared one: is_system with a company_id
       could only have come from a crafted create request, and would
       otherwise be grantable across companies. */
    if (role.is_system && role.company_id !== null) {
      throw forbidden(`Role ${roleId} belongs to another company`);
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
    /* The shared roles only — Company Admin (and S&T's own). A company's
       roles are that company's business; S&T neither manages nor needs to
       read them, and the S&T Users page only looks up Company Admin here. */
    query  = `SELECT r.id, r.role_name, r.description, r.is_system, r.company_id
              FROM roles r
              WHERE r.company_id IS NULL AND r.is_system = true
                AND NOT (r.role_name = ANY ($1::text[]))
              ORDER BY r.role_name`;
    params = [RETIRED_SYSTEM_ROLES];
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
    params = [company_id, [...PLATFORM_ONLY_ROLES, ...RETIRED_SYSTEM_ROLES]];
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
 * Create a role for the caller's company.
 *
 * This used to spread the request body straight in, so a company admin could
 * set is_system, pick any company_id through S&T, and attach any permission
 * id at all — including pages the company had never paid for, which the
 * role-only permit() routes would then honour. Now the company comes from
 * the caller, is_system is never read, and every page is checked against
 * what the company bought.
 */
exports.create = async ({ role_name, description, permission_ids } = {}, actor = {}) => {
  requireCompanyAdmin(actor);

  const client = await db.connect();
  let name = role_name;
  try {
    await client.query('BEGIN');
    name = await assertRoleNameUsable(client, role_name, actor.company_id);
    const pageIds = await pageIdsOnly(client, cleanIds(permission_ids));
    if (pageIds.length) await assertCompanyMayGrant(client, actor.company_id, pageIds);

    const { rows } = await client.query(
      `INSERT INTO roles (role_name, description, company_id, is_system)
       VALUES ($1, $2, $3, false) RETURNING *`,
      [name, description ? String(description).slice(0, 500) : null, actor.company_id]
    );
    const role = rows[0];
    await writeRolePermissions(client, role.id, pageIds);

    await client.query('COMMIT');
    return role;
  } catch (e) {
    await client.query('ROLLBACK');
    throw nameTaken(e, name);
  } finally {
    client.release();
  }
};

/**
 * Copy one of the company's roles into a new one — e.g. SUPERVISOR into a
 * NIGHT SUPERVISOR to adjust. The copy keeps only pages the company still
 * has, and says how many it had to leave out.
 */
exports.copy = async (sourceId, { role_name, description } = {}, actor = {}) => {
  requireCompanyAdmin(actor);

  const client = await db.connect();
  let name = role_name;
  try {
    await client.query('BEGIN');

    const { rows: src } = await client.query(
      `SELECT id, role_name, description, company_id, is_system FROM roles WHERE id = $1`, [sourceId]);
    const source = src[0];
    if (source && source.is_system && source.role_name === 'COMPANY_ADMIN') {
      throw { status: 400, message: 'Company Admin cannot be copied: its access comes from Manage Access, not from a list of pages.' };
    }
    // the company's own roles only; someone else's and a missing one read the same
    if (!source || source.is_system || source.company_id !== actor.company_id) {
      throw { status: 404, message: 'Role not found' };
    }

    name = await assertRoleNameUsable(client, role_name, actor.company_id);

    const { rows: perms } = await client.query(
      `SELECT p.id FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND p.permission_key LIKE 'page:%'`, [source.id]);
    const grants = await companyPageGrants(client, actor.company_id);
    const all  = perms.map(r => r.id);
    const kept = grants ? all.filter(id => grants.has(id)) : all;

    const { rows } = await client.query(
      `INSERT INTO roles (role_name, description, company_id, is_system)
       VALUES ($1, $2, $3, false) RETURNING *`,
      [name, description ? String(description).slice(0, 500) : `Copy of ${source.role_name}`, actor.company_id]
    );
    const role = rows[0];
    await writeRolePermissions(client, role.id, kept);

    await client.query('COMMIT');
    return { role, copied: kept.length, skipped: all.length - kept.length, from: source.role_name };
  } catch (e) {
    await client.query('ROLLBACK');
    throw nameTaken(e, name);
  } finally {
    client.release();
  }
};

exports.update = async (roleId, { role_name, description } = {}, actor = {}) => {
  requireCompanyAdmin(actor);
  const client = await db.connect();
  let name = role_name;
  try {
    await client.query('BEGIN');
    /* Scoped like every other mutation: without this a company admin could
       rename another tenant's role by guessing its id. */
    const role = await loadRoleFor(client, roleId, actor, true);
    if (role.is_system) throw forbidden('System roles cannot be changed');

    name = role_name === undefined || role_name === null || role_name === ''
      ? null
      : await assertRoleNameUsable(client, role_name, actor.company_id, role.id);

    const { rows } = await client.query(
      `UPDATE roles SET
         role_name   = COALESCE($1, role_name),
         description = COALESCE($2, description),
         updated_at  = now()
       WHERE id = $3 AND is_system = false
       RETURNING *`,
      [name, description === undefined ? null : String(description).slice(0, 500), roleId]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw nameTaken(e, name);
  } finally {
    client.release();
  }
};

/**
 * Replace a role's permissions entirely — pages the company paid for only,
 * plus the older API keys those pages need.
 */
exports.assignPermissions = async (roleId, permissionIds, actor = {}) => {
  requireCompanyAdmin(actor);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /* Confirms the role is the caller's to touch, and refuses a system role
       (Company Admin), whose access comes from Manage Access instead. */
    const role = await loadRoleFor(client, roleId, actor, true);
    if (role.is_system) throw forbidden('System roles cannot be changed');

    const pageIds = await pageIdsOnly(client, cleanIds(permissionIds));
    if (pageIds.length) await assertCompanyMayGrant(client, actor.company_id, pageIds);
    const written = await writeRolePermissions(client, roleId, pageIds);

    await client.query('COMMIT');
    return written;
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
  requireCompanyAdmin(actor);
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
    if (role.is_system) throw forbidden('System roles cannot be deleted');

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
  if (actor.is_snt_super) throw forbidden(SNT_ASSIGNS_NO_ROLES);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query(
      `SELECT id, company_id FROM users WHERE id = $1`, [user_id]);
    const target = userRows[0];
    if (!target) throw { status: 404, message: 'User not found' };

    if (!actor.company_id || target.company_id !== actor.company_id) {
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
    /* What the company paid for — or, for a company with no grants at all,
       everything, which is what "unrestricted" means everywhere else. This
       used to return nothing for that company, leaving its role editor empty. */
    query = `SELECT p.id, p.permission_key, p.description
             FROM permissions p
             WHERE p.permission_key LIKE 'page:%'
               AND (NOT EXISTS (SELECT 1 FROM company_permissions x
                                  JOIN permissions xp ON xp.id = x.permission_id
                                 WHERE x.company_id = $1 AND xp.permission_key LIKE 'page:%')
                    OR EXISTS (SELECT 1 FROM company_permissions cp
                                WHERE cp.company_id = $1 AND cp.permission_id = p.id))
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
