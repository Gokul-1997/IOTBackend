/*
 * Energy per machine per hour, worked out once and kept (energy_hourly, 055).
 *
 * The Energy screen measures consumption by differencing each meter's
 * running total between consecutive real readings (energy.service.js). Over
 * a month that means reading every reading again — most of them in telemetry
 * compressed after a week — on every request. The bill forecast needs a month
 * and more of history each time it is opened, so the same differences are
 * worked out here once an hour and kept:
 *
 *   - the screen's rule: only real readings (energy > 0); a fall counts
 *     nothing (a reset or replaced meter); a rise faster than 2,000 kW since
 *     the last reading (measured over at least 5 minutes) is a misread and
 *     counts nothing;
 *   - each rise belongs to the IST hour of the later reading, as the screen
 *     gives it to that reading's day, so an hour's figures add up to the
 *     screen's day;
 *   - the first reading of a stretch is compared with the machine's last
 *     reading before it (up to 2 days back), so no interval is lost where two
 *     stretches meet;
 *   - an hour is kept once it is 15 minutes over: readings arrive within
 *     seconds, and the collector sets aside anything more than 5 minutes
 *     late, so a kept hour does not change afterwards.
 *
 * energy_hourly_coverage records, per company, the hours worked out
 * ([from_hour, to_hour)), so an hour with no row is known to have used
 * nothing rather than not to have been looked at. The energy-hourly job
 * (src/cron) moves it forward every 10 minutes and back to HISTORY_DAYS a
 * week at a time. Reading never waits for it: the hours not kept yet are
 * worked out from the readings on the spot (at most MAX_TAIL of them).
 */
const db = require('../db');

const HOUR_MS = 3_600_000;
const IST_OFFSET_MS = 330 * 60_000;
/** An hour is final this long after it ends. */
const SETTLE_MS = 15 * 60_000;
/** How far back the job keeps hours. */
const HISTORY_DAYS = 100;
/** Most the reading side works out from raw readings itself, when the job is behind. */
const MAX_TAIL_MS = 48 * HOUR_MS;
/* The Energy screen's misread rule (energy.service.js, pms-backend energy-step.js). */
const MAX_KW = 2000;
const MIN_WINDOW_SEC = 300;

/** The start of the IST hour `ms` falls in. */
const istHour = ms => Math.floor((ms + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS;

/** Hours before this are final and may be kept. */
const settledUntil = (now = Date.now()) => istHour(now - SETTLE_MS);

/*
 * kWh per machine per IST hour for the readings received in [$2, $3), each
 * machine's first one compared with its last reading before $2.
 */
const HOURS_SQL = `
  WITH span AS (
    SELECT t.machine_id, t.received_at, t.energy
      FROM telemetry_raw t
     WHERE t.company_id = $1
       AND t.received_at >= $2::timestamptz
       AND t.received_at <  $3::timestamptz
       AND t.energy > 0
  ),
  metered AS (SELECT DISTINCT machine_id FROM span),
  prior AS (
    SELECT p.machine_id, p.received_at, p.energy
      FROM metered mm
      CROSS JOIN LATERAL (
        SELECT t.machine_id, t.received_at, t.energy
          FROM telemetry_raw t
         WHERE t.machine_id = mm.machine_id
           AND t.company_id = $1
           AND t.received_at <  $2::timestamptz
           AND t.received_at >= $2::timestamptz - INTERVAL '2 days'
           AND t.energy > 0
         ORDER BY t.received_at DESC
         LIMIT 1
      ) p
  ),
  readings AS (
    SELECT machine_id, received_at, energy,
           LAG(energy)      OVER w AS prev_energy,
           LAG(received_at) OVER w AS prev_at
      FROM (SELECT machine_id, received_at, energy FROM span
            UNION ALL
            SELECT machine_id, received_at, energy FROM prior) r
    WINDOW w AS (PARTITION BY machine_id ORDER BY received_at)
  )
  SELECT machine_id,
         date_trunc('hour', received_at AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS hour_start,
         SUM(CASE
               WHEN energy <= prev_energy THEN 0
               WHEN energy - prev_energy <= (${MAX_KW} * ${MIN_WINDOW_SEC} / 3600.0)::float8 THEN energy - prev_energy
               WHEN energy - prev_energy
                    > ${MAX_KW} * GREATEST(EXTRACT(EPOCH FROM received_at - prev_at), ${MIN_WINDOW_SEC}) / 3600.0 THEN 0
               ELSE energy - prev_energy
             END)::float8 AS kwh,
         COUNT(*)::int AS readings
    FROM readings
   WHERE prev_energy IS NOT NULL
     AND received_at >= $2::timestamptz
   GROUP BY 1, 2`;

const toRow = r => ({
  machine_id: Number(r.machine_id),
  hour: new Date(r.hour_start).getTime(),
  kwh: Number(r.kwh),
  readings: Number(r.readings)
});

/** Works out [fromMs, toMs) from the readings; nothing is kept. */
async function compute(client, companyId, fromMs, toMs) {
  if (toMs <= fromMs) return [];
  const { rows } = await client.query(HOURS_SQL, [companyId, new Date(fromMs), new Date(toMs)]);
  return rows.map(toRow);
}

/** The hours kept for this company, as epoch ms; null when none are. */
async function coverageOf(client, companyId) {
  const { rows } = await client.query(
    'SELECT from_hour, to_hour FROM energy_hourly_coverage WHERE company_id = $1', [companyId]);
  return rows.length ? { from: new Date(rows[0].from_hour).getTime(), to: new Date(rows[0].to_hour).getTime() } : null;
}

/**
 * Work out and keep [fromMs, toMs), next to what is kept already, so the
 * kept hours stay one unbroken stretch. Returns the coverage after it, or
 * null when another process is filling this company right now.
 */
async function fillChunk(companyId, fromMs, toMs) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [lock] } = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1), $2) AS locked', ['energy-hourly', companyId]);
    if (!lock?.locked) { await client.query('ROLLBACK'); return null; }

    // read again under the lock: another process may have moved it meanwhile
    const cov = await coverageOf(client, companyId);
    if (cov && (fromMs > cov.to || toMs < cov.from)) {
      await client.query('ROLLBACK');
      return cov;                                    // would leave a hole: the caller asks again from here
    }

    const rows = await compute(client, companyId, fromMs, toMs);
    await client.query(
      'DELETE FROM energy_hourly WHERE company_id = $1 AND hour_start >= $2 AND hour_start < $3',
      [companyId, new Date(fromMs), new Date(toMs)]);
    if (rows.length) {
      await client.query(
        `INSERT INTO energy_hourly (machine_id, hour_start, company_id, kwh, readings)
         SELECT u.machine_id, u.hour_start, $1, u.kwh, u.readings
           FROM unnest($2::int[], $3::timestamptz[], $4::float8[], $5::int[])
                AS u(machine_id, hour_start, kwh, readings)
         ON CONFLICT (machine_id, hour_start) DO UPDATE
            SET company_id = EXCLUDED.company_id, kwh = EXCLUDED.kwh, readings = EXCLUDED.readings`,
        [companyId, rows.map(r => r.machine_id), rows.map(r => new Date(r.hour)), rows.map(r => r.kwh), rows.map(r => r.readings)]);
    }
    const { rows: [after] } = await client.query(
      `INSERT INTO energy_hourly_coverage (company_id, from_hour, to_hour) VALUES ($1, $2, $3)
       ON CONFLICT (company_id) DO UPDATE
          SET from_hour  = LEAST(energy_hourly_coverage.from_hour, EXCLUDED.from_hour),
              to_hour    = GREATEST(energy_hourly_coverage.to_hour, EXCLUDED.to_hour),
              updated_at = NOW()
       RETURNING from_hour, to_hour`,
      [companyId, new Date(fromMs), new Date(toMs)]);
    await client.query('COMMIT');
    return { from: new Date(after.from_hour).getTime(), to: new Date(after.to_hour).getTime() };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bring the kept hours up to the last final hour, then back towards
 * HISTORY_DAYS a week at a time — newest first, so the hours a forecast
 * needs most are kept soonest — until `deadline`. Returns the coverage.
 */
async function extend(companyId, { now = Date.now(), deadline = Date.now() + 60_000, historyDays = HISTORY_DAYS } = {}) {
  const until = settledUntil(now);
  const oldest = istHour(now - historyDays * 24 * HOUR_MS);
  let cov = await coverageOf(db, companyId);

  if (!cov) {
    cov = await fillChunk(companyId, Math.max(until - 24 * HOUR_MS, oldest), until);
    if (!cov) return null;
  }
  while (cov.to < until && Date.now() < deadline) {
    const next = await fillChunk(companyId, cov.to, Math.min(cov.to + 24 * HOUR_MS, until));
    if (!next || next.to <= cov.to) return next || cov;
    cov = next;
  }
  while (cov.from > oldest && Date.now() < deadline) {
    const next = await fillChunk(companyId, Math.max(cov.from - 7 * 24 * HOUR_MS, oldest), cov.from);
    if (!next || next.from >= cov.from) return next || cov;
    cov = next;
  }
  return cov;
}

/* One background fill per company at a time in this process. */
const running = new Map();

/**
 * Start filling in the background (a forecast opened before the job has
 * caught up). Never throws; the next request reads what it kept.
 */
function kick(companyId) {
  if (running.has(companyId)) return running.get(companyId);
  const work = extend(companyId, { deadline: Date.now() + 120_000 })
    .catch(err => { console.error('[energy-hourly]', companyId, err.message); return null; })
    .finally(() => running.delete(companyId));
  running.set(companyId, work);
  return work;
}

/** Whether the company's meters sent anything in the last week (the job skips the rest). */
async function hasRecentReadings(companyId) {
  const { rows } = await db.query(
    `SELECT 1 FROM telemetry_raw
      WHERE company_id = $1 AND energy > 0 AND received_at > NOW() - INTERVAL '7 days'
      LIMIT 1`, [companyId]);
  return rows.length > 0;
}

/**
 * kWh per machine per IST hour from `fromMs` to `now`: the kept hours, and
 * the ones not kept yet worked out from the readings now. `completeFrom` is
 * the first hour the answer is whole from — later than `fromMs` while older
 * hours are still being worked out.
 */
async function hours(companyId, fromMs, now = Date.now()) {
  const start = istHour(fromMs);
  const cov = await coverageOf(db, companyId);
  const tailLimit = istHour(now - MAX_TAIL_MS);
  const usable = cov && cov.to >= tailLimit && cov.to > start;

  const tailFrom = usable ? Math.max(cov.to, start) : Math.max(start, tailLimit);
  const completeFrom = usable ? Math.max(start, cov.from) : tailFrom;

  const [kept, tail] = await Promise.all([
    usable && tailFrom > completeFrom
      ? db.query(
          `SELECT machine_id, hour_start, kwh, readings FROM energy_hourly
            WHERE company_id = $1 AND hour_start >= $2 AND hour_start < $3`,
          [companyId, new Date(completeFrom), new Date(tailFrom)]).then(r => r.rows.map(toRow))
      : [],
    compute(db, companyId, tailFrom, now + 1)
  ]);
  return { rows: kept.concat(tail), completeFrom };
}

module.exports = {
  hours, extend, kick, hasRecentReadings, compute, coverageOf, fillChunk,
  istHour, settledUntil, HISTORY_DAYS, HOURS_SQL, HOUR_MS, IST_OFFSET_MS
};
