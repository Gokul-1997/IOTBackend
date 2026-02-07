const cron = require('node-cron');
const hourlyJob = require('./hourlyOee.job');
const shiftJob = require('./shiftOee.job');

cron.schedule('*/10 * * * *', shiftJob); // check every 10 mins
cron.schedule('0 * * * *', hourlyJob); // every hour
