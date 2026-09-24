/*
 * Unit tests for dashboard/preventive.service — Phase 2 Screen 3.
 *
 * The screen takes a From–To range, as the design draws it ("18 Jun 2026 -
 * 18 Jul 2026"). It used to take one day, and its ticket cards ignored even
 * that, so changing the date changed nothing on them.
 *
 * Eleven queries run at once with different parameter lists; a query handed
 * a parameter it does not reference is refused by Postgres outright, which
 * is checked here directly as on the other screens.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/preventive.service');

const req = query => ({ user: { company_id: 4 }, query });

/** getPreventiveDashboard's eleven queries, in the order they are sent. */
function queueAll() {
  mockDb.queueResponse(
    { rows: [{ total: 0, open: 0 }] },                                   // critical alarms
    { rows: [{ generated: 0, open: 0, completed: 0, overdue: 0 }] },     // ticket KPIs
    { rows: [{ avg_resolution_hours: null, resolved_count: 0 }] },       // resolution
    { rows: [] },                                                        // trend
    { rows: [{ class: 'CRITICAL', total: 2 }, { class: 'NON_CRITICAL', total: 85 }] },
    { rows: [] },                                                        // by machine
    { rows: [] },                                                        // top reasons
    { rows: [{ open: 0, in_progress: 0, completed: 0 }] },               // status split
    { rows: [] },                                                        // ticket list
    { rows: [{ total: 0 }] },                                            // ticket count
    { rows: [] }                                                         // trigger summary
  );
}

const calls = () => mockDb.calls();
const byText = re => calls().find(c => re.test(c.text));

beforeEach(() => resetDb());

describe('every query binds exactly the parameters it references', () => {
  const highest = sql => Math.max(0, ...[...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1])));

  test.each([
    ['nothing (last 7 days)', {}],
    ['a range',               { from: '2026-09-01', to: '2026-09-24' }],
    ['a legacy single date',  { date: '2026-09-20' }],
    ['a machine',             { machine_id: 36 }],
    ['a search',              { search: 'spindle' }],
    ['everything at once',    { from: '2026-09-01', to: '2026-09-24', machine_id: 36, search: 'x', page: 2, limit: 5 }]
  ])('%s', async (_label, query) => {
    queueAll();
    await svc.getPreventiveDashboard(req(query));
    expect(calls()).toHaveLength(11);
    for (const call of calls()) expect(call.params.length).toBe(highest(call.text));
  });
});

describe('the date range', () => {
  test('bounds the alarm figures in plant time', async () => {
    queueAll();
    await svc.getPreventiveDashboard(req({ from: '2026-09-01', to: '2026-09-24' }));
    const alarms = byText(/AS open\s+FROM machine_alarms/);
    expect(alarms.params.slice(1, 3)).toEqual(['2026-09-01T00:00:00+05:30', '2026-09-24T23:59:59.999+05:30']);
  });

  test('bounds the ticket cards by when a ticket was raised', async () => {
    queueAll();
    await svc.getPreventiveDashboard(req({ from: '2026-09-01', to: '2026-09-24', machine_id: 36 }));
    const kpi = byText(/AS generated/);
    expect(kpi.text).toMatch(/t\.created_at >= \$2 AND t\.created_at <= \$3/);
    expect(kpi.text).toMatch(/t\.machine_id = \$4/);
    expect(kpi.params).toEqual([4, '2026-09-01T00:00:00+05:30', '2026-09-24T23:59:59.999+05:30', 36,
                                ['OPEN', 'ASSIGNED', 'IN_PROGRESS']]);
    expect(byText(/AS in_progress/).text).toMatch(/t\.created_at >= \$2/);
    expect(byText(/avg_resolution_hours/).text).toMatch(/t\.created_at >= \$2/);
  });

  test('leaves the ticket list unbounded: it is the backlog to work through', async () => {
    queueAll();
    await svc.getPreventiveDashboard(req({ from: '2026-09-01', to: '2026-09-24' }));
    const list = byText(/AS ticket_id/);
    expect(list.text).not.toMatch(/created_at >=/);
  });

  test('the trend runs across the whole range, one point per day', async () => {
    queueAll();
    await svc.getPreventiveDashboard(req({ from: '2026-08-25', to: '2026-09-24' }));
    const trend = byText(/generate_series/);
    expect(trend.params).toEqual([4, '2026-08-25', '2026-09-24']);
    // days are cut at IST midnight, not the database session's zone
    expect(trend.text).toMatch(/AT TIME ZONE 'Asia\/Kolkata'\)::date = days\.d/);
  });

  test('a range shorter than a week still draws the week the agreement asks for', async () => {
    queueAll();
    await svc.getPreventiveDashboard(req({ from: '2026-09-20', to: '2026-09-20' }));
    expect(byText(/generate_series/).params).toEqual([4, '2026-09-14', '2026-09-20']);
  });

  test('echoes the range back, with date kept for older clients', async () => {
    queueAll();
    const d = await svc.getPreventiveDashboard(req({ from: '2026-09-01', to: '2026-09-24' }));
    expect(d.filters).toMatchObject({ from: '2026-09-01', to: '2026-09-24', days: 24, date: '2026-09-24' });
  });

  test.each([
    [{ from: '2026-09-24', to: '2026-09-01' }, 'from must not be after to'],
    [{ from: '2025-01-01', to: '2026-09-24' }, 'a date range can cover at most 366 days'],
    [{ from: '2026-02-31' },                   '2026-02-31 is not a valid date'],
    [{ to: 'yesterday' },                      'date must be in YYYY-MM-DD format']
  ])('%j is a 400, sent before any query', async (query, message) => {
    await expect(svc.getPreventiveDashboard(req(query))).rejects.toMatchObject({ status: 400, message });
    expect(calls()).toHaveLength(0);
  });
});

describe('severity', () => {
  test('NORMAL alarms are Non-Critical, not Information', async () => {
    queueAll();
    const d = await svc.getPreventiveDashboard(req({}));
    const sql = byText(/AS class/).text;
    expect(sql).toMatch(/UPPER\(severity\) IN \('CRITICAL'/);
    expect(sql).toMatch(/ELSE 'NON_CRITICAL'/);
    expect(sql).not.toMatch(/'NORMAL'/);          // it reaches NON_CRITICAL by the ELSE
    expect(d.alarm_severity).toEqual({ critical: 2, non_critical: 85, information: 0 });
  });
});
