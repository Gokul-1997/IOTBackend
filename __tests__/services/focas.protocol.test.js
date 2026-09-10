/*
 * Unit tests for programs/transports/focas.protocol — the half of the
 * FOCAS transport that does not need the Fanuc library, a Windows host or
 * a controller on the wire.
 *
 * These are the rules that decide whether a program arrives intact. The
 * FFI half is thin and mostly unavoidable; this half is where a mistake
 * is silent — a transfer that reports success while the controller has
 * quietly dropped the first line of the program.
 *
 * Everything asserted here traces to Fanuc's FOCAS2 specification, which
 * ships with the licensed library rather than living in this repo.
 */

const P = require('../../src/programs/transports/focas.protocol');

const str = buf => buf.toString('latin1');

describe('return codes', () => {
  /*
   * The reference script supplied with the library retries on -10. Per
   * ERRCODE.HTM that is EW_SYSTEM2, an HSSB-only bus fault; EW_BUFFER —
   * the "controller buffer momentarily full, call again" case — is +10.
   * Getting the sign wrong means a transfer aborts exactly when the
   * controller was briefly busy, which small test programs never trigger
   * and production programs do.
   */
  test('EW_BUFFER is +10, and -10 is a different error entirely', () => {
    expect(P.EW.BUFFER).toBe(10);
    expect(P.EW.SYSTEM2).toBe(-10);
    expect(P.EW.BUFFER).not.toBe(-10);
  });

  test.each([
    ['EW_OK', 0], ['EW_BUSY', -1], ['EW_RESET', -2], ['EW_SOCKET', -16],
    ['EW_FUNC', 1], ['EW_DATA', 5], ['EW_PROT', 7], ['EW_OVRFLOW', 8],
    ['EW_MODE', 12], ['EW_REJECT', 13], ['EW_ALARM', 15]
  ])('%s is %i', (name, code) => {
    expect(P.NAMES[code]).toBe(name);
  });

  test('a machine that is merely not ready is a 409, not a server fault', () => {
    // The operator resolves these at the panel; reporting 502 would send
    // them to us instead of to the machine.
    for (const code of [P.EW.BUSY, P.EW.MODE, P.EW.REJECT, P.EW.ALARM, P.EW.STOP]) {
      const e = P.focasError(code, 'sending');
      expect(e.status).toBe(409);
      expect(e.code).toBe('MACHINE_NOT_READY');
    }
  });

  test('a genuine fault is a 502 carrying the FOCAS code', () => {
    const e = P.focasError(P.EW.SOCKET, 'connecting to the controller');
    expect(e.status).toBe(502);
    expect(e.code).toBe('FOCAS_ERROR');
    expect(e.focas).toEqual({ code: -16, name: 'EW_SOCKET', operation: 'connecting to the controller' });
    expect(e.message).toMatch(/EW_SOCKET/);
  });

  test('the message tells the operator what to do, not just what broke', () => {
    expect(P.focasError(P.EW.REJECT, 'starting').message).toMatch(/machining, resetting, or changing mode/i);
    expect(P.focasError(P.EW.OVRFLOW, 'sending').message).toMatch(/memory/i);
    expect(P.focasError(P.EW.ALARM, 'sending').message).toMatch(/clear the alarm/i);
  });

  test('an unknown code still produces a usable error', () => {
    const e = P.focasError(-999, 'sending');
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/code -999/);
  });
});

/*
 * cnc_download3: "LF Block1 LF ... LF %". LF must lead the whole program
 * and % must end it — and the spec is explicit that "data before the
 * first LF are ignored", which is how a missing leading LF costs you the
 * first line of the program with no error anywhere.
 */
describe('toFanucFormat', () => {
  test('adds the leading LF and the trailing %', () => {
    expect(str(P.toFanucFormat(Buffer.from('O1234\nG0 X0\nM30'))))
      .toBe('\nO1234\nG0 X0\nM30\n%');
  });

  test('the first block survives — the failure this format prevents', () => {
    const out = str(P.toFanucFormat(Buffer.from('O1234')));
    expect(out.startsWith('\n')).toBe(true);
    expect(out).toContain('O1234');
  });

  test('is idempotent, so a re-send does not wrap twice', () => {
    const once = P.toFanucFormat(Buffer.from('O1\nM30'));
    expect(str(P.toFanucFormat(once))).toBe(str(once));
  });

  test('a program fetched from a machine can be sent straight back', () => {
    // Upload format leads with "%\n"; download format must not, or the
    // controller discards up to the first LF and eats the O-word.
    const fromMachine = Buffer.from('%\nO1234\nG0 X0\nM30\n%');
    const out = str(P.toFanucFormat(fromMachine));
    expect(out).toBe('\nO1234\nG0 X0\nM30\n%');
    expect(out.startsWith('%')).toBe(false);
  });

  test('CRLF from a Windows CAM post is normalised', () => {
    // A CR sitting before the leading LF counts as data before the first
    // LF, taking the first block with it.
    expect(str(P.toFanucFormat(Buffer.from('O1234\r\nG0 X0\r\nM30'))))
      .toBe('\nO1234\nG0 X0\nM30\n%');
  });

  test.each([
    ['trailing whitespace', 'O1\nM30\n\n  '],
    ['leading whitespace',  '  \n\nO1\nM30']
  ])('%s does not disturb the wrapper', (_label, input) => {
    const out = str(P.toFanucFormat(Buffer.from(input)));
    expect(out.startsWith('\n')).toBe(true);
    expect(out.endsWith('\n%')).toBe(true);
    expect(out).not.toMatch(/\n\n%/);
  });

  test.each([[Buffer.alloc(0)], [null], [undefined]])('refuses %p', (empty) => {
    expect(() => P.toFanucFormat(empty)).toThrow(
      expect.objectContaining({ code: 'EMPTY_PROGRAM', status: 400 })
    );
  });
});

describe('fromFanucFormat', () => {
  test('unwraps what a controller sends back', () => {
    expect(str(P.fromFanucFormat(Buffer.from('%\nO1234\nG0 X0\nM30\n%'))))
      .toBe('O1234\nG0 X0\nM30\n');
  });

  test('round-trips with toFanucFormat', () => {
    const original = 'O1234\nG0 X0 Y0\nG1 Z-5 F100\nM30';
    const sent = P.toFanucFormat(Buffer.from(original));
    // what a controller would hand back is the same body in upload form
    const returned = Buffer.from('%' + str(sent), 'latin1');
    expect(str(P.fromFanucFormat(returned)).trim()).toBe(original);
  });

  test('tolerates data with no wrapper at all', () => {
    expect(str(P.fromFanucFormat(Buffer.from('O1\nM30'))).trim()).toBe('O1\nM30');
  });
});

/*
 * cnc_upstart3 addresses programs by number, not by name, so every fetch
 * and every existence check depends on this mapping.
 */
describe('programNumberOf', () => {
  test.each([
    ['O1234.NC',  1234],
    ['O1234',     1234],
    ['o0001.nc',  1],
    ['O9999.prg', 9999],
    ['1234.nc',   1234],
    ['/PRG/O5678.NC', 5678]
  ])('%s → %i', (name, expected) => {
    expect(P.programNumberOf(name)).toBe(expected);
  });

  test.each([['flange.nc'], [''], [null], ['O.nc']])('refuses %p with a message that says why', (bad) => {
    expect(() => P.programNumberOf(bad)).toThrow(/addressed by number/i);
    expect(() => P.programNumberOf(bad)).toThrow(
      expect.objectContaining({ code: 'BAD_PROGRAM_NUMBER', status: 400 })
    );
  });
});

describe('transfer sizing', () => {
  test('the chunk satisfies every constraint the spec puts on it', () => {
    // multiple of 256 (cnc_upload3, older series) and inside the
    // 1024–1400 window cnc_download3 asks for over Ethernet
    expect(P.CHUNK_SIZE % 256).toBe(0);
    expect(P.CHUNK_SIZE).toBeGreaterThanOrEqual(1024);
    expect(P.CHUNK_SIZE).toBeLessThanOrEqual(1400);
  });

  test('the default port is the FOCAS one', () => {
    expect(P.DEFAULT_PORT).toBe(8193);
  });

  test('buffer retries are bounded', () => {
    // an unbounded retry would hold the machine lock forever against a
    // controller that has stopped accepting data
    expect(P.BUFFER_RETRY_LIMIT).toBeGreaterThan(0);
    expect(P.BUFFER_RETRY_LIMIT).toBeLessThan(1000);
    expect(P.BUFFER_RETRY_MS).toBeGreaterThan(0);
  });
});
