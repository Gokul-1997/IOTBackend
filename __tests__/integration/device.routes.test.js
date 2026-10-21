/*
 * /api/device/v1 over HTTP — the three calls a machine's gateway makes:
 * GET /status, GET /program, POST /backup. The database is the mock; files
 * go to a temporary storage folder.
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
  id: 3, company_id: 5, machine_id: 7, last_seen_at: new Date().toISOString(), last_seen_ip: '::ffff:127.0.0.1',
  agent_version: null, machine_serial_no: 'VMC-1', machine_active: true, machine_company_id: 5, company_active: true, ...o
}));

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
           stored_name: saved.storedName, size_bytes: saved.size, sha256: saved.sha256, created_at: '2026-10-21T05:00:00Z' };
}

test('no token, or a wrong one: 401 with a code the gateway can act on', async () => {
  const missing = await request(app).get('/api/device/v1/status');
  expect(missing.status).toBe(401);
  expect(missing.body.code).toBe('TOKEN_MISSING');

  mockDb.queueResponse(none);
  const wrong = await request(app).get('/api/device/v1/status').set(AUTH);
  expect(wrong.status).toBe(401);
  expect(wrong.body.code).toBe('TOKEN_INVALID');
});

test('status: the machine, its program to compare by sha256, a backup request, and how often to ask', async () => {
  authRow();
  mockDb.queueResponse(one({ id: '81', program_name: 'O8001.nc', size_bytes: 20, sha256: 'a'.repeat(64), created_at: '2026-10-21T05:00:00Z' }),
    one({ id: '9', requested_at: '2026-10-21T05:10:00Z' }));
  const res = await request(app).get('/api/device/v1/status').set(AUTH);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({
    machine: { id: 7, serial: 'VMC-1' },
    program: { file_id: 81, program_name: 'O8001.nc', size_bytes: 20, sha256: 'a'.repeat(64), uploaded_at: '2026-10-21T05:00:00Z',
               status: 'WAITING', message: null },
    backup_request: { id: 9, requested_at: '2026-10-21T05:10:00Z' },
    poll_seconds: 15
  });
});

test('program: the file itself, with its name, id and checksum in the headers — as often as asked', async () => {
  const body = Buffer.from('%\nO8001\nG0 X25\nM30\n%\n');
  const file = await savedProgram(body);
  for (let i = 0; i < 2; i++) {
    authRow();
    mockDb.queueResponse(one(file));
    const res = await request(app).get('/api/device/v1/program').set(AUTH).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.body.equals(body)).toBe(true);
    expect(res.headers['x-program-name']).toBe('O8001.nc');
    expect(res.headers['x-file-id']).toBe('81');
    expect(res.headers['x-sha256']).toBe(file.sha256);
    expect(res.headers['content-length']).toBe(String(body.length));
  }
  expect(mockDb.calls().filter(c => /program_jobs/.test(c.text))).toHaveLength(0);
});

test('program: none uploaded yet is a 404 with a code', async () => {
  authRow();
  mockDb.queueResponse(none);
  const res = await request(app).get('/api/device/v1/program').set(AUTH);
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ status: 'error', code: 'NO_PROGRAM' });
});

test('backup: one multipart call with the file; saved as a backup of this machine', async () => {
  authRow();
  mockDb.queueResponse(one({ id: '90', machine_id: 7, program_name: 'O1234.nc', kind: 'BACKUP', size_bytes: 13, sha256: 'c'.repeat(64), created_at: 'T0' }),
    none);
  const res = await request(app).post('/api/device/v1/backup').set(AUTH)
    .field('program_name', 'O1234.nc').attach('file', Buffer.from('%\nO1234\nM30\n%'), 'running.nc');
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ file: { file_id: 90, program_name: 'O1234.nc', size_bytes: 13, sha256: 'c'.repeat(64), uploaded_at: 'T0' },
                             answered_request: null });
  const insert = mockDb.calls().find(c => /INSERT INTO program_files/.test(c.text));
  expect(insert.params.slice(0, 2)).toEqual([5, 7]);
  expect(insert.params[2]).toBe('company-5/programs/machine-7/backups');
  expect(insert.params[4]).toBe('O1234.nc');
});

test.each([
  ['no file', r => r, 400, 'NO_FILE'],
  ['a file over the size limit', r => r.attach('file', Buffer.alloc(1024 * 1024 + 1, 'G'), 'big.nc'), 413, 'TOO_LARGE'],
  ['a binary file', r => r.attach('file', Buffer.from([0, 1, 2, 3]), 'O1.nc'), 400, 'NOT_TEXT']
])('backup: %s is refused with a code', async (_, attach, status, code) => {
  authRow();
  const res = await attach(request(app).post('/api/device/v1/backup').set(AUTH).field('program_name', 'O1.nc'));
  expect(res.status).toBe(status);
  expect(res.body.code).toBe(code);
  expect(mockDb.calls().find(c => /INSERT INTO program_files/.test(c.text))).toBeUndefined();
});

test('report: JSON in, the result out; a missing reason is a 400 with a code', async () => {
  authRow();
  mockDb.queueResponse(one({ id: '81', program_name: 'O8001.nc', uploaded_by: null }));
  const done = await request(app).post('/api/device/v1/report').set(AUTH).send({ file_id: 81, status: 'DONE' });
  expect(done.status).toBe(200);
  expect(done.body).toEqual({ file_id: 81, status: 'DONE' });

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
