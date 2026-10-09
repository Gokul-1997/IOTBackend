/*
 * /api/device/v1 end to end over HTTP: token, job hand-out, file download,
 * tagged uploads, results and the controller list. The database is the mock;
 * files go to a temporary ProgramTransfer folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-dev-'));
process.env.PROGRAM_TRANSFER_DIR = path.join(TMP, 'ProgramTransfer');
process.env.PROGRAM_MAX_MB = '1';

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const deviceToken = require('../../src/programs/device-token');
const storage = require('../../src/programs/storage');

const app = express();
app.use(express.json());
app.use('/api/device/v1', require('../../src/programs/device.routes'));

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => resetDb());

const { token } = deviceToken.generate();
const AUTH = { Authorization: `Bearer ${token}` };
const machine = { id: 7, company_id: 5, machine_serial_no: 'VMC-1', ip_address: '192.168.200.3' };

const authRow = (o = {}) => mockDb.queueResponse({ rows: [{
  id: 3, company_id: 5, machine_id: 7, last_seen_at: new Date().toISOString(), last_seen_ip: '::ffff:127.0.0.1',
  agent_version: null, machine_serial_no: 'VMC-1', ip_address: '192.168.200.3', program_path: '//CNC_MEM/USER/PATH1/', machine_active: true,
  machine_company_id: 5, company_active: true, ...o
}], rowCount: 1 });

const jobRow = (o = {}) => ({
  id: '11', company_id: 5, machine_id: 7, machine_serial: 'VMC-1', action: 'SEND', program_name: 'O1234.nc', program_path: '//CNC_MEM/USER/PATH1/',
  overwrite: false, status: 'DELIVERED', message: null, file_id: '40', backup_file_id: null, requested_by: 2,
  requested_at: '2026-10-05T05:00:00Z', delivered_at: '2026-10-05T05:00:15Z', finished_at: null,
  requested_by_name: 'Priya', file_size: 24, file_sha256: 'a'.repeat(64), file_stored_name: '20261005-103000_NEW_O1234.nc',
  backup_stored_name: null, ...o
});
const one = row => ({ rows: [row], rowCount: 1 });

test('no token: 401 with a code the device can act on', async () => {
  const res = await request(app).get('/api/device/v1/ping');
  expect(res.status).toBe(401);
  expect(res.body.code).toBe('TOKEN_MISSING');
});

test('ping names the machine and the poll interval', async () => {
  authRow();
  const res = await request(app).get('/api/device/v1/ping').set(AUTH);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ device_id: 3, poll_seconds: 15,
    machine: { id: 7, serial: 'VMC-1', ip_address: '192.168.200.3', program_path: '//CNC_MEM/USER/PATH1/' } });
});

test('ping: a machine with no IP set gives the IP its controller reports', async () => {
  authRow({ ip_address: null, controller_ip: '192.168.200.1' });
  const res = await request(app).get('/api/device/v1/ping').set(AUTH);
  expect(res.body.machine.ip_address).toBe('192.168.200.1');
});

describe('direct program download and backup', () => {
  const binary = (r, cb) => {
    const chunks = [];
    r.on('data', chunk => chunks.push(chunk));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  test('the same current program can be downloaded repeatedly, with identity headers and no jobs', async () => {
    const body = Buffer.from('%\nO8001\nG0 X25\nM30\n%\n');
    const saved = await storage.save({ machine, kind: 'NEW', programName: 'O8001.nc', buffer: body });
    const file = { id: '81', machine_id: 7, program_name: 'O8001.nc', folder: saved.folder, stored_name: saved.storedName,
      size_bytes: saved.size, sha256: saved.sha256 };
    for (let n = 0; n < 2; n++) {
      authRow({ program_path: null });
      mockDb.queueResponse(one(file));
      const res = await request(app).get('/api/device/v1/program?machine_id=999').set(AUTH).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(body);
      expect(res.headers).toMatchObject({
        'x-file-id': '81', 'x-program-name': 'O8001.nc', 'x-sha256': saved.sha256,
        'cache-control': 'no-store', 'content-type': 'application/octet-stream', 'content-length': String(body.length)
      });
    }
    const lookups = mockDb.calls().filter(call => /FROM program_current/.test(call.text));
    expect(lookups).toHaveLength(2);
    for (const lookup of lookups) {
      expect(lookup.params).toEqual([5, 7]); // Query parameters never override the device's scope.
      expect(lookup.text).toMatch(/c\.company_id = \$1 AND c\.machine_id = \$2/);
      expect(lookup.text).toMatch(/f\.company_id = c\.company_id AND f\.machine_id = c\.machine_id/);
    }
    expect(mockDb.calls().some(call => /program_jobs|UPDATE program_current/.test(call.text))).toBe(false);
  });

  test('no publication returns an actionable JSON 404, while metadata returns file:null', async () => {
    authRow();
    const download = await request(app).get('/api/device/v1/program').set(AUTH);
    expect(download.status).toBe(404);
    expect(download.body).toMatchObject({ status: 'error', code: 'NO_PROGRAM' });
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['content-type']).toMatch(/application\/json/);
    authRow();
    const info = await request(app).get('/api/device/v1/program/info').set(AUTH);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ file: null });
    expect(info.headers['cache-control']).toBe('no-store');
  });

  test('metadata exposes the published file ID, checksum and direct download URL', async () => {
    authRow();
    mockDb.queueResponse(one({ id: '81', program_name: 'O8001.nc', size_bytes: 42, sha256: 'a'.repeat(64) }));
    const res = await request(app).get('/api/device/v1/program/info').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file: { id: 81, program_name: 'O8001.nc', size: 42, sha256: 'a'.repeat(64), url: '/api/device/v1/program' } });
  });

  test('a missing disk file returns a complete JSON response instead of a truncated program', async () => {
    authRow();
    mockDb.queueResponse(one({ id: '82', program_name: 'O_MISSING.nc', folder: 'company-5/machine-7', stored_name: 'missing.nc', size_bytes: 1234 }));
    const res = await request(app).get('/api/device/v1/program').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'FILE_GONE' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-length']).not.toBe('1234');
  });

  test('backup is saved separately even if the request includes job or type fields', async () => {
    const current = { id: '81', program_name: 'O8001.nc', size_bytes: 42, sha256: 'a'.repeat(64) };
    authRow();
    mockDb.queueResponse(one({ id: '90', program_name: 'O8001.nc', kind: 'BACKUP', folder: 'f', stored_name: 'backup.nc', size_bytes: 3, sha256: 'x', created_at: 'now' }));
    const res = await request(app).post('/api/device/v1/backup').set(AUTH)
      .field('type', 'NEW').field('job_id', '11').field('machine_id', '999').attach('file', Buffer.from('M30'), 'O8001.nc');
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ id: 90, kind: 'BACKUP', program_name: 'O8001.nc' });
    const write = mockDb.calls().find(call => /INSERT INTO program_files/.test(call.text));
    expect(write.params.slice(0, 2)).toEqual([5, 7]);
    expect(write.params[5]).toBe('BACKUP');
    expect(write.params[9]).toBeNull();
    expect(mockDb.calls().some(call => /program_current|program_jobs/.test(call.text))).toBe(false);
    authRow();
    mockDb.queueResponse(one(current));
    const info = await request(app).get('/api/device/v1/program/info').set(AUTH);
    expect(info.body.file.id).toBe(81);
  });

  test('device credentials are required for both direct endpoints', async () => {
    const download = await request(app).get('/api/device/v1/program');
    const backup = await request(app).post('/api/device/v1/backup').attach('file', Buffer.from('M30'), 'O1.nc');
    expect(download.status).toBe(401);
    expect(backup.status).toBe(401);
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('GET /jobs/next', () => {
  test('nothing waiting: 204, no body', async () => {
    authRow();
    const res = await request(app).get('/api/device/v1/jobs/next').set(AUTH);
    expect(res.status).toBe(204);
    const take = mockDb.calls()[1];
    expect(take.text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(take.text).toMatch(/SET status = 'DELIVERED'/);
    expect(take.text).toMatch(/machine_id = \$1 AND company_id = \$3 AND status = 'QUEUED'/);
    expect(take.params).toEqual([7, 3, 5]);            // its own machine, company and device only
  });

  test('a SEND job comes with where to download it and its checksum', async () => {
    authRow();
    mockDb.queueResponse(one({ id: '11' }), one(jobRow()));
    const res = await request(app).get('/api/device/v1/jobs/next').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.job).toEqual({
      id: 11, action: 'SEND', program_name: 'O1234.nc', overwrite: false,
      program_path: '//CNC_MEM/USER/PATH1/', target_file: '//CNC_MEM/USER/PATH1/O1234.nc',
      requested_at: '2026-10-05T05:00:00Z', requested_by: 'Priya',
      file: { size: 24, sha256: 'a'.repeat(64), url: '/api/device/v1/jobs/11/file' }
    });
  });

  test('an empty next poll does not remove the file of the job already claimed', async () => {
    const body = Buffer.from('%\nO1234\nM30\n%\n');
    const saved = await storage.save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: body });
    authRow();
    mockDb.queueResponse(one({ id: '11' }), one(jobRow({ file_size: saved.size, file_sha256: saved.sha256 })));
    const claimed = await request(app).get('/api/device/v1/jobs/next').set(AUTH);
    expect(claimed.status).toBe(200);

    authRow();
    const next = await request(app).get('/api/device/v1/jobs/next').set(AUTH);
    expect(next.status).toBe(204);

    authRow();
    mockDb.queueResponse(one(jobRow()), one({ folder: saved.folder, stored_name: saved.storedName, size_bytes: saved.size, sha256: saved.sha256 }));
    const downloaded = await request(app).get(claimed.body.job.file.url).set(AUTH).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', d => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.equals(body)).toBe(true);
  });
});

describe('GET /jobs/:id/file', () => {
  test('streams the program with its name and SHA-256', async () => {
    const body = Buffer.from('%\nO1234\nG0 X0\nM30\n%\n');
    const saved = await storage.save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: body });
    authRow();
    mockDb.queueResponse(one(jobRow()), one({ folder: saved.folder, stored_name: saved.storedName, size_bytes: saved.size, sha256: saved.sha256 }));
    const res = await request(app).get('/api/device/v1/jobs/11/file').set(AUTH).buffer(true)
      .parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['x-sha256']).toBe(saved.sha256);
    expect(res.headers['x-program-name']).toBe('O1234.nc');
    expect(res.body.equals(body)).toBe(true);
  });

  test("another machine's job: 404", async () => {
    authRow();
    mockDb.queueResponse(one(jobRow({ machine_id: 8 })));
    const res = await request(app).get('/api/device/v1/jobs/11/file').set(AUTH);
    expect([res.status, res.body.code]).toEqual([404, 'JOB_NOT_FOUND']);
  });

  test('a job not taken yet, or a FETCH job, has no file to give', async () => {
    authRow();
    mockDb.queueResponse(one(jobRow({ status: 'QUEUED' })));
    let res = await request(app).get('/api/device/v1/jobs/11/file').set(AUTH);
    expect([res.status, res.body.code]).toEqual([409, 'JOB_NOT_OPEN']);
    authRow();
    mockDb.queueResponse(one(jobRow({ action: 'FETCH' })));
    res = await request(app).get('/api/device/v1/jobs/11/file').set(AUTH);
    expect([res.status, res.body.code]).toEqual([409, 'WRONG_ACTION']);
  });
});

describe('POST /files — one upload, tagged', () => {
  const program = Buffer.from('%\nO1234\nG1 X10 F200\nM30\n%\n');

  test('BACKUP before an overwrite: kept in the machine folder and linked to the SEND job', async () => {
    authRow();
    mockDb.queueResponse(one(jobRow()), one({
      id: '41', folder: 'company-5/192.168.200.3', stored_name: 'x', program_name: 'O1234.nc', kind: 'BACKUP',
      size_bytes: program.length, sha256: storage.sha256(program), created_at: 'now'
    }));
    const res = await request(app).post('/api/device/v1/files').set(AUTH)
      .field('type', 'BACKUP').field('job_id', '11').field('sha256', storage.sha256(program))
      .attach('file', program, 'O1234.nc');
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ id: 41, kind: 'BACKUP' });
    const ins = mockDb.calls().find(c => /INSERT INTO program_files/.test(c.text));
    expect(ins.params.slice(0, 6)).toEqual([5, 7, 'company-5/192.168.200.3', expect.stringMatching(/_BACKUP_O1234\.nc$/), 'O1234.nc', 'BACKUP']);
    expect(fs.existsSync(path.join(storage.ROOT, ins.params[2], ins.params[3]))).toBe(true);
    expect(mockDb.calls().find(c => /SET backup_file_id/.test(c.text)).params).toEqual(['11', '41']);
  });

  test('BACKUP on the device\'s own schedule needs no job', async () => {
    authRow();
    mockDb.queueResponse(one({ id: '42', folder: 'f', stored_name: 's', program_name: 'O5.nc', kind: 'BACKUP', size_bytes: 3, sha256: 'x', created_at: 'now' }));
    const res = await request(app).post('/api/device/v1/files').set(AUTH).field('type', 'BACKUP').attach('file', Buffer.from('M30'), 'O5.nc');
    expect(res.status).toBe(201);
  });

  test('FETCHED answers a FETCH job and completes it', async () => {
    authRow();
    mockDb.queueResponse(
      one(jobRow({ action: 'FETCH', file_id: null })),
      one({ id: '43', folder: 'f', stored_name: 's', program_name: 'O1234.nc', kind: 'FETCHED', size_bytes: 3, sha256: 'x', created_at: 'now' }),
      { rows: [], rowCount: 1 },                              // job.file_id
      { rows: [], rowCount: 1 },                              // finish
      one(jobRow({ action: 'FETCH', status: 'DONE', file_id: '43' }))
    );
    const res = await request(app).post('/api/device/v1/files').set(AUTH)
      .field('type', 'FETCHED').field('job_id', '11').attach('file', program, 'whatever.nc');
    expect(res.status).toBe(201);
    const ins = mockDb.calls().find(c => /INSERT INTO program_files/.test(c.text));
    expect(ins.params[4]).toBe('O1234.nc');                   // named as asked for, not as uploaded
    expect(mockDb.calls().find(c => /UPDATE program_jobs SET status = \$2/.test(c.text)).params.slice(0, 2)).toEqual(['11', 'DONE']);
  });

  test.each([
    ['no type', { }, 'BAD_TYPE', 400],
    ['FETCHED without a job', { type: 'FETCHED' }, 'BAD_JOB', 400],
    ['an unknown tag', { type: 'NEW' }, 'BAD_TYPE', 400]
  ])('%s is refused', async (_l, fields, code, status) => {
    authRow();
    let r = request(app).post('/api/device/v1/files').set(AUTH);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    const res = await r.attach('file', program, 'O1.nc');
    expect([res.status, res.body.code]).toEqual([status, code]);
  });

  test('a file that arrived changed is refused before it is kept', async () => {
    authRow();
    const res = await request(app).post('/api/device/v1/files').set(AUTH)
      .field('type', 'BACKUP').field('sha256', 'b'.repeat(64)).attach('file', program, 'O1.nc');
    expect([res.status, res.body.code]).toEqual([422, 'CHECKSUM_MISMATCH']);
    expect(mockDb.calls().some(c => /INSERT INTO program_files/.test(c.text))).toBe(false);
  });

  test('over the size limit: 413 TOO_LARGE; a binary: NOT_TEXT', async () => {
    authRow();
    let res = await request(app).post('/api/device/v1/files').set(AUTH)
      .field('type', 'BACKUP').attach('file', Buffer.alloc(1024 * 1024 + 10, 0x41), 'O1.nc');
    expect([res.status, res.body.code]).toEqual([413, 'TOO_LARGE']);
    authRow();
    res = await request(app).post('/api/device/v1/files').set(AUTH)
      .field('type', 'BACKUP').attach('file', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]), 'O1.nc');
    expect([res.status, res.body.code]).toEqual([400, 'NOT_TEXT']);
  });
});

describe('POST /jobs/:id/result', () => {
  test('FAILED has to say why', async () => {
    authRow();
    const res = await request(app).post('/api/device/v1/jobs/11/result').set(AUTH).send({ status: 'FAILED' });
    expect([res.status, res.body.code]).toEqual([400, 'NO_MESSAGE']);
  });

  test('DONE finishes the job and tells the person who asked', async () => {
    authRow();
    mockDb.queueResponse(one(jobRow()), { rows: [], rowCount: 1 }, one(jobRow({ status: 'DONE' })));
    const res = await request(app).post('/api/device/v1/jobs/11/result').set(AUTH).send({ status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body.job).toEqual({ id: 11, status: 'DONE' });
    expect(mockDb.calls().some(c => /INSERT INTO notifications/.test(c.text))).toBe(true);
  });

  test('the same report again (a retry) is fine; a different one is not', async () => {
    authRow();
    mockDb.queueResponse(one(jobRow({ status: 'DONE' })));
    let res = await request(app).post('/api/device/v1/jobs/11/result').set(AUTH).send({ status: 'DONE' });
    expect(res.status).toBe(200);
    authRow();
    mockDb.queueResponse(one(jobRow({ status: 'DONE' })));
    res = await request(app).post('/api/device/v1/jobs/11/result').set(AUTH).send({ status: 'FAILED', message: 'x' });
    expect([res.status, res.body.code]).toEqual([409, 'JOB_NOT_OPEN']);
  });

  test('a FETCH job is not DONE until its file is uploaded', async () => {
    authRow();
    mockDb.queueResponse(one(jobRow({ action: 'FETCH', file_id: null })));
    const res = await request(app).post('/api/device/v1/jobs/11/result').set(AUTH).send({ status: 'DONE' });
    expect([res.status, res.body.code]).toEqual([409, 'NO_FILE']);
  });
});

describe('PUT /controller-files', () => {
  test('stores a cleaned list for this machine only', async () => {
    authRow();
    const res = await request(app).put('/api/device/v1/controller-files').set(AUTH).send({ files: [
      { name: 'O1234', size: 2048, modified: '2026-10-05T04:00:00Z', comment: 'FLANGE' },
      { name: 'O2001', size: 'x', modified: 'yesterday' }
    ] });
    expect(res.body).toEqual({ count: 2 });
    const up = mockDb.calls().find(c => /program_controller_files/.test(c.text));
    expect(up.params.slice(0, 2)).toEqual([7, 5]);
    expect(JSON.parse(up.params[2])).toEqual([
      { name: 'O1234', size: 2048, modified: '2026-10-05T04:00:00.000Z', comment: 'FLANGE' },
      { name: 'O2001', size: null, modified: null, comment: null }
    ]);
  });

  test('not a list, or a nameless entry: 400', async () => {
    authRow();
    let res = await request(app).put('/api/device/v1/controller-files').set(AUTH).send({ files: 'O1' });
    expect(res.status).toBe(400);
    authRow();
    res = await request(app).put('/api/device/v1/controller-files').set(AUTH).send({ files: [{ size: 1 }] });
    expect(res.status).toBe(400);
  });
});
