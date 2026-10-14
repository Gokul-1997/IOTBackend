jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { buildApp, fakeUser } = require('../helpers/testApp');
const response = rows => ({ rows, rowCount: rows.length });
const plantUser = () => fakeUser({ plant_id: 8, roles: ['Maintenance'], permissions: [
  'page:maintenance:view', 'page:maintenance:create', 'page:maintenance:edit', 'page:maintenance:delete',
  'page:downtime:view', 'page:downtime:create'
] });
function app(folder, stem, user = plantUser()) {
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () => (req, _res, next) => { req.user = user; next(); });
  jest.doMock('../../src/redis', () => ({ get: jest.fn(async () => '[]'), set: jest.fn() }));
  jest.doMock('../../src/db', () => mockDb);
  return buildApp({ mountPath: `/api/${folder}`, router: require(`../../src/${folder}/${stem}.routes`) });
}
beforeEach(() => resetDb());

test.each([
  ['maintenance', 'maintenance', '/schedules', { machine_id: 10, title: 'Foreign', scheduled_at: '2026-10-14' }],
  ['tickets', 'ticket', '/', { machine_id: 10, title: 'Foreign' }],
  ['downtime', 'downtime', '/events', { machine_id: 10, started_at: '2026-10-13' }]
])('a plant user cannot create %s work on another plant machine', async (folder, stem, route, body) => {
  mockDb.queueResponse(response([{ k: 0, allowed: false }]));
  const res = await request(app(folder, stem)).post(`/api/${folder}${route}`).send(body);
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('Record not found in your plant');
  expect(mockDb.calls()).toHaveLength(1);
  expect(mockDb.calls()[0].params).toEqual([4, 8, 10]);
});

test.each([
  ['maintenance', 'maintenance', '/schedules/12', 'put'],
  ['maintenance', 'maintenance', '/schedules/12', 'delete'],
  ['tickets', 'ticket', '/12', 'get'],
  ['tickets', 'ticket', '/12', 'put'],
  ['tickets', 'ticket', '/12/status', 'patch']
])('the actual %s record must be in the user plant for %s', async (folder, stem, route, method) => {
  mockDb.queueResponse(response([{ k: 0, allowed: false }]));
  const res = await request(app(folder, stem))[method](`/api/${folder}${route}`).send({ status: 'RESOLVED', title: 'Changed' });
  expect(res.status).toBe(404);
  expect(mockDb.calls()).toHaveLength(1);
});

test('assigning an own ticket to a technician in another plant is refused', async () => {
  mockDb.queueResponse(response([{ k: 0, allowed: true }, { k: 1, allowed: false }]));
  const res = await request(app('tickets', 'ticket')).patch('/api/tickets/12/assign').send({ assigned_to: 2 });
  expect(res.status).toBe(404);
  expect(mockDb.calls()[0].params).toEqual([4, 8, 12, 2]);
  expect(mockDb.calls()).toHaveLength(1);
});

test('a client-supplied plant cannot widen schedules and their total', async () => {
  mockDb.queueResponse(response([{ count: '1' }]), response([{ id: 1, machine_id: 7, title: 'Own plant' }]));
  const res = await request(app('maintenance', 'maintenance')).get('/api/maintenance/schedules?plant_id=10');
  expect(res.status).toBe(200);
  expect(res.body.pagination.total).toBe(1);
  expect(res.body.data).toEqual([{ id: 1, machine_id: 7, title: 'Own plant' }]);
  expect(mockDb.calls()[0].params).toEqual([4, 8]);
  expect(mockDb.calls()[1].params).toEqual([4, 8, 20, 0]);
});

test('a company admin retains company-wide access without extra scope queries', async () => {
  mockDb.queueResponse(response([{ count: '2' }]), response([{ id: 1, machine_id: 7 }, { id: 2, machine_id: 10 }]));
  const res = await request(app('maintenance', 'maintenance', fakeUser({ plant_id: 8, roles: ['COMPANY_ADMIN'] }))).get('/api/maintenance/schedules');
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(2);
  expect(mockDb.calls()).toHaveLength(2);
  expect(mockDb.calls()[0].params).toEqual([4]);
});

test('incomplete ownership check results fail closed before writes', async () => {
  mockDb.queueResponse(response([]));
  const res = await request(app('tickets', 'ticket')).post('/api/tickets').send({ machine_id: 7, title: 'Own ticket' });
  expect(res.status).toBe(404);
  expect(mockDb.calls()).toHaveLength(1);
});
