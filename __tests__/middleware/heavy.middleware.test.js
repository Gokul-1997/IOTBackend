/*
 * Heavy requests (exports, reports, long telemetry windows) run a few at a
 * time per company and overall, so one company's reporting cannot take every
 * database connection from the others.
 */
const { EventEmitter } = require('events');
const { createHeavyLimiter } = require('../../src/middleware/heavy.middleware');

function reqRes(company_id, user_id = 1) {
  const res = new EventEmitter();
  res.headersSent = false;
  res.status = jest.fn(code => { res.code = code; return res; });
  res.json = jest.fn(() => { res.headersSent = true; res.emit('finish'); return res; });
  return { req: { user: { id: user_id, company_id } }, res };
}

/** Starts a request; returns whether it got through and a way to finish it. */
function run(limiter, company) {
  const { req, res } = reqRes(company);
  const r = { started: false, res, finish: () => res.emit('finish') };
  limiter(req, res, () => { r.started = true; });
  return r;
}

afterEach(() => jest.useRealTimers());

test('a company runs its limit at once; the next waits for one of them to finish', () => {
  const limiter = createHeavyLimiter({ perCompany: 2, overall: 8 });
  const a = [run(limiter, 1), run(limiter, 1), run(limiter, 1)];
  expect(a.map(r => r.started)).toEqual([true, true, false]);
  a[0].finish();
  expect(a[2].started).toBe(true);
  expect(limiter.stats()).toMatchObject({ running: 2, waiting: 0 });
});

test('a company at its limit does not hold up another company behind it', () => {
  const limiter = createHeavyLimiter({ perCompany: 2, overall: 8 });
  run(limiter, 1); run(limiter, 1);
  const waitingA = run(limiter, 1);
  const b = run(limiter, 2);
  expect(waitingA.started).toBe(false);
  expect(b.started).toBe(true);
});

test('the overall limit holds across companies; the line is first come, first served', () => {
  const limiter = createHeavyLimiter({ perCompany: 3, overall: 3 });
  const first = [run(limiter, 1), run(limiter, 2), run(limiter, 3)];
  const c4 = run(limiter, 4), c5 = run(limiter, 5);
  expect([c4.started, c5.started]).toEqual([false, false]);
  first[1].finish();
  expect([c4.started, c5.started]).toEqual([true, false]);
});

test('a finished or abandoned request frees its place once, however it ends', () => {
  const limiter = createHeavyLimiter({ perCompany: 1, overall: 8 });
  const a = run(limiter, 1);
  a.res.emit('finish');
  a.res.emit('close');
  expect(limiter.stats().running).toBe(0);
});

test('a long wait is answered 503 and a long line 429, with a code the app can show', () => {
  jest.useFakeTimers();
  const limiter = createHeavyLimiter({ perCompany: 1, overall: 1, maxWaitMs: 1000, maxQueue: 1 });
  run(limiter, 1);
  const waiting = run(limiter, 2);
  const turnedAway = run(limiter, 3);
  expect(turnedAway.res.code).toBe(429);
  jest.advanceTimersByTime(1000);
  expect(waiting.res.code).toBe(503);
  expect(waiting.res.json.mock.calls[0][0].code).toBe('REPORTS_BUSY');
  expect(limiter.stats().waiting).toBe(0);
});

test('someone who closes the page leaves the line', () => {
  const limiter = createHeavyLimiter({ perCompany: 1, overall: 8 });
  const a = run(limiter, 1);
  const b = run(limiter, 1);
  b.res.emit('close');
  a.finish();
  expect(b.started).toBe(false);
  expect(limiter.stats()).toMatchObject({ running: 0, waiting: 0 });
});

test('the spindle panel is limited only over long ranges', () => {
  const heavy = require('../../src/middleware/heavy.middleware');
  const guard = heavy.forRanges('12h', '24h');
  const next = jest.fn();
  const { res } = reqRes(1);
  guard({ query: { range: '1h' }, user: { company_id: 1 } }, res, next);
  expect(next).toHaveBeenCalledTimes(1);
});
