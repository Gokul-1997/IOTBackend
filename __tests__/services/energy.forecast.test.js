/*
 * The electricity bill forecast's arithmetic (dashboard/energy-forecast.js).
 *
 * The fixtures are a factory whose machines run a day shift, 08:00–20:00
 * IST, Monday to Saturday, and stand on Sunday and at night. Where every
 * week is alike the forecast must be exact — the bill is what the meters
 * counted plus that same pattern for the hours left — so the expected
 * figures are worked out here hour by hour, not copied from the code.
 */
const fc = require('../../src/dashboard/energy-forecast');

const H = fc.HOUR_MS;
const IST = 330 * 60_000;
const at = (day, hh = 0, mm = 0) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
const dow = ms => new Date(ms + IST).getUTCDay();          // 0 = Sunday
const hourOf = ms => new Date(ms + IST).getUTCHours();

/** 10 kWh an hour on the day shift, Monday to Saturday. */
const dayShift = (kw = 10) => h => (dow(h) !== 0 && hourOf(h) >= 8 && hourOf(h) < 20 ? kw : 0);

/** One machine's hours from `from` to `to` (the hour `to` is in, part used: `partial`). */
function seriesOf(from, to, use, { partial = 0.5, skip = () => false } = {}) {
  const s = new Map();
  for (let h = fc.istHour(from); h < fc.istHour(to); h += H) {
    if (skip(h)) continue;
    const v = use(h);
    if (v) s.set(h, v);
  }
  const last = fc.istHour(to);
  if (use(last) && !skip(last)) s.set(last, use(last) * partial);
  return s;
}

const sumHours = (from, to, use) => { let n = 0; for (let h = from; h < to; h += H) n += use(h); return n; };

const NOW = at('2026-10-23', 10, 30);                       // a Friday, half way through the 10:00 hour
const PERIOD = { start: '2026-10-12', end: '2026-11-11' };
const PREVIOUS = { start: '2026-09-12', end: '2026-10-11' };
const HISTORY = at('2026-09-01');

describe('the bill period follows on from the one entered', () => {
  const entered = { start: '2026-10-12', end: '2026-11-11' };

  test('a bill from the 12th to the 11th repeats every month, both ways', () => {
    expect(fc.billPeriod(entered, '2026-10-23')).toMatchObject({ start: '2026-10-12', end: '2026-11-11', days: 31 });
    expect(fc.billPeriod(entered, '2026-11-12')).toMatchObject({ start: '2026-11-12', end: '2026-12-11', days: 30 });
    expect(fc.billPeriod(entered, '2026-10-11')).toMatchObject({ start: '2026-09-12', end: '2026-10-11' });
    expect(fc.billPeriod(entered, '2026-10-23', -1)).toMatchObject({ start: '2026-09-12', end: '2026-10-11' });
    expect(fc.billPeriod(entered, '2026-10-23', 1)).toMatchObject({ start: '2026-11-12', end: '2026-12-11' });
    expect(fc.repeatsText(fc.billPeriod(entered, '2026-10-23').pattern)).toBe('Every month');
  });

  test('entered long ago, it still finds this month\'s bill', () => {
    expect(fc.billPeriod({ start: '2025-01-12', end: '2025-02-11' }, '2026-10-23'))
      .toMatchObject({ start: '2026-10-12', end: '2026-11-11' });
  });

  test('a reading on the 31st falls on the last day of shorter months', () => {
    const e = { start: '2026-01-31', end: '2026-02-27' };
    expect(fc.patternOf(e.start, e.end)).toEqual({ months: 1 });
    expect(fc.billPeriod(e, '2026-03-15')).toMatchObject({ start: '2026-02-28', end: '2026-03-30' });
    expect(fc.billPeriod(e, '2026-04-10')).toMatchObject({ start: '2026-03-31', end: '2026-04-29' });
  });

  test('calendar months, two-monthly bills, and a fixed number of days', () => {
    expect(fc.billPeriod({ start: '2026-10-01', end: '2026-10-31' }, '2026-12-25')).toMatchObject({ start: '2026-12-01', end: '2026-12-31' });
    const twoMonthly = { start: '2026-10-12', end: '2026-12-11' };
    expect(fc.billPeriod(twoMonthly, '2027-01-05')).toMatchObject({ start: '2026-12-12', end: '2027-02-11' });
    expect(fc.repeatsText(fc.patternOf(twoMonthly.start, twoMonthly.end))).toBe('Every 2 months');
    const thirty = { start: '2026-10-12', end: '2026-11-10' };
    expect(fc.patternOf(thirty.start, thirty.end)).toEqual({ days: 30 });
    expect(fc.billPeriod(thirty, '2026-11-11')).toMatchObject({ start: '2026-11-11', end: '2026-12-10', days: 30 });
  });

  test('only real calendar dates are dates', () => {
    expect(fc.parseDay('2026-10-12')).toBe('2026-10-12');
    for (const bad of ['2026-02-31', '2026-13-01', '12-10-2026', '', null, 'x']) expect(fc.parseDay(bad)).toBeNull();
  });
});

describe('usual use is the median of the same hour of the week', () => {
  test('one odd week does not move it', () => {
    const use = dayShift();
    const wednesday = '2026-10-14';
    expect(dow(at(wednesday))).toBe(3);
    // a holiday: that Wednesday the machine stood
    const s = seriesOf(at('2026-09-20'), at('2026-10-23'), use, { skip: h => fc.istDay(h) === wednesday });
    const usual = fc.usualUse(s, at('2026-09-20'), fc.istHour(NOW));
    expect(usual.weeks).toBe(4);
    expect(usual.at(at('2026-10-28', 9))).toBe(10);          // a Wednesday at 09:00
    expect(usual.at(at('2026-10-25', 9))).toBe(0);           // a Sunday
  });

  test('under a week of history, the hours of the day stand in; under a day, no guess', () => {
    const use = dayShift();
    const s = seriesOf(at('2026-10-20'), NOW, use);
    const usual = fc.usualUse(s, at('2026-10-20'), fc.istHour(NOW));
    expect(usual.weeks).toBe(0);
    expect(usual.at(at('2026-10-25', 9))).toBe(10);          // Sunday too: no weekday pattern yet
    expect(fc.usualUse(s, at('2026-10-22', 18), fc.istHour(NOW))).toBeNull();
  });
});

describe('the forecast', () => {
  const use = dayShift();
  const series = new Map([[1, seriesOf(HISTORY, NOW, use)]]);
  const base = { series, machines: [1], rates: new Map([[1, 10]]), period: PERIOD, previous: PREVIOUS, now: NOW, historyFrom: HISTORY };

  test('every week alike: so far is what the meter counted, and the bill is exact', () => {
    const r = fc.forecastBill(base);
    const h0 = fc.istHour(NOW);
    const soFar = sumHours(at(PERIOD.start), h0, use) + use(h0) * 0.5;
    const rest = use(h0) * 0.5 + sumHours(h0 + H, at('2026-11-12'), use);
    expect(r.so_far).toEqual({ kwh: soFar, cost: soFar * 10 });
    expect(r.rest).toEqual({ kwh: rest, cost: rest * 10 });
    expect(r.forecast).toEqual({
      kwh: soFar + rest, cost: (soFar + rest) * 10,
      low_kwh: soFar + rest, high_kwh: soFar + rest, low_cost: (soFar + rest) * 10, high_cost: (soFar + rest) * 10
    });
    expect(r.history.weeks).toBe(4);
    expect(r.machines).toEqual({ in_scope: 1, metered: 1, forecast: 1, too_new: 0, unpriced: 0 });
  });

  test('the method is checked on the last 7 days, and the bill before is there to compare', () => {
    const r = fc.forecastBill(base);
    expect(r.accuracy).toMatchObject({ from: '2026-10-16', error_pct: 0 });
    expect(r.accuracy.actual_kwh).toBe(sumHours(fc.istHour(NOW) - 7 * 24 * H, fc.istHour(NOW), use));
    const prev = sumHours(at(PREVIOUS.start), at('2026-10-12'), use);
    expect(r.previous).toEqual({ start: PREVIOUS.start, end: PREVIOUS.end, kwh: prev, cost: prev * 10 });
  });

  test('day by day: used so far, expected to come, running totals ending at the bill', () => {
    const r = fc.forecastBill(base);
    expect(r.per_day).toHaveLength(31);
    const past = r.per_day.find(d => d.day === '2026-10-22');
    expect(past).toMatchObject({ kind: 'past', expected_kwh: null, forecast_cost: null });
    expect(past.used_kwh).toBe(120);
    const today = r.per_day.find(d => d.day === '2026-10-23');
    expect(today.kind).toBe('today');
    expect(today.used_kwh).toBe(25);                          // 08:00–10:30
    expect(today.expected_kwh).toBe(95);                      // the rest of the shift
    const last = r.per_day.at(-1);
    expect(last).toMatchObject({ kind: 'coming', used_kwh: null });
    expect(last.forecast_cost).toBe(r.forecast.cost);
    const running = r.per_day.filter(d => d.forecast_cost != null).map(d => d.forecast_cost);
    expect(running).toEqual([...running].sort((a, b) => a - b));
  });

  test('an odd week in the history widens the likely range, not the forecast', () => {
    const holiday = '2026-09-30';
    expect(dow(at(holiday))).toBe(3);
    const withHoliday = new Map([[1, seriesOf(HISTORY, NOW, use, { skip: h => fc.istDay(h) === holiday })]]);
    const r = fc.forecastBill({ ...base, series: withHoliday });
    const plain = fc.forecastBill(base);
    expect(r.forecast.cost).toBe(plain.forecast.cost);
    expect(r.forecast.low_cost).toBeLessThan(r.forecast.cost);
    expect(r.forecast.high_cost).toBe(r.forecast.cost);
  });

  test('each machine at its own rate; a machine with none is counted in kWh and said', () => {
    const two = new Map([[1, seriesOf(HISTORY, NOW, use)], [2, seriesOf(HISTORY, NOW, dayShift(4))]]);
    const priced = fc.forecastBill({ ...base, series: two, machines: [1, 2], rates: new Map([[1, 10], [2, 8]]) });
    const one = fc.forecastBill(base);
    const other = fc.forecastBill({ ...base, series: new Map([[2, two.get(2)]]), machines: [2], rates: new Map([[2, 8]]) });
    expect(priced.forecast.cost).toBeCloseTo(one.forecast.cost + other.forecast.cost, 2);

    const unpriced = fc.forecastBill({ ...base, series: two, machines: [1, 2], rates: new Map([[1, 10], [2, null]]) });
    expect(unpriced.machines.unpriced).toBe(1);
    expect(unpriced.forecast.cost).toBe(one.forecast.cost);
    expect(unpriced.forecast.kwh).toBeCloseTo(one.forecast.kwh + other.forecast.kwh, 3);

    const noTariff = fc.forecastBill({ ...base, rates: new Map([[1, null]]) });
    expect(noTariff.forecast.cost).toBeNull();
    expect(noTariff.so_far.cost).toBeNull();
    expect(noTariff.forecast.kwh).toBe(one.forecast.kwh);
  });

  test('a meter fitted this morning: what it counted is in, its coming use is not guessed', () => {
    const fresh = seriesOf(at('2026-10-23', 8), NOW, use);
    const r = fc.forecastBill({ ...base, series: new Map([[1, series.get(1)], [3, fresh]]), machines: [1, 3], rates: new Map([[1, 10], [3, 10]]) });
    expect(r.machines).toMatchObject({ metered: 2, forecast: 1, too_new: 1 });
    expect(r.so_far.kwh).toBe(fc.forecastBill(base).so_far.kwh + 25);
  });

  test('no meter in scope: nothing counted, nothing forecast', () => {
    const r = fc.forecastBill({ ...base, series: new Map(), machines: [1] });
    expect(r.forecast).toBeNull();
    expect(r.so_far).toEqual({ kwh: 0, cost: 0 });
    expect(r.machines.metered).toBe(0);
  });

  test('meters fitted during the last bill: no short total to compare against', () => {
    const late = new Map([[1, seriesOf(at('2026-09-25'), NOW, use)]]);
    expect(fc.forecastBill({ ...base, series: late, historyFrom: at('2026-09-25') }).previous).toBeNull();
    expect(fc.forecastBill({ ...base, series: late, historyFrom: HISTORY }).previous).toBeNull();
  });
});
