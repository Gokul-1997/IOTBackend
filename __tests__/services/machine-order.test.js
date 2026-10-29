/*
 * One machine order for every list the API gives (29 Oct 2026, the user:
 * "machine list sort order, all API"): by name, the numbers in a name read
 * as numbers — VMC - 2 - F before VMC - 10 - M. The key is SQL, so a paged
 * list keeps the order from page to page. VMCs first, then HMCs, then the
 * rest (the user: "VMC 1, 2, 3, next HMC 1, 2"). (Checked on PostgreSQL:
 * VMC - 1 - F, VMC - 2 - F, VMC - 3 - F, VMC - 9 - M, VMC - 10 - M,
 * VMC - 12 - F, VMC - 17 - F, VMC18- M, HMC - 1 - F, HMC - 7 - F,
 * HMC - 15 - F, CNC-01, Lathe 2.)
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { machineOrder } = require('../../src/lib/machine-order');

beforeEach(() => resetDb());

test('VMCs, then HMCs, then the rest; the key pads each run of digits and ignores case, spaces and dashes; ties go by the name', () => {
  const sql = machineOrder('m.machine_serial_no');
  expect(sql).toMatch(/^CASE WHEN upper\(btrim\(coalesce\(m\.machine_serial_no, ''\)\)\) LIKE 'VMC%' THEN 0 WHEN .* LIKE 'HMC%' THEN 1 ELSE 2 END ASC, /);
  expect(sql).toContain("lpad(nk.part[1], 20, '0')");
  expect(sql).toContain("lower(regexp_replace(nk.part[1], '[^[:alnum:]]', '', 'g'))");
  expect(sql).toContain('regexp_matches(coalesce(m.machine_serial_no, \'\')');
  expect(sql).toMatch(/COLLATE "C" ASC, m\.machine_serial_no ASC$/);
  expect(machineOrder('m.machine_serial_no', 'desc')).toMatch(/COLLATE "C" DESC, m\.machine_serial_no DESC$/);
  expect(machineOrder('x', 'sideways; DROP TABLE y')).toMatch(/ASC, x ASC$/);   // only ASC or DESC ever reach the SQL
});

test('the filter lists every page draws its machine picker from are in that order', async () => {
  mockDb.queueResponse({ rows: [] }, { rows: [] });
  await require('../../src/charts/charts.service').getMeta(null, 4);
  expect(mockDb.calls()[0].text).toContain(`ORDER BY ${machineOrder('machine_serial_no')}`);
});

test('the Machines page: by name unless another column is chosen, and its name column in the same order', async () => {
  const svc = require('../../src/machines/machine.service');
  const list = async query => {
    resetDb();
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    await svc.getMachines({ query, user: { company_id: 4 } }).catch(() => {});
    return mockDb.calls().map(c => c.text).find(t => /LIMIT/.test(t)) || '';
  };
  expect(await list({})).toContain(`ORDER BY ${machineOrder('m.machine_serial_no', 'ASC')}, m.id`);
  expect(await list({ sortBy: 'm.machine_serial_no', sortDir: 'desc' })).toContain(`ORDER BY ${machineOrder('m.machine_serial_no', 'DESC')}, m.id`);
  expect(await list({ sortBy: 'm.model', sortDir: 'asc' })).toContain('ORDER BY m.model ASC, m.id');
});
