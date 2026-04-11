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
  return (req, res, next) => {
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
};
