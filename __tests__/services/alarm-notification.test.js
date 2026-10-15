const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPool = { query: jest.fn(), connect: jest.fn(async () => mockClient) };
const mockAnnounce = jest.fn(async () => {});
jest.mock('../../src/db', () => mockPool);
jest.mock('../../src/notifications/notification.service', () => ({ announceUnread: (...args) => mockAnnounce(...args) }));

const service = require('../../src/alarms/alarm-notification.service');
const actor = { id: 12, company_id: 4, roles: ['COMPANY_ADMIN'] };
const machine = { id: 7, machine_serial_no: 'VMC-7', plant_name: 'Plant A' };
const alarm = { id: '91', company_id: 4, machine_id: 7, machine_serial_no: 'VMC-7', plant_id: 2,
  alarm_type: 'SPINDLE', alarm_code: 'SV401', message: "Controller's alarm", delay_seconds: 30 };
const empty = () => ({ rows: [], rowCount: 0 });
const sqlCalls = () => mockClient.query.mock.calls.map(([sql]) => sql);

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.connect.mockResolvedValue(mockClient);
  mockPool.query.mockResolvedValue(empty());
  mockClient.query.mockImplementation(async () => empty());
  mockAnnounce.mockResolvedValue(undefined);
});

describe('explicit per-machine alarm rules', () => {
  test('includes active machines without rules, disabled with a ten-minute default, with bounded pagination', async () => {
    mockPool.query.mockImplementation(async sql => /COUNT/.test(sql)
      ? { rows: [{ total: 3 }] } : { rows: [{ machine_id: 7, enabled: false, delay_seconds: 600 }] });
    const result = await service.getRules(actor, { page: '2', limit: '999', search: 'VMC_50%' });
    expect(result.pagination).toEqual({ page: 2, limit: 50, total: 3, totalPages: 1 });
    expect(result.data[0]).toEqual({ machine_id: 7, enabled: false, delay_seconds: 600 });
    for (const [sql, params] of mockPool.query.mock.calls) {
      expect(sql).toMatch(/m.company_id = \$1 AND m.is_active = TRUE/);
      expect(sql).toMatch(/LEFT JOIN alarm_notification_rules/);
      expect(params[0]).toBe(4);
      expect(params[1]).toBe('%VMC\\_50\\%%');
    }
    expect(mockPool.query.mock.calls[1][1].slice(-2)).toEqual([50, 50]);
  });

  test.each([
    {}, { ...actor, is_snt_super: true }, { ...actor, company_id: null },
    { ...actor, roles: ['SUPERVISOR'] }
  ])('non-company administrators cannot read or save rules: %j', async user => {
    await expect(service.getRules(user)).rejects.toMatchObject({ status: 403 });
    await expect(service.updateRule(user, 7, { enabled: true, delay_seconds: 30 })).rejects.toMatchObject({ status: 403 });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test.each([{ page: 'abc' }, { limit: 0 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER }, { search: [] }, { search: 'a'.repeat(101) }])(
    'invalid filters are rejected before SQL: %j', async query => {
      await expect(service.getRules(actor, query)).rejects.toMatchObject({ status: 400 });
      expect(mockPool.query).not.toHaveBeenCalled();
    }
  );

  test.each([
    { enabled: 'true', delay_seconds: 30 }, { enabled: true, delay_seconds: '30' },
    { enabled: true, delay_seconds: 0 }, { enabled: true, delay_seconds: 86401 },
    { enabled: true, delay_seconds: 1.5 }, { enabled: false }, null
  ])('invalid writes cannot coerce booleans or silently reset timing: %j', async body => {
    await expect(service.updateRule(actor, 7, body)).rejects.toMatchObject({ status: 400 });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('save uses the authenticated company and locks the machine; timing restarts only when values change', async () => {
    mockClient.query.mockImplementation(async sql => {
      if (/SELECT m.id/.test(sql)) return { rows: [machine] };
      if (/INSERT INTO alarm_notification_rules/.test(sql)) return { rows: [{ enabled: true, delay_seconds: 60 }] };
      return empty();
    });
    const result = await service.updateRule(actor, '7', { enabled: true, delay_seconds: 60, company_id: 99 });
    expect(result).toEqual({ machine_id: 7, machine_serial_no: 'VMC-7', plant_name: 'Plant A', enabled: true, delay_seconds: 60 });
    const lock = mockClient.query.mock.calls.find(([sql]) => /SELECT m.id/.test(sql));
    expect(lock[0]).toMatch(/m.company_id = \$2.*FOR SHARE OF m/);
    expect(lock[1]).toEqual([7, 4]);
    const insert = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO alarm_notification_rules/.test(sql));
    expect(insert[1]).toEqual([4, 7, true, 60, 12]);
    expect(insert[0]).toMatch(/IS DISTINCT FROM EXCLUDED.enabled/);
    expect(insert[0]).toMatch(/IS DISTINCT FROM EXCLUDED.delay_seconds/);
    expect(insert[0]).toMatch(/ELSE alarm_notification_rules.enabled_since END/);
    expect(sqlCalls().at(-1)).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('an inactive or foreign machine produces 404 and rolls back', async () => {
    await expect(service.updateRule(actor, 99, { enabled: true, delay_seconds: 600 })).rejects.toMatchObject({ status: 404 });
    expect(sqlCalls().at(-1)).toBe('ROLLBACK');
    expect(sqlCalls().some(sql => /INSERT INTO alarm_notification_rules/.test(sql))).toBe(false);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

function workerQueries({ users = [{ id: 12, link: '/alarms' }], insertError } = {}) {
  mockClient.query.mockImplementation(async sql => {
    if (/SELECT a.id/.test(sql)) return { rows: [alarm] };
    if (/WITH pages/.test(sql)) return { rows: users };
    if (/INSERT INTO notifications/.test(sql)) {
      if (insertError) throw insertError;
      return { rows: users.map(user => ({ user_id: user.id })) };
    }
    return empty();
  });
}

describe('durable sustained-alarm delivery', () => {
  test('requires a fresh accepted observation after the duration, rule enable and latest observation gap', async () => {
    await service.processDueAlarms({ batchSize: 999 });
    const [sql, params] = mockClient.query.mock.calls.find(([text]) => /SELECT a.id/.test(text));
    expect(params).toEqual([500]);
    expect(sql).toMatch(/a.ended_at IS NULL AND a.notification_sent_at IS NULL/);
    expect(sql).not.toMatch(/is_resolved/);
    expect(sql).toMatch(/m.company_id = a.company_id AND m.is_active = TRUE/);
    expect(sql).toMatch(/c.is_active = TRUE/);
    expect(sql).toMatch(/m.plant_id IS NULL OR EXISTS/);
    expect(sql).toMatch(/plant.company_id = m.company_id AND plant.is_active = TRUE/);
    expect(sql).toMatch(/t.received_at >= NOW\(\) - INTERVAL '120 seconds'/);
    expect(sql).toMatch(/observed.device_time >= EXTRACT/);
    expect(sql).toMatch(/observed.device_time <= EXTRACT\(EPOCH FROM NOW\(\)\)/);
    expect(sql).toMatch(/observed.alarm = TRUE/);
    expect(sql).toMatch(/GREATEST\(a.started_at, r.enabled_since, gap.resumed_at, a.notification_continuity_started_at\)\s*\+ make_interval\(secs => r.delay_seconds\)/);
    expect(sql).toMatch(/FOR UPDATE OF a SKIP LOCKED FOR SHARE OF r, m, c SKIP LOCKED/);
    expect(sql).toMatch(/ORDER BY a.notification_checked_at NULLS FIRST/);
    expect(mockAnnounce).not.toHaveBeenCalled();
    expect(sqlCalls().at(-1)).toBe('COMMIT');
  });

  test('inserts deduplicated recipients and marks the occurrence atomically before live announcements', async () => {
    workerQueries();
    mockAnnounce.mockImplementation(async ids => {
      expect(sqlCalls().at(-1)).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(ids).toEqual([12]);
    });
    await expect(service.processDueAlarms()).resolves.toEqual({ checked: 1, delivered: 1, recipients: 1 });
    const [sql, params] = mockClient.query.mock.calls.find(([text]) => /INSERT INTO notifications/.test(text));
    expect(sql).toMatch(/ON CONFLICT \(alarm_id, user_id\) WHERE alarm_id IS NOT NULL DO NOTHING/);
    expect(params[0]).toBe(4);
    expect(params[2]).toContain("Controller's alarm");
    expect(params[2]).toContain('30 seconds');
    expect(params.slice(3)).toEqual(['91', [12], ['/alarms']]);
    expect(sqlCalls()).toContain('UPDATE machine_alarms SET notification_sent_at = NOW() WHERE id = $1');
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
  });

  test('matches current plant, personal preference, owned roles and the same company-granted page', async () => {
    workerQueries();
    await service.processDueAlarms();
    const [sql, params] = mockClient.query.mock.calls.find(([text]) => /WITH pages/.test(text));
    expect(params).toEqual([4, 2]);
    expect(sql).toMatch(/u.company_id = \$1 AND u.is_active = TRUE AND COALESCE\(np.notify_alarm, TRUE\)/);
    expect(sql).toMatch(/u.plant_id IS NULL OR u.plant_id = \$2/);
    expect(sql).toMatch(/r.company_id IS NULL AND r.role_name IN \('COMPANY_ADMIN', 'ADMIN'\)/);
    expect(sql).toMatch(/r.company_id IS NULL OR r.company_id = u.company_id/);
    expect(sql).toMatch(/cp.permission_id = p.id/);
    expect(sql).toMatch(/rp.permission_id = p.id/);
  });

  test('no eligible recipient does not mark delivered and moves behind unchecked occurrences', async () => {
    workerQueries({ users: [] });
    await expect(service.processDueAlarms()).resolves.toEqual({ checked: 1, delivered: 0, recipients: 0 });
    expect(sqlCalls()).toContain('UPDATE machine_alarms SET notification_checked_at = NOW() WHERE id = $1');
    expect(sqlCalls().some(sql => /SET notification_sent_at/.test(sql))).toBe(false);
    expect(sqlCalls().some(sql => /INSERT INTO notifications/.test(sql))).toBe(false);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  test('an inbox failure rolls back its delivery marker and never announces', async () => {
    workerQueries({ insertError: new Error('database unavailable') });
    await expect(service.processDueAlarms()).rejects.toThrow('database unavailable');
    expect(sqlCalls().at(-1)).toBe('ROLLBACK');
    expect(sqlCalls().some(sql => /SET notification_sent_at/.test(sql))).toBe(false);
    expect(mockAnnounce).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('socket failure leaves the durable inbox committed', async () => {
    workerQueries();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockAnnounce.mockRejectedValue(new Error('socket unavailable'));
    await expect(service.processDueAlarms()).resolves.toMatchObject({ delivered: 1 });
    expect(sqlCalls().at(-1)).toBe('COMMIT');
    expect(sqlCalls()).not.toContain('ROLLBACK');
    log.mockRestore();
  });
});
