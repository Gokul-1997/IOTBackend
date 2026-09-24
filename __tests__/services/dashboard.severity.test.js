/*
 * The severity classes the agreement names (Critical, Non-Critical,
 * Information) for Screens 1, 2 and 3. Checked by running the CASE the way
 * Postgres would for each word, because the bug was a word falling through:
 * NORMAL — what the controllers actually send — was reported as Information.
 */
const { severityClass } = require('../../src/dashboard/severity');

/** Evaluate the generated CASE for one value, as Postgres would. */
function classify(value) {
  const sql = severityClass('x');
  const v = String(value).toUpperCase();
  for (const m of sql.matchAll(/WHEN UPPER\(x\) IN \(([^)]*)\)\s+THEN '(\w+)'/g)) {
    const words = m[1].split(',').map(w => w.trim().replace(/'/g, ''));
    if (words.includes(v)) return m[2];
  }
  return /ELSE '(\w+)'/.exec(sql)[1];
}

test.each([
  ['CRITICAL', 'CRITICAL'], ['critical', 'CRITICAL'], ['FATAL', 'CRITICAL'],
  ['NORMAL', 'NON_CRITICAL'], ['normal', 'NON_CRITICAL'], ['WARNING', 'NON_CRITICAL'],
  ['HIGH', 'NON_CRITICAL'], ['MEDIUM', 'NON_CRITICAL'],
  ['INFORMATION', 'INFORMATION'], ['INFO', 'INFORMATION'], ['LOW', 'INFORMATION'],
  ['SOMETHING_NEW', 'NON_CRITICAL']
])('%s is %s', (value, expected) => {
  expect(classify(value)).toBe(expected);
});

test('the column name is the caller\'s', () => {
  expect(severityClass('a.severity')).toMatch(/UPPER\(a\.severity\)/);
});

test('factory, maintenance and preventive all use this one definition', () => {
  const fs = require('fs');
  for (const f of ['factory', 'maintenance', 'preventive']) {
    const src = fs.readFileSync(require.resolve(`../../src/dashboard/${f}.service`), 'utf8');
    expect(src).toMatch(/const SEVERITY_CLASS = severityClass\(/);
    expect(src).not.toMatch(/WHEN severity IN \('HIGH','MEDIUM'\)/);
  }
});
