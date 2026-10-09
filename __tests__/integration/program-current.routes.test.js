/* Direct publication HTTP contract. All DB calls are mocked; files are temporary. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-current-'));
process.env.PROGRAM_TRANSFER_DIR = path.join(TMP, 'ProgramTransfer');

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
const none = { rows: [], rowCount: 0 };
const machine = { id: 7, company_id: 5, machine_serial_no: 'VMC-1', program_path: null };

beforeEach(() => {
  resetDb();
  mockUser = { id: 2, company_id: 5, permissions: ['page:programs:view', 'page:programs:upload', 'page:programs:transfer'] };
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('upload publishes directly as multipart, without send=true, a device token or a program path', async () => {
  mockDb.queueResponse(one(machine), none,
    one({ id: '101', machine_id: 7, program_name: 'O1001.nc', kind: 'NEW' }), none, none);
  const res = await request(app).post('/api/programs/machines/7/current-program')
    .field('note', 'Revision B').attach('file', Buffer.from('%\nO1001\nM30\n%'), 'O1001.nc');
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ status: 'success', data: { file: { id: '101', program_name: 'O1001.nc', is_current: true } } });
  expect(res.body.data).not.toHaveProperty('job');
  expect(mockDb.calls().some(call => /program_jobs/.test(call.text))).toBe(false);
  expect(mockDb.calls().find(call => /INSERT INTO program_current/.test(call.text)).params).toEqual([5, 7, '101']);
});

test.each(['page:programs:upload', 'page:programs:transfer'])('publication requires both permissions, not just %s', async permission => {
  mockUser.permissions = [permission];
  const res = await request(app).post('/api/programs/machines/7/current-program').attach('file', Buffer.from('M30'), 'O1.nc');
  expect(res.status).toBe(403);
  expect(mockDb.calls()).toHaveLength(0);
});

test('current metadata returns the nested file:null contract with no caching', async () => {
  mockDb.queueResponse(one(machine), none);
  const res = await request(app).get('/api/programs/machines/7/current-program');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'success', data: { file: null } });
  expect(res.headers['cache-control']).toBe('no-store');
});

test('another company machine cannot be published to or inspected', async () => {
  const upload = await request(app).post('/api/programs/machines/99/current-program').attach('file', Buffer.from('M30'), 'O1.nc');
  expect(upload.status).toBe(404);
  const read = await request(app).get('/api/programs/machines/99/current-program');
  expect(read.status).toBe(404);
  expect(mockDb.calls()).toHaveLength(2);
  for (const call of mockDb.calls()) expect(call.params).toEqual([99, 5]);
});

test('the multipart file is required, and anonymous publication is refused', async () => {
  let res = await request(app).post('/api/programs/machines/7/current-program').send({});
  expect([res.status, res.body.code]).toEqual([400, 'NO_FILE']);
  mockUser = null;
  res = await request(app).post('/api/programs/machines/7/current-program').attach('file', Buffer.from('M30'), 'O1.nc');
  expect(res.status).toBe(401);
  expect(mockDb.calls()).toHaveLength(0);
});
