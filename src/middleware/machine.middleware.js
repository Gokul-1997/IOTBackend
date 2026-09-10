const { verify } = require('../utils/jwt');

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token missing' });

  try {
    const payload = verify(token);
    if (payload.type !== 'MACHINE') {
      return res.status(403).json({ message: 'Invalid machine token' });
    }
    req.machine = payload;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
};
