/*
 * Heavy requests — exports, reports, long telemetry windows — run a few at a
 * time per company and a few more across all companies, so one company's
 * month-end exports cannot take every database connection and slow the live
 * screens of everyone else. The API holds DB_POOL_MAX (20) connections; with
 * at most 3 heavy requests per company and 8 in all, at least 12 stay free
 * for the dashboards whatever any one company does.
 *
 * Over the limit a request waits its turn — the person sees a slower
 * download, not an error. Waiting is first come, first served, except that a
 * company at its own limit does not hold up the companies behind it. Only a
 * long wait (30 s) or a long line (50) is answered, with 503 / 429.
 *
 * Counted in this process: run one API instance, or lower the numbers per
 * instance (HEAVY_PER_COMPANY, HEAVY_OVERALL).
 */

function createHeavyLimiter({
  perCompany = Number(process.env.HEAVY_PER_COMPANY || 3),
  overall = Number(process.env.HEAVY_OVERALL || 8),
  maxWaitMs = 30000,
  maxQueue = 50
} = {}) {
  const running = new Map();      // company (or user, for S&T) -> requests running
  let runningAll = 0;
  const queue = [];               // { key, start, timer }

  const canStart = key => runningAll < overall && (running.get(key) || 0) < perCompany;

  function startNext() {
    for (let i = 0; i < queue.length && runningAll < overall; i++) {
      if (!canStart(queue[i].key)) continue;
      const [entry] = queue.splice(i--, 1);
      clearTimeout(entry.timer);
      entry.start();
    }
  }

  function limiter(req, res, next) {
    const key = req.user?.company_id != null ? `c${req.user.company_id}` : `u${req.user?.id}`;

    const start = () => {
      runningAll++;
      running.set(key, (running.get(key) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        runningAll--;
        const n = running.get(key) - 1;
        if (n) running.set(key, n); else running.delete(key);
        startNext();
      };
      res.on('finish', release);
      res.on('close', release);
      next();
    };

    if (canStart(key)) return start();

    if (queue.length >= maxQueue) {
      return res.status(429).json({ message: 'Many large reports are being prepared right now. Try again in a minute.', code: 'REPORTS_BUSY' });
    }
    const entry = { key, start };
    entry.timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      if (!res.headersSent) {
        res.status(503).json({ message: 'Large reports are busy right now. Try again in a minute.', code: 'REPORTS_BUSY' });
      }
    }, maxWaitMs);
    entry.timer.unref?.();        // a wait in line never keeps the process up
    queue.push(entry);
    // the person gave up (closed the tab): leave the line
    res.on('close', () => {
      const i = queue.indexOf(entry);
      if (i >= 0) { queue.splice(i, 1); clearTimeout(entry.timer); }
    });
  }

  limiter.stats = () => ({ running: runningAll, waiting: queue.length, byCompany: Object.fromEntries(running) });
  return limiter;
}

const heavy = createHeavyLimiter();

/** The spindle panel is light over an hour and heavy over a day. */
heavy.forRanges = (...ranges) => (req, res, next) =>
  (ranges.includes(String(req.query.range)) ? heavy(req, res, next) : next());

module.exports = heavy;
module.exports.createHeavyLimiter = createHeavyLimiter;
