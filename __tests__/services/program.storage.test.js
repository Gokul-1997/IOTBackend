/*
 * The ProgramTransfer folder: names, folders, and writing files safely.
 * Runs against a temporary directory, never the real folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
process.env.STORAGE_ROOT = path.join(ROOT, 'unified');
process.env.PROGRAM_TRANSFER_DIR = path.join(ROOT, 'ProgramTransfer');
process.env.PROGRAM_MAX_MB = '1';
const storage = require('../../src/programs/storage');

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const machine = { id: 7, company_id: 5, ip_address: '192.168.200.3' };

// Exercise the same staged, bounded streaming writer as gateway uploads.
async function save({ buffer, ...options }) {
  const filename = path.join(ROOT, `${randomUUID()}.nc`);
  fs.writeFileSync(filename, buffer);
  try {
    return await storage.saveStream({ ...options, filename });
  } finally {
    fs.rmSync(filename, { force: true });
  }
}

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
  test('a stable machine ID names its folder under the company programs directory', () => {
    expect(storage.machineFolder(machine)).toBe('company-5/programs/machine-7');
  });
  test('two companies with the same IP never share a folder', () => {
    expect(storage.machineFolder({ ...machine, company_id: 6 })).not.toBe(storage.machineFolder(machine));
  });
  test('a missing, invalid or changed IP never changes the folder', () => {
    expect(storage.machineFolder({ ...machine, ip_address: null })).toBe(storage.machineFolder(machine));
    expect(storage.machineFolder({ ...machine, ip_address: '../../x' })).toBe(storage.machineFolder(machine));
    expect(storage.machineFolder({ ...machine, ip_address: '10.0.0.100' })).toBe(storage.machineFolder(machine));
  });
  test('two machines with the same IP never share their folder', () => {
    expect(storage.machineFolder({ ...machine, id: 8 })).not.toBe(storage.machineFolder(machine));
  });
  test('controller IP remains metadata and never determines the storage path', () => {
    // production: ip_address is empty on every machine, controller_ip is filled by the collector
    const prod = { id: 19, company_id: 4, ip_address: null, controller_ip: '192.168.200.1' };
    expect(storage.machineFolder(prod)).toBe('company-4/programs/machine-19');
  });
  test.each([undefined, null, 0, -1, true, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '../5', '5.1', ''])('invalid ID %p is rejected before choosing a folder', id => {
    expect(() => storage.machineFolder({ ...machine, id })).toThrow(expect.objectContaining({ code: 'BAD_ID' }));
    expect(() => storage.machineFolder({ ...machine, company_id: id })).toThrow(expect.objectContaining({ code: 'BAD_ID' }));
  });
});

test('file stamps are plant time (IST)', () => {
  expect(storage.stamp(new Date('2026-10-05T05:00:12Z'))).toBe('20261005-103012');
});

describe('content checks', () => {
  test('empty, binary and oversized files are refused during streaming', async () => {
    const options = { machine, kind: 'NEW', programName: 'O_INVALID.nc' };
    await expect(save({ ...options, buffer: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'EMPTY' });
    await expect(save({ ...options, buffer: Buffer.from([0x4f, 0x00, 0x31]) })).rejects.toMatchObject({ code: 'NOT_TEXT' });
    await expect(save({ ...options, buffer: Buffer.alloc(1024 * 1024 + 1, 0x41) })).rejects.toMatchObject({ status: 413 });
  });
});

describe('saving', () => {
  const at = new Date('2026-10-05T05:00:12Z');
  const body = Buffer.from('%\nO1234\nG0 X0 Y0\nM30\n%\n');

  test('the file lands in the machine folder with its stamp, kind and name', async () => {
    const saved = await save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: body, at });
    expect(saved).toMatchObject({
      folder: 'company-5/programs/machine-7/uploads', storedName: expect.stringMatching(/^20261005-103012_NEW_[a-f0-9-]+_O1234\.nc$/),
      programName: 'O1234.nc', size: body.length, sha256: storage.sha256(body)
    });
    const onDisk = fs.readFileSync(path.join(storage.ROOT, saved.folder, saved.storedName));
    expect(onDisk.equals(body)).toBe(true);
    // no temporary file left behind
    expect(fs.readdirSync(path.join(storage.ROOT, saved.folder)).filter(f => f.startsWith('.upload-'))).toEqual([]);
  });

  test('a second file in the same second never replaces the first', async () => {
    const first = await save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: body, at });
    const again = await save({ machine, kind: 'NEW', programName: 'O1234.nc', buffer: Buffer.from('G1\n'), at });
    expect(again.storedName).not.toBe(first.storedName);
    expect(await storage.read(first.folder, first.storedName)).toEqual(body);
    expect(await storage.read(again.folder, again.storedName)).toEqual(Buffer.from('G1\n'));
  });

  test('read and remove; removing twice is not an error', async () => {
    const s = await save({ machine, kind: 'BACKUP', programName: 'O9.nc', buffer: Buffer.from('M30\n'), at });
    expect((await storage.read(s.folder, s.storedName)).toString()).toBe('M30\n');
    await storage.remove(s.folder, s.storedName);
    await expect(storage.remove(s.folder, s.storedName)).resolves.toBeUndefined();
  });

  test('nothing outside the root can be opened', () => {
    expect(() => storage.resolveInside('company-5/../../..', 'passwd')).toThrow(/outside/);
    expect(() => storage.open('company-5', '../../../etc/passwd')).toThrow(/outside/);
  });

  test.each([['NEW', 'uploads'], ['BACKUP', 'backups'], ['FETCHED', 'fetched']])('%s has its own purpose directory', async (kind, purpose) => {
    const saved = await save({ machine, kind, programName: 'O_PURPOSE.nc', buffer: body, at });
    expect(saved.folder).toBe(`${storage.machineFolder(machine)}/${purpose}`);
    expect(saved.folder).not.toContain(machine.ip_address);
  });

  test.each(['../BACKUP', 'UNKNOWN', '', null, undefined, 'toString'])('kind %p is refused without writing files', async kind => {
    await expect(save({ machine, kind, programName: 'O_BAD.nc', buffer: body, at })).rejects.toMatchObject({ code: 'BAD_KIND' });
  });

  test('simultaneous same-name saves preserve every immutable version without temporary files', async () => {
    const buffers = Array.from({ length: 12 }, (_, i) => Buffer.from(`O9999\nG0 X${i}\nM30\n`));
    const saved = await Promise.all(buffers.map(buffer => save({ machine, kind: 'NEW', programName: 'O_CONCURRENT.nc', buffer, at })));
    expect(new Set(saved.map(file => file.storedName)).size).toBe(buffers.length);
    await Promise.all(saved.map(async (file, i) => expect(await storage.read(file.folder, file.storedName)).toEqual(buffers[i])));
    expect(fs.readdirSync(path.join(storage.ROOT, saved[0].folder)).filter(name => name.startsWith('.upload-'))).toEqual([]);
  });

  test('open stays synchronous and retains its open event and missing-file error contract', async () => {
    const saved = await save({ machine, kind: 'NEW', programName: 'O_STREAM.nc', buffer: body, at });
    const stream = storage.open(saved.folder, saved.storedName);
    expect(stream).not.toBeInstanceOf(Promise);
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(body);
    const absent = storage.open(saved.folder, 'missing.nc');
    await expect(new Promise((resolve, reject) => { absent.once('open', resolve); absent.once('error', reject); })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('historical paths and filesystem boundaries', () => {
  test.each(['company-5/192.168.200.3', 'company-5/machine-7', 'company-5/fe80--1'])('legacy history %s stays at the old root and can be read/opened/removed', async folder => {
    const dir = path.join(storage.LEGACY_ROOT, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'history.nc'), 'OLD\n');
    expect(storage.resolveInside(folder, 'history.nc')).toBe(path.join(dir, 'history.nc'));
    expect(await storage.read(folder, 'history.nc')).toEqual(Buffer.from('OLD\n'));
    const chunks = [];
    for await (const chunk of storage.open(folder, 'history.nc')) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('OLD\n');
    await storage.remove(folder, 'history.nc');
    await expect(storage.remove(folder, 'history.nc')).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'history.nc'))).toBe(false);
  });

  test('new paths do not fall back to the legacy root when the new file is missing', async () => {
    const folder = 'company-5/programs/machine-900/uploads';
    const legacyCopy = path.join(storage.LEGACY_ROOT, folder);
    fs.mkdirSync(legacyCopy, { recursive: true });
    fs.writeFileSync(path.join(legacyCopy, 'missing.nc'), 'WRONG ROOT\n');
    await expect(storage.read(folder, 'missing.nc')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each(['../outside', '/etc', 'company-5/192.168.1.1/../../outside', 'company-5\\machine-7', 'company-5/programs/machine-7/unknown'])('folder traversal or unsupported shape %s is rejected', folder => {
    expect(() => storage.resolveInside(folder, 'O1.nc')).toThrow(expect.objectContaining({ code: 'BAD_PATH' }));
  });

  test.each(['../outside.nc', '/etc/passwd', 'a/b.nc', 'a\\b.nc'])('stored name traversal %s is rejected', name => {
    expect(() => storage.resolveInside('company-5/programs/machine-7/uploads', name)).toThrow(expect.objectContaining({ code: 'BAD_PATH' }));
  });

  test('directory symlinks cannot redirect save, read, open or remove outside storage', async () => {
    const outside = path.join(ROOT, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(outside, 'uploads'));
    fs.writeFileSync(path.join(outside, 'uploads', 'secret.nc'), 'UNCHANGED\n');
    fs.symlinkSync(outside, path.join(storage.ROOT, 'company-5/programs/machine-22'), 'dir');
    const folder = 'company-5/programs/machine-22/uploads';
    await expect(save({ machine: { ...machine, id: 22 }, kind: 'NEW', programName: 'secret.nc', buffer: Buffer.from('M30') })).rejects.toMatchObject({ code: 'BAD_PATH' });
    await expect(storage.read(folder, 'secret.nc')).rejects.toMatchObject({ code: 'BAD_PATH' });
    expect(() => storage.open(folder, 'secret.nc')).toThrow(expect.objectContaining({ code: 'BAD_PATH' }));
    await expect(storage.remove(folder, 'secret.nc')).rejects.toMatchObject({ code: 'BAD_PATH' });
    expect(fs.readFileSync(path.join(outside, 'uploads', 'secret.nc'), 'utf8')).toBe('UNCHANGED\n');
  });

  test('a file symlink never reads or deletes its target', async () => {
    const folder = 'company-5/programs/machine-7/uploads';
    const outside = path.join(ROOT, 'secret.nc');
    fs.writeFileSync(outside, 'UNCHANGED\n');
    fs.symlinkSync(outside, path.join(storage.ROOT, folder, 'linked.nc'));
    await expect(storage.read(folder, 'linked.nc')).rejects.toThrow();
    expect(() => storage.open(folder, 'linked.nc')).toThrow();
    await expect(storage.remove(folder, 'linked.nc')).rejects.toMatchObject({ code: 'BAD_PATH' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('UNCHANGED\n');
  });

  test('legacy history also rejects a symlinked machine directory', async () => {
    const outside = path.join(ROOT, 'legacy-outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.nc'), 'UNCHANGED\n');
    const folder = 'company-5/192.168.200.9';
    fs.symlinkSync(outside, path.join(storage.LEGACY_ROOT, folder), 'dir');
    await expect(storage.read(folder, 'secret.nc')).rejects.toMatchObject({ code: 'BAD_PATH' });
    expect(() => storage.open(folder, 'secret.nc')).toThrow(expect.objectContaining({ code: 'BAD_PATH' }));
    await expect(storage.remove(folder, 'secret.nc')).rejects.toMatchObject({ code: 'BAD_PATH' });
    expect(fs.readFileSync(path.join(outside, 'secret.nc'), 'utf8')).toBe('UNCHANGED\n');
  });
});
