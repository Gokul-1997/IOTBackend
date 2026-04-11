/**
 * Middleware: restrict route to S&T Super Users only.
 * Must be applied AFTER auth.middleware.
 */
module.exports = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  if (!req.user.is_snt_super) {
    return res.status(403).json({ message: 'Access denied: S&T Super User only' });
  }
  next();
};
