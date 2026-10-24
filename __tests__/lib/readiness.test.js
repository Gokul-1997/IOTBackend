const { createReadiness } = require('../../src/lib/readiness');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => jest.useRealTimers());

test('a burst of health requests shares one database/Redis probe and leaves no deadline timers', async () => {
  jest.useFakeTimers();
  const db = { query: jest.fn(async () => ({})) }, redis = { ping: jest.fn(async () => 'PONG') };
  const ready = createReadiness({ db, redis });
  const results = await Promise.all(Array.from({ length: 100 }, () => ready()));
  expect(results.every(result => result.ok)).toBe(true);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(redis.ping).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  await ready(); expect(db.query).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1001); await ready(); expect(db.query).toHaveBeenCalledTimes(2);
});

test('a hung dependency times out without accumulating database work and recovers', async () => {
  jest.useFakeTimers();
  let resolve;
  const db = { query: jest.fn(() => new Promise(done => { resolve = done; })) };
  const redis = { ping: jest.fn(async () => 'PONG') };
  const ready = createReadiness({ db, redis, timeoutMs: 20, cacheMs: 1 });
  let first = ready(); await flush(); jest.advanceTimersByTime(20);
  expect(await first).toEqual({ ok: false, db: false, redis: true });
  jest.advanceTimersByTime(2);
  first = ready(); await flush(); jest.advanceTimersByTime(20); await first;
  expect(db.query).toHaveBeenCalledTimes(1);
  resolve({}); await flush();
  db.query.mockResolvedValue({}); jest.advanceTimersByTime(2);
  expect(await ready()).toEqual({ ok: true, db: true, redis: true });
  expect(jest.getTimerCount()).toBe(0);
});

test('repeated probes of permanently hung dependencies reuse their settled deadlines', async () => {
  jest.useFakeTimers();
  const db = { query: jest.fn(() => new Promise(() => {})) };
  const redis = { ping: jest.fn(() => new Promise(() => {})) };
  const ready = createReadiness({ db, redis, timeoutMs: 20, cacheMs: 1 });
  const first = ready(); await flush(); jest.advanceTimersByTime(20); await first;
  const timers = jest.spyOn(global, 'setTimeout');
  try {
    for (let i = 0; i < 100; i++) {
      jest.advanceTimersByTime(2);
      expect(await ready()).toEqual({ ok: false, db: false, redis: false });
    }
    expect(timers).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  } finally { timers.mockRestore(); }
});
