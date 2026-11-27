const db = require('../../src/db');
const scope = require('../../src/lib/read-scope');
const store = require('../../src/dashboard/energy-store');
const { splitRange, floor, dayOf, periodRanges, completePeriod } = store._test;
const day = '2026-10-29';
const ms = value => Date.parse(value);
const ist = value => `${day}T${value}+05:30`;
const fact = (extra = {}) => ({ machine_id: 25, shift_id: 6, period: 'range', bucket: ist('08:00:00'),
  kwh: 0, accepted_intervals: 1, rejected_intervals: 0, unallocated_intervals: 0,
  measured_seconds: 3600, pending: false, ...extra });
let answers;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(ist('12:00:00')));
  process.env.ENERGY_V2_ENABLED = 'true';
  store.invalidate();
  answers = [];
  db.query.mockReset().mockImplementation(async (sql, params) => {
    const answer = answers.find(([pattern]) => pattern.test(sql));
    return { rows: answer ? (typeof answer[1] === 'function' ? answer[1](params, sql) : answer[1]).map(r => ({ ...r })) : [] };
  });
});
afterEach(() => { delete process.env.ENERGY_V2_ENABLED; jest.useRealTimers(); });

test('IST month/day/hour partitions exactly cover a range without overlap or raw-history scans', () => {
  for (let n = 0; n < 40; n++) {
    const start = ms('2026-01-01T00:00:00+05:30') + n * 176400731;
    const end = start + (n + 1) * 119047113;
    const spans = splitRange(start, end);
    expect(spans[0].start).toBe(start);
    expect(spans.at(-1).end).toBe(end);
    expect(spans.reduce((sum, r) => sum + r.end - r.start, 0)).toBe(end - start);
    expect(spans.filter(r => r.source === 'facts').length).toBeLessThanOrEqual(2);
    for (let i = 0; i < spans.length; i++) {
      expect(spans[i].end).toBeGreaterThan(spans[i].start);
      if (i) expect(spans[i].start).toBe(spans[i - 1].end);
    }
  }
  expect(floor(ms('2026-10-28T23:59:59+05:30'), 'day')).toBe(ms('2026-10-28T00:00:00+05:30'));
  expect(dayOf('2026-10-28T20:00:00Z')).toBe('2026-10-29');
  expect(() => splitRange(0, 1000, 'bad')).toThrow('granularity');
});

test('disabled deployments never touch the database and readiness caches only per tenant', async () => {
  process.env.ENERGY_V2_ENABLED = 'false';
  expect(await store.enabled(4)).toBe(false);
  expect(db.query).not.toHaveBeenCalled();
  process.env.ENERGY_V2_ENABLED = 'true';
  answers.push([/SELECT ready/, params => [{ ready: params[0] === 4 }]]);
  expect(await store.enabled(4)).toBe(true);
  expect(await store.enabled(4)).toBe(true);
  expect(await store.enabled(5)).toBe(false);
  expect(db.query).toHaveBeenCalledTimes(2);
  store.invalidate(4);
  expect(await store.enabled(4)).toBe(true);
  expect(db.query).toHaveBeenCalledTimes(3);
});

test('unknown, measured zero, pending corrections, unallocated gaps, and stale coverage stay distinct', () => {
  expect(store.combine([])).toMatchObject({ kwh: null, energy_complete: false });
  expect(store.combine([fact()])).toMatchObject({ kwh: 0, energy_complete: true });
  expect(store.combine([fact({ pending: true })])).toMatchObject({ kwh: 0, energy_complete: false });
  expect(store.combine([fact({ kwh: 3, unallocated_intervals: 1 })])).toMatchObject({ kwh: 3, energy_complete: false });
  expect(store.combine([fact()], 7200).energy_complete).toBe(false);
  expect(store.combine([fact()], 3600).energy_complete).toBe(true);
  expect(store.combine([fact({ energy_complete: false })]).energy_complete).toBe(false);
});

test('counter reads bind company/machine/search and enforce plant authorization on every source', async () => {
  const malicious = "'% UNION SELECT * FROM companies --";
  await scope.run({ company_id: 4, plant_id: 2, roles: ['USER'] }, () => store.counters({ companyId: 4, machineId: 25, search: malicious },
    [{ start: ms('2026-10-01T00:00:00+05:30'), end: ms('2026-10-29T12:00:00+05:30') }], 'day'));
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toContain('e.company_id=$1');
  expect(sql).toContain("e.register='kwh_total'");
  expect(sql).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 2');
  expect(sql).toContain('JOIN selected');
  expect(sql).not.toContain(malicious);
  expect(params).toContain(malicious.toLowerCase());
  expect(params.slice(0, 2)).toEqual([4, 25]);
  expect(sql).not.toMatch(/telemetry_raw|energy_observations/);
});

test('machine detail reads the measured latest counter and keeps adjacent shift boundaries exclusive', async () => {
  answers.push([/energy:v2:latest-counter/, [{ total_energy: '3104' }]], [/energy:v2:counters/, [fact({ measured_seconds: 14400, kwh: 2 })]]);
  const result = await store.machineEnergy({ companyId: 4, machineId: 25, start: ist('08:00:00'), end: ist('20:00:00'), asOf: ist('12:00:00') });
  expect(result).toMatchObject({ total_energy: 3104, shift_kwh: 2, energy_complete: true });
  const [sql] = db.query.mock.calls.find(([text]) => text.includes('latest-counter'));
  expect(sql).toContain("field_values->>'kwh_total'");
  expect(sql).toContain("field_observed_at->>'kwh_total')::double precision");
  expect(sql).not.toContain("field_observed_at->>'kwh_total')::timestamptz");
  const bounds = store._test.range(ist('08:00:00'), ist('20:00:00'), ist('12:00:00'));
  expect(bounds.end).toBe(ms(ist('12:00:00')) + 1);
  db.query.mockClear();
  await store.machineEnergy({ companyId: 4, machineId: 25, start: '2026-10-28T08:00:00+05:30', end: '2026-10-28T20:00:00+05:30', asOf: ist('12:00:00') });
  const params = db.query.mock.calls.find(([text]) => text.includes('energy:v2:counters'))[1];
  expect(params).toContain('2026-10-28T14:30:00.000Z');
  expect(params).not.toContain('2026-10-28T14:30:00.001Z');
});

test('dashboard figures flag missing time, preserve zero, and keep daily/monthly/machine sums equal', async () => {
  answers.push([/energy:v2:counters/, [fact({ bucket: ist('00:00:00'), kwh: 0, measured_seconds: 43200 })]],
    [/energy:v2:machine-figures/, [{ machine_id: 25, machine_serial_no: 'HMC', produced: 4, run_seconds: 120, pending: false }]]);
  const result = await store.figures({ companyId: 4, start: ist('00:00:00'), end: ist('23:59:59.999') });
  expect(result.machines[0]).toMatchObject({ kwh: 0, energy_complete: true, rejected_intervals: 0 });
  expect(result.machineDays[0].kwh).toBe(0);
  expect(result.trend[0]).toMatchObject({ kwh: 0, machines: 1 });
  expect(result.months[0].kwh).toBe(0);
  answers[0][1][0].measured_seconds = 3600;
  const partial = await store.figures({ companyId: 4, start: ist('00:00:00'), end: ist('23:59:59.999') });
  expect(partial.machines[0]).toMatchObject({ kwh: 0, energy_complete: false });
  // Missing elapsed coverage is separate from rejected physical samples.
  expect(partial.machines[0].rejected_intervals).toBe(0);
  expect(partial.trend[0].machines).toBe(0);
});

test('a queue item makes dashboard results incomplete even when no ledger row carries it', async () => {
  answers.push([/energy:v2:counters/, [fact({ bucket: ist('00:00:00'), measured_seconds: 43200 })]],
    [/energy:v2:machine-figures/, [{ machine_id: 25, pending: true }]]);
  expect((await store.figures({ companyId: 4, start: ist('00:00:00'), end: ist('23:59:59.999') })).machines[0])
    .toMatchObject({ kwh: 0, energy_complete: false });
});

test('shift names are available for energy-only machines without CNC production rows', async () => {
  answers.push([/energy:v2:counters/, [fact({ kwh: 3 })]], [/energy:v2:shift-production/, [{ shift_id: 6, shift_name: 'Night' }]]);
  const result = await store.byShift({ companyId: 4, start: ist('00:00:00'), end: ist('23:59:59.999') });
  expect(result).toEqual([expect.objectContaining({ shift_id: 6, shift_name: 'Night', kwh: 3, produced: 0 })]);
});

test('shift energy reuses the cached dashboard snapshot when newer facts have arrived', async () => {
  const opts={companyId:4,start:ist('00:00:00'),end:ist('23:59:59.999')};
  answers.push([/energy:v2:counters/,[fact({kwh:3})]],
    [/energy:v2:machine-figures/,[{machine_id:25,pending:false}]],
    [/energy:v2:shift-production/,[{shift_id:6,shift_name:'Night'}]]);
  const snapshot=await store.figures(opts);
  answers[0][1]=[fact({kwh:9})]; // Database changes after figures were cached.
  db.query.mockClear();
  const shifts=await store.byShift(opts,snapshot.shiftEnergy);
  expect(snapshot.machines[0].kwh).toBe(3);
  expect(shifts.reduce((n,row)=>n+row.kwh,0)).toBe(3);
  expect(db.query.mock.calls.some(([sql])=>sql.includes('energy:v2:counters'))).toBe(false);
  expect((await store.byShift(opts))[0].kwh).toBe(9); // A fresh snapshot sees new work.
});

test('overnight shift periods start on selected date and future shifts contribute no expected time', () => {
  const shift = { id: 6, start_time: '20:00:00', end_time: '08:00:00' };
  const ranges = periodRanges('2026-10-28', '2026-10-28', [shift], 6, ms(ist('12:00:00')));
  expect(ranges[0]).toMatchObject({ start: ms('2026-10-28T20:00:00+05:30'), end: ms('2026-10-29T08:00:00+05:30'), expectedSeconds: 43200 });
  expect(completePeriod([fact({ measured_seconds: 43200 })], ranges)).toBe(true);
  expect(completePeriod([fact({ measured_seconds: 3600 })], ranges)).toBe(false);
  expect(periodRanges(day, day, [shift], 6, ms(ist('12:00:00')))[0].expectedSeconds).toBe(0);
  const month = periodRanges('2026-10-01', day, [shift], 6, ms(ist('12:00:00')))[0];
  expect(month.expectedSeconds).toBe(28 * 43200);
});

function factoryFixture(settings, machines = [25]) {
  const shift = { id: 6, start_time: '00:00:00', end_time: '00:00:00' };
  const periods = { day: [day, day], yesterday: ['2026-10-28', '2026-10-28'], month: ['2026-10-01', '2026-10-31'], prev_month: ['2026-09-01', '2026-09-30'] };
  const rows = Object.entries(periods).flatMap(([period, [from, to]]) => machines.map(machine_id => fact({ machine_id, period, kwh: machine_id === 25 ? 2 : 3,
    measured_seconds: periodRanges(from, to, [shift], 6, Date.now())[0].expectedSeconds })));
  answers.push([/energy:v2:factory-machines/, machines.map(machine_id => ({ machine_id }))], [/FROM shifts sh/, [shift]],
    [/FROM energy_settings es/, settings], [/energy:v2:counters/, params => rows.filter(row => params.includes(row.period))]);
  return rows;
}

test('factory uses per-machine tariffs, preserves measured totals, and rejects incomplete costs', async () => {
  const rows = factoryFixture([{ machine_id: null, cost_per_kwh: 10, currency: 'INR' }, { machine_id: 25, cost_per_kwh: 20, currency: 'INR' }], [25, 26]);
  const result = await store.factoryEnergy({ companyId: 4, date: day, asOf: ist('12:00:00') });
  expect(result).toMatchObject({ kwh: 5, cost_day: 70, cost_month: 70, currency: 'INR', energy_complete: true, cost_complete: true });
  rows.find(r => r.period === 'day' && r.machine_id === 25).pending = true;
  expect(await store.factoryEnergy({ companyId: 4, date: day, asOf: ist('12:00:00') }))
    .toMatchObject({ kwh: 5, cost_day: null, energy_complete: false, cost_complete: false });
});

/* 27 Nov 2026, production: "energy_month 8.6–16.6 s". The daily and monthly
   summaries are real-time aggregates: their not-yet-materialized part (today,
   the current month, all history until a month is complete) was aggregated
   from raw intervals on every read. Month totals now read the hourly summary
   (same sums; on a local copy 0.58–1.26 s became 0.08–0.13 s). */
test('factory month totals read only the hourly summary, never the real-time daily or monthly ones', async () => {
  factoryFixture([{ machine_id: null, cost_per_kwh: 10, currency: 'INR' }]);
  const result = await store.factoryEnergy({ companyId: 4, date: day, asOf: ist('12:00:00') });
  expect(result).toMatchObject({ month_kwh: 2, prev_month_kwh: 2 });
  const reads = db.query.mock.calls.map(([sql]) => sql).filter(sql => /energy:v2:counters/.test(sql));
  expect(reads).toHaveLength(2);
  for (const sql of reads) {
    expect(sql).not.toMatch(/energy_counter_(daily|monthly)/);
    expect(sql).toMatch(/energy_counter_hourly/);
  }
});

test('a summary coarser than the grain asked for is refused', async () => {
  const range = [{ start: ms(ist('00:00:00')), end: ms(ist('12:00:00')) }];
  await expect(store.counters({ companyId: 4 }, range, 'day', 'month')).rejects.toThrow('granularity');
  await expect(store.counters({ companyId: 4 }, range, 'total', 'week')).rejects.toThrow('granularity');
});

test('factory currency follows selected effective tariffs and does not mix different currencies', async () => {
  factoryFixture([{ machine_id: null, cost_per_kwh: 10, currency: 'INR' }, { machine_id: 25, cost_per_kwh: 0, currency: 'USD' }]);
  expect(await store.factoryEnergy({ companyId: 4, date: day, machineId: 25, asOf: ist('12:00:00') }))
    .toMatchObject({ currency: 'USD', cost_day: 0, cost_complete: true });
  answers = [];
  factoryFixture([{ machine_id: 25, cost_per_kwh: 10, currency: 'INR' }, { machine_id: 26, cost_per_kwh: 2, currency: 'USD' }], [25, 26]);
  expect(await store.factoryEnergy({ companyId: 4, date: day, asOf: ist('12:00:00') }))
    .toMatchObject({ kwh: 5, currency: null, cost_day: null, cost_complete: false });
});

test('meter buckets expose all registers, preserve genuine zero, and retain unknown chart gaps', async () => {
  const t = ms(ist('08:00:00'));
  answers.push([/energy:v2:meter-counters/, [fact({ t, register: 'kwh_total', measured_seconds: 3600 }),
    fact({ t, register: 'kwh_import', kwh: 2 }), fact({ t, register: 'kwh_export', kwh: 1 }),
    fact({ t, register: 'kvarh_total', kwh: 4 }), fact({ t, register: 'kvah_total', kwh: 5 })]]);
  const points = await store.meterEnergy({ companyId: 4, machineId: 25, start: ist('08:00:00'), end: ist('10:00:00'), bucketSeconds: 3600 });
  expect(points).toHaveLength(2);
  expect(points[0]).toMatchObject({ t, kwh: 0, kwh_import: 2, kwh_export: 1, kvarh: 4, kvah: 5, energy_complete: true });
  expect(points[1]).toMatchObject({ kwh: null, kwh_import: null, energy_intervals: 0, energy_complete: false });
  expect(db.query.mock.calls[0][0]).toContain('FROM energy_counter_hourly');
  expect(db.query.mock.calls[0][0]).not.toMatch(/energy_meter_readings|telemetry_raw/);
});

test('sub-hour meter buckets use bounded validated facts and flag unallocated known subtotals', async () => {
  const t = ms(ist('08:00:00'));
  answers.push([/energy:v2:meter-counters/, [fact({ t, register: 'kwh_total', kwh: 2, measured_seconds: 60, unallocated_intervals: 1 })]]);
  const points = await store.meterEnergy({ companyId: 4, machineId: 25, start: ist('08:00:00'), end: ist('08:02:00'), bucketSeconds: 60 });
  expect(points[0]).toMatchObject({ kwh: 2, energy_unallocated_intervals: 1, energy_complete: false });
  expect(db.query.mock.calls[0][0]).toContain('FROM energy_counter_intervals');
  expect(db.query.mock.calls[0][0]).not.toContain('FROM energy_counter_hourly');
  await expect(store.meterEnergy({ companyId: 4, machineId: 25, start: '2026-10-01', end: '2026-10-29', bucketSeconds: 60 })).rejects.toThrow('seven days');
});

test('reports retain inactive machine history, use overnight shift start dates and allocate duplicate joins only once', async () => {
  const hour_start = '2026-10-28T20:00:00+05:30';
  answers.push([/energy:v2:report-shifts/, [{ id: 6, start_time: '20:00:00', end_time: '08:00:00' }]],
    [/energy:v2:counters/, [fact({ bucket: hour_start, kwh: 4 })]]);
  const rows = [{ machine_id: 25, shift_id: 6, hour_start }, { machine_id: 25, shift_id: 6, hour_start }];
  const coverage = await store.attachReportEnergy(4, rows, { date_from: '2026-10-28', date_to: '2026-10-28', shift_id: 6 });
  expect(rows.map(r => r.energy_kwh)).toEqual([4, null]);
  expect(coverage).toMatchObject({ rows_with_energy: 1, accepted_intervals: 1, energy_complete: false });
  const [sql, params] = db.query.mock.calls.find(([text]) => text.includes('energy:v2:counters'));
  expect(sql).not.toContain('m.is_active=TRUE');
  expect(params).toContain('2026-10-28T14:30:00.000Z');
  expect(params).toContain('2026-10-29T02:30:00.000Z');
});

test('reports expose energy without production rows rather than silently adding it to another machine/hour', async () => {
  answers.push([/energy:v2:counters/, [fact({ kwh: 2 }), fact({ machine_id: 26, kwh: 3 })]]);
  const rows = [{ machine_id: 25, shift_id: 6, hour_start: ist('08:00:00') }];
  const coverage = await store.attachReportEnergy(4, rows);
  expect(rows[0]).toMatchObject({ energy_kwh: 2, energy_complete: true });
  expect(coverage).toMatchObject({ energy_without_production_rows_kwh: 3, energy_complete: false });
});


test('an unset deployment flag discovers verified readiness per company and never opts an unready tenant into summaries', async () => {
  delete process.env.ENERGY_V2_ENABLED;
  answers.push([/SELECT ready/, params => [{ ready: params[0] === 4 }]]);
  expect(await store.enabled(4)).toBe(true);
  expect(await store.enabled(5)).toBe(false);
  expect(db.query.mock.calls.map(([, params]) => params)).toEqual([[4], [5]]);
  process.env.ENERGY_V2_ENABLED = 'false';
  expect(await store.enabled(4)).toBe(false);
  expect(db.query).toHaveBeenCalledTimes(2);
});
