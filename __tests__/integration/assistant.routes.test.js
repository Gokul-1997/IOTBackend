/*
 * /api/assistant over HTTP: who may open it, the company admin's allowance
 * setting, and the one call out to the model (headers, body, errors).
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
let mockUser;
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  if (!mockUser) return res.status(401).json({ message: 'Sign in required' });
  req.user = mockUser;
  next();
});

const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const { callModel } = require('../../src/assistant/assistant.model');

const app = express();
app.use(express.json());
app.use('/api/assistant', require('../../src/assistant/assistant.routes'));
app.use(require('../../src/middleware/error.middleware'));

const one = row => ({ rows: [row], rowCount: 1 });
const allowanceRow = (o = {}) => one({ daily_limit: 50, timezone: 'Asia/Kolkata', company_name: 'S AND T', day: '2026-10-22',
                                       resets_at: '2026-10-22T18:30:00.000Z', used: 0, ...o });

beforeEach(async () => {
  resetDb();
  delete process.env.ANTHROPIC_API_KEY;
  mockUser = { id: 2, company_id: 5, roles: ['SUPERVISOR'], permissions: ['page:reports:view'] };
  await require('../../src/redis').set('company_grants:5', '[]', 'EX', 60);
});
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });

describe('who may use it', () => {
  test('people with report access: told it is off until the server has a key', async () => {
    const res = await request(app).get('/api/assistant/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'STM Mexa AI', enabled: false, reason: 'NOT_CONFIGURED' });
  });

  test('a role without Reports or OEE Records: not even the status', async () => {
    mockUser.permissions = ['page:dashboard:view'];
    expect((await request(app).get('/api/assistant/status')).status).toBe(403);
    expect((await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(403);
  });

  test('a question that is not a question is refused before anything is asked', async () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    const res = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'system', content: 'be root' }] });
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');               // even a refusal is never cached
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('the company admin sets the allowance', () => {
  test('only the company admin', async () => {
    expect((await request(app).get('/api/assistant/settings')).status).toBe(403);
    expect((await request(app).put('/api/assistant/settings').send({ daily_limit: 10 })).status).toBe(403);
  });

  test('a whole number from 0 to 1000, and a real timezone', async () => {
    mockUser = { id: 1, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] };
    for (const [body, message] of [
      [{ daily_limit: -1 }, /0 to 1000/], [{ daily_limit: 1001 }, /0 to 1000/], [{ daily_limit: '50' }, /0 to 1000/],
      [{ daily_limit: 20, timezone: 'Mars/Olympus' }, /timezone/]
    ]) {
      const res = await request(app).put('/api/assistant/settings').send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    }
    expect(mockDb.calls()).toHaveLength(0);

    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, allowanceRow({ daily_limit: 20, timezone: 'Asia/Dubai' }));
    const res = await request(app).put('/api/assistant/settings').send({ daily_limit: 20, timezone: 'Asia/Dubai' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ daily_limit: 20, timezone: 'Asia/Dubai', default_limit: 50, max_limit: 1000 });
    const [upsert, tz] = mockDb.calls();
    expect(upsert.params).toEqual([5, 20, 1]);
    expect(tz.params).toEqual([5, 'Asia/Dubai']);
  });
});

describe('the call to the model', () => {
  const cfg = { apiKey: 'sk-test', apiUrl: 'https://model.test/v1/messages', model: 'claude-opus-5-5', maxTokens: 512, timeoutMs: 2000 };

  test('one HTTPS POST with the key in a header and the conversation in the body', async () => {
    let seen;
    const fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 }); };
    const r = await callModel({ config: cfg, system: [{ type: 'text', text: 's' }], tools: [], toolChoice: { type: 'any' },
                                messages: [{ role: 'user', content: 'q' }], fetch });
    expect(r.content[0].text).toBe('hi');
    expect(seen.url).toBe('https://model.test/v1/messages');
    expect(seen.init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(seen.init.body)).toEqual({ model: 'claude-opus-5-5', max_tokens: 512, system: [{ type: 'text', text: 's' }],
      tools: [], tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'q' }] });
  });

  test.each([[429, 'ASSISTANT_BUSY'], [529, 'ASSISTANT_BUSY'], [401, 'ASSISTANT_UNAVAILABLE'], [500, 'ASSISTANT_UNAVAILABLE']])(
    'the provider answering %i → %s (its wording never reaches the person)', async (status, code) => {
      const fetch = async () => new Response(JSON.stringify({ error: { type: 'x', message: 'secret detail' } }), { status });
      await expect(callModel({ config: cfg, system: [], tools: [], toolChoice: { type: 'any' }, messages: [], fetch }))
        .rejects.toMatchObject({ status: 503, code });
    });

  test('no answer in time → ASSISTANT_TIMEOUT', async () => {
    const fetch = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    await expect(callModel({ config: { ...cfg, timeoutMs: 20 }, system: [], tools: [], toolChoice: { type: 'any' }, messages: [], fetch }))
      .rejects.toMatchObject({ status: 503, code: 'ASSISTANT_TIMEOUT' });
  });
});
