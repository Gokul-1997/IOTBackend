const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('shutdown deadline still fires if an awaited dependency never stops; repeated signals do not start more cleanup', async () => {
  jest.useFakeTimers();
  const signals = {}, exit = jest.fn(), stop = jest.fn(() => new Promise(() => {}));
  const subscriber = { on() {}, subscribe() {}, unsubscribe: jest.fn(), quit: jest.fn() };
  const db = { end: jest.fn() };
  const deps = {
    dotenv: { config() {} }, http: { createServer: () => ({ close: jest.fn() }) },
    'socket.io': { Server: class { close() {} } }, './app': {}, './db': db,
    './redis': { duplicate: () => subscriber, quit: jest.fn() },
    './lib/realtime': { setIo() {} }, './lib/socket-server': { attach() {} },
    './lib/start-listening': { startListening: async () => {} },
    './alarms/alarm-notification-listener': { startAlarmNotifications: () => stop },
    './cron': { stop() {} },
    './licensing/runtime': { stop() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8'), {
    require: name => { if (!(name in deps)) throw Error(name); return deps[name]; },
    process: { env: {}, on: (event, callback) => { signals[event] = callback; }, exit },
    setTimeout, console: { log() {}, error() {} }
  });
  signals.SIGTERM(); signals.SIGINT();
  expect(stop).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(10000);
  expect(exit).toHaveBeenCalledWith(1);
  expect(subscriber.quit).not.toHaveBeenCalled();
  jest.useRealTimers();
});
