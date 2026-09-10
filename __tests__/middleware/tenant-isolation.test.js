/*
 * Multi-tenant isolation guard.
 *
 * Controllers build service arguments by combining the authenticated
 * user's identity with the request. If the client-supplied spread comes
 * LAST it wins, and a caller can put company_id (or entered_by /
 * created_by / logged_by) in the body and have it honoured — writing
 * into, and reading from, another tenant.
 *
 * That regressed once and was exploitable: authenticated as user 4, a
 * downtime event posted with entered_by: 2 was stored as 2.
 *
 * The agreement requires "multi-tenant data isolation ... ensuring each
 * company can access only its own data", so this is asserted as source
 * structure rather than left to review.
 */
const fs = require('fs');
const path = require('path');

const CONTROLLER_DIR = path.join(__dirname, '..', '..', 'src');

/** Every *.controller.js under src/ */
function controllerFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.js') ? [full] : [];
  });
}

describe('multi-tenant isolation', () => {
  const files = controllerFiles(CONTROLLER_DIR);

  test('finds controllers to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files.map(f => [path.relative(CONTROLLER_DIR, f), f]))(
    '%s never lets the request body override identity',
    (_name, file) => {
      const src = fs.readFileSync(file, 'utf8');

      // A trusted key taken from req.user, followed later in the same
      // object literal by a spread of req.body / req.query.
      const unsafe = /\{[^{}]*\breq\.user\.[a-zA-Z_]+[^{}]*\.\.\.\s*req\.(body|query)[^{}]*\}/g;
      const hits = src.match(unsafe) || [];

      expect(hits).toEqual([]);
    }
  );
});
