const mockProcess = jest.fn(), mockPrune = jest.fn(async () => 0);
jest.mock('../../src/alarms/alarm-notification.service', () => ({ processDueAlarms: (...args) => mockProcess(...args), pruneProcessedEvents: (...args) => mockPrune(...args) }));
const job = require('../../src/cron/alarmNotifications.job');
beforeEach(() => { jest.clearAllMocks(); mockProcess.mockResolvedValue({ checked: 100, delivered: 0, progressed: 100 }); });
afterEach(() => jest.restoreAllMocks());
test('one fleet tick drains at most four bounded batches and signals a backlog', async () => {
  expect(await job()).toMatchObject({ hasMore: true }); expect(mockProcess).toHaveBeenCalledTimes(4);
  for (const call of mockProcess.mock.calls) expect(call).toEqual([{ batchSize: 100 }]);
});
test('a short batch ends a quiet fleet tick', async () => {
  mockProcess.mockResolvedValueOnce({ checked: 100, delivered: 0, progressed: 100 }).mockResolvedValueOnce({ checked: 3, delivered: 0, progressed: 3 });
  expect(await job()).toMatchObject({ hasMore: false }); expect(mockProcess).toHaveBeenCalledTimes(2);
});
test('a full no-recipient batch does not request an immediate hot retry loop', async () => {
  mockProcess.mockResolvedValue({ checked: 100, delivered: 0, progressed: 0 });
  expect(await job()).toMatchObject({ hasMore: false }); expect(mockProcess).toHaveBeenCalledTimes(4);
});
test('database failure is reported for durable retry', async () => {
  mockProcess.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(job()).rejects.toThrow('database unavailable'); expect(mockProcess).toHaveBeenCalledTimes(1);
});
