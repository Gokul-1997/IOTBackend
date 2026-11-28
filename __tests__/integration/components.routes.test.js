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
  jest.doMock('../../src/redis', () => ({ get: jest.fn(async () => '[]'), set: jest.fn() }));
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
      { rows: [], rowCount: 0 },                                    // BEGIN
      { rows: [{ id: 1, plant_id: 8 }], rowCount: 1 },              // the machine, locked
      { rows: [], rowCount: 0 },                                    // not on it yet
      { rows: [{ id: 9, machine_id: 1, target: 50, part_name: 'X' }], rowCount: 1 },
      { rows: [], rowCount: 0 },                                    // no job running
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
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });

  // 28 Nov 2026: one part on many machines
  const body = { part_name: 'Flange Housing', part_number: 'PN-4471', operation_number: 'OP-10', cycle_time: '00:01:30', target: 250, multiplication_factor: 1 };

  test('machine_ids: one component per machine, the list back', async () => {
    mockDb.queueResponse(
      { rows: [] }, { rows: [{ id: 1, plant_id: 8 }, { id: 2, plant_id: 8 }] }, { rows: [] },
      { rows: [{ id: 9, machine_id: 1 }, { id: 10, machine_id: 2 }] }, { rows: [] }, { rows: [] }
    );
    const res = await request(appWithUser()).post('/api/components').send({ ...body, machine_ids: [2, 1] });
    expect(res.status).toBe(200);
    expect(res.body.data.map(c => c.id)).toEqual([9, 10]);
    expect(mockDb.calls()[1].params[0]).toEqual([1, 2]);
  });

  test('no machine chosen: 400 in words; the same part already there: 409 naming the machine', async () => {
    let res = await request(appWithUser()).post('/api/components').send({ ...body, machine_ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Choose at least one machine');

    resetDb();
    mockDb.queueResponse({ rows: [] }, { rows: [{ id: 1, plant_id: 8 }] }, { rows: [{ machine_serial_no: 'VMC - 1 - F' }] });
    res = await request(appWithUser()).post('/api/components').send({ ...body, machine_ids: [1] });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('VMC - 1 - F already has Flange Housing (PN-4471 · OP-10) — edit that one, or leave that machine out.');
  });
});

describe('DELETE /api/components/:id', () => {
  test('deletes scoped to company_id', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 });
    const res = await request(appWithUser()).delete('/api/components/9');
    expect(res.status).toBe(200);
    expect(mockDb.calls()[0].params).toEqual(['9', 4, 1]);   // route param is a string
  });
});
