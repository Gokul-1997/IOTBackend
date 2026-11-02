/** A ready tenant reads one canonical ledger on every energy surface. */
const answers = [];
const calls = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text, params) => {
    calls.push({ text, params });
    const answer = answers.find(([pattern]) => pattern.test(text));
    const rows = answer ? answer[1].map(row => ({ ...row })) : [];
    return { rows, rowCount: rows.length };
  })
}));
jest.mock('../../src/dashboard/cache', () => ({
  remember: jest.fn(async (_name, _company, _keys, _ttl, compute) => compute()),
  ttlFor: () => 30
}));
jest.mock('../../src/dashboard/energy-store', () => ({
  enabled: jest.fn(), figures: jest.fn(), byShift: jest.fn(), machineEnergy: jest.fn(),
  factoryEnergy: jest.fn(), attachReportEnergy: jest.fn()
}), { virtual: true });
jest.mock('../../src/dashboard/oee.dashboard.service', () => ({
  machineTotals: jest.fn(async () => []), deriveOee: jest.fn(row => row),
  fleetOee: jest.fn(() => ({ availability_pct: null, performance_pct: null, quality_pct: null, oee_pct: null })),
  DEFAULT_THRESHOLDS: {}
}));

const energyStore = require('../../src/dashboard/energy-store');
const cache = require('../../src/dashboard/cache');
const energy = require('../../src/dashboard/energy.service');
const machine = require('../../src/dashboard/dashboard.service');
const reports = require('../../src/reports/report.service');
const factory = require('../../src/dashboard/factory.service');

const day = '2026-10-29';
const hour = '2026-10-29T02:30:00.000Z';
const rawReport = {
  machine_id: 25, shift_id: 6, hour_start: hour, machine: 'HMC-7-F', operator: '--',
  shift: 'DAY', hour: '29-Oct 08:00', run_seconds: 3600, idle_seconds: 0,
  manual_seconds: 0, off_seconds: 0, produced_qty: 8, energy_kwh: '9999'
};
const measuredFactory = (overrides = {}) => ({
  kwh: 1, month_kwh: 5, yesterday_kwh: 2, prev_month_kwh: 4,
  cost_day: 10, cost_month: 50, yesterday_cost: 20, currency: 'INR',
  cost_complete: true, month_cost_complete: true, yesterday_cost_complete: true,
  accepted_intervals: 2, rejected_intervals: 0, energy_complete: true,
  month_energy_complete: true, yesterday_energy_complete: true, prev_month_energy_complete: true,
  trend: [{ hour, kwh: 1 }], ...overrides
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date(`${day}T12:00:00+05:30`));
  answers.length = 0;
  calls.length = 0;
  energyStore.enabled.mockResolvedValue(true);
  energyStore.byShift.mockResolvedValue([]);
  energyStore.figures.mockResolvedValue({ machines: [], trend: [], machineDays: [], months: [] });
  energyStore.machineEnergy.mockResolvedValue({ total_energy: 3104, shift_kwh: 1.25, accepted_intervals: 2, rejected_intervals: 0 });
  energyStore.factoryEnergy.mockResolvedValue(measuredFactory());
});
afterEach(() => jest.useRealTimers());

function givenMachine() {
  answers.push(
    [/FROM machines\s+WHERE id = \$1 AND company_id = \$2/, [{ id: 25, machine_serial_no: 'HMC-7-F' }]],
    [/FROM shifts\s+WHERE company_id/, [{ id: 6, shift_code: 'DAY', start_time: '08:00:00', end_time: '20:00:00' }]]
  );
}
function givenFactory() {
  answers.push(
    [/AS energy_rate_per_kwh/, [{ energy_rate_per_kwh: 10, currency: 'INR' }]],
    [/FROM counted c/, [{ total: 1, running: 0, idle: 0, breakdown: 0, offline: 1 }]],
    [/FROM shifts sh/, [{ shift_id: 6, shift_code: 'DAY', shift_name: 'Day',
      start_time: '08:00:00', end_time: '20:00:00', machine_id: 25, hour_start: hour,
      produced: 8, run_seconds: 3600, idle_seconds: 0, kwh: 9999 }]],
    [/j\.target_qty::numeric AS target/, [{ machine_id: 25, target: 20 }]],
    [/\(\$2::date - 1\)/, [{ machine_id: 25, produced: 10, kwh: 9999 }]]
  );
}

test('Energy dashboard, daily/monthly charts and shifts use canonical figures, retaining a measured zero', async () => {
  energyStore.figures.mockResolvedValue({
    machines: [{ machine_id: 25, machine_serial_no: 'HMC-7-F', model: 'HMC',
      kwh: 0, days: 1, readings: 1, rejected_intervals: 0, produced: 8, run_seconds: 3600 }],
    trend: [{ day, kwh: 0, machines: 1, rejected_intervals: 0 }],
    machineDays: [{ machine_id: 25, day, kwh: 0, rejected_intervals: 0 }],
    months: [{ month: '2026-10-01', kwh: 0, rejected_intervals: 0 }]
  });
  energyStore.byShift.mockResolvedValue([{ shift_id: 6, shift_name: 'Day', kwh: 0 }]);
  answers.push([/FROM energy_settings es/, [{ machine_id: null, cost_per_kwh: 10, currency: 'INR' }]]);
  const result = await energy.getEnergy({ company_id: 4, from: day, to: day });
  expect(result.energy_source).toBe('canonical_energy_intervals');
  expect(result.by_shift_source).toBe('canonical_energy_intervals');
  expect(result.kpis.total_kwh).toBe(0);
  expect(result.kpis.total_cost).toBe(0);
  expect(result.coverage.energy_complete).toBe(true);
  expect(result.by_shift[0].kwh).toBe(0);
  expect(calls.some(call => /energy_observations|production_hourly/.test(call.text))).toBe(false);
  expect(cache.remember.mock.calls[0][2].pipeline).toBe('v2');
});

test('an empty canonical range stays unknown and never reads legacy meter history', async () => {
  const result = await energy.getEnergy({ company_id: 4, from: day, to: day });
  expect(result.kpis.total_kwh).toBeNull();
  expect(result.coverage.energy_complete).toBe(false);
  expect(calls.some(call => /energy_observations/.test(call.text))).toBe(false);
});

test('machine detail uses canonical intervals independently from status telemetry', async () => {
  givenMachine();
  const result = await machine.machineDetail(null, 25, 4);
  expect(result.power).toEqual({ total_kwh: 3104, shift_kwh: 1.25, energy_complete: true, rejected_intervals: 0 });
  expect(energyStore.machineEnergy).toHaveBeenCalledWith({ companyId: 4, machineId: 25,
    start: new Date(`${day}T08:00:00+05:30`), end: new Date(`${day}T20:00:00+05:30`),
    asOf: new Date(`${day}T12:00:00+05:30`) });
  expect(calls.some(call => /energy_observations/.test(call.text))).toBe(false);
});

test('machine detail accepts explicit incomplete coverage even with accepted intervals', async () => {
  givenMachine();
  energyStore.machineEnergy.mockResolvedValue({ total_energy: 3104, shift_kwh: 0,
    accepted_intervals: 1, rejected_intervals: 0, energy_complete: false });
  expect((await machine.machineDetail(null, 25, 4)).power).toMatchObject({ shift_kwh: 0, energy_complete: false });
});

test('a denied machine cannot ask the canonical ledger for another company’s data', async () => {
  expect(await machine.machineDetail(null, 25, 99)).toBeNull();
  expect(energyStore.enabled).not.toHaveBeenCalled();
  expect(energyStore.machineEnergy).not.toHaveBeenCalled();
});

test('production report and exports replace legacy allocations with canonical energy and strip internal keys', async () => {
  answers.push([/m\.machine_serial_no\s+AS machine/, [rawReport]]);
  energyStore.attachReportEnergy.mockImplementation(async (_company, rows) => {
    rows[0].energy_kwh = 0;
    rows[0].energy_complete = true;
    return { rows: 1, rows_with_energy: 1, accepted_intervals: 1, rejected_intervals: 0, energy_complete: true };
  });
  const result = await reports.productionData(4, day, day, 25, 6, 7);
  expect(result.summary.total_energy).toBe('0.00');
  expect(result.summary.total_parts).toBe(8);
  expect(result.summary.energy_coverage.energy_complete).toBe(true);
  expect(result.rows[0]).toMatchObject({ machine: 'HMC-7-F', energy_kwh: 0 });
  expect(result.rows[0]).not.toHaveProperty('machine_id');
  expect(result.rows[0]).not.toHaveProperty('shift_id');
  expect(result.rows[0]).not.toHaveProperty('hour_start');
  expect(energyStore.attachReportEnergy).toHaveBeenCalledWith(4, expect.any(Array),
    { date_from: day, date_to: day, machine_id: 25, shift_id: 6 });
  expect(calls[0].text).toContain('p.machine_id, p.shift_id, p.hour_start,');
});

test('production report has a null total when no selected hour has measured energy', async () => {
  answers.push([/m\.machine_serial_no\s+AS machine/, [rawReport]]);
  energyStore.attachReportEnergy.mockImplementation(async (_company, rows) => {
    rows[0].energy_kwh = null;
    rows[0].energy_complete = false;
  });
  const result = await reports.productionData(4, day, day);
  expect(result.summary.total_energy).toBeNull();
  expect(result.summary.energy_coverage).toMatchObject({ rows: 1, rows_with_energy: 0, energy_complete: false });
});

test('factory consumes the same ledger while preserving every production count and target', async () => {
  givenFactory();
  const result = await factory.getFactoryDashboard({ user: { company_id: 4 }, query: { date: day } });
  expect(energyStore.factoryEnergy).toHaveBeenCalledWith({ companyId: 4, machineId: null,
    date: day, shiftId: null, asOf: new Date(`${day}T12:00:00+05:30`).toISOString() });
  expect(result.energy).toMatchObject({ kwh: 1, month_kwh: 5, cost_day: 10, cost_month: 50,
    day_vs_yesterday_pct: -50, month_vs_last_pct: 25, cost_per_part: 1.25,
    energy_complete: true, accepted_intervals: 2 });
  expect(result.production).toMatchObject({ produced: 8, actual: 8, target: 20 });
  expect(result.trend[0]).toMatchObject({ kwh: 1, produced: 8, actual: 8 });
  expect(calls.some(call => /date_trunc\('month'/.test(call.text))).toBe(false);
});

test('factory partial energy remains measurable but cannot create misleading costs or comparisons', async () => {
  givenFactory();
  energyStore.factoryEnergy.mockResolvedValue(measuredFactory({ energy_complete: false,
    month_energy_complete: false, cost_complete: false, month_cost_complete: false, rejected_intervals: 1, trend: [] }));
  const result = await factory.getFactoryDashboard({ user: { company_id: 4 }, query: { date: day } });
  expect(result.energy).toMatchObject({ kwh: 1, cost_day: null, cost_month: null,
    cost_per_part: null, day_vs_yesterday_pct: null, month_vs_last_pct: null,
    cost_per_part_vs_yesterday_pct: null, energy_complete: false, rejected_intervals: 1 });
  expect(result.trend[0]).toMatchObject({ produced: 8, kwh: null });
});

test('an explicitly configured zero tariff is valid on a complete canonical factory range', async () => {
  givenFactory();
  answers[0][1][0].energy_rate_per_kwh = 0;
  energyStore.factoryEnergy.mockResolvedValue(measuredFactory({ cost_day: 0, cost_month: 0, yesterday_cost: 0 }));
  const result = await factory.getFactoryDashboard({ user: { company_id: 4 }, query: { date: day } });
  expect(result.energy).toMatchObject({ rate_per_kwh: 0, cost_day: 0, cost_month: 0, cost_per_part: 0 });
});

test('readiness false retains the existing report contract during migration', async () => {
  energyStore.enabled.mockResolvedValue(false);
  answers.push([/m\.machine_serial_no\s+AS machine/, [{ ...rawReport, energy_kwh: '2.25' }]]);
  const result = await reports.productionData(4, day, day);
  expect(result.summary).toEqual({ total_parts: 8, run_hours: '1.00', total_energy: '2.25', efficiency_pct: '100.0' });
  expect(energyStore.attachReportEnergy).not.toHaveBeenCalled();
});


test('factory honors per-machine tariff overrides and refuses mixed currency totals', async () => {
  givenFactory();
  energyStore.factoryEnergy.mockResolvedValue(measuredFactory({ cost_day: 25, cost_month: 125 }));
  const overridden = await factory.getFactoryDashboard({ user: { company_id: 4 }, query: { date: day } });
  expect(overridden.energy).toMatchObject({ rate_per_kwh: 10, cost_day: 25, cost_month: 125, cost_per_part: 3.13 });
  energyStore.factoryEnergy.mockResolvedValue(measuredFactory({ cost_day: null, cost_month: null,
    cost_complete: false, month_cost_complete: false }));
  const mixed = await factory.getFactoryDashboard({ user: { company_id: 4 }, query: { date: day } });
  expect(mixed.energy).toMatchObject({ kwh: 1, cost_day: null, cost_month: null, cost_per_part: null,
    cost_per_part_vs_yesterday_pct: null, cost_complete: false });
});
