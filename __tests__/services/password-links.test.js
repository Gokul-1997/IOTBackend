const crypto = require('crypto');
const { frontendUrl, createPasswordLink, SETUP_TTL_MS, RESET_TTL_MS } = require('../../src/lib/password-links');
const { generatePasswordEmail } = require('../../src/utils/nodemailer/emailTemplates/passwordEmail');

const originalEnv = { ...process.env };
beforeEach(() => { delete process.env.PUBLIC_FRONTEND_URL; delete process.env.FRONTEND_URL; });
afterEach(() => { process.env = { ...originalEnv }; });

test('a legacy origin list produces one public URL, never a comma or localhost', () => {
  process.env.NODE_ENV = 'production';
  process.env.FRONTEND_URL = 'http://localhost:4200,https://stmmexa.stmcnc.com,https://other.example.com';
  const link = createPasswordLink({ setup: true });
  expect(link.url).toMatch(/^https:\/\/stmmexa.stmcnc.com\/reset-password\/[a-f0-9]{64}\?mode=setup$/);
  expect(link.url).not.toContain(',');
});

test('the dedicated public URL wins and supports an application base path', () => {
  process.env.PUBLIC_FRONTEND_URL = 'https://factory.example.com/iot/';
  process.env.FRONTEND_URL = 'http://localhost:4200';
  expect(frontendUrl()).toBe('https://factory.example.com/iot');
});

test.each([
  'javascript:alert(1)', 'https://user:secret@example.com', 'http://localhost:4200',
  'https://site.example.com,http://localhost:4200', 'https://example.com/?redirect=https://bad.test',
  'https://stmmexa.stmcnc.comhttps://other.example.com', 'https://example.com/#fragment'
])('invalid public URL is rejected before an account is created: %s', value => {
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_FRONTEND_URL = value;
  expect(() => createPasswordLink()).toThrow(/PUBLIC_FRONTEND_URL/);
});

test('only a SHA-256 digest is stored and setup/reset use their advertised expiry', () => {
  const now = Date.now();
  for (const [setup, ttl] of [[true, SETUP_TTL_MS], [false, RESET_TTL_MS]]) {
    const link = createPasswordLink({ setup });
    const token = new URL(link.url).pathname.split('/').pop();
    expect(link.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(link.tokenHash).not.toBe(token);
    expect(link.expiresAt.getTime()).toBeGreaterThanOrEqual(now + ttl);
    expect(link.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ttl);
  }
  expect(createPasswordLink().tokenHash).not.toBe(createPasswordLink().tokenHash);
});

test.each([true, false])('email has matching HTML/text actions, branding and expiry; setup=%s', setup => {
  const link = createPasswordLink({ setup }).url;
  const { html, text } = generatePasswordEmail({ link, email: 'admin@example.test', companyName: 'Example Engineering', setup });
  const action = setup ? 'Set your password' : 'Reset password';
  for (const body of [html, text]) {
    expect(body).toContain(action);
    expect(body).toContain(link);
    expect(body).toContain(setup ? '24 hours' : '15 minutes');
    expect(body).toContain('STM Mexa IoT');
    expect(body).not.toMatch(/Kovai|Brew Cafe|Password:|localhost|auto-generated password/);
  }
  if (!setup) expect(text).toContain('Your password will stay the same');
});

test('customer-controlled company and email text cannot insert HTML', () => {
  const { html } = generatePasswordEmail({
    link: 'https://example.test/reset-password/abc?mode=setup&test=1', setup: true,
    email: '<img src=x onerror=alert(1)>', companyName: '<script>alert(1)</script>'
  });
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('mode=setup&amp;test=1');
});
