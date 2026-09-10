/*
 * Unit tests for dashboard/alarm.service — Phase 2 Screen 5.
 *
 * Two things carry this screen.
 *
 * Duration. An alarm ends when the machine stops reporting it and is
 * resolved when a person says they dealt with it. Measuring to resolved_at
 * would report how long someone took to click a button — a different
 * question, and not the one "maximum alarm duration" asks.
 *
 * Parameter binding. Eight optional filters means eight ways to shift the
 * placeholder indices, and a query handed more parameters than it
 * references is rejected outright by Postgres. That fault took an endpoint
 * down on Screen 4 while every SQL-text assertion stayed green, so here it
 * is checked directly.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/alarm.service');

const company_id = 4;

/** getAlarms fires seven queries; the list is two (page + count). */
function queueAll(kpi = {}) {
  mockDb.queueResponse(
    { rows: [{ total: 0, critical: 0, normal: 0, open: 0,
               max_duration_seconds: 0, avg_duration_seconds: 0, ...kpi }] },
    { rows: [] },                    // by machine
    { rows: [] },                    // by shift
    { rows: [{ critical: 0, normal: 0 }] },
    { rows: [] },                    // trend
    { rows: [] },                    // list page
    { rows: [{ total: 0 }] },        // list count
    { rows: [] }                     // facets
  );
}

beforeEach(() => resetDb());

describe('every query binds exactly the parameters it references', () => {
  const highest = sql => {
    const refs = [...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    return refs.length ? Math.max(...refs) : 0;
  };

  test.each([
    ['no filters',        {}],
    ['date range',        { from: '2026-09-01', to: '2026-09-10' }],
    ['machine',           { machine_id: 36 }],
    ['shift',             { shift_id: 1 }],
    ['alarm type',        { alarm_type: 'SPINDLE' }],
    ['alarm code',        { alarm_code: 'SV0401' }],
    ['severity',          { severity: 'CRITICAL' }],
    ['search',            { search: 'spindle' }],
    ['everything at once', { from: '2026-09-01', to: '2026-09-10', machine_id: 36, shift_id: 1,
                             alarm_type: 'SPINDLE', alarm_code: 'SV0401', severity: 'CRITICAL',
                             search: 'x', page: 2, limit: 50 }]
  ])('%s', async (_label, filters) => {
    queueAll();
    await svc.getAlarms({ company_id, ...filters });

    for (const call of mockDb.calls()) {
      expect(call.params.length).toBe(highest(call.text));
    }
  });

  test('the export path too', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    await svc.getExportRows({ company_id, machine_id: 36, search: 'x', severity: 'CRITICAL',
                              from: '2026-09-01', to: '2026-09-10' });
    for (const call of mockDb.calls()) {
      expect(call.params.length).toBe(highest(call.text));
    }
  });
});

describe('duration', () => {
  test('is measured to ended_at, not resolved_at', async () => {
    queueAll();
    await svc.getAlarms({ company_id });

    const kpi = mockDb.calls()[0].text;
    expect(kpi).toMatch(/COALESCE\(a\.ended_at, NOW\(\)\) - a\.started_at/);
    // resolved_at is when a person acknowledged it — a different question
    expect(kpi).not.toMatch(/resolved_at - a\.started_at/);
  });

  test('an alarm still open counts against now, so the worst one is visible', async () => {
    queueAll({ max_duration_seconds: 7200 });
    const d = await svc.getAlarms({ company_id });

    // otherwise the longest outage on the floor stays invisible until
    // someone closes it
    expect(mockDb.calls()[0].text).toMatch(/MAX\(EXTRACT\(EPOCH FROM \(COALESCE\(a\.ended_at, NOW\(\)\)/);
    expect(d.kpis.max_duration_seconds).toBe(7200);
  });

  test('average excludes alarms that have not ended', async () => {
    queueAll();
    await svc.getAlarms({ company_id });
    expect(mockDb.calls()[0].text).toMatch(/FILTER \(WHERE a\.ended_at IS NOT NULL\)/);
  });
});

describe('severity', () => {
  test('anything not CRITICAL counts as normal rather than being dropped', async () => {
    queueAll();
    await svc.getAlarms({ company_id });

    const kpi = mockDb.calls()[0].text;
    // an alarm missing from the count is worse than one in the wrong bucket
    expect(kpi).toMatch(/UPPER\(a\.severity\) = 'CRITICAL'/);
    expect(kpi).toMatch(/UPPER\(a\.severity\) <> 'CRITICAL'/);
  });

  test('the severity filter is case-insensitive', async () => {
    queueAll();
    await svc.getAlarms({ company_id, severity: 'critical' });
    expect(mockDb.calls()[0].params).toContain('CRITICAL');
  });
});

describe('the window', () => {
  test('is bounded by started_at when dates are given', async () => {
    queueAll();
    await svc.getAlarms({ company_id, from: '2026-09-01', to: '2026-09-10' });

    // machine_alarms grows with every fault; a query with no started_at
    // predicate gets slower every week until it stops returning
    expect(mockDb.calls()[0].text).toMatch(/a\.started_at >= \$\d/);
    expect(mockDb.calls()[0].text).toMatch(/a\.started_at <= \$\d/);
  });

  test('the end of the range includes the whole day', async () => {
    queueAll();
    await svc.getAlarms({ company_id, to: '2026-09-10' });
    // "to 2026-09-10" meaning midnight would silently drop that day
    expect(mockDb.calls()[0].params.some(p => String(p).includes('23:59:59'))).toBe(true);
  });

  test.each([['not-a-date'], ['2026-13-45'], ['10/09/2026']])('rejects %p as a 400', async (bad) => {
    await expect(svc.getAlarms({ company_id, from: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a range that runs backwards', async () => {
    await expect(svc.getAlarms({ company_id, from: '2026-09-10', to: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('input validation', () => {
  test.each([['abc'], ['-1'], ['0'], ['1.5']])('machine_id %p is a 400, not a 500', async (bad) => {
    await expect(svc.getAlarms({ company_id, machine_id: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('shift_id is validated the same way', async () => {
    await expect(svc.getAlarms({ company_id, shift_id: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('the alarm table', () => {
  test('orders by a total order so pages cannot repeat a row', async () => {
    queueAll();
    await svc.getAlarms({ company_id });

    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    // a faulting machine raises many alarms in the same second
    expect(list.text).toMatch(/ORDER BY a\.started_at DESC, a\.id DESC/);
  });

  test('caps the page size a caller can ask for', async () => {
    queueAll();
    await svc.getAlarms({ company_id, limit: 100000 });
    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.params.at(-2)).toBeLessThanOrEqual(200);
  });

  test('a search term is parameterised, never interpolated', async () => {
    queueAll();
    await svc.getAlarms({ company_id, search: "'; DROP TABLE machine_alarms;--" });

    const q = mockDb.calls().find(c => /ILIKE/.test(c.text));
    expect(q.text).not.toMatch(/DROP TABLE/);
    expect(q.params).toContain("%'; DROP TABLE machine_alarms;--%");
  });

  test('open and closed are distinguished by ended_at', async () => {
    queueAll();
    await svc.getAlarms({ company_id });
    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.text).toMatch(/\(a\.ended_at IS NULL\)\s+AS is_open/);
  });
});

describe('everything is scoped to the caller company', () => {
  test.each([[{}], [{ machine_id: 36 }], [{ search: 'x' }], [{ severity: 'CRITICAL' }]])(
    'with filters %p', async (filters) => {
      queueAll();
      await svc.getAlarms({ company_id, ...filters });
      for (const call of mockDb.calls()) {
        if (!/machine_alarms/.test(call.text)) continue;
        expect(call.text).toMatch(/company_id = \$1/);
        expect(call.params[0]).toBe(company_id);
      }
    });
});

describe('export', () => {
  test('is bounded, so a year of alarms still returns', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    await svc.getExportRows({ company_id });
    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.params.at(-2)).toBeLessThanOrEqual(200);
  });

  test('produces the columns the report is specified to carry', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, machine_serial_no: 'VMC-01', shift_name: 'Shift 1',
                 alarm_code: 'SV0401', alarm_type: 'Spindle overload', severity: 'CRITICAL',
                 started_at: '2026-09-10T02:00:00Z', ended_at: '2026-09-10T03:30:00Z',
                 is_open: false, duration_seconds: 5400, message: 'Load exceeded' }] },
      { rows: [{ total: 1 }] }
    );

    const rows = await svc.getExportRows({ company_id });

    expect(Object.keys(rows[0])).toEqual([
      'Machine', 'Shift', 'Alarm code', 'Alarm name', 'Severity',
      'Generated', 'Closed', 'Duration', 'Status', 'Message'
    ]);
    expect(rows[0]['Duration']).toBe('1h 30m');
    expect(rows[0]['Status']).toBe('Closed');
    expect(rows[0]['Severity']).toBe('Critical');
  });

  test('an open alarm exports with a blank close time, not a fabricated one', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, machine_serial_no: 'VMC-01', shift_name: 'Shift 1',
                 alarm_code: null, alarm_type: 'Door open', severity: 'WARNING',
                 started_at: '2026-09-10T02:00:00Z', ended_at: null,
                 is_open: true, duration_seconds: 600, message: null }] },
      { rows: [{ total: 1 }] }
    );

    const rows = await svc.getExportRows({ company_id });

    expect(rows[0]['Closed']).toBe('');
    expect(rows[0]['Status']).toBe('Open');
    expect(rows[0]['Severity']).toBe('Normal');
    expect(rows[0]['Duration']).toBe('0h 10m');
  });
});
