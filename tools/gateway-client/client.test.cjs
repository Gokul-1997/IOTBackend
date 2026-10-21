const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { createClient } = require('./client.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const token = 'mxg_' + 'a'.repeat(43), lease = 'b'.repeat(64);
let root, server, origin, downloads = 0, captures = [];
const content = Buffer.from('%\nO1001\nG0 X0\nM30\n%\n');
const job = id => ({ id, lease_token: lease, file: { sha256: hash(content), size: content.length } });
const client = name => createClient({ origin, token, spoolRoot: path.join(root, name) });
before(async () => {
  root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mexa-transport-test-')));
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    next();
  });
  app.post('/api/gateway/v1/config', (req, res) => res.json({ machines: req.body.machines }));
  app.post('/api/gateway/v1/commands/next', (req, res) => res.json({ job: null, received: req.body }));
  app.post('/api/gateway/v1/jobs/:id/file', (req, res) => {
    assert.equal(req.body.lease_token, lease); downloads++;
    if (req.params.id === '3') return res.redirect(307, origin + '/redirect-target');
    res.set('X-Sha256', req.params.id === '2' ? '0'.repeat(64) : hash(content));
    res.set('Content-Length', String(content.length)); res.type('application/octet-stream').end(content);
  });
  const upload = multer({ dest: path.join(root, 'received'), limits: { fileSize: 1024 * 1024 } }).single('file');
  app.post('/api/gateway/v1/jobs/:id/capture', upload, async (req, res) => {
    const bytes = await fs.promises.readFile(req.file.path);
    captures.push({ fields: req.body, bytes });
    assert.equal(req.body.sha256, hash(bytes)); assert.equal(req.body.lease_token, lease);
    res.json({ file: { id: 42, sha256: hash(bytes) } });
  });
  app.post('/api/gateway/v1/jobs/:id/result', (req, res) => res.json({ job: { id: Number(req.params.id), ...req.body } }));
  app.post('/api/gateway/v1/jobs/:id/progress', (req, res) => res.json(req.body));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.promises.rm(root, { recursive: true, force: true });
});
test('transport rejects external HTTP, embedded credentials and wrong credential types', () => {
  for (const url of ['http://plant.example', 'https://user:pass@plant.example', 'https://plant.example/api']) {
    assert.throws(() => createClient({ origin: url, token, spoolRoot: root }));
  }
  assert.throws(() => createClient({ origin, token: 'mxd_machine', spoolRoot: root }));
});
test('configuration and long-poll use the real authenticated JSON endpoints', async () => {
  const transport = client('json');
  assert.deepEqual(await transport.config([{ id: 7 }]), { machines: [{ id: 7 }] });
  const next = await transport.next({ available_slots: 1, active_job_ids: [], wait_seconds: 0 });
  assert.equal(next.job, null); assert.equal(next.received.available_slots, 1);
});
test('file download verifies bytes and atomically reuses an existing matching spool', async () => {
  const transport = client('download'), before = downloads;
  const first = await transport.download(job(1));
  assert.equal(first.sha256, hash(content)); assert.equal(first.reused, false);
  assert.deepEqual(await fs.promises.readFile(path.join(root, 'download', first.filename)), content);
  const repeated = await transport.download(job(1));
  assert.equal(repeated.reused, true); assert.equal(downloads - before, 1);
});
test('a mismatching existing spool is preserved rather than silently replaced', async () => {
  const transport = client('existing');
  await fs.promises.mkdir(path.join(root, 'existing'));
  await fs.promises.writeFile(path.join(root, 'existing', 'job-1-source.nc'), 'old-recovery-evidence');
  await assert.rejects(() => transport.download(job(1)), /differ/);
  assert.equal(await fs.promises.readFile(path.join(root, 'existing', 'job-1-source.nc'), 'utf8'), 'old-recovery-evidence');
});
test('wrong server checksum and redirect responses are refused without a saved file', async () => {
  const transport = client('unsafe');
  await assert.rejects(() => transport.download(job(2)), /checksum differs/);
  await assert.rejects(() => transport.download(job(3)), /fetch failed/);
  assert.deepEqual(await fs.promises.readdir(path.join(root, 'unsafe')), []);
});
test('file size limit is enforced before publishing spool bytes', async () => {
  const transport = createClient({ origin, token, spoolRoot: path.join(root, 'limited'), maxBytes: 4 });
  await assert.rejects(() => transport.download(job(1)), /limit/);
  assert.deepEqual(await fs.promises.readdir(path.join(root, 'limited')), []);
});
test('current backup requires the embedded reader proof and streams actual local bytes', async () => {
  const transport = client('capture'); await fs.promises.mkdir(path.join(root, 'capture'));
  await fs.promises.writeFile(path.join(root, 'capture', 'actual.nc'), content);
  const before = captures.length;
  await assert.rejects(() => transport.capture(job(4), { filename: 'actual.nc', program_name: 'O1001.nc', type: 'CURRENT' }), /identify and verify/);
  assert.equal(captures.length, before);
  const reply = await transport.capture(job(4), { filename: 'actual.nc', program_name: 'O1001.nc', type: 'CURRENT', current_program_verified: true, controller_reported_name: 'O1001.nc' });
  assert.equal(reply.file.sha256, hash(content));
  assert.deepEqual(captures.at(-1).bytes, content);
  assert.equal(captures.at(-1).fields.current_program_verified, 'true');
});
test('capture forbids path traversal and symlink spool inputs', async () => {
  const transport = client('symlink'); await fs.promises.mkdir(path.join(root, 'symlink'));
  const options = { program_name: 'O1001.nc', type: 'FETCHED' };
  await assert.rejects(() => transport.capture(job(5), { ...options, filename: '../actual.nc' }), /without a path/);
  await fs.promises.symlink(path.join(root, 'capture', 'actual.nc'), path.join(root, 'symlink', 'unsafe.nc'));
  await assert.rejects(() => transport.capture(job(5), { ...options, filename: 'unsafe.nc' }), /real, nonempty/);
});
test('result transport never invents controller verification flags', async () => {
  const result = await client('result').result(job(6), { status: 'FAILED', error_code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(result.job.status, 'FAILED'); assert.equal(result.job.verified, undefined);
  assert.equal(result.job.lease_token, lease);
});
test('progress cannot replace the claimed lease with an untrusted field', async () => {
  const result = await client('progress').progress(job(7), { stage: 'READING', bytes: 10, lease_token: 'fake' });
  assert.equal(result.lease_token, lease); assert.equal(result.stage, 'READING');
});
