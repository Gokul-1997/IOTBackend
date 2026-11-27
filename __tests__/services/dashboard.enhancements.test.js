jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { conditionHealth } = require('../../src/dashboard/condition-health');
const { cycleTrend, getCycleTime } = require('../../src/dashboard/cycle-time.controller');
const { paretoRows } = require('../../src/dashboard/alarm.service');
const { createPdf } = require('../../src/reports/pdf.util');
const { inspect, databaseSummary } = require('../../src/assistant/assistant.validation');

beforeEach(resetDb);
const now = Date.parse('2026-11-24T10:00:00Z');
const at = { received_at: new Date(now).toISOString() };

test.each(['spindle_load', 'servo_load_x', 'servo_load_y', 'servo_load_z', 'spindle_motor_temp'])(
  '%s uses the requested 60 and 80 boundaries consistently in the health score', key => {
    for (const [value, score, band] of [[59.9, 100, 'Healthy'], [60, 50, 'Normal'], [79.9, 50, 'Normal'], [80, 0, 'Critical'], [100, 0, 'Critical']]) {
      expect(conditionHealth({ ...at, [key]: value }, now).checks).toEqual([{ label: expect.any(String), score, band }]);
    }
  }
);

test('health uses reported condition checks and the 70% Good boundary', () => {
  expect(conditionHealth({ ...at, servo_temp_x: 25, servo_temp_y: 65 }, now)).toMatchObject({ score: 75, status: 'Good', reported_checks: 2 });
  expect(conditionHealth({ ...at, servo_temp_x: 25, servo_temp_y: 85 }, now)).toMatchObject({ score: 50, status: 'Bad' });
  expect(conditionHealth({ ...at, servo_temp_x: 25, alarm: true }, now)).toMatchObject({ score: 0, status: 'Bad' });
  expect(conditionHealth(at, now)).toBeNull();
  expect(conditionHealth({ servo_temp_x: 20 }, now)).toBeNull();
  expect(conditionHealth({ ...at, servo_temp_x: 0, spindle_motor_temp: 0 }, now)).toBeNull();
  expect(conditionHealth({ ...at, servo_temp_x: 25, servo_temp_y: 25, servo_temp_z: 25,
    encoder_temp_x: 25, spindle_motor_temp: 30, fan_status: { FAN1: { fault: true } } }, now)).toMatchObject({ score: 69, status: 'Bad' });
  expect(conditionHealth({ ...at, spindle_motor_temp: 25 }, now + 120000).stale).toBe(true);
});

test('unknown fan and battery objects do not imply a healthy reading', () => {
  expect(conditionHealth({ ...at, fan_status: { FAN1: {} }, acc_battery_status: { X: {} }, cnc_battery_warning: { warning: null } }, now)).toBeNull();
  expect(conditionHealth({ ...at, fan_status: { FAN1: { fault: true } } }, now)).toMatchObject({ score: 0, status: 'Bad' });
  expect(conditionHealth({ ...at, cnc_battery_warning: { warning: true } }, now)).toMatchObject({ score: 50 });
});

test('cycle time is recorded run seconds / actual parts and unknown hours remain gaps', () => {
  expect(cycleTrend([{ hour_start: 'x', produced: 20, run_seconds: 3600 }, { produced: 0, run_seconds: 100 }, { produced: 10, run_seconds: null }])
    .map(p => p.cycle_seconds)).toEqual([180, null, null]);
});

test('cycle history checks tenant ownership before reading production', async () => {
  mockDb.queueResponse({ rows: [] });
  expect(await getCycleTime(81, 5, { date: '2026-11-24' })).toBeNull();
  expect(mockDb.calls()).toHaveLength(1);
  expect(mockDb.calls()[0].params).toEqual([81, 5]);
});

test('Pareto ranks occurrence counts and keeps the full denominator including Other', () => {
  const rows = paretoRows([{ alarm_code: 'B', total: '2' }, { alarm_code: 'A', total: '6' }, { is_other: true, total: '2' }]);
  expect(rows.map(r => r.total)).toEqual([6, 2, 2]);
  expect(rows.map(r => r.cumulative_pct)).toEqual([60, 80, 100]);
  expect(paretoRows([])).toEqual([]);
});

test('AI checks formatted figures, source names, rounded values and same-metric comparisons', () => {
  const evidence = [{ data: { report: 'Production', period: { from: '2026-11-24', to: '2026-11-24' }, machine: 'VMC - 19 - F', totals: { parts: 1234, run_hours: 1.333, quality_pct: 96.56 } } }];
  expect(inspect('VMC - 19 - F on 2026-11-24: 1,234 parts, 1.3 h, quality 96.6%.', evidence).valid).toBe(true);
  expect(inspect('9,999 parts', evidence).valid).toBe(false);
  expect(databaseSummary(evidence)).toContain('parts: 1234');
  expect(inspect('Production increased by 20 parts (25%).', [{ data: { totals: { parts: 80 } } }, { data: { totals: { parts: 100 } } }]).valid).toBe(true);
  expect(inspect('OEE is 90%.', [{ data: { overall: { oee_pct: null } } }]).valid).toBe(false);
  expect(inspect('OEE is 90%.', [{ data: { overall: { oee_pct: 60, parts: 90 } } }]).valid).toBe(false);
  expect(inspect('OEE is 90%.', [{ data: { report: 'OEE', overall: { oee_pct: 60, quality_pct: 90 } } }]).valid).toBe(false);
});

test('PDF export writes A4 pages and paginates every selected column', async () => {
  const cols = Array.from({ length: 10 }, (_, n) => `Column ${n}`);
  const rows = Array.from({ length: 60 }, () => Object.fromEntries(cols.map(c => [c, 'Measured value'])));
  const file = await createPdf('Production Report', rows, cols);
  expect(file.subarray(0, 5).toString()).toBe('%PDF-');
  const pdf = file.toString('latin1');
  expect(pdf.includes('/Title')).toBe(true);
  expect(pdf.includes('/MediaBox [0 0 841.89 595.28]')).toBe(true);
  expect(Number(pdf.match(/\/Type \/Pages\s*\/Count (\d+)/)?.[1])).toBeGreaterThan(2);
});

test('very large PDF requests fail clearly instead of silently dropping rows', async () => {
  await expect(createPdf('Large report', Array(5001).fill({ Machine: 'VMC19' })))
    .rejects.toMatchObject({ status: 413, code: 'PDF_REPORT_TOO_LARGE' });
});
