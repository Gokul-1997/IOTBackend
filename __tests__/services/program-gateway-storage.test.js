const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
let directory, storage, previousRoot;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'program-stream-test-'));
  previousRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = path.join(directory, 'storage');
  jest.resetModules();
  storage = require('../../src/programs/storage');
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.STORAGE_ROOT;else process.env.STORAGE_ROOT = previousRoot;
  fs.rmSync(directory, {
    recursive: true,
    force: true
  });
});
const machine = {
  id: 7,
  company_id: 4
};
function source(bytes) {
  const filename = path.join(directory, 'source.nc');
  fs.writeFileSync(filename, bytes);
  return filename;
}
function files() {
  const root = path.join(directory, 'storage');
  return fs.existsSync(root) ? fs.readdirSync(root, {
    recursive: true
  }).filter(name => fs.statSync(path.join(root, name)).isFile()) : [];
}
test('streams a multi-megabyte NC program into an immutable tenant folder with exact SHA-256', async () => {
  const bytes = Buffer.from('G01 X1.25 Y2.5 F100\n'.repeat(250000));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const saved = await storage.saveStream({
    machine,
    kind: 'NEW',
    programName: 'O1234.nc',
    filename: source(bytes),
    expectedSha256: hash
  });
  expect(saved.size).toBe(bytes.length);
  expect(saved.sha256).toBe(hash);
  expect(saved.folder).toBe('company-4/programs/machine-7/uploads');
  expect(crypto.createHash('sha256').update(fs.readFileSync(storage.resolveInside(saved.folder, saved.storedName))).digest('hex')).toBe(hash);
  expect(files()).toHaveLength(1);
});
test.each([['empty', Buffer.alloc(0), 'EMPTY'], ['binary', Buffer.from([65, 0, 66]), 'NOT_TEXT']])('%s is rejected without a visible file', async (_name, bytes, code) => {
  await expect(storage.saveStream({
    machine,
    kind: 'BACKUP',
    programName: 'O1234.nc',
    filename: source(bytes)
  })).rejects.toMatchObject({
    code
  });
  expect(files()).toEqual([]);
});
test('checksum mismatch never publishes unverified controller bytes', async () => {
  await expect(storage.saveStream({
    machine,
    kind: 'BACKUP',
    programName: 'O1234.nc',
    filename: source('G01 X2\n'),
    expectedSha256: '0'.repeat(64)
  })).rejects.toMatchObject({
    code: 'CHECKSUM_MISMATCH'
  });
  expect(files()).toEqual([]);
});
test('the configured maximum is enforced during streaming', async () => {
  const filename = source(Buffer.alloc(storage.MAX_BYTES + 1, 65));
  await expect(storage.saveStream({
    machine,
    kind: 'NEW',
    programName: 'O1234.nc',
    filename
  })).rejects.toMatchObject({
    code: 'TOO_LARGE'
  });
  expect(files()).toEqual([]);
});
test('a destination directory failure closes the staging stream before returning', async () => {
  const local = require('../../src/files/local-storage');
  const original = fs.createReadStream;
  let input;
  const open = jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => (input = original(...args)));
  const write = jest.spyOn(local, 'writeStream').mockRejectedValue(new Error('storage directory unavailable'));
  try {
    await expect(storage.saveStream({ machine, kind: 'NEW', programName: 'O1234.nc', filename: source('G01 X2\n') }))
      .rejects.toThrow('storage directory unavailable');
    expect(input.destroyed).toBe(true);
    await new Promise(resolve => input.once('close', resolve));
    expect(files()).toEqual([]);
  } finally { open.mockRestore(); write.mockRestore(); }
});
