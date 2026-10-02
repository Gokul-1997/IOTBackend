/*
 * The machine page's spindle and feed panel: the latest reading, and how
 * load, speed and feed moved over a chosen range, from telemetry_raw.
 *
 * What the controllers send, and so what this can say:
 *   spindle_load   % of the spindle motor's rated load — past 100 is overload
 *   spindle_speed  rpm, actual
 *   feed_rate      mm/min, actual (rapid moves included)
 * None of it is a target: no programmed feed, no commanded speed, no
 * override %. The machine register's spindle_rpm (the rated maximum) is the
 * only reference value there is, so speed is shown against that.
 *
 * The trend is bucketed (TimescaleDB time_bucket) to 60–100 points. The
 * summary is worked out over the samples where the spindle was turning
 * (speed > 0) — an average that counted the idle zeros would describe
 * neither cutting nor standing still.
 */
const db = require('../db');

const RANGES = {
  '15m': { ms: 15 * 60e3,   bucket: '15 seconds', seconds: 15 },
  '1h':  { ms: 60 * 60e3,   bucket: '1 minute',   seconds: 60 },
  '4h':  { ms: 4 * 3600e3,  bucket: '3 minutes',  seconds: 180 },
  '12h': { ms: 12 * 3600e3, bucket: '10 minutes', seconds: 600 },
  '24h': { ms: 24 * 3600e3, bucket: '15 minutes', seconds: 900 }
};
/* The bands the machine page colours the load by */
const LOAD_HIGH = 80;
const LOAD_OVERLOAD = 100;
/* A reading older than this is not "now": the machine list's offline rule */
const STALE_MS = 60e3;
/* How far back the latest reading is looked for — a bound on received_at is
   what lets TimescaleDB prune chunks (see maintenance.service.js) */
const LATEST_LOOKBACK_MS = 24 * 3600e3;

const httpError = (message, status) => Object.assign(new Error(message), { status });
const num = v => (v === null || v === undefined ? null : Number(v));
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

exports.RANGES = RANGES;

exports.machineSpindle = async (machineId, companyId, range = '1h', nowMs = Date.now()) => {
  const id = Number(machineId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('machine_id must be a positive integer', 400);
  const r = RANGES[range];
  if (!r) throw httpError(`range must be one of ${Object.keys(RANGES).join(', ')}`, 400);

  const { rows: m } = await db.query(
    `SELECT id, machine_serial_no, spindle_rpm FROM machines WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!m.length) return null;

  const from = new Date(nowMs - r.ms);
  const to = new Date(nowMs);

  const [points, summary, latest] = await Promise.all([
    db.query(`
      SELECT (EXTRACT(EPOCH FROM time_bucket($4::interval, received_at)) * 1000)::bigint AS t,
             ROUND(AVG(spindle_load)::numeric, 1)::float AS load_avg,
             MAX(spindle_load)::float                    AS load_max,
             ROUND(AVG(spindle_speed))::int              AS rpm_avg,
             MAX(spindle_speed)::int                     AS rpm_max,
             ROUND(AVG(feed_rate))::int                  AS feed_avg,
             MAX(feed_rate)::float                       AS feed_max,
             COUNT(*)::int                               AS samples
        FROM telemetry_raw
       WHERE machine_id = $1 AND received_at >= $2 AND received_at < $3
       GROUP BY 1
       ORDER BY 1`, [id, from, to, r.bucket]),
    db.query(`
      SELECT COUNT(*)::int                                                          AS samples,
             COUNT(*) FILTER (WHERE spindle_speed > 0)::int                         AS turning,
             MIN(spindle_load) FILTER (WHERE spindle_speed > 0)::float              AS load_min,
             ROUND((AVG(spindle_load) FILTER (WHERE spindle_speed > 0))::numeric, 1)::float AS load_avg,
             MAX(spindle_load)::float                                               AS load_max,
             COUNT(*) FILTER (WHERE spindle_speed > 0 AND spindle_load >= $4)::int  AS load_high,
             COUNT(*) FILTER (WHERE spindle_speed > 0 AND spindle_load > $5)::int   AS load_over,
             MIN(spindle_speed) FILTER (WHERE spindle_speed > 0)::int               AS rpm_min,
             ROUND(AVG(spindle_speed) FILTER (WHERE spindle_speed > 0))::int        AS rpm_avg,
             MAX(spindle_speed)::int                                                AS rpm_max,
             COUNT(*) FILTER (WHERE feed_rate > 0)::int                             AS feeding,
             MIN(feed_rate) FILTER (WHERE feed_rate > 0)::float                     AS feed_min,
             ROUND(AVG(feed_rate) FILTER (WHERE feed_rate > 0))::int                AS feed_avg,
             MAX(feed_rate)::float                                                  AS feed_max,
             (EXTRACT(EPOCH FROM MIN(received_at)) * 1000)::bigint                  AS first_at,
             (EXTRACT(EPOCH FROM MAX(received_at)) * 1000)::bigint                  AS last_at
        FROM telemetry_raw
       WHERE machine_id = $1 AND received_at >= $2 AND received_at < $3`,
      [id, from, to, LOAD_HIGH, LOAD_OVERLOAD]),
    db.query(`
      SELECT (EXTRACT(EPOCH FROM received_at) * 1000)::bigint AS at,
             spindle_load::float AS load, spindle_speed::int AS rpm,
             feed_rate::float AS feed, machine_status AS status
        FROM telemetry_raw
       WHERE machine_id = $1 AND received_at > $2 AND received_at <= $3
       ORDER BY received_at DESC
       LIMIT 1`, [id, new Date(nowMs - LATEST_LOOKBACK_MS), to])
  ]);

  const rated = num(m[0].spindle_rpm) || null;
  const s = summary.rows[0] || {};
  const turning = Number(s.turning) || 0;
  const l = latest.rows[0];
  const rpmMax = num(s.rpm_max);

  return {
    machine: { id, serial: m[0].machine_serial_no, rated_rpm: rated },
    range: { key: range, from: from.getTime(), to: nowMs, bucket_seconds: r.seconds },
    thresholds: { load_high: LOAD_HIGH, load_overload: LOAD_OVERLOAD },
    latest: l ? {
      at: Number(l.at), load: num(l.load), rpm: num(l.rpm), feed: num(l.feed), status: l.status || null,
      stale: nowMs - Number(l.at) > STALE_MS
    } : null,
    points: points.rows.map(p => ({
      t: Number(p.t),
      load_avg: num(p.load_avg), load_max: num(p.load_max),
      rpm_avg: num(p.rpm_avg), rpm_max: num(p.rpm_max),
      feed_avg: num(p.feed_avg), feed_max: num(p.feed_max),
      samples: Number(p.samples) || 0
    })),
    summary: {
      samples: Number(s.samples) || 0,
      turning,
      first_at: num(s.first_at), last_at: num(s.last_at),
      load: {
        min: num(s.load_min), avg: num(s.load_avg), max: num(s.load_max),
        /* share of the time the spindle turned that it spent at 80 % or more,
           and over 100 % — counted in samples, which arrive at a steady rate */
        high_pct: share(Number(s.load_high) || 0, turning),
        overload_pct: share(Number(s.load_over) || 0, turning)
      },
      rpm: {
        min: num(s.rpm_min), avg: num(s.rpm_avg), max: rpmMax,
        max_of_rated_pct: rated && rpmMax !== null ? Math.round((rpmMax / rated) * 1000) / 10 : null
      },
      feed: { min: num(s.feed_min), avg: num(s.feed_avg), max: num(s.feed_max), feeding: Number(s.feeding) || 0 }
    }
  };
};
