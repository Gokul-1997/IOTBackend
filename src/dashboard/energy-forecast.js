/*
 * The electricity bill forecast's arithmetic — pure functions, no database,
 * so every step is tested on its own (energy-bill.service.js feeds them).
 *
 * ── The bill period ─────────────────────────────────────────────────────
 *
 * An EB bill prints two reading dates: From (the reading the last bill ended
 * on) and To (this bill's reading). The next bill starts on this one's To, so
 * a period is [From, To): From counted, To not — 26 Jul – 26 Aug is 31 days.
 * After the latest bill entered, bills follow every month (two or three for
 * bills that long) on the day of the month of its To date. Reading dates move
 * a day either way (26 Jul – 27 Aug), so one bill's exact length is never
 * repeated.
 *
 * ── The bill ────────────────────────────────────────────────────────────
 *
 * Worked out the way the bill itself is (a Tamil Nadu EB bill adds up as):
 *
 *   electricity charges = units × the rate the last bill really charged
 *                         (its electricity charges ÷ its units: the printed
 *                         rate is rounded — 8.13 billed 8.13363 on SC 1212)
 *   peak hour, ED/LPF penalty, welding surcharge, E tax & TCS
 *                       = the same share of the electricity charges as on
 *                         the last bill (welding was exactly 15 %)
 *   fixed charges       = as on the last bill
 *   net                 = all of them added
 *
 * ── The units ───────────────────────────────────────────────────────────
 *
 * Best first: EB meter readings entered (exact so far, the rest at the last
 * week's rate); a meter on the supply (hour by hour, below); else the last
 * bills' units per day — an estimate, and said to be one.
 *
 * A meter's coming use is per hour of the week (Monday 09:00 is not Sunday
 * 09:00): the median of the same hour over the last four weeks, so one odd
 * week — a holiday, a breakdown, a meter offline and then catching up — does
 * not move it. Its likely range repeats each of those weeks as it really was.
 *
 * Every time here is epoch ms; hours start on IST hours; days are IST dates.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_HOURS = 168;
const IST_OFFSET_MS = 330 * 60_000;
/** Weeks of history the usual use is taken from. */
const PROFILE_WEEKS = 4;
/** Less history than this and a machine's coming use is not guessed at. */
const MIN_HISTORY_MS = DAY_MS;
/** With less than a week, every day is taken as alike (no weekday pattern yet). */
const WEEK_MS = WEEK_HOURS * HOUR_MS;

const istHour = ms => Math.floor((ms + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS;
const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMidnight = day => Date.parse(`${day}T00:00:00+05:30`);
/** 0 = Monday 00:00 IST … 167 = Sunday 23:00 IST. */
const hourOfWeek = ms => { const d = new Date(ms + IST_OFFSET_MS); return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours(); };
const hourOfDay = ms => new Date(ms + IST_OFFSET_MS).getUTCHours();

/* ── dates (YYYY-MM-DD, calendar arithmetic only) ── */

const utc = day => new Date(`${day}T00:00:00Z`);
const ymd = d => d.toISOString().slice(0, 10);

/** A real calendar date in YYYY-MM-DD form, or null. */
function parseDay(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = utc(s);
  return Number.isNaN(d.getTime()) || ymd(d) !== s ? null : s;
}

function addDays(day, n) {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** b − a, in days. */
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS);

/** Day `dom` of the month `month` (0-based, may run past 11) of `year`, or that month's last day. */
function monthDay(year, month, dom) {
  const first = new Date(Date.UTC(year, month, 1));
  const lastDom = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(dom, lastDom))));
}

/** Every how many months a bill comes, from one bill's reading dates: 1, 2 or 3. */
function monthsOf(from, to) {
  return Math.min(3, Math.max(1, Math.round(daysBetween(from, to) / 30.44)));
}

/** The k-th reading date after `to` (k months × n), on its day of the month or that month's last day. */
function readingDate(to, months, k) {
  const t = utc(to);
  return monthDay(t.getUTCFullYear(), t.getUTCMonth() + k * months, t.getUTCDate());
}

/**
 * The bill `day` falls in, after the latest bill entered (`{ from, to }`):
 * { start, end, days, months } — end is its reading date, not counted. A day
 * before that bill's To falls in that bill itself.
 */
function currentPeriod(latest, day) {
  if (day < latest.to) return { start: latest.from, end: latest.to, days: daysBetween(latest.from, latest.to), months: monthsOf(latest.from, latest.to), billed: true };
  const months = monthsOf(latest.from, latest.to);
  const t = utc(latest.to), d = utc(day);
  let k = Math.max(0, Math.floor(((d.getUTCFullYear() - t.getUTCFullYear()) * 12 + d.getUTCMonth() - t.getUTCMonth()) / months));
  for (let i = 0; i < 4 && k > 0 && readingDate(latest.to, months, k) > day; i++) k--;
  for (let i = 0; i < 4 && readingDate(latest.to, months, k + 1) <= day; i++) k++;
  const start = readingDate(latest.to, months, k);
  const end = readingDate(latest.to, months, k + 1);
  return { start, end, days: daysBetween(start, end), months, billed: false };
}

/** "Every month", "Every 2 months". */
const cycleText = months => (months === 1 ? 'Every month' : `Every ${months} months`);

/* ── the bill, as the EB works it out ── */

const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v));

/**
 * What a bill charges, taken from the bill itself: the rate it really
 * charged, each charge that grows with the units as a share of the
 * electricity charges, and its fixed charges. Other charges (arrears, a
 * one-off adjustment) are not carried forward.
 */
function tariffOf(bill) {
  const units = num(bill.units), ec = num(bill.electricity_charges);
  const share = v => (ec > 0 ? num(v) / ec : 0);
  return {
    rate: units > 0 && ec > 0 ? ec / units : num(bill.rate),
    printed_rate: bill.rate === null || bill.rate === undefined || bill.rate === '' ? null : Number(bill.rate),
    peak_share: share(bill.peak_charges),
    penalty_share: share(bill.penalty_charges),
    welding_share: share(bill.welding_charges),
    tax_share: share(bill.tax_charges),
    fixed: num(bill.fixed_charges)
  };
}

/** The bill for `units` at `tariff`, every line rounded to the rupee as the EB prints it. */
function chargesFor(units, tariff) {
  const rupees = v => Math.round(v);
  const electricity = units * tariff.rate;
  const lines = {
    units: Math.round(units),
    electricity_charges: rupees(electricity),
    peak_charges: rupees(electricity * tariff.peak_share),
    fixed_charges: rupees(tariff.fixed),
    penalty_charges: rupees(electricity * tariff.penalty_share),
    welding_charges: rupees(electricity * tariff.welding_share),
    tax_charges: rupees(electricity * tariff.tax_share)
  };
  lines.net_amount = lines.electricity_charges + lines.peak_charges + lines.fixed_charges
    + lines.penalty_charges + lines.welding_charges + lines.tax_charges;
  return lines;
}

/* ── the units ── */

/**
 * The register at the start of the period: the reading on that day, or
 * between the readings either side of it (each within a week).
 */
function registerAt(readings, day) {
  const exact = readings.find(r => r.read_on === day);
  if (exact) return Number(exact.kwh);
  const before = [...readings].reverse().find(r => r.read_on < day && daysBetween(r.read_on, day) <= 7);
  const after = readings.find(r => r.read_on > day && daysBetween(day, r.read_on) <= 7);
  if (!before || !after) return null;
  const span = daysBetween(before.read_on, after.read_on);
  return Number(before.kwh) + (Number(after.kwh) - Number(before.kwh)) * daysBetween(before.read_on, day) / span;
}

/**
 * Units from EB meter readings (date, kWh register — taken at about the time
 * the EB reads it): so far = the latest reading in the period − the register
 * at its start; the rest at the rate of the last week of readings (or of the
 * period so far). Null when the readings cannot say.
 */
function unitsFromReadings(readings, period, today) {
  const list = [...readings].map(r => ({ read_on: r.read_on, kwh: Number(r.kwh) }))
    .sort((a, b) => (a.read_on < b.read_on ? -1 : 1));
  const start = registerAt(list, period.start);
  if (start === null) return null;
  const inside = list.filter(r => r.read_on > period.start && r.read_on <= period.end && r.read_on <= today);
  const last = inside.at(-1);
  if (!last || last.kwh < start) return null;
  const soFar = last.kwh - start;
  const done = daysBetween(period.start, last.read_on);
  const weekBack = [...list].reverse().find(r => r.read_on <= addDays(last.read_on, -7) && r.read_on >= addDays(last.read_on, -21));
  const perDay = weekBack && last.kwh >= weekBack.kwh
    ? (last.kwh - weekBack.kwh) / daysBetween(weekBack.read_on, last.read_on)
    : soFar / done;
  const left = Math.max(0, daysBetween(last.read_on, period.end));
  return { so_far: soFar, as_of: last.read_on, rest: perDay * left, per_day: perDay, measured: true };
}

/**
 * Units from the last bills (up to three): their units per day, for the days
 * of this period gone and to come. An estimate; its range is the lowest and
 * highest units per day among those bills.
 */
function unitsFromBills(bills, period, now) {
  const recent = bills.filter(b => num(b.units) > 0 && daysBetween(b.from, b.to) > 0).slice(0, 3);
  if (!recent.length) return null;
  const perBill = recent.map(b => num(b.units) / daysBetween(b.from, b.to));
  const perDay = recent.reduce((n, b) => n + num(b.units), 0) / recent.reduce((n, b) => n + daysBetween(b.from, b.to), 0);
  const gone = Math.min(period.days, Math.max(0, (now - istMidnight(period.start)) / DAY_MS));
  return {
    so_far: perDay * gone, as_of: null, rest: perDay * (period.days - gone), per_day: perDay, measured: false,
    low_per_day: recent.length > 1 ? Math.min(...perBill) : null,
    high_per_day: recent.length > 1 ? Math.max(...perBill) : null,
    bills: recent.length
  };
}

/* ── usual use ── */

function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * One machine's usual kWh in each hour of the week, from its hours in
 * [fromMs, toMs) — at most the PROFILE_WEEKS weeks before toMs. `series`
 * maps an hour's start to its kWh; an hour with no entry used nothing.
 * With under a week of history the hours of the day stand in for the
 * hours of the week. Null with under a day of history.
 */
function usualUse(series, fromMs, toMs) {
  const start = Math.max(istHour(fromMs), toMs - PROFILE_WEEKS * WEEK_MS);
  if (toMs - start < MIN_HISTORY_MS) return null;
  const byWeek = toMs - start >= WEEK_MS;
  const samples = Array.from({ length: byWeek ? WEEK_HOURS : 24 }, () => []);
  for (let h = start; h < toMs; h += HOUR_MS) samples[byWeek ? hourOfWeek(h) : hourOfDay(h)].push(series.get(h) || 0);
  const slots = samples.map(median);
  return {
    at: h => slots[byWeek ? hourOfWeek(h) : hourOfDay(h)],
    weeks: Math.min(PROFILE_WEEKS, Math.floor((toMs - start) / WEEK_MS)),
    from: start
  };
}

/**
 * Each of the last whole weeks before toMs as it really was, for the likely
 * range; weeks before fromMs are left out.
 */
function pastWeeks(series, fromMs, toMs) {
  const weeks = [];
  for (let w = 1; w <= PROFILE_WEEKS; w++) {
    const weekStart = toMs - w * WEEK_MS;
    if (weekStart < istHour(fromMs)) break;
    weeks.push(h => series.get(weekStart + ((h - weekStart) % WEEK_MS + WEEK_MS) % WEEK_MS) || 0);
  }
  return weeks;
}

/* ── the forecast ── */

const round = (v, dp = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

/**
 * The bill's figures.
 *
 * @param {object}   p
 * @param {Map<number, Map<number, number>>} p.series  machine → IST hour start → kWh, whole from p.historyFrom
 * @param {number[]} p.machines                        the machines in scope
 * @param {Map<number, number|null>} p.rates           ₹ per kWh by machine (null: no tariff)
 * @param {{start:string,end:string}} p.period          this bill
 * @param {{start:string,end:string}|null} p.previous   the bill before it
 * @param {number}   p.now
 * @param {number}   p.historyFrom                      the first hour the series is whole from
 */
function forecastBill(p) {
  const now = p.now;
  const h0 = istHour(now);
  const left = 1 - (now - h0) / HOUR_MS;                 // what remains of the current hour
  const startMs = istMidnight(p.period.start);
  const endMs = istMidnight(p.period.end);                // the reading date: not counted
  const days = [];
  for (let d = p.period.start; d < p.period.end; d = addDays(d, 1)) days.push(d);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const rateOf = m => (p.rates.has(m) ? p.rates.get(m) : null);
  const priced = p.machines.some(m => rateOf(m) != null);

  // per day of the bill: what was used, and what is expected (kWh and ₹)
  const actualKwh = days.map(() => 0), actualCost = days.map(() => 0);
  const expectKwh = days.map(() => 0), expectCost = days.map(() => 0);
  let weeksUsed = 0;
  const scenarioCost = [], scenarioKwh = [];           // per past week: [per day]
  let metered = 0, forecastable = 0, tooNew = 0, unpriced = 0;

  for (const m of p.machines) {
    const series = p.series.get(m);
    if (!series || !series.size) continue;
    metered++;
    const rate = rateOf(m);
    if (rate == null) unpriced++;

    // what the meter counted in this bill so far
    for (const [h, kwh] of series) {
      if (h < startMs || h > h0 || h >= endMs) continue;
      const i = dayIndex.get(istDay(h));
      actualKwh[i] += kwh;
      if (rate != null) actualCost[i] += kwh * rate;
    }

    // its own history starts at its first reading, if that is later than the series
    let first = Infinity;
    for (const h of series.keys()) if (h >= p.historyFrom && h < first) first = h;
    const usual = usualUse(series, Math.max(p.historyFrom, first), h0);
    if (!usual) { tooNew++; continue; }
    forecastable++;
    weeksUsed = Math.max(weeksUsed, usual.weeks);
    const weeks = pastWeeks(series, usual.from, h0);

    for (let h = Math.max(h0, startMs); h < endMs; h += HOUR_MS) {
      const share = h === h0 ? left : 1;
      const i = dayIndex.get(istDay(h));
      const kwh = usual.at(h) * share;
      expectKwh[i] += kwh;
      if (rate != null) expectCost[i] += kwh * rate;
      weeks.forEach((week, w) => {
        scenarioKwh[w] ??= days.map(() => 0);
        scenarioCost[w] ??= days.map(() => 0);
        const k = week(h) * share;
        scenarioKwh[w][i] += k;
        if (rate != null) scenarioCost[w][i] += k * rate;
      });
      // a machine with fewer past weeks than another: its usual use stands in for the missing ones
      for (let w = weeks.length; w < PROFILE_WEEKS; w++) {
        scenarioKwh[w] ??= days.map(() => 0);
        scenarioCost[w] ??= days.map(() => 0);
        scenarioKwh[w][i] += kwh;
        if (rate != null) scenarioCost[w][i] += kwh * rate;
      }
    }
  }

  const sum = a => a.reduce((n, v) => n + v, 0);
  const soFarKwh = sum(actualKwh), soFarCost = sum(actualCost);
  const restKwh = sum(expectKwh), restCost = sum(expectCost);
  const canForecast = forecastable > 0;

  // the likely range: each past week repeated for the rest of the bill (only weeks some machine really had)
  const realWeeks = scenarioKwh.slice(0, Math.max(1, weeksUsed));
  const totalsKwh = realWeeks.map(s => soFarKwh + sum(s));
  const totalsCost = scenarioCost.slice(0, Math.max(1, weeksUsed)).map(s => soFarCost + sum(s));
  const forecastKwh = soFarKwh + restKwh, forecastCost = soFarCost + restCost;
  const lowKwh = Math.min(forecastKwh, ...totalsKwh), highKwh = Math.max(forecastKwh, ...totalsKwh);
  const lowCost = Math.min(forecastCost, ...totalsCost), highCost = Math.max(forecastCost, ...totalsCost);

  // running totals for the chart: so far, then the forecast and its range
  const today = istDay(now);
  let cumA = 0, cumAC = 0, cumF = 0, cumFC = 0;
  const cumLo = realWeeks.map(() => 0), cumLoC = realWeeks.map(() => 0);
  const perDay = days.map((day, i) => {
    cumA += actualKwh[i]; cumAC += actualCost[i];
    cumF += actualKwh[i] + expectKwh[i]; cumFC += actualCost[i] + expectCost[i];
    realWeeks.forEach((s, w) => { cumLo[w] += actualKwh[i] + (s?.[i] || 0); cumLoC[w] += actualCost[i] + (scenarioCost[w]?.[i] || 0); });
    const past = day < today, isToday = day === today;
    return {
      day,
      kind: past ? 'past' : isToday ? 'today' : 'coming',
      used_kwh: past || isToday ? round(actualKwh[i], 3) : null,
      used_cost: priced && (past || isToday) ? round(actualCost[i]) : null,
      expected_kwh: canForecast && !past ? round(expectKwh[i], 3) : null,
      expected_cost: priced && canForecast && !past ? round(expectCost[i]) : null,
      to_date_kwh: past || isToday ? round(cumA, 3) : null,
      to_date_cost: priced && (past || isToday) ? round(cumAC) : null,
      forecast_kwh: canForecast && !past ? round(cumF, 3) : null,
      forecast_cost: priced && canForecast && !past ? round(cumFC) : null,
      low_cost: priced && canForecast && !past ? round(Math.min(cumFC, ...cumLoC)) : null,
      high_cost: priced && canForecast && !past ? round(Math.max(cumFC, ...cumLoC)) : null,
      low_kwh: canForecast && !past ? round(Math.min(cumF, ...cumLo), 3) : null,
      high_kwh: canForecast && !past ? round(Math.max(cumF, ...cumLo), 3) : null
    };
  });

  return {
    so_far: { kwh: round(soFarKwh, 3), cost: priced ? round(soFarCost) : null },
    rest: canForecast ? { kwh: round(restKwh, 3), cost: priced ? round(restCost) : null } : null,
    forecast: canForecast ? {
      kwh: round(forecastKwh, 3), cost: priced ? round(forecastCost) : null,
      low_kwh: round(lowKwh, 3), high_kwh: round(highKwh, 3),
      low_cost: priced ? round(lowCost) : null, high_cost: priced ? round(highCost) : null
    } : null,
    per_day: perDay,
    machines: { in_scope: p.machines.length, metered, forecast: forecastable, too_new: tooNew, unpriced },
    history: { from: istDay(p.historyFrom), weeks: weeksUsed },
    accuracy: canForecast ? accuracyOf(p.series, p.machines, p.historyFrom, h0) : null,
    previous: previousBill(p, rateOf, priced)
  };
}

/**
 * How well the method does on this factory: the last 7 days forecast from
 * the weeks before them (at least one), against what the meters counted.
 */
function accuracyOf(seriesByMachine, machines, historyFrom, h0) {
  const cut = h0 - WEEK_MS;
  let forecast = 0, actual = 0, used = 0;
  for (const m of machines) {
    const series = seriesByMachine.get(m);
    if (!series || !series.size) continue;
    let first = Infinity;
    for (const h of series.keys()) if (h >= historyFrom && h < first) first = h;
    const from = Math.max(historyFrom, first);
    if (cut - istHour(from) < WEEK_MS) continue;          // needs a whole week before the 7 days
    const usual = usualUse(series, from, cut);
    if (!usual) continue;
    used++;
    for (let h = cut; h < h0; h += HOUR_MS) {
      forecast += usual.at(h);
      actual += series.get(h) || 0;
    }
  }
  if (!used || actual <= 0) return null;
  return {
    from: istDay(cut), to: istDay(h0 - 1),
    forecast_kwh: round(forecast, 3), actual_kwh: round(actual, 3),
    error_pct: round(((forecast - actual) / actual) * 100, 1)
  };
}

/** The bill before this one, when the history covers all of it. */
function previousBill(p, rateOf, priced) {
  if (!p.previous) return null;
  const from = istMidnight(p.previous.start), to = istMidnight(p.previous.end);
  if (p.historyFrom > from) return null;
  let kwh = 0, cost = 0, first = Infinity;
  for (const m of p.machines) {
    const series = p.series.get(m);
    if (!series) continue;
    const rate = rateOf(m);
    for (const [h, v] of series) {
      if (h < first) first = h;
      if (h < from || h >= to) continue;
      kwh += v;
      if (rate != null) cost += v * rate;
    }
  }
  // the meters started during that bill: its total would be short, not low
  if (first === Infinity || first > from + DAY_MS) return null;
  return { start: p.previous.start, end: p.previous.end, kwh: round(kwh, 3), cost: priced ? round(cost) : null };
}

module.exports = {
  parseDay, addDays, daysBetween, monthsOf, currentPeriod, cycleText,
  tariffOf, chargesFor, registerAt, unitsFromReadings, unitsFromBills,
  median, usualUse, pastWeeks, forecastBill, accuracyOf,
  istHour, istDay, istMidnight, hourOfWeek,
  HOUR_MS, DAY_MS, WEEK_MS, PROFILE_WEEKS
};
