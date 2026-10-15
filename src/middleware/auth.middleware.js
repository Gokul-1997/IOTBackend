const jwt   = require('jsonwebtoken');
const db    = require('../db');
const redis = require('../redis');
const readScope = require('../lib/read-scope');
const { matches, revisionOf } = require('../lib/auth-revision');

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
    } catch {
      return res.status(401).json({ message: 'Access token expired or invalid' });
    }

    if (!/^[1-9]\d*$/.test(String(decoded.user_id))) {
      return res.status(401).json({ message: 'Access token expired or invalid' });
    }

    // Grants stay in the signed token. One indexed account lookup checks the
    // authorization revision and trusted scope on every request; a Redis
    // outage or stale cache cannot extend a revoked role or plant assignment.
    const roles        = decoded.roles       || [];
    const permissions  = decoded.permissions || [];
    const is_snt_super = roles.includes('SNT_SUPER') || decoded.is_snt_super === true;

    // S&T belongs to no company, so it has no company to be disabled
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.plant_id, u.company_id, u.user_type, u.is_active, u.auth_revision,
              COALESCE(c.is_active, true) AS company_active
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
      [decoded.user_id]
    );

    if (!rows.length) return res.status(401).json({ message: 'User not found' });

    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ message: 'Account inactive' });

    if (user.company_active === false) return companyDisabled(res);
    if (!matches(decoded, user)) return res.status(401).json({
      message: 'Your access changed. Refresh your session to continue.',
      code: 'AUTH_REVISION_CHANGED'
    });

    req.user = {
      id:          user.id,
      username:    user.username,
      plant_id:    user.plant_id,
      company_id:  user.company_id ?? null,
      user_type:   user.user_type || 'company_user',
      auth_revision: revisionOf(user.auth_revision),
      is_snt_super,
      role:        roles[0] || 'USER',
      roles,
      permissions,
      plan:        decoded.plan || null
    };

    readScope.run(req.user, next);
  } catch (err) {
    /* The token was valid (a bad one is answered above); what failed is the
       look-up of the account — the database out of reach for a moment.
       401 here made the web app sign everyone out on a network blip, as an
       unreachable Redis used to; 503 says "try again", and the session stays. */
    console.error('AUTH ERROR:', err);
    return res.status(503).json({
      message: 'The server could not check your session just now. Try again in a moment.',
      code: 'AUTH_UNAVAILABLE'
    });
  }
};

/** Remove legacy cached records after account changes. Authentication itself
 * always reads PostgreSQL; failed cache cleanup cannot preserve access. */
module.exports.forgetUsers = async (userIds = []) => {
  if (!userIds.length) return;
  try { await redis.del(...userIds.map(id => `user:${id}`)); }
  catch { /* obsolete records are never authoritative */ }
};
