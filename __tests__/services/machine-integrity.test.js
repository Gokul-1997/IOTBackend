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
  await svc.createMachine(req({ line_id: 8, ip_address: 'ignored', program_path: '//CNC_MEM/USER/PATH1/' }));
  const calls = mockDb.calls();
  expect(calls[1].text).toMatch(/companies.*FOR UPDATE/);
  const insert = calls.find(call => /INSERT INTO machines/.test(call.text));
  expect(insert.params.slice(0, 4)).toEqual([5, 4, 8, 'VMC-7']);
  expect(insert.text).not.toMatch(/ip_address/);                        // the IP comes from telemetry, never the form
  expect(insert.params.at(-1)).toBe('//CNC_MEM/USER/PATH1/');             // the program path, for the gateway (23 Oct 2026)
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
test('the edit API cannot set the IP (telemetry gives it)', async () => {
  await expect(svc.updateMachine({ ...req(), body: { ip_address: '1.2.3.4' } })).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls()).toHaveLength(0);
});

/* 23 Oct 2026, the user: "the machine's program path, from the Machines page, in the gateway's status".
   The gateway writes programs there and reads backups from there: the path holds only what a path needs,
   and never climbs out of itself. */
test('the program path: a plain path is saved; anything a path does not need is refused before anything is written', async () => {
  for (const [path, message] of [
    ['//CNC_MEM/USER/../../etc', /cannot contain "\.\."/], ['C:\\DNC\\..\\Windows', /cannot contain "\.\."/],
    ['/programs; rm -rf /', /letters, digits, spaces and/], ['/programs\nX', /letters, digits, spaces and/],
    ['$(id)', /letters, digits, spaces and/], ['/p'.repeat(130), /at most 255 characters/]
  ]) {
    await expect(svc.updateMachine({ ...req(), body: { program_path: path } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
  }
  expect(mockDb.calls()).toHaveLength(0);
  mockDb.queueResponse(response([{ id: 7, machine_serial_no: 'VMC-7', program_path: '//CNC_MEM/USER/PATH1/', ip_address: '10.0.0.9' }]));
  const saved = await svc.updateMachine({ ...req(), body: { program_path: '  //CNC_MEM/USER/PATH1/  ' } });
  expect(mockDb.calls()[0].params[0]).toBe('//CNC_MEM/USER/PATH1/');
  expect(saved).toMatchObject({ program_path: '//CNC_MEM/USER/PATH1/' });
  expect(saved).not.toHaveProperty('ip_address');
  resetDb();
  mockDb.queueResponse(response([{ id: 7, program_path: null }]));
  await svc.updateMachine({ ...req(), body: { program_path: '' } });          // emptied: not set
  expect(mockDb.calls()[0].params[0]).toBeNull();
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

const imageName = '859963eb-8a1c-49ec-89a0-076f25b141cb.png';
const imageUrl = company => `/api/files/companies/${company}/images/machines/${imageName}`;
test('machine creation cannot attach another company\'s local image', async () => {
  begin(); mockDb.queueResponse(response([{ id: 5 }]));
  await expect(svc.createMachine(req({ plant_id: 5, image_url: imageUrl(6) }))).rejects.toMatchObject({ status: 404 });
  expect(mockDb.calls().some(call => /INSERT INTO machines/.test(call.text))).toBe(false);
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
});
test('image-only machine edits also validate ownership before writing', async () => {
  mockDb.queueResponse(response(), response([{ id: 7, plant_id: 5, image_url: null }]));
  await expect(svc.updateMachine(req({ image_url: imageUrl(6) }))).rejects.toMatchObject({ status: 404 });
  expect(mockDb.calls().some(call => /UPDATE machines/.test(call.text))).toBe(false);
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
});
test('machine edits cannot attach a fresh local image from a different plant', async () => {
  mockDb.queueResponse(response(), response([{ id: 7, plant_id: 5, image_url: null }]),
    response([{ company_id: 4, plant_id: 6, filename: imageName,
      storage_key: `company-4/images/machines/${imageName}`, mime_type: 'image/png' }]));
  await expect(svc.updateMachine(req({ image_url: imageUrl(4) }))).rejects.toMatchObject({ status: 400, code: 'IMAGE_PLANT_MISMATCH' });
  expect(mockDb.calls().some(call => /UPDATE machines/.test(call.text))).toBe(false);
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
});
test('an ordinary machine edit can preserve its existing legacy image URL', async () => {
  const legacy = 'https://legacy-bucket.s3.example.com/images/old.png';
  mockDb.queueResponse(response(), response([{ id: 7, plant_id: 5, image_url: legacy }]),
    response([{ id: 7, plant_id: 5, image_url: legacy }]), response());
  await svc.updateMachine(req({ image_url: legacy }));
  expect(mockDb.calls().find(call => /UPDATE machines/.test(call.text)).params).toContain(legacy);
  expect(mockDb.calls().at(-1).text).toBe('COMMIT');
});
