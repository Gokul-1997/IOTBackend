/*
 * "Manage Access": what S&T decides a company has paid for.
 *
 * Found by tracing the feature end to end rather than trusting that it
 * worked because the modal opened:
 *
 *   - the save wiped every company_permissions row and re-inserted whatever
 *     arrived, with no validation: an unknown id died on a foreign key as a
 *     bare 500, a missing body threw after the DELETE had run, and a company
 *     that did not exist reported success.
 *   - revoking a page changed nothing that enforces it — roles inside the
 *     company kept the permission.
 *   - three of the read endpoints took only a company id from the URL, so any
 *     authenticated user could read any company's details, plan and access.
 *   - an empty save is not "revoke everything": the frontend reads a company
 *     with no grants as unrestricted, so it would have granted everything.
 *
 * Statement order in the service tests follows the code exactly, BEGIN
 * included — the mock hands out queued responses one per statement.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
// Saving clears the grant cache, which requires the Redis client — a real one
// would try to open a connection from inside a unit test.
const mockRedis = { get: jest.fn(), set: jest.fn(), del: jest.fn().mockResolvedValue(1) };
jest.mock('../../src/redis', () => mockRedis);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc  = require('../../src/companies/company.service');
const ctrl = require('../../src/companies/company.controller');

beforeEach(() => resetDb());

const texts = () => mockDb.calls().map(c => c.text);

describe('assignCompanyPermissions — input is checked before anything is touched', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'abc'],
    ['an object', { 0: 1 }]
  ])('%s is refused as 400, with no query at all', async (_label, body) => {
    await expect(svc.assignCompanyPermissions(4, body, 1)).rejects.toMatchObject({ status: 400 });
    // previously: TypeError after the DELETE had already run
    expect(mockDb.calls()).toHaveLength(0);
  });

  test.each([[[1, 'x']], [[1, -3]], [[1.5]], [[0]]])('%j is refused — ids are positive whole numbers', async ids => {
    await expect(svc.assignCompanyPermissions(4, ids, 1)).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('an empty selection is refused, because empty reads as unrestricted, not as locked out', async () => {
    const e = await svc.assignCompanyPermissions(4, [], 1).catch(err => err);
    expect(e.status).toBe(400);
    expect(e.code).toBe('EMPTY_ACCESS');
    expect(e.message).toMatch(/unrestricted/i);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('numeric strings from a form body are accepted, duplicates collapse', async () => {
    mockDb.queueResponse(
      {},                                        // BEGIN
      { rows: [{ id: 4 }] },                     // company exists
      { rows: [{ id: 1 }, { id: 2 }] },          // both are page permissions
      { rows: [] },                              // no current grants
      {},                                        // INSERT
      {}                                         // COMMIT
    );
    const out = await svc.assignCompanyPermissions(4, ['1', 2, 2, '1'], 1);
    expect(out.permission_count).toBe(2);
    expect(out.granted).toBe(2);
  });
});

describe('assignCompanyPermissions — the company and the ids must be real', () => {
  test('a company that does not exist is a 404, not a success', async () => {
    mockDb.queueResponse({}, { rows: [] });
    await expect(svc.assignCompanyPermissions(999, [1], 1)).rejects.toMatchObject({ status: 404 });
    expect(texts()).toEqual(['BEGIN', expect.stringContaining('FROM companies'), 'ROLLBACK']);
  });

  test('an id that is not a page permission is named in a 400, before any write', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 1 }] });   // 77 is missing
    const e = await svc.assignCompanyPermissions(4, [1, 77], 1).catch(err => err);
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/77/);
    expect(texts().some(t => /DELETE|INSERT/.test(t))).toBe(false);
  });

  test('the company row is locked, so two simultaneous saves serialise', async () => {
    mockDb.queueResponse({}, { rows: [] });
    await svc.assignCompanyPermissions(4, [1], 1).catch(() => {});
    expect(mockDb.calls()[1].text).toMatch(/FOR UPDATE/);
  });
});

describe('assignCompanyPermissions — a diff, scoped to page permissions', () => {
  test('only the changes are written: additions inserted, removals deleted, the rest untouched', async () => {
    mockDb.queueResponse(
      {},                                                   // BEGIN
      { rows: [{ id: 4 }] },                                // company
      { rows: [{ id: 2 }, { id: 3 }] },                     // wanted are page perms
      { rows: [{ permission_id: 1 }, { permission_id: 2 }] }, // currently granted: 1, 2
      {},                                                   // DELETE company_permissions (removes 1)
      {},                                                   // INSERT (adds 3)
      { rowCount: 0, rows: [] },                            // cascade: no role held 1
      {}                                                    // COMMIT
    );
    const out = await svc.assignCompanyPermissions(4, [2, 3], 7);
    expect(out).toMatchObject({ granted: 1, revoked: 1, permission_count: 2 });

    const del = mockDb.calls().find(c => /DELETE FROM company_permissions/.test(c.text));
    expect(del.params).toEqual([4, [1]]);                   // only the removed id
    const ins = mockDb.calls().find(c => /INSERT INTO company_permissions/.test(c.text));
    expect(ins.params).toEqual([4, [3], 7]);                // only the added id, by whom
  });

  test('saving exactly what is already granted writes nothing', async () => {
    mockDb.queueResponse(
      {}, { rows: [{ id: 4 }] }, { rows: [{ id: 1 }, { id: 2 }] },
      { rows: [{ permission_id: 1 }, { permission_id: 2 }] }, {}
    );
    const out = await svc.assignCompanyPermissions(4, [1, 2], 7);
    expect(out).toMatchObject({ granted: 0, revoked: 0, revoked_from_roles: 0 });
    expect(texts().some(t => /DELETE|INSERT/.test(t))).toBe(false);
  });

  test('the current-grants read is limited to page permissions, so legacy keys are never deleted', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 1 }] }, { rows: [] }, {}, {});
    await svc.assignCompanyPermissions(4, [1], 1);
    const read = mockDb.calls().find(c => /FROM company_permissions cp/.test(c.text));
    expect(read.text).toMatch(/permission_key LIKE 'page:%'/);
  });

  test('a failure part-way rolls back and releases the connection', async () => {
    const boom = new Error('deadlock detected');
    mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 1 }] }, { rows: [] });
    mockDb.queueError(boom);                                // the INSERT fails
    await expect(svc.assignCompanyPermissions(4, [1], 1)).rejects.toBe(boom);
    expect(texts()).toContain('ROLLBACK');
  });
});

describe('assignCompanyPermissions — a revoke has to bite at once', () => {
  beforeEach(() => mockRedis.del.mockClear());

  test('the cached grants are cleared after a save, so the API stops honouring a revoked page immediately', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 2 }] },
      { rows: [{ permission_id: 1 }, { permission_id: 2 }] }, {}, { rowCount: 0, rows: [] }, {});
    await svc.assignCompanyPermissions(4, [2], 1);
    expect(mockRedis.del).toHaveBeenCalledWith('company_grants:4');
  });

  test('nothing is cleared when the save was refused', async () => {
    await svc.assignCompanyPermissions(4, [], 1).catch(() => {});
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  test('a cache failure does not undo or fail a save that already committed', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('redis down'));
    mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 2 }] }, { rows: [] }, {}, {});
    await expect(svc.assignCompanyPermissions(4, [2], 1)).resolves.toMatchObject({ granted: 1 });
  });
});

describe('assignCompanyPermissions — revoking cascades to the company\'s own roles', () => {
  const revokeOne = () => mockDb.queueResponse(
    {}, { rows: [{ id: 4 }] }, { rows: [{ id: 2 }] },
    { rows: [{ permission_id: 1 }, { permission_id: 2 }] },   // had 1 and 2, keeps 2
    {},                                                        // DELETE company_permissions
    { rowCount: 3, rows: [{ role_id: 10 }, { role_id: 10 }, { role_id: 11 }] }, // cascade
    // role 10 keeps the Machines page: its API keys are re-derived from it
    { rows: [{ id: 2 }] },
    { rows: [{ id: 2, permission_key: 'page:machines:view' }] }, {}, {},
    // role 11 has no pages left, so no API keys either
    { rows: [] }, { rows: [] }, {}, {},
    {}                                                         // COMMIT
  );

  test('removed pages are stripped from custom roles of THAT company only', async () => {
    revokeOne();
    const out = await svc.assignCompanyPermissions(4, [2], 1);
    expect(out.revoked_from_roles).toBe(3);

    const cascade = mockDb.calls().find(c => /DELETE FROM role_permissions/.test(c.text));
    expect(cascade.text).toMatch(/ro\.company_id = \$1/);
    expect(cascade.text).toMatch(/ro\.is_system = false/);   // shared system roles are not narrowed
    expect(cascade.params).toEqual([4, [1]]);
  });

  test('the count is reported, so the caller is not left assuming more happened than did', async () => {
    revokeOne();
    expect(await svc.assignCompanyPermissions(4, [2], 1)).toEqual({
      company_id: 4, permission_count: 1, granted: 0, revoked: 1, revoked_from_roles: 3
    });
  });

  /* A removed page also takes away the older machine.view-style keys it
     needed; otherwise the role-only routes that check those keys would keep
     answering for a page the company no longer has. Each touched role is
     re-derived once, from the pages it still holds. */
  test('a removed page takes its API keys with it — each touched role re-derived once', async () => {
    revokeOne();
    await svc.assignCompanyPermissions(4, [2], 1);
    const inserts = mockDb.calls().filter(c => /INSERT INTO role_permissions/.test(c.text));
    expect(inserts.map(c => c.params[0])).toEqual([10, 11]);   // not 10 twice
    expect(inserts[0].params[2]).toEqual(['machine.view', 'line.view']);
    expect(inserts[1].params[2]).toEqual([]);
  });

  test('granting alone never touches role_permissions', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 1 }, { id: 2 }] },
      { rows: [{ permission_id: 1 }] }, {}, {});
    await svc.assignCompanyPermissions(4, [1, 2], 1);
    expect(texts().some(t => /role_permissions/.test(t))).toBe(false);
  });
});

describe('who may read a company\'s details, plan features and page access', () => {
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = jest.fn(code => { r.statusCode = code; return r; });
    r.json   = jest.fn(b => { r.body = b; return r; });
    return r;
  };
  const own   = { company_id: 4, is_snt_super: false };
  const super_ = { company_id: null, is_snt_super: true };

  test.each(['getById', 'getPlanFeatures', 'getCompanyPermissions'])(
    '%s: another company\'s id is refused before the database is touched', async fn => {
      const r = res();
      const next = jest.fn();
      await ctrl[fn]({ params: { id: '9' }, user: own }, r, next);
      expect(r.statusCode).toBe(403);
      expect(mockDb.calls()).toHaveLength(0);
      expect(next).not.toHaveBeenCalled();
    });

  test.each(['getById', 'getPlanFeatures', 'getCompanyPermissions'])(
    '%s: a caller with no company at all reads nothing', async fn => {
      const r = res();
      await ctrl[fn]({ params: { id: '4' }, user: { company_id: null, is_snt_super: false } }, r, jest.fn());
      expect(r.statusCode).toBe(403);
      expect(mockDb.calls()).toHaveLength(0);
    });

  test('a company admin still reads their own company\'s access', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, permission_key: 'page:dashboard:view' }] });
    const r = res();
    await ctrl.getCompanyPermissions({ params: { id: '4' }, user: own }, r, jest.fn());
    expect(r.statusCode).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  test('a super admin reads any company\'s access — the Manage Access modal depends on it', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, permission_key: 'page:dashboard:view' }] });
    const r = res();
    await ctrl.getCompanyPermissions({ params: { id: '9' }, user: super_ }, r, jest.fn());
    expect(r.statusCode).toBe(200);
  });
});
