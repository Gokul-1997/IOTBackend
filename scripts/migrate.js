#!/usr/bin/env node
/* Versioned schema changes only. The retired 003 data reset is never run.
 * --status / --dry are read-only. --through <filename> limits an upgrade.
 * --baseline --through <filename> records a verified existing schema only.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DIR = path.join(__dirname, '..', 'src', 'migrations');
const RETIRED = new Set(['003_clean_reset.sql']);
const LOCK = [742381, 1];
const sha = sql => crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

function optionsOf(args) {
  const options = { status: false, dry: false, baseline: false, through: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status') options.status = true;
    else if (args[i] === '--dry') options.dry = true;
    else if (args[i] === '--baseline') options.baseline = true;
    else if (args[i] === '--through') options.through = args[++i];
    else throw new Error(`Unknown migration option: ${args[i]}`);
  }
  if (args.includes('--through') && !options.through) throw new Error('--through needs a migration filename.');
  if (options.baseline && !options.through) throw new Error('Baseline requires --through <last verified migration>. It must never mark new, unapplied migrations as applied.');
  return options;
}

function filesOf(dir = DIR) {
  return fs.readdirSync(dir).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name) && !RETIRED.has(name)).sort();
}

function statementsOf(sql) {
  return sql.split(/;[ \t]*$/m).map(s => s.trim())
    .filter(s => s.split('\n').some(line => line.trim() && !line.trim().startsWith('--')));
}

function partsOf(sql) {
  if (sql.startsWith('-- migrate: statement-by-statement')) return { statements: statementsOf(sql) };
  // Existing enum additions must commit before SQL uses the new enum value.
  // Their preambles are idempotent; the schema body and ledger are atomic.
  const begin = /^BEGIN;\s*$/m.exec(sql);
  const hasEnumPreamble = begin && /ALTER\s+TYPE[\s\S]*?ADD\s+VALUE/i.test(sql.slice(0, begin.index));
  const preamble = hasEnumPreamble ? sql.slice(0, begin.index) : null;
  const body = (hasEnumPreamble ? sql.slice(begin.index) : sql)
    .replace(/^(?:BEGIN|COMMIT);[ \t]*\r?$/gm, '');
  return { preamble, body };
}

async function run(pool, { args = [], dir = DIR, log = console } = {}) {
  const options = optionsOf(args);
  const all = filesOf(dir);
  if (options.through && !all.includes(options.through)) throw new Error('--through must name a non-retired migration in the catalogue.');
  const client = await pool.connect();
  let locked = false;
  try {
    if (!options.status && !options.dry) {
      await client.query('SELECT pg_advisory_lock($1, $2)', LOCK);
      locked = true;
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY, checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), duration_ms INT)`);
    }
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
    const done = new Map(exists.rows[0]?.name
      ? (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map(r => [r.filename, r.checksum]) : []);
    const drifted = all.filter(f => done.has(f) && done.get(f) !== sha(fs.readFileSync(path.join(dir, f), 'utf8')));
    const pending = all.filter(f => !done.has(f) && (!options.through || f <= options.through));
    if (options.status || options.dry) {
      log.log(`applied: ${done.size}   pending in selected range: ${pending.length}`);
      for (const f of all) log.log(`${done.has(f) ? (drifted.includes(f) ? 'CHANGED' : 'applied') : 'PENDING'} ${f}`);
      if (done.has('003_clean_reset.sql')) log.log('retired: 003_clean_reset.sql (historical record retained; never run again)');
      if (drifted.length) log.error('Applied migration checksums changed. Write a new migration.');
      return drifted.length ? 1 : 0;
    }
    if (drifted.length) throw new Error(`Applied migrations changed: ${drifted.join(', ')}. Write a new migration.`);
    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
      const t0 = Date.now();
      const parts = partsOf(sql);
      let transaction = false;
      try {
        if (!options.baseline && parts.preamble) await client.query(parts.preamble);
        if (!options.baseline && parts.statements) {
          // Non-transactional hypertable index builds are replayable and idempotent.
          for (const statement of parts.statements) await client.query(statement);
        }
        await client.query('BEGIN');
        transaction = true;
        if (!options.baseline && parts.body) await client.query(parts.body);
        await client.query('INSERT INTO schema_migrations(filename, checksum, duration_ms) VALUES($1,$2,$3)',
          [filename, sha(sql), options.baseline ? 0 : Date.now() - t0]);
        await client.query('COMMIT');
        transaction = false;
        log.log(`${options.baseline ? 'recorded (not executed)' : 'applied'} ${filename}`);
      } catch (error) {
        if (transaction) await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${filename} failed: ${error.message}`, { cause: error });
      }
    }
    return 0;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', LOCK).catch(() => {});
    client.release();
  }
}

module.exports = { run, optionsOf, filesOf, partsOf, statementsOf, sha };
if (require.main === module) {
  // Validate options before loading database configuration or opening connections.
  try { optionsOf(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
  const pool = require('../src/db');
  run(pool, { args: process.argv.slice(2) }).then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
