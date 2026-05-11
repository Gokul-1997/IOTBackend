/*
 * HTTP-level integration tests for /api/quality
 *
 * Exercises the full middleware stack:
 *   auth middleware → validate middleware → controller → service → DB
 *
 * Covers:
 *  GET /api/quality
 *    TC-QR-01  400 when machine_id missing
 *    TC-QR-02  400 when shift_id missing
 *    TC-QR-03  400 when date missing
 *    TC-QR-04  401 when no auth token
 *    TC-QR-05  200 with correct production payload
 *    TC-QR-06  accepted decreases when reject_qty is set
 *    TC-QR-07  accepted is never negative
 *    TC-QR-08  returns hourly array
 *
 *  POST /api/quality/entry
 *    TC-QE-01  400 when machine_id missing
 *    TC-QE-02  400 when shift_id missing
 *    TC-QE-03  400 when date missing
 *    TC-QE-04  422 when reject+rework > produced
 *    TC-QE-05  200 with action:created on first entry
 *    TC-QE-06  200 with action:updated on subsequent entry
 *    TC-QE-07  reject_qty defaults to 0 when not sent
 *    TC-QE-08  rework_qty defaults to 0 when not sent
 *    TC-QE-09  401 when no auth token
 *    TC-QE-10  negative reject_qty rejected by validate middleware
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const request    = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { buildApp, fakeUser } = require('../helpers/testApp');

beforeEach(() => resetDb());

// ─── helpers ────────────────────────────────────────────────────────────────

function makeApp(user = fakeUser()) {
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () =>
    (req, _res, next) => { req.user = user; next(); });
  jest.doMock('../../src/db', () => mockDb);
  const router = require('../../src/quality/quality.routes');
  return buildApp({ mountPath: '/api/quality', router });
}

/** App with NO auth — auth middleware rejects immediately */
function makeUnauthApp() {
  jest.resetModules();
  jest.doMock('../../src/middleware/auth.middleware', () =>
    (_req, res) => res.status(401).json({ success: false, message: 'Unauthorized' }));
  jest.doMock('../../src/db', () => mockDb);
  const router = require('../../src/quality/quality.routes');
  return buildApp({ mountPath: '/api/quality', router });
}

const MACHINE_ROW = {
  id: 23, machine_serial_no: 'M-001', image_url: '/img/m.png',
  operator_name: 'Ravi', component_id: 'C-99', part_name: 'Shaft',
  operation_number: 'OP-01', target_qty: '100',
  cycle_time_seconds: '60', multiplication_factor: '1'
};

const SHIFT_ROW = { start_time: '08:00', end_time: '16:00', break_minutes: '30' };

function queueDashboard({ produced = 10, runSec = 1800, reject = 0, rework = 0 } = {}) {
  mockDb.queueResponse(
    { rows: [MACHINE_ROW] },
    { rows: [SHIFT_ROW] },
    { rows: [{ produced, run_seconds: runSec }] },
    { rows: [{ reject, rework }] },
    { rows: [] },          // oee upsert
    { rows: [] }           // hourly
  );
}

function queueUpsert({ produced = 10, existingId = null } = {}) {
  mockDb.queueResponse({ rows: [{ produced }] });
  mockDb.queueResponse(existingId ? { rows: [{ id: existingId }] } : { rows: [] });
  mockDb.queueResponse({ rows: [], rowCount: 1 });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/quality
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/quality', () => {

  test('TC-QR-01 400 when machine_id missing', async () => {
    const res = await request(makeApp())
      .get('/api/quality?shift_id=5&date=2026-05-06');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('TC-QR-02 400 when shift_id missing', async () => {
    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&date=2026-05-06');
    expect(res.status).toBe(400);
  });

  test('TC-QR-03 400 when date missing', async () => {
    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5');
    expect(res.status).toBe(400);
  });

  test('TC-QR-04 401 when no auth token', async () => {
    const res = await request(makeUnauthApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');
    expect(res.status).toBe(401);
  });

  test('TC-QR-05 200 with correct production payload', async () => {
    queueDashboard({ produced: 10, reject: 2, rework: 1 });

    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.production).toMatchObject({
      produced: 10,
      reject:   2,
      rework:   1,
      accepted: 7
    });
  });

  test('TC-QR-06 accepted decreases when reject_qty is set', async () => {
    queueDashboard({ produced: 20, reject: 5, rework: 0 });

    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');

    expect(res.status).toBe(200);
    expect(res.body.data.production.accepted).toBe(15);  // 20 - 5
  });

  test('TC-QR-07 accepted is never negative', async () => {
    queueDashboard({ produced: 5, reject: 8, rework: 0 });

    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');

    expect(res.status).toBe(200);
    expect(res.body.data.production.accepted).toBe(0);
  });

  test('TC-QR-08 returns hourly array', async () => {
    queueDashboard({ produced: 10 });

    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.hourly)).toBe(true);
  });

  test('TC-QR-09 quality_percent = 100 when no rejects', async () => {
    queueDashboard({ produced: 10, reject: 0, rework: 0 });

    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');

    expect(res.status).toBe(200);
    expect(res.body.data.production.quality_percent).toBe(100);
  });

  test('TC-QR-10 OEE fields present in response', async () => {
    queueDashboard({ produced: 10, runSec: 1800 });

    const res = await request(makeApp())
      .get('/api/quality?machine_id=23&shift_id=5&date=2026-05-06');

    expect(res.body.data.oee).toHaveProperty('oee');
    expect(res.body.data.oee).toHaveProperty('availability');
    expect(res.body.data.oee).toHaveProperty('performance');
    expect(res.body.data.oee).toHaveProperty('quality');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/quality/entry
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/quality/entry', () => {

  const VALID_BODY = {
    machine_id: 23, shift_id: 5, date: '2026-05-06',
    reject_qty: 2, rework_qty: 0
  };

  test('TC-QE-01 400 when machine_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ shift_id: 5, date: '2026-05-06', reject_qty: 2 });
    expect(res.status).toBe(400);
  });

  test('TC-QE-02 400 when shift_id missing', async () => {
    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ machine_id: 23, date: '2026-05-06', reject_qty: 2 });
    expect(res.status).toBe(400);
  });

  test('TC-QE-03 400 when date missing', async () => {
    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ machine_id: 23, shift_id: 5, reject_qty: 2 });
    expect(res.status).toBe(400);
  });

  test('TC-QE-04 422 when reject+rework > produced', async () => {
    mockDb.queueResponse({ rows: [{ produced: 5 }] }); // produced = 5

    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ ...VALID_BODY, reject_qty: 4, rework_qty: 3 }); // 7 > 5

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/exceed/i);
  });

  test('TC-QE-05 200 with action:created on first entry', async () => {
    queueUpsert({ produced: 10, existingId: null });

    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe('created');
  });

  test('TC-QE-06 200 with action:updated on subsequent entry', async () => {
    queueUpsert({ produced: 10, existingId: 77 });

    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('updated');
  });

  test('TC-QE-07 reject_qty defaults to 0 when not sent', async () => {
    queueUpsert({ produced: 10, existingId: null });

    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ machine_id: 23, shift_id: 5, date: '2026-05-06', rework_qty: 1 });

    expect(res.status).toBe(200);
    // reject_qty defaults to 0 — verify the INSERT uses 0
    const calls = mockDb.calls();
    const insertCall = calls.find(c => c.text.includes('INSERT INTO quality_entries'));
    expect(insertCall).toBeDefined();
    expect(insertCall.params).toContain(0); // reject_qty = 0
  });

  test('TC-QE-08 rework_qty defaults to 0 when not sent', async () => {
    queueUpsert({ produced: 10, existingId: null });

    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ machine_id: 23, shift_id: 5, date: '2026-05-06', reject_qty: 1 });

    expect(res.status).toBe(200);
    const calls = mockDb.calls();
    const insertCall = calls.find(c => c.text.includes('INSERT INTO quality_entries'));
    expect(insertCall).toBeDefined();
    expect(insertCall.params).toContain(0); // rework_qty = 0
  });

  test('TC-QE-09 401 when no auth token', async () => {
    const res = await request(makeUnauthApp())
      .post('/api/quality/entry')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  test('TC-QE-10 400 when reject_qty is negative (validate middleware)', async () => {
    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ ...VALID_BODY, reject_qty: -1 });
    expect(res.status).toBe(400);
  });

  test('TC-QE-11 both reject_qty and rework_qty = 0 is valid (clear/reset)', async () => {
    queueUpsert({ produced: 10, existingId: 88 });

    const res = await request(makeApp())
      .post('/api/quality/entry')
      .send({ ...VALID_BODY, reject_qty: 0, rework_qty: 0 });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('updated');
  });

  test('TC-QE-12 shift_date stored in DB (not relying on created_at)', async () => {
    queueUpsert({ produced: 10, existingId: null });

    await request(makeApp())
      .post('/api/quality/entry')
      .send(VALID_BODY);

    const calls = mockDb.calls();
    const insertCall = calls.find(c => c.text.includes('INSERT INTO quality_entries'));
    expect(insertCall.params).toContain('2026-05-06');
    expect(insertCall.text).toMatch(/shift_date/);
  });
});
