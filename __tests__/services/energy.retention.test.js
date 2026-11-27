'use strict';

jest.mock('../../src/dashboard/cache', () => ({ touch: jest.fn() }));
const job = require('../../src/cron/energyRetention.job');
const start = '2026-11-20 12:30:00.000125+00';
const end = '2026-11-20 13:30:00.000125+00';
const policy = { company_id: 4, from_at: start, through_at: end };

const retentionVersion = '2026-11-26 12:30:00.000125+00';
function fixture({ policies = [policy], lock = true, active = true, extension = true, fail = null,
  previousRefresh = [], duringRefresh = null } = {}) {
  const calls = [];
  const refreshQueue = new Map(previousRefresh.map(row => [row.machine_id,{...row}]));
  let refreshed = false;
  const client = { release: jest.fn(), query: jest.fn(async (sql, params = []) => {
    calls.push({ sql, params });
    if (fail && fail(sql)) throw Object.assign(new Error('retry'), { code: 'XX000' });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: lock }] };
    if (sql.includes('FROM energy_history_policy WHERE enabled')) return { rows: policies };
    if (sql.includes('FROM energy_history_policy') && sql.includes('FOR UPDATE')) return { rows: active ? [{ company_id: 4 }] : [] };
    if (sql.includes('SELECT machine_id FROM energy_meter_latest')) return { rows: [{ machine_id: 7 }] };
    if (sql.startsWith('SELECT machine_id,') && sql.includes('FROM energy_refresh_queue')) {
      return { rows: [...refreshQueue.values()].map(row=>({...row})) };
    }
    if (sql.startsWith('INSERT INTO energy_refresh_queue')) {
      const old = refreshQueue.get(7);
      refreshQueue.set(7,{machine_id:7,
        from_at:old && Date.parse(old.from_at)<Date.parse(start)?old.from_at:start,
        through_at:old && Date.parse(old.through_at)>Date.parse(end)?old.through_at:end,
        version:retentionVersion,last_error:old?.last_error??null});
      return {rows:[{machine_id:7,retention_version:retentionVersion}],rowCount:1};
    }
    if (sql.startsWith('CALL ') && !refreshed) {
      refreshed = true;
      duringRefresh?.(refreshQueue);
    }
    if (sql.startsWith('UPDATE energy_refresh_queue SET from_at=')) {
      const row = refreshQueue.get(params[1]);
      if (!row || row.version!==params[6])return {rows:[],rowCount:0};
      refreshQueue.set(params[1],{machine_id:params[1],from_at:params[2],through_at:params[3],version:params[4],last_error:params[5]});
      return {rows:[],rowCount:1};
    }
    if (sql.startsWith('DELETE FROM energy_refresh_queue')) {
      const row=refreshQueue.get(params[1]);
      if (!row || row.version!==params[2])return {rows:[],rowCount:0};
      refreshQueue.delete(params[1]);return {rows:[],rowCount:1};
    }
    if (sql.includes('FROM pg_extension')) return { rows: extension ? [{ extversion: '2.19.3' }] : [] };
    return { rows: [], rowCount: 2 };
  }) };
  const pool = { connect: jest.fn(async () => client) };
  return { client, pool, calls, refreshQueue };
}

beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-26T12:30:00Z')));
test('manual retention can select exactly one company and rejects an invalid owner',async()=>{
  const f=fixture({policies:[]});
  await job.run({pool:f.pool,companyId:4,touchCache:false});
  const selection=f.calls.find(q=>q.sql.includes('FROM energy_history_policy WHERE enabled'));
  expect(selection.sql).toContain('AND company_id=$3');
  expect(selection.params).toEqual([10,3600000,4]);
  await expect(job.run({pool:f.pool,companyId:0})).rejects.toThrow('positive integer');
});
afterEach(() => jest.useRealTimers());

test('an inert or absent initial policy watermark never triggers historical deletion', async () => {
  const f = fixture({ policies: [] });
  expect(await job.run({ pool: f.pool })).toEqual({ policies: 0, sweeps: [], errors: [] });
  expect(f.calls.find(q => q.sql.includes('FROM energy_history_policy WHERE enabled')).sql)
    .toContain('COALESCE(last_swept_at,retained_from) < energy_history_cutoff(company_id)');
  expect(f.calls.some(q => /^(DELETE|UPDATE) (telemetry_raw|energy_meter_readings)/.test(q.sql))).toBe(false);
  expect(f.client.release).toHaveBeenCalledTimes(1);
});

test('a reconcile worker or maintenance lock holder prevents any retention work', async () => {
  const f = fixture({ lock: false });
  await job.run({ pool: f.pool });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].sql).toContain("hashtext('cron:energy-reconcile')");
  expect(f.client.release).toHaveBeenCalled();
});

test('retiring one company and one bounded window preserves CNC and production records', async () => {
  const f = fixture();
  const result = await job.run({ pool: f.pool, touchCache: false });
  expect(result.policies).toBe(1);
  expect(result.errors).toEqual([]);
  const source = f.calls.filter(q => /^(DELETE FROM|UPDATE) (energy_meter_readings|energy_counter_intervals|telemetry_raw|production_hourly|ingest_gaps|telemetry_late)\b/.test(q.sql));
  expect(source).toHaveLength(6);
  for (const { sql, params } of source) {
    expect(sql).toContain('company_id=$1');
    expect(params).toEqual([4, start, end]); // Preserve PostgreSQL sub-millisecond boundaries.
  }
  expect(source.find(q => q.sql.startsWith('UPDATE telemetry_raw')).sql).toContain('SET energy=NULL,voltage=NULL,current=NULL,power=NULL');
  expect(source.find(q => q.sql.startsWith('UPDATE telemetry_raw')).sql).toContain('COALESCE(to_timestamp(device_time),received_at) < $3');
  expect(source.find(q => q.sql.startsWith('UPDATE production_hourly')).sql).toContain("hour_start < $3");
  expect(source.find(q => q.sql.startsWith('UPDATE telemetry_late')).sql).toContain('payload=energy_strip_payload(payload)');
  expect(source.find(q => q.sql.startsWith('UPDATE telemetry_late')).sql).toContain('COALESCE(to_timestamp(device_time),received_at) >= $2');
  expect(source.find(q => q.sql.startsWith('UPDATE telemetry_late')).sql).not.toContain('received_at >= $2');
  expect(f.calls.some(q => /^DELETE FROM (telemetry_raw|production_hourly|telemetry_late|ingest_gaps)\b/.test(q.sql))).toBe(false);
  const latestLock = f.calls.findIndex(q => q.sql.includes('pg_advisory_xact_lock'));
  const latestUpdate = f.calls.findIndex(q => q.sql.startsWith('UPDATE energy_meter_latest'));
  expect(latestLock).toBeLessThan(latestUpdate);
  expect(f.calls[latestLock].params).toEqual(['energy-latest:4:7']);
});

test('source cleanup commits before public refresh and the watermark advances only after all refreshes succeed', async () => {
  const f = fixture();
  await job.run({ pool: f.pool, touchCache: false });
  const commit = f.calls.findIndex(q => q.sql === 'COMMIT');
  const refresh = f.calls.flatMap((q, index) => q.sql.startsWith('CALL refresh_continuous_aggregate') ? [index] : []);
  const advance = f.calls.findIndex(q => q.sql.startsWith('UPDATE energy_history_policy SET last_swept_at'));
  expect(refresh).toHaveLength(3); // The open November monthly aggregate remains a real-time source tail.
  expect(commit).toBeLessThan(refresh[0]);
  expect(refresh.at(-1)).toBeLessThan(advance);
  expect(f.calls.some(q => q.sql.includes('_timescaledb_internal'))).toBe(false);
});

test('a compressed aggregate refresh failure leaves invalidation durable and does not advance the watermark', async () => {
  const f = fixture({ fail: sql => sql.startsWith("CALL refresh_continuous_aggregate('energy_counter_daily'") });
  const result = await job.run({ pool: f.pool, touchCache: false });
  expect(result.errors).toEqual([{ company_id: 4, code: 'XX000' }]);
  expect(f.calls.some(q => q.sql === 'COMMIT')).toBe(true);
  expect(f.calls.some(q => q.sql.startsWith('INSERT INTO energy_refresh_queue'))).toBe(true);
  expect(f.calls.some(q => q.sql.startsWith('DELETE FROM energy_refresh_queue'))).toBe(false);
  expect(f.calls.some(q => q.sql.startsWith('UPDATE energy_history_policy SET last_swept_at'))).toBe(false);
  expect(f.calls.at(-1).sql).toContain('pg_advisory_unlock');
  expect(f.client.release).toHaveBeenCalled();
});

test('a successful sweep removes only its newly created retention invalidation',async()=>{
  const f=fixture();
  expect((await job.run({pool:f.pool,touchCache:false})).errors).toEqual([]);
  expect(f.refreshQueue.size).toBe(0);
  const removed=f.calls.find(q=>q.sql.startsWith('DELETE FROM energy_refresh_queue'));
  expect(removed.params).toEqual([4,7,retentionVersion]);
  expect(removed.sql).toContain('machine_id=$2 AND updated_at=$3::timestamptz');
});

const liveRefresh={machine_id:7,from_at:'2026-11-26 12:29:00.000123+00',
  through_at:'2026-11-26 12:29:59.000456+00',version:'2026-11-26 12:29:59.000789+00',last_error:'XX001'};
test('successful retention restores earlier live bounds, error, and exact version instead of leaving a five-day union',async()=>{
  const f=fixture({previousRefresh:[liveRefresh]});
  await job.run({pool:f.pool,touchCache:false});
  expect(f.refreshQueue.get(7)).toEqual(liveRefresh);
  const snapshot=f.calls.find(q=>q.sql.startsWith('SELECT machine_id,')&&q.sql.includes('FROM energy_refresh_queue'));
  const merge=f.calls.find(q=>q.sql.startsWith('INSERT INTO energy_refresh_queue'));
  const restored=f.calls.find(q=>q.sql.startsWith('UPDATE energy_refresh_queue SET from_at='));
  expect(snapshot.sql).toContain('FOR UPDATE');
  expect(f.calls.indexOf(snapshot)).toBeLessThan(f.calls.indexOf(merge));
  expect(merge.sql).toContain('RETURNING machine_id,updated_at::text AS retention_version');
  expect(merge.sql).not.toContain('last_error=NULL');
  expect(restored.params).toEqual([4,7,liveRefresh.from_at,liveRefresh.through_at,liveRefresh.version,liveRefresh.last_error,retentionVersion]);
  expect(restored.sql).toContain('company_id=$1 AND machine_id=$2 AND updated_at=$7::timestamptz');
});

test.each([[],[liveRefresh]].map(previousRefresh=>[previousRefresh]))('a newer invalidation arriving during public refresh is preserved: previous=%j',async previousRefresh=>{
  const foreignVersion='2026-11-26 12:30:01.000321+00';
  let foreign;
  const f=fixture({previousRefresh,duringRefresh:queue=>{
    foreign={...queue.get(7),through_at:'2026-11-26 12:30:01.000123+00',version:foreignVersion,last_error:'NEW_ERROR'};
    queue.set(7,foreign);
  }});
  await job.run({pool:f.pool,touchCache:false});
  expect(f.refreshQueue.get(7)).toEqual(foreign);
  expect(f.calls.some(q=>q.sql.startsWith('UPDATE energy_history_policy SET last_swept_at'))).toBe(true);
});

test('refresh failure keeps both the retention range and pre-existing live work durably queued',async()=>{
  const f=fixture({previousRefresh:[liveRefresh],fail:sql=>sql.startsWith('CALL ')});
  expect((await job.run({pool:f.pool,touchCache:false})).errors).toHaveLength(1);
  expect(f.refreshQueue.get(7)).toEqual({machine_id:7,from_at:start,through_at:liveRefresh.through_at,
    version:retentionVersion,last_error:liveRefresh.last_error});
  expect(f.calls.some(q=>q.sql.startsWith('UPDATE energy_refresh_queue SET from_at='))).toBe(false);
  expect(f.calls.some(q=>q.sql.startsWith('DELETE FROM energy_refresh_queue'))).toBe(false);
  expect(f.calls.some(q=>q.sql.startsWith('UPDATE energy_history_policy SET last_swept_at'))).toBe(false);
});

test('a source write failure rolls back before refresh or checkpoint advancement', async () => {
  const f = fixture({ fail: sql => sql.startsWith('UPDATE telemetry_raw') });
  const result = await job.run({ pool: f.pool, touchCache: false });
  expect(result.errors).toHaveLength(1);
  expect(f.calls.some(q => q.sql === 'ROLLBACK')).toBe(true);
  expect(f.calls.some(q => q.sql === 'COMMIT')).toBe(false);
  expect(f.calls.some(q => q.sql.startsWith('CALL '))).toBe(false);
});

test('a policy disabled between discovery and row lock skips the sweep', async () => {
  const f = fixture({ active: false });
  expect((await job.run({ pool: f.pool })).policies).toBe(0);
  expect(f.calls.some(q => q.sql === 'ROLLBACK')).toBe(true);
  expect(f.calls.some(q => q.sql.startsWith('DELETE FROM energy_meter_readings'))).toBe(false);
});

test('ordinary PostgreSQL uses virtual read models and can complete without Timescale CALL', async () => {
  const f = fixture({ extension: false });
  expect((await job.run({ pool: f.pool, touchCache: false })).policies).toBe(1);
  expect(f.calls.some(q => q.sql.startsWith('CALL '))).toBe(false);
});

test.each([{ maxPolicies: 0 }, { maxPolicies: 101 }, { windowMs: 1 }, { windowMs: 3600001 }])(
  'invalid sweep bounds cannot connect or mutate data: %j', async options => {
    const f = fixture();
    await expect(job.run({ pool: f.pool, ...options })).rejects.toThrow(RangeError);
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
