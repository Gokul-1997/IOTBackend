/*
 * scripts/email-check.js — can this server send email? (27 Nov 2026: the log
 * said "535-5.7.8 Username and Password not accepted" and a new company admin
 * never got their password.) It signs in without sending, says what to do,
 * and never prints the password.
 */
const { main, optionsOf } = require('../../scripts/email-check');

let out;
beforeEach(() => { out = []; jest.spyOn(console, 'log').mockImplementation(line => out.push(String(line))); });
afterEach(() => jest.restoreAllMocks());
const text = () => out.join('\n');
const env = (extra = {}) => ({ EMAIL_USER: 'mexa.alerts@gmail.com', EMAIL_PASS: 'MyGooglePassword1', ...extra });

test('missing settings say which two lines .env needs', async () => {
  expect(await main({ env: {}, mailer: () => { throw new Error('not reached'); } })).toBe(1);
  expect(text()).toMatch(/EMAIL_USER and EMAIL_PASS must both be set/);
});

test('Gmail refusing the login explains the app password, and never prints the password', async () => {
  const refused = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted. For more information, go to 535 5.7.8 https://support.google.com/mail/?p=BadCredentials'), { code: 'EAUTH' });
  const code = await main({ env: env(), mailer: () => ({ verify: async () => { throw refused; } }) });
  expect(code).toBe(1);
  expect(text()).toMatch(/Gmail accepts only an app password/);
  expect(text()).toMatch(/myaccount\.google\.com\/apppasswords/);
  expect(text()).toMatch(/pm2 restart iot-app --update-env/);
  expect(text()).toMatch(/EMAIL_PASS has 17 letters; a Gmail app password has 16/);
  expect(text()).toMatch(/EMAIL_PASS: set, 17 characters/);
  expect(text()).not.toContain('MyGooglePassword1');
});

test('an unreachable mail server is told apart from a refused password', async () => {
  const blocked = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
  expect(await main({ env: env({ EMAIL_PASS: 'abcdefghijklmnop' }), mailer: () => ({ verify: async () => { throw blocked; } }) })).toBe(1);
  expect(text()).toMatch(/could not be reached .*port 465/);
  expect(text()).not.toMatch(/app password/);
});

test('a working sign-in says OK; --to also sends one test email', async () => {
  const sent = [];
  const mailer = () => ({ verify: async () => true, sendEmail: async m => { sent.push(m); return '250 OK'; } });
  expect(await main({ env: env({ EMAIL_PASS: 'abcd efgh ijkl mnop' }), mailer, ...optionsOf(['--to', 'me@example.com']) })).toBe(0);
  expect(text()).toMatch(/OK: the mail server accepted the sign-in/);
  expect(text()).toMatch(/contains spaces/);
  expect(sent).toEqual([expect.objectContaining({ to: 'me@example.com', subject: 'STM MEXA — test email' })]);
});
