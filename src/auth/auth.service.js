const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const crypto = require('crypto');
const { sendBulkEmails } = require('../utils/nodemailer');
const { generateResetPasswordTemplate } = require('../utils/nodemailer/emailTemplates/generateResetPasswordTemplate');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_TIME_MINUTES = 15;

exports.login = async ({ email, password }, req) => {

  if (!email || !password) {
    throw { status: 400, message: 'Email and password required' };
  }

  // 1️⃣ Get user
  const userRes = await db.query(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  );

  if (!userRes.rowCount) {
    throw { status: 404, message: 'User not found' };
  }

  const user = userRes.rows[0];

  // 2️⃣ Check active / lock
  if (!user.is_active) {
    throw { status: 403, message: 'Account inactive' };
  }

  if (user.lock_until && new Date(user.lock_until) > new Date()) {
    throw {
      status: 403,
      message: 'Account locked. Try again later.'
    };
  }

  // 3️⃣ Password verify
  const passwordValid = await bcrypt.compare(password, user.password_hash);

  if (!passwordValid) {
    let lockUntil = null;
    const failed = user.failed_login_attempts + 1;

    if (failed >= MAX_FAILED_ATTEMPTS) {
      lockUntil = new Date(Date.now() + LOCK_TIME_MINUTES * 60000);
    }

    await db.query(
      `UPDATE users
       SET failed_login_attempts = $1,
           lock_until = $2
       WHERE id = $3`,
      [failed, lockUntil, user.id]
    );

    throw { status: 401, message: 'Invalid credentials' };
  }

  // 4️⃣ Reset failed attempts
  await db.query(
    `UPDATE users
     SET failed_login_attempts = 0,
         lock_until = NULL,
         last_login_at = now(),
         last_login_ip = $1
     WHERE id = $2`,
    [req.ip, user.id]
  );

  // 5️⃣ Load roles
  const roleRes = await db.query(
    `SELECT r.role_name
     FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [user.id]
  );

  const roles = roleRes.rows.map(r => r.role_name);

  // 6️⃣ Load permissions
  const permRes = await db.query(
    `SELECT DISTINCT p.permission_key
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [user.id]
  );

  const permissions = permRes.rows.map(p => p.permission_key);

  // 7️⃣ Generate JWT
  const tokenPayload = {
    user_id: user.id,
    plant_id: user.plant_id,
    roles,
    permissions
  };

  const token = jwt.sign(
    tokenPayload,
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  // 8️⃣ Store token (max 2 sessions only)
  await db.query(
    `UPDATE users
  SET tokens = (
    CASE
      WHEN tokens IS NULL THEN ARRAY[$1]
      WHEN array_length(tokens, 1) < 2 THEN array_append(tokens, $1)
      ELSE array_append(tokens[2:2], $1)
    END
  )
  WHERE id = $2
  `,
    [token, user.id]
  );

  // 9️⃣ Return response
  return {
    accessToken: token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      roles,
      permissions,
      plant_id: user.plant_id
    }
  };
};

exports.logout = async (req) => {
  const auth = req.headers.authorization;
  if (!auth) return;

  const token = auth.split(' ')[1];

  await pool.query(
    `UPDATE users
     SET tokens = array_remove(tokens, $1)
     WHERE tokens @> ARRAY[$1]`,
    [token]
  );
};

exports.sendResetLink = async (email) => {
  const userRes = await db.query(
    'SELECT id, email FROM users WHERE email = $1',
    [email]
  );

  if (userRes.rowCount === 0) return; // 🔐 do not reveal

  const user = userRes.rows[0];

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
    `SELECT user_id FROM password_reset_tokens
     WHERE token = $1 AND expires_at > NOW() AND used = false`,
    [token]
  );

  if (result.rowCount === 0) {
    throw new Error('Invalid or expired token');
  }

  const hash = await bcrypt.hash(password, 10);

  await db.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [hash, result.rows[0].user_id]
  );

  await db.query(
    'UPDATE password_reset_tokens SET used = true WHERE token = $1',
    [token]
  );
};
