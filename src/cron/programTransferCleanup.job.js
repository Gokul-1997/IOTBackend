const { cleanupStuckTransfers } = require('../programs/program.service');

/*
 * Runs every 10 minutes.
 * FTP transfers time out after 30 seconds, so any program_transfers row
 * still PENDING after 5 minutes means the server restarted (or crashed)
 * mid-transfer. Mark those FAILED so the history page never shows
 * permanently stuck rows.
 */

module.exports = async () => {
  try {
    const fixed = await cleanupStuckTransfers();
    if (fixed > 0) {
      console.warn(`[programTransfer] marked ${fixed} stuck PENDING transfer(s) as FAILED`);
    }
  } catch (err) {
    console.error('[programTransfer] cleanup failed:', err.message);
  }
};
