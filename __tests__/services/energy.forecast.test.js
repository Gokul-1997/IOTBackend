/*
 * The electricity bill forecast's arithmetic (dashboard/energy-forecast.js).
 *
 * The bills are S AND T's own (July–August 2026, SC 1212 and SC 2309): the
 * forecast must work a bill out exactly as the EB did — to the rupee.
 *
 * The meter fixtures are a factory whose machines run a day shift, 08:00–20:00
 * IST, Monday to Saturday, and stand on Sunday and at night. Where every week
 * is alike the meter forecast must be exact, so the expected figures are
 * worked out here hour by hour, not copied from the code.
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
// reading dates: the bill runs from 12 Oct up to (not counting) 12 Nov
const PERIOD = { start: '2026-10-12', end: '2026-11-12' };
const PREVIOUS = { start: '2026-09-12', end: '2026-10-12' };

/* S AND T's bills for July–August 2026, as printed. */
const SC1212 = { from: '2026-07-26', to: '2026-08-26', units: 55952, rate: 8.13, peak_charges: 0, electricity_charges: 455093,
  fixed_charges: 91200, penalty_charges: 16372, welding_charges: 68264, tax_charges: 29512, net_amount: 660441 };
const SC2309 = { from: '2026-07-26', to: '2026-08-27', units: 68988, rate: 8.25, peak_charges: 0, electricity_charges: 569151,
  fixed_charges: 89984, penalty_charges: 15593, welding_charges: 0, tax_charges: 32622, net_amount: 707350 };
const HISTORY = at('2026-09-01');

describe('the bill period: reading date to reading date, then every month on the same day', () => {
  test('From is counted, To starts the next bill: 26 Jul – 26 Aug is 31 days, 26 Jul – 27 Aug 32', () => {
    expect(fc.daysBetween(SC1212.from, SC1212.to)).toBe(31);
    expect(fc.daysBetween(SC2309.from, SC2309.to)).toBe(32);
    expect(fc.monthsOf(SC1212.from, SC1212.to)).toBe(1);
    expect(fc.monthsOf('2026-06-26', '2026-08-26')).toBe(2);
  });

  test('after the latest bill, the bills follow on its reading day — this one, on 23 Oct', () => {
    expect(fc.currentPeriod(SC1212, '2026-10-23')).toMatchObject({ start: '2026-09-26', end: '2026-10-26', days: 30, billed: false });
    // a reading a day late once (27 Aug) is not repeated as a 32-day cycle
    expect(fc.currentPeriod(SC2309, '2026-10-23')).toMatchObject({ start: '2026-09-27', end: '2026-10-27', days: 30 });
    // on the reading day itself the new bill has begun
    expect(fc.currentPeriod(SC1212, '2026-08-26')).toMatchObject({ start: '2026-08-26', end: '2026-09-26' });
    expect(fc.currentPeriod(SC1212, '2026-10-26')).toMatchObject({ start: '2026-10-26', end: '2026-11-26' });
    expect(fc.cycleText(1)).toBe('Every month');
    expect(fc.cycleText(2)).toBe('Every 2 months');
  });

  test('a reading on the 31st falls on the last day of shorter months', () => {
    const jan = { from: '2026-12-31', to: '2027-01-31' };
    expect(fc.currentPeriod(jan, '2027-02-15')).toMatchObject({ start: '2027-01-31', end: '2027-02-28' });
    expect(fc.currentPeriod(jan, '2027-03-05')).toMatchObject({ start: '2027-02-28', end: '2027-03-31' });
  });

  test('only real calendar dates are dates', () => {
    expect(fc.parseDay('2026-10-12')).toBe('2026-10-12');
    for (const bad of ['2026-02-31', '2026-13-01', '12-10-2026', '', null, 'x']) expect(fc.parseDay(bad)).toBeNull();
  });
});

describe('the bill, worked out as the EB does', () => {
  test.each([['SC 1212', SC1212], ['SC 2309', SC2309]])('%s: its own units give back its own bill, to the rupee', (_name, bill) => {
    expect(fc.chargesFor(bill.units, fc.tariffOf(bill))).toEqual({
      units: bill.units, electricity_charges: bill.electricity_charges, peak_charges: 0, fixed_charges: bill.fixed_charges,
      penalty_charges: bill.penalty_charges, welding_charges: bill.welding_charges, tax_charges: bill.tax_charges,
      net_amount: bill.net_amount
    });
  });

  test('the rate is what the bill really charged (8.13 printed, 8.13363 billed); welding 15 %', () => {
    const t = fc.tariffOf(SC1212);
    expect(t.printed_rate).toBe(8.13);
    expect(t.rate).toBeCloseTo(455093 / 55952, 10);
    expect(t.welding_share).toBeCloseTo(0.15, 6);
    expect(t.fixed).toBe(91200);
  });

  test('fewer units: the charges that follow the units fall, the fixed charges stay', () => {
    const t = fc.tariffOf(SC1212);
    const half = fc.chargesFor(55952 / 2, t);
    expect(half.electricity_charges).toBe(Math.round(455093 / 2));
    expect(half.welding_charges).toBe(Math.round(68264 / 2));
    expect(half.fixed_charges).toBe(91200);
    expect(half.net_amount).toBe(half.electricity_charges + half.fixed_charges + half.penalty_charges + half.welding_charges + half.tax_charges);
  });
});

describe('this bill\'s units', () => {
  const period = { start: '2026-09-26', end: '2026-10-26', days: 30 };

  test('EB meter readings: exact so far; the rest at the last week\'s rate', () => {
    const readings = [
      { read_on: '2026-09-26', kwh: 100000 }, { read_on: '2026-10-14', kwh: 132000 }, { read_on: '2026-10-21', kwh: 144600 }
    ];
    const u = fc.unitsFromReadings(readings, period, '2026-10-23');
    expect(u).toMatchObject({ so_far: 44600, as_of: '2026-10-21', measured: true });
    expect(u.per_day).toBeCloseTo(12600 / 7, 6);              // 14 → 21 Oct
    expect(u.rest).toBeCloseTo(12600 / 7 * 5, 6);             // 21 → 26 Oct
  });

  test('no reading on the bill\'s first day: the register is taken between the readings either side', () => {
    const readings = [{ read_on: '2026-09-24', kwh: 96000 }, { read_on: '2026-09-28', kwh: 104000 }, { read_on: '2026-10-21', kwh: 144600 }];
    expect(fc.unitsFromReadings(readings, period, '2026-10-23').so_far).toBeCloseTo(144600 - 100000, 6);
    // nothing near the start, or nothing since: the readings cannot say
    expect(fc.unitsFromReadings([{ read_on: '2026-10-21', kwh: 144600 }], period, '2026-10-23')).toBeNull();
    expect(fc.unitsFromReadings([{ read_on: '2026-09-26', kwh: 100000 }], period, '2026-10-23')).toBeNull();
  });

  test('no readings: the last bills\' units per day, an estimate — its range from bill to bill', () => {
    const u = fc.unitsFromBills([SC1212], period, at('2026-10-23', 12));
    expect(u.measured).toBe(false);
    expect(u.per_day).toBeCloseTo(55952 / 31, 6);
    expect(u.so_far + u.rest).toBeCloseTo(55952 / 31 * 30, 6);
    expect(u.low_per_day).toBeNull();
    const two = fc.unitsFromBills([{ ...SC1212, from: '2026-08-26', to: '2026-09-26', units: 50000 }, SC1212], period, at('2026-10-23', 12));
    expect(two.per_day).toBeCloseTo((50000 + 55952) / 62, 6);
    expect(two.low_per_day).toBeCloseTo(50000 / 31, 6);
    expect(two.high_per_day).toBeCloseTo(55952 / 31, 6);
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
