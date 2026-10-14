/* Explicit operator-run import only. Requiring this module never loads .env,
 * connects to a database, contacts a URL or starts application services. */
const crypto = require('node:crypto');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const { MAX_BYTES, ALLOWED_MIME, typeOf, directory, fileUrl } = require('./image-types');

const TIMEOUT_MS = 20000;
const PAGE_SIZE = 100;

function failure(code) { return Object.assign(new Error(code), { code, importFailure: true }); }
function positiveId(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647; }
function safeKey(value) {
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
    || /[\\\x00-\x1f\x7f<>:"|?*]/.test(segment) || /[. ]$/.test(segment))) throw failure('UNSAFE_SOURCE_KEY');
  return value;
}

function normalizeSource({ origin, prefix } = {}) {
  // No userinfo, IP literal, explicit port, credentials, path or signed query
  // is accepted in an operator's approved source origin.
  if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/?$/i.test(origin)) throw failure('INVALID_SOURCE_ORIGIN');
  const parsed = new URL(origin);
  if (net.isIP(parsed.hostname) || !parsed.hostname.includes('.') || parsed.hostname.endsWith('.')) throw failure('INVALID_SOURCE_ORIGIN');
  if (typeof prefix !== 'string' || !prefix.startsWith('/') || !prefix.endsWith('/') || prefix === '/' || /[?#\\]/.test(prefix)) throw failure('INVALID_SOURCE_PREFIX');
  try {
    if (new URL(prefix, parsed.origin).pathname !== prefix) throw failure('INVALID_SOURCE_PREFIX');
    safeKey(prefix.slice(1, -1).split('/').map(segment => decodeURIComponent(segment)).join('/'));
  } catch { throw failure('INVALID_SOURCE_PREFIX'); }
  return { origin: parsed.origin, prefix };
}

function matchSource(value, source) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== source.origin || !url.pathname.startsWith(source.prefix)) return null;
  const authority = /^https:\/\/([^/]+)/i.exec(value)?.[1];
  if (!authority || /[:@]/.test(authority) || url.username || url.password || value.includes('?') || value.includes('#')) throw failure('UNSAFE_SOURCE_URL');
  let key;
  try {
    key = url.pathname.slice(1).split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      if (decoded.includes('/')) throw failure('UNSAFE_SOURCE_KEY');
      return decoded;
    }).join('/');
  } catch { throw failure('UNSAFE_SOURCE_KEY'); }
  safeKey(key);
  return { url, key };
}

function otherRemote(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && [0, 2].includes(c)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6 && !address.includes('%') && !address.includes('.')) {
    const halves = address.toLowerCase().split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const groups = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(group => parseInt(group, 16));
    // Only global unicast; exclude documentation, transition and special-use
    // subnets too. IPv4-mapped, loopback, ULA and link-local fail this range.
    return groups[0] >= 0x2000 && groups[0] <= 0x3fff && groups[0] !== 0x2002 && groups[0] !== 0x3fff
      && !(groups[0] === 0x2001 && (groups[1] < 0x0200 || groups[1] === 0x0db8));
  }
  return false;
}

async function publicLookup(hostname, { lookup = dns.lookup, timeoutMs = TIMEOUT_MS } = {}) {
  let timer;
  try {
    const records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('SOURCE_TIMEOUT')), timeoutMs); })
    ]);
    if (!records.length || records.some(record => !publicAddress(record.address))) throw failure('SOURCE_NETWORK_NOT_PUBLIC');
    return records.find(record => record.family === 4) || records[0];
  } catch (error) {
    if (error.importFailure) throw error;
    throw failure('SOURCE_DNS_FAILED');
  } finally { clearTimeout(timer); }
}

async function downloadHTTPS(url, { lookup = dns.lookup, request = https.request, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  const selected = await publicLookup(url.hostname, { lookup, timeoutMs });
  const remaining = Math.max(1, timeoutMs - (Date.now() - started));
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { response?.destroy(); req?.destroy(); reject(error); }
      else resolve(value);
    };
    try {
      req = request(url, {
        method: 'GET', agent: false, autoSelectFamily: false, rejectUnauthorized: true,
        // Pin the already-validated address. A second lookup cannot rebind
        // the approved host to a private address between validation/connect.
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        headers: { Accept: 'image/jpeg, image/png, image/webp', 'Accept-Encoding': 'identity' }
      }, res => {
        response = res;
        if (res.statusCode >= 300 && res.statusCode < 400) return finish(failure('SOURCE_REDIRECT_NOT_ALLOWED'));
        if (res.statusCode !== 200) return finish(failure(res.statusCode === 404 ? 'SOURCE_NOT_FOUND' : res.statusCode === 403 ? 'SOURCE_ACCESS_DENIED' : 'SOURCE_HTTP_ERROR'));
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return finish(failure('SOURCE_ENCODING_NOT_SUPPORTED'));
        const mimeType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_MIME.has(mimeType)) return finish(failure('INVALID_IMAGE_CONTENT'));
        const length = res.headers['content-length'];
        if (length != null && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BYTES)) return finish(failure('IMAGE_TOO_LARGE'));
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_BYTES) return finish(failure('IMAGE_TOO_LARGE'));
          chunks.push(chunk);
        });
        res.once('error', () => finish(failure('SOURCE_DOWNLOAD_FAILED')));
        res.once('aborted', () => finish(failure('SOURCE_DOWNLOAD_FAILED')));
        res.once('end', () => {
          if (length != null && Number(length) !== bytes) return finish(failure('SOURCE_DOWNLOAD_FAILED'));
          finish(null, { buffer: Buffer.concat(chunks, bytes), mimeType });
        });
      });
      req.once('error', () => finish(failure('SOURCE_DOWNLOAD_FAILED')));
      timer = setTimeout(() => finish(failure('SOURCE_TIMEOUT')), remaining);
      req.end();
    } catch { finish(failure('SOURCE_DOWNLOAD_FAILED')); }
  });
}

function directoryDownloader(sourceDirectory) {
  const source = require('./local-storage').createStore(path.resolve(sourceDirectory));
  return async (_url, key) => {
    let opened;
    try {
      const safe = safeKey(key);
      opened = await source.open(path.posix.dirname(safe) === '.' ? '' : path.posix.dirname(safe), path.posix.basename(safe));
      if (opened.size <= 0 || opened.size > MAX_BYTES) throw failure('IMAGE_TOO_LARGE');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of opened.stream) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw failure('IMAGE_TOO_LARGE');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks, bytes);
      return { buffer, mimeType: typeOf(buffer)?.mime };
    } catch (error) {
      opened?.stream.destroy();
      if (error.importFailure) throw error;
      throw failure(error.code === 'ENOENT' ? 'SOURCE_FILE_NOT_FOUND' : 'SOURCE_FILE_NOT_READABLE');
    }
  };
}

function checkedImage(value) {
  if (!Buffer.isBuffer(value?.buffer) || !value.buffer.length) throw failure('INVALID_IMAGE_CONTENT');
  if (value.buffer.length > MAX_BYTES) throw failure('IMAGE_TOO_LARGE');
  const type = typeOf(value.buffer);
  if (!type || type.mime !== value.mimeType || !ALLOWED_MIME.has(value.mimeType)) throw failure('INVALID_IMAGE_CONTENT');
  return { ...type, buffer: value.buffer, sha256: crypto.createHash('sha256').update(value.buffer).digest('hex') };
}

function createImporter({ pool, store, source, download = downloadHTTPS, sourceDirectory, onProgress = () => {} } = {}) {
  if (!pool?.connect || !pool?.query || !store?.write || !store?.remove) throw failure('INVALID_IMPORT_CONFIGURATION');
  source = normalizeSource(source);
  const fetch = sourceDirectory ? directoryDownloader(sourceDirectory) : download;
  const result = (snapshot, status, code, assetId) => ({ status, code, machine_id: Number(snapshot.id),
    company_id: Number(snapshot.company_id), ...(assetId ? { asset_id: assetId } : {}) });
  async function removeNew(relative, filename) {
    try { await store.remove(relative, filename); return true; } catch { return false; }
  }

  async function reconcile(snapshot, asset) {
    let client;
    let discard;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5000ms'");
      // This barrier waits for the original transaction's machine lock, so
      // an unacknowledged COMMIT cannot finish after we decide to delete bytes.
      const machine = await client.query('SELECT image_url FROM machines WHERE id=$1 FOR UPDATE', [snapshot.id]);
      const found = await client.query(`SELECT company_id,storage_key,sha256,mime_type,size_bytes
        FROM media_assets WHERE id=$1`, [asset.id]);
      await client.query('COMMIT');
      const row = found.rows[0];
      if (row && Number(row.company_id) === Number(snapshot.company_id) && row.storage_key === asset.storageKey
        && row.sha256 === asset.image.sha256 && row.mime_type === asset.image.mime && Number(row.size_bytes) === asset.image.buffer.length) return 'committed';
      if (!row && machine.rows[0]?.image_url !== asset.url) return 'not-committed';
      return 'unknown';
    } catch {
      try { await client?.query('ROLLBACK'); } catch (error) { discard = error; }
      return 'unknown';
    }
    finally { client?.release(discard); }
  }

  async function importMachine(snapshot) {
    let matched;
    try { matched = matchSource(snapshot.image_url, source); }
    catch (error) { return result(snapshot, 'failed', error.code); }
    if (!matched) return result(snapshot, 'skipped', otherRemote(snapshot.image_url) ? 'OTHER_REMOTE_SOURCE' : 'NOT_LEGACY_SOURCE');
    if (!positiveId(snapshot.id) || !positiveId(snapshot.company_id)) return result(snapshot, 'failed', 'INVALID_MACHINE_OWNER');
    if (!positiveId(snapshot.plant_id)) return result(snapshot, 'failed', 'UNPLACED_MACHINE');
    if (snapshot.valid_plant === false) return result(snapshot, 'failed', 'INVALID_MACHINE_PLANT');
    let image;
    try { image = checkedImage(await fetch(matched.url, matched.key)); }
    catch (error) { return result(snapshot, 'failed', error.importFailure ? error.code : 'SOURCE_DOWNLOAD_FAILED'); }
    let client;
    let active = false;
    let written = false;
    let attemptedCommit = false;
    let discard;
    let asset;
    try {
      client = await pool.connect();
      await client.query('BEGIN'); active = true;
      const { rows } = await client.query(`SELECT id,company_id,plant_id,image_url FROM machines
        WHERE id=$1 AND company_id=$2 FOR UPDATE`, [snapshot.id, snapshot.company_id]);
      const machine = rows[0];
      if (!machine || machine.image_url !== snapshot.image_url || Number(machine.plant_id) !== Number(snapshot.plant_id)) {
        await client.query('ROLLBACK'); active = false;
        return result(snapshot, 'changed', 'MACHINE_CHANGED');
      }
      const ownedPlant = await client.query('SELECT id FROM plants WHERE id=$1 AND company_id=$2 FOR KEY SHARE', [machine.plant_id, machine.company_id]);
      if (!ownedPlant.rows.length) throw failure('INVALID_MACHINE_PLANT');
      const id = crypto.randomUUID();
      const filename = `${id}.${image.extension}`;
      const relative = directory(Number(machine.company_id));
      asset = { id, filename, relative, image, storageKey: `${relative}/${filename}`, url: fileUrl(Number(machine.company_id), filename) };
      await store.write(relative, filename, image.buffer); written = true;
      await client.query(`INSERT INTO media_assets
        (id,company_id,plant_id,purpose,storage_key,filename,mime_type,size_bytes,sha256,uploaded_by)
        VALUES ($1,$2,$3,'machine-images',$4,$5,$6,$7,$8,NULL)`,
      [id, machine.company_id, machine.plant_id, asset.storageKey, filename, image.mime, image.buffer.length, image.sha256]);
      const updated = await client.query(`UPDATE machines SET image_url=$1
        WHERE id=$2 AND company_id=$3 AND image_url=$4 AND plant_id=$5 RETURNING id`,
      [asset.url, machine.id, machine.company_id, snapshot.image_url, machine.plant_id]);
      if (updated.rowCount !== 1) throw failure('MACHINE_CHANGED');
      attemptedCommit = true;
      await client.query('COMMIT'); active = false;
      return result(snapshot, 'imported', 'IMPORTED', id);
    } catch (error) {
      if (attemptedCommit) {
        // Never blindly compensate an ambiguous commit. Destroy that client
        // and confirm the durable outcome on a fresh connection first.
        client?.release(error); client = null; active = false;
        const outcome = await reconcile(snapshot, asset);
        if (outcome === 'committed') return result(snapshot, 'imported', 'IMPORTED_RECONCILED', asset.id);
        if (outcome === 'unknown') return result(snapshot, 'pending', 'COMMIT_RECONCILIATION_REQUIRED', asset.id);
        const removed = await removeNew(asset.relative, asset.filename);
        return result(snapshot, 'failed', removed ? 'COMMIT_NOT_APPLIED' : 'FILE_CLEANUP_REQUIRED', asset.id);
      }
      if (active) {
        try { await client?.query('ROLLBACK'); } catch (rollbackError) { discard = rollbackError; }
      }
      const removed = !written || await removeNew(asset.relative, asset.filename);
      return result(snapshot, 'failed', !removed ? 'FILE_CLEANUP_REQUIRED' : error.importFailure ? error.code
        : ['ENOSPC', 'EDQUOT'].includes(error.code) ? 'STORAGE_NO_SPACE' : 'IMPORT_WRITE_FAILED', asset?.id);
    } finally { client?.release(discard); }
  }

  async function run({ apply = false, companyId = null } = {}) {
    if (companyId != null && !positiveId(companyId)) throw failure('INVALID_COMPANY_ID');
    if (apply) {
      try {
        // Stop once before any downloads/new files if 046 has not been
        // applied. This is a read-only schema/permission check, never DDL.
        await pool.query(`SELECT id,company_id,plant_id,purpose,storage_key,filename,mime_type,size_bytes,sha256,uploaded_by
          FROM media_assets LIMIT 0`);
      } catch (error) {
        throw failure(['42P01', '42703'].includes(error.code) ? 'MEDIA_MIGRATION_REQUIRED' : 'MEDIA_CATALOGUE_UNAVAILABLE');
      }
    }
    const summary = { mode: apply ? 'apply' : 'dry-run', scanned: 0, candidates: 0, eligible: 0, imported: 0,
      changed: 0, failed: 0, pending: 0, skipped: 0, other_remote: 0 };
    const high = await pool.query('SELECT COALESCE(MAX(id),0) AS max_id FROM machines WHERE ($1::int IS NULL OR company_id=$1)', [companyId]);
    const maximum = Number(high.rows[0]?.max_id || 0);
    let cursor = 0;
    while (cursor < maximum) {
      const { rows } = await pool.query(`SELECT m.id,m.company_id,m.plant_id,m.image_url,(p.id IS NOT NULL) AS valid_plant
        FROM machines m LEFT JOIN plants p ON p.id=m.plant_id AND p.company_id=m.company_id
        WHERE m.id>$1 AND m.id<=$2 AND ($3::int IS NULL OR m.company_id=$3)
        ORDER BY m.id LIMIT ${PAGE_SIZE}`, [cursor, maximum, companyId]);
      if (!rows.length) break;
      for (const snapshot of rows) {
        cursor = Number(snapshot.id); summary.scanned++;
        let matched;
        try { matched = matchSource(snapshot.image_url, source); }
        catch (error) { summary.candidates++; summary.failed++; onProgress(result(snapshot, 'failed', error.code)); continue; }
        if (!matched) {
          summary.skipped++;
          if (otherRemote(snapshot.image_url)) {
            summary.other_remote++;
            onProgress(result(snapshot, 'skipped', 'OTHER_REMOTE_SOURCE'));
          }
          continue;
        }
        summary.candidates++;
        let outcome;
        if (!positiveId(snapshot.company_id)) outcome = result(snapshot, 'failed', 'INVALID_MACHINE_OWNER');
        else if (!positiveId(snapshot.plant_id)) outcome = result(snapshot, 'failed', 'UNPLACED_MACHINE');
        else if (!snapshot.valid_plant) outcome = result(snapshot, 'failed', 'INVALID_MACHINE_PLANT');
        else {
          summary.eligible++;
          outcome = apply ? await importMachine(snapshot) : result(snapshot, 'candidate', 'ELIGIBLE');
        }
        if (Object.hasOwn(summary, outcome.status)) summary[outcome.status]++;
        onProgress(outcome);
      }
    }
    return summary;
  }
  return { run, importMachine };
}

function parseOptions(args = []) {
  const options = { apply: false, companyId: null, sourceDirectory: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (seen.has(key)) throw failure('DUPLICATE_OPTION');
    seen.add(key);
    if (key === '--help') { options.help = true; continue; }
    if (key === '--apply') { options.apply = true; continue; }
    if (key === '--dry-run') continue;
    if (!['--source-origin', '--source-prefix', '--company-id', '--source-dir'].includes(key)) throw failure('UNKNOWN_OPTION');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw failure('OPTION_VALUE_REQUIRED');
    if (key === '--source-origin') options.origin = value;
    if (key === '--source-prefix') options.prefix = value;
    if (key === '--company-id') options.companyId = value;
    if (key === '--source-dir') options.sourceDirectory = path.resolve(value);
  }
  if (seen.has('--apply') && seen.has('--dry-run')) throw failure('CONFLICTING_OPTIONS');
  if (options.help) return options;
  options.source = normalizeSource({ origin: options.origin, prefix: options.prefix });
  if (options.companyId != null) {
    if (!positiveId(options.companyId) || !/^[1-9]\d*$/.test(options.companyId)) throw failure('INVALID_COMPANY_ID');
    options.companyId = Number(options.companyId);
  }
  return options;
}

module.exports = { TIMEOUT_MS, PAGE_SIZE, normalizeSource, matchSource, publicAddress, publicLookup,
  downloadHTTPS, directoryDownloader, checkedImage, createImporter, parseOptions };
