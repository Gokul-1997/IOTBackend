jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/lib/realtime', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/notifications/notification.service', () => ({ announceUnread: jest.fn(async () => {}) }));
const { mockDb, resetDb } = require('../helpers/mockDb');
const { emitToUser } = require('../../src/lib/realtime');
const { announceUnread } = require('../../src/notifications/notification.service');
const jobs = require('../../src/programs/jobs');
const job = {
  id: '91', protocol_version: 3, company_id: 4, machine_id: 7, requested_by: 12,
  action: 'SEND', status: 'DONE', machine_serial: 'CNC7', program_name: 'O1234.nc',
  program_path: '/CNC', lease_token: 'secret', gateway_token_version: 9,
  controller_ip: '192.168.1.100', command_parameters: { controller_key: 'private-profile' },
  file_folder: 'private-folder'
};
beforeEach(() => { resetDb(); jest.clearAllMocks(); });

test('a completed gateway operation checks current user, machine, plant and complete page access in the inbox snapshot', async () => {
  mockDb.queueResponse({ rows: [{ id: 12, inserted: true }] });
  await jobs.announce(job);
  const query = mockDb.calls()[0];
  expect(mockDb.calls()).toHaveLength(1);
  expect(query.text).toContain('WITH recipient AS');
  expect(query.text).toMatch(/u\.id=\$2 AND u\.company_id=\$1 AND u\.is_active=TRUE/);
  expect(query.text).toMatch(/m\.id=\$6 AND m\.company_id=u\.company_id AND m\.is_active=TRUE/);
  expect(query.text).toContain('u.plant_id=m.plant_id');
  expect(query.text).toContain("p.permission_key='page:programs:view'");
  expect(query.text).toContain('rp.permission_id=p.id');
  expect(query.text).toContain('cp.permission_id=p.id');
  expect(query.text).toContain('r.company_id IS NULL');
  expect(query.params).toEqual([4,12,'INFO','Program sent to CNC7','"O1234.nc" was sent to CNC7.',7,true]);
  expect(announceUnread).toHaveBeenCalledWith([12]);
});

test('company/plant reassignment or revoked access suppresses status and inbox delivery', async () => {
  mockDb.queueResponse({ rows: [] });
  await jobs.announce(job);
  expect(emitToUser).not.toHaveBeenCalled();
  expect(announceUnread).not.toHaveBeenCalled();
});

test('a permitted requester gets a safe live status when their inbox preference is disabled', async () => {
  mockDb.queueResponse({ rows: [{ id: 12, inserted: false }] });
  await jobs.announce(job);
  expect(emitToUser).toHaveBeenCalledWith(12, 'programJob', expect.objectContaining({ id: '91', status: 'DONE' }));
  const payload = emitToUser.mock.calls[0][2];
  for (const key of ['lease_token','gateway_token_version','controller_ip','command_parameters','file_folder','company_id']) expect(payload).not.toHaveProperty(key);
  expect(announceUnread).not.toHaveBeenCalled();
});

test.each([{ status: 'DELIVERED', action: 'SEND' }, { status: 'DONE', action: 'LIST' }])('progress and browsing update the requester without adding an inbox row: %j', async update => {
  mockDb.queueResponse({ rows: [{ id: 12, inserted: false }] });
  await jobs.announce({ ...job, ...update });
  expect(mockDb.calls()[0].params[6]).toBe(false);
  expect(emitToUser).toHaveBeenCalledTimes(1);
  expect(announceUnread).not.toHaveBeenCalled();
});

test('notification database failure never changes an already committed gateway result', async () => {
  mockDb.queueError(new Error('connection lost'));
  await expect(jobs.announce(job)).resolves.toBeUndefined();
  expect(emitToUser).not.toHaveBeenCalled();
  expect(announceUnread).not.toHaveBeenCalled();
});
