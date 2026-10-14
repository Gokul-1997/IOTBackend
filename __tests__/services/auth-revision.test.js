jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const mockRedis = { del: jest.fn().mockResolvedValue(1) };
jest.mock('../../src/redis', () => mockRedis);
const mockRealtime = { disconnectUsers: jest.fn() };
jest.mock('../../src/lib/realtime', () => mockRealtime);
const { mockDb, resetDb } = require('../helpers/mockDb');
const revision = require('../../src/lib/auth-revision');
const roles = require('../../src/roles/role.service');
const users = require('../../src/users/user.service');
const companies = require('../../src/companies/company.service');
const actor = { id: 1, company_id: 4, roles: ['COMPANY_ADMIN'] };
beforeEach(() => { resetDb(); jest.clearAllMocks(); mockRedis.del.mockResolvedValue(1); mockRealtime.disconnectUsers.mockImplementation(() => {}); });
const calls = () => mockDb.calls().map(call => call.text);

test.each([[undefined, '0'], [0, '0'], ['0', '0'], ['9007199254740993', '9007199254740993'], [null, null], ['01', null], [-1, null], [9007199254740992, null]])('revisionOf(%s) is canonical %s', (input, expected) => {
  expect(revision.revisionOf(input)).toBe(expected);
});
test('cache cleanup and socket teardown failure cannot reject committed authorization changes', async () => {
  mockRedis.del.mockRejectedValue(new Error('cache unavailable'));
  mockRealtime.disconnectUsers.mockImplementation(() => { throw new Error('socket adapter unavailable'); });
  await expect(revision.invalidateUsers([7])).resolves.toBeUndefined();
  expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([7]);
});
function queuePermissionChange(revisionResponse = { rows: [{ id: 7 }, { id: 8 }] }) {
  mockDb.queueResponse({}, { rows: [{ id: 10, company_id: 4, is_system: false }] },
    { rows: [{ id: 2 }] }, { rows: [{ permission_id: 2 }] },
    { rows: [{ id: 2, permission_key: 'page:quality:view' }] }, {}, {}, revisionResponse, {});
}
test('role permission replacement advances all affected users in its transaction before commit and teardown', async () => {
  queuePermissionChange(); await roles.assignPermissions(10, [2], actor);
  const statements = calls(); const bump = statements.findIndex(sql => /UPDATE users u SET auth_revision/.test(sql));
  expect(bump).toBeGreaterThan(statements.findIndex(sql => /INSERT INTO role_permissions/.test(sql)));
  expect(bump).toBeLessThan(statements.indexOf('COMMIT'));
  expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([7, 8]);
});
test('failed revision update rolls back permission replacement and never disconnects users', async () => {
  queuePermissionChange(new Error('revision storage failure'));
  await expect(roles.assignPermissions(10, [2], actor)).rejects.toThrow('revision storage failure');
  expect(calls()).toContain('ROLLBACK'); expect(calls()).not.toContain('COMMIT');
  expect(mockRealtime.disconnectUsers).not.toHaveBeenCalled(); expect(mockRedis.del).not.toHaveBeenCalled();
});
test('cache/socket cleanup failure does not trigger rollback after a successful role change', async () => {
  queuePermissionChange(); mockRedis.del.mockRejectedValue(new Error('redis down'));
  mockRealtime.disconnectUsers.mockImplementation(() => { throw new Error('adapter down'); });
  await expect(roles.assignPermissions(10, [2], actor)).resolves.toMatchObject({ pages: 1 });
  expect(calls()).not.toContain('ROLLBACK'); expect(calls().at(-1)).toBe('COMMIT');
});
test('user plant/account mutation and revision advance are one atomic UPDATE', async () => {
  mockDb.queueResponse({}, { rows: [{ id: 7, company_id: 4, plant_id: null }], rowCount: 1 }, { rows: [] }, {});
  await users.update(7, actor, { plant_id: null });
  expect(calls()[1]).toMatch(/plant_id = \$1, auth_revision = auth_revision \+ 1/);
  expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([7]);
});
test('company grant changes advance every company user before commit', async () => {
  mockDb.queueResponse({}, { rows: [{ id: 4 }] }, { rows: [{ id: 2 }] }, { rows: [] }, {}, { rows: [{ id: 7 }] }, {});
  await companies.assignCompanyPermissions(4, [2], 1);
  const statements = calls(); expect(statements.at(-2)).toMatch(/UPDATE users SET auth_revision = auth_revision \+ 1 WHERE company_id = \$1/);
  expect(statements.at(-1)).toBe('COMMIT'); expect(mockRealtime.disconnectUsers).toHaveBeenCalledWith([7]);
});
