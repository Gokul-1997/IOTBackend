const pmEngine = require('../maintenance/pm-engine.service');

/*
 * Runs every 15 minutes.
 *
 * Evaluates each company's alarm-threshold rules and raises a preventive
 * ticket wherever one has been breached. The engine is idempotent — it will
 * not raise a second ticket while one is still open for the same rule and
 * machine — so a tick that finds nothing new is a no-op.
 *
 * 15 minutes rather than every minute: preventive maintenance is not an
 * emergency path (breakdowns go through alarms), and each tick is a
 * per-company aggregate over machine_alarms.
 */
module.exports = async () => {
  try {
    const summary = await pmEngine.evaluateAll();
    if (summary.created > 0) {
      console.log(`[preventiveMaintenance] raised ${summary.created} PM ticket(s) across ${summary.companies} company(ies)`);
    }
    if (summary.failed.length) {
      console.error('[preventiveMaintenance] some companies failed:', summary.failed);
    }
  } catch (err) {
    console.error('[preventiveMaintenance] run failed:', err.message);
  }
};
