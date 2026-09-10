/*
 * Which protocol each machine gets routed to.
 *
 * This runs against the real controller strings in the live fleet, which
 * are free text and inconsistent — "FANUC oi-MF", "FANUC Oi-MF", "Fanuc
 * 0i-MF", "Fanuc 0i-TF", "Fanuc 31i-B" and a bare "FANUC" all exist. The
 * routing has to survive that without anyone hand-cleaning the column
 * first, because a machine that routes wrong either loses transfer
 * entirely or gets sent down a protocol its controller does not speak.
 */

const { protocolFor, protocolFromController, transportFor, TRANSPORTS } =
  require('../../src/programs/transports');

describe('routing by controller name', () => {
  test.each([
    ['FANUC oi-MF'],      // as stored on 9 machines
    ['FANUC Oi-MF'],
    ['Fanuc 0i-MF'],
    ['Fanuc 0i-TF'],
    ['Fanuc 31i-B'],
    ['FANUC'],
    ['  fanuc 30i  ']
  ])('%s → FOCAS', (controller) => {
    expect(protocolFromController(controller)).toBe('FOCAS');
  });

  test.each([
    ['M80'], ['M70'], ['Mitsubishi M80'],
    ['Siemens 840D'], ['Heidenhain TNC640']
  ])('%s → FTP', (controller) => {
    expect(protocolFromController(controller)).toBe('FTP');
  });

  test.each([[null], [undefined], ['']])('%p falls back to FTP', (controller) => {
    // Losing transfer on a machine because nobody filled in a free-text
    // field would be a worse failure than using the protocol it had
    // yesterday.
    expect(protocolFromController(controller)).toBe('FTP');
  });
});

describe('an explicit setting wins over the guess', () => {
  test('transfer_protocol overrides the controller name', () => {
    expect(protocolFor({ controller: 'FANUC 0i-MF', transfer_protocol: 'FTP' })).toBe('FTP');
    expect(protocolFor({ controller: 'M80', transfer_protocol: 'FOCAS' })).toBe('FOCAS');
  });

  test('it is case-insensitive', () => {
    expect(protocolFor({ controller: 'M80', transfer_protocol: 'focas' })).toBe('FOCAS');
  });

  test('an unrecognised value falls back to the controller name rather than failing', () => {
    expect(protocolFor({ controller: 'FANUC 0i-MF', transfer_protocol: 'CAROLINE' })).toBe('FOCAS');
    expect(protocolFor({ controller: 'M80', transfer_protocol: 'CAROLINE' })).toBe('FTP');
  });
});

describe('transportFor', () => {
  /*
   * The contract the service layer depends on. Each transport may export
   * extra helpers of its own — FTP exposes safeFileName for its tests —
   * but every one of these five has to be present, or switching a machine
   * to another protocol removes a capability and only fails once someone
   * is standing at the machine.
   */
  const INTERFACE = [
    'sendProgramToMachine', 'fetchProgramFromMachine',
    'listMachineFiles', 'machineFileExists', 'testMachineConnection'
  ];

  test('routes to a module implementing the whole interface', () => {
    for (const machine of [{ controller: 'FANUC 0i-MF' }, { controller: 'M80' }]) {
      const t = transportFor(machine);
      for (const fn of INTERFACE) expect(typeof t[fn]).toBe('function');
    }
  });

  test.each(Object.keys(TRANSPORTS))('%s implements every one of them', (name) => {
    for (const fn of INTERFACE) expect(typeof TRANSPORTS[name][fn]).toBe('function');
  });
});
