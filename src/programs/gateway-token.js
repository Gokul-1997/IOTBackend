const crypto = require('node:crypto');
const SHAPE = /^mxg_[A-Za-z0-9_-]{43}$/;
const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
exports.generate = () => {
  const token = 'mxg_' + crypto.randomBytes(32).toString('base64url');
  return {
    token,
    hash: hash(token),
    prefix: token.slice(0, 12)
  };
};
exports.hash = hash;
exports.fromRequest = req => {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return match && SHAPE.test(match[1]) ? match[1] : null;
};
