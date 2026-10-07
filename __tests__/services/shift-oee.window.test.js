/*
 * The shift OEE job recomputes every completed shift that ENDED in the last
 * 48 hours, every 10 minutes, and dates a shift by the day it STARTED.
 *
 * At 00:50 IST on 7 Oct (company 4: Shift 1 08:00–20:00, Shift 2 20:00–08:00)
 * that is Shift 1 of the 6th, Shift 1 of the 5th and Shift 2 that ran from the
 * 5th into the 6th — and the night shift from the 4th into the 5th, which on a
 * Sunday has no production and so nothing to write. One line per company says
 * so in words; a line per shift with "date=2026-10-05" looked like a fault.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { runShiftOee } = require('../../src/cron/shiftOee.job');

beforeEach(() => resetDb());
afterEach(() => jest.useRealTimers());

test('at 00:50 IST on the 7th: the three completed shifts with production, dated by their start', async () => {
  const now = Date.parse('2026-10-07T00:50:00+05:30');
  jest.useFakeTimers().setSystemTime(now);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});

  const prod = [
    { machine_id: 15, total_run_seconds: 30000, total_produced_qty: 40, cycle_time_seconds: 600 },
    { machine_id: 16, total_run_seconds: 20000, total_produced_qty: 25, cycle_time_seconds: 600 }
  ];
  mockDb.queueResponse(
    { rows: [{ id: 4 }] },                                                           // companies
    { rows: [{ id: 5, shift_code: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', break_minutes: 60 },
             { id: 6, shift_code: 'Shift 2', start_time: '20:00:00', end_time: '08:00:00', break_minutes: 60 }] },
    { rows: [{ id: 15 }, { id: 16 }] },                                              // machines
    { rows: prod }, { rows: [] }, { rows: [] },    // Shift 1 of the 6th: production, quality, upsert
    { rows: prod }, { rows: [] }, { rows: [] },    // Shift 1 of the 5th
    { rows: prod }, { rows: [] }, { rows: [] },    // Shift 2, 5th → 6th
    { rows: [] },   { rows: [] }                   // Shift 2, 4th → 5th: a Sunday, nothing produced
  );

  await runShiftOee({ fromMs: now - 48 * 3600e3, toMs: now });

  const upserts = mockDb.calls().filter(c => /INSERT INTO oee_shift_summary/.test(c.text));
  expect(upserts.map(c => [c.params[1], c.params[2]])).toEqual([[5, '2026-10-06'], [5, '2026-10-05'], [6, '2026-10-05']]);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toBe('[shiftOee] company 4: recomputed 3 completed shift(s) that ended in the last 48 h — '
    + 'Shift 1 started 2026-10-06 (2 machines); Shift 1 started 2026-10-05 (2 machines); Shift 2 started 2026-10-05 (2 machines)');
  log.mockRestore();
});
