module.exports = roles => (req, res, next) => {
  if (!roles.some(r => req.user.roles.includes(r))) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
};
