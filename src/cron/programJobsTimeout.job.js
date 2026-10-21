const { failStale } = require('../programs/jobs');

/*
 * Runs every 5 minutes. A Program Transfer job that a machine's device took
 * but never reported on, or that no device came for, is marked FAILED and
 * its requester told. Gateway writes with an unknown outcome stay blocked
 * for reconciliation; read-only operations and uncollected commands fail.
 */
module.exports = async () => {
  try {
    const failed = await failStale();
    if (failed > 0) console.warn(`[programJobs] updated ${failed} stale job(s)`);
  } catch (err) {
    console.error('[programJobs] timeout check failed:', err.message);
  }
};
