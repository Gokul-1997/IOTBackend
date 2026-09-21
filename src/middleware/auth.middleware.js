const jwt   = require('jsonwebtoken');
const db    = require('../db');
const redis = require('../redis');

/* Everyone in a company S&T has disabled is shut out — every request, not
   just the next sign-in. 401 rather than 403 so the app tries its refresh,
   which refuses too, and signs the person out. */
const companyDisabled = res => res.status(401).json({
  message: "Your company's access has been turned off. Contact S&T to turn it back on.",
  code: 'COMPANY_DISABLED'
});

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
      // an entry cached before this field existed reads as active
      if (user.company_active === false) return companyDisabled(res);

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
    // S&T belongs to no company, so it has no company to be disabled
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.plant_id, u.company_id, u.user_type, u.is_active,
              COALESCE(c.is_active, true) AS company_active
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
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
      is_active: user.is_active,
      company_active: user.company_active
    }));

    if (user.company_active === false) return companyDisabled(res);

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

/** Drop the cached copies of these users, so a change to their company's
 *  status applies on their next request instead of up to a minute later. */
module.exports.forgetUsers = async (userIds = []) => {
  if (!userIds.length) return;
  try { await redis.del(...userIds.map(id => `user:${id}`)); }
  catch { /* each entry expires within 60 seconds anyway */ }
};
