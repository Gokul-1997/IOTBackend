const { Pool } = require('pg');
require('dotenv').config();

/*
 * The API's connection pool.
 *
 * It was 10 connections with a 2 s wait for one. At 100 users that is enough
 * while they browse, but a burst (the shift starts and everyone opens a
 * dashboard; one slow Energy query holding a connection) emptied it, and
 * every request that waited 2 s failed with a 500 — 26 % of requests under
 * stress in the load test. Now 20 by default, a 5 s wait, and limits so one
 * runaway query or forgotten transaction cannot hold a connection forever.
 *
 *   DB_POOL_MAX            connections (default 20; the server allows 200)
 *   DB_STATEMENT_TIMEOUT_MS  longest a single query may run (default 60 s, as the server)
 *   DB_SSL                 'true' / 'false'; default: on when NODE_ENV=production
 */
const ssl = process.env.DB_SSL != null
  ? (process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false)
  : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false);

const pool = new Pool({
  host: process.env.POSTGRESQL_HOST,
  user: process.env.POSTGRESQL_USER,
  database: process.env.POSTGRESQL_DATABASE,
  password: process.env.POSTGRESQL_PASSWORD,
  port: Number(process.env.POSTGRESQL_PORT),
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 60000,
  idle_in_transaction_session_timeout: 60000,
  application_name: 'iot-api',
  ssl
});

pool.on('error', (err) => {
  // an idle client lost its connection; the pool replaces it
  console.error('DB pool: idle client error:', err.message);
});

// Check the connection at start-up — not under tests, where exiting the
// process would take the test worker (and every test file in it) down.
if (process.env.NODE_ENV !== 'test') {
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
}

module.exports = pool;
