/*
 * /api/dashboard — the same company asking for the same dashboard and filters
 * is answered once (cache.js): a second person costs the database nothing.
 * A change the company makes through the API, and only that company's,
 * makes the next request work its answer out again.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/redis', () => {
  const r = require('../setup/fake-redis').createFakeRedis();
  r.status = 'ready';
  return r;
});
jest.mock('../../src/middleware/auth.middleware', () => (req, _res, next) => {
  req.user = { id: 1, company_id: Number(req.headers['x-company'] || 4), roles: ['COMPANY_ADMIN'], permissions: [] };
  next();
});
jest.mock('../../src/middleware/access.middleware', () => () => (_req, _res, next) => next());

const { mockDb, resetDb } = require('../helpers/mockDb');
const redis = require('../../src/redis');
const cache = require('../../src/dashboard/cache');

function app() {
  const a = express();
  a.use(express.json());
  a.use(cache.invalidateOnWrite);
  a.use('/api/dashboard', require('../../src/dashboard/dashboard.routes'));
  return a;
}

const alarms = '/api/dashboard/alarms?from=2026-10-03&to=2026-10-09&part=kpis,charts';
const reads = () => mockDb.calls().filter(c => /machine_alarms/.test(c.text)).length;

beforeEach(async () => {
  resetDb();
  await redis.flushall();
});

test('a second person asking for the same dashboard costs the database nothing', async () => {
  const a = app();
  const first = await request(a).get(alarms);
  expect(first.status).toBe(200);
  expect(first.body.status).toBe('success');
  const worked = reads();
  expect(worked).toBeGreaterThan(0);

  const second = await request(a).get(alarms);
  expect(second.status).toBe(200);
  expect(second.text).toBe(first.text);
  expect(reads()).toBe(worked);
});

test('another company, or other filters, are worked out for themselves', async () => {
  const a = app();
  await request(a).get(alarms);
  const worked = reads();

  await request(a).get(alarms).set('x-company', '5');
  expect(reads()).toBeGreaterThan(worked);

  const after = reads();
  await request(a).get(alarms.replace('part=kpis,charts', 'part=table'));
  expect(reads()).toBeGreaterThan(after);
});

test('a change the company saves makes its next request work the answer out again — another company\'s stays', async () => {
  const a = app();
  await request(a).get(alarms);
  await request(a).get(alarms).set('x-company', '5');
  const worked = reads();

  // company 4 saves an alarm rule
  mockDb.queueResponse({ rows: [{ id: 1, alarm_type: 'SPINDLE' }] });
  const saved = await request(a).post('/api/dashboard/preventive/thresholds').send({ alarm_type: 'SPINDLE' });
  expect(saved.status).toBe(200);

  await request(a).get(alarms).set('x-company', '5');
  expect(reads()).toBe(worked);              // company 5: still shared

  await request(a).get(alarms);
  expect(reads()).toBeGreaterThan(worked);   // company 4: worked out again
});

test('a refused request is not kept', async () => {
  const a = app();
  const bad = await request(a).get('/api/dashboard/alarms?part=graphs');
  expect(bad.status).toBe(400);
  const again = await request(a).get('/api/dashboard/alarms?part=graphs');
  expect(again.status).toBe(400);
});

test('meter readers share bounded sparse-channel work only within their company and filters', async () => {
  const a=app();const url='/api/dashboard/energy/meter?range=24h';
  const first=await request(a).get(url);expect(first.status).toBe(200);
  const worked=mockDb.calls().length;expect(worked).toBeGreaterThan(0);
  const second=await request(a).get(url);expect(second.body).toEqual(first.body);
  expect(mockDb.calls()).toHaveLength(worked);
  await request(a).get(url).set('x-company','5');expect(mockDb.calls().length).toBeGreaterThan(worked);
  const foreign=mockDb.calls().length;
  await request(a).get('/api/dashboard/energy/meter?range=4h');expect(mockDb.calls().length).toBeGreaterThan(foreign);
});

/* 27 Nov 2026: the Factory board was worked out afresh for every request, so a
   reload while it was still being worked out started it all again beside the
   first (the browser showed the old request "(canceled)"; the server carried on). */
describe('the Factory dashboard', () => {
  const factory = '/api/dashboard/factory?date=2026-11-27';
  const live = () => mockDb.calls().filter(c => /telemetry_raw/.test(c.text)).length;

  test('a reload while it is being worked out joins that answer instead of starting another', async () => {
    const a = app();
    const [first, reload] = await Promise.all([request(a).get(factory), request(a).get(factory)]);
    expect([first.status, reload.status]).toEqual([200, 200]);
    expect(first.body.status).toBe('success');
    expect(reload.text).toBe(first.text);
    const both = live();
    await request(a).get(factory.replace('2026-11-27', '2026-11-26'));     // one answer worked out, for comparison
    expect(live() - both).toBe(both);
  });

  test('shared for a while; another day, machine or company is its own answer', async () => {
    const a = app();
    await request(a).get(factory);
    const once = live();
    expect(once).toBeGreaterThan(0);
    await request(a).get(factory);
    expect(live()).toBe(once);
    await request(a).get(factory.replace('2026-11-27', '2026-11-26'));
    await request(a).get(`${factory}&machine_id=7`);
    await request(a).get(factory).set('x-company', '5');
    expect(live()).toBe(once * 4);
  });
});

/* 27 Nov 2026, the user: "once ticket create but not showing" — a schedule
   saved with its first occurrence due waited up to 15 minutes for the cron
   to raise its ticket. */
describe('saving a periodic schedule', () => {
  const body = { machine_id: 7, title: 'Way lube', frequency: 'WEEKLY', next_due_at: '2026-11-27', grace_days: 0 };
  const saved = { id: 11, company_id: 4, machine_id: 7, title: 'Way lube', frequency: 'WEEKLY',
    next_due_at: '2026-11-27T00:00:00.000Z', assigned_user_id: null, grace_days: 0 };

  test('an occurrence already due is raised at once, for this schedule only', async () => {
    mockDb.queueResponse(
      { rows: [{}], rowCount: 1 },                                   // the machine is the company's
      { rows: [saved], rowCount: 1 },                                // INSERT schedule
      { rows: [], rowCount: 0 },                                     // BEGIN
      { rows: [{ ...saved, description: null, maintenance_type: 'PREVENTIVE' }] },   // due: this schedule
      { rows: [{ id: 99, status: 'OPEN' }], rowCount: 1 },          // ticket raised
      { rows: [{ next: '2099-01-01T00:00:00.000Z' }] },             // next occurrence
      { rows: [], rowCount: 1 },                                     // schedule advanced
      { rows: [], rowCount: 1 },                                     // status history
      { rows: [], rowCount: 0 }                                      // COMMIT
    );
    const res = await request(app()).post('/api/dashboard/periodic/schedules').send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 11, raised: 1 });
    const due = mockDb.calls().find(c => /FOR UPDATE SKIP LOCKED/.test(c.text));
    expect(due.params).toEqual([4, 11]);
  });

  test('if raising fails, the schedule is still saved (the 15-minute tick raises it)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.queueResponse({ rows: [{}], rowCount: 1 }, { rows: [saved], rowCount: 1 });
    mockDb.queueError(new Error('connection reset'));                 // BEGIN fails
    const res = await request(app()).post('/api/dashboard/periodic/schedules').send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 11, raised: 0 });
    console.error.mockRestore();
  });
});
