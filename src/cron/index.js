const cron = require('node-cron');
const hourlyJob = require('./hourlyOee.job');
const shiftJob = require('./shiftOee.job');
const transferCleanupJob = require('./programTransferCleanup.job');
const preventiveJob = require('./preventiveMaintenance.job');
const periodicJob = require('./periodicMaintenance.job');

const OPTS = { timezone: 'Asia/Kolkata' };

cron.schedule('*/10 * * * *', shiftJob,  OPTS); // check every 10 mins (IST)
cron.schedule('0 * * * *',    hourlyJob, OPTS); // every hour on the hour (IST)
cron.schedule('*/10 * * * *', transferCleanupJob, OPTS); // mark stuck PENDING transfers FAILED
cron.schedule('*/15 * * * *', preventiveJob, OPTS);      // raise PM tickets from breached alarm thresholds
cron.schedule('*/15 * * * *', periodicJob, OPTS);        // raise periodic tickets whose due date has arrived

// catch transfers orphaned by the restart itself, without waiting 10 min
transferCleanupJob();
