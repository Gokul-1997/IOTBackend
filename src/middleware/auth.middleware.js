const jwt   = require('jsonwebtoken');
const db    = require('../db');
const redis = require('../redis');

module.exports = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization token missing' });
    }

    const token = auth.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Access token expired or invalid' });
    }

    // roles/permissions always come from the JWT token (not the cache)
    const roles        = decoded.roles       || [];
    const permissions  = decoded.permissions || [];
    const is_snt_super = roles.includes('SNT_SUPER') || decoded.is_snt_super === true;

    // Check Redis cache before hitting DB
    const cacheKey = `user:${decoded.user_id}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      const user = JSON.parse(cached);
      if (!user.is_active) return res.status(403).json({ message: 'Account inactive' });

      req.user = {
        id:          user.id,
        username:    user.username,
        plant_id:    user.plant_id,
        company_id:  user.company_id  || decoded.company_id  || null,
        user_type:   user.user_type   || decoded.user_type   || 'company_user',
        is_snt_super,
        role:        roles[0] || 'USER',
        roles,
        permissions,
        plan:        decoded.plan || null
      };
      return next();
    }

    // Cache miss — query DB
    const { rows } = await db.query(
      `SELECT id, username, plant_id, company_id, user_type, is_active
       FROM users WHERE id = $1`,
      [decoded.user_id]
    );

    if (!rows.length) return res.status(401).json({ message: 'User not found' });

    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ message: 'Account inactive' });

    // Cache the DB record for 60 seconds
    await redis.setex(cacheKey, 60, JSON.stringify({
      id:        user.id,
      username:  user.username,
      plant_id:  user.plant_id,
      company_id: user.company_id,
      user_type: user.user_type,
      is_active: user.is_active
    }));

    req.user = {
      id:          user.id,
      username:    user.username,
      plant_id:    user.plant_id,
      company_id:  user.company_id  || decoded.company_id  || null,
      user_type:   user.user_type   || decoded.user_type   || 'company_user',
      is_snt_super,
      role:        roles[0] || 'USER',
      roles,
      permissions,
      plan:        decoded.plan || null
    };

    next();
  } catch (err) {
    console.error('AUTH ERROR:', err);
    return res.status(401).json({ message: 'Unauthorized' });
  }
};
