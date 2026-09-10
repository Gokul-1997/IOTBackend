/*
 * Unit tests for dashboard/downtime.service — Phase 2 Screen 6.
 *
 * The screen draws on two sources that answer different halves of the
 * question, and the tests are mostly about not conflating them:
 *
 *   production_hourly  measured run and idle time, from telemetry
 *   downtime_events    declared reasons, typed in by operators
 *
 * Reporting idle time as "downtime by reason" would be the tempting
 * shortcut and a lie. Idle time is measured; reasons are declared; the gap
 * between them is the number that tells a plant whether its downtime
 * reporting is worth anything.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/downtime.service');

const company_id = 4;

/* getDowntime fires: measured, alarm, declared, byReason, byCategory,
   byShift, hourly, list(page + count) — nine queries. */
function queueAll({ measured = {}, declared = {}, reasons = [] } = {}) {
  mockDb.queueResponse(
    { rows: [{ run_seconds: '0', idle_seconds: '0', manual_seconds: '0', ...measured }] },
    { rows: [{ alarm_seconds: '0' }] },
    { rows: [{ events: 0, downtime_seconds: '0', open_events: 0, ...declared }] },
    { rows: reasons },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [{ total: 0 }] }
  );
}

beforeEach(() => resetDb());

describe('every query binds exactly the parameters it references', () => {
  const highest = sql => {
    const refs = [...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    return refs.length ? Math.max(...refs) : 0;
  };

  test.each([
    ['no filters',   {}],
    ['date range',   { from: '2026-09-01', to: '2026-09-10' }],
    ['machine',      { machine_id: 36 }],
    ['shift',        { shift_id: 1 }],
    ['operator',     { operator_id: 2 }],
    ['reason',       { reason_id: 3 }],
    ['category',     { category: 'UNPLANNED' }],
    ['search',       { search: 'breakdown' }],
    ['everything',   { from: '2026-09-01', to: '2026-09-10', machine_id: 36, shift_id: 1,
                       operator_id: 2, reason_id: 3, category: 'PLANNED', search: 'x',
                       page: 2, limit: 50 }]
  ])('%s', async (_label, filters) => {
    queueAll();
    await svc.getDowntime({ company_id, ...filters });
    for (const call of mockDb.calls()) {
      expect(call.params.length).toBe(highest(call.text));
    }
  });
});

describe('availability comes from measured telemetry, not declared reasons', () => {
  test('is run over run plus idle', async () => {
    queueAll({ measured: { run_seconds: '3600', idle_seconds: '1200' } });
    const d = await svc.getDowntime({ company_id });
    expect(d.kpis.availability_pct).toBe(75);   // 3600 / 4800
  });

  test('reads from production_hourly, never from downtime_events', async () => {
    queueAll();
    await svc.getDowntime({ company_id });
    expect(mockDb.calls()[0].text).toMatch(/FROM production_hourly/);
    expect(mockDb.calls()[0].text).not.toMatch(/downtime_events/);
  });

  test('is null, not zero, when no telemetry was recorded', async () => {
    // "0% available" for a machine that reported nothing is a different
    // claim from a machine that ran badly
    queueAll({ measured: { run_seconds: '0', idle_seconds: '0' } });
    const d = await svc.getDowntime({ company_id });
    expect(d.kpis.availability_pct).toBeNull();
  });

  test('is bounded by hour_start so the query cannot grow unbounded', async () => {
    queueAll();
    await svc.getDowntime({ company_id });
    expect(mockDb.calls()[0].text).toMatch(/hour_start >= \$2/);
    expect(mockDb.calls()[0].text).toMatch(/hour_start <= \$3/);
  });
});

describe('the gap between measured and declared is named', () => {
  test('unaccounted idle is idle minus what has a reason', async () => {
    queueAll({
      measured: { run_seconds: '0', idle_seconds: '10000' },
      declared: { downtime_seconds: '4000', events: 3 }
    });
    const d = await svc.getDowntime({ company_id });
    expect(d.kpis.unaccounted_seconds).toBe(6000);
    expect(d.kpis.reason_coverage_pct).toBe(40);
  });

  test('never goes negative when more is declared than was measured idle', async () => {
    // overlapping or mistyped entries can exceed measured idle; a negative
    // "unaccounted" would be nonsense on the tile
    queueAll({
      measured: { run_seconds: '0', idle_seconds: '1000' },
      declared: { downtime_seconds: '5000' }
    });
    const d = await svc.getDowntime({ company_id });
    expect(d.kpis.unaccounted_seconds).toBe(0);
  });

  test('coverage is null when nothing was idle at all', async () => {
    queueAll({ measured: { run_seconds: '3600', idle_seconds: '0' } });
    const d = await svc.getDowntime({ company_id });
    expect(d.kpis.reason_coverage_pct).toBeNull();
  });
});

describe('event durations are clamped to the window', () => {
  test('an event spanning the boundary contributes only its overlap', async () => {
    queueAll();
    await svc.getDowntime({ company_id });

    const declared = mockDb.calls()[2].text;
    // a stoppage that began before the window would otherwise inflate
    // every day it touches
    expect(declared).toMatch(/LEAST\(COALESCE\(e\.ended_at, NOW\(\)\), \$3/);
    expect(declared).toMatch(/GREATEST\(e\.started_at, \$2/);
  });

  test('an open event counts to now', async () => {
    queueAll();
    await svc.getDowntime({ company_id });
    expect(mockDb.calls()[2].text).toMatch(/COALESCE\(e\.ended_at, NOW\(\)\)/);
  });
});

describe('the Pareto', () => {
  const rows = [
    { reason: 'Breakdown', reason_id: 1, category: 'UNPLANNED', events: 2, seconds: '6000', grand_total: '10000', cumulative: '6000' },
    { reason: 'Material',  reason_id: 2, category: 'UNPLANNED', events: 1, seconds: '3000', grand_total: '10000', cumulative: '9000' },
    { reason: 'Cleaning',  reason_id: 3, category: 'PLANNED',   events: 1, seconds: '1000', grand_total: '10000', cumulative: '10000' }
  ];

  test('carries share and a running cumulative — what makes it a Pareto', async () => {
    queueAll({ reasons: rows });
    const d = await svc.getDowntime({ company_id });

    expect(d.by_reason.map(r => r.share_pct)).toEqual([60, 30, 10]);
    expect(d.by_reason.map(r => r.cumulative_pct)).toEqual([60, 90, 100]);
  });

  test('cumulative ends at exactly 100', async () => {
    queueAll({ reasons: rows });
    const d = await svc.getDowntime({ company_id });
    expect(d.by_reason.at(-1).cumulative_pct).toBe(100);
  });

  test('top reasons is the first five of the same ordering', async () => {
    queueAll({ reasons: rows });
    const d = await svc.getDowntime({ company_id });
    expect(d.top_reasons).toEqual(d.by_reason.slice(0, 5));
  });

  test('an empty period produces no division by zero', async () => {
    queueAll({ reasons: [] });
    const d = await svc.getDowntime({ company_id });
    expect(d.by_reason).toEqual([]);
    expect(d.top_reasons).toEqual([]);
  });
});

describe('the hourly profile', () => {
  test('always has 24 slots so the axis cannot lie about which hour a bar is', async () => {
    queueAll();
    const d = await svc.getDowntime({ company_id });
    expect(d.hourly).toHaveLength(24);
    expect(d.hourly.map(h => h.hour)).toEqual([...Array(24).keys()]);
  });

  test('is grouped in the plant timezone, not UTC', async () => {
    queueAll();
    await svc.getDowntime({ company_id });
    const hourly = mockDb.calls().find(c => /EXTRACT\(HOUR FROM/.test(c.text));
    expect(hourly.text).toMatch(/Asia\/Kolkata/);
  });
});

describe('the window', () => {
  test('defaults to the last 7 days rather than all time', async () => {
    const { start, end } = svc.resolveRange({});
    const days = (new Date(end) - new Date(start)) / 86_400_000;
    expect(days).toBeGreaterThan(5.5);
    expect(days).toBeLessThan(7.5);
  });

  test.each([['nope'], ['2026-13-01'], ['01/09/2026']])('rejects %p', async (bad) => {
    await expect(svc.getDowntime({ company_id, from: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a backwards range', async () => {
    await expect(svc.getDowntime({ company_id, from: '2026-09-10', to: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('input validation', () => {
  test.each([['machine_id'], ['shift_id'], ['operator_id'], ['reason_id']])(
    '%s must be a positive integer', async (field) => {
      await expect(svc.getDowntime({ company_id, [field]: 'abc' })).rejects.toMatchObject({ status: 400 });
      await expect(svc.getDowntime({ company_id, [field]: '-1' })).rejects.toMatchObject({ status: 400 });
    });
});

describe('the detail table', () => {
  test('orders by a total order so pages cannot repeat a row', async () => {
    queueAll();
    await svc.getDowntime({ company_id });
    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.text).toMatch(/ORDER BY e\.started_at DESC, e\.id DESC/);
  });

  test('caps the page size', async () => {
    queueAll();
    await svc.getDowntime({ company_id, limit: 99999 });
    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    expect(list.params.at(-2)).toBeLessThanOrEqual(200);
  });

  test('search is parameterised, never interpolated', async () => {
    queueAll();
    await svc.getDowntime({ company_id, search: "'; DROP TABLE downtime_events;--" });
    const q = mockDb.calls().find(c => /ILIKE/.test(c.text));
    expect(q.text).not.toMatch(/DROP TABLE/);
  });

  test('open status is derived from ended_at, not a stored flag', async () => {
    queueAll();
    await svc.getDowntime({ company_id });
    const list = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    // a stored status column is a second source of truth that drifts the
    // first time something closes an event without updating it
    expect(list.text).toMatch(/\(e\.ended_at IS NULL\)\s+AS is_open/);
  });
});

describe('export', () => {
  test('carries every column the report is specified to have', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, machine_serial_no: 'VMC-01', shift_name: 'Morning',
                 started_at: '2026-09-10T02:00:00Z', ended_at: '2026-09-10T05:00:00Z',
                 duration_seconds: 10800, reason: 'Machine Breakdown', category: 'UNPLANNED',
                 sub_reason: 'Spindle bearing', operator_name: 'A. Kumar', is_open: false }] },
      { rows: [{ total: 1 }] }
    );
    const rows = await svc.getExportRows({ company_id });

    expect(Object.keys(rows[0])).toEqual([
      'Machine', 'Shift', 'Start', 'End', 'Duration',
      'Reason', 'Category', 'Sub reason', 'Operator', 'Status'
    ]);
    expect(rows[0]['Duration']).toBe('3h 00m');
    expect(rows[0]['Status']).toBe('Closed');
  });

  test('an open event exports a blank end, not a fabricated one', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, machine_serial_no: 'VMC-01', shift_name: 'Morning',
                 started_at: '2026-09-10T02:00:00Z', ended_at: null, duration_seconds: 1800,
                 reason: 'Quality Issue', category: 'QUALITY', sub_reason: null,
                 operator_name: null, is_open: true }] },
      { rows: [{ total: 1 }] }
    );
    const rows = await svc.getExportRows({ company_id });
    expect(rows[0]['End']).toBe('');
    expect(rows[0]['Status']).toBe('Open');
    expect(rows[0]['Operator']).toBe('Unassigned');
  });
});
