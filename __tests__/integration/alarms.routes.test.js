/*
 * /api/alarms — who may list and resolve, and the list's filters.
 *
 * Every alarm route used to check only that the caller was signed in, so any
 * role could list and resolve alarms through the API (the mobile app offered
 * Resolve to everyone) and any user could change the company's alert
 * settings. They now take the Alarms page's own keys: page:alarms:view to
 * list, page:alarms:resolve to resolve; the alert settings are the company
 * admin's.
 */
const request = require('supertest');
const { buildApp, fakeUser } = require('../helpers/testApp');

let mockDb;
function makeApp(user) {
  jest.resetModules();
  mockDb = require('../helpers/mockDb').mockDb;
  require('../helpers/mockDb').resetDb();
  jest.doMock('../../src/db', () => mockDb);
  jest.doMock('../../src/redis', () => ({ get: async () => null, set: async () => 'OK', del: async () => 1 }));
  jest.doMock('../../src/middleware/auth.middleware', () => (req, _res, next) => { req.user = user; next(); });
  const router = require('../../src/alarms/alarm.routes');
  return buildApp({ mountPath: '/api/alarms', router });
}

const supervisor = (permissions) => fakeUser({ roles: ['SUPERVISOR'], user_type: 'company_user', permissions });
const admin = () => fakeUser({ roles: ['COMPANY_ADMIN'], user_type: 'company_user', permissions: [] });
const grants = (keys = []) => ({ rows: keys.map(k => ({ permission_key: k })) });
const listReplies = () => [{ rows: [{ count: '0' }] }, { rows: [] }];

describe('who may list alarms', () => {
  test('a role without page:alarms:view is refused, and nothing is read', async () => {
    const app = makeApp(supervisor(['page:dashboard:view']));
    const res = await request(app).get('/api/alarms');
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('page:alarms:view');
    expect(mockDb.calls().some(c => /machine_alarms/.test(c.text))).toBe(false);
  });

  test('a role holding it may list', async () => {
    const app = makeApp(supervisor(['page:alarms:view']));
    mockDb.queueResponse(grants(), ...listReplies());
    const res = await request(app).get('/api/alarms');
    expect(res.status).toBe(200);
  });

  test('the company admin may list', async () => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(), ...listReplies());
    expect((await request(app).get('/api/alarms')).status).toBe(200);
  });
});

describe('who may resolve', () => {
  test('viewing is not resolving: a role with view only is refused, nothing written', async () => {
    const app = makeApp(supervisor(['page:alarms:view']));
    const res = await request(app).patch('/api/alarms/7/resolve').send({});
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('page:alarms:resolve');
    expect(mockDb.calls().some(c => /UPDATE machine_alarms/.test(c.text))).toBe(false);
  });

  test('a role with page:alarms:resolve may, within its own company', async () => {
    const app = makeApp(supervisor(['page:alarms:view', 'page:alarms:resolve']));
    mockDb.queueResponse(grants(), { rows: [{ id: 7 }], rowCount: 1 });
    const res = await request(app).patch('/api/alarms/7/resolve').send({ resolution_note: 'air restored' });
    expect(res.status).toBe(200);
    const upd = mockDb.calls().find(c => /UPDATE machine_alarms/.test(c.text));
    expect(upd.text).toMatch(/WHERE id = \$3 AND company_id = \$4/);
    expect(upd.params[3]).toBe(4);
  });

  test('a company not granted resolve is refused even for its admin', async () => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(['page:alarms:view']));
    expect((await request(app).patch('/api/alarms/7/resolve').send({})).status).toBe(403);
  });
});

describe('the alert settings are the company admin\'s', () => {
  test('another role cannot read or change them', async () => {
    const app = makeApp(supervisor(['page:alarms:view', 'page:alarms:resolve']));
    expect((await request(app).get('/api/alarms/preferences')).status).toBe(403);
    expect((await request(app).put('/api/alarms/preferences').send({ email_enabled: false })).status).toBe(403);
    expect(mockDb.calls().some(c => /alert_preferences/.test(c.text))).toBe(false);
  });
});

describe('the list', () => {
  const run = async (query) => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(), ...listReplies());
    const res = await request(app).get('/api/alarms').query(query);
    const count = mockDb.calls().find(c => /SELECT COUNT\(\*\) FROM machine_alarms/.test(c.text));
    const page = mockDb.calls().find(c => /LIMIT \$\d+ OFFSET/.test(c.text));
    return { res, count, page };
  };

  test('active=true is "not cleared by the controller yet"', async () => {
    const { res, count } = await run({ active: 'true', is_resolved: 'false' });
    expect(res.status).toBe(200);
    expect(count.text).toMatch(/a\.ended_at IS NULL/);
    expect(count.text).toMatch(/a\.is_resolved = \$2/);
  });

  test('severity CRITICAL and NORMAL (anything not critical)', async () => {
    expect((await run({ severity: 'CRITICAL' })).count.text).toMatch(/UPPER\(a\.severity\) = 'CRITICAL'/);
    expect((await run({ severity: 'normal' })).count.text).toMatch(/UPPER\(a\.severity\) <> 'CRITICAL'/);
  });

  test('active alarms come first, then newest', async () => {
    const { page } = await run({});
    expect(page.text).toMatch(/ORDER BY \(a\.ended_at IS NULL\) DESC, a\.started_at DESC/);
  });

  test.each([
    [{ page: 'abc' }, 'page must be a positive whole number'],
    [{ machine_id: 'x' }, 'machine_id must be a positive whole number'],
    [{ active: 'maybe' }, 'active must be true or false'],
    [{ severity: 'LOW' }, 'severity must be CRITICAL or NORMAL'],
  ])('%j is a 400, not a 500', async (query, message) => {
    const { res } = await run(query);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
  });

  test('every query binds exactly the parameters it references', async () => {
    const highest = sql => Math.max(0, ...[...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    const { count, page } = await run({ machine_id: 3, is_resolved: 'false', active: 'true', severity: 'CRITICAL', page: 2, limit: 5 });
    expect(count.params.length).toBe(highest(count.text));
    expect(page.params.length).toBe(highest(page.text));
    expect(page.params.slice(-2)).toEqual([5, 5]);   // limit 5, offset 5
  });
});
