/**
 * Phase 2 · Screen 9 — Energy Monitoring.
 *
 * ── How energy is measured ─────────────────────────────────────────────
 *
 * Devices report `energy` as a cumulative kWh counter, not as consumption
 * per message. Consumption over a period is therefore the difference
 * between the first and last reading in it, per machine — not a sum of the
 * readings, which would add up a running total and produce a number with
 * no meaning at all.
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
 * Consumption is computed per machine per day, then summed. Computing it
 * across the whole window at once would miss every reset inside it.
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
const { parsePart, when } = require('./parts');
const cache = require('./cache');

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

function resolveRange({ from, to }) {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
  if (from && !isDate(from)) throw httpError('from must be a date in YYYY-MM-DD form', 400);
  if (to && !isDate(to))     throw httpError('to must be a date in YYYY-MM-DD form', 400);

  const end   = to   ? `${to} 23:59:59.999` : new Date().toISOString();
  const start = from ? `${from} 00:00:00`
                     : new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10) + ' 00:00:00';
  if (new Date(start) > new Date(end)) throw httpError('from must not be after to', 400);
  return { start, end };
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
     WHERE t.company_id = $1
       AND t.received_at >= $2::timestamptz
       AND t.received_at <= $3::timestamptz
       AND t.energy > 0
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
    SELECT machine_id,
           (received_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           CASE
             WHEN prev_energy IS NULL THEN NULL
             WHEN energy <= prev_energy THEN 0
             WHEN energy - prev_energy <= (${MAX_KW} * ${MIN_WINDOW_SEC} / 3600.0)::float8 THEN energy - prev_energy
             WHEN energy - prev_energy
                  > ${MAX_KW} * GREATEST(EXTRACT(EPOCH FROM received_at - prev_at), ${MIN_WINDOW_SEC}) / 3600.0 THEN 0
             ELSE energy - prev_energy
           END AS delta
      FROM readings
  ),
  daily AS (
    SELECT machine_id, day,
           SUM(delta)::numeric   AS kwh,
           COUNT(*)::bigint      AS readings
      FROM deltas
     WHERE delta IS NOT NULL   -- the first reading of a machine has no predecessor
     GROUP BY machine_id, day
  )`;

/** Tariff and overload threshold, machine override falling back to company. */
async function settingsFor(companyId) {
  const { rows } = await pool.query(
    `SELECT machine_id, cost_per_kwh, currency, overload_kw
       FROM energy_settings WHERE company_id = $1`,
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
    currency: company?.currency || 'INR'
  };
}

/**
 * Each machine's running time and output (production_hourly), and its peak
 * power and average supply voltage and current (telemetry) — every active
 * machine, whether or not it reports anything.
 */
async function machineFigures({ companyId, machineId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND t.machine_id = $${params.length}`) : '';

  const { rows } = await pool.query(
    `WITH run AS (
       SELECT ph.machine_id,
              SUM(ph.run_seconds)::bigint  AS run_seconds,
              SUM(ph.produced_qty)::bigint AS produced
         FROM production_hourly ph
         JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1
        WHERE ph.hour_start >= $2::timestamptz AND ph.hour_start <= $3::timestamptz
          ${machineId ? `AND ph.machine_id = $${params.length}` : ''}
        GROUP BY ph.machine_id
     ),
     peak AS (
       /* Highest instantaneous power, for the overload check, and the average
          supply voltage and current — read in the same pass over telemetry.
          The size of the power, not its sign: a meter whose current
          transformers face the wrong way reports a running machine as
          negative kW (VMC - 1 - F did), which MAX alone would never flag. */
       SELECT t.machine_id, MAX(ABS(t.power)) AS peak_kw,
              AVG(t.voltage) AS avg_voltage, AVG(t.current) AS avg_current,
              COUNT(t.voltage)::bigint AS voltage_readings, COUNT(t.current)::bigint AS current_readings
         FROM telemetry_raw t
        WHERE t.company_id = $1
          AND t.received_at >= $2::timestamptz AND t.received_at <= $3::timestamptz
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
      WHERE m.company_id = $1 AND m.is_active = TRUE
        ${machineId ? `AND m.id = $${params.length}` : ''}
      ORDER BY m.machine_serial_no`,
    params
  );
  return rows;
}

/**
 * Consumption from the meter counters, in one pass over telemetry: per
 * machine (the table and the tiles), per day (the trend, and the tiles'
 * "vs yesterday") and per calendar month — plus the days of the range, so a
 * day no machine reported is a zero on the chart rather than a missing
 * point. These were three passes over the same readings, one for each.
 */
async function consumption({ companyId, machineId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND t.machine_id = $${params.length}`) : '';

  const { rows } = await pool.query(
    `WITH ${DAILY_ENERGY_CTE.replace('%MACHINE%', mf)}
     SELECT CASE WHEN GROUPING(machine_id) = 0 THEN 'machine'
                 WHEN GROUPING(day) = 0        THEN 'day'
                 ELSE 'month' END               AS kind,
            machine_id, day, date_trunc('month', day)::date AS month,
            SUM(kwh)::numeric                   AS kwh,
            SUM(readings)::bigint               AS readings,
            COUNT(*)::int                       AS n
       FROM daily
      GROUP BY GROUPING SETS ((machine_id), (day), (date_trunc('month', day)::date))
     UNION ALL
     SELECT 'calendar', NULL, g::date, NULL, NULL, NULL, NULL
       FROM generate_series($2::timestamptz::date, $3::timestamptz::date, INTERVAL '1 day') AS g`,
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
async function figures({ companyId, machineId, start, end }) {
  const [energyRows, machineRows] = await Promise.all([
    consumption({ companyId, machineId, start, end }),
    machineFigures({ companyId, machineId, start, end })
  ]);

  const perMachine = new Map();
  const perDay = new Map();
  const calendar = [];
  const months = [];
  for (const r of energyRows) {
    if (r.kind === 'machine') perMachine.set(r.machine_id, r);
    else if (r.kind === 'day') perDay.set(+new Date(r.day), r);
    else if (r.kind === 'month') months.push(r);
    else if (r.kind === 'calendar') calendar.push(r.day);
  }

  const machines = machineRows.map(m => {
    const e = perMachine.get(m.machine_id);
    // no counter reading: unknown, not zero
    return { ...m, kwh: e ? e.kwh : null, days: e ? e.n : null, readings: e ? e.readings : null };
  });

  const trend = calendar.sort((a, b) => a - b).map(day => {
    const d = perDay.get(+new Date(day));
    return {
      day,
      kwh: d ? Number(d.kwh) : 0,
      // a day with no reporting machines has no consumption figure at all,
      // which is different from a day that consumed nothing
      machines: d ? Number(d.n) : 0
    };
  });

  return {
    machines,
    trend,
    months: months.sort((a, b) => a.month - b.month).map(r => ({ month: r.month, kwh: Number(r.kwh) }))
  };
}

/** Consumption by shift, to compare usage across them. */
async function byShift({ companyId, machineId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND ph.machine_id = $${params.length}`) : '';

  /* Shift is not on telemetry_raw, so energy cannot be split by shift from
     the counter directly. production_hourly carries both the shift and the
     energy the collector accumulated per hour, so the split comes from
     there — and is reported as such rather than implied to be meter-exact. */
  const { rows } = await pool.query(
    `SELECT COALESCE(s.shift_name, 'Unassigned') AS shift_name, ph.shift_id,
            COALESCE(SUM(ph.energy_kwh), 0)::numeric AS kwh,
            SUM(ph.run_seconds)::bigint              AS run_seconds,
            SUM(ph.produced_qty)::bigint             AS produced
       FROM production_hourly ph
       JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1
       LEFT JOIN shifts s ON s.id = ph.shift_id
      WHERE ph.hour_start >= $2::timestamptz AND ph.hour_start <= $3::timestamptz
        ${mf}
      GROUP BY s.shift_name, ph.shift_id
      ORDER BY kwh DESC`,
    params
  );
  return rows.map(r => ({
    shift_name: r.shift_name, shift_id: r.shift_id,
    kwh: Number(r.kwh),
    run_seconds: Number(r.run_seconds),
    produced: Number(r.produced)
  }));
}

function round(v, dp = 2) {
  return v === null || v === undefined ? null : Number(Number(v).toFixed(dp));
}

/*
 * The whole screen, or the parts asked for (`part`, see parts.js): kpis =
 * the tiles; charts = the trend, shift, top-five and cost charts; table =
 * Machine Detail. Every part rests on figures() — the per-machine rows (the
 * tiles are their sums) and the daily trend (a chart, and the tiles' "vs
 * yesterday") — worked out once per company, machine and range and shared.
 */
exports.getEnergy = async (q = {}) => {
  const want = parsePart(q.part);
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId = parseId(q.machine_id, 'machine_id');
  const search = (q.search || '').trim().toLowerCase();

  const [figs, shifts, settings] = await Promise.all([
    cache.remember('energy:figures', companyId, { machineId, start, end }, cache.ttlFor(q),
      () => figures({ companyId, machineId, start, end })),
    when(want.charts, () => byShift({ companyId, machineId, start, end }), []),
    settingsFor(companyId)
  ]);
  const rows = figs.machines;
  const trend = figs.trend;
  const months = figs.months;

  let machines = rows.map(r => {
    const cfg  = settings.forMachine(r.machine_id);
    const kwh  = r.kwh === null ? null : Number(r.kwh);
    const rate = cfg?.cost_per_kwh != null ? Number(cfg.cost_per_kwh) : null;
    const peak = r.peak_kw === null ? null : Number(r.peak_kw);
    const overloadKw = cfg?.overload_kw != null ? Number(cfg.overload_kw) : null;
    const produced = Number(r.produced);

    return {
      machine_id: r.machine_id,
      machine_serial_no: r.machine_serial_no,
      model: r.model,
      kwh: round(kwh),
      // null, not zero: a machine that reported no counter has unknown
      // consumption, which is not the same as having consumed nothing
      readings: r.readings === null ? 0 : Number(r.readings),
      run_seconds: Number(r.run_seconds),
      produced,
      kwh_per_part: (kwh != null && produced > 0) ? round(kwh / produced, 4) : null,
      cost: (kwh != null && rate != null) ? round(kwh * rate) : null,
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
  const totalKwh  = reporting.reduce((n, m) => n + m.kwh, 0);
  const totalCost = reporting.reduce((n, m) => n + (m.cost ?? 0), 0);
  const hasAnyCost = reporting.some(m => m.cost !== null);
  const totalRun  = machines.reduce((n, m) => n + m.run_seconds, 0);
  const totalProduced = machines.reduce((n, m) => n + m.produced, 0);

  const pageNum  = Math.max(1, Number(q.page) || 1);
  const limitNum = Math.min(200, Math.max(1, Number(q.limit) || 20));
  const offset   = (pageNum - 1) * limitNum;
  const sorted = want.table ? [...machines].sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1)) : [];

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
  const vsYesterday = (prevDay && lastDay && prevDay.machines > 0 && lastDay.machines > 0 && prevDay.kwh > 0)
    ? round(((lastDay.kwh - prevDay.kwh) / prevDay.kwh) * 100, 1) : null;

  // the machine furthest over its limit, for the Overload tile
  const worst = machines.filter(m => m.is_overloaded)
    .sort((a, b) => (b.peak_kw - b.overload_kw) - (a.peak_kw - a.overload_kw))[0];

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, search: (q.search || '').trim() || null
    },
    currency: settings.currency,
    // the company tariff, so the cost trend can price each day, week or month
    rate_per_kwh: settings.company?.cost_per_kwh != null ? Number(settings.company.cost_per_kwh) : null,
    ...(want.kpis && {
      kpis: {
        total_kwh: reporting.length ? round(totalKwh) : null,
        total_operating_seconds: totalRun,
        total_produced: totalProduced,
        kwh_per_part: (reporting.length && totalProduced > 0) ? round(totalKwh / totalProduced, 4) : null,
        total_cost: hasAnyCost ? round(totalCost) : null,
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
        tariff_configured: settings.company?.cost_per_kwh != null,
        note: reporting.length === 0
          ? 'No machine is reporting an energy counter yet. Energy figures appear once the devices send the `energy` field over MQTT.'
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
        data: sorted.slice(offset, offset + limitNum),
        total: sorted.length,
        page: pageNum, limit: limitNum,
        totalPages: Math.max(1, Math.ceil(sorted.length / limitNum))
      }
    }),
    updated_at: new Date().toISOString()
  };
};

/* ── settings ── */

exports.getSettings = async (companyId) => {
  const { rows } = await pool.query(
    `SELECT es.id, es.machine_id, es.cost_per_kwh, es.currency, es.overload_kw,
            m.machine_serial_no
       FROM energy_settings es
       LEFT JOIN machines m ON m.id = es.machine_id
      WHERE es.company_id = $1
      ORDER BY es.machine_id NULLS FIRST`,
    [companyId]
  );
  return rows;
};

exports.saveSettings = async ({ company_id, machine_id, cost_per_kwh, currency, overload_kw, user_id }) => {
  const machineId = parseId(machine_id, 'machine_id');

  const numOrNull = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw httpError(`${label} must be a positive number`, 400);
    return n;
  };
  const rate = numOrNull(cost_per_kwh, 'cost_per_kwh');
  const overload = numOrNull(overload_kw, 'overload_kw');

  if (machineId) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM machines WHERE id = $1 AND company_id = $2`, [machineId, company_id]);
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
     RETURNING *`,
    [company_id, machineId, rate, (currency || 'INR').toUpperCase().slice(0, 8), overload, user_id]
  );
  return rows[0];
};

exports.getExportRows = async (q = {}) => {
  // the table's rows only: the export needs no trend or chart
  const d = await exports.getEnergy({ ...q, part: 'table', page: 1, limit: 200 });
  const hhmm = s => `${Math.floor((Number(s) || 0) / 3600)}h ${String(Math.floor(((Number(s) || 0) % 3600) / 60)).padStart(2, '0')}m`;
  const nz = v => v === null || v === undefined ? '' : v;

  return d.machines.data.map(r => ({
    'Machine':        r.machine_serial_no,
    'Energy (kWh)':   nz(r.kwh),
    'Operating time': hhmm(r.run_seconds),
    'Production':     r.produced,
    'kWh per part':   nz(r.kwh_per_part),
    [`Cost (${d.currency})`]: nz(r.cost),
    'Peak kW':        nz(r.peak_kw),
    'Overload':       r.is_overloaded ? 'Yes' : ''
  }));
};

exports.resolveRange = resolveRange;
