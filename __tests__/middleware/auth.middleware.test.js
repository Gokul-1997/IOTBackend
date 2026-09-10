/*
 * Unit tests for auth.middleware.js
 *
 * Covers:
 *  TC-AM-01  401 when Authorization header missing
 *  TC-AM-02  401 when Authorization header not "Bearer ..."
 *  TC-AM-03  401 when JWT is invalid / expired
 *  TC-AM-04  403 when user is inactive (Redis cache path)
 *  TC-AM-05  req.user populated correctly from Redis cache
 *  TC-AM-06  DB fallback when Redis cache miss
 *  TC-AM-07  401 when user not found in DB (cache miss path)
 *  TC-AM-08  403 when user inactive in DB (cache miss path)
 *  TC-AM-09  req.user populated correctly from DB
 *  TC-AM-10  SNT_SUPER role derived from JWT
 *  TC-AM-11  is_snt_super true when decoded.is_snt_super is true
 *  TC-AM-12  401 when an unexpected error is thrown
 */

jest.mock('../../src/db',    () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/redis', () => ({
  get:   jest.fn(),
  setex: jest.fn(async () => 'OK')
}));
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn()
}));

const jwt    = require('jsonwebtoken');
const redis  = require('../../src/redis');
const { mockDb, resetDb } = require('../helpers/mockDb');
const middleware = require('../../src/middleware/auth.middleware');

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _status: null,
    _body:   null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body  = body;  return this; }
  };
  return res;
}

function makeReq(token) {
  return {
    headers: {
      authorization: token ? `Bearer ${token}` : undefined
    }
  };
}

const DECODED_BASE = {
  user_id:    1,
  company_id: 4,
  plant_id:   1,
  user_type:  'ADMIN',
  roles:      ['ADMIN'],
  permissions: ['page:dashboard'],
  is_snt_super: false,
  plan: null
};

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
  redis.get.mockResolvedValue(null);   // cache miss by default
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing / malformed header
// ─────────────────────────────────────────────────────────────────────────────

test('TC-AM-01 401 when Authorization header missing', async () => {
  const req = { headers: {} };
  const res = makeRes();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(401);
  expect(res._body.message).toMatch(/token missing/i);
});

test('TC-AM-02 401 when Authorization header lacks Bearer prefix', async () => {
  const req = { headers: { authorization: 'Token abc123' } };
  const res = makeRes();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(401);
});

// ─────────────────────────────────────────────────────────────────────────────
// Invalid JWT
// ─────────────────────────────────────────────────────────────────────────────

test('TC-AM-03 401 when JWT verify throws (expired / tampered)', async () => {
  jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });

  const res  = makeRes();
  const next = jest.fn();

  await middleware(makeReq('bad-token'), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(401);
  expect(res._body.message).toMatch(/expired or invalid/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Redis cache hit
// ─────────────────────────────────────────────────────────────────────────────

test('TC-AM-04 403 when cached user is inactive', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockResolvedValue(JSON.stringify({ id: 1, is_active: false }));

  const res  = makeRes();
  const next = jest.fn();

  await middleware(makeReq('valid-token'), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(403);
  expect(res._body.message).toMatch(/inactive/i);
});

test('TC-AM-05 req.user populated correctly from Redis cache', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockResolvedValue(JSON.stringify({
    id: 1, username: 'alice', plant_id: 1, company_id: 4,
    user_type: 'ADMIN', is_active: true
  }));

  const req  = makeReq('valid-token');
  const res  = makeRes();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(next).toHaveBeenCalled();
  expect(req.user.id).toBe(1);
  expect(req.user.username).toBe('alice');
  expect(req.user.roles).toEqual(['ADMIN']);
  expect(req.user.permissions).toEqual(['page:dashboard']);
  expect(req.user.is_snt_super).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// DB fallback (cache miss)
// ─────────────────────────────────────────────────────────────────────────────

test('TC-AM-06 DB is queried on Redis cache miss', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockResolvedValue(null);

  mockDb.queueResponse({
    rows: [{ id: 1, username: 'bob', plant_id: 1, company_id: 4, user_type: 'ADMIN', is_active: true }]
  });

  const req  = makeReq('valid-token');
  const res  = makeRes();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(mockDb.calls()).toHaveLength(1);
  expect(next).toHaveBeenCalled();
});

test('TC-AM-07 401 when user not found in DB', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockResolvedValue(null);
  mockDb.queueResponse({ rows: [] });

  const res  = makeRes();
  const next = jest.fn();

  await middleware(makeReq('valid-token'), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(401);
  expect(res._body.message).toMatch(/User not found/i);
});

test('TC-AM-08 403 when user inactive in DB', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockResolvedValue(null);
  mockDb.queueResponse({
    rows: [{ id: 1, username: 'dave', plant_id: 1, company_id: 4, user_type: 'ADMIN', is_active: false }]
  });

  const res  = makeRes();
  const next = jest.fn();

  await middleware(makeReq('valid-token'), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(403);
  expect(res._body.message).toMatch(/inactive/i);
});

test('TC-AM-09 req.user populated from DB and cached in Redis', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockResolvedValue(null);

  mockDb.queueResponse({
    rows: [{ id: 1, username: 'carol', plant_id: 1, company_id: 4, user_type: 'ADMIN', is_active: true }]
  });

  const req  = makeReq('valid-token');
  const res  = makeRes();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(next).toHaveBeenCalled();
  expect(req.user.username).toBe('carol');
  expect(req.user.company_id).toBe(4);
  expect(redis.setex).toHaveBeenCalledWith(
    'user:1',
    60,
    expect.any(String)   // JSON string
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// is_snt_super derivation
// ─────────────────────────────────────────────────────────────────────────────

test('TC-AM-10 is_snt_super = true when role is SNT_SUPER', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE, roles: ['SNT_SUPER'] });
  redis.get.mockResolvedValue(JSON.stringify({
    id: 1, username: 'super', plant_id: 1, company_id: 4, user_type: 'ADMIN', is_active: true
  }));

  const req  = makeReq('valid-token');
  await middleware(req, makeRes(), jest.fn());

  expect(req.user.is_snt_super).toBe(true);
});

test('TC-AM-11 is_snt_super = true when decoded.is_snt_super flag is true', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE, roles: ['ADMIN'], is_snt_super: true });
  redis.get.mockResolvedValue(JSON.stringify({
    id: 1, username: 'flagged', plant_id: 1, company_id: 4, user_type: 'ADMIN', is_active: true
  }));

  const req  = makeReq('valid-token');
  await middleware(req, makeRes(), jest.fn());

  expect(req.user.is_snt_super).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Unexpected error path
// ─────────────────────────────────────────────────────────────────────────────

test('TC-AM-12 401 when an unexpected error occurs during processing', async () => {
  jwt.verify.mockReturnValue({ ...DECODED_BASE });
  redis.get.mockRejectedValue(new Error('Redis down'));

  const res  = makeRes();
  const next = jest.fn();

  await middleware(makeReq('valid-token'), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res._status).toBe(401);
  expect(res._body.message).toMatch(/Unauthorized/i);
});
