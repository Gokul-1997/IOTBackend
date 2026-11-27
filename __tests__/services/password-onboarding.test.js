jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('bcrypt', () => ({ hash: jest.fn(async () => 'unexposed-password-hash') }));
jest.mock('../../src/utils/nodemailer', () => ({ sendEmail: jest.fn(async () => {}), sendBulkEmails: jest.fn(async () => []) }));
jest.mock('../../src/roles/role.service', () => ({ createDefaultRolesForCompany: jest.fn(async () => []) }));
jest.mock('../../src/lib/auth-revision', () => ({ invalidateUsers: jest.fn(async () => {}), revisionOf: jest.fn() }));

const { mockDb, resetDb } = require('../helpers/mockDb');
const { sendEmail, sendBulkEmails } = require('../../src/utils/nodemailer');
const bcrypt = require('bcrypt');
const company = require('../../src/companies/company.service');
const auth = require('../../src/auth/auth.service');
const crypto = require('crypto');
const customer = { company_code: 'EX', company_name: 'Example Engineering', admin_username: 'admin', admin_email: 'admin@example.test' };

beforeEach(() => { resetDb(); jest.clearAllMocks(); });

function queueCompany() {
  mockDb.queueResponse({}, { rows: [], rowCount: 0 }, { rows: [{ id: 42 }] },
    { rows: [{ id: 77, username: 'admin', email: customer.admin_email }] },
    { rows: [], rowCount: 0 }, { rows: [] });
}

test('company creation commits a hashed setup link, then emails the link without disclosing a password', async () => {
  queueCompany();
  sendEmail.mockImplementationOnce(async () => {
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });
  const result = await company.create(customer);
  const mail = sendEmail.mock.calls[0][0];
  const token = mail.html.match(/reset-password\/([a-f0-9]{64})\?mode=setup/)[1];
  const insert = mockDb.calls().find(c => /INSERT INTO password_reset_tokens/.test(c.text));
  expect(insert.params[0]).toBe(77);
  expect(insert.params[1]).toBe(crypto.createHash('sha256').update(token).digest('hex'));
  expect(result).toMatchObject({ id: 42, welcome_email: 'sent', admin_user: { id: 77 } });
  const initialSecret = bcrypt.hash.mock.calls[0][0];
  expect(initialSecret).toMatch(/^[a-f0-9]{64}$/);
  for (const exposed of [JSON.stringify(result), mail.html, mail.text]) {
    expect(exposed).not.toContain(initialSecret);
    expect(exposed).not.toContain('unexposed-password-hash');
  }
  expect(JSON.stringify(result)).not.toContain(token);
});

test('a failed setup token write rolls back the account and sends no email', async () => {
  queueCompany();
  mockDb.queueResponse({}, new Error('token insert failed'));
  await expect(company.create(customer)).rejects.toThrow('token insert failed');
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  expect(sendEmail).not.toHaveBeenCalled();
});

test('forgot password replaces old links inside a transaction and does not change the password', async () => {
  mockDb.queueResponse({ rows: [{ id: 77, email: customer.admin_email }], rowCount: 1 });
  await auth.sendResetLink(customer.admin_email);
  const calls = mockDb.allCalls();
  expect(calls.some(c => /pg_advisory_xact_lock/.test(c.text))).toBe(true);
  expect(calls.at(-1).text).toBe('COMMIT');
  expect(calls.some(c => /UPDATE users SET password_hash/.test(c.text))).toBe(false);
  const mail = sendBulkEmails.mock.calls[0][0];
  expect(mail).toMatchObject({ recipients: [customer.admin_email], subject: 'Reset your STM Mexa IoT password' });
  expect(mail.html).toContain('15 minutes');
  expect(mail.text).toContain('Your password will stay the same');
  const token = mail.text.match(/reset-password\/([a-f0-9]{64})/)[1];
  expect(calls.find(c => /INSERT INTO password_reset_tokens/.test(c.text)).params[1]).not.toBe(token);
});

test('unknown/inactive accounts receive no email and no reset token', async () => {
  mockDb.queueResponse({ rows: [], rowCount: 0 });
  await auth.sendResetLink('unknown@example.test');
  expect(sendBulkEmails).not.toHaveBeenCalled();
  expect(mockDb.connect).not.toHaveBeenCalled();
  expect(mockDb.calls()[0].text).toMatch(/u.is_active = true/);
});

test('using a link atomically claims it, invalidates all other links and revokes sessions', async () => {
  mockDb.queueResponse({}, { rows: [{ user_id: 77 }], rowCount: 1 }, { rows: [{ user_id: 77 }], rowCount: 1 });
  await auth.resetPassword('test-single-use-token', 'new-password-123');
  const calls = mockDb.allCalls();
  expect(calls.findIndex(c => /pg_advisory_xact_lock/.test(c.text)))
    .toBeLessThan(calls.findIndex(c => /RETURNING user_id/.test(c.text)));
  expect(calls.find(c => /RETURNING user_id/.test(c.text)).text).toMatch(/expires_at > NOW\(\) AND used = false/);
  expect(calls.some(c => /UPDATE users SET password_hash/.test(c.text))).toBe(true);
  expect(calls.some(c => /used = true WHERE user_id/.test(c.text))).toBe(true);
  expect(calls.some(c => /UPDATE user_sessions SET revoked = true/.test(c.text))).toBe(true);
  expect(calls.at(-1).text).toBe('COMMIT');
});

test.each(['expired', 'already used'])('%s links cannot change a password', async () => {
  mockDb.queueResponse({}, { rows: [{ user_id: 77 }], rowCount: 1 }, { rows: [], rowCount: 0 });
  await expect(auth.resetPassword('invalid-link', 'new-password-123')).rejects.toMatchObject({ status: 400 });
  expect(mockDb.calls().some(c => /UPDATE users SET password_hash/.test(c.text))).toBe(false);
  expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
});
