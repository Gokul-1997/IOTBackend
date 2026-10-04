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
const num = v => (v === null || v === undefined ? null : Number(v));
const ms = v => (v ? new Date(v).getTime() : null);
/* A running total's rise from the first reading to the last; null when it
   fell (a reset or replaced meter) or either end is missing. */
const rise = (first, last) => (first == null || last == null || Number(last) < Number(first) ? null : Number(last) - Number(first));

exports.RANGES = RANGES;
exports.LIMITS = LIMITS;
exports.READING_COLUMNS = READING_COLUMNS;

/** Machines of this company that have sent meter readings in the last 30 days. */
async function meters(companyId, nowMs) {
  const { rows } = await db.query(
    `SELECT m.id, m.machine_serial_no, MAX(r.read_at) AS last_read_at
       FROM energy_meter_readings r
       JOIN machines m ON m.id = r.machine_id
      WHERE m.company_id = $1 AND r.read_at >= $2
      GROUP BY m.id, m.machine_serial_no
      ORDER BY m.machine_serial_no`,
    [companyId, new Date(nowMs - LOOKBACK_MS)]
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
  const r = RANGES[range];
  if (!r) throw httpError(`range must be one of ${Object.keys(RANGES).join(', ')}`, 400);
  let id = null;
  if (machineId !== undefined && machineId !== null && machineId !== '') {
    id = Number(machineId);
    if (!Number.isInteger(id) || id <= 0) throw httpError('machine_id must be a positive integer', 400);
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
    const { rows } = await db.query(`SELECT id, machine_serial_no FROM machines WHERE id = $1 AND company_id = $2`, [id, companyId]);
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
        ORDER BY read_at DESC LIMIT 1`,
      [machine.id, new Date(nowMs - LOOKBACK_MS), to]),
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
        GROUP BY 1
        ORDER BY 1`,
      [machine.id, from, to, interval]),
    /* Energy used per interval, from the running total: consecutive real
       readings only (a 0 is a dropped read), a fall counts nothing, and so
       does a rise no machine could draw — the Energy screen's rules. */
    db.query(
      `WITH steps AS (
         SELECT read_at, kwh_total,
                LAG(kwh_total) OVER w AS prev_kwh,
                LAG(read_at)   OVER w AS prev_at
           FROM energy_meter_readings
          WHERE machine_id = $1 AND read_at >= $2 AND read_at <= $3 AND kwh_total > 0
         WINDOW w AS (ORDER BY read_at)
       )
       SELECT (EXTRACT(EPOCH FROM date_bin($4::interval, read_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')) * 1000)::bigint AS t,
              SUM(CASE
                    WHEN prev_kwh IS NULL OR kwh_total <= prev_kwh THEN 0
                    WHEN kwh_total - prev_kwh
                         > ${MAX_KW} * GREATEST(EXTRACT(EPOCH FROM read_at - prev_at), ${MIN_WINDOW_SEC}) / 3600.0 THEN 0
                    ELSE kwh_total - prev_kwh
                  END)::float AS kwh
         FROM steps
        GROUP BY 1
        ORDER BY 1`,
      [machine.id, from, to, interval]),
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
              AVG(frequency_hz)::float AS hz_avg, MIN(frequency_hz)::float AS hz_min, MAX(frequency_hz)::float AS hz_max,
              (ARRAY_AGG(kwh_import   ORDER BY read_at)      FILTER (WHERE kwh_import   > 0))[1] AS kwh_import_first,
              (ARRAY_AGG(kwh_import   ORDER BY read_at DESC) FILTER (WHERE kwh_import   > 0))[1] AS kwh_import_last,
              (ARRAY_AGG(kwh_export   ORDER BY read_at)      FILTER (WHERE kwh_export   > 0))[1] AS kwh_export_first,
              (ARRAY_AGG(kwh_export   ORDER BY read_at DESC) FILTER (WHERE kwh_export   > 0))[1] AS kwh_export_last,
              (ARRAY_AGG(kvarh_total  ORDER BY read_at)      FILTER (WHERE kvarh_total  > 0))[1] AS kvarh_first,
              (ARRAY_AGG(kvarh_total  ORDER BY read_at DESC) FILTER (WHERE kvarh_total  > 0))[1] AS kvarh_last,
              (ARRAY_AGG(kvah_total   ORDER BY read_at)      FILTER (WHERE kvah_total   > 0))[1] AS kvah_first,
              (ARRAY_AGG(kvah_total   ORDER BY read_at DESC) FILTER (WHERE kvah_total   > 0))[1] AS kvah_last
         FROM energy_meter_readings
        WHERE machine_id = $1 AND read_at >= $2 AND read_at <= $3`,
      [machine.id, from, to])
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
  const kwhSteps = energyQ.rows.length ? energyQ.rows.reduce((a, e) => a + (num(e.kwh) || 0), 0) : null;
  const summary = {
    readings: s.readings || 0,
    first_at: ms(s.first_at), last_at: ms(s.last_at),
    kwh_used:   kwhSteps,
    kwh_import: rise(s.kwh_import_first, s.kwh_import_last),
    kwh_export: rise(s.kwh_export_first, s.kwh_export_last),
    kvarh:      rise(s.kvarh_first, s.kvarh_last),
    kvah:       rise(s.kvah_first, s.kvah_last),
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
