jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { EventEmitter } = require('node:events');
const { mockDb, resetDb } = require('../helpers/mockDb');
const history = require('../../src/assistant/assistant.history');
const allowance = require('../../src/assistant/assistant.allowance');
const validate = require('../../src/middleware/validate.middleware');
const sendError = require('../../src/utils/controller-error');

const user = { id: 2, company_id: 5, plant_id: 7, roles: ['SUPERVISOR'],
  permissions: ['page:reports:view', 'page:assistant:view'], company_permissions: ['page:reports:view'], auth_revision: '1' };
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
beforeEach(resetDb);
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test.each([
  { company_id: 9 }, { plant_id: 8 }, { auth_revision: '2' },
  { roles: ['OPERATOR'] }, { permissions: ['page:assistant:view'] }, { company_permissions: [] }
])('old AI replies cannot be reused after scope changes: %j', changed => {
  const sig = history.sign(user, 'Private report');
  expect(history.verify({ ...user, ...changed }, 'Private report', sig)).toBe(false);
});
test('reordering unchanged permissions keeps a genuine reply valid', () => {
  expect(history.verify({ ...user, permissions: [...user.permissions].reverse() }, 'Report', history.sign(user, 'Report'))).toBe(true);
});

test('company question reservation is serialized in a short transaction', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [{ questions: 1 }] }, { rows: [] });
  await expect(allowance.reserveQuestion(user, { day: '2026-10-23', limit: 50 })).resolves.toBeNull();
  const calls = mockDb.allCalls();
  expect(calls[0].text).toBe('BEGIN');
  expect(calls[1].text).toMatch(/pg_advisory_xact_lock/);
  expect(calls[1].params).toEqual([5]);
  expect(calls[2].text).toMatch(/INSERT INTO assistant_usage/);
  expect(calls.at(-1).text).toBe('COMMIT');
  const client = await mockDb.connect.mock.results[0].value;
  expect(client.release).toHaveBeenCalledTimes(1);
});
test('a failed reservation rolls back and releases its connection', async () => {
  mockDb.queueResponse({ rows: [] });
  mockDb.queueError(new Error('database unavailable'));
  await expect(allowance.reserveQuestion(user, { day: '2026-10-23', limit: 50 })).rejects.toThrow('database unavailable');
  expect(mockDb.allCalls().at(-1).text).toBe('ROLLBACK');
  const client = await mockDb.connect.mock.results[0].value;
  expect(client.release).toHaveBeenCalledTimes(1);
});
test('a losing last-answer reservation records cost without granting another answer', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [{ answers: 50 }] });
  const result = await allowance.record(user, { day: '2026-10-23', limit: 50, used: 49 }, { answered: true, inputTokens: 100 });
  expect(result).toMatchObject({ answer_limited: true, used: 50, remaining: 0 });
  expect(mockDb.calls().map(c => c.params[3])).toEqual([1, 0]);
});

test.each([['bad@example.com'], { email: 'bad@example.com' }, true])('string validation refuses a non-string: %j', value => {
  const res = response(), next = jest.fn();
  validate({ email: { type: 'string', email: true } })({ body: { email: value } }, res, next);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(next).not.toHaveBeenCalled();
});
test.each([[], {}, true, 'Infinity', '1e999', ' '])('numeric validation refuses unsafe coercion: %j', value => {
  const res = response(), next = jest.fn();
  validate({ count: { type: 'number' } })({ body: { count: value } }, res, next);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(next).not.toHaveBeenCalled();
});
test.each([500, 503])('internal error details stay out of %i responses', status => {
  const res = response();
  sendError(Object.assign(new Error('password=secret; SELECT hidden_column'), { status }), { method: 'GET', originalUrl: '/api/users' }, res);
  expect(res.status).toHaveBeenCalledWith(status);
  expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/secret|SELECT|hidden_column/);
  expect(res.json.mock.calls[0][0].ref).toMatch(/^[0-9a-f]{8}$/);
});
test('a public input refusal keeps the existing response shape', () => {
  const res = response();
  sendError({ status: 403, message: 'Access denied' }, {}, res, { success: false });
  expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Access denied' });
});

test('an established live socket disconnects at access-token expiry', async () => {
  jest.useFakeTimers();
  mockDb.query.mockResolvedValue({ rows: [{ is_active: true, company_active: true, auth_revision: '1' }] });
  const io = { use: jest.fn(), on: jest.fn() };
  require('../../src/lib/socket-server').attach(io, { db: mockDb });
  const socket = new EventEmitter();
  socket.user = { user_id: 2, company_id: 5, auth_revision: '1', exp: Math.floor(Date.now() / 1000) + 1 };
  socket.connected = true;
  socket.join = jest.fn(); socket.leave = jest.fn();
  socket.disconnect = jest.fn(() => { socket.connected = false; socket.emit('disconnect'); });
  io.on.mock.calls.find(([event]) => event === 'connection')[1](socket);
  await Promise.resolve();
  expect(socket.disconnect).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1001);
  expect(socket.disconnect).toHaveBeenCalledWith(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('an oversized model response is aborted before it can be buffered indefinitely', async () => {
  const http = require('node:http');
  const model = require('../../src/assistant/assistant.model');
  const req = new EventEmitter(), res = new EventEmitter();
  res.statusCode = 200; res.destroy = jest.fn();
  req.destroy = jest.fn(error => req.emit('error', error));
  jest.spyOn(http, 'request').mockImplementation((_url, _options, callback) => {
    req.end = () => { callback(res); res.emit('data', Buffer.alloc(model.MAX_RESPONSE_BYTES + 1)); };
    return req;
  });
  await expect(model.post('http://model.test')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  expect(req.destroy).toHaveBeenCalled();
  expect(res.destroy).toHaveBeenCalled();
});
test('a cancelled question aborts its provider request', async () => {
  const controller = new AbortController();
  const fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))));
  const result = require('../../src/assistant/assistant.model').callModel({ config: { apiUrl: 'https://model.test', timeoutMs: 2000 }, signal: controller.signal, fetch });
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: 'ASSISTANT_TIMEOUT' });
});
