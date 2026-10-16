const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPool = { query: jest.fn(), connect: jest.fn(async () => mockClient) };
const mockAnnounce = jest.fn(async () => {});
jest.mock('../../src/db', () => mockPool);
jest.mock('../../src/notifications/notification.service', () => ({ announceUnread: (...args) => mockAnnounce(...args) }));
const service = require('../../src/alarms/alarm-notification.service');
const actor = { id: 12, company_id: 4, roles: ['COMPANY_ADMIN'] };
const empty = () => ({ rows: [], rowCount: 0 });
const calls = () => mockClient.query.mock.calls.map(([sql]) => sql);
beforeEach(() => {
  jest.clearAllMocks(); mockPool.connect.mockResolvedValue(mockClient); mockPool.query.mockResolvedValue(empty());
  mockClient.query.mockResolvedValue(empty()); mockAnnounce.mockResolvedValue(undefined);
});
describe('company critical alert setting', () => {
  test('an unconfigured company is off and reads only its machine count', async () => {
    mockPool.query.mockImplementation(async sql => /COUNT/.test(sql) ? { rows: [{ machines: 2000 }] } : empty());
    expect(await service.getPolicy(actor)).toEqual({ enabled: false, configured: false, version: 0, updated_at: null, counts: { machines: 2000 } });
    expect(mockPool.query.mock.calls.every(([, params]) => params[0] === 4)).toBe(true); expect(mockPool.connect).not.toHaveBeenCalled();
  });
  test.each([{}, { ...actor, is_snt_super: true }, { ...actor, company_id: null }, { ...actor, roles: ['SUPERVISOR'] }])(
    'only company administrators manage the company setting: %j', async user => {
      await expect(service.getPolicy(user)).rejects.toMatchObject({ status: 403 });
      await expect(service.updatePolicy(user, { enabled: true, expected_version: 0 })).rejects.toMatchObject({ status: 403 });
      expect(mockPool.query).not.toHaveBeenCalled(); expect(mockPool.connect).not.toHaveBeenCalled();
    });
  test.each([null, {}, { enabled: 'true', expected_version: 0 }, { enabled: true }, { enabled: true, expected_version: -1 },
    { enabled: true, expected_version: '1' }, { enabled: true, expected_version: 1.5 }])(
    'rejects malformed values before connecting: %j', async body => {
      await expect(service.updatePolicy(actor, body)).rejects.toMatchObject({ status: 400 }); expect(mockPool.connect).not.toHaveBeenCalled();
    });
  test('stale edits roll back with 409 instead of overwriting another administrator', async () => {
    mockClient.query.mockImplementation(async sql => /SELECT version/.test(sql) ? { rows: [{ version: 3 }] } : empty());
    await expect(service.updatePolicy(actor, { enabled: true, expected_version: 2 })).rejects.toMatchObject({ status: 409 });
    expect(calls().some(sql => /INSERT INTO/.test(sql))).toBe(false); expect(calls().at(-1)).toBe('ROLLBACK'); expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
  test('company writes lock the company, preserve unchanged activation and ignore a forged company id', async () => {
    mockPool.query.mockImplementation(async sql => /SELECT enabled/.test(sql) ? { rows: [{ enabled: true, version: 1, updated_at: 'now' }] } : { rows: [{ machines: 3 }] });
    expect((await service.updatePolicy(actor, { enabled: true, expected_version: 0, company_id: 99 })).enabled).toBe(true);
    expect(mockClient.query.mock.calls[1]).toEqual(['SELECT id FROM companies WHERE id=$1 FOR UPDATE', [4]]);
    const [sql, params] = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO alarm_notification_policies/.test(sql));
    expect(params).toEqual([4, true, 12]); expect(sql).toMatch(/IS DISTINCT FROM EXCLUDED.enabled/);
    expect(sql).toMatch(/ELSE alarm_notification_policies.enabled_since/); expect(calls().at(-1)).toBe('COMMIT');
  });
});
const event = extra => ({ id: '11', alarm_id: '91', company_id: 4, machine_id: 7, plant_id: 2, machine_serial_no: 'VMC-7',
  alarm_type: 'SPINDLE', alarm_code: 'SV401', message: "Controller's alarm", severity_class: 'critical',
  notification_delivered_priorities: [], enabled: true, eligible: true, fresh: true, ...extra });
function worker({ events = [], alarms = [], users = [{ id: 12, link: '/alarms' }], insertError } = {}) {
  mockClient.query.mockImplementation(async sql => {
    if (/FROM alarm_notification_events e JOIN/.test(sql)) return { rows: events };
    if (/SELECT a\.\*,a.id AS alarm_id/.test(sql)) return { rows: alarms };
    if (/WITH pages/.test(sql)) return { rows: users };
    if (/INSERT INTO notifications/.test(sql)) { if (insertError) throw insertError; return { rows: users.map(user => ({ user_id: user.id })) }; }
    return empty();
  });
}
describe('durable critical-only delivery', () => {
  test('a fresh critical event can notify after its three-second alarm cleared; unread follows commit', async () => {
    worker({ events: [event({ ended_at: 'already cleared' })] });
    mockAnnounce.mockImplementation(async () => { expect(calls().at(-1)).toBe('COMMIT'); expect(mockClient.release).toHaveBeenCalled(); });
    expect(await service.processDueAlarms()).toMatchObject({ checked: 1, delivered: 1, recipients: 1 });
    const [sql, params] = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO notifications/.test(sql));
    expect(sql).toMatch(/ON CONFLICT\(alarm_id,user_id,alarm_priority\)/); expect(params.slice(3)).toEqual(['91', 'critical', [12], ['/alarms']]);
    expect(params[2]).toContain("Controller's alarm"); expect(params[2]).not.toContain('Still active after');
    const eventSql = calls().find(sql => /FROM alarm_notification_events e JOIN/.test(sql));
    expect(eventSql).not.toMatch(/a.ended_at IS NULL/); expect(eventSql).toMatch(/INTERVAL '120 seconds'/);
    expect(eventSql).toMatch(/e.received_at>=p.enabled_since/); expect(eventSql).toMatch(/e.occurred_at>=date_trunc\('second',p.enabled_since\)/);
  });
  test.each([
    ['normal', event({ severity_class: 'noncritical' }), 'history'], ['information', event({ severity_class: 'info' }), 'history'],
    ['disabled', event({ enabled: false }), 'disabled_stale_or_inactive'], ['stale replay', event({ fresh: false }), 'disabled_stale_or_inactive'],
    ['inactive scope', event({ eligible: false }), 'disabled_stale_or_inactive']
  ])('%s produces no notification', async (_name, value, outcome) => {
    worker({ events: [value] }); expect(await service.processDueAlarms()).toMatchObject({ checked: 1, delivered: 0, progressed: 1 });
    expect(calls().some(sql => /INSERT INTO notifications/.test(sql))).toBe(false);
    expect(mockClient.query.mock.calls).toContainEqual(['UPDATE alarm_notification_events SET processed_at=NOW(),outcome=$2 WHERE id=$1', ['11', outcome]]);
  });
  test('critical escalation can notify after a historical normal delivery, but critical flapping cannot duplicate', async () => {
    worker({ events: [event({ notification_delivered_priorities: ['noncritical'] }), event({ id: '12' })] });
    expect(await service.processDueAlarms()).toMatchObject({ checked: 2, delivered: 1 }); expect(calls().filter(sql => /INSERT INTO notifications/.test(sql))).toHaveLength(1);
    worker({ events: [event({ notification_delivered_priorities: ['critical'] })] }); expect(await service.processDueAlarms()).toMatchObject({ delivered: 0 });
  });
  test('no eligible recipient leaves fresh work pending without a hot-loop progress signal', async () => {
    worker({ events: [event()], users: [] }); expect(await service.processDueAlarms()).toMatchObject({ checked: 1, delivered: 0, progressed: 0 });
    expect(calls().some(sql => /SET processed_at/.test(sql))).toBe(false);
    const sql = calls().find(sql => /WITH pages/.test(sql));
    expect(sql).toMatch(/COALESCE\(np.notify_alarm,TRUE\)/); expect(sql).toMatch(/u.plant_id=\$2/);
    expect(sql).toMatch(/cp.permission_id=p.id/); expect(sql).toMatch(/rp.permission_id=p.id/); expect(sql).toMatch(/r.company_id IS NULL/);
  });
  test('enabling alerts can notify a current critical alarm only after fresh confirmation; legacy delay rules do not drive delivery', async () => {
    worker({ alarms: [event({ id: '91' })] }); expect(await service.processDueAlarms({ batchSize: 999 })).toMatchObject({ delivered: 1 });
    const [sql, params] = mockClient.query.mock.calls.find(([sql]) => /SELECT a\.\*,a.id AS alarm_id/.test(sql));
    expect(params).toEqual([500]); expect(sql).toMatch(/a.ended_at IS NULL/); expect(sql).not.toMatch(/is_resolved/);
    expect(sql).toMatch(/p.enabled=TRUE/); expect(sql).toMatch(/IN\('CRITICAL','FATAL','EMERGENCY'\)/);
    expect(sql).toMatch(/observed.alarm=TRUE/); expect(sql).toMatch(/a.notification_priority_changed_at/);
    expect(sql).toMatch(/a.notification_continuity_started_at/); expect(sql).toMatch(/gap.resumed_at/);
    expect(sql).toMatch(/GREATEST\(a.started_at,p.enabled_since/); expect(sql).not.toMatch(/alarm_notification_rules|delay_seconds|alarm_notification_overrides/);
  });
  test('inbox failures roll back; socket failures cannot undo committed messages', async () => {
    worker({ events: [event()], insertError: new Error('database down') }); await expect(service.processDueAlarms()).rejects.toThrow('database down');
    expect(calls().at(-1)).toBe('ROLLBACK'); expect(mockAnnounce).not.toHaveBeenCalled();
    worker({ events: [event()] }); mockAnnounce.mockRejectedValueOnce(new Error('socket down'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {}); expect(await service.processDueAlarms()).toMatchObject({ delivered: 1 });
    expect(calls().at(-1)).toBe('COMMIT'); log.mockRestore();
  });
  test('bounded event retention preserves alarm history and durable deduplication', async () => {
    mockPool.query.mockResolvedValue({ rowCount: 12 }); expect(await service.pruneProcessedEvents()).toBe(12);
    const [sql] = mockPool.query.mock.calls[0]; expect(sql).toMatch(/INTERVAL '7 days'/); expect(sql).toMatch(/LIMIT 1000 FOR UPDATE SKIP LOCKED/);
    expect(sql).not.toMatch(/DELETE FROM machine_alarms|DELETE FROM notifications/);
  });
});
