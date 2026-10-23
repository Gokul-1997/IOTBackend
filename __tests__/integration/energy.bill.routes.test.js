/*
 * /api/dashboard/energy/bill and /bill-period over HTTP: who may read and
 * change what, that a change is audited and shows at once, that everyone in
 * the company shares one forecast, and that a fault answers in plain words.
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
  req.user = { id: 9, company_id: 4, roles: ['COMPANY_ADMIN'], permissions: [] };
  next();
});
const mockChecked = [];
jest.mock('../../src/middleware/access.middleware', () => (...keys) => (req, res, next) => {
  mockChecked.push(...keys);
  const denied = String(req.headers['x-deny'] || '').split(',');
  if (keys.some(k => denied.includes(k))) return res.status(403).json({ status: 'error', message: 'Access denied' });
  return next();
});
jest.mock('../../src/audit/audit.service', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/dashboard/energy-hourly.service', () => ({
  ...jest.requireActual('../../src/dashboard/energy-hourly.service'),
  hours: jest.fn(async (_c, from) => ({ rows: [], completeFrom: from })),
  kick: jest.fn()
}));

const { mockDb, resetDb } = require('../helpers/mockDb');
const redis = require('../../src/redis');
const audit = require('../../src/audit/audit.service');
const cache = require('../../src/dashboard/cache');

function app() {
  const a = express();
  a.use(express.json());
  a.use(cache.invalidateOnWrite);
  a.use('/api/dashboard', require('../../src/dashboard/dashboard.routes'));
  return a;
}

const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plus = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const reads = () => mockDb.calls().filter(c => /FROM energy_billing/.test(c.text)).length;

beforeEach(async () => {
  resetDb();
  mockChecked.length = 0;
  audit.log.mockClear();
  await redis.flushall();
});

test('the forecast is for whoever sees the Energy screen, and shared by the company', async () => {
  const a = app();
  const first = await request(a).get('/api/dashboard/energy/bill');
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ status: 'success', data: { configured: false } });
  expect(mockChecked).toContain('page:analytics-energy:view');

  const worked = reads();
  const second = await request(a).get('/api/dashboard/energy/bill');
  expect(second.text).toBe(first.text);
  expect(reads()).toBe(worked);

  expect((await request(a).get('/api/dashboard/energy/bill').set('x-deny', 'page:analytics-energy:view')).status).toBe(403);
});

test('the dates are changed by whoever may set the tariff — audited, and the forecast follows at once', async () => {
  const a = app();
  await request(a).get('/api/dashboard/energy/bill');
  const before = reads();

  const body = { period_start: today, period_end: plus(today, 29) };
  mockDb.queueResponse({ rows: [] }, { rows: [{ start: body.period_start, end: body.period_end, updated_at: null }] });
  const saved = await request(a).put('/api/dashboard/energy/bill-period').send(body);
  expect(saved.status).toBe(200);
  expect(saved.body.data).toMatchObject({ configured: true, current: { start: today } });
  expect(mockChecked).toContain('page:analytics-energy:settings');
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE_ENERGY_BILL_PERIOD', company_id: 4, user_id: 9 }));

  await request(a).get('/api/dashboard/energy/bill');
  expect(reads()).toBeGreaterThan(before + 1);                // worked out again, not the cached answer

  const denied = await request(a).put('/api/dashboard/energy/bill-period')
    .set('x-deny', 'page:analytics-energy:settings').send(body);
  expect(denied.status).toBe(403);
  expect((await request(a).delete('/api/dashboard/energy/bill-period').set('x-deny', 'page:analytics-energy:settings')).status).toBe(403);

  const removed = await request(a).delete('/api/dashboard/energy/bill-period');
  expect(removed.status).toBe(200);
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE_ENERGY_BILL_PERIOD' }));
});

test('a mistake is said plainly (400); a fault says nothing of the inside (500)', async () => {
  const a = app();
  const bad = await request(a).put('/api/dashboard/energy/bill-period').send({ period_start: today, period_end: today });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/at least 7 days/);
  expect(audit.log).not.toHaveBeenCalled();

  mockDb.queueError(new Error('relation "energy_billing" does not exist'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const fault = await request(a).get('/api/dashboard/energy/bill-period');
  spy.mockRestore();
  expect(fault.status).toBe(500);
  expect(fault.body.message).toBe('Could not load the bill dates just now. Try again in a moment.');
});
