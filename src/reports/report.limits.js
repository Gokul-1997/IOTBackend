/*
 * How much report may be delivered straight to the browser.
 *
 * The three report datasets are hourly rows joined across machines, shifts
 * and operators: a year of production for a 20-machine plant is ~175,000
 * rows. Sending that synchronously ties up a connection while Postgres
 * streams it, serialises it into one JSON response, and then asks the
 * browser to hold all of it — which is how a "report" becomes an outage.
 *
 * So a range up to three months is answered directly, and anything longer
 * is generated out of band and emailed. The cutoff is expressed in days
 * because months differ in length and the user picks dates, not months.
 */

const MAX_DIRECT_DAYS = 92;          // a full quarter, inclusive

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, field) {
  if (!value || !ISO_DATE.test(String(value))) {
    const e = new Error(`${field} must be a date in YYYY-MM-DD form`);
    e.status = 400; e.code = 'INVALID_DATE';
    throw e;
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    const e = new Error(`${field} is not a real date`);
    e.status = 400; e.code = 'INVALID_DATE';
    throw e;
  }
  return d;
}

/** Inclusive day count: the same date twice is one day, not zero. */
function rangeDays(date_from, date_to) {
  const from = parseDate(date_from, 'date_from');
  const to   = parseDate(date_to,   'date_to');

  if (to < from) {
    const e = new Error('date_to falls before date_from');
    e.status = 400; e.code = 'INVALID_RANGE';
    throw e;
  }
  return Math.round((to - from) / 86_400_000) + 1;
}

function exceedsDirectLimit(date_from, date_to) {
  return rangeDays(date_from, date_to) > MAX_DIRECT_DAYS;
}

/**
 * Throws unless the range is small enough to answer in the response.
 * The error carries the numbers so the client can say "104 days — the most
 * that can be downloaded directly is 92" rather than a bare refusal.
 */
function assertDirectRange(date_from, date_to) {
  const days = rangeDays(date_from, date_to);
  if (days > MAX_DIRECT_DAYS) {
    const e = new Error(
      `This range covers ${days} days. Up to ${MAX_DIRECT_DAYS} days can be downloaded directly; ` +
      'longer reports are emailed instead.'
    );
    e.status   = 413;
    e.code     = 'RANGE_TOO_LARGE';
    e.days     = days;
    e.max_days = MAX_DIRECT_DAYS;
    throw e;
  }
  return days;
}

module.exports = { MAX_DIRECT_DAYS, rangeDays, exceedsDirectLimit, assertDirectRange };
