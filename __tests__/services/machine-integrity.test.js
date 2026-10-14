jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/machines/machine.service');
const response = (rows = []) => ({ rows, rowCount: rows.length });
const req = (body = {}, user = {}) => ({ body: { machine_serial_no: 'VMC-7', ...body }, user: { company_id: 4, plant_id: null, ...user }, params: { id: 7 }, query: {} });
beforeEach(() => resetDb());
function begin() { mockDb.queueResponse(response(), response([{ id: 4 }]), response([{ max_machines: 2 }]), response([{ n: 0 }])); }
test('quota, owned placement and shift links commit together under the company lock', async () => {
  begin();
  mockDb.queueResponse(response([{ id: 8, plant_id: 5 }]), response([{ id: 5 }]), response([{ id: 7, plant_id: 5 }]), response(), response());
  await svc.createMachine(req({ line_id: 8, ip_address: 'ignored', program_path: '/ignored' }));
  const calls = mockDb.calls();
  expect(calls[1].text).toMatch(/companies.*FOR UPDATE/);
  const insert = calls.find(call => /INSERT INTO machines/.test(call.text));
  expect(insert.params.slice(0, 4)).toEqual([5, 4, 8, 'VMC-7']);
  expect(insert.text).not.toMatch(/ip_address|program_path/);
  expect(calls.find(call => /INSERT INTO machine_shift_config/.test(call.text)).params).toEqual([5, 7, 4]);
  expect(calls.at(-1).text).toBe('COMMIT');
});
test('quota exhaustion rolls back before placement and insertion', async () => {
  mockDb.queueResponse(response(), response([{ id: 4 }]), response([{ max_machines: 2 }]), response([{ n: 2 }]));
  await expect(svc.createMachine(req({ plant_id: 5 }))).rejects.toMatchObject({ status: 402 });
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  expect(mockDb.calls().some(call => /INSERT/.test(call.text))).toBe(false);
});
test('foreign line is rejected before a machine write', async () => {
  begin(); mockDb.queueResponse(response());
  await expect(svc.createMachine(req({ line_id: 99 }))).rejects.toMatchObject({ status: 404 });
  expect(mockDb.calls()[4].params).toEqual([99, 4]);
  expect(mockDb.calls().some(call => /INSERT/.test(call.text))).toBe(false);
});
test('multiple plants require an explicit choice', async () => {
  begin(); mockDb.queueResponse(response([{ id: 5 }, { id: 6 }]));
  await expect(svc.createMachine(req())).rejects.toMatchObject({ status: 400, message: /Choose a plant/ });
});
test('an explicit plant must match the selected known line', async () => {
  begin(); mockDb.queueResponse(response([{ id: 8, plant_id: 6 }]));
  await expect(svc.createMachine(req({ line_id: 8, plant_id: 5 }))).rejects.toMatchObject({ status: 400 });
});
test('plant-bound users cannot create machines for another plant', async () => {
  begin();
  await expect(svc.createMachine(req({ plant_id: 6 }, { plant_id: 5 }))).rejects.toMatchObject({ status: 403 });
});
test('failed shift linking rolls back the machine too', async () => {
  begin(); mockDb.queueResponse(response([{ id: 5 }]), response([{ id: 7 }]));
  mockDb.queueError(new Error('shift link failed'));
  await expect(svc.createMachine(req({ plant_id: 5 }))).rejects.toThrow('shift link failed');
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
});
test('machine list clamps page size and keeps a plant-bound user in their own plant', async () => {
  mockDb.queueResponse(response(), response([{ total: 0 }]));
  await svc.getMachines({ ...req({}, { plant_id: 5 }), query: { plant_id: 6, limit: 100000 } });
  expect(mockDb.calls()[0].params).toEqual([4, 5, 100, 0]);
  for (const call of mockDb.calls()) expect(call.text).toMatch(/m.plant_id = \$2/);
});
test('the generic edit API cannot set transfer settings', async () => {
  await expect(svc.updateMachine({ ...req(), body: { ip_address: '1.2.3.4', program_path: '/programs' } })).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});
test('moving plants removes incompatible shifts and attaches the new timetable in the placement transaction', async () => {
  mockDb.queueResponse(response(), response([{ id: 7, plant_id: 5, line_id: 8 }]), response([{ id: 6 }]),
    response([{ id: 7, plant_id: 6, line_id: null }]), response(), response(), response(), response());
  await svc.updateMachine(req({ plant_id: 6, line_id: null }));
  const calls = mockDb.calls();
  expect(calls[4].text).toMatch(/DELETE FROM machine_shift_config/);
  expect(calls[4].params).toEqual([7, 4, 6]);
  expect(calls[5].text).toMatch(/INSERT INTO machine_shift_config/);
  expect(calls[5].params).toEqual([6, 7, 4]);
  expect(calls[6].params).toEqual([6, 7]);
  expect(calls.at(-1).text).toBe('COMMIT');
});
