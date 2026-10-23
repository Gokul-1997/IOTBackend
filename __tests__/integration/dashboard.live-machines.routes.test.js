/*
 * GET /api/dashboard/live — the machine page's switcher (23 Oct 2026, the
 * user: to see the next machine they went back to the Live Dashboard each
 * time). Every machine by name with its status now, in the Live Dashboard's
 * order; on the machine page's own permission, for the caller's company and
 * plant only, and nothing of the shift is worked out for it.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/middleware/auth.middleware', () => (req, _res, next) => {
  const plant = req.headers['x-plant'];
  req.user = {
    id: 1,
    company_id: req.headers['x-company'] === 'none' ? null : Number(req.headers['x-company'] || 4),
    plant_id: plant ? Number(plant) : null,
    roles: [req.headers['x-role'] || 'COMPANY_ADMIN'],
    permissions: []
  };
  next();
});
/* the guard lets through only the permissions the test says the person holds */
jest.mock('../../src/middleware/access.middleware', () => key => {
  const guard = (req, res, next) => String(req.headers['x-perms'] ?? 'page:dashboard:live:view').split(',').includes(key)
    ? next() : res.status(403).json({ status: 'error', message: 'Access denied' });
  guard.requiredPermission = key;
  return guard;
});

const { mockDb, resetDb } = require('../helpers/mockDb');

function app() {
  const a = express();
  a.use('/api/dashboard', require('../../src/dashboard/dashboard.routes'));
  return a;
}

const ROWS = [
  { machine_id: 21, machine_serial_no: 'VMC - 1 - F', status: 'RUNNING', alarm: false },
  { machine_id: 25, machine_serial_no: 'HMC - 7 - F', status: 'IDLE', alarm: true },
  { machine_id: 31, machine_serial_no: 'Lathe 3', status: 'OFFLINE', alarm: false }
];

beforeEach(resetDb);

test('every machine of the company by name, with its status now, in the Live Dashboard order', async () => {
  mockDb.queueResponse({ rows: ROWS });
  const res = await request(app()).get('/api/dashboard/live');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'success', data: ROWS });

  expect(mockDb.calls()).toHaveLength(1);                      // nothing of the shift: one light query
  const [q] = mockDb.calls();
  expect(q.params).toEqual([4]);
  expect(q.text).toMatch(/m\.company_id = \$1 AND m\.is_active = true/);
  expect(q.text).toMatch(/ORDER BY id\s*$/);                   // the Live Dashboard's order
  expect(q.text).toMatch(/INTERVAL '60 seconds' THEN 'OFFLINE'/); // the Live Dashboard's status rule
  expect(q.text).not.toMatch(/production_hourly|operator|job/i);
});

test('it is the machine page\'s permission — the Live Dashboard list alone is not enough', async () => {
  const router = require('../../src/dashboard/dashboard.routes');
  const route = router.stack.find(l => l.route?.path === '/live' && l.route.methods.get);
  expect(route.route.stack.find(s => s.handle.requiredPermission).handle.requiredPermission).toBe('page:dashboard:live:view');

  const res = await request(app()).get('/api/dashboard/live').set('x-perms', 'page:dashboard:view');
  expect(res.status).toBe(403);
  expect(mockDb.calls()).toHaveLength(0);
});

test('someone kept to one plant gets that plant\'s machines; the company admin gets all', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [] });
  await request(app()).get('/api/dashboard/live').set('x-role', 'OPERATOR').set('x-plant', '3');
  await request(app()).get('/api/dashboard/live').set('x-plant', '3');
  const [plantUser, admin] = mockDb.calls();
  expect(plantUser.text).toMatch(/authorized_machine\.company_id = 4 AND authorized_machine\.plant_id = 3/);
  expect(admin.text).not.toMatch(/authorized_machine/);
});

test('an account without a company is refused before any query', async () => {
  const res = await request(app()).get('/api/dashboard/live').set('x-company', 'none');
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ status: 'error', message: 'No company assigned' });
  expect(mockDb.calls()).toHaveLength(0);
});

test('a database failure is a plain 500 that tells nothing of the query', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockDb.queueError(new Error('relation "telemetry_raw" does not exist'));
  const res = await request(app()).get('/api/dashboard/live');
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ status: 'error', message: 'Failed to load the machines' });
  spy.mockRestore();
});

test('/live/:machine_id still opens one machine', async () => {
  mockDb.queueResponse({ rows: [] });
  const res = await request(app()).get('/api/dashboard/live/25');
  expect(res.status).toBe(404);
  expect(mockDb.calls()[0].params).toEqual([25, 4]);
});
