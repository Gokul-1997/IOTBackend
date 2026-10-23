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

/** The company's grants (Manage Access) as the access check reads them. */
const grant = keys => require('../../src/redis').set('company_grants:5', JSON.stringify(keys), 'EX', 60);

beforeEach(async () => {
  resetDb();
  delete process.env.ANTHROPIC_API_KEY;
  // S&T gave the company the AI; the company admin gave it to this person's role
  mockUser = { id: 2, company_id: 5, roles: ['SUPERVISOR'], permissions: ['page:reports:view', 'page:assistant:view'] };
  await grant(['page:reports:view', 'page:assistant:view']);
});
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });

describe('who may use it', () => {
  test('people with report access: told it is off until the server has a key', async () => {
    const res = await request(app).get('/api/assistant/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'STM Mexa AI', enabled: false, reason: 'NOT_CONFIGURED' });
  });

  test('any role the company admin gave it — reports or not; S&T, with no company, may not', async () => {
    mockUser.permissions = ['page:dashboard:view', 'page:assistant:view'];
    expect((await request(app).get('/api/assistant/status')).status).toBe(200);
    mockUser = { id: 1, company_id: null, is_snt_super: true, roles: ['SNT_SUPER'], permissions: [] };
    expect((await request(app).get('/api/assistant/status')).status).toBe(403);
    expect((await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(403);
  });

  /* 23 Oct 2026, the user: "super admin decides for that company — not all users". */
  test('only a company S&T gave it to — never a company with no grants at all, whose other pages are all open', async () => {
    await grant([]);                                               // fresh, unrestricted company
    let res = await request(app).get('/api/assistant/status');
    expect([res.status, res.body.code]).toEqual([403, 'NOT_IN_PLAN']);
    await grant(['page:reports:view']);                           // S&T gave reports, not the AI
    res = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
    expect([res.status, res.body.code]).toEqual([403, 'NOT_IN_PLAN']);
    mockUser = { id: 1, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] };   // not even the company admin
    expect((await request(app).get('/api/assistant/settings')).status).toBe(403);
    expect(mockDb.calls().filter(c => !/company_permissions/.test(c.text))).toHaveLength(0);
  });

  test('in a company that has it, only the roles the company admin gave it; the company admin always', async () => {
    mockUser.permissions = ['page:reports:view'];
    expect((await request(app).get('/api/assistant/status')).body).toMatchObject({ code: 'PERMISSION_DENIED' });
    mockUser = { id: 1, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] };
    expect((await request(app).get('/api/assistant/status')).status).toBe(200);
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

  // 23 Oct 2026, the user: "50 a day — the client may lower it, never raise it"
  test('a whole number up to the platform\'s ceiling (50 unless the server says) — lower, never higher — and a real timezone', async () => {
    mockUser = { id: 1, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] };
    for (const [body, message] of [
      [{ daily_limit: -1 }, /from 0 to 50\./], [{ daily_limit: 51 }, /from 0 to 50\./], [{ daily_limit: 100 }, /from 0 to 50\./],
      [{ daily_limit: '50' }, /from 0 to 50\./], [{ daily_limit: 20, timezone: 'Mars/Olympus' }, /timezone/]
    ]) {
      const res = await request(app).put('/api/assistant/settings').send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    }
    expect(mockDb.calls()).toHaveLength(0);

    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }, allowanceRow({ daily_limit: 20, timezone: 'Asia/Dubai' }));
    const res = await request(app).put('/api/assistant/settings').send({ daily_limit: 20, timezone: 'Asia/Dubai' });
    expect(res.status).toBe(200);
    // the company's own total for the day comes with it: the admin sees it, and cannot change it
    expect(res.body.data).toEqual({ daily_limit: 20, timezone: 'Asia/Dubai', default_limit: 50, max_limit: 50, company_daily_max: 50 });
    const [upsert, tz] = mockDb.calls();
    expect(upsert.params).toEqual([5, 20, 1]);
    expect(tz.params).toEqual([5, 'Asia/Dubai']);
    // who changed what it may cost is on record
    const audit = mockDb.calls().find(c => /INSERT INTO audit_logs/.test(c.text));
    expect(audit.params.slice(0, 4)).toEqual([1, 5, 'UPDATE_ASSISTANT_SETTINGS', 'assistant_settings']);
  });

  test('S&T can raise the ceiling on the server; a stored allowance above it is used as the ceiling', async () => {
    mockUser = { id: 1, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] };
    process.env.ASSISTANT_DAILY_LIMIT_MAX = '1000';
    mockDb.queueResponse({ rows: [], rowCount: 1 }, allowanceRow({ daily_limit: 1000 }));
    expect((await request(app).put('/api/assistant/settings').send({ daily_limit: 1000 })).body.data.max_limit).toBe(1000);
    delete process.env.ASSISTANT_DAILY_LIMIT_MAX;
    resetDb();
    mockDb.queueResponse(allowanceRow({ daily_limit: 1000 }));
    expect((await request(app).get('/api/assistant/settings')).body.data).toMatchObject({ daily_limit: 50, max_limit: 50 });
  });
});

describe('how fast one person may ask', () => {
  test('six questions a minute; the seventh is refused before anything else runs', async () => {
    mockUser = { id: 77, company_id: 5, roles: ['SUPERVISOR'], permissions: ['page:assistant:view'] };
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: `q${i}` }] });
      expect(res.status).toBe(503);                              // no key on this server: turned away by the service
    }
    const seventh = await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'q7' }] });
    expect(seventh.status).toBe(429);
    expect(seventh.body).toMatchObject({ code: 'TOO_MANY_QUESTIONS', message: 'Too many questions in a short time. Wait a minute, then ask again.' });
    // another person is not held up
    mockUser = { ...mockUser, id: 78 };
    expect((await request(app).post('/api/assistant/chat').send({ messages: [{ role: 'user', content: 'q' }] })).status).toBe(503);
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

test('the model is Haiku unless the server says otherwise — the lowest cost', () => {
  const readConfig = require('../../src/assistant/assistant.config');
  delete process.env.ASSISTANT_MODEL;
  expect(readConfig().model).toBe('claude-haiku-5-5');
  process.env.ASSISTANT_MODEL = 'claude-sonnet-5-5';
  expect(readConfig().model).toBe('claude-sonnet-5-5');
  delete process.env.ASSISTANT_MODEL;
});

describe('the HTTPS call itself, without global fetch', () => {
  const http = require('node:http');
  const { post } = require('../../src/assistant/assistant.model');
  let server, url, seen;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen = { headers: req.headers, body };
        if (req.url === '/slow') return;                                  // never answers
        res.writeHead(req.url === '/refused' ? 401 : 200, { 'content-type': 'application/json' });
        res.end(req.url === '/refused' ? '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}' : '{"content":[{"type":"text","text":"OK"}]}');
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(r => server.close(r)));

  test('posts the body with its length and headers, and reads the answer', async () => {
    const res = await post(`${url}/ok`, { headers: { 'x-api-key': 'k' }, body: '{"a":"é"}' });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ content: [{ type: 'text', text: 'OK' }] });
    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength('{"a":"é"}')));
    expect(seen.headers['x-api-key']).toBe('k');
  });

  test('a refusal is kept for the server log, with the provider\'s reason', async () => {
    const cfg = { apiKey: 'bad', apiUrl: `${url}/refused`, model: 'm', maxTokens: 8, timeoutMs: 2000 };
    await expect(callModel({ config: cfg, system: [], tools: [], toolChoice: { type: 'any' }, messages: [] }))
      .rejects.toMatchObject({ status: 503, code: 'ASSISTANT_UNAVAILABLE', detail: '401 authentication_error: invalid x-api-key' });
  });

  test('no answer in time is a timeout, not a hang', async () => {
    const cfg = { apiKey: 'k', apiUrl: `${url}/slow`, model: 'm', maxTokens: 8, timeoutMs: 50 };
    await expect(callModel({ config: cfg, system: [], tools: [], toolChoice: { type: 'any' }, messages: [] }))
      .rejects.toMatchObject({ status: 503, code: 'ASSISTANT_TIMEOUT' });
  });
});

test('a key not scoped to a workspace sends the workspace the server names', () => {
  const { headersFor } = require('../../src/assistant/assistant.model');
  expect(headersFor({ apiKey: 'k' })).toEqual({ 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  expect(headersFor({ apiKey: 'k', workspaceId: 'wrkspc_01ABC' })['anthropic-workspace-id']).toBe('wrkspc_01ABC');
});

test('a key pasted into ANTHROPIC_WORKSPACE_ID is never sent as the workspace, and is flagged', () => {
  const readConfig = require('../../src/assistant/assistant.config');
  process.env.ANTHROPIC_WORKSPACE_ID = 'sk-ant-usr-SECRET';
  expect(readConfig()).toMatchObject({ workspaceId: '', workspaceIdIsKey: true, workspaceIdSet: true });
  process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01AbC';
  expect(readConfig()).toMatchObject({ workspaceId: 'wrkspc_01AbC', workspaceIdIsKey: false });
  delete process.env.ANTHROPIC_WORKSPACE_ID;
});
