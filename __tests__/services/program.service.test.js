/*
 * Program Transfer, kept simple (21 Oct 2026), with one gateway per company
 * (22 Oct 2026): people upload programs — they wait in line per machine —
 * download files and ask for a backup; S&T makes the company's gateway
 * token; the gateway reads every machine's status in one call, downloads a
 * machine's next program, posts backups and reports. The database is the
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
  test("machines: the company's gateway, and each machine with the program in front of its line, how many wait, the last report, backup and open request", async () => {
    mockDb.queueResponse({ rows: [
      { id: 7, machine_serial_no: 'VMC-1', program_path: ' //CNC_MEM/USER/PATH1/ ', controller_type: 'FANUC', machine_ip: '192.168.1.10',
        next_id: '44', next_name: 'O2002.nc', next_size: 30, next_at: 'T5', waiting: '2',
        next_sent_at: null, next_report_late: false,
        report_id: '40', report_name: 'O1001.nc', delivery_status: 'DONE', delivery_message: null, delivered_at: 'T2b',
        backup_id: '41', backup_name: 'O1001.nc', backup_at: 'T3', request_id: '9', requested_at: 'T4',
        request_closed_at: null, request_error: null, request_waiting: true },
      { id: 8, machine_serial_no: 'VMC-2', next_id: null, waiting: null, report_id: '50', report_name: 'O5000.nc',
        delivery_status: 'FAILED', delivery_message: 'CNC memory full', delivered_at: 'T7', backup_id: null, request_id: null },
      { id: 9, machine_serial_no: 'VMC-3', next_id: null, report_id: null, backup_id: null, request_id: null }
    ], rowCount: 3 },
    one({ id: 1, token_prefix: 'mxg_abcdefgh', created_at: 'T0', last_seen_at: 'T1', last_seen_ip: '203.0.113.9', agent_version: '1.0', online: true }));
    const r = await svc.listMachines(req());
    const [machines, gateway] = mockDb.calls();
    expect(machines.text).toMatch(/WHERE m\.company_id = \$1 AND m\.is_active = true/);
    expect(machines.text).toMatch(/f\.delivery_status IS NULL AND f\.deleted_at IS NULL\s+ORDER BY f\.created_at, f\.id LIMIT 1/);
    expect(machines.text).toMatch(/ORDER BY f\.delivered_at DESC NULLS LAST, f\.id DESC LIMIT 1/);
    expect(machines.text).toMatch(/SELECT m\.id, m\.machine_serial_no, m\.program_path, m\.controller_type, COALESCE\(NULLIF\(btrim\(m\.controller_ip\)/);
    expect(machines.text).toMatch(/ORDER BY id DESC LIMIT 1\) lr/);     // the last backup asked for, in the order they were made
    expect(machines.params).toEqual([5, 30, 10]);                   // 30 min a backup request is offered; 10 min to report
    expect(gateway.text).toMatch(/FROM program_gateway_tokens\s+WHERE company_id = \$1 AND revoked_at IS NULL/);
    expect(gateway.params).toEqual([5, 60]);
    expect(r).toEqual({
      // where it calls from is for S&T, not the company's page
      gateway: { token_prefix: 'mxg_abcdefgh', token_created_at: 'T0', last_seen_at: 'T1', online: true },
      machines: [
        { id: 7, machine_serial_no: 'VMC-1',
          // where its programs go, as the gateway is told — shown on the page so a wrong one is seen
          program_path: '//CNC_MEM/USER/PATH1/', machine_ip: '192.168.1.10', controller_type: 'FANUC',
          next: { id: '44', program_name: 'O2002.nc', size_bytes: 30, created_at: 'T5', sent_to_gateway_at: null, report_late: false },
          waiting: 2,
          last_report: { id: '40', program_name: 'O1001.nc', delivery_status: 'DONE', delivery_message: null, delivered_at: 'T2b' },
          last_backup: { id: '41', program_name: 'O1001.nc', created_at: 'T3' },
          backup_request: { id: '9', requested_at: 'T4' },
          backup_failure: null },
        { id: 8, machine_serial_no: 'VMC-2', program_path: null, machine_ip: null, controller_type: null, next: null, waiting: 0,
          last_report: { id: '50', program_name: 'O5000.nc', delivery_status: 'FAILED', delivery_message: 'CNC memory full', delivered_at: 'T7' },
          last_backup: null, backup_request: null, backup_failure: null },
        { id: 9, machine_serial_no: 'VMC-3', program_path: null, machine_ip: null, controller_type: null,
          next: null, waiting: 0, last_report: null, last_backup: null, backup_request: null, backup_failure: null }
      ]
    });
  });

  test('no gateway token yet: gateway is null', async () => {
    mockDb.queueResponse(none, none);
    await expect(svc.listMachines(req())).resolves.toEqual({ gateway: null, machines: [] });
  });

  /** A machine whose last backup request is in this state. */
  const asked = (id, o) => ({ id, machine_serial_no: `VMC-${id}`, next_id: null, report_id: null, backup_id: null,
    request_id: '9', requested_at: '2026-10-21T05:00:00Z', request_closed_at: null, request_error: null, request_waiting: false, ...o });

  test("a backup the gateway could not read shows — until a backup arrives after it", async () => {
    mockDb.queueResponse({ rows: [
      asked(1, { backup_id: '41', backup_name: 'O1001.nc', backup_at: '2026-10-21T04:00:00Z',
                 request_closed_at: '2026-10-21T05:30:00Z', request_error: 'CNC not reachable' }),
      asked(2, { backup_id: '50', backup_at: '2026-10-21T06:00:00Z', request_closed_at: '2026-10-21T05:30:00Z', request_error: 'CNC not reachable' })
    ], rowCount: 2 }, none);
    const { machines: [failed, recovered] } = await svc.listMachines(req());
    expect(failed.backup_failure).toEqual({ message: 'CNC not reachable', at: '2026-10-21T05:30:00Z' });
    expect(failed.backup_request).toBeNull();
    expect(recovered.backup_failure).toBeNull();
  });

  /* 23 Oct 2026, the user: "upload and backup — are both statuses updated correctly?" */
  test('a backup request the gateway never answered says so once it is no longer offered — not silence', async () => {
    mockDb.queueResponse({ rows: [
      asked(1, {}),                                                                // open, past the 30 minutes
      asked(2, { request_waiting: true }),                                         // open, still offered
      asked(3, { request_closed_at: '2026-10-21T05:10:00Z', backup_id: '60', backup_at: '2026-10-21T05:10:00Z' }) // answered
    ], rowCount: 3 }, none);
    const { machines: [unanswered, waiting, answered] } = await svc.listMachines(req());
    expect(unanswered).toMatchObject({ backup_request: null, backup_failure: { unanswered: true, at: '2026-10-21T05:00:00Z',
      message: 'No answer from the gateway within 30 minutes. Check that it is running, then ask again.' } });
    expect(waiting).toMatchObject({ backup_request: { id: '9', requested_at: '2026-10-21T05:00:00Z' }, backup_failure: null });
    expect(answered).toMatchObject({ backup_request: null, backup_failure: null });
  });

  test('an older failure is not shown for a newer request: only the last request asked for counts', async () => {
    // the old query took the last request WITH an error; a newer one still waiting must win
    mockDb.queueResponse({ rows: [asked(1, { request_waiting: true, requested_at: '2026-10-21T07:00:00Z' })], rowCount: 1 }, none);
    const { machines: [m] } = await svc.listMachines(req());
    expect(m.backup_failure).toBeNull();
    expect(m.backup_request).toEqual({ id: '9', requested_at: '2026-10-21T07:00:00Z' });
  });

  test('the program in front of the line, once the gateway has taken it: when — and late after 10 minutes without a report', async () => {
    mockDb.queueResponse({ rows: [
      { id: 7, machine_serial_no: 'VMC-1', next_id: '44', next_name: 'O2002.nc', next_size: 30, next_at: 'T5', waiting: '1',
        next_sent_at: 'T6', next_report_late: false, report_id: null, backup_id: null, request_id: null },
      { id: 8, machine_serial_no: 'VMC-2', next_id: '45', next_name: 'O3003.nc', next_size: 30, next_at: 'T5', waiting: '3',
        next_sent_at: 'T1', next_report_late: true, report_id: null, backup_id: null, request_id: null }
    ], rowCount: 2 }, none);
    const { machines: [onTime, late] } = await svc.listMachines(req());
    expect(onTime.next).toMatchObject({ id: '44', sent_to_gateway_at: 'T6', report_late: false });
    expect(late.next).toMatchObject({ id: '45', sent_to_gateway_at: 'T1', report_late: true });
    expect(late.waiting).toBe(3);
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

  test('files: newest first, the backups filter, and each upload in line with its place (1 = next)', async () => {
    mockDb.queueResponse(one(machine),
      { rows: [{ id: '45', kind: 'NEW', queue_position: '2' }, { id: '44', kind: 'NEW', queue_position: '1' },
               { id: '41', kind: 'NEW', delivery_status: 'DONE', queue_position: null }], rowCount: 3 },
      one({ total: 3 }));
    const r = await svc.listFiles(req({ query: { machine_id: '7', kind: 'uploads', page: '1', limit: '20' } }));
    const list = mockDb.calls()[1];
    expect(list.params).toEqual([7, 5, ['NEW'], 20, 0]);
    expect(list.text).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY f\.created_at, f\.id\) AS position/);
    expect(r.data.map(f => f.queue_position)).toEqual([2, 1, null]);
    expect(r.data[0]).not.toHaveProperty('is_current');
    expect(r.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });
});

describe('upload', () => {
  test("is saved under the machine's folder and joins the end of its line", async () => {
    mockDb.queueResponse(one(machine), one({ id: '42', machine_id: 7, program_name: 'O1001.nc', kind: 'NEW', created_at: 'T9' }), one({ position: 2 }));
    const file = await svc.upload(req({ body: { machine_id: '7' }, file: stage('%\nO1001\nM30\n%\n') }));
    expect(file).toMatchObject({ id: '42', queue_position: 2 });
    const insert = sql(/INSERT INTO program_files/);
    expect(insert.params.slice(0, 2)).toEqual([5, 7]);
    expect(insert.params[2]).toBe('company-5/programs/machine-7/uploads');
    expect(insert.params.slice(4, 6)).toEqual(['O1001.nc', 'NEW']);
    expect(insert.params.slice(8)).toEqual([2, null]);           // uploaded_by; no gateway
    expect(fs.existsSync(storage.resolveInside(insert.params[2], insert.params[3]))).toBe(true);
    expect(sql(/AS position/).params).toEqual([7, '42']);
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
  test('an upload still in line is deleted from disk and leaves the line', async () => {
    const saved = await storage.saveStream({ machine, kind: 'NEW', programName: 'O0999.nc', filename: stage('%\nO0999\nM30\n%\n').path });
    mockDb.queueResponse(one({ id: '30', machine_id: 7, kind: 'NEW', company_id: 5, program_name: 'O0999.nc', delivery_status: null,
                               folder: saved.folder, stored_name: saved.storedName }));
    await svc.deleteFile(req({ params: { id: '30' } }));
    expect(fs.existsSync(storage.resolveInside(saved.folder, saved.storedName))).toBe(false);
    expect(sql(/UPDATE program_files SET deleted_at/).params).toEqual(['30', 2]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'PROGRAM_DELETE',
      old_value: { program: 'O0999.nc', kind: 'NEW', machine_id: 7, waiting: true } }));
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

describe("S&T: a company's gateway token", () => {
  const snt = { id: 1, company_id: 1, is_snt_super: true, roles: ['SNT_SUPER'] };
  const acme = { id: 5, company_name: 'Acme Gears', is_active: true };

  test('replaces the live token of that company; only its hash is stored, the token is returned once and never audited', async () => {
    mockDb.queueResponse(one(acme), none, none, none, one({ id: 3, token_prefix: 'mxg_x', created_at: 'T0' }), none);
    const r = await svc.createGatewayToken(req({ user: snt, params: { id: '5' } }));
    expect(r.token).toMatch(deviceToken.SHAPE);
    expect(r).toMatchObject({ token_prefix: 'mxg_x', created_at: 'T0', company_name: 'Acme Gears' });
    expect(sql(/FOR UPDATE/).params).toEqual([5]);
    expect(sql(/UPDATE program_gateway_tokens SET revoked_at/).params).toEqual([5, 1]);
    const insert = sql(/INSERT INTO program_gateway_tokens/);
    expect(insert.params).toEqual([5, r.token.slice(0, 12), deviceToken.hash(r.token), 1]);
    expect(JSON.stringify(mockDb.calls())).not.toContain(r.token);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ user_id: 1, company_id: 5, action: 'GATEWAY_TOKEN_CREATE',
      new_value: { company: 'Acme Gears', token_prefix: r.token.slice(0, 12) } }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(r.token);
  });

  test("a company's gateway: its token, when and where from it last called", async () => {
    mockDb.queueResponse(one(acme),
      one({ id: 3, token_prefix: 'mxg_abcdefgh', created_at: 'T0', last_seen_at: 'T1', last_seen_ip: '203.0.113.9', agent_version: 'mexa-gateway 1', online: false }));
    await expect(svc.companyGateway(req({ user: snt, params: { id: '5' } }))).resolves.toEqual({
      company_id: 5, company_name: 'Acme Gears', poll_seconds: 15,
      gateway: { token_prefix: 'mxg_abcdefgh', token_created_at: 'T0', last_seen_at: 'T1', online: false,
                 last_seen_ip: '203.0.113.9', agent_version: 'mexa-gateway 1' }
    });
  });

  test('stopping a token that does not exist says so; an unknown company is not found', async () => {
    mockDb.queueResponse(one(acme), none);
    await expect(svc.revokeGatewayToken(req({ user: snt, params: { id: '5' } })))
      .rejects.toMatchObject({ status: 404, code: 'NO_TOKEN', message: 'Acme Gears has no gateway token.' });
    mockDb.queueResponse(none);
    await expect(svc.createGatewayToken(req({ user: snt, params: { id: '99' } }))).rejects.toMatchObject({ status: 404, code: 'COMPANY_NOT_FOUND' });
    expect(sql(/INSERT INTO program_gateway_tokens/)).toBeUndefined();
  });

  test('stopping the token is audited against the company', async () => {
    mockDb.queueResponse(one(acme), one({ id: 3, token_prefix: 'mxg_abcdefgh' }));
    await svc.revokeGatewayToken(req({ user: snt, params: { id: '5' } }));
    expect(sql(/UPDATE program_gateway_tokens SET revoked_at/).params).toEqual([5, 1]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ company_id: 5, action: 'GATEWAY_TOKEN_REVOKE' }));
  });
});

describe('the gateway side: one token, every machine', () => {
  const gateway = { id: 3, company_id: 5, company_name: 'Acme Gears' };
  const vmc1 = (o = {}) => ({ ...machine, is_active: true, machine_ip: '192.168.1.10', ...o });

  /* 23 Oct 2026, the user: "machine_id, not the name; the controller name, the api_key and the program path
     from the Machines page in the status" */
  test('status: every machine of the token\'s company — its id, name, IP, controller, api_key and program path — one query, and how often to ask', async () => {
    mockDb.queueResponse({ rows: [
      { machine_id: '7', machine_serial_no: 'VMC-1', machine_ip: '192.168.1.10', controller: 'FANUC 0i-MF', controller_type: 'FANUC', api_key: 'k'.repeat(32),
        program_path: ' //CNC_MEM/USER/PATH1/ ', file_id: '42', program_name: 'O1001.nc', size_bytes: 24,
        sha256: 'a'.repeat(64), created_at: 'T0', waiting: '3', request_id: '9', requested_at: 'T1' },
      { machine_id: '8', machine_serial_no: 'VMC-2', machine_ip: null, controller: 'M80', controller_type: 'MITSUBISHI', api_key: null, program_path: '',
        file_id: null, waiting: null, request_id: null }
    ], rowCount: 2 });
    await expect(svc.gatewayStatus(gateway)).resolves.toEqual({
      company: 'Acme Gears',
      machines: [
        { machine_id: 7, machine: 'VMC-1', machine_ip: '192.168.1.10', controller_name: 'FANUC 0i-MF', controller_type: 'FANUC', api_key: 'k'.repeat(32),
          program_path: '//CNC_MEM/USER/PATH1/',
          program: { file_id: 42, program_name: 'O1001.nc', size_bytes: 24, sha256: 'a'.repeat(64), uploaded_at: 'T0' },
          programs_waiting: 3, backup_request: { id: 9, requested_at: 'T1' } },
        { machine_id: 8, machine: 'VMC-2', machine_ip: null, controller_name: 'M80', controller_type: 'MITSUBISHI', api_key: null, program_path: null,
          program: null, programs_waiting: 0, backup_request: null }
      ],
      poll_seconds: 15
    });
    expect(mockDb.calls()).toHaveLength(1);
    expect(mockDb.calls()[0].params).toEqual([5, 30]);
    expect(mockDb.calls()[0].text).toMatch(/m\.id AS machine_id, m\.machine_serial_no, .* m\.controller, m\.controller_type, m\.api_key, m\.program_path/);
  });

  describe('which machine a call is about', () => {
    const find = input => svc._internal.machineOf(gateway, input);

    test('by machine_id, as GET /status lists it — inside the token\'s company; a name or IP sent with it must be its own', async () => {
      mockDb.queueResponse(one(vmc1()), one(vmc1()), one(vmc1()));
      await expect(find({ machine_id: 7 })).resolves.toMatchObject({ id: 7, machine_serial_no: 'VMC-1' });
      await expect(find({ machine_id: ' 7 ', machine: 'vmc-1', machine_ip: '192.168.1.10' })).resolves.toMatchObject({ id: 7 });
      await expect(find({ machine_id: '7', machine: 'VMC-2' })).rejects.toMatchObject({ status: 400, code: 'MACHINE_MISMATCH',
        message: 'machine_id 7 is VMC-1 (192.168.1.10), not "VMC-2".' });
      expect(mockDb.calls().map(c => c.params)).toEqual([[7, 5], [7, 5], [7, 5]]);
      expect(mockDb.calls()[0].text).toMatch(/WHERE m\.id = \$1 AND m\.company_id = \$2/);

      resetDb();
      mockDb.queueResponse(none, one(vmc1({ is_active: false })));
      await expect(find({ machine_id: 70 })).rejects.toMatchObject({ status: 404, code: 'MACHINE_NOT_FOUND',
        message: 'No machine 70 in Acme Gears. Use the machine_id GET /status lists.' });
      await expect(find({ machine_id: 7 })).rejects.toMatchObject({ status: 403, code: 'MACHINE_INACTIVE' });
      for (const bad of ['VMC-1', '7.5', '-1', '0', 1e12, '{{machineId}}']) {
        await expect(find({ machine_id: bad })).rejects.toMatchObject({ status: 400, code: 'BAD_MACHINE_ID' });
      }
      expect(mockDb.calls()).toHaveLength(2);                          // nothing asked for a malformed id
    });

    test('by name (any case, spaces trimmed), by IP, or both — always inside the token\'s company', async () => {
      mockDb.queueResponse(one(vmc1()), one(vmc1()), one(vmc1()));
      await expect(find({ machine: ' vmc-1 ' })).resolves.toMatchObject({ id: 7, machine_serial_no: 'VMC-1' });
      await expect(find({ machine_ip: '192.168.1.10' })).resolves.toMatchObject({ id: 7 });
      await expect(find({ machine: 'VMC-1', machine_ip: '192.168.1.10' })).resolves.toMatchObject({ id: 7 });
      expect(mockDb.calls().map(c => c.params)).toEqual([[5, 'vmc-1', null], [5, null, '192.168.1.10'], [5, 'VMC-1', '192.168.1.10']]);
      expect(mockDb.calls()[0].text).toMatch(/lower\(btrim\(m\.machine_serial_no\)\) = lower\(\$2::text\)/);
    });

    test('nothing named: 400; two of the same name: 409 with what to send; switched off: 403; unknown: 404 naming the company', async () => {
      await expect(find({})).rejects.toMatchObject({ status: 400, code: 'MACHINE_REQUIRED', message: 'Say which machine: "machine_id", as GET /status lists it.' });
      expect(mockDb.calls()).toHaveLength(0);

      mockDb.queueResponse({ rows: [vmc1(), vmc1({ id: 8, machine_ip: '192.168.1.11' })], rowCount: 2 });
      await expect(find({ machine: 'VMC-1' })).rejects.toMatchObject({ status: 409, code: 'MACHINE_AMBIGUOUS',
        message: '2 machines are named "VMC-1". Send "machine_ip" as well, or give them different names on the Machines page.' });

      mockDb.queueResponse(one(vmc1({ is_active: false })));
      await expect(find({ machine: 'VMC-1' })).rejects.toMatchObject({ status: 403, code: 'MACHINE_INACTIVE', message: 'VMC-1 is switched off in MEXA.' });

      mockDb.queueResponse(none, none, none);
      await expect(find({ machine: 'VMC-9' })).rejects.toMatchObject({ status: 404, code: 'MACHINE_NOT_FOUND',
        message: 'No machine "VMC-9" in Acme Gears. Use the machine_id GET /status lists.' });
      await expect(find({ machine_ip: '10.0.0.9' })).rejects.toMatchObject({
        message: 'No machine with IP 10.0.0.9 in Acme Gears. Use the machine_id GET /status lists.' });
      await expect(find({ machine: 'VMC-1', machine_ip: '10.0.0.9' })).rejects.toMatchObject({
        message: 'No machine "VMC-1" with IP 10.0.0.9 in Acme Gears. Use the machine_id GET /status lists.' });
    });

    test('an old machine that shares a name with a switched-on one does not get in the way', async () => {
      mockDb.queueResponse({ rows: [vmc1({ id: 3, is_active: false }), vmc1()], rowCount: 2 });
      await expect(find({ machine: 'VMC-1' })).resolves.toMatchObject({ id: 7 });
    });
  });

  test('program: the oldest upload still in line; none waiting is a 404 the gateway can read', async () => {
    mockDb.queueResponse(one(vmc1()), one({ id: '42', program_name: 'O1001.nc' }));
    await expect(svc.gatewayProgram(gateway, { machine: 'VMC-1' })).resolves.toMatchObject({ machine: { id: 7 }, program: { id: '42' } });
    const [, line, taken] = mockDb.calls();
    expect(line.params).toEqual([7]);
    expect(line.text).toMatch(/f\.kind = 'NEW' AND f\.delivery_status IS NULL AND f\.deleted_at IS NULL\s+ORDER BY f\.created_at, f\.id\s+LIMIT 1/);
    // handed out, it is with the gateway until the gateway reports — only while it is still in line
    expect(taken.text).toMatch(/UPDATE program_files f SET sent_to_gateway_at = NOW\(\) WHERE f\.id = \$1 AND f\.kind = 'NEW' AND f\.delivery_status IS NULL AND f\.deleted_at IS NULL/);
    expect(taken.params).toEqual(['42']);

    mockDb.queueResponse(one(vmc1()), none);
    await expect(svc.gatewayProgram(gateway, { machine: 'VMC-1' })).rejects.toMatchObject({ status: 404, code: 'NO_PROGRAM',
      message: 'Nothing is waiting for VMC-1.' });
  });

  test('backup: saved as a backup of the machine named, answers its open request and tells who asked', async () => {
    mockDb.queueResponse(one(vmc1()),
      one({ id: '43', machine_id: 7, program_name: 'O1001.nc', kind: 'BACKUP', size_bytes: 14, sha256: 'b'.repeat(64), created_at: 'T2' }),
      one({ id: '9', requested_by: 2 }), none);
    const r = await svc.gatewayBackup(gateway, stage('%\nO1001\nM30\n%\n'), { machine_id: '7', program_name: 'O1001.nc' });
    expect(r).toEqual({ machine_id: 7, machine: 'VMC-1', file: { file_id: 43, program_name: 'O1001.nc', size_bytes: 14, sha256: 'b'.repeat(64), uploaded_at: 'T2' },
                        answered_request: 9 });
    const insert = sql(/INSERT INTO program_files/);
    expect(insert.params[2]).toBe('company-5/programs/machine-7/backups');
    expect(insert.params[5]).toBe('BACKUP');
    expect(insert.params.slice(8)).toEqual([null, 3]);   // no person; the gateway
    expect(sql(/UPDATE program_backup_requests SET closed_at = NOW\(\), file_id = \$2/).params).toEqual([7, '43']);
    const note = sql(/INSERT INTO notifications/);
    expect(note.text).toMatch(/notify_program_transfer = false/);
    // the link opens Program Transfer on this machine with the backup marked
    expect(note.params).toEqual([5, 2, 'INFO', 'Backup received — VMC-1', '"O1001.nc" was saved from VMC-1.', '/programs?machine_id=7&file_id=43']);
  });

  test('a backup nobody asked for is kept, and no one is notified; one for no machine is refused before anything is saved', async () => {
    mockDb.queueResponse(one(vmc1()), one({ id: '44', program_name: 'O1001.nc' }), none);
    const r = await svc.gatewayBackup(gateway, stage('%\nO1001\nM30\n%\n'), { machine_ip: '192.168.1.10' });
    expect(r.answered_request).toBeNull();
    expect(sql(/INSERT INTO notifications/)).toBeUndefined();

    resetDb();
    await expect(svc.gatewayBackup(gateway, stage('%\nO1001\nM30\n%\n'), {})).rejects.toMatchObject({ status: 400, code: 'MACHINE_REQUIRED' });
    expect(sql(/INSERT INTO program_files/)).toBeUndefined();
  });
});

describe('the gateway reports what happened — and the line moves on', () => {
  const gateway = { id: 3, company_id: 5, company_name: 'Acme Gears' };
  const reported = (o = {}) => one({ id: '42', machine_id: 7, program_name: 'O1001.nc', uploaded_by: 2, machine_serial_no: 'VMC-1', ...o });
  const next = one({ id: '43', program_name: 'O1002.nc', size_bytes: 30, sha256: 'c'.repeat(64), created_at: 'T3' });

  test("DONE: the program is on the machine, the uploader is told, and the answer names the machine's next program", async () => {
    mockDb.queueResponse(reported(), none, next);
    await expect(svc.gatewayReport(gateway, { file_id: 42, status: 'done' })).resolves.toEqual({
      file_id: 42, machine_id: 7, machine: 'VMC-1', status: 'DONE',
      next_program: { file_id: 43, program_name: 'O1002.nc', size_bytes: 30, sha256: 'c'.repeat(64), uploaded_at: 'T3' }
    });
    const update = sql(/UPDATE program_files f SET delivery_status/);
    expect(update.params).toEqual([42, 5, 'DONE', null, null]);
    expect(update.text).toMatch(/f\.company_id = \$2 AND f\.kind = 'NEW'/);           // only this company's uploads
    expect(sql(/INSERT INTO notifications/).params).toEqual([5, 2, 'INFO', 'Program on VMC-1', '"O1001.nc" was written to VMC-1.',
      '/programs?machine_id=7&file_id=42']);
    expect(mockDb.calls().at(-1).params).toEqual([7]);                                // the line of that machine
  });

  test('FAILED: the reason is kept, the uploader is warned, and the line moves on all the same', async () => {
    mockDb.queueResponse(reported(), none, none);
    await expect(svc.gatewayReport(gateway, { file_id: 42, status: 'FAILED', message: '  CNC memory full  ' }))
      .resolves.toMatchObject({ status: 'FAILED', next_program: null });
    expect(sql(/UPDATE program_files f SET delivery_status/).params).toEqual([42, 5, 'FAILED', 'CNC memory full', null]);
    expect(sql(/INSERT INTO notifications/).params.slice(2)).toEqual(['WARNING', 'Program not accepted — VMC-1',
      'VMC-1 could not use "O1001.nc": CNC memory full', '/programs?machine_id=7&file_id=42']);
  });

  test('a machine_id sent with the report must be the program\'s machine', async () => {
    mockDb.queueResponse(one({ id: 8, company_id: 5, machine_serial_no: 'VMC-2', is_active: true }), none,
      one({ id: '42', kind: 'NEW', machine_id: 7, machine_serial_no: 'VMC-1' }));
    await expect(svc.gatewayReport(gateway, { file_id: 42, machine_id: 8, status: 'DONE' })).rejects.toMatchObject({
      status: 400, code: 'MACHINE_MISMATCH', message: 'Program 42 is for VMC-1, not VMC-2.' });
    expect(mockDb.calls()[0].params).toEqual([8, 5]);
  });

  test('a machine name sent with the report (an older gateway) must be the program\'s machine too', async () => {
    mockDb.queueResponse(one({ id: 8, company_id: 5, machine_serial_no: 'VMC-2', is_active: true }), none,
      one({ id: '42', kind: 'NEW', machine_id: 7, machine_serial_no: 'VMC-1' }));
    await expect(svc.gatewayReport(gateway, { file_id: 42, machine: 'VMC-2', status: 'DONE' })).rejects.toMatchObject({
      status: 400, code: 'MACHINE_MISMATCH', message: 'Program 42 is for VMC-1, not VMC-2.' });
    expect(sql(/UPDATE program_files f SET delivery_status/).params[4]).toBe(8);         // nothing of VMC-1 was changed
  });

  test('the same report again (a retry) changes nothing and tells no one twice', async () => {
    mockDb.queueResponse(none, one({ id: '42', kind: 'NEW', machine_id: 7, machine_serial_no: 'VMC-1' }), none);
    await expect(svc.gatewayReport(gateway, { file_id: 42, status: 'DONE' }))
      .resolves.toEqual({ file_id: 42, machine_id: 7, machine: 'VMC-1', status: 'DONE', unchanged: true, next_program: null });
    expect(sql(/INSERT INTO notifications/)).toBeUndefined();
  });

  test('no such program in the company, a backup\'s id, or text where the number goes: each says what to send', async () => {
    mockDb.queueResponse(none, none);
    await expect(svc.gatewayReport(gateway, { file_id: 42, status: 'DONE' })).rejects.toMatchObject({ status: 404, code: 'FILE_NOT_FOUND',
      message: 'No program 42 in Acme Gears. Report the file_id GET /status lists under the machine (program.file_id), or the X-File-Id header of GET /program.' });

    // the gateway reporting the backup it just sent — the 201 already finished that
    mockDb.queueResponse(none, one({ id: '20', kind: 'BACKUP', machine_id: 7, machine_serial_no: 'VMC-1' }));
    await expect(svc.gatewayReport(gateway, { file_id: 20, status: 'DONE' })).rejects.toMatchObject({ status: 400, code: 'BACKUP_NEEDS_NO_REPORT',
      message: '20 is a backup the gateway sent. A backup needs no report: the 201 from POST /backup already finished it. Report DONE or FAILED only for a program from GET /status (program.file_id).' });

    // the Postman variable left unfilled
    await expect(svc.gatewayReport(gateway, { file_id: '{{fileId}}', status: 'DONE' })).rejects.toMatchObject({ status: 404, code: 'FILE_NOT_FOUND',
      message: 'file_id must be a number: program.file_id from GET /status (or the X-File-Id header of GET /program).' });
  });

  test.each([
    [{ file_id: 42, status: 'OK' }, 'BAD_STATUS'],
    [{ file_id: 42, status: 'FAILED' }, 'NO_MESSAGE'],
    [{ status: 'DONE' }, 'NOTHING_TO_REPORT'],
    [{ backup_request_id: 9, status: 'DONE' }, 'BAD_STATUS']
  ])('%j is refused with %s', async (body, code) => {
    await expect(svc.gatewayReport(gateway, body)).rejects.toMatchObject({ status: 400, code });
    expect(sql(/UPDATE/)).toBeUndefined();
  });

  test('a backup that could not be read closes the request and warns who asked', async () => {
    mockDb.queueResponse(one({ id: '9', machine_id: 7, requested_by: 2, machine_serial_no: 'VMC-1' }), none);
    await expect(svc.gatewayReport(gateway, { backup_request_id: 9, status: 'FAILED', message: 'CNC not reachable' }))
      .resolves.toEqual({ backup_request_id: 9, machine_id: 7, machine: 'VMC-1', status: 'FAILED' });
    const update = sql(/UPDATE program_backup_requests r SET closed_at = NOW\(\), error_message = \$3/);
    expect(update.params).toEqual([9, 5, 'CNC not reachable', null]);
    expect(update.text).toMatch(/r\.company_id = \$2/);
    expect(sql(/INSERT INTO notifications/).params.slice(2)).toEqual(['WARNING', 'Backup failed — VMC-1',
      'VMC-1 could not send a backup: CNC not reachable', '/programs?machine_id=7']);
  });

  test("a backup request already closed: unchanged; another company's: not found", async () => {
    mockDb.queueResponse(none, one({ id: '9', machine_id: 7, machine_serial_no: 'VMC-1' }));
    await expect(svc.gatewayReport(gateway, { backup_request_id: 9, status: 'FAILED', message: 'x' }))
      .resolves.toEqual({ backup_request_id: 9, machine_id: 7, machine: 'VMC-1', status: 'FAILED', unchanged: true });
    resetDb();
    mockDb.queueResponse(none, none);
    await expect(svc.gatewayReport(gateway, { backup_request_id: 10, status: 'FAILED', message: 'x' }))
      .rejects.toMatchObject({ status: 404, code: 'REQUEST_NOT_FOUND', message: 'No backup request 10 in Acme Gears. Use backup_request.id from GET /status.' });
  });
});
