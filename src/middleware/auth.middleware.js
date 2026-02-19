const jwt = require('jsonwebtoken');
const db = require('../db');

module.exports = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token missing' });
    }

    // 1️⃣ Extract token
    const token = auth.split(' ')[1];

    // 2️⃣ Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        message: 'Access token expired or invalid'
      });
    }

    // 3️⃣ Load user (basic validation)
    const { rows } = await db.query(
      `SELECT id, username, plant_id, is_active
       FROM users
       WHERE id = $1`,
      [decoded.user_id]
    );

    if (!rows.length) {
      return res.status(401).json({ message: 'User not found' });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({ message: 'Account inactive' });
    }

    // 🔥 NORMALIZE USER CONTEXT (THIS FIXES EVERYTHING)
    const roles = decoded.roles || [];
    req.user = {
      id: user.id,
      username: user.username,
      plant_id: user.plant_id,

      // ✅ ADD THIS
      role: roles[0] || 'USER',

      // keep existing
      roles,
      permissions: decoded.permissions || []
    };

    next();
  } catch (err) {
    console.error('AUTH ERROR:', err);
    return res.status(401).json({ message: 'Unauthorized' });
  }
};
