jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const machines = require('../../src/machines/machine.service');
const placement = require('../../src/lib/machine-placement');
const row = (patch = {}) => ({ id: 7, company_id: 4, plant_id: 5, line_id: null, is_active: true, ...patch });
const response = (rows = []) => ({ rows, rowCount: rows.length });
const payload = { machine_id: 7, company_id: 4, plant_id: 5 };
const req = body => ({ body, params: { id: 7 }, user: { company_id: 4, plant_id: null } });
beforeEach(async () => {
  resetDb();
  await placement.load({ query: async () => response([row()]) });
});

test('a committed machine placement edit closes the old route and refreshes from the database', async () => {
  mockDb.queueResponse(response(), response([row()]), response([{ id: 6 }]),
    response([row({ plant_id: 6 })]), response(), response(), response(), response(), response([row({ plant_id: 6 })]));
  const edit = machines.updateMachine(req({ plant_id: 6, line_id: null }));
  expect(placement.resolve(payload)).toBeNull();
  await edit;
  expect(placement.resolve(payload).plant_id).toBe(6);
  expect(mockDb.calls().at(-1)).toEqual({
    text: 'SELECT id, company_id, plant_id, is_active FROM machines WHERE id = $1', params: [7]
  });
});

test('a failed edit restores only the previously committed placement after rollback', async () => {
  mockDb.queueResponse(response(), response([row()]), response([{ id: 6 }]));
  mockDb.queueError(new Error('update failed'));
  mockDb.queueResponse(response(), response([row()]));
  await expect(machines.updateMachine(req({ plant_id: 6, line_id: null }))).rejects.toThrow('update failed');
  expect(placement.resolve(payload).plant_id).toBe(5);
  expect(mockDb.calls().at(-2).text).toBe('ROLLBACK');
});

test('deactivation closes the live route, and activation reopens its current placement', async () => {
  mockDb.queueResponse(response(), response([{ id: 4 }]), response([row()]), response(), response(), response([row({ is_active: false })]));
  await machines.toggleMachineStatus(req({}));
  expect(placement.resolve(payload)).toBeNull();
  mockDb.queueResponse(response(), response([{ id: 4 }]), response([row({ is_active: false })]), response([{ max_machines: 2 }]),
    response([{ n: 0 }]), response(), response(), response([row()]));
  await machines.toggleMachineStatus(req({}));
  expect(placement.resolve(payload).plant_id).toBe(5);
});

test('deletion removes the route and failed deletion restores the current row', async () => {
  mockDb.queueResponse(response([row()]), response());
  await machines.deleteMachine(req({}));
  expect(placement.resolve(payload)).toBeNull();
  placement.upsert(row());
  mockDb.queueError(new Error('referenced'));
  mockDb.queueResponse(response([row()]));
  await expect(machines.deleteMachine(req({}))).rejects.toThrow('referenced');
  expect(placement.resolve(payload).plant_id).toBe(5);
});

test('creation registers the new machine only after its machine and shift transaction commits', async () => {
  placement.remove(7);
  mockDb.queueResponse(response(), response([{ id: 4 }]), response([{ max_machines: 2 }]), response([{ n: 0 }]),
    response([{ id: 5 }]), response([row()]), response(), response(), response([row()]));
  const created = await machines.createMachine(req({ machine_serial_no: 'CNC-7', plant_id: 5 }));
  expect(created.id).toBe(7);
  expect(placement.resolve(payload).plant_id).toBe(5);
  expect(mockDb.calls().at(-2).text).toBe('COMMIT');
});
