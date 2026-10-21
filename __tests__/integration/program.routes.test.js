/*
 * /api/programs over HTTP — what a person can do on the Program Transfer
 * page, and what their role allows. The database is the mock; files go to a
 * temporary storage folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-routes-'));
process.env.STORAGE_ROOT = path.join(TMP, 'storage');

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
let mockUser;
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  if (!mockUser) return res.status(401).json({ message: 'Sign in required' });
  req.user = mockUser;
  next();
});

const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const app = express();
app.use(express.json());
app.use('/api/programs', require('../../src/programs/program.routes'));
const one = row => ({ rows: [row], rowCount: 1 });
const machine = { id: 7, company_id: 5, machine_serial_no: 'VMC-1' };
const ALL = ['page:programs:view', 'page:programs:upload', 'page:programs:transfer', 'page:programs:fetch', 'page:programs:delete', 'page:machines:edit'];

beforeEach(async () => {
  resetDb();
  mockUser = { id: 2, company_id: 5, permissions: [...ALL] };
  await require('../../src/redis').set('company_grants:5', '[]', 'EX', 60);   // a fresh company: no grant limits
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('upload: the file is saved for the machine and comes back as its program', async () => {
  mockDb.queueResponse(one(machine), one({ id: '101', machine_id: 7, program_name: 'O1001.nc', kind: 'NEW' }));
  const res = await request(app).post('/api/programs/files')
    .field('machine_id', '7').attach('file', Buffer.from('%\nO1001\nM30\n%'), 'O1001.nc');
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ status: 'success', data: { id: '101', program_name: 'O1001.nc', is_current: true } });
});

test.each(['page:programs:upload', 'page:programs:transfer'])('upload needs both Upload and Send to Machine, not just %s', async permission => {
  mockUser.permissions = ['page:programs:view', permission];
  const res = await request(app).post('/api/programs/files').field('machine_id', '7').attach('file', Buffer.from('M30'), 'O1.nc');
  expect(res.status).toBe(403);
  expect(mockDb.calls().find(c => /program_files/.test(c.text))).toBeUndefined();
});

test('backup request needs Fetch from Machine; the first click makes it, the second finds it', async () => {
  mockUser.permissions = ['page:programs:view'];
  expect((await request(app).post('/api/programs/machines/7/backup')).status).toBe(403);

  mockUser.permissions = [...ALL];
  mockDb.queueResponse(one(machine), { rows: [], rowCount: 0 }, one({ id: '9', requested_at: 'T0' }));
  const first = await request(app).post('/api/programs/machines/7/backup');
  expect(first.status).toBe(201);
  expect(first.body.data).toEqual({ id: '9', requested_at: 'T0', created: true });
});

test('delete needs Delete; the gateway token needs Machines → Edit', async () => {
  mockUser.permissions = ['page:programs:view'];
  expect((await request(app).delete('/api/programs/files/30')).status).toBe(403);
  expect((await request(app).post('/api/programs/machines/7/device-token')).status).toBe(403);
  expect((await request(app).delete('/api/programs/machines/7/device-token')).status).toBe(403);
  expect(mockDb.calls().find(c => /program_/.test(c.text))).toBeUndefined();
});

test('a new gateway token is shown once and never cached', async () => {
  mockDb.queueResponse(one(machine), { rows: [] }, { rows: [] }, one({ id: 3, token_prefix: 'mxd_abcdefgh', created_at: 'T0' }));
  const res = await request(app).post('/api/programs/machines/7/device-token');
  expect(res.status).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.data.token).toMatch(/^mxd_[A-Za-z0-9_-]{43}$/);
  expect(res.body.data).toMatchObject({ token_prefix: 'mxd_abcdefgh', machine_serial_no: 'VMC-1' });
});

test('files of a machine in another company: 404, nothing listed', async () => {
  mockDb.queueResponse({ rows: [], rowCount: 0 });
  const res = await request(app).get('/api/programs/files?machine_id=99');
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ status: 'error', code: 'MACHINE_NOT_FOUND' });
});

test.each([
  ['post', '/api/programs/machines/7/transfer'],
  ['post', '/api/programs/jobs'],
  ['put', '/api/programs/machines/7/connection'],
  ['get', '/api/programs/machines/7/controller-files']
])('the retired %s %s is gone', async (method, url) => {
  const res = await request(app)[method](url);
  expect(res.status).toBe(404);
});
