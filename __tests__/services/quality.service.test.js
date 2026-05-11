/*
 * Unit tests for quality.service.js
 *
 * Covers:
 *  getQualityDashboardService
 *    TC-QS-01  returns machine + production + oee + hourly
 *    TC-QS-02  accepted = produced - reject - rework
 *    TC-QS-03  accepted is clamped to 0 when reject+rework > produced
 *    TC-QS-04  quality_percent = 0 when produced = 0
 *    TC-QS-05  OEE = 0 when no production data
 *    TC-QS-06  upserts oee_shift_summary when produced > 0
 *    TC-QS-07  does NOT upsert oee_shift_summary when produced = 0
 *    TC-QS-08  uses COALESCE(shift_date, created_at::date) to read quality entries
 *
 *  upsertQualityEntryService
 *    TC-QU-01  creates new entry when none exists
 *    TC-QU-02  updates existing entry when found for same machine+shift+date
 *    TC-QU-03  stores shift_date on INSERT
 *    TC-QU-04  updates shift_date on UPDATE
 *    TC-QU-05  422 when reject+rework exceeds produced_qty
 *    TC-QU-06  skips produce validation when produced = 0 (no production data yet)
 *    TC-QU-07  returns { action: 'created' } on insert
 *    TC-QU-08  returns { action: 'updated' } on update
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);

const { mockDb, resetDb } = require('../helpers/mockDb');
const quality = require('../../src/quality/quality.service');

beforeEach(() => resetDb());

// ─── helpers ────────────────────────────────────────────────────────────────

const MACHINE_ROW = {
  id: 23,
  machine_serial_no: 'M-001',
  image_url: '/img/m.png',
  operator_name: 'Ravi',
  component_id: 'C-99',
  part_name: 'Shaft',
  operation_number: 'OP-01',
  target_qty: 100,
  cycle_time_seconds: 60,
  multiplication_factor: 1
};

const SHIFT_ROW = {
  start_time: '08:00',
  end_time: '16:00',
  break_minutes: 30
};

function queueDashboard({
  produced = 10,
  runSeconds = 1800,
  reject = 0,
  rework = 0,
  hourly = []
} = {}) {
  mockDb.queueResponse(
    { rows: [MACHINE_ROW] },                                  // machine
    { rows: [SHIFT_ROW] },                                    // shift
    { rows: [{ produced, run_seconds: runSeconds }] },        // prod totals
    { rows: [{ reject, rework }] },                           // quality entries
    { rows: [], rowCount: 0 },                                // oee_shift_summary upsert
    { rows: hourly }                                          // hourly rows
  );
}

const BASE_ARGS = { machine_id: 23, shift_id: 5, date: '2026-05-06' };

// ─────────────────────────────────────────────────────────────────────────────
// getQualityDashboardService
// ─────────────────────────────────────────────────────────────────────────────

describe('getQualityDashboardService', () => {

  test('TC-QS-01 returns machine, production, oee, hourly', async () => {
    queueDashboard({ produced: 10, runSeconds: 1800, reject: 2, rework: 1 });

    const result = await quality.getQualityDashboardService(BASE_ARGS);

    expect(result).toHaveProperty('machine');
    expect(result).toHaveProperty('production');
    expect(result).toHaveProperty('oee');
    expect(result).toHaveProperty('hourly');
    expect(result.machine.machine_serial_no).toBe('M-001');
  });

  test('TC-QS-02 accepted = produced - reject - rework', async () => {
    queueDashboard({ produced: 10, reject: 2, rework: 1 });

    const { production } = await quality.getQualityDashboardService(BASE_ARGS);

    expect(production.produced).toBe(10);
    expect(production.reject).toBe(2);
    expect(production.rework).toBe(1);
    expect(production.accepted).toBe(7);   // 10 - 2 - 1
  });

  test('TC-QS-03 accepted is clamped to 0 when reject+rework > produced', async () => {
    queueDashboard({ produced: 5, reject: 4, rework: 3 });   // 4+3 = 7 > 5

    const { production } = await quality.getQualityDashboardService(BASE_ARGS);

    expect(production.accepted).toBe(0);
  });

  test('TC-QS-04 quality_percent = 0 when produced = 0', async () => {
    queueDashboard({ produced: 0, runSeconds: 0, reject: 0, rework: 0 });

    const { production } = await quality.getQualityDashboardService(BASE_ARGS);

    expect(production.quality_percent).toBe(0);
    expect(production.produced).toBe(0);
  });

  test('TC-QS-05 OEE = 0 when no production data', async () => {
    queueDashboard({ produced: 0, runSeconds: 0 });

    const { oee } = await quality.getQualityDashboardService(BASE_ARGS);

    expect(oee.oee).toBe(0);
    expect(oee.availability).toBe(0);
  });

  test('TC-QS-06 upserts oee_shift_summary when produced > 0', async () => {
    queueDashboard({ produced: 10, runSeconds: 1800 });

    await quality.getQualityDashboardService(BASE_ARGS);

    const calls = mockDb.calls();
    const upsertCall = calls.find(c => c.text.includes('oee_shift_summary'));
    expect(upsertCall).toBeDefined();
    expect(upsertCall.text).toMatch(/ON CONFLICT/i);
  });

  test('TC-QS-07 does NOT upsert oee_shift_summary when produced = 0', async () => {
    queueDashboard({ produced: 0, runSeconds: 0 });

    await quality.getQualityDashboardService(BASE_ARGS);

    const calls = mockDb.calls();
    const upsertCall = calls.find(c => c.text.includes('oee_shift_summary'));
    expect(upsertCall).toBeUndefined();
  });

  test('TC-QS-08 quality query uses COALESCE(shift_date, created_at::date)', async () => {
    queueDashboard({ produced: 5, reject: 1 });

    await quality.getQualityDashboardService(BASE_ARGS);

    const calls = mockDb.calls();
    const qualityCall = calls.find(c =>
      c.text.includes('quality_entries') && c.text.includes('reject_qty')
    );
    expect(qualityCall).toBeDefined();
    expect(qualityCall.text).toMatch(/COALESCE\(shift_date/i);
  });

  test('TC-QS-09 quality_percent reflects accepted/produced ratio', async () => {
    queueDashboard({ produced: 10, reject: 2, rework: 0 });

    const { production } = await quality.getQualityDashboardService(BASE_ARGS);

    // accepted = 8, produced = 10 → 80%
    expect(production.quality_percent).toBe(80);
  });

  test('TC-QS-10 machine target_qty is returned correctly', async () => {
    queueDashboard({ produced: 5 });

    const { production } = await quality.getQualityDashboardService(BASE_ARGS);

    expect(production.target_qty).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertQualityEntryService
// ─────────────────────────────────────────────────────────────────────────────

const UPSERT_ARGS = {
  machine_id: 23,
  shift_id: 5,
  date: '2026-05-06',
  reject_qty: 2,
  rework_qty: 0,
  user_id: 1
};

function queueUpsert({ produced = 10, existingId = null } = {}) {
  // produced_qty validation query
  mockDb.queueResponse({ rows: [{ produced }] });
  // existing entry lookup
  mockDb.queueResponse(existingId
    ? { rows: [{ id: existingId }] }
    : { rows: [] }
  );
  // INSERT or UPDATE
  mockDb.queueResponse({ rows: [], rowCount: 1 });
}

describe('upsertQualityEntryService', () => {

  test('TC-QU-01 creates new entry when none exists', async () => {
    queueUpsert({ existingId: null });

    await quality.upsertQualityEntryService(UPSERT_ARGS);

    const calls = mockDb.calls();
    const insertCall = calls.find(c => c.text.includes('INSERT INTO quality_entries'));
    expect(insertCall).toBeDefined();
  });

  test('TC-QU-02 updates existing entry when found for same machine+shift+date', async () => {
    queueUpsert({ existingId: 55 });

    await quality.upsertQualityEntryService(UPSERT_ARGS);

    const calls = mockDb.calls();
    const updateCall = calls.find(c =>
      c.text.includes('UPDATE quality_entries') && c.text.includes('reject_qty')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall.params).toContain(55);  // id is used in WHERE
  });

  test('TC-QU-03 stores shift_date on INSERT', async () => {
    queueUpsert({ existingId: null });

    await quality.upsertQualityEntryService(UPSERT_ARGS);

    const calls = mockDb.calls();
    const insertCall = calls.find(c => c.text.includes('INSERT INTO quality_entries'));
    expect(insertCall.text).toMatch(/shift_date/);
    expect(insertCall.params).toContain('2026-05-06');
  });

  test('TC-QU-04 updates shift_date on UPDATE', async () => {
    queueUpsert({ existingId: 55 });

    await quality.upsertQualityEntryService(UPSERT_ARGS);

    const calls = mockDb.calls();
    const updateCall = calls.find(c =>
      c.text.includes('UPDATE quality_entries')
    );
    expect(updateCall.text).toMatch(/shift_date/);
    expect(updateCall.params).toContain('2026-05-06');
  });

  test('TC-QU-05 422 when reject+rework exceeds produced_qty', async () => {
    // produced = 5, reject = 4, rework = 3 → total 7 > 5
    mockDb.queueResponse({ rows: [{ produced: 5 }] });

    await expect(
      quality.upsertQualityEntryService({ ...UPSERT_ARGS, reject_qty: 4, rework_qty: 3 })
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/exceed/i) });
  });

  test('TC-QU-06 skips produce validation when produced = 0', async () => {
    // produced = 0 → no validation error even if reject_qty > 0
    queueUpsert({ produced: 0, existingId: null });

    const result = await quality.upsertQualityEntryService(UPSERT_ARGS);
    expect(result.action).toBe('created');
  });

  test('TC-QU-07 returns { action: "created" } on insert', async () => {
    queueUpsert({ existingId: null });

    const result = await quality.upsertQualityEntryService(UPSERT_ARGS);
    expect(result).toEqual({ action: 'created' });
  });

  test('TC-QU-08 returns { action: "updated" } on update', async () => {
    queueUpsert({ existingId: 55 });

    const result = await quality.upsertQualityEntryService(UPSERT_ARGS);
    expect(result).toEqual({ action: 'updated' });
  });

  test('TC-QU-09 reject_qty = 0, rework_qty = 0 is valid (reset entry)', async () => {
    queueUpsert({ produced: 10, existingId: 55 });

    const result = await quality.upsertQualityEntryService({
      ...UPSERT_ARGS, reject_qty: 0, rework_qty: 0
    });
    expect(result.action).toBe('updated');
  });

  test('TC-QU-10 lookup uses COALESCE(shift_date, created_at::date)', async () => {
    queueUpsert({ existingId: null });

    await quality.upsertQualityEntryService(UPSERT_ARGS);

    const calls = mockDb.calls();
    const lookupCall = calls.find(c =>
      c.text.includes('quality_entries') && c.text.includes('SELECT id')
    );
    expect(lookupCall).toBeDefined();
    expect(lookupCall.text).toMatch(/COALESCE\(shift_date/i);
  });
});
