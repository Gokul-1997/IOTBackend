/**
 * The ProgramTransfer folder: where every program file is kept on the server.
 *
 *   <PROGRAM_TRANSFER_DIR>/
 *     company-5/
 *       192.168.200.3/
 *         20261005-103012_NEW_O1234.nc
 *         20261005-103020_BACKUP_O1234.nc
 *         20261005-111502_FETCHED_O2001.nc
 *
 * One folder per machine IP, as asked, under a folder per company: two
 * companies on this one server can both have a machine at 192.168.1.10, and
 * their programs must never land in the same folder. A machine with no IP
 * set gets machine-<id> instead.
 *
 * Every name is built here, from parts that are checked here, so nothing a
 * user or a device sends can reach a path outside the root.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const ROOT = path.resolve(
  process.env.PROGRAM_TRANSFER_DIR || path.join(__dirname, '..', '..', 'storage', 'ProgramTransfer')
);

/** NC programs are text; a mould-surface program can still run to many MB. */
const MAX_BYTES = Math.max(1, Number(process.env.PROGRAM_MAX_MB) || 20) * 1024 * 1024;

/* What controllers and CAM software name programs. No extension at all is
   allowed too: a Fanuc program is often just "O1234". */
const ALLOWED_EXTENSIONS = ['.nc', '.prg', '.cnc', '.txt', '.tap', '.eia', '.min', '.gcode', '.ptp', '.mpf', '.spf'];

function fail(message, code, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/**
 * A program's name as it may be written to disk and to a controller: the
 * last path segment only, no control characters (NUL ends a path, CR/LF
 * split a protocol line), none of the characters Windows refuses (the
 * on-premise server may be Windows), at most 100 characters.
 */
function safeProgramName(name) {
  const base = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/').pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');            // Windows drops trailing dots and spaces

  if (!base || base === '.' || base === '..' || /^\.+$/.test(base)) {
    throw fail(`"${name}" is not a usable program name.`, 'BAD_NAME');
  }
  if (base.length > 100) throw fail('A program name can be at most 100 characters.', 'BAD_NAME');

  const ext = path.extname(base).toLowerCase();
  if (ext && !ALLOWED_EXTENSIONS.includes(ext)) {
    throw fail(`"${ext}" files are not NC programs. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}, or no extension.`, 'BAD_TYPE');
  }
  return base;
}

/**
 * The machine's IP: the one set on the machine, else the one its controller
 * reports (the collector keeps machines.controller_ip up to date — on
 * production no machine has ip_address set). Null when neither is an IP.
 */
function machineIp(machine) {
  return [machine.ip_address, machine.controller_ip]
    .map(v => String(v || '').trim())
    .find(v => net.isIP(v)) || null;
}

/** The machine's folder, relative to the root: company-<id>/<ip>, or machine-<id> without one. */
function machineFolder(machine) {
  const ip = machineIp(machine);
  const leaf = ip ? ip.replace(/:/g, '-') : `machine-${Number(machine.id)}`;   // ':' is not allowed in a Windows path
  return `company-${Number(machine.company_id)}/${leaf}`;
}

/** 20261005-103012 — plant time (IST), so the folder reads like the shop's clock. */
function stamp(date = new Date()) {
  const d = new Date(date.getTime() + 330 * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** A path inside the root, or an error — the last guard against traversal. */
function resolveInside(folder, storedName) {
  const full = path.resolve(ROOT, folder, storedName || '');
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw fail('That file is outside the ProgramTransfer folder.', 'BAD_PATH', 400);
  }
  return full;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Checks a program's bytes before anything is written: not empty, not over
 * the limit, and text — a NUL byte means an executable or an archive, which
 * has no business going to a CNC.
 */
function checkContent(buffer) {
  if (!buffer || !buffer.length) throw fail('The file is empty.', 'EMPTY');
  if (buffer.length > MAX_BYTES) {
    throw fail(`The file is larger than ${Math.round(MAX_BYTES / 1048576)} MB.`, 'TOO_LARGE', 413);
  }
  if (buffer.indexOf(0) !== -1) throw fail('The file is not a text NC program.', 'NOT_TEXT');
}

/**
 * Keep a program in its machine's folder. Written to a temporary name first
 * and then linked to its final one, so a half-written file never carries a
 * real name, and an existing file is never replaced: a clash (two files in
 * the same second) takes the next free -2, -3 … instead.
 */
async function save({ machine, kind, programName, buffer, at = new Date() }) {
  checkContent(buffer);
  const name = safeProgramName(programName);
  const folder = machineFolder(machine);
  const dir = resolveInside(folder);
  await fsp.mkdir(dir, { recursive: true, mode: 0o750 });

  const tmp = path.join(dir, `.upload-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.writeFile(tmp, buffer, { flag: 'wx', mode: 0o640 });
  try {
    const base = `${stamp(at)}_${kind}_`;
    for (let n = 1; n < 100; n++) {
      const storedName = n === 1 ? base + name : `${base}${n}_${name}`;
      try {
        await fsp.link(tmp, resolveInside(folder, storedName));
        return { folder, storedName, programName: name, size: buffer.length, sha256: sha256(buffer) };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw fail('Could not find a free file name.', 'NAME_CLASH', 500);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

function open(folder, storedName) {
  return fs.createReadStream(resolveInside(folder, storedName));
}

async function read(folder, storedName) {
  return fsp.readFile(resolveInside(folder, storedName));
}

/** Delete a file; one that is already gone is not an error. */
async function remove(folder, storedName) {
  await fsp.unlink(resolveInside(folder, storedName)).catch(err => {
    if (err.code !== 'ENOENT') throw err;
  });
}

module.exports = {
  ROOT, MAX_BYTES, ALLOWED_EXTENSIONS,
  safeProgramName, machineIp, machineFolder, stamp, checkContent, sha256,
  save, open, read, remove, resolveInside
};
