#!/usr/bin/env node
/*
 * MEXA Program Transfer — a ready-made gateway.
 *
 * The MEXA server never connects to a machine; machines sit on the factory
 * network behind its firewall. A small program next to the machine — this
 * one — asks the server instead (docs/PROGRAM_TRANSFER_API.md):
 *
 *   every 15 s   GET /status
 *     a new program  → GET /program → check its SHA-256 → write it into
 *                      PROGRAM_DIR → POST /report DONE (or FAILED, and why)
 *     a backup asked → read the newest program in PROGRAM_DIR →
 *                      POST /backup (or POST /report FAILED, and why)
 *
 * PROGRAM_DIR is the folder the machine takes its programs from: the CNC's
 * network share or DNC folder — or, to try the whole flow on a laptop, any
 * folder. A controller reached another way (FTP, FOCAS…) replaces the two
 * functions marked MACHINE below; nothing else changes.
 *
 * Node.js 20 or newer, nothing to install:
 *
 *   MEXA_URL=https://stmapi.stmcnc.com MEXA_TOKEN=mxd_… PROGRAM_DIR=./machine node mexa-gateway.js
 *
 * One gateway per machine: the token says which machine it is.
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DEVICE_API = '/api/device/v1';
const NAME_MAX = 100;

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
 * The program's name as a file in PROGRAM_DIR: a plain name, never a path.
 * The server checks names on upload too; a gateway checks again because it
 * writes into the machine's folder.
 */
function safeName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > NAME_MAX || n === '.' || n === '..' || n.startsWith('.') ||
      /[\/\\:*?"<>|\u0000-\u001f]/.test(n)) {
    throw new Error(`"${n.slice(0, 40)}" is not a usable program name`);
  }
  return n;
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function createGateway({ url, token, programDir, backupFile = null, log = () => {}, fetch: send = globalThis.fetch }) {
  // the server's address, or the API address the Gateway token dialog shows — either works
  const root = String(url).replace(/\/+$/, '');
  const base = root.endsWith(DEVICE_API) ? root : root + DEVICE_API;
  const dir = path.resolve(programDir);

  async function call(method, route, { body, headers } = {}) {
    const res = await send(base + route, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
    if (res.ok) return res;
    let detail = {};
    try { detail = await res.json(); } catch { /* not JSON */ }
    throw new ServerError(detail.message || `${method} ${route} answered ${res.status}`, res.status, detail.code);
  }

  const report = body => call('POST', '/report', { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const reason = err => String(err?.message || err).slice(0, 500);

  /* ── MACHINE ── how this gateway reaches the machine: its program folder.
     For FTP, FOCAS or a controller's own tool, replace these two. ── */

  /** Put the program where the machine takes it from — whole, or not at all. */
  async function writeToMachine(name, data) {
    await fs.mkdir(dir, { recursive: true });
    const partial = path.join(dir, `.${name}.part`);
    await fs.writeFile(partial, data);
    await fs.rename(partial, path.join(dir, name));
  }

  /** The program to back up: BACKUP_FILE, or the newest program in the folder. */
  async function readFromMachine() {
    let file = backupFile ? path.resolve(backupFile) : null;
    if (!file) {
      let newest = null;
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const { mtimeMs } = await fs.stat(full);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { full, mtimeMs };
      }
      if (!newest) throw new Error(`No program in ${dir} to back up`);
      file = newest.full;
    }
    return { name: path.basename(file), data: await fs.readFile(file) };
  }

  /* ── the loop's two jobs ── */

  /** A new program: download it, check it, write it, say so. A local failure is reported; a server one is tried again. */
  async function deliver(program) {
    const res = await call('GET', '/program');
    const fileId = Number(res.headers.get('x-file-id')) || program.file_id;
    const data = Buffer.from(await res.arrayBuffer());
    let name = program.program_name;
    try {
      name = safeName(decodeURIComponent(res.headers.get('x-program-name') || '') || program.program_name);
      const expected = String(res.headers.get('x-sha256') || program.sha256 || '').toLowerCase();
      if (sha256(data) !== expected) throw new Error('The file arrived damaged (its SHA-256 does not match); upload it again');
      await writeToMachine(name, data);
    } catch (err) {
      await report({ file_id: fileId, status: 'FAILED', message: reason(err) });
      log(`${name}: NOT written — ${reason(err)}`);
      return 'FAILED';
    }
    await report({ file_id: fileId, status: 'DONE' });
    log(`${name}: written to the machine (${data.length} bytes)`);
    return 'DONE';
  }

  /** Someone pressed Backup: send the machine's program, or say why it cannot be read. */
  async function backup(request) {
    let file;
    try {
      file = await readFromMachine();
    } catch (err) {
      await report({ backup_request_id: request.id, status: 'FAILED', message: reason(err) });
      log(`Backup NOT sent — ${reason(err)}`);
      return 'FAILED';
    }
    const form = new FormData();
    form.append('program_name', file.name);
    form.append('file', new Blob([file.data]), file.name);
    try {
      await call('POST', '/backup', { body: form });
    } catch (err) {
      // refused for what it is (not a text program, too large…): tell the person; anything else, try again
      if (!(err instanceof ServerError) || err.status === 401 || err.status === 429 || err.status >= 500) throw err;
      await report({ backup_request_id: request.id, status: 'FAILED', message: reason(err) });
      log(`Backup of ${file.name} refused — ${reason(err)}`);
      return 'FAILED';
    }
    log(`Backup sent: ${file.name} (${file.data.length} bytes)`);
    return 'SENT';
  }

  /** One round: ask, then deliver and back up as asked. */
  async function tick() {
    const status = await (await call('GET', '/status')).json();
    if (status.program && status.program.status === 'WAITING') await deliver(status.program);
    if (status.backup_request) await backup(status.backup_request);
    return status;
  }

  /** Round after round until stopped; slower while the server keeps failing. A wrong token stops it. */
  async function run({ signal } = {}) {
    let failures = 0;
    let announced = false;
    while (!signal?.aborted) {
      let wait;
      try {
        const status = await tick();
        if (!announced) { log(`Connected: machine ${status.machine?.serial ?? status.machine?.id}; programs go to ${dir}`); announced = true; }
        failures = 0;
        wait = Math.min(300, Math.max(5, Number(status.poll_seconds) || 15));
      } catch (err) {
        if (err.fatal) {
          log(`Stopped: ${err.message}. Make a new token in MEXA → Program Transfer → Gateway token.`);
          throw err;
        }
        failures += 1;
        wait = Math.min(300, 15 * 2 ** Math.min(failures - 1, 5));
        const why = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;   // "fetch failed (ECONNREFUSED)"
        log(`Trying again in ${wait} s — ${why}`);
      }
      await sleep(wait * 1000, signal);
    }
  }

  return { tick, run, deliver, backup };
}

module.exports = { createGateway, safeName, ServerError };

/* ── run from the command line ── */
if (require.main === module) {
  const { MEXA_URL, MEXA_TOKEN, PROGRAM_DIR = 'machine-programs', BACKUP_FILE } = process.env;
  const log = message => console.log(`${new Date().toISOString()}  ${message}`);
  if (!MEXA_URL || !MEXA_TOKEN) {
    console.error('Set MEXA_URL (the MEXA server, e.g. https://stmapi.stmcnc.com) and MEXA_TOKEN (the machine\'s mxd_ token).');
    process.exit(2);
  }
  if (!/^https:\/\//i.test(MEXA_URL) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(MEXA_URL)) {
    console.error('Use https:// for the MEXA server — the token must not travel in clear text.');
    process.exit(2);
  }
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('Stopping.'); controller.abort(); });
  createGateway({ url: MEXA_URL, token: MEXA_TOKEN, programDir: PROGRAM_DIR, backupFile: BACKUP_FILE || null, log })
    .run({ signal: controller.signal })
    .then(() => process.exit(0), () => process.exit(1));
}
