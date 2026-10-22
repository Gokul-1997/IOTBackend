/*
 * /api/device/v1 over HTTP — the four calls a company's gateway makes with
 * its one token: GET /status (every machine), GET /program?machine=,
 * POST /backup (machine + file), POST /report. The database is the mock;
 * files go to a temporary storage folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dev-'));
process.env.STORAGE_ROOT = path.join(TMP, 'storage');
process.env.PROGRAM_MAX_MB = '1';

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const deviceToken = require('../../src/programs/device-token');
const storage = require('../../src/programs/storage');

const app = express();
app.use(express.json());
app.use('/api/device/v1', require('../../src/programs/device.routes'));

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => resetDb());

const { token } = deviceToken.generate();
const AUTH = { Authorization: `Bearer ${token}` };
const machine = { id: 7, company_id: 5, machine_serial_no: 'VMC-1' };
const one = row => ({ rows: [row], rowCount: 1 });
const none = { rows: [], rowCount: 0 };

const authRow = (o = {}) => mockDb.queueResponse(one({
  id: 3, company_id: 5, last_seen_at: new Date().toISOString(), last_seen_ip: '::ffff:127.0.0.1',
  agent_version: null, company_name: 'Acme Gears', company_active: true, ...o
}));
const machineRow = (o = {}) => mockDb.queueResponse(one({ ...machine, is_active: true, machine_ip: '192.168.1.10', ...o }));

const binary = (r, cb) => {
  const chunks = [];
  r.on('data', chunk => chunks.push(chunk));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function savedProgram(text, name = 'O8001.nc') {
  const source = path.join(TMP, `source-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(source, text);
  const saved = await storage.saveStream({ machine, kind: 'NEW', programName: name, filename: source });
  return { id: '81', machine_id: 7, program_name: saved.programName, kind: 'NEW', folder: saved.folder,
           stored_name: saved.storedName, size_bytes: saved.size, sha256: saved.sha256, created_at: '2026-10-22T05:00:00Z' };
}

test('no token, a wrong one, or an old machine token: 401 with a code the gateway can act on', async () => {
  const missing = await request(app).get('/api/device/v1/status');
  expect(missing.status).toBe(401);
  expect(missing.body.code).toBe('TOKEN_MISSING');

  mockDb.queueResponse(none);
  const wrong = await request(app).get('/api/device/v1/status').set(AUTH);
  expect(wrong.status).toBe(401);
  expect(wrong.body.code).toBe('TOKEN_INVALID');

  const old = await request(app).get('/api/device/v1/status').set({ Authorization: `Bearer mxd_${'Q'.repeat(43)}` });
  expect(old.status).toBe(401);
  expect(old.body.code).toBe('TOKEN_REPLACED');
});

test('status: every machine of the company in one call — its name, IP, next program, line and backup request', async () => {
  authRow();
  mockDb.queueResponse({ rows: [
    { machine_serial_no: 'VMC-1', machine_ip: '192.168.1.10', file_id: '81', program_name: 'O8001.nc', size_bytes: 20,
      sha256: 'a'.repeat(64), created_at: '2026-10-22T05:00:00Z', waiting: '2', request_id: '9', requested_at: '2026-10-22T05:10:00Z' },
    { machine_serial_no: 'VMC-2', machine_ip: null, file_id: null, waiting: null, request_id: null }
  ], rowCount: 2 });
  const res = await request(app).get('/api/device/v1/status').set(AUTH);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({
    company: 'Acme Gears',
    machines: [
      { machine: 'VMC-1', machine_ip: '192.168.1.10',
        program: { file_id: 81, program_name: 'O8001.nc', size_bytes: 20, sha256: 'a'.repeat(64), uploaded_at: '2026-10-22T05:00:00Z' },
        programs_waiting: 2,
        backup_request: { id: 9, requested_at: '2026-10-22T05:10:00Z' } },
      { machine: 'VMC-2', machine_ip: null, program: null, programs_waiting: 0, backup_request: null }
    ],
    poll_seconds: 15
  });
  const q = mockDb.calls()[1];
  expect(q.params).toEqual([5, 30]);                                   // the token's company, nothing from the request
  expect(q.text).toMatch(/m\.company_id = \$1 AND m\.is_active = true/);
  expect(mockDb.calls()).toHaveLength(2);                              // one query for all machines
});

test('program: the machine named gets the file in front of its line, with its id, name and checksum in the headers', async () => {
  const body = Buffer.from('%\nO8001\nG0 X25\nM30\n%\n');
  const file = await savedProgram(body);
  for (const query of ['machine=VMC-1', 'machine=vmc-1', 'machine_ip=192.168.1.10']) {
    authRow();
    machineRow();
    mockDb.queueResponse(one(file));
    const res = await request(app).get(`/api/device/v1/program?${query}`).set(AUTH).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.body.equals(body)).toBe(true);
    expect(res.headers['x-program-name']).toBe('O8001.nc');
    expect(res.headers['x-file-id']).toBe('81');
    expect(res.headers['x-machine']).toBe('VMC-1');
    expect(res.headers['x-sha256']).toBe(file.sha256);
    expect(res.headers['content-length']).toBe(String(body.length));
    const line = mockDb.calls().at(-1);
    expect(line.params).toEqual([7]);
    expect(line.text).toMatch(/delivery_status IS NULL/);
    expect(line.text).toMatch(/ORDER BY f\.created_at, f\.id/);         // oldest first
  }
});

test('program: no machine named, an unknown machine, nothing waiting — each a code the gateway can act on', async () => {
  authRow();
  let res = await request(app).get('/api/device/v1/program').set(AUTH);
  expect([res.status, res.body.code]).toEqual([400, 'MACHINE_REQUIRED']);

  authRow();
  mockDb.queueResponse(none);
  res = await request(app).get('/api/device/v1/program?machine=VMC-9').set(AUTH);
  expect([res.status, res.body.code]).toEqual([404, 'MACHINE_NOT_FOUND']);
  expect(res.body.message).toBe('No machine "VMC-9" in Acme Gears. Use the names and IPs GET /status lists.');

  authRow();
  machineRow();
  mockDb.queueResponse(none);
  res = await request(app).get('/api/device/v1/program?machine=VMC-1').set(AUTH);
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ status: 'error', code: 'NO_PROGRAM', message: 'Nothing is waiting for VMC-1.' });
});

test('backup: one multipart call with the machine and the file; saved as a backup of that machine', async () => {
  authRow();
  machineRow();
  mockDb.queueResponse(one({ id: '90', machine_id: 7, program_name: 'O1234.nc', kind: 'BACKUP', size_bytes: 13, sha256: 'c'.repeat(64), created_at: 'T0' }),
    none);
  const res = await request(app).post('/api/device/v1/backup').set(AUTH)
    .field('machine', 'VMC-1').field('program_name', 'O1234.nc').attach('file', Buffer.from('%\nO1234\nM30\n%'), 'running.nc');
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ machine: 'VMC-1',
                             file: { file_id: 90, program_name: 'O1234.nc', size_bytes: 13, sha256: 'c'.repeat(64), uploaded_at: 'T0' },
                             answered_request: null });
  expect(mockDb.calls()[1].params).toEqual([5, 'VMC-1', null]);       // found within the token's company
  const insert = mockDb.calls().find(c => /INSERT INTO program_files/.test(c.text));
  expect(insert.params.slice(0, 2)).toEqual([5, 7]);
  expect(insert.params[2]).toBe('company-5/programs/machine-7/backups');
  expect(insert.params[4]).toBe('O1234.nc');
  expect(insert.params[9]).toBe(3);                                    // the gateway that sent it
});

test.each([
  ['no machine', r => r.attach('file', Buffer.from('M30'), 'O1.nc'), false, 400, 'MACHINE_REQUIRED'],
  ['no file', r => r.field('machine', 'VMC-1'), true, 400, 'NO_FILE'],
  ['a file over the size limit', r => r.field('machine', 'VMC-1').attach('file', Buffer.alloc(1024 * 1024 + 1, 'G'), 'big.nc'), true, 413, 'TOO_LARGE'],
  ['a binary file', r => r.field('machine', 'VMC-1').attach('file', Buffer.from([0, 1, 2, 3]), 'O1.nc'), true, 400, 'NOT_TEXT']
])('backup: %s is refused with a code', async (_, attach, found, status, code) => {
  authRow();
  if (found) machineRow();
  const res = await attach(request(app).post('/api/device/v1/backup').set(AUTH).field('program_name', 'O1.nc'));
  expect(res.status).toBe(status);
  expect(res.body.code).toBe(code);
  expect(mockDb.calls().find(c => /INSERT INTO program_files/.test(c.text))).toBeUndefined();
});

test('report: JSON in, the result and the machine\'s next program out; a missing reason is a 400 with a code', async () => {
  authRow();
  mockDb.queueResponse(one({ id: '81', machine_id: 7, program_name: 'O8001.nc', uploaded_by: null, machine_serial_no: 'VMC-1' }),
    one({ id: '82', program_name: 'O8002.nc', size_bytes: 30, sha256: 'b'.repeat(64), created_at: 'T1' }));
  const done = await request(app).post('/api/device/v1/report').set(AUTH).send({ file_id: 81, status: 'DONE' });
  expect(done.status).toBe(200);
  expect(done.body).toEqual({ file_id: 81, machine: 'VMC-1', status: 'DONE',
    next_program: { file_id: 82, program_name: 'O8002.nc', size_bytes: 30, sha256: 'b'.repeat(64), uploaded_at: 'T1' } });

  authRow();
  const bad = await request(app).post('/api/device/v1/report').set(AUTH).send({ file_id: 81, status: 'FAILED' });
  expect(bad.status).toBe(400);
  expect(bad.body).toMatchObject({ status: 'error', code: 'NO_MESSAGE' });
});

test.each(['/jobs/next', '/ping', '/commands/next'])('the retired %s call is gone', async route => {
  authRow();
  const res = await request(app).get(`/api/device/v1${route}`).set(AUTH);
  expect(res.status).toBe(404);
});
