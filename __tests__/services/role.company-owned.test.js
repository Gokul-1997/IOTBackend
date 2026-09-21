/*
 * The roles model agreed with the customer on 2026-09-21.
 *
 *   S&T super admin  — creates the company and its admin, and sets what the
 *                      company paid for. No action on roles.
 *   Default roles    — each company gets its own copy when it is created.
 *   Company admin    — creates users and manages every company role: changes
 *                      the defaults, copies, creates, deletes. Only ever with
 *                      pages the company paid for.
 *
 * Three gaps this closes on the way:
 *   - create() spread the request body in, so is_system and any permission
 *     id at all could be set — including pages the company never bought,
 *     which the role-only permit() routes then honoured.
 *   - a company's own role held page keys only, so its pages opened and the
 *     API behind them answered 403 (machines, shifts, operators, lines).
 *   - role names were unique across every company, so the first company to
 *     use a name took it from all the others.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/roles/role.service');
const { legacyKeysFor } = require('../../src/roles/default-roles');

const sntSuper = { id: 1, is_snt_super: true,  company_id: null };
const companyA = { id: 2, is_snt_super: false, company_id: 4 };

beforeEach(() => resetDb());

const sql = () => mockDb.calls().map(c => c.text);

/* ─────────────────────────── who may manage roles ─────────────────────────── */

describe('S&T reads roles but does not manage them', () => {
  test.each([
    ['create', () => svc.create({ role_name: 'LINE LEAD' }, sntSuper)],
    ['copy',   () => svc.copy(51, { role_name: 'NIGHT SUP' }, sntSuper)],
    ['update', () => svc.update(10, { role_name: 'X' }, sntSuper)],
    ['permissions', () => svc.assignPermissions(10, [1], sntSuper)],
    ['delete', () => svc.remove(10, sntSuper)]
  ])('%s is refused with an explanation, before any query', async (_n, call) => {
    await expect(call()).rejects.toMatchObject({ status: 403, message: /managed by each company's admin/ });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a caller with no company is refused too', async () => {
    await expect(svc.create({ role_name: 'LINE LEAD' }, { is_snt_super: false, company_id: null }))
      .rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('S&T reads only the shared roles, not any company\'s', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list({ is_snt_super: true });
    expect(sql()[0]).toMatch(/r\.company_id IS NULL/);
  });
});

/* ─────────────────────────── create ─────────────────────────── */

describe('create — a company admin makes a role for their own company', () => {
  const queueCreate = ({ grants = [{ permission_id: 1 }], pages = [{ id: 1, permission_key: 'page:machines:view' }] } = {}) => {
    mockDb.queueResponse(
      {},                                        // BEGIN
      { rows: [] },                              // name clash check
      { rows: pages.map(p => ({ id: p.id })) },  // which ids are pages
      { rows: grants },                          // company grants
      { rows: [{ id: 90, role_name: 'LINE LEAD', company_id: 4, is_system: false }] }, // INSERT
      { rows: pages },                           // page lookup
      {}, {}, {}                                 // DELETE, INSERT perms, COMMIT
    );
  };

  test('the role belongs to the caller\'s company and is never a system role', async () => {
    queueCreate();
    await svc.create({ role_name: 'LINE LEAD', permission_ids: [1] }, companyA);
    const ins = mockDb.calls().find(c => /INSERT INTO roles/.test(c.text));
    expect(ins.text).toMatch(/VALUES \(\$1, \$2, \$3, false\)/);
    expect(ins.params[2]).toBe(4);
  });

  test('is_system and company_id in the body are ignored', async () => {
    queueCreate();
    await svc.create({ role_name: 'LINE LEAD', permission_ids: [1], is_system: true, company_id: 9 }, companyA);
    const ins = mockDb.calls().find(c => /INSERT INTO roles/.test(c.text));
    expect(ins.params[2]).toBe(4);
    expect(ins.text).not.toMatch(/true\)/);
  });

  test('a page the company did not pay for is refused, and named', async () => {
    mockDb.queueResponse(
      {}, { rows: [] },
      { rows: [{ id: 1 }, { id: 77 }] },                        // both are pages
      { rows: [{ permission_id: 1 }] },                         // company paid for 1 only
      { rows: [{ permission_key: 'page:programs:transfer' }] }  // the key for 77
    );
    await expect(svc.create({ role_name: 'LINE LEAD', permission_ids: [1, 77] }, companyA))
      .rejects.toMatchObject({ status: 403, message: /page:programs:transfer/ });
    expect(sql().some(t => /INSERT INTO roles/.test(t))).toBe(false);
  });

  test('a company with no grants is unrestricted — its admin can still build a role', async () => {
    queueCreate({ grants: [] });
    await expect(svc.create({ role_name: 'LINE LEAD', permission_ids: [1] }, companyA)).resolves.toBeTruthy();
  });

  test('the pages bring the API keys they need', async () => {
    queueCreate();
    await svc.create({ role_name: 'LINE LEAD', permission_ids: [1] }, companyA);
    const ins = mockDb.calls().find(c => /INSERT INTO role_permissions/.test(c.text));
    expect(ins.params[2]).toEqual(['machine.view', 'line.view']);
  });

  /* The older API keys are derived from pages, never chosen. The editor has
     always sent back every id a role holds, derived ones included, so those
     are ignored rather than refused — and never granted as sent. */
  test('a machine.view-style id in the request is ignored, never granted directly', async () => {
    mockDb.queueResponse(
      {}, { rows: [] },
      { rows: [] },                                               // 500 is not a page
      { rows: [{ id: 90 }] },                                     // INSERT role
      { rows: [] },                                               // no pages to write
      {}, {}, {}                                                  // DELETE, INSERT, COMMIT
    );
    await svc.create({ role_name: 'LINE LEAD', permission_ids: [500] }, companyA);
    const ins = mockDb.calls().find(c => /INSERT INTO role_permissions/.test(c.text));
    expect(ins.params[1]).toEqual([]);     // no page ids
    expect(ins.params[2]).toEqual([]);     // so no derived keys either
    expect(ins.params[1]).not.toContain(500);
  });
});

/* ─────────────────────────── names ─────────────────────────── */

describe('role names', () => {
  test.each(['SNT_SUPER', 'snt_super', 'Company_Admin', 'ADMIN', ' admin '])(
    '"%s" is reserved — the code grants privilege by that name', async name => {
      mockDb.queueResponse({});                                   // BEGIN
      await expect(svc.create({ role_name: name }, companyA))
        .rejects.toMatchObject({ status: 400, message: /reserved/ });
      expect(sql().some(t => /INSERT INTO roles/.test(t))).toBe(false);
    });

  test('an active system role\'s name is refused', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 3, company_id: null }] });
    await expect(svc.create({ role_name: 'platform thing' }, companyA))
      .rejects.toMatchObject({ status: 409, message: /system role name/ });
  });

  /* The old shared SUPERVISOR/…/HR rows are retired; each company owns its
     own. A company that deleted its SUPERVISOR must be able to make one. */
  test('a retired shared row does not block a company\'s own name', async () => {
    mockDb.queueResponse({}, { rows: [] });
    await svc.create({ role_name: 'supervisor' }, companyA).catch(() => {});
    const check = mockDb.calls()[1];
    expect(check.params[3]).toEqual(expect.arrayContaining(['SUPERVISOR', 'OPERATOR']));
    expect(check.text).toMatch(/NOT \(role_name = ANY\(\$4::text\[\]\)\)/);
  });

  test('a company cannot have two roles of the same name, whatever the case', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 80, company_id: 4 }] });
    await expect(svc.create({ role_name: 'line lead' }, companyA))
      .rejects.toMatchObject({ status: 409, message: /already has a role/ });
  });

  test('the clash check only looks at this company and active system roles', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 80, company_id: 4 }] });
    await svc.create({ role_name: 'line lead' }, companyA).catch(() => {});
    const check = mockDb.calls()[1];
    expect(check.text).toMatch(/OR company_id = \$2/);
    expect(check.params[1]).toBe(4);
  });

  test('before migration 025, a name another company holds is a clear 409, not a 500', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockDb.queueResponse({}, { rows: [] }, dup);    // BEGIN, name check, INSERT
    await expect(svc.create({ role_name: 'LINE LEAD' }, companyA))
      .rejects.toMatchObject({ status: 409, message: /already taken/ });
  });

  test('spaces are tidied, and length is bounded', async () => {
    mockDb.queueResponse({});
    await expect(svc.create({ role_name: 'x' }, companyA)).rejects.toMatchObject({ status: 400 });
    resetDb();
    mockDb.queueResponse({});
    await expect(svc.create({ role_name: 'a'.repeat(51) }, companyA)).rejects.toMatchObject({ status: 400 });
    resetDb();
    mockDb.queueResponse({}, { rows: [{ id: 80, company_id: 4 }] });
    await svc.create({ role_name: '  Line    Lead ' }, companyA).catch(() => {});
    expect(mockDb.calls()[1].params[0]).toBe('Line Lead');
  });
});

/* ─────────────────────────── copy ─────────────────────────── */

describe('copy — one of the company\'s roles, into a new one', () => {
  // the company's OWN Maintenance role, created for it with the company
  const MAINT = { id: 51, role_name: 'MAINTENANCE', description: 'd', company_id: 4, is_system: false };

  const PAGES = [{ id: 1, permission_key: 'page:analytics-maintenance:view' },
                 { id: 2, permission_key: 'page:maintenance:view' },
                 { id: 3, permission_key: 'page:analytics-energy:view' }];
  const queueCopy = ({ source = MAINT, grants = [{ permission_id: 1 }, { permission_id: 2 }] } = {}) => {
    const keep = grants.length ? PAGES.filter(p => grants.some(g => g.permission_id === p.id)) : PAGES;
    mockDb.queueResponse(
      {},                                                     // BEGIN
      { rows: [source] },                                     // source
      { rows: [] },                                           // name clash
      { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },            // source page ids
      { rows: grants },                                       // company grants
      { rows: [{ id: 95, role_name: 'NIGHT MAINT', company_id: 4, is_system: false }] }, // INSERT
      { rows: keep },                                         // pages kept
      {}, {}, {}                                              // DELETE, INSERT, COMMIT
    );
  };

  /* S&T may have narrowed the company's access since the source was made;
     the copy follows the company's access today, and says what it dropped. */
  test('keeps only pages the company still has, and says how many it left out', async () => {
    queueCopy();
    const out = await svc.copy(51, { role_name: 'NIGHT MAINT' }, companyA);
    expect(out).toMatchObject({ copied: 2, skipped: 1, from: 'MAINTENANCE' });
    const ins = mockDb.calls().find(c => /INSERT INTO role_permissions/.test(c.text));
    expect(ins.params[1]).toEqual([1, 2]);
  });

  test('an unrestricted company keeps every page', async () => {
    queueCopy({ grants: [] });
    const out = await svc.copy(51, { role_name: 'NIGHT MAINT' }, companyA);
    expect(out).toMatchObject({ copied: 3, skipped: 0 });
  });

  test('the copy belongs to the company and is editable (not a system role)', async () => {
    queueCopy();
    await svc.copy(51, { role_name: 'NIGHT MAINT' }, companyA);
    const ins = mockDb.calls().find(c => /INSERT INTO roles/.test(c.text));
    expect(ins.params[2]).toBe(4);
    expect(ins.text).toMatch(/false\)/);
  });

  test.each([
    ['SNT_SUPER',                  { id: 6,  role_name: 'SNT_SUPER',  company_id: null, is_system: true }],
    ['a retired shared row',       { id: 19, role_name: 'SUPERVISOR', company_id: null, is_system: true }],
    ['another company\'s role',    { id: 70, role_name: 'QC',         company_id: 5,    is_system: false }]
  ])('%s cannot be copied — reads as not found', async (_n, source) => {
    mockDb.queueResponse({}, { rows: [source] });
    await expect(svc.copy(source.id, { role_name: 'MINE' }, companyA)).rejects.toMatchObject({ status: 404 });
    expect(sql().some(t => /INSERT INTO roles/.test(t))).toBe(false);
  });

  test('Company Admin cannot be copied — its access is Manage Access, not a page list', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 7, role_name: 'COMPANY_ADMIN', company_id: null, is_system: true }] });
    await expect(svc.copy(7, { role_name: 'MY ADMIN' }, companyA))
      .rejects.toMatchObject({ status: 400, message: /Manage Access/ });
  });
});

/* ─────────────────────────── the company's defaults are its own ─────────────────────────── */

describe('the company\'s default roles are its own to change', () => {
  test('the company admin can rename its own SUPERVISOR', async () => {
    mockDb.queueResponse(
      {}, { rows: [{ id: 51, role_name: 'SUPERVISOR', is_system: false, company_id: 4 }] },
      { rows: [] },                                           // name free
      { rows: [{ id: 51, role_name: 'SHIFT LEAD' }] }, {}     // UPDATE, COMMIT
    );
    await expect(svc.update(51, { role_name: 'SHIFT LEAD' }, companyA))
      .resolves.toMatchObject({ role_name: 'SHIFT LEAD' });
  });

  test('a leftover shared row cannot be touched — it reads as not found', async () => {
    mockDb.queueResponse({}, { rows: [{ id: 19, role_name: 'SUPERVISOR', is_system: true, company_id: null }] });
    await expect(svc.update(19, { role_name: 'X' }, companyA)).rejects.toMatchObject({ status: 404 });
    expect(sql().some(t => /UPDATE roles/.test(t))).toBe(false);
  });

  test('retired rows are never listed — including the old shared defaults', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.list(companyA);
    expect(mockDb.calls()[0].params[1]).toEqual(expect.arrayContaining(
      ['MANAGER', 'OPERATOR', 'VIEWER', 'SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR', 'SNT_SUPER']));
    expect(mockDb.calls()[0].params[1]).not.toContain('COMPANY_ADMIN');
  });

  test('retired rows cannot be assigned', async () => {
    mockDb.queueResponse({ rows: [{ id: 20, role_name: 'OPERATOR', company_id: null, is_system: true }] });
    await expect(svc.assertAssignable(mockDb, [20], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403, message: /no longer in use/ });
  });

  test('S&T can only make someone a company admin — not give out the company\'s roles', async () => {
    mockDb.queueResponse({ rows: [{ id: 51, role_name: 'MAINTENANCE', company_id: 4, is_system: false }] });
    await expect(svc.assertAssignable(mockDb, [51], { actor: sntSuper, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403, message: /company's admin/ });

    resetDb();
    mockDb.queueResponse({ rows: [{ id: 7, role_name: 'COMPANY_ADMIN', company_id: null, is_system: true }] });
    await expect(svc.assertAssignable(mockDb, [7], { actor: sntSuper, targetCompanyId: 4 })).resolves.toBeUndefined();
  });

  test('a crafted "system" row owned by a company cannot be granted across companies', async () => {
    mockDb.queueResponse({ rows: [{ id: 99, role_name: 'SNEAKY', company_id: 5, is_system: true }] });
    await expect(svc.assertAssignable(mockDb, [99], { actor: companyA, targetCompanyId: 4 }))
      .rejects.toMatchObject({ status: 403 });
  });
});

/* ─────────────────────────── the older API keys ─────────────────────────── */

describe('legacyKeysFor — pages bring the API keys behind them', () => {
  test.each([
    [['page:machines:view'],                      ['machine.view', 'line.view']],   // the form's line list
    [['page:machines:edit'],                      ['machine.update']],
    [['page:operators:view'],                     ['operator.view', 'shift.view']],
    [['page:shifts:delete'],                      ['shift.update']],   // that route checks update
    [['page:programs:view'],                      ['machine.view']],
    [['page:analytics-oee:view'],                 []],                 // dashboards need none
    [['page:programs:view', 'page:job:view'],     ['machine.view', 'operator.view']], // no duplicates
    [['page:quality:view'],                       ['line.view']],      // its line filter
    [['page:reports:view'],                       ['machine.view', 'operator.view', 'shift.view']]
  ])('%j → %j', (pages, legacy) => {
    expect(legacyKeysFor(pages)).toEqual(legacy);
  });

  test('every key it can produce is a real legacy permission', () => {
    const { LEGACY_API_PERMISSIONS } = require('../../src/roles/role.service');
    const real = new Set(LEGACY_API_PERMISSIONS.map(p => p.key));
    const { LEGACY_FOR_PAGE } = require('../../src/roles/default-roles');
    for (const actions of Object.values(LEGACY_FOR_PAGE)) {
      for (const keys of Object.values(actions)) for (const k of keys) expect(real.has(k)).toBe(true);
    }
  });

  test('every page it maps is a real module in the catalogue', () => {
    const { APP_MODULES } = require('../../src/plans/plan.service');
    const { LEGACY_FOR_PAGE } = require('../../src/roles/default-roles');
    for (const [mod, actions] of Object.entries(LEGACY_FOR_PAGE)) {
      const def = APP_MODULES.find(m => m.key === mod);
      expect(def).toBeTruthy();
      for (const a of Object.keys(actions)) expect(def.actions).toContain(a);
    }
  });
});
