/*
 * Program Transfer, the people's side: uploads into a machine's folder,
 * jobs for its device, and device tokens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-svc-'));
process.env.PROGRAM_TRANSFER_DIR = path.join(TMP, 'ProgramTransfer');

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/programs/program.service');
const storage = require('../../src/programs/storage');
const deviceToken = require('../../src/programs/device-token');

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => resetDb());

const one = row => ({ rows: [row], rowCount: 1 });
const none = { rows: [], rowCount: 0 };
const machine7 = { id: 7, company_id: 5, machine_serial_no: 'VMC-1', ip_address: '192.168.200.3' };
const machine8 = { id: 8, company_id: 5, machine_serial_no: 'VMC-2', ip_address: '192.168.200.4' };
const program = Buffer.from('%\nO1234\nG0 X0\nM30\n%\n');

const user = (perms = ['page:programs:view', 'page:programs:upload', 'page:programs:transfer', 'page:programs:fetch', 'page:programs:delete']) =>
  ({ id: 2, username: 'Priya', company_id: 5, permissions: perms });
const req = (o = {}) => ({ user: user(), params: {}, query: {}, body: {}, headers: {}, ip: '10.0.0.5', ...o });
const jobRow = (o = {}) => ({ id: '11', company_id: 5, machine_id: 7, machine_serial: 'VMC-1', action: 'SEND', program_name: 'O1234.nc',
  status: 'QUEUED', requested_by: 2, file_stored_name: null, backup_stored_name: null, ...o });

const folderFiles = m => {
  const dir = path.join(storage.ROOT, storage.machineFolder(m));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('uploading a program', () => {
  const upload = (body, perms) => req({
    user: user(perms), body: { machine_id: '7', ...body },
    file: { originalname: 'O1234.nc', buffer: program }
  });

  test('send without the transfer permission is refused before anything is written', async () => {
    await expect(svc.uploadFile(upload({ send: 'true' }, ['page:programs:upload'])))
      .rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('already on the controller: 409 FILE_EXISTS, and no file is left behind', async () => {
    mockDb.queueResponse(one(machine7), none, one({ files: [{ name: 'O1234' }] }));
    await expect(svc.uploadFile(upload({ send: 'true' })))
      .rejects.toMatchObject({ status: 409, code: 'FILE_EXISTS', names: ['O1234.nc'] });
    expect(folderFiles(machine7)).toEqual([]);
  });

  test('already waiting to be sent: 409 DUPLICATE_JOB', async () => {
    mockDb.queueResponse(one(machine7), one({ program_name: 'o1234' }));
    await expect(svc.uploadFile(upload({ send: 'true', overwrite: 'true' })))
      .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_JOB' });
  });

  test('upload and send: the file is kept as NEW and a SEND job is queued for the device', async () => {
    mockDb.queueResponse(
      one(machine7), none, none,
      one({ id: '40', machine_id: 7, folder: 'company-5/192.168.200.3', stored_name: 'x', program_name: 'O1234.nc', kind: 'NEW' }),
      one({ id: '11' }), one(jobRow())
    );
    const r = await svc.uploadFile(upload({ send: 'true', overwrite: 'false', note: 'rev C' }));
    expect(r.job).toMatchObject({ id: '11', action: 'SEND', status: 'QUEUED' });
    expect(folderFiles(machine7)).toEqual([expect.stringMatching(/^\d{8}-\d{6}_NEW_O1234\.nc$/)]);
    const job = mockDb.calls().find(c => /INSERT INTO program_jobs/.test(c.text));
    expect(job.params).toEqual([5, 7, 'VMC-1', 'SEND', 'O1234.nc', '40', false, 2]);
  });
});

describe('jobs', () => {
  test('FETCH needs the fetch permission', async () => {
    await expect(svc.createJobs(req({ user: user(['page:programs:view']), body: { action: 'FETCH', machine_id: 7, program_names: ['O1'] } })))
      .rejects.toMatchObject({ status: 403 });
  });

  test('a program sent to another machine is copied into that machine\'s folder first', async () => {
    const saved = await storage.save({ machine: machine7, kind: 'NEW', programName: 'O2001.nc', buffer: program });
    mockDb.queueResponse(
      one({ id: '50', company_id: 5, machine_id: 7, folder: saved.folder, stored_name: saved.storedName, program_name: 'O2001.nc', kind: 'NEW' }),
      one(machine8), none, none,
      one({ id: '51', machine_id: 8, folder: 'company-5/192.168.200.4', stored_name: 'y', program_name: 'O2001.nc', kind: 'NEW' }),
      one({ id: '12' }), one(jobRow({ id: '12', machine_id: 8, program_name: 'O2001.nc' }))
    );
    const r = await svc.createJobs(req({ body: { action: 'SEND', file_ids: [50], machine_ids: [8] } }));
    expect(r.jobs).toHaveLength(1);
    expect(folderFiles(machine8)).toEqual([expect.stringMatching(/_NEW_O2001\.nc$/)]);
    const job = mockDb.calls().find(c => /INSERT INTO program_jobs/.test(c.text));
    expect(job.params.slice(1, 6)).toEqual([8, 'VMC-2', 'SEND', 'O2001.nc', '51']);
  });

  test('one refusal queues nothing', async () => {
    mockDb.queueResponse(
      one({ id: '50', company_id: 5, machine_id: 7, folder: 'f', stored_name: 's', program_name: 'O2001.nc' }),
      one(machine7), one(machine8),
      none, none,                                  // VMC-1: free
      none, one({ files: [{ name: 'O2001.nc' }] }) // VMC-2: already there
    );
    await expect(svc.createJobs(req({ body: { action: 'SEND', file_ids: [50], machine_ids: [7, 8] } })))
      .rejects.toMatchObject({ code: 'FILE_EXISTS', names: ['O2001.nc on VMC-2'] });
    expect(mockDb.calls().some(c => /INSERT INTO program_jobs/.test(c.text))).toBe(false);
  });

  test('a job the device already took cannot be cancelled', async () => {
    mockDb.queueResponse(one(jobRow({ status: 'DELIVERED' })));
    await expect(svc.cancelJob(req({ params: { id: '11' } })))
      .rejects.toMatchObject({ status: 409, message: /already taken/ });
  });

  test("another company's job is not found", async () => {
    mockDb.queueResponse(one(jobRow({ company_id: 6 })));
    await expect(svc.cancelJob(req({ params: { id: '11' } }))).rejects.toMatchObject({ status: 404 });
  });
});

test('a file waiting to be sent cannot be deleted', async () => {
  mockDb.queueResponse(one({ id: '40', company_id: 5, folder: 'f', stored_name: 's' }), one({ id: '11' }));
  await expect(svc.deleteFile(req({ params: { id: '40' } }))).rejects.toMatchObject({ status: 409, code: 'IN_USE' });
});

describe('device tokens', () => {
  test('a new token replaces the old one; only its hash and prefix are stored or logged', async () => {
    mockDb.queueResponse(
      one(machine7),
      {},                                                       // BEGIN
      { rows: [], rowCount: 1 },                                // revoke the old token
      one({ id: 9, machine_id: 7, label: null, token_prefix: 'mxd_abcdefgh', created_at: 'now' }),
      {}                                                        // COMMIT
    );
    const r = await svc.createDeviceToken(req({ params: { machineId: '7' } }));
    expect(r.token).toMatch(deviceToken.SHAPE);
    expect(r.device.folder).toBe('company-5/192.168.200.3');

    const calls = mockDb.calls();
    expect(calls.find(c => /UPDATE program_devices SET revoked_at/.test(c.text)).params).toEqual([7, 2]);
    const ins = calls.find(c => /INSERT INTO program_devices/.test(c.text));
    expect(ins.params).toContain(deviceToken.hash(r.token));
    expect(ins.params).not.toContain(r.token);
    const auditCall = calls.find(c => /INSERT INTO audit_logs/.test(c.text));
    expect(JSON.stringify(auditCall.params)).not.toContain(r.token);
  });

  test('revoking a machine without a token: 404', async () => {
    mockDb.queueResponse(one(machine7), none);
    await expect(svc.revokeDeviceToken(req({ params: { machineId: '7' } }))).rejects.toMatchObject({ status: 404 });
  });
});

test('"O1234.nc" and "o1234" are the same program to a controller', () => {
  expect(svc._internal.sameProgram('O1234.nc', 'o1234')).toBe(true);
  expect(svc._internal.sameProgram('O1234.nc', 'O12345')).toBe(false);
});
