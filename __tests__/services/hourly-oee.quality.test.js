jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/utils/shift.util', () => ({ getCurrentShift: jest.fn() }));
const { mockDb, resetDb } = require('../helpers/mockDb');
const { getCurrentShift } = require('../../src/utils/shift.util');
const { runHourlyOee, hourlyQuality } = require('../../src/cron/hourlyOee.job');
beforeEach(() => { resetDb(); getCurrentShift.mockResolvedValue({ id: 5, start_time: '08:00', end_time: '20:00' }); });
test.each([1, 10, 441])('produced %s and no reported shift rejects retains the plant rule of 100%% quality', produced => expect(hourlyQuality(produced)).toBe(100));
test.each([[0, 0, 0], [10, 2, 0], [10, 0, 2], [10, 50, 0]])('shift totals %j cannot be invented as an hourly measured reject count', (produced, reject, rework) => expect(hourlyQuality(produced, reject, rework)).toBeNull());
test('actual hourly rollup queries quality once, persists tenant scope and leaves unattributable hourly quality/OEE NULL', async () => {
  mockDb.queueResponse({ rows: [{ id: 4 }] }, { rows: [
    { machine_id: 1, produced_qty: 10, run_seconds: 1800, cycle_time_seconds: 60 },
    { machine_id: 2, produced_qty: 20, run_seconds: 1800, cycle_time_seconds: null }
  ] }, { rows: [{ machine_id: 1, reject: 2, rework: 0 }] }, { rows: [] });
  await runHourlyOee(new Date('2026-10-13T08:00:00+05:30'));
  const calls = mockDb.calls();
  expect(calls.filter(c => c.text.includes('FROM quality_entries'))).toHaveLength(1);
  const write = calls.find(c => c.text.includes('INSERT INTO oee_hourly'));
  expect(write.params.slice(0, 8)).toEqual([1, 4, 5, expect.any(Date), 50, 33.33, null, null]);
  expect(write.params.slice(8)).toEqual([2, 4, 5, expect.any(Date), 50, null, 100, null]);
});
