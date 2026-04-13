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
       VALUES ($1, $2, $3, 1, $4, 'company_user', true)
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
            p.plan_name, p.plan_code, p.tier,
            cp.max_users, cp.max_plants, cp.max_machines, cp.expires_at
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

  // Count current users & plants
  const [usersRes, plantsRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_active = true`, [id]),
    db.query(`SELECT COUNT(*) FROM plants WHERE company_id = $1 AND is_active = true`, [id])
  ]);
  company.current_users  = parseInt(usersRes.rows[0].count, 10);
  company.current_plants = parseInt(plantsRes.rows[0].count, 10);

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
exports.assignPlan = async (company_id, { plan_id, max_users, max_plants, max_machines, expires_at }) => {
  if (!plan_id) throw { status: 400, message: 'plan_id is required' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Upsert plan assignment
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
      [company_id, plan_id, max_users || null, max_plants || null, max_machines || null, expires_at || null]
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
exports.assignCompanyPermissions = async (company_id, permission_ids, granted_by) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Remove old permissions
    await client.query(`DELETE FROM company_permissions WHERE company_id = $1`, [company_id]);

    // Insert new permissions
    for (const pid of permission_ids) {
      await client.query(
        `INSERT INTO company_permissions (company_id, permission_id, granted_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [company_id, pid, granted_by || null]
      );
    }

    await client.query('COMMIT');
    return { company_id, permission_count: permission_ids.length };
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
