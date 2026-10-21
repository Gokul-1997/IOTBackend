const db = require('../db');
const tokens = require('../programs/gateway-token');
module.exports = async (req, res, next) => {
  const token = tokens.fromRequest(req);
  if (!token) return res.status(401).json({
    status: 'error',
    code: 'GATEWAY_TOKEN_REQUIRED',
    message: 'Send the gateway token as a Bearer credential.'
  });
  try {
    const {
      rows
    } = await db.query(`SELECT g.*,c.is_active AS company_active,p.is_active AS plant_active
   FROM program_gateways g JOIN companies c ON c.id=g.company_id LEFT JOIN plants p ON p.id=g.plant_id AND p.company_id=g.company_id
   WHERE g.token_hash=$1`, [tokens.hash(token)]);
    const gateway = rows[0];
    if (!gateway) return res.status(401).json({
      status: 'error',
      code: 'GATEWAY_TOKEN_INVALID',
      message: 'Gateway token is invalid or rotated.'
    });
    if (!gateway.is_active || !gateway.company_active || gateway.plant_id && !gateway.plant_active) return res.status(403).json({
      status: 'error',
      code: 'GATEWAY_DISABLED',
      message: 'Gateway, company or plant is inactive.'
    });
    if (!gateway.last_seen_at || Date.now() - new Date(gateway.last_seen_at).getTime() > 30000) {
      await db.query('UPDATE program_gateways SET last_seen_at=NOW(),last_seen_ip=$2,agent_version=$3 WHERE id=$1', [gateway.id, req.ip || null, String(req.headers['x-agent-version'] || '').slice(0, 50) || null]);
    }
    req.gateway = {
      id: gateway.id,
      company_id: gateway.company_id,
      plant_id: gateway.plant_id,
      token_version: gateway.token_version,
      max_concurrency: gateway.max_concurrency
    };
    next();
  } catch (error) {
    console.error('[gateway auth]', error.message);
    res.status(503).json({
      status: 'error',
      code: 'GATEWAY_AUTH_UNAVAILABLE',
      message: 'Gateway authentication is temporarily unavailable.'
    });
  }
};
