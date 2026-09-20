/*
 * requireAccess: the role's permission AND the company's grant.
 *
 * "Manage Access" used to be enforced nowhere at the API. permission.middleware
 * checks only the user's role; the company-level grant hid menu items in the
 * browser and constrained later role assignment, and nothing more — a page
 * revoked from a company stayed available to anyone who called the endpoint.
 *
 * The rules mirror the frontend's on purpose (auth.service.ts,
 * permission.guard.ts) so the two cannot disagree about who sees a page.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
// jest hoists jest.mock above this line, and only allows variables named mock*
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
jest.mock('../../src/redis', () => mockRedis);
const redis = mockRedis;

const { mockDb, resetDb } = require('../helpers/mockDb');
const requireAccess = require('../../src/middleware/access.middleware');
const { denialFor, loadCompanyGrants, invalidateCompanyGrants } = requireAccess;

const KEY = 'page:analytics-oee:view';

/** The rows company_permissions ⨝ permissions returns. */
const grants = (...keys) => ({ rows: keys.map(permission_key => ({ permission_key })) });

const roleUser = (over = {}) => ({
  id: 5, company_id: 4, is_snt_super: false,
  roles: ['SUPERVISOR'], permissions: [KEY], ...over
});

beforeEach(() => {
  resetDb();
  redis.get.mockReset().mockResolvedValue(null);
  redis.set.mockReset().mockResolvedValue('OK');
  redis.del.mockReset().mockResolvedValue(1);
});

describe('who passes', () => {
  test('SNT_SUPER passes with no lookup at all — it administers every tenant', async () => {
    expect(await denialFor({ is_snt_super: true, company_id: null }, KEY)).toBeNull();
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a role holding the key, in a company that has been granted it', async () => {
    mockDb.queueResponse(grants(KEY, 'page:analytics-alarms:view'));
    expect(await denialFor(roleUser(), KEY)).toBeNull();
  });

  test('a company with no grants at all is fresh and unrestricted — the frontend reads it the same way', async () => {
    mockDb.queueResponse(grants());
    expect(await denialFor(roleUser(), KEY)).toBeNull();
  });

  test('COMPANY_ADMIN is governed by the company grant alone, with no role permission at all', async () => {
    // a shared system role cannot say what one company has paid for; requiring
    // it here would lock every admin out of a page the moment a module was
    // added and nobody remembered to grant the system role
    mockDb.queueResponse(grants(KEY));
    expect(await denialFor(roleUser({ roles: ['COMPANY_ADMIN'], permissions: [] }), KEY)).toBeNull();
  });

  test('the legacy ADMIN role is treated as a company admin, as permission.guard.ts does', async () => {
    mockDb.queueResponse(grants(KEY));
    expect(await denialFor(roleUser({ roles: ['ADMIN'], permissions: [] }), KEY)).toBeNull();
  });
});

describe('who does not', () => {
  test('a role without the key is refused before the company is even looked up', async () => {
    expect(await denialFor(roleUser({ permissions: ['page:machines:view'] }), KEY)).toBe('ROLE');
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a role holding the key does not exceed what the company has bought', async () => {
    mockDb.queueResponse(grants('page:analytics-alarms:view'));       // OEE was revoked
    expect(await denialFor(roleUser(), KEY)).toBe('COMPANY');
  });

  test('a company admin of a company that lost the page is refused — the revoke is real', async () => {
    mockDb.queueResponse(grants('page:analytics-alarms:view'));
    expect(await denialFor(roleUser({ roles: ['COMPANY_ADMIN'], permissions: [] }), KEY)).toBe('COMPANY');
  });

  test('view granted is not export granted — they are separate keys', async () => {
    mockDb.queueResponse(grants(KEY));
    const u = roleUser({ permissions: [KEY, 'page:analytics-oee:export'] });
    expect(await denialFor(u, 'page:analytics-oee:export')).toBe('COMPANY');
  });

  test('a caller with no company is refused, so "no grants means unrestricted" cannot be reached by having no company', async () => {
    expect(await denialFor(roleUser({ company_id: null }), KEY)).toBe('NO_COMPANY');
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('the same for a company admin with no company', async () => {
    expect(await denialFor(roleUser({ roles: ['COMPANY_ADMIN'], company_id: null }), KEY)).toBe('NO_COMPANY');
  });

  test.each([[undefined], [null], ['page:analytics-oee:view'], [{}]])(
    'a malformed permissions value (%p) grants nothing rather than throwing', async bad => {
      expect(await denialFor(roleUser({ permissions: bad }), KEY)).toBe('ROLE');
    });

  test('no user at all', async () => {
    expect(await denialFor(undefined, KEY)).toBe('NO_USER');
  });
});

describe('the middleware', () => {
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = jest.fn(c => { r.statusCode = c; return r; });
    r.json   = jest.fn(b => { r.body = b; return r; });
    return r;
  };

  test('calls next() when the caller passes', async () => {
    mockDb.queueResponse(grants(KEY));
    const next = jest.fn(); const r = res();
    await requireAccess(KEY)({ user: roleUser() }, r, next);
    expect(next).toHaveBeenCalledWith();
    expect(r.status).not.toHaveBeenCalled();
  });

  test('a page outside the plan is a 403 that says so and names the code', async () => {
    mockDb.queueResponse(grants('page:analytics-alarms:view'));
    const r = res();
    await requireAccess(KEY)({ user: roleUser() }, r, jest.fn());
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('NOT_IN_PLAN');
    expect(r.body.message).toMatch(/plan does not include/i);
    expect(r.body.required).toBe(KEY);
  });

  test('a missing role permission is a plain 403, not a plan message', async () => {
    const r = res();
    await requireAccess(KEY)({ user: roleUser({ permissions: [] }) }, r, jest.fn());
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
  });

  test('no user is a 401', async () => {
    const r = res();
    await requireAccess(KEY)({}, r, jest.fn());
    expect(r.statusCode).toBe(401);
  });

  test('a database failure goes to the error handler, not a hung request', async () => {
    mockDb.queueError(new Error('connection reset'));
    const next = jest.fn(); const r = res();
    await requireAccess(KEY)({ user: roleUser() }, r, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(r.status).not.toHaveBeenCalled();
  });

  test('advertises the key it enforces, for the catalogue scan', () => {
    expect(requireAccess(KEY).requiredPermission).toBe(KEY);
  });
});

describe('the grant cache', () => {
  test('a hit answers without touching the database', async () => {
    redis.get.mockResolvedValue(JSON.stringify([KEY]));
    const set = await loadCompanyGrants(4);
    expect([...set]).toEqual([KEY]);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a miss reads the database and stores it for a minute', async () => {
    mockDb.queueResponse(grants(KEY));
    await loadCompanyGrants(4);
    expect(redis.set).toHaveBeenCalledWith('company_grants:4', JSON.stringify([KEY]), 'EX', 60);
  });

  test('an unrestricted company is cached too — an empty list is a real answer', async () => {
    mockDb.queueResponse(grants());
    await loadCompanyGrants(4);
    expect(redis.set).toHaveBeenCalledWith('company_grants:4', '[]', 'EX', 60);
  });

  test('a cached empty list still reads as unrestricted', async () => {
    redis.get.mockResolvedValue('[]');
    expect(await denialFor(roleUser(), KEY)).toBeNull();
  });

  test('Redis failing never takes a page down — the database answers', async () => {
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    mockDb.queueResponse(grants(KEY));
    expect(await denialFor(roleUser(), KEY)).toBeNull();
  });

  test('companies do not share an entry', async () => {
    mockDb.queueResponse(grants(KEY));
    await loadCompanyGrants(4);
    mockDb.queueResponse(grants(KEY));
    await loadCompanyGrants(9);
    expect(redis.get.mock.calls.map(c => c[0])).toEqual(['company_grants:4', 'company_grants:9']);
  });

  test('saving Manage Access clears the entry, so a revoke bites at once', async () => {
    await invalidateCompanyGrants(4);
    expect(redis.del).toHaveBeenCalledWith('company_grants:4');
  });

  test('a failure clearing it is swallowed — it expires within a minute anyway', async () => {
    redis.del.mockRejectedValue(new Error('down'));
    await expect(invalidateCompanyGrants(4)).resolves.toBeUndefined();
  });
});
