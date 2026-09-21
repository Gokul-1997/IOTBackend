/*
 * Each company owns its default roles.
 *
 * The flow the customer asked for: when S&T creates a company, the company
 * gets its own copy of each default role (Supervisor, Maintenance, Quality,
 * Setter, HR), holding only the pages S&T gave it. The company admin then
 * adjusts them as needed; S&T takes no action on roles.
 *
 * What is pinned here:
 *   - the roles belong to the company (company_id set, not a system role),
 *   - they hold only pages the company was granted,
 *   - they carry the older API keys their pages need,
 *   - a name the company already uses is left alone,
 *   - company creation does this inside its own transaction.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) }));
jest.mock('../../src/utils/nodemailer', () => ({ sendEmail: jest.fn(async () => {}) }), { virtual: false });

const roleSvc = require('../../src/roles/role.service');
const { resolveDefaultRoles } = require('../../src/roles/default-roles');

const TEMPLATES = resolveDefaultRoles();
const byName = Object.fromEntries(TEMPLATES.map(t => [t.name, t]));
beforeEach(() => resetDb());

/** Queue one template's worth: INSERT role, page-id lookup, and the write. */
function queueTemplate(t, { id, created = true, pages }) {
  if (!created) { mockDb.queueResponse({ rows: [] }); return; }       // name taken
  const rows = (pages ?? t.permissions).map((k, i) => ({ id: 1000 + i, permission_key: k }));
  mockDb.queueResponse(
    { rows: [{ id }] },                          // INSERT roles ... RETURNING id
    { rows: rows.map(r => ({ id: r.id })) },     // SELECT ids for the template's keys
    { rows },                                    // writeRolePermissions: page lookup
    {}, {}                                       // DELETE, INSERT
  );
}

describe('createDefaultRolesForCompany', () => {
  test('creates each default role as the company\'s own, not a shared system row', async () => {
    mockDb.queueResponse({ rows: [] });          // grants: none = unrestricted
    TEMPLATES.forEach((t, i) => queueTemplate(t, { id: 100 + i }));

    const out = await roleSvc.createDefaultRolesForCompany(mockDb, 4);

    const inserts = mockDb.calls().filter(c => /INSERT INTO roles/.test(c.text));
    expect(inserts.map(c => c.params[0])).toEqual(['SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR']);
    for (const c of inserts) {
      expect(c.text).toMatch(/VALUES \(\$1, \$2, \$3, false\)/);   // never is_system
      expect(c.params[2]).toBe(4);                                  // owned by the company
    }
    expect(out.map(r => r.role)).toEqual(['SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR']);
  });

  test('holds only the pages the company was granted', async () => {
    // the company has only page id 1000 (SUPERVISOR's first key)
    mockDb.queueResponse({ rows: [{ permission_id: 1000 }] });
    const sup = byName.SUPERVISOR;
    mockDb.queueResponse(
      { rows: [{ id: 100 }] },
      { rows: sup.permissions.map((_, i) => ({ id: 1000 + i })) },
      { rows: [{ id: 1000, permission_key: sup.permissions[0] }] }, {}, {}
    );
    // the other four: their pages are all outside the grant
    for (const t of TEMPLATES.slice(1)) {
      mockDb.queueResponse({ rows: [{ id: 200 }] }, { rows: [{ id: 5000 }] }, { rows: [] }, {}, {});
    }

    const out = await roleSvc.createDefaultRolesForCompany(mockDb, 4);
    expect(out[0]).toEqual({ role: 'SUPERVISOR', id: 100, pages: 1 });
    expect(out.slice(1).every(r => r.pages === 0)).toBe(true);

    const write = mockDb.calls().filter(c => /INSERT INTO role_permissions/.test(c.text))[0];
    expect(write.params[1]).toEqual([1000]);
  });

  test('a company with no grants at all is unrestricted — the full template', async () => {
    mockDb.queueResponse({ rows: [] });
    TEMPLATES.forEach((t, i) => queueTemplate(t, { id: 100 + i }));
    const out = await roleSvc.createDefaultRolesForCompany(mockDb, 4);
    expect(out.map(r => r.pages)).toEqual(TEMPLATES.map(t => t.permissions.length));
  });

  test('each role gets the older API keys its pages need', async () => {
    mockDb.queueResponse({ rows: [] });
    TEMPLATES.forEach((t, i) => queueTemplate(t, { id: 100 + i }));
    await roleSvc.createDefaultRolesForCompany(mockDb, 4);

    const writes = mockDb.calls().filter(c => /INSERT INTO role_permissions/.test(c.text));
    const legacyFor = name => writes[TEMPLATES.findIndex(t => t.name === name)].params[2];
    expect(legacyFor('QUALITY')).toEqual(['line.view']);          // the Quality page's line filter
    expect(legacyFor('SETTER')).toEqual(['machine.view']);        // Program Transfer lists machines
    expect(legacyFor('HR')).toEqual(expect.arrayContaining(['operator.view', 'operator.create', 'shift.view']));
  });

  test('a name the company already uses is left alone — nothing written to it', async () => {
    mockDb.queueResponse({ rows: [] });
    queueTemplate(byName.SUPERVISOR, { created: false });      // company already has one
    TEMPLATES.slice(1).forEach((t, i) => queueTemplate(t, { id: 101 + i }));

    const out = await roleSvc.createDefaultRolesForCompany(mockDb, 4);
    expect(out.map(r => r.role)).not.toContain('SUPERVISOR');
    const ins = mockDb.calls().find(c => /INSERT INTO roles/.test(c.text));
    expect(ins.text).toMatch(/ON CONFLICT DO NOTHING/);
  });

  test('nothing here touches Manage Access or another company', async () => {
    mockDb.queueResponse({ rows: [] });
    TEMPLATES.forEach((t, i) => queueTemplate(t, { id: 100 + i }));
    await roleSvc.createDefaultRolesForCompany(mockDb, 4);
    for (const c of mockDb.calls()) {
      expect(c.text).not.toMatch(/INSERT INTO company_permissions|DELETE FROM company_permissions/);
    }
  });
});

describe('the templates themselves', () => {
  test('carry no hand-written API keys — they are derived from the pages', () => {
    const { DEFAULT_ROLES } = require('../../src/roles/default-roles');
    for (const r of DEFAULT_ROLES) expect(r.legacy).toBeUndefined();
  });
});

describe('S&T creating a company', () => {
  test('creates the company\'s default roles in the same transaction', async () => {
    const companySvc = require('../../src/companies/company.service');
    const spy = jest.spyOn(roleSvc, 'createDefaultRolesForCompany')
      .mockResolvedValue([{ role: 'SUPERVISOR', id: 1, pages: 29 }]);

    mockDb.queueResponse(
      {},                                                  // BEGIN
      { rows: [], rowCount: 0 },                           // admin email free
      { rows: [{ id: 42, company_name: 'NEWCO' }] },       // INSERT company
      { rows: [{ id: 77, username: 'newadmin', email: 'a@newco.com' }] }, // admin user
      { rows: [{ id: 7 }], rowCount: 1 },                  // COMPANY_ADMIN role id
      {},                                                  // user_roles
      { rows: [] }                                         // permissions list (none, for brevity)
    );

    const co = await companySvc.create({
      company_code: 'NC', company_name: 'NEWCO', admin_username: 'newadmin', admin_email: 'a@newco.com'
    });

    expect(spy).toHaveBeenCalledWith(expect.anything(), 42);
    expect(co.default_roles).toEqual(['SUPERVISOR']);
    // before COMMIT: a company never exists without its roles
    const texts = mockDb.calls().map(c => c.text);
    expect(texts[texts.length - 1]).toBe('COMMIT');
    spy.mockRestore();
  });
});
