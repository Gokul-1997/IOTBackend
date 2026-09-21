/*
 * S&T disabling a company stops everyone in it — its admin, its users,
 * every role it made — fully and at once:
 *
 *   - sign-in is refused, with a message that says why;
 *   - an open session stops on its next request (the auth middleware), and
 *     its token refresh is refused, so the app signs the person out;
 *   - live data stops: open sockets are closed, new ones refused;
 *   - no alarm emails or in-app alerts go out, and no reset-password mail.
 *
 * Nobody's own account is changed, so turning the company back on restores
 * exactly who could sign in before. Before this, disabling only flipped
 * companies.is_active — which nothing read — while the confirm box already
 * promised "This will disable all users".
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const mockRedis = { get: jest.fn(), setex: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) };
jest.mock('../../src/redis', () => mockRedis);
const mockRealtime = { disconnectUsers: jest.fn(), emitToUser: jest.fn(), setIo: jest.fn() };
jest.mock('../../src/lib/realtime', () => mockRealtime);
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'signed-jwt-token'), verify: jest.fn() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn(async () => true), hash: jest.fn(async () => 'hashed') }));
jest.mock('../../src/utils/nodemailer', () => ({ sendBulkEmails: jest.fn(), sendEmail: jest.fn(async () => {}) }));
jest.mock(
  '../../src/utils/nodemailer/emailTemplates/generateResetPasswordTemplate',
  () => ({ generateResetPasswordTemplate: () => '<html/>' })
);

process.env.JWT_SECRET = 'test-secret';

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mockDb, resetDb } = require('../helpers/mockDb');
const middleware = require('../../src/middleware/auth.middleware');
const auth       = require('../../src/auth/auth.service');
const companies  = require('../../src/companies/company.service');
const alarms     = require('../../src/alarms/alarm.service');
const { sendBulkEmails } = require('../../src/utils/nodemailer');

const fakeReq = { ip: '1.2.3.4', headers: { 'user-agent': 'jest' } };

function makeRes() {
  return {
    _status: null, _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;  return this; }
  };
}
const bearer = () => ({ headers: { authorization: 'Bearer t' } });

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  jwt.verify.mockReturnValue({ user_id: 17, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] });
  bcrypt.compare.mockResolvedValue(true);
});

/* ─────────────────────────── every request ─────────────────────────── */

describe('an open session stops on its next request', () => {
  test('from the database: 401 COMPANY_DISABLED, so the app refreshes and is signed out', async () => {
    mockDb.queueResponse({ rows: [{ id: 17, username: 'pacpl_admin', company_id: 5, is_active: true, company_active: false }] });
    const res = makeRes(); const next = jest.fn();
    await middleware(bearer(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: 'COMPANY_DISABLED', message: /turned off/ });
    expect(mockDb.calls()[0].text).toMatch(/LEFT JOIN companies c ON c\.id = u\.company_id/);
  });

  test('the company\'s status is cached with the user, so the next request is refused from the cache', async () => {
    mockDb.queueResponse({ rows: [{ id: 17, company_id: 5, is_active: true, company_active: false }] });
    await middleware(bearer(), makeRes(), jest.fn());
    expect(JSON.parse(mockRedis.setex.mock.calls[0][2])).toMatchObject({ company_active: false });
  });

  test('from the cache', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ id: 17, company_id: 5, is_active: true, company_active: false }));
    const res = makeRes(); const next = jest.fn();
    await middleware(bearer(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._body.code).toBe('COMPANY_DISABLED');
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('an entry cached before the field existed still passes — it expires within a minute', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ id: 17, company_id: 5, is_active: true }));
    const next = jest.fn();
    await middleware(bearer(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('an active company\'s users carry on as before', async () => {
    mockDb.queueResponse({ rows: [{ id: 17, company_id: 5, is_active: true, company_active: true }] });
    const next = jest.fn();
    await middleware(bearer(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('S&T belongs to no company and is never shut out by this', async () => {
    jwt.verify.mockReturnValue({ user_id: 1, roles: ['SNT_SUPER'], permissions: [] });
    mockDb.queueResponse({ rows: [{ id: 1, company_id: null, is_active: true, company_active: true }] });
    const next = jest.fn();
    await middleware(bearer(), makeRes(), next);
    expect(next).toHaveBeenCalled();
    // a user with no company reads as active, not as disabled
    expect(mockDb.calls()[0].text).toMatch(/COALESCE\(c\.is_active, true\) AS company_active/);
  });

  test('a user disabled on their own is still the 403 it was', async () => {
    mockDb.queueResponse({ rows: [{ id: 17, company_id: 5, is_active: false, company_active: true }] });
    const res = makeRes();
    await middleware(bearer(), res, jest.fn());
    expect(res._status).toBe(403);
    expect(res._body.message).toMatch(/inactive/);
  });
});

/* ─────────────────────────── sign-in and refresh ─────────────────────────── */

describe('sign-in', () => {
  const userRow = over => ({
    rows: [{ id: 17, email: 'admin@pacpl.test', password_hash: 'h', company_id: 5,
             is_active: true, failed_login_attempts: 0, lock_until: null, company_active: false, ...over }],
    rowCount: 1
  });

  test('the right password for a disabled company: 403 COMPANY_DISABLED, and no session is opened', async () => {
    mockDb.queueResponse(userRow());
    await expect(auth.login({ email: 'admin@pacpl.test', password: 'ok' }, fakeReq))
      .rejects.toMatchObject({ status: 403, code: 'COMPANY_DISABLED', message: /Contact S&T/ });
    expect(mockDb.calls()).toHaveLength(1);
    expect(mockDb.calls().some(c => /user_sessions/.test(c.text))).toBe(false);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  test('the wrong password is just "invalid credentials" — the company\'s status is not given away', async () => {
    mockDb.queueResponse(userRow());
    bcrypt.compare.mockResolvedValueOnce(false);
    await expect(auth.login({ email: 'admin@pacpl.test', password: 'bad' }, fakeReq))
      .rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
  });

  test('the query reads the company\'s status', async () => {
    mockDb.queueResponse(userRow());
    await auth.login({ email: 'admin@pacpl.test', password: 'ok' }, fakeReq).catch(() => {});
    expect(mockDb.calls()[0].text).toMatch(/COALESCE\(c\.is_active, true\) AS company_active/);
  });
});

describe('token refresh', () => {
  const session = over => ({
    rows: [{ user_id: 17, expires_at: new Date(Date.now() + 86_400_000), revoked: false,
             email: 'a@b.com', username: 'a', plant_id: null, is_active: true, company_active: false, ...over }],
    rowCount: 1
  });

  test('is refused while the company is off — nothing else is read, no token is signed', async () => {
    mockDb.queueResponse(session());
    await expect(auth.refresh('raw', fakeReq)).rejects.toMatchObject({ status: 403, code: 'COMPANY_DISABLED' });
    expect(mockDb.calls()).toHaveLength(1);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  test('the session is left in place, so it works again once the company is back on', async () => {
    mockDb.queueResponse(session());
    await auth.refresh('raw', fakeReq).catch(() => {});
    expect(mockDb.calls().some(c => /UPDATE user_sessions/.test(c.text))).toBe(false);
  });
});

describe('forgot password', () => {
  test('no reset mail for someone in a disabled company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });       // the company filter finds no one
    await auth.sendResetLink('admin@pacpl.test');
    expect(mockDb.calls()[0].text).toMatch(/COALESCE\(c\.is_active, true\)/);
    expect(sendBulkEmails).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────── turning it off and on ─────────────────────────── */

describe('turning a company off applies at once', () => {
  test('deactivate: every user\'s cached copy is dropped and their sockets are closed', async () => {
    mockDb.queueResponse({ rowCount: 1 }, { rows: [{ id: 17 }, { id: 30 }] });
    await companies.remove(5);

    expect(mockDb.calls()[1].text).toMatch(/SELECT id FROM users WHERE company_id = \$1/);
    expect(mockDb.calls()[1].params).toEqual([5]);
    expect(mockRedis.del).toHaveBeenCalledWith('user:17', 'user:30');
    expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([17, 30]);
  });

  test('the same through Edit Company with is_active false', async () => {
    mockDb.queueResponse({ rows: [{ id: 5, is_active: false }] }, { rows: [{ id: 17 }] });
    await companies.update(5, { is_active: false });
    expect(mockRedis.del).toHaveBeenCalledWith('user:17');
    expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([17]);
  });

  test('turning it back on drops the cached "off" too, and closes nothing', async () => {
    mockDb.queueResponse({ rows: [{ id: 5, is_active: true }] }, { rows: [{ id: 17 }] });
    await companies.update(5, { is_active: true });
    expect(mockRedis.del).toHaveBeenCalledWith('user:17');
    expect(mockRealtime.disconnectUsers).not.toHaveBeenCalled();
  });

  test('editing only the name leaves sessions alone', async () => {
    mockDb.queueResponse({ rows: [{ id: 5, is_active: true }] });
    await companies.update(5, { company_name: 'Renamed' });
    expect(mockDb.calls()).toHaveLength(1);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  test('a cache that is down does not fail the deactivate — entries expire within a minute', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('redis down'));
    mockDb.queueResponse({ rowCount: 1 }, { rows: [{ id: 17 }] });
    await expect(companies.remove(5)).resolves.toBeUndefined();
    expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([17]);
  });

  test('an unknown company is a 404 and nobody is touched', async () => {
    mockDb.queueResponse({ rowCount: 0 });
    await expect(companies.remove(999)).rejects.toMatchObject({ status: 404 });
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockRealtime.disconnectUsers).not.toHaveBeenCalled();
  });

  test('a company with no users has nothing to clear', async () => {
    mockDb.queueResponse({ rowCount: 1 }, { rows: [] });
    await companies.remove(5);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────── alerts ─────────────────────────── */

describe('alerts stop while the company is off', () => {
  test('alarm emails go only to admins of an active company', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ machine_serial_no: 'VMC-1' }] }, { rows: [] });
    await alarms.sendAlarmEmails(5, 1, 'ALARM', 'x');
    const recipients = mockDb.calls().find(c => /SELECT DISTINCT u\.email/.test(c.text));
    expect(recipients.text).toMatch(/JOIN companies c ON c\.id = u\.company_id AND c\.is_active = true/);
    expect(sendBulkEmails).not.toHaveBeenCalled();
  });

  test('in-app alerts likewise', async () => {
    mockDb.queueResponse({ rows: [{ machine_serial_no: 'VMC-1' }] }, { rows: [], rowCount: 0 });
    await alarms.createAlarmNotification(5, 1, 'ALARM', 'x');
    const users = mockDb.calls()[1];
    expect(users.text).toMatch(/JOIN companies c ON c\.id = u\.company_id AND c\.is_active = true/);
    expect(mockDb.calls().some(c => /INSERT INTO notifications/.test(c.text))).toBe(false);
  });
});
