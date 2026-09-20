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


/*
 * Self-service profile: the route a non-admin uses to see and change their
 * own account. Before this existed, GET/PUT /api/users/:id required
 * ADMIN-tier role, so a MANAGER/SUPERVISOR/OPERATOR had no way to view their
 * own profile or change their own password.
 */
describe('getMyProfile', () => {
  test('returns the profile joined with company and plant names', async () => {
    mockDb.queueResponse({ rows: [{
      id: 12, username: 'suresh', email: 's@x.com', mobile: null,
      user_type: 'SUPERVISOR', company_id: 4, plant_id: 1,
      last_login_at: null, created_at: '2026-01-01',
      company_name: 'S AND T', plant_name: 'Plant 1'
    }] });
    const p = await auth.getMyProfile(12);
    expect(p.username).toBe('suresh');
    expect(p.company_name).toBe('S AND T');
  });

  test('a deleted user throws 404 rather than returning nothing', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(auth.getMyProfile(999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateMyProfile', () => {
  test('rejects a malformed email before it reaches the database', async () => {
    await expect(auth.updateMyProfile(12, { email: 'not-an-email' }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('rejects an update with nothing to change', async () => {
    await expect(auth.updateMyProfile(12, {})).rejects.toMatchObject({ status: 400 });
  });

  test('updates email and mobile together', async () => {
    mockDb.queueResponse({ rows: [{ id: 12, username: 'suresh', email: 'new@x.com', mobile: '9999999999' }] });
    const out = await auth.updateMyProfile(12, { email: 'new@x.com', mobile: '9999999999' });
    expect(out.email).toBe('new@x.com');
    const { text: sql, params } = mockDb.calls()[0];
    expect(sql).toMatch(/UPDATE users SET email = \$1, mobile = \$2/);
    expect(params).toEqual(['new@x.com', '9999999999', 12]);
  });

  test('a duplicate email reports 409, not a raw database error', async () => {
    // queueError only throws instanceof Error — a plain object would be
    // returned as if it were a successful { code, message } row.
    const dup = new Error('duplicate key');
    dup.code = '23505';
    mockDb.queueError(dup);
    await expect(auth.updateMyProfile(12, { email: 'taken@x.com' }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('changeMyPassword', () => {
  beforeEach(() => { bcrypt.compare.mockReset(); });

  test('requires both the current and the new password', async () => {
    await expect(auth.changeMyPassword(12, '', 'newpassword1')).rejects.toMatchObject({ status: 400 });
    await expect(auth.changeMyPassword(12, 'oldpass', '')).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('rejects a new password shorter than 8 characters', async () => {
    await expect(auth.changeMyPassword(12, 'oldpass1', 'short')).rejects.toMatchObject({ status: 400 });
  });

  test('a wrong current password is rejected before anything is written', async () => {
    mockDb.queueResponse({ rows: [{ password_hash: 'hash:oldpass1' }] });
    bcrypt.compare.mockResolvedValueOnce(false);
    await expect(auth.changeMyPassword(12, 'wrongpass', 'newpassword1'))
      .rejects.toMatchObject({ status: 401 });
    // only the SELECT ran — no UPDATE for a rejected attempt
    expect(mockDb.calls()).toHaveLength(1);
  });

  test('the new password must differ from the current one', async () => {
    mockDb.queueResponse({ rows: [{ password_hash: 'hash:samepass1' }] });
    bcrypt.compare
      .mockResolvedValueOnce(true)   // matches current
      .mockResolvedValueOnce(true);  // new === current
    await expect(auth.changeMyPassword(12, 'samepass1', 'samepass1'))
      .rejects.toMatchObject({ status: 400 });
  });

  test('a correct current password and a new one succeeds', async () => {
    mockDb.queueResponse({ rows: [{ password_hash: 'hash:oldpass1' }] }, {});
    bcrypt.compare
      .mockResolvedValueOnce(true)   // current password matches
      .mockResolvedValueOnce(false); // new password is not the same as old
    await auth.changeMyPassword(12, 'oldpass1', 'brandnewpass1');
    const { text: sql, params } = mockDb.calls()[1];
    expect(sql).toMatch(/UPDATE users SET password_hash/);
    expect(params[0]).toBe('hash:brandnewpass1');
    expect(params[1]).toBe(12);
  });

  test('a user that no longer exists is reported, not a null-pointer crash', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(auth.changeMyPassword(999, 'anything1', 'newpassword1'))
      .rejects.toMatchObject({ status: 404 });
  });
});

/*
 * Refresh carries the company's current grants.
 *
 * Login sent company_permissions to the browser once and nothing ever
 * updated it — a change made in Manage Access reached a signed-in user only
 * when they signed out and back in. Refresh runs about every 14 minutes for
 * anyone with the app open.
 */
describe('refresh', () => {
  const session = { rows: [{ user_id: 12, expires_at: new Date(Date.now() + 86_400_000), revoked: false,
                             email: 'a@b.com', username: 'a', plant_id: 1, is_active: true }], rowCount: 1 };

  test('returns the current page grants alongside the new token', async () => {
    mockDb.queueResponse(
      session,
      { rows: [{ role_name: 'COMPANY_ADMIN' }] },                         // roles
      { rows: [{ permission_key: 'page:programs:view' }] },               // role permissions
      { rows: [{ company_id: 4, user_type: 'ADMIN' }] },                  // company
      { rows: [{ permission_key: 'page:dashboard:view' }, { permission_key: 'page:reports:view' }] }
    );
    const out = await auth.refresh('raw-refresh-token', fakeReq);
    expect(out.accessToken).toBe('signed-jwt-token');
    expect(out.company_permissions).toEqual(['page:dashboard:view', 'page:reports:view']);
    expect(out.permissions).toEqual(['page:programs:view']);
  });

  test('a page revoked since login is absent — that is the point', async () => {
    mockDb.queueResponse(
      session, { rows: [{ role_name: 'COMPANY_ADMIN' }] }, { rows: [] },
      { rows: [{ company_id: 4, user_type: 'ADMIN' }] },
      { rows: [{ permission_key: 'page:dashboard:view' }] }               // reports is gone
    );
    const out = await auth.refresh('raw-refresh-token', fakeReq);
    expect(out.company_permissions).not.toContain('page:reports:view');
  });

  test('a super admin has no company, so no company query runs and the list is empty', async () => {
    mockDb.queueResponse(
      session, { rows: [{ role_name: 'SNT_SUPER' }] }, { rows: [] },
      { rows: [{ company_id: null, user_type: 'SNT_SUPER' }] }
    );
    const out = await auth.refresh('raw-refresh-token', fakeReq);
    expect(out.company_permissions).toEqual([]);
    expect(mockDb.calls().some(c => /FROM company_permissions/.test(c.text))).toBe(false);
  });

  test('a revoked session is still refused before any of this is read', async () => {
    mockDb.queueResponse({ rows: [{ ...session.rows[0], revoked: true }], rowCount: 1 });
    await expect(auth.refresh('raw-refresh-token', fakeReq)).rejects.toMatchObject({ status: 401 });
    expect(mockDb.calls()).toHaveLength(1);
  });
});
