const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const crypto = require('crypto');
const { sendBulkEmails } = require('../utils/nodemailer');
const { generateResetPasswordTemplate } = require('../utils/nodemailer/emailTemplates/generateResetPasswordTemplate');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_TIME_MINUTES = 15;

// Access token short; refresh token long
const ACCESS_EXPIRES = '15m';
const REFRESH_TTL_DAYS = 7;

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
}

// good refresh token: random + store hashed (optional). Here store plain for simplicity.
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

exports.login = async ({ email, password }, req) => {
  if (!email || !password) throw { status: 400, message: 'Email and password required' };

  // Step 1: Get user WITHOUT lock first (read-only)
  const userRes = await db.query(
    `SELECT id, email, username, password_hash, plant_id,
            is_active, failed_login_attempts, lock_until
     FROM users
     WHERE email = $1`,
    [email]
  );

  if (!userRes.rowCount) throw { status: 404, message: 'User not found' };

  const user = userRes.rows[0];

  if (!user.is_active) throw { status: 403, message: 'Account inactive' };

  if (user.lock_until && new Date(user.lock_until) > new Date()) {
    throw { status: 403, message: 'Account locked. Try again later.' };
  }

  // Step 2: Validate password (CPU-bound, no DB lock needed)
  const passwordValid = await bcrypt.compare(password, user.password_hash);

  if (!passwordValid) {
    // Update failed attempts (non-critical, use fire-and-forget)
    const failed = (user.failed_login_attempts || 0) + 1;
    const lockUntil = failed >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCK_TIME_MINUTES * 60000)
      : null;

    db.query(
      `UPDATE users
       SET failed_login_attempts = $1,
           lock_until = $2
       WHERE id = $3`,
      [failed, lockUntil, user.id]
    ).catch(err => console.error('Failed to update login attempts:', err));

    throw { status: 401, message: 'Invalid credentials' };
  }

  // Step 3: Get roles + permissions in parallel
  const [roleRes, permRes] = await Promise.all([
    db.query(
      `SELECT r.role_name
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [user.id]
    ),
    db.query(
      `SELECT DISTINCT p.permission_key
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1`,
      [user.id]
    )
  ]);

  const roles = roleRes.rows.map(r => r.role_name);
  const permissions = permRes.rows.map(p => p.permission_key);

  // Step 4: Only update session info (use transaction)
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Update login info
    await client.query(
      `UPDATE users
       SET failed_login_attempts = 0,
           lock_until = NULL,
           last_login_at = now(),
           last_login_ip = $1
       WHERE id = $2`,
      [req.ip, user.id]
    );

    // Create refresh session
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO user_sessions (user_id, refresh_token, expires_at, last_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, expiresAt, req.ip, req.headers['user-agent'] || null]
    );

    // Keep only last 2 valid sessions
    await client.query(
      `UPDATE user_sessions
       SET revoked = true
       WHERE user_id = $1
         AND revoked = false
         AND id NOT IN (
           SELECT id FROM user_sessions
           WHERE user_id = $1 AND revoked = false
           ORDER BY created_at DESC
           LIMIT 2
         )`,
      [user.id]
    );

    await client.query('COMMIT');

    // Step 5: Generate tokens and return
    const tokenPayload = {
      user_id: user.id,
      plant_id: user.plant_id,
      roles,
      permissions
    };

    const accessToken = signAccessToken(tokenPayload);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        roles,
        permissions,
        plant_id: user.plant_id
      }
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.refresh = async (refreshToken, req) => {
  if (!refreshToken) throw { status: 401, message: 'Refresh token required' };

  const sessionRes = await db.query(
    `SELECT s.user_id, s.expires_at, s.revoked,
            u.email, u.username, u.plant_id, u.is_active
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token = $1`,
    [refreshToken]
  );

  if (!sessionRes.rowCount) throw { status: 401, message: 'Invalid refresh token' };

  const s = sessionRes.rows[0];
  if (s.revoked) throw { status: 401, message: 'Session revoked' };
  if (new Date(s.expires_at) <= new Date()) throw { status: 401, message: 'Session expired' };
  if (!s.is_active) throw { status: 403, message: 'Account inactive' };

  // reload roles/permissions (or cache)
  const roleRes = await db.query(
    `SELECT r.role_name
     FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [s.user_id]
  );
  const roles = roleRes.rows.map(r => r.role_name);

  const permRes = await db.query(
    `SELECT DISTINCT p.permission_key
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [s.user_id]
  );
  const permissions = permRes.rows.map(p => p.permission_key);

  const accessToken = signAccessToken({
    user_id: s.user_id,
    plant_id: s.plant_id,
    roles,
    permissions
  });

  return { accessToken };
};

/* =========================================================
   RESET PASSWORD (keep your flow, just add cleanup)
   ========================================================= */
exports.sendResetLink = async (email) => {
  const userRes = await db.query(
    'SELECT id, email FROM users WHERE email = $1',
    [email]
  );

  if (userRes.rowCount === 0) return; // do not reveal

  const user = userRes.rows[0];

  // optional: invalidate old unused tokens
  await db.query(
    `UPDATE password_reset_tokens
     SET used = true
     WHERE user_id = $1 AND used = false`,
    [user.id]
  );

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, token, expiresAt]
  );

  const resetLink = `${process.env.FRONTEND_URL}/reset-password/${token}`;
  const html = generateResetPasswordTemplate(resetLink, user.email);

  await sendBulkEmails({
    recipients: [user.email],
    subject: 'Reset Your Password',
    html
  });
};

exports.resetPassword = async (token, password) => {
  const result = await db.query(
    `SELECT user_id
     FROM password_reset_tokens
     WHERE token = $1 AND expires_at > NOW() AND used = false`,
    [token]
  );

  if (result.rowCount === 0) throw { status: 400, message: 'Invalid or expired token' };

  const userId = result.rows[0].user_id;
  const hash = await bcrypt.hash(password, 10);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [hash, userId]
    );

    await client.query(
      'UPDATE password_reset_tokens SET used = true WHERE token = $1',
      [token]
    );

    // revoke all sessions after password change
    await client.query(
      `UPDATE user_sessions SET revoked = true WHERE user_id = $1`,
      [userId]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.logout = async (refreshToken) => {
  if (!refreshToken) return;

  await db.query(
    `UPDATE user_sessions
     SET revoked = true
     WHERE refresh_token = $1`,
    [refreshToken]
  );
};

