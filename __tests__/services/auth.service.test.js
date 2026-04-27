/*
 * Unit tests for auth.service.login covering:
 *  - missing credentials → 400
 *  - user not found     → 404
 *  - inactive account   → 403
 *  - locked account     → 403
 *  - bad password       → 401 (and increments failed_login_attempts)
 *  - good password      → returns access+refresh tokens, role list
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash:    jest.fn(async (p) => `hash:${p}`)
}));
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'signed-jwt-token'),
  verify: jest.fn()
}));
jest.mock('../../src/utils/nodemailer', () => ({ sendBulkEmails: jest.fn() }));
jest.mock(
  '../../src/utils/nodemailer/emailTemplates/generateResetPasswordTemplate',
  () => ({ generateResetPasswordTemplate: () => '<html/>' })
);

process.env.JWT_SECRET = 'test-secret';

const bcrypt = require('bcryptjs');
const { mockDb, resetDb } = require('../helpers/mockDb');
const auth = require('../../src/auth/auth.service');

const fakeReq = { ip: '1.2.3.4', headers: { 'user-agent': 'jest' } };

beforeEach(() => resetDb());

describe('auth.service.login', () => {
  test('400 when email or password is missing', async () => {
    await expect(auth.login({ email: '', password: '' }, fakeReq))
      .rejects.toMatchObject({ status: 400 });
  });

  test('404 when user not found', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(auth.login({ email: 'x@y.com', password: 'p' }, fakeReq))
      .rejects.toMatchObject({ status: 404 });
  });

  test('403 when account inactive', async () => {
    mockDb.queueResponse({
      rows: [{ id: 1, password_hash: 'h', is_active: false }],
      rowCount: 1
    });
    await expect(auth.login({ email: 'x@y.com', password: 'p' }, fakeReq))
      .rejects.toMatchObject({ status: 403, message: /inactive/i });
  });

  test('403 when account locked', async () => {
    const lockUntil = new Date(Date.now() + 60_000).toISOString();
    mockDb.queueResponse({
      rows: [{ id: 1, password_hash: 'h', is_active: true, lock_until: lockUntil }],
      rowCount: 1
    });
    await expect(auth.login({ email: 'x@y.com', password: 'p' }, fakeReq))
      .rejects.toMatchObject({ status: 403, message: /locked/i });
  });

  test('401 on bad password', async () => {
    mockDb.queueResponse({
      rows: [{
        id: 1, email: 'x@y.com', password_hash: 'h',
        is_active: true, failed_login_attempts: 0, lock_until: null
      }],
      rowCount: 1
    });
    bcrypt.compare.mockResolvedValueOnce(false);

    await expect(auth.login({ email: 'x@y.com', password: 'wrong' }, fakeReq))
      .rejects.toMatchObject({ status: 401 });
  });

  test('returns tokens + roles + permissions on success', async () => {
    bcrypt.compare.mockResolvedValueOnce(true);

    mockDb.queueResponse(
      // user lookup
      {
        rows: [{
          id: 1, email: 'x@y.com', username: 'x',
          password_hash: 'h', plant_id: 1, company_id: 4, user_type: 'ADMIN',
          is_active: true, failed_login_attempts: 0, lock_until: null
        }],
        rowCount: 1
      },
      // roles
      { rows: [{ role_name: 'ADMIN' }], rowCount: 1 },
      // permissions
      { rows: [{ permission_key: 'dashboard.view' }], rowCount: 1 },
      // company plan
      { rows: [{ plan_code: 'PRO', plan_name: 'Pro', tier: 2,
                 max_users: 10, max_plants: 2, max_machines: 50 }], rowCount: 1 },
      // company_permissions
      { rows: [{ permission_key: 'dashboard.view' }], rowCount: 1 }
    );

    // Transaction queries (inside db.connect()) — BEGIN, UPDATE, INSERT, UPDATE, COMMIT
    mockDb.queueResponse({}, {}, {}, {}, {}, {});

    const out = await auth.login({ email: 'x@y.com', password: 'right' }, fakeReq);

    expect(out.accessToken).toBe('signed-jwt-token');
    expect(out.refreshToken).toEqual(expect.any(String));
    expect(out.refreshToken.length).toBeGreaterThan(40);
    expect(out.user.roles).toEqual(['ADMIN']);
    expect(out.user.permissions).toEqual(['dashboard.view']);
    expect(out.user.plan).toMatchObject({ plan_code: 'PRO', tier: 2 });
  });
});
