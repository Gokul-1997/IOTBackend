const db = require('../db');
const hourly = require('../dashboard/energy-hourly.service');

/*
 * Every 10 minutes: keep each company's energy per machine per hour
 * (energy_hourly) up to the last final hour, and work its history back to
 * 100 days a week at a time — what the electricity bill forecast reads
 * (dashboard/energy-hourly.service.js). Companies whose meters sent nothing
 * this week are skipped. Each company gets at most a minute a run and the
 * run at most five, so a long first back-fill spreads over several runs.
 */
const RUN_MS = 5 * 60_000;
const COMPANY_MS = 60_000;

module.exports = async function energyHourly() {
  const deadline = Date.now() + RUN_MS;
  const { rows } = await db.query('SELECT id FROM companies WHERE is_active IS NOT FALSE ORDER BY id');
  for (const { id } of rows) {
    if (Date.now() >= deadline) break;
    try {
      if (!(await hourly.hasRecentReadings(id))) continue;
      await hourly.extend(id, { deadline: Math.min(deadline, Date.now() + COMPANY_MS) });
    } catch (err) {
      // one company's failure does not stop the others
      console.error(`[cron:energy-hourly] company ${id}:`, err.message);
    }
  }
};
