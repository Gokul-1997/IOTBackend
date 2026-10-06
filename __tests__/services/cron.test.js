/*
 * Scheduled jobs: the right hour, and one runner at a time.
 */
jest.mock('../../src/db', () => {
  const state = { locked: false, ran: 0 };
  const client = {
    query: jest.fn(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        if (state.locked) return { rows: [{ ok: false }] };
        state.locked = true; return { rows: [{ ok: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) { state.locked = false; return { rows: [{ pg_advisory_unlock: true }] }; }
      return { rows: [] };
    }),
    release: jest.fn()
  };
  return { connect: jest.fn(async () => client), query: jest.fn(async () => ({ rows: [] })), _state: state, _client: client };
});

const { previousIstHour } = require('../../src/cron/hourlyOee.job');
const { exclusive } = require('../../src/cron');
const db = require('../../src/db');

describe('hourly OEE reads the IST hour production_hourly is keyed by', () => {
  test('at 10:00 IST it reads 09:00–10:00 IST, i.e. 03:30–04:30 UTC', () => {
    const { hourStart, hourEnd } = previousIstHour(new Date('2026-10-06T04:30:05Z'));   // 10:00:05 IST
    expect(hourStart.toISOString()).toBe('2026-10-06T03:30:00.000Z');
    expect(hourEnd.toISOString()).toBe('2026-10-06T04:30:00.000Z');
  });

  test('just after midnight IST it reads 23:00–00:00 of the day before', () => {
    const { hourStart } = previousIstHour(new Date('2026-10-05T18:31:00Z'));            // 00:01 IST, 6 Oct
    expect(hourStart.toISOString()).toBe('2026-10-05T17:30:00.000Z');                     // 23:00 IST, 5 Oct
  });
});

describe('one runner at a time', () => {
  test('a second process asking for the same job while it runs skips the tick', async () => {
    let release;
    const slow = jest.fn(() => new Promise(r => { release = r; }));
    const other = jest.fn(async () => {});
    const first = exclusive('preventive', slow);
    await new Promise(r => setImmediate(r));
    await exclusive('preventive', other);          // lock held: skipped
    release();
    await first;
    expect(slow).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(db._state.locked).toBe(false);           // released afterwards
  });

  test('a job that throws still releases the lock and its connection', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await exclusive('periodic', async () => { throw new Error('boom'); });
    expect(db._state.locked).toBe(false);
    expect(db._client.release).toHaveBeenCalled();
    spy.mockRestore();
  });
});
