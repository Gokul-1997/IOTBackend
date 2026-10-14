/** Immutable programs in the unified company storage tree:
 * <STORAGE_ROOT>/company-5/programs/machine-7/{uploads|backups|fetched}/...
 * IP changes never change a machine's new storage location. Existing database
 * folders company-N/<IP or machine-ID> remain in the legacy ProgramTransfer
 * root and are read there; this module never moves files or rewrites history.
 */
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { Readable } = require('stream');
const local = require('../files/local-storage');

const ROOT = local.ROOT;
const LEGACY_ROOT = path.resolve(
  process.env.PROGRAM_TRANSFER_DIR || path.join(__dirname, '..', '..', 'storage', 'ProgramTransfer')
);
const legacy = local.createStore(LEGACY_ROOT);
const PURPOSES = Object.freeze({ NEW: 'uploads', BACKUP: 'backups', FETCHED: 'fetched' });

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

function positiveId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) {
    throw fail('A valid company and machine ID are required.', 'BAD_ID');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('A valid company and machine ID are required.', 'BAD_ID');
  return id;
}

/** Stable base folder; save adds the purpose below this directory. */
function machineFolder(machine) {
  return `company-${positiveId(machine?.company_id)}/programs/machine-${positiveId(machine?.id)}`;
}

/** 20261005-103012 — plant time (IST), so the folder reads like the shop's clock. */
function stamp(date = new Date()) {
  const d = new Date(date.getTime() + 330 * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** The stored folder determines its format; new paths never fall back to old roots. */
function storeFor(folder) {
  if (typeof folder === 'string' && /^company-[1-9]\d*\/programs\/machine-[1-9]\d*(?:\/(?:uploads|backups|fetched))?$/.test(folder)) return local;
  const match = typeof folder === 'string' && /^company-[1-9]\d*\/([^/\\]+)$/.exec(folder);
  if (match && (/^machine-[1-9]\d*$/.test(match[1]) || net.isIP(match[1]) || net.isIP(match[1].replace(/-/g, ':')))) {
    return legacy;
  }
  throw fail('That file is outside the allowed program storage folder.', 'BAD_PATH');
}

/** Lexical path guard; file operations also reject directory/file symlinks. */
function resolveInside(folder, storedName) {
  return storeFor(folder).resolveInside(folder, storedName);
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
 * Keep a program under its machine and purpose, using the shared immutable
 * fsynced writer. A same-second clash takes the next available name.
 */
async function save({ machine, kind, programName, buffer, at = new Date() }) {
  if (typeof kind !== 'string' || !Object.hasOwn(PURPOSES, kind)) throw fail('Unknown program file kind.', 'BAD_KIND');
  checkContent(buffer);
  const name = safeProgramName(programName);
  const folder = `${machineFolder(machine)}/${PURPOSES[kind]}`;
  const base = `${stamp(at)}_${kind}_`;
  for (let n = 1; n < 100; n++) {
    const storedName = n === 1 ? base + name : `${base}${n}_${name}`;
    try {
      await local.write(folder, storedName, buffer);
      return { folder, storedName, programName: name, size: buffer.length, sha256: sha256(buffer) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw fail('Could not find a free file name.', 'NAME_CLASH', 500);
}

function open(folder, storedName) {
  const store = storeFor(folder);
  store.resolveInside(folder, storedName);
  try {
    const stream = store.openSync(folder, storedName);
    // Existing download handlers await the read stream's `open` event.
    // Its descriptor has already been opened safely, so preserve that event.
    queueMicrotask(() => { if (!stream.destroyed) stream.emit('open', stream.fd); });
    return stream;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Preserve missing-file errors on the stream for existing HTTP mapping.
    const stream = new Readable({ read() {} });
    queueMicrotask(() => stream.destroy(err));
    return stream;
  }
}

async function read(folder, storedName) {
  return storeFor(folder).read(folder, storedName);
}

/** Delete a file; one that is already gone is not an error. */
async function remove(folder, storedName) {
  return storeFor(folder).remove(folder, storedName);
}

module.exports = {
  ROOT, LEGACY_ROOT, MAX_BYTES, ALLOWED_EXTENSIONS,
  safeProgramName, machineIp, machineFolder, stamp, checkContent, sha256,
  save, open, read, remove, resolveInside
};
