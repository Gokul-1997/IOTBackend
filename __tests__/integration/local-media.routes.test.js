const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-media-'));
process.env.STORAGE_ROOT = root;
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
let mockUser;
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  if (!mockUser) return res.status(401).json({ message: 'Sign in required' });
  req.user = mockUser;
  next();
});
const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const redis = require('../../src/redis');
const local = require('../../src/files/local-storage');
const media = require('../../src/files/media.service');
const app = express();
app.use('/api/upload', require('../../src/upload/upload.routes'));
app.use('/api/files', require('../../src/files/media.routes'));
app.use(require('../../src/middleware/error.middleware'));
const response = (...rows) => ({ rows, rowCount: rows.length });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9kAAAAASUVORK5CYII=', 'base64');
const uuid = '859963eb-8a1c-49ec-89a0-076f25b141cb';
const filename = `${uuid}.png`;
const url = media.fileUrl(4, filename);
const asset = (patch = {}) => ({ id: uuid, company_id: 4, plant_id: 8, purpose: 'machine-images',
  storage_key: `company-4/images/machines/${filename}`, filename, mime_type: 'image/png', size_bytes: PNG.length,
  sha256: crypto.createHash('sha256').update(PNG).digest('hex'), uploaded_by: 2, ...patch });
const upload = (buffer = PNG, mime = 'image/png', name = '../../fake.svg') => request(app).post('/api/upload')
  .field('plant_id', '8').attach('file', buffer, { filename: name, contentType: mime });

beforeEach(async () => {
  resetDb();
  mockUser = { id: 2, company_id: 4, plant_id: 8, roles: ['ENGINEER'], permissions: ['page:machines:create', 'page:machines:view'] };
  await redis.set('company_grants:4', '[]');
  fs.rmSync(path.join(root, 'company-4'), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('new upload creates an immutable company/permission-owned local image, ignoring original filename', async () => {
  mockDb.queueResponse(response({ id: 8 }), response());
  const res = await upload();
  expect(res.status).toBe(201);
  const parsed = media.parseReference(res.body.fileUrl);
  expect(parsed.company).toBe(4);
  expect(parsed.filename).toMatch(media.FILE_PATTERN);
  expect(res.body.fileUrl).not.toMatch(/s3|https?:|fake|\.\./);
  expect(fs.readFileSync(path.join(root, media.directory(4), parsed.filename))).toEqual(PNG);
  expect(mockDb.calls()[0].params).toEqual([8, 4]);
  const insert = mockDb.calls()[1];
  expect(insert.text).toMatch(/INSERT INTO media_assets/);
  expect(insert.params.slice(1)).toEqual([4, 8, `${media.directory(4)}/${parsed.filename}`, parsed.filename,
    'image/png', PNG.length, asset().sha256, 2]);
});

test('two identical uploads receive distinct UUIDs and preserve both files', async () => {
  mockDb.queueResponse(response({ id: 8 }), response(), response({ id: 8 }), response());
  const a = await upload(); const b = await upload();
  expect(a.status).toBe(201); expect(b.status).toBe(201);
  expect(a.body.fileUrl).not.toBe(b.body.fileUrl);
  expect(fs.readdirSync(path.join(root, media.directory(4)))).toHaveLength(2);
});

test.each(['anonymous', 'no-company', 'no-role', 'no-company-grant'])('denies %s before allocating or saving the multipart file', async mode => {
  if (mode === 'anonymous') mockUser = null;
  if (mode === 'no-company') mockUser.company_id = null;
  if (mode === 'no-role') mockUser.permissions = ['page:dashboard:view'];
  if (mode === 'no-company-grant') await redis.set('company_grants:4', JSON.stringify(['page:dashboard:view']));
  const res = await upload();
  expect(res.status).toBe(mode === 'anonymous' ? 401 : 403);
  expect(mockDb.calls()).toHaveLength(0);
  expect(fs.existsSync(path.join(root, 'company-4'))).toBe(false);
});

test.each([
  [Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/png'],
  [PNG, 'image/jpeg'],
  [PNG.subarray(0, 30), 'image/png']
])('rejects spoofed or truncated file content without a disk write', async (buffer, mime) => {
  const res = await upload(buffer, mime);
  expect(res.status).toBe(400); expect(res.body.code).toBe('INVALID_IMAGE_CONTENT');
  expect(mockDb.calls()).toHaveLength(0);
  expect(fs.existsSync(path.join(root, 'company-4'))).toBe(false);
});

test('rejects SVG and oversized uploads with clear errors', async () => {
  let res = await upload(Buffer.from('<svg/>'), 'image/svg+xml');
  expect([res.status, res.body.code]).toEqual([400, 'IMAGE_TYPE_NOT_SUPPORTED']);
  res = await upload(Buffer.alloc(media.MAX_BYTES + 1), 'image/png');
  expect([res.status, res.body.code]).toEqual([400, 'IMAGE_TOO_LARGE']);
  expect(mockDb.calls()).toHaveLength(0);
});

test('plant-bound uploader cannot spoof a different plant', async () => {
  const res = await request(app).post('/api/upload').field('plant_id', '9').attach('file', PNG, { filename: 'm.png', contentType: 'image/png' });
  expect(res.status).toBe(403);
  expect(mockDb.calls()).toHaveLength(0);
});

test('metadata failure removes only the new file and keeps an existing image', async () => {
  await local.write(media.directory(4), filename, PNG);
  mockDb.queueResponse(response({ id: 8 })); mockDb.queueError(new Error('insert failed'));
  const res = await upload();
  expect(res.status).toBe(500); expect(res.body.message).not.toContain('insert failed');
  expect(fs.readdirSync(path.join(root, media.directory(4)))).toEqual([filename]);
  expect(fs.readFileSync(path.join(root, media.directory(4), filename))).toEqual(PNG);
});

test('assigned machine image is authenticated, plant scoped, streamed with private cache headers', async () => {
  await local.write(media.directory(4), filename, PNG);
  mockDb.queueResponse(response(asset()), response({ assigned: true, allowed: true }));
  const res = await request(app).get(url);
  expect(res.status).toBe(200); expect(res.body).toEqual(PNG);
  expect(res.headers['content-type']).toMatch(/^image\/png/);
  expect(res.headers['cache-control']).toBe('private, no-cache');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers.etag).toBe(`"${asset().sha256}"`);
  expect(mockDb.calls()[1].params).toEqual([4, url, 8]);
});

test('anonymous, cross-company and traversal reads never open the file', async () => {
  const spy = jest.spyOn(local, 'open');
  mockUser = null;
  expect((await request(app).get(url)).status).toBe(401);
  mockUser = { id: 2, company_id: 5, permissions: ['page:machines:view'] };
  expect((await request(app).get(url)).status).toBe(404);
  mockUser.company_id = 4;
  expect((await request(app).get('/api/files/companies/4/images/machines/%2e%2e%2fsecret.png')).status).toBe(404);
  expect(spy).not.toHaveBeenCalled(); expect(mockDb.calls()).toHaveLength(0);
  spy.mockRestore();
});

test('revoked image read permissions deny stream even for an assigned image', async () => {
  mockUser.permissions = ['page:programs:view'];
  const spy = jest.spyOn(local, 'open');
  expect((await request(app).get(url)).status).toBe(403);
  expect(spy).not.toHaveBeenCalled(); expect(mockDb.calls()).toHaveLength(0);
  spy.mockRestore();
});

test('a moved machine image cannot be read through its old uploader preview permission', async () => {
  mockDb.queueResponse(response(asset()), response({ assigned: true, allowed: false }));
  const spy = jest.spyOn(local, 'open');
  expect((await request(app).get(url)).status).toBe(404);
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});

test('plant deletion leaves retained unassigned bytes private from the former plant-bound uploader', async () => {
  mockDb.queueResponse(response(asset({ plant_id: null })), response({ assigned: false, allowed: false }));
  const spy = jest.spyOn(local, 'open');
  expect((await request(app).get(url)).status).toBe(404);
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});

test('a retained image with a deleted plant cannot be newly assigned to another plant', async () => {
  mockDb.queueResponse(response(asset({ plant_id: null })));
  await expect(media.validateImageReference({ user: mockUser, imageUrl: url, plantId: 8 }))
    .rejects.toMatchObject({ code: 'IMAGE_PLANT_MISMATCH' });
  mockDb.queueResponse(response(asset({ plant_id: null })));
  await expect(media.validateImageReference({ user: { ...mockUser, roles: ['COMPANY_ADMIN'] }, imageUrl: url, plantId: null }))
    .rejects.toMatchObject({ code: 'IMAGE_PLANT_MISMATCH' });
});

test.each([2, 3])('unassigned upload preview is restricted to its authorized uploader, requested user %s', async id => {
  mockUser.id = id;
  await local.write(media.directory(4), filename, PNG);
  mockDb.queueResponse(response(asset()), response({ assigned: false, allowed: false }));
  expect((await request(app).get(url)).status).toBe(id === 2 ? 200 : 404);
});

test('missing local file responds with JSON before any stream headers', async () => {
  mockDb.queueResponse(response(asset()), response({ assigned: true, allowed: true }));
  const res = await request(app).get(url);
  expect([res.status, res.body.code]).toEqual([404, 'IMAGE_FILE_MISSING']);
  expect(res.headers['content-type']).toMatch(/application\/json/);
});

test('304 still checks current authorization before conditional response', async () => {
  await local.write(media.directory(4), filename, PNG);
  mockDb.queueResponse(response(asset()), response({ assigned: true, allowed: true }));
  const res = await request(app).get(url).set('If-None-Match', `"${asset().sha256}"`);
  expect(res.status).toBe(304);
  expect(mockDb.calls()).toHaveLength(2);
  mockDb.queueResponse(response(asset()), response({ assigned: true, allowed: false }));
  expect((await request(app).get(url).set('If-None-Match', `"${asset().sha256}"`)).status).toBe(404);
});

test('an invalid database storage key cannot read another local file', async () => {
  mockDb.queueResponse(response(asset({ storage_key: '../../private' })));
  const spy = jest.spyOn(local, 'open');
  expect((await request(app).get(url)).status).toBe(404);
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});

test('machine reference rejects foreign company, wrong plant and arbitrary remote URL', async () => {
  await expect(media.validateImageReference({ user: mockUser, imageUrl: url.replace('/4/', '/5/'), plantId: 8 })).rejects.toMatchObject({ status: 404 });
  mockDb.queueResponse(response(asset({ plant_id: 9 })));
  await expect(media.validateImageReference({ user: mockUser, imageUrl: url, plantId: 8 })).rejects.toMatchObject({ code: 'IMAGE_PLANT_MISMATCH' });
  await expect(media.validateImageReference({ user: mockUser, imageUrl: 'https://arbitrary/image.png', plantId: 8 })).rejects.toMatchObject({ code: 'INVALID_IMAGE_REFERENCE' });
});

test('ordinary edit preserves unchanged legacy URL without contacting external storage', async () => {
  const legacy = 'https://old-bucket.s3.region.amazonaws.com/images/example.png';
  expect(await media.validateImageReference({ user: mockUser, imageUrl: legacy, existingImageUrl: legacy, plantId: 8 })).toBe(legacy);
  expect(mockDb.calls()).toHaveLength(0);
});

test('new image reference uses the supplied transaction client', async () => {
  const client = { query: jest.fn(async () => response(asset())) };
  expect(await media.validateImageReference({ user: mockUser, imageUrl: url, plantId: 8, client })).toBe(url);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FROM media_assets'), [4, filename]);
  expect(mockDb.calls()).toHaveLength(0);
});
