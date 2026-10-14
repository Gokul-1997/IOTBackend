const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, optionsOf, filesOf, partsOf, sha } = require('../../scripts/migrate');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-migration-test-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const log = { log: jest.fn(), error: jest.fn() };
function fixture({ done = [], exists = true, failBody = false, failLedger = false } = {}) {
  const calls = [];
  const client = { release: jest.fn(), query: jest.fn(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('to_regclass')) return { rows: [{ name: exists ? 'schema_migrations' : null }] };
    if (sql === 'SELECT filename, checksum FROM schema_migrations') return { rows: done };
    if (failBody && sql.includes('CREATE TABLE fixture')) throw new Error('DDL failed');
    if (failLedger && sql.startsWith('INSERT INTO schema_migrations')) throw new Error('ledger failed');
    return { rows: [], rowCount: 1 };
  }) };
  return { calls, client, pool: { connect: jest.fn(async () => client) } };
}
test('retired reset can never enter the migration catalogue, even if copied back', () => {
  fs.writeFileSync(path.join(dir, '003_clean_reset.sql'), 'DELETE FROM companies');
  fs.writeFileSync(path.join(dir, '040_safe.sql'), 'SELECT 1;');
  expect(filesOf(dir)).toEqual(['040_safe.sql']);
});
test.each(['--status', '--dry'])('%s never creates the ledger or mutates schema', async option => {
  fs.writeFileSync(path.join(dir, '040_safe.sql'), 'CREATE TABLE fixture(id int);');
  const f = fixture({ exists: false });
  expect(await run(f.pool, { args: [option], dir, log })).toBe(0);
  expect(f.calls.every(c => c.sql.startsWith('SELECT '))).toBe(true);
  expect(f.client.release).toHaveBeenCalledTimes(1);
});
test('schema and applied marker commit together under one checked-out migration lock', async () => {
  fs.writeFileSync(path.join(dir, '040_safe.sql'), 'BEGIN;\nCREATE TABLE fixture(id int);\nCOMMIT;\n');
  const f = fixture();
  await run(f.pool, { dir, log });
  const sql = f.calls.map(c => c.sql);
  expect(sql[0]).toBe('SELECT pg_advisory_lock($1, $2)');
  const begin = sql.indexOf('BEGIN');
  expect(sql[begin + 1]).toContain('CREATE TABLE fixture');
  expect(sql[begin + 1]).not.toMatch(/^COMMIT;/m);
  expect(sql[begin + 2]).toMatch(/^INSERT INTO schema_migrations/);
  expect(sql[begin + 3]).toBe('COMMIT');
  expect(sql.at(-1)).toBe('SELECT pg_advisory_unlock($1, $2)');
  expect(f.pool.connect).toHaveBeenCalledTimes(1);
});
test.each([{ failBody: true }, { failLedger: true }])('DDL/ledger failure rolls back, unlocks and prevents later migrations', async failure => {
  fs.writeFileSync(path.join(dir, '040_safe.sql'), 'CREATE TABLE fixture(id int);');
  fs.writeFileSync(path.join(dir, '041_later.sql'), 'CREATE TABLE later(id int);');
  const f = fixture(failure);
  await expect(run(f.pool, { dir, log })).rejects.toThrow('Migration 040_safe.sql failed');
  const sql = f.calls.map(c => c.sql);
  expect(sql).toContain('ROLLBACK');
  expect(sql.join('\n')).not.toContain('CREATE TABLE later');
  expect(sql.at(-1)).toContain('pg_advisory_unlock');
  expect(f.client.release).toHaveBeenCalledTimes(1);
});
test('baseline needs an explicit verified boundary and never executes schema SQL', async () => {
  expect(() => optionsOf(['--baseline'])).toThrow('last verified migration');
  fs.writeFileSync(path.join(dir, '039_existing.sql'), 'SELECT existing_schema;');
  fs.writeFileSync(path.join(dir, '040_new.sql'), 'SELECT new_schema;');
  const f = fixture();
  await run(f.pool, { args: ['--baseline', '--through', '039_existing.sql'], dir, log });
  expect(f.calls.find(c => c.sql.startsWith('INSERT INTO schema_migrations')).values[0]).toBe('039_existing.sql');
  expect(f.calls.map(c => c.sql).join('\n')).not.toMatch(/SELECT (existing|new)_schema/);
});
test('checksum drift refuses upgrades instead of hiding changed historical migrations', async () => {
  fs.writeFileSync(path.join(dir, '040_safe.sql'), 'SELECT 1;');
  const f = fixture({ done: [{ filename: '040_safe.sql', checksum: sha('SELECT 2;') }] });
  await expect(run(f.pool, { dir, log })).rejects.toThrow('Applied migrations changed');
  expect(f.calls.map(c => c.sql)).not.toContain('BEGIN');
});
test('enum preamble is separated while function bodies retain their BEGIN/END', () => {
  const p = partsOf("ALTER TYPE state ADD VALUE IF NOT EXISTS 'NEW';\nBEGIN;\nDO $$\nBEGIN\n RAISE NOTICE 'ok';\nEND $$;\nCOMMIT;\n");
  expect(p.preamble).toContain('ALTER TYPE');
  expect(p.body).toContain("BEGIN\n RAISE NOTICE");
  expect(p.body).not.toMatch(/^COMMIT;/m);
});
