/*
 * Unit tests for dashboard/operator.service — Phase 2 Screen 7.
 *
 * The hard part of this screen is not arithmetic, it is attribution. No
 * production table carries an operator: production_hourly, oee_hourly and
 * quality_entries are all keyed by machine and shift, and the only link to
 * a person is operator_machine_assignments — which in this database is not
 * exclusive. Ten of forty-one machines have two or three operators assigned
 * at once, and no assignment has ever been closed.
 *
 * So "operator X produced N parts" is not a fact the data supports. These
 * tests pin the honest alternative: each operator carries the figures for
 * the machines they are responsible for, every row says how many of those
 * are shared, and fleet totals are measured per machine rather than summed
 * across operators — because summing would count shared output twice.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/operator.service');

const company_id = 4;

/** getOperators fires the aggregate, then three fleet queries. */
function queueAll(operatorRows = [], fleet = {}) {
  mockDb.queueResponse(
    { rows: operatorRows },
    { rows: [{ produced: '0', run_seconds: '0', idle_seconds: '0', ...(fleet.prod || {}) }] },
    { rows: [{ oee: fleet.oee ?? null }] },
    { rows: [{ rejected: fleet.rejected ?? '0' }] }
  );
}

const row = (over = {}) => ({
  operator_id: 1, operator_code: 'OP1', operator_name: 'A. Kumar', skill_level: 'L2',
  machine_count: 1, shared_machines: 0,
  produced: '100', rejected: '5', run_seconds: '3600', idle_seconds: '1200',
  downtime_seconds: '0', alarm_count: 0, oee: null, performance: null, ...over
});

beforeEach(() => resetDb());

describe('derived rates', () => {
  test('good parts are produced minus rejected', () => {
    const d = svc.derive(row({ produced: '100', rejected: '5' }));
    expect(d.good).toBe(95);
    expect(d.quality_rate_pct).toBe(95);
    expect(d.rejection_rate_pct).toBe(5);
  });

  test('good never goes negative when rejects exceed the telemetry count', () => {
    // rejects are typed in by hand and produced comes from telemetry, so
    // the two can disagree; a negative "good" would be nonsense on a tile
    const d = svc.derive(row({ produced: '10', rejected: '50' }));
    expect(d.good).toBe(0);
  });

  test('utilization is run over run plus idle', () => {
    const d = svc.derive(row({ run_seconds: '3600', idle_seconds: '1200' }));
    expect(d.utilization_pct).toBe(75);
  });

  test.each([
    ['quality_rate_pct',   { produced: '0', rejected: '0' }],
    ['rejection_rate_pct', { produced: '0', rejected: '0' }],
    ['utilization_pct',    { run_seconds: '0', idle_seconds: '0' }]
  ])('%s is null, not zero, when its denominator is absent', (field, over) => {
    // "0% quality" for an operator whose machines produced nothing is a
    // different claim from one who produced only scrap
    expect(svc.derive(row(over))[field]).toBeNull();
  });

  test('OEE and efficiency stay null when nothing was recorded', () => {
    const d = svc.derive(row({ oee: null, performance: null }));
    expect(d.oee_pct).toBeNull();
    expect(d.efficiency_pct).toBeNull();
  });

  test('numbers come back as numbers, not driver strings', () => {
    const d = svc.derive(row());
    for (const k of ['produced', 'good', 'rejected', 'run_seconds', 'alarm_count']) {
      expect(typeof d[k]).toBe('number');
    }
  });
});

describe('ranking', () => {
  const mk = (name, oee, produced) => ({ operator_name: name, oee_pct: oee, produced });

  test('orders by OEE, then by produced quantity', () => {
    const out = svc.rank([mk('a', 50, 10), mk('b', 80, 5), mk('c', 80, 99)]);
    expect(out.map(r => r.operator_name)).toEqual(['c', 'b', 'a']);
  });

  test('operators with no OEE sort last rather than counting as zero', () => {
    // absent is not bad; ranking a new operator below everyone because
    // nothing has been measured yet would be a false judgement
    const out = svc.rank([mk('none', null, 999), mk('low', 10, 1)]);
    expect(out.map(r => r.operator_name)).toEqual(['low', 'none']);
  });

  test('falls back to quantity when nobody has an OEE', () => {
    const out = svc.rank([mk('a', null, 5), mk('b', null, 50)]);
    expect(out.map(r => r.operator_name)).toEqual(['b', 'a']);
  });

  test('does not mutate the array it was given', () => {
    const input = [mk('a', 10, 1), mk('b', 90, 1)];
    svc.rank(input);
    expect(input.map(r => r.operator_name)).toEqual(['a', 'b']);
  });
});

describe('attribution is disclosed, never guessed at', () => {
  test('a shared machine is reported on every operator who has it', async () => {
    queueAll([
      row({ operator_id: 1, operator_name: 'A', produced: '3414', shared_machines: 1 }),
      row({ operator_id: 2, operator_name: 'B', produced: '3414', shared_machines: 1 })
    ]);
    const d = await svc.getOperators({ company_id });

    // both carry the full figure, and both say it is shared — splitting it
    // would invent numbers nobody measured
    expect(d.operators.data.map(r => r.produced)).toEqual([3414, 3414]);
    expect(d.operators.data.every(r => r.shared_machines === 1)).toBe(true);
  });

  test('the response states how many operators share a machine', async () => {
    queueAll([row({ shared_machines: 1 }), row({ operator_id: 2, shared_machines: 0 })]);
    const d = await svc.getOperators({ company_id });

    expect(d.attribution.operators).toBe(2);
    expect(d.attribution.shared_machines).toBe(1);
    expect(d.attribution.note).toMatch(/more than one assigned operator/i);
  });

  test('fleet totals are measured per machine, not summed from operators', async () => {
    queueAll(
      [row({ produced: '3414' }), row({ operator_id: 2, produced: '3414' })],
      { prod: { produced: '3414', run_seconds: '100', idle_seconds: '100' } }
    );
    const d = await svc.getOperators({ company_id });

    // summing the rows would report 6828 for output that was produced once
    expect(d.kpis.produced).toBe(3414);
    expect(mockDb.calls()[1].text).toMatch(/FROM production_hourly/);
  });
});

describe('tenant scoping', () => {
  test('quality is scoped through the machine, since the table has no company_id', async () => {
    queueAll();
    await svc.getOperators({ company_id });

    const agg = mockDb.calls()[0].text;
    // without this join quality_entries is global and one company's reject
    // counts leak into another's numbers
    expect(agg).toMatch(/FROM quality_entries q\s*\n\s*JOIN machines qm ON qm\.id = q\.machine_id AND qm\.company_id = \$1/);
    expect(mockDb.calls()[3].text).toMatch(/JOIN machines m ON m\.id = q\.machine_id AND m\.company_id = \$1/);
  });

  test('OEE is scoped through the machine too', async () => {
    queueAll();
    await svc.getOperators({ company_id });

    // oee_hourly.company_id is NULL on almost every row, so filtering on it
    // directly returns nothing and the screen silently reports no OEE
    expect(mockDb.calls()[0].text).toMatch(/JOIN machines om ON om\.id = o\.machine_id AND om\.company_id = \$1/);
    expect(mockDb.calls()[2].text).toMatch(/JOIN machines m ON m\.id = o\.machine_id AND m\.company_id = \$1/);
  });

  test('operators and assignments are scoped directly', async () => {
    queueAll();
    await svc.getOperators({ company_id });
    const agg = mockDb.calls()[0].text;
    expect(agg).toMatch(/a\.company_id = \$1/);
    expect(agg).toMatch(/op\.company_id = \$1/);
    expect(mockDb.calls()[0].params[0]).toBe(company_id);
  });
});

describe('every query binds exactly the parameters it references', () => {
  const refs = sql => [...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1]));

  test.each([
    ['no filters',  {}],
    ['date range',  { from: '2026-08-01', to: '2026-09-10' }],
    ['machine',     { machine_id: 36 }],
    ['shift',       { shift_id: 5 }],
    ['operator',    { operator_id: 2 }],
    ['search',      { search: 'kumar' }],
    ['everything',  { from: '2026-08-01', to: '2026-09-10', machine_id: 36,
                      shift_id: 5, operator_id: 2, search: 'a', page: 2, limit: 50 }]
  ])('%s', async (_label, filters) => {
    queueAll();
    await svc.getOperators({ company_id, ...filters });

    for (const call of mockDb.calls()) {
      const used = refs(call.text);
      const highest = used.length ? Math.max(...used) : 0;
      // the count must match…
      expect(call.params.length).toBe(highest);
      // …and no placeholder in between may go unreferenced, or Postgres
      // cannot infer its type and rejects the statement outright
      for (let i = 1; i <= highest; i++) expect(used).toContain(i);
    }
  });
});

describe('assignment window', () => {
  test('an assignment counts when it overlaps the period, open-ended included', async () => {
    queueAll();
    await svc.getOperators({ company_id, from: '2026-08-01', to: '2026-09-10' });

    const agg = mockDb.calls()[0].text;
    // assigned_to is NULL on every row in this database, so an
    // assignment that never closed must still count
    expect(agg).toMatch(/a\.assigned_from <= \$3/);
    expect(agg).toMatch(/a\.assigned_to IS NULL OR a\.assigned_to >= \$2/);
  });
});

describe('input validation', () => {
  test.each([['machine_id'], ['shift_id'], ['operator_id']])(
    '%s must be a positive integer', async (field) => {
      await expect(svc.getOperators({ company_id, [field]: 'abc' })).rejects.toMatchObject({ status: 400 });
      await expect(svc.getOperators({ company_id, [field]: '0' })).rejects.toMatchObject({ status: 400 });
    });

  test.each([['nope'], ['2026-13-01']])('rejects date %p', async (bad) => {
    await expect(svc.getOperators({ company_id, from: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a backwards range', async () => {
    await expect(svc.getOperators({ company_id, from: '2026-09-10', to: '2026-08-01' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('search is parameterised, never interpolated', async () => {
    queueAll();
    await svc.getOperators({ company_id, search: "'; DROP TABLE operators;--" });
    expect(mockDb.calls()[0].text).not.toMatch(/DROP TABLE/);
    expect(mockDb.calls()[0].params).toContain("%'; DROP TABLE operators;--%");
  });

  test('caps the page size', async () => {
    queueAll(Array.from({ length: 5 }, (_, i) => row({ operator_id: i + 1 })));
    const d = await svc.getOperators({ company_id, limit: 99999 });
    expect(d.operators.limit).toBeLessThanOrEqual(200);
  });
});

describe('export', () => {
  test('carries the columns the report is specified to have', async () => {
    queueAll([row({ operator_name: 'A. Kumar', operator_code: 'OP1' })]);
    const rows = await svc.getExportRows({ company_id });

    expect(Object.keys(rows[0])).toEqual([
      'Operator ID', 'Operator', 'Machines', 'Shared', 'Run time', 'Down time',
      'Utilization', 'Produced', 'Good', 'Rejected', 'Quality rate', 'Alarms',
      'OEE', 'Efficiency'
    ]);
    expect(rows[0]['Produced']).toBe(100);
    expect(rows[0]['Good']).toBe(95);
  });

  test('an unmeasured rate exports blank rather than a misleading zero', async () => {
    queueAll([row({ produced: '0', rejected: '0', run_seconds: '0', idle_seconds: '0' })]);
    const rows = await svc.getExportRows({ company_id });
    expect(rows[0]['Quality rate']).toBe('');
    expect(rows[0]['Utilization']).toBe('');
  });

  test('marks which operators share machines', async () => {
    queueAll([row({ shared_machines: 2 })]);
    const rows = await svc.getExportRows({ company_id });
    expect(rows[0]['Shared']).toBe('2 shared');
  });
});
