/*
 * What S&T can see and do on the Users side.
 *
 * A company's admin is made with the company. That admin creates and
 * manages everyone else in it — a second full-access admin included — so
 * S&T's side is one admin per company:
 *
 *   - the list, and every read or change by id, is that admin only;
 *   - S&T adds no one and deletes no one (the company would be left with
 *     nobody to run it; the admin goes with the company);
 *   - S&T may change the admin's name, email, password and active status,
 *     never the company.
 *
 * A company admin's own view is unchanged: their own company's users.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) }));
const svc = require('../../src/users/user.service');

const snt = { id: 1, is_snt_super: true, company_id: null };
const companyA = { id: 10, is_snt_super: false, company_id: 4 };

/* The company's earliest holder of the shared Company Admin role — the one
   company create made in the same transaction as the company. */
const THE_ADMIN = /\w+\.id = \(\s*SELECT MIN\(xa\.user_id\) FROM user_roles xa\s+JOIN roles xr ON xr\.id = xa\.role_id\s+JOIN users xu ON xu\.id = xa\.user_id\s+WHERE xu\.company_id = \w+\.company_id\s+AND xr\.role_name = 'COMPANY_ADMIN' AND xr\.company_id IS NULL\)/;

beforeEach(() => resetDb());

describe('S&T sees one admin per company', () => {
  test('the list is each company\'s first admin', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, username: 'S AND T', company_id: 4 }] }, { rows: [] });
    await svc.list(snt);
    const text = mockDb.calls()[0].text;
    expect(text).toMatch(THE_ADMIN);
    // the shared Company Admin role only — a company role can't be named COMPANY_ADMIN (025)
    expect(text).toMatch(/xr\.company_id IS NULL/);
  });

  test('each row says whether the company itself is turned off', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list(snt);
    expect(mockDb.calls()[0].text).toMatch(/COALESCE\(c\.is_active, true\) AS company_active/);
  });

  test('reading one user by id is limited the same way — anyone else is a 404', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(svc.getById(13, snt)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()[0].text).toMatch(THE_ADMIN);
  });

  test('changing a user is limited the same way', async () => {
    mockDb.queueResponse({}, { rows: [], rowCount: 0 });      // BEGIN, UPDATE matches nothing
    await expect(svc.update(22, snt, { is_active: false })).rejects.toMatchObject({ status: 404 });
    const upd = mockDb.calls().find(c => /UPDATE users SET/.test(c.text));
    expect(upd.text).toMatch(THE_ADMIN);
  });
});

describe('S&T adds and deletes no one', () => {
  test('creating a user is refused before anything is read or written', async () => {
    await expect(svc.create({
      username: 'second_admin', email: 'a2@x.com', password: 'Passw0rd!', company_id: 4, role_ids: [7]
    }, snt)).rejects.toMatchObject({ status: 403, message: /created with the company/ });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('deleting the company\'s admin is refused — it goes with the company', async () => {
    await expect(svc.remove(10, snt)).rejects.toMatchObject({ status: 403, message: /removed only with the company/ });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('S&T edits an admin\'s own details — never the company', () => {
  const queueUpdate = () => mockDb.queueResponse(
    {},                                                                  // BEGIN
    { rows: [{ id: 10, company_id: 4 }], rowCount: 1 },                  // UPDATE
    { rows: [{ id: 7, role_name: 'COMPANY_ADMIN' }] },                   // roles
    {}                                                                   // COMMIT
  );

  test('name, email, password and active status can be changed', async () => {
    queueUpdate();
    await svc.update(10, snt, { username: 'New Admin', email: 'new@x.com', password: 'Passw0rd!', is_active: true });
    const upd = mockDb.calls().find(c => /UPDATE users SET/.test(c.text));
    expect(upd.text).toMatch(/username = \$1, email = \$2, password_hash = \$3, is_active = \$4/);
  });

  test.each([
    ['company_id', { company_id: 5 }],
    ['company_id cleared', { company_id: null }],
    ['plant_id', { plant_id: 3 }],
    ['supervised machines', { supervised_machine_ids: [] }],
    ['a company field alongside allowed ones', { username: 'x_admin', company_id: 5 }]
  ])('%s is refused, and nothing is written', async (_label, body) => {
    await expect(svc.update(10, snt, body)).rejects.toMatchObject({ status: 400, message: /company can't be changed/ });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('a company admin\'s view is unchanged', () => {
  test('the list is their own company\'s users, with no first-admin limit', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list(companyA);
    const { text, params } = mockDb.calls()[0];
    expect(text).toMatch(/u\.company_id = \$1/);
    expect(text).not.toMatch(THE_ADMIN);
    expect(params[0]).toBe(4);
  });

  test('deleting is scoped to their company', async () => {
    mockDb.queueResponse({}, { rows: [], rowCount: 0 });
    await expect(svc.remove(99, companyA)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()[1].params).toEqual([99, 4]);
    expect(mockDb.calls().some(c => /DELETE FROM/.test(c.text))).toBe(false);
  });

  test('deleting one of their users removes roles, then the user', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 30 }], rowCount: 1 }, {}, {}, {});
    await svc.remove(30, companyA);
    const texts = mockDb.calls().map(c => c.text.trim());
    const check = texts.findIndex(t => /FOR UPDATE/.test(t));
    const roles = texts.findIndex(t => /DELETE FROM user_roles/.test(t));
    const user  = texts.findIndex(t => /DELETE FROM users/.test(t));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(roles);
    expect(roles).toBeLessThan(user);
    expect(texts).toContain('COMMIT');
  });

  /* A company admin can give a second person full access themselves — the
     reason S&T no longer needs to add one. */
  test('a company admin can create a second Company Admin', async () => {
    mockDb.queueResponse(
      {},                                                                 // BEGIN
      { rows: [], rowCount: 0 },                                          // email check
      { rows: [{ id: 40, username: 'second', company_id: 4 }] },          // INSERT
      { rows: [{ id: 7, role_name: 'COMPANY_ADMIN', company_id: null, is_system: true }] }, // assertAssignable
      {},                                                                 // user_roles
      { rows: [{ id: 7, role_name: 'COMPANY_ADMIN' }] },                  // read back
      {}                                                                  // COMMIT
    );
    const user = await svc.create({ username: 'second', email: 's@x.com', password: 'Passw0rd!', role_ids: [7] }, companyA);
    expect(user.roles).toEqual([{ id: 7, role_name: 'COMPANY_ADMIN' }]);
    expect(user.company_id).toBe(4);
  });
});
