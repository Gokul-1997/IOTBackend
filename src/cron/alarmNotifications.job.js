const { processDueAlarms, pruneProcessedEvents } = require('../alarms/alarm-notification.service');
let lastCleanup = 0;

// A bounded scan every 15 seconds; the database retains pending work across
// restarts. The scheduler's PostgreSQL lock prevents overlapping API runners.
module.exports = async () => {
  const deadline = Date.now() + 5000;
  let delivered = 0;
  let hasMore = false;
  // Short transactions drain simultaneous fleet faults without an unlimited
  // work loop. Any remaining backlog is durable and continues next tick.
  for (let batch = 0; batch < 4 && Date.now() < deadline; batch++) {
    const result = await processDueAlarms({ batchSize: 100 });
    delivered += result.delivered;
    // A full batch with no progress can mean users opted out. Do not run a
    // hot retry loop; the next event or recovery tick will try it again.
    hasMore = result.checked >= 100 && result.progressed !== 0;
    if (result.checked < 100) break;
  }
  if (delivered) console.log(`[alarmNotifications] delivered ${delivered} alarm occurrence(s)`);
  if (Date.now() - lastCleanup >= 15 * 60 * 1000) {
    const removed = await pruneProcessedEvents();
    if (removed < 1000) lastCleanup = Date.now();
    else hasMore = true; // keep each delete bounded while catching up a busy fleet
  }
  return { delivered, hasMore };
};
