/*
 * Unit tests for dashboard/energy.service — Phase 2 Screen 9.
 *
 * Devices report energy as a cumulative kWh counter, so consumption over a
 * period is a difference, not a sum. Summing the readings would add up a
 * running total and produce a number with no meaning.
 *
 * The subtraction has one trap worth testing hard. MAX(energy) - MIN(energy)
 * over a period looks equivalent to differencing and is not: it cannot see
 * a counter reset that happens inside the period. A meter replaced mid-day
 * reading 500, 520, 3, 5 has MAX 520 and MIN 3, giving 517 kWh for a
 * machine that used 22. This was written that way first, and an end-to-end
 * run against real rows caught it.
 *
 * Real meters also misread: a 0 between two real readings, or a jump no
 * machine could draw. Differencing those booked a whole meter total
 * (107 million kWh) into one interval, so both count nothing.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/energy.service');

const company_id = 4;

/*
 * getEnergy asks, in this order: the shift split (charts only), the
 * settings, then — worked out once per company, machine and range and
 * shared (cache.js) — the one pass over the meter counters (per machine,
 * per day, per month, and the days of the range) and the per-machine
 * running time, output and peak power.
 *
 * The fixtures describe a machine as one row; these split it into what each
 * of the two queries answers.
 */
const COUNTER = ['kwh', 'days', 'readings', 'rejected_intervals'];
const counterRows = (machines, extra = []) => [
  ...machines.filter(m => m.kwh !== null && m.kwh !== undefined)
    .map(m => ({ kind: 'machine', machine_id: m.machine_id, kwh: m.kwh, readings: m.readings, n: m.days, rejected_intervals: m.rejected_intervals || 0 })),
  ...extra
];
const machineOnly = machines => machines.map(m =>
  Object.fromEntries(Object.entries(m).filter(([k]) => !COUNTER.includes(k))));

function queueAll({ machines = [], shifts = [], settings = [], counters = [] } = {}) {
  mockDb.queueResponse(
    { rows: shifts }, { rows: settings }, { rows: counterRows(machines, counters) }, { rows: machineOnly(machines) }
  );
}

/* The table (and the export) asks for no shift split. */
function queueTable({ machines = [], settings = [] } = {}) {
  mockDb.queueResponse({ rows: settings }, { rows: counterRows(machines) }, { rows: machineOnly(machines) });
}

/* Every statement sent, as one text. */
const allSql = () => mockDb.calls().map(c => c.text).join('\n');

const machineRow = (over = {}) => ({
  machine_id: 1, machine_serial_no: 'VMC-01', model: 'VF700',
  kwh: '30', days: 1, readings: '3',
  run_seconds: '3600', produced: '100', peak_kw: '12', ...over
});

beforeEach(() => resetDb());

describe('consumption comes from differences, not sums', () => {
  /* Assertions about what the SQL does must not read its comments — the
     comment here explains why MAX-MIN is wrong, and matching it would make
     the test fail on prose rather than on behaviour. */
  const executable = sql => String(sql).replace(/\/\*[\s\S]*?\*\//g, '');

  test('the query differences consecutive readings', async () => {
    queueAll();
    await svc.getEnergy({ company_id });

    const sql = executable(allSql());
    expect(sql).toMatch(/LAG\(t\.energy\)\s+OVER w/);
    expect(sql).toMatch(/WINDOW w AS \(PARTITION BY t\.machine_id ORDER BY t\.observed_at, t\.received_at\)/);
    // MAX-MIN cannot see a reset inside the period
    expect(sql).not.toMatch(/MAX\(energy\)\s*-\s*MIN\(energy\)/);
  });

  test('a falling counter is an unknown gap, never negative consumption', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // a machine cannot un-consume electricity
    expect(executable(allSql())).toMatch(/WHEN energy < prev_energy THEN NULL/);
  });

  test('a 0 is a dropped read, so the climb back from it is not consumption', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // VMC - 13 - M sent 0 in most messages; 0 → 107,615,280 is not 107 million kWh
    const sql = executable(allSql());
    expect(sql).toMatch(/AND t\.energy > 0/);
    expect(sql).not.toMatch(/t\.energy IS NOT NULL/);
  });

  test('a rise no machine could draw is an unknown gap', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // over 2,000 kW since the last reading, measured over at least five minutes
    expect(executable(allSql())).toMatch(
      /energy - prev_energy\s+> 2000 \* GREATEST\(EXTRACT\(EPOCH FROM observed_at - prev_at\), 300\) \/ 3600\.0 THEN NULL/);
  });

  test('a rise below the smallest possible limit is kept without its own limit; the exact limit still decides every larger one', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    const sql = executable(allSql());
    // 2,000 kW over the 5-minute minimum is the smallest limit any interval can have
    const quick = sql.search(/WHEN energy - prev_energy <= \(2000 \* 300 \/ 3600\.0\)::float8 THEN energy - prev_energy/);
    const exact = sql.search(/energy - prev_energy\s+> 2000 \* GREATEST/);
    expect(quick).toBeGreaterThan(-1);
    expect(exact).toBeGreaterThan(quick);
  });

  test('a machine with a single reading has no interval and so no consumption', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // the first reading of a machine has no predecessor, so its delta is
    // NULL and must be excluded rather than treated as zero usage
    expect(allSql()).toMatch(/WHERE delta IS NOT NULL/);
  });

  test('the telemetry read is bounded so the hypertable can be pruned', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    const reads = mockDb.calls().map(c => c.text).filter(t => /FROM energy_observations/.test(t));
    expect(reads).toHaveLength(2);
    expect(allSql()).not.toMatch(/FROM telemetry_raw/);
    for (const sql of reads) {
      expect(sql).toContain("t.received_at >= $2::timestamptz - INTERVAL '5 minutes'");
      expect(sql).toContain("t.received_at <= $3::timestamptz + INTERVAL '5 minutes'");
      expect(sql).toContain('t.observed_at >= $2::timestamptz');
      expect(sql).toContain('t.observed_at <= $3::timestamptz');
      expect(sql).toContain('t.observed_at <= NOW()');
    }
  });

  test('one pass over the counters gives the machines, the days and the months', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // it was three: one for the table and tiles, one for the trend, one for the months
    const passes = mockDb.calls().filter(c => /LAG\(t\.energy\)/.test(c.text));
    expect(passes).toHaveLength(1);
    expect(passes[0].text).toMatch(/GROUPING SETS \(\(machine_id\), \(day\), \(date_trunc\('month', day\)::date\), \(machine_id, day\)\)/);
  });

  test('delayed full packets use device observation time for sequence, day and power-rate validation', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    const sql = executable(allSql());
    expect(sql).toContain('LAG(t.observed_at) OVER w AS prev_at');
    expect(sql).toContain("(observed_at AT TIME ZONE 'Asia/Kolkata')::date AS day");
    expect(sql).not.toContain("(received_at AT TIME ZONE 'Asia/Kolkata')::date AS day");
    expect(sql).not.toContain('EXTRACT(EPOCH FROM received_at - prev_at)');
  });

  test('the trend keeps missing days unknown and the months add up measured days', async () => {
    const d1 = new Date(2026, 9, 7), d2 = new Date(2026, 9, 8), d3 = new Date(2026, 9, 9);
    queueAll({
      machines: [machineRow({ kwh: '30' })],
      counters: [
        { kind: 'calendar', day: d3 }, { kind: 'calendar', day: d1 }, { kind: 'calendar', day: d2 },
        { kind: 'day', day: d1, kwh: '10', n: 2 }, { kind: 'day', day: d3, kwh: '20', n: 1 },
        { kind: 'month', month: new Date(2026, 9, 1), kwh: '30' }
      ]
    });
    const d = await svc.getEnergy({ company_id, from: '2026-10-07', to: '2026-10-09' });

    expect(d.trend.map(t => [new Date(t.day).getDate(), t.kwh, t.machines])).toEqual([[7, 10, 2], [8, null, 0], [9, 20, 1]]);
    expect(d.by_month).toEqual([{ month: new Date(2026, 9, 1).toISOString(), kwh: 30, rejected_intervals: 0, cost: null, cost_complete: false }]);
    // the last day against the one before: the day before reported nothing, so no comparison
    expect(d.kpis.kwh_vs_yesterday_pct).toBeNull();
  });
});

describe('unknown is not zero', () => {
  test('a machine that reports no counter has null consumption', async () => {
    queueAll({ machines: [machineRow({ kwh: null, readings: null })] });
    const d = await svc.getEnergy({ company_id });

    // zero would say the machine used no electricity; null says we do not
    // know, which is the truth when nothing reports it
    expect(d.machines.data[0].kwh).toBeNull();
    expect(d.machines.data[0].cost).toBeNull();
  });

  test('fleet total is null when nothing reports at all', async () => {
    queueAll({ machines: [machineRow({ kwh: null })] });
    const d = await svc.getEnergy({ company_id });
    expect(d.kpis.total_kwh).toBeNull();
    expect(d.coverage.reporting).toBe(0);
  });

  test('cost is null when no tariff has been configured', async () => {
    queueAll({ machines: [machineRow()], settings: [] });
    const d = await svc.getEnergy({ company_id });

    expect(d.machines.data[0].kwh).toBe(30);
    expect(d.machines.data[0].cost).toBeNull();
    expect(d.kpis.total_cost).toBeNull();
    expect(d.coverage.tariff_configured).toBe(false);
  });

  test('kWh per part is null when nothing was produced', async () => {
    queueAll({ machines: [machineRow({ produced: '0' })] });
    const d = await svc.getEnergy({ company_id });
    expect(d.machines.data[0].kwh_per_part).toBeNull();
  });

  test('the coverage note describes the selected period without claiming devices never report', async () => {
    queueAll({ machines: [machineRow({ kwh: null })] });
    const d = await svc.getEnergy({ company_id });
    expect(d.coverage.note).toMatch(/No accepted energy intervals were measured in the selected period/i);
  });
});

describe('cost and tariff', () => {
  const tariff = [{ machine_id: null, cost_per_kwh: '8.50', currency: 'INR', overload_kw: '50' }];

  test('applies the company tariff', async () => {
    queueAll({ machines: [machineRow({ kwh: '30' })], settings: tariff });
    const d = await svc.getEnergy({ company_id });

    expect(d.machines.data[0].cost).toBe(255);   // 30 x 8.50
    expect(d.currency).toBe('INR');
  });

  test('a machine override beats the company default', async () => {
    queueAll({
      machines: [machineRow({ machine_id: 1, kwh: '10' })],
      settings: [...tariff, { machine_id: 1, cost_per_kwh: '20', currency: 'INR', overload_kw: null }]
    });
    const d = await svc.getEnergy({ company_id });
    expect(d.machines.data[0].cost).toBe(200);   // the override, not 85
  });

  test('kWh per part uses the fleet totals', async () => {
    queueAll({ machines: [machineRow({ kwh: '50', produced: '200' })] });
    const d = await svc.getEnergy({ company_id });
    expect(d.kpis.kwh_per_part).toBe(0.25);
  });
});

describe('overload alerts', () => {
  const withThreshold = [{ machine_id: null, cost_per_kwh: null, currency: 'INR', overload_kw: '50' }];

  test('flags a machine whose peak power exceeded the threshold', async () => {
    queueAll({ machines: [machineRow({ peak_kw: '55' })], settings: withThreshold });
    const d = await svc.getEnergy({ company_id });

    expect(d.machines.data[0].is_overloaded).toBe(true);
    expect(d.kpis.overload_alerts).toBe(1);
    expect(d.overloads).toHaveLength(1);
  });

  test('does not flag one at or below the threshold', async () => {
    queueAll({ machines: [machineRow({ peak_kw: '50' })], settings: withThreshold });
    const d = await svc.getEnergy({ company_id });
    expect(d.machines.data[0].is_overloaded).toBe(false);
  });

  test('peak power is the size of the reading, whatever its sign', async () => {
    // VMC - 1 - F's meter reports a running machine as negative kW (its
    // current transformers face the wrong way); MAX alone would never flag it
    queueAll();
    await svc.getEnergy({ company_id });
    expect(allSql()).toMatch(/MAX\(ABS\(t\.power\)\) FILTER \(WHERE ABS\(t\.power\) < 'Infinity'::float8\) AS peak_kw/);
  });

  test('never flags when no threshold is configured', async () => {
    // an unconfigured threshold must not read as a threshold of zero, or
    // every machine alerts the moment it draws any power at all
    queueAll({ machines: [machineRow({ peak_kw: '999' })], settings: [] });
    const d = await svc.getEnergy({ company_id });
    expect(d.machines.data[0].is_overloaded).toBe(false);
    expect(d.kpis.overload_alerts).toBe(0);
  });
});

describe('settings', () => {
  test('rejects a machine belonging to another company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.saveSettings({ company_id, machine_id: 99, cost_per_kwh: 5 }))
      .rejects.toMatchObject({ status: 404 });
  });

  test.each([[-1], ['abc']])('rejects a bad rate %p', async (bad) => {
    await expect(svc.saveSettings({ company_id, cost_per_kwh: bad }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('upserts against the partial unique index rather than reading first', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] });
    await svc.saveSettings({ company_id, cost_per_kwh: 8.5 });

    // reading then writing would race another writer; the index makes
    // "one default per company" a rule the database enforces
    expect(mockDb.calls()[0].text).toMatch(/ON CONFLICT \(company_id\) WHERE machine_id IS NULL/);
  });

  test('a machine setting conflicts on the machine, not the company', async () => {
    mockDb.queueResponse({ rows: [{ '?column?': 1 }], rowCount: 1 }, { rows: [{ id: 2 }] });
    await svc.saveSettings({ company_id, machine_id: 5, cost_per_kwh: 9 });
    expect(mockDb.calls()[1].text).toMatch(/ON CONFLICT \(machine_id\) WHERE machine_id IS NOT NULL/);
  });
});

describe('every query binds exactly the parameters it references', () => {
  test.each([
    ['no filters', {}],
    ['date range', { from: '2026-09-01', to: '2026-09-10' }],
    ['machine',    { machine_id: 36 }],
    ['both',       { from: '2026-09-01', to: '2026-09-10', machine_id: 36 }]
  ])('%s', async (_label, filters) => {
    queueAll();
    await svc.getEnergy({ company_id, ...filters });

    for (const call of mockDb.calls()) {
      const used = [...call.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
      const hi = used.length ? Math.max(...used) : 0;
      expect(call.params.length).toBe(hi);
      for (let i = 1; i <= hi; i++) expect(used).toContain(i);
    }
  });
});

describe('input validation', () => {
  test('machine_id must be a positive integer', async () => {
    await expect(svc.getEnergy({ company_id, machine_id: 'abc' })).rejects.toMatchObject({ status: 400 });
  });

  test.each([['nope'], ['2026-13-01']])('rejects date %p', async (bad) => {
    await expect(svc.getEnergy({ company_id, from: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a backwards range', async () => {
    await expect(svc.getEnergy({ company_id, from: '2026-09-10', to: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('defaults to the last 7 days', () => {
    const { start, end } = svc.resolveRange({});
    const days = (new Date(end) - new Date(start)) / 86_400_000;
    expect(days).toBeGreaterThan(5.5);
    expect(days).toBeLessThan(7.5);
  });
});

describe('export', () => {
  test('names the cost column with the configured currency', async () => {
    queueTable({
      machines: [machineRow()],
      settings: [{ machine_id: null, cost_per_kwh: '8.5', currency: 'EUR', overload_kw: null }]
    });
    const rows = await svc.getExportRows({ company_id });
    // the export asks for the table's rows only: the settings and the machines' figures, no shift split
    expect(mockDb.calls()).toHaveLength(3);
    expect(allSql()).not.toMatch(/GROUP BY s\.shift_name/);
    expect(Object.keys(rows[0])).toContain('Cost (EUR)');
  });

  test('an unknown figure exports blank rather than a misleading zero', async () => {
    queueTable({ machines: [machineRow({ kwh: null, produced: '0', peak_kw: null })] });
    const rows = await svc.getExportRows({ company_id });
    expect(rows[0]['Energy (kWh)']).toBe('');
    expect(rows[0]['kWh per part']).toBe('');
    expect(rows[0]['Peak kW']).toBe('');
  });
});

describe('measured energy, honest coverage and tariff estimates', () => {
  const day = '2026-10-07';
  const month = '2026-10-01';
  const rate = (machine_id, cost_per_kwh, currency = 'INR') => ({ machine_id, cost_per_kwh, currency, overload_kw: null });
  const pointRows = (machineDays) => [
    ...machineDays.map(m => ({ kind: 'machine_day', day, ...m })),
    { kind: 'calendar', day },
    { kind: 'day', day, kwh: machineDays.reduce((n, m) => n + Number(m.kwh), 0), n: machineDays.length,
      rejected_intervals: machineDays.reduce((n, m) => n + Number(m.rejected_intervals || 0), 0) },
    { kind: 'month', month, kwh: machineDays.reduce((n, m) => n + Number(m.kwh), 0),
      rejected_intervals: machineDays.reduce((n, m) => n + Number(m.rejected_intervals || 0), 0) }
  ];

  test('day/month costs use each machine tariff and identify estimates made at current tariffs', async () => {
    queueAll({ machines: [machineRow({ machine_id: 1, kwh: '5' }), machineRow({ machine_id: 2, kwh: '3' })],
      settings: [rate(null, '3'), rate(1, '2'), rate(2, '7')],
      counters: pointRows([{ machine_id: 1, kwh: '5' }, { machine_id: 2, kwh: '3' }]) });
    const d = await svc.getEnergy({ company_id, from: day, to: day });
    expect(d.kpis.total_cost).toBe(31); // 5*2 + 3*7; company rate alone would falsely say 24
    expect(d.trend[0]).toMatchObject({ kwh: 8, cost: 31, cost_complete: true });
    expect(d.by_month[0]).toMatchObject({ kwh: 8, cost: 31, cost_complete: true });
    expect(d.coverage).toMatchObject({ energy_complete: true, cost_complete: true, priced: 2 });
    expect(d.cost_basis).toBe('current_tariff_estimate');
    expect(d.energy_source).toBe('telemetry_counter_deltas');
    expect(d.by_shift_source).toBe('production_hourly');
  });

  test('an unpriced machine prevents a partial sum being presented as the full fleet cost', async () => {
    queueAll({ machines: [machineRow({ machine_id: 1, kwh: '5' }), machineRow({ machine_id: 2, kwh: '3' })],
      settings: [rate(1, '2')], counters: pointRows([{ machine_id: 1, kwh: '5' }, { machine_id: 2, kwh: '3' }]) });
    const d = await svc.getEnergy({ company_id, from: day, to: day });
    expect(d.kpis.total_kwh).toBe(8);
    expect(d.kpis.total_cost).toBeNull();
    expect(d.trend[0].cost).toBeNull();
    expect(d.by_month[0].cost).toBeNull();
    expect(d.coverage).toMatchObject({ cost_complete: false, priced: 1, tariff_configured: true });
  });

  test('different currencies are never added or displayed as the company currency', async () => {
    queueAll({ machines: [machineRow({ machine_id: 1 }), machineRow({ machine_id: 2 })],
      settings: [rate(null, '2'), rate(2, '7', 'USD')],
      counters: pointRows([{ machine_id: 1, kwh: '30' }, { machine_id: 2, kwh: '30' }]) });
    const d = await svc.getEnergy({ company_id, from: day, to: day });
    expect(d.kpis.total_cost).toBeNull();
    expect(d.coverage).toMatchObject({ currency_consistent: false, cost_complete: false });
    expect(d.machines.data.find(m => m.machine_id === 2)).toMatchObject({ cost: null, currency: 'USD' });
    expect(d.trend[0].cost).toBeNull();
  });

  test('one common machine-only tariff currency remains correctly labeled', async () => {
    queueAll({ machines: [machineRow()], settings: [rate(1, '2', 'EUR')] });
    const d = await svc.getEnergy({ company_id });
    expect(d.currency).toBe('EUR');
    expect(d.kpis.total_cost).toBe(60);
  });

  test('partial energy is not divided by output from the entire fleet', async () => {
    queueAll({ machines: [machineRow({ machine_id: 1, kwh: '5', produced: '100' }),
      machineRow({ machine_id: 2, kwh: null, produced: '900' })], settings: [rate(null, '2')] });
    const d = await svc.getEnergy({ company_id });
    expect(d.kpis.total_kwh).toBe(5);
    expect(d.kpis.total_produced).toBe(1000);
    expect(d.kpis.kwh_per_part).toBeNull();
    expect(d.kpis.total_cost).toBeNull();
    expect(d.coverage.energy_complete).toBe(false);
  });

  test('reset or outlier gaps retain measured increments and suppress complete-period cost and efficiency', async () => {
    queueAll({ machines: [machineRow({ kwh: '8', rejected_intervals: 1 })], settings: [rate(null, '2')],
      counters: pointRows([{ machine_id: 1, kwh: '8', rejected_intervals: 1 }]) });
    const d = await svc.getEnergy({ company_id, from: day, to: day });
    expect(d.kpis.total_kwh).toBe(8);
    expect(d.kpis.total_cost).toBeNull();
    expect(d.kpis.kwh_per_part).toBeNull();
    expect(d.machines.data[0]).toMatchObject({ cost: null, kwh_per_part: null, rejected_intervals: 1, energy_complete: false });
    expect(d.coverage).toMatchObject({ energy_complete: false, cost_complete: false, rejected_intervals: 1 });
    expect(d.trend[0]).toMatchObject({ kwh: 8, cost: null, cost_complete: false });
  });

  test('a real measured zero remains zero, including a zero configured tariff', async () => {
    queueAll({ machines: [machineRow({ kwh: '0' })], settings: [rate(null, '0')],
      counters: pointRows([{ machine_id: 1, kwh: '0' }]) });
    const d = await svc.getEnergy({ company_id, from: day, to: day });
    expect(d.kpis).toMatchObject({ total_kwh: 0, total_cost: 0, kwh_per_part: 0 });
    expect(d.trend[0]).toMatchObject({ kwh: 0, cost: 0, cost_complete: true });
    expect(d.coverage).toMatchObject({ energy_complete: true, cost_complete: true });
  });

  test('fleet sums use unrounded meter values', async () => {
    queueAll({ machines: [machineRow({ machine_id: 1, kwh: '0.004' }), machineRow({ machine_id: 2, kwh: '0.004' })],
      settings: [rate(null, '2')] });
    const d = await svc.getEnergy({ company_id });
    expect(d.machines.data.map(m => m.kwh)).toEqual([0, 0]);
    expect(d.kpis.total_kwh).toBe(0.01);
    expect(d.kpis.total_cost).toBe(0.02);
  });

  test('a missing calendar day is distinct from measured zero', async () => {
    queueAll({ machines: [machineRow({ kwh: '0' })], settings: [rate(null, '2')], counters: [
      ...pointRows([{ machine_id: 1, kwh: '0' }]), { kind: 'calendar', day: '2026-10-08' }
    ] });
    const d = await svc.getEnergy({ company_id, from: day, to: '2026-10-08' });
    expect(d.trend[0]).toMatchObject({ kwh: 0, cost: 0 });
    expect(d.trend[1]).toMatchObject({ kwh: null, machines: 0, cost: null, cost_complete: false });
  });

  test('an existing tariff remains configured while energy has not reported', async () => {
    queueAll({ machines: [machineRow({ kwh: null })], settings: [rate(null, '2')] });
    const d = await svc.getEnergy({ company_id });
    expect(d.coverage).toMatchObject({ tariff_configured: true, energy_complete: false, cost_complete: false, priced: 0 });
  });
});

describe('bounded, authorized Energy reads', () => {
  test('search is bound into every source, including shared cached figures, not just the table', async () => {
    const cache = require('../../src/dashboard/cache');
    const remembered = jest.spyOn(cache, 'remember');
    queueAll({ machines: [machineRow({ machine_serial_no: 'VMC-01' })] });
    try {
      await svc.getEnergy({ company_id, machine_id: 1, search: 'VMC-01', from: '2026-10-01', to: '2026-10-07' });
      expect(remembered).toHaveBeenCalledWith('energy:figures', company_id,
        expect.objectContaining({ machineId: 1, search: 'vmc-01' }), expect.any(Number), expect.any(Function));
      const sources = mockDb.calls().filter(c => /FROM (?:energy_observations|production_hourly)/.test(c.text));
      expect(sources).toHaveLength(3);
      for (const call of sources) {
        expect(call.params.slice(-2)).toEqual([1, 'vmc-01']);
        expect(call.text).toMatch(/POSITION\(\$5 IN LOWER\(COALESCE\(m\.machine_serial_no/);
        expect(call.text).toContain('m.is_active = TRUE');
        expect(call.text).toContain('m.company_id = $1');
      }
    } finally { remembered.mockRestore(); }
  });

  test('telemetry and rollups cannot read future buckets or a foreign recorded company', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    for (const c of mockDb.calls().filter(c => /FROM energy_observations/.test(c.text))) {
      expect(c.text).toContain('t.company_id = $1');
      expect(c.text).toContain('t.received_at <= NOW()');
    }
    for (const c of mockDb.calls().filter(c => /FROM production_hourly/.test(c.text))) {
      expect(c.text).toContain('ph.company_id = $1');
      expect(c.text).toContain('ph.hour_start < NOW()');
    }
    expect(allSql()).toContain('s.company_id = $1');
  });

  test('every data source follows the request authorization plant scope', async () => {
    queueAll();
    await require('../../src/lib/read-scope').run({ company_id, plant_id: 8, roles: ['USER'] },
      () => svc.getEnergy({ company_id, machine_id: 1 }));
    for (const c of mockDb.calls()) expect(c.text).toContain('authorized_machine.plant_id = 8');
  });

  test.each([['page', Infinity], ['page', '1.2'], ['page', 0], ['page', true], ['page', []],
    ['limit', 'Infinity'], ['limit', -1], ['limit', 1.5], ['machine_id', [1]], ['machine_id', true],
    ['machine_id', Number.MAX_SAFE_INTEGER + 1]])('rejects malformed %s=%p before reads', async (key, value) => {
    await expect(svc.getEnergy({ company_id, [key]: value })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('UI pages stay capped at 200 rows', async () => {
    queueTable({ machines: Array.from({ length: 205 }, (_, i) => machineRow({ machine_id: i + 1 })) });
    const d = await svc.getEnergy({ company_id, part: 'table', limit: 1000 });
    expect(d.machines.data).toHaveLength(200);
    expect(d.machines).toMatchObject({ total: 205, limit: 200, totalPages: 2 });
  });

  test('historical to-only ranges resolve seven plant days ending on the selected date', () => {
    expect(svc.resolveRange({ to: '2020-01-07' })).toEqual({
      start: '2020-01-01T00:00:00+05:30', end: '2020-01-07T23:59:59.999+05:30'
    });
  });

  test('a leap-year window can contain 366 days; longer scans fail before reads', async () => {
    expect(svc.resolveRange({ from: '2024-01-01', to: '2024-12-31' })).toBeTruthy();
    await expect(svc.getEnergy({ company_id, from: '2024-01-01', to: '2025-01-01' })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('stale machine ownership settings cannot reveal another company serial or be overwritten', async () => {
    mockDb.queueResponse({ rows: [] });
    await svc.getSettings(company_id);
    expect(allSql()).toContain('m.id = es.machine_id AND m.company_id = $1');
    expect(allSql()).toContain('es.machine_id IS NULL OR m.id IS NOT NULL');
    resetDb();
    mockDb.queueResponse({ rowCount: 1, rows: [{ '?column?': 1 }] }, { rowCount: 0, rows: [] });
    await expect(svc.saveSettings({ company_id, machine_id: 1, cost_per_kwh: 2 })).rejects.toMatchObject({ status: 409 });
    expect(allSql()).toContain('WHERE energy_settings.company_id = EXCLUDED.company_id');
  });
});

describe('complete Energy exports', () => {
  test('includes matched machines beyond the UI page ceiling without repeated raw scans', async () => {
    queueTable({ machines: Array.from({ length: 205 }, (_, i) => machineRow({ machine_id: i + 1, machine_serial_no: `VMC-${i + 1}` })) });
    const rows = await svc.getExportRows({ company_id });
    expect(rows).toHaveLength(205);
    expect(rows.some(r => r.Machine === 'VMC-205')).toBe(true);
    expect(mockDb.calls().filter(c => /LAG\(t\.energy\)/.test(c.text))).toHaveLength(1);
    expect(mockDb.calls()).toHaveLength(3);
  });

  test('discloses reset gaps and never exports their cost or full-period efficiency as complete', async () => {
    queueTable({ machines: [machineRow({ kwh: '8', rejected_intervals: 1 })],
      settings: [{ machine_id: null, cost_per_kwh: 2, currency: 'INR' }] });
    const [r] = await svc.getExportRows({ company_id });
    expect(r['Energy (kWh)']).toBe(8);
    expect(r['Cost (INR)']).toBe('');
    expect(r['kWh per part']).toBe('');
    expect(r['Energy coverage']).toBe('Partial: meter gaps');
  });
});

describe('no invented full-period figures or invalid tariff settings', () => {
  const tariff = [{ machine_id: null, cost_per_kwh: 2, currency: 'INR' }];
  test('a missing selected day makes period/month cost and efficiency partial while preserving daily measured cost', async () => {
    queueAll({ machines: [machineRow({ kwh: '5', days: 1 })], settings: tariff, counters: [
      { kind: 'calendar', day: '2026-10-01' }, { kind: 'calendar', day: '2026-10-02' },
      { kind: 'machine_day', day: '2026-10-01', machine_id: 1, kwh: '5' },
      { kind: 'day', day: '2026-10-01', kwh: '5', n: 1 },
      { kind: 'month', month: '2026-10-01', kwh: '5' }
    ] });
    const d = await svc.getEnergy({ company_id, from: '2026-10-01', to: '2026-10-02' });
    expect(d.kpis).toMatchObject({ total_kwh: 5, total_cost: null, kwh_per_part: null });
    expect(d.coverage).toMatchObject({ energy_complete: false, cost_complete: false });
    expect(d.machines.data[0]).toMatchObject({ kwh: 5, cost: null, kwh_per_part: null, energy_complete: false });
    expect(d.trend[0]).toMatchObject({ kwh: 5, cost: 10, cost_complete: true });
    expect(d.trend[1]).toMatchObject({ kwh: null, cost: null, cost_complete: false });
    expect(d.by_month[0]).toMatchObject({ kwh: 5, cost: null, cost_complete: false });
  });

  test('legacy hourly zero allocations do not establish measured zero by shift', async () => {
    queueAll({ shifts: [{ shift_id: 1, shift_name: 'Shift A', kwh: '0', run_seconds: 0, produced: 0 },
      { shift_id: 2, shift_name: 'Shift B', kwh: null, run_seconds: 0, produced: 0 },
      { shift_id: 3, shift_name: 'Shift C', kwh: '3', run_seconds: 30, produced: 1 }] });
    const d = await svc.getEnergy({ company_id });
    expect(d.by_shift.map(s => s.kwh)).toEqual([null, null, 3]);
  });

  test.each([['currency', 123], ['currency', true], ['currency', {}], ['currency', 'RUPEES'],
    ['currency', 'IN'], ['currency', 'IN1'], ['cost_per_kwh', 1000000], ['overload_kw', 100000000],
    ['cost_per_kwh', true], ['cost_per_kwh', [2]], ['overload_kw', {}]])('refuses invalid %s=%p before queries', async (key, value) => {
    await expect(svc.saveSettings({ company_id, [key]: value })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('accepts zero and the numeric column limits, normalizing a three-letter currency', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] });
    await svc.saveSettings({ company_id, cost_per_kwh: 999999.9999, overload_kw: 99999999.99, currency: ' eur ' });
    expect(mockDb.calls()[0].params.slice(2, 5)).toEqual([999999.9999, 'EUR', 99999999.99]);
    resetDb();
    mockDb.queueResponse({ rows: [{ id: 1 }] });
    await svc.saveSettings({ company_id, cost_per_kwh: 0, overload_kw: 0, currency: 'inr' });
    expect(mockDb.calls()[0].params.slice(2, 5)).toEqual([0, 'INR', 0]);
  });
});
