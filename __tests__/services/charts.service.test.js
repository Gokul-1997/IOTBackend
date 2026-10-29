/*
 * Unit tests for charts.service:
 *  - getMeta returns lines/machines/shifts (we don't have lines in this slice — meta has machines+shifts)
 *  - getChartData returns hourlyCount + totalProduced
 *  - getPartTiming applies the stale-counter recovery guard
 *
 * The stale-counter test is the most important — it's the bug the client
 * reported (charts page showing every part as 0.2m IDLE / 0 RUNNING).
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/charts/charts.service');

beforeEach(() => resetDb());

describe('charts.service.getMeta', () => {
  test('returns machines + shifts arrays', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, machine_serial_no: 'VMC-1' }] },
      { rows: [{ id: 5, shift_code: 'MS01', shift_name: 'Morning',
                 start_time: '08:00', end_time: '20:00' }] }
    );
    const out = await svc.getMeta(null, 4);
    expect(out.machines).toHaveLength(1);
    expect(out.shifts).toHaveLength(1);
    expect(out.shifts[0].shift_code).toBe('MS01');
  });
});

describe('charts.service.getChartData', () => {
  test('returns empty arrays when no machineId and no date', async () => {
    const out = await svc.getChartData({ companyId: 4, machineId: null, shiftId: null, date: null });
    expect(out.hourlyCount).toEqual([]);
    expect(out.totalProduced).toBe(0);
  });

  test('totalProduced is the sum of hourlyCount', async () => {
    mockDb.queueResponse({
      rows: [
        { hour: '08:00', produced: 5 },
        { hour: '09:00', produced: 7 },
        { hour: '10:00', produced: 3 }
      ]
    });
    const out = await svc.getChartData({
      companyId: 4, machineId: 1, shiftId: 5, date: '2026-04-27'
    });
    expect(out.totalProduced).toBe(15);
    expect(out.hourlyCount).toHaveLength(3);
  });

  test.each([null, 5])('shift %s uses the report shift-date window including partial hours, tenant and as-of guards', async shiftId => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-28T16:36:00Z'));
    try {
      await svc.getChartData({ companyId: 4, machineId: 7, shiftId, date: '2026-10-28' });
      const { text, params } = mockDb.calls()[0];
      expect(params).toEqual([4, 7, '2026-10-28', '2026-10-28T16:36:00.000Z', ...(shiftId ? [shiftId] : [])]);
      expect(text).toContain('ph.company_id = $1');
      expect(text).toContain('s.id = ph.shift_id AND s.company_id = $1');
      expect(text).toContain("ph.hour_start + INTERVAL '1 hour' > ($3::date + s.start_time)");
      expect(text).toContain('CASE WHEN s.start_time >= s.end_time');
      expect(text).toContain('ph.hour_start < LEAST(');
      expect(text).toContain("($3::date + s.start_time) AT TIME ZONE 'Asia/Kolkata' <= $4::timestamptz");
      expect(text).toContain('s.id IS NULL');
      expect(text).not.toMatch(/multiplication_factor|JOIN components/);
    } finally { jest.useRealTimers(); }
  });

  test('a malformed chart date fails before reaching the rollup query', async () => {
    await expect(svc.getChartData({ companyId: 4, machineId: 7, date: '2026-02-31' }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('charts.service.getPartTiming', () => {
  test('returns empty when no machineId or shiftStart', async () => {
    expect(await svc.getPartTiming({ machineId: null, shiftStartEpoch: null })).toEqual([]);
  });

  test('expands multi-part jumps into individual rows with averaged time', async () => {
    // One part_event with increment=4 → 4 output rows, time split equally.
    mockDb.queueResponse({
      rows: [{
        completed_at: new Date(),
        started_at:   new Date(),
        increment:    4,
        run_seconds:  240,    // 4 min total → 1 min/part
        idle_seconds: 0
      }]
    });

    const out = await svc.getPartTiming({
      companyId: 4, machineId: 1, shiftStartEpoch: 1700000000, shiftEndEpoch: 1700001000
    });
    expect(out.parts).toHaveLength(4);
    expect(out.parts[0].run_min).toBe(1);
    expect(out.parts[0].idle_min).toBe(0);
    expect(out.totalRunMin).toBe(4);
    expect(out.totalIdleMin).toBe(0);
  });

  test('respects max_parts cap', async () => {
    mockDb.queueResponse({
      rows: Array.from({ length: 20 }).map(() => ({
        completed_at: new Date(), started_at: new Date(),
        increment: 1, run_seconds: 60, idle_seconds: 30
      }))
    });

    const out = await svc.getPartTiming({
      companyId: 4, machineId: 1, shiftStartEpoch: 1, shiftEndEpoch: 2, maxParts: 10
    });
    expect(out.parts).toHaveLength(10);
  });

  test('raw counter recovery and long gaps cannot fabricate parts in timing charts', async () => {
    await svc.getPartTiming({ companyId: 4, machineId: 1, shiftStartEpoch: 1700000000, shiftEndEpoch: 1700001000 });
    const { text } = mockDb.calls()[0];
    expect(text).toContain('parts_count - counter_base <= 20');
    expect(text).toContain('interval_sec > 0 AND interval_sec <= 60');
    expect(text).toContain('counter_base <= 2 AND (parts_count - counter_base) >= 5');
    expect(text).toContain('PARTITION BY counter_epoch');
    expect(text).toContain('AND company_id = $4');
    expect(text).toContain('o.interval_sec BETWEEN 1 AND 60');
  });
});
