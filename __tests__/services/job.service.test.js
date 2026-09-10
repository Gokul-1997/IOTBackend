/*
 * Unit tests for job/job.service — the paginated job lists.
 *
 * getJobHistory used to be a bare `LIMIT 200` with no offset and no total:
 * past 200 jobs the older ones were unreachable, and no client could have
 * paged to them because the count was never returned.
 *
 * The ordering tests matter as much as the paging ones. `ORDER BY started_at
 * DESC` alone is not a total order — production has 11 jobs sharing a single
 * timestamp — so without a tiebreaker the same row can appear on two pages
 * while another is skipped entirely.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/job/job.service');

const company_id = 4;

/** getCurrentJobs/getJobHistory fire the data and count queries together. */
const queue = (rows, total) => mockDb.queueResponse(
  { rows, rowCount: rows.length },
  { rows: [{ total }], rowCount: 1 }
);

beforeEach(() => resetDb());

describe('job.service.getJobHistory', () => {

  test('without page/limit returns every row, and data stays an array', async () => {
    queue([{ job_id: 1 }, { job_id: 2 }], 2);

    const res = await svc.getJobHistory(company_id);

    // Existing callers do `res.data.map(...)` — this must not become an object.
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.totalPages).toBe(1);

    // no LIMIT/OFFSET appended, and only the company is bound
    const dataCall = mockDb.calls()[0];
    expect(dataCall.text).not.toMatch(/LIMIT/);
    expect(dataCall.params).toEqual([company_id]);
  });

  test('the old hard-coded LIMIT 200 is gone', async () => {
    queue([], 0);
    await svc.getJobHistory(company_id);
    expect(mockDb.calls()[0].text).not.toMatch(/LIMIT 200/);
  });

  test('page/limit become LIMIT and OFFSET', async () => {
    queue([{ job_id: 11 }], 50);

    const res = await svc.getJobHistory(company_id, { page: 3, limit: 5 });

    const dataCall = mockDb.calls()[0];
    expect(dataCall.text).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(dataCall.params).toEqual([company_id, 5, 10]); // page 3 → skip 10
    expect(res).toMatchObject({ total: 50, page: 3, limit: 5, totalPages: 10 });
  });

  test('orders by a total key so a row cannot land on two pages', async () => {
    queue([], 0);
    await svc.getJobHistory(company_id, { page: 1, limit: 5 });

    // started_at alone is not unique in real data; id breaks the tie.
    expect(mockDb.calls()[0].text).toMatch(/ORDER BY j\.started_at DESC, j\.id DESC/);
  });

  test('counts the whole set, not just the page', async () => {
    queue([{ job_id: 1 }], 50);
    await svc.getJobHistory(company_id, { page: 2, limit: 5 });

    const countCall = mockDb.calls()[1];
    expect(countCall.text).toMatch(/COUNT\(\*\)/);
    expect(countCall.text).not.toMatch(/LIMIT/);
    expect(countCall.params).toEqual([company_id]);
  });

  test('clamps a limit that would pull the table into memory', async () => {
    queue([], 0);
    await svc.getJobHistory(company_id, { page: 1, limit: 100000 });
    expect(mockDb.calls()[0].params[1]).toBe(200);
  });

  test('rejects nonsense paging rather than producing a negative OFFSET', async () => {
    queue([], 0);
    const res = await svc.getJobHistory(company_id, { page: -5, limit: 0 });

    expect(res.page).toBe(1);
    expect(mockDb.calls()[0].params[2]).toBe(0); // OFFSET never negative
  });

  test('is always scoped to the caller’s company', async () => {
    queue([], 0);
    await svc.getJobHistory(company_id, { page: 1, limit: 10 });

    mockDb.calls().forEach(c => {
      expect(c.text).toMatch(/m\.company_id = \$1/);
      expect(c.params[0]).toBe(company_id);
    });
  });
});

describe('job.service.getCurrentJobs', () => {

  test('returns only active jobs on active machines', async () => {
    queue([{ job_id: 1 }], 1);
    await svc.getCurrentJobs(company_id);

    const sql = mockDb.calls()[0].text;
    expect(sql).toMatch(/m\.is_active = TRUE/);
    expect(sql).toMatch(/j\.is_active = TRUE/);
  });

  test('paginates on the same terms as the history', async () => {
    queue([{ job_id: 1 }], 12);

    const res = await svc.getCurrentJobs(company_id, { page: 2, limit: 5 });

    expect(mockDb.calls()[0].params).toEqual([company_id, 5, 5]);
    expect(res).toMatchObject({ total: 12, page: 2, limit: 5, totalPages: 3 });
  });

  test('the count respects the active filters too', async () => {
    queue([], 0);
    await svc.getCurrentJobs(company_id, { page: 1, limit: 5 });

    // a count over all jobs would make totalPages disagree with the rows shown
    expect(mockDb.calls()[1].text).toMatch(/j\.is_active = TRUE/);
  });
});
