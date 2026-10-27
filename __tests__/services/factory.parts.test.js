/* Factory uses the same recorded output units as Production Report. A
 * current component factor must never rewrite historical rollup counts.
 * The mock answers queries by content rather than Promise.all position. */
const answers = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text) => {
    const hit = answers.find(([re]) => re.test(text));
    return hit ? { rows: hit[1], rowCount: hit[1].length } : { rows: [], rowCount: 0 };
  })
}));

const svc = require('../../src/dashboard/factory.service');

/* Stored quantities remain 192 + 40 even though the second current job has factor 2. */
beforeEach(() => {
  answers.length = 0;
  answers.push(
    [/AS energy_rate_per_kwh/, [{ energy_rate_per_kwh: 10, currency: 'INR', oee_target_percent: 85 }]],
    [/FROM counted c/, [{ total: 2, running: 1, idle: 1, breakdown: 0, offline: 0 }]],
    [/j\.target_qty::numeric AS target/, [{ machine_id: 7, target: 431, mult: 1 }, { machine_id: 9, target: 431, mult: 2 }]],
    [/FROM shifts sh/, [
      { shift_id: 1, shift_code: 'Shift 1', shift_name: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', machine_id: 7, hour_start: '2026-10-26T03:30:00.000Z', produced: 192, run_seconds: 20000, idle_seconds: 4000, kwh: 30 },
      { shift_id: 1, shift_code: 'Shift 1', shift_name: 'Shift 1', start_time: '08:00:00', end_time: '20:00:00', machine_id: 9, hour_start: '2026-10-26T03:30:00.000Z', produced: 40, run_seconds: 10000, idle_seconds: 2000, kwh: 20 },
      { shift_id: 2, shift_code: 'Shift 2', shift_name: 'Shift 2', start_time: '20:00:00', end_time: '08:00:00', machine_id: null, produced: 0 }
    ]],
    [/\(\$2::date - 1\)/, [{ machine_id: 7, kwh: 25, produced: 100 }, { machine_id: 9, kwh: 25, produced: 50 }]],
    [/date_trunc\('month'/, [{ kwh: 50, prev_kwh: 40 }]]
  );
});

const req = { user: { company_id: 4 }, query: { date: '2026-10-26' } };

test('the shift bar and Actual vs Target use stored report counts', async () => {
  const d = await svc.getFactoryDashboard(req);
  const shift1 = d.shiftwise.find(s => s.shift_id === 1);
  expect(shift1.produced).toBe(232);
  expect(shift1.actual).toBe(232);
  expect(shift1.target).toBe(862);
  expect(d.shiftwise.find(s => s.shift_id === 2).produced).toBe(0);
});

test('headline, trend and cost per part use the same recorded quantities', async () => {
  const d = await svc.getFactoryDashboard(req);
  expect(d.production.produced).toBe(232);
  expect(d.production.actual).toBe(232);
  expect(d.trend.reduce((a, t) => a + t.produced, 0)).toBe(232);
  expect(d.energy.cost_per_part).toBe(Number(((50 * 10) / 232).toFixed(2)));
  // Yesterday also uses recorded quantities: 100 + 50 = 150 for 50 kWh.
  const yesterday = (50 * 10) / 150, today = (50 * 10) / 232;
  expect(d.energy.cost_per_part_vs_yesterday_pct).toBe(Number((((Number(today.toFixed(2)) - Number(yesterday.toFixed(2))) / Number(yesterday.toFixed(2))) * 100).toFixed(1)));
});

test('a machine without a current job still contributes its recorded output', async () => {
  answers.splice(answers.findIndex(([re]) => re.source.includes('target_qty')), 1,
    [/j\.target_qty::numeric AS target/, [{ machine_id: 7, target: 431, mult: 1 }]]);
  const d = await svc.getFactoryDashboard(req);
  const shift1 = d.shiftwise.find(s => s.shift_id === 1);
  expect(shift1.produced).toBe(232);                // machine 9 has no job now: recorded output still counts
  expect(shift1.actual).toBe(192);                  // only the machine with a target
});


test('editing the current component factor never changes recorded historical counts', async () => {
  const before = await svc.getFactoryDashboard(req);
  const targetRows = answers.find(([re]) => re.source.includes('target_qty'))[1];
  targetRows[1].mult = 20;
  const after = await svc.getFactoryDashboard(req);
  expect(after.production).toEqual(before.production);
  expect(after.shiftwise).toEqual(before.shiftwise);
  expect(after.trend).toEqual(before.trend);
  expect(after.energy.cost_per_part).toBe(before.energy.cost_per_part);
});
