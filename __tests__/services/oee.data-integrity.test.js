jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const oee = require('../../src/dashboard/oee.dashboard.service');
const operators = require('../../src/dashboard/operator.service');
const reports = require('../../src/reports/report.service');

beforeEach(() => {
  resetDb();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-28T17:06:00Z'));
});
afterEach(() => jest.useRealTimers());

test('OEE and Operator dates mean the same plant days even when the server uses UTC', () => {
  const expected = { start: '2026-10-28T00:00:00+05:30', end: '2026-10-28T23:59:59.999+05:30' };
  expect(oee.resolveRange({ from: '2026-10-28', to: '2026-10-28' })).toEqual(expected);
  expect(operators.resolveRange({ from: '2026-10-28', to: '2026-10-28' })).toEqual(expected);
  jest.setSystemTime(new Date('2026-10-28T01:00:00+05:30'));
  expect(oee.resolveRange({}).end).toBe(expected.end);
});

test.each(['2026-02-31', '2026-13-01'])('a nonexistent report day is refused: %s', date => {
  expect(() => oee.resolveRange({ from: date })).toThrow(expect.objectContaining({ status: 400 }));
});

test('OEE refuses an unbounded date range before reading telemetry', async () => {
  await expect(oee.getOee({ company_id: 4, from: '2020-01-01', to: '2026-10-28' }))
    .rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});

test('OEE totals and daily chart read the same shift-start-day scope and reject future/foreign rows', async () => {
  await oee.getOee({ company_id: 4, from: '2026-10-28', to: '2026-10-28', shift_id: 2 });
  const calls = mockDb.calls();
  expect(calls).toHaveLength(2);
  for (const { text, params } of calls) {
    expect(params).toEqual([4, '2026-10-28T00:00:00+05:30', '2026-10-28T23:59:59.999+05:30', 2]);
    expect(text).toContain('ph.company_id = $1');
    expect(text).toContain('ps.id = ph.shift_id AND ps.company_id = $1');
    expect(text).toContain('ph.hour_start < LEAST(');
    expect(text).toContain('ps.start_time >= ps.end_time');
    expect(text).toContain('ph.hour_start + INTERVAL \'1 hour\' >');
    expect(text).toContain('ph.shift_id = $4');
    expect(text).toContain('q.shift_date <= (NOW() AT TIME ZONE \'Asia/Kolkata\')::date');
  }
  // The overnight tail must be on its shift's starting day in the trend.
  expect(calls[1].text).toContain('THEN 1 ELSE 0 END) AS day');
  expect(calls[0].text).toContain('t.received_at <= NOW()');
});

test('an OEE export contains every machine, while the API page still holds at most 200', async () => {
  const machines = Array.from({ length: 241 }, (_, index) => ({
    machine_id: index + 1, machine_serial_no: `M-${String(index + 1).padStart(3, '0')}`,
    produced: 1, run_seconds: 60, idle_seconds: 0, hours: 1, rejected: 0,
    cycle_seconds: 60, mult: 1, downtime_seconds: 0, alarm_count: 0
  }));
  mockDb.queueResponse({ rows: machines }, { rows: [] }, { rows: machines }, { rows: [] }, { rows: machines }, { rows: [] });
  const page = await oee.getOee({ company_id: 4, limit: 200 });
  const fleet = await oee.getOee({ company_id: 4, all_machines: '1' });
  const exported = await oee.getExportRows({ company_id: 4 });
  expect(page.machines.data).toHaveLength(200);
  expect(page.kpis.produced).toBe(241);
  expect(fleet.machines.data).toHaveLength(241);
  expect(fleet.machines).toMatchObject({ page: 1, totalPages: 1, total: 241 });
  expect(exported).toHaveLength(241);
  expect(exported.reduce((sum, row) => sum + row.Production, 0)).toBe(241);
});

test('Factory overnight quality keeps the shift starting day rather than the following day', async () => {
  await oee.machineTotals({ companyId: 4, start: '2026-10-28T08:00:00+05:30',
    end: '2026-10-29T08:00:00+05:30', qualityDays: { from: '2026-10-28', to: '2026-10-28' } });
  const { text, params } = mockDb.calls()[0];
  expect(params.slice(-2)).toEqual(['2026-10-28', '2026-10-28']);
  expect(text).toContain('q.shift_date >= $4::date');
  expect(text).toContain('q.shift_date <= $5::date');
  expect(text).toContain("(q.shift_date + qs.start_time) AT TIME ZONE 'Asia/Kolkata' <= NOW()");
});

test('Hourly OEE bounds missing-shift rows and keeps old NULL owners without leaking explicit foreign owners', async () => {
  await reports.oeeHourlyData(4, '2026-10-28', '2026-10-28', 7, 2, 9);
  const { text, params } = mockDb.calls()[0];
  expect(params).toEqual([4, '2026-10-28', '2026-10-28', 7, 2, 9, '2026-10-28T17:06:00.000Z']);
  expect(text).toContain('o.company_id IS NULL OR o.company_id = $1');
  expect(text).toContain('s.start_time IS NULL\n          AND o.hour_start >=');
  expect(text).toContain('o.hour_start < LEAST(');
  expect(text).toContain('clock.as_of');
  expect(text).toContain('o.machine_id   = $4');
  expect(text).toContain('o.shift_id     = $5');
  expect(text).toContain('op.operator_id = $6');
});

test('Shift OEE reports only completed shifts owned by the selected company', async () => {
  await reports.shiftOeeData(4, '2026-10-28', '2026-10-28');
  const { text } = mockDb.calls()[0];
  expect(text).toContain('s.id = o.shift_id AND s.company_id = $1');
  expect(text).toContain("AT TIME ZONE 'Asia/Kolkata' <= NOW()");
  expect(text).toContain('s.start_time >= s.end_time');
});
