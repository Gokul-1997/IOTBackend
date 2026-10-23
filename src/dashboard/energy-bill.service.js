/*
 * The electricity (EB) bill — kept as printed, per service connection, and
 * forecast the way it is worked out (Energy Dashboard, "This Bill").
 *
 *   connections   listConnections / saveConnection / deleteConnection
 *   bills         saveBill / deleteBill — every charge as on the bill
 *   readings      saveReading / deleteReading — the EB meter's kWh register
 *   forecast      getBill
 *
 * A factory can have several supplies (S AND T: SC 1212 and SC 2309), each
 * with its own reading dates and charges, so each is forecast on its own
 * and the total is their sum. The bill is the whole company's: only someone
 * with the Energy "Tariff Settings" permission and the whole company in view
 * may change it, and only the whole company sees it.
 *
 * The arithmetic is energy-forecast.js: this bill's units (EB meter readings,
 * else a meter on the supply, else the last bills' units per day) at the
 * charges of the latest bill.
 */
const pool = require('../db');
const { current } = require('../lib/read-scope');
const hourly = require('./energy-hourly.service');
const fc = require('./energy-forecast');

const httpError = (message, status) => Object.assign(new Error(message), { status });

function parseId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

/** A rupee or unit figure as typed: a number, never text; `negative` for adjustments. */
function amount(v, label, { required = false, negative = false, max = 1e10 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw httpError(`Enter the ${label}`, 400);
    return null;
  }
  const n = typeof v === 'number' ? v : (/^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : NaN);
  if (!Number.isFinite(n) || Math.abs(n) > max || (!negative && n < 0)) {
    throw httpError(`The ${label} must be a number${negative ? '' : ' of 0 or more'}`, 400);
  }
  return Math.round(n * 100) / 100;
}

/** Today in plant time (IST). */
const today = (now = Date.now()) => fc.istDay(now);

/** The bill is the whole company's: not for someone who sees one plant. */
function companyWide(action) {
  if (current()?.plantId != null) throw httpError(`The electricity bill is the whole company's: ${action} needs company administration`, 403);
}

const BILL_COLUMNS = `id, connection_id, to_char(period_from, 'YYYY-MM-DD') AS "from", to_char(period_to, 'YYYY-MM-DD') AS "to",
  units, rate, electricity_charges, peak_charges, fixed_charges, penalty_charges, welding_charges,
  tax_charges, other_charges, net_amount`;

const toBill = r => ({
  id: r.id, connection_id: r.connection_id, from: r.from, to: r.to,
  days: fc.daysBetween(r.from, r.to),
  units: Number(r.units), rate: r.rate === null ? null : Number(r.rate),
  electricity_charges: Number(r.electricity_charges), peak_charges: Number(r.peak_charges),
  fixed_charges: Number(r.fixed_charges), penalty_charges: Number(r.penalty_charges),
  welding_charges: Number(r.welding_charges), tax_charges: Number(r.tax_charges),
  other_charges: Number(r.other_charges), net_amount: Number(r.net_amount)
});

/** Everything about the company's supplies: each with its bills (newest first) and recent readings. */
async function loadConnections(companyId, { readingsSince } = {}) {
  const [conns, bills, readings] = await Promise.all([
    pool.query(
      `SELECT c.id, c.sc_number, c.name, c.meter_machine_id, m.machine_serial_no AS meter_machine
         FROM energy_connections c
         LEFT JOIN machines m ON m.id = c.meter_machine_id AND m.company_id = c.company_id
        WHERE c.company_id = $1
        ORDER BY c.sc_number`, [companyId]),
    pool.query(`SELECT ${BILL_COLUMNS} FROM energy_bills WHERE company_id = $1 ORDER BY period_to DESC`, [companyId]),
    pool.query(
      `SELECT id, connection_id, to_char(read_on, 'YYYY-MM-DD') AS read_on, kwh
         FROM energy_readings
        WHERE company_id = $1 AND read_on >= $2::date
        ORDER BY read_on`, [companyId, readingsSince || fc.addDays(today(), -150)])
  ]);
  return conns.rows.map(c => ({
    id: c.id, sc_number: c.sc_number, name: c.name,
    meter: c.meter_machine_id ? { machine_id: c.meter_machine_id, machine: c.meter_machine } : null,
    bills: bills.rows.filter(b => b.connection_id === c.id).map(toBill),
    readings: readings.rows.filter(r => r.connection_id === c.id)
      .map(r => ({ id: r.id, read_on: r.read_on, kwh: Number(r.kwh) }))
  }));
}

/** The bill this connection is on now, from its latest bill. */
function periodOf(conn, day) {
  const latest = conn.bills[0];
  if (!latest) return null;
  return fc.currentPeriod(latest, day);
}

/** For Tariff & Rates: the supplies, their bills, readings, and the bill each is on now. */
exports.listConnections = async (companyId, { now = Date.now() } = {}) => {
  companyWide('seeing it');
  const day = today(now);
  return (await loadConnections(companyId)).map(c => {
    const period = periodOf(c, day);
    return {
      ...c,
      readings: [...c.readings].reverse(),                    // newest first on the page
      current: period && { start: period.start, end: period.end, days: period.days },
      cycle: period ? fc.cycleText(period.months) : null
    };
  });
};

async function ownConnection(companyId, id) {
  const connectionId = parseId(id, 'connection');
  const { rows } = await pool.query(
    'SELECT id FROM energy_connections WHERE id = $1 AND company_id = $2', [connectionId, companyId]);
  if (!rows.length) throw httpError('Service connection not found', 404);
  return connectionId;
}

exports.saveConnection = async ({ company_id, id, sc_number, name, meter_machine_id, user_id }) => {
  companyWide('changing it');
  const number = String(sc_number ?? '').trim();
  if (!number) throw httpError('Enter the service connection number, as on the bill', 400);
  if (number.length > 40) throw httpError('The service connection number is at most 40 characters', 400);
  const label = String(name ?? '').trim();
  if (label.length > 80) throw httpError('The name is at most 80 characters', 400);
  const meter = parseId(meter_machine_id, 'meter machine');
  if (meter) {
    const { rows } = await pool.query('SELECT 1 FROM machines WHERE id = $1 AND company_id = $2', [meter, company_id]);
    if (!rows.length) throw httpError('That machine is not in your company', 400);
  }
  try {
    if (id !== undefined && id !== null) {
      const connectionId = await ownConnection(company_id, id);
      await pool.query(
        `UPDATE energy_connections SET sc_number = $3, name = $4, meter_machine_id = $5, updated_at = NOW()
          WHERE id = $1 AND company_id = $2`, [connectionId, company_id, number, label || null, meter]);
      return { id: connectionId };
    }
    const { rows } = await pool.query(
      `INSERT INTO energy_connections (company_id, sc_number, name, meter_machine_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [company_id, number, label || null, meter, user_id ?? null]);
    return { id: rows[0].id };
  } catch (err) {
    if (err.code === '23505') throw httpError(`Service connection ${number} is already added`, 409);
    throw err;
  }
};

exports.deleteConnection = async ({ company_id, id }) => {
  companyWide('changing it');
  const connectionId = await ownConnection(company_id, id);
  await pool.query('DELETE FROM energy_connections WHERE id = $1 AND company_id = $2', [connectionId, company_id]);
  return { id: connectionId };
};

/**
 * A bill as printed. Electricity charges default to units × rate and the
 * net to the sum of the charges; what was typed is kept. The answer says
 * how far the typed figures are from those sums, so a typing slip shows.
 */
exports.saveBill = async ({ company_id, connection_id, id, body = {}, user_id }) => {
  companyWide('changing it');
  const connectionId = await ownConnection(company_id, connection_id);
  const billId = parseId(id, 'bill');
  const from = fc.parseDay(body.from), to = fc.parseDay(body.to);
  if (!from || !to) throw httpError('Enter the billing period From and To dates (YYYY-MM-DD), as on the bill', 400);
  if (to <= from) throw httpError('The To date must be after the From date', 400);
  if (fc.daysBetween(from, to) > 93) throw httpError('A bill covers at most 3 months: check the dates', 400);
  if (to > today()) throw httpError('A bill\'s To date cannot be in the future', 400);

  const units = amount(body.units, 'units', { required: true, max: 1e9 });
  if (units <= 0) throw httpError('The units must be more than 0', 400);
  const rate = amount(body.rate, 'rate per unit', { max: 1000 });
  const electricity = amount(body.electricity_charges, 'electricity charges')
    ?? (rate !== null ? Math.round(units * rate) : null);
  if (electricity === null) throw httpError('Enter the electricity charges, or the rate per unit', 400);
  const line = k => amount(body[k], k.replace('_', ' ')) ?? 0;
  const peak = line('peak_charges'), fixed = line('fixed_charges'), penalty = line('penalty_charges');
  const welding = line('welding_charges'), tax = line('tax_charges');
  const other = amount(body.other_charges, 'other charges', { negative: true }) ?? 0;
  const sum = electricity + peak + fixed + penalty + welding + tax + other;
  const net = amount(body.net_amount, 'net bill') ?? Math.round(sum * 100) / 100;

  const { rows: clash } = await pool.query(
    `SELECT to_char(period_from, 'DD Mon YYYY') AS f, to_char(period_to, 'DD Mon YYYY') AS t FROM energy_bills
      WHERE connection_id = $1 AND company_id = $2 AND id <> $3 AND period_from < $5::date AND period_to > $4::date LIMIT 1`,
    [connectionId, company_id, billId ?? 0, from, to]);
  if (clash.length) throw httpError(`These dates overlap the bill of ${clash[0].f} – ${clash[0].t}`, 409);

  const values = [connectionId, company_id, from, to, units, rate, electricity, peak, fixed, penalty, welding, tax, other, net];
  let saved;
  if (billId) {
    const { rows } = await pool.query(
      `UPDATE energy_bills SET period_from = $3, period_to = $4, units = $5, rate = $6, electricity_charges = $7,
              peak_charges = $8, fixed_charges = $9, penalty_charges = $10, welding_charges = $11, tax_charges = $12,
              other_charges = $13, net_amount = $14, updated_at = NOW()
        WHERE id = $15 AND connection_id = $1 AND company_id = $2
       RETURNING ${BILL_COLUMNS}`, [...values, billId]);
    if (!rows.length) throw httpError('Bill not found', 404);
    saved = rows[0];
  } else {
    const { rows } = await pool.query(
      `INSERT INTO energy_bills (connection_id, company_id, period_from, period_to, units, rate, electricity_charges,
              peak_charges, fixed_charges, penalty_charges, welding_charges, tax_charges, other_charges, net_amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${BILL_COLUMNS}`, [...values, user_id ?? null]);
    saved = rows[0];
  }
  return {
    bill: toBill(saved),
    checks: {
      // the printed rate is often rounded: how far units × rate is from the electricity charges
      rate_difference: rate === null ? null : Math.round((electricity - units * rate) * 100) / 100,
      // a slip in one of the charges shows here
      net_difference: Math.round((net - sum) * 100) / 100
    }
  };
};

exports.deleteBill = async ({ company_id, connection_id, id }) => {
  companyWide('changing it');
  const connectionId = await ownConnection(company_id, connection_id);
  const billId = parseId(id, 'bill');
  const { rowCount } = await pool.query(
    'DELETE FROM energy_bills WHERE id = $1 AND connection_id = $2 AND company_id = $3', [billId, connectionId, company_id]);
  if (!rowCount) throw httpError('Bill not found', 404);
  return { id: billId };
};

/** The EB meter's kWh register on a day. Readings only climb: one out of order is a typing slip. */
exports.saveReading = async ({ company_id, connection_id, body = {}, user_id }) => {
  companyWide('changing it');
  const connectionId = await ownConnection(company_id, connection_id);
  const day = fc.parseDay(body.read_on);
  if (!day) throw httpError('Enter the reading date (YYYY-MM-DD)', 400);
  if (day > today()) throw httpError('A reading cannot be dated in the future', 400);
  const kwh = amount(body.kwh, 'reading', { required: true, max: 1e12 });

  const { rows: around } = await pool.query(
    `(SELECT to_char(read_on, 'DD Mon YYYY') AS d, kwh, 'before' AS side FROM energy_readings
       WHERE connection_id = $1 AND company_id = $2 AND read_on < $3::date ORDER BY read_on DESC LIMIT 1)
     UNION ALL
     (SELECT to_char(read_on, 'DD Mon YYYY') AS d, kwh, 'after' FROM energy_readings
       WHERE connection_id = $1 AND company_id = $2 AND read_on > $3::date ORDER BY read_on LIMIT 1)`,
    [connectionId, company_id, day]);
  for (const r of around) {
    if (r.side === 'before' && kwh < Number(r.kwh)) throw httpError(`The reading on ${r.d} was ${Number(r.kwh)}: this one cannot be lower`, 400);
    if (r.side === 'after' && kwh > Number(r.kwh)) throw httpError(`The reading on ${r.d} was ${Number(r.kwh)}: this one cannot be higher`, 400);
  }
  const { rows } = await pool.query(
    `INSERT INTO energy_readings (company_id, connection_id, read_on, kwh, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (connection_id, read_on) DO UPDATE SET kwh = EXCLUDED.kwh, created_by = EXCLUDED.created_by
     RETURNING id, to_char(read_on, 'YYYY-MM-DD') AS read_on, kwh`,
    [company_id, connectionId, day, kwh, user_id ?? null]);
  return { id: rows[0].id, read_on: rows[0].read_on, kwh: Number(rows[0].kwh) };
};

exports.deleteReading = async ({ company_id, connection_id, id }) => {
  companyWide('changing it');
  const connectionId = await ownConnection(company_id, connection_id);
  const readingId = parseId(id, 'reading');
  const { rowCount } = await pool.query(
    'DELETE FROM energy_readings WHERE id = $1 AND connection_id = $2 AND company_id = $3', [readingId, connectionId, company_id]);
  if (!rowCount) throw httpError('Reading not found', 404);
  return { id: readingId };
};

/* ── the forecast ── */

/** Units from the meter on the supply, hour by hour; null when it has nothing for this bill. */
async function unitsFromMeter(companyId, conn, period, now) {
  const needFrom = Math.min(fc.istMidnight(period.start), fc.istHour(now) - 35 * fc.DAY_MS);
  const { rows, completeFrom } = await hourly.hours(companyId, needFrom, now);
  if (completeFrom > needFrom) hourly.kick(companyId);
  if (completeFrom > fc.istMidnight(period.start)) return null;          // its hours for this bill not all worked out yet
  const series = new Map();
  for (const r of rows) {
    if (r.machine_id !== conn.meter.machine_id) continue;
    series.set(r.hour, (series.get(r.hour) || 0) + r.kwh);
  }
  if (!series.size) return null;
  const f = fc.forecastBill({
    series: new Map([[conn.meter.machine_id, series]]), machines: [conn.meter.machine_id], rates: new Map(),
    period: { start: period.start, end: period.end }, previous: null, now, historyFrom: completeFrom
  });
  if (!f.forecast) return null;
  return {
    so_far: f.so_far.kwh, as_of: null, rest: f.rest.kwh, measured: true,
    low_total: f.forecast.low_kwh, high_total: f.forecast.high_kwh,
    per_day: null, accuracy: f.accuracy
  };
}

const round = (v, dp = 0) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

async function forecastConnection(companyId, conn, now) {
  const base = { id: conn.id, sc_number: conn.sc_number, name: conn.name, meter: conn.meter };
  const latest = conn.bills[0];
  if (!latest) return { ...base, status: 'no_bill' };
  const day = today(now);
  const period = fc.currentPeriod(latest, day);
  const tariff = fc.tariffOf(latest);

  let source = 'readings';
  let units = fc.unitsFromReadings(conn.readings, period, day);
  if (!units && conn.meter) { source = 'meter'; units = await unitsFromMeter(companyId, conn, period, now); }
  if (!units) { source = 'bills'; units = fc.unitsFromBills(conn.bills, period, now); }

  const total = units.so_far + units.rest;
  const forecast = fc.chargesFor(total, tariff);
  const lowUnits = units.low_total ?? (units.low_per_day != null ? units.so_far + units.rest * units.low_per_day / units.per_day : null);
  const highUnits = units.high_total ?? (units.high_per_day != null ? units.so_far + units.rest * units.high_per_day / units.per_day : null);
  const range = lowUnits != null && highUnits != null
    ? { low: fc.chargesFor(Math.min(lowUnits, total), tariff).net_amount, high: fc.chargesFor(Math.max(highUnits, total), tariff).net_amount }
    : null;

  const gone = Math.min(period.days, Math.max(0, (now - fc.istMidnight(period.start)) / fc.DAY_MS));
  return {
    ...base,
    status: 'ok',
    period: {
      start: period.start, end: period.end, days: period.days,
      day: Math.min(period.days, Math.floor(gone) + 1), days_left: round(period.days - gone, 1)
    },
    cycle: fc.cycleText(period.months),
    source,
    units: {
      so_far: round(units.so_far), as_of: units.as_of ?? null, rest: round(units.rest), total: round(total),
      per_day: round(units.per_day, 1), measured: units.measured, bills: units.bills ?? null
    },
    forecast,
    range,
    accuracy: units.accuracy ?? null,
    tariff: {
      rate: round(tariff.rate, 4), printed_rate: tariff.printed_rate, fixed_charges: tariff.fixed,
      peak_pct: round(tariff.peak_share * 100, 2), penalty_pct: round(tariff.penalty_share * 100, 2),
      welding_pct: round(tariff.welding_share * 100, 2), tax_pct: round(tariff.tax_share * 100, 2)
    },
    last_bill: latest,
    change_pct: latest.net_amount > 0 ? round(((forecast.net_amount - latest.net_amount) / latest.net_amount) * 100, 1) : null
  };
}

/**
 * This bill for every supply, and their total. Only for the whole company:
 * someone who sees one plant gets `restricted`.
 */
exports.getBill = async (q = {}, { now = Date.now() } = {}) => {
  if (current()?.plantId != null) return { configured: false, restricted: true, connections: [], total: null, currency: 'INR' };
  const companyId = q.company_id;
  const conns = await loadConnections(companyId, { readingsSince: fc.addDays(today(now), -120) });
  const connections = [];
  for (const c of conns) connections.push(await forecastConnection(companyId, c, now));
  const ready = connections.filter(c => c.status === 'ok');
  const sum = k => ready.reduce((n, c) => n + (k(c) ?? 0), 0);
  const allRanges = ready.length && ready.every(c => c.range);
  return {
    configured: ready.length > 0,
    restricted: false,
    currency: 'INR',
    connections,
    total: ready.length ? {
      units: sum(c => c.units.total),
      net_amount: sum(c => c.forecast.net_amount),
      low: allRanges ? sum(c => c.range.low) : null,
      high: allRanges ? sum(c => c.range.high) : null,
      last_net: sum(c => c.last_bill.net_amount),
      ends: ready.map(c => c.period.end).sort().at(-1),
      measured: ready.every(c => c.units.measured)
    } : null,
    updated_at: new Date(now).toISOString()
  };
};
