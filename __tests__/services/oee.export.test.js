/*
 * The machine-wise OEE summary (Reports → Machine OEE) is exported as Excel
 * or CSV. Its PDF was removed (2026-10-14): asking for one is refused before
 * anything is read.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const ctrl = require('../../src/dashboard/dashboard.controller');

const res = () => {
  const r = { headers: {} };
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  r.send = jest.fn(() => r);
  r.type = jest.fn(() => r);
  r.setHeader = jest.fn((k, v) => { r.headers[k] = v; return r; });
  return r;
};
const req = format => ({ params: { format }, query: {}, user: { company_id: 4 } });

beforeEach(() => resetDb());

test.each(['pdf', 'PDF', 'docx', ''])('%p is refused, before anything is read', async (format) => {
  const r = res();
  await ctrl.exportOee(req(format), r);
  expect(r.status).toHaveBeenCalledWith(400);
  expect(r.json).toHaveBeenCalledWith({ status: 'error', message: 'format must be xlsx or csv' });
  expect(mockDb.calls()).toHaveLength(0);
});

test('CSV still exports', async () => {
  const r = res();
  await ctrl.exportOee(req('csv'), r);
  // no machines in the mocked data: the usual "none match" answer, after the query
  expect(mockDb.calls().length).toBeGreaterThan(0);
  expect(r.status).toHaveBeenCalledWith(404);
});
