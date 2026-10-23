/*
 * The electricity bill — its dates (Tariff & Rates) and what it will cost
 * (Energy Dashboard, "This bill").
 *
 *   getBillPeriod / saveBillPeriod / clearBillPeriod   the dates, per company
 *   getBill                                             the forecast
 *
 * The bill is the company's: its dates are company-wide, and only someone
 * with the Energy "Tariff Settings" permission and the whole company in view
 * may change them (as with the company tariff). The forecast follows the
 * dashboard's machine filter, and a plant-scoped person sees their plant's
 * machines only.
 *
 * Energy comes from energy_hourly (energy-hourly.service.js) — the meter
 * counters differenced exactly as the Energy screen does — and money from the
 * same tariff as the rest of the screen: each machine's own rate, else the
 * company default. The arithmetic is energy-forecast.js.
 */
const pool = require('../db');
const { plantSql, current } = require('../lib/read-scope');
const hourly = require('./energy-hourly.service');
const fc = require('./energy-forecast');

const httpError = (message, status) => Object.assign(new Error(message), { status });

function parseId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

/** History the forecast reads: the bill before this one, and five weeks for the usual use and its check. */
const NEED_DAYS = 35;

/** Today in plant time (IST). */
const today = (now = Date.now()) => fc.istDay(now);

/* ── the dates ── */

async function enteredOf(companyId) {
  const { rows } = await pool.query(
    `SELECT to_char(period_start, 'YYYY-MM-DD') AS start, to_char(period_end, 'YYYY-MM-DD') AS end,
            updated_at
       FROM energy_billing WHERE company_id = $1`, [companyId]);
  return rows[0] || null;
}

/** The dates as the screens show them: this bill, the next, and how they repeat. */
function describe(entered, now = Date.now()) {
  if (!entered) return { configured: false, entered: null, current: null, next: null, repeats: null };
  const day = today(now);
  const cur = fc.billPeriod(entered, day);
  const next = fc.billPeriod(entered, day, 1);
  return {
    configured: true,
    entered: { start: entered.start, end: entered.end },
    current: { start: cur.start, end: cur.end, days: cur.days },
    next: { start: next.start, end: next.end, days: next.days },
    repeats: fc.repeatsText(cur.pattern),
    updated_at: entered.updated_at ?? null
  };
}

exports.getBillPeriod = async (companyId) => describe(await enteredOf(companyId));

exports.saveBillPeriod = async ({ company_id, period_start, period_end, user_id }) => {
  if (current()?.plantId != null) throw httpError('The bill dates are the whole company\'s: they need company administration', 403);
  const start = fc.parseDay(period_start);
  const end = fc.parseDay(period_end);
  if (!start || !end) throw httpError('Enter the bill\'s first and last day as dates (YYYY-MM-DD)', 400);
  const length = fc.daysBetween(start, end) + 1;
  if (length < 7) throw httpError('A bill runs at least 7 days: the last day must be 6 or more days after the first', 400);
  if (length > 93) throw httpError('A bill runs at most 3 months: the last day must be within 92 days of the first', 400);
  const day = today();
  if (fc.daysBetween(start, day) > 400 || fc.daysBetween(day, start) > 92) {
    throw httpError('The bill\'s first day must be within the last year and not more than 3 months ahead', 400);
  }
  await pool.query(
    `INSERT INTO energy_billing (company_id, period_start, period_end, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE
        SET period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
            updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [company_id, start, end, user_id ?? null]);
  return exports.getBillPeriod(company_id);
};

exports.clearBillPeriod = async ({ company_id }) => {
  if (current()?.plantId != null) throw httpError('The bill dates are the whole company\'s: they need company administration', 403);
  await pool.query('DELETE FROM energy_billing WHERE company_id = $1', [company_id]);
  return describe(null);
};

/* ── the forecast ── */

/** The active machines in scope (the filter, the person's plant) and each one's ₹ per kWh. */
async function machinesAndRates(companyId, machineId) {
  const params = [companyId];
  const mf = machineId ? (params.push(machineId), ` AND m.id = $${params.length}`) : '';
  const { rows } = await pool.query(
    `SELECT m.id, m.machine_serial_no,
            COALESCE(own.cost_per_kwh, dflt.cost_per_kwh) AS rate,
            dflt.currency
       FROM machines m
       LEFT JOIN energy_settings own  ON own.company_id = m.company_id AND own.machine_id = m.id
       LEFT JOIN energy_settings dflt ON dflt.company_id = m.company_id AND dflt.machine_id IS NULL
      WHERE m.company_id = $1 AND m.is_active = TRUE${plantSql('m.id')}${mf}
      ORDER BY m.machine_serial_no`, params);
  return rows;
}

/** `q` is the request's query plus company_id; the clock is the server's (tests pass `now`). */
exports.getBill = async (q = {}, { now = Date.now() } = {}) => {
  const companyId = q.company_id;
  const machineId = parseId(q.machine_id, 'machine_id');

  const [entered, machines] = await Promise.all([enteredOf(companyId), machinesAndRates(companyId, machineId)]);
  if (machineId && !machines.length) throw httpError('Machine not found or access denied', 404);

  const currency = machines.find(m => m.currency)?.currency || 'INR';
  const scope = { machine_id: machineId, machine: machineId ? machines[0].machine_serial_no : null };
  const dates = describe(entered, now);
  if (!entered) return { ...dates, currency, scope };

  const period = fc.billPeriod(entered, today(now));
  const previous = fc.billPeriod(entered, today(now), -1);
  const needFrom = Math.max(
    Math.min(fc.istMidnight(previous.start), fc.istHour(now) - NEED_DAYS * fc.DAY_MS),
    fc.istHour(now) - hourly.HISTORY_DAYS * fc.DAY_MS);

  const { rows, completeFrom } = await hourly.hours(companyId, needFrom, now);
  // older hours not worked out yet: the job is behind, or this is the first look — catch up meanwhile
  if (completeFrom > needFrom) hourly.kick(companyId);

  const ids = machines.map(m => Number(m.id));
  const inScope = new Set(ids);
  const series = new Map();
  for (const r of rows) {
    if (!inScope.has(r.machine_id)) continue;
    if (!series.has(r.machine_id)) series.set(r.machine_id, new Map());
    const s = series.get(r.machine_id);
    s.set(r.hour, (s.get(r.hour) || 0) + r.kwh);
  }
  const rates = new Map(machines.map(m => [Number(m.id), m.rate == null ? null : Number(m.rate)]));

  const periodStart = fc.istMidnight(period.start);
  // the bill's own days are not all worked out yet: say so, rather than a short total
  const preparing = completeFrom > periodStart;
  const figures = fc.forecastBill({
    series, machines: ids, rates, now,
    period: { start: period.start, end: period.end },
    previous: { start: previous.start, end: previous.end },
    historyFrom: completeFrom
  });

  const elapsed = Math.min(period.days, Math.max(0, (now - periodStart) / fc.DAY_MS));
  return {
    ...dates,
    currency,
    scope,
    preparing,
    period: {
      start: period.start, end: period.end, days: period.days,
      day: Math.min(period.days, Math.floor(elapsed) + 1),
      days_left: Number((period.days - elapsed).toFixed(1))
    },
    ...(preparing
      ? { so_far: null, rest: null, forecast: null, per_day: [], accuracy: null, previous: null,
          machines: figures.machines, history: figures.history }
      : figures),
    updated_at: new Date(now).toISOString()
  };
};
