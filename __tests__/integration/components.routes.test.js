/*
 * HTTP-level integration tests for /api/components.
 * Mocks DB + auth so we exercise the real route + controller + service +
 * validation pipeline end-to-end.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { buildApp, fakeUser } = require('../helpers/testApp');

beforeEach(() => resetDb());

function appWithUser(user = fakeUser()) {
  // Stub the auth middleware to inject our fake user without needing a JWT
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () =>
    (req, _res, next) => { req.user = user; next(); });
  jest.doMock('../../src/db', () => mockDb);
  const router = require('../../src/component/component.routes');
  return buildApp({ mountPath: '/api/components', router });
}

describe('GET /api/components', () => {
  test('returns paginated list', async () => {
    mockDb.queueResponse(
      { rows: [{ total: '1' }] },
      { rows: [{ id: 1, part_name: 'X', machine_serial_no: 'M1' }] }
    );

    const res = await request(appWithUser()).get('/api/components?page=1&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  test('passes search filter to DB', async () => {
    mockDb.queueResponse(
      { rows: [{ total: '0' }] },
      { rows: [] }
    );

    await request(appWithUser()).get('/api/components?search=foo');
    expect(mockDb.calls()[0].text).toMatch(/ILIKE/);
  });
});

describe('POST /api/components', () => {
  test('400 when required fields missing (validate middleware)', async () => {
    const res = await request(appWithUser())
      .post('/api/components')
      .send({});
    expect(res.status).toBe(400);
  });

  test('happy path inserts and cascades', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 9, target: 50, part_name: 'X' }], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    const res = await request(appWithUser())
      .post('/api/components')
      .send({
        machine_id: 1, part_name: 'X', part_number: 'PN',
        operation_number: 'OP', cycle_time: '00:01:00', target: 50,
        multiplication_factor: 1
      });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(9);
    expect(mockDb.calls()).toHaveLength(2);
  });
});

describe('DELETE /api/components/:id', () => {
  test('deletes scoped to company_id', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 });
    const res = await request(appWithUser()).delete('/api/components/9');
    expect(res.status).toBe(200);
    expect(mockDb.calls()[0].params).toEqual(['9', 4]);   // route param is a string
  });
});
