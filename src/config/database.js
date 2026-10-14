const fs = require('node:fs');

function sslOptions(env = process.env) {
  if (env.DB_SSL != null && !['true', 'false'].includes(env.DB_SSL)) throw new Error('DB_SSL must be true or false.');
  const enabled = env.DB_SSL == null ? env.NODE_ENV === 'production' : env.DB_SSL === 'true';
  if (!enabled) return false;
  // Trust the operating system roots, or the explicitly configured private CA.
  // A certificate error must never silently become an unverified connection.
  return { rejectUnauthorized: true, ...(env.DB_SSL_CA_FILE ? { ca: fs.readFileSync(env.DB_SSL_CA_FILE, 'utf8') } : {}) };
}

function positiveInteger(env, key, fallback, maximum) {
  if (env[key] == null || env[key] === '') return fallback;
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
  return value;
}

module.exports = { sslOptions, positiveInteger };
