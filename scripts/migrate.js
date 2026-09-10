#!/usr/bin/env node
/**
 * Apply database migrations, once each, in order.
 *
 * Written after a migration that had been committed but never run left the
 * Programs page broken in production. Nothing recorded what had been
 * applied, so the only way to answer "is the database up to date?" was to
 * inspect the schema by hand and remember what to look for. That is not a
 * question a person should be answering.
 *
 *   npm run migrate            apply everything not yet applied
 *   npm run migrate -- --dry   list what would be applied, change nothing
 *   npm run migrate -- --status  show applied and pending
 *   npm run migrate -- --baseline
 *                              record every current file as applied WITHOUT
 *                              running it, for a database that already has
 *                              this schema. Run this once, on an existing
 *                              deployment, before the first real migrate.
 *
 * Each file manages its own transaction. Several of ours have to: ALTER
 * TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
 * so those statements sit outside the file's BEGIN/COMMIT. Wrapping the
 * whole file in another transaction here would break them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../src/db');

const DIR = path.join(__dirname, '..', 'src', 'migrations');

const args = process.argv.slice(2);
const DRY      = args.includes('--dry');
const STATUS   = args.includes('--status');
const BASELINE = args.includes('--baseline');

const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INT
    )`);
}

function files() {
  return fs.readdirSync(DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();   // 001_, 002_ … lexical order is the intended order
}

async function applied() {
  const { rows } = await pool.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(rows.map(r => [r.filename, r.checksum]));
}

async function main() {
  await ensureTable();
  const done = await applied();
  const all = files();
  const pending = all.filter(f => !done.has(f));

  /* A migration that changed after being applied is a real problem: the
     database no longer matches the file, and nobody can tell what it
     actually contains. Report it rather than silently ignoring it. */
  const drifted = all.filter(f => {
    const prev = done.get(f);
    return prev && prev !== sha(fs.readFileSync(path.join(DIR, f), 'utf8'));
  });

  if (STATUS || DRY) {
    console.log(`applied: ${done.size}   pending: ${pending.length}`);
    for (const f of all) {
      const mark = done.has(f) ? (drifted.includes(f) ? 'CHANGED' : 'applied') : 'PENDING';
      console.log(`  ${mark.padEnd(8)} ${f}`);
    }
    if (drifted.length) {
      console.error(`\n${drifted.length} applied migration(s) have been edited since. ` +
                    `The database no longer matches the file; write a new migration instead.`);
    }
    return drifted.length ? 1 : 0;
  }

  if (BASELINE) {
    if (!pending.length) { console.log('nothing to baseline — every file is already recorded'); return 0; }
    for (const f of pending) {
      await pool.query(
        `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1,$2,0)
         ON CONFLICT (filename) DO NOTHING`,
        [f, sha(fs.readFileSync(path.join(DIR, f), 'utf8'))]
      );
      console.log(`  recorded (not run)  ${f}`);
    }
    console.log(`\nbaselined ${pending.length} file(s). Future runs will apply only new ones.`);
    return 0;
  }

  if (drifted.length) {
    console.error('refusing to run: these applied migrations have been edited since —');
    drifted.forEach(f => console.error('  ' + f));
    console.error('Write a new migration rather than changing one that has already run.');
    return 1;
  }

  if (!pending.length) { console.log(`up to date — ${done.size} migration(s) applied`); return 0; }

  console.log(`applying ${pending.length} migration(s)…\n`);
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const t0 = Date.now();
    try {
      await pool.query(sql);
      const ms = Date.now() - t0;
      await pool.query(
        `INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1,$2,$3)`,
        [f, sha(sql), ms]
      );
      console.log(`  ok  ${f}  (${ms}ms)`);
    } catch (err) {
      // Stop at the first failure. Continuing would apply later migrations
      // on top of a schema that is missing what this one was adding.
      console.error(`  FAILED  ${f}\n    ${err.message}`);
      console.error('\nStopped. Later migrations were not attempted.');
      return 1;
    }
  }
  console.log(`\ndone — ${pending.length} applied`);
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => { console.error(err); process.exit(1); });
