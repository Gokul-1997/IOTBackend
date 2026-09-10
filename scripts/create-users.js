require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const pool = new Pool({
  host: process.env.POSTGRESQL_HOST,
  user: process.env.POSTGRESQL_USER,
  database: process.env.POSTGRESQL_DATABASE,
  password: process.env.POSTGRESQL_PASSWORD,
  port: Number(process.env.POSTGRESQL_PORT),
  ssl: { rejectUnauthorized: false }
});

// Random per-run password — never hardcode real credentials in a script
// that gets committed to git. Printed once below; relay it to the user
// over a secure channel and have them change it on first login.
function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

const NEW_USERS = [
  { email: 'erp@mechmatrixindia.com',         username: 'ERP MechMatrix',        password: generatePassword() },
  { email: 'production1@mechmatrixindia.com',  username: 'Production1 MechMatrix', password: generatePassword() },
];

async function main() {
  const client = await pool.connect();
  try {
    // 1. Look up development1@stmcnc.com
    const refRes = await client.query(
      `SELECT u.id, u.username, u.email, u.company_id, u.plant_id, u.user_type
       FROM users u WHERE u.email = $1`,
      ['development1@stmcnc.com']
    );

    if (!refRes.rowCount) {
      console.error('❌  Reference user development1@stmcnc.com not found in DB');
      return;
    }

    const refUser = refRes.rows[0];
    console.log('✅  Reference user found:', refUser);

    // 2. Get their roles
    const rolesRes = await client.query(
      `SELECT r.id, r.role_name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [refUser.id]
    );
    const roles = rolesRes.rows;
    console.log('   Roles:', roles.map(r => r.role_name).join(', ') || 'none');

    // 3. Find company for mechmatrixindia.com (may differ from stmcnc.com)
    const compRes = await client.query(
      `SELECT id, company_name FROM companies
       WHERE LOWER(company_name) LIKE '%mechmatrix%' OR LOWER(company_name) LIKE '%mech matrix%'
       LIMIT 1`
    );

    let targetCompanyId = refUser.company_id;
    let targetPlantId   = refUser.plant_id;

    if (compRes.rowCount) {
      console.log('   Found MechMatrix company:', compRes.rows[0]);
      targetCompanyId = compRes.rows[0].id;
      // Look up a plant under that company (use first plant if any)
      const plantRes = await client.query(
        `SELECT id FROM plants WHERE company_id = $1 AND is_active = true LIMIT 1`,
        [targetCompanyId]
      );
      targetPlantId = plantRes.rowCount ? plantRes.rows[0].id : null;
    } else {
      console.log('   No MechMatrix company found — using same company as reference user (company_id:', targetCompanyId, ')');
    }

    // 4. Create each new user
    for (const u of NEW_USERS) {
      const exists = await client.query(`SELECT id FROM users WHERE email = $1`, [u.email]);
      if (exists.rowCount) {
        console.log(`⚠️   ${u.email} already exists — skipping`);
        continue;
      }

      const hash = await bcrypt.hash(u.password, 10);

      await client.query('BEGIN');
      try {
        const ins = await client.query(
          `INSERT INTO users (username, email, password_hash, plant_id, company_id, user_type, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           RETURNING id, username, email`,
          [u.username, u.email, hash, targetPlantId, targetCompanyId, refUser.user_type]
        );
        const newUser = ins.rows[0];

        for (const role of roles) {
          await client.query(
            `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
            [newUser.id, role.id]
          );
        }

        await client.query('COMMIT');
        console.log(`✅  Created: ${newUser.email} (id=${newUser.id}) with roles: [${roles.map(r => r.role_name).join(', ')}]`);
        console.log(`   Temporary password (shown once — relay securely, not over email/chat): ${u.password}`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`❌  Failed to create ${u.email}:`, e.message);
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
