/*
 * /api/dashboard/energy/bill and /connections over HTTP: who may read and
 * change what, that every change is audited and shows in the forecast at
 * once, that the company shares one forecast, and that a fault answers in
 * plain words.
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

const VIEW = 'page:analytics-energy:view', SETTINGS = 'page:analytics-energy:settings';
const reads = () => mockDb.calls().filter(c => /FROM energy_connections c/.test(c.text)).length;
const owned = { rows: [{ id: 1 }] };

beforeEach(async () => {
  resetDb();
  mockChecked.length = 0;
  audit.log.mockClear();
  await redis.flushall();
});

test('the forecast and the bills are for whoever sees the Energy screen; the forecast is shared by the company', async () => {
  const a = app();
  const first = await request(a).get('/api/dashboard/energy/bill');
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ status: 'success', data: { configured: false, connections: [] } });
  expect(mockChecked).toContain(VIEW);

  const worked = reads();
  expect((await request(a).get('/api/dashboard/energy/bill')).text).toBe(first.text);
  expect(reads()).toBe(worked);

  expect((await request(a).get('/api/dashboard/energy/connections')).status).toBe(200);
  expect((await request(a).get('/api/dashboard/energy/bill').set('x-deny', VIEW)).status).toBe(403);
  expect((await request(a).get('/api/dashboard/energy/connections').set('x-deny', VIEW)).status).toBe(403);
});

test('connections, bills and readings are changed by whoever may set the tariff — each audited, the forecast following at once', async () => {
  const a = app();
  await request(a).get('/api/dashboard/energy/bill');
  const before = reads();

  mockDb.queueResponse({ rows: [{ id: 1 }] });
  const added = await request(a).post('/api/dashboard/energy/connections').send({ sc_number: '1212' });
  expect(added.status).toBe(200);
  expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'CREATE_ENERGY_CONNECTION', company_id: 4, user_id: 9 }));

  await request(a).get('/api/dashboard/energy/bill');
  expect(reads()).toBe(before + 1);                         // worked out again, not the cached answer

  mockDb.queueResponse(owned, { rows: [] }, { rows: [{ id: 11, connection_id: 1, from: '2026-07-26', to: '2026-08-26', units: '55952',
    rate: '8.13', electricity_charges: '455093', peak_charges: '0', fixed_charges: '91200', penalty_charges: '16372',
    welding_charges: '68264', tax_charges: '29512', other_charges: '0', net_amount: '660441' }] });
  const bill = await request(a).post('/api/dashboard/energy/connections/1/bills').send({
    from: '2026-07-26', to: '2026-08-26', units: 55952, rate: 8.13, electricity_charges: 455093, fixed_charges: 91200,
    penalty_charges: 16372, welding_charges: 68264, tax_charges: 29512, net_amount: 660441 });
  expect(bill.status).toBe(200);
  expect(bill.body.data.checks).toEqual({ rate_difference: 203.24, net_difference: 0 });
  expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'CREATE_ENERGY_BILL' }));

  mockDb.queueResponse(owned, { rows: [] }, { rows: [{ id: 5, read_on: '2026-10-21', kwh: '144600' }] });
  const reading = await request(a).post('/api/dashboard/energy/connections/1/readings').send({ read_on: '2026-10-21', kwh: 144600 });
  expect(reading.status).toBe(200);
  expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'CREATE_ENERGY_READING' }));

  for (const [method, path] of [['post', '/connections'], ['put', '/connections/1'], ['delete', '/connections/1'],
                                ['post', '/connections/1/bills'], ['put', '/connections/1/bills/11'], ['delete', '/connections/1/bills/11'],
                                ['post', '/connections/1/readings'], ['delete', '/connections/1/readings/5']]) {
    const r = await request(a)[method](`/api/dashboard/energy${path}`).set('x-deny', SETTINGS).send({});
    expect([method, path, r.status]).toEqual([method, path, 403]);
  }
});

test('a mistake is said plainly (400) and not audited; a fault says nothing of the inside (500)', async () => {
  const a = app();
  mockDb.queueResponse(owned);
  const bad = await request(a).post('/api/dashboard/energy/connections/1/bills').send({ from: '2026-08-26', to: '2026-08-26', units: 1 });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toBe('The To date must be after the From date');
  expect(audit.log).not.toHaveBeenCalled();

  mockDb.queueError(new Error('relation "energy_connections" does not exist'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const fault = await request(a).get('/api/dashboard/energy/connections');
  spy.mockRestore();
  expect(fault.status).toBe(500);
  expect(fault.body.message).toBe('Could not load the electricity bills just now. Try again in a moment.');
});
