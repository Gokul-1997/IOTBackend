/*
 * Unit tests for programs/transports/focas — the transfer loops, with the
 * Fanuc library replaced by a fake that answers the way the specification
 * says a controller does.
 *
 * The real library cannot run here: it is a licensed Windows/Linux binary
 * and it needs a controller on port 8193. What can be verified without one
 * is everything around the calls — that a partial accept advances by what
 * the controller actually took, that EW_BUFFER means retry rather than
 * fail, that EW_RESET is a normal end of file, and that the handle is
 * released down every path including the failures.
 *
 * Handle leaks are the one that bites quietly: a controller allows only a
 * few concurrent connections, so a leaked handle per failed transfer takes
 * the machine offline after a handful of attempts.
 */

const P = require('../../src/programs/transports/focas.protocol');

const { EW } = P;

jest.mock('koffi', () => ({ load: jest.fn() }));

let koffi;   // re-required after every resetModules — see setup()
let focas;
let fake;

/**
 * Rebuild the whole module graph with a fake Fanuc library in place.
 *
 * jest.resetModules() re-runs the koffi mock factory, so the module under
 * test ends up holding a *different* jest.fn than a stale reference in
 * this file would. Re-requiring both here is what keeps them the same
 * object; skipping it fails as "koffi.load returned undefined", which
 * looks like a bug in the transport rather than in the harness.
 */
function setup(overrides = {}) {
  jest.resetModules();
  koffi = require('koffi');

  fake = {
    allclibhndl3: jest.fn((_ip, _port, _t, out) => { out[0] = 4242; return EW.OK; }),
    freelibhndl:  jest.fn(() => EW.OK),
    dwnstart3:    jest.fn(() => EW.OK),
    download3:    jest.fn(() => EW.OK),          // accepts everything offered
    dwnend3:      jest.fn(() => EW.OK),
    upstart3:     jest.fn(() => EW.OK),
    upload3:      jest.fn(() => EW.RESET),       // nothing to read
    upend3:       jest.fn(() => EW.OK),
    ...overrides
  };

  koffi.load.mockReturnValue({
    func: (signature) => fake[/\b(cnc_\w+)\s*\(/.exec(signature)[1].replace(/^cnc_/, '')]
  });

  focas = require('../../src/programs/transports/focas');
}

const machine = {
  id: 20, machine_serial_no: 'VMC-01',
  ip_address: '192.168.1.101', controller: 'FANUC oi-MF'
};

beforeEach(() => {
  process.env.FOCAS_LIB_PATH = '/fake/Fwlib64.dll';
  setup();
});

afterEach(() => { delete process.env.FOCAS_LIB_PATH; });

describe('connecting', () => {
  test('opens on the FOCAS port and always releases the handle', async () => {
    await focas.testMachineConnection(machine);

    expect(fake.allclibhndl3).toHaveBeenCalledWith('192.168.1.101', 8193, expect.any(Number), expect.anything());
    expect(fake.freelibhndl).toHaveBeenCalledWith(4242);
  });

  test('a machine with no IP fails before the library is touched', async () => {
    await expect(focas.testMachineConnection({ id: 1 })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED', status: 400
    });
    expect(fake.allclibhndl3).not.toHaveBeenCalled();
  });

  test('a refused connection reports the controller error, not a generic one', async () => {
    setup({ allclibhndl3: jest.fn(() => EW.SOCKET) });

    await expect(focas.testMachineConnection(machine)).rejects.toMatchObject({
      code: 'FOCAS_ERROR',
      focas: expect.objectContaining({ name: 'EW_SOCKET' })
    });
    // nothing to release — the handle was never allocated
    expect(fake.freelibhndl).not.toHaveBeenCalled();
  });
});

describe('sendProgramToMachine', () => {
  const program = Buffer.from('O1234\n' + 'G1 X1 Y1\n'.repeat(400) + 'M30');

  test('sends the whole program in spec-sized chunks', async () => {
    const chunks = [];
    setup({
      download3: jest.fn((_h, length, data) => { chunks.push(Buffer.from(data).length); return EW.OK; })
    });

    await focas.sendProgramToMachine(machine, program, 'O1234.NC');

    const expected = P.toFanucFormat(program).length;
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(expected);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(P.CHUNK_SIZE);
    expect(fake.dwnstart3).toHaveBeenCalledWith(4242, 0);   // type 0 = NC program
    expect(fake.dwnend3).toHaveBeenCalled();
    expect(fake.freelibhndl).toHaveBeenCalled();
  });

  test('advances by what the controller accepted, not by what was offered', async () => {
    // The spec says download3 may store fewer characters than asked and
    // report the real number back through *length. Advancing by the
    // offered size instead would skip those bytes and register a corrupt
    // program on the machine — with every call returning EW_OK.
    let call = 0;
    setup({
      download3: jest.fn((_h, length) => {
        if (call++ === 0) length[0] = 100;   // took only part of the first chunk
        return EW.OK;
      })
    });

    await focas.sendProgramToMachine(machine, program, 'O1234.NC');

    const total = P.toFanucFormat(program).length;
    const offered = fake.download3.mock.calls.map(c => c[1]);
    // the run must account for every byte, partial accept included
    expect(fake.download3).toHaveBeenCalled();
    expect(offered.length).toBeGreaterThan(Math.ceil(total / P.CHUNK_SIZE));
  });

  test('EW_BUFFER is retried with the same data, not treated as a failure', async () => {
    let stalled = false;
    setup({
      download3: jest.fn((_h, length, data) => {
        if (!stalled) { stalled = true; return EW.BUFFER; }
        return EW.OK;
      })
    });

    await expect(focas.sendProgramToMachine(machine, Buffer.from('O1\nM30'), 'O1.NC'))
      .resolves.toEqual(expect.objectContaining({ bytes: expect.any(Number) }));

    // the retry re-sends the identical chunk
    const [first, second] = fake.download3.mock.calls;
    expect(Buffer.from(second[2]).equals(Buffer.from(first[2]))).toBe(true);
  });

  test('a controller stuck on EW_BUFFER gives up instead of spinning forever', async () => {
    setup({ download3: jest.fn(() => EW.BUFFER) });

    await expect(focas.sendProgramToMachine(machine, Buffer.from('O1\nM30'), 'O1.NC'))
      .rejects.toThrow(/stopped accepting data/i);

    expect(fake.download3.mock.calls.length).toBeLessThanOrEqual(P.BUFFER_RETRY_LIMIT + 2);
    expect(fake.freelibhndl).toHaveBeenCalled();
  }, 15000);

  test('a refusal at dwnstart3 never sends a byte', async () => {
    // This is the case FTP cannot detect: the controller is machining.
    setup({ dwnstart3: jest.fn(() => EW.REJECT) });

    await expect(focas.sendProgramToMachine(machine, Buffer.from('O1\nM30'), 'O1.NC'))
      .rejects.toMatchObject({ code: 'MACHINE_NOT_READY', status: 409 });

    expect(fake.download3).not.toHaveBeenCalled();
    expect(fake.freelibhndl).toHaveBeenCalled();
  });

  test('errors deferred to dwnend3 are surfaced, not swallowed', async () => {
    // The spec warns that download3 reports success for data the
    // controller rejects later, and that dwnend3 is where it appears.
    setup({ dwnend3: jest.fn(() => EW.OVRFLOW) });

    await expect(focas.sendProgramToMachine(machine, Buffer.from('O1\nM30'), 'O1.NC'))
      .rejects.toMatchObject({ focas: expect.objectContaining({ name: 'EW_OVRFLOW' }) });
  });

  test('dwnend3 still runs when the send failed, and the first error wins', async () => {
    setup({
      download3: jest.fn(() => EW.DATA),
      dwnend3:   jest.fn(() => EW.OK)
    });

    await expect(focas.sendProgramToMachine(machine, Buffer.from('O1\nM30'), 'O1.NC'))
      .rejects.toMatchObject({ focas: expect.objectContaining({ name: 'EW_DATA' }) });

    // leaving the transfer open on the controller would block the next one
    expect(fake.dwnend3).toHaveBeenCalled();
    expect(fake.freelibhndl).toHaveBeenCalled();
  });

  test('reports progress against the real total', async () => {
    const seen = [];
    await focas.sendProgramToMachine(machine, program, 'O1234.NC', p => seen.push(p));

    const total = P.toFanucFormat(program).length;
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every(p => p.total === total)).toBe(true);
    expect(seen.at(-1).bytes).toBe(total);
  });

  test('refuses an empty program before opening a handle', async () => {
    await expect(focas.sendProgramToMachine(machine, Buffer.alloc(0), 'O1.NC'))
      .rejects.toMatchObject({ code: 'EMPTY_PROGRAM' });
    expect(fake.allclibhndl3).not.toHaveBeenCalled();
  });
});

describe('fetchProgramFromMachine', () => {
  test('reads until EW_RESET and unwraps the result', async () => {
    const body = '%\nO1234\nG0 X0\nM30\n%';
    let sent = false;
    setup({
      upload3: jest.fn((_h, length, data) => {
        if (sent) return EW.RESET;
        sent = true;
        Buffer.from(body, 'latin1').copy(data);
        length[0] = body.length;
        return EW.OK;
      })
    });

    const out = await focas.fetchProgramFromMachine(machine, 'O1234.NC');

    expect(out.toString('latin1').trim()).toBe('O1234\nG0 X0\nM30');
    expect(fake.upstart3).toHaveBeenCalledWith(4242, 0, 1234, 1234);
    expect(fake.upend3).toHaveBeenCalled();
    expect(fake.freelibhndl).toHaveBeenCalled();
  });

  test('a program that is not on the controller is a 404, not an empty file', async () => {
    // Storing a zero-byte program in the library would look like a
    // successful fetch and cut nothing when sent back.
    await expect(focas.fetchProgramFromMachine(machine, 'O9999.NC'))
      .rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND', status: 404 });
  });

  test('a name with no program number is refused before connecting', async () => {
    await expect(focas.fetchProgramFromMachine(machine, 'flange.nc'))
      .rejects.toMatchObject({ code: 'BAD_PROGRAM_NUMBER' });
    expect(fake.allclibhndl3).not.toHaveBeenCalled();
  });
});

describe('machineFileExists', () => {
  test('true when the controller can start reading that number', async () => {
    await expect(focas.machineFileExists(machine, 'O1234.NC')).resolves.toBe(true);
    expect(fake.upend3).toHaveBeenCalled();   // probe closed, nothing left open
  });

  test('EW_DATA means the program is not there', async () => {
    setup({ upstart3: jest.fn(() => EW.DATA) });
    await expect(focas.machineFileExists(machine, 'O1234.NC')).resolves.toBe(false);
  });

  test('any other error is raised, never reported as "not there"', async () => {
    // Reporting false here would turn the overwrite guard into a no-op
    // whenever the controller was busy.
    setup({ upstart3: jest.fn(() => EW.BUSY) });

    await expect(focas.machineFileExists(machine, 'O1234.NC'))
      .rejects.toMatchObject({ code: 'MACHINE_NOT_READY' });
  });
});

describe('when the library is not on this host', () => {
  test('reports it as unavailable instead of crashing the API', async () => {
    jest.resetModules();
    koffi.load.mockImplementation(() => { throw new Error('image not found'); });
    const isolated = require('../../src/programs/transports/focas');

    await expect(isolated.testMachineConnection(machine)).rejects.toMatchObject({
      code: 'FOCAS_NOT_AVAILABLE', status: 503
    });
    expect(isolated.isAvailable()).toBe(false);
  });
});
