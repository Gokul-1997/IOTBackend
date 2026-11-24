#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { partsOf } = require('./migrate');
async function verify(client, { checkIngestRole = true } = {}) {
  const schema = `reason_verify_${Date.now()}`;
  const migration = partsOf(fs.readFileSync(path.join(__dirname, '../src/migrations/068_controller_downtime_events.sql'), 'utf8')).body;
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema},public;
      SET LOCAL statement_timeout='60s';
      CREATE TABLE companies(id INT PRIMARY KEY);
      CREATE TABLE machines(id INT PRIMARY KEY,company_id INT);
      CREATE TABLE shifts(id INT PRIMARY KEY,company_id INT,start_time TIME,end_time TIME,is_active BOOLEAN);
      CREATE TABLE machine_shift_config(machine_id INT,shift_id INT);
      CREATE TABLE downtime_reasons(id INT PRIMARY KEY,company_id INT,code TEXT,name TEXT,category TEXT,is_active BOOLEAN);
      CREATE TABLE downtime_events(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,shift_id INT,downtime_reason_id INT,
        started_at TIMESTAMPTZ,ended_at TIMESTAMPTZ,notes TEXT,entered_by INT,
        duration_seconds INT GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (ended_at-started_at))::int) STORED);
      CREATE UNIQUE INDEX one_open ON downtime_events(machine_id) WHERE ended_at IS NULL;
      CREATE TABLE telemetry_raw(company_id INT,machine_id INT,device_time BIGINT,received_at TIMESTAMPTZ NOT NULL,
        machine_status TEXT,controller_downtime_value DOUBLE PRECISION);
      INSERT INTO companies VALUES(4),(5);
      INSERT INTO machines VALUES(81,4),(82,5),(83,4);
      INSERT INTO shifts VALUES(1,4,'08:00','20:00',TRUE),(2,5,'08:00','20:00',TRUE);
      INSERT INTO machine_shift_config VALUES(81,1),(82,2),(83,1);
      INSERT INTO downtime_reasons VALUES(4,NULL,'QTY','Wrong database-ID mapping','QUALITY',TRUE),
        (21,4,'0','Maintenance','PLANNED',TRUE),(25,4,'4','TEA','PLANNED',TRUE),
        (27,4,'6','Inspection','QUALITY',TRUE),(35,5,'4','Other company','PLANNED',TRUE);`);
    const timescale = (await client.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'")).rows[0]?.extversion;
    if (timescale) await client.query("SELECT create_hypertable('telemetry_raw','received_at')");
    await client.query(migration);
    await client.query(migration);
    const start = Date.parse('2026-11-23T08:00:00Z') / 1000;
    const send = (offset, status, value, machine=81, tenant=4) => client.query(`INSERT INTO telemetry_raw
      VALUES($1,$2,$3::bigint,to_timestamp($3::bigint+0.5),$4,$5)`, [tenant,machine,start+offset,status,value]);
    await send(0,'IDLE',4); await send(10,'IDLE',4); await send(20,'IDLE',6);
    await send(30,'IDLE',6); await send(35,'RUNNING',6); await send(45,'RUNNING',6);
    await send(50,'IDLE',0); await send(60,'IDLE',0); await send(70,'IDLE',99); await send(80,'IDLE',99);
    let events = (await client.query('SELECT * FROM downtime_events WHERE company_id=4 ORDER BY id')).rows;
    assert.equal(events.length,2);
    assert.deepEqual(events.map(e=>[e.downtime_reason_id,e.duration_seconds,e.source]),[[25,20,'controller'],[27,15,'controller']]);
    assert(events.every(e=>e.shift_id===1&&e.entered_by===null&&e.ended_at));
    await send(15,'IDLE',4); // Late replay must not rewind or duplicate events.
    assert.equal((await client.query('SELECT COUNT(*)::int n FROM downtime_events')).rows[0].n,2);
    await send(90,'IDLE',4); await send(300,'IDLE',4); await send(310,'IDLE',4);
    events = (await client.query('SELECT * FROM downtime_events WHERE company_id=4 ORDER BY id')).rows;
    assert.deepEqual(events.slice(2).map(e=>e.duration_seconds),[60,10]);
    await send(0,'IDLE',4,82,5); await send(10,'IDLE',4,82,5);
    assert.equal((await client.query('SELECT downtime_reason_id FROM downtime_events WHERE company_id=5')).rows[0].downtime_reason_id,35);
    await send(0,'IDLE',0,83); await send(10,'IDLE',0,83);
    assert.equal((await client.query('SELECT COUNT(*)::int n FROM downtime_events WHERE machine_id=83')).rows[0].n,0);
    await client.query(`INSERT INTO downtime_events(company_id,machine_id,downtime_reason_id,started_at,ended_at,notes)
      VALUES(4,81,27,to_timestamp($1),to_timestamp($2),'Operator entry')`,[start+320,start+400]);
    await send(320,'IDLE',4); await send(330,'IDLE',4); await send(340,'RUNNING',4);
    assert.equal((await client.query("SELECT duration_seconds FROM downtime_events WHERE source='manual'")).rows[0].duration_seconds,80);
    assert.equal((await client.query("SELECT MAX(ended_at) AS ended FROM downtime_events WHERE machine_id=81 AND source='controller'")).rows[0].ended.getTime(),(start+320)*1000);
    await send(500,'IDLE',4,82,4); // A mismatched tenant/device cannot produce an event.
    assert.equal((await client.query('SELECT COUNT(*)::int n FROM controller_downtime_state WHERE company_id=4 AND machine_id=82')).rows[0].n,0);
    if (checkIngestRole) {
    await client.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='machine_api_user') THEN CREATE ROLE machine_api_user NOLOGIN; END IF; END $$;
      GRANT USAGE ON SCHEMA ${schema} TO machine_api_user;
      GRANT INSERT ON telemetry_raw TO machine_api_user; SET LOCAL ROLE machine_api_user`);
    await send(500,'IDLE',4,83); await send(510,'RUNNING',4,83);
    await client.query('RESET ROLE');
    assert.equal((await client.query('SELECT duration_seconds FROM downtime_events WHERE machine_id=83')).rows[0].duration_seconds,10);
    }
    const { backfill } = require('./backfill-controller-reasons');
    const before = (await client.query("SELECT downtime_reason_id,SUM(duration_seconds)::int seconds FROM downtime_events WHERE company_id=4 AND machine_id=81 GROUP BY downtime_reason_id ORDER BY downtime_reason_id")).rows;
    const options={companyId:4,machineId:81,from:new Date(start*1000+500),to:new Date((start+600)*1000),transaction:false};
    const preview=await backfill(client,options);
    assert(preview.readings>0&&!preview.applied);
    await backfill(client,{...options,apply:true});
    await backfill(client,{...options,apply:true});
    assert.deepEqual((await client.query("SELECT downtime_reason_id,SUM(duration_seconds)::int seconds FROM downtime_events WHERE company_id=4 AND machine_id=81 GROUP BY downtime_reason_id ORDER BY downtime_reason_id")).rows,before);
    return { passed:true,timescaledb:timescale||null,checks:['configured code mapping','reason change and resume','zero and unmapped','tenant isolation','no silent-gap inflation','manual precedence','idempotent migration','late replay'] };
  } finally { await client.query('ROLLBACK'); }
}
module.exports={verify};
if(require.main===module){
  if(!process.env.REASON_TEST_DATABASE_URL){console.error('Set REASON_TEST_DATABASE_URL to a disposable test database');process.exit(1);}
  const client=new Client({connectionString:process.env.REASON_TEST_DATABASE_URL,application_name:'controller-reason-verifier'});
  client.connect().then(()=>verify(client)).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>client.end());
}
