const mockClient = {
  query: jest.fn(),
  release: jest.fn()
};
const mockPool = {
  query: jest.fn(),
  connect: jest.fn(async () => mockClient)
};
const mockAnnounce = jest.fn(async () => {}),
  mockDenial = jest.fn(async () => null);
jest.mock('../../src/db', () => mockPool);
jest.mock('../../src/middleware/access.middleware', () => ({
  denialFor: (...args) => mockDenial(...args)
}));
jest.mock('../../src/programs/jobs', () => ({
  ...jest.requireActual('../../src/programs/jobs'),
  announce: (...args) => mockAnnounce(...args)
}));
jest.mock('../../src/notifications/notification.service', () => ({
  announceUnread: jest.fn(async () => {})
}));
const service = require('../../src/programs/gateway.service');
const tokens = require('../../src/programs/gateway-token');
const actor = {
  id: 12,
  company_id: 4,
  plant_id: null,
  roles: ['COMPANY_ADMIN']
};
const gateway = {
  id: 2,
  company_id: 4,
  plant_id: 8,
  token_version: 1,
  max_concurrency: 2
};
const currentGateway = {
  ...gateway,
  is_active: true,
  token_hash: 'hashed-secret'
};
const baseJob = () => ({
  id: '91',
  company_id: 4,
  machine_id: 7,
  gateway_id: 2,
  gateway_token_version: 1,
  protocol_version: 3,
  lease_token: 'a'.repeat(64),
  status: 'DELIVERED',
  action: 'SEND',
  configuration_version: 1,
  expires_at: new Date(Date.now() + 60000),
  program_path: '/CNC',
  program_name: 'O1234.nc',
  file_id: '3',
  file_sha256: 'b'.repeat(64),
  file_size: 10,
  progress_bytes: 0,
  requested_by: 12,
  machine_serial: 'CNC7',
  command_parameters: {
    relative_path: '',
    controller_key: 'private-profile'
  },
  overwrite: false
});
const empty = () => ({
  rows: [],
  rowCount: 0
});
function worker(job = baseJob()) {
  mockClient.query.mockImplementation(async sql => {
    if (/SELECT g\.\*/.test(sql)) return {
      rows: [currentGateway]
    };
    if (/SELECT id FROM program_jobs WHERE id=/.test(sql)) return {
      rows: [{
        id: job.id
      }]
    };
    if (/SELECT j\.\*/.test(sql)) return {
      rows: [job]
    };
    if (/SELECT a.machine_id FROM program_gateway_assignments/.test(sql)) return {
      rows: [{
        machine_id: job.machine_id
      }]
    };
    if (/UPDATE program_jobs SET status=\$2/.test(sql)) {
      job.status = 'DONE';
      job.stage = 'DONE';
      return {
        rows: [],
        rowCount: 1
      };
    }
    if (/UPDATE program_jobs SET stage='NEEDS_RECONCILIATION'/.test(sql)) {
      job.stage = 'NEEDS_RECONCILIATION';
      return empty();
    }
    return empty();
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockClient.query.mockResolvedValue(empty());
  mockPool.query.mockResolvedValue(empty());
  mockPool.connect.mockResolvedValue(mockClient);
  mockDenial.mockResolvedValue(null);
});
test('gateway tokens are random, hashed and distinct from user and per-machine credentials', () => {
  const a = tokens.generate(),
    b = tokens.generate();
  expect(a.token).toMatch(/^mxg_[A-Za-z0-9_-]{43}$/);
  expect(a.hash).toBe(tokens.hash(a.token));
  expect(a.token).not.toBe(b.token);
  expect(tokens.fromRequest({
    headers: {
      authorization: 'Bearer ' + a.token
    }
  })).toBe(a.token);
  expect(tokens.fromRequest({
    headers: {
      authorization: 'Bearer mxd_' + a.token.slice(4)
    }
  })).toBeNull();
});
test.each(['../O1234.nc', 'folder/../O1234.nc', '/root/O1234.nc', 'C:\\CNC\\O1234.nc', 'folder\u0000file'])('controller paths stay relative to their configured directory: %j', path => {
  expect(() => service._internal.cleanPath(path)).toThrow();
});
test('operator and Socket.IO views never contain leases, token generation, profiles or disk source folders', () => {
  const source = baseJob();
  source.file_folder = 'private/storage';
  const safe = service._internal.view(source);
  expect(safe).not.toHaveProperty('lease_token');
  expect(safe).not.toHaveProperty('gateway_token_version');
  expect(safe).not.toHaveProperty('command_parameters');
  expect(safe).not.toHaveProperty('file_folder');
  expect(JSON.stringify(safe)).not.toContain('private-profile');
});
describe('server file browsing', () => {
  const file = { id: '3', company_id: 4, machine_id: 7, program_name: 'O1234.nc', size_bytes: 10 };
  function filesInScope() {
    mockPool.query.mockImplementation(async sql => {
      if (/SELECT m\.\*/.test(sql)) return { rows: [{ id: 7, company_id: 4, plant_id: 8 }] };
      if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ total: 43 }] };
      if (/SELECT \* FROM program_files/.test(sql)) return { rows: [file] };
      throw new Error('Unexpected file query');
    });
  }
  test.each([
    [{}, 'created_at DESC,id DESC'],
    [{ sort: 'name', direction: 'asc' }, 'program_name ASC,id ASC'],
    [{ sort: 'name', direction: 'desc' }, 'program_name DESC,id DESC'],
    [{ sort: 'size', direction: 'asc' }, 'size_bytes ASC,id ASC'],
    [{ sort: 'size', direction: 'desc' }, 'size_bytes DESC,id DESC'],
    [{ sort: 'date', direction: 'asc' }, 'created_at ASC,id ASC'],
    [{ sort: 'date', direction: 'desc' }, 'created_at DESC,id DESC']
  ])('sorts all matching pages deterministically: %j', async (query, order) => {
    filesInScope();
    const result = await service.listFiles({ user: actor, query: { machine_id: '7', page: '3', limit: '20', ...query } });
    expect(result).toEqual({ data: [file], total: 43, page: 3, limit: 20 });
    const [sql, values] = mockPool.query.mock.calls.find(([text]) => /SELECT \* FROM program_files/.test(text));
    expect(sql).toContain(`ORDER BY ${order} LIMIT $5 OFFSET $6`);
    expect(values).toEqual([4, 7, null, null, 20, 40]);
  });
  test.each([
    [{ sort: 'name; DROP TABLE program_files' }, 'BAD_SORT'],
    [{ sort: 'constructor' }, 'BAD_SORT'],
    [{ sort: ['name'] }, 'BAD_SORT'],
    [{ sort: { name: true } }, 'BAD_SORT'],
    [{ direction: 'asc NULLS FIRST' }, 'BAD_DIRECTION'],
    [{ direction: 'DESC' }, 'BAD_DIRECTION'],
    [{ direction: ['asc'] }, 'BAD_DIRECTION']
  ])('rejects non-allowlisted sort input before database work: %j', async (query, code) => {
    await expect(service.listFiles({ user: actor, query: { machine_id: '7', ...query } })).rejects.toMatchObject({ status: 400, code });
    expect(mockPool.query).not.toHaveBeenCalled();
  });
  test('file search is literal, parameterized, company/machine scoped and plant checked before sorting', async () => {
    filesInScope();
    const search = String.raw`part%_\' OR 1=1 --`;
    const expectedSearch = String.raw`%part\%\_\\' OR 1=1 --%`;
    await service.listFiles({ user: { ...actor, roles: ['OPERATOR'], plant_id: 8 }, query: { machine_id: '7', company_id: '99', search, kind: 'backup', sort: 'name', direction: 'asc' } });
    expect(mockPool.query.mock.calls[0][1]).toEqual([7, 4, 8]);
    const fileQueries = mockPool.query.mock.calls.filter(([sql]) => /FROM program_files/.test(sql));
    expect(fileQueries).toHaveLength(2);
    for (const [sql, values] of fileQueries) {
      expect(sql).toContain('company_id=$1 AND machine_id=$2 AND deleted_at IS NULL');
      expect(sql).toContain('program_name ILIKE $4');
      expect(sql).not.toContain(search);
      expect(values.slice(0, 4)).toEqual([4, 7, 'BACKUP', expectedSearch]);
    }
  });
  test('an unavailable or out-of-scope machine does not list or count its files', async () => {
    await expect(service.listFiles({ user: actor, query: { machine_id: '99', sort: 'name', direction: 'asc' } })).rejects.toMatchObject({ status: 404, code: 'MACHINE_NOT_FOUND' });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][1]).toEqual([99, 4, null]);
  });
});
test.each(['SEND', 'RESTORE'])('%s requires explicit true write confirmation before database work', async action => {
  await expect(service.createCommand({
    user: actor,
    headers: {
      'idempotency-key': 'request-key-123456'
    },
    params: {
      machineId: 7
    },
    body: {
      confirm: 'true',
      file_id: 3
    }
  }, action)).rejects.toMatchObject({
    code: 'CONFIRMATION_REQUIRED'
  });
  expect(mockPool.connect).not.toHaveBeenCalled();
});
test('company and role permissions are checked again for retryable controller actions', async () => {
  mockDenial.mockResolvedValue('COMPANY');
  await expect(service.createCommand({
    user: actor,
    body: {
      confirm: true
    }
  }, 'SEND')).rejects.toMatchObject({
    status: 403,
    code: 'NOT_IN_PLAN'
  });
  expect(mockPool.connect).not.toHaveBeenCalled();
});
test('an embedded-team adapter can be assigned without claiming a controller protocol', async () => {
  mockClient.query.mockImplementation(async sql => {
    if (/SELECT g\.\*/.test(sql)) return { rows: [currentGateway] };
    if (/SELECT m\.\*/.test(sql)) return { rows: [{ id: 7, company_id: 4, plant_id: 8, machine_serial_no: 'CNC7' }] };
    return empty();
  });
  await expect(service.saveAssignment({ user: actor, params: { machineId: 7 }, body: {
    gateway_id: 2, protocol: 'embedded', controller_key: 'embedded-machine-7', program_path: 'C:\\CNC'
  } })).resolves.toHaveProperty('machine.id', 7);
  const insert = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO program_gateway_assignments/.test(sql));
  expect(insert[1]).toEqual([4,7,2,'embedded-machine-7','embedded','C:\\CNC',12]);
});
test.each([
  [null, 'embedded', 'machine-7'],
  [{ protocol: 'sftp', controller_key: 'existing-cnc-profile' }, 'sftp', 'existing-cnc-profile']
])('simple gateway/path setup defaults new profiles and preserves existing CNC mapping (%j)', async (previous, protocol, key) => {
  mockClient.query.mockImplementation(async sql => {
    if (/SELECT g\.\*/.test(sql)) return { rows: [currentGateway] };
    if (/SELECT m\.\*/.test(sql)) return { rows: [{ id: 7, company_id: 4, plant_id: 8, machine_serial_no: 'CNC7' }] };
    if (/SELECT protocol,controller_key/.test(sql)) return { rows: previous ? [previous] : [] };
    return empty();
  });
  await service.saveAssignment({ user: actor, params: { machineId: 7 }, body: { gateway_id: 2, program_path: '/PROGRAMS' } });
  const insert = mockClient.query.mock.calls.find(([sql]) => /INSERT INTO program_gateway_assignments/.test(sql));
  expect(insert[1]).toEqual([4,7,2,key,protocol,'/PROGRAMS',12]);
});
test('wrong gateway token generation or lease cannot download controller source files', async () => {
  worker();
  await expect(service.jobFile(gateway, 91, 'wrong')).rejects.toMatchObject({
    code: 'LEASE_INVALID'
  });
  worker();
  await expect(service.jobFile({
    ...gateway,
    token_version: 0
  }, 91, 'a'.repeat(64))).rejects.toMatchObject({
    code: 'GATEWAY_TOKEN_INVALID'
  });
});
test('current assignment is rechecked for each command request', async () => {
  worker();
  mockClient.query.mockImplementation(async sql => /SELECT g\.\*/.test(sql) ? {
    rows: [currentGateway]
  } : /SELECT id FROM program_jobs/.test(sql) ? {
    rows: [{
      id: 91
    }]
  } : /SELECT j\.\*/.test(sql) ? {
    rows: [baseJob()]
  } : empty());
  await expect(service.jobFile(gateway, 91, 'a'.repeat(64))).rejects.toMatchObject({
    code: 'ASSIGNMENT_CHANGED'
  });
});
test.each([{}, {
  verified: true
}, {
  verified: true,
  safety_checked: true,
  sha256: '0'.repeat(64),
  replaced: false
}])('write success refuses incomplete or incorrect read-back proof: %j', async proof => {
  worker();
  await expect(service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'DONE',
    ...proof
  })).rejects.toMatchObject({
    code: 'WRITE_NOT_VERIFIED'
  });
  expect(mockAnnounce).not.toHaveBeenCalled();
});
test('an authorized overwrite still requires its actual pre-overwrite backup', async () => {
  worker({
    ...baseJob(),
    overwrite: true
  });
  await expect(service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'DONE',
    verified: true,
    safety_checked: true,
    sha256: 'b'.repeat(64),
    replaced: true
  })).rejects.toMatchObject({
    code: 'BACKUP_REQUIRED'
  });
});
test('successful writes audit and commit before emitting only a safe status view', async () => {
  worker();
  mockAnnounce.mockImplementation(async value => {
    expect(mockClient.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    expect(value).not.toHaveProperty('lease_token');
    expect(value).not.toHaveProperty('gateway_token_version');
  });
  const result = await service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'DONE',
    verified: true,
    safety_checked: true,
    sha256: 'b'.repeat(64),
    replaced: false
  });
  expect(result.job.status).toBe('DONE');
  expect(mockClient.query.mock.calls.some(([sql]) => /INSERT INTO program_gateway_events/.test(sql))).toBe(true);
});
test('an expired or ambiguous write blocks the machine until controller reconciliation', async () => {
  worker({
    ...baseJob(),
    expires_at: new Date(Date.now() - 1000)
  });
  const result = await service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'FAILED',
    error_code: 'NETWORK_LOST',
    message: 'No controller response',
    write_started: true
  });
  expect(result.job.status).toBe('DELIVERED');
  expect(result.job.stage).toBe('NEEDS_RECONCILIATION');
});
test('an unknown write cannot be reset by ordinary progress or a later no-write claim', async () => {
  worker({ ...baseJob(), stage: 'NEEDS_RECONCILIATION', error_code: 'WRITE_STATE_UNKNOWN' });
  await expect(service.progress(gateway, 91, {
    lease_token: 'a'.repeat(64), stage: 'UPLOADING', bytes: 0
  })).rejects.toMatchObject({ code: 'WRITE_RECONCILIATION_REQUIRED' });
  const result = await service.result(gateway, 91, {
    lease_token: 'a'.repeat(64), status: 'FAILED', error_code: 'NETWORK_LOST',
    message: 'Controller did not respond', write_started: false
  });
  expect(result.job.status).toBe('DELIVERED');
  expect(result.job.stage).toBe('NEEDS_RECONCILIATION');
});
test('a verified reconciliation can safely close an unknown write', async () => {
  worker({ ...baseJob(), stage: 'NEEDS_RECONCILIATION', error_code: 'WRITE_STATE_UNKNOWN' });
  const result = await service.result(gateway, 91, {
    lease_token: 'a'.repeat(64), status: 'DONE', verified: true, reconciled: true,
    safety_checked: true, sha256: 'b'.repeat(64), replaced: false
  });
  expect(result.job.status).toBe('DONE');
});
test('a duplicate success cannot rewrite whether a controller file was replaced', async () => {
  worker({ ...baseJob(), status: 'DONE', result_json: { replaced: true } });
  await expect(service.result(gateway, 91, {
    lease_token: 'a'.repeat(64), status: 'DONE', verified: true,
    safety_checked: true, sha256: 'b'.repeat(64), replaced: false
  })).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
});
test('a gateway cannot claim a backup succeeded without sending actual controller bytes', async () => {
  worker({
    ...baseJob(),
    action: 'BACKUP',
    file_id: null
  });
  await expect(service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'DONE'
  })).rejects.toMatchObject({
    code: 'CAPTURE_REQUIRED'
  });
  await expect(service.capture(gateway, 91, {
    type: 'CURRENT',
    program_name: 'O1234.nc',
    sha256: 'b'.repeat(64)
  }, {
    path: '/unused'
  })).rejects.toMatchObject({
    code: 'CURRENT_PROGRAM_UNKNOWN'
  });
});
test('progress is bounded and cannot move backwards or revive an expired lease', async () => {
  worker({
    ...baseJob(),
    stage: 'DOWNLOADING',
    progress_bytes: 20
  });
  await expect(service.progress(gateway, 91, {
    lease_token: 'a'.repeat(64),
    stage: 'DOWNLOADING',
    bytes: 10,
    total: 100
  })).rejects.toMatchObject({
    code: 'BAD_PROGRESS'
  });
  worker({
    ...baseJob(),
    expires_at: new Date(Date.now() - 1000)
  });
  await expect(service.progress(gateway, 91, {
    lease_token: 'a'.repeat(64),
    stage: 'DOWNLOADING',
    bytes: 10,
    total: 100
  })).rejects.toMatchObject({
    code: 'LEASE_EXPIRED'
  });
});
test('LIST rejects traversal and excessive directory entries instead of trusting controller output', async () => {
  worker({
    ...baseJob(),
    action: 'LIST'
  });
  await expect(service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'DONE',
    path: '',
    listing: [{
      name: '../private',
      size: 1
    }]
  })).rejects.toMatchObject({
    code: 'BAD_LIST'
  });
  worker({
    ...baseJob(),
    action: 'LIST'
  });
  await expect(service.result(gateway, 91, {
    lease_token: 'a'.repeat(64),
    status: 'DONE',
    path: '',
    listing: Array.from({
      length: 2001
    }, () => ({
      name: 'O1.nc'
    }))
  })).rejects.toMatchObject({
    code: 'BAD_LIST'
  });
});
test('long polling validates bounds and an aborted caller never waits on a database connection', async () => {
  await expect(service.claim(gateway, {
    wait_seconds: 25
  })).rejects.toMatchObject({
    code: 'BAD_WAIT'
  });
  const abort = new AbortController();
  abort.abort();
  expect(await service.claim(gateway, {
    wait_seconds: 24
  }, abort.signal)).toEqual({
    job: null,
    poll_seconds: 15
  });
  expect(mockPool.connect).not.toHaveBeenCalled();
});
test('timeouts fail uncollected commands and read-only work while keeping uncertain writes blocked', async () => {
  const stale = [
    { ...baseJob(), id: '91', status: 'QUEUED' },
    { ...baseJob(), id: '92', action: 'BACKUP' },
    { ...baseJob(), id: '93', action: 'RESTORE' }
  ];
  mockClient.query.mockImplementation(async (sql, values) => {
    if (/SELECT j.id,j.company_id/.test(sql)) return { rows: stale };
    if (/UPDATE program_jobs SET status='FAILED'/.test(sql)) {
      Object.assign(stale.find(j => j.id === values[0]), { status: 'FAILED', error_code: values[1] });
    }
    if (/UPDATE program_jobs SET stage='NEEDS_RECONCILIATION'/.test(sql)) {
      Object.assign(stale.find(j => j.id === values[0]), { stage: 'NEEDS_RECONCILIATION', error_code: 'WRITE_STATE_UNKNOWN' });
    }
    if (/SELECT j\.\*/.test(sql)) return { rows: [stale.find(j => j.id === values[0])] };
    return empty();
  });
  mockAnnounce.mockImplementation(async () => expect(mockClient.query.mock.calls.at(-1)[0]).toBe('COMMIT'));
  expect(await service.expireStale({ gatewayId: 2 })).toBe(3);
  expect(stale[0]).toMatchObject({ status: 'FAILED', error_code: 'QUEUE_TIMEOUT' });
  expect(stale[1]).toMatchObject({ status: 'FAILED', error_code: 'GATEWAY_TIMEOUT' });
  expect(stale[2]).toMatchObject({ status: 'DELIVERED', stage: 'NEEDS_RECONCILIATION', error_code: 'WRITE_STATE_UNKNOWN' });
  expect(service._internal.descriptor(stale[2]).recovery_only).toBe(true);
  expect(mockAnnounce).toHaveBeenCalledTimes(3);
  const sweep = mockClient.query.mock.calls.find(([sql]) => /SELECT j.id,j.company_id/.test(sql));
  expect(sweep[0]).toContain('FOR UPDATE OF j SKIP LOCKED');
  expect(sweep[0]).toContain("IS NOT DISTINCT FROM 'WRITE_STATE_UNKNOWN'");
  expect(sweep[1]).toEqual([2,null,100]);
});
test('an unsuccessful timeout transaction cannot announce uncommitted failures', async () => {
  mockClient.query.mockImplementation(async sql => {
    if (/SELECT j.id,j.company_id/.test(sql)) return { rows: [{ ...baseJob(), status: 'QUEUED' }] };
    if (/INSERT INTO program_gateway_events/.test(sql)) throw new Error('audit unavailable');
    return empty();
  });
  await expect(service.expireStale()).rejects.toThrow('audit unavailable');
  expect(mockAnnounce).not.toHaveBeenCalled();
  expect(mockClient.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
});
test.each([['audit failure', false], ['connection loss during COMMIT', true]])('upload cleanup preserves only files whose commit is uncertain: %s', async (_description, commitFailure) => {
  const storage = require('../../src/programs/storage');
  const saved = { folder: 'company-4/programs/machine-7/uploads', storedName: 'saved.nc', programName: 'O1234.nc', size: 10, sha256: 'b'.repeat(64) };
  const save = jest.spyOn(storage, 'saveStream').mockResolvedValue(saved);
  const remove = jest.spyOn(storage, 'remove').mockResolvedValue();
  const m = { id: 7, company_id: 4, plant_id: 8, machine_serial_no: 'CNC7' };
  mockPool.query.mockResolvedValue({ rows: [m] });
  mockClient.query.mockImplementation(async sql => {
    if (/SELECT m\.\*/.test(sql)) return { rows: [m] };
    if (/INSERT INTO program_files/.test(sql)) return { rows: [{ id: '9', program_name: saved.programName, size_bytes: saved.size, sha256: saved.sha256 }] };
    if (sql === 'COMMIT' && commitFailure || /INSERT INTO program_gateway_events/.test(sql) && !commitFailure) throw new Error('database unavailable');
    return empty();
  });
  try {
    await expect(service.upload({ user: actor, params: { machineId: 7 }, headers: { 'idempotency-key': 'request-key-123456' },
      file: { path: '/staging.nc', originalname: 'O1234.nc' } })).rejects.toThrow('database unavailable');
    if (commitFailure) expect(remove).not.toHaveBeenCalled();
    else expect(remove).toHaveBeenCalledWith(saved.folder, saved.storedName);
  } finally { save.mockRestore(); remove.mockRestore(); }
});
