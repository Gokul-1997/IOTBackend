/**
 * Gateway tokens: the secret a company's gateway sends on every call.
 *
 *   mxg_<43 characters of base64url>      256 random bits, one per company
 *
 * Until 22 Oct 2026 each machine had its own token, "mxd_…"; those no longer
 * work, and are told apart so the gateway can say so plainly.
 *
 * Only the SHA-256 of a token is stored. That is enough here — a password
 * needs a slow hash because people choose guessable ones; 256 random bits
 * cannot be guessed, so a fast hash loses nothing and lets a request find
 * its gateway by an index lookup.
 */
const crypto = require('crypto');

const PREFIX = 'mxg_';
const SHAPE = /^mxg_[A-Za-z0-9_-]{43}$/;
const MACHINE_TOKEN = /^mxd_[A-Za-z0-9_-]{43}$/;

function generate() {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hash(token), prefix: token.slice(0, 12) };
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Whatever follows "Authorization: Bearer"; null when there is nothing. */
function bearer(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/** The gateway token in "Authorization: Bearer mxg_…"; null when absent or malformed. */
function fromRequest(req) {
  const token = bearer(req);
  return token && SHAPE.test(token) ? token : null;
}

/** A retired machine token ("mxd_…"). */
const isMachineToken = token => MACHINE_TOKEN.test(String(token || ''));

module.exports = { generate, hash, bearer, fromRequest, isMachineToken, PREFIX, SHAPE };
