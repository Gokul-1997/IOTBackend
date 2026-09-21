/*
 * What S&T can see and do on the Users side.
 *
 * Each company creates and manages its own users; S&T creates the company's
 * admin and nothing else. So S&T's view of users is company admins only —
 * in the list, and in every read or change by id. It used to be every user
 * of every company.
 *
 * A company admin's own view is unchanged: their own company's users.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) }));
const svc = require('../../src/users/user.service');

const snt = { id: 1, is_snt_super: true, company_id: null };
const companyA = { id: 10, is_snt_super: false, company_id: 4 };

const ADMIN_ONLY = /EXISTS \(\s*SELECT 1 FROM user_roles xa JOIN roles xr ON xr\.id = xa\.role_id\s+WHERE xa\.user_id = \w+\.id AND xr\.role_name = 'COMPANY_ADMIN' AND xr\.company_id IS NULL\)/;

beforeEach(() => resetDb());

describe('S&T sees company admins only', () => {
  test('the list is limited to company admins', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, username: 'S AND T', company_id: 4 }] }, { rows: [] });
    await svc.list(snt);
    expect(mockDb.calls()[0].text).toMatch(ADMIN_ONLY);
    // the shared Company Admin role only — a company role that happened to be
    // named COMPANY_ADMIN could not count (and migration 025 forbids one)
    expect(mockDb.calls()[0].text).toMatch(/xr\.company_id IS NULL/);
  });

  test('reading one user by id is limited the same way — an ordinary user is a 404', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(svc.getById(22, snt)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()[0].text).toMatch(ADMIN_ONLY);
  });

  test('changing a user is limited the same way', async () => {
    mockDb.queueResponse({}, { rows: [], rowCount: 0 });      // BEGIN, UPDATE matches nothing
    await expect(svc.update(22, snt, { is_active: false })).rejects.toMatchObject({ status: 404 });
    const upd = mockDb.calls().find(c => /UPDATE users SET/.test(c.text));
    expect(upd.text).toMatch(ADMIN_ONLY);
  });

  test('deleting is limited the same way — and an ordinary user is left untouched', async () => {
    mockDb.queueResponse({}, { rows: [], rowCount: 0 });      // BEGIN, the check finds nothing
    await expect(svc.remove(22, snt)).rejects.toMatchObject({ status: 404 });
    const texts = mockDb.calls().map(c => c.text);
    expect(texts[1]).toMatch(ADMIN_ONLY);
    // nothing deleted — not even the user's roles
    expect(texts.some(t => /DELETE FROM/.test(t))).toBe(false);
  });

  /* The check reads the user's roles. Clearing user_roles first — which the
     old code did — would make every company admin look like an ordinary
     user, and S&T could never delete one. */
  test('deleting a company admin checks first, then removes roles and user', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 10 }], rowCount: 1 }, {}, {}, {});
    await svc.remove(10, snt);
    const texts = mockDb.calls().map(c => c.text.trim());
    const check = texts.findIndex(t => /FOR UPDATE/.test(t));
    const roles = texts.findIndex(t => /DELETE FROM user_roles/.test(t));
    const user  = texts.findIndex(t => /DELETE FROM users/.test(t));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(roles);
    expect(roles).toBeLessThan(user);
    expect(texts).toContain('COMMIT');
  });
});

describe('a company admin\'s view is unchanged', () => {
  test('the list is their own company\'s users, with no admin-only limit', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list(companyA);
    const { text, params } = mockDb.calls()[0];
    expect(text).toMatch(/u\.company_id = \$1/);
    expect(text).not.toMatch(ADMIN_ONLY);
    expect(params[0]).toBe(4);
  });

  test('deleting is scoped to their company', async () => {
    mockDb.queueResponse({}, { rows: [], rowCount: 0 });
    await expect(svc.remove(99, companyA)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()[1].params).toEqual([99, 4]);
    expect(mockDb.calls().some(c => /DELETE FROM/.test(c.text))).toBe(false);
  });
});
