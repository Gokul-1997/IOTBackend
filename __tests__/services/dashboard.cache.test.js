/*
 * dashboard/cache.js — a dashboard's answer is worked out once and shared:
 * by everyone in the company asking for the same filters, for 30 s while the
 * range includes today and 5 minutes for a range in the past; a change the
 * company makes through the API puts all of its answers out of date at once;
 * and without Redis every request is worked out, as before.
 */
jest.mock('../../src/redis', () => {
  const r = require('../setup/fake-redis').createFakeRedis();
  r.status = 'ready';
  return r;
});
const redis = require('../../src/redis');
const cache = require('../../src/dashboard/cache');

const week = { from: '2026-10-03', to: '2026-10-09', part: 'kpis,charts' };
let n;
const counted = (value = { ok: true }) => async () => { n += 1; return { ...value, n }; };

beforeEach(async () => {
  n = 0;
  redis.status = 'ready';
  await redis.flushall();
});

describe('one answer, shared', () => {
  test('the same company and filters are worked out once', async () => {
    const a = await cache.json('alarms', 4, week, 30, counted());
    const b = await cache.json('alarms', 4, { ...week }, 30, counted());
    expect(n).toBe(1);
    expect(b).toBe(a);
    expect(JSON.parse(a)).toEqual({ ok: true, n: 1 });
  });

  test('the same filters in another order share it; other filters, another dashboard or company do not', async () => {
    await cache.json('alarms', 4, week, 30, counted());
    await cache.json('alarms', 4, { part: week.part, to: week.to, from: week.from }, 30, counted());
    expect(n).toBe(1);

    await cache.json('alarms', 4, { ...week, page: '2' }, 30, counted());
    await cache.json('downtime', 4, week, 30, counted());
    await cache.json('alarms', 5, week, 30, counted());
    expect(n).toBe(4);
  });

  test('requests at the same moment wait for the one answer being worked out', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const slow = async () => { n += 1; await gate; return { rows: [1, 2, 3] }; };

    const all = Promise.all([1, 2, 3, 4, 5].map(() => cache.json('energy', 4, week, 30, slow)));
    await new Promise(r => setImmediate(r));
    release();
    const texts = await all;
    expect(n).toBe(1);
    expect(new Set(texts).size).toBe(1);
  });

  test('an error is never kept: the next request works it out again', async () => {
    await expect(cache.json('alarms', 4, week, 30, async () => { throw Object.assign(new Error('bad'), { status: 400 }); }))
      .rejects.toMatchObject({ status: 400 });
    await cache.json('alarms', 4, week, 30, counted());
    expect(n).toBe(1);
  });

  test('remember() hands back the value as JSON would — the same on a hit and a miss', async () => {
    const day = new Date(Date.UTC(2026, 9, 9));
    const first = await cache.remember('energy:figures', 4, week, 30, async () => ({ day, kwh: 1.5 }));
    const again = await cache.remember('energy:figures', 4, week, 30, async () => ({ day: 'never', kwh: 0 }));
    expect(first).toEqual({ day: day.toISOString(), kwh: 1.5 });
    expect(again).toEqual(first);
  });

  test('no company: nothing to share it with, so it is worked out every time', async () => {
    await cache.json('alarms', null, week, 30, counted());
    await cache.json('alarms', null, week, 30, counted());
    expect(n).toBe(2);
  });
});

describe('a change puts the company\'s answers out of date', () => {
  test('after touch() the next request is worked out again; another company keeps its answer', async () => {
    await cache.json('alarms', 4, week, 30, counted());
    await cache.json('alarms', 5, week, 30, counted());
    expect(n).toBe(2);

    cache.touch(4);
    await new Promise(r => setImmediate(r));

    await cache.json('alarms', 4, week, 30, counted());
    await cache.json('alarms', 5, week, 30, counted());
    expect(n).toBe(3);
  });

  describe('invalidateOnWrite', () => {
    const run = async ({ method = 'POST', path = '/api/tickets', status = 200, user = { company_id: 4 } } = {}) => {
      const seen = {};
      const req = { method, path, user };
      const res = {
        statusCode: status,
        end: jest.fn(async () => { seen.version = await redis.get('dash:ver:4'); })
      };
      cache.invalidateOnWrite(req, res, () => {});
      await res.end('{}');
      await new Promise(r => setImmediate(r));
      return { seen, version: await redis.get('dash:ver:4') };
    };

    test('a write that succeeds touches the company — before the response leaves', async () => {
      const { seen, version } = await run();
      expect(version).toBe('1');
      // the reload that follows the answer can never be handed the old one
      expect(seen.version).toBe('1');
    });

    test.each([
      ['a read', { method: 'GET' }],
      ['a write that failed', { status: 400 }],
      ['signing in', { path: '/api/auth/refresh' }],
      ['the machines\' device API', { path: '/api/device/v1/backup' }],
      ['marking notifications read', { path: '/api/notifications/read-all' }],
      ['no company (S&T)', { user: { company_id: null } }]
    ])('%s touches nothing', async (_label, over) => {
      const { version } = await run(over);
      expect(version).toBeNull();
    });
  });
});

describe('without Redis', () => {
  test('every request is worked out, and none fails', async () => {
    redis.status = 'reconnecting';
    await cache.json('alarms', 4, week, 30, counted());
    await cache.json('alarms', 4, week, 30, counted());
    expect(n).toBe(2);
    expect(() => cache.touch(4)).not.toThrow();
  });

  test('a Redis that errors is a miss, not an error', async () => {
    const get = redis.get;
    redis.get = async () => { throw new Error('ECONNRESET'); };
    try {
      await expect(cache.json('alarms', 4, week, 30, counted())).resolves.toBe(JSON.stringify({ ok: true, n: 1 }));
    } finally {
      redis.get = get;
    }
  });
});

describe('how long an answer is kept', () => {
  const now = new Date('2026-10-09T06:30:00Z');   // 12:00 IST

  test('a range ending before today (plant time) is history: 5 minutes', () => {
    expect(cache.ttlFor({ from: '2026-10-01', to: '2026-10-08' }, now)).toBe(cache.PAST_TTL);
  });

  test.each([
    ['ending today', { from: '2026-10-03', to: '2026-10-09' }],
    ['no dates (the last days, up to now)', {}],
    ['a date that is not one', { to: 'yesterday' }]
  ])('%s: 30 s', (_label, q) => {
    expect(cache.ttlFor(q, now)).toBe(cache.LIVE_TTL);
  });

  test('today is the plant\'s: 23:30 UTC on the 8th is already the 9th in India', () => {
    const lateUtc = new Date('2026-10-08T23:30:00Z');
    expect(cache.plantToday(lateUtc)).toBe('2026-10-09');
    expect(cache.ttlFor({ to: '2026-10-08' }, lateUtc)).toBe(cache.PAST_TTL);
  });
});
