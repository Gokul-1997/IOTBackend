/* Authoritative authorization checks PostgreSQL; cached rows never preserve
 * revoked grants. These tests exercise the actual middleware and ALS scope. */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/redis', () => ({ get: jest.fn(), setex: jest.fn(), del: jest.fn() }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
const jwt = require('jsonwebtoken');
const redis = require('../../src/redis');
const { mockDb, resetDb } = require('../helpers/mockDb');
const auth = require('../../src/middleware/auth.middleware');
const readScope = require('../../src/lib/read-scope');
const token = { user_id: 1, company_id: 999, plant_id: 999, user_type: 'OLD', roles: ['QUALITY'], permissions: ['page:quality:edit'] };
const user = { id: 1, username: 'alice', plant_id: 11, company_id: 4, user_type: 'company_user', is_active: true, company_active: true, auth_revision: '0' };
const req = () => ({ headers: { authorization: 'Bearer signed-token' } });
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
beforeEach(() => { resetDb(); jest.clearAllMocks(); jwt.verify.mockReturnValue({ ...token }); });
afterEach(() => jest.restoreAllMocks());

test('license expiry blocks the authenticated request using trusted database company scope', async () => {
  const gate=jest.spyOn(require('../../src/licensing/runtime'),'assertAccess').mockRejectedValueOnce(Object.assign(new Error('Subscription expired'),{status:403,code:'LICENSE_EXPIRED'}));
  mockDb.queueResponse({rows:[user]});const response=res(),next=jest.fn();await auth(req(),response,next);
  expect(gate).toHaveBeenCalledWith(expect.objectContaining({company_id:4}));expect(response.status).toHaveBeenCalledWith(403);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({code:'LICENSE_EXPIRED'}));expect(next).not.toHaveBeenCalled();
});

test.each([undefined, '', 'Token abc'])('missing or wrong Bearer header %s is refused before lookup', async header => {
  const response = res(); const next = jest.fn();
  await auth({ headers: { authorization: header } }, response, next);
  expect(response.status).toHaveBeenCalledWith(401);
  expect(mockDb.calls()).toHaveLength(0); expect(next).not.toHaveBeenCalled();
});
test('invalid JWT is refused before lookup', async () => {
  jwt.verify.mockImplementation(() => { throw new Error('expired'); });
  const response = res(); await auth(req(), response, jest.fn());
  expect(response.status).toHaveBeenCalledWith(401); expect(mockDb.calls()).toHaveLength(0);
});
test.each([undefined, null, -1, 'abc'])('invalid signed user id %s is refused', async id => {
  jwt.verify.mockReturnValue({ ...token, user_id: id }); const response = res();
  await auth(req(), response, jest.fn()); expect(response.status).toHaveBeenCalledWith(401);
  expect(mockDb.calls()).toHaveLength(0);
});
test('one trusted indexed lookup supplies scope and preserves ALS; missing revision is zero', async () => {
  mockDb.queueResponse({ rows: [user] }); const request = req(); const next = jest.fn(() => {
    expect(readScope.current()).toMatchObject({ companyId: 4, plantId: 11 });
  });
  await auth(request, res(), next); expect(next).toHaveBeenCalledTimes(1);
  expect(request.user).toMatchObject({ id: 1, company_id: 4, plant_id: 11, user_type: 'company_user', auth_revision: '0', roles: ['QUALITY'], permissions: ['page:quality:edit'] });
  expect(mockDb.calls()).toHaveLength(1); expect(mockDb.calls()[0]).toMatchObject({ params: [1] });
  expect(mockDb.calls()[0].text).toMatch(/WHERE u\.id = \$1/);
  expect(redis.get).not.toHaveBeenCalled(); expect(redis.setex).not.toHaveBeenCalled();
});
test('trusted null company cannot fall back to the JWT company', async () => {
  mockDb.queueResponse({ rows: [{ ...user, company_id: null }] }); const request = req();
  await auth(request, res(), jest.fn()); expect(request.user.company_id).toBeNull();
});
test('stale active cache is ignored after disabling an account', async () => {
  redis.get.mockResolvedValue(JSON.stringify(user)); mockDb.queueResponse({ rows: [{ ...user, is_active: false }] });
  const response = res(); const next = jest.fn(); await auth(req(), response, next);
  expect(response.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  expect(redis.get).not.toHaveBeenCalled();
});
test('disabled company is refused from the current DB row', async () => {
  mockDb.queueResponse({ rows: [{ ...user, company_active: false }] }); const response = res();
  await auth(req(), response, jest.fn()); expect(response.status).toHaveBeenCalledWith(401);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'COMPANY_DISABLED' }));
});
test('deleted account is refused', async () => {
  mockDb.queueResponse({ rows: [] }); const response = res(); await auth(req(), response, jest.fn());
  expect(response.status).toHaveBeenCalledWith(401);
});
test('old JWT role grants are rejected immediately after revision advances', async () => {
  mockDb.queueResponse({ rows: [{ ...user, auth_revision: '1' }] }); const response = res(); const next = jest.fn();
  await auth(req(), response, next); expect(response.status).toHaveBeenCalledWith(401);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REVISION_CHANGED' }));
  expect(next).not.toHaveBeenCalled();
});
test('successive requests recheck the revision even when a cache entry exists', async () => {
  redis.get.mockResolvedValue(JSON.stringify(user)); mockDb.queueResponse({ rows: [user] }, { rows: [{ ...user, auth_revision: '1' }] });
  const first = jest.fn(); await auth(req(), res(), first); expect(first).toHaveBeenCalled();
  const response = res(); await auth(req(), response, jest.fn()); expect(response.status).toHaveBeenCalledWith(401);
  expect(mockDb.calls()).toHaveLength(2); expect(redis.get).not.toHaveBeenCalled();
});
test.each([null, '01', '-1', '1.1', 9007199254740992])('invalid token revision %s is refused', async revision => {
  jwt.verify.mockReturnValue({ ...token, auth_revision: revision }); mockDb.queueResponse({ rows: [user] });
  const response = res(); await auth(req(), response, jest.fn()); expect(response.status).toHaveBeenCalledWith(401);
});
test('BIGINT revision comparison preserves precision above JavaScript safe integers', async () => {
  jwt.verify.mockReturnValue({ ...token, auth_revision: '9007199254740993' });
  mockDb.queueResponse({ rows: [{ ...user, auth_revision: '9007199254740993' }] }, { rows: [{ ...user, auth_revision: '9007199254740992' }] });
  const next = jest.fn(); await auth(req(), res(), next); expect(next).toHaveBeenCalled();
  const response = res(); await auth(req(), response, jest.fn()); expect(response.status).toHaveBeenCalledWith(401);
});
test('DB outage returns retryable503 and never falls back to stale cache', async () => {
  redis.get.mockResolvedValue(JSON.stringify(user)); mockDb.queueError(new Error('database down')); const response = res();
  await auth(req(), response, jest.fn()); expect(response.status).toHaveBeenCalledWith(503);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_UNAVAILABLE' }));
  expect(redis.get).not.toHaveBeenCalled();
});
test('Redis cannot block authoritative authentication', async () => {
  redis.get.mockRejectedValue(new Error('redis down')); redis.setex.mockRejectedValue(new Error('redis down'));
  mockDb.queueResponse({ rows: [user] }); const next = jest.fn(); await auth(req(), res(), next);
  expect(next).toHaveBeenCalled(); expect(redis.get).not.toHaveBeenCalled();
});
