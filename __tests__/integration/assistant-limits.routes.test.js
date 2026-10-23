/*
 * /api/companies/:id/assistant — S&T sets how much one company may use STM
 * Mexa AI: answers a day for each person, questions a day for the whole
 * company, a monthly cost limit, and the company's timezone; and sees its
 * use today and this month (23 Oct 2026, the user: "only the super admin
 * decides how much — up or down — not the company side").
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

const app = express();
app.use(express.json());
app.use('/api/companies', require('../../src/companies/company.routes'));
app.use(require('../../src/middleware/error.middleware'));

const SNT = { id: 9, company_id: null, roles: ['SNT_SUPER'], is_snt_super: true, permissions: [] };
const one = row => ({ rows: [row], rowCount: 1 });
/** What is stored for the company (null: not set by S&T yet). */
const settingsRow = (o = {}) => one({ id: 5, company_name: 'S AND T', timezone: 'Asia/Kolkata', daily_limit: null, company_daily_limit: null,
  monthly_budget_usd: null, updated_at: null, day: '2026-10-23', granted: true, ...o });
const usageRow = (o = {}) => one({ today_questions: 12, today_answers: 9, today_people: 3, month_questions: 140, month_answers: 120,
  input: '2000000', cached: '9000000', output: '300000', ...o });
const figures = (o = {}) => ({ person_daily: 50, company_daily: 50, monthly_usd: 5, ...o });

beforeEach(() => { resetDb(); mockUser = SNT; });

test('only S&T: the company admin and everyone else are refused before anything is read', async () => {
  for (const u of [{ id: 1, company_id: 5, roles: ['COMPANY_ADMIN'], permissions: [] },
                   { id: 2, company_id: 5, roles: ['SUPERVISOR'], permissions: ['page:assistant:view'] }]) {
    mockUser = u;
    expect((await request(app).get('/api/companies/5/assistant')).status).toBe(403);
    expect((await request(app).put('/api/companies/5/assistant').send(figures({ person_daily: 500, company_daily: 500 }))).status).toBe(403);
  }
  expect(mockDb.calls()).toHaveLength(0);
});

test('S&T sees the company\'s figures — the defaults until it sets its own — and its use today and this month', async () => {
  mockDb.queueResponse(settingsRow(), usageRow());
  const res = await request(app).get('/api/companies/5/assistant');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.data).toEqual({
    company_id: 5, company_name: 'S AND T', timezone: 'Asia/Kolkata', granted: true,
    person_daily: 50, company_daily: 50, monthly_usd: 5,
    defaults: { person_daily: 50, company_daily: 50, monthly_usd: 5 },
    max: { person_daily: 1000, company_daily: 10000, monthly_usd: 1000 },
    // US$: 2M input × 0.125 + 9M cache reads × 0.01 + 0.3M output × 0.50 a million = 0.25 + 0.09 + 0.15
    usage: { today: { questions: 12, answers: 9, people: 3 }, month: { questions: 140, answers: 120, spent_usd: 0.49 } },
    updated_at: null
  });
  expect(mockDb.calls()[1].params).toEqual([5, '2026-10-23']);       // the month and the day are the company's
});

test('S&T raises or lowers each figure and sets the timezone; who changed it is on record', async () => {
  mockDb.queueResponse(one({ id: 5 }), { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 },
    settingsRow({ daily_limit: 200, company_daily_limit: 500, monthly_budget_usd: '25.50', timezone: 'Asia/Dubai',
                  updated_at: '2026-10-23T10:00:00.000Z' }), usageRow());
  const res = await request(app).put('/api/companies/5/assistant').send(figures({ person_daily: 200, company_daily: 500, monthly_usd: 25.5, timezone: 'Asia/Dubai' }));
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ person_daily: 200, company_daily: 500, monthly_usd: 25.5, timezone: 'Asia/Dubai' });
  const [, upsert, tz] = mockDb.calls();
  expect(upsert.text).toMatch(/INSERT INTO assistant_settings/);
  expect(upsert.params).toEqual([5, 200, 500, 25.5, 9]);
  expect(tz.params).toEqual([5, 'Asia/Dubai']);
  const audit = mockDb.calls().find(c => /INSERT INTO audit_logs/.test(c.text));
  expect(audit.params.slice(0, 5)).toEqual([9, null, 'UPDATE_ASSISTANT_SETTINGS', 'assistant_settings', '5']);
});

test('each figure from 0 (the AI off for the company) up to the server\'s ceiling, money to the cent, a real timezone — nothing saved otherwise', async () => {
  for (const [body, message] of [
    [figures({ person_daily: -1 }), /each person must be a whole number from 0 to 1000\./],
    [figures({ person_daily: 1001 }), /each person must be a whole number from 0 to 1000\./],
    [figures({ person_daily: '50' }), /each person/],
    [figures({ company_daily: 10001 }), /whole company must be a whole number from 0 to 10000\./],
    [figures({ company_daily: 2.5 }), /whole company/],
    [figures({ monthly_usd: 1000.01 }), /monthly limit must be an amount in US\$ from 0 to 1000, to the cent\./],
    [figures({ monthly_usd: 5.555 }), /to the cent/],
    [figures({ monthly_usd: '5' }), /monthly limit/],
    [figures({ timezone: 'Mars/Olympus' }), /timezone/]
  ]) {
    const res = await request(app).put('/api/companies/5/assistant').send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  }
  expect(mockDb.calls()).toHaveLength(0);

  mockDb.queueResponse(one({ id: 5 }), { rows: [], rowCount: 1 }, settingsRow({ daily_limit: 0, company_daily_limit: 0, monthly_budget_usd: '0.00' }), usageRow());
  const off = await request(app).put('/api/companies/5/assistant').send(figures({ person_daily: 0, company_daily: 0, monthly_usd: 0 }));
  expect(off.body.data).toMatchObject({ person_daily: 0, company_daily: 0, monthly_usd: 0 });
});

test('a company that is not there: 404, and nothing is written', async () => {
  mockDb.queueResponse({ rows: [], rowCount: 0 });
  expect((await request(app).put('/api/companies/77/assistant').send(figures())).status).toBe(404);
  expect(mockDb.calls().filter(c => /assistant_settings/.test(c.text))).toHaveLength(0);
  mockDb.queueResponse({ rows: [], rowCount: 0 });
  expect((await request(app).get('/api/companies/77/assistant')).status).toBe(404);
  expect((await request(app).get('/api/companies/abc/assistant')).status).toBe(404);
});

test('the server\'s ceiling bounds S&T too, and holds what is stored above it', async () => {
  process.env.ASSISTANT_COMPANY_DAILY_MAX = '100';
  try {
    const res = await request(app).put('/api/companies/5/assistant').send(figures({ company_daily: 101 }));
    expect(res.body.message).toMatch(/from 0 to 100\./);
    mockDb.queueResponse(settingsRow({ company_daily_limit: 500 }), usageRow());
    expect((await request(app).get('/api/companies/5/assistant')).body.data).toMatchObject({ company_daily: 100, max: { company_daily: 100 } });
  } finally { delete process.env.ASSISTANT_COMPANY_DAILY_MAX; }
});
