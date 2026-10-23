/**
 * Page access: what the ROLE allows, and what the COMPANY has been granted.
 *
 * permission.middleware.js checks only req.user.permissions — the user's role.
 * The company-level grant that "Manage Access" edits was enforced nowhere at
 * the API: it hid menu items in the browser and constrained what could be
 * assigned to a role later, and that was all. Revoking a page from a company
 * changed nothing a user could not undo by typing a URL or calling the API.
 *
 * requireAccess(key) closes that for the pages that have a key of their own.
 * It mirrors what the frontend already does, on purpose, so the two cannot
 * disagree about who may see a page:
 *
 *   - SNT_SUPER passes: it administers every tenant and holds no company.
 *   - COMPANY_ADMIN is governed by the company grant alone. The frontend
 *     ignores its role permissions for exactly this reason (a shared system
 *     role cannot say what one company has paid for), and requiring them here
 *     would lock every company admin out of a page the moment someone added a
 *     module and forgot to grant the system role — the trap migration 013
 *     had to be written around for Program Transfer.
 *   - Every other role needs the permission on the role AND the company grant.
 *   - A company with no grants at all is a fresh, unrestricted one — the same
 *     reading auth.service.ts and permission.guard.ts take — except for an
 *     opt-in page (the AI assistant, plan.service optIn): only a company S&T
 *     granted it has it, whatever else it has.
 *
 * Legacy keys (machine.view, shift.create ...) are NOT routed through here.
 * They are not in the catalogue Manage Access offers, so no company has them
 * granted; checking them against the company would lock out every tenant.
 */

const db = require('../db');
const { isOptInKey } = require('../plans/plan.service');

const TTL_SECONDS = 60;
const cacheKey = (id, revision, userId) => revision == null || userId == null
  ? `company_grants:${id}` : `company_grants:${id}:user:${userId}:revision:${revision}`;

/**
 * Every permission key the company has been granted.
 *
 * Cached briefly: dashboards fire several requests per load and the answer
 * changes only when S&T saves Manage Access, which clears it. Redis being
 * unavailable must never take a page down, so both cache calls are best
 * effort and the database is the fallback.
 */
async function loadCompanyGrants(company_id, authRevision, userId) {
  let redis = null;
  try { redis = require('../redis'); } catch { /* no cache configured */ }

  if (redis) {
    try {
      const hit = await redis.get(cacheKey(company_id, authRevision, userId));
      if (hit) return new Set(JSON.parse(hit));
    } catch { /* fall through to the database */ }
  }

  const { rows } = await db.query(
    `SELECT p.permission_key
       FROM company_permissions cp
       JOIN permissions p ON p.id = cp.permission_id
      WHERE cp.company_id = $1`,
    [company_id]
  );
  const keys = rows.map(r => r.permission_key);

  if (redis) {
    try { await redis.set(cacheKey(company_id, authRevision, userId), JSON.stringify(keys), 'EX', TTL_SECONDS); }
    catch { /* best effort */ }
  }
  return new Set(keys);
}

/** Called after Manage Access saves, so a revoke takes effect at once
 *  instead of after the cache expires. */
async function invalidateCompanyGrants(company_id) {
  try { await require('../redis').del(cacheKey(company_id)); }
  catch { /* the entry expires within TTL_SECONDS anyway */ }
}

/**
 * Does `key` (e.g. page:analytics-oee:view) pass for this user?
 * Returns null when it does, otherwise the reason it does not.
 */
async function denialFor(user, key) {
  return denialForAny(user, [key]);
}

/** A shared endpoint can serve several screens; one complete role+company
 * grant must match. A role grant for one screen cannot be paired with a
 * company grant for a different screen. */
async function denialForAny(user, keys) {
  if (!user) return 'NO_USER';
  if (user.is_snt_super) return null;

  const roles = user.roles || [];
  const isCompanyAdmin = roles.includes('COMPANY_ADMIN') || roles.includes('ADMIN');

  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  const allowed = isCompanyAdmin ? keys : keys.filter(key => permissions.includes(key));
  if (!allowed.length) return 'ROLE';

  // A caller with no company has nothing to be granted, and "no grants
  // means unrestricted" must not be reachable by simply having no company.
  if (!user.company_id) return 'NO_COMPANY';

  // A successful Manage Access change advances every company user's
  // revision. Fresh tokens can never reuse a cache entry from before it,
  // even if an in-flight read fills that old entry after invalidation.
  const grants = await loadCompanyGrants(user.company_id, user.auth_revision, user.id);
  const granted = key => grants.has(key) || (grants.size === 0 && !isOptInKey(key));
  if (!allowed.some(granted)) return 'COMPANY';
  return null;
}

module.exports = function requireAccess(key) {
  const guard = async (req, res, next) => {
    try {
      const why = await denialFor(req.user, key);
      if (!why) return next();

      if (!req.user) return res.status(401).json({ message: 'User context missing' });
      return res.status(403).json({
        message: why === 'COMPANY'
          ? 'Your plan does not include this page. Contact S&T to add it.'
          : 'Permission denied',
        code: why === 'COMPANY' ? 'NOT_IN_PLAN' : 'PERMISSION_DENIED',
        required: key
      });
    } catch (err) {
      next(err);
    }
  };
  // Read back by __tests__/services/permission.catalogue.test.js, which walks
  // every router and checks each key named here exists in the catalogue.
  guard.requiredPermission = key;
  return guard;
};

module.exports.denialFor = denialFor;
module.exports.loadCompanyGrants = loadCompanyGrants;
module.exports.invalidateCompanyGrants = invalidateCompanyGrants;
module.exports.denialForAny = denialForAny;
module.exports.any = (...keys) => {
  const guard = async (req, res, next) => {
    try {
      const why = await denialForAny(req.user, keys);
      if (!why) return next();
      return res.status(req.user ? 403 : 401).json({
        message: why === 'COMPANY' ? 'Your plan does not include this page. Contact S&T to add it.' : 'Permission denied',
        code: why === 'COMPANY' ? 'NOT_IN_PLAN' : 'PERMISSION_DENIED',
        required: keys
      });
    } catch (err) { next(err); }
  };
  guard.requiredPermissions = keys;
  return guard;
};
