const { spawnSync } = require('node:child_process');
const path = require('node:path');
const script = path.resolve(__dirname, '../../scripts/ops/db-restore-test.sh');
test.each(['iot', 'postgres', 'iot_restore_test', 'iot_restore_test_x;DROP DATABASE iot', 'iot_restore_test_' + 'x'.repeat(60)])('refuses unsafe scratch target %s before invoking database tools', target => {
  const result = spawnSync('bash', [script, '/nonexistent.dump', target], { encoding: 'utf8', env: { PATH: process.env.PATH, PGDATABASE: 'iot' } });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Target must be');
});
test('refuses restoring over explicitly supplied source even with a scratch-looking name', () => {
  const result = spawnSync('bash', [script, '/nonexistent.dump', 'iot_restore_test_source'], { encoding: 'utf8', env: { PATH: process.env.PATH, SOURCE_DB: 'iot_restore_test_source' } });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('source database');
});
