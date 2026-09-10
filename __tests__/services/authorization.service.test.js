/*
 * Unit tests for programs/authorization.service — the supervisor OTP gate
 * on CNC program transfers.
 *
 * This guards a safety control: a program reaching the wrong controller
 * can crash a spindle. The tests that matter most are the negative ones —
 * a code must not work for another machine, another company, after
 * expiry, or after five wrong guesses.
 *
 * db.connect()'s client.query is the same mock as db.query (see
 * helpers/mockDb.js), so every statement in a transaction — including the
 * literal BEGIN/COMMIT — consumes one queued response in order.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/utils/nodemailer', () => ({
  sendEmail: jest.fn(async () => 'queued'),
  sendBulkEmails: jest.fn(async () => [])
}));

const { mockDb, resetDb } = require('../helpers/mockDb');
const { sendEmail } = require('../../src/utils/nodemailer');
const svc = require('../../src/programs/authorization.service');

const company_id = 3;
const user = { id: 9, username: 'Anand', company_id };
const machine = { id: 5, machine_serial_no: 'VMC-102-F' };

const hash = (code) => svc._internal.hashCode(code);
const future = () => new Date(Date.now() + 9 * 60 * 1000);
const past = () => new Date(Date.now() - 60 * 1000);

/** A transfer_authorizations row as the FOR UPDATE select returns it. */
const authRow = (over = {}) => ({
  id: 77,
  company_id,
  machine_id: machine.id,
  supervisor_id: 42,
  code_hash: hash('123456'),
  attempts: 0,
  uses: 0,
  status: 'PENDING',
  expires_at: future(),
  ...over
});

beforeEach(() => {
  resetDb();
  sendEmail.mockClear();
});

describe('requestAuthorization', () => {
  test('refuses when the machine has no supervisor, and sends no email', async () => {
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },  // machine lookup
      { rows: [] }                       // listSupervisors — nobody assigned
    );

    await expect(svc.requestAuthorization({ machine_id: 5, user }))
      .rejects.toMatchObject({ status: 403, code: 'NO_SUPERVISOR_ASSIGNED' });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('issues a code to the single assigned supervisor without asking who', async () => {
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },
      { rows: [{ id: 42, username: 'Ravi', email: 'ravi@stm.com' }] },
      { rows: [{ name: 'O1234 Flange' }] },                       // program names
      { rows: [{ id: 77, expires_at: future() }], rowCount: 1 },  // INSERT
      { rows: [], rowCount: 1 }                                   // UPDATE sent_to
    );

    const res = await svc.requestAuthorization({
      machine_id: 5, program_ids: [1], user
    });

    expect(res.authorization_id).toBe(77);
    expect(res.supervisor).toMatchObject({ id: 42, username: 'Ravi' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  test('never returns the code, and stores only its hash', async () => {
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },
      { rows: [{ id: 42, username: 'Ravi', email: 'ravi@stm.com' }] },
      { rows: [{ id: 77, expires_at: future() }], rowCount: 1 },
      { rows: [], rowCount: 1 }
    );

    const res = await svc.requestAuthorization({ machine_id: 5, user });

    // The emailed code is the only place the plaintext exists.
    const emailed = sendEmail.mock.calls[0][0].text.match(/code: (\d{6})/)[1];

    expect(JSON.stringify(res)).not.toContain(emailed);

    const insert = mockDb.calls().find(c => /INSERT INTO transfer_authorizations/i.test(c.text));
    expect(insert.params).toContain(hash(emailed));
    expect(insert.params).not.toContain(emailed);
  });

  test('masks the destination so it identifies without disclosing', async () => {
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },
      { rows: [{ id: 42, username: 'Ravi', email: 'ravi@stm.com' }] },
      { rows: [{ id: 77, expires_at: future() }], rowCount: 1 },
      { rows: [], rowCount: 1 }
    );

    const res = await svc.requestAuthorization({ machine_id: 5, user });

    expect(res.supervisor.sent_to).toBe('r***@stm.com');
  });

  test('asks which supervisor when the machine has several', async () => {
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },
      { rows: [
        { id: 42, username: 'Ravi', email: 'ravi@stm.com' },
        { id: 43, username: 'Sunita', email: 'sunita@stm.com' }
      ] }
    );

    await expect(svc.requestAuthorization({ machine_id: 5, user }))
      .rejects.toMatchObject({ code: 'SUPERVISOR_REQUIRED', status: 400 });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('rejects a supervisor who does not cover this machine', async () => {
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },
      { rows: [{ id: 42, username: 'Ravi', email: 'ravi@stm.com' }] }
    );

    await expect(svc.requestAuthorization({ machine_id: 5, supervisor_id: 99, user }))
      .rejects.toMatchObject({ code: 'INVALID_SUPERVISOR' });
  });

  test('retires the code when delivery fails, so no live hash is left behind', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SMTP unreachable'));
    mockDb.queueResponse(
      { rows: [machine], rowCount: 1 },
      { rows: [{ id: 42, username: 'Ravi', email: 'ravi@stm.com' }] },
      { rows: [{ id: 77, expires_at: future() }], rowCount: 1 },
      { rows: [], rowCount: 1 }   // UPDATE ... SET status = 'EXPIRED'
    );

    await expect(svc.requestAuthorization({ machine_id: 5, user }))
      .rejects.toMatchObject({ code: 'DELIVERY_FAILED', status: 502 });

    const last = mockDb.calls().at(-1);
    expect(last.text).toMatch(/SET status = 'EXPIRED'/);
    expect(last.params).toEqual([77]);
  });

  test('refuses a machine outside the caller’s company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    await expect(svc.requestAuthorization({ machine_id: 5, user }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('verifyAuthorization', () => {
  const verify = (over = {}) => svc.verifyAuthorization({
    authorization_id: 77, code: '123456', machine_id: 5, company_id, ...over
  });

  test('accepts the right code and marks the authorisation verified', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                                        // BEGIN
      { rows: [authRow()], rowCount: 1 },                               // SELECT FOR UPDATE
      { rows: [{ id: 77, supervisor_id: 42, verified_at: new Date() }] },// UPDATE
      { rows: [], rowCount: 0 }                                         // COMMIT
    );

    const res = await verify();

    expect(res.supervisor_id).toBe(42);
    expect(mockDb.calls()[2].text).toMatch(/SET status = 'VERIFIED'/);
  });

  test('rejects a code issued for a different machine', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ machine_id: 6 })], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    await expect(verify()).rejects.toMatchObject({ code: 'WRONG_MACHINE' });
  });

  test('rejects an authorisation belonging to another company', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ company_id: 99 })], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    // Deliberately indistinguishable from a bad id — never confirm the
    // row exists for someone else.
    await expect(verify()).rejects.toMatchObject({ code: 'INVALID_CODE' });
  });

  test('counts a wrong code against the attempt limit and commits the counter', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ attempts: 1 })], rowCount: 1 },
      { rows: [], rowCount: 1 },   // UPDATE attempts
      { rows: [], rowCount: 0 }    // COMMIT
    );

    await expect(verify({ code: '999999' }))
      .rejects.toMatchObject({ code: 'INVALID_CODE' });

    const update = mockDb.calls()[2];
    expect(update.params).toEqual([77, 2, false]);
    // The counter must survive the rejection, or guesses are unlimited.
    expect(mockDb.calls()[3].text).toBe('COMMIT');
  });

  test('locks the authorisation on the fifth wrong code', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ attempts: 4 })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    await expect(verify({ code: '999999' }))
      .rejects.toMatchObject({ code: 'CODE_LOCKED' });

    expect(mockDb.calls()[2].params).toEqual([77, 5, true]);
  });

  test('a locked authorisation refuses even the correct code', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ status: 'LOCKED' })], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    await expect(verify()).rejects.toMatchObject({ code: 'CODE_LOCKED' });
  });

  test('rejects an expired code and stamps it expired', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ expires_at: past() })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    await expect(verify()).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    expect(mockDb.calls()[2].text).toMatch(/SET status = 'EXPIRED'/);
  });

  test('stays usable for the overwrite retry, which re-sends the same code', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ status: 'VERIFIED', uses: 1, verified_at: new Date() })], rowCount: 1 },
      { rows: [{ id: 77, supervisor_id: 42 }] },
      { rows: [], rowCount: 0 }
    );

    await expect(verify()).resolves.toMatchObject({ supervisor_id: 42 });
  });

  test('stops once the reuse cap is hit', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow({ status: 'VERIFIED', uses: svc.MAX_USES })], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    await expect(verify()).rejects.toMatchObject({ code: 'CODE_EXHAUSTED' });
  });

  test('refuses outright when no code is supplied', async () => {
    await expect(svc.verifyAuthorization({ machine_id: 5, company_id }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('assertAuthorized', () => {
  test('asks for a code when the machine has a supervisor', async () => {
    mockDb.queueResponse({ rows: [{ id: 42, username: 'Ravi' }] });

    await expect(svc.assertAuthorized(machine, user, {}))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', status: 403 });
  });

  test('reports the missing assignment when nobody supervises the machine', async () => {
    mockDb.queueResponse({ rows: [] });

    // A different fix from APPROVAL_REQUIRED: this one needs an admin,
    // not a supervisor, so the two must not share a code.
    await expect(svc.assertAuthorized(machine, user, {}))
      .rejects.toMatchObject({ code: 'NO_SUPERVISOR_ASSIGNED' });
  });

  test('passes a valid code through to the transfer', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [authRow()], rowCount: 1 },
      { rows: [{ id: 77, supervisor_id: 42 }] },
      { rows: [], rowCount: 0 }
    );

    const res = await svc.assertAuthorized(machine, user, {
      authorization_id: 77, code: '123456'
    });

    expect(res.supervisor_id).toBe(42);
  });
});

describe('setSupervisedMachines', () => {
  test('scopes the insert by company so a foreign machine id cannot be claimed', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },  // BEGIN
      { rows: [], rowCount: 2 },  // deactivate existing
      { rows: [], rowCount: 1 },  // insert machine 5
      { rows: [], rowCount: 0 },  // insert machine 999 — not this company, no row
      { rows: [], rowCount: 0 }   // COMMIT
    );

    await svc.setSupervisedMachines(42, company_id, [5, 999], user.id);

    const insert = mockDb.calls()[2];
    // The INSERT ... SELECT FROM machines WHERE company_id filter is what
    // makes a cross-tenant id a no-op rather than a privilege grant.
    expect(insert.text).toMatch(/FROM machines m\s+WHERE m\.id = \$2 AND m\.company_id = \$1/);
  });

  test('ignores non-numeric machine ids', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }
    );

    const ids = await svc.setSupervisedMachines(42, company_id, ['abc', null], user.id);

    expect(ids).toEqual([]);
  });
});
