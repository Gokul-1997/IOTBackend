#!/usr/bin/env node
/* Disposable PostgreSQL + files only. No .env, external service, customer
 * credentials or operational database is loaded by this verification. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const repo = path.resolve(__dirname, '../..');
const pgBin = process.env.MEDIA_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-media-fixture-'));
process.env.STORAGE_ROOT = path.join(directory, 'storage');
const migration = fs.readFileSync(path.join(repo, 'src/migrations/046_local_media.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(repo, 'src/migrations/rollback/046_local_media_down.sql'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9kAAAAASUVORK5CYII=', 'base64');
let pool;
let running = false;

(async () => {
  try {
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(directory, 'data'), '-U', 'media_fixture', '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'),
      '-o', `-F -k ${directory} -p 55446 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    pool = new Pool({ host: directory, port: 55446, user: 'media_fixture', database: 'postgres', max: 2 });
    await pool.query(`CREATE TABLE companies(id INT PRIMARY KEY);
      CREATE TABLE plants(id INT PRIMARY KEY,company_id INT,is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE users(id INT PRIMARY KEY);
      CREATE TABLE machines(id INT PRIMARY KEY,company_id INT,plant_id INT,image_url TEXT);
      INSERT INTO companies VALUES(4),(5);
      INSERT INTO plants VALUES(8,4),(9,4),(10,5);
      INSERT INTO users VALUES(2),(3);
      INSERT INTO machines VALUES(7,4,8,NULL),(8,4,9,NULL),(9,5,10,NULL);`);
    await pool.query(migration); await pool.query(migration);
    await pool.query(rollback); await pool.query(rollback);
    await pool.query(migration);
    const dbPath = require.resolve(path.join(repo, 'src/db.js'));
    const redisPath = require.resolve(path.join(repo, 'src/redis.js'));
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
    require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true,
      exports: { get: async () => '[]', set: async () => 'OK' } };
    const media = require(path.join(repo, 'src/files/media.service'));
    const local = require(path.join(repo, 'src/files/local-storage'));
    const user = { id: 2, company_id: 4, plant_id: 8, roles: ['ENGINEER'], permissions: ['page:machines:create', 'page:machines:view'] };
    const file = { buffer: PNG, mimetype: 'image/png', originalname: '../../unsafe.svg' };
    const first = await media.uploadMachineImage(user, file, 8);
    const second = await media.uploadMachineImage(user, file, 8);
    assert.notEqual(first.filename, second.filename);
    assert.deepEqual(await local.read(media.directory(4), first.filename), PNG);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM media_assets')).rows[0].n, 2);
    await assert.rejects(() => media.uploadMachineImage(user, file, 10), error => error.status === 403);
    const uploaded = await media.authorizeRead(user, 4, first.filename);
    assert.equal(uploaded.uploaded_by, 2);
    await assert.rejects(() => media.authorizeRead({ ...user, id: 3 }, 4, first.filename), error => error.status === 404);
    await assert.rejects(() => media.authorizeRead({ ...user, company_id: 5 }, 4, first.filename), error => error.status === 404);
    await assert.rejects(() => media.authorizeRead({ ...user, permissions: [] }, 4, first.filename), error => error.status === 403);
    await pool.query('UPDATE machines SET image_url=$1 WHERE id=7', [first.fileUrl]);
    assert.equal((await media.authorizeRead({ ...user, id: 3 }, 4, first.filename)).id, first.id);
    await pool.query('UPDATE machines SET plant_id=9 WHERE id=7');
    await assert.rejects(() => media.authorizeRead(user, 4, first.filename), error => error.status === 404);
    assert.equal((await media.authorizeRead({ ...user, id: 3, plant_id: 9 }, 4, first.filename)).id, first.id);
    assert.equal(await media.validateImageReference({ user: { ...user, roles: ['COMPANY_ADMIN'] }, imageUrl: first.fileUrl,
      existingImageUrl: first.fileUrl, plantId: 9 }), first.fileUrl);
    await assert.rejects(() => media.validateImageReference({ user: { ...user, roles: ['COMPANY_ADMIN'] },
      imageUrl: second.fileUrl, plantId: 9 }), error => error.code === 'IMAGE_PLANT_MISMATCH');
    await assert.rejects(() => pool.query('UPDATE media_assets SET plant_id=10 WHERE id=$1', [first.id]), error => error.code === '23503');
    await assert.rejects(() => pool.query("UPDATE media_assets SET storage_key='../../private' WHERE id=$1", [first.id]), error => error.code === '23514');
    await assert.rejects(() => pool.query('UPDATE media_assets SET size_bytes=5242881 WHERE id=$1', [first.id]), error => error.code === '23514');
    await assert.rejects(() => pool.query(rollback), /Local media exists/);
    await pool.query('ROLLBACK');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM media_assets')).rows[0].n, 2, 'Refused rollback preserves assets');
    assert.deepEqual(await local.read(media.directory(4), first.filename), PNG);
    await pool.query(`CREATE FUNCTION media_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'fixture rejection'; END $$;
      CREATE TRIGGER media_fixture_fail BEFORE INSERT ON media_assets FOR EACH ROW EXECUTE FUNCTION media_fixture_fail();`);
    const before = fs.readdirSync(path.join(process.env.STORAGE_ROOT, media.directory(4))).sort();
    await assert.rejects(() => media.uploadMachineImage(user, file, 8), /fixture rejection/);
    assert.deepEqual(fs.readdirSync(path.join(process.env.STORAGE_ROOT, media.directory(4))).sort(), before,
      'Failed catalogue insert deletes only the new image');
    await pool.query('DELETE FROM plants WHERE id=8');
    assert.deepEqual((await pool.query('SELECT company_id,plant_id FROM media_assets ORDER BY id')).rows,
      [{ company_id: 4, plant_id: null }, { company_id: 4, plant_id: null }],
      'Deleting the former plant clears only plant ownership and retains the tenant catalogue');
    assert.deepEqual(fs.readdirSync(path.join(process.env.STORAGE_ROOT, media.directory(4))).sort(), before,
      'Plant deletion never removes image bytes');
    await assert.rejects(() => media.authorizeRead(user, 4, second.filename), error => error.status === 404,
      'Former plant-bound uploader cannot read retained unassigned media');
    await assert.rejects(() => media.validateImageReference({ user: { ...user, plant_id: 9 },
      imageUrl: second.fileUrl, plantId: 9 }), error => error.code === 'IMAGE_PLANT_MISMATCH',
      'Retained unassigned media cannot be newly attached to another plant');
    assert.equal((await media.authorizeRead({ ...user, plant_id: 9 }, 4, first.filename)).id, first.id,
      'An image already attached to a moved machine follows that machine current plant');
    await assert.rejects(() => pool.query('DELETE FROM companies WHERE id=4'), error => error.code === '23503',
      'Company deletion does not discard media ownership or files implicitly');
    console.log('Local media PostgreSQL fixture passed: repeatable migration/empty rollback, retained nonempty catalogue, immutable local uploads, exact stored metadata, company/plant/grant/uploader authorization, moved-machine access, legacy reference validation, composite ownership/path/size constraints, failed-insert file cleanup and plant deletion retaining tenant catalogue/bytes with old preview access denied.');
  } finally {
    if (pool) await pool.end();
    if (running) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
