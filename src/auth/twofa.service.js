const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../db');

const APP_NAME = process.env.APP_NAME || 'IoT Platform';

exports.setup2FA = async (user_id, email) => {
  const secret = speakeasy.generateSecret({ name: `${APP_NAME} (${email})`, length: 20 });

  // Store secret (not yet enabled)
  await db.query(
    `INSERT INTO user_2fa (user_id, secret, is_enabled)
     VALUES ($1, $2, false)
     ON CONFLICT (user_id)
     DO UPDATE SET secret = EXCLUDED.secret, is_enabled = false, updated_at = NOW()`,
    [user_id, secret.base32]
  );

  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
  return { secret: secret.base32, qrDataUrl };
};

exports.verify2FA = async (user_id, token) => {
  const res = await db.query(`SELECT secret FROM user_2fa WHERE user_id = $1`, [user_id]);
  if (!res.rowCount) throw { status: 400, message: '2FA not set up' };

  const verified = speakeasy.totp.verify({
    secret: res.rows[0].secret,
    encoding: 'base32',
    token,
    window: 1
  });
  return verified;
};

exports.enable2FA = async (user_id, token) => {
  const valid = await exports.verify2FA(user_id, token);
  if (!valid) throw { status: 400, message: 'Invalid TOTP code' };

  // Generate hashed backup codes
  const rawCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
  const hashedCodes = rawCodes.map(c => crypto.createHash('sha256').update(c).digest('hex'));

  await db.query(
    `UPDATE user_2fa SET is_enabled = true, backup_codes = $1, enabled_at = NOW(), updated_at = NOW()
     WHERE user_id = $2`,
    [hashedCodes, user_id]
  );

  return { backup_codes: rawCodes };
};

exports.disable2FA = async (user_id) => {
  await db.query(
    `UPDATE user_2fa SET is_enabled = false, backup_codes = NULL, updated_at = NOW()
     WHERE user_id = $1`,
    [user_id]
  );
};

exports.get2FAStatus = async (user_id) => {
  const res = await db.query(
    `SELECT is_enabled, enabled_at FROM user_2fa WHERE user_id = $1`, [user_id]
  );
  if (!res.rowCount) return { enabled: false };
  return { enabled: res.rows[0].is_enabled, enabled_at: res.rows[0].enabled_at };
};

exports.useBackupCode = async (user_id, code) => {
  const res = await db.query(`SELECT backup_codes FROM user_2fa WHERE user_id = $1 AND is_enabled = true`, [user_id]);
  if (!res.rowCount) return false;

  const hashed = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
  const codes = res.rows[0].backup_codes || [];
  const idx = codes.indexOf(hashed);
  if (idx === -1) return false;

  // Remove used backup code
  const newCodes = codes.filter((_, i) => i !== idx);
  await db.query(`UPDATE user_2fa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2`, [newCodes, user_id]);
  return true;
};
