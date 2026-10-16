// Boot only with stand-ins: this must never load application .env or services.
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function boot({ listenError, stop = jest.fn(async () => {}) } = {}) {
  jest.resetModules();
  const signals = {};
  jest.spyOn(process, 'on').mockImplementation((name, handler) => { signals[name] = handler; return process; });
  jest.spyOn(process, 'exit').mockImplementation(() => {});
  const pool = { end: jest.fn(async () => {}) };
  const subscriber = { on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(async () => {}), quit: jest.fn(async () => {}) };
  const redis = { duplicate: () => subscriber, quit: jest.fn(async () => {}) };
  const server = { close: jest.fn(callback => callback()) };
  const io = { close: jest.fn() };
  const start = jest.fn(() => stop);
  jest.doMock('dotenv', () => ({ config: jest.fn() }));
  jest.doMock('http', () => ({ createServer: () => server }));
  jest.doMock('socket.io', () => ({ Server: jest.fn(() => io) }));
  jest.doMock('../../src/app', () => ({}));
  jest.doMock('../../src/db', () => pool);
  jest.doMock('../../src/redis', () => redis);
  jest.doMock('../../src/lib/realtime', () => ({ setIo: jest.fn() }));
  jest.doMock('../../src/lib/socket-server', () => ({ attach: jest.fn() }));
  jest.doMock('../../src/lib/start-listening', () => ({ startListening: () => listenError ? Promise.reject(listenError) : Promise.resolve() }));
  jest.doMock('../../src/alarms/alarm-notification-listener', () => ({ startAlarmNotifications: start }));
  jest.doMock('../../src/cron', () => ({ stop: jest.fn() }));
  require('../../src/server');
  return { signals, start, stop, pool, server };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('API starts its alarm listener with the API pool and stops it before closing that pool', async () => {
  const context = boot();
  await flush();
  expect(context.start).toHaveBeenCalledWith({ pool: context.pool });
  await context.signals.SIGTERM();
  await flush();
  expect(context.stop).toHaveBeenCalledTimes(1);
  expect(context.pool.end).toHaveBeenCalledTimes(1);
  expect(context.stop.mock.invocationCallOrder[0]).toBeLessThan(context.pool.end.mock.invocationCallOrder[0]);
});

test('failed HTTP startup releases the alarm listener before ending the pool', async () => {
  const context = boot({ listenError: new Error('placement schema unavailable') });
  await flush();
  expect(context.stop).toHaveBeenCalledTimes(1);
  expect(context.pool.end).toHaveBeenCalledTimes(1);
  expect(context.stop.mock.invocationCallOrder[0]).toBeLessThan(context.pool.end.mock.invocationCallOrder[0]);
  expect(process.exit).toHaveBeenCalledWith(1);
});

test('shutdown awaits listener cleanup rather than ending its connection pool early', async () => {
  let complete;
  const stop = jest.fn(() => new Promise(resolve => { complete = resolve; }));
  const context = boot({ stop });
  await flush();
  context.signals.SIGINT();
  await flush();
  expect(context.pool.end).not.toHaveBeenCalled();
  complete();
  await flush();
  expect(context.pool.end).toHaveBeenCalledTimes(1);
});
