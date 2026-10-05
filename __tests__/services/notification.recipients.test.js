/*
 * Who is sent an in-app notification, and whether Settings is obeyed.
 *
 * Before: every user in the company got every alarm — HR and Setter
 * included — with a link to the Live Dashboard most of them could not
 * open, and the Alarms / Program transfer switches in Settings were saved
 * but never read. The alarm message was also pasted into the SQL, so one
 * containing an apostrophe broke the insert.
 *
 * The recipient query runs against Postgres, so these tests hold its shape;
 * which roles it picks on the real data was checked read-only on 2026-09-22
 * (admins → /alarms, Maintenance → /alarm-report, Supervisor → /dashboard;
 * Quality, Setter and HR not told).
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/utils/nodemailer', () => ({ sendBulkEmails: jest.fn(), sendEmail: jest.fn(async () => {}) }));
const { mockDb, resetDb } = require('../helpers/mockDb');
const alarms = require('../../src/alarms/alarm.service');
const jobs = require('../../src/programs/jobs');

beforeEach(() => resetDb());

const recipientsQuery = () => mockDb.calls().find(c => /FROM users u/.test(c.text));
const insertCall = () => mockDb.calls().find(c => /INSERT INTO notifications/.test(c.text));

describe('alarm notifications', () => {
  const machine = { rows: [{ machine_serial_no: 'VMC-7' }], rowCount: 1 };

  test('go only to roles that can see alarms, in an active company', async () => {
    mockDb.queueResponse(machine, { rows: [], rowCount: 0 });
    await alarms.createAlarmNotification(4, 7, 'ALARM', 'Spindle overload');

    const q = recipientsQuery();
    expect(q.params).toEqual([4]);
    expect(q.text).toMatch(/JOIN companies c ON c\.id = u\.company_id AND c\.is_active = true/);
    expect(q.text).toMatch(/u\.is_active = true/);
    // the company admin, or a role holding an alarm page or the Live Dashboard
    expect(q.text).toMatch(/HAVING bool_or\(r\.role_name = 'COMPANY_ADMIN' AND r\.company_id IS NULL\)/);
    expect(q.text).toMatch(/'page:alarms:view', 'page:analytics-alarms:view', 'page:dashboard:view'/);
  });

  test('skip anyone who switched Alarms off; no row means on', async () => {
    mockDb.queueResponse(machine, { rows: [], rowCount: 0 });
    await alarms.createAlarmNotification(4, 7, 'ALARM', 'x');
    const q = recipientsQuery();
    expect(q.text).toMatch(/LEFT JOIN notification_preferences np ON np\.user_id = u\.id/);
    expect(q.text).toMatch(/COALESCE\(np\.notify_alarm, true\)/);
  });

  test('link each person to the first alarm page they can open', async () => {
    mockDb.queueResponse(machine, { rows: [], rowCount: 0 });
    await alarms.createAlarmNotification(4, 7, 'ALARM', 'x');
    const q = recipientsQuery().text.replace(/\s+/g, ' ');
    const admin = q.indexOf("THEN '/alarms'");
    const report = q.indexOf("THEN '/alarm-report'");
    const live = q.indexOf("ELSE '/dashboard'");
    expect(admin).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(admin);
    expect(live).toBeGreaterThan(report);
  });

  test('one insert for everyone, each with their own link', async () => {
    mockDb.queueResponse(machine, {
      rows: [{ id: 10, link: '/alarms' }, { id: 22, link: '/dashboard' }, { id: 23, link: '/alarm-report' }],
      rowCount: 3
    });
    await alarms.createAlarmNotification(4, 7, 'ALARM', 'Spindle overload');

    const ins = insertCall();
    expect(ins.params).toEqual([
      4, 'ALARM', 'ALARM — VMC-7', 'Spindle overload',
      [10, 22, 23], ['/alarms', '/dashboard', '/alarm-report']
    ]);
    expect(ins.text).toMatch(/unnest\(\$5::int\[\], \$6::text\[\]\)/);
  });

  test("a message with an apostrophe is a parameter, never part of the SQL", async () => {
    const message = "Door open'; DROP TABLE notifications; --";
    mockDb.queueResponse(machine, { rows: [{ id: 10, link: '/alarms' }], rowCount: 1 });
    await alarms.createAlarmNotification(4, 7, 'WARNING', message);

    const ins = insertCall();
    expect(ins.text).not.toContain(message);
    expect(ins.text).not.toContain('Door open');
    expect(ins.params[1]).toBe('WARNING');
    expect(ins.params[3]).toBe(message);
  });

  test('nobody to tell: no insert', async () => {
    mockDb.queueResponse(machine, { rows: [], rowCount: 0 });
    await alarms.createAlarmNotification(4, 7, 'ALARM', 'x');
    expect(insertCall()).toBeUndefined();
  });

  test('a failure is logged, never thrown into the alarm path', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.queueResponse(machine);
    mockDb.queueError(new Error('connection reset'));
    await expect(alarms.createAlarmNotification(4, 7, 'ALARM', 'x')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('createAlarmNotification error:', 'connection reset');
    spy.mockRestore();
  });
});

describe('program transfer notifications', () => {
  const job = { id: '5', company_id: 3, requested_by: 7, action: 'SEND', status: 'DONE', program_name: 'O1234.nc',
                machine_serial: 'VMC-01', message: null, backup_stored_name: '20261005-103020_BACKUP_O1234.nc' };

  test('the person who asked is told, unless they switched Program transfer off', async () => {
    await jobs.announce(job);
    const ins = insertCall();
    expect(ins).toBeDefined();
    expect(ins.text).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM notification_preferences\s+WHERE user_id = \$2 AND notify_program_transfer = false\)/);
    expect(ins.params.slice(0, 3)).toEqual([3, 7, 'INFO']);
    expect(ins.params[3]).toBe('Program sent to VMC-01');
    expect(ins.params[4]).toMatch(/kept as 20261005-103020_BACKUP_O1234\.nc/);
  });

  test('a failure says why, as a warning', async () => {
    await jobs.announce({ ...job, status: 'FAILED', message: 'Controller memory full.', backup_stored_name: null });
    const ins = insertCall();
    expect(ins.params[2]).toBe('WARNING');
    expect(ins.params[3]).toBe('Program transfer failed — VMC-01');
    expect(ins.params[4]).toBe('"O1234.nc" was not sent to VMC-01. Controller memory full.');
  });

  test('a job still under way is not a notification', async () => {
    await jobs.announce({ ...job, status: 'DELIVERED' });
    expect(insertCall()).toBeUndefined();
  });
});
