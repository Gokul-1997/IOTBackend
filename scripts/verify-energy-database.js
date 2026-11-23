#!/usr/bin/env node
'use strict';
// Creates only an uncommitted isolated schema. Always rolls back, including
// Timescale background-job registrations. No public application rows change.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Client}=require('pg');
const {partsOf}=require('./migrate');
const ROOT=path.resolve(__dirname,'..');
async function verify(client,{callback}={}) {
  const schema='energy_verify_'+Date.now()+'_'+Math.random().toString(16).slice(2,8);
  const reports=[];
  const saved=new Map();
  function inject(file,exports) {
    const key=require.resolve(file);saved.set(key,require.cache[key]);require.cache[key]={id:key,filename:key,loaded:true,exports};
  }
  const oldFlag=process.env.ENERGY_V2_ENABLED;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path=${schema},public`);
    await client.query(`CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY,checksum TEXT,applied_at TIMESTAMPTZ,duration_ms INT);
      CREATE TABLE companies(id INT PRIMARY KEY);
      CREATE TABLE machines(id INT PRIMARY KEY,company_id INT REFERENCES companies(id),
        machine_serial_no TEXT,model TEXT,is_active BOOLEAN DEFAULT TRUE,plant_id INT,
        UNIQUE(company_id,id));
      CREATE TABLE shifts(id INT PRIMARY KEY,company_id INT,shift_name TEXT,start_time TIME,end_time TIME,is_active BOOLEAN,plant_id INT);
      CREATE TABLE production_hourly(company_id INT,machine_id INT,shift_id INT,hour_start TIMESTAMPTZ,run_seconds INT,produced_qty INT);
      CREATE TABLE energy_settings(company_id INT,machine_id INT,cost_per_kwh NUMERIC,currency TEXT);
      INSERT INTO companies VALUES(4),(5);
      INSERT INTO machines(id,company_id,machine_serial_no,model)VALUES(19,4,'Verify-19','CNC'),(20,4,'Verify-20','CNC'),(21,5,'Other tenant','CNC');
      INSERT INTO shifts VALUES(1,4,'Shift 1','08:00','20:00',TRUE,NULL),(2,4,'Shift 2','20:00','08:00',TRUE,NULL);
      INSERT INTO energy_settings VALUES(4,NULL,10,'INR');`);
    const text=fs.readFileSync(path.join(ROOT,'src/dashboard/energy-meter.service.js'),'utf8');
    const literal=/const READING_COLUMNS = (\[[\s\S]*?\]);/.exec(text);
    if(!literal)throw Error('Could not locate fixed meter column contract');
    const columns=vm.runInNewContext(literal[1]);
    assert(columns.every(c=>/^[a-z0-9_]+$/.test(c)));
    await client.query(`CREATE TABLE energy_meter_readings(machine_id INT NOT NULL,company_id INT,
      read_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ DEFAULT NOW(),standalone BOOLEAN DEFAULT FALSE,
      standalone_fields TEXT[] DEFAULT '{}',${columns.filter(c=>!c.startsWith('thd_')).map(c=>`${c} DOUBLE PRECISION`).join(',')},PRIMARY KEY(machine_id,read_at))`);
    const {rows:[ext]}=await client.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'");
    if(ext)await client.query("SELECT create_hypertable('energy_meter_readings','read_at',chunk_time_interval=>INTERVAL '7 days')");
    for(const file of ['064_energy_interval_pipeline.sql','065_energy_continuous_aggregates.sql','066_energy_meter_thd.sql']) {
      await client.query(partsOf(fs.readFileSync(path.join(ROOT,'src/migrations',file),'utf8')).body);
    }
    reports.push({check:'schema',timescaledb:ext?.extversion||null,passed:true});
    await client.query(`INSERT INTO energy_meter_readings(company_id,machine_id,read_at,kwh_total,kw_total)
      VALUES(4,19,'2026-10-28T10:00:00+05:30',100,2),
      (4,19,'2026-10-28T10:00:30+05:30',101,NULL),
      (4,19,'2026-10-28T10:00:40+05:30',90,NULL),
      (4,19,'2026-10-28T10:00:50+05:30',101,NULL),
      (4,19,'2026-10-28T10:00:55+05:30',102,NULL),
      (4,20,'2026-10-28T10:00:00+05:30',0,NULL),
      (4,20,'2026-10-28T10:00:30+05:30',0,NULL),
      (5,21,'2026-10-28T10:00:00+05:30',999,NULL)`);
    await client.query(`INSERT INTO energy_meter_readings(company_id,machine_id,read_at,v_ll_avg)
      VALUES(4,19,'2026-10-28T10:00:35+05:30',415)`);
    const {rows:[latest]}=await client.query('SELECT * FROM energy_meter_latest WHERE company_id=4 AND machine_id=19');
    assert.equal(latest.field_values.kwh_total,102);assert.equal(latest.field_values.kw_total,2);
    assert.equal(latest.field_values.v_ll_avg,415);
    assert.equal(Number(latest.field_observed_at.kw_total),Date.parse('2026-10-28T10:00:00+05:30'));
    reports.push({check:'sparse_latest_event_time',passed:true});
    const thdMigration=partsOf(fs.readFileSync(path.join(ROOT,'src/migrations/066_energy_meter_thd.sql'),'utf8')).body;
    await client.query(thdMigration); // Reapplying the additive DDL must be harmless.
    const {rows:thdColumns}=await client.query(`SELECT column_name,data_type,is_nullable
      FROM information_schema.columns WHERE table_schema=$1 AND table_name='energy_meter_readings'
      AND column_name LIKE 'thd_%'`,[schema]);
    assert.equal(thdColumns.length,9);
    assert(thdColumns.every(column=>column.data_type==='real'&&column.is_nullable==='YES'));
    await client.query(`INSERT INTO energy_meter_readings(company_id,machine_id,read_at,thd_v1n,thd_i2)
      VALUES(4,19,'2026-10-28T10:00:56+05:30',0,3.4)`);
    const {rows:[thdLatest]}=await client.query('SELECT * FROM energy_meter_latest WHERE company_id=4 AND machine_id=19');
    assert.equal(thdLatest.field_values.thd_v1n,0);
    assert(Math.abs(thdLatest.field_values.thd_i2-3.4)<0.000001);
    assert.equal(thdLatest.field_values.thd_i3,undefined);
    assert.equal(Number(thdLatest.field_observed_at.thd_v1n),Date.parse('2026-10-28T10:00:56+05:30'));
    assert.equal(thdLatest.field_values.kwh_total,102);
    reports.push({check:'nullable_THD_schema_idempotency_and_latest_projection',passed:true});
    // Application modules receive this explicit test client, never .env pools.
    inject(path.join(ROOT,'src/db.js'),{query:(...args)=>client.query(...args)});
    inject(path.join(ROOT,'src/dashboard/cache.js'),{touch:()=>{}});
    const budgetPath=require.resolve('../src/dashboard/energy-db');
    saved.set(budgetPath,require.cache[budgetPath]);delete require.cache[budgetPath];
    const jobPath=require.resolve('../src/cron/energyReconcile.job');
    saved.set(jobPath,require.cache[jobPath]);delete require.cache[jobPath];
    const {reconcileMachine}=require(jobPath);
    const adapter={query:(sql,args)=>{
      if(sql==='BEGIN')return client.query('SAVEPOINT energy_worker');
      if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT energy_worker');
      if(sql==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT energy_worker');
      return client.query(sql,args);
    }};
    for(const machine of [19,20,21]) {
      for(let pages=0;pages<10;pages++) {
        const {rows:[claim]}=await client.query(`UPDATE energy_reconcile_queue SET claimed_from=LEAST(claimed_from,from_at),from_at=NULL
          WHERE machine_id=$1 RETURNING company_id,claimed_from`,[machine]);
        if(!claim)break;
        await reconcileMachine(adapter,{companyId:claim.company_id,machineId:machine,from:claim.claimed_from,maxPoints:3});
      }
    }
    const {rows:counter}=await client.query(`SELECT machine_id,SUM(delta)::float8 AS kwh FROM energy_counter_intervals
      GROUP BY machine_id ORDER BY machine_id`);
    assert.equal(counter.find(r=>r.machine_id===19).kwh,2);
    assert.equal(counter.find(r=>r.machine_id===20).kwh,0);
    assert.equal(counter.find(r=>r.machine_id===21).kwh,null);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM energy_reconcile_queue')).rows[0].n,0);
    for(const view of ['energy_counter_hourly','energy_counter_daily','energy_counter_monthly']) {
      const {rows:[row]}=await client.query(`SELECT SUM(kwh)::float8 AS kwh FROM ${view} WHERE company_id=4 AND register='kwh_total'`);
      assert.equal(row.kwh,2);
    }
    reports.push({check:'worker_replay_paging_high_water_and_CAGG_parity',passed:true,kwh:2});
    await client.query('INSERT INTO energy_pipeline_state(company_id,ready)VALUES(4,TRUE)');
    process.env.ENERGY_V2_ENABLED='true';
    const storePath=require.resolve('../src/dashboard/energy-store');saved.set(storePath,require.cache[storePath]);delete require.cache[storePath];
    const store=require(storePath);
    assert.equal(await store.enabled(4),true);
    const opts={companyId:4,machineId:19,start:new Date('2026-10-28T00:00:00+05:30'),end:new Date('2026-10-28T23:59:59.999+05:30')};
    const figures=await store.figures(opts);
    assert.equal(Number(figures.machines[0].kwh),2);
    const shifts=await store.byShift(opts);assert.equal(shifts.reduce((n,r)=>n+(r.kwh||0),0),2);
    const machine=await store.machineEnergy({...opts,asOf:new Date('2026-10-28T11:00:00+05:30')});
    assert.equal(machine.shift_kwh,2);assert.equal(machine.total_energy,102);
    const factory=await store.factoryEnergy({companyId:4,machineId:19,date:'2026-10-28',asOf:'2026-10-28T11:00:00+05:30'});
    assert.equal(factory.kwh,2);assert.equal(factory.energy_complete,false);
    const rows=[{machine_id:19,shift_id:1,hour_start:'2026-10-28T10:00:00+05:30',energy_kwh:999}];
    await store.attachReportEnergy(4,rows,{});assert.equal(rows[0].energy_kwh,2);
    reports.push({check:'all_shared_readers_parity_no_other_tenant_data',passed:true});
    await client.query(`DELETE FROM energy_meter_readings WHERE company_id=4 AND machine_id=19 AND read_at='2026-10-28T10:00:40+05:30'`);
    const {rows:[claim]}=await client.query(`UPDATE energy_reconcile_queue SET claimed_from=from_at,from_at=NULL
      WHERE company_id=4 AND machine_id=19 RETURNING claimed_from`);
    await reconcileMachine(adapter,{companyId:4,machineId:19,from:claim.claimed_from});
    assert.equal((await client.query(`SELECT COUNT(*)::int n FROM energy_counter_intervals WHERE machine_id=19 AND quality='regression'`)).rows[0].n,0);
    reports.push({check:'source_deletion_reconciles_without_orphans',passed:true});
    if(callback)await callback(client,{schema,reports});
    const rawBefore=(await client.query('SELECT COUNT(*)::int AS n FROM energy_meter_readings')).rows[0].n;
    await client.query(partsOf(fs.readFileSync(path.join(ROOT,'src/migrations/rollback/065_energy_continuous_aggregates_down.sql'),'utf8')).body);
    await client.query('SAVEPOINT rollback_guard');
    let refused=false;
    try {
      await client.query(partsOf(fs.readFileSync(path.join(ROOT,'src/migrations/rollback/064_energy_interval_pipeline_down.sql'),'utf8')).body);
    }catch(error){refused=true;await client.query('ROLLBACK TO SAVEPOINT rollback_guard');}
    assert.equal(refused,true,'Nonempty derived-history removal must require a verified backup acknowledgement');
    await client.query("SET LOCAL iot.energy_derived_backup_verified='true'");
    await client.query(partsOf(fs.readFileSync(path.join(ROOT,'src/migrations/rollback/064_energy_interval_pipeline_down.sql'),'utf8')).body);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM energy_meter_readings')).rows[0].n,rawBefore);
    reports.push({check:'rollback_guard_and_preserved_original_readings',passed:true});
    return {schema,checks:reports,rolled_back:true};
  }finally{
    await client.query('ROLLBACK');
    if(oldFlag===undefined)delete process.env.ENERGY_V2_ENABLED;else process.env.ENERGY_V2_ENABLED=oldFlag;
    for(const [key,entry]of saved)if(entry)require.cache[key]=entry;else delete require.cache[key];
    assert.equal((await client.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists',[schema])).rows[0].exists,false);
  }
}
module.exports={verify};
if(require.main===module){
  if(!process.env.ENERGY_TEST_DATABASE_URL){console.error('Set ENERGY_TEST_DATABASE_URL explicitly');process.exit(1);}
  const client=new Client({connectionString:process.env.ENERGY_TEST_DATABASE_URL,application_name:'energy-isolated-verifier',statement_timeout:60000});
  client.connect().then(()=>verify(client)).then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>client.end());
}
