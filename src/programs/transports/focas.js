/**
 * Program transfer over FOCAS (Fanuc Open CNC API Specifications).
 *
 * Exposes the same interface as the FTP transport, so the service layer
 * above it — the supervisor OTP gate, the per-machine lock, the audit
 * row, the live progress events — is unchanged by which one a machine
 * uses.
 *
 * What FOCAS buys over FTP is refusal. A controller rejects a write while
 * a program is running (EW_REJECT), while the memory-protect key is on
 * (EW_ATTRIB), when memory is full (EW_OVRFLOW) and when the program is
 * already selected. FTP accepts all four and leaves the operator to find
 * out at the panel.
 *
 * ── Where this can run ─────────────────────────────────────────────
 * The library is a native binary: Fwlib64.dll on Windows, libfwlib32.so
 * on Linux. This module loads it in-process, so the Node process must be
 * on a machine that has the licensed library AND a network route to the
 * controller's port 8193. A cloud API server has neither. Point
 * FOCAS_LIB_PATH at the library and it loads; leave it unset on a host
 * that has no library and every call reports NOT_AVAILABLE rather than
 * crashing the process at require() time.
 *
 * ── Threading ──────────────────────────────────────────────────────
 * FOCAS library handles are not thread-safe, so every call here is
 * synchronous — koffi's async variants would hand the same handle to
 * different worker threads. The event loop is therefore blocked for the
 * duration of one FOCAS call, and the loops below yield between chunks
 * so progress events flush and the rest of the API keeps serving. The
 * per-machine advisory lock in program.service.js is what stops two
 * transfers sharing a controller.
 *
 * Signatures were verified against Fanuc's FOCAS2 specification
 * (Document/SpecE/Program/*.xml), which ships with the licensed library
 * and is not redistributed here.
 */

const path = require('path');
const koffi = require('koffi');
const P = require('./focas.protocol');

const { EW } = P;

/* ─────────────────────────────────────────────────────────────
   Loading the library
   ───────────────────────────────────────────────────────────── */

function defaultLibraryName() {
  if (process.platform === 'win32') return 'Fwlib64.dll';
  if (process.platform === 'linux') return 'libfwlib32.so';
  return null;   // no Fanuc build for macOS
}

let lib = null;
let loadError = null;
let fns = null;

function unavailable(reason) {
  const e = new Error(
    `FOCAS is not available on this server: ${reason}. ` +
    `Program transfer over FOCAS has to run on a host with the licensed Fanuc library ` +
    `and a network route to the controller.`
  );
  e.code = 'FOCAS_NOT_AVAILABLE';
  e.status = 503;
  return e;
}

/**
 * Bind the library on first use rather than at require() time, so the API
 * still boots on a server that will never speak FOCAS — the machines that
 * use another transport must keep working.
 */
function load() {
  if (fns) return fns;
  if (loadError) throw unavailable(loadError);

  const target = process.env.FOCAS_LIB_PATH || defaultLibraryName();
  if (!target) {
    loadError = `no Fanuc library exists for ${process.platform}`;
    throw unavailable(loadError);
  }

  try {
    lib = koffi.load(path.isAbsolute(target) ? target : target);
  } catch (err) {
    loadError = `could not load ${target} (${err.message})`;
    throw unavailable(loadError);
  }

  try {
    fns = {
      // short cnc_allclibhndl3(const char *ip, unsigned short port, long timeout, unsigned short *handle)
      allclibhndl3: lib.func('short cnc_allclibhndl3(const char *ip, uint16_t port, long timeout, _Out_ uint16_t *handle)'),
      freelibhndl:  lib.func('short cnc_freelibhndl(uint16_t handle)'),

      // PC → CNC. FOCAS calls this "download"; our API calls it an upload.
      dwnstart3:    lib.func('short cnc_dwnstart3(uint16_t handle, short type)'),
      download3:    lib.func('short cnc_download3(uint16_t handle, _Inout_ long *length, const char *data)'),
      dwnend3:      lib.func('short cnc_dwnend3(uint16_t handle)'),

      // CNC → PC.
      upstart3:     lib.func('short cnc_upstart3(uint16_t handle, short type, long s_number, long e_number)'),
      upload3:      lib.func('short cnc_upload3(uint16_t handle, _Inout_ long *length, _Out_ char *data)'),
      upend3:       lib.func('short cnc_upend3(uint16_t handle)')
    };
  } catch (err) {
    loadError = `the library loaded but its functions do not match the expected FOCAS signatures (${err.message})`;
    fns = null;
    throw unavailable(loadError);
  }

  return fns;
}

/** True when this host could actually talk FOCAS, without throwing. */
function isAvailable() {
  try { load(); return true; } catch { return false; }
}

/* ─────────────────────────────────────────────────────────────
   Session handling
   ───────────────────────────────────────────────────────────── */

const CONNECT_TIMEOUT = 10;   // FOCAS counts this in seconds
const NC_PROGRAM = 0;         // the `type` argument on dwnstart3/upstart3

/** Let the event loop breathe between synchronous FOCAS calls. */
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireAddress(machine) {
  if (!machine?.ip_address) {
    const e = new Error(
      'This machine has no IP address configured. Edit the machine and set it before transferring.'
    );
    e.code = 'NOT_CONFIGURED';
    e.status = 400;
    throw e;
  }
}

/**
 * Open a FOCAS handle, run `fn(handle)`, and always release the handle.
 *
 * The release matters more than it looks: a controller allows only a
 * handful of concurrent connections, and a leaked handle stays allocated
 * on the CNC until it times out. Leak a few and the machine stops
 * accepting connections entirely — including from the operator's own
 * tooling.
 */
async function withHandle(machine, fn) {
  requireAddress(machine);
  const f = load();

  const port = Number(machine.focas_port) || P.DEFAULT_PORT;
  const out = [0];

  const rc = f.allclibhndl3(String(machine.ip_address), port, CONNECT_TIMEOUT, out);
  if (rc !== EW.OK) throw P.focasError(rc, 'connecting to the controller');

  const handle = out[0];
  try {
    return await fn(handle, f);
  } finally {
    try { f.freelibhndl(handle); } catch { /* nothing useful to do */ }
  }
}

/* ─────────────────────────────────────────────────────────────
   PC → CNC
   ───────────────────────────────────────────────────────────── */

/**
 * Send a program to the controller.
 * Signature matches the FTP transport so callers do not branch.
 *
 * @param {object}   machine
 * @param {Buffer}   content     raw G-code from the library
 * @param {string}   fileName    used only for messages; Fanuc takes the
 *                               program number from the O-word in the data
 * @param {function} [onProgress] ({ bytes, total })
 */
async function sendProgramToMachine(machine, content, fileName, onProgress) {
  const data = P.toFanucFormat(content);
  const total = data.length;

  return withHandle(machine, async (handle, f) => {
    // The controller decides here whether it will accept a write at all:
    // running program, memory-protect key, wrong mode.
    const started = f.dwnstart3(handle, NC_PROGRAM);
    if (started !== EW.OK) throw P.focasError(started, 'starting the transfer');

    let sent = 0;
    let stalls = 0;
    let failure = null;

    try {
      while (sent < total) {
        const chunk = data.subarray(sent, Math.min(sent + P.CHUNK_SIZE, total));
        const length = [chunk.length];

        const rc = f.download3(handle, length, chunk);

        if (rc === EW.OK) {
          // The controller reports how much it actually took, which can be
          // less than offered — advancing by chunk.length instead would
          // skip bytes and corrupt the program on the machine.
          const accepted = length[0];
          if (accepted <= 0) throw P.focasError(EW.LENGTH, 'sending the program');

          sent += accepted;
          stalls = 0;

          if (typeof onProgress === 'function') onProgress({ bytes: sent, total });
          await yieldToLoop();
          continue;
        }

        if (rc === EW.BUFFER) {
          // Controller buffer momentarily full: the spec says call again
          // with the same arguments. Note this is +10; -10 is an HSSB bus
          // fault and must not be retried.
          if (++stalls > P.BUFFER_RETRY_LIMIT) {
            throw P.focasError(EW.BUFFER, 'sending the program (controller stopped accepting data)');
          }
          await pause(P.BUFFER_RETRY_MS);
          continue;
        }

        throw P.focasError(rc, 'sending the program');
      }
    } catch (err) {
      failure = err;
    }

    // dwnend3 must run whether or not the loop succeeded: it closes the
    // controller's side of the transfer, and it is also where deferred
    // errors from earlier chunks surface — the spec is explicit that
    // download3 may report success for data that is rejected later.
    const ended = f.dwnend3(handle);

    if (failure) throw failure;
    if (ended !== EW.OK) throw P.focasError(ended, 'finishing the transfer');

    return { bytes: total };
  });
}

/* ─────────────────────────────────────────────────────────────
   CNC → PC
   ───────────────────────────────────────────────────────────── */

/**
 * Read one program off the controller.
 *
 * @returns {Promise<Buffer>} the program with the FOCAS wrapper removed
 */
async function fetchProgramFromMachine(machine, fileName, onProgress) {
  const number = P.programNumberOf(fileName);

  return withHandle(machine, async (handle, f) => {
    // s_number === e_number selects exactly one program.
    const started = f.upstart3(handle, NC_PROGRAM, number, number);
    if (started !== EW.OK) throw P.focasError(started, `reading program O${number}`);

    const chunks = [];
    let bytes = 0;
    let stalls = 0;
    let failure = null;
    let done = false;

    try {
      while (!done) {
        const buf = Buffer.alloc(P.CHUNK_SIZE);
        const length = [P.CHUNK_SIZE];

        const rc = f.upload3(handle, length, buf);

        if (rc === EW.OK) {
          const got = length[0];
          if (got > 0) {
            chunks.push(Buffer.from(buf.subarray(0, got)));
            bytes += got;
            if (typeof onProgress === 'function') onProgress({ bytes, total: 0 });
          }
          await yieldToLoop();
          continue;
        }

        if (rc === EW.BUFFER) {
          if (++stalls > P.BUFFER_RETRY_LIMIT) {
            throw P.focasError(EW.BUFFER, 'reading the program (controller stopped sending)');
          }
          await pause(P.BUFFER_RETRY_MS);
          continue;
        }

        if (rc === EW.RESET) {
          // Reading past the closing '%' is how FOCAS signals the end of
          // the program — an expected finish, not a fault.
          done = true;
          continue;
        }

        throw P.focasError(rc, 'reading the program');
      }
    } catch (err) {
      failure = err;
    }

    const ended = f.upend3(handle);

    if (failure) throw failure;
    if (ended !== EW.OK) throw P.focasError(ended, 'finishing the read');

    if (bytes === 0) {
      const e = new Error(`Program O${number} is not on this controller.`);
      e.code = 'PROGRAM_NOT_FOUND';
      e.status = 404;
      throw e;
    }

    return P.fromFanucFormat(Buffer.concat(chunks));
  });
}

/* ─────────────────────────────────────────────────────────────
   Probes
   ───────────────────────────────────────────────────────────── */

/**
 * Is this program already on the controller?
 *
 * Asks the controller to start reading that one program number and stops
 * immediately. A program that is not there fails at upstart3, which is a
 * far more direct answer than reading the whole directory — and unlike
 * the FTP transport there is no model where the probe is unsupported.
 */
async function machineFileExists(machine, fileName) {
  const number = P.programNumberOf(fileName);

  return withHandle(machine, async (handle, f) => {
    const rc = f.upstart3(handle, NC_PROGRAM, number, number);

    if (rc !== EW.OK) {
      // EW_DATA here means "no program in that range"; anything else is a
      // genuine fault and must not be reported as "the file is absent",
      // or the overwrite guard silently stops guarding.
      if (rc === EW.DATA) return false;
      throw P.focasError(rc, `checking for program O${number}`);
    }

    f.upend3(handle);
    return true;
  });
}

/**
 * Connectivity check for the machine form's Test Connection button.
 * Opens a handle and releases it — nothing on the controller changes.
 */
async function testMachineConnection(machine) {
  await withHandle(machine, async () => undefined);
}

/**
 * Listing the controller's program directory needs cnc_rdprogdir3, whose
 * result is a packed struct that varies by CNC series. It is not bound
 * here, so the file browser reports this honestly rather than showing an
 * empty directory that looks like a machine with no programs on it.
 */
async function listMachineFiles() {
  const e = new Error(
    'Listing programs over FOCAS is not implemented yet. ' +
    'Programs can still be sent and fetched by number.'
  );
  e.code = 'LIST_UNSUPPORTED';
  e.status = 501;
  throw e;
}

module.exports = {
  sendProgramToMachine,
  fetchProgramFromMachine,
  listMachineFiles,
  machineFileExists,
  testMachineConnection,
  isAvailable,
  /** @internal exposed for tests */
  _load: load
};
