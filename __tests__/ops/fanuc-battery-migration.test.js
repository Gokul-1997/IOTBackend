const fs = require('node:fs');
const path = require('node:path');
const readSql = file => fs.readFileSync(path.join(__dirname, '../../src/migrations', file), 'utf8')
  .replace(/--.*$/gm, '');

test('062 adds nullable JSON diagnostics with no historical rewrite or table-wide validation', () => {
  const sql = readSql('062_fanuc_battery_diagnostics.sql');
  expect(sql).toMatch(/BEGIN;[\s\S]*SET LOCAL lock_timeout = '5s';[\s\S]*COMMIT;/);
  for (const column of ['acc_battery_status', 'cnc_battery_warning']) {
    expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} JSONB[,;]`));
  }
  expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|DEFAULT|NOT NULL|VALIDATE|CREATE INDEX)\b/i);
  expect(sql).not.toMatch(/\bALTER COLUMN\b/i);
});

test('062 rollback removes only the new diagnostics, preserving legacy APC data', () => {
  const sql = readSql('rollback/062_fanuc_battery_diagnostics_down.sql');
  expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
  expect(sql).toContain('DROP COLUMN IF EXISTS acc_battery_status');
  expect(sql).toContain('DROP COLUMN IF EXISTS cnc_battery_warning');
  expect(sql).not.toMatch(/\bapc_battery_status\b/);
});
