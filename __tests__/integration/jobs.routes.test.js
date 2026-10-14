jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { buildApp, fakeUser } = require('../helpers/testApp');
beforeEach(() => resetDb());
function app(user = fakeUser({ plant_id: null }), grants = [], productionErrors = false) {
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () => (req, res, next) => {
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    req.user = user; next();
  });
  jest.doMock('../../src/redis', () => ({ get: jest.fn(async () => JSON.stringify(grants)), set: jest.fn() }));
  jest.doMock('../../src/db', () => mockDb);
  const router = require('../../src/job/job.routes');
  if (!productionErrors) return buildApp({ mountPath: '/api/jobs', router });
  const express = require('express');
  const instance = express();
  instance.use(express.json());
  instance.use('/api/jobs', router);
  instance.use(require('../../src/middleware/error.middleware'));
  return instance;
}
const body = { machine_id: 7, component_id: 3, job_start: '2026-10-13T08:00:00+05:30' };
const response = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
const machine = { id: 7, plant_id: 8 };
const writes = () => mockDb.calls().filter(c => /^\s*(INSERT|UPDATE)\b/.test(c.text));
function startFixture(existing = [], component = [{ part_name: 'Part A', target: 50, cycle_time_seconds: 60 }]) {
  mockDb.queueResponse(response(), response([machine]), response(existing), response(component), response([{ id: 9 }]), response());
}

describe('job authorization', () => {
  test.each(['start', 'stop'])('unauthenticated %s is refused', async action => {
    expect((await request(app(null)).post(`/api/jobs/${action}`).send(body)).status).toBe(401);
  });
  test('a role with view alone cannot start or stop jobs', async () => {
    const user = fakeUser({ roles: ['Line viewer'], permissions: ['page:job:view'] });
    for (const action of ['start', 'stop']) expect((await request(app(user)).post(`/api/jobs/${action}`).send(body)).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });
  test('role and company must grant the same action', async () => {
    const user = fakeUser({ roles: ['Line setter'], permissions: ['page:job:create'] });
    expect((await request(app(user, ['page:job:view'])).post('/api/jobs/start').send(body)).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });
});

describe('start job', () => {
  test.each(['machine_id', 'component_id', 'job_start'])('%s is required', async key => {
    const missing = { ...body }; delete missing[key];
    expect((await request(app()).post('/api/jobs/start').send(missing)).status).toBe(400);
  });
  test('an invalid date is refused before a connection is acquired', async () => {
    expect((await request(app()).post('/api/jobs/start').send({ ...body, job_start: 'wrong' })).status).toBe(400);
    expect(mockDb.connect).not.toHaveBeenCalled();
  });
  test('foreign or unavailable machine is refused before component lookup or insertion', async () => {
    mockDb.queueResponse(response(), response());
    expect((await request(app()).post('/api/jobs/start').send(body)).status).toBe(404);
    expect(writes()).toHaveLength(0);
    expect(mockDb.calls()[1].params).toEqual([7, 4, null]);
    expect(mockDb.calls()[1].text).toMatch(/company_id = \$2/);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
  test('plant-bound caller cannot operate another or unassigned plant machine', async () => {
    mockDb.queueResponse(response(), response());
    expect((await request(app(fakeUser({ plant_id: 8 }))).post('/api/jobs/start').send(body)).status).toBe(404);
    expect(mockDb.calls()[1].text).toMatch(/plant_id = \$3/);
    expect(mockDb.calls()[1].params).toEqual([7, 4, 8]);
  });
  test('an already active job is a conflict and rolls back', async () => {
    startFixture([{ id: 1, part_name: 'Old part' }]);
    expect((await request(app()).post('/api/jobs/start').send(body)).status).toBe(409);
    expect(writes()).toHaveLength(0);
  });
  test('component lookup is bound to both selected machine and company', async () => {
    startFixture([], []);
    expect((await request(app()).post('/api/jobs/start').send(body)).status).toBe(404);
    expect(mockDb.calls()[3].params).toEqual([3, 7, 4]);
    expect(mockDb.calls()[3].text).toMatch(/company_id = \$3/);
    expect(writes()).toHaveLength(0);
  });
  test('success locks the machine then stores tenant, plant and cycle snapshot in one transaction', async () => {
    startFixture();
    const res = await request(app()).post('/api/jobs/start').send({ ...body, company_id: 99 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 9 });
    expect(mockDb.calls()[1].text).toMatch(/FOR UPDATE/);
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
    expect(writes()[0].params).toEqual([8, 4, 7, 3, 'Part A', 50, new Date(body.job_start), 60]);
  });
  test('unexpected database errors pass through the safe production error handler', async () => {
    const failure = new Error('column secret_account_token does not exist');
    failure.code = '42703';
    mockDb.queueResponse(response());
    mockDb.queueError(failure);
    const res = await request(app(fakeUser({ plant_id: null }), [], true)).post('/api/jobs/start').send(body);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ status: 'error', message: 'Something went wrong on the server. Please try again.', ref: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/secret_account_token|42703/);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
});

describe('stop job', () => {
  test('no active job is a conflict', async () => {
    mockDb.queueResponse(response(), response([machine]), response());
    expect((await request(app()).post('/api/jobs/stop').send({ machine_id: 7 })).status).toBe(409);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
  test('update itself has the company predicate under the same machine lock', async () => {
    mockDb.queueResponse(response(), response([machine]), response([{ id: 9 }]), response());
    expect((await request(app()).post('/api/jobs/stop').send({ machine_id: 7 })).status).toBe(200);
    expect(mockDb.calls()[1].text).toMatch(/FOR UPDATE/);
    expect(writes()[0].params).toEqual([7, 4]);
    expect(writes()[0].text).toMatch(/company_id = \$2/);
  });
});

describe('job reads', () => {
  test.each(['/available-machines', '/current', '/history'])('%s needs authentication', async path => {
    expect((await request(app(null)).get(`/api/jobs${path}`)).status).toBe(401);
  });
  test('bounded history carries page state and stable ordering', async () => {
    mockDb.queueResponse(response([{ job_id: 9 }]), response([{ total: 37 }]));
    const res = await request(app()).get('/api/jobs/history?page=2&limit=10');
    expect(res.body).toMatchObject({ data: [{ job_id: 9 }], total: 37, page: 2, limit: 10, totalPages: 4 });
    expect(mockDb.calls()[0].params).toEqual([4, 10, 10]);
    expect(mockDb.calls()[0].text).toMatch(/ORDER BY j.started_at DESC, j.id DESC/);
  });
  test('plant scope applies to both history data and count', async () => {
    mockDb.queueResponse(response(), response([{ total: 0 }]));
    await request(app(fakeUser({ plant_id: 8 }))).get('/api/jobs/history');
    for (const call of mockDb.calls()) expect(call.text).toMatch(/m.plant_id = \$2/);
    expect(mockDb.calls()[0].params).toEqual([4, 8, 20, 0]);
  });
});
