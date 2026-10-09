/*
 * The unread count reaches a person's open screens over the live connection
 * (event `unreadCount`, room user:<id>) whenever it changes — notifications
 * created for them, or read by them — so the web app no longer asks for it
 * every 30 s from every tab it has open.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/utils/nodemailer', () => ({ sendBulkEmails: jest.fn(), sendEmail: jest.fn(async () => {}) }));
const { mockDb, resetDb } = require('../helpers/mockDb');
const realtime = require('../../src/lib/realtime');
const notes = require('../../src/notifications/notification.service');
const ctrl = require('../../src/notifications/notification.controller');
const alarms = require('../../src/alarms/alarm.service');
const jobs = require('../../src/programs/jobs');

let emitted;
const io = { to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
const counts = () => emitted.filter(e => e.event === 'unreadCount').map(e => [e.room, e.payload.count]);
const settle = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  resetDb();
  emitted = [];
  realtime.setIo(io);
});
afterAll(() => realtime.setIo(null));

describe('announceUnread', () => {
  test('each person is told their own count — 0 included — from one query', async () => {
    mockDb.queueResponse({ rows: [{ user_id: 7, count: 3 }] });
    await notes.announceUnread([7, 8, 7]);

    expect(mockDb.calls()).toHaveLength(1);
    expect(mockDb.calls()[0].params).toEqual([[7, 8]]);
    expect(mockDb.calls()[0].text).toMatch(/user_id = ANY\(\$1::int\[\]\) AND is_read = false/);
    expect(emitted).toEqual([
      { room: 'user:7', event: 'unreadCount', payload: { count: 3 } },
      { room: 'user:8', event: 'unreadCount', payload: { count: 0 } }
    ]);
  });

  test('a process that serves no sockets (cron alone, tests) asks nothing', async () => {
    realtime.setIo(null);
    await notes.announceUnread([7]);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('no one to tell, nothing asked', async () => {
    await notes.announceUnread([null, undefined, 0, 'x']);
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a failure is logged, never thrown into what caused it', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.queueError(new Error('connection reset'));
    await expect(notes.announceUnread([7])).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
    expect(spy).toHaveBeenCalledWith('Unread count announce failed:', 'connection reset');
    spy.mockRestore();
  });
});

describe('when the count changes', () => {
  const res = () => { const r = { json: jest.fn(), status: jest.fn(() => r) }; return r; };

  test('reading one tells the reader\'s other tabs and devices', async () => {
    mockDb.queueResponse({ rowCount: 1 }, { rows: [{ user_id: 5, count: 2 }] });
    const r = res();
    await ctrl.markRead({ user: { id: 5 }, params: { id: '9' } }, r);
    await settle();
    expect(r.json).toHaveBeenCalledWith({ success: true });
    expect(counts()).toEqual([['user:5', 2]]);
  });

  test('marking all read tells them 0', async () => {
    mockDb.queueResponse({ rowCount: 4 }, { rows: [] });
    await ctrl.markAllRead({ user: { id: 5 } }, res());
    await settle();
    expect(counts()).toEqual([['user:5', 0]]);
  });

  test('an alarm notification tells every recipient, each their own count', async () => {
    mockDb.queueResponse(
      { rows: [{ machine_serial_no: 'VMC-7' }], rowCount: 1 },
      { rows: [{ id: 11, link: '/alarms' }, { id: 12, link: '/alarm-report' }], rowCount: 2 },
      { rowCount: 2 },
      { rows: [{ user_id: 11, count: 1 }, { user_id: 12, count: 4 }] }
    );
    await alarms.createAlarmNotification(4, 7, 'ALARM', 'Spindle overload');
    expect(counts()).toEqual([['user:11', 1], ['user:12', 4]]);
  });

  test('a finished program transfer tells the person who asked', async () => {
    const job = { id: '5', company_id: 3, requested_by: 7, action: 'SEND', status: 'DONE', program_name: 'O1234.nc',
                  machine_serial: 'VMC-01', message: null, backup_stored_name: null };
    mockDb.queueResponse({ rowCount: 1 }, { rows: [{ user_id: 7, count: 6 }] });
    await jobs.announce(job);
    expect(counts()).toEqual([['user:7', 6]]);
  });
});
