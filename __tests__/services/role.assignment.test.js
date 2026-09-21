/*
 * Who may be given which role.
 *
 * The hole these close: auth.service derives the platform super-admin flag
 * straight from holding the SNT_SUPER role (`roles.includes('SNT_SUPER')`),
 * and access.middleware waves that flag past every page and company check.
 * So granting that one role to a user makes them a full platform admin who
 * can see and edit every tenant.
 *
 * Both routes a role reaches a user by allowed it:
 *   - POST /api/roles/assign/:id  checked the role was "system or same
 *     company", and SNT_SUPER is a system role, so it passed.
 *   - POST /api/users             took role_ids and inserted them into
 *     user_roles with no check whatsoever.
 *
 * Either one let a company admin mint themselves an S&T super user.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const roleSvc = require('../../src/roles/role.service');
const userSvc = require('../../src/users/user.service');

jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) }));

const sntSuper  = { id: 1, is_snt_super: true, company_id: null };
const companyA  = { id: 2, is_snt_super: false, company_id: 4 };

const role = (over = {}) => ({ id: 50, role_name: 'SETTER', company_id: null, is_system: true, ...over });

beforeEach(() => resetDb());

describe('assertAssignable — the shared rule', () => {
  const client = () => mockDb;

  test('the company\'s own role is assignable to its users', async () => {
    mockDb.queueResponse({ rows: [role({ id: 50, role_name: 'MAINTENANCE', company_id: 4, is_system: false })] });
    await expect(roleSvc.assertAssignable(client(), [50], { actor: companyA, targetCompanyId: 4 }))
      .resolves.toBeUndefined();
  });

  test('so is Company Admin, the one shared role a company admin can give', async () => {
    mockDb.queueResponse({ rows: [role({ id: 7, role_name: 'COMPANY_ADMIN' })] });
    await expect(roleSvc.assertAssignable(client(), [7], { actor: companyA, targetCompanyId: 4 }))
      .resolves.toBeUndefined();
  });

  /* Each company now owns its default roles; the old shared rows were
     retired by migration 027. If one ever reappeared it must not be usable. */
  test('a leftover shared default row is refused', async () => {
    mockDb.queueResponse({ rows: [role({ id: 19, role_name: 'SUPERVISOR' })] });
    await expect(roleSvc.assertAssignable(client(), [19], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403, message: /no longer in use/ });
  });

  test('a company admin CANNOT assign SNT_SUPER — the escalation', async () => {
    mockDb.queueResponse({ rows: [role({ id: 6, role_name: 'SNT_SUPER' })] });
    await expect(roleSvc.assertAssignable(client(), [6], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403, message: /only be granted by S&T/ });
  });

  /* S&T gives no role to anyone. A company's admin is made with the
     company, and S&T creates no other account — so there is nobody left for
     S&T to grant SNT_SUPER or Company Admin to. */
  test('S&T grants no role — not SNT_SUPER, not Company Admin', async () => {
    await expect(roleSvc.assertAssignable(client(), [6], { actor: sntSuper, targetCompanyId: null }))
      .rejects.toMatchObject({ status: 403, message: /S&T doesn't assign roles/ });
    await expect(roleSvc.assertAssignable(client(), [7], { actor: sntSuper, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('POST /roles/assign by S&T is refused before the user is even looked up', async () => {
    await expect(roleSvc.assign(10, [7], sntSuper)).rejects.toMatchObject({ status: 403 });
    // clearing an admin's roles is refused too
    await expect(roleSvc.assign(10, [], sntSuper)).rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('another company\'s custom role is refused', async () => {
    mockDb.queueResponse({ rows: [role({ id: 70, role_name: 'QC_LEAD', company_id: 5, is_system: false })] });
    await expect(roleSvc.assertAssignable(client(), [70], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403, message: /another company/ });
  });

  test('a role that does not exist is a 404, not a silent skip', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(roleSvc.assertAssignable(client(), [999], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('one bad id in a list of good ones refuses the whole list', async () => {
    mockDb.queueResponse({ rows: [role({ id: 50, role_name: 'MAINTENANCE', company_id: 4, is_system: false })] });
    mockDb.queueResponse({ rows: [role({ id: 6, role_name: 'SNT_SUPER' })] });
    await expect(roleSvc.assertAssignable(client(), [50, 6], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403 });
  });

  test('the row is locked, so a role cannot be deleted between check and insert', async () => {
    mockDb.queueResponse({ rows: [role({ company_id: 4, is_system: false })] });
    await roleSvc.assertAssignable(client(), [50], { actor: companyA, targetCompanyId: 4 });
    expect(mockDb.calls()[0].text).toMatch(/FOR UPDATE/);
  });
});

describe('POST /api/users — role_ids used to go straight into user_roles', () => {
  const newUser = (over = {}) => ({
    username: 'setter1', email: 's1@x.com', password: 'Passw0rd!', ...over
  });

  /* create() opens its own transaction: BEGIN, the email/username check,
     the INSERT, then the role work. */
  const queueCreate = () => {
    mockDb.queueResponse({});                                  // BEGIN
    mockDb.queueResponse({ rows: [], rowCount: 0 });           // duplicate check
    mockDb.queueResponse({ rows: [{ id: 99, username: 'setter1', company_id: 4 }] });
  };

  test('a company admin creating a user with SNT_SUPER is refused', async () => {
    queueCreate();
    mockDb.queueResponse({ rows: [role({ id: 6, role_name: 'SNT_SUPER' })] });

    await expect(userSvc.create(newUser({ role_ids: [6] }), companyA))
      .rejects.toMatchObject({ status: 403 });

    // and the transaction is undone — no half-created user is left behind
    expect(mockDb.calls().some(c => /ROLLBACK/.test(c.text))).toBe(true);
    expect(mockDb.calls().some(c => /INSERT INTO user_roles/.test(c.text))).toBe(false);
  });

  test('another company\'s role is refused too', async () => {
    queueCreate();
    mockDb.queueResponse({ rows: [role({ id: 70, company_id: 5, is_system: false })] });

    await expect(userSvc.create(newUser({ role_ids: [70] }), companyA))
      .rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls().some(c => /INSERT INTO user_roles/.test(c.text))).toBe(false);
  });

  test('the company\'s own default role works', async () => {
    queueCreate();
    mockDb.queueResponse({ rows: [role({ id: 50, role_name: 'MAINTENANCE', company_id: 4, is_system: false })] });
    mockDb.queueResponse({});                                            // INSERT user_roles
    mockDb.queueResponse({ rows: [{ id: 50, role_name: 'MAINTENANCE' }] }); // read back
    mockDb.queueResponse({});                                            // COMMIT

    const user = await userSvc.create(newUser({ role_ids: [50] }), companyA);
    expect(user.roles).toEqual([{ id: 50, role_name: 'MAINTENANCE' }]);
    expect(mockDb.calls().some(c => /INSERT INTO user_roles/.test(c.text))).toBe(true);
  });

  /* A user with no role used to get OPERATOR, a retired role nobody manages.
     Garbage ids clean down to no role at all, so they get the same answer —
     before anything reaches the database. */
  test('no usable role id is refused before anything is written', async () => {
    await expect(userSvc.create(newUser({ role_ids: ["'; DROP TABLE users; --", -1, 0] }), companyA))
      .rejects.toMatchObject({ status: 400, message: 'Choose a role for this user' });
    await expect(userSvc.create(newUser({ role_ids: [] }), companyA))
      .rejects.toMatchObject({ status: 400 });
    await expect(userSvc.create(newUser(), companyA))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});
