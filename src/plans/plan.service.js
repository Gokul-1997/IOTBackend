const db = require('../db');

// ── All app modules with CRUD actions ─────────────────────────
const APP_MODULES = [
  { key: 'dashboard',      label: 'Dashboard',       group: 'Main',   actions: ['view'] },
  { key: 'dashboard:live', label: 'Live Dashboard',   group: 'Main',   actions: ['view'] },
  { key: 'oee-reports',    label: 'OEE Reports',      group: 'Main',   actions: ['view'] },
  { key: 'reports',        label: 'Reports',          group: 'Main',   actions: ['view'] },
  { key: 'charts',         label: 'Charts',           group: 'Main',   actions: ['view'] },
  { key: 'quality',        label: 'Quality',          group: 'Main',   actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'machines',       label: 'Machines',         group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'component',      label: 'Component',        group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'job',            label: 'Job',              group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'shifts',         label: 'Shifts',           group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'operators',      label: 'Operators',        group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'assignments',    label: 'Assignments',      group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'machine-shifts', label: 'Machine Shifts',   group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'plants',         label: 'Plants',           group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'lines',          label: 'Lines',            group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'users',          label: 'Users',            group: 'Admin',  actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'roles',          label: 'Roles',            group: 'Admin',  actions: ['view', 'create', 'edit', 'delete'] },
];

exports.APP_MODULES = APP_MODULES;

/**
 * Seed all page:module:action permissions into the permissions table.
 */
exports.seedPermissions = async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    for (const mod of APP_MODULES) {
      for (const action of mod.actions) {
        const key  = `page:${mod.key}:${action}`;
        const desc = `${action.charAt(0).toUpperCase() + action.slice(1)} on ${mod.label}`;
        await client.query(
          `INSERT INTO permissions (permission_key, description)
           VALUES ($1, $2)
           ON CONFLICT (permission_key) DO NOTHING`,
          [key, desc]
        );
      }
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
 * Return all permissions grouped by module for the role editor UI.
 */
exports.listPermissions = async () => {
  const { rows } = await db.query(
    `SELECT id, permission_key, description
     FROM permissions
     WHERE permission_key LIKE 'page:%'
     ORDER BY permission_key`
  );

  // Group by module
  const grouped = {};
  for (const row of rows) {
    const parts  = row.permission_key.split(':'); // ['page','machines','view']
    const module = parts.slice(1, -1).join(':');  // 'machines'
    const action = parts[parts.length - 1];       // 'view'
    const def    = APP_MODULES.find(m => m.key === module);

    if (!grouped[module]) {
      grouped[module] = {
        module,
        label:  def?.label  || module,
        group:  def?.group  || 'Other',
        permissions: []
      };
    }
    grouped[module].permissions.push({ ...row, action });
  }

  return Object.values(grouped);
};

// ── Plan CRUD ─────────────────────────────────────────────────

exports.list = async () => {
  const { rows: plans } = await db.query(
    `SELECT id, plan_code, plan_name, tier, description,
            max_users, max_plants, max_machines, is_active
     FROM plans ORDER BY tier`
  );

  for (const plan of plans) {
    const { rows } = await db.query(
      `SELECT feature_key, is_enabled FROM plan_features WHERE plan_id = $1 ORDER BY feature_key`,
      [plan.id]
    );
    plan.features = rows;
  }

  return plans;
};

exports.getById = async (id) => {
  const { rows } = await db.query(
    `SELECT id, plan_code, plan_name, tier, description,
            max_users, max_plants, max_machines, is_active
     FROM plans WHERE id = $1`,
    [id]
  );
  if (!rows.length) throw { status: 404, message: 'Plan not found' };

  const plan = rows[0];
  const { rows: features } = await db.query(
    `SELECT feature_key, is_enabled FROM plan_features WHERE plan_id = $1 ORDER BY feature_key`,
    [id]
  );
  plan.features = features;
  return plan;
};

exports.create = async ({ plan_code, plan_name, tier, description, max_users, max_plants, max_machines, features }) => {
  if (!plan_code || !plan_name) throw { status: 400, message: 'plan_code and plan_name required' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO plans (plan_code, plan_name, tier, description, max_users, max_plants, max_machines)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [plan_code, plan_name, tier || 1, description || null, max_users || 5, max_plants || 1, max_machines || 10]
    );
    const plan = rows[0];

    if (Array.isArray(features)) {
      for (const f of features) {
        await client.query(
          `INSERT INTO plan_features (plan_id, feature_key, is_enabled) VALUES ($1,$2,$3)
           ON CONFLICT (plan_id, feature_key) DO UPDATE SET is_enabled = $3`,
          [plan.id, f.feature_key, f.is_enabled !== false]
        );
      }
    }

    await client.query('COMMIT');
    return plan;
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw { status: 409, message: 'Plan code already exists' };
    throw e;
  } finally {
    client.release();
  }
};

exports.update = async (id, { plan_name, description, max_users, max_plants, max_machines, features, is_active }) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE plans
       SET plan_name    = COALESCE($1, plan_name),
           description  = COALESCE($2, description),
           max_users    = COALESCE($3, max_users),
           max_plants   = COALESCE($4, max_plants),
           max_machines = COALESCE($5, max_machines),
           is_active    = COALESCE($6, is_active)
       WHERE id = $7 RETURNING *`,
      [plan_name, description, max_users, max_plants, max_machines, is_active, id]
    );
    if (!rows.length) throw { status: 404, message: 'Plan not found' };

    if (Array.isArray(features)) {
      for (const f of features) {
        await client.query(
          `INSERT INTO plan_features (plan_id, feature_key, is_enabled) VALUES ($1,$2,$3)
           ON CONFLICT (plan_id, feature_key) DO UPDATE SET is_enabled = $3`,
          [id, f.feature_key, f.is_enabled !== false]
        );
      }
    }

    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
