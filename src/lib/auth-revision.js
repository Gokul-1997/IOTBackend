/* PostgreSQL BIGINT is a string. Do not round a revision through Number:
 * comparison must remain exact even after the safe-integer range. */
function revisionOf(value) {
  if (value === undefined) return '0';
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return /^(0|[1-9]\d*)$/.test(text) ? text : null;
}

function matches(token, user) {
  const tokenRevision = revisionOf(token.auth_revision);
  return tokenRevision !== null && tokenRevision === revisionOf(user.auth_revision);
}

/** Called only after the mutation commits. HTTP checks PostgreSQL itself;
 * cache invalidation and socket teardown cannot undo a successful write. */
async function invalidateUsers(userIds = []) {
  if (!userIds.length) return;
  try { await require('../middleware/auth.middleware').forgetUsers(userIds); }
  catch (error) { console.warn('AUTH legacy cache cleanup skipped:', error.message); }
  try { require('./realtime').disconnectUsers(userIds); }
  catch (error) { console.warn('AUTH socket teardown skipped:', error.message); }
}

module.exports = { revisionOf, matches, invalidateUsers };
