/* Factory and Production Report use the same stored output and shift-start
   date, including the following morning of an overnight shift. */
jest.mock('../../src/db', () => ({ query: jest.fn() }));
jest.mock('../../src/dashboard/oee.dashboard.service', () => ({
  machineTotals: jest.fn(async () => []),
  deriveOee: jest.fn(),
  fleetOee: jest.fn(() => ({})),
  DEFAULT_THRESHOLDS: {}
}));

const db = require('../../src/db');
const svc = require('../../src/dashboard/factory.service');
const oee = require('../../src/dashboard/oee.dashboard.service');

const shifts = [
  { shift_id: 1, shift_code: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', machine_id: 7, hour_start: '2026-10-27T08:00:00+05:30', produced: 119, run_seconds: 100000, idle_seconds: 10000, kwh: 20 },
  { shift_id: 1, shift_code: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', machine_id: 9, hour_start: '2026-10-27T12:00:00+05:30', produced: 30, run_seconds: 35900, idle_seconds: 5000, kwh: 10.52 },
  { shift_id: 2, shift_code: 'Shift 2', start_time: '20:00:00', end_time: '08:00:00', machine_id: null, produced: 0 }
];
const request = query => ({ user: { company_id: 4 }, query: { date: '2026-10-27', ...query } });
const shiftQuery = () => db.query.mock.calls.find(([sql]) => /FROM shifts sh/.test(sql));

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-27T12:34:00+05:30'));
  oee.machineTotals.mockClear();
  oee.deriveOee.mockClear();
  db.query.mockReset().mockImplementation(async sql => {
    let rows = [];
    if (/AS energy_rate_per_kwh/.test(sql)) rows = [{ energy_rate_per_kwh: 10 }];
    else if (/FROM counted c/.test(sql)) rows = [{ total: 1, running: 1 }];
    else if (/j\.target_qty::numeric AS target/.test(sql)) rows = [{ machine_id: 7, target: 431, mult: 1 }, { machine_id: 9, target: 431, mult: 2 }];
    else if (/FROM shifts sh/.test(sql)) rows = shifts;
    else if (/FROM shifts WHERE id/.test(sql)) rows = [{ id: 2, shift_code: 'Shift 2', start_time: '20:00:00', end_time: '08:00:00' }];
    return { rows, rowCount: rows.length };
  });
});

afterEach(() => jest.useRealTimers());

test('noon matches report raw149 parts,37.75 run hours and30.52kWh; tonight is not started', async () => {
  const out = await svc.getFactoryDashboard(request());
  expect(out.production.produced).toBe(149);
  expect(out.production.actual).toBe(149);
  expect(out.production.target).toBe(1724);
  expect(out.shiftwise).toEqual([
    expect.objectContaining({ shift_id: 1, produced: 149, actual: 149, status: 'in_progress' }),
    expect.objectContaining({ shift_id: 2, produced: 0, actual: 0, status: 'upcoming', starts_at: '2026-10-27T14:30:00.000Z', ends_at: '2026-10-28T02:30:00.000Z' })
  ]);
  expect(out.trend.reduce((total, row) => total + row.produced, 0)).toBe(149);
  expect(out.time.run_seconds / 3600).toBe(37.75);
  expect(out.energy.kwh).toBe(30.52);
  expect(out.trend.reduce((total, row) => total + row.kwh, 0)).toBe(30.52);
  expect(oee.machineTotals).toHaveBeenCalledWith(expect.objectContaining({ start: '2026-10-27T02:30:00.000Z', end: '2026-10-27T07:04:00.000Z' }));
  expect(out.updated_at).toBe('2026-10-27T07:04:00.000Z');
});

test.each([
  ['2026-10-27T00:00:00+05:30', '2026-10-26', ['completed', 'in_progress']],
  ['2026-10-27T00:00:00+05:30', '2026-10-27', ['upcoming', 'upcoming']],
  ['2026-10-27T08:00:00+05:30', '2026-10-26', ['completed', 'completed']],
  ['2026-10-27T08:00:00+05:30', '2026-10-27', ['in_progress', 'upcoming']],
  ['2026-10-27T19:59:59+05:30', '2026-10-27', ['in_progress', 'upcoming']],
  ['2026-10-27T20:00:00+05:30', '2026-10-27', ['completed', 'in_progress']],
  ['2026-10-28T00:00:00+05:30', '2026-10-27', ['completed', 'in_progress']],
  ['2026-10-28T08:00:00+05:30', '2026-10-27', ['completed', 'completed']],
  ['2026-10-27T12:34:00+05:30', '2026-10-25', ['completed', 'completed']],
  ['2026-10-27T12:34:00+05:30', '2026-10-28', ['upcoming', 'upcoming']]
])('status at %s for shifts starting %s is %j', async (now, date, statuses) => {
  jest.setSystemTime(new Date(now));
  const out = await svc.getFactoryDashboard(request({ date }));
  expect(out.shiftwise.map(s => s.status)).toEqual(statuses);
  expect(shiftQuery()[1]).toEqual([4, date, new Date(now).toISOString()]);
});

test('comparison binds its date and as-of, and bounds each shift including the overlapping first hour', async () => {
  await svc.getFactoryDashboard(request({ machine_id: '7' }));
  const [sql, params] = shiftQuery();
  expect(params).toEqual([4, '2026-10-27', '2026-10-27T07:04:00.000Z', 7]);
  expect(sql).toMatch(/p\.company_id = sh\.company_id/);
  expect(sql).toMatch(/p\.machine_id = \$4/);
  expect(sql).toMatch(/p\.hour_start >= \(\$2::date::timestamp AT TIME ZONE 'Asia\/Kolkata'\) - INTERVAL '1 hour'/);
  expect(sql).toMatch(/p\.hour_start < LEAST/);
  expect(sql).toMatch(/p\.hour_start \+ INTERVAL '1 hour' > \(\$2::date \+ sh\.start_time\)/);
  expect(sql).toMatch(/WHEN sh\.start_time >= sh\.end_time\s+THEN \$2::date \+ INTERVAL '1 day' \+ sh\.end_time/);
  expect(sql).toMatch(/\(\$2::date \+ sh\.start_time\) AT TIME ZONE 'Asia\/Kolkata' <= \$3::timestamptz/);
  // Filters and settings use the same request/aggregate; no per-shift query.
  expect(db.query.mock.calls.filter(([text]) => /FROM shifts sh/.test(text))).toHaveLength(1);
});

test('half-hour shifts keep exact local start/end timestamps and status boundaries', async () => {
  const answer = db.query.getMockImplementation();
  db.query.mockImplementation(async (sql, params) => /FROM shifts sh/.test(sql)
    ? { rows: shifts.map(row => ({ ...row, start_time: row.shift_id === 1 ? '08:30:00' : '20:30:00', end_time: row.shift_id === 1 ? '20:30:00' : '08:30:00' })) }
    : answer(sql, params));
  jest.setSystemTime(new Date('2026-10-27T08:15:00+05:30'));
  let out = await svc.getFactoryDashboard(request());
  expect(out.shiftwise[0]).toMatchObject({ starts_at: '2026-10-27T03:00:00.000Z', ends_at: '2026-10-27T15:00:00.000Z', status: 'upcoming' });
  jest.setSystemTime(new Date('2026-10-27T08:30:00+05:30'));
  out = await svc.getFactoryDashboard(request());
  expect(out.shiftwise[0].status).toBe('in_progress');
  jest.setSystemTime(new Date('2026-10-28T08:30:00+05:30'));
  out = await svc.getFactoryDashboard(request());
  expect(out.shiftwise[1]).toMatchObject({ starts_at: '2026-10-27T15:00:00.000Z', ends_at: '2026-10-28T03:00:00.000Z', status: 'completed' });
});

test('selecting the night shift preserves the shared overnight window for calendar metrics', async () => {
  const out = await svc.getFactoryDashboard(request({ shift_id: '2' }));
  expect(out.production.produced).toBe(0);
  expect(out.energy.kwh).toBe(0);
  expect(out.time.run_seconds).toBe(0);
  expect(out.trend).toEqual([]);
  expect(out.shiftwise.map(row => row.shift_id)).toEqual([2]);
  expect(oee.machineTotals).toHaveBeenCalledWith(expect.objectContaining({ shiftId: 2, start: '2026-10-27T14:30:00.000Z', end: '2026-10-27T14:30:00.000Z' }));
  expect(shiftQuery()[1][1]).toBe('2026-10-27');
});

test('a selected shift keeps comparison bars, headline and hourly trend in one scope', async () => {
  const answer = db.query.getMockImplementation();
  db.query.mockImplementation(async (sql, params) => /FROM shifts sh/.test(sql)
    ? { rows: [...shifts.slice(0,2), { ...shifts[2], machine_id:7, hour_start:'2026-10-27T20:00:00+05:30', produced:60 }] }
    : answer(sql, params));
  jest.setSystemTime(new Date('2026-10-27T22:36:00+05:30'));
  const out = await svc.getFactoryDashboard(request({ shift_id:'2' }));
  expect(out.shiftwise.map(row => row.shift_id)).toEqual([2]);
  expect(out.production.produced).toBe(60);
  expect(out.shiftwise.reduce((sum,row) => sum+row.produced,0)).toBe(out.production.produced);
  expect(out.trend.reduce((sum,row) => sum+row.produced,0)).toBe(out.production.produced);
});

test('machines without a target remain in pieces but do not inflate the target actual', async () => {
  const answer = db.query.getMockImplementation();
  db.query.mockImplementation(async (sql, params) => {
    const result = await answer(sql, params);
    if (/FROM shifts sh/.test(sql)) result.rows = [...result.rows, { ...shifts[0], machine_id: 11, produced: 100, kwh: 1 }];
    return result;
  });
  const out = await svc.getFactoryDashboard(request());
  expect(out.production.produced).toBe(249);
  expect(out.production.actual).toBe(149);
});

test('OEE receives the exact matched machine rollup totals rather than previous-night output', async () => {
  oee.machineTotals.mockResolvedValueOnce([{ machine_id: 7, produced: 999, run_seconds: 999999, idle_seconds: 1, hours: 10, rejected: 1, cycle_seconds: 25, mult: 2 }]);
  await svc.getFactoryDashboard(request());
  expect(oee.deriveOee).toHaveBeenCalledWith(expect.objectContaining({ machine_id: 7, produced: 119, run_seconds: 100000, idle_seconds: 10000, hours: 1, rejected: 1, cycle_seconds: 25, mult: 2 }), {});
});

test('bounded Unassigned records count once without a fabricated shift time, status or target', async () => {
  const answer = db.query.getMockImplementation();
  db.query.mockImplementation(async (sql, params) => {
    const result = await answer(sql, params);
    if (/FROM shifts sh/.test(sql)) result.rows = [...result.rows, { shift_id: null, shift_code: 'Unassigned', shift_name: 'Unassigned', start_time: null, end_time: null, machine_id: 7, hour_start: '2026-10-27T06:00:00+05:30', produced: 17, run_seconds: 1200, idle_seconds: 0, kwh: 1 }];
    return result;
  });
  const out = await svc.getFactoryDashboard(request());
  expect(out.production.produced).toBe(166);
  expect(out.production.target).toBe(1724);
  const unassigned = out.shiftwise.find(row => row.shift_id === null);
  expect(unassigned).toMatchObject({ shift_code: 'Unassigned', produced: 17, target: null });
  expect(unassigned.starts_at).toBeUndefined();
  expect(unassigned.status).toBeUndefined();
  expect(shiftQuery()[0]).toMatch(/missing_shift\.id IS NULL/);
  expect(shiftQuery()[0]).toMatch(/p\.hour_start >= \$2::date::timestamp AT TIME ZONE 'Asia\/Kolkata'/);
});

test('trend remains chronological even when shift-code order differs from clock order', async () => {
  const answer = db.query.getMockImplementation();
  db.query.mockImplementation(async (sql, params) => /FROM shifts sh/.test(sql)
    ? { rows: [
      { ...shifts[2], machine_id: 7, hour_start: '2026-10-27T21:00:00+05:30', produced: 2, kwh: 1 },
      shifts[0]
    ] }
    : answer(sql, params));
  jest.setSystemTime(new Date('2026-10-28T09:00:00+05:30'));
  const out = await svc.getFactoryDashboard(request());
  expect(out.trend.map(row => row.hour.toISOString())).toEqual(['2026-10-27T02:30:00.000Z', '2026-10-27T15:30:00.000Z']);
});

test('monthly energy stops at the selected plant day and request clock, and checks the recorded machine owner', async () => {
  await svc.getFactoryDashboard(request({ machine_id: '7' }));
  const [sql, params] = db.query.mock.calls.find(([text]) => /date_trunc\('month'/.test(text));
  expect(params).toEqual([4, '2026-10-27', '2026-10-27T07:04:00.000Z', 7]);
  expect(sql).toContain('JOIN machines owned ON owned.id = p.machine_id AND owned.company_id = $1');
  expect(sql).toContain('WHERE p.company_id = $1');
  expect(sql).toContain("p.hour_start < LEAST((($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), $3::timestamptz)");
  expect(sql).toContain('p.machine_id = $4');
});

test('live machine state and job target cannot use another company or future telemetry row', async () => {
  await svc.getFactoryDashboard(request());
  const live = db.query.mock.calls.find(([text]) => /FROM counted c/.test(text))[0];
  const target = db.query.mock.calls.find(([text]) => /j\.target_qty::numeric AS target/.test(text))[0];
  expect(live).toContain('t.company_id = $1');
  expect(live).toContain('t.received_at <= NOW()');
  expect(target).toContain('WHERE j.company_id = $1');
});
