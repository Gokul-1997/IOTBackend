/*
 * The Live Dashboard card and the machine's own page show the same machine,
 * so they show the same values (25 Oct 2026, the user: the Component ID on
 * the machine page was not the one on the Live Dashboard — the page showed
 * the component's part number, the card the current job's component id).
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

beforeEach(() => {
  answers.length = 0; calls.length = 0;
  answers.push(
    [/FROM shifts/, [{ id: 1, shift_code: 'DAY', start_time: '00:00:00', end_time: '23:59:59', break_minutes: 0 }]],
    [/SELECT id,machine_serial_no,image_url\s+FROM machines/, [{ id: 25, machine_serial_no: 'HMC - 7 - F', image_url: null }]],
    [/FROM machines\s+WHERE id = \$1 AND company_id = \$2/, [{ id: 25, machine_serial_no: 'HMC - 7 - F', image_url: null }]],
    [/DISTINCT ON \(oma\.machine_id\)/, [{ machine_id: 25, operator_name: 'Bala Murugan' }]],
    [/SELECT o\.operator_name, o\.operator_code/, [{ operator_name: 'Bala Murugan', operator_code: 'EMP-25' }]],
    [/SELECT machine_id,part_name,component_id,target_qty\s+FROM machine_current_job/,
      [{ machine_id: 25, part_name: 'Turbine housing', component_id: 7, target_qty: 60 }]],
    // the machine page's job query; part_number is what the old query also read
    [/FROM machine_current_job j\s+LEFT JOIN components c ON c\.id = j\.component_id\s+WHERE j\.machine_id = \$1/,
      [{ part_name: 'Turbine housing', component_id: 7, part_number: 'PN-45-1002', target: 60, multiplication_factor: 1 }]]
  );
});

test('the Component ID, part and operator on the machine page are the Live Dashboard card\'s', async () => {
  const list = await svc.dashboard(null, 4);
  const card = list.machines.find(m => m.machine_id === 25);
  const page = await svc.machineDetail(null, 25, 4);

  expect(card.component_id).toBe(7);
  expect(page.job.component_id).toBe(card.component_id);     // not the part number PN-45-1002
  expect(page.job.part_name).toBe(card.part_name);
  expect(page.operator.operator_name).toBe(card.operator_name);
});

test('a job without a component reads "--" on the page, as the card\'s empty value', async () => {
  answers.unshift([/FROM machine_current_job j\s+LEFT JOIN components c ON c\.id = j\.component_id\s+WHERE j\.machine_id = \$1/,
    [{ part_name: 'Turbine housing', component_id: null, target: 60, multiplication_factor: 1 }]]);   // answered first
  const page = await svc.machineDetail(null, 25, 4);
  expect(page.job.component_id).toBe('--');
});

test('two operators on one machine and shift: both pages pick the latest assignment', async () => {
  await svc.dashboard(null, 4);
  await svc.machineDetail(null, 25, 4);
  const listQuery = calls.find(c => /DISTINCT ON \(oma\.machine_id\)/.test(c.text));
  const pageQuery = calls.find(c => /SELECT o\.operator_name, o\.operator_code/.test(c.text));
  expect(listQuery.text).toMatch(/ORDER BY oma\.machine_id, oma\.id DESC/);
  expect(pageQuery.text).toMatch(/ORDER BY a\.id DESC/);
});
