const { processDueAlarms } = require('../alarms/alarm-notification.service');

// A bounded scan every 15 seconds; the database retains pending work across
// restarts. The scheduler's PostgreSQL lock prevents overlapping API runners.
module.exports = async () => {
  const deadline = Date.now() + 5000;
  let delivered = 0;
  // Short transactions drain simultaneous fleet faults without an unlimited
  // work loop. Any remaining backlog is durable and continues next tick.
  for (let batch = 0; batch < 4 && Date.now() < deadline; batch++) {
    const result = await processDueAlarms({ batchSize: 100 });
    delivered += result.delivered;
    if (result.checked < 100) break;
  }
  if (delivered) console.log(`[alarmNotifications] delivered ${delivered} alarm occurrence(s)`);
};
