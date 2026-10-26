/*
 * Factory → Shift wise Production (26 Oct 2026, the user): the shift's bar
 * read 232 while Actual vs Target under it read 272 for the same shift. The
 * bar summed the machines' counters; Actual counted parts — each counter
 * times the parts its job makes per cycle (the component's multiplication
 * factor), as the Live Dashboard and the machine page count them. The bar,
 * the "pieces" figure and the cost per part now count parts too.
 *
 * The mock answers each query by what it asks for, not by position.
 */
const answers = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text) => {
    const hit = answers.find(([re]) => re.test(text));
    return hit ? { rows: hit[1], rowCount: hit[1].length } : { rows: [], rowCount: 0 };
  })
}));

const svc = require('../../src/dashboard/factory.service');

/* Shift 1: VMC - 1 counted 192 cycles of a 1-part job; VMC - 2 counted 40 cycles of a 2-part job. */
beforeEach(() => {
  answers.length = 0;
  answers.push(
    [/AS energy_rate_per_kwh/, [{ energy_rate_per_kwh: 10, currency: 'INR', oee_target_percent: 85 }]],
    [/FROM counted c/, [{ total: 2, running: 1, idle: 1, breakdown: 0, offline: 0 }]],
    [/j\.target_qty::numeric AS target/, [{ machine_id: 7, target: 431, mult: 1 }, { machine_id: 9, target: 431, mult: 2 }]],
    [/FROM shifts sh/, [
      { shift_id: 1, shift_code: 'Shift 1', shift_name: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', machine_id: 7, produced: 192 },
      { shift_id: 1, shift_code: 'Shift 1', shift_name: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', machine_id: 9, produced: 40 },
      { shift_id: 2, shift_code: 'Shift 2', shift_name: 'Shift 2', start_time: '20:00:00', end_time: '08:00:00', machine_id: null, produced: 0 }
    ]],
    [/SELECT hour_start, machine_id, shift_id/, [
      { hour_start: '2026-10-26T03:30:00.000Z', machine_id: 7, shift_id: 1, kwh: 30, produced: 192 },
      { hour_start: '2026-10-26T03:30:00.000Z', machine_id: 9, shift_id: 1, kwh: 20, produced: 40 }
    ]],
    [/\(\$2::date - 1\)/, [{ machine_id: 7, kwh: 25, produced: 100 }, { machine_id: 9, kwh: 25, produced: 50 }]],
    [/date_trunc\('month'/, [{ kwh: 50, prev_kwh: 40 }]],
    [/COALESCE\(SUM\(produced_qty\),0\)::int\s+AS produced,\s+COALESCE\(SUM\(run_seconds\)/,
      [{ produced: 232, run_seconds: 30000, idle_seconds: 6000, energy_kwh: 50 }]]
  );
});

const req = { user: { company_id: 4 }, query: { date: '2026-10-26' } };

test('the shift\'s bar counts parts, as Actual vs Target under it does', async () => {
  const d = await svc.getFactoryDashboard(req);
  const shift1 = d.shiftwise.find(s => s.shift_id === 1);
  expect(shift1.produced).toBe(192 + 40 * 2);       // 272, not the counters' 232
  expect(shift1.actual).toBe(272);
  expect(shift1.target).toBe(862);
  expect(d.shiftwise.find(s => s.shift_id === 2).produced).toBe(0);
});

test('the day\'s "pieces", the trend and the cost per part count parts too', async () => {
  const d = await svc.getFactoryDashboard(req);
  expect(d.production.produced).toBe(272);
  expect(d.production.actual).toBe(272);
  expect(d.trend.reduce((a, t) => a + t.produced, 0)).toBe(272);
  expect(d.energy.cost_per_part).toBe(Number(((50 * 10) / 272).toFixed(2)));
  // yesterday in parts as well: 100 + 50 × 2 = 200 parts for 50 kWh
  const yesterday = (50 * 10) / 200, today = (50 * 10) / 272;
  expect(d.energy.cost_per_part_vs_yesterday_pct).toBe(Number((((Number(today.toFixed(2)) - Number(yesterday.toFixed(2))) / Number(yesterday.toFixed(2))) * 100).toFixed(1)));
});

test('a machine with no job counts one part a cycle; a machine without a target is in the bar, not in Actual', async () => {
  answers.splice(answers.findIndex(([re]) => re.source.includes('target_qty')), 1,
    [/j\.target_qty::numeric AS target/, [{ machine_id: 7, target: 431, mult: 1 }]]);
  const d = await svc.getFactoryDashboard(req);
  const shift1 = d.shiftwise.find(s => s.shift_id === 1);
  expect(shift1.produced).toBe(232);                // machine 9 has no job now: 40 parts
  expect(shift1.actual).toBe(192);                  // only the machine with a target
});
