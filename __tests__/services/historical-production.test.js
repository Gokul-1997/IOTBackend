jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { metrics } = require('../../src/lib/historical-production');
const quality = require('../../src/quality/quality.service');
beforeEach(() => resetDb());
test('mixed historical jobs combine ideal work, rather than applying today’s one cycle to all past parts', () => {
  const rows = [{ produced_qty: 10, run_seconds: 600, cycle_time_seconds: 30 }, { produced_qty: 20, run_seconds: 1200, cycle_time_seconds: 60 }];
  expect(metrics(rows, 3600, 27)).toEqual({ availability: 50, performance: 83.33, quality: 90, oee: 37.5 });
});
test('one unknown historical cycle leaves performance and OEE unknown', () => {
  expect(metrics([{ produced_qty: 10, run_seconds: 600, cycle_time_seconds: null }], 3600, 10)).toMatchObject({ performance: null, quality: 100, oee: null });
});
test('quality GET uses four bounded reads and never assigns cumulative rejects to an hour', async () => {
  mockDb.queueResponse({ rows: [{ id: 7, target_qty: 100, cycle_time_seconds: 9999 }] },
    { rows: [{ start_time: '08:15', end_time: '16:15', break_minutes: 0 }] },
    { rows: [{ hour_start: '2026-10-13T02:30:00Z', produced_qty: 10, run_seconds: 600, cycle_time_seconds: 30, planned_seconds: 2700 }] },
    { rows: [{ reject: 2, rework: 0 }] });
  const result = await quality.getQualityDashboardService({ company_id: 1, machine_id: 7, shift_id: 5, date: '2026-10-13' });
  expect(result.oee.performance).toBe(50);
  expect(result.hourly[0]).toMatchObject({ reject: null, accepted: null, quality: null, oee: null, measurement_basis: 'HOURLY_QUALITY_NOT_MEASURED' });
  expect(mockDb.calls()).toHaveLength(4);
  expect(mockDb.calls().every(c => !/INSERT|UPDATE|DELETE/.test(c.text))).toBe(true);
});
