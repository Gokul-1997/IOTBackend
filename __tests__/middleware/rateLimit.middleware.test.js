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
