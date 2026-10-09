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
