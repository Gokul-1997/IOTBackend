jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const scope = require('../../src/lib/read-scope');
const { getOperatorPerformance } = require('../../src/reports/operator.report.service');

beforeEach(() => {
  resetDb();
  jest.useFakeTimers().setSystemTime(new Date('2026-10-28T20:15:00+05:30'));
});
afterEach(() => jest.useRealTimers());

test('production and shift quality aggregate independently after deduplicating authorized assignments', async () => {
  const rows = [{ operator_id: 8, total_produced: '30', total_rejected: '5' }];
  mockDb.queueResponse({ rows });
  const result = await getOperatorPerformance({ company_id: 4, from_date: '2026-10-27', to_date: '2026-10-28', shift_id: '2' });
  const [{ text, params }] = mockDb.calls();
  const production = text.slice(text.indexOf('production_totals AS'), text.indexOf('quality_totals AS'));
  const quality = text.slice(text.indexOf('quality_totals AS'), text.indexOf('machine_totals AS'));
  expect(text).toContain('SELECT DISTINCT o.id AS operator_id, m.id AS machine_id, s.id AS shift_id');
  expect(production).toContain('SUM(ph.produced_qty)');
  expect(production).not.toContain('quality_entries');
  expect(quality).toContain('SUM(qe.reject_qty)');
  expect(quality).not.toContain('production_hourly');
  for (const predicate of ['oma.company_id = $1', 'osa.company_id = $1', 'm.company_id = $1', 's.company_id = $1', 'ph.company_id = $1']) {
    expect(text).toContain(predicate);
  }
  expect(text).not.toMatch(/multiplication_factor|target_qty/);
  expect(params).toEqual([4, '2026-10-27', '2026-10-28', '2026-10-28T14:45:00.000Z', 2, 20, 0]);
  expect(result).toEqual({ data: rows, pagination: { page: 1, limit: 20 } });
});

test('the complete selected shift dates, overnight tail and partial first hour are bounded before aggregation', async () => {
  await getOperatorPerformance({ company_id: 4, from_date: '2026-10-28', to_date: '2026-10-28' });
  const [{ text }] = mockDb.calls();
  expect(text).toContain("ph.hour_start + INTERVAL '1 hour' >");
  expect(text).toContain('(w.from_day + a.start_time)');
  expect(text).toContain("w.to_day + INTERVAL '1 day' + a.end_time");
  expect(text).toContain('ph.hour_start < w.as_of');
  expect(text).toContain('(qe.created_at AT TIME ZONE \'Asia/Kolkata\')::date) >= w.from_day');
  expect(text).toContain('(qe.created_at AT TIME ZONE \'Asia/Kolkata\')::date) <= w.to_day');
  expect(text).toContain("+ a.start_time) AT TIME ZONE 'Asia/Kolkata' <= w.as_of");
});

test('plant-scoped operators only include machines and shifts authorized in the current request', async () => {
  await scope.run({ company_id: 4, plant_id: 8, user_type: 'company_user' }, () => getOperatorPerformance({ company_id: 4 }));
  const [{ text }] = mockDb.calls();
  expect(text).toContain('m.id IN (SELECT authorized_machine.id FROM machines authorized_machine WHERE authorized_machine.company_id = 4 AND authorized_machine.plant_id = 8)');
  expect(text).toContain('(s.plant_id IS NULL OR (TRUE  AND s.plant_id = 8))');
  expect(text).toMatch(/WHERE o\.company_id = \$1\s+AND \(\$5::int IS NULL OR mt\.operator_id IS NOT NULL\)\s+AND mt\.operator_id IS NOT NULL/);
});

test.each([
  { from_date: '2026-02-30' }, { to_date: '28/10/2026' },
  { from_date: '2026-10-29', to_date: '2026-10-28' },
  { shift_id: '2oops' }, { shift_id: -1 }, { shift_id: 1.5 }
])('invalid report scope %j fails before reading data', async filters => {
  await expect(getOperatorPerformance({ company_id: 4, ...filters })).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toEqual([]);
});

test.each([
  [{ page: 'bad', limit: -4 }, 1, 1, 0],
  [{ page: 2, limit: 200 }, 2, 100, 100],
  [{ page: -2, limit: 'bad' }, 1, 20, 0]
])('pagination stays usable for %j', async (pagination, page, limit, offset) => {
  const result = await getOperatorPerformance({ company_id: 4, ...pagination });
  expect(result.pagination).toEqual({ page, limit });
  expect(mockDb.calls()[0].params.slice(-2)).toEqual([limit, offset]);
});
