const request = require('supertest');
const { buildApp, fakeUser } = require('../helpers/testApp');
let mockDb;
const mockRules = { getPolicy: jest.fn(), updatePolicy: jest.fn() };
function makeApp(user) {
  jest.resetModules(); mockDb = require('../helpers/mockDb').mockDb; require('../helpers/mockDb').resetDb();
  jest.doMock('../../src/db', () => mockDb);
  jest.doMock('../../src/redis', () => ({ get: async () => null, set: async () => 'OK', del: async () => 1 }));
  jest.doMock('../../src/alarms/alarm-notification.service', () => mockRules);
  jest.doMock('../../src/middleware/auth.middleware', () => (req, _res, next) => { req.user = user; next(); });
  return buildApp({ mountPath: '/api/alarms', router: require('../../src/alarms/alarm.routes') });
}
const admin = extra => fakeUser({ roles: ['COMPANY_ADMIN'], user_type: 'company_user', permissions: [], ...extra });
const grants = keys => ({ rows: keys.map(permission_key => ({ permission_key })) });
beforeEach(() => { Object.values(mockRules).forEach(mock => mock.mockReset()); });
describe('company-admin critical alert API', () => {
  test('ordinary alarm viewers cannot manage company alert settings', async () => {
    const app = makeApp(fakeUser({ roles: ['SUPERVISOR'], permissions: ['page:alarms:view'] }));
    for (const method of ['get','put']) expect((await request(app)[method]('/api/alarms/notification-policy').send({ enabled: true, expected_version: 0 })).status).toBe(403);
    expect(mockDb.calls()).toHaveLength(0); expect(mockRules.getPolicy).not.toHaveBeenCalled(); expect(mockRules.updatePolicy).not.toHaveBeenCalled();
  });
  test('company page revocation denies even an administrator', async () => {
    const app = makeApp(admin()); mockDb.queueResponse(grants(['page:programs:view']));
    const result = await request(app).get('/api/alarms/notification-policy');
    expect(result.status).toBe(403); expect(result.body.code).toBe('NOT_IN_PLAN'); expect(mockRules.getPolicy).not.toHaveBeenCalled();
  });
  test.each(['page:alarms:view','page:analytics-alarms:view','page:dashboard:view'])(
    'the current %s grant permits reads', async key => {
      const user = admin(); const app = makeApp(user); mockDb.queueResponse(grants([key]));
      mockRules.getPolicy.mockResolvedValue({ enabled: false, configured: false, version: 0, updated_at: null, counts: { machines: 20 } });
      const result = await request(app).get('/api/alarms/notification-policy').query({ company_id: 99 });
      expect(result.status).toBe(200); expect(result.body.data.enabled).toBe(false); expect(result.body.data.configured).toBe(false);
      expect(mockRules.getPolicy).toHaveBeenCalledWith(user);
    });
  test('writes receive the authenticated account and exact optimistic values', async () => {
    const user = admin(); const app = makeApp(user); mockDb.queueResponse(grants(['page:alarms:view']));
    mockRules.updatePolicy.mockResolvedValue({ enabled: true, configured: true, version: 1, counts: { machines: 20 } });
    const body = { enabled: true, expected_version: 0, company_id: 99 };
    expect((await request(app).put('/api/alarms/notification-policy').send(body)).body.data.enabled).toBe(true);
    expect(mockRules.updatePolicy).toHaveBeenCalledWith(user, body);
  });
  test('optimistic conflicts remain a clear 409', async () => {
    const app = makeApp(admin()); mockDb.queueResponse(grants(['page:alarms:view']));
    mockRules.updatePolicy.mockRejectedValue(Object.assign(new Error('Reload before saving'), { status: 409 }));
    const result = await request(app).put('/api/alarms/notification-policy').send({ enabled: true, expected_version: 0 });
    expect(result.status).toBe(409); expect(result.body.message).toBe('Reload before saving');
  });
  test('old delay routes give a clear 410 instead of silently accepting inactive controls', async () => {
    const app = makeApp(admin()); mockDb.queueResponse(grants(['page:alarms:view']), grants(['page:alarms:view']));
    const read = await request(app).get('/api/alarms/notification-rules');
    const write = await request(app).put('/api/alarms/notification-rules/7').send({ enabled: true, delay_seconds: 30 });
    expect(read.status).toBe(410); expect(write.status).toBe(410); expect(write.body.message).toContain('company critical alert settings');
    expect(mockRules.updatePolicy).not.toHaveBeenCalled();
  });
});
