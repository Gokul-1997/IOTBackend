/*
 * syncDefaultRoles — what runs on every app start to keep the default roles
 * the same in every company.
 *
 * The guarantees worth pinning:
 *   - the roles are created with company_id NULL, so one row serves every
 *     tenant. A per-company copy would let "Supervisor" drift apart.
 *   - page:% keys are authoritative: a key dropped from the definition is
 *     removed from the role, not left behind.
 *   - legacy machine.view-style keys are insert-only, because the legacy
 *     seeder grants the same keys to the older system roles on the same
 *     pass and a delete here would fight it.
 *   - role_name is UNIQUE across all companies, so a company may already
 *     own one of these names. That company keeps its role.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { syncDefaultRoles } = require('../../src/roles/role.service');
const { resolveDefaultRoles } = require('../../src/roles/default-roles');

const DEFAULTS = resolveDefaultRoles();

/** Answers the per-role id lookup so every role is processed. */
function queueRoleIds(ids = DEFAULTS.map((_, i) => 100 + i)) {
  for (const id of ids) {
    mockDb.queueResponse({ rows: [] });                 // the upsert
    mockDb.queueResponse({ rows: id === null ? [] : [{ id }] });  // the id lookup
    mockDb.queueResponse({ rows: [], rowCount: 0 });    // the delete
    mockDb.queueResponse({ rows: [], rowCount: 0 });    // the insert
  }
}

const client = () => mockDb;

beforeEach(() => resetDb());

describe('syncDefaultRoles — the shape of the guarantee', () => {
  test('creates every default role as a system role owned by no company', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());

    const upserts = mockDb.calls().filter(c => /INSERT INTO roles/.test(c.text));
    expect(upserts).toHaveLength(DEFAULTS.length);
    for (const c of upserts) {
      expect(c.text).toMatch(/VALUES \(\$1, \$2, true, NULL\)/);
    }
    expect(upserts.map(c => c.params[0]))
      .toEqual(['SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR']);
  });

  test('a re-run updates the description rather than failing on the unique name', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());
    const upsert = mockDb.calls().find(c => /INSERT INTO roles/.test(c.text));
    expect(upsert.text).toMatch(/ON CONFLICT \(role_name\) DO UPDATE/);
    expect(upsert.text).toMatch(/SET description = EXCLUDED\.description/);
  });

  /* role_name is globally unique. Without this guard the upsert would take
     over a role a company created for itself and flip it to a system role,
     silently changing who that company's users are. */
  test('will not take over a role a company already owns', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());
    const upsert = mockDb.calls().find(c => /INSERT INTO roles/.test(c.text));
    expect(upsert.text).toMatch(/WHERE roles\.company_id IS NULL/);

    const lookup = mockDb.calls().find(c => /SELECT id FROM roles/.test(c.text));
    expect(lookup.text).toMatch(/company_id IS NULL/);
  });

  test('a name a company owns is skipped entirely — no grants are written for it', async () => {
    // the first role's id lookup comes back empty: a company holds that name
    mockDb.queueResponse({ rows: [] });          // upsert
    mockDb.queueResponse({ rows: [] });          // id lookup → nothing
    for (let i = 1; i < DEFAULTS.length; i++) {
      mockDb.queueResponse({ rows: [] });
      mockDb.queueResponse({ rows: [{ id: 200 + i }] });
      mockDb.queueResponse({ rows: [], rowCount: 0 });
      mockDb.queueResponse({ rows: [], rowCount: 0 });
    }

    const summary = await syncDefaultRoles(client());
    expect(summary.map(s => s.role)).not.toContain('SUPERVISOR');
    expect(summary).toHaveLength(DEFAULTS.length - 1);

    const touched = mockDb.calls()
      .filter(c => /role_permissions/.test(c.text))
      .map(c => c.params[0]);
    expect(touched).not.toContain(100);
  });
});

describe('syncDefaultRoles — page keys are authoritative', () => {
  test('removes page keys the definition no longer lists', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());

    const del = mockDb.calls().find(c => /DELETE FROM role_permissions/.test(c.text));
    expect(del.text).toMatch(/p\.permission_key LIKE 'page:%'/);
    expect(del.text).toMatch(/NOT \(p\.permission_key = ANY\(\$2::text\[\]\)\)/);
    expect(del.params[1]).toEqual(DEFAULTS[0].permissions);
  });

  /* The legacy keys are shared with LEGACY_API_PERMISSIONS, which grants
     them to the older system roles on the same pass. Deleting from that
     set here would undo the other seeder's work on every restart. */
  test('never deletes a legacy key', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());

    for (const c of mockDb.calls().filter(c => /DELETE FROM role_permissions/.test(c.text))) {
      expect(c.text).toMatch(/LIKE 'page:%'/);
      expect(c.params[1].every(k => k.startsWith('page:'))).toBe(true);
    }
  });

  test('grants page keys and legacy keys together, ignoring ones already held', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());

    const ins = mockDb.calls().find(c => /INSERT INTO role_permissions/.test(c.text));
    expect(ins.text).toMatch(/ON CONFLICT DO NOTHING/);
    expect(ins.params[1]).toEqual([...DEFAULTS[0].permissions, ...DEFAULTS[0].legacy]);
  });

  test('every write is scoped to the one role it is syncing', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());

    for (const c of mockDb.calls().filter(c => /role_permissions/.test(c.text))) {
      expect(typeof c.params[0]).toBe('number');
      expect(c.params[0]).toBeGreaterThanOrEqual(100);
    }
  });

  test('nothing touches a company-owned role or a company grant', async () => {
    queueRoleIds();
    await syncDefaultRoles(client());

    for (const c of mockDb.calls()) {
      expect(c.text).not.toMatch(/company_permissions/);
      expect(c.text).not.toMatch(/DELETE FROM roles/);
    }
  });

  test('reports what it changed, per role', async () => {
    for (const _ of DEFAULTS) {
      mockDb.queueResponse({ rows: [] });
      mockDb.queueResponse({ rows: [{ id: 100 }] });
      mockDb.queueResponse({ rows: [], rowCount: 2 });
      mockDb.queueResponse({ rows: [], rowCount: 3 });
    }
    const summary = await syncDefaultRoles(client());
    expect(summary[0]).toEqual({ role: 'SUPERVISOR', granted: 3, revoked: 2 });
  });
});
