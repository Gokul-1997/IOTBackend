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

/* 27 Nov 2026, the user: the default reason codes are not wanted for every
   company — each company creates the codes it needs. */
test('reason codes: the company\'s own only — no built-in codes — by category and name', async () => {
  await svc.getReasons(13);
  const [{ text, params }] = mockDb.calls();
  expect(text).toMatch(/WHERE company_id = \$1 AND is_active = true\s+ORDER BY category, name/);
  expect(text).not.toMatch(/IS NULL/);
  expect(params).toEqual([13]);
  await expect(svc.getReasons(null)).rejects.toMatchObject({ status: 403 });
});

test('downtime cannot be booked on a built-in code: only the company\'s own active reasons', async () => {
  mockDb.queueResponse({ rows: [], rowCount: 0 });                  // the built-in reason 2 is not the company's
  await expect(svc.logEvent({ company_id: 13, machine_id: 7, downtime_reason_id: 2, started_at: '2026-11-27T05:00:00Z',
    ended_at: '2026-11-27T05:10:00Z', entered_by: 1 })).rejects.toMatchObject({ status: 404 });
  const [insert] = mockDb.calls();
  expect(insert.text).toMatch(/WHERE id=\$4 AND is_active = TRUE AND company_id=\$1/);
  expect(insert.text).not.toMatch(/company_id IS NULL/);
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
  expect(r.pagination).toMatchObject({ page: 1, limit: 20 });
  const data = mockDb.calls()[1];
  expect(data.params.slice(-2)).toEqual([20, 0]);
});

test('editing trims values, normalizes code/category and only updates the caller\'s active reason', async () => {
  const edited = { id: 25, company_id: 4, code: 'TEA', name: 'Tea break', category: 'PLANNED', is_active: true };
  mockDb.queueResponse({ rows: [edited], rowCount: 1 });
  expect(await svc.updateReason('25', 4, { code: ' tea ', name: ' Tea break ', category: ' planned ', is_active: true })).toEqual(edited);
  expect(mockDb.calls()[0].params).toEqual(['TEA', 'Tea break', 'PLANNED', true, 25, 4]);
  expect(mockDb.calls()[0].text).toMatch(/WHERE id=\$5 AND company_id=\$6 AND is_active = TRUE/);
});

test('editing a duplicated code gives a useful conflict and preserves other database failures', async () => {
  mockDb.queueError(Object.assign(new Error('duplicate'), { code: '23505' }));
  await expect(svc.updateReason(25, 4, { code: 'tea', name: 'Tea', category: 'PLANNED' }))
    .rejects.toEqual({ status: 409, message: 'Reason code TEA already exists' });
  const down = new Error('database unavailable');
  mockDb.queueError(down);
  await expect(svc.deleteReason(25, 4)).rejects.toBe(down);
});

test('deleting deactivates only the owned active catalogue row, leaving historical events untouched', async () => {
  const removed = { id: 25, company_id: 4, code: '4', name: 'TEA', is_active: false };
  mockDb.queueResponse({ rows: [removed], rowCount: 1 });
  expect(await svc.deleteReason('25', 4)).toEqual(removed);
  const [query] = mockDb.calls();
  expect(query.params).toEqual([25, 4]);
  expect(query.text).toMatch(/UPDATE downtime_reasons SET is_active = FALSE/);
  expect(query.text).toMatch(/WHERE id=\$1 AND company_id=\$2 AND is_active = TRUE/);
  expect(query.text).not.toMatch(/DELETE|downtime_events/);
  expect(mockDb.calls()).toHaveLength(1);
});

test('built-in, other-company, already removed and nonexistent reason ids all give the same not-found result', async () => {
  for (const id of [1, 25, 999]) {
    await expect(svc.deleteReason(id, 4)).rejects.toEqual({ status: 404, message: 'Reason not found' });
    await expect(svc.updateReason(id, 4, { code: 'X', name: 'New name', category: 'UNPLANNED' }))
      .rejects.toEqual({ status: 404, message: 'Reason not found' });
  }
  expect(mockDb.calls().every(call => /company_id=\$[26]/.test(call.text))).toBe(true);
});

test.each([
  { code: '', name: 'Name' }, { code: '  ', name: 'Name' }, { code: 4, name: 'Name' },
  { code: 'x'.repeat(21), name: 'Name' }, { code: 'ß'.repeat(11), name: 'Name' },
  { code: 'X', name: '' }, { code: 'X', name: 'n'.repeat(101) }, { code: 'X', name: ['Name'] },
  { code: 'X\u0000', name: 'Name' }, { code: 'X', name: 'Name', category: 'INVALID' },
  { code: 'X', name: 'Name', category: true }, { code: 'X', name: 'Name', is_active: 'false' }
])('invalid edits %j are refused before a database query', async input => {
  await expect(svc.updateReason(25, 4, input)).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});

test.each(['invalid', 0, -1, 1.5, 2147483648])('invalid reason id %j is refused before any query', async id => {
  await expect(svc.deleteReason(id, 4)).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});

test('an account without a company cannot create, edit or delete reasons', async () => {
  const input = { code: 'X', name: 'Name' };
  await expect(svc.createReason({ ...input, company_id: null })).rejects.toMatchObject({ status: 403 });
  await expect(svc.updateReason(25, null, input)).rejects.toMatchObject({ status: 403 });
  await expect(svc.deleteReason(25, null)).rejects.toMatchObject({ status: 403 });
  expect(mockDb.calls()).toHaveLength(0);
});

test('new manual events atomically require the company\'s own active reason while historical links remain untouched', async () => {
  const input = { company_id: 4, machine_id: 81, downtime_reason_id: 25,
    started_at: '2026-11-25T04:00:00Z', ended_at: '2026-11-25T04:01:00Z', entered_by: 7 };
  await expect(svc.logEvent(input)).rejects.toEqual({ status: 404, message: 'Active downtime reason not found' });
  const [query] = mockDb.calls();
  expect(query.text).toMatch(/INSERT INTO downtime_events[\s\S]*SELECT \$1,\$2,\$3,\$4/);
  expect(query.text).toMatch(/\$4::integer IS NULL OR EXISTS/);
  expect(query.text).toMatch(/FROM downtime_reasons WHERE id=\$4 AND is_active = TRUE/);
  expect(query.text).toMatch(/is_active = TRUE AND company_id=\$1\s*\)\)/);
  expect(query.params.slice(0, 4)).toEqual([4, 81, null, 25]);
  expect(mockDb.calls()).toHaveLength(1);
  resetDb();
  mockDb.queueResponse({ rows: [{ id: 90 }], rowCount: 1 });
  expect(await svc.logEvent({ ...input, downtime_reason_id: null })).toEqual({ id: 90 });
});
