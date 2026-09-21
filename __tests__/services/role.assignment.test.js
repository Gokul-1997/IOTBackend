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

  test('a shared system role is assignable to a company user', async () => {
    mockDb.queueResponse({ rows: [role({ id: 50, role_name: 'MAINTENANCE' })] });
    await expect(roleSvc.assertAssignable(client(), [50], { actor: companyA, targetCompanyId: 4 }))
      .resolves.toBeUndefined();
  });

  test('a company admin CANNOT assign SNT_SUPER — the escalation', async () => {
    mockDb.queueResponse({ rows: [role({ id: 6, role_name: 'SNT_SUPER' })] });
    await expect(roleSvc.assertAssignable(client(), [6], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403, message: /only be granted by S&T/ });
  });

  test('S&T itself still can', async () => {
    mockDb.queueResponse({ rows: [role({ id: 6, role_name: 'SNT_SUPER' })] });
    await expect(roleSvc.assertAssignable(client(), [6], { actor: sntSuper, targetCompanyId: 4 }))
      .resolves.toBeUndefined();
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
    mockDb.queueResponse({ rows: [role({ id: 50, role_name: 'MAINTENANCE' })] });
    mockDb.queueResponse({ rows: [role({ id: 6, role_name: 'SNT_SUPER' })] });
    await expect(roleSvc.assertAssignable(client(), [50, 6], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403 });
  });

  test('the row is locked, so a role cannot be deleted between check and insert', async () => {
    mockDb.queueResponse({ rows: [role()] });
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

  test('a legitimate default role still works', async () => {
    queueCreate();
    mockDb.queueResponse({ rows: [role({ id: 50, role_name: 'MAINTENANCE' })] });
    mockDb.queueResponse({});                                            // INSERT user_roles
    mockDb.queueResponse({ rows: [{ id: 50, role_name: 'MAINTENANCE' }] }); // read back
    mockDb.queueResponse({});                                            // COMMIT

    const user = await userSvc.create(newUser({ role_ids: [50] }), companyA);
    expect(user.roles).toEqual([{ id: 50, role_name: 'MAINTENANCE' }]);
    expect(mockDb.calls().some(c => /INSERT INTO user_roles/.test(c.text))).toBe(true);
  });

  test('a non-numeric role id is dropped rather than reaching SQL', async () => {
    queueCreate();
    // nothing queued for a role lookup: none should happen
    mockDb.queueResponse({ rows: [{ id: 20 }] });   // the OPERATOR default lookup
    mockDb.queueResponse({});                       // INSERT user_roles (default)
    mockDb.queueResponse({ rows: [] });             // read back
    mockDb.queueResponse({});                       // COMMIT

    await userSvc.create(newUser({ role_ids: ["'; DROP TABLE users; --", -1, 0] }), companyA);
    expect(mockDb.calls().some(c => /DROP TABLE/.test(c.text))).toBe(false);
    // falls through to the default-role branch, as an empty list would
    expect(mockDb.calls().some(c => /role_name = 'OPERATOR'/.test(c.text))).toBe(true);
  });
});
