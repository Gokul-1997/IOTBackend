const { hash, compare } = require('../../src/utils/password');

describe('password utils', () => {
  test('hash returns a non-trivial string', async () => {
    const h = await hash('my-secret');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(20);
    expect(h).not.toContain('my-secret');
  });

  test('compare returns true for matching password', async () => {
    const h = await hash('correct-horse');
    expect(await compare('correct-horse', h)).toBe(true);
  });

  test('compare returns false for wrong password', async () => {
    const h = await hash('correct-horse');
    expect(await compare('wrong-horse', h)).toBe(false);
  });

  test('two hashes of the same password differ (salted)', async () => {
    const a = await hash('same');
    const b = await hash('same');
    expect(a).not.toBe(b);
  });
});
