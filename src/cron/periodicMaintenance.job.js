/**
 * Phase 2 · Screen 4 — raise periodic maintenance tickets on a timer.
 *
 * Every 15 minutes, matching the preventive engine. A finer interval would
 * buy nothing: the shortest frequency is daily, so a quarter-hour of lag on
 * work that is due today changes nothing anyone can act on.
 *
 * The engine is idempotent and takes a row lock per schedule, so a tick
 * that overlaps the previous one — or a second pm2 cluster instance running
 * the same job — cannot double-raise an occurrence.
 */
const engine = require('../maintenance/periodic-engine.service');

module.exports = async () => {
  try {
    const summary = await engine.evaluateAll();
    if (summary.created > 0) {
      console.log(
        `[periodicMaintenance] raised ${summary.created} ticket(s) from ` +
        `${summary.advanced} schedule(s) across ${summary.companies} company(ies)`
      );
    }
    if (summary.failed.length) {
      console.error('[periodicMaintenance] some companies failed:', summary.failed);
    }
  } catch (err) {
    console.error('[periodicMaintenance] run failed:', err.message);
  }
};
