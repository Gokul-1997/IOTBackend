const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.POSTGRESQL_HOST,
  user: process.env.POSTGRESQL_USER,
  database: process.env.POSTGRESQL_DATABASE,
  password: process.env.POSTGRESQL_PASSWORD,
  port: Number(process.env.POSTGRESQL_PORT),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connection (only once at boot)
(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ DB connected successfully');
    client.release();
  } catch (err) {
    console.error('❌ DB connection failed:', err.message);
    process.exit(1); // fail fast
  }
})();

module.exports = pool;
