/*
 * tools/gateway/mexa-gateway.js — the program next to a machine that moves
 * an uploaded program into it, and its backups out (22 Oct 2026: "how does
 * the server move my .nc file to the machine?" — it does not; this does).
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
const { createGateway, safeName } = require('../../tools/gateway/mexa-gateway');

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const one = row => ({ rows: [row], rowCount: 1 });
const none = { rows: [], rowCount: 0 };
const machine = { id: 7, company_id: 5, machine_serial_no: 'VMC-1' };

describe('against the real gateway API', () => {
  const { token } = deviceToken.generate();
  let server, url, db;

  /* The few rows the four calls read and write, answered by what each query asks. */
  function fakeDatabase() {
    const state = { files: [], requests: [] };
    mockDb.query.mockImplementation(async (sql, params = []) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (/FROM program_devices d/.test(text)) {
        return params[0] === deviceToken.hash(token)
          ? one({ id: 3, company_id: 5, machine_id: 7, last_seen_at: new Date().toISOString(), last_seen_ip: '127.0.0.1',
                  agent_version: null, machine_serial_no: 'VMC-1', machine_active: true, machine_company_id: 5, company_active: true })
          : none;
      }
      if (/FROM program_files f[\s\S]*kind = 'NEW'[\s\S]*LIMIT 1/.test(text)) {
        const newest = state.files.filter(f => f.kind === 'NEW').at(-1);
        return newest ? one(newest) : none;
      }
      if (/FROM program_backup_requests\s+WHERE machine_id = \$1 AND closed_at IS NULL/.test(text)) {
        return { rows: state.requests.filter(r => !r.closed_at), rowCount: 0 };
      }
      if (/UPDATE program_files SET delivery_status/.test(text)) {
        const f = state.files.find(x => x.id === String(params[0]));
        if (!f || (f.delivery_status === params[2] && f.delivery_message === params[3])) return none;
        Object.assign(f, { delivery_status: params[2], delivery_message: params[3] });
        return one({ id: f.id, program_name: f.program_name, uploaded_by: null });
      }
      if (/INSERT INTO program_files/.test(text)) {
        const row = { id: String(100 + state.files.length), machine_id: 7, folder: params[2], stored_name: params[3],
                      program_name: params[4], kind: params[5], size_bytes: params[6], sha256: params[7], created_at: 'T1' };
        state.files.push(row);
        return one(row);
      }
      if (/UPDATE program_backup_requests SET closed_at = NOW\(\), (file_id|error_message)/.test(text)) {
        const r = state.requests.find(x => !x.closed_at);
        if (!r) return none;
        Object.assign(r, { closed_at: 'now', file_id: /file_id/.test(text) ? params[1] : null, error_message: /error_message/.test(text) ? params[2] : null });
        return one({ id: r.id, requested_by: null });
      }
      return none;
    });
    return state;
  }

  /** What a person's upload on the Program Transfer page leaves behind: the file, and its row. */
  async function uploaded(text, name) {
    const source = path.join(TMP, `upload-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(source, text);
    const saved = await storage.saveStream({ machine, kind: 'NEW', programName: name, filename: source });
    db.files.push({ id: '81', machine_id: 7, program_name: saved.programName, kind: 'NEW', folder: saved.folder,
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

  test('a program uploaded on the page lands in the machine\'s folder, byte for byte, and the page is told DONE', async () => {
    const program = '%\nO1001 (FACE MILL)\nG21 G90\nG0 X25. Y10.\nM30\n%\n';
    await uploaded(program, 'O1001.nc');
    const dir = path.join(TMP, 'machine-a');
    const lines = [];
    const gateway = createGateway({ url, token, programDir: dir, log: l => lines.push(l) });

    const status = await gateway.tick();
    expect(status.program).toMatchObject({ file_id: 81, program_name: 'O1001.nc', status: 'WAITING' });
    expect(fs.readFileSync(path.join(dir, 'O1001.nc'), 'utf8')).toBe(program);
    expect(db.files[0]).toMatchObject({ delivery_status: 'DONE', delivery_message: null });
    expect(fs.readdirSync(dir)).toEqual(['O1001.nc']);                 // no half-written file left behind

    // the next round sees DONE and leaves the machine alone
    fs.writeFileSync(path.join(dir, 'O1001.nc'), 'edited on the machine');
    await gateway.tick();
    expect(fs.readFileSync(path.join(dir, 'O1001.nc'), 'utf8')).toBe('edited on the machine');
    expect(lines.join('\n')).not.toContain(token);
  });

  test('Backup now: the newest program in the folder is sent back and answers the request', async () => {
    const dir = path.join(TMP, 'machine-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'O0001.nc'), '%\nO0001\nM30\n%\n');
    const newest = path.join(dir, 'O2002.nc');
    fs.writeFileSync(newest, '%\nO2002\nG0 Z5.\nM30\n%\n');
    fs.utimesSync(newest, new Date(), new Date(Date.now() + 1000));
    db.requests.push({ id: '9', requested_at: 'T0', closed_at: null });

    await createGateway({ url, token, programDir: dir }).tick();
    const backup = db.files.find(f => f.kind === 'BACKUP');
    expect(backup).toMatchObject({ program_name: 'O2002.nc' });
    expect(fs.readFileSync(path.join(process.env.STORAGE_ROOT, backup.folder, backup.stored_name), 'utf8'))
      .toBe('%\nO2002\nG0 Z5.\nM30\n%\n');
    expect(db.requests[0]).toMatchObject({ closed_at: 'now', file_id: '100' });
  });

  test('nothing in the folder to back up: the page is told why, instead of waiting 30 minutes', async () => {
    db.requests.push({ id: '9', requested_at: 'T0', closed_at: null });
    await createGateway({ url, token, programDir: path.join(TMP, 'empty-machine') }).tick();
    expect(db.requests[0].error_message).toMatch(/^No program in .*empty-machine to back up$/);
  });

  test('a wrong token stops the gateway with a sentence a person can act on', async () => {
    const lines = [];
    const gateway = createGateway({ url, token: 'mxd_' + 'x'.repeat(43), programDir: TMP, log: l => lines.push(l) });
    await expect(gateway.run()).rejects.toMatchObject({ status: 401, fatal: true });
    expect(lines.at(-1)).toMatch(/Make a new token in MEXA → Program Transfer → Gateway token/);
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
      sent.push({ route, init });
      const answer = routes[route];
      if (!answer) return new Response(JSON.stringify({ status: 'error', code: 'NOT_FOUND' }), { status: 404 });
      return typeof answer === 'function' ? answer(init) : answer();
    };
    return { fetch, sent, reports: () => sent.filter(s => s.route === 'POST /report').map(s => JSON.parse(s.init.body)) };
  }
  const status = (program, backup_request = null) => () => new Response(JSON.stringify({
    machine: { id: 7, serial: 'VMC-1' }, program, backup_request, poll_seconds: 15 }), { status: 200 });
  const file = (text, headers = {}) => () => new Response(text, { status: 200, headers: {
    'X-File-Id': '42', 'X-Program-Name': encodeURIComponent('O1001.nc'), 'X-Sha256': sum(text), ...headers } });
  const ok = () => new Response(JSON.stringify({ status: 'DONE' }), { status: 200 });
  const waiting = { file_id: 42, program_name: 'O1001.nc', sha256: 'x', status: 'WAITING' };
  const dirOf = name => path.join(TMP, name);

  test('a damaged download is not written, and the page says so', async () => {
    const api = scripted({ 'GET /status': status(waiting), 'GET /program': file('G0 X1', { 'X-Sha256': sum('something else') }), 'POST /report': ok });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('dmg'), fetch: api.fetch }).tick();
    expect(fs.existsSync(path.join(dirOf('dmg'), 'O1001.nc'))).toBe(false);
    expect(api.reports()).toEqual([{ file_id: 42, status: 'FAILED', message: 'The file arrived damaged (its SHA-256 does not match); upload it again' }]);
  });

  test.each(['../evil.nc', '..', 'a/b.nc', 'C:\\x.nc', '.hidden'])('a name like %j never becomes a path: refused and reported', async name => {
    const api = scripted({ 'GET /status': status(waiting), 'POST /report': ok,
                           'GET /program': file('G0 X1', { 'X-Program-Name': encodeURIComponent(name) }) });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dirOf('names'), fetch: api.fetch }).tick();
    expect(api.reports()[0]).toMatchObject({ file_id: 42, status: 'FAILED', message: expect.stringMatching(/not a usable program name/) });
    expect(fs.existsSync(path.join(TMP, 'evil.nc'))).toBe(false);
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

  test('a backup the server refuses (not a text program) is reported, not retried forever', async () => {
    const dir = dirOf('bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'O9.nc'), Buffer.from([0, 1, 2]));
    const api = scripted({ 'GET /status': status(null, { id: 9 }), 'POST /report': ok,
      'POST /backup': () => new Response(JSON.stringify({ code: 'NOT_TEXT', message: 'Only text NC programs can be stored.' }), { status: 400 }) });
    await createGateway({ url: 'https://mexa.test', token: 't', programDir: dir, fetch: api.fetch }).tick();
    expect(api.reports()).toEqual([{ backup_request_id: 9, status: 'FAILED', message: 'Only text NC programs can be stored.' }]);
  });

  test('every call carries the token as a Bearer header, and the backup is multipart with its name', async () => {
    const dir = dirOf('hdr');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'O7.nc'), 'M30');
    const api = scripted({ 'GET /status': status(null, { id: 9 }), 'POST /backup': () => new Response('{}', { status: 201 }) });
    await createGateway({ url: 'https://mexa.test/', token: 'mxd_abc', programDir: dir, fetch: api.fetch }).tick();
    expect(api.sent.map(s => s.init.headers.Authorization)).toEqual(['Bearer mxd_abc', 'Bearer mxd_abc']);
    const form = api.sent[1].init.body;
    expect(form.get('program_name')).toBe('O7.nc');
    expect(form.get('file').name).toBe('O7.nc');
  });

  test('safeName keeps an ordinary program name as it is', () => {
    expect(safeName('O1234')).toBe('O1234');
    expect(safeName('PART 7 (OP10).nc')).toBe('PART 7 (OP10).nc');
  });
});
