/*
 * A company's Program Transfer gateway token is made by S&T, not by the
 * company (22 Oct 2026, the user: "super admin side one program token create,
 * don't company side"): /api/companies/:id/program-gateway. One token serves
 * every machine of the company. The database is the mock.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/audit/audit.service', () => ({ log: jest.fn(async () => {}) }));
let mockUser;
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  if (!mockUser) return res.status(401).json({ message: 'Sign in required' });
  req.user = mockUser;
  next();
});

const express = require('express');
const request = require('supertest');
const { mockDb, resetDb } = require('../helpers/mockDb');
const audit = require('../../src/audit/audit.service');

const app = express();
app.use(express.json());
app.use('/api/companies', require('../../src/companies/company.routes'));
app.use(require('../../src/middleware/error.middleware'));

const one = row => ({ rows: [row], rowCount: 1 });
const none = { rows: [], rowCount: 0 };
const SNT = { id: 1, company_id: 1, is_snt_super: true, roles: ['SNT_SUPER'], permissions: [] };
const ACME_ADMIN = { id: 2, company_id: 5, is_snt_super: false, roles: ['COMPANY_ADMIN'],
                     permissions: ['page:programs:view', 'page:programs:upload', 'page:machines:edit'] };
const acme = { id: 5, company_name: 'Acme Gears', is_active: true };
const ROUTES = [['get', '/api/companies/5/program-gateway'], ['post', '/api/companies/5/program-gateway/token'],
                ['delete', '/api/companies/5/program-gateway/token']];

beforeEach(() => { resetDb(); audit.log.mockClear(); mockUser = SNT; });

test.each(ROUTES)('only S&T: a company admin — even of that company — cannot %s %s', async (method, url) => {
  mockUser = ACME_ADMIN;
  const res = await request(app)[method](url);
  expect(res.status).toBe(403);
  expect(mockDb.calls()).toHaveLength(0);
});

test('S&T makes the token: shown once, never cached, only its hash kept, and the old one stops', async () => {
  mockDb.queueResponse(one(acme), none, none, none, one({ id: 3, token_prefix: 'mxg_abcdefgh', created_at: 'T0' }), none);
  const res = await request(app).post('/api/companies/5/program-gateway/token');
  expect(res.status).toBe(201);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.token).toMatch(/^mxg_[A-Za-z0-9_-]{43}$/);
  expect(res.body).toMatchObject({ token_prefix: 'mxg_abcdefgh', created_at: 'T0', company_name: 'Acme Gears' });
  expect(mockDb.calls().find(c => /UPDATE program_gateways SET revoked_at/.test(c.text)).params).toEqual([5, 1]);
  expect(JSON.stringify(mockDb.calls())).not.toContain(res.body.token);
  expect(JSON.stringify(audit.log.mock.calls)).not.toContain(res.body.token);
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ company_id: 5, action: 'GATEWAY_TOKEN_CREATE' }));
});

test('S&T sees the gateway: its token, when it last called and from where — never the token itself', async () => {
  mockDb.queueResponse(one(acme), one({ id: 3, token_prefix: 'mxg_abcdefgh', created_at: 'T0', last_seen_at: 'T1',
                                         last_seen_ip: '203.0.113.9', agent_version: 'mexa-gateway 2', online: true }));
  const res = await request(app).get('/api/companies/5/program-gateway');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({
    company_id: 5, company_name: 'Acme Gears', poll_seconds: 15,
    gateway: { token_prefix: 'mxg_abcdefgh', token_created_at: 'T0', last_seen_at: 'T1', online: true,
               last_seen_ip: '203.0.113.9', agent_version: 'mexa-gateway 2' }
  });
  expect(mockDb.calls().every(c => !/token_hash/.test(c.text))).toBe(true);
});

test('stopping the token works once; a second time says there is none', async () => {
  mockDb.queueResponse(one(acme), one({ id: 3, token_prefix: 'mxg_abcdefgh' }));
  let res = await request(app).delete('/api/companies/5/program-gateway/token');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ revoked: true });

  mockDb.queueResponse(one(acme), none);
  res = await request(app).delete('/api/companies/5/program-gateway/token');
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ code: 'NO_TOKEN', message: 'Acme Gears has no gateway token.' });
});

test('a company that does not exist: 404, and no token is made', async () => {
  mockDb.queueResponse(none);
  const res = await request(app).post('/api/companies/99/program-gateway/token');
  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ code: 'COMPANY_NOT_FOUND' });
  expect(mockDb.calls().find(c => /program_gateways/.test(c.text))).toBeUndefined();
});
