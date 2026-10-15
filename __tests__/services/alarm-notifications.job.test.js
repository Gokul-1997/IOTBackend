const mockProcess = jest.fn();
jest.mock('../../src/alarms/alarm-notification.service', () => ({ processDueAlarms: (...args) => mockProcess(...args) }));
const job = require('../../src/cron/alarmNotifications.job');

beforeEach(() => {
  jest.clearAllMocks();
  mockProcess.mockResolvedValue({ checked: 100, delivered: 0 });
});
afterEach(() => jest.restoreAllMocks());

test('one fleet tick drains at most four bounded batches', async () => {
  await job();
  expect(mockProcess).toHaveBeenCalledTimes(4);
  for (const call of mockProcess.mock.calls) expect(call).toEqual([{ batchSize: 100 }]);
});

test('a short batch ends the tick without repeatedly scanning a quiet fleet', async () => {
  mockProcess.mockResolvedValueOnce({ checked: 100, delivered: 0 }).mockResolvedValueOnce({ checked: 3, delivered: 0 });
  await job();
  expect(mockProcess).toHaveBeenCalledTimes(2);
});

test('a slow batch leaves remaining work for the next tick', async () => {
  jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(5001);
  await job();
  expect(mockProcess).toHaveBeenCalledTimes(1);
});

test('database failure stops the batch loop for the scheduler to report and retry', async () => {
  mockProcess.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(job()).rejects.toThrow('database unavailable');
  expect(mockProcess).toHaveBeenCalledTimes(1);
});
