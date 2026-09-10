/*
 * Unit tests for programs/program.service covering the full transfer flow
 * with a mocked FTP client (no real CNC machine needed):
 *  - createProgram: rejects without a file, inserts with metadata
 *  - transferProgram: SUCCESS path updates the log row
 *  - transferProgram: FTP failure writes error_message + status FAILED (502)
 *  - transferProgram: missing program / machine → error
 *  - deleteProgram: not found → error
 *  - testConnection: blank password falls back to stored one (write-only)
 *  - cleanupStuckTransfers: marks stale PENDING rows FAILED
 *  - the supervisor authorisation gate on uploadOne
 *
 * The OTP gate itself is covered in authorization.service.test.js; here it
 * is mocked so these tests stay about the transfer mechanics, with two
 * exceptions that assert the two are actually wired together.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/programs/program.transfer', () => ({
  sendProgramToMachine:    jest.fn(),
  fetchProgramFromMachine: jest.fn(),
  listMachineFiles:        jest.fn(),
  machineFileExists:       jest.fn(),
  testMachineConnection:   jest.fn()
}));
jest.mock('../../src/programs/authorization.service', () => ({
  assertAuthorized: jest.fn()
}));

const { mockDb, resetDb } = require('../helpers/mockDb');
const {
  sendProgramToMachine, fetchProgramFromMachine, machineFileExists, testMachineConnection
} = require('../../src/programs/program.transfer');
const { assertAuthorized } = require('../../src/programs/authorization.service');
const svc = require('../../src/programs/program.service');

const user = { id: 7, company_id: 3 };

/** Shape assertAuthorized resolves to: the verified authorisation row. */
const VERIFIED = { id: 77, supervisor_id: 42 };

beforeEach(() => {
  resetDb();
  sendProgramToMachine.mockReset();
  fetchProgramFromMachine.mockReset();
  machineFileExists.mockReset();
  testMachineConnection.mockReset();
  assertAuthorized.mockReset();
  // default: nothing on the controller, so transfers are not blocked
  machineFileExists.mockResolvedValue(false);
  // default: the supervisor has authorised this transfer
  assertAuthorized.mockResolvedValue(VERIFIED);
});

describe('program.service.createProgram', () => {
  test('throws when no file is uploaded', async () => {
    await expect(svc.createProgram({ user, body: {}, file: undefined }))
      .rejects.toThrow(/no program file/i);
  });

  test('inserts program with name, size and uploader', async () => {
    const file = { originalname: 'O1234.nc', buffer: Buffer.from('G0 X0 Y0'), size: 8 };
    mockDb.queueResponse({
      rows: [{ id: 1, name: 'Flange Roughing', file_name: 'O1234.nc', file_size: 8 }],
      rowCount: 1
    });

    const result = await svc.createProgram({
      user, file, body: { name: 'Flange Roughing', description: 'op10' }
    });

    expect(result.id).toBe(1);
    const insert = mockDb.calls()[0];
    expect(insert.text).toMatch(/INSERT INTO programs/i);
    expect(insert.params).toEqual([3, 'Flange Roughing', 'O1234.nc', file.buffer, 8, 'op10', 7]);
  });

  test('falls back to file name when no display name given', async () => {
    const file = { originalname: 'O55.prg', buffer: Buffer.from('M30'), size: 3 };
    mockDb.queueResponse({ rows: [{ id: 2 }], rowCount: 1 });

    await svc.createProgram({ user, file, body: {} });

    expect(mockDb.calls()[0].params[1]).toBe('O55.prg');
  });
});

describe('program.service.transferProgram', () => {
  const req = { user, params: { id: '10', machineId: '20' } };

  const programRow = {
    id: 10, name: 'Flange Roughing', file_name: 'O1234.nc',
    content: Buffer.from('G0 X0')
  };
  const machineRow = {
    id: 20, machine_serial_no: 'VMC-01', ip_address: '192.168.1.101',
    ftp_port: 21, ftp_user: 'cnc', ftp_pass: 'secret', ftp_dir: '/PROGRAM'
  };

  test('SUCCESS: uploads via FTP and marks the log row SUCCESS', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },        // program lookup
      { rows: [machineRow], rowCount: 1 },        // machine lookup
      { rows: [{ id: 99 }], rowCount: 1 },        // insert PENDING log
      { rows: [], rowCount: 1 }                   // update SUCCESS
    );
    sendProgramToMachine.mockResolvedValue();

    const result = await svc.transferProgram(req);

    // nothing was on the machine, so there was nothing to back up
    expect(result).toEqual({ transfer_id: 99, status: 'SUCCESS', backup: null });
    expect(sendProgramToMachine).toHaveBeenCalledWith(
      machineRow, programRow.content, 'O1234.nc', expect.any(Function)
    );

    const update = mockDb.calls()[3];
    expect(update.text).toMatch(/SET status = 'SUCCESS'/);
    expect(update.params).toEqual([99]);
  });

  test('FAILED: FTP error is saved to error_message and rethrown as 502', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 100 }], rowCount: 1 },       // insert PENDING log
      { rows: [], rowCount: 1 }                   // update FAILED
    );
    sendProgramToMachine.mockRejectedValue(new Error('connect ETIMEDOUT 192.168.1.101:21'));

    await expect(svc.transferProgram(req)).rejects.toMatchObject({
      status: 502,
      message: /Transfer failed: connect ETIMEDOUT/
    });

    const update = mockDb.calls()[3];
    expect(update.text).toMatch(/SET status = 'FAILED'/);
    expect(update.params).toEqual([100, 'connect ETIMEDOUT 192.168.1.101:21']);
  });

  test('refuses to overwrite a program already on the controller', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 }
    );
    machineFileExists.mockResolvedValue(true);

    // Silently replacing a file the operator may be mid-cut on is the
    // failure this guard exists to prevent.
    await expect(svc.transferProgram(req)).rejects.toMatchObject({
      status: 409,
      code: 'FILE_EXISTS'
    });
    expect(sendProgramToMachine).not.toHaveBeenCalled();
  });

  test('overwrite:true backs the old program up, then sends', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 500, name: 'O1234.nc backup', file_size: 12 }], rowCount: 1 },  // backup INSERT
      { rows: [{ id: 101 }], rowCount: 1 },                                          // transfer row
      { rows: [], rowCount: 1 }                                                      // mark SUCCESS
    );
    machineFileExists.mockResolvedValue(true);
    fetchProgramFromMachine.mockResolvedValue(Buffer.from('O1234\nOLD\nM30'));
    sendProgramToMachine.mockResolvedValue();

    const result = await svc.transferProgram({ ...req, body: { overwrite: true } });

    expect(result.status).toBe('SUCCESS');
    expect(result.backup).toEqual({ id: 500, name: 'O1234.nc backup', file_size: 12 });

    // order is the whole safety property: read the old one before writing over it
    const order = [
      fetchProgramFromMachine.mock.invocationCallOrder[0],
      sendProgramToMachine.mock.invocationCallOrder[0]
    ];
    expect(order[0]).toBeLessThan(order[1]);
  });

  test('throws when program not found', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                  // program missing
      { rows: [machineRow], rowCount: 1 }
    );

    await expect(svc.transferProgram(req)).rejects.toThrow(/program not found/i);
    expect(sendProgramToMachine).not.toHaveBeenCalled();
  });

  test('throws when machine not found', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [], rowCount: 0 }                   // machine missing
    );

    await expect(svc.transferProgram(req)).rejects.toThrow(/machine not found/i);
    expect(sendProgramToMachine).not.toHaveBeenCalled();
  });

  test('an unauthorised transfer never reaches the controller', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 }
    );
    const denied = Object.assign(new Error('needs supervisor authorisation'), {
      status: 403, code: 'APPROVAL_REQUIRED'
    });
    assertAuthorized.mockRejectedValue(denied);

    await expect(svc.transferProgram(req)).rejects.toMatchObject({
      status: 403, code: 'APPROVAL_REQUIRED'
    });

    // The gate must sit in front of the FTP layer entirely — not even the
    // existence probe should open a session against the machine.
    expect(sendProgramToMachine).not.toHaveBeenCalled();
    expect(machineFileExists).not.toHaveBeenCalled();
    // ...and nothing may be written to the transfer log either.
    expect(mockDb.calls().some(c => /INSERT INTO program_transfers/i.test(c.text))).toBe(false);
  });

  test('records who authorised alongside who initiated', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 102 }], rowCount: 1 },
      { rows: [], rowCount: 1 }
    );
    sendProgramToMachine.mockResolvedValue();

    await svc.transferProgram({ ...req, body: { authorization_id: 77, authorization_code: '123456' } });

    expect(assertAuthorized).toHaveBeenCalledWith(
      machineRow, user, { authorization_id: 77, code: '123456' }
    );

    const insert = mockDb.calls()[2];
    expect(insert.text).toMatch(/authorized_by, authorization_id, authorized_at/);
    // transferred_by is the operator who clicked; authorized_by the
    // supervisor who signed it off. The agreement requires both.
    expect(insert.params.slice(-4, -1)).toEqual([user.id, VERIFIED.supervisor_id, VERIFIED.id]);
    expect(insert.params.at(-1)).toBeNull();   // nothing was replaced
  });
});

describe('program.service.transferBatch', () => {
  const programRow = { id: 10, name: 'Flange', file_name: 'O1.nc', content: Buffer.from('G0') };
  const machineRow = { id: 20, machine_serial_no: 'VMC-01' };

  test('reports a blocked machine as APPROVAL_REQUIRED, not a generic failure', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 }
    );
    assertAuthorized.mockRejectedValue(Object.assign(new Error('needs authorisation'), {
      status: 403, code: 'APPROVAL_REQUIRED'
    }));

    const res = await svc.transferBatch({
      user, body: { program_ids: [10], machine_ids: [20] }
    });

    // Collapsing this into FAILED would tell the operator to retry, when
    // what they actually need is a code from their supervisor.
    expect(res.results[0]).toMatchObject({
      machine_serial: 'VMC-01', status: 'APPROVAL_REQUIRED', code: 'APPROVAL_REQUIRED'
    });
    expect(res.succeeded).toBe(0);
  });

  test('a wrong code costs one attempt for the whole batch, not one per program', async () => {
    const threePrograms = [
      { id: 10, name: 'A', file_name: 'A.nc', content: Buffer.from('G0') },
      { id: 11, name: 'B', file_name: 'B.nc', content: Buffer.from('G0') },
      { id: 12, name: 'C', file_name: 'C.nc', content: Buffer.from('G0') }
    ];
    mockDb.queueResponse(
      ...threePrograms.map(p => ({ rows: [p], rowCount: 1 })),
      { rows: [machineRow], rowCount: 1 }
    );
    assertAuthorized.mockRejectedValue(Object.assign(new Error('Incorrect code. 4 attempts remaining.'), {
      status: 403, code: 'INVALID_CODE'
    }));

    const res = await svc.transferBatch({
      user, body: { program_ids: [10, 11, 12], machine_ids: [20] }
    });

    // Verifying per program would spend 3 of the 5 attempts on a single
    // mistyped code, and 5 selected programs would lock it outright.
    expect(assertAuthorized).toHaveBeenCalledTimes(1);
    // Every program still has to be reported, or the operator sees a
    // partial list and assumes the rest went through.
    expect(res.results).toHaveLength(3);
    expect(res.results.every(r => r.status === 'APPROVAL_REQUIRED')).toBe(true);
  });

  test('an unassigned machine is reported distinctly from a missing code', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 }
    );
    assertAuthorized.mockRejectedValue(Object.assign(new Error('no supervisor'), {
      status: 403, code: 'NO_SUPERVISOR_ASSIGNED'
    }));

    const res = await svc.transferBatch({
      user, body: { program_ids: [10], machine_ids: [20] }
    });

    // This one an admin has to fix, so it must not look like "enter a code".
    expect(res.results[0].status).toBe('NO_SUPERVISOR');
  });
});

describe('program.service.deleteProgram', () => {
  test('throws when program does not belong to company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.deleteProgram({ user, params: { id: '5' } }))
      .rejects.toThrow(/not found or access denied/i);
  });

  test('soft-deletes the program', async () => {
    mockDb.queueResponse({ rows: [{ id: 5 }], rowCount: 1 });
    await svc.deleteProgram({ user, params: { id: '5' } });
    expect(mockDb.calls()[0].text).toMatch(/SET is_active = false/);
  });
});

describe('program.service.testConnection', () => {
  test('blank password falls back to the stored one (write-only password)', async () => {
    mockDb.queueResponse({
      rows: [{ ip_address: '192.168.1.101', ftp_port: 21, ftp_user: 'cnc', ftp_pass: 'stored-secret' }],
      rowCount: 1
    });
    testMachineConnection.mockResolvedValue();

    await svc.testConnection({
      user,
      body: { machine_id: 20, ip_address: '192.168.1.101', ftp_user: 'cnc', ftp_pass: '' }
    });

    expect(testMachineConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ftp_pass: 'stored-secret' })
    );
  });

  test('form values override stored ones when provided', async () => {
    mockDb.queueResponse({
      rows: [{ ip_address: '10.0.0.1', ftp_port: 21, ftp_user: 'old', ftp_pass: 'old-pass' }],
      rowCount: 1
    });
    testMachineConnection.mockResolvedValue();

    await svc.testConnection({
      user,
      body: { machine_id: 20, ip_address: '192.168.1.200', ftp_user: 'new', ftp_pass: 'new-pass' }
    });

    expect(testMachineConnection).toHaveBeenCalledWith({
      ip_address: '192.168.1.200', ftp_port: 21, ftp_user: 'new', ftp_pass: 'new-pass'
    });
  });

  test('works without machine_id (new machine, nothing saved yet)', async () => {
    testMachineConnection.mockResolvedValue();

    await svc.testConnection({
      user,
      body: { ip_address: '192.168.1.50', ftp_port: 21, ftp_user: 'cnc', ftp_pass: 'pw' }
    });

    expect(mockDb.calls()).toHaveLength(0);   // no DB lookup needed
    expect(testMachineConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ip_address: '192.168.1.50' })
    );
  });

  test('throws when machine_id given but machine not found', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.testConnection({ user, body: { machine_id: 999 } }))
      .rejects.toThrow(/machine not found/i);
  });

  /*
   * The endpoint takes an address from the request body so the machine
   * form can be tested before it is saved, which without a guard makes it
   * a port scanner: any logged-in user can aim the server at a host and
   * learn from the reply whether the port answered.
   */
  describe('will not probe off the shop floor', () => {
    test.each([
      ['a public address',        '8.8.8.8'],
      ['EC2 instance metadata',   '169.254.169.254'],
      ['loopback',                '127.0.0.1'],
      ['just outside 172.16/12',  '172.32.0.1']
    ])('refuses %s', async (_label, ip) => {
      await expect(svc.testConnection({ user, body: { ip_address: ip } }))
        .rejects.toMatchObject({ status: 400, code: 'ADDRESS_NOT_PRIVATE' });
      expect(testMachineConnection).not.toHaveBeenCalled();
    });

    test('rejects a malformed address before it reaches the FTP client', async () => {
      await expect(svc.testConnection({ user, body: { ip_address: '10.0.0.999' } }))
        .rejects.toMatchObject({ status: 400, code: 'BAD_ADDRESS' });
      expect(testMachineConnection).not.toHaveBeenCalled();
    });

    test.each([['10.4.1.9'], ['172.16.0.1'], ['172.31.255.254'], ['192.168.1.50']])(
      'allows %s', async (ip) => {
        testMachineConnection.mockResolvedValue();
        await svc.testConnection({ user, body: { ip_address: ip } });
        expect(testMachineConnection).toHaveBeenCalled();
      }
    );

    test('a stored address is trusted — only body values are screened', async () => {
      // An admin set this through the machine form; re-validating it here
      // would lock a customer out of their own machine over a policy the
      // machine form never enforced.
      mockDb.queueResponse({
        rows: [{ ip_address: '8.8.8.8', ftp_port: 21, ftp_user: 'cnc', ftp_pass: 'pw' }],
        rowCount: 1
      });
      testMachineConnection.mockResolvedValue();

      await svc.testConnection({ user, body: { machine_id: 20 } });

      expect(testMachineConnection).toHaveBeenCalledWith(
        expect.objectContaining({ ip_address: '8.8.8.8' })
      );
    });
  });
});

/*
 * A CNC's embedded FTP server accepts one control session. Two transfers
 * overlapping is not an abstract race — it is two operators clicking Send
 * within a few seconds of each other — and the result on some controllers
 * is a truncated program file rather than a clean refusal.
 */
describe('program.service — one transfer at a time per machine', () => {
  const programRow = { id: 1, name: 'Flange', file_name: 'O1234.nc', content: Buffer.from('G0') };
  const machineRow = { id: 20, machine_serial_no: 'VMC-01', ip_address: '192.168.1.101' };
  const req = { user, params: { id: 1, machineId: 20 }, body: {} };

  test('refuses a second transfer while one is running, without touching FTP', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 }
    );
    mockDb.denyAdvisoryLock();

    await expect(svc.transferProgram(req)).rejects.toMatchObject({
      status: 409,
      code: 'MACHINE_BUSY'
    });
    // the whole point: no second session is opened against the controller
    expect(sendProgramToMachine).not.toHaveBeenCalled();
    expect(machineFileExists).not.toHaveBeenCalled();
  });

  test('takes the lock on the machine id and releases it on success', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 99 }], rowCount: 1 },
      { rows: [], rowCount: 1 }
    );
    sendProgramToMachine.mockResolvedValue();

    await svc.transferProgram(req);

    const locks = mockDb.allCalls().filter(c => /advisory/.test(c.text));
    expect(locks).toHaveLength(2);
    expect(locks[0].text).toMatch(/pg_try_advisory_lock/);
    expect(locks[0].params[1]).toBe(20);        // keyed by machine, not program
    expect(locks[1].text).toMatch(/pg_advisory_unlock/);
    expect(locks[1].params).toEqual(locks[0].params);
  });

  test('releases the lock when the transfer fails', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 100 }], rowCount: 1 },
      { rows: [], rowCount: 1 }
    );
    sendProgramToMachine.mockRejectedValue(new Error('connect ETIMEDOUT'));

    await expect(svc.transferProgram(req)).rejects.toThrow(/Transfer failed/);

    // a failed transfer that kept the lock would wedge the machine until
    // the API process restarted
    expect(mockDb.allCalls().some(c => /pg_advisory_unlock/.test(c.text))).toBe(true);
  });

  test('an unauthorised caller never takes the lock', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 },
      { rows: [machineRow], rowCount: 1 }
    );
    const denied = Object.assign(new Error('Supervisor code required'), {
      status: 403, code: 'APPROVAL_REQUIRED'
    });
    assertAuthorized.mockRejectedValue(denied);

    await expect(svc.transferProgram(req)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    // otherwise a stream of unauthorised attempts would hold the machine
    // busy against the operators who are allowed to use it
    expect(mockDb.allCalls().some(c => /advisory/.test(c.text))).toBe(false);
  });
});

describe('program.service.cleanupStuckTransfers', () => {
  test('marks stale PENDING rows as FAILED and returns the count', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });

    const fixed = await svc.cleanupStuckTransfers();

    expect(fixed).toBe(2);
    const q = mockDb.calls()[0].text;
    expect(q).toMatch(/SET status = 'FAILED'/);
    expect(q).toMatch(/status = 'PENDING'/);
    expect(q).toMatch(/INTERVAL '5 minutes'/);
  });
});

/*
 * Backup before overwrite.
 *
 * A program on a controller is not necessarily a copy of anything in the
 * library — operators edit at the panel, and those edits often exist
 * nowhere else. So the old program is read off the machine and stored
 * before the new one is sent, and if that read fails nothing is sent at
 * all. Overwriting something we failed to back up would destroy exactly
 * what the backup exists to protect.
 */
describe('program.service — backup before overwrite', () => {
  const req = { user, params: { id: '10', machineId: '20' }, body: { overwrite: true } };
  const programRow = { id: 10, name: 'Flange', file_name: 'O1234.nc', content: Buffer.from('G0 X0') };
  const machineRow = { id: 20, machine_serial_no: 'VMC-01', ip_address: '192.168.1.101' };

  const lookups = () => mockDb.queueResponse(
    { rows: [programRow], rowCount: 1 },
    { rows: [machineRow], rowCount: 1 }
  );

  test('nothing on the machine means no backup and no wasted read', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 }, { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 99 }], rowCount: 1 }, { rows: [], rowCount: 1 }
    );
    machineFileExists.mockResolvedValue(false);
    sendProgramToMachine.mockResolvedValue();

    const result = await svc.transferProgram(req);

    expect(result.backup).toBeNull();
    expect(fetchProgramFromMachine).not.toHaveBeenCalled();
  });

  test('the backup is stored against the machine it came from', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 }, { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 500, name: 'bk', file_size: 9 }], rowCount: 1 },
      { rows: [{ id: 101 }], rowCount: 1 }, { rows: [], rowCount: 1 }
    );
    machineFileExists.mockResolvedValue(true);
    fetchProgramFromMachine.mockResolvedValue(Buffer.from('OLD PROG'));
    sendProgramToMachine.mockResolvedValue();

    await svc.transferProgram(req);

    const insert = mockDb.calls().find(c => /is_backup/.test(c.text));
    expect(insert.text).toMatch(/INSERT INTO programs/i);
    expect(insert.params).toContain(machineRow.id);      // backup_of_machine_id
    expect(insert.params).toContain(programRow.id);      // which program replaced it
    expect(insert.params.some(p => Buffer.isBuffer(p) && p.toString() === 'OLD PROG')).toBe(true);
  });

  test('the transfer row records which backup belongs to it', async () => {
    mockDb.queueResponse(
      { rows: [programRow], rowCount: 1 }, { rows: [machineRow], rowCount: 1 },
      { rows: [{ id: 500, name: 'bk', file_size: 9 }], rowCount: 1 },
      { rows: [{ id: 101 }], rowCount: 1 }, { rows: [], rowCount: 1 }
    );
    machineFileExists.mockResolvedValue(true);
    fetchProgramFromMachine.mockResolvedValue(Buffer.from('OLD'));
    sendProgramToMachine.mockResolvedValue();

    await svc.transferProgram(req);

    const transferInsert = mockDb.calls().find(c => /INSERT INTO program_transfers/i.test(c.text));
    expect(transferInsert.text).toMatch(/backup_program_id/);
    expect(transferInsert.params.at(-1)).toBe(500);
  });

  test('a failed backup stops the transfer — nothing is sent', async () => {
    lookups();
    machineFileExists.mockResolvedValue(true);
    fetchProgramFromMachine.mockRejectedValue(new Error('EW_BUSY'));

    await expect(svc.transferProgram(req)).rejects.toMatchObject({
      code: 'BACKUP_FAILED', status: 502
    });

    // the old program on the machine is still there, untouched
    expect(sendProgramToMachine).not.toHaveBeenCalled();
  });

  test('an empty read counts as a failed backup', async () => {
    lookups();
    machineFileExists.mockResolvedValue(true);
    fetchProgramFromMachine.mockResolvedValue(Buffer.alloc(0));

    // Storing zero bytes would look like a backup and restore nothing.
    await expect(svc.transferProgram(req)).rejects.toMatchObject({ code: 'BACKUP_FAILED' });
    expect(sendProgramToMachine).not.toHaveBeenCalled();
  });

  test('the failure message says the transfer did not happen', async () => {
    lookups();
    machineFileExists.mockResolvedValue(true);
    fetchProgramFromMachine.mockRejectedValue(new Error('timeout'));

    await expect(svc.transferProgram(req)).rejects.toThrow(/nothing was sent/i);
  });
});

describe('program.service.getPrograms', () => {
  test('backups are kept out of the list operators send from', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [{ total: 0 }], rowCount: 1 });

    await svc.getPrograms({ user, query: {} });

    // one row per overwrite would bury the programs people actually curate
    expect(mockDb.calls()[0].text).toMatch(/is_backup = false/);
  });
});

describe('program.service.getBackups', () => {
  test('lists only backups, newest first', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [{ total: 0 }], rowCount: 1 });

    await svc.getBackups({ user, query: {} });

    const q = mockDb.calls()[0].text;
    expect(q).toMatch(/is_backup = true/);
    expect(q).toMatch(/ORDER BY p\.backup_taken_at DESC/);
  });

  test('filters to one machine when asked', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [{ total: 0 }], rowCount: 1 });

    await svc.getBackups({ user, query: { machine_id: 20 } });

    expect(mockDb.calls()[0].text).toMatch(/backup_of_machine_id = \$2/);
    expect(mockDb.calls()[0].params).toContain(20);
  });

  test('scoped to the caller company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [{ total: 0 }], rowCount: 1 });

    await svc.getBackups({ user, query: {} });

    expect(mockDb.calls()[0].text).toMatch(/p\.company_id = \$1/);
    expect(mockDb.calls()[0].params[0]).toBe(user.company_id);
  });
});
