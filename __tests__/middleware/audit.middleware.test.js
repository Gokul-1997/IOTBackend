/*
 * Tests for middleware/audit.middleware — Screens 15, 16 and 17 each
 * specify an audit trail, and until now none was written: audit.service
 * had a working log() that nothing ever called, and the table sat at zero
 * rows.
 *
 * The two things worth getting right are what gets recorded and what must
 * never be. An audit table is read by administrators and kept for years,
 * so a plaintext password in one is worse than no audit at all — it is a
 * durable copy of a secret in a place designed to be read.
 */

jest.mock('../../src/audit/audit.service', () => ({ log: jest.fn(async () => {}) }));
const audit = require('../../src/audit/audit.service');
const audited = require('../../src/middleware/audit.middleware');

function run(middleware, opts = {}) {
  const { method = 'POST', body = {}, params = {}, query = {}, status = 200 } = opts;
  // `user` must be settable to undefined, so check whether the caller
  // supplied the key rather than whether its value is falsy
  const user = 'user' in opts ? opts.user : { id: 7, company_id: 4 };
  const req = {
    method, body, params, query,
    user,
    ip: '10.0.0.5',
    headers: { 'user-agent': 'jest' }
  };
  const res = { statusCode: status, json: jest.fn(b => b) };
  const next = jest.fn();
  middleware(req, res, next);
  return { req, res, next };
}

beforeEach(() => audit.log.mockClear());

describe('what gets recorded', () => {
  test('a successful create', async () => {
    const { res } = run(audited('role'), { method: 'POST', body: { role_name: 'Setter' } });
    res.json({ id: 99 });

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0][0];
    expect(entry.action).toBe('CREATE_ROLE');
    expect(entry.resource).toBe('role');
    expect(entry.resource_id).toBe(99);
    expect(entry.user_id).toBe(7);
    expect(entry.company_id).toBe(4);
    expect(entry.new_value.body.role_name).toBe('Setter');
  });

  test('takes the id from the route when the response has no body to read', async () => {
    // a delete returns nothing useful, so :id is the only source
    const { res } = run(audited('role'), { method: 'DELETE', params: { id: '42' } });
    res.json({ status: 'success' });
    expect(audit.log.mock.calls[0][0].resource_id).toBe('42');
    expect(audit.log.mock.calls[0][0].action).toBe('DELETE_ROLE');
  });

  test('records where the change came from', async () => {
    const { res } = run(audited('user'), { method: 'PUT', params: { id: '3' } });
    res.json({ ok: true });
    const entry = audit.log.mock.calls[0][0];
    expect(entry.ip_address).toBe('10.0.0.5');
    expect(entry.user_agent).toBe('jest');
  });

  test.each([
    ['POST', 'CREATE_USER'], ['PUT', 'UPDATE_USER'],
    ['PATCH', 'UPDATE_USER'], ['DELETE', 'DELETE_USER']
  ])('%s becomes %s', (method, action) => {
    const { res } = run(audited('user'), { method });
    res.json({});
    expect(audit.log.mock.calls[0][0].action).toBe(action);
  });
});

describe('what is deliberately not recorded', () => {
  test('a GET is never audited', () => {
    const { res, next } = run(audited('role'), { method: 'GET' });
    res.json({ data: [] });
    expect(audit.log).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test.each([[400], [403], [404], [409], [500]])('a %i response is not audited', (status) => {
    // a rejected request changed nothing, and a log full of failures
    // buries the changes someone is actually looking for
    const { res } = run(audited('role'), { status });
    res.json({ message: 'nope' });
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('secrets never reach the table', () => {
  test.each([
    ['password'], ['new_password'], ['current_password'], ['confirm_password'],
    ['token'], ['refresh_token'], ['secret'], ['api_key'], ['ftp_pass'],
    ['authorization_code']
  ])('%s is redacted', (field) => {
    const { res } = run(audited('user'), { body: { username: 'a', [field]: 'hunter2' } });
    res.json({ id: 1 });

    const recorded = JSON.stringify(audit.log.mock.calls[0][0].new_value);
    expect(recorded).not.toContain('hunter2');
    expect(recorded).toContain('[redacted]');
  });

  test('redaction is case-insensitive', () => {
    const { res } = run(audited('user'), { body: { Password: 'hunter2', API_KEY: 'abc' } });
    res.json({ id: 1 });
    const recorded = JSON.stringify(audit.log.mock.calls[0][0].new_value);
    expect(recorded).not.toContain('hunter2');
    expect(recorded).not.toContain('abc');
  });

  test('reaches secrets nested inside objects', () => {
    const { res } = run(audited('company'), {
      body: { admin: { username: 'a', password: 'hunter2' } }
    });
    res.json({ id: 1 });
    expect(JSON.stringify(audit.log.mock.calls[0][0].new_value)).not.toContain('hunter2');
  });

  test('and inside arrays', () => {
    const { res } = run(audited('user'), { body: { users: [{ password: 'hunter2' }] } });
    res.json({ id: 1 });
    expect(JSON.stringify(audit.log.mock.calls[0][0].new_value)).not.toContain('hunter2');
  });

  test('non-secret fields survive intact', () => {
    const { res } = run(audited('user'), { body: { username: 'kumar', email: 'k@x.com', password: 'p' } });
    res.json({ id: 1 });
    const v = audit.log.mock.calls[0][0].new_value;
    expect(v.body.username).toBe('kumar');
    expect(v.body.email).toBe('k@x.com');
    expect(v.body.password).toBe('[redacted]');
  });

  test('deeply nested input cannot be used to exhaust the recursion', () => {
    let deep = { password: 'hunter2' };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    const { res } = run(audited('user'), { body: deep });
    expect(() => res.json({ id: 1 })).not.toThrow();
    expect(JSON.stringify(audit.log.mock.calls[0][0].new_value)).not.toContain('hunter2');
  });
});

describe('auditing never breaks the request', () => {
  test('the response is sent before the audit is written', () => {
    const { res } = run(audited('role'));
    const out = res.json({ id: 1 });
    // the caller gets its body back regardless of what the audit does
    expect(out).toEqual({ id: 1 });
  });

  test('a failing audit write does not throw into the response', () => {
    audit.log.mockRejectedValueOnce(new Error('audit table is gone'));
    const { res } = run(audited('role'));
    // the change already happened; reporting failure now would be a lie
    expect(() => res.json({ id: 1 })).not.toThrow();
  });

  test('an unauthenticated request still records the action', () => {
    const { res } = run(audited('user'), { user: undefined });
    res.json({ id: 1 });
    expect(audit.log.mock.calls[0][0].user_id).toBeNull();
  });
});
