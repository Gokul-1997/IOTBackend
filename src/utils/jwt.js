const jwt = require('jsonwebtoken');

exports.signAccess = payload =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

exports.signRefresh = payload =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

exports.verify = token =>
  jwt.verify(token, process.env.JWT_SECRET);
