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
const db = require('./energy-db');
const energyStore = require('./energy-store');
const { cleanElectrical, validSql } = require('../lib/energy-quality');
const { plantSql } = require('../lib/read-scope');
const { machineOrder } = require('../lib/machine-order');

const RANGES = {
  '1h':  { seconds: 3600,       bucket: 60 },
  '4h':  { seconds: 4 * 3600,   bucket: 300 },
  '12h': { seconds: 12 * 3600,  bucket: 900 },
  '24h': { seconds: 24 * 3600,  bucket: 1800 },
  '5d':  { seconds: 5 * 86400,  bucket: 2 * 3600 },
  '7d':  { seconds: 7 * 86400,  bucket: 3 * 3600 }
};

/* A channel not observed for two minutes is not a current measurement,
   even when a different channel has just arrived in a sparse packet. */
const STALE_MS = 120e3;
/* How far back a meter and its latest reading are looked for: bounded so
   the hypertable prunes chunks. */
const LOOKBACK_MS = 5 * 86400e3;
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
  'run_hours', 'aux_interrupts',
  'thd_v1n', 'thd_v2n', 'thd_v3n', 'thd_v12', 'thd_v23', 'thd_v31',
  'thd_i1', 'thd_i2', 'thd_i3'
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

/**
 * A sparse packet updates only the channels it actually reports. Find each
 * channel's last real observation in one bounded scan, then fetch those
 * exact rows by (machine_id, read_at). This avoids sorting/expanding a month
 * of full readings once for every channel. SQL identifiers and placeholders
 * here are internal constants, never request input.
 */
function latestMeterFieldsSQL(columns, {
  machine = '$1', company = '$4', from = '$2', to = '$3',
  activeOnly = false, upperExclusive = false, legacyOnly = false
} = {}) {
  if (!columns.length || columns.some(column => !READING_COLUMNS.includes(column))) throw new TypeError('Invalid meter fields');
  const projected = process.env.ENERGY_V2_ENABLED !== 'false' && !legacyOnly;
  const bound = `r.machine_id = ${machine} AND r.read_at >= ${from} AND r.read_at ${upperExclusive ? '<' : '<='} ${to}
          AND r.read_at <= NOW() AND r.company_id = ${company}${plantSql('r.machine_id')}${projected ? ' AND NOT (SELECT ready FROM readiness)' : ''}`;
  const owned = activeOnly ? `JOIN machines m ON m.id = r.machine_id AND m.company_id = ${company} AND m.is_active` : '';
  const legacy = `WITH latest_at AS MATERIALIZED (
    SELECT ${columns.map(c => `MAX(r.read_at) FILTER (WHERE ${validSql(c, 'r.' + c)}) AS ${c}_at`).join(',\n           ')}
      FROM energy_meter_readings r
      ${owned}
     WHERE ${bound}
  )
  SELECT MAX(r.read_at) AS read_at,
         jsonb_object_agg(field.name, to_jsonb(r) -> field.name) AS field_values,
         jsonb_object_agg(field.name, EXTRACT(EPOCH FROM r.read_at) * 1000) AS field_observed_at
    FROM latest_at
    CROSS JOIN LATERAL (VALUES ${columns.map(c => `('${c}', latest_at.${c}_at)`).join(',\n                              ')}) AS field(name, at)
    JOIN energy_meter_readings r ON r.machine_id = ${machine} AND r.read_at = field.at
    ${owned}
   WHERE ${bound}
   HAVING COUNT(*) > 0`;
  if (!projected) return legacy;
  // The readiness test is an initplan, so a ready company never scans its raw
  // history. Channel bounds apply independently; a future timestamp cannot
  // make an older channel look current or escape the requested window.
  return `WITH readiness AS MATERIALIZED (
    SELECT EXISTS(SELECT 1 FROM energy_pipeline_state WHERE company_id = ${company} AND ready) AS ready
  ), projected AS (
    SELECT MAX(to_timestamp(field.at / 1000.0)) AS read_at,
           jsonb_object_agg(field.name, l.field_values -> field.name) AS field_values,
           jsonb_object_agg(field.name, field.at) AS field_observed_at
      FROM energy_meter_latest l
      JOIN machines m ON m.id = l.machine_id AND m.company_id = l.company_id${activeOnly ? ' AND m.is_active' : ''}
      CROSS JOIN LATERAL (VALUES ${columns.map(column => `('${column}', (l.field_observed_at ->> '${column}')::double precision)`).join(',\n                                ')}) AS field(name, at)
     WHERE (SELECT ready FROM readiness) AND l.machine_id = ${machine} AND l.company_id = ${company}${plantSql('l.machine_id')}
       AND field.at >= EXTRACT(EPOCH FROM ${from}::timestamptz) * 1000
       AND field.at ${upperExclusive ? '<' : '<='} EXTRACT(EPOCH FROM ${to}::timestamptz) * 1000
       AND field.at <= EXTRACT(EPOCH FROM NOW()) * 1000
       AND l.field_values -> field.name IS NOT NULL AND l.field_values -> field.name <> 'null'::jsonb
     HAVING COUNT(*) > 0
  ), legacy AS (${legacy})
  SELECT * FROM projected UNION ALL SELECT * FROM legacy`;
}

function latestMeterSnapshot(row, columns, nowMs, staleMs = STALE_MS) {
  if (!row) return null;
  const values = row.field_values || row;
  const observed = row.field_observed_at;
  const latest = { at: null, stale: false };
  const times = {};
  const stale = {};
  for (const column of columns) {
    let value = cleanElectrical(column, values[column]);
    const candidate = observed ? num(observed[column]) : ms(row.read_at);
    if (candidate !== null && candidate > nowMs) value = null;
    latest[column] = value;
    const at = value !== null && Number.isFinite(candidate) && candidate <= nowMs ? candidate : null;
    times[column] = at;
    stale[column] = value === null ? null : at === null || nowMs - at > staleMs;
    if (at !== null) latest.at = latest.at === null ? at : Math.max(latest.at, at);
    if (stale[column]) latest.stale = true;
  }
  latest.field_observed_at = times;
  latest.field_stale = stale;
  return latest;
}

exports.latestMeterFieldsSQL = latestMeterFieldsSQL;
exports.latestMeterSnapshot = latestMeterSnapshot;

/** Machines of this company that have sent meter readings in the last 30 days. */
async function meters(companyId, nowMs, canonical = false) {
  if (canonical) {
    const { rows } = await db.query(`SELECT m.id,m.machine_serial_no,latest.read_at AS last_read_at
      FROM machines m JOIN energy_meter_latest l ON l.machine_id=m.id AND l.company_id=m.company_id
      JOIN LATERAL (SELECT MAX(to_timestamp((j.value::text)::double precision/1000.0)) AS read_at
        FROM jsonb_each(l.field_observed_at) j
        WHERE (j.value::text)::double precision >= EXTRACT(EPOCH FROM $2::timestamptz)*1000
          AND (j.value::text)::double precision <= EXTRACT(EPOCH FROM LEAST($3::timestamptz,NOW()))*1000
      ) latest ON latest.read_at IS NOT NULL
      WHERE m.company_id=$1${plantSql('m.id')}
      ORDER BY ${machineOrder('m.machine_serial_no')}`,
    [companyId,new Date(nowMs-LOOKBACK_MS),new Date(nowMs)]);
    return rows.map(row => ({ id: row.id,serial: row.machine_serial_no,last_read_at: ms(row.last_read_at) }));
  }
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

const ELECTRICAL_METRICS = ['kw_total','kva_total','i_avg','v_ll_avg','v_ln_avg','pf_avg','frequency_hz'];
const ELECTRICAL_EXTRA = ['kw_peak','i_max','v_ll_min','v_ll_max','v_ln_min','v_ln_max'];
/** Complete minutes use sum/count rollups. At most two partial minutes read
 * typed samples, so a seven-day chart never rereads seven days of raw rows. */
function electricalSQL() {
  const aggregateColumns = ELECTRICAL_METRICS.flatMap(metric => ['sum','count','min','max'].map(suffix => `${metric}_${suffix}`));
  const columns = ['samples','first_at','last_at',...aggregateColumns,...ELECTRICAL_EXTRA];
  const edgeColumns = ELECTRICAL_METRICS.flatMap(metric => [
    `SUM(${metric}::double precision) AS ${metric}_sum`,`COUNT(${metric}) AS ${metric}_count`,
    `MIN(${metric})::double precision AS ${metric}_min`,`MAX(${metric})::double precision AS ${metric}_max`
  ]);
  const average = metric => `SUM(${metric}_sum)/NULLIF(SUM(${metric}_count),0)`;
  const resultColumns = [
    `SUM(samples)::bigint AS samples`,`MIN(first_at) AS first_at`,`MAX(last_at) AS last_at`,
    `${average('kw_total')} AS kw_avg`,`MIN(kw_total_min) AS kw_min`,`MAX(kw_total_max) AS kw_max`,`MAX(kw_peak) AS kw_peak`,
    `${average('kva_total')} AS kva_avg`,`MAX(kva_total_max) AS kva_max`,
    `${average('i_avg')} AS i_avg`,`MAX(i_max) AS i_max`,
    `${average('v_ll_avg')} AS v_ll_avg`,`MIN(v_ll_min) AS v_ll_min`,`MAX(v_ll_max) AS v_ll_max`,
    `${average('v_ln_avg')} AS v_ln_avg`,`MIN(v_ln_min) AS v_ln_min`,`MAX(v_ln_max) AS v_ln_max`,
    `${average('pf_avg')} AS pf_avg`,`MIN(pf_avg_min) AS pf_min`,
    `${average('frequency_hz')} AS hz_avg`,`MIN(frequency_hz_min) AS hz_min`,`MAX(frequency_hz_max) AS hz_max`
  ].join(',\n');
  return `/* energy:v2:meter-electrical */ WITH bounds AS (
    SELECT $2::timestamptz AS from_at,LEAST($3::timestamptz,NOW())+INTERVAL '1 millisecond' AS to_at,
      date_trunc('minute',$2::timestamptz)+CASE WHEN date_trunc('minute',$2::timestamptz)=$2::timestamptz THEN INTERVAL '0' ELSE INTERVAL '1 minute' END AS full_from,
      date_trunc('minute',LEAST($3::timestamptz,NOW())+INTERVAL '1 millisecond') AS full_to
  ), electrical AS (
    SELECT e.bucket,${columns.map(column => `e.${column}`).join(',')}
      FROM energy_electrical_1m e CROSS JOIN bounds b
     WHERE e.machine_id=$1 AND e.company_id=$5${plantSql('e.machine_id')}
       AND e.bucket>=b.full_from AND e.bucket<b.full_to
       AND NOT EXISTS(SELECT 1 FROM energy_refresh_queue q WHERE q.company_id=e.company_id AND q.machine_id=e.machine_id
         AND q.from_at<e.bucket+INTERVAL '1 minute' AND q.through_at>=e.bucket)
    UNION ALL
    SELECT date_trunc('minute',r.read_at) AS bucket,COUNT(*) AS samples,MIN(r.read_at) AS first_at,MAX(r.read_at) AS last_at,
      ${edgeColumns.join(',\n')},MAX(ABS(kw_total))::double precision AS kw_peak,
      MAX(GREATEST(i1,i2,i3))::double precision AS i_max,
      MIN(LEAST(v12,v23,v31))::double precision AS v_ll_min,MAX(GREATEST(v12,v23,v31))::double precision AS v_ll_max,
      MIN(LEAST(v1n,v2n,v3n))::double precision AS v_ln_min,MAX(GREATEST(v1n,v2n,v3n))::double precision AS v_ln_max
      FROM energy_meter_readings r CROSS JOIN bounds b
     WHERE r.machine_id=$1 AND r.company_id=$5${plantSql('r.machine_id')}
       AND r.read_at>=b.from_at AND r.read_at<b.to_at
       AND (r.read_at<b.full_from OR r.read_at>=b.full_to OR EXISTS(
         SELECT 1 FROM energy_refresh_queue q WHERE q.company_id=r.company_id AND q.machine_id=r.machine_id
           AND q.from_at<date_trunc('minute',r.read_at)+INTERVAL '1 minute' AND q.through_at>=date_trunc('minute',r.read_at)))
     GROUP BY 1
  ), points AS (
    SELECT (EXTRACT(EPOCH FROM date_bin($4::interval,bucket,TIMESTAMPTZ '2000-01-01 00:00:00+05:30'))*1000)::bigint AS t,
      ${resultColumns} FROM electrical GROUP BY 1
  ), summary AS (SELECT ${resultColumns} FROM electrical)
  SELECT COALESCE((SELECT jsonb_agg(p ORDER BY p.t) FROM points p),'[]'::jsonb) AS points,
    (SELECT to_jsonb(s)||jsonb_build_object('readings',COALESCE(s.samples,0)) FROM summary s) AS summary`;
}

async function canonicalReadings({ companyId,machineId,from,to,nowMs,bucket }) {
  const [latest,electrical,energy] = await Promise.all([
    db.query(latestMeterFieldsSQL(READING_COLUMNS),[machineId,new Date(nowMs-LOOKBACK_MS),to,companyId]),
    db.query(electricalSQL(),[machineId,from,to,`${bucket} seconds`,companyId]),
    energyStore.meterEnergy({ companyId,machineId,start:from,end:to,bucketSeconds:bucket })
  ]);
  return [latest,{ rows:electrical.rows[0]?.points||[] },{ rows:energy },{ rows:[electrical.rows[0]?.summary||{}] }];
}

/** Does the meter look wired the wrong way round? Negative kW and power factor, and more Export than Import. */
function checksFor(latest) {
  if (!latest) return { ct_reversed: false };
  const current = key => latest.field_stale?.[key] !== true;
  const exportOutruns = latest.kwh_export != null && latest.kwh_import != null && latest.kwh_export > latest.kwh_import;
  const negative = (current('kw_total') && latest.kw_total != null && latest.kw_total < 0)
    || (current('pf_avg') && latest.pf_avg != null && latest.pf_avg < 0);
  return { ct_reversed: current('kwh_export') && current('kwh_import') && exportOutruns && negative };
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
  const canonical = await energyStore.enabled(companyId);

  /* Before migration 029 has run there is no table, and so no meter yet —
     an empty answer, not a 500 the screen would read as a lost connection. */
  let list;
  try {
    list = await meters(companyId, nowMs, canonical);
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
  const [latestQ, pointsQ, energyQ, summaryQ] = await (canonical
    ? canonicalReadings({ companyId,machineId:machine.id,from,to,nowMs,bucket:r.bucket })
    : Promise.all([
    db.query(
      latestMeterFieldsSQL(READING_COLUMNS, { legacyOnly: !canonical }),
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
            AND value >= 0 AND value <= 1000000000000
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
  ]));

  const latest = latestMeterSnapshot(latestQ.rows[0], READING_COLUMNS, nowMs);

  const kwhByT = new Map(energyQ.rows.map(e => [Number(e.t), num(e.kwh)]));
  const points = pointsQ.rows.map(p => ({
    t: Number(p.t), samples: p.samples,
    kw_avg: cleanElectrical('kw_total', p.kw_avg), kw_min: cleanElectrical('kw_total', p.kw_min), kw_max: cleanElectrical('kw_total', p.kw_max),
    kva_avg: cleanElectrical('kva_total', p.kva_avg), kva_max: cleanElectrical('kva_total', p.kva_max),
    i_avg: cleanElectrical('i_avg', p.i_avg), i_max: cleanElectrical('i_avg', p.i_max),
    v_ll_avg: cleanElectrical('v_ll_avg', p.v_ll_avg), v_ll_min: cleanElectrical('v_ll_avg', p.v_ll_min), v_ll_max: cleanElectrical('v_ll_avg', p.v_ll_max),
    pf_avg: cleanElectrical('pf_avg', p.pf_avg), pf_min: cleanElectrical('pf_avg', p.pf_min),
    hz_avg: cleanElectrical('frequency_hz', p.hz_avg),
    kwh: kwhByT.has(Number(p.t)) ? kwhByT.get(Number(p.t)) : null
  }));

  const s = summaryQ.rows[0] || {};
  const summary = {
    // AVG above is the mean of reported samples, not a time-weighted
    // reconstruction of values omitted from change-only packets.
    average_basis: 'reported_samples',
    readings: s.readings || 0,
    first_at: ms(s.first_at), last_at: ms(s.last_at),
    kwh_used:   measuredSum(energyQ.rows, 'kwh'),
    kwh_import: measuredSum(energyQ.rows, 'kwh_import'),
    kwh_export: measuredSum(energyQ.rows, 'kwh_export'),
    kvarh:      measuredSum(energyQ.rows, 'kvarh'),
    kvah:       measuredSum(energyQ.rows, 'kvah'),
    energy_intervals: energyQ.rows.reduce((total, row) => total + (num(row.energy_intervals) || 0), 0),
    energy_rejected_intervals: energyQ.rows.reduce((total, row) => total + (num(row.energy_rejected_intervals) || 0), 0),
    kw:   { avg: cleanElectrical('kw_total', s.kw_avg), min: cleanElectrical('kw_total', s.kw_min), max: cleanElectrical('kw_total', s.kw_max), peak: cleanElectrical('kw_total', s.kw_peak) },
    kva:  { avg: cleanElectrical('kva_total', s.kva_avg), max: cleanElectrical('kva_total', s.kva_max) },
    i:    { avg: cleanElectrical('i_avg', s.i_avg), max: cleanElectrical('i_avg', s.i_max) },
    v_ll: { min: cleanElectrical('v_ll_avg', s.v_ll_min), avg: cleanElectrical('v_ll_avg', s.v_ll_avg), max: cleanElectrical('v_ll_avg', s.v_ll_max) },
    v_ln: { min: cleanElectrical('v_ln_avg', s.v_ln_min), avg: cleanElectrical('v_ln_avg', s.v_ln_avg), max: cleanElectrical('v_ln_avg', s.v_ln_max) },
    pf:   { avg: cleanElectrical('pf_avg', s.pf_avg), min: cleanElectrical('pf_avg', s.pf_min) },
    hz:   { min: cleanElectrical('frequency_hz', s.hz_min), avg: cleanElectrical('frequency_hz', s.hz_avg), max: cleanElectrical('frequency_hz', s.hz_max) }
  };
  if (canonical) {
    summary.energy_source = 'canonical_energy_intervals';
    summary.energy_complete = summary.energy_intervals > 0 && summary.energy_rejected_intervals === 0
      && energyQ.rows.every(row => row.energy_complete !== false);
  }

  return { meters: list, machine, range: rangeOut, latest, points, summary, checks: checksFor(latest), limits: LIMITS };
};
