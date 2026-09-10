/**
 * Record who changed what.
 *
 * audit.service has had a working log() since it was written, and nothing
 * ever called it — the table existed with zero rows while three screens
 * specified an audit trail. This wires it in one place rather than
 * scattering log() calls through every controller, because the scattered
 * version is the one where somebody adds a new endpoint and forgets.
 *
 *   router.post('/', auth, audited('role'), ctrl.create)
 *
 * Only mutations are recorded, and only successful ones: a rejected
 * request changed nothing, and a log full of failed attempts buries the
 * changes someone is actually looking for. Authentication failures are
 * already logged separately.
 *
 * Writing is fire-and-forget. An audit row that fails must never turn a
 * successful change into an error for the user — the change already
 * happened, and reporting failure would be a lie.
 */

const audit = require('../audit/audit.service');

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/*
 * Fields that must never reach the audit table.
 *
 * The log records request bodies, and those bodies contain credentials on
 * exactly the routes most worth auditing — user creation, password
 * changes, FTP settings. A plaintext password in an audit row is worse
 * than no audit row, because it is a durable copy of a secret in a table
 * built to be read by administrators.
 */
const REDACT = new Set([
  'password', 'password_hash', 'new_password', 'old_password', 'current_password',
  'confirm_password', 'token', 'refresh_token', 'access_token', 'secret',
  'api_key', 'ftp_pass', 'authorization_code', 'code'
]);

function sanitise(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitise(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : sanitise(v, depth + 1);
  }
  return out;
}

/** POST → CREATE, PUT/PATCH → UPDATE, DELETE → DELETE. */
function actionFor(method, resource) {
  const verb = method === 'POST' ? 'CREATE' : method === 'DELETE' ? 'DELETE' : 'UPDATE';
  return `${verb}_${String(resource).toUpperCase()}`;
}

/**
 * @param {string} resource what is being changed, e.g. 'role', 'user'
 */
module.exports = function audited(resource) {
  return (req, res, next) => {
    if (!MUTATIONS.has(req.method)) return next();

    const originalJson = res.json.bind(res);

    res.json = (body) => {
      // Send the response first. Nothing about auditing should delay it.
      const result = originalJson(body);

      if (res.statusCode >= 200 && res.statusCode < 300) {
        /* The id can come from the route (/roles/:id) or from what was
           just created (the response body). Prefer the route, because a
           delete has no body to read it from. */
        const resourceId = req.params?.id
          ?? body?.data?.id ?? body?.id ?? null;

        audit.log({
          user_id:    req.user?.id ?? null,
          company_id: req.user?.company_id ?? null,
          action:     actionFor(req.method, resource),
          resource,
          resource_id: resourceId,
          new_value:  sanitise({
            ...(Object.keys(req.body || {}).length ? { body: req.body } : {}),
            ...(Object.keys(req.query || {}).length ? { query: req.query } : {})
          }),
          ip_address: req.ip || req.headers['x-forwarded-for'] || null,
          user_agent: req.headers['user-agent'] || null
        }).catch(() => { /* audit.service already logs its own failures */ });
      }

      return result;
    };

    next();
  };
};

module.exports.sanitise = sanitise;
module.exports.actionFor = actionFor;
module.exports.REDACT = REDACT;
