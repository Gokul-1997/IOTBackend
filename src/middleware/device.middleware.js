/**
 * Authenticates a company's gateway (the Program Transfer API, /api/device/v1).
 *
 * The gateway sends "Authorization: Bearer mxg_…" — its company's one token
 * (22 Oct 2026: one token for every machine, instead of one per machine; S&T
 * makes it under Company Management → Gateway). The token is looked up by
 * hash, must not be revoked, and its company must be active — a company S&T
 * disabled stops its gateway at once. A user's
 * sign-in token is not accepted here, and a gateway token is not accepted
 * anywhere else (auth.middleware verifies JWTs only).
 *
 * Every accepted call is the gateway's heartbeat: last_seen_at, the address
 * it came from and its agent version are kept, at most every 30 seconds,
 * which is what the Program Transfer page shows as online / offline.
 */
const db = require('../db');
const deviceToken = require('../programs/device-token');

const SEEN_EVERY_MS = 30_000;

const deny = (res, status, code, message) => res.status(status).json({ status: 'error', code, message });

module.exports = async (req, res, next) => {
  const sent = deviceToken.bearer(req);
  if (!sent) return deny(res, 401, 'TOKEN_MISSING', 'Send the gateway token as "Authorization: Bearer mxg_…".');
  if (deviceToken.isMachineToken(sent)) {
    return deny(res, 401, 'TOKEN_REPLACED', 'This is a machine token (mxd_…), and machine tokens no longer work. Program Transfer now has one token '
      + 'for all machines of a company (it starts mxg_), made by S&T: ask S&T for your company\'s gateway token.');
  }
  const token = deviceToken.fromRequest(req);
  if (!token) return deny(res, 401, 'TOKEN_INVALID', 'This gateway token is not valid. Ask S&T for your company\'s gateway token.');

  try {
    const { rows } = await db.query(
      `SELECT g.id, g.company_id, g.last_seen_at, g.last_seen_ip, g.agent_version,
              c.company_name, c.is_active AS company_active
         FROM program_gateway_tokens g
         JOIN companies c ON c.id = g.company_id
        WHERE g.token_hash = $1 AND g.revoked_at IS NULL`,
      [deviceToken.hash(token)]
    );
    const g = rows[0];
    // unknown and revoked read the same: nothing to learn from probing
    if (!g) return deny(res, 401, 'TOKEN_INVALID', 'This gateway token is not valid. Ask S&T for your company\'s gateway token.');
    if (g.company_active === false) return deny(res, 403, 'COMPANY_DISABLED', "The company's access has been turned off.");

    const ip = req.ip || null;
    const version = String(req.headers['x-agent-version'] || '').slice(0, 50) || null;
    const stale = !g.last_seen_at || Date.now() - new Date(g.last_seen_at).getTime() > SEEN_EVERY_MS;
    if (stale || ip !== g.last_seen_ip || (version && version !== g.agent_version)) {
      await db.query(
        `UPDATE program_gateway_tokens
            SET last_seen_at = NOW(), last_seen_ip = $2, agent_version = COALESCE($3, agent_version)
          WHERE id = $1`,
        [g.id, ip, version]
      );
    }

    req.gateway = { id: g.id, company_id: g.company_id, company_name: g.company_name };
    next();
  } catch (err) {
    console.error('Gateway auth failed:', err.message);
    deny(res, 500, 'SERVER_ERROR', 'The server could not check the gateway token. Try again.');
  }
};
