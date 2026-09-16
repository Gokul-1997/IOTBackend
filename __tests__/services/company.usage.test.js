/*
 * Usage against a company's plan limits — the figure that decides whether
 * the next "create user / plant / machine" call will be refused.
 *
 * Two things make this worth pinning:
 *
 *   - It must resolve limits exactly as quota.middleware does: the
 *     company_plans override first, the plan's ceiling second, and an
 *     expired or inactive assignment granting nothing. A screen that
 *     disagrees with the quota check is worse than no screen.
 *   - A limit of 0 or null means unlimited there ("if (!limit || limit <= 0)
 *     return next()"). Reported as a percentage of zero it would show every
 *     company as instantly over its limit.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc  = require('../../src/companies/company.service');
const ctrl = require('../../src/companies/company.controller');

const row = (over = {}) => ({
  id: 4, company_name: 'S AND T', plan_id: 3, plan_name: 'Gold',
  expires_at: null, plan_active: true,
  max_users: 10, max_plants: 2, max_machines: 20,
  users_used: 3, plants_used: 1, machines_used: 5, ...over
});

beforeEach(() => resetDb());

describe('usage figures', () => {
  test('reports used, limit and percentage for each resource', async () => {
    mockDb.queueResponse({ rows: [row()] });
    const u = await svc.getUsage(4);

    expect(u.users_used).toBe(3);
    expect(u.users_pct).toBe(30);
    expect(u.plants_pct).toBe(50);
    expect(u.machines_pct).toBe(25);
  });

  test('an unlimited resource has no percentage, rather than 0%', async () => {
    // quota.middleware treats 0 or null as unlimited; a percentage of zero
    // would paint an unlimited company as permanently over its limit
    mockDb.queueResponse({ rows: [row({ max_users: 0, max_plants: null })] });
    const u = await svc.getUsage(4);

    expect(u.users_pct).toBeNull();
    expect(u.plants_pct).toBeNull();
    expect(u.machines_pct).toBe(25);
  });

  test('over the limit is capped at 100, not 150', async () => {
    mockDb.queueResponse({ rows: [row({ max_machines: 4, machines_used: 6 })] });
    expect((await svc.getUsage(4)).machines_pct).toBe(100);
  });

  test('at exactly the limit reads 100', async () => {
    mockDb.queueResponse({ rows: [row({ max_plants: 1, plants_used: 1 })] });
    expect((await svc.getUsage(4)).plants_pct).toBe(100);
  });

  test('nothing used yet is 0, which is a real answer', async () => {
    mockDb.queueResponse({ rows: [row({ users_used: 0 })] });
    expect((await svc.getUsage(4)).users_pct).toBe(0);
  });

  test('an unknown company is a 404, not empty figures', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(svc.getUsage(99999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the limits come from the same rule the quota check uses', () => {
  test('override first, plan ceiling second, expiry respected', async () => {
    mockDb.queueResponse({ rows: [row()] });
    await svc.getUsage(4);
    const sql = mockDb.calls()[0].text;

    expect(sql).toMatch(/COALESCE\(cp\.max_users,\s*p\.max_users\)/);
    expect(sql).toMatch(/COALESCE\(cp\.max_plants,\s*p\.max_plants\)/);
    expect(sql).toMatch(/COALESCE\(cp\.max_machines,\s*p\.max_machines\)/);
    // an assignment that lapsed grants nothing
    expect(sql).toMatch(/cp\.expires_at IS NULL OR cp\.expires_at > NOW\(\)/);
    expect(sql).toMatch(/cp\.is_active/);
  });

  test('counts only active rows, as the quota check counts them', async () => {
    mockDb.queueResponse({ rows: [row()] });
    await svc.getUsage(4);
    const sql = mockDb.calls()[0].text;

    expect(sql).toMatch(/FROM users\s+u\s+WHERE u\.company_id = c\.id AND u\.is_active/);
    expect(sql).toMatch(/FROM plants\s+pl WHERE pl\.company_id = c\.id AND pl\.is_active/);
    expect(sql).toMatch(/FROM machines m\s+WHERE m\.company_id = c\.id AND m\.is_active/);
  });

  test('binds exactly the parameters it references', async () => {
    mockDb.queueResponse({ rows: [row()] });
    await svc.getUsage(4);
    const { text, params } = mockDb.calls()[0];
    const highest = Math.max(...[...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    expect(params.length).toBe(highest);
    expect(params[0]).toBe(4);
  });

  test('an expired plan is reported as inactive, so the screen can say why creates fail', async () => {
    mockDb.queueResponse({ rows: [row({ plan_active: false, expires_at: '2026-09-09T14:12:34.175Z' })] });
    const u = await svc.getUsage(4);
    expect(u.plan_active).toBe(false);
    expect(u.expires_at).toBeTruthy();
  });
});

describe('who may read another company\'s usage', () => {
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = jest.fn(code => { r.statusCode = code; return r; });
    r.json   = jest.fn(b => { r.body = b; return r; });
    return r;
  };

  test('a company admin reading their own company is allowed', async () => {
    mockDb.queueResponse({ rows: [row()] });
    const r = res();
    await ctrl.getUsage({ params: { id: '4' }, user: { company_id: 4, is_snt_super: false } }, r, jest.fn());
    expect(r.statusCode).toBe(200);
    expect(r.body.company_name).toBe('S AND T');
  });

  test('a company admin reading a different company is refused', async () => {
    // without this the id in the URL is enough to read another tenant's
    // headcount and machine estate
    const r = res();
    const next = jest.fn();
    await ctrl.getUsage({ params: { id: '9' }, user: { company_id: 4, is_snt_super: false } }, r, next);

    expect(r.statusCode).toBe(403);
    expect(mockDb.calls()).toHaveLength(0);   // never reached the database
    expect(next).not.toHaveBeenCalled();
  });

  test('a super admin may read any company', async () => {
    mockDb.queueResponse({ rows: [row({ id: 9, company_name: 'Apex Turbine Components' })] });
    const r = res();
    await ctrl.getUsage({ params: { id: '9' }, user: { company_id: null, is_snt_super: true } }, r, jest.fn());
    expect(r.statusCode).toBe(200);
    expect(r.body.company_name).toBe('Apex Turbine Components');
  });

  test('a database failure goes to the error handler, not a half-rendered reply', async () => {
    mockDb.queueError(new Error('connection reset'));
    const r = res();
    const next = jest.fn();
    await ctrl.getUsage({ params: { id: '4' }, user: { is_snt_super: true } }, r, next);
    expect(next).toHaveBeenCalled();
  });
});
