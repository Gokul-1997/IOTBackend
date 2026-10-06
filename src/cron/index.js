const cron = require('node-cron');
const db = require('../db');
const hourlyJob = require('./hourlyOee.job');
const shiftJob = require('./shiftOee.job');
const programJobsTimeout = require('./programJobsTimeout.job');
const preventiveJob = require('./preventiveMaintenance.job');
const periodicJob = require('./periodicMaintenance.job');

/*
 * Scheduled jobs, run by exactly one process at a time.
 *
 * Every API process registers these schedules — a second pm2 instance, or a
 * developer's laptop running the API against the production database (as
 * happens here), used to run every job again at the same moment. Most jobs
 * are idempotent, but two runs of the preventive engine in the same instant
 * can both pass its "no ticket open yet" check and raise duplicate tickets.
 *
 * Each run now takes a Postgres advisory lock named after the job; a process
 * that does not get it skips that tick. CRON_ENABLED=false turns the jobs off
 * in a process altogether (set it on any machine that is not the server).
 */

const OPTS = { timezone: 'Asia/Kolkata' };
const tasks = [];

/** Run `job` only if no other process is running it right now. */
async function exclusive(name, job) {
  let client;
  try {
    client = await db.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`cron:${name}`]);
    if (!rows[0].ok) return;                       // another process has this tick
    try { await job(); }
    finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`cron:${name}`]).catch(() => {}); }
  } catch (err) {
    console.error(`[cron:${name}]`, err.message);
  } finally {
    client?.release();
  }
}

function schedule(expr, name, job) {
  tasks.push(cron.schedule(expr, () => exclusive(name, job), OPTS));
}

if (process.env.CRON_ENABLED !== 'false' && process.env.NODE_ENV !== 'test') {
  schedule('*/10 * * * *', 'shift-oee',        shiftJob);            // every 10 min (IST)
  schedule('0 * * * *',    'hourly-oee',       hourlyJob);           // on the hour (IST)
  schedule('*/5 * * * *',  'program-timeouts', programJobsTimeout);  // fail Program Transfer jobs no device finished
  schedule('*/15 * * * *', 'preventive',       preventiveJob);       // raise PM tickets from breached alarm thresholds
  schedule('*/15 * * * *', 'periodic',         periodicJob);         // raise periodic tickets whose due date has arrived
} else {
  console.log('Scheduled jobs are off in this process (CRON_ENABLED=false)');
}

module.exports = {
  stop() { for (const t of tasks) t.stop(); },
  exclusive
};
