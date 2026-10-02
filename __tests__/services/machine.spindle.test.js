/*
 * The machine page's spindle panel. What matters: it reads only this
 * company's machine, only the chosen window, and its summary describes the
 * time the spindle turned — not an average dragged down by idle zeros.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/spindle.service');

const NOW = Date.parse('2026-10-01T10:00:00+05:30');
const machine = { id: 25, machine_serial_no: 'HMC - 7 - F', spindle_rpm: 10000 };

function given({ m = [machine], points = [], summary = {}, latest = [] } = {}) {
  mockDb.queueResponse({ rows: m }, { rows: points }, { rows: [summary] }, { rows: latest });
}

beforeEach(() => resetDb());

describe('machineSpindle', () => {
  test('a bad id or range is a 400 before any query', async () => {
    await expect(svc.machineSpindle('abc', 4, '1h', NOW)).rejects.toMatchObject({ status: 400 });
    await expect(svc.machineSpindle(25, 4, '7d', NOW)).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test("another company's machine is not found, and nothing else is read", async () => {
    mockDb.queueResponse({ rows: [] });
    expect(await svc.machineSpindle(25, 99, '1h', NOW)).toBeNull();
    expect(mockDb.calls()).toHaveLength(1);
    expect(mockDb.calls()[0].params).toEqual([25, 99]);
  });

  test('reads only this machine within the chosen window, bucketed to the range', async () => {
    given();
    const d = await svc.machineSpindle(25, 4, '4h', NOW);
    const trend = mockDb.calls().find(c => /time_bucket/.test(c.text));
    expect(trend.params).toEqual([25, new Date(NOW - 4 * 3600e3), new Date(NOW), '3 minutes']);
    const latest = mockDb.calls().find(c => /LIMIT 1/.test(c.text));
    // the latest reading is looked for within a bounded window too
    expect(latest.params).toEqual([25, new Date(NOW - 24 * 3600e3), new Date(NOW)]);
    expect(d.range).toEqual({ key: '4h', from: NOW - 4 * 3600e3, to: NOW, bucket_seconds: 180 });
  });

  test('the summary counts the time the spindle turned, not the idle zeros', async () => {
    given({ summary: { samples: 400, turning: 200, load_min: 3, load_avg: 41.5, load_max: 118,
                       load_high: 30, load_over: 4, rpm_min: 800, rpm_avg: 2400, rpm_max: 8000,
                       feeding: 150, feed_min: 20, feed_avg: 900, feed_max: 30000 } });
    const d = await svc.machineSpindle(25, 4, '1h', NOW);
    const q = mockDb.calls().find(c => /FILTER \(WHERE spindle_speed > 0\)/.test(c.text));
    expect(q.params.slice(3)).toEqual([80, 100]);
    expect(d.summary.load).toEqual({ min: 3, avg: 41.5, max: 118, high_pct: 15, overload_pct: 2 });
    expect(d.summary.rpm).toEqual({ min: 800, avg: 2400, max: 8000, max_of_rated_pct: 80 });
    expect(d.summary.feed).toEqual({ min: 20, avg: 900, max: 30000, feeding: 150 });
  });

  test('with no turning, the shares are unknown, not zero', async () => {
    given({ summary: { samples: 50, turning: 0 } });
    const d = await svc.machineSpindle(25, 4, '1h', NOW);
    expect(d.summary.load.high_pct).toBeNull();
    expect(d.summary.load.overload_pct).toBeNull();
  });

  test('speed is shown against the rated speed only when the register has one', async () => {
    given({ m: [{ ...machine, spindle_rpm: null }], summary: { turning: 10, rpm_max: 5000 } });
    const d = await svc.machineSpindle(25, 4, '1h', NOW);
    expect(d.machine.rated_rpm).toBeNull();
    expect(d.summary.rpm.max_of_rated_pct).toBeNull();
  });

  test('the latest reading says when it was taken and whether it is still current', async () => {
    given({ latest: [{ at: String(NOW - 90e3), load: 35, rpm: 2500, feed: 1200, status: 'RUNNING' }] });
    let d = await svc.machineSpindle(25, 4, '1h', NOW);
    expect(d.latest).toEqual({ at: NOW - 90e3, load: 35, rpm: 2500, feed: 1200, status: 'RUNNING', stale: true });

    resetDb();
    given({ latest: [{ at: String(NOW - 5e3), load: 35, rpm: 2500, feed: 1200, status: 'RUNNING' }] });
    d = await svc.machineSpindle(25, 4, '1h', NOW);
    expect(d.latest.stale).toBe(false);
  });

  test('no reading in the last day is no latest reading', async () => {
    given();
    expect((await svc.machineSpindle(25, 4, '1h', NOW)).latest).toBeNull();
  });

  test('trend points keep their gaps as nulls, and their times as numbers', async () => {
    given({ points: [{ t: String(NOW - 60e3), load_avg: 12.5, load_max: 40, rpm_avg: 2000, rpm_max: 2500, feed_avg: null, feed_max: null, samples: 12 }] });
    const d = await svc.machineSpindle(25, 4, '1h', NOW);
    expect(d.points).toEqual([{ t: NOW - 60e3, load_avg: 12.5, load_max: 40, rpm_avg: 2000, rpm_max: 2500, feed_avg: null, feed_max: null, samples: 12 }]);
  });
});
