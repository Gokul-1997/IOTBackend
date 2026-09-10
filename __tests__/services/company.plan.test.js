/*
 * Unit tests for the plan governance in companies/company.service —
 * Phase 2 Screens 11 and 13.
 *
 * The limits are the product. A tier that accepts "Bronze with 999
 * machines" is not a tier, and a limit nobody enforces is decoration. Most
 * of these tests are about refusing things that used to be accepted:
 *
 *   - custom limits above what the plan permits
 *   - plans that do not exist, or have been deactivated
 *   - an expiry date already in the past
 *
 * The rest cover the audit trail. company_plans holds one row per company
 * and is upserted, so before this every plan change silently erased the one
 * before it — there was no way to say when a company moved tier or who
 * authorised it.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/companies/company.service');

const company_id = 4;
const actor = 7;

const BRONZE = { id: 1, plan_name: 'Bronze', is_active: true, max_users: 10, max_plants: 1, max_machines: 20 };

/**
 * assignPlan runs: BEGIN, SELECT current FOR UPDATE, SELECT plan,
 * INSERT company_plans, INSERT history, COMMIT.
 */
function queueAssign({ current = null, plan = BRONZE } = {}) {
  mockDb.queueResponse(
    { rows: [], rowCount: 0 },                      // BEGIN
    { rows: current ? [current] : [] },             // current assignment
    { rows: plan ? [plan] : [] },                   // the plan
    { rows: [{ id: 1, company_id, plan_id: plan?.id }] },  // upsert
    { rows: [], rowCount: 1 },                      // history insert
    { rows: [], rowCount: 0 }                       // COMMIT
  );
}

beforeEach(() => resetDb());

describe('a plan must be real, current and permitted', () => {
  test('rejects a plan that does not exist', async () => {
    queueAssign({ plan: null });
    await expect(svc.assignPlan(company_id, { plan_id: 9999 }, actor))
      .rejects.toMatchObject({ status: 404 });
  });

  test('rejects a deactivated plan', async () => {
    // otherwise the company keeps limits nobody is maintaining, and the
    // quota middleware enforces them indefinitely
    queueAssign({ plan: { ...BRONZE, is_active: false } });
    await expect(svc.assignPlan(company_id, { plan_id: 1 }, actor))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no longer available/i) });
  });

  test('rejects a plan_id that was not supplied at all', async () => {
    await expect(svc.assignPlan(company_id, {}, actor)).rejects.toMatchObject({ status: 400 });
  });

  test('rolls back rather than half-applying a rejected assignment', async () => {
    queueAssign({ plan: { ...BRONZE, is_active: false } });
    await expect(svc.assignPlan(company_id, { plan_id: 1 }, actor)).rejects.toBeDefined();
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
});

describe('custom limits cannot exceed the plan', () => {
  test.each([
    ['Machines limit', { max_machines: 999 }, 20],
    ['Users limit',    { max_users: 500 },    10],
    ['Plants limit',   { max_plants: 50 },    1]
  ])('rejects %s above the ceiling', async (_label, override, ceiling) => {
    queueAssign();
    await expect(svc.assignPlan(company_id, { plan_id: 1, ...override }, actor))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(`maximum of ${ceiling}`)
      });
  });

  test('accepts a limit at exactly the ceiling', async () => {
    queueAssign();
    await expect(svc.assignPlan(company_id, { plan_id: 1, max_machines: 20 }, actor)).resolves.toBeDefined();
  });

  test('an omitted limit means "use the plan default", not zero', async () => {
    queueAssign();
    await svc.assignPlan(company_id, { plan_id: 1 }, actor);

    const upsert = mockDb.calls().find(c => /INSERT INTO company_plans/i.test(c.text));
    // null lets COALESCE fall through to the plan; 0 would mean no quota
    expect(upsert.params[2]).toBeNull();
    expect(upsert.params[3]).toBeNull();
    expect(upsert.params[4]).toBeNull();
  });

  test.each([[-5], [1.5], ['many']])('rejects a nonsense limit %p', async (bad) => {
    queueAssign();
    await expect(svc.assignPlan(company_id, { plan_id: 1, max_machines: bad }, actor))
      .rejects.toMatchObject({ status: 400 });
  });

  test('is not fooled into clamping silently', async () => {
    // an admin who typed 999 must be told it was refused, not left
    // believing a smaller number was applied on their behalf
    queueAssign();
    await expect(svc.assignPlan(company_id, { plan_id: 1, max_machines: 999 }, actor))
      .rejects.toMatchObject({ message: expect.stringContaining('999') });
  });
});

describe('expiry', () => {
  test('rejects a date already in the past', async () => {
    await expect(svc.assignPlan(company_id, { plan_id: 1, expires_at: '2020-01-01' }, actor))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/already expired/i) });
  });

  test('rejects an unparseable date', async () => {
    await expect(svc.assignPlan(company_id, { plan_id: 1, expires_at: 'soon' }, actor))
      .rejects.toMatchObject({ status: 400 });
  });

  test('accepts a future date', async () => {
    queueAssign();
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString();
    await expect(svc.assignPlan(company_id, { plan_id: 1, expires_at: future }, actor)).resolves.toBeDefined();
  });
});

describe('the audit trail', () => {
  test('records every assignment', async () => {
    queueAssign();
    await svc.assignPlan(company_id, { plan_id: 1 }, actor);

    const hist = mockDb.calls().find(c => /INSERT INTO company_plan_history/i.test(c.text));
    expect(hist).toBeDefined();
    expect(hist.params).toContain(actor);
  });

  test('records what the plan was before, so a row explains itself', async () => {
    queueAssign({ current: { plan_id: 3, max_users: 999, max_plants: 99, max_machines: 500 } });
    await svc.assignPlan(company_id, { plan_id: 1, max_machines: 20, note: 'Downgrade' }, actor);

    const hist = mockDb.calls().find(c => /INSERT INTO company_plan_history/i.test(c.text));
    // without the "before" values a row only makes sense next to its
    // predecessor, which is exactly what an audit reader does not have
    expect(hist.params).toContain(3);      // previous_plan_id
    expect(hist.params).toContain(500);    // previous_max_machines
    expect(hist.params).toContain('Downgrade');
  });

  test('a first assignment records no previous plan rather than a fake one', async () => {
    queueAssign({ current: null });
    await svc.assignPlan(company_id, { plan_id: 1 }, actor);

    const hist = mockDb.calls().find(c => /INSERT INTO company_plan_history/i.test(c.text));
    expect(hist.params[6]).toBeNull();   // previous_plan_id
  });

  test('locks the current assignment so two admins cannot interleave', async () => {
    queueAssign();
    await svc.assignPlan(company_id, { plan_id: 1 }, actor);

    // both would otherwise read the same "before" state and write two
    // history rows each claiming to follow it
    expect(mockDb.calls()[1].text).toMatch(/FROM company_plans WHERE company_id = \$1 FOR UPDATE/);
  });

  test('the write and its history record commit together', async () => {
    queueAssign();
    await svc.assignPlan(company_id, { plan_id: 1 }, actor);

    const texts = mockDb.calls().map(c => c.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts.at(-1)).toBe('COMMIT');
    // a plan change without its audit row is worse than no audit at all,
    // because the gap is invisible
    const upsertAt = texts.findIndex(t => /INSERT INTO company_plans/i.test(t));
    const histAt   = texts.findIndex(t => /INSERT INTO company_plan_history/i.test(t));
    expect(upsertAt).toBeGreaterThan(0);
    expect(histAt).toBeGreaterThan(upsertAt);
    expect(histAt).toBeLessThan(texts.length - 1);
  });
});

describe('reading the history', () => {
  test('newest first, with a total order so pages cannot repeat', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    await svc.getPlanHistory(company_id);

    // several changes can land in the same second during a bulk update
    expect(mockDb.calls()[0].text).toMatch(/ORDER BY h\.changed_at DESC, h\.id DESC/);
  });

  test('caps the page size', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    const r = await svc.getPlanHistory(company_id, { limit: 99999 });
    expect(r.limit).toBeLessThanOrEqual(100);
  });

  test('scoped to the one company', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    await svc.getPlanHistory(company_id);
    expect(mockDb.calls()[0].params[0]).toBe(company_id);
    expect(mockDb.calls()[1].params[0]).toBe(company_id);
  });
});
