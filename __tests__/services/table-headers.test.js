/*
 * Every paged table's header reaches its SQL (29 Oct 2026, the MEXA table:
 * sort any column, tick values to filter — lib/table-query.js). One check per
 * endpoint: the asked sort is the ORDER BY, the ticked values are a bound
 * array, a column that is not on the endpoint's list is ignored.
 */
const calls = [];
jest.mock('../../src/db', () => {
  const query = jest.fn(async (text, params) => {
    calls.push({ text: String(text), params });
    return /COUNT\(/i.test(String(text)) ? { rows: [{ count: '0', total: 0, n: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  return { query, connect: async () => ({ query, release() {} }), readOnly: work => work() };
});
jest.mock('../../src/redis', () => ({ get: async () => null, set: async () => 'OK', del: async () => 1, on() {} }));

const range = { from: '2026-10-22', to: '2026-10-29' };
beforeEach(() => { calls.length = 0; });
const sqlWith = re => calls.find(c => re.test(c.text));

test.each([
  ['Machine Alarms', () => require('../../src/alarms/alarm.service').getAlarms({ company_id: 4, sort: 'code', dir: 'desc', f_status: 'on' })],
  ['Maintenance tickets', () => require('../../src/tickets/ticket.service').getTickets({ company_id: 4, sort: 'status', dir: 'desc', f_status: 'OPEN' })],
  ['Downtime events', () => require('../../src/downtime/downtime.service').getEvents({ company_id: 4, sort: 'duration', dir: 'desc', f_category: 'PLANNED' })],
  ['Machines', () => require('../../src/machines/machine.service').getMachines({ query: { sort: 'model', dir: 'desc', f_status: 'true' }, user: { company_id: 4 } })],
  ['Operators', () => require('../../src/operators/operator.service').list(null, { sort: 'name', dir: 'desc', f_status: 'true' }, 4)],
  ['Plants', () => require('../../src/plants/plant.service').getPlants(4, { sort: 'name', dir: 'desc', f_status: 'true' })],
  ['Components', () => require('../../src/component/component.service').list(null, { sort: 'target', dir: 'desc', f_machine: 'VMC - 1' }, 4)],
  ['Job history', () => require('../../src/job/job.service').getJobHistory(4, { query: { sort: 'target', dir: 'desc', f_status: 'false' } })],
  ['Alarm Report Dashboard', () => require('../../src/dashboard/alarm.service').getAlarms({ company_id: 4, part: 'table', ...range, sort: 'ended_at', dir: 'desc', f_status: 'open' })],
  ['Downtime Reason Analysis', () => require('../../src/dashboard/downtime.service').getDowntime({ company_id: 4, part: 'table', ...range, sort: 'operator', dir: 'desc', f_status: 'open' })],
  ['Periodic Maintenance', () => require('../../src/dashboard/periodic.service').getPeriodic({ company_id: 4, part: 'table', head: { sort: 'frequency', dir: 'desc', f_status: 'OPEN' } })],
  ['Maintenance Report', () => require('../../src/dashboard/maintenance-report.service').getReport({ company_id: 4, part: 'table', ...range, sort: 'downtime', dir: 'desc', f_status: 'OPEN' })]
])('%s: the header sort is the ORDER BY and a ticked value is a bound array', async (_name, run) => {
  await run();
  const ordered = sqlWith(/ORDER BY[\s\S]*DESC NULLS LAST/);
  expect(ordered).toBeDefined();
  const filtered = sqlWith(/\)::text = ANY\(\$\d+::text\[\]\)/);
  expect(filtered).toBeDefined();
  const n = Number(/\)::text = ANY\(\$(\d+)::text\[\]\)/.exec(filtered.text)[1]);
  expect(Array.isArray(filtered.params[n - 1])).toBe(true);
});

test('a column that is not on the list sorts nothing and reaches no SQL', async () => {
  await require('../../src/tickets/ticket.service').getTickets({ company_id: 4, sort: 'password', dir: 'desc', f_password: 'x' });
  expect(calls.some(c => /password/.test(c.text))).toBe(false);
  expect(sqlWith(/ORDER BY t\.created_at DESC, t\.id DESC/)).toBeDefined();
});
