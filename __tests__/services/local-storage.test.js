const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../src/files/local-storage');

let temporary;
let store;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-private-files-'));
  store = createStore(path.join(temporary, 'storage'));
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('concurrent writes cannot replace an existing file, including across companies', async () => {
  const results = await Promise.allSettled([
    store.write('company-1/images/machines', 'machine.png', Buffer.from('first')),
    store.write('company-1/images/machines', 'machine.png', Buffer.from('second'))
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.code).toBe('EEXIST');
  const saved = (await store.read('company-1/images/machines', 'machine.png')).toString();
  expect(['first', 'second']).toContain(saved);
  await store.write('company-2/images/machines', 'machine.png', Buffer.from('other company'));
  expect((await store.read('company-2/images/machines', 'machine.png')).toString()).toBe('other company');
  expect(fs.readdirSync(path.join(store.ROOT, 'company-1/images/machines'))).toEqual(['machine.png']);
  expect(fs.statSync(path.join(store.ROOT, 'company-1/images/machines/machine.png')).mode & 0o777).toBe(0o640);
});

test.each(['../outside', '/etc', 'company-1/../../outside', 'company-1\\outside', 'company-1//images'])('rejects unsafe directories: %s', async folder => {
  await expect(store.write(folder, 'file.png', Buffer.from('no'))).rejects.toMatchObject({ code: 'BAD_PATH' });
  expect(() => store.resolveInside(folder, 'file.png')).toThrow('Invalid storage path');
});

test.each(['../secret', '/secret', 'a/b.png', 'a\\b.png', '.', '..', 'file\u0000.png'])('rejects unsafe filenames: %s', async name => {
  await expect(store.write('company-1/images', name, Buffer.from('no'))).rejects.toMatchObject({ code: 'BAD_PATH' });
});

test('symlinked directories and files cannot expose or overwrite files outside storage', async () => {
  await store.ensureDirectory('company-1/images');
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  const secret = path.join(outside, 'secret.png');
  fs.writeFileSync(secret, 'private');
  fs.symlinkSync(outside, path.join(store.ROOT, 'company-1/images/link'));
  await expect(store.write('company-1/images/link', 'new.png', Buffer.from('no'))).rejects.toMatchObject({ code: 'BAD_PATH' });
  await expect(store.open('company-1/images/link', 'secret.png')).rejects.toMatchObject({ code: 'BAD_PATH' });
  fs.symlinkSync(secret, path.join(store.ROOT, 'company-1/images/secret.png'));
  await expect(store.open('company-1/images', 'secret.png')).rejects.toBeDefined();
  await expect(store.remove('company-1/images', 'secret.png')).rejects.toMatchObject({ code: 'BAD_PATH' });
  expect(fs.readFileSync(secret, 'utf8')).toBe('private');
  expect(fs.readdirSync(outside)).toEqual(['secret.png']);
});

test('streams close cleanly and deleting an absent file is safe', async () => {
  await store.write('company-1/programs', 'O1.nc', Buffer.from('M30\n'));
  const opened = await store.open('company-1/programs', 'O1.nc');
  expect(opened.size).toBe(4);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('M30\n');
  const syncStream = store.openSync('company-1/programs', 'O1.nc');
  for await (const chunk of syncStream) expect(chunk.toString()).toBe('M30\n');
  await store.remove('company-1/programs', 'O1.nc');
  await expect(store.remove('company-1/programs', 'O1.nc')).resolves.toBeUndefined();
  await expect(store.open('company-1/programs', 'O1.nc')).rejects.toMatchObject({ code: 'ENOENT' });
});
