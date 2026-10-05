/*
 * The device token check in front of /api/device/v1.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const { mockDb, resetDb } = require('../helpers/mockDb');
const deviceToken = require('../../src/programs/device-token');
const deviceAuth = require('../../src/middleware/device.middleware');

const { token } = deviceToken.generate();

function run(headers = {}, rows = []) {
  mockDb.queueResponse({ rows, rowCount: rows.length });
  const req = { headers, ip: '203.0.113.9' };
  const res = { status: jest.fn(function (s) { this.code = s; return this; }), json: jest.fn(function (b) { this.body = b; return this; }) };
  const next = jest.fn();
  return deviceAuth(req, res, next).then(() => ({ req, res, next }));
}

const row = (o = {}) => ({
  id: 3, company_id: 5, machine_id: 7, last_seen_at: new Date().toISOString(), last_seen_ip: '203.0.113.9',
  agent_version: '1.0.0', machine_serial_no: 'VMC-1', ip_address: '192.168.200.3', machine_active: true,
  machine_company_id: 5, company_active: true, ...o
});

beforeEach(() => resetDb());

describe('tokens', () => {
  test('generated tokens have the documented shape and are random', () => {
    const a = deviceToken.generate(), b = deviceToken.generate();
    expect(a.token).toMatch(deviceToken.SHAPE);
    expect(a.token).not.toBe(b.token);
    expect(a.prefix).toBe(a.token.slice(0, 12));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('only "Bearer mxd_…" of the right length is read', () => {
    expect(deviceToken.fromRequest({ headers: { authorization: `Bearer ${token}` } })).toBe(token);
    expect(deviceToken.fromRequest({ headers: { authorization: token } })).toBeNull();
    expect(deviceToken.fromRequest({ headers: { authorization: 'Bearer eyJhbGciOi.x.y' } })).toBeNull();   // a user's JWT
    expect(deviceToken.fromRequest({ headers: {} })).toBeNull();
  });
});

describe('device.middleware', () => {
  test('no token: 401, and the database is not asked', async () => {
    resetDb();
    const req = { headers: {} };
    const res = { status: jest.fn(function () { return this; }), json: jest.fn() };
    await deviceAuth(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a token is looked up by its hash, never by the token itself', async () => {
    await run({ authorization: `Bearer ${token}` }, []);
    const q = mockDb.calls()[0];
    expect(q.params).toEqual([deviceToken.hash(token)]);
    expect(q.text).toMatch(/revoked_at IS NULL/);
  });

  test('unknown or revoked: 401 TOKEN_INVALID', async () => {
    const { res, next } = await run({ authorization: `Bearer ${token}` }, []);
    expect(res.code).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  test('a disabled company or a switched-off machine stops the device', async () => {
    let r = await run({ authorization: `Bearer ${token}` }, [row({ company_active: false })]);
    expect([r.res.code, r.res.body.code]).toEqual([403, 'COMPANY_DISABLED']);
    r = await run({ authorization: `Bearer ${token}` }, [row({ machine_active: false })]);
    expect([r.res.code, r.res.body.code]).toEqual([403, 'MACHINE_INACTIVE']);
    r = await run({ authorization: `Bearer ${token}` }, [row({ machine_company_id: 9 })]);
    expect(r.res.code).toBe(403);
  });

  test('accepted: req.device is its one machine; a recent heartbeat is not rewritten', async () => {
    const { req, next } = await run({ authorization: `Bearer ${token}` }, [row()]);
    expect(next).toHaveBeenCalled();
    expect(req.device).toEqual({
      id: 3, company_id: 5,
      machine: { id: 7, company_id: 5, machine_serial_no: 'VMC-1', ip_address: '192.168.200.3' }
    });
    expect(mockDb.calls().some(c => /UPDATE program_devices/.test(c.text))).toBe(false);
  });

  test('a stale heartbeat, a new address or a new agent version is recorded', async () => {
    await run({ authorization: `Bearer ${token}`, 'x-agent-version': '1.1.0' },
              [row({ last_seen_at: new Date(Date.now() - 120_000).toISOString() })]);
    const upd = mockDb.calls().find(c => /UPDATE program_devices/.test(c.text));
    expect(upd.params).toEqual([3, '203.0.113.9', '1.1.0']);
  });
});
