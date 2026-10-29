/**
 * Phase 2 · Screen 9 — Energy Monitoring.
 *
 * ── How energy is measured ─────────────────────────────────────────────
 *
 * Devices report `energy` as a cumulative kWh counter, not as consumption
 * per message. Consumption is the sum of accepted changes between consecutive
 * readings for each machine. Adding cumulative readings would repeatedly
 * count the meter's lifetime total.
 *
 * Two things break that subtraction and both are handled explicitly:
 *
 *   A counter that resets — a meter replaced, a controller rebooted —
 *   makes last < first, which would read as negative consumption. Those
 *   intervals are treated as gaps rather than as negative usage, because a
 *   machine cannot un-consume electricity.
 *
 *   A machine that reported once in the period has no interval at all. Its
 *   consumption is unknown, not zero.
 *
 * Accepted intervals are attributed to the day of the later reading, then
 * summed by machine, day and month. Rejected intervals remain visible as
 * incomplete coverage; no before-range baseline is estimated.
 *
 * ── State of the data ──────────────────────────────────────────────────
 *
 * Meters misread. VMC - 13 - M has sent 0, 2.718 and 107.6 million in
 * turn, and plain differencing booked its whole meter total several times
 * a day. So a 0 is a dropped read and a rise no machine could draw counts
 * nothing (see DAILY_ENERGY_CTE): a misread costs one interval, not a
 * meter total. A machine with no readings still shows "not reported"
 * rather than a zero that looks like a very efficient factory.
 */

const pool = require('../db');
const { plantSql, nullablePlantSql, current } = require('../lib/read-scope');
const { parsePart, when } = require('./parts');
const cache = require('./cache');
const { machineOrder } = require('../lib/machine-order');
const { tableRows } = require('../lib/table-query');

/* The Machine Detail table's header (lib/table-query.js, 29 Oct 2026): sort
   any column, filter overload; built here, so read from each row. */
const HEAD = {
  sort: {
    machine: r => r.machine_serial_no, model: r => r.model, energy: r => r.kwh, run: r => r.run_seconds, produced: r => r.produced,
    kwh_per_part: r => r.kwh_per_part, cost: r => r.cost, peak: r => r.peak_kw, status: r => (r.is_overloaded ? 1 : 0)
  },
  filter: { model: r => r.model, status: r => (r.is_overloaded ? 'overload' : 'normal') },
  search: { machine: r => r.machine_serial_no }
};

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') throw httpError(`${label} must be a positive integer`, 400);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

/*
 * The days are plant days (IST), whatever the database's own clock. The range
 * used to be written without a zone, so on a database set to UTC (production)
 * "1 Oct" began at 05:30 IST and "7 Oct" ran on to 05:30 on the 8th — the
 * totals missed the first morning and took in the next one, which the daily
 * chart (IST days) then left out.
 */
const IST = '+05:30';
const plantToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function resolveRange({ from, to }) {
  const isDate = v => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;   // 2026-02-31 is no date
  };
  if (from && !isDate(from)) throw httpError('from must be a date in YYYY-MM-DD form', 400);
  if (to && !isDate(to))     throw httpError('to must be a date in YYYY-MM-DD form', 400);

  const last = to || plantToday();
  const end = `${last}T23:59:59.999${IST}`;
  const first = from || new Date(Date.parse(`${last}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const start = `${first}T00:00:00${IST}`;
  if (new Date(start) > new Date(end)) throw httpError('from must not be after to', 400);
  if (Date.parse(end) - Date.parse(start) >= 366 * 86_400_000) throw httpError('Energy date range must not exceed 366 days', 400);
  return { start, end };
}

function machineFilter(machineId, search, params) {
  let sql = '';
  if (machineId) sql += ` AND m.id = $${params.push(machineId)}`;
  if (search) {
    const bind = `$${params.push(search)}`;
    sql += ` AND (POSITION(${bind} IN LOWER(COALESCE(m.machine_serial_no, ''))) > 0 OR POSITION(${bind} IN LOWER(COALESCE(m.model, ''))) > 0)`;
  }
  return sql;
}


/* Far beyond what any machine tool draws: a rise implying more is a misread.
   The collector applies the same two numbers to production_hourly
   (pms-backend src/lib/energy-step.js), so Reports and this screen agree. */
const MAX_KW = 2000;
const MIN_WINDOW_SEC = 300;

/**
 * Per-machine-per-day consumption from the cumulative counter.
 *
 * The window is bounded on received_at so the planner can prune the
 * telemetry hypertable's chunks; without that predicate this reads all 185
 * of them and gets slower every day.
 */
const DAILY_ENERGY_CTE = `
  readings AS (
    /*
     * Real meter readings only. A 0 is a dropped read, not a meter at zero:
     * counting the climb back from 0 would book the whole meter total as
     * one interval.
     */
    SELECT t.machine_id, t.received_at, t.energy,
           LAG(t.energy)      OVER w AS prev_energy,
           LAG(t.received_at) OVER w AS prev_at
      FROM telemetry_raw t
      JOIN machines m ON m.id = t.machine_id AND m.company_id = $1 AND m.is_active = TRUE
     WHERE t.company_id = $1
       AND t.received_at >= $2::timestamptz
       AND t.received_at <= $3::timestamptz AND t.received_at <= NOW()
       AND t.energy > 0 AND t.energy < 'Infinity'::float8
       %MACHINE%
    WINDOW w AS (PARTITION BY t.machine_id ORDER BY t.received_at)
  ),
  deltas AS (
    /*
     * Consumption between one reading and the next.
     *
     * MAX(energy) - MIN(energy) over a period looks equivalent and is not:
     * it cannot see a counter reset that happens inside the period. A meter
     * replaced mid-day reading 500, 520, 3, 5 has MAX 520 and MIN 3, giving
     * 517 kWh for a machine that actually used 22.
     *
     * Differencing consecutive readings and keeping only the rises gives
     * 20 + (reset, nothing) + 2 = 22, because a machine cannot un-consume
     * electricity. A rise faster than ${MAX_KW} kW since the last reading
     * (measured over at least ${MIN_WINDOW_SEC / 60} minutes) is a misread
     * and counts nothing either.
     *
     * The delta is attributed to the day of the later reading, so overnight
     * consumption lands on the day it finished rather than being lost.
     *
     * A rise no bigger than the smallest limit (${MAX_KW} kW over
     * ${MIN_WINDOW_SEC / 60} minutes) cannot be a misread, so it is kept
     * without working out its own limit — the same answer, without exact
     * decimal arithmetic on every one of millions of readings.
     */
    SELECT machine_id, prev_energy IS NOT NULL AS has_previous,
           (received_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           CASE
             WHEN prev_energy IS NULL THEN NULL
             WHEN energy < prev_energy THEN NULL
             WHEN energy - prev_energy <= (${MAX_KW} * ${MIN_WINDOW_SEC} / 3600.0)::float8 THEN energy - prev_energy
             WHEN energy - prev_energy
                  > ${MAX_KW} * GREATEST(EXTRACT(EPOCH FROM received_at - prev_at), ${MIN_WINDOW_SEC}) / 3600.0 THEN NULL
             ELSE energy - prev_energy
           END AS delta
      FROM readings
  ),
  daily AS (
    SELECT machine_id, day,
           SUM(delta)::numeric   AS kwh,
           COUNT(delta)::bigint AS readings,
           COUNT(*) FILTER (WHERE has_previous AND delta IS NULL)::bigint AS rejected_intervals
      FROM deltas
     WHERE delta IS NOT NULL OR has_previous -- retain rejected intervals as unknown gaps
     GROUP BY machine_id, day
  )`;

/** Tariff and overload threshold, machine override falling back to company. */
async function settingsFor(companyId) {
  const { rows } = await pool.query(
    `SELECT machine_id, cost_per_kwh, currency, overload_kw
       FROM energy_settings es WHERE es.company_id = $1${nullablePlantSql('es.machine_id')}
        AND (es.machine_id IS NULL OR EXISTS (SELECT 1 FROM machines owned
             WHERE owned.id = es.machine_id AND owned.company_id = $1))`,
    [companyId]
  );
  const byMachine = new Map();
  let company = null;
  for (const r of rows) {
    if (r.machine_id === null) company = r;
    else byMachine.set(r.machine_id, r);
  }
  return {
    company,
    forMachine: id => byMachine.get(id) || company || null,
    currency: company?.currency || ([...new Set(rows.filter(r => r.cost_per_kwh != null).map(r => r.currency))].length === 1
      ? rows.find(r => r.cost_per_kwh != null)?.currency : null) || 'INR'
  };
}

/**
 * Each machine's running time and output (production_hourly), and its peak
 * power and average supply voltage and current (telemetry) — every active
 * machine, whether or not it reports anything.
 */
async function machineFigures({ companyId, machineId, search, start, end }) {
  const params = [companyId, start, end];
  const mf = machineFilter(machineId, search, params);

  const { rows } = await pool.query(
    `WITH run AS (
       SELECT ph.machine_id,
              SUM(ph.run_seconds)::bigint  AS run_seconds,
              SUM(ph.produced_qty)::bigint AS produced
         FROM production_hourly ph
         JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1 AND m.is_active = TRUE
        WHERE ph.company_id = $1${plantSql('ph.machine_id')} AND ph.hour_start >= $2::timestamptz AND ph.hour_start <= $3::timestamptz
          AND ph.hour_start < NOW() ${mf}
        GROUP BY ph.machine_id
     ),
     peak AS (
       /* Highest instantaneous power, for the overload check, and the average
          supply voltage and current — read in the same pass over telemetry.
          The size of the power, not its sign: a meter whose current
          transformers face the wrong way reports a running machine as
          negative kW (VMC - 1 - F did), which MAX alone would never flag. */
       SELECT t.machine_id, MAX(ABS(t.power)) FILTER (WHERE ABS(t.power) < 'Infinity'::float8) AS peak_kw,
              AVG(t.voltage) FILTER (WHERE ABS(t.voltage) < 'Infinity'::float8) AS avg_voltage,
              AVG(t.current) FILTER (WHERE ABS(t.current) < 'Infinity'::float8) AS avg_current,
              COUNT(t.voltage) FILTER (WHERE ABS(t.voltage) < 'Infinity'::float8)::bigint AS voltage_readings,
              COUNT(t.current) FILTER (WHERE ABS(t.current) < 'Infinity'::float8)::bigint AS current_readings
         FROM telemetry_raw t
         JOIN machines m ON m.id = t.machine_id AND m.company_id = $1 AND m.is_active = TRUE
        WHERE t.company_id = $1${plantSql('t.machine_id')}
          AND t.received_at >= $2::timestamptz AND t.received_at <= $3::timestamptz AND t.received_at <= NOW()
          AND (t.power IS NOT NULL OR t.voltage IS NOT NULL OR t.current IS NOT NULL)
          ${mf}
        GROUP BY t.machine_id
     )
     SELECT m.id AS machine_id, m.machine_serial_no, m.model,
            COALESCE(r.run_seconds, 0)::bigint AS run_seconds,
            COALESCE(r.produced, 0)::bigint    AS produced,
            pk.peak_kw, pk.avg_voltage, pk.avg_current, pk.voltage_readings, pk.current_readings
       FROM machines m
       LEFT JOIN run r          ON r.machine_id = m.id
       LEFT JOIN peak pk        ON pk.machine_id = m.id
      WHERE m.company_id = $1 AND m.is_active = TRUE${plantSql('m.id')}
        ${mf}
      ORDER BY ${machineOrder('m.machine_serial_no')}`,
    params
  );
  return rows;
}

/**
 * Consumption from the meter counters, in one pass over telemetry: per
 * machine (the table and the tiles), per day (the trend, and the tiles'
 * "vs yesterday") and per calendar month — plus the days of the range, so a
 * day no machine reported remains an explicit unknown point. These were three passes over the same readings, one for each.
 */
async function consumption({ companyId, machineId, search, start, end }) {
  const params = [companyId, start, end];
  const mf = machineFilter(machineId, search, params);

  const { rows } = await pool.query(
    `WITH ${DAILY_ENERGY_CTE.replace('%MACHINE%', mf + plantSql('t.machine_id'))}
     SELECT CASE WHEN GROUPING(machine_id) = 0 AND GROUPING(day) = 0 THEN 'machine_day'
                 WHEN GROUPING(machine_id) = 0 THEN 'machine'
                 WHEN GROUPING(day) = 0        THEN 'day'
                 ELSE 'month' END               AS kind,
            machine_id, day::text AS day, date_trunc('month', day)::date::text AS month,
            SUM(kwh)::numeric                   AS kwh,
            SUM(readings)::bigint               AS readings,
            COUNT(*) FILTER (WHERE kwh IS NOT NULL)::int AS n,
            SUM(rejected_intervals)::bigint AS rejected_intervals
       FROM daily
      GROUP BY GROUPING SETS ((machine_id), (day), (date_trunc('month', day)::date), (machine_id, day))
     UNION ALL
     SELECT 'calendar', NULL, g::date::text, NULL, NULL, NULL, NULL, NULL
       FROM generate_series(($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,
                            ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, INTERVAL '1 day') AS g`,
    params
  );
  return rows;
}

/**
 * Everything the screen draws from the meters and the hourly figures, for
 * one company, machine and range: each machine's row, the daily trend and
 * the months. Every part rests on it, so it is worked out once and shared
 * (cache.js) — by the parts, by paging and searching the table, and by
 * everyone in the company looking at the same range.
 */
async function figures({ companyId, machineId, search, start, end }) {
  const [energyRows, machineRows] = await Promise.all([
    consumption({ companyId, machineId, search, start, end }),
    machineFigures({ companyId, machineId, search, start, end })
  ]);

  const perMachine = new Map();
  const perDay = new Map();
  const machineDays = [];
  const calendar = [];
  const months = [];
  for (const r of energyRows) {
    if (r.kind === 'machine_day') machineDays.push(r);
    else if (r.kind === 'machine') perMachine.set(r.machine_id, r);
    else if (r.kind === 'day') perDay.set(+new Date(r.day), r);
    else if (r.kind === 'month') months.push(r);
    else if (r.kind === 'calendar') calendar.push(r.day);
  }

  const machines = machineRows.map(m => {
    const e = perMachine.get(m.machine_id);
    // no counter reading: unknown, not zero
    return { ...m, kwh: e ? e.kwh : null, days: e ? e.n : null, readings: e ? e.readings : null, rejected_intervals: e ? e.rejected_intervals : 0 };
  });

  const trend = calendar.sort((a, b) => +new Date(a) - +new Date(b)).map(day => {
    const d = perDay.get(+new Date(day));
    return {
      day,
      kwh: d?.kwh == null ? null : Number(d.kwh),
      rejected_intervals: Number(d?.rejected_intervals || 0),
      // a day with no reporting machines has no consumption figure at all,
      // which is different from a day that consumed nothing
      machines: d ? Number(d.n) : 0
    };
  });

  return {
    machines,
    trend,
    machineDays,
    months: months.sort((a, b) => +new Date(a.month) - +new Date(b.month)).map(r => ({ month: r.month, kwh: r.kwh == null ? null : Number(r.kwh), rejected_intervals: Number(r.rejected_intervals || 0) }))
  };
}

/** Consumption by shift, to compare usage across them. */
async function byShift({ companyId, machineId, search, start, end }) {
  const params = [companyId, start, end];
  const mf = machineFilter(machineId, search, params);

  /* Shift is not on telemetry_raw, so energy cannot be split by shift from
     the counter directly. production_hourly carries both the shift and the
     energy the collector accumulated per hour, so the split comes from
     there — and is reported as such rather than implied to be meter-exact. */
  const { rows } = await pool.query(
    `SELECT COALESCE(s.shift_name, 'Unassigned') AS shift_name, ph.shift_id,
            SUM(ph.energy_kwh)::numeric AS kwh,
            SUM(ph.run_seconds)::bigint              AS run_seconds,
            SUM(ph.produced_qty)::bigint             AS produced
       FROM production_hourly ph
       JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1 AND m.is_active = TRUE
       LEFT JOIN shifts s ON s.id = ph.shift_id AND s.company_id = $1
      WHERE ph.company_id = $1${plantSql('ph.machine_id')} AND ph.hour_start >= $2::timestamptz AND ph.hour_start <= $3::timestamptz
        AND ph.hour_start < NOW() ${mf}
      GROUP BY s.shift_name, ph.shift_id
      ORDER BY kwh DESC`,
    params
  );
  return rows.map(r => ({
    shift_name: r.shift_name, shift_id: r.shift_id,
    // Legacy hourly rows default missing meter energy to zero. A zero
    // allocation cannot establish a measured zero, unlike a flat counter.
    kwh: Number(r.kwh) > 0 ? Number(r.kwh) : null,
    run_seconds: Number(r.run_seconds),
    produced: Number(r.produced)
  }));
}

function round(v, dp = 2) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp));
}

/*
 * The whole screen, or the parts asked for (`part`, see parts.js): kpis =
 * the tiles; charts = the trend, shift, top-five and cost charts; table =
 * Machine Detail. Every part rests on figures() — the per-machine rows (the
 * tiles are their sums) and the daily trend (a chart, and the tiles' "vs
 * yesterday") — worked out once per company, machine and range and shared.
 */
async function getEnergy(q = {}, { exportAll = false } = {}) {
  const want = parsePart(q.part);
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId = parseId(q.machine_id, 'machine_id');
  if (q.search != null && typeof q.search !== 'string') throw httpError('search must be text', 400);
  const search = (q.search || '').trim().toLowerCase();
  if (search.length > 200) throw httpError('search must not exceed 200 characters', 400);
  const pageNum = parseId(q.page, 'page') || 1;
  const limitNum = Math.min(200, parseId(q.limit, 'limit') || 20);
  if (!Number.isSafeInteger((pageNum - 1) * limitNum)) throw httpError('page is too large', 400);
  /* The Overload Alerts tile narrows Machine Detail to the machines behind
     its number (the table and its export only; the tiles keep every machine). */
  const show = q.show === undefined || q.show === null || q.show === '' || q.show === 'all' ? null : String(q.show).toLowerCase();
  if (show && show !== 'overload') throw httpError('show must be all or overload', 400);

  const [figs, shifts, settings] = await Promise.all([
    cache.remember('energy:figures', companyId, { machineId, search, start, end }, cache.ttlFor(q),
      () => figures({ companyId, machineId, search, start, end })),
    when(want.charts, () => byShift({ companyId, machineId, search, start, end }), []),
    settingsFor(companyId)
  ]);
  const rows = figs.machines;

  let machines = rows.map(r => {
    const cfg  = settings.forMachine(r.machine_id);
    const kwh  = round(r.kwh, 8);
    const rate = round(cfg?.cost_per_kwh, 8);
    const peak = round(r.peak_kw, 8);
    const overloadKw = round(cfg?.overload_kw, 8);
    const produced = Number(r.produced);
    const machineComplete = kwh != null && !Number(r.rejected_intervals || 0)
      && (!figs.trend.length || Number(r.days) === figs.trend.length);

    return {
      machine_id: r.machine_id,
      machine_serial_no: r.machine_serial_no,
      model: r.model,
      kwh: round(kwh),
      currency: cfg?.currency || settings.currency,
      rejected_intervals: Number(r.rejected_intervals || 0),
      energy_complete: machineComplete,
      // null, not zero: a machine that reported no counter has unknown
      // consumption, which is not the same as having consumed nothing
      readings: r.readings === null ? 0 : Number(r.readings),
      run_seconds: Number(r.run_seconds),
      produced,
      kwh_per_part: (machineComplete && produced > 0) ? round(kwh / produced, 4) : null,
      cost: (machineComplete && rate != null && cfg?.currency === settings.currency) ? round(kwh * rate) : null,
      peak_kw: round(peak),
      avg_voltage: r.avg_voltage == null ? null : round(r.avg_voltage, 1),
      avg_current: r.avg_current == null ? null : round(r.avg_current, 1),
      voltage_readings: Number(r.voltage_readings || 0),
      current_readings: Number(r.current_readings || 0),
      overload_kw: overloadKw,
      is_overloaded: (peak != null && overloadKw != null) ? peak > overloadKw : false
    };
  });

  if (search) {
    machines = machines.filter(m =>
      String(m.machine_serial_no || '').toLowerCase().includes(search) ||
      String(m.model || '').toLowerCase().includes(search));
  }

  const reporting = machines.filter(m => m.kwh !== null);
  // Sum unrounded readings, then round once; hundreds of small machine
  // figures must not disappear just because their displayed rows round down.
  const rawByMachine = new Map(rows.map(r => [r.machine_id, r]));
  const totalKwh = reporting.reduce((n, m) => n + Number(rawByMachine.get(m.machine_id).kwh), 0);
  const totalCost = reporting.reduce((n, m) => {
    const rate = round(settings.forMachine(m.machine_id)?.cost_per_kwh, 8);
    return n + (rate == null ? 0 : Number(rawByMachine.get(m.machine_id).kwh) * rate);
  }, 0);
  const rejectedIntervals = machines.reduce((n, m) => n + m.rejected_intervals, 0);
  const dailyComplete = r => machines.length > 0 && r.kwh != null
    && r.machines === machines.length && !r.rejected_intervals;
  const energyComplete = machines.length > 0 && reporting.length === machines.length && rejectedIntervals === 0
    && figs.trend.every(dailyComplete);
  const currencyConsistent = reporting.every(m => m.currency === settings.currency);
  const priced = reporting.filter(m => m.cost !== null && m.currency === settings.currency).length;
  const costComplete = energyComplete && currencyConsistent && priced === reporting.length;
  const totalRun  = machines.reduce((n, m) => n + m.run_seconds, 0);
  const totalProduced = machines.reduce((n, m) => n + m.produced, 0);

  // The company default alone cannot price a trend: machine overrides may
  // differ, or a machine may have no tariff. Price each measured interval's
  // machine/day total once, without another scan over raw telemetry.
  const ids = new Set(machines.map(m => m.machine_id));
  const costsByDay = new Map();
  const costsByMonth = new Map();
  for (const r of figs.machineDays || []) {
    if (!ids.has(r.machine_id)) continue;
    const cfg = settings.forMachine(r.machine_id);
    const rate = round(cfg?.cost_per_kwh, 8);
    const priced = rate != null && cfg?.currency === settings.currency;
    const day = new Date(r.day).toISOString().slice(0, 10);
    for (const [map, key] of [[costsByDay, day], [costsByMonth, day.slice(0, 7)]]) {
      const point = map.get(key) || { cost: 0, complete: true, machines: new Set() };
      point.complete = point.complete && priced && !Number(r.rejected_intervals || 0);
      point.machines.add(r.machine_id);
      if (priced) point.cost += Number(r.kwh) * rate;
      map.set(key, point);
    }
  }
  const pricePoint = (r, dateKey, map, length) => {
    const point = map.get(new Date(r[dateKey]).toISOString().slice(0, length));
    const selectedDays = dateKey === 'month'
      ? figs.trend.filter(d => new Date(d.day).toISOString().slice(0, 7) === new Date(r.month).toISOString().slice(0, 7))
      : [r];
    const complete = !!point && point.complete && point.machines.size === machines.length
      && selectedDays.every(dailyComplete);
    return { ...r, cost: complete ? round(point.cost) : null, cost_complete: complete };
  };
  const trend = figs.trend.map(r => pricePoint(r, 'day', costsByDay, 10));
  const months = figs.months.map(r => pricePoint(r, 'month', costsByMonth, 7));

  const offset   = (pageNum - 1) * limitNum;
  const listed = show === 'overload' ? machines.filter(m => m.is_overloaded) : machines;
  const head = want.table ? tableRows(listed, q, HEAD) : null;
  const sorted = !want.table ? [] : head.sort ? head.rows : [...head.rows].sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1));

  /* Volts and amps averaged over the readings, each machine weighted by how
     many readings it sent; null when no machine sends them. */
  const weighted = (valKey, nKey) => {
    const src = machines.filter(m => m[valKey] != null && m[nKey] > 0);
    const n = src.reduce((a, m) => a + m[nKey], 0);
    return n ? round(src.reduce((a, m) => a + m[valKey] * m[nKey], 0) / n, 1) : null;
  };

  /* The last day in the range against the one before it — the design's
     "vs Yesterday". Only when both days had a reporting machine. */
  const [prevDay, lastDay] = trend.slice(-2);
  const vsYesterday = (prevDay && lastDay && machines.length > 0
    && prevDay.machines === machines.length && lastDay.machines === machines.length
    && !prevDay.rejected_intervals && !lastDay.rejected_intervals && prevDay.kwh > 0)
    ? round(((lastDay.kwh - prevDay.kwh) / prevDay.kwh) * 100, 1) : null;

  // the machine furthest over its limit, for the Overload tile
  const worst = machines.filter(m => m.is_overloaded)
    .sort((a, b) => (b.peak_kw - b.overload_kw) - (a.peak_kw - a.overload_kw))[0];

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, search: (q.search || '').trim() || null, show
    },
    currency: settings.currency,
    cost_basis: 'current_tariff_estimate',
    energy_source: 'telemetry_counter_deltas',
    by_shift_source: 'production_hourly',
    // Company-default metadata only. Trend costs are priced per machine
    // using the currently configured tariff, not a historical invoice.
    rate_per_kwh: settings.company?.cost_per_kwh != null ? Number(settings.company.cost_per_kwh) : null,
    ...(want.kpis && {
      kpis: {
        total_kwh: reporting.length ? round(totalKwh) : null,
        total_operating_seconds: totalRun,
        total_produced: totalProduced,
        kwh_per_part: (energyComplete && totalProduced > 0) ? round(totalKwh / totalProduced, 4) : null,
        total_cost: costComplete ? round(totalCost) : null,
        avg_voltage: weighted('avg_voltage', 'voltage_readings'),
        avg_current: weighted('avg_current', 'current_readings'),
        kwh_vs_yesterday_pct: vsYesterday,
        overload_alerts: machines.filter(m => m.is_overloaded).length,
        // whether any machine has a limit to be judged against: 0 alerts with none set is no all-clear
        overload_limit_set: machines.some(m => m.overload_kw != null),
        overload_top: worst ? { machine_serial_no: worst.machine_serial_no, exceeded_kw: round(worst.peak_kw - worst.overload_kw, 1) } : null
      },
      /* Stated up front because it decides whether any of this means
         anything: energy is only known for machines that report the counter. */
      coverage: {
        machines: machines.length,
        reporting: reporting.length,
        tariff_configured: machines.some(m => round(settings.forMachine(m.machine_id)?.cost_per_kwh, 8) != null),
        rejected_intervals: rejectedIntervals,
        energy_complete: energyComplete,
        cost_complete: costComplete,
        priced,
        currency_consistent: currencyConsistent,
        note: reporting.length === 0
          ? 'No accepted energy intervals were measured in the selected period.'
          : `${reporting.length} of ${machines.length} machines report an energy counter.`
      }
    }),
    ...(want.charts && {
      trend,
      by_shift: shifts,
      by_month: months,
      top_consumers: [...reporting].sort((a, b) => b.kwh - a.kwh).slice(0, 5),
      overloads: machines.filter(m => m.is_overloaded)
    }),
    ...(want.table && {
      machines: {
        data: exportAll ? sorted : sorted.slice(offset, offset + limitNum),
        total: sorted.length,
        page: pageNum, limit: limitNum,
        totalPages: Math.max(1, Math.ceil(sorted.length / limitNum))
      }
    }),
    updated_at: new Date().toISOString()
  };
}
exports.getEnergy = getEnergy;

/* ── settings ── */

exports.getSettings = async (companyId) => {
  const { rows } = await pool.query(
    `SELECT es.id, es.machine_id, es.cost_per_kwh, es.currency, es.overload_kw,
            m.machine_serial_no
       FROM energy_settings es
       LEFT JOIN machines m ON m.id = es.machine_id AND m.company_id = $1
      WHERE es.company_id = $1${nullablePlantSql('es.machine_id')}
        AND (es.machine_id IS NULL OR m.id IS NOT NULL)
      ORDER BY es.machine_id NULLS FIRST`,
    [companyId]
  );
  return rows;
};

exports.saveSettings = async ({ company_id, machine_id, cost_per_kwh, currency, overload_kw, user_id }) => {
  const machineId = parseId(machine_id, 'machine_id');
  if (!machineId && current()?.plantId != null) throw httpError('Company-wide energy settings require company administration', 403);

  const numOrNull = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'number' && typeof v !== 'string') throw httpError(`${label} must be a positive number`, 400);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw httpError(`${label} must be a positive number`, 400);
    return n;
  };
  const rate = numOrNull(cost_per_kwh, 'cost_per_kwh');
  const overload = numOrNull(overload_kw, 'overload_kw');
  // Match the database numeric precision and return an actionable 400 rather
  // than a numeric-overflow 500. Zero is a valid explicitly configured rate.
  if (rate != null && rate > 999999.9999) throw httpError('cost_per_kwh must not exceed 999999.9999', 400);
  if (overload != null && overload > 99999999.99) throw httpError('overload_kw must not exceed 99999999.99', 400);
  let currencyCode = 'INR';
  if (currency != null && currency !== '') {
    if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
      throw httpError('currency must be a three-letter currency code', 400);
    }
    currencyCode = currency.trim().toUpperCase();
  }

  if (machineId) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM machines WHERE id = $1 AND company_id = $2${plantSql('id')}`, [machineId, company_id]);
    if (!rowCount) throw httpError('Machine not found or access denied', 404);
  }

  /* The partial unique indexes make "one default per company, one override
     per machine" a rule the database enforces, so this upserts against them
     rather than reading first and racing another writer. */
  const conflict = machineId
    ? 'ON CONFLICT (machine_id) WHERE machine_id IS NOT NULL'
    : 'ON CONFLICT (company_id) WHERE machine_id IS NULL';

  const { rows } = await pool.query(
    `INSERT INTO energy_settings (company_id, machine_id, cost_per_kwh, currency, overload_kw, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ${conflict} DO UPDATE
        SET cost_per_kwh = EXCLUDED.cost_per_kwh,
            currency     = EXCLUDED.currency,
            overload_kw  = EXCLUDED.overload_kw,
            updated_at   = NOW()
      WHERE energy_settings.company_id = EXCLUDED.company_id
     RETURNING *`,
    [company_id, machineId, rate, currencyCode, overload, user_id]
  );
  if (!rows.length) throw httpError('Machine tariff ownership has changed; contact company administration', 409);
  return rows[0];
};

exports.getExportRows = async (q = {}) => {
  // the table's rows only: the export needs no trend or chart
  const d = await getEnergy({ ...q, part: 'table', page: 1, limit: 200 }, { exportAll: true });
  const hhmm = s => `${Math.floor((Number(s) || 0) / 3600)}h ${String(Math.floor(((Number(s) || 0) % 3600) / 60)).padStart(2, '0')}m`;
  const nz = v => v === null || v === undefined ? '' : v;

  return d.machines.data.map(r => ({
    'Machine':        r.machine_serial_no,
    'Energy (kWh)':   nz(r.kwh),
    'Operating time': hhmm(r.run_seconds),
    'Production':     r.produced,
    'kWh per part':   nz(r.kwh_per_part),
    [`Cost (${d.currency})`]: r.currency === d.currency ? nz(r.cost) : '',
    'Cost currency':  r.currency,
    'Energy coverage': r.energy_complete ? 'Measured intervals' : (r.kwh == null ? 'Not reported' : 'Partial: meter gaps'),
    'Peak kW':        nz(r.peak_kw),
    'Overload':       r.is_overloaded ? 'Yes' : ''
  }));
};

exports.resolveRange = resolveRange;
