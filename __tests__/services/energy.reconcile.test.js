'use strict';

jest.mock('../../src/dashboard/cache',()=>({touch:jest.fn()}));
const job=require('../../src/cron/energyReconcile.job');
const {reconcileMachine,shiftFor}=job;

const COLUMNS=['company_id','machine_id','register','observed_at','interval_start','raw_value','delta',
  'quality','allocated','shift_id','measured_seconds','baseline_value','baseline_at','uncertain',
  'epoch_at','rule_id','event_id','state'];
const allDay=[{id:4,start_time:'00:00:00',end_time:'00:00:00'}];
const point=(at,value,extra={})=>({read_at:new Date(at),source_at:at,kwh_total:value,...extra});
const start='2026-10-29T10:00:00.000Z';
test('a certified historical drain leaves newer live packets queued',async()=>{
  const calls=[];
  const client={release:jest.fn(),query:jest.fn(async(sql,params)=>{
    calls.push({sql,params});
    return{rows:sql.includes('pg_try_advisory_lock')?[{ok:true}]:[]};
  })};
  const pool={connect:async()=>client};
  await job.run({pool,companyId:4,before:start,touchCache:false,refreshAggregates:false});
  const selection=calls.find(c=>c.sql.includes('SELECT company_id,machine_id FROM energy_reconcile_queue'));
  expect(selection.sql).toContain('LEAST(claimed_from,from_at)<$3::timestamptz');
  expect(selection.params).toEqual([4,20,start]);
  expect(calls.some(c=>/^(UPDATE|DELETE FROM) energy_reconcile_queue/.test(c.sql))).toBe(false);
  await expect(job.run({pool,before:'bad'})).rejects.toThrow('valid timestamp');
});

function fixture({points=[],rules=[],events=[],shifts=allDay,prior={},pending=null,failInsert=false}={}) {
  const state={facts:[],queue:true,pending,claimed:start,sql:[],checkpoints:[]};
  const client={query:jest.fn(async(sql,params=[])=>{
    state.sql.push({sql,params});
    if(sql.startsWith('SELECT read_at,')) return {rows:points};
    if(sql.includes('SELECT * FROM energy_meter_rules')) return {rows:rules};
    if(sql.includes('SELECT *,event_type AS type')) return {rows:events};
    if(sql.startsWith('SELECT id,start_time')) return {rows:shifts};
    if(sql.startsWith('SELECT state FROM energy_counter_intervals')) return {rows:prior[params[2]]?[{state:prior[params[2]]}]:[]};
    if(sql.startsWith('INSERT INTO energy_counter_intervals')) {
      if(failInsert) throw Object.assign(new Error('retry'),{code:'40001'});
      for(let n=0;n<params.length;n+=COLUMNS.length) {
        const row=Object.fromEntries(COLUMNS.map((key,index)=>[key,params[n+index]]));
        row.state=JSON.parse(row.state);state.facts.push(row);
      }
    }
    if(sql.startsWith('DELETE FROM energy_reconcile_queue') && state.pending===null) state.queue=false;
    if(sql.startsWith('UPDATE energy_reconcile_queue SET claimed_from=NULL') && state.queue) {
      const resume=params[2];
      const next=state.pending===null?resume:resume===null?state.pending:
        (new Date(state.pending)<new Date(resume)?state.pending:resume);
      if(next===null) throw Object.assign(new Error('empty queue item'),{code:'23514'});
      state.pending=next;state.claimed=null;
    }
    if(sql.startsWith('INSERT INTO energy_counter_state')) state.checkpoints.push(params);
    return {rows:[]};
  })};
  return {client,state};
}

describe('durable energy replay',()=>{
  test('completes and removes an empty queue item without violating its CHECK',async()=>{
    const {client,state}=fixture({points:[point(start,100),point('2026-10-29T10:00:05Z',101)]});
    expect(await reconcileMachine(client,{companyId:1,machineId:2,from:start})).toEqual({points:2,facts:2,more:false});
    expect(state.queue).toBe(false);
    expect(state.facts.map(f=>f.delta)).toEqual([null,1]);
    expect(state.facts[1]).toMatchObject({allocated:true,quality:'measured',shift_id:4,measured_seconds:5});
    expect(state.sql.at(-1).sql).toBe('COMMIT');
    const deletion=state.sql.findIndex(q=>q.sql.startsWith('DELETE FROM energy_reconcile_queue'));
    const update=state.sql.findIndex(q=>q.sql.startsWith('UPDATE energy_reconcile_queue SET claimed_from=NULL'));
    expect(deletion).toBeLessThan(update);
  });

  test('keeps a concurrent earlier correction pending after the current claim finishes',async()=>{
    const pending='2026-10-29T09:59:00Z';
    const {client,state}=fixture({points:[point(start,100)],pending});
    await reconcileMachine(client,{companyId:1,machineId:2,from:start});
    expect(state.queue).toBe(true);expect(state.pending).toBe(pending);expect(state.claimed).toBeNull();
  });

  test('pages from the first unread exact timestamp without skipping a sub-millisecond row',async()=>{
    const next='2026-10-29T10:00:05.000125+00:00';
    const {client,state}=fixture({points:[point(start,100),point(next,101)]});
    expect(await reconcileMachine(client,{companyId:1,machineId:2,from:start,maxPoints:1})).toEqual({points:1,facts:1,more:true});
    expect(state.pending).toBe(next);
    expect(state.sql.find(q=>q.sql.startsWith('SELECT read_at,')).params.at(-1)).toBe(2);
    expect(state.sql.find(q=>q.sql.startsWith('DELETE FROM energy_counter_intervals f')).params[3]).toBe(next);
  });

  test('exactly a full final page finishes without repeatedly replaying its last point',async()=>{
    const {client,state}=fixture({points:[point(start,100)]});
    expect((await reconcileMachine(client,{companyId:1,machineId:2,from:start,maxPoints:1})).more).toBe(false);
    expect(state.queue).toBe(false);
  });

  test('register omissions are absent observations and nonfinite inputs remain rejected facts',async()=>{
    const {client,state}=fixture({points:[point(start,null,{kwh_import:20,kwh_export:Number.NaN}),point('2026-10-29T10:00:05Z',undefined,{kwh_import:21})]});
    await reconcileMachine(client,{companyId:1,machineId:2,from:start});
    expect(state.facts).toHaveLength(3);
    expect(state.facts.filter(f=>f.register==='kwh_total')).toHaveLength(0);
    expect(state.facts.find(f=>f.register==='kwh_export')).toMatchObject({raw_value:null,delta:null,quality:'invalid'});
    expect(state.facts.filter(f=>f.register==='kwh_import').map(f=>f.delta)).toEqual([null,1]);
  });

  test('applies persisted rule identifiers and a verified reset event',async()=>{
    const {client,state}=fixture({
      points:[point(start,101),point('2026-10-29T10:00:05Z',2)],
      rules:[{id:'20',register:'kwh_total',effective_from:new Date('2026-10-29T09:00:00Z'),max_rate_units_per_hour:3600,resolution:0,max_gap_seconds:60,rollover_value:null,rollover_margin_ratio:0.1}],
      events:[{id:'30',register:'kwh_total',effective_at:new Date('2026-10-29T10:00:02Z'),type:'reset',baseline_value:0}],
    });
    await reconcileMachine(client,{companyId:1,machineId:2,from:start});
    expect(state.facts[1]).toMatchObject({delta:2,rule_id:'20',event_id:'30',quality:'reset',allocated:true});
  });

  test('does not infer a counter reset during a replay',async()=>{
    const {client,state}=fixture({points:[point(start,11),point('2026-10-29T10:00:05Z',5),point('2026-10-29T10:00:10Z',11),point('2026-10-29T10:00:15Z',12)]});
    await reconcileMachine(client,{companyId:1,machineId:2,from:start});
    expect(state.facts.map(f=>f.delta)).toEqual([null,null,0,1]);
    expect(state.facts.map(f=>f.quality)).toEqual(['baseline','regression','recovered','measured']);
  });

  test('uses the common measurement-end convention across an IST hour boundary',async()=>{
    const {client,state}=fixture({points:[point('2026-10-29T10:29:55Z',100),point('2026-10-29T10:30:00Z',101)]});
    await reconcileMachine(client,{companyId:1,machineId:2,from:'2026-10-29T10:29:55Z'});
    expect(state.facts[1]).toMatchObject({delta:1,quality:'measured',allocated:true,measured_seconds:5});
  });

  test('a normal boundary pair belongs to the shift of the later observation',async()=>{
    const shifts=[{id:1,start_time:'00:00:00',end_time:'15:45:00'},{id:2,start_time:'15:45:00',end_time:'00:00:00'}];
    const {client,state}=fixture({points:[point('2026-10-29T10:14:55Z',100),point('2026-10-29T10:15:00Z',101)],shifts});
    await reconcileMachine(client,{companyId:1,machineId:2,from:'2026-10-29T10:14:55Z'});
    expect(state.facts[1]).toMatchObject({delta:1,quality:'measured',allocated:true,shift_id:2});
  });

  test('a replay retains existing shift IDs and removes only facts whose source field disappeared',async()=>{
    const {client,state}=fixture({points:[point(start,100)]});
    await reconcileMachine(client,{companyId:1,machineId:2,from:start});
    const upsert=state.sql.find(q=>q.sql.startsWith('INSERT INTO energy_counter_intervals')).sql;
    expect(upsert.split('DO UPDATE SET')[1]).not.toMatch(/shift_id=/);
    const prune=state.sql.find(q=>q.sql.startsWith('DELETE FROM energy_counter_intervals f')).sql;
    expect(prune).toContain('NOT EXISTS(SELECT 1 FROM energy_meter_readings');
    expect(prune).toContain("WHEN 'kwh_import' THEN r.kwh_import");
    expect(prune).toContain('f.company_id=$1 AND f.machine_id=$2');
    expect(state.sql.some(q=>q.sql.startsWith('DELETE FROM energy_counter_state'))).toBe(true);
  });

  test('rolls back and leaves the durable claim available after a failure',async()=>{
    const {client,state}=fixture({points:[point(start,100)],failInsert:true});
    await expect(reconcileMachine(client,{companyId:1,machineId:2,from:start})).rejects.toMatchObject({code:'40001'});
    expect(state.queue).toBe(true);expect(state.claimed).toBe(start);
    expect(state.sql.some(q=>q.sql==='ROLLBACK')).toBe(true);
    expect(state.sql.some(q=>q.sql==='COMMIT')).toBe(false);
    expect(state.sql.at(-1).params).toEqual([1,2,'40001']);
  });

  test('rejects invalid batch sizes before opening a transaction',async()=>{
    const {client}=fixture();
    await expect(reconcileMachine(client,{companyId:1,machineId:2,from:start,maxPoints:0})).rejects.toThrow(RangeError);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('disabled schedules do not connect to the database',async()=>{
    const previous=process.env.ENERGY_V2_ENABLED;process.env.ENERGY_V2_ENABLED='false';
    const db=require('../../src/db');db.connect.mockClear();
    await job();expect(db.connect).not.toHaveBeenCalled();
    if(previous===undefined)delete process.env.ENERGY_V2_ENABLED;else process.env.ENERGY_V2_ENABLED=previous;
  });
});

describe('shift classification',()=>{
  test('handles overnight shifts, exact start/end times and IST midnight',()=>{
    const shifts=[{id:1,start_time:'08:00:00',end_time:'20:00:00'},{id:2,start_time:'20:00:00',end_time:'08:00:00'}];
    expect(shiftFor(shifts,new Date('2026-10-29T02:30:00Z'))).toBe(1);
    expect(shiftFor(shifts,new Date('2026-10-29T14:30:00Z'))).toBe(2);
    expect(shiftFor(shifts,new Date('2026-10-29T18:30:00Z'))).toBe(2);
  });
  test('does not guess an overlapping or missing shift',()=>{
    expect(shiftFor([allDay[0],{...allDay[0],id:5}],new Date(start))).toBeNull();
    expect(shiftFor([],new Date(start))).toBeNull();
  });
});


test('automatic replay only claims and refreshes verified companies; explicit rebuild can prepare an unready company', async () => {
  const previous = process.env.ENERGY_V2_ENABLED;
  const db = require('../../src/db');
  const client = { release: jest.fn(), query: jest.fn(async sql => ({
    rows: sql.includes('pg_try_advisory_lock') ? [{ ok: true }] : []
  })) };
  const connection = db.connect.mockImplementation(async () => client);
  try {
    delete process.env.ENERGY_V2_ENABLED;
    await job();
    const automatic = client.query.mock.calls.filter(([sql]) =>
      /SELECT company_id,machine_id FROM energy_(?:reconcile|refresh)_queue/.test(sql));
    expect(automatic).toHaveLength(2);
    for (const [sql] of automatic) expect(sql).toContain('EXISTS(SELECT 1 FROM energy_pipeline_state s WHERE');
    client.query.mockClear();
    await job.run({ pool: db, companyId: 4, touchCache: false });
    const rebuild = client.query.mock.calls.filter(([sql]) =>
      /SELECT company_id,machine_id FROM energy_(?:reconcile|refresh)_queue/.test(sql));
    expect(rebuild).toHaveLength(2);
    for (const [sql, params] of rebuild) {
      expect(sql).not.toContain('energy_pipeline_state');
      expect(params[0]).toBe(4);
    }
  } finally {
    connection.mockReset();
    if (previous === undefined) delete process.env.ENERGY_V2_ENABLED;
    else process.env.ENERGY_V2_ENABLED = previous;
  }
});
