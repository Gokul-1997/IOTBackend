/*
 * HTTP-level integration tests for /api/auth
 *
 * Mocks DB, bcrypt, JWT, and nodemailer.
 * Exercises the full route → validate middleware → controller → service stack.
 *
 * Covers:
 *  POST /api/auth/login
 *    TC-AR-01  400 when email missing
 *    TC-AR-02  400 when password missing
 *    TC-AR-03  400 when email is invalid format
 *    TC-AR-04  404 when user not found
 *    TC-AR-05  403 when account inactive
 *    TC-AR-06  403 when account locked
 *    TC-AR-07  401 on wrong password
 *    TC-AR-08  200 with tokens on success
 *
 *  POST /api/auth/refresh
 *    TC-AR-20  401 when no refresh token
 *    TC-AR-21  401 when refresh token invalid (not in DB)
 *    TC-AR-22  401 when session is revoked
 *    TC-AR-23  401 when session expired
 *    TC-AR-24  200 with new accessToken on success
 *
 *  POST /api/auth/logout
 *    TC-AR-30  200 even with no refresh token (safe logout)
 *    TC-AR-31  200 revokes session when refresh token provided
 *
 *  POST /api/auth/forgot-password
 *    TC-AR-40  400 when email missing
 *    TC-AR-41  400 when email format invalid
 *    TC-AR-42  200 always (email not revealed)
 *    TC-AR-43  200 even when user does not exist (no reveal)
 *
 *  POST /api/auth/reset-password
 *    TC-AR-50  400 when token missing
 *    TC-AR-51  400 when password missing
 *    TC-AR-52  400 when password shorter than 8 chars
 *    TC-AR-53  200 on successful reset
 *    TC-AR-54  400 when token invalid/expired
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash:    jest.fn(async (p) => `hashed:${p}`)
}));
jest.mock('jsonwebtoken', () => ({
  sign:   jest.fn(() => 'signed-access-token'),
  verify: jest.fn()
}));
jest.mock('../../src/utils/nodemailer', () => ({
  sendBulkEmails: jest.fn(async () => {})
}));
jest.mock(
  '../../src/utils/nodemailer/emailTemplates/generateResetPasswordTemplate',
  () => ({ generateResetPasswordTemplate: () => '<html>reset</html>' })
);

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt  = require('bcryptjs');
const { mockDb, resetDb } = require('../helpers/mockDb');

beforeEach(() => resetDb());

// ── build test app ────────────────────────────────────────────────────────────

function makeApp() {
  jest.resetModules();
  jest.doMock('../../src/db', () => mockDb);
  jest.doMock('bcryptjs', () => ({
    compare: bcrypt.compare,
    hash:    bcrypt.hash
  }));
  jest.doMock('jsonwebtoken', () => ({
    sign:   jest.fn(() => 'signed-access-token'),
    verify: jest.fn()
  }));
  jest.doMock('../../src/utils/nodemailer', () => ({ sendBulkEmails: jest.fn() }));
  jest.doMock(
    '../../src/utils/nodemailer/emailTemplates/generateResetPasswordTemplate',
    () => ({ generateResetPasswordTemplate: () => '<html/>' })
  );

  const router = require('../../src/auth/auth.routes');
  const app    = express();
  app.use(express.json());
  app.use('/api/auth', router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message || 'error' });
  });
  return app;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const ACTIVE_USER = {
  id: 1, email: 'test@x.com', username: 'test',
  password_hash: 'hashed_pw', plant_id: 1, company_id: 4, user_type: 'ADMIN',
  is_active: true, failed_login_attempts: 0, lock_until: null, company_name: 'Acme'
};

function queueSuccessfulLogin() {
  bcrypt.compare.mockResolvedValueOnce(true);

  mockDb.queueResponse(
    // user lookup
    { rows: [ACTIVE_USER], rowCount: 1 },
    // roles
    { rows: [{ role_name: 'ADMIN' }], rowCount: 1 },
    // permissions
    { rows: [{ permission_key: 'page:dashboard' }], rowCount: 1 },
    // plan
    { rows: [{ plan_code: 'PRO', plan_name: 'Pro', tier: 2, max_users: 10, max_plants: 2, max_machines: 50 }], rowCount: 1 },
    // company_permissions
    { rows: [], rowCount: 0 }
  );

  // Transaction: BEGIN, UPDATE last_login, INSERT session, UPDATE old sessions, COMMIT
  mockDb.queueResponse({}, {}, {}, {}, {});
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  test('TC-AR-01 400 when email missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ password: 'secret123' });
    expect(res.status).toBe(400);
  });

  test('TC-AR-02 400 when password missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'user@x.com' });
    expect(res.status).toBe(400);
  });

  test('TC-AR-03 400 when email format invalid', async () => {
    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'secret123' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/valid email/i);
  });

  test('TC-AR-04 404 when user not found', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'ghost@x.com', password: 'pw' });
    expect(res.status).toBe(404);
  });

  test('TC-AR-05 403 when account inactive', async () => {
    mockDb.queueResponse({
      rows: [{ ...ACTIVE_USER, is_active: false }],
      rowCount: 1
    });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'test@x.com', password: 'pw' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/inactive/i);
  });

  test('TC-AR-06 403 when account locked', async () => {
    const lockUntil = new Date(Date.now() + 60_000).toISOString();
    mockDb.queueResponse({
      rows: [{ ...ACTIVE_USER, lock_until: lockUntil }],
      rowCount: 1
    });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'test@x.com', password: 'pw' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/locked/i);
  });

  test('TC-AR-07 401 on wrong password', async () => {
    bcrypt.compare.mockResolvedValueOnce(false);
    mockDb.queueResponse({ rows: [ACTIVE_USER], rowCount: 1 });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'test@x.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('TC-AR-08 200 with accessToken + refreshToken on success', async () => {
    queueSuccessfulLogin();

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'test@x.com', password: 'correct' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe('signed-access-token');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.refreshToken.length).toBeGreaterThan(40);
    expect(res.body.user.roles).toEqual(['ADMIN']);
  });

  test('TC-AR-09 response includes plan when company has a plan', async () => {
    queueSuccessfulLogin();

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'test@x.com', password: 'correct' });

    expect(res.status).toBe(200);
    expect(res.body.user.plan).toMatchObject({ plan_code: 'PRO', tier: 2 });
  });

  test('TC-AR-10 user object contains expected fields', async () => {
    queueSuccessfulLogin();

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'test@x.com', password: 'correct' });

    const user = res.body.user;
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('email');
    expect(user).toHaveProperty('roles');
    expect(user).toHaveProperty('permissions');
    expect(user).toHaveProperty('company_permissions');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/refresh', () => {
  test('TC-AR-20 401 when no refresh token provided', async () => {
    const res = await request(makeApp())
      .post('/api/auth/refresh')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Refresh token required/i);
  });

  test('TC-AR-21 401 when refresh token not in DB', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'some-random-token' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Invalid refresh token/i);
  });

  test('TC-AR-22 401 when session is revoked', async () => {
    mockDb.queueResponse({
      rows: [{
        user_id: 1, expires_at: new Date(Date.now() + 86400000).toISOString(),
        revoked: true, is_active: true
      }],
      rowCount: 1
    });

    const res = await request(makeApp())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'some-token' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/revoked/i);
  });

  test('TC-AR-23 401 when session is expired', async () => {
    mockDb.queueResponse({
      rows: [{
        user_id: 1, expires_at: new Date(Date.now() - 1000).toISOString(),
        revoked: false, is_active: true
      }],
      rowCount: 1
    });

    const res = await request(makeApp())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'some-token' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
  });

  test('TC-AR-24 200 with new accessToken on success', async () => {
    mockDb.queueResponse({
      rows: [{
        user_id: 1, plant_id: 1, expires_at: new Date(Date.now() + 86400000).toISOString(),
        revoked: false, is_active: true, email: 'test@x.com', username: 'test'
      }],
      rowCount: 1
    });
    // roles
    mockDb.queueResponse({ rows: [{ role_name: 'ADMIN' }], rowCount: 1 });
    // permissions
    mockDb.queueResponse({ rows: [{ permission_key: 'page:dashboard' }], rowCount: 1 });
    // company + user_type
    mockDb.queueResponse({ rows: [{ company_id: 4, user_type: 'ADMIN' }], rowCount: 1 });

    const res = await request(makeApp())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'valid-raw-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accessToken).toBe('signed-access-token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  test('TC-AR-30 200 even with no refresh token body (safe logout)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/logout')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('TC-AR-31 200 and revokes session when refresh token provided', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 }); // UPDATE revoked = true

    const res = await request(makeApp())
      .post('/api/auth/logout')
      .send({ refreshToken: 'some-valid-refresh-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDb.calls()[0].text).toMatch(/SET revoked = true/i);
  });

  test('TC-AR-32 refresh token can also be sent via x-refresh-token header', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 });

    const res = await request(makeApp())
      .post('/api/auth/logout')
      .set('x-refresh-token', 'some-token')
      .send({});

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  test('TC-AR-40 400 when email missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
  });

  test('TC-AR-41 400 when email format is invalid', async () => {
    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'not-valid' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/valid email/i);
  });

  test('TC-AR-42 200 when user exists (does not reveal whether email sent)', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, email: 'user@x.com' }], rowCount: 1 });
    mockDb.queueResponse({ rows: [], rowCount: 1 }); // INSERT reset token

    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'user@x.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });

  test('TC-AR-43 200 even when user does NOT exist (no account enumeration)', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'ghost@x.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/reset link/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/reset-password', () => {
  test('TC-AR-50 400 when token missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ password: 'newpassword1' });
    expect(res.status).toBe(400);
  });

  test('TC-AR-51 400 when password missing', async () => {
    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'abc123' });
    expect(res.status).toBe(400);
  });

  test('TC-AR-52 400 when password shorter than 8 chars (validate middleware)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'abc123', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatch(/at least 8/i);
  });

  test('TC-AR-53 200 on valid token + password reset', async () => {
    // resetPassword queries: find token, update password, delete token
    mockDb.queueResponse({
      rows: [{ user_id: 1, expires_at: new Date(Date.now() + 60000).toISOString() }],
      rowCount: 1
    });
    mockDb.queueResponse({ rows: [], rowCount: 1 }); // UPDATE password
    mockDb.queueResponse({ rows: [], rowCount: 1 }); // DELETE token

    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'valid-reset-token', password: 'newpassword1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/reset successful/i);
  });

  test('TC-AR-54 400 when token is invalid or expired', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }); // token not found

    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'bad-token', password: 'newpassword1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid|expired/i);
  });
});
