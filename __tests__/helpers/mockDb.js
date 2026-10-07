/*
 * Lightweight mock for src/db.js (a pg.Pool instance).
 * Tests register expected queries (or a script of responses) and assert what
 * the service called. No real PostgreSQL needed.
 *
 * Usage:
 *   const { mockDb, resetDb } = require('../helpers/mockDb');
 *   jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
 *   beforeEach(() => resetDb());
 *   mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
 */

const responseQueue = [];
const calls = [];

/*
 * Advisory locks are infrastructure, not behaviour under test. Program
 * transfers take one per machine to keep two sessions off a controller's
 * single-session FTP server, which puts a pg_try_advisory_lock and a
 * matching unlock around every transfer. Letting those consume queued
 * responses would mean every existing test had to queue two extra rows
 * in the right order to describe something none of them are asserting.
 *
 * They are answered here instead, granted by default. A test that cares
 * about contention calls `denyAdvisoryLock()` to make the next attempt
 * fail, which is how the "machine busy" case is exercised.
 */
const ADVISORY_LOCK = /pg_(try_)?advisory_(unlock|lock)/i;
let grantLock = true;

/*
 * The company-ownership check (src/lib/tenant.js) is infrastructure in the
 * same sense: nearly every write now asks it first. It is answered here as
 * "every id belongs to the caller" unless a test calls `denyOwnership()`, and
 * it is kept out of calls() so positional assertions do not shift.
 */
const OWNERSHIP = /^\s*SELECT 0 AS k, count\(\*\)::int AS n FROM/;
let ownershipDenied = false;
const ownershipCalls = [];

const mockDb = {
  query: jest.fn(async (text, params) => {
    const sql = typeof text === 'string' ? text : text.text;
    calls.push({ text: sql, params });

    if (OWNERSHIP.test(sql)) {
      calls.pop();
      ownershipCalls.push({ text: sql, params });
      const denied = ownershipDenied;
      ownershipDenied = false;     // denial applies to one check only
      const rows = (params || []).slice(1).map((ids, k) => ({ k, n: denied ? 0 : ids.length }));
      return { rows, rowCount: rows.length };
    }

    if (ADVISORY_LOCK.test(sql)) {
      const locked = grantLock;
      grantLock = true;            // denial applies to one attempt only
      return { rows: [{ locked }], rowCount: 1 };
    }

    if (responseQueue.length === 0) {
      return { rows: [], rowCount: 0 };
    }
    const next = responseQueue.shift();
    if (next instanceof Error) throw next;
    return next;
  }),

  // Transaction client (for db.connect())
  connect: jest.fn(async () => ({
    query: mockDb.query,
    release: jest.fn()
  })),

  // Helpers used by tests
  queueResponse: (...responses) => {
    responses.forEach(r => responseQueue.push(r));
  },
  queueError: (err) => {
    responseQueue.push(err);
  },
  /** Make the next pg_try_advisory_lock report the machine already busy. */
  denyAdvisoryLock: () => { grantLock = false; },
  /** Make the next ownership check find the ids in another company. */
  denyOwnership: () => { ownershipDenied = true; },
  /** The ownership checks made, with their parameters ([company_id, ids…]). */
  ownershipChecks: () => [...ownershipCalls],
  reset: () => {
    responseQueue.length = 0;
    calls.length = 0;
    grantLock = true;
    ownershipDenied = false;
    ownershipCalls.length = 0;
    mockDb.query.mockClear();
    mockDb.connect.mockClear();
  },
  /*
   * The queries under test, with the advisory-lock bookkeeping filtered
   * out. Tests index this positionally (`calls()[2]` is the insert), so
   * leaking two infrastructure queries into it would shift every
   * assertion in the suite for a lock none of them are about.
   */
  calls: () => calls.filter(c => !ADVISORY_LOCK.test(c.text)),

  /** Everything, locks included — for tests that assert the locking itself. */
  allCalls: () => [...calls]
};

function resetDb() {
  mockDb.reset();
}

module.exports = { mockDb, resetDb };
