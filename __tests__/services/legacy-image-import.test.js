const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { createStore } = require('../../src/files/local-storage');
const { MAX_BYTES } = require('../../src/files/image-types');
const { normalizeSource, matchSource, publicAddress, publicLookup, downloadHTTPS,
  directoryDownloader, checkedImage, createImporter, parseOptions } = require('../../src/files/legacy-image-import');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9kAAAAASUVORK5CYII=', 'base64');
const source = normalizeSource({ origin: 'https://old-bucket.s3.ap-south-1.amazonaws.com', prefix: '/images/' });
const old = source.origin + '/images/file-123.png';
const snapshot = { id: 7, company_id: 4, plant_id: 8, image_url: old, valid_plant: true };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-image-import-test-'));
const response = (...rows) => ({ rows, rowCount: rows.length });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function setup({ changed = false, fail = null, image = { buffer: PNG, mimeType: 'image/png' } } = {}) {
  const store = createStore(path.join(root, crypto.randomUUID()));
  const client = { release: jest.fn(), query: jest.fn(async (sql, params) => {
    if (sql.includes('FROM machines')) return response({ ...snapshot, ...(changed ? { image_url: '/api/files/new.png' } : {}) });
    if (sql.includes('FROM plants')) return response({ id: 8 });
    if (fail && sql.includes(fail)) throw new Error('secret signed URL or database detail');
    if (sql.includes('UPDATE machines')) return response({ id: 7 });
    return response();
  }) };
  const pool = { connect: jest.fn(async () => client), query: jest.fn() };
  const download = jest.fn(async () => image);
  const progress = [];
  const job = createImporter({ pool, store, source, download, onProgress: value => progress.push(value) });
  return { job, pool, client, store, download, progress };
}
const crypto = require('node:crypto');

test('CLI defaults to dry run and validates flags before loading configuration', () => {
  const args = ['--source-origin', source.origin, '--source-prefix', '/images/'];
  expect(parseOptions(args)).toMatchObject({ apply: false, companyId: null, source });
  expect(parseOptions([...args, '--apply', '--company-id', '4'])).toMatchObject({ apply: true, companyId: 4 });
  expect(() => parseOptions([...args, '--apply', '--dry-run'])).toThrow('CONFLICTING_OPTIONS');
  expect(() => parseOptions([...args, '--unknown'])).toThrow('UNKNOWN_OPTION');
  expect(() => parseOptions([...args, '--company-id', '01'])).toThrow('INVALID_COMPANY_ID');
  expect(() => parseOptions([...args, '--source-origin', 'https://other.example.com'])).toThrow('DUPLICATE_OPTION');
  expect(() => parseOptions([])).toThrow('INVALID_SOURCE_ORIGIN');
});

test.each(['http://bucket.example.com', 'https://user:secret@bucket.example.com', 'https://bucket.example.com:443',
  'https://bucket.example.com/path', 'https://bucket.example.com?secret=1', 'https://127.0.0.1', 'https://localhost'])('rejects unsafe origin %s', origin => {
  expect(() => normalizeSource({ origin, prefix: '/images/' })).toThrow('INVALID_SOURCE_ORIGIN');
});
test.each(['/', 'images/', '/images', '/images/../', '/images/%2F/', '/images/?key=secret/', '/images/\\escape/'])('rejects unsafe prefix %s', prefix => {
  expect(() => normalizeSource({ origin: source.origin, prefix })).toThrow('INVALID_SOURCE_PREFIX');
});

test('source matching is exact and preserves full bucket-key paths', () => {
  expect(matchSource(old, source).key).toBe('images/file-123.png');
  expect(matchSource('https://another-bucket.example.com/images/file.png', source)).toBeNull();
  expect(matchSource(source.origin + '/other/file.png', source)).toBeNull();
  expect(matchSource('/api/files/companies/4/images/machines/file.png', source)).toBeNull();
});
test.each(['/images/a.png?secret=1', '/images/a.png#secret', '/images/a%2fb.png', '/images/a%5cb.png', '/images/%00.png'])('never fetches signed/unsafe source %s', key => {
  expect(() => matchSource(source.origin + key, source)).toThrow(/^UNSAFE_SOURCE_/);
});

test.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.2.2', '192.168.1.2',
  '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1',
  '::ffff:127.0.0.1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff00::1', '2001:db8::1', '2002:7f00:1::', '2001::1'])('rejects private/reserved address %s', address => {
  expect(publicAddress(address)).toBe(false);
});
test.each(['52.219.62.5', '3.5.210.1', '2600:1f18:1234::1'])('permits public address %s', address => {
  expect(publicAddress(address)).toBe(true);
});

test('all DNS answers are validated, including a private second answer', async () => {
  await expect(publicLookup('bucket.example.com', { lookup: async () => [{ address: '52.219.62.5', family: 4 },
    { address: '127.0.0.1', family: 4 }] })).rejects.toMatchObject({ code: 'SOURCE_NETWORK_NOT_PUBLIC' });
  await expect(publicLookup('bucket.example.com', { lookup: async () => { throw new Error('sensitive hostname'); } }))
    .rejects.toMatchObject({ code: 'SOURCE_DNS_FAILED' });
  await expect(publicLookup('bucket.example.com', { lookup: () => new Promise(() => {}), timeoutMs: 5 }))
    .rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' });
});

function fakeRequest({ status = 200, headers = { 'content-type': 'image/png' }, chunks = [PNG], hang = false } = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    req.destroy = jest.fn();
    req.end = () => setImmediate(() => {
      const res = new PassThrough();
      res.statusCode = status; res.headers = headers;
      callback(res);
      if (hang) return;
      for (const chunk of chunks) if (!res.destroyed) res.write(chunk);
      if (!res.destroyed) res.end();
    });
    return req;
  };
  return { request, calls };
}
const publicDNS = async () => [{ address: '52.219.62.5', family: 4 }];
test('HTTPS downloader pins public DNS and keeps certificate verification enabled', async () => {
  const fake = fakeRequest();
  expect(await downloadHTTPS(new URL(old), { lookup: publicDNS, request: fake.request })).toEqual({ buffer: PNG, mimeType: 'image/png' });
  const options = fake.calls[0].options;
  expect(options.rejectUnauthorized).toBe(true); expect(options.agent).toBe(false);
  const callback = jest.fn(); options.lookup('bucket.example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '52.219.62.5', 4);
  expect(options.headers).not.toHaveProperty('Authorization');
});

test.each([
  [{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }, 'SOURCE_REDIRECT_NOT_ALLOWED'],
  [{ status: 403 }, 'SOURCE_ACCESS_DENIED'],
  [{ status: 404 }, 'SOURCE_NOT_FOUND'],
  [{ headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) } }, 'IMAGE_TOO_LARGE'],
  [{ headers: { 'content-type': 'text/html' } }, 'INVALID_IMAGE_CONTENT'],
  [{ headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } }, 'SOURCE_ENCODING_NOT_SUPPORTED'],
  [{ headers: { 'content-type': 'image/png' }, chunks: [Buffer.alloc(MAX_BYTES), Buffer.alloc(1)] }, 'IMAGE_TOO_LARGE'],
  [{ headers: { 'content-type': 'image/png', 'content-length': '900' } }, 'SOURCE_DOWNLOAD_FAILED']
])('downloader refuses unsafe/unusable response as %s', async (fixture, code) => {
  const fake = fakeRequest(fixture);
  await expect(downloadHTTPS(new URL(old), { lookup: publicDNS, request: fake.request })).rejects.toMatchObject({ code });
  expect(fake.calls).toHaveLength(1);
});
test('download has an overall deadline even when the source does not finish', async () => {
  await expect(downloadHTTPS(new URL(old), { lookup: publicDNS, request: fakeRequest({ hang: true }).request, timeoutMs: 5 }))
    .rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' });
});

test('image content and MIME are checked before a transaction starts', async () => {
  const fixture = setup({ image: { buffer: Buffer.from('<svg/>'), mimeType: 'image/png' } });
  expect(await fixture.job.importMachine(snapshot)).toMatchObject({ status: 'failed', code: 'INVALID_IMAGE_CONTENT' });
  expect(fixture.pool.connect).not.toHaveBeenCalled();
  expect(() => checkedImage({ buffer: PNG, mimeType: 'image/jpeg' })).toThrow('INVALID_IMAGE_CONTENT');
});

test('successful import writes immutable company bytes and changes catalogue and machine in one transaction', async () => {
  const fixture = setup();
  const result = await fixture.job.importMachine(snapshot);
  expect(result).toMatchObject({ status: 'imported', code: 'IMPORTED', machine_id: 7, company_id: 4 });
  const calls = fixture.client.query.mock.calls;
  expect(calls[0][0]).toBe('BEGIN'); expect(calls.at(-1)[0]).toBe('COMMIT');
  expect(calls[1][0]).toMatch(/FOR UPDATE/); expect(calls[1][1]).toEqual([7, 4]);
  expect(calls[2][0]).toMatch(/FOR KEY SHARE/); expect(calls[2][1]).toEqual([8, 4]);
  expect(calls[3][0]).toMatch(/INSERT INTO media_assets/);
  expect(calls[4][0]).toMatch(/UPDATE machines SET image_url/);
  expect(calls[4][1][0]).toBe(`/api/files/companies/4/images/machines/${result.asset_id}.png`);
  expect(await fixture.store.read('company-4/images/machines', `${result.asset_id}.png`)).toEqual(PNG);
  expect(JSON.stringify(result)).not.toContain(source.origin);
});

test('a concurrent image edit is detected after download, without replacing it or publishing bytes', async () => {
  const fixture = setup({ changed: true });
  expect(await fixture.job.importMachine(snapshot)).toMatchObject({ status: 'changed', code: 'MACHINE_CHANGED' });
  expect(fixture.download).toHaveBeenCalledTimes(1);
  expect(fixture.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  expect(fs.existsSync(fixture.store.ROOT)).toBe(false);
});

test('known insert failure rolls back and removes only its new file', async () => {
  const fixture = setup({ fail: 'INSERT INTO media_assets' });
  await fixture.store.write('company-4/images/machines', 'preserve.png', PNG);
  const outcome = await fixture.job.importMachine(snapshot);
  expect(outcome).toMatchObject({ status: 'failed', code: 'IMPORT_WRITE_FAILED' });
  expect(fixture.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  expect(fs.readdirSync(path.join(fixture.store.ROOT, 'company-4/images/machines'))).toEqual(['preserve.png']);
  expect(JSON.stringify(outcome)).not.toMatch(/secret|signed|http/);
});

test('rollback failure destroys the client rather than returning an open transaction to the pool', async () => {
  const fixture = setup({ fail: 'INSERT INTO media_assets' });
  const original = fixture.client.query.getMockImplementation();
  const rollbackError = new Error('fixture rollback connection loss');
  fixture.client.query.mockImplementation((sql, params) => sql === 'ROLLBACK' ? Promise.reject(rollbackError) : original(sql, params));
  expect(await fixture.job.importMachine(snapshot)).toMatchObject({ status: 'failed', code: 'IMPORT_WRITE_FAILED' });
  expect(fixture.client.release).toHaveBeenCalledWith(rollbackError);
  expect(fs.readdirSync(path.join(fixture.store.ROOT, 'company-4/images/machines'))).toEqual([]);
});

test.each([
  [{ company_id: null }, 'INVALID_MACHINE_OWNER'], [{ plant_id: null }, 'UNPLACED_MACHINE'],
  [{ valid_plant: false }, 'INVALID_MACHINE_PLANT']
])('invalid placement remains unchanged without downloading bytes', async (patch, code) => {
  const fixture = setup();
  expect(await fixture.job.importMachine({ ...snapshot, ...patch })).toMatchObject({ status: 'failed', code });
  expect(fixture.download).not.toHaveBeenCalled(); expect(fixture.pool.connect).not.toHaveBeenCalled();
});

test('dry run only enumerates, while company-scoped apply skips already-local references for resume', async () => {
  const fixture = setup();
  fixture.pool.query.mockResolvedValueOnce(response({ max_id: 9 })).mockResolvedValueOnce(response(snapshot,
    { id: 8, company_id: 4, plant_id: 8, image_url: '/api/files/companies/4/images/machines/a.png', valid_plant: true },
    { id: 9, company_id: 4, plant_id: 8, image_url: 'https://other.example.com/images/a.png', valid_plant: true }));
  expect(await fixture.job.run({ companyId: 4 })).toMatchObject({ mode: 'dry-run', scanned: 3, candidates: 1, eligible: 1, skipped: 2, other_remote: 1, imported: 0 });
  expect(fixture.download).not.toHaveBeenCalled(); expect(fixture.pool.connect).not.toHaveBeenCalled();
  expect(fixture.progress).toEqual([{ status: 'candidate', code: 'ELIGIBLE', machine_id: 7, company_id: 4 },
    { status: 'skipped', code: 'OTHER_REMOTE_SOURCE', machine_id: 9, company_id: 4 }]);
  expect(fixture.pool.query.mock.calls[0][1]).toEqual([4]);
  expect(fixture.pool.query.mock.calls[1][1]).toEqual([0, 9, 4]);
});

test.each(['42P01', '42703'])('apply stops once when migration 046 catalogue is missing (%s), before any download or file write', async code => {
  const fixture = setup();
  fixture.pool.query.mockRejectedValueOnce(Object.assign(new Error('sensitive schema error'), { code }));
  await expect(fixture.job.run({ apply: true })).rejects.toMatchObject({ code: 'MEDIA_MIGRATION_REQUIRED' });
  expect(fixture.pool.query).toHaveBeenCalledTimes(1);
  expect(fixture.pool.query.mock.calls[0][0]).toMatch(/FROM media_assets LIMIT 0/);
  expect(fixture.download).not.toHaveBeenCalled(); expect(fixture.pool.connect).not.toHaveBeenCalled();
  expect(fs.existsSync(fixture.store.ROOT)).toBe(false);
});

test.each(['http://old.example.com/images/private.png?secret=redacted', 'https://another-bucket.example.com/images/private.png'])('other remote references are visible by ID without fetching or printing their URL', async image_url => {
  const fixture = setup();
  const result = await fixture.job.importMachine({ ...snapshot, image_url });
  expect(result).toEqual({ status: 'skipped', code: 'OTHER_REMOTE_SOURCE', machine_id: 7, company_id: 4 });
  expect(fixture.download).not.toHaveBeenCalled(); expect(fixture.pool.connect).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/http|secret|private/);
});

test('source-directory fallback reads full keys and leaves original files untouched', async () => {
  const copy = createStore(path.join(root, crypto.randomUUID()));
  await copy.write('images', 'file-123.png', PNG);
  const reader = directoryDownloader(copy.ROOT);
  expect(await reader(new URL(old), 'images/file-123.png')).toEqual({ buffer: PNG, mimeType: 'image/png' });
  expect(await copy.read('images', 'file-123.png')).toEqual(PNG);
  await expect(reader(new URL(old), '../private.png')).rejects.toMatchObject({ code: 'UNSAFE_SOURCE_KEY' });
  fs.symlinkSync(path.join(copy.ROOT, 'images/file-123.png'), path.join(copy.ROOT, 'images/link.png'));
  await expect(reader(new URL(old), 'images/link.png')).rejects.toMatchObject({ code: 'SOURCE_FILE_NOT_READABLE' });
  const huge = path.join(copy.ROOT, 'images/oversize.png');
  fs.writeFileSync(huge, ''); fs.truncateSync(huge, MAX_BYTES + 1);
  await expect(reader(new URL(old), 'images/oversize.png')).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
});

test('help and invalid CLI options never create database clients or print credentials', () => {
  const script = path.resolve(__dirname, '../../scripts/import-machine-images.js');
  const text = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  expect(text).toContain('read-only dry run'); expect(text).toContain('--source-origin');
  let error;
  try { execFileSync(process.execPath, [script, '--source-origin', 'https://user:secret@bucket.example.com', '--source-prefix', '/images/'], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (caught) { error = caught; }
  expect(error.status).toBe(2);
  expect(String(error.stderr)).toContain('INVALID_SOURCE_ORIGIN');
  expect(String(error.stderr)).not.toContain('secret');
});
