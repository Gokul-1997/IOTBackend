const db = require('../db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendEmail } = require('../utils/nodemailer');

/**
 * Generate a secure random password: 2 upper + 2 lower + 2 digits + 2 special = 10 chars
 */
function generatePassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '@#$&!';
  const pick = (s, n) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
  const parts = pick(upper, 2) + pick(lower, 3) + pick(digits, 2) + pick(special, 1);
  // Shuffle
  return parts.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

/**
 * Create a new company + its first admin user.
 * Password is auto-generated and emailed.
 * Only SNT_SUPER can call this.
 */
exports.create = async ({ company_code, company_name, contact_email, contact_phone, address, plan_id, admin_username, admin_email }) => {
  if (!company_code || !company_name) {
    throw { status: 400, message: 'company_code and company_name are required' };
  }
  if (!admin_username || !admin_email) {
    throw { status: 400, message: 'Admin username and email are required' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check if admin email already exists
    const existingUser = await client.query(`SELECT id FROM users WHERE email = $1`, [admin_email]);
    if (existingUser.rowCount > 0) throw { status: 400, message: 'Admin email already exists' };

    // Create company
    const { rows } = await client.query(
      `INSERT INTO companies (company_code, company_name, contact_email, contact_phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [company_code, company_name, contact_email || null, contact_phone || null, address || null]
    );
    const company = rows[0];

    if (plan_id) {
      await client.query(
        `INSERT INTO company_plans (company_id, plan_id) VALUES ($1, $2)
       ON CONFLICT (company_id) DO UPDATE SET plan_id = $2, is_active = true`,
        [company.id, plan_id]
      );
    }

    // Create admin user for this company (auto-generated password)
    const admin_password = generatePassword();
    const hash = await bcrypt.hash(admin_password, 10);
    const userRes = await client.query(
      `INSERT INTO users (username, email, password_hash, plant_id, company_id, user_type, is_active)
       VALUES ($1, $2, $3, NULL, $4, 'company_user', true)
       RETURNING id, username, email`,
      [admin_username, admin_email, hash, company.id]
    );
    const adminUser = userRes.rows[0];

    // Assign COMPANY_ADMIN role
    const roleRes = await client.query(`SELECT id FROM roles WHERE role_name = 'COMPANY_ADMIN'`);
    if (roleRes.rowCount > 0) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [adminUser.id, roleRes.rows[0].id]
      );
    }

    // AUTO-GRANT all permissions to the new company (full access)
    // Get all available permissions
    const permRes = await client.query(`SELECT id FROM permissions ORDER BY id`);
    for (const perm of permRes.rows) {
      await client.query(
        `INSERT INTO company_permissions (company_id, permission_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [company.id, perm.id]
      );
    }

    await client.query('COMMIT');

    // Send login credentials email (fire and forget)
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    sendEmail({
      to: admin_email,
      subject: `Your Admin Account for ${company_name} — STM Mexa IoT`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <h2 style="color:#2B3990;">Welcome to STM Mexa IoT Platform</h2>
          <p>Your company <strong>${company_name}</strong> has been created. You are the Company Admin.</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="margin:4px 0;"><strong>Login URL:</strong> <a href="${loginUrl}/login">${loginUrl}/login</a></p>
            <p style="margin:4px 0;"><strong>Email:</strong> ${admin_email}</p>
            <p style="margin:4px 0;"><strong>Password:</strong> ${admin_password}</p>
          </div>
          <p style="color:#666;font-size:13px;">Please change your password after first login.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
          <p style="color:#999;font-size:12px;">STM Mexa IoT Platform</p>
        </div>
      `
    }).catch(err => console.error('Failed to send admin welcome email:', err.message));

    company.admin_user = adminUser;
    return company;
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw { status: 409, message: 'Company code already exists' };
    throw e;
  } finally {
    client.release();
  }
};

/**
 * List all companies with their active plan.
 */
exports.list = async () => {
  const { rows } = await db.query(
    `SELECT c.id, c.company_code, c.company_name, c.contact_email,
            c.contact_phone, c.is_active, c.created_at,
            p.id AS plan_id, p.plan_name, p.plan_code, p.tier,
            COALESCE(cp.max_users,    p.max_users)    AS max_users,
            COALESCE(cp.max_plants,   p.max_plants)   AS max_plants,
            COALESCE(cp.max_machines, p.max_machines) AS max_machines,
            cp.expires_at
     FROM companies c
     LEFT JOIN company_plans cp ON cp.company_id = c.id AND cp.is_active = true
     LEFT JOIN plans p ON p.id = cp.plan_id
     ORDER BY c.company_name`
  );
  return rows;
};

/**
 * Get single company with plan, users count, plants count.
 */
exports.getById = async (id) => {
  const { rows } = await db.query(
    `SELECT c.id, c.company_code, c.company_name, c.contact_email,
            c.contact_phone, c.address, c.logo_url, c.is_active, c.created_at,
            p.id AS plan_id, p.plan_name, p.plan_code, p.tier,
            COALESCE(cp.max_users,    p.max_users)    AS max_users,
            COALESCE(cp.max_plants,   p.max_plants)   AS max_plants,
            COALESCE(cp.max_machines, p.max_machines) AS max_machines,
            cp.expires_at
     FROM companies c
     LEFT JOIN company_plans cp ON cp.company_id = c.id AND cp.is_active = true
     LEFT JOIN plans p ON p.id = cp.plan_id
     WHERE c.id = $1`,
    [id]
  );
  if (!rows.length) throw { status: 404, message: 'Company not found' };

  const company = rows[0];

  // Count current users, plants & machines
  const [usersRes, plantsRes, machinesRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM users    WHERE company_id = $1 AND is_active = true`, [id]),
    db.query(`SELECT COUNT(*) FROM plants   WHERE company_id = $1 AND is_active = true`, [id]),
    db.query(`SELECT COUNT(*) FROM machines WHERE company_id = $1 AND is_active = true`, [id])
  ]);
  company.current_users    = parseInt(usersRes.rows[0].count,    10);
  company.current_plants   = parseInt(plantsRes.rows[0].count,   10);
  company.current_machines = parseInt(machinesRes.rows[0].count, 10);

  return company;
};

/**
 * Update company basic info.
 */
exports.update = async (id, { company_name, contact_email, contact_phone, address, logo_url, is_active }) => {
  const { rows } = await db.query(
    `UPDATE companies
     SET company_name   = COALESCE($1, company_name),
         contact_email  = COALESCE($2, contact_email),
         contact_phone  = COALESCE($3, contact_phone),
         address        = COALESCE($4, address),
         logo_url       = COALESCE($5, logo_url),
         is_active      = COALESCE($6, is_active),
         updated_at     = now()
     WHERE id = $7
     RETURNING *`,
    [company_name, contact_email, contact_phone, address, logo_url, is_active, id]
  );
  if (!rows.length) throw { status: 404, message: 'Company not found' };
  return rows[0];
};

/**
 * Assign or change a company's plan.
 * Supports per-company overrides for limits.
 */
/**
 * Assign or change a company's subscription plan.
 *
 * Three things the agreement asks for and this now does:
 *
 *   The plan must be real and active. Assigning a deactivated plan would
 *   leave the company with limits nobody is maintaining, and the quota
 *   middleware would happily enforce them for years.
 *
 *   Custom limits must not exceed what the plan permits. Without that
 *   check, "Bronze with max_machines 999" is accepted and the tiers mean
 *   nothing — the limits are the product, not a suggestion.
 *
 *   Every change is recorded. company_plans holds one row per company and
 *   is upserted, so without a history table each change silently erased
 *   the one before it and no one could say when a company moved tier or
 *   who authorised it.
 */
exports.assignPlan = async (company_id, { plan_id, max_users, max_plants, max_machines, expires_at, note }, changed_by = null) => {
  if (!plan_id) throw { status: 400, message: 'plan_id is required' };

  if (expires_at && Number.isNaN(Date.parse(expires_at))) {
    throw { status: 400, message: 'expires_at must be a valid date' };
  }
  if (expires_at && new Date(expires_at) <= new Date()) {
    throw { status: 400, message: 'expires_at is in the past. A plan cannot be assigned already expired.' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /* Lock the company's current assignment for the duration. Two admins
       changing the plan at once would otherwise both read the same "before"
       state and write two history rows that each claim to follow it. */
    const { rows: currentRows } = await client.query(
      `SELECT plan_id, max_users, max_plants, max_machines
         FROM company_plans WHERE company_id = $1 FOR UPDATE`,
      [company_id]
    );
    const before = currentRows[0] || null;

    const { rows: planRows } = await client.query(
      `SELECT id, plan_name, is_active, max_users, max_plants, max_machines
         FROM plans WHERE id = $1`,
      [plan_id]
    );
    const plan = planRows[0];
    if (!plan) throw { status: 404, message: 'Plan not found' };
    if (!plan.is_active) {
      throw { status: 400, message: `The ${plan.plan_name} plan is no longer available.` };
    }

    /* A custom limit above the plan's ceiling is rejected rather than
       silently clamped: an admin who typed 999 should be told the plan does
       not allow it, not left believing it was applied. */
    const checkLimit = (label, value, ceiling) => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw { status: 400, message: `${label} must be a whole number` };
      }
      if (ceiling != null && n > Number(ceiling)) {
        throw {
          status: 400,
          message: `${label} of ${n} exceeds the ${plan.plan_name} plan maximum of ${ceiling}.`
        };
      }
      return n;
    };

    const users    = checkLimit('Users limit',    max_users,    plan.max_users);
    const plants   = checkLimit('Plants limit',   max_plants,   plan.max_plants);
    const machines = checkLimit('Machines limit', max_machines, plan.max_machines);

    const { rows } = await client.query(
      `INSERT INTO company_plans (company_id, plan_id, max_users, max_plants, max_machines, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (company_id) DO UPDATE SET
         plan_id = $2,
         max_users = $3,
         max_plants = $4,
         max_machines = $5,
         expires_at = $6,
         is_active = true
       RETURNING *`,
      [company_id, plan_id, users, plants, machines, expires_at || null]
    );

    await client.query(
      `INSERT INTO company_plan_history
         (company_id, plan_id, max_users, max_plants, max_machines, expires_at,
          previous_plan_id, previous_max_users, previous_max_plants, previous_max_machines,
          changed_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [company_id, plan_id, users, plants, machines, expires_at || null,
       before?.plan_id ?? null, before?.max_users ?? null,
       before?.max_plants ?? null, before?.max_machines ?? null,
       changed_by, note || null]
    );

    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/** The audit trail for one company's plan, most recent change first. */
/**
 * What a company is using, against what its plan allows.
 *
 * The limits are resolved exactly as quota.middleware resolves them —
 * company_plans overrides first, the plan's own ceiling second — so a
 * screen showing "18 of 20 machines" agrees with the answer a create call
 * will actually give. An expired or inactive assignment grants nothing,
 * which is why `plan_active` is reported rather than inferred from dates
 * by the caller.
 *
 * Counts are of active rows only, matching what the quota check counts.
 */
exports.getUsage = async (company_id) => {
  const { rows } = await db.query(
    `SELECT c.id, c.company_name,
            p.id   AS plan_id,
            p.plan_name,
            cp.expires_at,
            (cp.id IS NOT NULL
               AND cp.is_active
               AND (cp.expires_at IS NULL OR cp.expires_at > NOW())) AS plan_active,
            COALESCE(cp.max_users,    p.max_users)    AS max_users,
            COALESCE(cp.max_plants,   p.max_plants)   AS max_plants,
            COALESCE(cp.max_machines, p.max_machines) AS max_machines,
            (SELECT COUNT(*) FROM users    u  WHERE u.company_id  = c.id AND u.is_active)::int  AS users_used,
            (SELECT COUNT(*) FROM plants   pl WHERE pl.company_id = c.id AND pl.is_active)::int AS plants_used,
            (SELECT COUNT(*) FROM machines m  WHERE m.company_id  = c.id AND m.is_active)::int  AS machines_used
       FROM companies c
       LEFT JOIN company_plans cp ON cp.company_id = c.id AND cp.is_active = true
       LEFT JOIN plans p ON p.id = cp.plan_id
      WHERE c.id = $1`,
    [company_id]
  );
  if (!rows.length) throw { status: 404, message: 'Company not found' };

  const r = rows[0];
  /* A limit of 0 or null means unlimited, the same reading quota.middleware
     takes ("if (!limit || limit <= 0) return next()"). Reporting it as 0
     would show every company as instantly over its limit. */
  const pct = (used, max) => (!max || Number(max) <= 0) ? null
    : Math.min(100, Math.round((Number(used) / Number(max)) * 100));

  return {
    ...r,
    users_pct:    pct(r.users_used, r.max_users),
    plants_pct:   pct(r.plants_used, r.max_plants),
    machines_pct: pct(r.machines_used, r.max_machines)
  };
};

exports.getPlanHistory = async (company_id, { page = 1, limit = 20 } = {}) => {
  const pageNum  = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset   = (pageNum - 1) * limitNum;

  const [dataRes, countRes] = await Promise.all([
    db.query(
      `SELECT h.id, h.changed_at, h.note,
              h.max_users, h.max_plants, h.max_machines, h.expires_at,
              h.previous_max_users, h.previous_max_plants, h.previous_max_machines,
              p.plan_name  AS plan_name,
              pp.plan_name AS previous_plan_name,
              u.username   AS changed_by_name
         FROM company_plan_history h
         LEFT JOIN plans p  ON p.id  = h.plan_id
         LEFT JOIN plans pp ON pp.id = h.previous_plan_id
         LEFT JOIN users u  ON u.id  = h.changed_by
        WHERE h.company_id = $1
        ORDER BY h.changed_at DESC, h.id DESC
        LIMIT $2 OFFSET $3`,
      [company_id, limitNum, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS total FROM company_plan_history WHERE company_id = $1`, [company_id])
  ]);

  const total = countRes.rows[0].total;
  return {
    data: dataRes.rows, total, page: pageNum, limit: limitNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum))
  };
};

/**
 * Get plan features (allowed pages) for a company.
 */
exports.getPlanFeatures = async (company_id) => {
  const { rows } = await db.query(
    `SELECT pf.feature_key, pf.is_enabled
     FROM company_plans cp
     JOIN plan_features pf ON pf.plan_id = cp.plan_id
     WHERE cp.company_id = $1 AND cp.is_active = true`,
    [company_id]
  );
  return rows;
};

/**
 * Get all permissions assigned to a company (page:module:action).
 * Returns grouped by module for the UI.
 */
exports.getCompanyPermissions = async (company_id) => {
  const { rows } = await db.query(
    `SELECT p.id, p.permission_key, p.description
     FROM company_permissions cp
     JOIN permissions p ON p.id = cp.permission_id
     WHERE cp.company_id = $1
     ORDER BY p.permission_key`,
    [company_id]
  );
  return rows;
};

/**
 * Assign page permissions to a company.
 * Super user selects which pages/actions the company can access.
 * permission_ids = array of permission IDs to grant.
 */
/**
 * Replace the page access a company has been granted.
 *
 * This is the write side of "Manage Access" — what S&T decides a company has
 * paid for. It used to DELETE every company_permissions row and re-insert
 * whatever ids arrived, which had four problems:
 *
 *   - nothing validated the ids. An unknown id failed on a foreign key
 *     halfway through and surfaced as a bare 500; a missing or non-array
 *     body threw a TypeError after the DELETE had already run.
 *   - a company that did not exist reported success.
 *   - the modal only knows page permissions, but the DELETE wiped every row,
 *     including any non-page grants a company held.
 *   - revoking a page changed nothing that enforces it: the roles inside the
 *     company kept the permission, so the revocation was cosmetic. A company
 *     admin could not GRANT the page again (role.service checks new grants
 *     against this table), but every role that already held it kept it.
 *
 * Now: validated, a diff against the current page grants (unchanged rows keep
 * their original granted_by/granted_at), and a revoke cascades to the
 * company's OWN roles. System roles are shared by every tenant, so their
 * permissions cannot be narrowed per company — the response says how many
 * role grants were removed so the caller is not left assuming more than
 * happened.
 *
 * An empty selection is refused. The frontend reads a company with no grants
 * as "fresh, unrestricted" (auth.service.ts: companyPerms.length === 0),
 * so saving nothing would not revoke everything — it would silently grant
 * everything.
 */
exports.assignCompanyPermissions = async (company_id, permission_ids, granted_by) => {
  if (!Array.isArray(permission_ids)) {
    throw { status: 400, message: 'permission_ids must be a list of permission ids' };
  }
  const wanted = [...new Set(permission_ids.map(Number))];
  if (wanted.some(n => !Number.isInteger(n) || n <= 0)) {
    throw { status: 400, message: 'permission_ids must be positive whole numbers' };
  }
  if (wanted.length === 0) {
    throw {
      status: 400, code: 'EMPTY_ACCESS',
      message: 'Select at least one page. A company with no access selected is treated as unrestricted, ' +
               'not as locked out — deactivate the company to lock it out.'
    };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Locks the row so two simultaneous saves serialise, and is the
    // existence check: previously a made-up company id reported success.
    const { rows: co } = await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [company_id]);
    if (!co.length) throw { status: 404, message: 'Company not found' };

    const { rows: valid } = await client.query(
      `SELECT id FROM permissions WHERE id = ANY($1::int[]) AND permission_key LIKE 'page:%'`,
      [wanted]
    );
    const validIds = new Set(valid.map(r => r.id));
    const unknown = wanted.filter(id => !validIds.has(id));
    if (unknown.length) {
      throw { status: 400, message: `Not a page permission: ${unknown.join(', ')}` };
    }

    // Only page permissions are managed here — legacy API keys (machine.view
    // and the like) are not in the catalogue the modal offers, so they are
    // neither read nor deleted.
    const { rows: cur } = await client.query(
      `SELECT cp.permission_id
         FROM company_permissions cp
         JOIN permissions p ON p.id = cp.permission_id
        WHERE cp.company_id = $1 AND p.permission_key LIKE 'page:%'`,
      [company_id]
    );
    const current   = new Set(cur.map(r => r.permission_id));
    const wantedSet = new Set(wanted);
    const added     = wanted.filter(id => !current.has(id));
    const removed   = [...current].filter(id => !wantedSet.has(id));

    if (removed.length) {
      await client.query(
        `DELETE FROM company_permissions WHERE company_id = $1 AND permission_id = ANY($2::int[])`,
        [company_id, removed]
      );
    }
    if (added.length) {
      await client.query(
        `INSERT INTO company_permissions (company_id, permission_id, granted_by)
         SELECT $1, unnest($2::int[]), $3
         ON CONFLICT DO NOTHING`,
        [company_id, added, granted_by || null]
      );
    }

    let revokedFromRoles = 0;
    if (removed.length) {
      const r = await client.query(
        `DELETE FROM role_permissions rp
          USING roles ro
          WHERE rp.role_id = ro.id
            AND ro.company_id = $1
            AND ro.is_system = false
            AND rp.permission_id = ANY($2::int[])`,
        [company_id, removed]
      );
      revokedFromRoles = r.rowCount || 0;
    }

    await client.query('COMMIT');

    // access.middleware caches a company's grants for up to a minute; without
    // this a revoke would keep working until it expired.
    await require('../middleware/access.middleware').invalidateCompanyGrants(company_id);

    return {
      company_id,
      permission_count: wanted.length,
      granted: added.length,
      revoked: removed.length,
      revoked_from_roles: revokedFromRoles
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Delete (soft-deactivate) a company.
 */
exports.remove = async (id) => {
  const { rowCount } = await db.query(
    `UPDATE companies SET is_active = false, updated_at = now() WHERE id = $1`,
    [id]
  );
  if (!rowCount) throw { status: 404, message: 'Company not found' };
};

/**
 * Permanently delete a company and ALL related data.
 * CASCADE handles: company_plans, company_permissions, users.company_id, roles.company_id
 * We also need to clean up user_roles and user_sessions for users in this company.
 */
exports.permanentDelete = async (id) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Get all user IDs for this company
    const { rows: companyUsers } = await client.query(
      `SELECT id FROM users WHERE company_id = $1`, [id]
    );
    const userIds = companyUsers.map(u => u.id);

    if (userIds.length > 0) {
      // Delete user_roles
      await client.query(`DELETE FROM user_roles WHERE user_id = ANY($1)`, [userIds]);
      // Delete user_sessions
      await client.query(`DELETE FROM user_sessions WHERE user_id = ANY($1)`, [userIds]);
      // Delete password_reset_tokens
      await client.query(`DELETE FROM password_reset_tokens WHERE user_id = ANY($1)`, [userIds]);
      // Delete users
      await client.query(`DELETE FROM users WHERE company_id = $1`, [id]);
    }

    // Delete custom roles for this company
    const { rows: companyRoles } = await client.query(
      `SELECT id FROM roles WHERE company_id = $1`, [id]
    );
    const roleIds = companyRoles.map(r => r.id);
    if (roleIds.length > 0) {
      await client.query(`DELETE FROM role_permissions WHERE role_id = ANY($1)`, [roleIds]);
      await client.query(`DELETE FROM roles WHERE company_id = $1`, [id]);
    }

    // Delete company_permissions, company_plans (CASCADE should handle, but explicit)
    await client.query(`DELETE FROM company_permissions WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM company_plans WHERE company_id = $1`, [id]);

    // Delete the company
    const { rowCount } = await client.query(`DELETE FROM companies WHERE id = $1`, [id]);
    if (!rowCount) {
      await client.query('ROLLBACK');
      throw { status: 404, message: 'Company not found' };
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
