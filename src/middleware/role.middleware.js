module.exports = roles => (req, res, next) => {
  // FIX: added null guard — was crashing with TypeError if auth middleware not applied first
  if (!req.user || !req.user.roles) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  if (!roles.some(r => req.user.roles.includes(r))) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};
