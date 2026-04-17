const cron = require('node-cron');
const hourlyJob = require('./hourlyOee.job');
const shiftJob = require('./shiftOee.job');

const OPTS = { timezone: 'Asia/Kolkata' };

cron.schedule('*/10 * * * *', shiftJob,  OPTS); // check every 10 mins (IST)
cron.schedule('0 * * * *',    hourlyJob, OPTS); // every hour on the hour (IST)
