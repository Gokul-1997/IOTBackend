jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const realtime = require('../../src/lib/realtime');
const service = require('../../src/notifications/notification.service');
const controller = require('../../src/notifications/notification.controller');

beforeEach(() => { resetDb(); realtime.setIo(null); });
afterEach(() => realtime.setIo(null));
const response = () => { const res = { json: jest.fn(), status: jest.fn(() => res) }; return res; };

test.each([4, 5, null])('inbox data, total and unread count all use the authenticated company scope %s', async companyId => {
  mockDb.queueResponse({ rows: [{ count: '1' }] }, { rows: [{ id: '9', company_id: companyId }] }, { rows: [{ count: '1' }] });
  const result = await service.getNotifications({ user_id: 7, company_id: companyId, page: 2, limit: 10, unread_only: 'true' });
  expect(result.unread_count).toBe(1);
  expect(result.pagination.total).toBe(1);
  const calls = mockDb.calls();
  for (const call of calls) {
    expect(call.text).toMatch(/company_id IS NOT DISTINCT FROM \$2::int/);
    expect(call.params.slice(0, 2)).toEqual([7, companyId]);
  }
  expect(calls[1].params).toEqual([7, companyId, 10, 10]);
  expect(calls[1].text).toMatch(/LIMIT \$3 OFFSET \$4/);
});

test.each([4, 5, null])('unread endpoint remains scoped after account reassignment, including null company %s', async companyId => {
  mockDb.queueResponse({ rows: [{ count: '2' }] });
  expect(await service.getUnreadCount(7, companyId)).toBe(2);
  expect(mockDb.calls()[0].params).toEqual([7, companyId]);
  expect(mockDb.calls()[0].text).toMatch(/company_id IS NOT DISTINCT FROM \$2::int/);
});

test('marking one read requires matching notification, user and company', async () => {
  await service.markRead({ notification_id: '99', user_id: 7, company_id: 5 });
  expect(mockDb.calls()[0].params).toEqual(['99', 7, 5]);
  expect(mockDb.calls()[0].text).toMatch(/id = \$1 AND user_id = \$2 AND company_id IS NOT DISTINCT FROM \$3::int/);
});

test('mark all read cannot touch the same user\'s former-company records', async () => {
  await service.markAllRead(7, 5);
  expect(mockDb.calls()[0].params).toEqual([7, 5]);
  expect(mockDb.calls()[0].text).toMatch(/user_id = \$1 AND company_id IS NOT DISTINCT FROM \$2::int AND is_read = false/);
});

test('missing company is a null platform scope, never an unrestricted inbox', async () => {
  await service.markRead({ notification_id: '99', user_id: 7 });
  await service.markAllRead(7);
  mockDb.queueResponse({ rows: [{ count: '0' }] });
  await service.getUnreadCount(7);
  expect(mockDb.calls().map(call => call.params.at(-1))).toEqual([null, null, null]);
});

test('forged list query identity cannot override the authenticated company or user', async () => {
  mockDb.queueResponse({ rows: [{ count: '0' }] }, { rows: [] }, { rows: [{ count: '0' }] });
  const res = response();
  await controller.getNotifications({ user: { id: 7, company_id: 5 }, query: { user_id: 99, company_id: 4 } }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  for (const call of mockDb.calls()) expect(call.params.slice(0, 2)).toEqual([7, 5]);
});

test('controllers pass authenticated company scope to count and mark actions', async () => {
  await controller.markRead({ user: { id: 7, company_id: 5 }, params: { id: '9' }, body: { company_id: 4 } }, response());
  await controller.markAllRead({ user: { id: 7, company_id: 5 }, body: { company_id: 4 } }, response());
  mockDb.queueResponse({ rows: [{ count: '0' }] });
  await controller.getUnreadCount({ user: { id: 7, company_id: 5 }, query: { company_id: 4 } }, response());
  expect(mockDb.calls().map(call => call.params)).toEqual([['9', 7, 5], [7, 5], [7, 5]]);
});

test('live badges count only notifications belonging to each user\'s current company', async () => {
  const emitted = [];
  realtime.setIo({ to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
  mockDb.queueResponse({ rows: [{ user_id: 7, count: 1 }] });
  await service.announceUnread([7, 8]);
  expect(mockDb.calls()[0].text).toMatch(/n.company_id IS NOT DISTINCT FROM u.company_id/);
  expect(mockDb.calls()[0].params).toEqual([[7, 8]]);
  expect(emitted).toEqual([
    { room: 'user:7', event: 'unreadCount', payload: { count: 1 } },
    { room: 'user:8', event: 'unreadCount', payload: { count: 0 } }
  ]);
});
