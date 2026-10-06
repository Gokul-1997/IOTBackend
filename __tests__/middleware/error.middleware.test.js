/*
 * What a caller sees when something fails. An unexpected error's message is
 * for the log, not the caller: Postgres text ("column x does not exist") is a
 * map of the schema.
 */
const express = require('express');
const request = require('supertest');
const errorMiddleware = require('../../src/middleware/error.middleware');

function appThrowing(err) {
  const app = express();
  app.get('/x', (_req, _res, next) => next(err));
  app.use(errorMiddleware);
  return app;
}

let logged;
beforeEach(() => { logged = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => logged.mockRestore());

test('an unexpected error: a plain message and a reference, the details only in the log', async () => {
  const err = Object.assign(new Error('column "secret_col" does not exist'), { code: '42703' });
  const res = await request(appThrowing(err)).get('/x');
  expect(res.status).toBe(500);
  expect(res.body.message).toBe('Something went wrong on the server. Please try again.');
  expect(JSON.stringify(res.body)).not.toMatch(/secret_col|42703/);
  expect(res.body.ref).toMatch(/^[0-9a-f]{8}$/);
  expect(logged.mock.calls[0][0]).toContain(res.body.ref);
});

test('a deliberate error keeps its status, message and application code', async () => {
  const res = await request(appThrowing({ status: 400, code: 'RANGE_TOO_LARGE', message: 'Pick 92 days or fewer', days: 120, max_days: 92 })).get('/x');
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ status: 'error', message: 'Pick 92 days or fewer', code: 'RANGE_TOO_LARGE', days: 120, max_days: 92 });
});

test('a database error code is never forwarded, even with a status', async () => {
  const res = await request(appThrowing(Object.assign(new Error('duplicate key'), { code: '23505' }))).get('/x');
  expect(res.body.code).toBeUndefined();
});
