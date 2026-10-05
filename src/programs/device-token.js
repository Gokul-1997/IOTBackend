/**
 * Device tokens: the secret the machine's device sends on every call.
 *
 *   mxd_<43 characters of base64url>      256 random bits
 *
 * Only the SHA-256 of a token is stored. That is enough here — a password
 * needs a slow hash because people choose guessable ones; 256 random bits
 * cannot be guessed, so a fast hash loses nothing and lets a request find
 * its device by an index lookup.
 */
const crypto = require('crypto');

const PREFIX = 'mxd_';
const SHAPE = /^mxd_[A-Za-z0-9_-]{43}$/;

function generate() {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hash(token), prefix: token.slice(0, 12) };
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Pulls the token out of "Authorization: Bearer mxd_…"; null when absent or malformed. */
function fromRequest(req) {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(\S+)$/i);
  const token = m ? m[1] : null;
  return token && SHAPE.test(token) ? token : null;
}

module.exports = { generate, hash, fromRequest, PREFIX, SHAPE };
