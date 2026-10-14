/**
 * Middleware factory: check that the authenticated user has a specific permission.
 *
 * Permission key format: page:<module>:<action>
 * e.g.  page:machines:view, page:machines:create, page:shifts:delete
 *
 * S&T Super Users have implicit access to everything.
 *
 * Usage:
 *   router.post('/', auth, checkPerm('page:machines:create'), ctrl.create)
 */
module.exports = function checkPermission(requiredPermission) {
  // Master-list endpoints are shared by several pages. Their legacy key is
  // derived from those pages, so check an actual role+company page grant too.
  const { LEGACY_FOR_PAGE } = require('../roles/default-roles');
  const alternatives = [];
  for (const [module, actions] of Object.entries(LEGACY_FOR_PAGE)) {
    for (const [action, keys] of Object.entries(actions)) {
      if (keys.includes(requiredPermission)) alternatives.push(`page:${module}:${action}`);
    }
  }
  if (alternatives.length) {
    const mapped = require('./access.middleware').any(...alternatives);
    mapped.requiredPermission = requiredPermission;
    return mapped;
  }
  const guard = (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'User context missing' });
    }

    // SNT_SUPER bypasses all permission gates
    if (req.user.is_snt_super) return next();

    const permissions = req.user.permissions || [];
    if (!Array.isArray(permissions)) {
      return res.status(403).json({ message: 'Invalid permissions format' });
    }

    if (!permissions.includes(requiredPermission)) {
      return res.status(403).json({
        message: 'Permission denied',
        required: requiredPermission
      });
    }

    next();
  };
  // Read back by __tests__/services/permission.catalogue.test.js.
  guard.requiredPermission = requiredPermission;
  return guard;
};
