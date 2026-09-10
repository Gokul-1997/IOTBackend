/**
 * FOCAS protocol rules, with no FFI in sight.
 *
 * Everything here is decided by Fanuc's specification rather than by the
 * library binary: what a return code means, how an NC program has to be
 * shaped before a controller will accept it, and how a file name maps to
 * the program number the upload calls want.
 *
 * Kept separate from focas.js on purpose. The FFI half cannot run without
 * a Windows machine, the licensed library and a controller on the other
 * end of the wire; this half is the part that is actually easy to get
 * wrong, so it is the part that has to be testable on any machine.
 *
 * Every constant below was read out of Fanuc's own FOCAS2 documentation
 * (Document/SpecE: ERRCODE.HTM, Program/cnc_download3.xml,
 * Program/cnc_upload3.xml). That documentation ships with the licensed
 * library and is deliberately not in this repo — it is the vendor's to
 * distribute, not ours. The facts that matter are captured here so the
 * code does not depend on having it to hand.
 */

/* ─────────────────────────────────────────────────────────────
   Return codes (ERRCODE.HTM)

   Note the sign. EW_BUFFER is +10; -10 is EW_SYSTEM2, an HSSB-only bus
   fault that an Ethernet connection never returns. Treating -10 as
   "buffer full, retry" — as the reference script we were given does —
   means a real EW_BUFFER falls through to the failure branch instead,
   so a transfer aborts precisely when the controller was momentarily
   busy. Small programs never hit it; larger ones do, intermittently,
   which is the worst way for a bug like this to present.
   ───────────────────────────────────────────────────────────── */

const EW = {
  PROTOCOL: -17, SOCKET: -16, NODLL: -15, BUS: -11, SYSTEM2: -10,
  HSSB: -9, HANDLE: -8, VERSION: -7, UNEXP: -6, SYSTEM: -5,
  PARITY: -4, MMCSYS: -3, RESET: -2, BUSY: -1, OK: 0,
  FUNC: 1, LENGTH: 2, NUMBER: 3, ATTRIB: 4, DATA: 5, NOOPT: 6,
  PROT: 7, OVRFLOW: 8, PARAM: 9, BUFFER: 10, PATH: 11, MODE: 12,
  REJECT: 13, DTSRVR: 14, ALARM: 15, STOP: 16, PASSWD: 17
};

/**
 * What each code means to the person who pressed Send. These are written
 * for an operator or a setter, not for whoever reads the FOCAS manual —
 * the machine is in front of them and the fix is usually at the panel.
 */
const MESSAGES = {
  [EW.PROTOCOL]: 'The controller returned malformed data. Check the Ethernet board.',
  [EW.SOCKET]:   'Could not reach the controller. Check power, the network cable and the IP address.',
  [EW.NODLL]:    'The FOCAS library has no driver for this CNC series.',
  [EW.HANDLE]:   'The connection to the controller was lost.',
  [EW.VERSION]:  'The FOCAS library version does not match this controller.',
  [EW.UNEXP]:    'The FOCAS library reported an unexpected internal state.',
  [EW.RESET]:    'The controller was reset or stopped during the transfer.',
  [EW.BUSY]:     'The controller is busy. Try again in a moment.',
  [EW.FUNC]:     'This operation is not available on this controller.',
  [EW.LENGTH]:   'The data length sent to the controller was rejected.',
  [EW.NUMBER]:   'That program number is not valid on this controller.',
  [EW.ATTRIB]:   'The program is write-protected on the controller.',
  [EW.DATA]:     'The controller rejected the program contents. It may contain a character the CNC does not accept, or the program number may already be in use.',
  [EW.NOOPT]:    'This controller does not have the option required for this operation.',
  [EW.PROT]:     'The program is protected on the controller (O8000/O9000 protection or encoding).',
  [EW.OVRFLOW]:  'The controller does not have enough program memory left.',
  [EW.PARAM]:    'A CNC parameter prevents this operation.',
  [EW.PATH]:     'The requested path does not exist on this controller.',
  [EW.MODE]:     'The controller is in the wrong mode. Put it in EDIT mode and make sure no program is running.',
  [EW.REJECT]:   'The controller refused the transfer in its current state — it is machining, resetting, or changing mode.',
  [EW.DTSRVR]:   'The controller data server reported an error.',
  [EW.ALARM]:    'The controller is in an alarm state. Clear the alarm and try again.',
  [EW.STOP]:     'The transfer was stopped at the controller.',
  [EW.PASSWD]:   'The program area is locked by a password on the controller.'
};

/** Codes worth calling out as "the machine is not ready", not "it broke". */
const NOT_READY = new Set([EW.BUSY, EW.MODE, EW.REJECT, EW.ALARM, EW.STOP]);

const NAMES = Object.fromEntries(Object.entries(EW).map(([k, v]) => [v, `EW_${k}`]));

/** Turn a FOCAS return code into an Error the API layer can report. */
function focasError(code, operation) {
  const name = NAMES[code] || `code ${code}`;
  const detail = MESSAGES[code] || 'The controller rejected the operation.';

  const e = new Error(`${detail} (${name} during ${operation})`);
  e.code = NOT_READY.has(code) ? 'MACHINE_NOT_READY' : 'FOCAS_ERROR';
  e.focas = { code, name, operation };
  // A machine that is simply busy or in the wrong mode is the operator's
  // to resolve, so it is a 409, not a 502 pointing at our own plumbing.
  e.status = NOT_READY.has(code) ? 409 : 502;
  return e;
}

/* ─────────────────────────────────────────────────────────────
   NC data format

   cnc_download3: "LF Block1 LF Block2 LF ... LF %". LF must be at the
   top of the whole program and % at the end; anything before the first
   LF is discarded by the controller. Get this wrong and the transfer
   succeeds while the first line of the program silently disappears.
   ───────────────────────────────────────────────────────────── */

const LF = 0x0a;
const PERCENT = 0x25;

/**
 * Shape a program the way a Fanuc controller requires before sending.
 * Idempotent, so a program already in FOCAS form is passed through
 * rather than wrapped twice.
 *
 * @param {Buffer} content raw G-code as stored in the library
 * @returns {Buffer}
 */
function toFanucFormat(content) {
  if (!content || content.length === 0) {
    const e = new Error('The program is empty. Nothing was sent to the controller.');
    e.code = 'EMPTY_PROGRAM';
    e.status = 400;
    throw e;
  }

  // Normalise CRLF first: a stray CR before the leading LF would count as
  // "data before the first LF" and take the first block with it.
  let body = Buffer.from(content).toString('latin1').replace(/\r\n/g, '\n').trim();

  // A leading % is the upload format, not the download format — the
  // controller discards everything up to the first LF, so a program that
  // came off a machine and is being sent back would lose its first line.
  if (body.startsWith('%')) body = body.slice(1).replace(/^\n/, '');
  if (body.endsWith('%'))   body = body.slice(0, -1).trimEnd();

  return Buffer.from(`\n${body}\n%`, 'latin1');
}

/**
 * Strip the wrapper off data read back from a controller so what lands in
 * the library is the program an engineer would recognise.
 * Upload format is "% LF Block1 LF ... LF %".
 */
function fromFanucFormat(content) {
  let body = Buffer.from(content).toString('latin1');

  const first = body.indexOf('\n');
  if (body.startsWith('%') && first !== -1) body = body.slice(first + 1);

  const last = body.lastIndexOf('%');
  if (last !== -1) body = body.slice(0, last);

  return Buffer.from(body.replace(/\s+$/, '') + '\n', 'latin1');
}

/**
 * The program number the upload calls address a program by.
 *
 * cnc_upstart3 takes numeric start/end program numbers, not a file name,
 * so "O1234.NC" has to become 1234 before anything can be read back.
 */
function programNumberOf(fileName) {
  const m = /O?(\d{1,8})/i.exec(String(fileName || '').split(/[\\/]/).pop() || '');
  if (!m) {
    const e = new Error(
      `Cannot work out a program number from "${fileName}". ` +
      `Fanuc programs are addressed by number, so the name needs to contain one — for example O1234.`
    );
    e.code = 'BAD_PROGRAM_NUMBER';
    e.status = 400;
    throw e;
  }
  return Number(m[1]);
}

/* ─────────────────────────────────────────────────────────────
   Transfer sizing

   cnc_download3: a multiple of 256 is preferred, and over Ethernet the
   spec asks for 1024–1400 bytes per call — below that "transmission
   efficiency become to worsen, and the communication error might occur".
   cnc_upload3 requires a multiple of 256 outright on older series.
   1280 satisfies every one of those constraints.
   ───────────────────────────────────────────────────────────── */

const CHUNK_SIZE = 1280;
const DEFAULT_PORT = 8193;

/* A controller reporting EW_BUFFER wants the identical call again. It
   clears in milliseconds, so a short pause beats a tight spin; the cap
   exists so a wedged controller fails with a real message instead of
   holding the machine lock until something times out. */
const BUFFER_RETRY_LIMIT = 200;
const BUFFER_RETRY_MS = 20;

module.exports = {
  EW, NAMES, MESSAGES, NOT_READY,
  focasError,
  toFanucFormat, fromFanucFormat, programNumberOf,
  CHUNK_SIZE, DEFAULT_PORT, BUFFER_RETRY_LIMIT, BUFFER_RETRY_MS,
  LF, PERCENT
};
