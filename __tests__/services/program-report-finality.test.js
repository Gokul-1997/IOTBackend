jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const service = require('../../src/programs/program.service');
const gateway = { company_id: 5, company_name: 'Fixture' };
beforeEach(resetDb);
test.each([
  ['DONE', null, 'FAILED', 'late network error'],
  ['FAILED', 'CNC full', 'DONE', null],
  ['FAILED', 'CNC full', 'FAILED', 'different result'],
  ['SKIPPED', null, 'DONE', null],
])('a final %s result cannot be changed to %s by a delayed report', async (oldStatus, oldMessage, status, message) => {
  mockDb.queueResponse({ rows: [] }, { rows: [{ id: 42, kind: 'NEW', machine_id: 7, machine_serial_no: 'VMC-1', delivery_status: oldStatus, delivery_message: oldMessage }] });
  await expect(service.gatewayReport(gateway, { file_id: 42, status, message })).rejects.toMatchObject({ status: 409, code: 'REPORT_CONFLICT' });
  expect(mockDb.calls()[0].text).toMatch(/f\.delivery_status IS NULL/);
  expect(mockDb.calls().some(call => /INSERT INTO notifications/.test(call.text))).toBe(false);
});
test('an exact terminal retry is idempotent and does not announce another notification', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [{ id: 42, kind: 'NEW', machine_id: 7, machine_serial_no: 'VMC-1', delivery_status: 'FAILED', delivery_message: 'CNC full' }] }, { rows: [] });
  await expect(service.gatewayReport(gateway, { file_id: 42, status: 'FAILED', message: 'CNC full' })).resolves.toMatchObject({ unchanged: true, status: 'FAILED' });
  expect(mockDb.calls().some(call => /INSERT INTO notifications/.test(call.text))).toBe(false);
});
