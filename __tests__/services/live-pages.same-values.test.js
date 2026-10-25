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
