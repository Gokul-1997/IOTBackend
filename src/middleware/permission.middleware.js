module.exports = function checkPermission(requiredPermission) {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({ message: 'User context missing' });
    }
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
