jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
let mockUser;
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  if (!mockUser) return res.status(401).json({ message: 'Unauthorized' });
  req.user = mockUser;
  next();
});

const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const app = express();
app.use(express.json());
app.use('/api/downtime', require('../../src/downtime/downtime.routes'));
app.use(require('../../src/middleware/error.middleware'));
const GRANTS = ['page:downtime:view', 'page:downtime:create', 'page:downtime:edit', 'page:downtime:delete'];
const input = { code: '4', name: 'Tea break', category: 'PLANNED', is_active: true };

beforeEach(async () => {
  resetDb();
  mockUser = { id: 7, company_id: 4, plant_id: null, roles: ['SUPERVISOR'], permissions: GRANTS };
  await require('../../src/redis').set('company_grants:4', JSON.stringify(GRANTS), 'EX', 60);
});

test('DELETE requires sign-in, an explicit role Delete action and its company grant', async () => {
  mockUser = null;
  expect((await request(app).delete('/api/downtime/reasons/25')).status).toBe(401);
  mockUser = { id: 7, company_id: 4, plant_id: null, roles: ['SUPERVISOR'], permissions: ['page:downtime:edit'] };
  expect((await request(app).delete('/api/downtime/reasons/25')).status).toBe(403);
  mockUser.permissions = GRANTS;
  await require('../../src/redis').set('company_grants:4', JSON.stringify(['page:downtime:view', 'page:downtime:edit']), 'EX', 60);
  expect((await request(app).delete('/api/downtime/reasons/25')).status).toBe(403);
  expect(mockDb.calls()).toHaveLength(0);
});

test('authorized deletion keeps the history and never trusts a body company id', async () => {
  mockDb.queueResponse({ rows: [{ id: 25, company_id: 4, code: '4', name: 'TEA', is_active: false }], rowCount: 1 });
  const result = await request(app).delete('/api/downtime/reasons/25').send({ company_id: 99 });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ success: true, data: { id: 25, is_active: false } });
  expect(mockDb.calls()[0].params).toEqual([25, 4]);
  expect(mockDb.calls()[0].text).not.toMatch(/DELETE FROM|downtime_events/);
});

test('built-in and foreign ids remain not found, even with Delete permission', async () => {
  const result = await request(app).delete('/api/downtime/reasons/1');
  expect(result.status).toBe(404);
  expect(result.body.message).toBe('Reason not found');
  expect(mockDb.calls()[0].text).toMatch(/company_id=\$2/);
});

test('an editor can update their reason, but cannot deactivate it through PUT without Delete', async () => {
  mockUser.permissions = ['page:downtime:edit'];
  mockDb.queueResponse({ rows: [{ id: 25, company_id: 4, ...input }], rowCount: 1 });
  const edited = await request(app).put('/api/downtime/reasons/25').send({ ...input, company_id: 99 });
  expect(edited.status).toBe(200);
  expect(mockDb.calls()[0].params.slice(-2)).toEqual([25, 4]);
  resetDb();
  const removed = await request(app).put('/api/downtime/reasons/25').send({ ...input, is_active: false });
  expect(removed.status).toBe(403);
  expect(mockDb.calls()).toHaveLength(0);
});

test('invalid edits return 400 and duplicate codes return 409 without SQL details', async () => {
  const invalid = await request(app).put('/api/downtime/reasons/25').send({ ...input, code: '' });
  expect(invalid.status).toBe(400);
  expect(mockDb.calls()).toHaveLength(0);
  mockDb.queueError(Object.assign(new Error('secret duplicate SQL details'), { code: '23505' }));
  const duplicate = await request(app).put('/api/downtime/reasons/25').send(input);
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.message).toBe('Reason code 4 already exists');
});

test('logging an event with an inactive reason fails even if its id is owned', async () => {
  const result = await request(app).post('/api/downtime/events').send({ machine_id: 81, downtime_reason_id: 25,
    started_at: '2026-11-25T04:00:00Z', ended_at: '2026-11-25T04:01:00Z' });
  expect(result.status).toBe(404);
  expect(result.body.message).toBe('Active downtime reason not found');
  expect(mockDb.calls()[0].text).toMatch(/id=\$4 AND is_active = TRUE/);
});

test('Downtime Delete is available in the permission catalogue for explicit assignment', () => {
  expect(require('../../src/plans/plan.service').APP_MODULES.find(module => module.key === 'downtime').actions)
    .toEqual(['view', 'create', 'edit', 'delete']);
});
