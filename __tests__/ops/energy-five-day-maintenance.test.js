'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
jest.mock('../../src/db', () => { throw Error('Maintenance must not implicitly load application DB'); });
const ops = require('../../scripts/energy-five-day-maintenance');
const args = ['--company-id','4','--days','5','--env-file','explicit.env','--backup-dir','explicit-backup'];
const from = '2026-11-20T12:00:00.000Z';
const through = '2026-11-20T18:00:00.000Z';
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(),'energy-maintenance-test-')); });
afterEach(() => { fs.rmSync(dir,{recursive:true,force:true}); });
const manifest = () => ({company_id:4,days:5,database:'iot',cutoff:'2026-11-21T12:30:00.000Z',completed:[],backups:[]});

test.each([
  [],['--company-id','5','--days','5'],['--company-id','4','--days','6'],
  [...args,'--stage','drop-everything'],[...args,'--database','implicit']
].map(input=>[input]))('rejects an unapproved tenant, horizon, or target: %j', input => {
  expect(() => ops.options(input)).toThrow();
});
test('defaults to a preview and requires an explicit environment and backup destination', () => {
  expect(ops.options(args)).toMatchObject({apply:false,companyId:4,days:5,envFile:'explicit.env',backupDir:'explicit-backup'});
  expect(ops.options([...args,'--apply','--stage','rebuild'])).toMatchObject({apply:true,stage:'rebuild'});
});
test('verified backup preserves PostgreSQL microseconds and large integers exactly and is private', () => {
  const line = '{"received_at":"2026-11-20 12:00:00.000125+00","id":9007199254740993,"power":-0.199}';
  const saved = ops.backup(dir,'raw-old',[line]);
  const file = path.join(dir,saved.file);
  const bytes = fs.readFileSync(file);
  expect(zlib.gunzipSync(bytes).toString()).toBe(line+'\n');
  expect(saved.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  expect(saved.rows).toBe(1);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
test('a raw CNC batch verifies its recoverable energy backup before updating only energy fields', async () => {
  const m = manifest(), calls = [];
  const op = ops.operations().find(o => o.name === 'raw-old');
  const client = {query: jest.fn(async (sql,params) => {
    calls.push({sql,params});
    if(sql.includes('AS line FROM')) return {rows:[{line:'{"id":1,"energy":22,"power":-0.2}'}]};
    if(sql.startsWith('UPDATE telemetry_raw')) {
      const written = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
      expect(written.completed).toEqual([]);
      expect(written.backups).toHaveLength(1);
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir,written.backups[0].file))).toString())
        .toBe('{"id":1,"energy":22,"power":-0.2}\n');
      expect(sql).toContain('SET energy=NULL,voltage=NULL,current=NULL,power=NULL');
      expect(sql).not.toMatch(/parts_count\s*=|machine_status\s*=|run_time\s*=/);
      return {rows:[],rowCount:1};
    }
    return {rows:[]};
  })};
  await ops.mutate(client,dir,m,op,from,through,()=>{});
  expect(calls[0].sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const readsAndWrites = calls.filter(c => (/AS line FROM/.test(c.sql)||c.sql.startsWith('UPDATE telemetry_raw')));
  expect(readsAndWrites).toHaveLength(2);
  for(const call of readsAndWrites) {
    expect(call.sql).toContain('company_id=$1');
    expect(call.sql).toContain('COALESCE(to_timestamp(device_time),received_at)<$2');
    expect(call.params).toEqual([4,m.cutoff,from,through]);
  }
  expect(calls.at(-1).sql).toBe('COMMIT');
  expect(m.completed).toHaveLength(1);
  const count = calls.length;
  await ops.mutate(client,dir,m,op,from,through,()=>{});
  expect(calls).toHaveLength(count); // Committed checkpoints are restartable.
});
test('backup/change count mismatch rolls back without marking a batch complete', async () => {
  const m = manifest(), calls=[];
  const client = {query: jest.fn(async sql => {
    calls.push(sql);
    if(sql.includes('AS line FROM'))return {rows:[{line:'{"company_id":4,"kwh_total":22}'}]};
    return {rows:[],rowCount:0};
  })};
  await expect(ops.mutate(client,dir,m,ops.operations()[0],from,through,()=>{})).rejects.toThrow('Backup/change row counts differ');
  expect(calls.at(-1)).toBe('ROLLBACK');
  expect(calls).not.toContain('COMMIT');
  expect(m.completed).toEqual([]);
  expect(m.backups).toHaveLength(1); // Recovery material survives a SQL failure.
});
test('a completed larger window also covers smaller resume batches',async()=>{
  const m=manifest();
  m.completed.push('raw-old:2026-11-20T00:00:00.000Z:2026-11-21T00:00:00.000Z');
  const client={query:jest.fn()};
  await ops.mutate(client,dir,m,ops.operations().find(op=>op.name==='raw-old'),from,through,()=>{});
  expect(client.query).not.toHaveBeenCalled();
});
test('a concurrent latest update rolls back and retries with a fresh verified snapshot',async()=>{
  const m=manifest(),calls=[];let updates=0;
  const client={query:jest.fn(async sql=>{
    calls.push(sql);
    if(sql.includes('AS line FROM'))return{rows:[{line:'{"company_id":4,"kwh_total":22}'}]};
    if(sql.startsWith('DELETE FROM energy_meter_readings')&&++updates===1)throw Object.assign(new Error('concurrent update'),{code:'40001'});
    return{rows:[],rowCount:1};
  })};
  await ops.mutate(client,dir,m,ops.operations()[0],from,through,()=>{});
  expect(calls.filter(sql=>sql==='ROLLBACK')).toHaveLength(1);
  expect(calls.filter(sql=>sql==='COMMIT')).toHaveLength(1);
  expect(m.completed).toHaveLength(1);expect(m.backups).toHaveLength(2);
});
test('a failed competing maintenance lock cannot change another run\'s manifest or paused jobs', async () => {
  const m = {...manifest(),jobs:[{job_id:1069,scheduled:true}]};
  const bytes = JSON.stringify(m,null,2);
  fs.writeFileSync(path.join(dir,'manifest.json'),bytes);
  const calls=[];
  const query = jest.fn(async sql => {
    calls.push(sql);
    if(sql.startsWith('SELECT company_name'))return {rows:[{company_name:'S AND T'}]};
    if(sql.startsWith('SELECT current_database'))return {rows:[{database:'iot',as_of:'2026-11-26T12:30:00Z',cutoff:m.cutoff}]};
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{ok:false}]};
    return {rows:[]};
  });
  const client = {query,release:jest.fn()};
  await expect(ops.execute({query,connect:async()=>client},
    {...ops.options([...args,'--apply']),backupDir:dir})).rejects.toThrow('already running');
  expect(calls.some(sql=>sql.includes('alter_job'))).toBe(false);
  expect(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')).toBe(bytes);
  expect(client.release).toHaveBeenCalledTimes(1);
});
test('verification checks old continuous aggregates as well as source history', async () => {
  const calls=[];
  const pool = {query:async (sql,params) => {
    calls.push({sql,params});
    if(sql.includes('AS retained'))return {rows:[{retained:'40',oldest:'2026-11-22',newest:'2026-11-26'}]};
    return {rows:[{n:sql.includes('FROM energy_electrical_1m')?'1':'0'}]};
  }};
  const result = await ops.verify(pool,manifest().cutoff);
  expect(result.complete).toBe(false);
  expect(result['energy_electrical_1m-old']).toBe('1');
  for(const c of calls)expect(c.params[0]).toBe(4);
});
test('CNC verification covers the certified history in bounded receipt windows',async()=>{
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('AS retained'))return{rows:[{retained:'40'}]};
    return{rows:[{n:sql.includes('AND received_at>=$3 AND received_at<$4')?'1':'0'}]};
  }};
  const result=await ops.verify(pool,manifest().cutoff,
    {first:'2026-11-19T06:00:00.000Z',last:'2026-11-20T18:00:00.000Z'});
  const windows=calls.filter(c=>c.sql.includes('AND received_at>=$3 AND received_at<$4'));
  expect(windows).toHaveLength(2);
  expect(windows[0].params.slice(2)).toEqual([new Date('2026-11-19T00:00:00Z'),new Date('2026-11-20T00:00:00Z')]);
  expect(windows[1].params.slice(2)).toEqual([new Date('2026-11-20T00:00:00Z'),new Date('2026-11-21T00:00:00Z')]);
  expect(result['raw-old']).toBe('2');expect(result.complete).toBe(false);
});
