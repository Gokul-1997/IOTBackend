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
 * telemetry_raw.energy is NULL on every row in this database: no device
 * has ever sent it. Everything here is correct and returns nothing until
 * that changes. The screen says so rather than showing zeros that look
 * like a very efficient factory.
 */

const pool = require('../db');

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

/**
 * Per-machine-per-day consumption from the cumulative counter.
 *
 * The window is bounded on received_at so the planner can prune the
 * telemetry hypertable's chunks; without that predicate this reads all 185
 * of them and gets slower every day.
 */
const DAILY_ENERGY_CTE = `
  deltas AS (
    /*
     * Consumption between one reading and the next.
     *
     * MAX(energy) - MIN(energy) over a period looks equivalent and is not:
     * it cannot see a counter reset that happens inside the period. A meter
     * replaced mid-day reading 500, 520, 0, 5 has MAX 520 and MIN 0, giving
     * 520 kWh for a machine that actually used 25.
     *
     * Differencing consecutive readings and keeping only the rises gives
     * 20 + (reset, dropped) + 5 = 25. GREATEST(..., 0) is what discards the
     * reset, because a machine cannot un-consume electricity.
     *
     * The delta is attributed to the day of the later reading, so overnight
     * consumption lands on the day it finished rather than being lost.
     */
    SELECT machine_id,
           (received_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           GREATEST(energy - LAG(energy) OVER (PARTITION BY machine_id ORDER BY received_at), 0) AS delta
      FROM (
        SELECT t.machine_id, t.received_at, t.energy
          FROM telemetry_raw t
         WHERE t.company_id = $1
           AND t.received_at >= $2::timestamptz
           AND t.received_at <= $3::timestamptz
           AND t.energy IS NOT NULL
           %MACHINE%
      ) r
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

async function perMachine({ companyId, machineId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND t.machine_id = $${params.length}`) : '';

  const { rows } = await pool.query(
    `WITH ${DAILY_ENERGY_CTE.replace('%MACHINE%', mf)},
     per_machine AS (
       SELECT machine_id,
              SUM(kwh)::numeric      AS kwh,
              SUM(readings)::bigint  AS readings,
              COUNT(*)::int          AS days
         FROM daily GROUP BY machine_id
     ),
     run AS (
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
       /* Highest instantaneous power seen, for the overload check. */
       SELECT t.machine_id, MAX(t.power) AS peak_kw
         FROM telemetry_raw t
        WHERE t.company_id = $1
          AND t.received_at >= $2::timestamptz AND t.received_at <= $3::timestamptz
          AND t.power IS NOT NULL
          ${mf}
        GROUP BY t.machine_id
     )
     SELECT m.id AS machine_id, m.machine_serial_no, m.model,
            pm.kwh, pm.days, pm.readings,
            COALESCE(r.run_seconds, 0)::bigint AS run_seconds,
            COALESCE(r.produced, 0)::bigint    AS produced,
            pk.peak_kw
       FROM machines m
       LEFT JOIN per_machine pm ON pm.machine_id = m.id
       LEFT JOIN run r          ON r.machine_id = m.id
       LEFT JOIN peak pk        ON pk.machine_id = m.id
      WHERE m.company_id = $1 AND m.is_active = TRUE
        ${machineId ? `AND m.id = $${params.length}` : ''}
      ORDER BY m.machine_serial_no`,
    params
  );
  return rows;
}

/** Consumption per day across the fleet, for the trend chart. */
async function dailyTrend({ companyId, machineId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND t.machine_id = $${params.length}`) : '';

  const { rows } = await pool.query(
    `WITH ${DAILY_ENERGY_CTE.replace('%MACHINE%', mf)},
     days AS (
       SELECT generate_series($2::timestamptz::date, $3::timestamptz::date, INTERVAL '1 day')::date AS day
     )
     SELECT d.day,
            COALESCE(SUM(dl.kwh), 0)::numeric AS kwh,
            COUNT(dl.machine_id)::int         AS machines
       FROM days d LEFT JOIN daily dl ON dl.day = d.day
      GROUP BY d.day ORDER BY d.day`,
    params
  );
  return rows.map(r => ({
    day: r.day,
    kwh: Number(r.kwh),
    // a day with no reporting machines has no consumption figure at all,
    // which is different from a day that consumed nothing
    machines: Number(r.machines)
  }));
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

/** Consumption by calendar month, for the longer view. */
async function byMonth({ companyId, machineId, start, end }) {
  const params = [companyId, start, end];
  const mf = machineId ? (params.push(machineId), ` AND t.machine_id = $${params.length}`) : '';

  const { rows } = await pool.query(
    `WITH ${DAILY_ENERGY_CTE.replace('%MACHINE%', mf)}
     SELECT date_trunc('month', day)::date AS month,
            SUM(kwh)::numeric AS kwh
       FROM daily GROUP BY 1 ORDER BY 1`,
    params
  );
  return rows.map(r => ({ month: r.month, kwh: Number(r.kwh) }));
}

function round(v, dp = 2) {
  return v === null || v === undefined ? null : Number(Number(v).toFixed(dp));
}

exports.getEnergy = async (q = {}) => {
  const companyId = q.company_id;
  const { start, end } = resolveRange(q);
  const machineId = parseId(q.machine_id, 'machine_id');
  const search = (q.search || '').trim().toLowerCase();

  const [rows, trend, shifts, months, settings] = await Promise.all([
    perMachine({ companyId, machineId, start, end }),
    dailyTrend({ companyId, machineId, start, end }),
    byShift({ companyId, machineId, start, end }),
    byMonth({ companyId, machineId, start, end }),
    settingsFor(companyId)
  ]);

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
  const sorted = [...machines].sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1));

  return {
    filters: {
      from: q.from || null, to: q.to || null,
      machine_id: machineId, search: (q.search || '').trim() || null
    },
    currency: settings.currency,
    kpis: {
      total_kwh: reporting.length ? round(totalKwh) : null,
      total_operating_seconds: totalRun,
      total_produced: totalProduced,
      kwh_per_part: (reporting.length && totalProduced > 0) ? round(totalKwh / totalProduced, 4) : null,
      total_cost: hasAnyCost ? round(totalCost) : null,
      overload_alerts: machines.filter(m => m.is_overloaded).length
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
    },
    trend,
    by_shift: shifts,
    by_month: months,
    top_consumers: [...reporting].sort((a, b) => b.kwh - a.kwh).slice(0, 5),
    overloads: machines.filter(m => m.is_overloaded),
    machines: {
      data: sorted.slice(offset, offset + limitNum),
      total: sorted.length,
      page: pageNum, limit: limitNum,
      totalPages: Math.max(1, Math.ceil(sorted.length / limitNum))
    },
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
  const d = await exports.getEnergy({ ...q, page: 1, limit: 200 });
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
