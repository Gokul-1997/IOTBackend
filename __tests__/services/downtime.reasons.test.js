/*
 * Downtime page: reason codes once each, a Summary without dates, and a
 * duplicate code said in words.
 *
 * Production has every built-in reason code twice (ids 1–10 and 11–20):
 * migration 007 ran twice and its unique index on (company_id, code) treats
 * each NULL company as different. The Summary tab sent no dates and the
 * service bound "NOW() - INTERVAL '7 days'" as a value — a 500 every time,
 * which the page showed as "No downtime to summarise yet".
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/downtime/downtime.service');

beforeEach(() => resetDb());

test('reason codes: one row per code per owner, the oldest copy, then by category and name', async () => {
  await svc.getReasons(13);
  const [{ text, params }] = mockDb.calls();
  expect(text).toMatch(/SELECT DISTINCT ON \(company_id, code\) \* FROM downtime_reasons/);
  expect(text).toMatch(/ORDER BY company_id, code, id\s*\)\s*r\s*ORDER BY category, name/);
  expect(text).toMatch(/company_id = \$1 OR company_id IS NULL/);
  expect(params).toEqual([13]);
});

test('summary without dates: the last 7 days, worked out by the database', async () => {
  mockDb.queueResponse({ rows: [{ category: 'UNPLANNED', reason_name: 'No material', code: 'ZZCR1', event_count: '1', total_seconds: '600' }] });
  const rows = await svc.getDowntimeSummary({ company_id: 13 });
  const [{ text, params }] = mockDb.calls();
  expect(params).toEqual([13, null, null]);
  expect(text).toMatch(/COALESCE\(\$2::timestamptz, NOW\(\) - INTERVAL '7 days'\)/);
  expect(text).toMatch(/COALESCE\(\$3::timestamptz, NOW\(\)\)/);
  expect(rows).toHaveLength(1);
});

test('summary with dates passes them on; a date that is not one is a 400, not a 500', async () => {
  await svc.getDowntimeSummary({ company_id: 13, from_date: '2026-10-01', to_date: '2026-10-07T23:59:59+05:30' });
  expect(mockDb.calls()[0].params).toEqual([13, '2026-10-01', '2026-10-07T23:59:59+05:30']);
  await expect(svc.getDowntimeSummary({ company_id: 13, from_date: 'last week' }))
    .rejects.toEqual({ status: 400, message: 'from_date is not a date' });
  expect(mockDb.calls()).toHaveLength(1);
});

test('a code the company already has is a 409 in words; other database errors pass through untouched', async () => {
  mockDb.queueError(Object.assign(new Error('duplicate key value violates unique constraint "idx_downtime_reasons_code"'), { code: '23505' }));
  await expect(svc.createReason({ company_id: 13, code: 'brk', name: 'Breakdown' }))
    .rejects.toEqual({ status: 409, message: 'Reason code BRK already exists' });

  const down = Object.assign(new Error('connection terminated'), { code: '57P01' });
  mockDb.queueError(down);
  await expect(svc.createReason({ company_id: 13, code: 'X1', name: 'X' })).rejects.toBe(down);
});

test('events: a page or limit that is not a number falls back instead of reaching the database', async () => {
  mockDb.queueResponse({ rows: [{ count: '0' }] }, { rows: [] });
  const r = await svc.getEvents({ company_id: 13, page: 'abc', limit: '-5' });
  expect(r.pagination).toMatchObject({ page: 1, limit: 1 });
  const data = mockDb.calls()[1];
  expect(data.params.slice(-2)).toEqual([1, 0]);
});
