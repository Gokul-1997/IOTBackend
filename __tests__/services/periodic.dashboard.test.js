/*
 * Unit tests for dashboard/periodic.service — Phase 2 Screen 4.
 *
 * Compliance is the figure this screen exists to report, so most of these
 * are about what it counts. The definition: of the occurrences whose
 * deadline has passed, the share completed by that deadline — where the
 * deadline is the due date plus the schedule's grace days.
 *
 * Two ways to get it wrong, both flattering:
 *   - counting occurrences that are not yet due as compliant, which makes
 *     a plant that has done nothing this year look perfect every January
 *   - applying grace after the fact instead of as part of the deadline
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/periodic.service');

const company_id = 4;

/** getPeriodic fires six queries in parallel; two of them are paginated. */
function queueDashboard(kpiRow = {}) {
  mockDb.queueResponse(
    { rows: [{ scheduled: '0', due_today: '0', due_this_week: '0', overdue: '0',
               completed: '0', judged_total: '0', on_time: '0', ...kpiRow }] },
    { rows: [] },                       // compliance trend
    { rows: [] },                       // by frequency
    { rows: [] },                       // technician workload
    { rows: [] },                       // upcoming
    { rows: [] },                       // tickets page
    { rows: [{ total: 0 }] }            // tickets count
  );
}

beforeEach(() => resetDb());

describe('compliance', () => {

  test('is the on-time share of what has actually come due', async () => {
    queueDashboard({ judged_total: '10', on_time: '7' });
    const d = await svc.getPeriodic({ company_id });

    expect(d.kpis.compliance_pct).toBe(70);
    expect(d.kpis.compliance_basis).toEqual({ on_time: 7, judged: 10 });
  });

  test('is null, not zero, when nothing has come due yet', async () => {
    // "0% compliance" on a plant with no deadlines behind it is a lie, and
    // the screen would repeat it in a KPI tile all January.
    queueDashboard({ judged_total: '0', on_time: '0', scheduled: '12' });
    const d = await svc.getPeriodic({ company_id });

    expect(d.kpis.compliance_pct).toBeNull();
    expect(d.kpis.scheduled).toBe(12);
  });

  test('counts only occurrences whose deadline has passed', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id });

    const kpi = mockDb.calls()[0].text;
    expect(kpi).toMatch(/deadline < NOW\(\)/);
    // grace is part of the deadline, not an excuse applied afterwards
    expect(kpi).toMatch(/due_date \+ make_interval\(days => grace_days\)/);
  });

  test('on-time means finished by the deadline, not merely finished', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id });

    expect(mockDb.calls()[0].text).toMatch(/finished_at <= deadline/);
  });

  test('only schedule-generated tickets count toward the plan', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id });

    // a breakdown ticket is not periodic maintenance; counting it would
    // inflate compliance with work that was never planned
    expect(mockDb.calls()[0].text).toMatch(/t\.schedule_id IS NOT NULL/);
    expect(mockDb.calls()[0].text).toMatch(/JOIN maintenance_schedules/);
  });

  test('is rounded to one decimal, not left as a repeating fraction', async () => {
    queueDashboard({ judged_total: '3', on_time: '1' });
    const d = await svc.getPeriodic({ company_id });
    expect(d.kpis.compliance_pct).toBe(33.3);
  });
});

describe('KPI counts', () => {
  test('overdue means still open past the deadline', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id });

    const kpi = mockDb.calls()[0].text;
    expect(kpi).toMatch(/overdue/);
    expect(mockDb.calls()[0].params[2]).toEqual(['OPEN', 'ASSIGNED', 'IN_PROGRESS']);
    expect(mockDb.calls()[0].params[3]).toEqual(['RESOLVED', 'CLOSED']);
  });

  test('due today is measured in the plant timezone, not UTC', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id });

    // a shift starting at 06:00 IST is the previous day in UTC, so "due
    // today" computed in UTC is wrong for half the working day
    expect(mockDb.calls()[0].text).toMatch(/Asia\/Kolkata/);
  });

  test('numbers come back as numbers, not strings from the driver', async () => {
    queueDashboard({ scheduled: '5', overdue: '2', completed: '3' });
    const d = await svc.getPeriodic({ company_id });

    for (const k of ['scheduled', 'due_today', 'due_this_week', 'overdue', 'completed']) {
      expect(typeof d.kpis[k]).toBe('number');
    }
  });
});

describe('the ticket table', () => {
  test('orders by a total order so pages cannot repeat a row', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id });

    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    // due_date is not unique — a nightly batch raises many occurrences at
    // the same instant — so it cannot order pagination on its own
    expect(list.text).toMatch(/ORDER BY t\.due_date DESC, t\.id DESC/);
  });

  test('caps the page size a caller can ask for', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id, limit: 100000 });

    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.params.at(-2)).toBeLessThanOrEqual(100);
  });

  test('a search term is parameterised, never interpolated', async () => {
    queueDashboard();
    await svc.getPeriodic({ company_id, search: "'; DROP TABLE machines;--" });

    const list = mockDb.calls().find(c => /ILIKE/.test(c.text));
    expect(list.text).not.toMatch(/DROP TABLE/);
    expect(list.params).toContain("%'; DROP TABLE machines;--%");
  });
});

describe('input validation', () => {
  test.each([['abc'], ['-1'], ['0'], ['1.5']])('machine_id %p is a 400, not a 500', async (bad) => {
    await expect(svc.getPeriodic({ company_id, machine_id: bad }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('an absent machine filter means all machines', async () => {
    queueDashboard();
    const d = await svc.getPeriodic({ company_id });
    expect(d.filters.machine_id).toBeNull();
  });
});

describe('schedules', () => {
  const base = {
    company_id, machine_id: 5, title: 'Grease the ways',
    frequency: 'WEEKLY', next_due_at: '2026-09-15T02:00:00Z', grace_days: 2, user_id: 9
  };

  test('creates a schedule after checking the machine belongs to the company', async () => {
    mockDb.queueResponse({ rows: [{ '?column?': 1 }], rowCount: 1 }, { rows: [{ id: 1 }] });

    await svc.upsertSchedule(base);

    // without the ownership check a schedule could be hung off another
    // tenant's machine
    expect(mockDb.calls()[0].text).toMatch(/FROM machines WHERE id = \$1 AND company_id = \$2/);
  });

  test('rejects a machine from another company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.upsertSchedule(base)).rejects.toMatchObject({ status: 404 });
  });

  test.each([['FORTNIGHTLY'], [''], [null], ['weekly-ish']])('rejects frequency %p', async (frequency) => {
    await expect(svc.upsertSchedule({ ...base, frequency }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('accepts every frequency the engine can step', async () => {
    const engine = require('../../src/maintenance/periodic-engine.service');
    // a frequency the form offers but the engine cannot step would create
    // schedules that never generate anything
    for (const f of svc.FREQUENCIES) {
      expect(engine.FREQUENCY_STEP[f]).toBeDefined();
    }
  });

  test.each([[-1], [366], [1.5], ['soon']])('rejects grace_days %p', async (grace_days) => {
    await expect(svc.upsertSchedule({ ...base, grace_days }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('rejects an unparseable first due date', async () => {
    await expect(svc.upsertSchedule({ ...base, next_due_at: 'next Tuesday' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('deleting deactivates rather than removing', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 });

    await svc.deleteSchedule({ id: 1, company_id });

    // tickets it produced reference it, and compliance history is read
    // through that join — a hard delete would rewrite last quarter
    expect(mockDb.calls()[0].text).toMatch(/SET is_active = FALSE/);
    expect(mockDb.calls()[0].text).not.toMatch(/DELETE/i);
  });

  test('deleting something that is not yours is a 404', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.deleteSchedule({ id: 999, company_id })).rejects.toMatchObject({ status: 404 });
  });
});

describe('export', () => {
  test('is bounded, so a plant with years of history still returns', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });

    await svc.getExportRows({ company_id });

    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.params.at(-2)).toBeLessThanOrEqual(100);
  });

  test('produces human column names, not database ones', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, machine_serial_no: 'VMC-01', title: 'Grease', frequency: 'WEEKLY',
                 priority: 'LOW', status: 'OPEN', due_date: '2026-09-10T00:00:00Z',
                 completed_at: null, is_overdue: true, assigned_to_name: null }] },
      { rows: [{ total: 1 }] }
    );

    const rows = await svc.getExportRows({ company_id });

    expect(Object.keys(rows[0])).toEqual([
      'Ticket', 'Machine', 'Task', 'Frequency', 'Priority',
      'Status', 'Due date', 'Completed', 'Overdue', 'Technician'
    ]);
    expect(rows[0]['Overdue']).toBe('Yes');
    expect(rows[0]['Technician']).toBe('Unassigned');
    expect(rows[0]['Due date']).toBe('2026-09-10');
  });
});

/*
 * Parameter binding.
 *
 * The tests above assert SQL *text*, which a mocked driver will happily
 * accept however many parameters come with it. Postgres will not: a
 * statement handed more parameters than it references is rejected
 * outright, and that is how the count query — which shares its WHERE with
 * the data query but needs neither the status list nor limit/offset —
 * shipped broken past a green suite.
 *
 * Every filter combination shifts the placeholder indices, so each one is
 * its own chance to get this wrong.
 */
describe('every query binds exactly the parameters it references', () => {
  const highest = sql => {
    const found = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    return found.length ? Math.max(...found) : 0;
  };

  test.each([
    ['no filters',            {}],
    ['search only',           { search: 'grease' }],
    ['status only',           { status: 'OPEN' }],
    ['search and status',     { search: 'grease', status: 'OPEN' }],
    ['machine and search',    { machine_id: 5, search: 'x' }],
    ['machine, search, status', { machine_id: 5, search: 'x', status: 'CLOSED' }]
  ])('%s', async (_label, filters) => {
    queueDashboard();
    await svc.getPeriodic({ company_id, ...filters });

    for (const call of mockDb.calls()) {
      // A statement may reference fewer placeholders than it is given only
      // if it references none at all; otherwise the counts must match.
      expect(call.params.length).toBe(highest(call.text));
    }
  });

  test('the export path too', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });

    await svc.getExportRows({ company_id, search: 'x', status: 'OPEN', machine_id: 5 });

    for (const call of mockDb.calls()) {
      expect(call.params.length).toBe(highest(call.text));
    }
  });
});
