#!/usr/bin/env node
/*
 * MEXA Program Transfer — a ready-made gateway, for all of a company's machines.
 *
 * The MEXA server never connects to a machine; machines sit on the factory
 * network behind its firewall. One small program on the factory network —
 * this one — asks the server instead, with the company's one token
 * (docs/PROGRAM_TRANSFER_API.md):
 *
 *   every 15 s   GET /status  — every machine in one answer
 *     a machine with a program waiting → GET /program?machine_id=ID → check
 *                its SHA-256 → write it into the machine's folder → POST
 *                /report DONE (or FAILED, and why); the answer names the
 *                machine's next program, which goes the same way at once
 *     a machine asked for a backup → read the newest program in its folder
 *                → POST /backup (or POST /report FAILED, and why)
 *     a machine on hold (in alarm, emergency stop or offline) is offered
 *                neither until it is running or idle again
 *
 * A machine's folder is PROGRAM_DIR/<machine name> — or, with MACHINE_DIRS,
 * the folder given for it (the CNC's network share, its DNC folder). To try
 * the whole flow on a laptop, any PROGRAM_DIR will do. A controller reached
 * another way (FTP, FOCAS…) replaces the two functions marked MACHINE below;
 * they are given the machine as /status lists it — its machine_id, name, IP,
 * controller and its type (Fanuc or Mitsubishi), and program path (the CNC's
 * folder, from the Machines page).
 * Nothing else changes.
 *
 * Node.js 20.10 or newer, nothing to install:
 *
 *   MEXA_URL=https://stmapi.stmcnc.com MEXA_TOKEN=mxg_… PROGRAM_DIR=./machines node mexa-gateway.js
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { constants } = require('fs');

const DEVICE_API = '/api/device/v1';
const AGENT = 'mexa-gateway 3';
const NAME_MAX = 100;
/** Programs written to one machine in one round, one after the other; the rest wait for the next round. */
const PER_ROUND = 10;

/** An answer from the server that is not a success. `fatal`: the token is wrong — stop, a person must fix it. */
class ServerError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.fatal = status === 401;
  }
}

/**
 * The program's name as a file in a machine's folder: a plain name, never a
 * path. The server checks names on upload too; a gateway checks again
 * because it writes into the machine's folder.
 */
function safeName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > NAME_MAX || n === '.' || n === '..' || n.startsWith('.') ||
      /[\/\\:*?"<>|\u0000-\u001f]/.test(n)) {
    throw new Error(`"${n.slice(0, 40)}" is not a usable program name`);
  }
  return n;
}

/** A machine's name as a folder name: what a folder cannot hold becomes "_". */
const folderName = name => String(name ?? '').trim().replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || 'machine';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms, signal) => new Promise(resolve => {
  let timer;
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  if (signal?.aborted) return done();
  timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * programDir   every machine's folder is programDir/<machine name>
 * machineDirs  { "VMC-01": "\\\\cnc01\\programs", … } — when given, only these
 *              machines are served here (another gateway may serve the rest)
 */
function createGateway({ url, token, programDir = 'machines', machineDirs = null, log = () => {}, fetch: send = globalThis.fetch, requestTimeoutMs = 30000, maxProgramBytes = 20 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300000) throw new Error('Request timeout must be 1–300000 milliseconds');
  if (!Number.isSafeInteger(maxProgramBytes) || maxProgramBytes < 1 || maxProgramBytes > 100 * 1024 * 1024) throw new Error('Program size limit must be 1–104857600 bytes');
  // the server's address, or the API address S&T gave with the token — either works
  const root = String(url).replace(/\/+$/, '');
  const base = root.endsWith(DEVICE_API) ? root : root + DEVICE_API;
  const dirs = machineDirs ? new Map(Object.entries(machineDirs).map(([name, dir]) => [name.trim().toLowerCase(), path.resolve(dir)])) : null;
  const serves = name => !dirs || dirs.has(String(name).trim().toLowerCase());
  const folderOf = name => dirs?.get(String(name).trim().toLowerCase()) || path.resolve(programDir, folderName(name));

  let runSignal;
  let running = false;
  let ticking;
  const checkStopped = () => { if (runSignal?.aborted) throw Object.assign(new Error('Gateway stopped'), { name: 'AbortError' }); };

  async function call(method, route, { body, headers } = {}) {
    checkStopped();
    const controller = new AbortController();
    const abort = () => controller.abort();
    runSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, requestTimeoutMs);
    try {
      const res = await send(base + route, { method, body, signal: controller.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'X-Agent-Version': AGENT, ...headers } });
      // Read under the same deadline as the headers, and stop before buffering
      // an unbounded response, including one sent without Content-Length.
      const limit = route.startsWith('/program?') && res.ok ? maxProgramBytes : 4 * 1024 * 1024;
      if (Number(res.headers.get('content-length')) > limit) {
        controller.abort();
        throw new Error('Gateway response exceeds its size limit');
      }
      const chunks = [];
      let bytes = 0;
      if (res.body) {
        const reader = res.body.getReader();
        const cancel = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
        try {
          while (true) {
            const { value, done } = await reader.read();
            controller.signal.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) {
              void reader.cancel().catch(() => {});
              throw new Error('Gateway response exceeds its size limit');
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          reader.releaseLock();
        }
      }
      const answer = new Response([204, 205, 304].includes(res.status) ? null : Buffer.concat(chunks),
        { status: res.status, statusText: res.statusText, headers: res.headers });
      if (answer.ok) return answer;
      let detail = {};
      try { detail = await answer.json(); } catch { /* not JSON */ }
      throw new ServerError(detail.message || `${method} ${route} answered ${res.status}`, res.status, detail.code);
    } finally {
      clearTimeout(timer);
      runSignal?.removeEventListener('abort', abort);
    }
  }

  const report = async body => (await call('POST', '/report', { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).json();
  const reason = err => String(err?.message || err).slice(0, 500);
  /** How a call names a machine: its machine_id (since 23 Oct 2026); its name for a server older than that. */
  const named = machine => (machine.machine_id ? { machine_id: machine.machine_id } : { machine: machine.machine });

  /* ── MACHINE ── how this gateway reaches a machine: its program folder.
     For FTP, FOCAS or a controller's own tool, replace these two; `machine`
     is the machine from GET /status: { machine_id, machine (its name),
     machine_ip, controller_name, controller_type (FANUC or MITSUBISHI: which
     protocol to use), program_path, … }. program_path is the
     CNC's own folder as typed on the Machines page (//CNC_MEM/USER/PATH1/ on
     a Fanuc), for such a version; this folder version never takes it for a
     folder on this PC — only PROGRAM_DIR and MACHINE_DIRS, set here. ── */

  async function readLocal(filename, { metadata = false } = {}) {
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxProgramBytes) throw new Error('Program is not a regular file within the configured size limit');
      const chunks = [];
      let size = 0;
      while (true) {
        checkStopped();
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maxProgramBytes) throw new Error('Program exceeds the configured size limit');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const data = Buffer.concat(chunks);
      return metadata ? { data, mode: stat.mode & 0o777 } : data;
    } finally { await file.close(); }
  }

  /** Keep a recoverable previous version before replacing an existing program. */
  async function writeToMachine(machine, name, data) {
    checkStopped();
    const dir = folderOf(machine.machine);
    await fs.mkdir(dir, { recursive: true });
    const destination = path.join(dir, name);
    let previous;
    try { previous = await readLocal(destination, { metadata: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && sha256(previous.data) === sha256(data)) return; // a lost report reply must not create another overwrite
    if (previous) {
      const versions = path.join(dir, '.mexa-backups');
      await fs.mkdir(versions, { recursive: true, mode: 0o700 });
      const version = `${name}.${Date.now()}-${crypto.randomUUID()}`;
      await fs.writeFile(path.join(versions, version), previous.data, { flag: 'wx', mode: 0o600, flush: true });
      await fs.writeFile(path.join(versions, `${version}.json`), JSON.stringify({
        program_name: name, machine_id: machine.machine_id ?? null, machine: machine.machine,
        saved_at: new Date().toISOString(), size_bytes: previous.data.length, sha256: sha256(previous.data)
      }), { flag: 'wx', mode: 0o600, flush: true });
    }
    const partial = path.join(dir, `.${name}.${crypto.randomUUID()}.part`);
    try {
      // New files keep the previous gateway's umask-based access; replacements
      // preserve the CNC/DNC account's existing read permissions.
      await fs.writeFile(partial, data, { flag: 'wx', signal: runSignal, mode: 0o666, flush: true });
      if (previous) await fs.chmod(partial, previous.mode);
      checkStopped();
      await fs.rename(partial, destination);
      if (sha256(await readLocal(destination)) !== sha256(data)) throw new Error('Machine program read-back did not match the downloaded file');
    } finally { await fs.unlink(partial).catch(() => {}); }
  }

  /** The newest regular program in the machine's folder, bounded before reading. */
  async function readFromMachine(machine) {
    const dir = folderOf(machine.machine);
    let newest = null;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      checkStopped();
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const { mtimeMs } = await fs.lstat(full);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { full, mtimeMs };
    }
    if (!newest) throw new Error(`No program in ${dir} to back up`);
    return { name: safeName(path.basename(newest.full)), data: await readLocal(newest.full) };
  }

  /* ── the round's two jobs ── */

  /**
   * The program in front of a machine's line: download it, check it, write
   * it, say so. A local failure is reported (the line moves on); a server one
   * is tried again next round. Answers the report — its next_program says
   * whether another one waits.
   */
  async function deliver(machine) {
    const who = named(machine);
    const res = await call('GET', `/program?${new URLSearchParams(who)}`);
    const fileId = Number(res.headers.get('x-file-id'));
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error('Server returned an invalid program file ID');
    const data = Buffer.from(await res.arrayBuffer());
    let name = machine.program?.program_name || `file ${fileId}`;
    try {
      name = safeName(decodeURIComponent(res.headers.get('x-program-name') || '') || name);
      if (sha256(data) !== String(res.headers.get('x-sha256') || '').toLowerCase()) {
        throw new Error('The file arrived damaged (its SHA-256 does not match); upload it again');
      }
      await writeToMachine(machine, name, data);
    } catch (err) {
      const answer = await report({ file_id: fileId, ...who, status: 'FAILED', message: reason(err) });
      log(`${machine.machine}: ${name} NOT written — ${reason(err)}`);
      return answer;
    }
    const answer = await report({ file_id: fileId, ...who, status: 'DONE' });
    log(`${machine.machine}: ${name} written (${data.length} bytes)`);
    return answer;
  }

  /** Every program waiting for a machine, one after the other — the next once the last is done. */
  async function deliverAll(machine) {
    let written = 0;
    for (let more = true; more && written < PER_ROUND; written++) {
      try {
        more = !!(await deliver(machine)).next_program;
      } catch (err) {
        // deleted on the page, the machine renamed, or it went into alarm, emergency stop or offline
        // (on hold: its programs wait) between /status and now: nothing to do here
        if (err instanceof ServerError && ['NO_PROGRAM', 'MACHINE_NOT_FOUND', 'MACHINE_INACTIVE', 'MACHINE_ON_HOLD'].includes(err.code)) return written;
        throw err;
      }
    }
    return written;
  }

  /** Someone pressed Backup now for this machine: send its program, or say why it cannot be read. */
  async function backup(machine) {
    const requestId = machine.backup_request.id;
    const who = named(machine);
    let file;
    try {
      file = await readFromMachine(machine);
    } catch (err) {
      await report({ backup_request_id: requestId, ...who, status: 'FAILED', message: reason(err) });
      log(`${machine.machine}: backup NOT sent — ${reason(err)}`);
      return 'FAILED';
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(who)) form.append(key, String(value));
    form.append('program_name', file.name);
    form.append('file', new Blob([file.data]), file.name);
    try {
      await call('POST', '/backup', { body: form });
    } catch (err) {
      // refused for what it is (not a text program, too large…): tell the person; anything else, try again
      if (!(err instanceof ServerError) || err.status === 401 || err.status === 429 || err.status >= 500) throw err;
      await report({ backup_request_id: requestId, ...who, status: 'FAILED', message: reason(err) });
      log(`${machine.machine}: backup of ${file.name} refused — ${reason(err)}`);
      return 'FAILED';
    }
    log(`${machine.machine}: backup sent — ${file.name} (${file.data.length} bytes)`);
    return 'SENT';
  }

  /** One round: one /status for every machine, then deliver and back up as asked. */
  async function round() {
    const status = await (await call('GET', '/status')).json();
    // Sanitizing names can map distinct machines to the same folder. Refuse
    // before writing any file; MACHINE_DIRS can assign distinct locations.
    const destinations = new Set();
    for (const machine of status.machines || []) {
      if (!serves(machine.machine)) continue;
      const dir = folderOf(machine.machine);
      const key = process.platform === 'win32' || process.platform === 'darwin' ? dir.toLowerCase() : dir;
      if (destinations.has(key)) throw new Error('Two machines resolve to the same program folder; configure distinct MACHINE_DIRS');
      destinations.add(key);
    }
    for (const machine of status.machines || []) {
      checkStopped();
      if (!serves(machine.machine)) continue;
      if (machine.program) await deliverAll(machine);
      if (machine.backup_request) await backup(machine);
    }
    return status;
  }

  function tick() {
    if (!ticking) {
      const work = round().finally(() => { if (ticking === work) ticking = null; });
      ticking = work;
    }
    return ticking;
  }

  /** Round after round until stopped; slower while the server keeps failing. A wrong token stops it. */
  async function run({ signal } = {}) {
    if (running) throw new Error('Gateway is already running');
    running = true;
    runSignal = signal;
    let failures = 0;
    let announced = false;
    try {
    while (!signal?.aborted) {
      let wait;
      try {
        const status = await tick();
        if (!announced) {
          const machines = (status.machines || []).filter(m => serves(m.machine));
          log(`Connected to ${status.company}: ${machines.length} machine(s) served here; `
            + (dirs ? 'programs go to the folders in MACHINE_DIRS' : `programs go to ${path.resolve(programDir)}${path.sep}<machine name>`));
          announced = true;
        }
        failures = 0;
        wait = Math.min(300, Math.max(5, Number(status.poll_seconds) || 15));
      } catch (err) {
        if (signal?.aborted) break;
        if (err.fatal) {
          log(`Stopped: ${err.message}`);
          throw err;
        }
        failures += 1;
        wait = Math.min(300, 15 * 2 ** Math.min(failures - 1, 5));
        const why = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;   // "fetch failed (ECONNREFUSED)"
        log(`Trying again in ${wait} s — ${why}`);
      }
      await sleep(wait * 1000, signal);
    }
    } finally { runSignal = undefined; running = false; }
  }

  return { tick, run, deliver, deliverAll, backup, folderOf };
}

module.exports = { createGateway, safeName, folderName, ServerError, sleep };

/* ── run from the command line ── */
if (require.main === module) {
  const { MEXA_URL, MEXA_TOKEN, PROGRAM_DIR = 'machines', MACHINE_DIRS,
    GATEWAY_REQUEST_TIMEOUT_MS = '30000', GATEWAY_MAX_PROGRAM_BYTES = '20971520' } = process.env;
  const log = message => console.log(`${new Date().toISOString()}  ${message}`);
  if (!MEXA_URL || !MEXA_TOKEN) {
    console.error('Set MEXA_URL (the MEXA server, e.g. https://stmapi.stmcnc.com) and MEXA_TOKEN (the company\'s mxg_ token from S&T).');
    process.exit(2);
  }
  if (!/^https:\/\//i.test(MEXA_URL) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(MEXA_URL)) {
    console.error('Use https:// for the MEXA server — the token must not travel in clear text.');
    process.exit(2);
  }
  let machineDirs = null;
  if (MACHINE_DIRS) {
    try {
      machineDirs = JSON.parse(MACHINE_DIRS);
      if (!machineDirs || typeof machineDirs !== 'object' || Array.isArray(machineDirs)) throw new Error('not an object');
    } catch (err) {
      console.error(`MACHINE_DIRS must be JSON like {"VMC-01": "D:\\\\DNC\\\\VMC-01"} (${err.message}).`);
      process.exit(2);
    }
  }
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('Stopping.'); controller.abort(); });
  createGateway({ url: MEXA_URL, token: MEXA_TOKEN, programDir: PROGRAM_DIR, machineDirs, log,
    requestTimeoutMs: Number(GATEWAY_REQUEST_TIMEOUT_MS), maxProgramBytes: Number(GATEWAY_MAX_PROGRAM_BYTES) })
    .run({ signal: controller.signal })
    .then(() => process.exit(0), () => process.exit(1));
}
