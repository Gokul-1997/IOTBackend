/*
 * Phase 2 · Screen 9 — the energy meter's own readings.
 *
 * energy_meter_readings (migration 029) keeps everything a machine's
 * 3-phase meter sends — each phase's volts and amps, kW / kVA / kVAr, power
 * factor, frequency, demand, the meter's highest values and its
 * import/export registers — one row per machine at most every 15 s. This
 * serves one machine at a time, to the Energy screen and the machine page:
 *
 *   latest   the newest reading, and whether it is current
 *   points   the trend over the chosen range, bucketed to ~50–60 points
 *   summary  what the range adds up to: energy used, highs and lows
 *   checks   what the readings say about the meter itself
 *
 * Readings are shown as the meter reports them. One thing is checked: a
 * meter whose current transformers face the wrong way reports a running
 * machine as negative kW and counts its energy as Export (VMC - 1 - F on
 * 3 Oct 2026). That is said in plain words rather than "corrected".
 *
 * date_bin, not TimescaleDB's time_bucket, so this runs on any PostgreSQL 14+.
 */
const db = require('../db');
const { plantSql } = require('../lib/read-scope');
const { machineOrder } = require('../lib/machine-order');

const RANGES = {
  '1h':  { seconds: 3600,       bucket: 60 },
  '4h':  { seconds: 4 * 3600,   bucket: 300 },
  '12h': { seconds: 12 * 3600,  bucket: 900 },
  '24h': { seconds: 24 * 3600,  bucket: 1800 },
  '7d':  { seconds: 7 * 86400,  bucket: 3 * 3600 }
};

/* Rows are written every 15 s, so two minutes without one is not "now". */
const STALE_MS = 120e3;
/* How far back a meter and its latest reading are looked for: bounded so
   the hypertable prunes chunks. */
const LOOKBACK_MS = 30 * 86400e3;
/* The same misread rule as the Energy screen and the collector: a rise
   faster than this since the last real reading counts nothing. */
const MAX_KW = 2000;
const MIN_WINDOW_SEC = 300;

/* Guidance the screen colours readings by. A 415 V three-phase supply; IS
   12360 allows ±10 %. Most supply companies want power factor at 0.9 or
   better. Imbalance over 2 % (voltage) or 10 % (current) is worth a look. */
const LIMITS = {
  v_ll_nominal: 415, v_tolerance_pct: 10,
  pf_good: 0.95, pf_low: 0.9,
  hz_min: 49.5, hz_max: 50.5,
  v_imbalance_pct: 2, i_imbalance_pct: 10
};

/* Every column of a reading, in table order (pms-backend METER_FIELDS). */
const READING_COLUMNS = [
  'v1n', 'v2n', 'v3n', 'v_ln_avg', 'v12', 'v23', 'v31', 'v_ll_avg',
  'i1', 'i2', 'i3', 'i_avg',
  'kw1', 'kw2', 'kw3', 'kw_total', 'kvar1', 'kvar2', 'kvar3', 'kvar_total', 'kva1', 'kva2', 'kva3', 'kva_total',
  'pf1', 'pf2', 'pf3', 'pf_avg', 'frequency_hz',
  'kw_demand_max', 'kw_demand_min', 'kvar_demand_max', 'kvar_demand_min', 'kva_demand_max',
  'v1n_max', 'v2n_max', 'v3n_max', 'v12_max', 'v23_max', 'v31_max', 'i1_max', 'i2_max', 'i3_max',
  'kwh_import', 'kwh_export', 'kwh_total', 'kvarh_import', 'kvarh_export', 'kvarh_total', 'kvah_total',
  'run_hours', 'aux_interrupts'
];

const httpError = (message, status) => Object.assign(new Error(message), { status });
const num = v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const ms = v => (v ? new Date(v).getTime() : null);
const COUNTERS = ['kwh', 'kwh_import', 'kwh_export', 'kvarh', 'kvah'];
/* Null is an unknown interval, not evidence of zero consumption. */
const measuredSum = (rows, key) => {
  const values = rows.map(row => num(row[key])).filter(v => v !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
};

exports.RANGES = RANGES;
exports.LIMITS = LIMITS;
exports.READING_COLUMNS = READING_COLUMNS;

/** Machines of this company that have sent meter readings in the last 30 days. */
async function meters(companyId, nowMs) {
  const { rows } = await db.query(
    `SELECT m.id, m.machine_serial_no, latest.read_at AS last_read_at
       FROM machines m
       JOIN LATERAL (
         SELECT r.read_at FROM energy_meter_readings r
          WHERE r.machine_id = m.id AND r.company_id = $1
            AND r.read_at >= $2 AND r.read_at <= $3
          ORDER BY r.read_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE m.company_id = $1${plantSql('m.id')}
      ORDER BY ${machineOrder('m.machine_serial_no')}`,
    [companyId, new Date(nowMs - LOOKBACK_MS), new Date(nowMs)]
  );
  return rows.map(r => ({ id: r.id, serial: r.machine_serial_no, last_read_at: ms(r.last_read_at) }));
}

/** Does the meter look wired the wrong way round? Negative kW and power factor, and more Export than Import. */
function checksFor(latest) {
  if (!latest) return { ct_reversed: false };
  const exportOutruns = latest.kwh_export != null && latest.kwh_import != null && latest.kwh_export > latest.kwh_import;
  const negative = (latest.kw_total != null && latest.kw_total < 0) || (latest.pf_avg != null && latest.pf_avg < 0);
  return { ct_reversed: exportOutruns && negative };
}

/**
 * One machine's meter. machineId may be omitted on the Energy screen: the
 * first machine with a meter is shown. Returns null for a machine that is
 * not this company's.
 */
exports.meterReadings = async ({ companyId, machineId, range = '24h', nowMs = Date.now() }) => {
  if (!Number.isSafeInteger(Number(companyId)) || Number(companyId) <= 0) throw httpError('No company assigned', 403);
  if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) throw httpError(`range must be one of ${Object.keys(RANGES).join(', ')}`, 400);
  const r = RANGES[range];
  let id = null;
  if (machineId !== undefined && machineId !== null && machineId !== '') {
    id = Number(machineId);
    if ((typeof machineId !== 'number' && typeof machineId !== 'string') || !Number.isSafeInteger(id) || id <= 0) throw httpError('machine_id must be a positive integer', 400);
  }

  const from = new Date(nowMs - r.seconds * 1000);
  const to = new Date(nowMs);
  const rangeOut = { key: range, from: from.getTime(), to: to.getTime(), bucket_seconds: r.bucket };

  /* Before migration 029 has run there is no table, and so no meter yet —
     an empty answer, not a 500 the screen would read as a lost connection. */
  let list;
  try {
    list = await meters(companyId, nowMs);
  } catch (err) {
    if (err && err.code === '42P01') {
      return { meters: [], machine: null, range: rangeOut, latest: null, points: [],
               summary: { readings: 0 }, checks: { ct_reversed: false }, limits: LIMITS };
    }
    throw err;
  }

  let machine = null;
  if (id !== null) {
    const { rows } = await db.query(`SELECT id, machine_serial_no FROM machines WHERE id = $1 AND company_id = $2${plantSql('id')}`, [id, companyId]);
    if (!rows.length) return null;
    machine = { id: rows[0].id, serial: rows[0].machine_serial_no };
  } else if (list.length) {
    machine = { id: list[0].id, serial: list[0].serial };
  }

  const empty = { meters: list, machine, range: rangeOut, latest: null, points: [],
                  summary: { readings: 0 }, checks: { ct_reversed: false }, limits: LIMITS };
  if (!machine) return empty;

  const interval = `${r.bucket} seconds`;
  const [latestQ, pointsQ, energyQ, summaryQ] = await Promise.all([
    db.query(
      `SELECT * FROM energy_meter_readings
        WHERE machine_id = $1 AND read_at >= $2 AND read_at <= $3
          AND company_id = $4${plantSql('machine_id')}
        ORDER BY read_at DESC LIMIT 1`,
      [machine.id, new Date(nowMs - LOOKBACK_MS), to, companyId]),
    db.query(
      `SELECT (EXTRACT(EPOCH FROM date_bin($4::interval, read_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')) * 1000)::bigint AS t,
              COUNT(*)::int                           AS samples,
              AVG(kw_total)::float                    AS kw_avg,
              MIN(kw_total)::float                    AS kw_min,
              MAX(kw_total)::float                    AS kw_max,
              AVG(kva_total)::float                   AS kva_avg,
              MAX(kva_total)::float                   AS kva_max,
              AVG(i_avg)::float                       AS i_avg,
              MAX(GREATEST(i1, i2, i3))::float        AS i_max,
              AVG(v_ll_avg)::float                    AS v_ll_avg,
              MIN(LEAST(v12, v23, v31))::float        AS v_ll_min,
              MAX(GREATEST(v12, v23, v31))::float     AS v_ll_max,
              AVG(pf_avg)::float                      AS pf_avg,
              MIN(pf_avg)::float                      AS pf_min,
              AVG(frequency_hz)::float                AS hz_avg
         FROM energy_meter_readings
        WHERE machine_id = $1 AND read_at >= $2 AND read_at <= $3
          AND company_id = $5${plantSql('machine_id')}
        GROUP BY 1
        ORDER BY 1`,
      [machine.id, from, to, interval, companyId]),
    /* Energy used per interval, from measured counter pairs. Missing,
       reset and implausible pairs are unknown, never manufactured zero.
       A zero total is a dropped read. For other registers, zero is useful
       before the first positive reading (unused Import/Export), but not
       after it: 100 -> dropped 0 -> 101 must not count 101 units. */
    db.query(
      `WITH reported AS (
         SELECT read_at, register, value
           FROM energy_meter_readings
           CROSS JOIN LATERAL (VALUES
             ('kwh', kwh_total), ('kwh_import', kwh_import), ('kwh_export', kwh_export),
             ('kvarh', kvarh_total), ('kvah', kvah_total)
           ) AS counter(register, value)
          WHERE machine_id = $1 AND read_at >= $2 AND read_at <= $3
            AND company_id = $5${plantSql('machine_id')}
            AND value >= 0 AND value < 'Infinity'::float8
       ), observed AS (
         SELECT *, COUNT(*) FILTER (WHERE value > 0) OVER (
                    PARTITION BY register ORDER BY read_at
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                  ) AS positive_before
           FROM reported
       ), counters AS (
         SELECT read_at, register, value
           FROM observed
          WHERE value > 0 OR (register <> 'kwh' AND positive_before = 0)
       ), steps AS (
         SELECT read_at, register, value,
                LAG(value) OVER w AS prev_value,
                LAG(read_at)   OVER w AS prev_at
           FROM counters
         WINDOW w AS (PARTITION BY register ORDER BY read_at)
       ), measured AS (
         SELECT *, CASE
                    WHEN prev_value IS NULL OR value < prev_value THEN NULL
                    WHEN value - prev_value
                         > ${MAX_KW} * GREATEST(EXTRACT(EPOCH FROM read_at - prev_at), ${MIN_WINDOW_SEC}) / 3600.0 THEN NULL
                    ELSE value - prev_value
                  END AS used
           FROM steps
       )
       SELECT (EXTRACT(EPOCH FROM date_bin($4::interval, read_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')) * 1000)::bigint AS t,
              ${COUNTERS.map(key => `SUM(used) FILTER (WHERE register = '${key}')::float AS ${key}`).join(',\n              ')},
              COUNT(*) FILTER (WHERE register = 'kwh' AND used IS NOT NULL)::int AS energy_intervals,
              COUNT(*) FILTER (WHERE register = 'kwh' AND prev_value IS NOT NULL AND used IS NULL)::int AS energy_rejected_intervals
         FROM measured
        GROUP BY 1
        ORDER BY 1`,
      [machine.id, from, to, interval, companyId]),
    db.query(
      `SELECT COUNT(*)::int                                   AS readings,
              MIN(read_at)                                    AS first_at,
              MAX(read_at)                                    AS last_at,
              AVG(kw_total)::float AS kw_avg, MIN(kw_total)::float AS kw_min, MAX(kw_total)::float AS kw_max,
              MAX(ABS(kw_total))::float                       AS kw_peak,
              AVG(kva_total)::float AS kva_avg, MAX(kva_total)::float AS kva_max,
              AVG(i_avg)::float AS i_avg, MAX(GREATEST(i1, i2, i3))::float AS i_max,
              AVG(v_ll_avg)::float AS v_ll_avg, MIN(LEAST(v12, v23, v31))::float AS v_ll_min, MAX(GREATEST(v12, v23, v31))::float AS v_ll_max,
              AVG(v_ln_avg)::float AS v_ln_avg, MIN(LEAST(v1n, v2n, v3n))::float AS v_ln_min, MAX(GREATEST(v1n, v2n, v3n))::float AS v_ln_max,
              AVG(pf_avg)::float AS pf_avg, MIN(pf_avg)::float AS pf_min,
              AVG(frequency_hz)::float AS hz_avg, MIN(frequency_hz)::float AS hz_min, MAX(frequency_hz)::float AS hz_max
         FROM energy_meter_readings
        WHERE machine_id = $1 AND read_at >= $2 AND read_at <= $3
          AND company_id = $4${plantSql('machine_id')}`,
      [machine.id, from, to, companyId])
  ]);

  let latest = null;
  const l = latestQ.rows[0];
  if (l) {
    latest = { at: ms(l.read_at), stale: nowMs - ms(l.read_at) > STALE_MS };
    for (const c of READING_COLUMNS) latest[c] = num(l[c]);
  }

  const kwhByT = new Map(energyQ.rows.map(e => [Number(e.t), num(e.kwh)]));
  const points = pointsQ.rows.map(p => ({
    t: Number(p.t), samples: p.samples,
    kw_avg: num(p.kw_avg), kw_min: num(p.kw_min), kw_max: num(p.kw_max),
    kva_avg: num(p.kva_avg), kva_max: num(p.kva_max),
    i_avg: num(p.i_avg), i_max: num(p.i_max),
    v_ll_avg: num(p.v_ll_avg), v_ll_min: num(p.v_ll_min), v_ll_max: num(p.v_ll_max),
    pf_avg: num(p.pf_avg), pf_min: num(p.pf_min),
    hz_avg: num(p.hz_avg),
    kwh: kwhByT.has(Number(p.t)) ? kwhByT.get(Number(p.t)) : null
  }));

  const s = summaryQ.rows[0] || {};
  const summary = {
    readings: s.readings || 0,
    first_at: ms(s.first_at), last_at: ms(s.last_at),
    kwh_used:   measuredSum(energyQ.rows, 'kwh'),
    kwh_import: measuredSum(energyQ.rows, 'kwh_import'),
    kwh_export: measuredSum(energyQ.rows, 'kwh_export'),
    kvarh:      measuredSum(energyQ.rows, 'kvarh'),
    kvah:       measuredSum(energyQ.rows, 'kvah'),
    energy_intervals: energyQ.rows.reduce((total, row) => total + (num(row.energy_intervals) || 0), 0),
    energy_rejected_intervals: energyQ.rows.reduce((total, row) => total + (num(row.energy_rejected_intervals) || 0), 0),
    kw:   { avg: num(s.kw_avg), min: num(s.kw_min), max: num(s.kw_max), peak: num(s.kw_peak) },
    kva:  { avg: num(s.kva_avg), max: num(s.kva_max) },
    i:    { avg: num(s.i_avg), max: num(s.i_max) },
    v_ll: { min: num(s.v_ll_min), avg: num(s.v_ll_avg), max: num(s.v_ll_max) },
    v_ln: { min: num(s.v_ln_min), avg: num(s.v_ln_avg), max: num(s.v_ln_max) },
    pf:   { avg: num(s.pf_avg), min: num(s.pf_min) },
    hz:   { min: num(s.hz_min), avg: num(s.hz_avg), max: num(s.hz_max) }
  };

  return { meters: list, machine, range: rangeOut, latest, points, summary, checks: checksFor(latest), limits: LIMITS };
};
