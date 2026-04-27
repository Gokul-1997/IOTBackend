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

const mockDb = {
  query: jest.fn(async (text, params) => {
    calls.push({ text: typeof text === 'string' ? text : text.text, params });
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
  reset: () => {
    responseQueue.length = 0;
    calls.length = 0;
    mockDb.query.mockClear();
    mockDb.connect.mockClear();
  },
  calls: () => [...calls]
};

function resetDb() {
  mockDb.reset();
}

module.exports = { mockDb, resetDb };
