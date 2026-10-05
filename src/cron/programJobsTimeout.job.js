const { failStale } = require('../programs/jobs');

/*
 * Runs every 5 minutes. A Program Transfer job that a machine's device took
 * but never reported on, or that no device came for, is marked FAILED and
 * its requester told — so the history never shows a job "waiting" forever
 * (see programs/jobs.js for the two time limits).
 */
module.exports = async () => {
  try {
    const failed = await failStale();
    if (failed > 0) console.warn(`[programJobs] marked ${failed} stale job(s) FAILED`);
  } catch (err) {
    console.error('[programJobs] timeout check failed:', err.message);
  }
};
