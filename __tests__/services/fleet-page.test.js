jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { parseFleetPage, fleetPage } = require('../../src/dashboard/fleet-page');
const service = require('../../src/dashboard/dashboard.service');

beforeEach(resetDb);
test('old clients keep their full response; new clients opt in explicitly', () => {
  expect(parseFleetPage({ page: '1', per_page: '6' })).toBeNull();
  expect(parseFleetPage({ paged: '1' })).toEqual({ page: 1, perPage: 25, status: 'all', search: '' });
});
test.each([
  { paged: 'true' }, { paged: '1', per_page: '101' }, { paged: '1', page: '-1' },
  { paged: '1', page: '1.5' }, { paged: '1', status: 'unknown' },
  { paged: '1', search: ['a'] }, { paged: '1', search: 'x'.repeat(101) }
])('rejects unbounded or malformed page options %j', query => {
  expect(() => parseFleetPage(query)).toThrow(expect.objectContaining({ status: 400 }));
});
test('only the authenticated company is queried; search is a parameter', async () => {
  mockDb.queueResponse({ rows: [{ machines: [], summary: { total: 50 }, total: 0 }] });
  const options = parseFleetPage({ paged: '1', page: '2', per_page: '25', search: "%' OR TRUE --" });
  const data = await fleetPage(4, options);
  expect(mockDb.calls()[0].params).toEqual([4, 25, 25, 'all', "%' OR TRUE --"]);
  expect(data.summary.total).toBe(50);
  expect(data.pagination).toEqual({ page: 2, per_page: 25, total: 0, total_pages: 1 });
});
test('an account without a company cannot enumerate machines', async () => {
  await expect(fleetPage(null, parseFleetPage({ paged: '1' }))).rejects.toMatchObject({ status: 403 });
  expect(mockDb.calls()).toHaveLength(0);
});
test('production and job calculations use only page IDs; summary covers the company', async () => {
  mockDb.queueResponse(
    { rows: [{ id: 1, shift_code: 'DAY', start_time: '00:00:00', end_time: '23:59:59', break_minutes: 0 }] },
    { rows: [{ machines: [{ id: 7, machine_serial_no: 'M7', machine_status: 'RUNNING', alarm: false, received_at: new Date() }],
      summary: { total: 5000, running: 4000, idle: 1000, alarm: 5, offline: 0 }, total: 5000 }] },
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }
  );
  const data = await service.dashboard(null, 4, parseFleetPage({ paged: '1', per_page: '1' }));
  expect(data.machines.map(m => m.machine_id)).toEqual([7]);
  expect(data.summary.total).toBe(5000);
  expect(data.pagination.total_pages).toBe(5000);
  const production = mockDb.calls().find(c => /FROM production_hourly/.test(c.text));
  expect(production.params[0]).toEqual([7]);
  expect(mockDb.calls().filter(c => /FROM telemetry_raw/.test(c.text))).toHaveLength(1);
});
