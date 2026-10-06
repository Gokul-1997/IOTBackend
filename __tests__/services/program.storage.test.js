/*
 * The ProgramTransfer folder: names, folders, and writing files safely.
 * Runs against a temporary directory, never the real folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
process.env.PROGRAM_TRANSFER_DIR = path.join(ROOT, 'ProgramTransfer');
process.env.PROGRAM_MAX_MB = '1';
const storage = require('../../src/programs/storage');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const machine = { id: 7, company_id: 5, ip_address: '192.168.200.3' };

describe('program names', () => {
  test.each([
    ['O1234.nc', 'O1234.nc'],
    ['O1234', 'O1234'],                                   // a Fanuc program has no extension
    ['C:\\CAM\\out\\O2001.NC', 'O2001.NC'],               // a Windows path from CAM software: the name only
    ['../../etc/O1.nc', 'O1.nc'],                         // traversal keeps the last segment only
    ['O1\r\nDELE x.nc', 'O1DELE x.nc'],                   // CR/LF never reach a protocol line
    ['part:1?.nc', 'part_1_.nc'],                         // characters Windows refuses
    ['O77.nc. ', 'O77.nc']                                // Windows drops trailing dots/spaces
  ])('%j → %j', (input, out) => expect(storage.safeProgramName(input)).toBe(out));

  test.each(['', '..', '.', '/', 'x'.repeat(101), 'tool.exe', 'evil.sh'])('%j is refused', bad => {
    expect(() => storage.safeProgramName(bad)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('the machine\'s folder', () => {
  test('one folder per machine IP, under the company', () => {
    expect(storage.machineFolder(machine)).toBe('company-5/192.168.200.3');
  });
  test('two companies with the same IP never share a folder', () => {
    expect(storage.machineFolder({ ...machine, company_id: 6 })).not.toBe(storage.machineFolder(machine));
  });
  test('no IP, or a value that is not one, falls back to the machine id', () => {
    expect(storage.machineFolder({ ...machine, ip_address: null })).toBe('company-5/machine-7');
    expect(storage.machineFolder({ ...machine, ip_address: '../../x' })).toBe('company-5/machine-7');
  });
  test('an IPv6 address loses its colons (not allowed in a Windows path)', () => {
    expect(storage.machineFolder({ ...machine, ip_address: 'fe80::1' })).toBe('company-5/fe80--1');
  });
  test('no IP set on the machine: the IP its controller reports names the folder', () => {
    // production: ip_address is empty on every machine, controller_ip is filled by the collector
    const prod = { id: 19, company_id: 4, ip_address: null, controller_ip: '192.168.200.1' };
    expect(storage.machineFolder(prod)).toBe('company-4/192.168.200.1');
    expect(storage.machineIp(prod)).toBe('192.168.200.1');
  });
  test('the IP set on the machine wins; one that is not an IP does not block the fallback', () => {
    expect(storage.machineIp({ ip_address: '10.0.0.5', controller_ip: '192.168.200.1' })).toBe('10.0.0.5');
    expect(storage.machineIp({ ip_address: 'VMC-2', controller_ip: ' 192.168.200.1 ' })).toBe('192.168.200.1');
    expect(storage.machineIp({ ip_address: '', controller_ip: '../x' })).toBeNull();
  });
});

test('file stamps are plant time (IST)', () => {
  expect(storage.stamp(new Date('2026-10-05T05:00:12Z'))).toBe('20261005-103012');
});

describe('content checks', () => {
  test('empty, binary and oversized files are refused', () => {
    expect(() => storage.checkContent(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => storage.checkContent(Buffer.from([0x4f, 0x00, 0x31]))).toThrow(/not a text NC program/);
    expect(() => storage.checkContent(Buffer.alloc(1024 * 1024 + 1, 0x41))).toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe('saving', () => {
  const at = new Date('2026-10-05T05:00:12Z');
  const body = Buffer.from('%\nO1234\nG0 X0 Y0\nM30\n%\n');

  test('the file lands in the machine folder with its stamp, kind and name', async () => {
    const saved = await storage.save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: body, at });
    expect(saved).toMatchObject({
      folder: 'company-5/192.168.200.3', storedName: '20261005-103012_NEW_O1234.nc',
      programName: 'O1234.nc', size: body.length, sha256: storage.sha256(body)
    });
    const onDisk = fs.readFileSync(path.join(storage.ROOT, saved.folder, saved.storedName));
    expect(onDisk.equals(body)).toBe(true);
    // no temporary file left behind
    expect(fs.readdirSync(path.join(storage.ROOT, saved.folder)).filter(f => f.startsWith('.upload-'))).toEqual([]);
  });

  test('a second file in the same second never replaces the first', async () => {
    const again = await storage.save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: Buffer.from('G1\n'), at });
    expect(again.storedName).toBe('20261005-103012_NEW_2_O1234.nc');
    const first = fs.readFileSync(path.join(storage.ROOT, again.folder, '20261005-103012_NEW_O1234.nc'));
    expect(first.equals(body)).toBe(true);
  });

  test('read and remove; removing twice is not an error', async () => {
    const s = await storage.save({ machine, kind: 'BACKUP', programName: 'O9.nc', buffer: Buffer.from('M30\n'), at });
    expect((await storage.read(s.folder, s.storedName)).toString()).toBe('M30\n');
    await storage.remove(s.folder, s.storedName);
    await expect(storage.remove(s.folder, s.storedName)).resolves.toBeUndefined();
  });

  test('nothing outside the root can be opened', () => {
    expect(() => storage.resolveInside('company-5/../../..', 'passwd')).toThrow(/outside the ProgramTransfer folder/);
    expect(() => storage.open('company-5', '../../../etc/passwd')).toThrow(/outside/);
  });
});
