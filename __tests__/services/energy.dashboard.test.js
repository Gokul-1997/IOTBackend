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
 * reading 500, 520, 0, 5 has MAX 520 and MIN 0, giving 520 kWh for a
 * machine that used 25. This was written that way first, and an end-to-end
 * run against real rows caught it.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/energy.service');

const company_id = 4;

/* getEnergy fires: perMachine, dailyTrend, byShift, byMonth, settings. */
function queueAll({ machines = [], trend = [], shifts = [], months = [], settings = [] } = {}) {
  mockDb.queueResponse(
    { rows: machines }, { rows: trend }, { rows: shifts }, { rows: months }, { rows: settings }
  );
}

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

    const sql = executable(mockDb.calls()[0].text);
    expect(sql).toMatch(/LAG\(energy\) OVER \(PARTITION BY machine_id ORDER BY received_at\)/);
    // MAX-MIN cannot see a reset inside the period
    expect(sql).not.toMatch(/MAX\(energy\)\s*-\s*MIN\(energy\)/);
  });

  test('a falling counter contributes nothing, never a negative', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // a machine cannot un-consume electricity
    expect(mockDb.calls()[0].text).toMatch(/GREATEST\(energy - LAG\(energy\)[\s\S]*?, 0\)/);
  });

  test('a machine with a single reading has no interval and so no consumption', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    // the first reading of a machine has no predecessor, so its delta is
    // NULL and must be excluded rather than treated as zero usage
    expect(mockDb.calls()[0].text).toMatch(/WHERE delta IS NOT NULL/);
  });

  test('the telemetry read is bounded so the hypertable can be pruned', async () => {
    queueAll();
    await svc.getEnergy({ company_id });
    const sql = mockDb.calls()[0].text;
    expect(sql).toMatch(/t\.received_at >= \$2/);
    expect(sql).toMatch(/t\.received_at <= \$3/);
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

  test('the coverage note says plainly when no device reports energy', async () => {
    queueAll({ machines: [machineRow({ kwh: null })] });
    const d = await svc.getEnergy({ company_id });
    expect(d.coverage.note).toMatch(/No machine is reporting an energy counter/i);
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
    queueAll({
      machines: [machineRow()],
      settings: [{ machine_id: null, cost_per_kwh: '8.5', currency: 'EUR', overload_kw: null }]
    });
    const rows = await svc.getExportRows({ company_id });
    expect(Object.keys(rows[0])).toContain('Cost (EUR)');
  });

  test('an unknown figure exports blank rather than a misleading zero', async () => {
    queueAll({ machines: [machineRow({ kwh: null, produced: '0', peak_kw: null })] });
    const rows = await svc.getExportRows({ company_id });
    expect(rows[0]['Energy (kWh)']).toBe('');
    expect(rows[0]['kWh per part']).toBe('');
    expect(rows[0]['Peak kW']).toBe('');
  });
});
