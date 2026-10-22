/*
 * Program Transfer, kept simple (21 Oct 2026): people upload a machine's
 * program, download files, ask for a backup; the machine's gateway reads
 * its status, downloads the program and posts backups. The database is the
 * mock; files go to a temporary storage folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-svc-'));
process.env.STORAGE_ROOT = path.join(TMP, 'storage');
process.env.PROGRAM_MAX_MB = '1';

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/audit/audit.service', () => ({ log: jest.fn(async () => {}) }));

const { mockDb, resetDb } = require('../helpers/mockDb');
const audit = require('../../src/audit/audit.service');
const svc = require('../../src/programs/program.service');
const storage = require('../../src/programs/storage');
const deviceToken = require('../../src/programs/device-token');

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => { resetDb(); audit.log.mockClear(); });

const one = row => ({ rows: [row], rowCount: 1 });
const none = { rows: [], rowCount: 0 };
const machine = { id: 7, company_id: 5, machine_serial_no: 'VMC-1' };
const user = { id: 2, company_id: 5, permissions: [] };
const req = (o = {}) => ({ user, params: {}, query: {}, body: {}, headers: {}, ip: '10.0.0.1', ...o });
let staged = 0;
function stage(text, name = 'O1001.nc') {
  const file = path.join(TMP, `staged-${++staged}`);
  fs.writeFileSync(file, text);
  return { path: file, originalname: name };
}
const sql = pattern => mockDb.calls().find(c => pattern.test(c.text));

describe('machines and files', () => {
  test('machines: the company only, each with its gateway, program, last backup and open request', async () => {
    mockDb.queueResponse({ rows: [
      { id: 7, machine_serial_no: 'VMC-1', token_prefix: 'mxd_abcdefgh', token_created_at: 'T0', last_seen_at: 'T1', online: true,
        program_id: '40', program_name: 'O1001.nc', program_size: 24, program_at: 'T2',
        backup_id: '41', backup_name: 'O1001.nc', backup_at: 'T3', request_id: '9', requested_at: 'T4' },
      { id: 8, machine_serial_no: 'VMC-2', token_prefix: null, program_id: null, backup_id: null, request_id: null }
    ], rowCount: 2 });
    const list = await svc.listMachines(req());
    const q = mockDb.calls()[0];
    expect(q.text).toMatch(/WHERE m\.company_id = \$1 AND m\.is_active = true/);
    expect(q.params).toEqual([5, 60, 30]);
    expect(list).toEqual([
      { id: 7, machine_serial_no: 'VMC-1',
        gateway: { token_prefix: 'mxd_abcdefgh', token_created_at: 'T0', last_seen_at: 'T1', online: true },
        program: { id: '40', program_name: 'O1001.nc', size_bytes: 24, created_at: 'T2',
                   delivery_status: null, delivery_message: null, delivered_at: null },
        last_backup: { id: '41', program_name: 'O1001.nc', created_at: 'T3' },
        backup_request: { id: '9', requested_at: 'T4' },
        backup_failure: null },
      { id: 8, machine_serial_no: 'VMC-2', gateway: null, program: null, last_backup: null, backup_request: null, backup_failure: null }
    ]);
  });

  test("what the gateway reported shows: the program on the machine, a backup it could not read", async () => {
    mockDb.queueResponse({ rows: [
      { id: 7, machine_serial_no: 'VMC-1', token_prefix: null, program_id: '40', program_name: 'O1001.nc', program_size: 24, program_at: 'T2',
        delivery_status: 'FAILED', delivery_message: 'CNC memory full', delivered_at: '2026-10-21T05:00:00Z',
        backup_id: '41', backup_name: 'O1001.nc', backup_at: '2026-10-21T04:00:00Z', request_id: null,
        backup_error: 'CNC not reachable', backup_failed_at: '2026-10-21T05:30:00Z' },
      // a backup arrived after the failure: the failure is old news
      { id: 8, machine_serial_no: 'VMC-2', token_prefix: null, program_id: null, backup_id: '50', backup_at: '2026-10-21T06:00:00Z',
        request_id: null, backup_error: 'CNC not reachable', backup_failed_at: '2026-10-21T05:30:00Z' }
    ], rowCount: 2 });
    const [failed, recovered] = await svc.listMachines(req());
    expect(failed.program).toMatchObject({ delivery_status: 'FAILED', delivery_message: 'CNC memory full' });
    expect(failed.backup_failure).toEqual({ message: 'CNC not reachable', at: '2026-10-21T05:30:00Z' });
    expect(recovered.backup_failure).toBeNull();
  });

  test("a plant user sees only their plant's machines", async () => {
    await svc.listMachines(req({ user: { ...user, plant_id: 3, authorization_plant_id: 3 } }));
    expect(mockDb.calls()[0].text).toMatch(/plant_id = 3/);
  });

  test("another company's machine is not found, and nothing is listed", async () => {
    mockDb.queueResponse(none);
    await expect(svc.listFiles(req({ query: { machine_id: '99' } }))).rejects.toMatchObject({ status: 404, code: 'MACHINE_NOT_FOUND' });
    expect(mockDb.calls()).toHaveLength(1);
    expect(mockDb.calls()[0].params).toEqual([99, 5]);
  });

  test('files: newest first, backups filter, the current program marked', async () => {
    mockDb.queueResponse(one(machine),
      { rows: [{ id: '41', kind: 'BACKUP' }, { id: '40', kind: 'BACKUP' }], rowCount: 2 },
      one({ total: 2 }),
      one({ id: '50', kind: 'NEW' }));
    const r = await svc.listFiles(req({ query: { machine_id: '7', kind: 'backups', page: '1', limit: '20' } }));
    expect(mockDb.calls()[1].params).toEqual([7, 5, ['BACKUP', 'FETCHED'], 20, 0]);
    expect(r.data.map(f => f.is_current)).toEqual([false, false]);
    expect(r.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
  });
});

describe('upload', () => {
  test("is saved under the machine's folder and becomes the machine's program", async () => {
    mockDb.queueResponse(one(machine), one({ id: '42', machine_id: 7, program_name: 'O1001.nc', kind: 'NEW' }));
    const file = await svc.upload(req({ body: { machine_id: '7' }, file: stage('%\nO1001\nM30\n%\n') }));
    expect(file).toMatchObject({ id: '42', is_current: true });
    const insert = sql(/INSERT INTO program_files/);
    expect(insert.params.slice(0, 2)).toEqual([5, 7]);
    expect(insert.params[2]).toBe('company-5/programs/machine-7/uploads');
    expect(insert.params.slice(4, 6)).toEqual(['O1001.nc', 'NEW']);
    expect(insert.params[8]).toBe(2);           // uploaded_by
    expect(fs.existsSync(storage.resolveInside(insert.params[2], insert.params[3]))).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'PROGRAM_UPLOAD', company_id: 5 }));
  });

  test.each([
    ['a binary file', '\u0000\u0001ELF', 'O1.nc', 'NOT_TEXT'],
    ['an empty file', '', 'O1.nc', 'EMPTY'],
    ['a file that is not a program', 'hello', 'virus.exe', 'BAD_TYPE']
  ])('%s is refused, and nothing is saved', async (_, text, name, code) => {
    mockDb.queueResponse(one(machine));
    await expect(svc.upload(req({ body: { machine_id: '7' }, file: stage(text, name) }))).rejects.toMatchObject({ code });
    expect(sql(/INSERT INTO program_files/)).toBeUndefined();
  });

  test('no file attached says so', async () => {
    mockDb.queueResponse(one(machine));
    await expect(svc.upload(req({ body: { machine_id: '7' } }))).rejects.toMatchObject({ code: 'NO_FILE', status: 400 });
  });
});

describe('delete', () => {
  test("the machine's program cannot be deleted (the gateway would go back to an older one)", async () => {
    mockDb.queueResponse(one({ id: '42', machine_id: 7, kind: 'NEW', company_id: 5, folder: 'company-5/programs/machine-7/uploads', stored_name: 'x' }),
      one({ id: '42' }));
    await expect(svc.deleteFile(req({ params: { id: '42' } }))).rejects.toMatchObject({ status: 409, code: 'CURRENT_PROGRAM' });
    expect(sql(/UPDATE program_files SET deleted_at/)).toBeUndefined();
  });

  test('an older upload is deleted from disk and marked deleted', async () => {
    const saved = await storage.saveStream({ machine, kind: 'NEW', programName: 'O0999.nc', filename: stage('%\nO0999\nM30\n%\n').path });
    mockDb.queueResponse(one({ id: '30', machine_id: 7, kind: 'NEW', company_id: 5, program_name: 'O0999.nc',
                               folder: saved.folder, stored_name: saved.storedName }), one({ id: '42' }));
    await svc.deleteFile(req({ params: { id: '30' } }));
    expect(fs.existsSync(storage.resolveInside(saved.folder, saved.storedName))).toBe(false);
    expect(sql(/UPDATE program_files SET deleted_at/).params).toEqual(['30', 2]);
  });

  test("a file of another company is not found", async () => {
    mockDb.queueResponse(none);
    await expect(svc.deleteFile(req({ params: { id: '30' } }))).rejects.toMatchObject({ status: 404, code: 'FILE_NOT_FOUND' });
    expect(mockDb.calls()[0].params).toEqual([30, 5]);
  });
});

describe('backup requests', () => {
  test('a request is made once; a second click returns the open one', async () => {
    mockDb.queueResponse(one(machine), none, one({ id: '9', requested_at: 'T0' }));
    await expect(svc.requestBackup(req({ params: { machineId: '7' } }))).resolves.toEqual({ id: '9', requested_at: 'T0', created: true });
    expect(mockDb.calls()[1].text).toMatch(/requested_at <= NOW\(\) - make_interval\(mins => \$2\)/);   // a stale one is closed first
    expect(mockDb.calls()[2].text).toMatch(/ON CONFLICT \(machine_id\) WHERE closed_at IS NULL DO NOTHING/);

    resetDb();
    mockDb.queueResponse(one(machine), none, none, one({ id: '9', requested_at: 'T0' }));
    await expect(svc.requestBackup(req({ params: { machineId: '7' } }))).resolves.toEqual({ id: '9', requested_at: 'T0', created: false });
  });
});

describe('gateway token', () => {
  test('replaces the live token; only its hash is stored and the token is returned once', async () => {
    mockDb.queueResponse(one(machine), none, none, one({ id: 3, token_prefix: 'mxd_x', created_at: 'T0' }), none);
    const r = await svc.createDeviceToken(req({ params: { machineId: '7' } }));
    expect(r.token).toMatch(deviceToken.SHAPE);
    const insert = sql(/INSERT INTO program_devices/);
    expect(insert.params[3]).toBe(deviceToken.hash(r.token));
    expect(JSON.stringify(insert.params)).not.toContain(r.token);
    expect(sql(/UPDATE program_devices SET revoked_at/).params).toEqual([7, 2]);
  });

  test('revoking a machine with no token says so', async () => {
    mockDb.queueResponse(one(machine), none);
    await expect(svc.revokeDeviceToken(req({ params: { machineId: '7' } }))).rejects.toMatchObject({ status: 404, code: 'NO_TOKEN' });
  });
});

describe('the gateway side', () => {
  const device = { id: 3, company_id: 5, machine: { id: 7, machine_serial_no: 'VMC-1' } };

  test('status: the program to compare by sha256, an open backup request, how often to ask', async () => {
    mockDb.queueResponse(one({ id: '42', program_name: 'O1001.nc', size_bytes: 24, sha256: 'a'.repeat(64), created_at: 'T0' }),
      one({ id: '9', requested_at: 'T1' }));
    await expect(svc.deviceStatus(device)).resolves.toEqual({
      machine: { id: 7, serial: 'VMC-1' },
      program: { file_id: 42, program_name: 'O1001.nc', size_bytes: 24, sha256: 'a'.repeat(64), uploaded_at: 'T0',
                 status: 'WAITING', message: null },
      backup_request: { id: 9, requested_at: 'T1' },
      poll_seconds: 15
    });
    expect(mockDb.calls()[0].params).toEqual([7]);
  });

  test('program: none uploaded yet is a 404 the gateway can read', async () => {
    await expect(svc.deviceProgram(device)).rejects.toMatchObject({ status: 404, code: 'NO_PROGRAM' });
  });

  test('backup: saved as a backup of that machine, answers the open request and tells who asked', async () => {
    mockDb.queueResponse(one({ id: '43', machine_id: 7, program_name: 'O1001.nc', kind: 'BACKUP', size_bytes: 14, sha256: 'b'.repeat(64), created_at: 'T2' }),
      one({ id: '9', requested_by: 2 }), none);
    const r = await svc.deviceBackup(device, stage('%\nO1001\nM30\n%\n'), { program_name: 'O1001.nc' });
    expect(r).toEqual({ file: { file_id: 43, program_name: 'O1001.nc', size_bytes: 14, sha256: 'b'.repeat(64), uploaded_at: 'T2' }, answered_request: 9 });
    const insert = sql(/INSERT INTO program_files/);
    expect(insert.params[2]).toBe('company-5/programs/machine-7/backups');
    expect(insert.params[5]).toBe('BACKUP');
    expect(insert.params.slice(8)).toEqual([null, 3]);   // no person; the device
    expect(sql(/UPDATE program_backup_requests SET closed_at = NOW\(\), file_id = \$2/).params).toEqual([7, '43']);
    const note = sql(/INSERT INTO notifications/);
    expect(note.text).toMatch(/notify_program_transfer = false/);
    // the link opens Program Transfer on this machine with the backup marked
    expect(note.params).toEqual([5, 2, 'INFO', 'Backup received — VMC-1', '"O1001.nc" was saved from VMC-1.', '/programs?machine_id=7&file_id=43']);
  });

  test('a backup nobody asked for is kept, and no one is notified', async () => {
    mockDb.queueResponse(one({ id: '44', program_name: 'O1001.nc' }), none);
    const r = await svc.deviceBackup(device, stage('%\nO1001\nM30\n%\n'));
    expect(r.answered_request).toBeNull();
    expect(sql(/INSERT INTO notifications/)).toBeUndefined();
  });
});

describe('the gateway reports what happened', () => {
  const device = { id: 3, company_id: 5, machine: { id: 7, machine_serial_no: 'VMC-1' } };

  test('DONE: the program is on the machine, and the uploader is told', async () => {
    mockDb.queueResponse(one({ id: '42', program_name: 'O1001.nc', uploaded_by: 2 }), none);
    await expect(svc.deviceReport(device, { file_id: 42, status: 'done' })).resolves.toEqual({ file_id: 42, status: 'DONE' });
    const update = sql(/UPDATE program_files SET delivery_status/);
    expect(update.params).toEqual([42, 7, 'DONE', null]);
    expect(update.text).toMatch(/machine_id = \$2 AND kind = 'NEW' AND deleted_at IS NULL/);   // only this machine's uploads
    expect(sql(/INSERT INTO notifications/).params).toEqual([5, 2, 'INFO', 'Program on VMC-1', '"O1001.nc" was written to VMC-1.',
      '/programs?machine_id=7&file_id=42']);
  });

  test('FAILED: the reason is kept, and the uploader is warned', async () => {
    mockDb.queueResponse(one({ id: '42', program_name: 'O1001.nc', uploaded_by: 2 }), none);
    await svc.deviceReport(device, { file_id: 42, status: 'FAILED', message: '  CNC memory full  ' });
    expect(sql(/UPDATE program_files SET delivery_status/).params).toEqual([42, 7, 'FAILED', 'CNC memory full']);
    expect(sql(/INSERT INTO notifications/).params.slice(2)).toEqual(['WARNING', 'Program not accepted — VMC-1',
      'VMC-1 could not use "O1001.nc": CNC memory full', '/programs?machine_id=7&file_id=42']);
  });

  test('the same report again (a retry) changes nothing and tells no one twice', async () => {
    mockDb.queueResponse(none, one({ id: '42' }));
    await expect(svc.deviceReport(device, { file_id: 42, status: 'DONE' })).resolves.toEqual({ file_id: 42, status: 'DONE', unchanged: true });
    expect(sql(/INSERT INTO notifications/)).toBeUndefined();
  });

  test("a file of another machine, or no file, is not found", async () => {
    mockDb.queueResponse(none, none);
    await expect(svc.deviceReport(device, { file_id: 99, status: 'DONE' })).rejects.toMatchObject({ status: 404, code: 'FILE_NOT_FOUND' });
  });

  test.each([
    [{ file_id: 42, status: 'OK' }, 'BAD_STATUS'],
    [{ file_id: 42, status: 'FAILED' }, 'NO_MESSAGE'],
    [{ status: 'DONE' }, 'NOTHING_TO_REPORT'],
    [{ backup_request_id: 9, status: 'DONE' }, 'BAD_STATUS']
  ])('%j is refused with %s', async (body, code) => {
    await expect(svc.deviceReport(device, body)).rejects.toMatchObject({ status: 400, code });
    expect(sql(/UPDATE/)).toBeUndefined();
  });

  test('a backup that could not be read closes the request and warns who asked', async () => {
    mockDb.queueResponse(one({ id: '9', requested_by: 2 }), none);
    await expect(svc.deviceReport(device, { backup_request_id: 9, status: 'FAILED', message: 'CNC not reachable' }))
      .resolves.toEqual({ backup_request_id: 9, status: 'FAILED' });
    expect(sql(/UPDATE program_backup_requests SET closed_at = NOW\(\), error_message = \$3/).params).toEqual([9, 7, 'CNC not reachable']);
    expect(sql(/INSERT INTO notifications/).params.slice(2)).toEqual(['WARNING', 'Backup failed — VMC-1',
      'VMC-1 could not send a backup: CNC not reachable', '/programs?machine_id=7']);
  });

  test('a backup request already closed: unchanged; another machine\'s: not found', async () => {
    mockDb.queueResponse(none, one({ id: '9' }));
    await expect(svc.deviceReport(device, { backup_request_id: 9, status: 'FAILED', message: 'x' }))
      .resolves.toEqual({ backup_request_id: 9, status: 'FAILED', unchanged: true });
    resetDb();
    mockDb.queueResponse(none, none);
    await expect(svc.deviceReport(device, { backup_request_id: 10, status: 'FAILED', message: 'x' }))
      .rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND' });
  });
});
