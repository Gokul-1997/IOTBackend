const { EventEmitter } = require('events');
jest.mock('../../src/db', () => ({ connect: jest.fn() }));
jest.mock('../../src/cron/alarmNotifications.job', () => jest.fn());
const { startAlarmNotifications } = require('../../src/alarms/alarm-notification-listener');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let client, pool, run;
beforeEach(() => {
  jest.useFakeTimers(); client = new EventEmitter(); client.query = jest.fn(async () => {}); client.release = jest.fn();
  pool = { connect: jest.fn(async () => client) }; run = jest.fn(async () => ({ hasMore: false }));
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
test('disabled listeners do not take a pool connection', async () => {
  const stop = startAlarmNotifications({ pool, run, enabled: false }); await stop(); expect(pool.connect).not.toHaveBeenCalled();
});
test('subscribes before catch-up, coalesces bursts and ignores other channels', async () => {
  const stop = startAlarmNotifications({ pool, run, enabled: true }); await flush();
  expect(client.query).toHaveBeenCalledWith('LISTEN cnc_alarm_events'); expect(run).not.toHaveBeenCalled();
  for (let i = 0; i < 20; i++) client.emit('notification', { channel: 'cnc_alarm_events' });
  await jest.advanceTimersByTimeAsync(20); expect(run).toHaveBeenCalledTimes(1);
  client.emit('notification', { channel: 'different' }); await jest.advanceTimersByTimeAsync(20); expect(run).toHaveBeenCalledTimes(1);
  await stop(); expect(client.query).toHaveBeenLastCalledWith('UNLISTEN cnc_alarm_events'); expect(client.release).toHaveBeenCalledTimes(1);
});
test('drains a productive backlog with yields and handles an event arriving during a run', async () => {
  let finish; run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const stop = startAlarmNotifications({ pool, run, enabled: true }); await flush();
  await jest.advanceTimersByTimeAsync(20); expect(run).toHaveBeenCalledTimes(1);
  client.emit('notification', { channel: 'cnc_alarm_events' });
  finish({ hasMore: true }); await flush(); await jest.advanceTimersByTimeAsync(20);
  expect(run).toHaveBeenCalledTimes(2); await stop();
});
test('reconnects after a failed connection and catches up without trusting lost notifications', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  pool.connect.mockRejectedValueOnce(new Error('database restarting'));
  const stop = startAlarmNotifications({ pool, run, enabled: true }); await flush();
  await jest.advanceTimersByTimeAsync(1000); await flush();
  expect(pool.connect).toHaveBeenCalledTimes(2); await jest.advanceTimersByTimeAsync(20); expect(run).toHaveBeenCalledTimes(1);
  await stop(); log.mockRestore();
});
test('stop waits for an in-flight drain and cancels later notifications', async () => {
  let finish; run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const stop = startAlarmNotifications({ pool, run, enabled: true }); await flush(); await jest.advanceTimersByTimeAsync(20);
  let stopped = false; const stopping = stop().then(() => { stopped = true; }); await flush(); expect(stopped).toBe(false);
  finish({ hasMore: true }); await stopping; await jest.advanceTimersByTimeAsync(1000);
  expect(stopped).toBe(true); expect(run).toHaveBeenCalledTimes(1);
});
test('stop retains an error listener through UNLISTEN failure and destroys the connection', async () => {
  const stop = startAlarmNotifications({ pool, run, enabled: true }); await flush();
  let listenersDuringUnlisten = 0;
  client.query.mockImplementation(async sql => {
    if (sql === 'UNLISTEN cnc_alarm_events') {
      listenersDuringUnlisten = client.listenerCount('error');
      const error = new Error('connection lost during shutdown');
      client.emit('error', error);
      throw error;
    }
  });
  await stop();
  expect(listenersDuringUnlisten).toBeGreaterThan(0);
  expect(client.release).toHaveBeenCalledWith(true);
  expect(client.listenerCount('error')).toBe(0);
  await jest.advanceTimersByTimeAsync(5000);
  expect(pool.connect).toHaveBeenCalledTimes(1);
});
