const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const { sslOptions, positiveInteger } = require('./config/database');
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
 *   DB_READONLY_POOL_MAX   connections for read-only work (default 4)
 *   DB_STATEMENT_TIMEOUT_MS  longest a single query may run (default 60 s, as the server)
 *   DB_SSL                 'true' / 'false'; default: on when NODE_ENV=production
 */
const settings = {
  host: process.env.POSTGRESQL_HOST,
  user: process.env.POSTGRESQL_USER,
  database: process.env.POSTGRESQL_DATABASE,
  password: process.env.POSTGRESQL_PASSWORD,
  port: Number(process.env.POSTGRESQL_PORT),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: positiveInteger(process.env, 'DB_STATEMENT_TIMEOUT_MS', 60000, 600000),
  idle_in_transaction_session_timeout: 60000,
  ssl: sslOptions()
};

const pool = new Pool({ ...settings, max: positiveInteger(process.env, 'DB_POOL_MAX', 20, 200), application_name: 'iot-api' });

pool.on('error', (err) => {
  // an idle client lost its connection; the pool replaces it
  console.error('DB pool: idle client error:', err.message);
});

/*
 * Read-only work — the AI assistant's tools (23 Oct 2026, the user: "the AI
 * only reads; nothing written, not one line"). While `pool.readOnly(work)`
 * runs, every query this module is asked for — by the tool and by any
 * service it calls, however deep — goes through a second, small pool whose
 * connections start with default_transaction_read_only = on. PostgreSQL
 * itself then refuses any INSERT, UPDATE, DELETE or schema change, whatever
 * the code underneath tries. Everything outside readOnly() is unchanged.
 */
const readOnlyScope = new AsyncLocalStorage();
let readOnlyPool = null;
function readOnlyPoolOf() {
  if (!readOnlyPool) {
    readOnlyPool = new Pool({
      ...settings,
      max: positiveInteger(process.env, 'DB_READONLY_POOL_MAX', 4, 50),
      options: '-c default_transaction_read_only=on',
      application_name: 'iot-api-readonly'
    });
    readOnlyPool.on('error', err => console.error('DB read-only pool: idle client error:', err.message));
  }
  return readOnlyPool;
}

const query = pool.query.bind(pool);
const connect = pool.connect.bind(pool);
const end = pool.end.bind(pool);
pool.query = (...args) => (readOnlyScope.getStore() ? readOnlyPoolOf().query(...args) : query(...args));
pool.connect = (...args) => (readOnlyScope.getStore() ? readOnlyPoolOf().connect(...args) : connect(...args));
pool.end = async (...args) => {
  if (readOnlyPool) await readOnlyPool.end().catch(() => {});
  return end(...args);
};
/** Run `work` with the database refusing every write it attempts. */
pool.readOnly = work => readOnlyScope.run(true, work);

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
