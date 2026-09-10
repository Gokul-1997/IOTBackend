/**
 * FTP transfer to CNC controllers (Fanuc / Mitsubishi).
 *
 * Both controller families run a built-in FTP server on the machine
 * LAN port. Sending a program = FTP upload of the NC file into the
 * controller's program directory; the operator then selects it on
 * the control panel and presses CYCLE START.
 *
 * These are embedded FTP servers, not general-purpose ones. They
 * implement a subset of the protocol, allow very few concurrent
 * sessions, and vary between models — so the code below never assumes
 * a command exists just because the RFC says it should. Every place
 * that could differ between controllers is handled explicitly and,
 * where it cannot be resolved, reported as its own error code rather
 * than guessed at. Writing the wrong file to a machine that is cutting
 * metal is not an error worth being casual about.
 */
const ftp = require('basic-ftp');
const { Readable, Writable } = require('stream');

const TRANSFER_TIMEOUT_MS = 60_000;   // shop LANs are slow and often wireless
const CONNECT_TIMEOUT_MS  = 10_000;

/* ─────────────────────────────────────────────────────────────
   FTP reply-code classification

   basic-ftp raises FTPError with the numeric reply code attached.
   Two families matter here and mean very different things:

     550  the file is not there (a normal, expected answer)
     500/502/504  the controller does not implement that command

   Treating "not implemented" as "file absent" would silently skip the
   overwrite guard on exactly the controllers whose FTP server is most
   limited, which is the opposite of what a safety check should do.
   ───────────────────────────────────────────────────────────── */

function replyCode(err) {
  return typeof err?.code === 'number' ? err.code : null;
}

const isMissing     = err => replyCode(err) === 550;
const isUnsupported = err => [500, 502, 504].includes(replyCode(err));

/** An outcome the caller has to decide about, not a transport failure. */
function transferError(message, code, status = 502) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/* ─────────────────────────────────────────────────────────────
   File names

   A program's file name reaches us from an uploaded file's own
   metadata or from a request body, so it is caller-controlled all the
   way to an FTP path. `../` in that string would place the write
   outside the controller's program directory — on a CNC that is
   somewhere between "the operator cannot find the program" and
   "a system file was overwritten".
   ───────────────────────────────────────────────────────────── */

function safeFileName(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')      // Windows-style separators from CAM software
    .split('/').pop()          // keep the last segment only
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')   // NUL truncates the path server-side; CR/LF splits the FTP command
    .trim();

  if (!base || base === '.' || base === '..') {
    throw transferError(`"${name}" is not a usable file name.`, 'BAD_FILE_NAME', 400);
  }
  return base;
}

/* ─────────────────────────────────────────────────────────────
   Connection
   ───────────────────────────────────────────────────────────── */

/**
 * Open a logged-in FTP client for a machine, optionally moved into its
 * program directory. Every operation below goes through here so the
 * connection settings stay in one place.
 */
async function connect(machine, { timeout = TRANSFER_TIMEOUT_MS, enterDir = false } = {}) {
  if (!machine.ip_address) {
    throw transferError(
      'This machine has no IP address configured. Edit the machine and set its FTP details.',
      'NOT_CONFIGURED', 400
    );
  }

  const client = new ftp.Client(timeout);
  try {
    await client.access({
      host:     machine.ip_address,
      port:     machine.ftp_port || 21,
      user:     machine.ftp_user || 'anonymous',
      password: machine.ftp_pass || '',
      secure:   false   // CNC controllers do not support FTPS
    });

    if (enterDir && machine.ftp_dir) {
      // cd, never ensureDir: ensureDir CREATES missing segments, so a typo
      // in ftp_dir would silently make a new directory on the controller
      // and drop the program somewhere the operator will never look for it.
      try {
        await client.cd(machine.ftp_dir);
      } catch (err) {
        throw transferError(
          `The program directory "${machine.ftp_dir}" does not exist on this controller.`,
          'BAD_DIRECTORY', 400
        );
      }
    }
    return client;
  } catch (err) {
    client.close();
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────
   Transfers
   ───────────────────────────────────────────────────────────── */

/**
 * Upload a program buffer to a machine over FTP.
 *
 * @param {object}   machine  - { ip_address, ftp_port, ftp_user, ftp_pass, ftp_dir }
 * @param {Buffer}   content  - raw G-code file bytes
 * @param {string}   fileName - target file name on the CNC (e.g. O1234.nc)
 * @param {function} [onProgress] - called with ({ bytes, total }) as it streams
 */
async function sendProgramToMachine(machine, content, fileName, onProgress) {
  const target = safeFileName(fileName);

  // An empty program is always a mistake upstream — a failed save, a
  // truncated import — and the controller would accept it happily,
  // leaving an operator to select a file that cuts nothing.
  if (!content || content.length === 0) {
    throw transferError(
      `"${target}" is empty. Nothing was sent to the controller.`,
      'EMPTY_PROGRAM', 400
    );
  }

  const client = await connect(machine, { enterDir: true });
  try {
    if (typeof onProgress === 'function') {
      client.trackProgress(info => onProgress({ bytes: info.bytes, total: content.length }));
    }
    await client.uploadFrom(Readable.from(content), target);
  } finally {
    client.trackProgress();   // detach handler before the socket closes
    client.close();
  }
}

/**
 * Pull a program off the controller into memory.
 * Programs are small text files, so buffering is fine and lets the
 * caller store the bytes without a temp file.
 *
 * @returns {Promise<Buffer>}
 */
async function fetchProgramFromMachine(machine, fileName, onProgress) {
  const target = safeFileName(fileName);
  const client = await connect(machine, { enterDir: true });
  const chunks = [];

  try {
    // Ask the controller how big the file is so progress can report a
    // percentage rather than a running byte count. Not every embedded
    // server implements SIZE; when it does not, progress degrades to
    // bytes-so-far, which is a cosmetic loss and not worth failing over.
    let total = 0;
    try {
      total = await client.size(target);
    } catch {
      total = 0;
    }

    if (typeof onProgress === 'function') {
      client.trackProgress(info => onProgress({ bytes: info.bytes, total }));
    }

    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); }
    });

    await client.downloadTo(sink, target);
    return Buffer.concat(chunks);
  } finally {
    client.trackProgress();
    client.close();
  }
}

/**
 * List NC programs sitting on the controller.
 * Returns name, size and modified date — the columns the file browser shows.
 */
async function listMachineFiles(machine) {
  const client = await connect(machine, { enterDir: true });
  try {
    const entries = await client.list();
    return entries
      .filter(e => e.isFile)
      .map(e => ({
        name:        e.name,
        size:        e.size,
        modified_at: e.modifiedAt || e.rawModifiedAt || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (isUnsupported(err)) {
      throw transferError(
        'This controller does not support listing its program directory over FTP. ' +
        'Programs can still be sent and fetched by name.',
        'LIST_UNSUPPORTED', 501
      );
    }
    throw err;
  } finally {
    client.close();
  }
}

/**
 * Does this file already exist on the controller?
 * Used to raise an overwrite confirmation before clobbering a program
 * an operator may be mid-way through running.
 *
 * Deliberately does NOT go through listMachineFiles. Fanuc's embedded
 * FTP server refuses passive-mode LIST on several models while handling
 * SIZE and STOR perfectly well — so a directory listing is the least
 * reliable way to answer a question SIZE answers directly, and building
 * the overwrite guard on LIST would block transfers on exactly those
 * machines.
 *
 * @returns {Promise<boolean>}
 * @throws  {Error} code EXISTENCE_UNKNOWN when the controller supports
 *          neither probe — the caller must ask the user rather than
 *          assume the file is absent.
 */
async function machineFileExists(machine, fileName) {
  const target = safeFileName(fileName);
  const client = await connect(machine, { enterDir: true });

  try {
    try {
      await client.size(target);
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      if (!isUnsupported(err)) throw err;
      // SIZE not implemented — fall through and try a listing instead.
    }

    try {
      const entries = await client.list();
      const want = target.toLowerCase();
      return entries.some(e => e.isFile && e.name.toLowerCase() === want);
    } catch (err) {
      if (!isUnsupported(err)) throw err;
    }

    // Neither probe is available on this controller. Silently returning
    // false here would turn the overwrite confirmation into a no-op and
    // let a transfer replace a running program without anyone being asked.
    throw transferError(
      'This controller cannot report whether the file already exists. ' +
      'Confirm the overwrite to send it anyway.',
      'EXISTENCE_UNKNOWN', 409
    );
  } finally {
    client.close();
  }
}

/**
 * Quick connectivity check — connects and logs in, nothing else.
 * Used by the "Test Connection" button and the live status indicator.
 */
async function testMachineConnection(machine) {
  const client = await connect(machine, { timeout: CONNECT_TIMEOUT_MS });
  client.close();
}

module.exports = {
  sendProgramToMachine,
  fetchProgramFromMachine,
  listMachineFiles,
  machineFileExists,
  testMachineConnection,
  safeFileName
};
