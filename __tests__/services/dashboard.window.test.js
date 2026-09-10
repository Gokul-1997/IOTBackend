/*
 * Unit tests for dashboard/window — the filter parsing every analytics
 * dashboard shares.
 *
 * These exist because an end-to-end pass found two client mistakes coming
 * back as 500s:
 *   - `date=not-a-date` was interpolated into "not-a-dateT00:00:00+05:30"
 *     and handed to Postgres, which raised a type error.
 *   - a missing shift threw an Error with no .status, so the controller's
 *     `err.status || 500` reported a server fault for a client one.
 *
 * A 500 tells the caller the server is broken and pollutes error
 * monitoring; both are 4xx.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { resolveWindow, parseDate, parseMachineId, scope } = require('../../src/dashboard/window');

const company_id = 4;

beforeEach(() => resetDb());

describe('parseDate', () => {

  test('accepts a real date', () => {
    expect(parseDate('2026-08-06')).toBe('2026-08-06');
  });

  test('defaults to today when omitted', () => {
    expect(parseDate(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test.each([
    ['not-a-date'],
    ['06-08-2026'],
    ['2026/08/06'],
    ['2026-8-6'],
    ["2026-08-06'; DROP TABLE machines;--"]
  ])('rejects %s as 400', (bad) => {
    expect(() => parseDate(bad)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('rejects a date that matches the pattern but does not exist', () => {
    // 31 February passes the regex; only a real calendar check catches it
    expect(() => parseDate('2026-02-31')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('parseMachineId', () => {

  test('returns null when absent, so "all machines" still works', () => {
    expect(parseMachineId(undefined)).toBeNull();
    expect(parseMachineId('')).toBeNull();
    expect(parseMachineId(null)).toBeNull();
  });

  test('accepts a positive integer from the query string', () => {
    expect(parseMachineId('7')).toBe(7);
  });

  test.each([['abc'], ['-1'], ['0'], ['1.5'], ["1 OR 1=1"]])(
    'rejects %s as 400 instead of letting NaN reach the query', (bad) => {
      expect(() => parseMachineId(bad)).toThrow(expect.objectContaining({ status: 400 }));
    });
});

describe('resolveWindow', () => {

  test('a bare date spans the whole day in plant time', async () => {
    const w = await resolveWindow(company_id, { date: '2026-08-06' });

    expect(w.from).toBe('2026-08-06T00:00:00+05:30');
    expect(w.to).toBe('2026-08-06T23:59:59.999+05:30');
    expect(w.shift).toBeNull();
    // no shift means no lookup
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a shift narrows the window to that shift', async () => {
    mockDb.queueResponse({ rows: [{ id: 10, shift_code: 'MS01', start_time: '06:00:00', end_time: '14:00:00' }], rowCount: 1 });

    const w = await resolveWindow(company_id, { date: '2026-08-06', shift_id: 10 });

    expect(w.from).toBe('2026-08-06T06:00:00+05:30');
    expect(w.to).toBe('2026-08-06T14:00:00+05:30');
    expect(w.shift.shift_code).toBe('MS01');
  });

  test('an overnight shift ends on the following day', async () => {
    mockDb.queueResponse({ rows: [{ id: 12, shift_code: 'NS01', start_time: '22:00:00', end_time: '06:00:00' }], rowCount: 1 });

    const w = await resolveWindow(company_id, { date: '2026-08-06', shift_id: 12 });

    expect(w.from).toBe('2026-08-06T22:00:00+05:30');
    expect(w.to).toBe('2026-08-07T06:00:00+05:30');
  });

  test('a missing shift is 404, not 500', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    await expect(resolveWindow(company_id, { date: '2026-08-06', shift_id: 999999 }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('the shift lookup is scoped to the company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    await resolveWindow(company_id, { date: '2026-08-06', shift_id: 10 }).catch(() => {});

    expect(mockDb.calls()[0].text).toMatch(/company_id = \$2/);
    expect(mockDb.calls()[0].params).toEqual([10, company_id]);
  });

  test('another company’s shift fails the same way a missing one does', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    // identical status and message either way, so this cannot be used to
    // probe which shift ids exist in other tenants
    await expect(resolveWindow(company_id, { date: '2026-08-06', shift_id: 555 }))
      .rejects.toMatchObject({ status: 404, message: 'Shift not found or access denied' });
  });

  test('a non-numeric shift_id is refused before any query runs', async () => {
    await expect(resolveWindow(company_id, { date: '2026-08-06', shift_id: 'abc' }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('scope', () => {

  test('binds company and window, and appends the machine when given', () => {
    const win = { from: 'F', to: 'T' };

    const all = scope(company_id, win, null);
    expect(all.sql).toBe('company_id = $1 AND hour_start >= $2 AND hour_start < $3');
    expect(all.params).toEqual([company_id, 'F', 'T']);

    const one = scope(company_id, win, 7);
    expect(one.sql).toMatch(/AND machine_id = \$4$/);
    expect(one.params).toEqual([company_id, 'F', 'T', 7]);
  });

  test('honours a starting placeholder offset', () => {
    const s = scope(company_id, { from: 'F', to: 'T' }, 7, 2);
    expect(s.sql).toBe('company_id = $2 AND hour_start >= $3 AND hour_start < $4 AND machine_id = $5');
  });
});
