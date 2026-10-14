const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../../scripts/ops/db-backup.sh');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-backup-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture({ failDump = false, failRemote = false } = {}) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const write = (name, source) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + source, { mode: 0o700 });
  write('pg_dump', failDump ? 'exit 1\n' : 'for arg do case "$arg" in --file=*) printf fixture-dump > "${arg#--file=}";; esac; done\n');
  write('pg_restore', 'exit 0\n');
  write('aws', 'printf "%s\\n" "$@" >> "$BACKUP_TEST_LOG"\n' + (failRemote ? 'exit 1\n' : 'exit 0\n'));
  const backup = path.join(root, 'backup'); fs.mkdirSync(backup);
  const log = path.join(root, 'aws.log');
  const env = { PATH: bin + ':' + process.env.PATH, PGDATABASE: 'fixture', BACKUP_DIR: backup,
    S3_URI: 's3://fixture-bucket/backups', BACKUP_TEST_LOG: log, KEEP_DAYS: '14' };
  return { backup, log, env };
}

test('dump and checksum are private, and missing prefix slash cannot overwrite the dump with its manifest', () => {
  const f = fixture(); const result = spawnSync('bash', [script], { env: f.env, encoding: 'utf8' });
  expect(result.status).toBe(0);
  const files = fs.readdirSync(f.backup); const name = files.find(file => file.endsWith('.dump'));
  expect(files.sort()).toEqual([name, name + '.sha256'].sort());
  const bytes = fs.readFileSync(path.join(f.backup, name));
  expect(fs.readFileSync(path.join(f.backup, name + '.sha256'), 'utf8')).toContain(crypto.createHash('sha256').update(bytes).digest('hex'));
  expect(fs.statSync(path.join(f.backup, name)).mode & 0o077).toBe(0);
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n');
  expect(calls.filter(arg => arg === 's3://fixture-bucket/backups/')).toHaveLength(2);
  expect(calls).toContain(path.join(f.backup, name));
  expect(calls).toContain(path.join(f.backup, name + '.sha256'));
});

test.each([{ failDump: true }, { failRemote: true }])('failed backup/upload preserves older recovery artifacts and removes temporary files/lock: %j', failure => {
  const f = fixture(failure); const old = path.join(f.backup, 'fixture_old.dump');
  fs.writeFileSync(old, 'older-backup'); fs.writeFileSync(old + '.sha256', 'older-manifest');
  const date = new Date(Date.now() - 40 * 86400_000); fs.utimesSync(old, date, date);
  const result = spawnSync('bash', [script], { env: f.env, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(old, 'utf8')).toBe('older-backup');
  expect(fs.readFileSync(old + '.sha256', 'utf8')).toBe('older-manifest');
  expect(fs.readdirSync(f.backup).some(file => file.endsWith('.part') || file.endsWith('backup-lock'))).toBe(false);
});
