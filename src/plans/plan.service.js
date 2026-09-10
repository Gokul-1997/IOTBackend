const db = require('../db');

// ── All app modules with CRUD actions ─────────────────────────
const APP_MODULES = [
  // ── Dashboard (widget-level control) ──
  { key: 'dashboard',      label: 'Dashboard',       group: 'Main',   actions: ['view', 'partcount', 'target', 'utilization', 'runtime', 'operator', 'status'] },
  { key: 'dashboard:live', label: 'Live Dashboard',   group: 'Main',   actions: ['view', 'power-consume', 'feed-override-chart', 'spindle-speed-chart'] },

  // ── OEE & Reports (widget-level control) ──
  { key: 'oee-reports',    label: 'OEE Reports',      group: 'Main',   actions: ['view', 'oee', 'availability', 'performance', 'quality', 'export'] },
  { key: 'reports',        label: 'Reports',          group: 'Main',   actions: ['view', 'kpi', 'export'] },
  { key: 'charts',         label: 'Charts',           group: 'Main',   actions: ['view', 'partwise-chart', 'hourly-chart'] },

  // ── Quality (widget-level) ──
  { key: 'quality',        label: 'Quality',          group: 'Main',   actions: ['view', 'oee-metrics', 'production-cards', 'hourly-chart', 'edit'] },

  // ── Phase 2 modules — added here because they were shipped with routes
  // and a nav entry (header.component.ts) but never registered as a real
  // permission. hasPermission() has no 'page:maintenance' etc. to grant
  // to anyone, so for every role except SNT_SUPER (which bypasses checks
  // entirely) the header's own permission filter silently hid Maintenance,
  // Alarms and Downtime from the nav menu — the pages worked fine if you
  // knew the URL (their routes have no guard), the menu item just never
  // rendered. Ticket actions (create/assign/status-change) live under the
  // existing 'maintenance' key rather than a new module, since Tickets is
  // a tab on that same page, not a separate route.
  { key: 'maintenance',       label: 'Maintenance',       group: 'Main', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'alarms',            label: 'Alarms',            group: 'Main', actions: ['view', 'resolve'] },
  { key: 'downtime',          label: 'Downtime',          group: 'Main', actions: ['view', 'create', 'edit'] },
  { key: 'production-plans',  label: 'Production Plans',  group: 'Main', actions: ['view', 'create', 'edit', 'delete'] },

  // Program Transfer shipped with a route and a nav entry but no module
  // entry at all, so no page:programs:* key had ever existed and every
  // /api/programs route ran on `auth` alone. Migration 013 grants these
  // to the system roles; the actions are deliberately finer than CRUD
  // because sending to a controller and deleting from the library carry
  // very different risk.
  { key: 'programs',          label: 'Program Transfer',  group: 'Main', actions: ['view', 'upload', 'transfer', 'fetch', 'delete'] },

  // ── Master pages (CRUD) ──
  { key: 'machines',       label: 'Machines',         group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'component',      label: 'Component',        group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'job',            label: 'Job',              group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'shifts',         label: 'Shifts',           group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'operators',      label: 'Operators',        group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'assignments',    label: 'Assignments',      group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'machine-shifts', label: 'Machine Shifts',   group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'plants',         label: 'Plants',           group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'lines',          label: 'Lines',            group: 'Master', actions: ['view', 'create', 'edit', 'delete'] },

  // ── Admin pages (CRUD) ──
  { key: 'users',          label: 'Users',            group: 'Admin',  actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'roles',          label: 'Roles',            group: 'Admin',  actions: ['view', 'create', 'edit', 'delete'] },
];

exports.APP_MODULES = APP_MODULES;

/**
 * Friendly labels for widget/action names shown in the permission UI.
 * Falls back to capitalized action name if not found here.
 */
const ACTION_LABELS = {
  view:              'View Page',
  create:            'Create',
  edit:              'Edit',
  delete:            'Delete',
  // Dashboard widgets
  partcount:         'Part Count (Achieved)',
  target:            'Target Quantity',
  utilization:       'Utilization Donut',
  runtime:           'Run / Idle Time',
  operator:          'Operator Panel',
  status:            'Status Summary Bar',
  // Live Dashboard widgets
  'power-consume':       'Power Consumption',
  'feed-override-chart': 'Feed Override Rate Chart',
  'spindle-speed-chart': 'Spindle Speed Chart',
  // OEE Reports widgets
  oee:               'OEE %',
  availability:      'Availability %',
  performance:       'Performance %',
  quality:           'Quality %',
  export:            'Export (CSV/Excel)',
  // Reports widgets
  kpi:               'KPI Summary Cards',
  // Charts widgets
  'partwise-chart':  'Part-Wise Run vs Idle Chart',
  'hourly-chart':    'Hourly Part Count Chart',
  // Program Transfer actions
  upload:            'Upload to Library',
  transfer:          'Send to Machine',
  fetch:             'Fetch from Machine',
  // Quality widgets
  'oee-metrics':     'OEE Metric Cards',
  'production-cards':'Production Cards (Target/Accepted/Rejected/Rework)',
};
exports.ACTION_LABELS = ACTION_LABELS;

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
        const friendlyAction = ACTION_LABELS[action] || (action.charAt(0).toUpperCase() + action.slice(1));
        const desc = `${friendlyAction} — ${mod.label}`;
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
    const actionLabel = ACTION_LABELS[action] || (action.charAt(0).toUpperCase() + action.slice(1));
    grouped[module].permissions.push({ ...row, action, actionLabel });
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
