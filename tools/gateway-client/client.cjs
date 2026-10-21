/** Outbound HTTPS transport for Windows/Node-RED embedded integrations.
 * This module deliberately contains no CNC protocol or simulated controller.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const positive = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('A positive job ID is required.');
  return id;
};
const checksum = value => {
  if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('A SHA-256 checksum is required.');
  return value;
};
const lease = value => {
  if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('A job lease is required.');
  return value;
};
async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function json(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Gateway JSON response exceeds 1 MiB.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw new Error(`Gateway returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw Object.assign(new Error(body.message || `Gateway HTTP ${response.status}`), { code: body.code, status: response.status });
  return body;
}
function createClient({ origin, token, spoolRoot, maxBytes = 20 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const endpoint = new URL(origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Use an HTTPS server origin; plain HTTP is allowed only for loopback tests.');
  }
  if (!/^mxg_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('Use a private gateway token, not a user or machine token.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 ** 3) throw new Error('Set a bounded file size limit.');
  if (!spoolRoot || !path.isAbsolute(spoolRoot)) throw new Error('Configure an absolute private spoolRoot.');
  const root = path.resolve(spoolRoot);
  async function spool(name) {
    if (typeof name !== 'string' || !name || name.length > 150 || /[\\/\x00-\x1f<>:"|?*]/.test(name) || name === '.' || name === '..') throw new Error('Use a local spool filename, without a path.');
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    // A configured spool must not escape through an existing symlink.
    let current = root;
    while (true) {
      const info = await fs.promises.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The spool must use real directories, without symbolic links.');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return path.join(root, name);
  }
  const base = endpoint.origin + '/api/gateway/v1';
  const headers = { Authorization: `Bearer ${token}`, 'X-Agent-Version': 'node-red-transport/1.0' };
  async function request(route, payload = {}, options = {}) {
    const response = await fetchImpl(base + route, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeout || 35_000),
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    return json(response);
  }
  async function download(job) {
    const jobId = positive(job.id), expected = checksum(job.file?.sha256), credential = lease(job.lease_token);
    const destination = await spool(`job-${jobId}-source.nc`);
    try {
      const info = await fs.promises.lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || await digest(destination) !== expected) throw new Error('Existing spool bytes differ; preserve them for reconciliation.');
      return { filename: path.basename(destination), sha256: expected, size_bytes: info.size, reused: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetchImpl(`${base}/jobs/${jobId}/file`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ lease_token: credential })
    });
    if (!response.ok) return json(response);
    const declared = Number(response.headers.get('content-length'));
    if (response.headers.get('content-length') && (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes)) {
      await response.body?.cancel(); throw new Error('The server file exceeds the configured limit or is empty.');
    }
    if (response.headers.get('x-sha256') !== expected) {
      await response.body?.cancel(); throw new Error('The server checksum differs from the claimed command.');
    }
    const temporary = destination + '.' + crypto.randomUUID() + '.part';
    const hash = crypto.createHash('sha256'); let size = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(new Error('The server file exceeds the gateway file limit.'));
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (!size || hash.digest('hex') !== expected || (declared && size !== declared)) throw new Error('The downloaded file failed size/checksum verification.');
      const handle = await fs.promises.open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.promises.link(temporary, destination); // Never overwrite another command's spool.
      return { filename: path.basename(destination), sha256: expected, size_bytes: size, reused: false };
    } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function capture(job, { filename, program_name, type, current_program_verified, controller_reported_name } = {}) {
    const jobId = positive(job.id), credential = lease(job.lease_token);
    if (!['CURRENT', 'FETCHED', 'REPLACEMENT'].includes(type)) throw new Error('Choose a capture purpose.');
    if (typeof program_name !== 'string' || !program_name || program_name.length > 100 || /[\\/\x00-\x1f<>:"|?*]/.test(program_name)) throw new Error('Supply the actual controller program filename.');
    if (type === 'CURRENT' && (current_program_verified !== true || controller_reported_name !== program_name)) throw new Error('The embedded controller reader must identify and verify the current program.');
    const source = await spool(filename), stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw new Error('Capture must be a real, nonempty spool file within the size limit.');
    const sha256 = await digest(source);
    const boundary = 'mexa-' + crypto.randomUUID();
    const fields = { lease_token: credential, program_name, type, sha256,
      ...(type === 'CURRENT' ? { current_program_verified: 'true', controller_reported_name } : {}) };
    const prefix = Buffer.from(Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('') +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${program_name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    async function* bytes() { yield prefix; yield* fs.createReadStream(source); yield suffix; }
    const response = await fetchImpl(`${base}/jobs/${jobId}/capture`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000), duplex: 'half',
      headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(prefix.length + stat.size + suffix.length) },
      body: Readable.from(bytes())
    });
    return json(response);
  }
  return {
    config: reports => request('/config', { machines: reports || [] }),
    next: body => request('/commands/next', body || { available_slots: 1, active_job_ids: [], wait_seconds: 24 }),
    progress: (job, data) => request(`/jobs/${positive(job.id)}/progress`, { ...data, lease_token: lease(job.lease_token) }),
    result: (job, data) => request(`/jobs/${positive(job.id)}/result`, { ...data, lease_token: lease(job.lease_token) }),
    download, capture
  };
}
module.exports = { createClient };
