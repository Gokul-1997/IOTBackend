/*
 * tools/gateway/mexa-gateway.js — the program on the factory network that
 * moves uploaded programs into the machines, and their backups out, with the
 * company's one token (22 Oct 2026: one token and one status call for every
 * machine; programs go one after the other per machine).
 *
 * First against the real /api/device/v1 routes over HTTP (the database is a
 * small in-memory stand-in, files go to a temporary storage folder), then
 * the edge cases against a scripted server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mexa-gw-'));
process.env.STORAGE_ROOT = path.join(TMP, 'storage');

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const express = require('express');
const { mockDb, resetDb } = require('../helpers/mockDb');
const deviceToken = require('../../src/programs/device-token');
const storage = require('../../src/programs/storage');
const { createGateway, safeName, folderName } = require('../../tools/gateway/mexa-gateway');

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const one = row => ({ rows: [row], rowCount: 1 });
const none = { rows: [], rowCount: 0 };

describe('against the real gateway API', () => {
  const { token } = deviceToken.generate();
  let server, url, db;

  /* The few rows the four calls read and write, answered by what each query asks. */
  function fakeDatabase() {
    const state = {
      machines: [{ id: 7, company_id: 5, machine_serial_no: 'VMC-1', is_active: true, machine_ip: '192.168.1.10', controller: 'FANUC 0i-MF',
                   api_key: 'a'.repeat(32), program_path: '//CNC_MEM/USER/PATH1/' },
                 { id: 8, company_id: 5, machine_serial_no: 'VMC-2', is_active: true, machine_ip: null, controller: null, api_key: null, program_path: null }],
      files: [], requests: [], statusCalls: 0
    };
    const waiting = machineId => state.files.filter(f => f.machine_id === machineId && f.kind === 'NEW' && !f.delivery_status);
    const byName = id => state.machines.find(m => m.id === id).machine_serial_no;
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (/FROM program_gateway_tokens g/.test(text)) {
        return params[0] === deviceToken.hash(token)
          ? one({ id: 3, company_id: 5, last_seen_at: new Date().toISOString(), last_seen_ip: '127.0.0.1',
                  agent_version: 'mexa-gateway 3', company_name: 'Acme Gears', company_active: true })
          : none;
      }
      if (/FROM machines m\s+LEFT JOIN LATERAL/.test(text)) {                       // GET /status: every machine at once
        state.statusCalls += 1;
        return { rows: state.machines.map(m => {
          const line = waiting(m.id), head = line[0], request = state.requests.find(r => r.machine_id === m.id && !r.closed_at);
          return { machine_id: m.id, machine_serial_no: m.machine_serial_no, machine_ip: m.machine_ip, controller: m.controller,
                   api_key: m.api_key, program_path: m.program_path, file_id: head?.id ?? null,
                   program_name: head?.program_name, size_bytes: head?.size_bytes, sha256: head?.sha256, created_at: head?.created_at,
                   waiting: line.length ? String(line.length) : null, request_id: request?.id ?? null, requested_at: request?.requested_at };
        }) };
      }
      if (/FROM machines m WHERE m\.id = \$1 AND m\.company_id = \$2/.test(text)) {      // which machine a call names: its machine_id
        const m = state.machines.find(x => x.id === params[0] && x.company_id === params[1]);
        return m ? one(m) : none;
      }
      if (/lower\(btrim\(m\.machine_serial_no\)\)/.test(text)) {                     // …or, from an older gateway, its name
        const rows = state.machines.filter(m => (params[1] == null || m.machine_serial_no.toLowerCase() === params[1].toLowerCase())
          && (params[2] == null || m.machine_ip === params[2]));
        return { rows, rowCount: rows.length };
      }
      if (/WHERE f\.machine_id = \$1 AND f\.kind = 'NEW' AND f\.delivery_status IS NULL/.test(text)) {   // the machine's next program
        const head = waiting(params[0])[0];
        return head ? one(head) : none;
      }
      if (/UPDATE program_files f SET delivery_status/.test(text)) {
        const f = state.files.find(x => x.id === String(params[0]) && x.kind === 'NEW' && (params[4] == null || x.machine_id === params[4]));
        if (!f || (f.delivery_status === params[2] && f.delivery_message === params[3])) return none;
        Object.assign(f, { delivery_status: params[2], delivery_message: params[3] });
        return one({ id: f.id, machine_id: f.machine_id, program_name: f.program_name, uploaded_by: null, machine_serial_no: byName(f.machine_id) });
      }
      if (/INSERT INTO program_files/.test(text)) {
        const row = { id: String(100 + state.files.length), machine_id: params[1], folder: params[2], stored_name: params[3],
                      program_name: params[4], kind: params[5], size_bytes: params[6], sha256: params[7], gateway_token_id: params[9], created_at: 'T1' };
        state.files.push(row);
        return one(row);
      }
      if (/UPDATE program_backup_requests SET closed_at = NOW\(\), file_id/.test(text)) {
        const r = state.requests.find(x => x.machine_id === params[0] && !x.closed_at);
        if (!r) return none;
        Object.assign(r, { closed_at: 'now', file_id: params[1] });
        return one({ id: r.id, requested_by: null });
      }
      if (/UPDATE program_backup_requests r SET closed_at = NOW\(\), error_message/.test(text)) {
        const r = state.requests.find(x => x.id === String(params[0]) && !x.closed_at);
        if (!r) return none;
        Object.assign(r, { closed_at: 'now', error_message: params[2] });
        return one({ id: r.id, machine_id: r.machine_id, requested_by: null, machine_serial_no: byName(r.machine_id) });
      }
      return none;
    });
    return state;
  }

  /** What a person's upload on the Program Transfer page leaves behind: the file, and its row (at the end of the line). */
  async function uploaded(machineId, text, name) {
    const source = path.join(TMP, `upload-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(source, text);
    const saved = await storage.saveStream({ machine: { id: machineId, company_id: 5 }, kind: 'NEW', programName: name, filename: source });
    db.files.push({ id: String(81 + db.files.length), machine_id: machineId, program_name: saved.programName, kind: 'NEW', folder: saved.folder,
                    stored_name: saved.storedName, size_bytes: saved.size, sha256: saved.sha256, created_at: 'T0',
                    delivery_status: null, delivery_message: null, delivered_at: null });
  }

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', false);
    app.use(express.json());
    app.use('/api/device/v1', require('../../src/programs/device.routes'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => { resetDb(); db = fakeDatabase(); });
  afterEach(() => mockDb.query.mockReset());

  test('one status call for every machine; two programs for one machine go one after the other, byte for byte, each reported DONE', async () => {
    const first = '%\nO1001 (FACE MILL)\nG21 G90\nG0 X25. Y10.\nM30\n%\n';
    const second = '%\nO1002 (DRILL)\nG81 Z-5. R2.\nM30\n%\n';
    const other = '%\nO2001\nM30\n%\n';
    await uploaded(7, first, 'O1001.nc');
    await uploaded(7, second, 'O1002.nc');
    await uploaded(8, other, 'O2001.nc');
    const dir = path.join(TMP, 'factory-a');
    const lines = [];
    const gateway = createGateway({ url, token, programDir: dir, log: l => lines.push(l) });

    const status = await gateway.tick();
    expect(db.statusCalls).toBe(1);
    expect(status.company).toBe('Acme Gears');
    expect(status.machines.map(m => [m.machine_id, m.machine, m.programs_waiting])).toEqual([[7, 'VMC-1', 2], [8, 'VMC-2', 1]]);
    expect(status.machines[0]).toMatchObject({ controller_name: 'FANUC 0i-MF', api_key: 'a'.repeat(32), program_path: '//CNC_MEM/USER/PATH1/' });
    // the CNC's own folder is for a gateway that talks to the CNC; this one writes only under PROGRAM_DIR
    expect(fs.existsSync(path.join(dir, 'VMC-1'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'VMC-1', 'O1001.nc'), 'utf8')).toBe(first);
    expect(fs.readFileSync(path.join(dir, 'VMC-1', 'O1002.nc'), 'utf8')).toBe(second);
    expect(fs.readFileSync(path.join(dir, 'VMC-2', 'O2001.nc'), 'utf8')).toBe(other);
    expect(db.files.map(f => f.delivery_status)).toEqual(['DONE', 'DONE', 'DONE']);
    // in line: O1001 before O1002
    expect(lines.filter(l => l.startsWith('VMC-1'))).toEqual([`VMC-1: O1001.nc written (${Buffer.byteLength(first)} bytes)`, `VMC-1: O1002.nc written (${Buffer.byteLength(second)} bytes)`]);
    expect(fs.readdirSync(path.join(dir, 'VMC-1')).sort()).toEqual(['O1001.nc', 'O1002.nc']);   // no half-written file left behind

    // the next round finds nothing waiting and leaves the machines alone
    fs.writeFileSync(path.join(dir, 'VMC-1', 'O1001.nc'), 'edited on the machine');
    await gateway.tick();
    expect(db.statusCalls).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'VMC-1', 'O1001.nc'), 'utf8')).toBe('edited on the machine');
    expect(lines.join('\n')).not.toContain(token);
  });

  test('MACHINE_DIRS: only the machines named are served here, into their own folders; the rest wait for their gateway', async () => {
    await uploaded(7, 'M30\n', 'O1001.nc');
    await uploaded(8, 'M30\n', 'O2001.nc');
    const share = path.join(TMP, 'cnc01-share');
    await createGateway({ url, token, machineDirs: { 'vmc-1': share } }).tick();
    expect(fs.readFileSync(path.join(share, 'O1001.nc'), 'utf8')).toBe('M30\n');
    expect(db.files.map(f => f.delivery_status)).toEqual(['DONE', null]);
  });

  test('Backup now: the newest program in that machine\'s folder is sent back and answers its request', async () => {
    const dir = path.join(TMP, 'factory-b');
    fs.mkdirSync(path.join(dir, 'VMC-2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'VMC-2', 'O0001.nc'), '%\nO0001\nM30\n%\n');
    const newest = path.join(dir, 'VMC-2', 'O2002.nc');
    fs.writeFileSync(newest, '%\nO2002\nG0 Z5.\nM30\n%\n');
    fs.utimesSync(newest, new Date(), new Date(Date.now() + 1000));
    db.requests.push({ id: '9', machine_id: 8, requested_at: 'T0', closed_at: null });

    await createGateway({ url, token, programDir: dir }).tick();
    const backup = db.files.find(f => f.kind === 'BACKUP');
    expect(backup).toMatchObject({ program_name: 'O2002.nc', machine_id: 8, gateway_token_id: 3 });
    expect(fs.readFileSync(path.join(process.env.STORAGE_ROOT, backup.folder, backup.stored_name), 'utf8'))
      .toBe('%\nO2002\nG0 Z5.\nM30\n%\n');
    expect(db.requests[0]).toMatchObject({ closed_at: 'now', file_id: backup.id });
  });

  test('nothing in the folder to back up: the page is told why, instead of waiting 30 minutes', async () => {
    db.requests.push({ id: '9', machine_id: 7, requested_at: 'T0', closed_at: null });
    await createGateway({ url, token, programDir: path.join(TMP, 'empty-factory') }).tick();
    expect(db.requests[0].error_message).toMatch(/^No program in .*empty-factory.VMC-1 to back up$/);
  });

  test('a wrong token, or an old machine token, stops the gateway with a sentence a person can act on', async () => {
    for (const wrong of ['mxg_' + 'x'.repeat(43), 'mxd_' + 'x'.repeat(43)]) {
      const lines = [];
      const gateway = createGateway({ url, token: wrong, programDir: TMP, log: l => lines.push(l) });
      await expect(gateway.run()).rejects.toMatchObject({ status: 401, fatal: true });
      expect(lines.at(-1)).toMatch(/^Stopped: .*ask S&T for your company's gateway token\.$/i);
    }
  });
});

describe('edge cases, against a scripted server', () => {
  const crypto = require('crypto');
  const sum = text => crypto.createHash('sha256').update(text).digest('hex');

  /** A fetch that answers from a script and records what it was sent. */
  function scripted(routes) {
    const sent = [];
    const fetch = async (address, init) => {
      const route = `${init.method} ${new URL(address).pathname.replace('/api/device/v1', '')}`;
      sent.push({ route, address, init });
      const answer = routes[route];
      if (!answer) return new Response(JSON.stringify({ status: 'error', code: 'NOT_FOUND' }), { status: 404 });
      return typeof answer === 'function' ? answer(init) : answer();
    };
    return { fetch, sent, reports: () => sent.filter(s => s.route === 'POST /report').map(s => JSON.parse(s.init.body)) };
  }
  const status = (program, backup_request = null, o = { machine_id: 7 }) => () => new Response(JSON.stringify({
    company: 'Acme Gears',
    machines: [{ ...o, machine: 'VMC-1', machine_ip: '192.168.1.10', program, programs_waiting: program ? 1 : 0, backup_request }],
    poll_seconds: 15 }), { status: 200 });
  const file = (text, headers = {}) => () => new Response(text, { status: 200, headers: {
    'X-File-Id': '42', 'X-Program-Name': encodeURIComponent('O1001.nc'), 'X-Sha256': sum(text), ...headers } });
  const ok = () => new Response(JSON.stringify({ status: 'DONE', next_program: null }), { status: 200 });
  const waiting = { file_id: 42, program_name: 'O1001.nc', sha256: 'x' };
  const dirOf = name => path.join(TMP, name);

  test('the program is asked for by the machine_id, and the report names the machine_id too', async () => {
    const api = scripted({ 'GET /status': status(waiting), 'GET /program': file('G0 X1'), 'POST /report': ok });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('by-id'), fetch: api.fetch }).tick();
    expect(api.sent[1].address).toBe('https://mexa.test/api/device/v1/program?machine_id=7');
    expect(api.reports()).toEqual([{ file_id: 42, machine_id: 7, status: 'DONE' }]);
  });

  test('a server from before machine ids: the machine\'s name, as before', async () => {
    const api = scripted({ 'GET /status': status(waiting, null, {}), 'GET /program': file('G0 X1'), 'POST /report': ok });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('named'), fetch: api.fetch }).tick();
    expect(api.sent[1].address).toBe('https://mexa.test/api/device/v1/program?machine=VMC-1');
    expect(api.reports()).toEqual([{ file_id: 42, machine: 'VMC-1', status: 'DONE' }]);
  });

  test('a damaged download is not written, and the page says so', async () => {
    const api = scripted({ 'GET /status': status(waiting), 'GET /program': file('G0 X1', { 'X-Sha256': sum('something else') }), 'POST /report': ok });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('dmg'), fetch: api.fetch }).tick();
    expect(fs.existsSync(path.join(dirOf('dmg'), 'VMC-1', 'O1001.nc'))).toBe(false);
    expect(api.reports()).toEqual([{ file_id: 42, machine_id: 7, status: 'FAILED',
      message: 'The file arrived damaged (its SHA-256 does not match); upload it again' }]);
  });

  test.each(['../evil.nc', '..', 'a/b.nc', 'C:\\x.nc', '.hidden'])('a name like %j never becomes a path: refused and reported', async name => {
    const api = scripted({ 'GET /status': status(waiting), 'POST /report': ok,
                           'GET /program': file('G0 X1', { 'X-Program-Name': encodeURIComponent(name) }) });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('names'), fetch: api.fetch }).tick();
    expect(api.reports()[0]).toMatchObject({ file_id: 42, status: 'FAILED', message: expect.stringMatching(/not a usable program name/) });
    expect(fs.existsSync(path.join(TMP, 'evil.nc'))).toBe(false);
    expect(fs.existsSync(path.join(dirOf('names'), 'evil.nc'))).toBe(false);
  });

  test('a machine name that is not a folder name still gets a folder of its own, inside PROGRAM_DIR', () => {
    const gateway = createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('folders') });
    expect(gateway.folderOf('VMC/01: Bay 2')).toBe(path.join(dirOf('folders'), 'VMC_01_ Bay 2'));
    expect(gateway.folderOf('..')).toBe(path.join(dirOf('folders'), '_'));
    expect(folderName('  ')).toBe('machine');
  });

  test('the machine folder cannot be written: the reason goes to the page', async () => {
    const blocker = dirOf('blocked');
    fs.writeFileSync(blocker, 'a file where the folder should be');
    const api = scripted({ 'GET /status': status(waiting), 'GET /program': file('G0 X1'), 'POST /report': ok });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: blocker, fetch: api.fetch }).tick();
    expect(api.reports()[0]).toMatchObject({ file_id: 42, status: 'FAILED', message: expect.stringMatching(/EEXIST|ENOTDIR/) });
  });

  test('the server failing is tried again later — never reported to the person as the machine\'s fault', async () => {
    const api = scripted({ 'GET /status': status(waiting), 'GET /program': () => new Response('{"message":"busy"}', { status: 503 }), 'POST /report': ok });
    await expect(createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('busy'), fetch: api.fetch }).tick())
      .rejects.toMatchObject({ status: 503, fatal: false });
    expect(api.reports()).toEqual([]);
  });

  test('a program deleted on the page between /status and the download is skipped, not an error', async () => {
    const api = scripted({ 'GET /status': status(waiting),
      'GET /program': () => new Response(JSON.stringify({ code: 'NO_PROGRAM', message: 'Nothing is waiting for VMC-1.' }), { status: 404 }) });
    await expect(createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('gone'), fetch: api.fetch }).tick()).resolves.toBeTruthy();
    expect(api.reports()).toEqual([]);
  });

  test('after DONE the next program of the machine goes at once — at most ten in a round', async () => {
    let n = 0;
    const api = scripted({ 'GET /status': status(waiting), 'GET /program': file('G0 X1'),
      'POST /report': () => new Response(JSON.stringify({ status: 'DONE', next_program: ++n < 3 ? { file_id: 42 + n } : null }), { status: 200 }) });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('line'), fetch: api.fetch }).tick();
    expect(api.sent.filter(s => s.route === 'GET /program')).toHaveLength(3);

    const endless = scripted({ 'GET /status': status(waiting), 'GET /program': file('G0 X1'),
      'POST /report': () => new Response(JSON.stringify({ status: 'DONE', next_program: { file_id: 1 } }), { status: 200 }) });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('line2'), fetch: endless.fetch }).tick();
    expect(endless.sent.filter(s => s.route === 'GET /program')).toHaveLength(10);
  });

  test('a backup the server refuses (not a text program) is reported, not retried forever', async () => {
    const dir = dirOf('bin');
    fs.mkdirSync(path.join(dir, 'VMC-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'VMC-1', 'O9.nc'), Buffer.from([0, 1, 2]));
    const api = scripted({ 'GET /status': status(null, { id: 9 }), 'POST /report': ok,
      'POST /backup': () => new Response(JSON.stringify({ code: 'NOT_TEXT', message: 'Only text NC programs can be stored.' }), { status: 400 }) });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dir, fetch: api.fetch }).tick();
    expect(api.reports()).toEqual([{ backup_request_id: 9, machine_id: 7, status: 'FAILED', message: 'Only text NC programs can be stored.' }]);
  });

  test('every call carries the token as a Bearer header and the agent version; the backup is multipart with the machine_id and its name', async () => {
    const dir = dirOf('hdr');
    fs.mkdirSync(path.join(dir, 'VMC-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'VMC-1', 'O7.nc'), 'M30');
    const api = scripted({ 'GET /status': status(null, { id: 9 }), 'POST /backup': () => new Response('{}', { status: 201 }) });
    await createGateway({ url: 'https://mexa.test/', token: 'mxg_abc', programDir: dir, fetch: api.fetch }).tick();
    expect(api.sent.map(s => s.init.headers.Authorization)).toEqual(['Bearer mxg_abc', 'Bearer mxg_abc']);
    expect(api.sent.map(s => s.init.headers['X-Agent-Version'])).toEqual(['mexa-gateway 3', 'mexa-gateway 3']);
    const form = api.sent[1].init.body;
    expect(form.get('machine_id')).toBe('7');
    expect(form.get('machine')).toBeNull();
    expect(form.get('program_name')).toBe('O7.nc');
    expect(form.get('file').name).toBe('O7.nc');
  });

  test('safeName keeps an ordinary program name as it is', () => {
    expect(safeName('O1234')).toBe('O1234');
    expect(safeName('PART 7 (OP10).nc')).toBe('PART 7 (OP10).nc');
  });
});
