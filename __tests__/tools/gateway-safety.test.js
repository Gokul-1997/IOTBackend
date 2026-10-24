const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getEventListeners } = require('node:events');
const { createGateway, sleep } = require('../../tools/gateway/mexa-gateway');
const sum = value => crypto.createHash('sha256').update(value).digest('hex');
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-safety-')); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function fixture({ machines = [{ machine_id: 7, machine: 'VMC-1', program: { file_id: 42, program_name: 'O1001.nc' } }], data = 'M30\n', options = {} } = {}) {
  const reports = [];
  const fetch = jest.fn(async (url, init) => {
    if (url.endsWith('/status')) return Response.json({ machines });
    if (url.includes('/program?')) return new Response(data, { headers: {
      'X-File-Id': '42', 'X-Program-Name': 'O1001.nc', 'X-Sha256': sum(data)
    } });
    if (url.endsWith('/report')) { reports.push(JSON.parse(init.body)); return Response.json({ next_program: null }); }
    return Response.json({}, { status: 201 });
  });
  return { fetch, reports, gateway: createGateway({ url: 'https://fixture.test', token: 'test-only', programDir: directory, fetch, ...options }) };
}

test('a stalled gateway request has a deadline and cancels the actual HTTP signal', async () => {
  jest.useFakeTimers(); let signal;
  const fetch = (_url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })));
  });
  const work = createGateway({ url: 'https://fixture.test', token: 'test', fetch, requestTimeoutMs: 20 }).tick();
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  jest.advanceTimersByTime(21); await rejected;
  expect(signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('stopping the gateway aborts in-flight HTTP work instead of waiting for the next poll', async () => {
  const controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const fetch = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(Error('stopped'), { name: 'AbortError' })));
    started();
  });
  const gateway = createGateway({ url: 'https://fixture.test', token: 'test', fetch });
  const work = gateway.run({ signal: controller.signal });
  await ready; controller.abort(); await work;
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('a stalled response body is cancelled under the request deadline', async () => {
  jest.useFakeTimers();
  const cancel = jest.fn();
  const fetch = async () => new Response(new ReadableStream({ cancel }));
  const work = createGateway({ url: 'https://fixture.test', token: 'test', fetch, requestTimeoutMs: 20 }).tick();
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await jest.advanceTimersByTimeAsync(21);
  await rejected;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each([0, -1, NaN, Infinity, 300001])('an invalid request deadline %s is refused', requestTimeoutMs => {
  expect(() => createGateway({ requestTimeoutMs })).toThrow('timeout');
});

test('polling sleep removes abort listeners after every completed wait', async () => {
  jest.useFakeTimers(); const controller = new AbortController();
  for (let i = 0; i < 30; i++) {
    const wait = sleep(1, controller.signal); jest.advanceTimersByTime(1); await wait;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  }
  controller.abort(); await sleep(100, controller.signal);
  expect(jest.getTimerCount()).toBe(0);
});

test('an oversized program without Content-Length is refused before any file write', async () => {
  const f = fixture({ data: 'M30\n'.repeat(10), options: { maxProgramBytes: 8 } });
  await expect(f.gateway.tick()).rejects.toThrow('size limit');
  expect(fs.existsSync(path.join(directory, 'VMC-1'))).toBe(false);
  expect(f.reports).toEqual([]); // a server download failure is not a machine refusal
});

test('concurrent ticks share one round instead of delivering the same file twice', async () => {
  const f = fixture(); const first = f.gateway.tick(), second = f.gateway.tick();
  expect(first).toBe(second); await Promise.all([first, second]);
  expect(f.reports).toHaveLength(1);
  expect(f.fetch.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(1);
});

test('overwriting saves the previous program and metadata; unchanged retry makes no extra version', async () => {
  const folder = path.join(directory, 'VMC-1'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'O1001.nc'), 'old program');
  fs.chmodSync(path.join(folder, 'O1001.nc'), 0o664);
  const f = fixture(); await f.gateway.tick();
  const versions = path.join(folder, '.mexa-backups');
  const files = fs.readdirSync(versions); expect(files).toHaveLength(2);
  const saved = files.find(name => !name.endsWith('.json'));
  expect(fs.readFileSync(path.join(versions, saved), 'utf8')).toBe('old program');
  expect(JSON.parse(fs.readFileSync(path.join(versions, saved + '.json'), 'utf8'))).toMatchObject({ machine_id: 7, program_name: 'O1001.nc', sha256: sum('old program') });
  expect(fs.readFileSync(path.join(folder, 'O1001.nc'), 'utf8')).toBe('M30\n');
  if (process.platform !== 'win32') expect(fs.statSync(path.join(folder, 'O1001.nc')).mode & 0o777).toBe(0o664);
  await f.gateway.tick(); expect(fs.readdirSync(versions)).toHaveLength(2);
  expect(fs.readdirSync(folder).filter(name => name.endsWith('.part'))).toEqual([]);
});

test('an older unrelated invalid filename cannot block backing up the newest valid program', async () => {
  const folder = path.join(directory, 'VMC-1'); fs.mkdirSync(folder);
  const unrelated = path.join(folder, 'x'.repeat(101));
  fs.writeFileSync(unrelated, 'old unrelated file'); fs.utimesSync(unrelated, 0, 0);
  fs.writeFileSync(path.join(folder, 'O1001.nc'), 'M30\n');
  const f = fixture({ machines: [{ machine_id: 7, machine: 'VMC-1', backup_request: { id: 9 } }] });
  await f.gateway.tick();
  expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/backup'))).toBe(true);
  expect(f.reports).toEqual([]);
});

test('a failed safety backup leaves the original program untouched', async () => {
  const folder = path.join(directory, 'VMC-1'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'O1001.nc'), 'old program');
  const promises = require('node:fs/promises'), write = promises.writeFile;
  jest.spyOn(promises, 'writeFile').mockImplementation((file, ...args) => {
    if (String(file).includes('.mexa-backups')) throw Error('Safety backup unavailable');
    return write(file, ...args);
  });
  const f = fixture(); await f.gateway.tick();
  expect(fs.readFileSync(path.join(folder, 'O1001.nc'), 'utf8')).toBe('old program');
  expect(f.reports[0]).toMatchObject({ status: 'FAILED', message: 'Safety backup unavailable' });
});

test('ambiguous sanitized machine folders fail before any download', async () => {
  const f = fixture({ machines: ['VMC/1', 'VMC:1'].map((machine, index) => ({ machine, machine_id: index + 1, program: { file_id: 42 } })) });
  await expect(f.gateway.tick()).rejects.toThrow('distinct MACHINE_DIRS');
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('a backup exceeding the configured program limit never enters an upload', async () => {
  const folder = path.join(directory, 'VMC-1'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'O1001.nc'), 'x'.repeat(100));
  const f = fixture({ machines: [{ machine_id: 7, machine: 'VMC-1', backup_request: { id: 9 } }], options: { maxProgramBytes: 8 } });
  await f.gateway.tick();
  expect(f.reports[0]).toMatchObject({ backup_request_id: 9, status: 'FAILED' });
  expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/backup'))).toBe(false);
});
