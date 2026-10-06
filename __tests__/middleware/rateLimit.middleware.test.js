/*
 * The rate limiters keep their counts in Redis. Redis connected but slow
 * (every command timing out) used to fail each request with a 500 — the
 * whole API down for a cache. Requests must go through instead.
 */
jest.mock('../../src/redis', () => ({
  status: 'ready',
  // the scripts loaded at start-up; every later command times out
  call: jest.fn(command => command === 'SCRIPT'
    ? Promise.resolve('sha')
    : Promise.reject(new Error('Command timed out'))),
}));

const express = require('express');
const request = require('supertest');
const { standardLimiter, authLimiter } = require('../../src/middleware/rateLimit.middleware');

function appWith(limiter) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

test('TC-RL-01 standard limiter lets requests through when Redis times out', async () => {
  const res = await request(appWith(standardLimiter)).get('/ping');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('TC-RL-02 auth limiter lets requests through when Redis times out', async () => {
  const res = await request(appWith(authLimiter)).get('/ping');
  expect(res.status).toBe(200);
});

/*
 * Who a request is counted against. By address alone, a whole factory behind
 * one public address shared one allowance (95 % of 100 users' requests were
 * refused in the load test).
 */
describe('whoIsAsking', () => {
  const jwt = jest.requireActual('jsonwebtoken');
  const { whoIsAsking } = require('../../src/middleware/rateLimit.middleware');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'rl-test-secret';
  const req = (auth, ip = '203.0.113.7') => ({ ip, headers: auth ? { authorization: auth } : {} });

  test('a signed-in user is counted as themselves, wherever they connect from', () => {
    const t = jwt.sign({ user_id: 42 }, process.env.JWT_SECRET);
    expect(whoIsAsking(req(`Bearer ${t}`))).toBe('user:42');
    expect(whoIsAsking(req(`Bearer ${t}`, '198.51.100.9'))).toBe('user:42');
  });

  test('two people behind the same factory address are two allowances', () => {
    const a = jwt.sign({ user_id: 1 }, process.env.JWT_SECRET);
    const b = jwt.sign({ user_id: 2 }, process.env.JWT_SECRET);
    expect(whoIsAsking(req(`Bearer ${a}`))).not.toBe(whoIsAsking(req(`Bearer ${b}`)));
  });

  test('no token, or one that does not verify, is counted by address', () => {
    expect(whoIsAsking(req())).toMatch(/^ip:/);
    expect(whoIsAsking(req(`Bearer ${jwt.sign({ user_id: 1 }, 'forged')}`))).toMatch(/^ip:/);
    expect(whoIsAsking(req('Bearer junk'))).toMatch(/^ip:/);
  });
});
