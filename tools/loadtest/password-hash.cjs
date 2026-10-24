/* Compare the retired bcryptjs implementation with the existing native bcrypt.
 * Usage: node tools/loadtest/password-hash.cjs /tmp/bcryptjs/package/umd/index.js
 * Uses fixture passwords only; no configuration or application service loads. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const bcrypt = require('bcrypt');
if (!process.argv[2]) throw new Error('Pass the extracted bcryptjs@3.0.3 CommonJS entry path');
const legacy = require(path.resolve(process.argv[2]));
const password = 'local-benchmark-only', parallel = 20, cost = 10;
(async () => {
  const oldHash = await legacy.hash(password, cost);
  const newHash = await bcrypt.hash(password, cost);
  assert.equal(await bcrypt.compare(password, oldHash), true);
  assert.equal(await legacy.compare(password, newHash), true);
  const results = {};
  for (const [name, implementation] of [['bcryptjs', legacy], ['bcrypt', bcrypt]]) {
    const start = performance.now();
    await Promise.all(Array.from({ length: parallel }, () => implementation.hash(password, cost)));
    results[name] = { elapsed_ms: Math.round(performance.now() - start) };
  }
  console.log(JSON.stringify({ fixture: 'same host, fixture passwords, one sequential comparison; no API/DB; not a login SLA',
    node: process.version, cost, parallel, compatible_old_and_new_hashes: true, results }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
