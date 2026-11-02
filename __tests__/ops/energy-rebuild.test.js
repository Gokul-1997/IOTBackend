const path = require('node:path');
const { spawnSync } = require('node:child_process');
jest.mock('../../src/db', () => { throw new Error('Rebuild must not load application database configuration'); });
jest.mock('../../src/dashboard/cache', () => { throw new Error('Rebuild must not load the application Redis cache'); });
const ops = require('../../scripts/energy-rebuild');
const FROM = '2026-10-01T00:00:00+05:30';
const TO = '2026-10-02T00:00:00+05:30';
const valid = stage => ({ apply:true,companyId:4,from:FROM,to:TO,stepMinutes:15,stage });
function database(handler) {
  const calls=[];
  const query=jest.fn(async(text,params)=>{ calls.push({text,params});return handler(text,params); });
  const client={query,release:jest.fn()};
  return {calls,client,pool:{query,connect:jest.fn(async()=>client)}};
}
const parity = () => ({ source_registers:'4',facts:'4',orphan_facts:'0',mismatched_source_facts:'0',queued:0,refresh_queued:0,kwh:1 });

test.each([
  [],['--company-id','4','--stage','typo'],['--company-id','4','--step-minutes','0'],
  ['--company-id','4','--stage','source','--from','2026-10-01','--to',TO],
  ['--company-id','4','--stage','source','--from',TO,'--to',FROM]
].map(args=>[args]))('rejects unsafe or incomplete CLI options: %j',args=>expect(()=>ops.options(args)).toThrow());

test('operations require an explicit target URL; ambient PG settings do not select a database',()=>{
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/energy-rebuild.js'),'--company-id','4'],
    {env:{PATH:process.env.PATH,PGHOST:'a-production-server',PGDATABASE:'production'},encoding:'utf8'});
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Set ENERGY_DATABASE_URL explicitly');
});

test('a dry run performs no writes or hidden database reads',async()=>{
  const db=database(()=>{throw Error('No query expected');});
  expect(await ops.execute(db.pool,{...valid('source'),apply:false})).toMatchObject({dry_run:true,stage:'source'});
  expect(db.calls).toHaveLength(0);
});

test('each source window commits its sparse merge and certificate atomically',async()=>{
  const db=database(async text=>({rows:[],rowCount:text.startsWith('INSERT INTO energy_meter_readings')?3:1}));
  const result=await ops.source(db.pool,{...valid('source'),to:'2026-10-01T00:01:00+05:30'},()=>{});
  expect(result.changed).toBe(3);
  const statements=db.calls.map(call=>call.text);
  expect(statements[0]).toBe('BEGIN');
  const insert=statements.find(text=>text.startsWith('INSERT INTO energy_meter_readings'));
  expect(insert).toContain('array_agg(t.energy ORDER BY t.received_at DESC) FILTER(WHERE t.energy IS NOT NULL)');
  expect(insert).toContain('kwh_total=COALESCE(energy_meter_readings.kwh_total,EXCLUDED.kwh_total)');
  expect(statements.findIndex(text=>text.includes('INSERT INTO energy_backfill_windows'))).toBeLessThan(statements.indexOf('COMMIT'));
  expect(db.client.release).toHaveBeenCalled();
});

test('failed source window rolls back rather than certifying an incomplete import',async()=>{
  const db=database(async text=>{if(text.includes('INSERT INTO energy_backfill_windows'))throw Error('Certificate storage failed');return {rows:[],rowCount:1};});
  await expect(ops.source(db.pool,{...valid('source'),to:'2026-10-01T00:01:00+05:30'},()=>{})).rejects.toThrow('Certificate storage failed');
  expect(db.calls.map(call=>call.text)).toContain('ROLLBACK');
  expect(db.calls.map(call=>call.text)).not.toContain('COMMIT');
});

test('projection seed includes real-valued channels and rejects an older future projection',async()=>{
  const at=Date.parse('2026-10-30T00:00:00Z');
  const db=database(async text=>{
    if(text.includes('information_schema.columns'))return {rows:['v_ll_avg','kw_total','kwh_total','aux_interrupts'].map(column_name=>({column_name}))};
    if(text.startsWith('SELECT id FROM machines'))return {rows:[{id:15}]};
    if(text==='SELECT CURRENT_TIMESTAMP AS at')return {rows:[{at:new Date(at)}]};
    if(text.startsWith('WITH latest_at'))return {rows:[{read_at:new Date(at-1000),field_values:{v_ll_avg:230,kw_total:-1,kwh_total:55,aux_interrupts:0},
      field_observed_at:{v_ll_avg:at-1000,kw_total:at-1000,kwh_total:at-1000,aux_interrupts:at-1000}}]};
    if(text.startsWith('SELECT * FROM energy_meter_latest'))return {rows:[{field_values:{kw_total:999},field_observed_at:{kw_total:at+3600e3}}]};
    return {rows:[]};
  });
  await ops.seed(db.pool,4);
  expect(db.calls[0].text).toContain("data_type IN('double precision','real') OR column_name='aux_interrupts'");
  const write=db.calls.find(call=>call.text.startsWith('INSERT INTO energy_meter_latest'));
  expect(JSON.parse(write.params[2])).toMatchObject({v_ll_avg:230,kw_total:-1,kwh_total:55,aux_interrupts:0});
  expect(write.params[4].getTime()).toBe(at-1000);
});

test('aligned verification compares only fully contained IST buckets',()=>{
  expect(ops.closedRange('2026-10-01T08:10:00+05:30','2026-10-01T10:20:00+05:30','hour'))
    .toEqual({from:new Date('2026-10-01T09:00:00+05:30'),to:new Date('2026-10-01T10:00:00+05:30')});
  expect(ops.closedRange('2026-10-01T08:10:00+05:30','2026-10-01T10:20:00+05:30','hour',true).from)
    .toEqual(new Date('2026-10-01T08:00:00+05:30'));
});

test('verification refuses mismatched per-register aggregate totals even with matching source/fact counts',async()=>{
  const db=database(async text=>({rows:[text.includes('WITH source_points')?parity():{checked_buckets:'5',mismatched_buckets:text.includes('energy:verify:energy_counter_hourly')?'1':'0'}]}));
  const result=await ops.verify(db.pool,valid('verify'));
  expect(result.complete).toBe(false);
  expect(result.aggregates.energy_counter_hourly.complete).toBe(false);
  const hourly=db.calls.find(call=>call.text.includes('energy:verify:energy_counter_hourly')).text;
  expect(hourly).toContain('m.register=a.register');
  expect(hourly).toContain('COALESCE(m.shift_id,0)=COALESCE(a.shift_id,0)');
  expect(hourly).toContain('m.accepted_intervals IS DISTINCT FROM a.accepted_intervals');
});

test.each(['mismatched_source_facts','orphan_facts','queued','refresh_queued'])('verification rejects %s even if every aggregate matches',async field=>{
  const row={...parity(),[field]:1};
  const db=database(async text=>({rows:[text.includes('WITH source_points')?row:{checked_buckets:'5',mismatched_buckets:'0'}]}));
  expect((await ops.verify(db.pool,valid('verify'))).complete).toBe(false);
});

test('refresh uses closed IST bounds and requires explicit preparation of compressed aggregates',async()=>{
  const db=database(async text=>({rows:text.includes("pg_extension")?[{}]:text.includes('continuous_aggregates')?[{chunk:'_timescaledb_internal.chunk'}]:[]}));
  await expect(ops.refresh(db.pool,valid('refresh'))).rejects.toThrow('--decompress');
  expect(db.calls.some(call=>/decompress_chunk|CALL refresh/.test(call.text))).toBe(false);
});

test('a failed manual refresh restores compression scheduling',async()=>{
  const db=database(async text=>{
    if(text.includes('pg_extension'))return {rows:[{}]};
    if(text.includes('j.job_id'))return {rows:[{job_id:5,scheduled:true}]};
    if(text.includes('c.chunk_schema'))return {rows:[{chunk:'_timescaledb_internal.chunk'}]};
    if(text.startsWith('CALL refresh'))throw Error('Refresh failed');
    return {rows:[]};
  });
  await expect(ops.refresh(db.pool,{...valid('refresh'),decompress:true})).rejects.toThrow('Refresh failed');
  expect(db.calls.filter(call=>call.text.includes('alter_job')).map(call=>call.text))
    .toEqual(['SELECT alter_job($1,scheduled=>FALSE)','SELECT alter_job($1,scheduled=>TRUE)']);
  const call=db.calls.find(item=>item.text.startsWith('CALL refresh'));
  expect(call.params).toEqual([new Date(FROM),new Date(TO)]);
});

function cutoverDB({badTail=false,badCoverage=false,oldTo=false}={}) {
  return database(async text=>{
    if(text==='SELECT CURRENT_TIMESTAMP AS as_of')return {rows:[{as_of:new Date(oldTo?'2026-10-04T00:00:00+05:30':'2026-10-02T01:15:00+05:30')}]};
    if(text.includes('WITH source_points'))return {rows:[parity()]};
    if(text.includes('energy:verify:energy_'))return {rows:[{checked_buckets:'5',mismatched_buckets:'0'}]};
    if(text.includes('(SELECT version())'))return {rows:[{invalid_owners:0,legacy_from:new Date(FROM),meter_from:new Date(FROM)}]};
    if(text.includes('range_agg'))return {rows:[{complete:!badCoverage}]};
    if(text.includes('energy:verify:live-tail'))return {rows:[{missing_scalar_rows:badTail?'1':'0'}]};
    return {rows:[]};
  });
}
test.each([{badTail:true},{badCoverage:true},{oldTo:true}])('cutover refuses uncertified history and retains legacy readiness: %j',async scenario=>{
  const db=cutoverDB(scenario);
  await expect(ops.execute(db.pool,valid('enable'))).rejects.toThrow('Cutover refused');
  expect(db.calls.some(call=>call.text.startsWith('INSERT INTO energy_pipeline_state'))).toBe(false);
  expect(db.calls.at(-1).text).toBe('ROLLBACK');
});
test('cutover verifies source/fact history through a frozen recent snapshot, then atomically enables',async()=>{
  const db=cutoverDB();
  const result=await ops.execute(db.pool,valid('enable'));
  expect(result.ready).toBe(true);
  expect(result.verified_through).toBe('2026-10-01T19:45:00.001Z');
  expect(db.calls[0].text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const verification=db.calls.find(call=>call.text.includes('WITH source_points'));
  expect(verification.params[2].toISOString()).toBe(result.verified_through);
  expect(db.calls.at(-1).text).toBe('COMMIT');
});

test('drain cannot report completion merely because another worker holds the lock',async()=>{
  const db=database(async text=>({rows:[text.includes('pg_try_advisory_lock')?{ok:false}:{remaining:2}]}));
  await expect(ops.execute(db.pool,valid('drain'),()=>{})).rejects.toThrow('busy in another worker');
});
