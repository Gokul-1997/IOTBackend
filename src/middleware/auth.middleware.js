const jwt = require('jsonwebtoken');
const db = require('../db');

module.exports = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token missing' });
    }

    // 1️⃣ Extract & normalize token
    let token = auth.replace('Bearer', '').trim();

    if (token.startsWith('"') && token.endsWith('"')) {
      token = token.slice(1, -1);
    }

    // 2️⃣ Basic JWT format check
    if (token.split('.').length !== 3) {
      return res.status(401).json({ message: 'Invalid token format' });
    }

    // 3️⃣ Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Token expired or invalid' });
    }

    // 4️⃣ Load user + active tokens
    const { rows } = await db.query(
      `SELECT id, username, plant_id, tokens
       FROM users
       WHERE id = $1`,
      [decoded.user_id]
    );

    if (!rows.length) {
      return res.status(401).json({ message: 'User not found' });
    }

    const user = rows[0];

    // 5️⃣ Enforce max-2-session rule
    if (!Array.isArray(user.tokens) || !user.tokens.includes(token)) {
      return res.status(401).json({
        message: 'Session expired. Please login again.'
      });
    }

    // 6️⃣ Attach user to request
    req.user = {
      id: user.id,
      username: user.username,
      plant_id: user.plant_id,
      roles: decoded.roles,
      permissions: decoded.permissions
    };

    next();
  } catch (err) {
    console.error('AUTH ERROR:', err);
    return res.status(401).json({ message: 'Unauthorized' });
  }
};
