#!/usr/bin/env node
/* Disposable PostgreSQL + private files. Never loads .env, contacts S3, or
 * writes an application database. All remote downloads are fixture bytes. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const repo = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-legacy-media-'));
const pgBin = process.env.LEGACY_IMAGE_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const storageRoot = path.join(directory, 'private-storage');
process.env.STORAGE_ROOT = storageRoot;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9kAAAAASUVORK5CYII=', 'base64');
const origin = 'https://images.fixture.invalid';
const prefix = '/legacy-images/';
const remote = name => `${origin}${prefix}${name}`;
let pool, running = false;

function filesBelow(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesBelow(path.join(folder, entry.name)).map(child => `${entry.name}/${child}`)
    : [entry.name]).sort();
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Wrap real pg clients only to inject response loss; SQL still executes on the
// isolated PostgreSQL server. Reconciliation can obtain fresh connections.
function observedPool({ afterQuery, commit, refuseReconciliation = false } = {}) {
  let injected = false;
  const sql = [];
  return {
    sql,
    query: async (...args) => { sql.push(args[0]); return pool.query(...args); },
    connect: async () => {
      if (injected && refuseReconciliation) throw Object.assign(new Error('fixture reconnection unavailable'), { code: 'ECONNRESET' });
      const client = await pool.connect();
      return {
        query: async (...args) => {
          sql.push(args[0]);
          if (!injected && commit && /^\s*COMMIT\s*;?\s*$/i.test(args[0])) {
            injected = true;
            return commit(client);
          }
          const result = await client.query(...args);
          await afterQuery?.(args[0], args[1], result);
          return result;
        },
        release: error => client.release(error)
      };
    }
  };
}

async function main() {
  try {
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(directory, 'data'), '-U', 'legacy_image_fixture', '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'),
      '-o', `-k ${directory} -p 55448 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    pool = new Pool({ host: directory, port: 55448, user: 'legacy_image_fixture', database: 'postgres', max: 8 });
    await pool.query(`CREATE TABLE companies(id INT PRIMARY KEY);
      CREATE TABLE plants(id INT PRIMARY KEY,company_id INT,is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE users(id INT PRIMARY KEY);
      CREATE TABLE machines(id INT PRIMARY KEY,company_id INT,plant_id INT REFERENCES plants(id),image_url TEXT,
        machine_serial_no TEXT,is_active BOOLEAN DEFAULT TRUE);
      INSERT INTO companies VALUES(4),(5);
      INSERT INTO plants(id,company_id) VALUES(8,4),(9,4),(10,5);`);
    await pool.query(fs.readFileSync(path.join(repo, 'src/migrations/046_local_media.sql'), 'utf8'));
    const { createStore } = require(path.join(repo, 'src/files/local-storage'));
    const { createImporter, normalizeSource } = require(path.join(repo, 'src/files/legacy-image-import'));
    const store = createStore(storageRoot);
    const source = normalizeSource({ origin, prefix });
    const originalDirectory = path.join(directory, 'old-object-backup');
    fs.mkdirSync(originalDirectory, { mode: 0o750 });
    const originalFile = path.join(originalDirectory, 'same-name.png');
    fs.writeFileSync(originalFile, PNG, { mode: 0o640 });
    const downloads = [];
    const download = async url => { downloads.push(url); return { buffer: fs.readFileSync(originalFile), mimeType: 'image/png' }; };
    const importer = (extra = {}) => createImporter({ pool, store, source, download, ...extra });
    const addMachine = async (id, { company = 4, plant = 8, url = remote(`machine-${id}.png`) } = {}) => {
      await pool.query('INSERT INTO machines(id,company_id,plant_id,image_url,machine_serial_no) VALUES($1,$2,$3,$4,$5)',
        [id, company, plant, url, `CNC-${id}`]);
    };
    const snapshot = async id => (await pool.query(`SELECT m.*,
      EXISTS(SELECT 1 FROM plants p WHERE p.id=m.plant_id AND p.company_id=m.company_id) AS valid_plant
      FROM machines m WHERE m.id=$1`, [id])).rows[0];
    const assets = async () => (await pool.query('SELECT * FROM media_assets ORDER BY id')).rows;
    const verifyAsset = async (result, id, company, plant) => {
      assert.ok(result.asset_id, 'Successful import returns its new asset identity');
      const asset = (await pool.query('SELECT * FROM media_assets WHERE id=$1', [result.asset_id])).rows[0];
      assert.equal(asset.company_id, company);
      assert.equal(asset.plant_id, plant);
      assert.equal(asset.uploaded_by, null);
      assert.equal(asset.mime_type, 'image/png');
      assert.equal(asset.size_bytes, PNG.length);
      assert.equal(asset.storage_key, `company-${company}/images/machines/${asset.filename}`);
      assert.equal((await snapshot(id)).image_url, `/api/files/companies/${company}/images/machines/${asset.filename}`);
      assert.deepEqual(await store.read(`company-${company}/images/machines`, asset.filename), PNG);
      return asset;
    };

    await addMachine(101, { url: remote('same-name.png') });
    await addMachine(102, { company: 5, plant: 10, url: remote('same-name.png') });
    await addMachine(103, { plant: null });
    await addMachine(104, { plant: 10 }); // Legacy foreign-company plant.
    await addMachine(105, { url: 'https://other.fixture.invalid/legacy-images/outside.png' });
    const beforeDry = (await pool.query('SELECT * FROM machines ORDER BY id')).rows;
    const dryPool = observedPool();
    await importer({ pool: dryPool }).run({ apply: false, companyId: 4 });
    assert.equal(downloads.length, 0, 'Dry-run performs no downloads');
    assert.deepEqual(await assets(), [], 'Dry-run does not create catalogue rows');
    assert.deepEqual((await pool.query('SELECT * FROM machines ORDER BY id')).rows, beforeDry);
    assert.equal(fs.existsSync(storageRoot), false, 'Dry-run does not even create a storage directory');
    assert.equal(dryPool.sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(text)), false,
      'Dry-run never issues SQL writes');

    let atomicObserved = false;
    const atomicPool = observedPool({ afterQuery: async (text) => {
      if (/^\s*UPDATE\s+machines\b/i.test(text)) {
        atomicObserved = true;
        assert.equal((await snapshot(101)).image_url, remote('same-name.png'), 'Outside transaction readers still see the original image');
        assert.equal((await assets()).length, 0, 'Catalogue insert is not published ahead of machine assignment');
      }
    } });
    const first = await importer({ pool: atomicPool }).importMachine(await snapshot(101));
    assert.equal(first.status, 'imported');
    assert.equal(atomicObserved, true);
    const firstAsset = await verifyAsset(first, 101, 4, 8);
    const second = await importer().importMachine(await snapshot(102));
    assert.equal(second.status, 'imported');
    const secondAsset = await verifyAsset(second, 102, 5, 10);
    assert.notEqual(firstAsset.storage_key, secondAsset.storage_key, 'Same remote filename belongs to separate tenant directories');

    const beforeResume = filesBelow(storageRoot);
    const readsBeforeResume = downloads.length;
    await importer().run({ apply: true, companyId: 4 });
    assert.equal(downloads.length, readsBeforeResume, 'Resume skips existing local references and invalid placement/source candidates');
    assert.deepEqual(filesBelow(storageRoot), beforeResume);
    assert.equal((await snapshot(103)).image_url, remote('machine-103.png'), 'Unplaced machine remains untouched');
    assert.equal((await snapshot(104)).image_url, remote('machine-104.png'), 'Foreign-company plant reference remains untouched');
    assert.equal((await snapshot(105)).image_url, 'https://other.fixture.invalid/legacy-images/outside.png');

    // A machine edit during the external read must win over the old snapshot.
    await addMachine(106);
    const pause = deferred(), started = deferred();
    const changing = importer({ download: async () => { started.resolve(); await pause.promise; return { buffer: PNG, mimeType: 'image/png' }; } });
    const changeImport = changing.importMachine(await snapshot(106));
    await started.promise;
    await pool.query('UPDATE machines SET image_url=$1 WHERE id=106', [remote('operator-changed.png')]);
    pause.resolve();
    const changed = await changeImport;
    assert.equal(changed.status, 'changed');
    assert.equal((await snapshot(106)).image_url, remote('operator-changed.png'));
    assert.deepEqual(filesBelow(storageRoot), beforeResume, 'Race never leaves an unwanted local asset');

    await addMachine(114);
    const plantPause = deferred(), plantStarted = deferred();
    const moving = importer({ download: async () => { plantStarted.resolve(); await plantPause.promise; return { buffer: PNG, mimeType: 'image/png' }; } });
    const movingImport = moving.importMachine(await snapshot(114));
    await plantStarted.promise;
    await pool.query('UPDATE machines SET plant_id=9 WHERE id=114');
    plantPause.resolve();
    assert.equal((await movingImport).status, 'changed');
    assert.equal((await snapshot(114)).plant_id, 9);
    assert.equal((await snapshot(114)).image_url, remote('machine-114.png'));
    assert.deepEqual(filesBelow(storageRoot), beforeResume, 'Placement change invalidates the import snapshot without leftover files');

    await addMachine(115);
    const ownerPause = deferred(), ownerStarted = deferred();
    const reassigning = importer({ download: async () => { ownerStarted.resolve(); await ownerPause.promise; return { buffer: PNG, mimeType: 'image/png' }; } });
    const ownershipImport = reassigning.importMachine(await snapshot(115));
    await ownerStarted.promise;
    await pool.query('UPDATE machines SET company_id=5,plant_id=10 WHERE id=115');
    ownerPause.resolve();
    assert.equal((await ownershipImport).status, 'changed');
    assert.equal((await snapshot(115)).company_id, 5);
    assert.equal((await snapshot(115)).image_url, remote('machine-115.png'));
    assert.deepEqual(filesBelow(storageRoot), beforeResume, 'Company reassignment cannot write an old tenant file or catalogue row');

    await addMachine(107, { plant: 9 });
    await pool.query(`CREATE FUNCTION fixture_reject_image_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.plant_id=9 THEN RAISE EXCEPTION 'fixture insert denied'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_image_insert BEFORE INSERT ON media_assets FOR EACH ROW EXECUTE FUNCTION fixture_reject_image_insert();`);
    const failedInsert = await importer().importMachine(await snapshot(107));
    assert.equal(failedInsert.status, 'failed');
    assert.equal((await snapshot(107)).image_url, remote('machine-107.png'));
    assert.equal((await assets()).length, 2);
    assert.deepEqual(filesBelow(storageRoot), beforeResume, 'Rejected catalogue insert removes only its new bytes');
    await pool.query('DROP TRIGGER fixture_reject_image_insert ON media_assets; DROP FUNCTION fixture_reject_image_insert()');

    await addMachine(108);
    await pool.query(`CREATE FUNCTION fixture_reject_image_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=108 AND NEW.image_url LIKE '/api/files/%' THEN RAISE EXCEPTION 'fixture machine update denied'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_image_update BEFORE UPDATE ON machines FOR EACH ROW EXECUTE FUNCTION fixture_reject_image_update();`);
    const failedUpdate = await importer().importMachine(await snapshot(108));
    assert.equal(failedUpdate.status, 'failed');
    assert.equal((await snapshot(108)).image_url, remote('machine-108.png'));
    assert.equal((await assets()).length, 2);
    assert.deepEqual(filesBelow(storageRoot), beforeResume, 'Rejected assignment rolls back metadata and new file together');
    await pool.query('DROP TRIGGER fixture_reject_image_update ON machines; DROP FUNCTION fixture_reject_image_update()');

    await addMachine(109);
    await pool.query(`CREATE FUNCTION fixture_reject_image_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=109 AND NEW.image_url LIKE '/api/files/%' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='fixture deferred commit denied'; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER fixture_reject_image_commit AFTER UPDATE ON machines DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fixture_reject_image_commit();`);
    const failedCommit = await importer().importMachine(await snapshot(109));
    assert.equal(failedCommit.status, 'failed');
    assert.equal((await snapshot(109)).image_url, remote('machine-109.png'));
    assert.equal((await assets()).length, 2);
    assert.deepEqual(filesBelow(storageRoot), beforeResume, 'Known failed commit preserves existing files and compensates only its new UUID');
    await pool.query('DROP TRIGGER fixture_reject_image_commit ON machines; DROP FUNCTION fixture_reject_image_commit()');

    const connectionLost = () => Object.assign(new Error('fixture lost COMMIT reply'), { code: 'ECONNRESET' });
    await addMachine(110);
    const committedPool = observedPool({ commit: async client => { await client.query('COMMIT'); throw connectionLost(); } });
    const reconciled = await importer({ pool: committedPool }).importMachine(await snapshot(110));
    assert.equal(reconciled.status, 'imported');
    assert.equal(reconciled.code, 'IMPORTED_RECONCILED');
    await verifyAsset(reconciled, 110, 4, 8);

    await addMachine(111);
    const retainedBefore = filesBelow(storageRoot);
    const unavailablePool = observedPool({ commit: async client => { await client.query('COMMIT'); throw connectionLost(); }, refuseReconciliation: true });
    const pending = await importer({ pool: unavailablePool }).importMachine(await snapshot(111));
    assert.equal(pending.status, 'pending');
    assert.equal(pending.code, 'COMMIT_RECONCILIATION_REQUIRED');
    assert.equal(filesBelow(storageRoot).length, retainedBefore.length + 1, 'Uncertain commit never deletes possibly committed bytes');
    const pendingMachine = await snapshot(111);
    const committedAsset = (await pool.query('SELECT * FROM media_assets WHERE filename=$1', [pendingMachine.image_url.split('/').pop()])).rows[0];
    assert.ok(committedAsset, 'The fixture actually committed before losing its reply');
    assert.deepEqual(await store.read(`company-4/images/machines`, committedAsset.filename), PNG);

    await addMachine(112);
    const abortedBefore = filesBelow(storageRoot);
    const abortedPool = observedPool({ commit: async client => { await client.query('ROLLBACK'); throw connectionLost(); } });
    const notApplied = await importer({ pool: abortedPool }).importMachine(await snapshot(112));
    assert.equal(notApplied.status, 'failed');
    assert.equal(notApplied.code, 'COMMIT_NOT_APPLIED');
    assert.equal((await snapshot(112)).image_url, remote('machine-112.png'));
    assert.deepEqual(filesBelow(storageRoot), abortedBefore, 'A fresh locked reconciliation can prove absence before removing new bytes');

    await addMachine(113);
    const orphanBefore = filesBelow(storageRoot);
    const uncertainPool = observedPool({ commit: async client => { await client.query('ROLLBACK'); throw connectionLost(); }, refuseReconciliation: true });
    const uncertain = await importer({ pool: uncertainPool }).importMachine(await snapshot(113));
    assert.equal(uncertain.status, 'pending');
    assert.equal(uncertain.code, 'COMMIT_RECONCILIATION_REQUIRED');
    assert.equal((await snapshot(113)).image_url, remote('machine-113.png'));
    assert.equal(filesBelow(storageRoot).length, orphanBefore.length + 1, 'Even an actually absent commit retains bytes when no fresh proof is available');

    // Private buckets can be copied to an operator-controlled full-key tree.
    // Importing that backup is a read; no cloud request or source deletion is
    // permitted even after the new tenant file and database assignment commit.
    const originalKey = path.join(originalDirectory, 'legacy-images/archive/source.png');
    fs.mkdirSync(path.dirname(originalKey), { recursive: true, mode: 0o750 });
    fs.writeFileSync(originalKey, PNG, { mode: 0o640 });
    await addMachine(116, { company: 5, plant: 10, url: remote('archive/source.png') });
    const localSource = await importer({ sourceDirectory: originalDirectory,
      download: async () => { throw new Error('A source-directory import must never contact the network'); }
    }).importMachine(await snapshot(116));
    assert.equal(localSource.status, 'imported');
    await verifyAsset(localSource, 116, 5, 10);
    assert.deepEqual(fs.readFileSync(originalKey), PNG, 'Import copies original bucket backup bytes and never deletes them');
    assert.deepEqual(fs.readFileSync(originalFile), PNG, 'Original legacy object backup is never modified or deleted');

    console.log('PASS legacy image import: real PostgreSQL transactions, dry-run without writes/downloads, tenant/plant ownership, atomic catalogue and machine assignment, immutable company paths, resume, concurrent image/plant/company edit protection, failed insert/update/deferred COMMIT cleanup, successful lost-COMMIT reconciliation, safe uncertain-COMMIT retention and private bucket backup import without modifying source bytes.');
  } finally {
    if (pool) await pool.end();
    if (running) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
