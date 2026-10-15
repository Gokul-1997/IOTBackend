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
  return buildApp({ mountPath: '/api/alarms', router: require('../../src/alarms/alarm.routes') });
}
const admin = extra => fakeUser({ roles: ['COMPANY_ADMIN'], user_type: 'company_user', permissions: [], ...extra });
const grants = keys => ({ rows: keys.map(permission_key => ({ permission_key })) });

describe('company-admin sustained-alarm configuration', () => {
  test('a normal alarm viewer cannot read or change company machine rules', async () => {
    const app = makeApp(fakeUser({ roles: ['SUPERVISOR'], permissions: ['page:alarms:view'] }));
    expect((await request(app).get('/api/alarms/notification-rules')).status).toBe(403);
    expect((await request(app).put('/api/alarms/notification-rules/7').send({ enabled: true, delay_seconds: 30 })).status).toBe(403);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('the company must currently hold at least one alarm-capable page', async () => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(['page:programs:view']));
    const result = await request(app).get('/api/alarms/notification-rules');
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('NOT_IN_PLAN');
    expect(mockDb.calls().some(call => /alarm_notification_rules/.test(call.text))).toBe(false);
  });

  test.each(['page:alarms:view', 'page:analytics-alarms:view', 'page:dashboard:view'])(
    'an administrator can configure with the currently permitted %s page', async key => {
      const app = makeApp(admin());
      mockDb.queueResponse(grants([key]), { rows: [{ total: 1 }] }, {
        rows: [{ machine_id: 7, machine_serial_no: 'VMC-7', plant_name: 'Plant A', enabled: false, delay_seconds: 600 }]
      });
      const result = await request(app).get('/api/alarms/notification-rules').query({ company_id: 99, page: 1, limit: 20 });
      expect(result.status).toBe(200);
      expect(result.body.data[0].delay_seconds).toBe(600);
      expect(result.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
      const scoped = mockDb.calls().filter(call => /FROM machines m/.test(call.text));
      expect(scoped).toHaveLength(2);
      for (const query of scoped) expect(query.params[0]).toBe(4);
    }
  );

  test('a platform administrator cannot invent a company policy', async () => {
    const app = makeApp(admin({ is_snt_super: true, company_id: null }));
    expect((await request(app).get('/api/alarms/notification-rules').query({ company_id: 4 })).status).toBe(403);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('invalid duration is a 400 and no machine is queried or changed', async () => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(['page:dashboard:view']));
    const result = await request(app).put('/api/alarms/notification-rules/7').send({ enabled: true, delay_seconds: '30' });
    expect(result.status).toBe(400);
    expect(mockDb.calls().some(call => /FROM machines m|INSERT INTO/.test(call.text))).toBe(false);
  });

  test('the write endpoint saves only the authenticated company and selected machine', async () => {
    const app = makeApp(admin());
    mockDb.queueResponse(grants(['page:dashboard:view']), { rows: [] },
      { rows: [{ id: 7, machine_serial_no: 'VMC-7', plant_name: 'Plant A' }] },
      { rows: [{ enabled: true, delay_seconds: 30 }] }, { rows: [] });
    const result = await request(app).put('/api/alarms/notification-rules/7')
      .send({ enabled: true, delay_seconds: 30, company_id: 99, machine_id: 88 });
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ machine_id: 7, machine_serial_no: 'VMC-7', plant_name: 'Plant A', enabled: true, delay_seconds: 30 });
    const write = mockDb.calls().find(call => /INSERT INTO alarm_notification_rules/.test(call.text));
    expect(write.params.slice(0, 4)).toEqual([4, 7, true, 30]);
  });
});
