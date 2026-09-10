/*
 * HTTP integration tests for /api/jobs
 *
 * Exercises the full middleware stack:
 *   auth middleware → validate middleware → controller → service → DB
 *
 * Covers:
 *  POST /api/jobs/start
 *    TC-JR-01  400 when machine_id missing
 *    TC-JR-02  400 when component_id missing
 *    TC-JR-03  400 when job_start missing
 *    TC-JR-04  401 when no auth token
 *    TC-JR-05  500 when machine already has active job
 *    TC-JR-06  500 when component not found for machine
 *    TC-JR-07  200 on successful job start
 *
 *  POST /api/jobs/stop
 *    TC-JR-20  400 when machine_id missing
 *    TC-JR-21  401 when no auth token
 *    TC-JR-22  500 when no active job to stop
 *    TC-JR-23  200 on successful job stop
 *
 *  GET /api/jobs/available-machines
 *    TC-JR-30  401 when no auth token
 *    TC-JR-31  200 returns list of machines
 *
 *  GET /api/jobs/current
 *    TC-JR-40  401 when no auth token
 *    TC-JR-41  200 returns current active jobs
 *    TC-JR-42  200 returns empty array when no active jobs
 *
 *  GET /api/jobs/history
 *    TC-JR-50  401 when no auth token
 *    TC-JR-51  200 returns job history
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { buildApp, fakeUser } = require('../helpers/testApp');

beforeEach(() => resetDb());

// ── app factories ─────────────────────────────────────────────────────────────

function makeApp(user = fakeUser()) {
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () =>
    (req, _res, next) => { req.user = user; next(); });
  jest.doMock('../../src/db', () => mockDb);
  const router = require('../../src/job/job.routes');
  return buildApp({ mountPath: '/api/jobs', router });
}

function makeUnauthApp() {
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () =>
    (_req, res) => res.status(401).json({ success: false, message: 'Unauthorized' }));
  jest.doMock('../../src/db', () => mockDb);
  const router = require('../../src/job/job.routes');
  return buildApp({ mountPath: '/api/jobs', router });
}

const VALID_START = {
  machine_id:   1,
  component_id: 2,
  job_start:    '2026-05-01T08:00:00'
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/start
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/start', () => {
  test('TC-JR-01 400 when machine_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/jobs/start')
      .send({ component_id: 2, job_start: '2026-05-01T08:00:00' });
    expect(res.status).toBe(400);
  });

  test('TC-JR-02 400 when component_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/jobs/start')
      .send({ machine_id: 1, job_start: '2026-05-01T08:00:00' });
    expect(res.status).toBe(400);
  });

  test('TC-JR-03 400 when job_start missing', async () => {
    const res = await request(makeApp())
      .post('/api/jobs/start')
      .send({ machine_id: 1, component_id: 2 });
    expect(res.status).toBe(400);
  });

  test('TC-JR-04 401 when no auth token', async () => {
    const res = await request(makeUnauthApp())
      .post('/api/jobs/start')
      .send(VALID_START);
    expect(res.status).toBe(401);
  });

  test('TC-JR-05 500 when machine already has an active job', async () => {
    mockDb.queueResponse({
      rows: [{ id: 99, part_name: 'OldPart' }],
      rowCount: 1
    });

    const res = await request(makeApp())
      .post('/api/jobs/start')
      .send(VALID_START);

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/already has an active job/i);
  });

  test('TC-JR-06 500 when component not found or wrong machine', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }); // no active job
    mockDb.queueResponse({ rows: [], rowCount: 0 }); // component lookup fails

    const res = await request(makeApp())
      .post('/api/jobs/start')
      .send(VALID_START);

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/does not belong to this machine/i);
  });

  test('TC-JR-07 200 on successful job start', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });                        // no active job
    mockDb.queueResponse({ rows: [{ part_name: 'PartA', target: 50 }] });   // component found
    mockDb.queueResponse({ rows: [], rowCount: 1 });                         // INSERT

    const res = await request(makeApp())
      .post('/api/jobs/start')
      .send(VALID_START);

    expect(res.status).toBe(200);
    expect(mockDb.calls()[2].text).toMatch(/INSERT INTO machine_current_job/);
  });

  test('TC-JR-08 DB INSERT uses company_id from authenticated user', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    mockDb.queueResponse({ rows: [{ part_name: 'PartA', target: 50 }] });
    mockDb.queueResponse({ rows: [], rowCount: 1 });

    const user = fakeUser({ company_id: 7 });
    await request(makeApp(user))
      .post('/api/jobs/start')
      .send(VALID_START);

    expect(mockDb.calls()[2].params[0]).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/stop
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/stop', () => {
  test('TC-JR-20 400 when machine_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/jobs/stop')
      .send({});
    expect(res.status).toBe(400);
  });

  test('TC-JR-21 401 when no auth token', async () => {
    const res = await request(makeUnauthApp())
      .post('/api/jobs/stop')
      .send({ machine_id: 1 });
    expect(res.status).toBe(401);
  });

  test('TC-JR-22 500 when no active job to stop', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post('/api/jobs/stop')
      .send({ machine_id: 1 });

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/No active job/i);
  });

  test('TC-JR-23 200 on successful job stop', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, part_name: 'PartA' }], rowCount: 1 });
    mockDb.queueResponse({ rows: [], rowCount: 1 });

    const res = await request(makeApp())
      .post('/api/jobs/stop')
      .send({ machine_id: 1 });

    expect(res.status).toBe(200);
    expect(mockDb.calls()[1].text).toMatch(/UPDATE machine_current_job/);
    expect(mockDb.calls()[1].text).toMatch(/is_active = false/);
  });

  test('TC-JR-24 stop scoped to authenticated user company_id', async () => {
    mockDb.queueResponse({ rows: [{ id: 1, part_name: 'PartA' }], rowCount: 1 });
    mockDb.queueResponse({ rows: [], rowCount: 1 });

    const user = fakeUser({ company_id: 9 });
    await request(makeApp(user))
      .post('/api/jobs/stop')
      .send({ machine_id: 1 });

    expect(mockDb.calls()[0].params[1]).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/available-machines
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/jobs/available-machines', () => {
  test('TC-JR-30 401 when no auth token', async () => {
    const res = await request(makeUnauthApp()).get('/api/jobs/available-machines');
    expect(res.status).toBe(401);
  });

  test('TC-JR-31 200 returns list of available machines', async () => {
    mockDb.queueResponse({
      rows: [
        { id: 1, machine_serial_no: 'VMC-1-F' },
        { id: 2, machine_serial_no: 'VMC-2-F' }
      ]
    });

    const res = await request(makeApp()).get('/api/jobs/available-machines');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data || res.body)).toBe(true);
  });

  test('TC-JR-32 200 returns empty array when all machines are busy', async () => {
    mockDb.queueResponse({ rows: [] });

    const res = await request(makeApp()).get('/api/jobs/available-machines');

    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(Array.isArray(data) ? data.length : 0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/current
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/jobs/current', () => {
  test('TC-JR-40 401 when no auth token', async () => {
    const res = await request(makeUnauthApp()).get('/api/jobs/current');
    expect(res.status).toBe(401);
  });

  test('TC-JR-41 200 returns current active jobs', async () => {
    // the list endpoints run the page query and a COUNT together
    mockDb.queueResponse({
      rows: [{
        machine_id: 1, machine_serial_no: 'VMC-1-F',
        job_id: 10, part_name: 'PartA', target_qty: 50,
        started_at: '2026-05-01T08:00:00Z'
      }]
    }, { rows: [{ total: 1 }] });

    const res = await request(makeApp()).get('/api/jobs/current');
    expect(res.status).toBe(200);
  });

  test('TC-JR-42 200 returns empty when no active jobs', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });

    const res = await request(makeApp()).get('/api/jobs/current');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/history
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/jobs/history', () => {
  test('TC-JR-50 401 when no auth token', async () => {
    const res = await request(makeUnauthApp()).get('/api/jobs/history');
    expect(res.status).toBe(401);
  });

  test('TC-JR-51 200 returns job history', async () => {
    mockDb.queueResponse({
      rows: [
        {
          machine_serial_no: 'VMC-1-F', part_name: 'PartA',
          target_qty: 50, started_at: '2026-05-01T08:00:00Z',
          ended_at: '2026-05-01T20:00:00Z', is_active: false
        }
      ]
    }, { rows: [{ total: 1 }] });

    const res = await request(makeApp()).get('/api/jobs/history');
    expect(res.status).toBe(200);
  });

  test('TC-JR-52 history is scoped to authenticated company_id', async () => {
    mockDb.queueResponse({ rows: [] });

    const user = fakeUser({ company_id: 11 });
    await request(makeApp(user)).get('/api/jobs/history');

    expect(mockDb.calls()[0].params[0]).toBe(11);
  });
});
