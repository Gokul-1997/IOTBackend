jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const readScope = require('../../src/lib/read-scope');
const reports = require('../../src/reports/report.service');

const now = '2026-10-27T07:14:00.000Z'; // 12:44 PM in the plant
const rows = [
  { machine: 'VMC-1', operator: '--', shift: 'Shift 1', hour: '27-Oct 08:00',
    produced_qty: 119, run_seconds: 72000, idle_seconds: 3600, manual_seconds: 600, off_seconds: 0, energy_kwh: '20.000' },
  { machine: 'VMC-2', operator: '--', shift: 'Shift 1', hour: '27-Oct 09:00',
    produced_qty: 30, run_seconds: 63900, idle_seconds: 3600, manual_seconds: 0, off_seconds: 0, energy_kwh: '10.520' }
];

beforeEach(() => {
  resetDb();
  jest.useFakeTimers().setSystemTime(new Date(now));
});
afterEach(() => jest.useRealTimers());

test('production summary preserves stored quantities and the existing row/summary contract', async () => {
  mockDb.queueResponse({ rows });
  const result = await reports.productionData(4, '2026-10-27', '2026-10-27');

  expect(result.summary).toEqual({ total_parts: 149, run_hours: '37.75', total_energy: '30.52', efficiency_pct: '95.0' });
  expect(result.rows[0]).toEqual({ ...rows[0], run_time: '20:00', idle_time: '01:00', setup_time: '00:10', off_time: '00:00' });
  expect(mockDb.calls()).toHaveLength(1);
  expect(mockDb.calls()[0].text).not.toMatch(/multiplication_factor|JOIN components/);
});

test('the shift window includes its first partial hour and guards an upcoming shift bucket', async () => {
  await reports.productionData(4, '2026-10-27', '2026-10-27');
  const { text, params } = mockDb.calls()[0];

  expect(text).toMatch(/p\.hour_start \+ INTERVAL '1 hour' > \(\$2::date \+ s\.start_time\)/);
  expect(text).toMatch(/CASE WHEN s\.start_time >= s\.end_time/);
  expect(text).toMatch(/clock\.as_of AT TIME ZONE 'Asia\/Kolkata'\)::date \+ s\.start_time/);
  expect(text).toMatch(/p\.hour_start < LEAST\(/);
  expect(params).toEqual([4, '2026-10-27', '2026-10-27', now]);
});

test('missing shifts have a bounded calendar fallback rather than all historical rows', async () => {
  await reports.productionData(4, '2026-10-26', '2026-10-27');
  const { text } = mockDb.calls()[0];

  expect(text).toMatch(/s\.start_time IS NULL\s+AND p\.hour_start >= \$2::date::timestamp/);
  expect(text).toMatch(/AND p\.hour_start < \(\$3::date \+ 1\)::timestamp/);
  expect(text).toMatch(/p\.hour_start >= \(\$2::date::timestamp AT TIME ZONE 'Asia\/Kolkata'\) - INTERVAL '1 hour'/);
  expect(text).toMatch(/\(\$3::date \+ 2\)::timestamp/);
  expect(text).toMatch(/s\.id = p\.shift_id AND s\.company_id = \$1/);
});

test('machine, shift, operator and plant filters still constrain the same single query', async () => {
  await readScope.run({ company_id: 4, plant_id: 2 }, () =>
    reports.productionData(4, '2026-10-26', '2026-10-27', 7, 3, 9));
  const { text, params } = mockDb.calls()[0];

  expect(params).toEqual([4, '2026-10-26', '2026-10-27', 7, 3, 9, now]);
  expect(text).toContain('p.machine_id       = $4');
  expect(text).toContain('p.shift_id         = $5');
  expect(text).toContain('op.operator_id     = $6');
  expect(text).toContain('SELECT $7::timestamptz AS as_of');
  expect(text).toContain('WHERE m.company_id = $1');
  expect(text).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 2');
  expect(mockDb.calls()).toHaveLength(1);
});

test('download and email rows use the same corrected production dataset', async () => {
  mockDb.queueResponse({ rows });
  const result = await reports.reportRows('production', 4, {
    date_from: '2026-10-27', date_to: '2026-10-27', machine_id: 7, shift_id: 1
  });

  expect(result.map(row => row.produced_qty)).toEqual([119, 30]);
  expect(mockDb.calls()).toHaveLength(1);
  expect(mockDb.calls()[0].params).toEqual([4, '2026-10-27', '2026-10-27', 7, 1, now]);
});
