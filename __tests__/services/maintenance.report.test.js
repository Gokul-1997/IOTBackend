/*
 * Unit tests for dashboard/maintenance-report.service.
 *
 * Two things here are easy to get wrong in a way no one notices until a
 * customer reads the report and believes it:
 *
 *   - MTTR must average only resolved tickets. Including open ones reports
 *     a repair that has not happened, and the number silently improves as
 *     more tickets are raised.
 *   - a ticket with no downtime entered must not vanish from the totals.
 *     It counts as a ticket and is declared as unrecorded, rather than
 *     being dropped so the stopped-time figure looks better than it is.
 *
 * The rest guard tenant scoping and the filter whitelist: every query is
 * bound to the caller's company_id as $1, and no user string reaches SQL.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/maintenance-report.service');

const company_id = 4;
const q = (over = {}) => ({ company_id, from: '2026-08-01', to: '2026-08-31', ...over });

const KPIS = {
  tickets: 12, settled: 9, open: 3, breakdowns: 7, critical: 2,
  downtime_minutes: 540, downtime_unrecorded: 2, mttr_hours: 4.25, mttr_basis: 9
};

/** The six queries getReport fires, in Promise.all order (the last is the
 *  paginated list, which is itself a count plus a rows query). */
const queueAll = (over = {}) => mockDb.queueResponse(
  { rows: [{ ...KPIS, ...(over.kpis || {}) }] },
  { rows: over.byMachine || [] },
  { rows: over.byType    || [] },
  { rows: over.byStatus  || [] },
  { rows: over.trend     || [] },
  { rows: [{ n: over.total === undefined ? 12 : over.total }] },
  { rows: over.tickets   || [] }
);

beforeEach(() => resetDb());

describe('maintenance report — tenant scoping', () => {
  test('every query binds the caller’s company as $1', async () => {
    queueAll();
    await svc.getReport(q());
    const calls = mockDb.calls();
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach(c => expect(c.params[0]).toBe(company_id));
    calls.forEach(c => expect(c.text).toMatch(/t\.company_id = \$1/));
  });

  test('a user with no company is refused rather than shown everything', async () => {
    await expect(svc.getReport({ company_id: null })).rejects.toMatchObject({ status: 403 });
    await expect(svc.getReport({})).rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('maintenance report — filters are bound, never interpolated', () => {
  test('a search string is a parameter, not SQL', async () => {
    queueAll();
    await svc.getReport(q({ search: "'; DROP TABLE maintenance_tickets; --" }));
    for (const c of mockDb.calls()) {
      expect(c.text).not.toMatch(/DROP TABLE/);
    }
    expect(mockDb.calls()[0].params).toContain("%'; DROP TABLE maintenance_tickets; --%");
  });

  test('status, type and priority are checked against a whitelist', async () => {
    await expect(svc.getReport(q({ status: 'NOPE' }))).rejects.toMatchObject({ status: 400 });
    await expect(svc.getReport(q({ issue_type: 'NOPE' }))).rejects.toMatchObject({ status: 400 });
    await expect(svc.getReport(q({ priority: 'NOPE' }))).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a whitelisted value passes, case-insensitively', async () => {
    queueAll();
    await svc.getReport(q({ status: 'closed', issue_type: 'breakdown' }));
    expect(mockDb.calls()[0].params).toContain('CLOSED');
    expect(mockDb.calls()[0].params).toContain('BREAKDOWN');
  });

  test('machine_id must be a positive integer', async () => {
    await expect(svc.getReport(q({ machine_id: 'abc' }))).rejects.toMatchObject({ status: 400 });
    await expect(svc.getReport(q({ machine_id: '-1' }))).rejects.toMatchObject({ status: 400 });
    await expect(svc.getReport(q({ machine_id: '1.5' }))).rejects.toMatchObject({ status: 400 });
  });

  test('a bad date range is refused, and from must not follow to', async () => {
    await expect(svc.getReport(q({ from: '01-08-2026' }))).rejects.toMatchObject({ status: 400 });
    await expect(svc.getReport(q({ from: '2026-08-31', to: '2026-08-01' })))
      .rejects.toMatchObject({ status: 400 });
  });

  test('no dates given defaults to the last 30 days rather than all of history', () => {
    const { start, end } = svc.resolveRange({});
    const days = (new Date(end) - new Date(start)) / 86_400_000;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(31);
  });
});

describe('maintenance report — MTTR is only ever a claim about resolved work', () => {
  test('the average is filtered to tickets that actually have a resolved_at', async () => {
    queueAll();
    await svc.getReport(q());
    const kpiSql = mockDb.calls()[0].text;
    // the average is over (resolved_at - created_at) ...
    expect(kpiSql).toMatch(/AVG\(EXTRACT\(EPOCH FROM \(t\.resolved_at - t\.created_at\)\)/);
    // ... and every AVG of it carries the FILTER that excludes open tickets
    for (const m of kpiSql.matchAll(/AVG\(EXTRACT\(EPOCH FROM \(t\.resolved_at[\s\S]{0,80}/g)) {
      expect(m[0]).toMatch(/FILTER \(WHERE t\.resolved_at IS NOT NULL\)/);
    }
  });

  test('the number of tickets it averages is reported with it', async () => {
    queueAll();
    const res = await svc.getReport(q());
    expect(res.kpis.mttr_hours).toBe(4.25);
    expect(res.kpis.mttr_basis).toBe(9);
    expect(res.kpis.mttr_basis_note).toBe('Mean of 9 resolved tickets');
  });

  test('nothing resolved says so instead of implying an instant repair', async () => {
    queueAll({ kpis: { mttr_hours: null, mttr_basis: 0 } });
    const res = await svc.getReport(q());
    expect(res.kpis.mttr_hours).toBeNull();
    expect(res.kpis.mttr_basis_note).toBe('No ticket has been resolved in this period');
  });

  test('a single resolved ticket is not called "tickets"', async () => {
    queueAll({ kpis: { mttr_basis: 1 } });
    const res = await svc.getReport(q());
    expect(res.kpis.mttr_basis_note).toBe('Mean of 1 resolved ticket');
  });
});

describe('maintenance report — unrecorded downtime is declared, not hidden', () => {
  test('tickets with no minutes entered are counted and named', async () => {
    queueAll();
    const res = await svc.getReport(q());
    expect(res.kpis.downtime_minutes).toBe(540);
    expect(res.kpis.downtime_unrecorded).toBe(2);
    expect(res.kpis.downtime_note).toBe('2 tickets recorded no downtime');
  });

  test('when every ticket has minutes there is no caveat to make', async () => {
    queueAll({ kpis: { downtime_unrecorded: 0 } });
    const res = await svc.getReport(q());
    expect(res.kpis.downtime_note).toBeNull();
  });

  test('the total sums the column rather than counting only non-null rows', async () => {
    queueAll();
    await svc.getReport(q());
    expect(mockDb.calls()[0].text).toMatch(/COALESCE\(SUM\(t\.downtime_minutes\), 0\)/);
  });
});

describe('maintenance report — shaping', () => {
  test('every status and issue type appears, including the ones with no tickets', async () => {
    queueAll({
      byType:   [{ issue_type: 'BREAKDOWN', n: 7 }],
      byStatus: [{ status: 'OPEN', n: 3 }]
    });
    const res = await svc.getReport(q());
    expect(res.by_type).toEqual({ BREAKDOWN: 7, ALARM: 0, INSPECTION: 0, OTHER: 0 });
    expect(res.by_status).toEqual({ OPEN: 3, ASSIGNED: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 });
  });

  test('the resolved filters come back so the UI can echo them', async () => {
    queueAll();
    const res = await svc.getReport(q({ machine_id: '7' }));
    expect(res.filters).toEqual({ from: '2026-08-01', to: '2026-08-31', machine_id: 7 });
  });

  test('pagination is bounded — a caller cannot ask for the whole table', async () => {
    queueAll();
    await svc.getReport(q({ limit: '99999' }));
    const rowsCall = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET \$\d+/.test(c.text));
    expect(rowsCall.params[rowsCall.params.length - 2]).toBe(200);
  });

  test('page 3 offsets by two pages, not by three', async () => {
    queueAll();
    await svc.getReport(q({ page: '3', limit: '25' }));
    const rowsCall = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET \$\d+/.test(c.text));
    expect(rowsCall.params[rowsCall.params.length - 1]).toBe(50);
  });

  test('an empty period reports zeros and one page, not a crash', async () => {
    queueAll({ kpis: { tickets: 0, settled: 0, open: 0, mttr_basis: 0, mttr_hours: null }, total: 0 });
    const res = await svc.getReport(q());
    expect(res.tickets.total).toBe(0);
    expect(res.tickets.totalPages).toBe(1);
    expect(res.by_machine).toEqual([]);
  });
});

describe('maintenance report — export rows', () => {
  test('the columns match the PDF header the controller passes', async () => {
    mockDb.queueResponse(
      { rows: [{ n: 1 }] },
      { rows: [{
        machine_serial_no: 'VMC-1', title: 'Spindle noise', issue_type: 'BREAKDOWN',
        priority: 'HIGH', status: 'CLOSED', created_at: '2026-08-06T09:00:00Z',
        resolved_at: '2026-08-06T13:15:00Z', repair_hours: 4.25, downtime_minutes: 255,
        assigned_to_name: 'ravi', parts_used: 'bearing'
      }] }
    );
    const rows = await svc.getExportRows(q());
    expect(Object.keys(rows[0])).toEqual([
      'Machine', 'Title', 'Type', 'Priority', 'Status', 'Raised', 'Resolved',
      'Repair (h)', 'Downtime (min)', 'Assigned to', 'Parts used'
    ]);
    expect(rows[0]['Raised']).toBe('2026-08-06 09:00:00');
    expect(rows[0]['Assigned to']).toBe('ravi');
  });

  test('an open ticket exports blank cells, not zeros that read as instant repairs', async () => {
    mockDb.queueResponse(
      { rows: [{ n: 1 }] },
      { rows: [{
        machine_serial_no: 'VMC-2', title: 'Coolant leak', issue_type: 'BREAKDOWN',
        priority: 'LOW', status: 'OPEN', created_at: '2026-08-06T09:00:00Z',
        resolved_at: null, repair_hours: null, downtime_minutes: null,
        assigned_to_name: null, parts_used: null
      }] }
    );
    const rows = await svc.getExportRows(q());
    expect(rows[0]['Resolved']).toBe('');
    expect(rows[0]['Repair (h)']).toBe('');
    expect(rows[0]['Downtime (min)']).toBe('');
    expect(rows[0]['Assigned to']).toBe('Unassigned');
  });
});
