jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/utils/nodemailer', () => ({ sendBulkEmails: jest.fn() }));
const { mockDb, resetDb } = require('../helpers/mockDb');
const alarms = require('../../src/alarms/alarm.service');
const scope = require('../../src/lib/read-scope');

beforeEach(resetDb);

test('the alarm list and count remain inside the recipient\'s assigned plant', async () => {
  mockDb.queueResponse({ rows: [{ count: '0' }] }, { rows: [] });
  await scope.run({ company_id: 4, plant_id: 8, roles: ['SUPERVISOR'] },
    () => alarms.getAlarms({ company_id: 4, machine_id: 99 }));
  expect(mockDb.calls()).toHaveLength(3);                        // count, page, summary
  for (const query of mockDb.calls()) {
    expect(query.text).toContain('a.machine_id IN (SELECT authorized_machine.id');
    expect(query.text).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 8');
    expect(query.params.slice(0, 2)).toEqual([4, 99]);
  }
});

test('a recipient cannot acknowledge another plant\'s alarm through its notification link', async () => {
  mockDb.queueResponse({ rows: [], rowCount: 0 });
  await expect(scope.run({ company_id: 4, plant_id: 8, roles: ['SUPERVISOR'] },
    () => alarms.resolveAlarm({ alarm_id: 99, company_id: 4, resolved_by: 7 })))
    .rejects.toMatchObject({ status: 404 });
  const query = mockDb.calls()[0];
  expect(query.text).toContain('a.machine_id IN (SELECT authorized_machine.id');
  expect(query.text).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 8');
});

test('company administrators can follow alerts across their company plants', async () => {
  mockDb.queueResponse({ rows: [{ count: '0' }] }, { rows: [] });
  await scope.run({ company_id: 4, plant_id: 8, roles: ['COMPANY_ADMIN'] },
    () => alarms.getAlarms({ company_id: 4 }));
  for (const query of mockDb.calls()) {
    expect(query.text).not.toContain('authorized_machine');
    expect(query.params[0]).toBe(4);
  }
});
