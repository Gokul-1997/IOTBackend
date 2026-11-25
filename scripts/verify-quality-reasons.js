const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function verify() {
  const url = new URL(process.env.QUALITY_TEST_DATABASE_URL || '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Use an explicitly configured disposable local PostgreSQL database');
  const db = new Client({ connectionString: url.toString() });
  const schema = `quality_reason_fixture_${process.pid}`;
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public;
      CREATE TABLE quality_entries (id integer PRIMARY KEY, reject_qty integer, rework_qty integer);
      INSERT INTO quality_entries VALUES (1, 2, 1)`);
    const migration = fs.readFileSync(path.join(__dirname, '../src/migrations/069_quality_reasons.sql'), 'utf8');
    await db.query(migration);
    await db.query(migration);
    assert.deepEqual((await db.query('SELECT * FROM quality_entries WHERE id=1')).rows[0], {
      id: 1, reject_qty: 2, rework_qty: 1, rejection_reason: null, rework_reason: null
    });
    await db.query('UPDATE quality_entries SET rejection_reason=$1, rework_reason=$2 WHERE id=1', ['Diameter out of tolerance', 'தமிழ் - burr removal']);
    assert.deepEqual((await db.query('SELECT rejection_reason, rework_reason FROM quality_entries')).rows[0], {
      rejection_reason: 'Diameter out of tolerance', rework_reason: 'தமிழ் - burr removal'
    });
    await assert.rejects(db.query('UPDATE quality_entries SET rejection_reason=$1', ['x'.repeat(501)]), { code: '22001' });
    console.log('Quality reasons: migration replay, historical totals, independent text storage, Unicode and length limit passed.');
  } finally {
    await db.query('ROLLBACK');
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
}
verify().catch(error => { console.error(error.message); process.exitCode = 1; });
