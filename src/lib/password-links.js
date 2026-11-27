const crypto = require('crypto');

const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;
const DEFAULT_FRONTEND = 'https://stmmexa.stmcnc.com';

// CORS accepts a list of origins; an email must point to exactly one website.
function frontendUrl() {
  const explicit = process.env.PUBLIC_FRONTEND_URL?.trim();
  const configured = explicit || process.env.FRONTEND_URL?.trim() || DEFAULT_FRONTEND;
  const candidates = explicit ? [explicit] : configured.split(',').map(s => s.trim());
  const urls = candidates.flatMap(candidate => {
    try {
      const url = new URL(candidate);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const validProtocol = url.protocol === 'https:' ||
        (url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production');
      if (!validProtocol || url.username || url.password || url.search || url.hash ||
          /\s/.test(candidate) || (candidate.match(/https?:\/\//g) || []).length !== 1 ||
          (loopback && process.env.NODE_ENV === 'production')) return [];
      return [url];
    } catch { return []; }
  });
  // Prefer the public site over a local development origin in legacy lists.
  const selected = urls.find(url => url.origin === DEFAULT_FRONTEND) ||
    urls.find(url => url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || urls[0];
  if (!selected) throw new Error('Set PUBLIC_FRONTEND_URL to one valid HTTPS application URL');
  return selected.href.replace(/\/$/, '');
}

function createPasswordLink({ setup = false } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + (setup ? SETUP_TTL_MS : RESET_TTL_MS)),
    url: `${frontendUrl()}/reset-password/${token}${setup ? '?mode=setup' : ''}`
  };
}

// Issuing and redeeming share this transaction lock, so requests for one
// account cannot leave competing valid links or reuse a link.
async function lockPasswordLinks(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock(734821, $1)', [userId]);
}

async function savePasswordLink(client, userId, link) {
  await lockPasswordLinks(client, userId);
  await client.query('UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false', [userId]);
  await client.query(
    'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, link.tokenHash, link.expiresAt]
  );
}

module.exports = { frontendUrl, createPasswordLink, savePasswordLink, lockPasswordLinks, SETUP_TTL_MS, RESET_TTL_MS };
