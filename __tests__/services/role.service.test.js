/*
 * roles/role.service.js had no test file before this one.
 *
 * Four gaps found by tracing every code path a company admin can reach,
 * not just the ones already covered by a guard:
 *
 *   - list() and listPermissions() had a third, unscoped branch reachable
 *     whenever the caller is neither a confirmed super admin nor has a
 *     known company_id (the column is nullable) — it ran the query with
 *     no WHERE clause and returned every company's data.
 *   - getById() took only an id, with no actor at all: any admin-tier user
 *     could read any company's role and its full permission list by
 *     requesting its id.
 *   - assignPermissions() validated the requested permission ids against
 *     the caller's company, but never checked the ROLE belonged to them,
 *     and never excluded system roles — a company admin could overwrite
 *     the permission set of another tenant's role, or of SNT_SUPER itself,
 *     as long as the ids they asked for were within their own company's
 *     allowed set.
 *
 * update(), remove() and assign() already had the loadRoleFor guard before
 * this file existed; they get lighter coverage here to confirm that stays
 * true, not to re-derive it.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/roles/role.service');

beforeEach(() => resetDb());

const sntSuper = { is_snt_super: true };
const companyA = { is_snt_super: false, company_id: 4 };
const companyB = { is_snt_super: false, company_id: 5 };
/* The exact shape a nullable users.company_id produces once decoded off
   the JWT — not a hypothetical, the column allows it today. */
const noCompany = { is_snt_super: false, company_id: null };

describe('list()', () => {
  test('SNT_SUPER sees every company\'s roles, joined with company_name', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, role_name: 'SETTER', company_id: 4, company_name: 'S AND T' }] });
    mockDb.queueResponse({ rows: [] }); // per-role permissions fetch
    const rows = await svc.list({ is_snt_super: true, company_id: null });
    expect(rows).toHaveLength(1);
    const { text: sql } = mockDb.calls()[0];
    expect(sql).toMatch(/LEFT JOIN companies/);
  });

  /* This used to filter on company_id alone, which hid every system role —
     and the whole default set (Supervisor, Maintenance, Quality, Setter, HR)
     lives with company_id NULL, so a company admin could see none of them
     and had nothing to assign a new user to. */
  test('a company admin sees their own roles AND the shared system roles', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, role_name: 'SETTER', company_id: 4 }] });
    mockDb.queueResponse({ rows: [] });
    await svc.list({ is_snt_super: false, company_id: 4 });
    const { text: sql, params } = mockDb.calls()[0];
    expect(sql).toMatch(/r\.company_id = \$1/);
    expect(sql).toMatch(/r\.company_id IS NULL AND r\.is_system = true/);
    expect(params[0]).toBe(4);
  });

  test('but never SNT_SUPER — that one is the platform\'s, not a company\'s', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list({ is_snt_super: false, company_id: 4 });
    const { text: sql, params } = mockDb.calls()[0];
    expect(sql).toMatch(/role_name <> ALL \(\$2::text\[\]\)/);
    expect(params[1]).toContain('SNT_SUPER');
  });

  /* company_id NULL and is_system false belongs to nobody — it cannot be
     reached through any company's list, and must not leak into one. */
  test('an orphaned role stays hidden', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list({ is_snt_super: false, company_id: 4 });
    expect(mockDb.calls()[0].text).toMatch(/r\.company_id IS NULL AND r\.is_system = true/);
  });

  test('neither SNT_SUPER nor a known company: empty, not every company\'s roles', async () => {
    const rows = await svc.list({ is_snt_super: false, company_id: null });
    expect(rows).toEqual([]);
    // fails closed before touching the database at all
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('called with nothing at all behaves the same as no company', async () => {
    expect(await svc.list()).toEqual([]);
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('listPermissions()', () => {
  test('SNT_SUPER gets the unfiltered catalogue', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, permission_key: 'page:dashboard:view', description: '' }] });
    const grouped = await svc.listPermissions({ is_snt_super: true, company_id: null });
    expect(Object.keys(grouped).length).toBeGreaterThan(0);
  });

  test('a company sees only what it has been granted', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.listPermissions({ is_snt_super: false, company_id: 4 });
    const { text: sql, params } = mockDb.calls()[0];
    expect(sql).toMatch(/cp\.company_id = \$1 AND cp\.permission_id = p\.id/);
    expect(params).toEqual([4]);
  });

  /* A company with no grants at all is unrestricted everywhere else in the
     app. This used to return nothing for it, so its role editor was empty
     and the admin could not build a role. */
  test('a company with no grants at all sees the whole catalogue, not nothing', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.listPermissions({ is_snt_super: false, company_id: 4 });
    expect(mockDb.calls()[0].text).toMatch(/NOT EXISTS \(SELECT 1 FROM company_permissions x/);
  });

  test('neither SNT_SUPER nor a known company: empty, not the full catalogue', async () => {
    const grouped = await svc.listPermissions({ is_snt_super: false, company_id: null });
    expect(grouped).toEqual([]);
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('getById()', () => {
  test('SNT_SUPER can read any role', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 5 }] });
    mockDb.queueResponse({ rows: [{ id: 1, permission_key: 'page:machines:view' }] });
    const role = await svc.getById(10, sntSuper);
    expect(role.role_name).toBe('SETTER');
    expect(role.permissions).toHaveLength(1);
  });

  test('a company admin can read their own company\'s role', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 4 }] });
    mockDb.queueResponse({ rows: [] });
    const role = await svc.getById(10, companyA);
    expect(role.role_name).toBe('SETTER');
  });

  test('the bug: a company admin could read ANY company\'s role by id — now 404', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 5 }] });
    await expect(svc.getById(10, companyA)).rejects.toMatchObject({ status: 404 });
  });

  test('a caller with no company_id reads nothing, even a role that exists', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 4 }] });
    await expect(svc.getById(10, noCompany)).rejects.toMatchObject({ status: 404 });
  });

  test('a role that does not exist and a role belonging to someone else both read as the same 404', async () => {
    mockDb.queueResponse({ rows: [] });
    const missing = await svc.getById(999, companyA).catch(e => e);
    mockDb.queueResponse({ rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 5 }] });
    const belongsToOther = await svc.getById(10, companyA).catch(e => e);
    expect(missing.status).toBe(belongsToOther.status);
    expect(missing.message).toBe(belongsToOther.message);
  });
});

describe('assignPermissions()', () => {
  test('a company admin can assign permissions to their own custom role', async () => {
    mockDb.queueResponse(
      {},                                                                            // BEGIN
      { rows: [{ id: 10, role_name: 'LINE LEAD', is_system: false, company_id: 4 }] },  // loadRoleFor
      { rows: [{ id: 1 }, { id: 2 }] },                                              // which ids are pages
      { rows: [{ permission_id: 1 }, { permission_id: 2 }] },                        // company grants
      { rows: [{ id: 1, permission_key: 'page:machines:view' },
               { id: 2, permission_key: 'page:machines:edit' }] },                  // the pages
      {}, {}, {}                                                                     // DELETE, INSERT, COMMIT
    );
    const out = await svc.assignPermissions(10, [1, 2], companyA);
    expect(out.pages).toBe(2);
    // the pages bring the API keys they need, or the machine list would 403
    expect(out.legacy).toEqual(['machine.view', 'line.view', 'machine.update']);
  });

  test('the bug: assigning to another company\'s role — now blocked before any write', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 5 }] });
    await expect(svc.assignPermissions(10, [1], companyA)).rejects.toMatchObject({ status: 404 });
    // BEGIN, the guard query, and the ROLLBACK the catch block issues —
    // never a DELETE or an INSERT into role_permissions.
    expect(mockDb.calls().map(c => c.text)).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT id, role_name, is_system, company_id FROM roles'),
      'ROLLBACK'
    ]);
  });

  test('a company admin cannot reach a default role to overwrite it', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 51, role_name: 'MAINTENANCE', is_system: true, company_id: null }] });
    await expect(svc.assignPermissions(51, [1], companyA)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls().map(c => c.text)).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT id, role_name, is_system, company_id FROM roles'),
      'ROLLBACK'
    ]);
  });

  /* AWS model: S&T sets what a company can use; the company manages its
     roles. S&T is refused before anything is read or written — including
     SNT_SUPER's own row, which this route once let S&T overwrite. */
  test('S&T is refused before any query — roles are the company admin\'s', async () => {
    await expect(svc.assignPermissions(1, [1], sntSuper))
      .rejects.toMatchObject({ status: 403, message: /managed by each company's admin/ });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a permission outside the company\'s allowed set is refused, not silently dropped', async () => {
    mockDb.queueResponse(
      {},
      { rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 4 }] },
      { rows: [{ id: 1 }, { id: 99 }] },             // both are pages
      { rows: [{ permission_id: 1 }] },              // only permission 1 is allowed
      { rows: [{ permission_key: 'page:machines:delete' }] }
    );
    await expect(svc.assignPermissions(10, [1, 99], companyA))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('update(), remove(), assign() — already guarded; confirming it holds', () => {
  /* Both open a transaction, so BEGIN takes the first queued response. The
     earlier versions of these queued the role first, BEGIN swallowed it, and
     the tests passed on an empty lookup — right answer, wrong reason. */
  test('update() refuses to rename another company\'s role', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 5 }] });
    await expect(svc.update(10, { role_name: 'RENAMED' }, companyA))
      .rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls().some(c => /UPDATE roles/.test(c.text))).toBe(false);
  });

  test('remove() refuses to delete another company\'s role', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 10, role_name: 'SETTER', is_system: false, company_id: 5 }] });
    await expect(svc.remove(10, companyA)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls().some(c => /DELETE FROM roles/.test(c.text))).toBe(false);
  });

  test('assign() refuses to grant a user a role from another company', async () => {
    mockDb.queueResponse(
      {},                                                     // BEGIN
      { rows: [{ id: 20, company_id: 4 }] },                  // target user, same company
      { rows: [{ id: 10, company_id: 5, is_system: false }] } // the role — belongs to company 5
    );
    await expect(svc.assign(20, [10], companyA))
      .rejects.toMatchObject({ status: 403 });
  });
});
