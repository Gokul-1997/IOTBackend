/**
 * A machine's hour rate — what an hour of it costs, in rupees — and what the
 * time it loses costs at that rate.
 *
 * S AND T sent its rates on 6 Oct 2026 (₹350 to ₹2,800 an hour). The rate is
 * entered on the machine (Master → Machines); idle and alarm time are priced
 * with it on the Downtime and OEE screens.
 */
const MAX_RATE = 1000000;

const fail = (message) => Object.assign(new Error(message), { code: 'BAD_HOUR_RATE', status: 400 });

/** The rate as it is stored: a number of rupees, two decimals; empty means "not set" (null). */
function cleanHourRate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/,/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > MAX_RATE) {
    throw fail('The hour rate must be a number of rupees from 0 to 10,00,000.');
  }
  return Math.round(n * 100) / 100;
}

/** What `seconds` of a machine at `rate` ₹/hour cost, in whole rupees; null without a rate. */
function costOf(seconds, rate) {
  if (rate === null || rate === undefined) return null;
  const r = Number(rate);
  const s = Number(seconds) || 0;
  return Number.isFinite(r) ? Math.round((s / 3600) * r) : null;
}

module.exports = { cleanHourRate, costOf, MAX_RATE };
