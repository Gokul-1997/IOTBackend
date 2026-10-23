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
 * Node.js 20 or newer, nothing to install:
 *
 *   MEXA_URL=https://stmapi.stmcnc.com MEXA_TOKEN=mxg_… PROGRAM_DIR=./machines node mexa-gateway.js
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

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
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * programDir   every machine's folder is programDir/<machine name>
 * machineDirs  { "VMC-01": "\\\\cnc01\\programs", … } — when given, only these
 *              machines are served here (another gateway may serve the rest)
 */
function createGateway({ url, token, programDir = 'machines', machineDirs = null, log = () => {}, fetch: send = globalThis.fetch }) {
  // the server's address, or the API address S&T gave with the token — either works
  const root = String(url).replace(/\/+$/, '');
  const base = root.endsWith(DEVICE_API) ? root : root + DEVICE_API;
  const dirs = machineDirs ? new Map(Object.entries(machineDirs).map(([name, dir]) => [name.trim().toLowerCase(), path.resolve(dir)])) : null;
  const serves = name => !dirs || dirs.has(String(name).trim().toLowerCase());
  const folderOf = name => dirs?.get(String(name).trim().toLowerCase()) || path.resolve(programDir, folderName(name));

  async function call(method, route, { body, headers } = {}) {
    const res = await send(base + route, { method, body, headers: { Authorization: `Bearer ${token}`, 'X-Agent-Version': AGENT, ...headers } });
    if (res.ok) return res;
    let detail = {};
    try { detail = await res.json(); } catch { /* not JSON */ }
    throw new ServerError(detail.message || `${method} ${route} answered ${res.status}`, res.status, detail.code);
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

  /** Put the program where the machine takes it from — whole, or not at all. */
  async function writeToMachine(machine, name, data) {
    const dir = folderOf(machine.machine);
    await fs.mkdir(dir, { recursive: true });
    const partial = path.join(dir, `.${name}.part`);
    await fs.writeFile(partial, data);
    await fs.rename(partial, path.join(dir, name));
  }

  /** The program to back up: the newest program in the machine's folder. */
  async function readFromMachine(machine) {
    const dir = folderOf(machine.machine);
    let newest = null;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const { mtimeMs } = await fs.stat(full);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { full, mtimeMs };
    }
    if (!newest) throw new Error(`No program in ${dir} to back up`);
    return { name: path.basename(newest.full), data: await fs.readFile(newest.full) };
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
        // deleted on the page, or the machine renamed, between /status and now: nothing to do here
        if (err instanceof ServerError && ['NO_PROGRAM', 'MACHINE_NOT_FOUND', 'MACHINE_INACTIVE'].includes(err.code)) return written;
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
  async function tick() {
    const status = await (await call('GET', '/status')).json();
    for (const machine of status.machines || []) {
      if (!serves(machine.machine)) continue;
      if (machine.program) await deliverAll(machine);
      if (machine.backup_request) await backup(machine);
    }
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
        if (!announced) {
          const machines = (status.machines || []).filter(m => serves(m.machine));
          log(`Connected to ${status.company}: ${machines.length} machine(s) served here; `
            + (dirs ? 'programs go to the folders in MACHINE_DIRS' : `programs go to ${path.resolve(programDir)}${path.sep}<machine name>`));
          announced = true;
        }
        failures = 0;
        wait = Math.min(300, Math.max(5, Number(status.poll_seconds) || 15));
      } catch (err) {
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
  }

  return { tick, run, deliver, deliverAll, backup, folderOf };
}

module.exports = { createGateway, safeName, folderName, ServerError };

/* ── run from the command line ── */
if (require.main === module) {
  const { MEXA_URL, MEXA_TOKEN, PROGRAM_DIR = 'machines', MACHINE_DIRS } = process.env;
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
  createGateway({ url: MEXA_URL, token: MEXA_TOKEN, programDir: PROGRAM_DIR, machineDirs, log })
    .run({ signal: controller.signal })
    .then(() => process.exit(0), () => process.exit(1));
}
