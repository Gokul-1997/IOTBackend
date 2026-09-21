/*
 * Two places a default role was let down by the API behind a page it holds:
 *
 *   - Quality: recording rejects/rework had no check at all, so SUPERVISOR —
 *     set up as Quality view-only — could change the figures OEE is built on.
 *     It now needs Quality → Edit.
 *   - Maintenance: the ticket assignee dropdown read the admin-only user
 *     list, which refused MAINTENANCE. It now has its own list: the
 *     company's active users, for anyone who can open Maintenance.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/redis', () => ({ get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn() }));
const { mockDb, resetDb } = require('../helpers/mockDb');

const guardsOf = (router, method, path) => {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} is not registered`);
  return layer.route.stack.map(s => s.handle.requiredPermission).filter(Boolean);
};

beforeEach(() => resetDb());

describe('Quality — recording rejects and rework needs Edit', () => {
  const router = require('../../src/quality/quality.routes');

  test('POST /quality/entry requires page:quality:edit', () => {
    expect(guardsOf(router, 'post', '/entry')).toEqual(['page:quality:edit']);
  });

  test('reading the Quality page is unchanged', () => {
    expect(guardsOf(router, 'get', '/')).toEqual([]);
  });

  test('a role with Quality view only is refused; one with Edit gets through', async () => {
    const guard = router.stack.find(l => l.route?.path === '/entry').route.stack
      .find(s => s.handle.requiredPermission).handle;
    const res = () => ({ status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

    const viewOnly = res(); const next1 = jest.fn();
    await guard({ user: { company_id: 4, roles: ['SUPERVISOR'], permissions: ['page:quality:view'] } }, viewOnly, next1);
    expect(next1).not.toHaveBeenCalled();
    expect(viewOnly.code).toBe(403);

    mockDb.queueResponse({ rows: [{ permission_key: 'page:quality:edit' }] });   // the company's grants
    const next2 = jest.fn();
    await guard({ user: { company_id: 4, roles: ['QUALITY'], permissions: ['page:quality:view', 'page:quality:edit'] } }, res(), next2);
    expect(next2).toHaveBeenCalled();
  });
});

describe('Maintenance — who a ticket can be assigned to', () => {
  const router = require('../../src/tickets/ticket.routes');
  const svc = require('../../src/tickets/ticket.service');

  test('GET /tickets/assignees needs Maintenance, not an admin role', () => {
    expect(guardsOf(router, 'get', '/assignees')).toEqual(['page:maintenance:view']);
  });

  test('it is registered before /:id, which would read "assignees" as a ticket id', () => {
    const paths = router.stack.filter(l => l.route?.methods.get).map(l => l.route.path);
    expect(paths.indexOf('/assignees')).toBeLessThan(paths.indexOf('/:id'));
  });

  test('the company\'s active users, names only', async () => {
    mockDb.queueResponse({ rows: [{ id: 23, username: 'maintenance.demo' }] });
    await expect(svc.getAssignees(4)).resolves.toEqual([{ id: 23, username: 'maintenance.demo' }]);
    const { text, params } = mockDb.calls()[0];
    expect(text).toMatch(/SELECT id, username FROM users WHERE company_id = \$1 AND is_active = true/);
    expect(params).toEqual([4]);
  });

  test('no company, no list — never everyone', async () => {
    await expect(svc.getAssignees(null)).resolves.toEqual([]);
    expect(mockDb.calls()).toHaveLength(0);
  });
});
