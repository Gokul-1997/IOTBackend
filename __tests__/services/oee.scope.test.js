/*
 * The Factory and Maintenance screens must scope oee_hourly through the
 * machine, not through oee_hourly.company_id.
 *
 * That column is NULL on 52,555 of the table's 52,559 production rows — the
 * hourly rollup job never wrote it. Filtering on it matched nothing, so both
 * screens reported OEE as 0% for every company on every day, while the OEE
 * dashboard (which computes from production_hourly) reported the real
 * figure for the same plant on the same day. Two screens contradicting each
 * other about the headline number is worse than either being absent.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { scope, scopeViaMachine } = require('../../src/dashboard/window');
const factorySvc = require('../../src/dashboard/factory.service');
const maintSvc   = require('../../src/dashboard/maintenance.service');

const win = { from: '2026-09-16T00:00:00+05:30', to: '2026-09-16T23:59:59.999+05:30', day: '2026-09-16', shift: null };
const req = (query = {}) => ({ user: { company_id: 4 }, query: { date: '2026-09-16', ...query } });

/** The query that reads oee_hourly, whichever position it sits in. */
const oeeQuery = () => mockDb.calls().find(c => /FROM oee_hourly/.test(c.text));

/*
 * These assert the SQL, not the mapping that follows it.
 *
 * factory.service fires its nine queries with Promise.all and then reads
 * prodRes.rows[0]; mockDb answers with no rows unless a test queues them, so
 * the mapping throws after every query has already been issued. Queueing
 * nine result sets in the right order would make these tests depend on the
 * order of an unrelated Promise.all — so the rejection is swallowed and the
 * captured queries are inspected instead. In production that branch cannot
 * be reached: the query is an aggregate with no GROUP BY, which always
 * returns exactly one row.
 */
const runCapturingSql = (fn, arg) => fn(arg).catch(() => {});

beforeEach(() => resetDb());

describe('scopeViaMachine', () => {
  test('filters on the machine\'s company, never on the row\'s own column', () => {
    const s = scopeViaMachine(4, win, null);
    expect(s.sql).toMatch(/m\.company_id = \$1/);
    expect(s.sql).not.toMatch(/(^|[^.])company_id = \$1/);   // not the bare column
    expect(s.params).toEqual([4, win.from, win.to]);
  });

  test('keeps the window bounded, so the hypertable can prune', () => {
    const s = scopeViaMachine(4, win, null);
    expect(s.sql).toMatch(/o\.hour_start >= \$2 AND o\.hour_start < \$3/);
  });

  test('a machine filter binds a fourth parameter', () => {
    const s = scopeViaMachine(4, win, 7);
    expect(s.sql).toMatch(/o\.machine_id = \$4/);
    expect(s.params).toEqual([4, win.from, win.to, 7]);
  });

  test('binds exactly the parameters it references, with and without a machine', () => {
    for (const machineId of [null, 7]) {
      const s = scopeViaMachine(4, win, machineId);
      const highest = Math.max(...[...s.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
      expect(s.params.length).toBe(highest);
    }
  });

  test('scope() is unchanged for the tables that do carry company_id', () => {
    // production_hourly is populated correctly; only oee_hourly is affected
    expect(scope(4, win, null).sql).toMatch(/^company_id = \$1/);
  });
});

/* Factory no longer reads oee_hourly at all. Averaging it read 0% — an hour
   with nothing made has no performance — while the OEE Dashboard showed the
   real figure for the same plant. Factory now uses that screen's own totals. */
describe('Factory dashboard', () => {
  const totalsQuery = () => mockDb.calls().find(c => /machine_current_job/.test(c.text) && /FROM production_hourly/.test(c.text));

  test('does not average oee_hourly', async () => {
    await runCapturingSql(factorySvc.getFactoryDashboard, req());
    expect(oeeQuery()).toBeUndefined();
  });

  test('uses the OEE Dashboard\'s machine totals, scoped to the company', async () => {
    await runCapturingSql(factorySvc.getFactoryDashboard, req());
    const q = totalsQuery();
    expect(q).toBeTruthy();
    expect(q.text).toMatch(/JOIN machines m ON m\.id = ph\.machine_id AND m\.company_id = \$1/);
    expect(q.params[0]).toBe(4);
  });

  test('a machine filter still reaches the OEE figures', async () => {
    await runCapturingSql(factorySvc.getFactoryDashboard, req({ machine_id: '7' }));
    expect(totalsQuery().params).toContain(7);
  });

  test('every query binds exactly the parameters it references', async () => {
    await runCapturingSql(factorySvc.getFactoryDashboard, req({ machine_id: '7' }));
    for (const q of mockDb.calls()) {
      const refs = [...q.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
      const highest = refs.length ? Math.max(...refs) : 0;
      expect(q.params ? q.params.length : 0).toBe(highest);
    }
  });
});

describe('Maintenance dashboard', () => {
  const totalsQuery = () => mockDb.calls().find(c => /machine_current_job/.test(c.text) && /FROM production_hourly/.test(c.text));

  test('does not average oee_hourly — it uses the OEE Dashboard\'s totals', async () => {
    await runCapturingSql(maintSvc.getMaintenanceDashboard, req({ machine_id: '7' }));
    expect(oeeQuery()).toBeUndefined();
    expect(totalsQuery().text).toMatch(/m\.company_id = \$1/);
    expect(totalsQuery().params).toContain(7);
  });

  test('every query binds exactly the parameters it references', async () => {
    await runCapturingSql(maintSvc.getMaintenanceDashboard, req({ machine_id: '7' }));
    for (const q of mockDb.calls()) {
      const refs = [...q.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
      const highest = refs.length ? Math.max(...refs) : 0;
      expect(q.params ? q.params.length : 0).toBe(highest);
    }
  });
});
