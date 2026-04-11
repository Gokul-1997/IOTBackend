const db = require('../db');

/**
 * Create a new company and optionally assign a plan immediately.
 * Only SNT_SUPER can call this.
 */
exports.create = async ({ company_code, company_name, contact_email, contact_phone, address, plan_id }) => {
  if (!company_code || !company_name) {
    throw { status: 400, message: 'company_code and company_name are required' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO companies (company_code, company_name, contact_email, contact_phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [company_code, company_name, contact_email || null, contact_phone || null, address || null]
    );
    const company = rows[0];

    if (plan_id) {
      await client.query(
        `INSERT INTO company_plans (company_id, plan_id) VALUES ($1, $2)`,
        [company.id, plan_id]
      );
    }

    await client.query('COMMIT');
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

    // Deactivate current plan assignment
    await client.query(
      `UPDATE company_plans SET is_active = false WHERE company_id = $1`,
      [company_id]
    );

    // Assign new plan
    const { rows } = await client.query(
      `INSERT INTO company_plans (company_id, plan_id, max_users, max_plants, max_machines, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
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
 * Delete (soft-deactivate) a company.
 */
exports.remove = async (id) => {
  const { rowCount } = await db.query(
    `UPDATE companies SET is_active = false, updated_at = now() WHERE id = $1`,
    [id]
  );
  if (!rowCount) throw { status: 404, message: 'Company not found' };
};
