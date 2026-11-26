/**
 * Shared energy read model. Counter differences are attributed to the time of
 * the later observation, on the Asia/Kolkata calendar. A difference spanning
 * an unknown gap remains a known subtotal, with incomplete coverage; it is
 * never interpolated into invented hourly consumption or billable energy.
 *
 * Complete calendar buckets use compact continuous aggregates. Only the two
 * partial edges use validated interval facts. No reader scans raw CNC history.
 */
const db = require('./energy-db');
const { plantSql, sharedEntityPlantSql } = require('../lib/read-scope');
const { machineOrder } = require('../lib/machine-order');

const OFFSET = 330 * 60_000;
const DAY = 86_400_000;
const readiness = new Map();
let readinessWarningAfter = 0;
const good = "('measured','flat','rollover')";
const REGISTERS = ['kwh_total', 'kwh_import', 'kwh_export', 'kvarh_total', 'kvah_total'];
const levels = ['month', 'day', 'hour'];
const views = { month: 'energy_counter_monthly', day: 'energy_counter_daily', hour: 'energy_counter_hourly' };
const number = v => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
const count = v => number(v) || 0;
const iso = ms => new Date(ms).toISOString();
const dayOf = value => new Date(new Date(value).getTime() + OFFSET).toISOString().slice(0, 10);
const monthOf = value => `${dayOf(value).slice(0, 7)}-01`;
const midnight = day => Date.parse(`${day}T00:00:00+05:30`);
function id(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${label} must be a positive integer`);
  return n;
}
function millis(value) {
  const n = new Date(value).getTime();
  if (!Number.isFinite(n)) throw new TypeError('Energy range requires valid timestamps');
  return n;
}
function floor(ms, grain) {
  const d = new Date(ms + OFFSET);
  if (grain === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - OFFSET;
  const width = grain === 'day' ? DAY : grain === 'minute' ? 60_000 : 3_600_000;
  return Math.floor((ms + OFFSET) / width) * width - OFFSET;
}
function next(ms, grain) {
  if (grain !== 'month') return ms + (grain === 'day' ? DAY : grain === 'minute' ? 60_000 : 3_600_000);
  const d = new Date(ms + OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - OFFSET;
}
/** A disjoint cover of [start,end), with at most two raw edges. */
function splitRange(start, end, maxGrain = 'month') {
  const result = [];
  const level = levels.indexOf(maxGrain);
  if (level < 0) throw new TypeError('Invalid energy aggregate granularity');
  const allowed = levels.slice(level);
  function partition(from, to, at) {
    if (from >= to) return;
    if (at === allowed.length) { result.push({ source: 'facts', start: from, end: to }); return; }
    const grain = allowed[at];
    const lower = floor(from, grain) === from ? from : next(floor(from, grain), grain);
    const upper = floor(to, grain);
    if (lower >= upper) return partition(from, to, at + 1);
    partition(from, lower, at + 1);
    result.push({ source: views[grain], start: lower, end: upper });
    partition(upper, to, at + 1);
  }
  partition(start, end, 0);
  return result;
}
function invalidate(companyId) { if (companyId == null) readiness.clear(); else readiness.delete(Number(companyId)); }
async function enabled(companyId) {
  // Deliberately no database access while deployment/backfill is disabled.
  if (process.env.ENERGY_V2_ENABLED === 'false') return false;
  const company = id(companyId, 'Company');
  const old = readiness.get(company);
  if (old && old.until > Date.now()) return old.ready;
  let ready = false;
  try {
    const { rows } = await db.query('SELECT ready FROM energy_pipeline_state WHERE company_id = $1', [company]);
    ready = rows[0]?.ready === true;
  } catch (err) {
    // A rolling deployment may enable the feature before migration 064.
    // Only that absent optional readiness table means "not ready". A lost
    // connection, missing different relation or permission failure still
    // needs to fail visibly instead of silently changing the data source.
    const missingReadiness = err?.code === '42P01' && (err.table === 'energy_pipeline_state'
      || /relation "(?:[^".]+\.)?energy_pipeline_state" does not exist/.test(err.message || ''));
    if (!missingReadiness) throw err;
    if (Date.now() >= readinessWarningAfter) {
      console.warn('Energy v2 readiness table is not installed; retaining the current energy source until migration 064 is applied.');
      readinessWarningAfter = Date.now() + 60_000;
    }
  }
  if (readiness.size >= 1000) readiness.clear();
  readiness.set(company, { ready, until: Date.now() + 5000 });
  return ready;
}
function selectedSQL(opts, params) {
  let filter = '';
  if (opts.machineId != null) filter += ` AND m.id = $${params.push(id(opts.machineId, 'Machine'))}`;
  if (opts.search) {
    const value = String(opts.search).toLowerCase();
    if (value.length > 200) throw new TypeError('Energy search is too long');
    const bind = `$${params.push(value)}`;
    filter += ` AND (POSITION(${bind} IN LOWER(COALESCE(m.machine_serial_no,''))) > 0 OR POSITION(${bind} IN LOWER(COALESCE(m.model,''))) > 0)`;
  }
  return `SELECT m.id AS machine_id,m.machine_serial_no,m.model FROM machines m
    WHERE m.company_id=$1${opts.includeInactive ? '' : ' AND m.is_active=TRUE'}${plantSql('m.id')}${filter}`;
}
function range(start, end, asOf = Date.now()) {
  const from = millis(start);
  // Public dashboard date ranges end at 23:59:59.999; preserve that last ms.
  const to = Math.min(millis(end) + 1, millis(asOf) + 1);
  if (millis(end) < from) throw new TypeError('Energy range ends before it starts');
  return { start: from, end: to };
}
function bucketSQL(grain, column) {
  return grain === 'total' ? 'NULL::timestamptz' : `(date_trunc('${grain}',${column} AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
}
// CAGG invalidations outside its policy window must never serve old totals.
// Only affected device/calendar buckets fall back to compact validated facts;
// all other history still uses materialized summaries.
function counterSourceSQL(view) {
  const grain=Object.keys(views).find(key=>views[key]===view);
  if(!grain)throw new TypeError('Invalid counter aggregate');
  const bucket=column=>bucketSQL(grain,column);
  const dirty=alias=>`EXISTS(SELECT 1 FROM energy_refresh_queue dirty WHERE dirty.company_id=${alias}.company_id
    AND dirty.machine_id=${alias}.machine_id AND ${alias}.bucket>=${bucket('dirty.from_at')}
    AND ${alias}.bucket<=${bucket('dirty.through_at')})`;
  return `(SELECT a.* FROM ${view} a WHERE NOT ${dirty('a')}
    UNION ALL SELECT ${bucket('f.observed_at')} AS bucket,f.company_id,f.machine_id,f.register,f.shift_id,
      SUM(f.delta)::double precision AS kwh,COUNT(f.delta) AS accepted_intervals,
      COUNT(*) FILTER(WHERE f.quality NOT IN ${good}) AS rejected_intervals,
      SUM(f.delta) FILTER(WHERE NOT f.allocated)::double precision AS unallocated_kwh,
      COUNT(f.delta) FILTER(WHERE NOT f.allocated) AS unallocated_intervals,
      MIN(f.interval_start) AS first_interval_start,MAX(f.observed_at) AS last_observed_at,
      SUM(f.measured_seconds)::double precision AS measured_seconds
    FROM energy_counter_intervals f JOIN energy_refresh_queue dirty
      ON dirty.company_id=f.company_id AND dirty.machine_id=f.machine_id
      AND f.observed_at>=${bucket('dirty.from_at')}
      AND f.observed_at<${bucket('dirty.through_at')}+INTERVAL '1 ${grain}'
    GROUP BY 1,f.company_id,f.machine_id,f.register,f.shift_id)`;
}
/** One bounded query for any number of requested periods (never per machine). */
async function counters(opts, ranges, grain = 'day') {
  if (!['total', ...levels].includes(grain)) throw new TypeError('Invalid energy aggregate granularity');
  const params = [id(opts.companyId, 'Company')];
  const selected = selectedSQL(opts, params);
  const branches = [];
  const maxGrain = grain === 'total' ? 'month' : grain;
  for (const r of ranges) {
    for (const span of splitRange(r.start, r.end, maxGrain)) {
      const a = `$${params.push(iso(span.start))}::timestamptz`;
      const b = `$${params.push(iso(span.end))}::timestamptz`;
      const label = `$${params.push(String(r.label || 'range'))}::text`;
      const shift = r.shiftId == null ? (r.unassigned ? ' AND e.shift_id IS NULL' : '')
        : ` AND e.shift_id=$${params.push(id(r.shiftId, 'Shift'))}`;
      const raw = span.source === 'facts';
      const point = raw ? 'e.observed_at' : 'e.bucket';
      branches.push(`SELECT ${label} AS period,e.machine_id,e.shift_id,${point} AS point,
        ${raw ? `e.delta AS kwh,(e.delta IS NOT NULL)::int AS accepted_intervals,
        (e.quality NOT IN ${good})::int AS rejected_intervals,
        CASE WHEN NOT e.allocated THEN e.delta END AS unallocated_kwh,
        (e.delta IS NOT NULL AND NOT e.allocated)::int AS unallocated_intervals,
        e.interval_start AS first_interval_start,e.observed_at AS last_observed_at,e.measured_seconds`
        : 'e.kwh,e.accepted_intervals,e.rejected_intervals,e.unallocated_kwh,e.unallocated_intervals,e.first_interval_start,e.last_observed_at,e.measured_seconds'}
        FROM ${raw ? 'energy_counter_intervals' : counterSourceSQL(span.source)} e
        JOIN selected m ON m.machine_id=e.machine_id
        WHERE e.company_id=$1 AND e.register='kwh_total' AND ${point}>=${a} AND ${point}<${b}${shift}`);
    }
  }
  if (!branches.length) return [];
  const { rows } = await db.query(`/* energy:v2:counters */ WITH selected AS (${selected}), ledger AS (
    ${branches.join('\nUNION ALL\n')}
  ) SELECT period,l.machine_id,l.shift_id,${bucketSQL(grain, 'point')} AS bucket,
      SUM(kwh)::double precision AS kwh,SUM(accepted_intervals)::bigint AS accepted_intervals,
      SUM(rejected_intervals)::bigint AS rejected_intervals,SUM(unallocated_kwh)::double precision AS unallocated_kwh,
      SUM(unallocated_intervals)::bigint AS unallocated_intervals,
      MIN(first_interval_start) AS first_interval_start,MAX(last_observed_at) AS last_observed_at,
      SUM(measured_seconds)::double precision AS measured_seconds,
      EXISTS(SELECT 1 FROM energy_reconcile_queue q WHERE q.company_id=$1 AND q.machine_id=l.machine_id) AS pending
    FROM ledger l GROUP BY period,l.machine_id,l.shift_id,${bucketSQL(grain, 'point')}
    ORDER BY period,bucket,l.machine_id,l.shift_id`, params);
  return rows;
}
function combine(rows, expectedSeconds = null) {
  const accepted = rows.reduce((n, r) => n + count(r.accepted_intervals), 0);
  const rejected = rows.reduce((n, r) => n + count(r.rejected_intervals), 0);
  const unallocated = rows.reduce((n, r) => n + count(r.unallocated_intervals), 0);
  const values = rows.filter(r => r.kwh != null && count(r.accepted_intervals) > 0);
  const measured = rows.reduce((n, r) => n + count(r.measured_seconds), 0);
  return {
    kwh: values.length ? values.reduce((n, r) => n + count(r.kwh), 0) : null,
    accepted_intervals: accepted, rejected_intervals: rejected,
    unallocated_intervals: unallocated,
    measured_seconds: measured,
    energy_complete: accepted > 0 && rejected === 0 && unallocated === 0 && !rows.some(r => r.pending || r.energy_complete === false)
      && (expectedSeconds == null || (expectedSeconds > 0 && measured >= Math.max(0, expectedSeconds - 60))),
    pending: rows.some(r => r.pending),
    first_interval_start: rows.reduce((t, r) => r.first_interval_start && (!t || millis(r.first_interval_start) < millis(t)) ? r.first_interval_start : t, null),
    last_observed_at: rows.reduce((t, r) => r.last_observed_at && (!t || millis(r.last_observed_at) > millis(t)) ? r.last_observed_at : t, null)
  };
}
function grouped(rows, key) {
  const groups = new Map();
  for (const row of rows) { const k = key(row); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
  return groups;
}
function calendar(start, end) {
  const days = [];
  for (let t = floor(start, 'day'); t < end; t += DAY) days.push(dayOf(t));
  return days;
}
async function machineFigures(opts, bounds) {
  const params = [id(opts.companyId, 'Company'), iso(bounds.start), iso(bounds.end)];
  const selected = selectedSQL(opts, params);
  // One-minute rollups preserve per-field sums/counts. Read only partial
  // minute edges from sparse meter rows, never an entire month of raw rows.
  const lower = floor(bounds.start, 'minute') === bounds.start ? bounds.start : next(floor(bounds.start, 'minute'), 'minute');
  const upper = floor(bounds.end, 'minute');
  const dirty=point=>`EXISTS(SELECT 1 FROM energy_refresh_queue dirty WHERE dirty.company_id=r.company_id
    AND dirty.machine_id=r.machine_id AND ${point}>=${bucketSQL('minute','dirty.from_at')}
    AND ${point}<${bucketSQL('minute','dirty.through_at')}+INTERVAL '1 minute')`;
  const edge = `SELECT r.machine_id,ABS(r.kw_total) AS peak_kw,r.v_ll_avg AS vl_sum,(r.v_ll_avg IS NOT NULL)::int AS vl_count,
    r.v_ln_avg AS vn_sum,(r.v_ln_avg IS NOT NULL)::int AS vn_count,r.i_avg AS i_sum,(r.i_avg IS NOT NULL)::int AS i_count
    FROM energy_meter_readings r JOIN selected m ON m.machine_id=r.machine_id WHERE r.company_id=$1
    AND r.read_at >= $2::timestamptz AND r.read_at < $3::timestamptz`;
  // A correlated dirty-range OR over the complete raw range made every
  // request revisit all five days of readings. Probe the affected minute
  // ranges by machine/time instead; each unrefreshed minute replaces exactly
  // one rollup, and the disjoint partial edges cannot be counted twice.
  const dirtyEdges = `SELECT e.* FROM energy_refresh_queue d JOIN selected m ON m.machine_id=d.machine_id
    CROSS JOIN LATERAL (SELECT r.machine_id,ABS(r.kw_total) AS peak_kw,
      r.v_ll_avg AS vl_sum,(r.v_ll_avg IS NOT NULL)::int AS vl_count,
      r.v_ln_avg AS vn_sum,(r.v_ln_avg IS NOT NULL)::int AS vn_count,
      r.i_avg AS i_sum,(r.i_avg IS NOT NULL)::int AS i_count
      FROM energy_meter_readings r WHERE r.company_id=$1 AND r.machine_id=d.machine_id
        AND r.read_at>=GREATEST($2::timestamptz,'${iso(lower)}'::timestamptz,${bucketSQL('minute','d.from_at')})
        AND r.read_at<LEAST($3::timestamptz,'${iso(upper)}'::timestamptz,${bucketSQL('minute','d.through_at')}+INTERVAL '1 minute')
      OFFSET 0) e WHERE d.company_id=$1`;
  const electrical = lower < upper
    ? `SELECT r.machine_id,r.kw_peak AS peak_kw,r.v_ll_avg_sum AS vl_sum,r.v_ll_avg_count AS vl_count,
        r.v_ln_avg_sum AS vn_sum,r.v_ln_avg_count AS vn_count,r.i_avg_sum AS i_sum,r.i_avg_count AS i_count
       FROM energy_electrical_1m r JOIN selected m ON m.machine_id=r.machine_id WHERE r.company_id=$1
       AND r.bucket >= $${params.push(iso(lower))}::timestamptz AND r.bucket < $${params.push(iso(upper))}::timestamptz
       AND NOT ${dirty('r.bucket')}
       UNION ALL ${edge} AND (r.read_at < '${iso(lower)}'::timestamptz OR r.read_at >= '${iso(upper)}'::timestamptz)
       UNION ALL ${dirtyEdges}`
    : edge;
  const { rows } = await db.query(`/* energy:v2:machine-figures */ WITH selected AS (${selected}),
    run AS (SELECT p.machine_id,SUM(p.run_seconds)::bigint AS run_seconds,SUM(p.produced_qty)::bigint AS produced
      FROM production_hourly p JOIN selected m ON m.machine_id=p.machine_id
      WHERE p.company_id=$1 AND p.hour_start >= $2::timestamptz AND p.hour_start < $3::timestamptz GROUP BY p.machine_id),
    electrical AS (${electrical}), supply AS (SELECT machine_id,MAX(peak_kw) AS peak_kw,
      SUM(vl_sum)/NULLIF(SUM(vl_count),0) AS avg_voltage,
      SUM(vl_count) AS voltage_readings,
      SUM(i_sum)/NULLIF(SUM(i_count),0) AS avg_current,SUM(i_count) AS current_readings FROM electrical GROUP BY machine_id)
    SELECT m.*,COALESCE(run.run_seconds,0) AS run_seconds,COALESCE(run.produced,0) AS produced,
      supply.peak_kw,supply.avg_voltage,supply.voltage_readings,supply.avg_current,supply.current_readings,
      EXISTS(SELECT 1 FROM energy_reconcile_queue q WHERE q.company_id=$1 AND q.machine_id=m.machine_id) AS pending
    FROM selected m LEFT JOIN run USING(machine_id) LEFT JOIN supply USING(machine_id)
    ORDER BY ${machineOrder('m.machine_serial_no')}`, params);
  return rows;
}
async function figures(opts) {
  const bounds = range(opts.start, opts.end);
  const days = calendar(bounds.start, bounds.end);
  const [energy, machines] = await Promise.all([counters(opts, [{ ...bounds }], 'day'), machineFigures(opts, bounds)]);
  const perMachine = grouped(energy, r => Number(r.machine_id));
  const perDayMachine = grouped(energy, r => `${Number(r.machine_id)}:${dayOf(r.bucket)}`);
  const machineDays = [...perDayMachine.values()].map(rows => {
    const day = dayOf(rows[0].bucket);
    const seconds = Math.max(0, Math.min(midnight(day) + DAY, bounds.end) - Math.max(midnight(day), bounds.start)) / 1000;
    return { machine_id: Number(rows[0].machine_id), day, ...combine(rows, seconds) };
  });
  const perDay = grouped(machineDays, r => r.day);
  const mapped = machines.map(m => {
    const rows = perMachine.get(Number(m.machine_id)) || [];
    const total = combine(rows, (bounds.end - bounds.start) / 1000);
    const measuredDays = new Set(rows.filter(r => count(r.accepted_intervals) > 0).map(r => dayOf(r.bucket))).size;
    const complete = total.energy_complete && !m.pending;
    return { ...m, machine_id: Number(m.machine_id), ...total, energy_complete: complete, days: measuredDays, readings: total.accepted_intervals };
  });
  const trend = days.map(day => {
    const rows = perDay.get(day) || [];
    const total = combine(rows);
    return { day, ...total,
      machines: rows.filter(r => r.kwh != null && r.energy_complete).length };
  });
  return { machines: mapped, machineDays, trend, shiftEnergy: energy,
    months: [...grouped(trend, r => r.day.slice(0, 7)).entries()].map(([month, rows]) => ({ month: `${month}-01`, ...combine(rows) })) };
}
async function byShift(opts, frozenEnergy = null) {
  const bounds = range(opts.start, opts.end);
  const [energy, production] = await Promise.all([
    Array.isArray(frozenEnergy) ? Promise.resolve(frozenEnergy) : counters(opts, [{ ...bounds }], 'total'),
    (() => {
      const params = [id(opts.companyId, 'Company'), iso(bounds.start), iso(bounds.end)];
      const selected = selectedSQL(opts, params);
      return db.query(`/* energy:v2:shift-production */ WITH selected AS (${selected}), totals AS (
        SELECT p.shift_id,SUM(p.run_seconds)::bigint AS run_seconds,SUM(p.produced_qty)::bigint AS produced
        FROM production_hourly p JOIN selected m ON m.machine_id=p.machine_id LEFT JOIN shifts s ON s.id=p.shift_id AND s.company_id=$1
        WHERE p.company_id=$1 AND p.hour_start >= $2::timestamptz AND p.hour_start < $3::timestamptz GROUP BY p.shift_id)
        SELECT sh.id AS shift_id,sh.shift_name,totals.run_seconds,totals.produced
        FROM shifts sh LEFT JOIN totals ON totals.shift_id=sh.id
        WHERE sh.company_id=$1${sharedEntityPlantSql('sh')}
        UNION ALL SELECT NULL,'Unassigned',run_seconds,produced FROM totals WHERE shift_id IS NULL`, params);
    })()
  ]);
  const groups = grouped(energy, r => r.shift_id == null ? 'null' : String(r.shift_id));
  const prod = new Map(production.rows.map(r => [r.shift_id == null ? 'null' : String(r.shift_id), r]));
  const ids = new Set([...groups.keys(), ...prod.keys()]);
  return [...ids].map(key => ({ shift_id: key === 'null' ? null : Number(key), shift_name: prod.get(key)?.shift_name || 'Unassigned',
    run_seconds: count(prod.get(key)?.run_seconds), produced: count(prod.get(key)?.produced), ...combine(groups.get(key) || []) }));
}
async function machineEnergy(opts) {
  const asOf = millis(opts.asOf || Date.now());
  // Shift end is exclusive. The observation at 20:00 belongs to the next
  // configured shift rather than being counted twice by adjacent shifts.
  const bounds = opts.start && opts.end ? { start: millis(opts.start), end: Math.min(millis(opts.end), asOf + 1) } : { start: asOf, end: asOf };
  const params = [id(opts.companyId, 'Company'), id(opts.machineId, 'Machine'), iso(asOf)];
  const [rows, latest] = await Promise.all([
    counters(opts, [{ ...bounds }], 'total'),
    db.query(`/* energy:v2:latest-counter */ SELECT (l.field_values->>'kwh_total')::double precision AS total_energy
      FROM energy_meter_latest l JOIN machines m ON m.id=l.machine_id AND m.company_id=$1
      WHERE l.company_id=$1 AND l.machine_id=$2${plantSql('m.id')}
        AND (l.field_observed_at->>'kwh_total')::double precision <= EXTRACT(EPOCH FROM $3::timestamptz)*1000`, params)
  ]);
  const total = combine(rows, (bounds.end - bounds.start) / 1000);
  return { ...total, shift_kwh: total.kwh, total_energy: number(latest.rows[0]?.total_energy) };
}
function addDays(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10); }
function monthEnd(day) { const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return addDays(d.toISOString().slice(0, 10), -1); }
function shiftBounds(first, last, shift) {
  const start = Date.parse(`${first}T${shift.start_time}+05:30`);
  const end = Date.parse(`${last}T${shift.end_time}+05:30`) + (String(shift.start_time) >= String(shift.end_time) ? DAY : 0);
  return { start, end };
}
function periodRanges(first, last, shifts, shiftId, asOf, label = 'range') {
  const result = [];
  for (const shift of shifts) {
    if (shiftId != null && Number(shift.id) !== Number(shiftId)) continue;
    const bounds = shiftBounds(first, last, shift);
    let expectedSeconds = 0;
    for (let day = first, n = 0; day <= last && n <= 366; day = addDays(day, 1), n++) {
      const daily = shiftBounds(day, day, shift);
      expectedSeconds += Math.max(0, Math.min(daily.end, asOf + 1) - daily.start) / 1000;
    }
    result.push({ label, start: bounds.start, end: Math.min(bounds.end, asOf + 1), shiftId: Number(shift.id), expectedSeconds });
  }
  if (shiftId == null) {
    const start = midnight(first), end = Math.min(midnight(addDays(last, 1)), asOf + 1);
    result.push({ label, start, end, unassigned: true, expectedSeconds: Math.max(0, end - start) / 1000 });
  }
  return result;
}
function completePeriod(rows, ranges) {
  const assigned = ranges.filter(r => !r.unassigned && r.expectedSeconds > 0);
  const expected = assigned.length ? assigned : ranges.filter(r => r.expectedSeconds > 0);
  return expected.length > 0 && expected.every(r => combine(rows.filter(row => r.unassigned ? row.shift_id == null : Number(row.shift_id) === r.shiftId), r.expectedSeconds).energy_complete)
    && !rows.some(r => r.pending || count(r.rejected_intervals) || count(r.unallocated_intervals));
}
async function factoryEnergy(opts) {
  const company = id(opts.companyId, 'Company');
  const asOf = millis(opts.asOf || Date.now());
  const params = [company];
  const selected = selectedSQL(opts, params);
  const [machineRes, shiftRes, settingRes] = await Promise.all([
    db.query(`/* energy:v2:factory-machines */ ${selected}`, params),
    db.query(`SELECT id,start_time,end_time FROM shifts sh WHERE sh.company_id=$1${opts.shiftId == null ? ' AND sh.is_active=TRUE' : ' AND sh.id=$2'}${sharedEntityPlantSql('sh')}`, opts.shiftId == null ? [company] : [company, id(opts.shiftId, 'Shift')]),
    db.query(`SELECT es.machine_id,es.cost_per_kwh,es.currency FROM energy_settings es WHERE es.company_id=$1
      AND (es.machine_id IS NULL OR EXISTS(SELECT 1 FROM machines m WHERE m.id=es.machine_id AND m.company_id=$1${plantSql('m.id')}))`, [company])
  ]);
  const machines = machineRes.rows.map(r => Number(r.machine_id));
  const prevMonth = addDays(`${opts.date.slice(0, 7)}-01`, -1).slice(0, 7) + '-01';
  const periods = {
    day: [opts.date, opts.date], yesterday: [addDays(opts.date, -1), addDays(opts.date, -1)],
    month: [`${opts.date.slice(0, 7)}-01`, monthEnd(opts.date)], prev_month: [prevMonth, monthEnd(prevMonth)]
  };
  const ranges = [];
  for (const [label, [first, last]] of Object.entries(periods)) {
    ranges.push(...periodRanges(first, last, shiftRes.rows, opts.shiftId, asOf, label));
  }
  // Day needs hourly chart points. Month summaries use daily/monthly buckets
  // and are fetched in the same database round trip as the day branches.
  const dailyRanges = ranges.filter(r => ['day', 'yesterday'].includes(r.label));
  const monthlyRanges = ranges.filter(r => !['day', 'yesterday'].includes(r.label));
  const [shortRows, longRows] = await Promise.all([counters(opts, dailyRanges, 'hour'), counters(opts, monthlyRanges, 'total')]);
  const all = [...shortRows, ...longRows];
  const defaultSetting = settingRes.rows.find(r => r.machine_id == null);
  const overrides = new Map(settingRes.rows.filter(r => r.machine_id != null).map(r => [Number(r.machine_id), r]));
  const effectiveSettings = machines.map(machine => overrides.get(machine) || defaultSetting);
  const currencies = new Set(effectiveSettings.filter(r => r?.cost_per_kwh != null && r.currency).map(r => r.currency));
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  const result = { currency, cost_basis: 'current_tariff_estimate' };
  for (const label of Object.keys(periods)) {
    const rows = all.filter(r => r.period === label);
    const total = combine(rows);
    const byMachine = grouped(rows, r => Number(r.machine_id));
    const complete = machines.length > 0 && machines.every(machine => completePeriod(byMachine.get(machine) || [], ranges.filter(r => r.label === label)));
    let cost = 0;
    let costComplete = complete && !!currency;
    for (const machine of machines) {
      const subtotal = combine(byMachine.get(machine) || []);
      const setting = overrides.get(machine) || defaultSetting;
      const rate = number(setting?.cost_per_kwh);
      if (rate == null || rate < 0 || setting?.currency !== currency || subtotal.kwh == null) costComplete = false;
      else cost += subtotal.kwh * rate;
    }
    const prefix = label === 'day' ? '' : `${label}_`;
    result[`${prefix}kwh`] = total.kwh;
    result[`${prefix}energy_complete`] = complete;
    if (label === 'day') Object.assign(result, { accepted_intervals: total.accepted_intervals, rejected_intervals: total.rejected_intervals,
      unallocated_intervals: total.unallocated_intervals, cost_day: costComplete ? cost : null, cost_complete: costComplete });
    if (label === 'month') Object.assign(result, { cost_month: costComplete ? cost : null, month_cost_complete: costComplete });
    if (label === 'yesterday') Object.assign(result, { yesterday_cost: costComplete ? cost : null, yesterday_cost_complete: costComplete });
  }
  result.trend = [...grouped(shortRows.filter(r => r.period === 'day'), r => iso(millis(r.bucket))).entries()]
    .map(([hour, rows]) => ({ hour, ...combine(rows) })).sort((a, b) => a.hour.localeCompare(b.hour));
  return result;
}
/** All five physical registers for a single meter. Missing chart buckets
 * remain explicit unknown values, rather than disappearing from coverage. */
async function meterEnergy(opts) {
  const company = id(opts.companyId, 'Company');
  const machine = id(opts.machineId, 'Machine');
  const seconds = Number(opts.bucketSeconds);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 10800 || seconds % 60) throw new TypeError('Invalid meter bucket size');
  const start = millis(opts.start), end = Math.min(millis(opts.end), Date.now() + 1);
  if (end < start || end - start > 7 * DAY + 1000) throw new TypeError('Meter range must not exceed seven days');
  if (start === end) return [];
  const params = [company, machine, `${seconds} seconds`];
  const selected = `SELECT m.id AS machine_id FROM machines m WHERE m.company_id=$1 AND m.id=$2${plantSql('m.id')}`;
  const spans = seconds % 3600 === 0 ? splitRange(start, end, 'hour') : [{ source: 'facts', start, end }];
  const branches = spans.map(span => {
    const raw = span.source === 'facts', point = raw ? 'e.observed_at' : 'e.bucket';
    const lower = `$${params.push(iso(span.start))}::timestamptz`, upper = `$${params.push(iso(span.end))}::timestamptz`;
    return `SELECT e.register,${point} AS point,${raw ? `e.delta AS kwh,(e.delta IS NOT NULL)::int AS accepted_intervals,
      (e.quality NOT IN ${good})::int AS rejected_intervals,
      (e.delta IS NOT NULL AND NOT e.allocated)::int AS unallocated_intervals,e.measured_seconds`
      : 'e.kwh,e.accepted_intervals,e.rejected_intervals,e.unallocated_intervals,e.measured_seconds'}
      FROM ${raw ? 'energy_counter_intervals' : counterSourceSQL(span.source)} e JOIN selected m ON m.machine_id=e.machine_id
      WHERE e.company_id=$1 AND e.machine_id=$2 AND e.register IN (${REGISTERS.map(r => `'${r}'`).join(',')})
        AND ${point}>=${lower} AND ${point}<${upper}`;
  });
  const { rows } = await db.query(`/* energy:v2:meter-counters */ WITH selected AS (${selected}), ledger AS (
    ${branches.join('\nUNION ALL\n')}
  ) SELECT (EXTRACT(EPOCH FROM date_bin($3::interval,point,TIMESTAMPTZ '2000-01-01 00:00:00+05:30'))*1000)::bigint AS t,
      register,SUM(kwh)::double precision AS kwh,SUM(accepted_intervals)::bigint AS accepted_intervals,
      SUM(rejected_intervals)::bigint AS rejected_intervals,SUM(unallocated_intervals)::bigint AS unallocated_intervals,
      SUM(measured_seconds)::double precision AS measured_seconds,
      EXISTS(SELECT 1 FROM energy_reconcile_queue q WHERE q.company_id=$1 AND q.machine_id=$2) AS pending
    FROM ledger GROUP BY 1,register ORDER BY 1,register`, params);
  const groups = grouped(rows, r => Number(r.t));
  const width = seconds * 1000;
  const first = Math.floor((start + OFFSET) / width) * width - OFFSET;
  const names = { kwh_total: 'kwh', kwh_import: 'kwh_import', kwh_export: 'kwh_export', kvarh_total: 'kvarh', kvah_total: 'kvah' };
  const points = [];
  for (let t = first; t < end; t += width) {
    const list = groups.get(t) || [];
    const point = { t, kwh: null, kwh_import: null, kwh_export: null, kvarh: null, kvah: null };
    for (const register of REGISTERS) point[names[register]] = combine(list.filter(r => r.register === register)).kwh;
    const total = combine(list.filter(r => r.register === 'kwh_total'), (Math.min(t + width, end) - Math.max(t, start)) / 1000);
    Object.assign(point, { energy_intervals: total.accepted_intervals, energy_rejected_intervals: total.rejected_intervals,
      energy_unallocated_intervals: total.unallocated_intervals, energy_complete: total.energy_complete });
    points.push(point);
  }
  return points;
}
async function attachReportEnergy(companyId, rows, filters = {}) {
  if (!rows.length) return { rows: 0, rows_with_energy: 0, accepted_intervals: 0, rejected_intervals: 0, energy_complete: false };
  const times = rows.map(r => millis(r.hour_start));
  const bounds = { start: Math.min(...times), end: Math.min(Math.max(...times) + 3_600_000, Date.now() + 1) };
  let ranges = [{ ...bounds, shiftId: filters.shift_id || null }];
  let shifts = [];
  if (filters.date_from && filters.date_to) {
    const catalog = await db.query(`/* energy:v2:report-shifts */ SELECT id,start_time,end_time FROM shifts sh
      WHERE sh.company_id=$1${sharedEntityPlantSql('sh')}`, [id(companyId, 'Company')]);
    shifts = catalog.rows;
    ranges = periodRanges(filters.date_from, filters.date_to, shifts, filters.shift_id || null, Date.now());
  }
  const ledger = await counters({ companyId, machineId: filters.machine_id, includeInactive: true }, ranges, 'hour');
  const key = row => `${Number(row.machine_id)}:${row.shift_id == null ? 'null' : Number(row.shift_id)}:${floor(millis(row.hour_start || row.bucket), 'hour')}`;
  const groups = grouped(ledger, key);
  const seen = new Set();
  const uniqueRows = [];
  const shiftById = new Map(shifts.map(s => [Number(s.id), s]));
  for (const row of rows) {
    const k = key(row);
    const at = millis(row.hour_start);
    const shift = shiftById.get(Number(row.shift_id));
    const windows = shift ? [dayOf(at), addDays(dayOf(at), -1)].map(day => shiftBounds(day, day, shift)) : [{ start: at, end: at + 3_600_000 }];
    let expectedSeconds = 0;
    for (const window of windows) for (const selected of ranges) {
      if (selected.shiftId != null && Number(selected.shiftId) !== Number(row.shift_id)) continue;
      if (selected.unassigned && row.shift_id != null) continue;
      expectedSeconds += Math.max(0, Math.min(at + 3_600_000, window.end, selected.end) - Math.max(at, window.start, selected.start)) / 1000;
    }
    const total = combine(groups.get(k) || [], expectedSeconds);
    // One production bucket has one meter allocation even if a join happens
    // to produce duplicate rows. Never duplicate energy in a report export.
    row.energy_kwh = seen.has(k) ? null : total.kwh;
    row.accepted_intervals = seen.has(k) ? 0 : total.accepted_intervals;
    row.rejected_intervals = seen.has(k) ? 0 : total.rejected_intervals;
    row.energy_complete = !seen.has(k) && total.energy_complete;
    row.unallocated_intervals = seen.has(k) ? 0 : total.unallocated_intervals;
    row.measured_seconds = seen.has(k) ? 0 : total.measured_seconds;
    if (!seen.has(k)) uniqueRows.push(row);
    seen.add(k);
  }
  const total = combine(rows.map(r => ({ ...r, kwh: r.energy_kwh })));
  const omitted = combine(ledger.filter(r => !seen.has(key(r))));
  const representedMachines = new Set(uniqueRows.map(r => Number(r.machine_id)));
  const wholePeriod = !filters.date_from || !filters.date_to || [...representedMachines].every(machine => completePeriod(ledger.filter(r => Number(r.machine_id) === machine), ranges));
  return { rows: rows.length, rows_with_energy: rows.filter(r => r.energy_kwh != null).length,
    accepted_intervals: total.accepted_intervals, rejected_intervals: total.rejected_intervals,
    unallocated_intervals: total.unallocated_intervals,
    energy_complete: wholePeriod && uniqueRows.every(r => r.energy_complete === true)
      && !omitted.accepted_intervals && !omitted.rejected_intervals,
    energy_without_production_rows_kwh: omitted.kwh };
}
module.exports = { enabled, invalidate, figures, byShift, machineEnergy, factoryEnergy, meterEnergy, attachReportEnergy,
  // Bounded primitives are also shared by meter detail and operational checks.
  counters, combine, _test: { splitRange, floor, next, range, dayOf, calendar, shiftBounds, periodRanges, completePeriod } };
