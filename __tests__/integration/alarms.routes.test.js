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
    expect(upd.text).toMatch(/WHERE a.id = \$3 AND a.company_id = \$4/);
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
    const summary = mockDb.calls().find(c => /AS still_on/.test(c.text));
    expect(count.params.length).toBe(highest(count.text));
    expect(page.params.length).toBe(highest(page.text));
    expect(summary.params.length).toBe(highest(summary.text));
    expect(page.params.slice(-2)).toEqual([5, 5]);   // limit 5, offset 5
  });

  test('each row says which ticket was raised from it, and its status, within the company', async () => {
    const { page } = await run({});
    expect(page.text).toMatch(/SELECT t\.id, t\.status FROM maintenance_tickets t\s+WHERE t\.alarm_id = a\.id AND t\.company_id = a\.company_id/);
    expect(page.text).toMatch(/tk\.id AS ticket_id, tk\.status AS ticket_status/);
  });

  test('the summary counts the same alarms with every filter but severity, for the All | Critical | Non-critical switch', async () => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(), { rows: [{ count: '4' }] }, { rows: [] },
      { rows: [{ total: 23, critical: 4, still_on: 15, machines: 9 }] });
    const res = await request(app).get('/api/alarms').query({ machine_id: 3, is_resolved: 'false', severity: 'CRITICAL' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 23, critical: 4, still_on: 15, machines: 9 });
    expect(res.body.pagination.total).toBe(4);
    const count = mockDb.calls().find(c => /SELECT COUNT\(\*\) FROM machine_alarms/.test(c.text));
    const summary = mockDb.calls().find(c => /AS still_on/.test(c.text));
    const summaryWhere = summary.text.split('FROM machine_alarms a')[1];
    expect(summaryWhere).toMatch(/a\.company_id = \$1 AND a\.machine_id = \$2 AND a\.is_resolved = \$3/);
    expect(summaryWhere).not.toMatch(/severity/);                 // the switch's counts stay put while it filters
    expect(count.text).toMatch(/UPPER\(a\.severity\) = 'CRITICAL'/);
    expect(summary.params).toEqual(count.params);
  });

  test('the header: sort any column (machines in natural order), filter severity and status, search the text', async () => {
    const { count, page } = await run({ sort: 'machine', dir: 'desc', f_severity: 'CRITICAL', f_status: 'on,cleared', q_alarm: 'atc' });
    expect(page.text).toMatch(/ORDER BY CASE WHEN upper\(btrim\(coalesce\(m\.machine_serial_no/);
    expect(page.text).toMatch(/a\.started_at DESC, a\.id DESC\s+LIMIT/);
    expect(count.text).toMatch(/CASE WHEN a\.is_resolved THEN 'resolved' WHEN a\.ended_at IS NULL THEN 'on' ELSE 'cleared' END\)::text = ANY\(\$2::text\[\]\)/);
    expect(count.text).toMatch(/ILIKE \$3/);
    expect(count.text).toMatch(/CASE WHEN UPPER\(a\.severity\) = 'CRITICAL' THEN 'CRITICAL' ELSE 'NORMAL' END\)::text = ANY\(\$4::text\[\]\)/);
    expect(count.params.slice(1)).toEqual([['on', 'cleared'], '%atc%', ['CRITICAL']]);
    // the switch's counts: the header's filters, but not severity — and no parameter it does not use
    const summary = mockDb.calls().find(c => /AS still_on/.test(c.text));
    expect(summary.text).toMatch(/ILIKE \$3/);
    expect(summary.text.split('FROM machine_alarms a')[1]).not.toMatch(/ELSE 'NORMAL' END\)::text = ANY/);
    expect(summary.params).toEqual(count.params.slice(0, 3));
  });

  test('a sort that is not a column is ignored: the usual order', async () => {
    const { page } = await run({ sort: 'password', dir: 'asc' });
    expect(page.text).toMatch(/ORDER BY \(a\.ended_at IS NULL\) DESC, a\.started_at DESC, a\.id DESC/);
  });

  test('an old database answer without a summary row gives zeros, not an error', async () => {
    const { res } = await run({});
    expect(res.body.summary).toEqual({ total: 0, critical: 0, still_on: 0, machines: 0 });
  });
});
