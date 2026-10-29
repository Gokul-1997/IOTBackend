/*
 * The Live Dashboard card and the machine's own page show the same machine,
 * so they show the same values (25 Oct 2026, the user: the Component ID on
 * the Live Dashboard was not the one on the machine page — "simply show Part
 * No on both"). Both answers carry the component's part number.
 *
 * The mock answers each query by what it asks for, not by position.
 */
const answers = [];
const calls = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text, params) => {
    calls.push({ text, params });
    const hit = answers.find(([re]) => re.test(text));
    return hit ? { rows: hit[1], rowCount: hit[1].length } : { rows: [], rowCount: 0 };
  })
}));

const svc = require('../../src/dashboard/dashboard.service');

const LIST_JOB = /SELECT j\.machine_id, j\.part_name, j\.component_id, c\.part_number, j\.target_qty\s+FROM machine_current_job j/;
const PAGE_JOB = /FROM machine_current_job j\s+LEFT JOIN components c ON c\.id = j\.component_id\s+WHERE j\.machine_id = \$1/;

function given(partNumber) {
  answers.length = 0; calls.length = 0;
  answers.push(
    [/FROM shifts/, [{ id: 1, shift_code: 'DAY', start_time: '00:00:00', end_time: '23:59:59', break_minutes: 0 }]],
    [/SELECT id,machine_serial_no,image_url\s+FROM machines/, [{ id: 25, machine_serial_no: 'HMC - 7 - F', image_url: null }]],
    [/FROM machines\s+WHERE id = \$1 AND company_id = \$2/, [{ id: 25, machine_serial_no: 'HMC - 7 - F', image_url: null }]],
    [/DISTINCT ON \(oma\.machine_id\)/, [{ machine_id: 25, operator_name: 'Bala Murugan' }]],
    [/SELECT o\.operator_name, o\.operator_code/, [{ operator_name: 'Bala Murugan', operator_code: 'EMP-25' }]],
    [LIST_JOB, [{ machine_id: 25, part_name: 'Turbine housing', component_id: 7, part_number: partNumber, target_qty: 60 }]],
    [PAGE_JOB, [{ part_name: 'Turbine housing', component_id: 7, part_number: partNumber, target: 60, multiplication_factor: 1 }]]
  );
}

async function bothPages() {
  const list = await svc.dashboard(null, 4);
  return { card: list.machines.find(m => m.machine_id === 25), page: await svc.machineDetail(null, 25, 4) };
}

test('the card and the machine page carry the same Part No', async () => {
  given('PN-45-1002');
  const { card, page } = await bothPages();
  expect(page.job.part_number).toBe('PN-45-1002');
  expect(card.part_number).toBe(page.job.part_number);
  expect(card.part_name).toBe(page.job.part_name);
  expect(card.operator_name).toBe(page.operator.operator_name);
});

test('a component without a part number has none on either page; component_id stays what each sent before', async () => {
  given(null);
  const { card, page } = await bothPages();
  expect(card.part_number).toBeNull();
  expect(page.job.part_number).toBeNull();
  expect(card.component_id).toBe(7);
  expect(page.job.component_id).toBe(7);        // the mobile app's "Component" reads this, unchanged
  given('PN-45-1002');
  expect((await bothPages()).page.job.component_id).toBe('PN-45-1002');
});

test('the card reads the part number from the job\'s own component, for the machines on the page only', async () => {
  given('PN-45-1002');
  await svc.dashboard(null, 4);
  const q = calls.find(c => LIST_JOB.test(c.text));
  expect(q.text).toMatch(/LEFT JOIN components c ON c\.id = j\.component_id/);
  expect(q.params).toEqual([[25]]);
});

test('two operators on one machine and shift: both pages pick the latest assignment', async () => {
  given('PN-45-1002');
  await bothPages();
  const listQuery = calls.find(c => /DISTINCT ON \(oma\.machine_id\)/.test(c.text));
  const pageQuery = calls.find(c => /SELECT o\.operator_name, o\.operator_code/.test(c.text));
  expect(listQuery.text).toMatch(/ORDER BY oma\.machine_id, oma\.id DESC/);
  expect(pageQuery.text).toMatch(/ORDER BY a\.id DESC/);
});

test('recorded part counts agree on list and detail even when the component multiplier is edited', async () => {
  given('PN-45-1002');
  const component = { machine_id: 25, target: 60, multiplication_factor: 2 };
  const pageJob = answers.find(([re]) => re === PAGE_JOB)[1][0];
  pageJob.multiplication_factor = 2;
  answers.push(
    [/SELECT j\.machine_id, j\.target_qty AS target/, [component]],
    [/FROM production_hourly/, [{ machine_id: 25, produced_qty: 7, run_seconds: 600, idle_seconds: 60 }]]
  );
  const before = await bothPages();
  expect(before.card.produced_qty).toBe(7);
  expect(before.card.achieved_qty).toBe(7);
  expect(before.page.job.achieved_qty).toBe(7);
  expect(before.page.quality.accepted).toBe(7);
  component.multiplication_factor = pageJob.multiplication_factor = 20;
  const after = await bothPages();
  expect(after.card.achieved_qty).toBe(7);
  expect(after.page.job.achieved_qty).toBe(7);
  expect(after.page.quality.accepted).toBe(7);
});

test('list and detail include the first overlapping hour, reject future buckets and enforce source company', async () => {
  given('PN-45-1002');
  await bothPages();
  const rollups = calls.filter(c => /FROM production_hourly/.test(c.text));
  expect(rollups).toHaveLength(2);
  for (const q of rollups) {
    expect(q.text).toContain('AND company_id = $5');
    expect(q.text).toContain("hour_start + INTERVAL '1 hour' > $3::timestamptz");
    expect(q.text).toContain('hour_start < LEAST($4::timestamptz, $6::timestamptz)');
    expect(q.params[4]).toBe(4);
    expect(q.params[5]).toBeInstanceOf(Date);
  }
});

test('live shifts use an exclusive end so adjacent shifts cannot both match the boundary', async () => {
  given('PN-45-1002');
  await bothPages();
  const shifts = calls.filter(c => /FROM shifts/.test(c.text));
  for (const q of shifts) {
    expect(q.text).not.toContain('BETWEEN start_time AND end_time');
    expect(q.text).not.toMatch(/::time <= end_time/);
    expect(q.text).toMatch(/::time < end_time/);
  }
});

test.each([
  ['2026-10-28T07:30:00+05:30','2026-10-27T02:30:00.000Z'],
  ['2026-10-28T08:00:00+05:30','2026-10-28T02:30:00.000Z'],
  ['2026-10-28T23:59:59+05:30','2026-10-28T02:30:00.000Z']
])('a 24 hour live shift at %s starts at %s on both pages', async (clock,start) => {
  jest.useFakeTimers().setSystemTime(new Date(clock));
  try {
    given('PN-45-1002');
    Object.assign(answers[0][1][0],{ start_time:'08:00:00',end_time:'08:00:00' });
    await bothPages();
    const rollups = calls.filter(c => /FROM production_hourly/.test(c.text));
    expect(rollups).toHaveLength(2);
    for (const q of rollups) {
      expect(q.params[2].toISOString()).toBe(start);
      expect(q.params[3]-q.params[2]).toBe(86400000);
    }
  } finally { jest.useRealTimers(); }
});
