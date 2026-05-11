/**
 * Run once to update a user's email and password.
 * Usage: node scripts/update-user-credentials.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.POSTGRESQL_HOST,
  user:     process.env.POSTGRESQL_USER,
  database: process.env.POSTGRESQL_DATABASE,
  password: process.env.POSTGRESQL_PASSWORD,
  port:     Number(process.env.POSTGRESQL_PORT),
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const OLD_EMAIL   = 'gokul@gmail.com';
const NEW_EMAIL   = 'development1@stmcnc.com';
const NEW_PASSWORD = 'Development@123';

async function run() {
  const client = await pool.connect();
  try {
    const check = await client.query(
      `SELECT id, email FROM users WHERE email = $1`, [OLD_EMAIL]
    );

    if (!check.rowCount) {
      console.error(`❌ User not found: ${OLD_EMAIL}`);
      return;
    }

    const user = check.rows[0];
    console.log(`Found user id=${user.id} email=${user.email}`);

    const hash = await bcrypt.hash(NEW_PASSWORD, 10);

    await client.query(
      `UPDATE users
       SET email = $1, password_hash = $2
       WHERE id = $3`,
      [NEW_EMAIL, hash, user.id]
    );

    // Revoke all active sessions so old tokens can't be reused
    await client.query(
      `UPDATE user_sessions SET revoked = true WHERE user_id = $1`, [user.id]
    );

    console.log(`✅ Updated email to ${NEW_EMAIL} and password. All sessions revoked.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
