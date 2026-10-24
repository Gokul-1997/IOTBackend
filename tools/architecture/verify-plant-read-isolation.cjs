#!/usr/bin/env node
/* Actual SQL, HTTP and Socket.IO against a disposable Unix-socket PostgreSQL
 * cluster. Does not load .env, reach deployed services, or mutate existing DBs. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { Pool } = require('pg');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: socketClient } = require('socket.io-client');
const repo = path.resolve(__dirname, '../..');
const pgBin = process.env.PLANT_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-plant-read-fixture-'));
const pmsFixture = fs.readFileSync(path.join(__dirname, 'verify-pms-integrity.cjs'), 'utf8');
const baseSql = pmsFixture.match(/const sql = `([\s\S]*?)`;\n\nasync function/)[1];
let pool, started = false, server, io;
const clients = [];
const redisValues = new Map();
const redis = { status: 'ready', get: async k => redisValues.get(k) ?? null,
  set: async (k,v) => { redisValues.set(k,v); return 'OK'; },
  setex: async (k,_s,v) => { redisValues.set(k,v); return 'OK'; },
  incr: async k => { const n = Number(redisValues.get(k) || 0)+1;redisValues.set(k,String(n)); return n; },
  del: async (...keys) => keys.forEach(k => redisValues.delete(k)) };
const telemetryColumns = ['spindle_load','feed_rate','energy','power','voltage','current','spindle_speed','spindle_motor_temp','spindle_insulation_res','servo_load_x','servo_load_y','servo_load_z','servo_temp_x','servo_temp_y','servo_temp_z','encoder_temp_x','encoder_temp_y','encoder_temp_z','servo_insulation_res_x','servo_insulation_res_y','servo_insulation_res_z','servo_pulse_x','servo_pulse_y','servo_pulse_z','cnc_battery_voltage','apc_battery_voltage','sequence_number','parts_count','device_time'];
function inject(relative, value) { const p = require.resolve(path.join(repo,relative));require.cache[p]={id:p,filename:p,loaded:true,exports:value}; }
(async () => {
 try {
  execFileSync(path.join(pgBin,'initdb'),['-D',path.join(temp,'data'),'-U','cnc_fixture','-A','trust','--no-locale'],{stdio:'pipe'});
  execFileSync(path.join(pgBin,'pg_ctl'),['-D',path.join(temp,'data'),'-l',path.join(temp,'postgres.log'),'-o',`-F -k ${temp} -p 55443 -c listen_addresses=''`,'-w','start'],{stdio:'pipe'});started=true;
  pool=new Pool({host:temp,port:55443,user:'cnc_fixture',database:'postgres',max:4});
  await pool.query(baseSql);
  await pool.query("ALTER TYPE ticket_issue_type ADD VALUE 'PREVENTIVE'");
  await pool.query(`
   ALTER TABLE companies ADD COLUMN name TEXT;
   ALTER TABLE plants ADD COLUMN plant_name TEXT;
   ALTER TABLE users ADD COLUMN auth_revision BIGINT DEFAULT 0, ADD COLUMN user_type TEXT DEFAULT 'company_user';
   ALTER TABLE shifts ADD COLUMN shift_code TEXT DEFAULT 'DAY', ADD COLUMN shift_name TEXT DEFAULT 'Day', ADD COLUMN start_time TIME DEFAULT '00:00', ADD COLUMN end_time TIME DEFAULT '23:59:59', ADD COLUMN break_minutes INT DEFAULT 0;
   UPDATE shifts SET plant_id=NULL WHERE id=1;
   INSERT INTO shifts(id,plant_id,company_id,shift_code,shift_name,is_active)VALUES(3,8,4,'OWN','Own plant shift',TRUE),(4,10,4,'OTHER','Other plant shift',TRUE);
   CREATE TABLE shift_breaks(id INT, break_name TEXT, company_id INT, shift_id INT, start_time TIME, end_time TIME);
   CREATE TABLE permissions(id INT, permission_key TEXT);CREATE TABLE company_permissions(company_id INT, permission_id INT);
   CREATE TABLE operators(id INT PRIMARY KEY,company_id INT,plant_id INT,operator_name TEXT,operator_code TEXT,skill_level TEXT,is_active BOOLEAN DEFAULT TRUE);
   CREATE TABLE operator_machine_assignments(id INT,company_id INT,operator_id INT,machine_id INT,is_active BOOLEAN DEFAULT TRUE,assigned_from TIMESTAMPTZ DEFAULT '2020-01-01',assigned_to TIMESTAMPTZ);
   CREATE TABLE operator_shift_assignments(operator_id INT,company_id INT,shift_id INT,is_active BOOLEAN DEFAULT TRUE,effective_from DATE DEFAULT '2020-01-01',effective_to DATE);
   CREATE TABLE production_hourly(company_id INT,machine_id INT,shift_id INT,hour_start TIMESTAMPTZ,run_seconds INT,idle_seconds INT,manual_seconds INT,produced_qty INT,energy_kwh NUMERIC);
   CREATE TABLE oee_hourly(company_id INT,machine_id INT,shift_id INT,hour_start TIMESTAMPTZ,availability NUMERIC,performance NUMERIC,quality NUMERIC,oee NUMERIC);
   CREATE TABLE oee_shift_summary(machine_id INT,shift_id INT,shift_date DATE,availability NUMERIC,performance NUMERIC,quality NUMERIC,oee NUMERIC);
   CREATE TABLE quality_entries(id SERIAL PRIMARY KEY,machine_id INT,shift_id INT,shift_date DATE,created_at TIMESTAMPTZ DEFAULT NOW(),reject_qty INT,rework_qty INT,entered_by INT);
   CREATE TABLE telemetry_raw(company_id INT,machine_id INT,received_at TIMESTAMPTZ,machine_status TEXT,alarm BOOLEAN,mode TEXT,fan_status JSONB,apc_battery_status JSONB,${telemetryColumns.map(c=>`${c} NUMERIC`).join(',')});
   CREATE TABLE company_settings(company_id INT,energy_rate_per_kwh NUMERIC,currency TEXT,oee_target_percent NUMERIC);
   CREATE TABLE energy_settings(id SERIAL,company_id INT,machine_id INT,cost_per_kwh NUMERIC,currency TEXT,overload_kw NUMERIC,created_by INT,updated_at TIMESTAMPTZ);
   ALTER TABLE machine_alarms ADD COLUMN alarm_code TEXT,ADD COLUMN resolved_at TIMESTAMPTZ,ADD COLUMN started_at TIMESTAMPTZ DEFAULT NOW(),ADD COLUMN ended_at TIMESTAMPTZ,ADD COLUMN shift_id INT DEFAULT 1,ADD COLUMN is_resolved BOOLEAN DEFAULT FALSE;
   ALTER TABLE downtime_events ADD COLUMN operator_id INT,ADD COLUMN sub_reason TEXT;
   ALTER TABLE maintenance_tickets ADD COLUMN schedule_id INT,ADD COLUMN due_date TIMESTAMPTZ,ADD COLUMN resolution_note TEXT;
   ALTER TABLE maintenance_schedules ADD COLUMN grace_days INT DEFAULT 0,ADD COLUMN last_generated_at TIMESTAMPTZ,ADD COLUMN assigned_user_id INT,ADD COLUMN checklist JSONB;
   CREATE TABLE alarm_thresholds(id INT PRIMARY KEY,company_id INT,machine_id INT,alarm_type TEXT,threshold_count INT,window_hours INT,due_hours INT,priority TEXT,is_active BOOLEAN);
   INSERT INTO operators VALUES(1,4,8,'Own operator','OWN','A',TRUE),(2,4,10,'Other operator','OTHER','A',TRUE);
   INSERT INTO operator_machine_assignments(id,company_id,operator_id,machine_id)VALUES(1,4,1,7),(2,4,2,10);
   INSERT INTO operator_shift_assignments(operator_id,company_id,shift_id)VALUES(1,4,1),(2,4,1);
   INSERT INTO production_hourly SELECT company_id,id,1,date_trunc('hour',NOW()),1800,1000,0,CASE id WHEN 7 THEN 111 WHEN 10 THEN 777 WHEN 99 THEN 999 WHEN 100 THEN 888 ELSE 555 END,1 FROM machines;
   INSERT INTO oee_hourly SELECT company_id,id,1,date_trunc('hour',NOW()),50,60,70,21 FROM machines;
   INSERT INTO oee_shift_summary SELECT id,1,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,50,60,70,21 FROM machines;
   INSERT INTO quality_entries(machine_id,shift_id,shift_date,created_at,reject_qty,rework_qty) SELECT id,1,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,NOW(),1,0 FROM machines;
   INSERT INTO telemetry_raw(company_id,machine_id,received_at,machine_status,alarm,energy,power,voltage,current)SELECT company_id,id,NOW(),'RUNNING',FALSE,100,2,415,2 FROM machines;
   INSERT INTO company_settings VALUES(4,10,'INR',85);
   INSERT INTO energy_settings(company_id,machine_id,cost_per_kwh,currency,overload_kw,updated_at) VALUES(4,NULL,10,'INR',100,NOW());
   INSERT INTO downtime_events(company_id,machine_id,shift_id,started_at,ended_at)VALUES(4,7,1,NOW()-INTERVAL '10 minutes',NOW()),(4,10,1,NOW()-INTERVAL '20 minutes',NOW());
   INSERT INTO maintenance_schedules(id,company_id,machine_id,title,frequency,next_due_at)VALUES(1,4,7,'Own schedule','DAILY',NOW()),(2,4,10,'Other schedule','DAILY',NOW());
   INSERT INTO maintenance_tickets(id,company_id,machine_id,title,status,issue_type,priority,schedule_id,due_date,created_at)VALUES(1,4,7,'Own ticket','OPEN','BREAKDOWN','HIGH',1,NOW(),NOW()),(2,4,10,'Other ticket','OPEN','BREAKDOWN','HIGH',2,NOW(),NOW());
   INSERT INTO alarm_thresholds VALUES(1,4,NULL,'AXIS',3,24,24,'HIGH',TRUE);
  `);
  inject('src/db.js',pool);inject('src/redis.js',redis);
  inject('src/utils/nodemailer/index.js',{sendMail:async()=>{throw new Error('Fixture never sends email');}});
  inject('src/audit/audit.service.js',{log:()=>{throw new Error('Fixture should not invoke audited writes');}});
  process.env.STORAGE_ROOT=path.join(temp,'storage');
  process.env.PROGRAM_TRANSFER_DIR=path.join(temp,'program-files');
  await pool.query(`
   ALTER TABLE machines ADD COLUMN controller_ip TEXT;
   UPDATE machines SET ip_address='192.168.1.'||id,program_path='/programs';
   CREATE TABLE program_devices(id SERIAL PRIMARY KEY,company_id INT,machine_id INT,label TEXT,token_prefix TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),last_seen_at TIMESTAMPTZ,last_seen_ip TEXT,agent_version TEXT,revoked_at TIMESTAMPTZ);
   CREATE TABLE program_gateway_tokens(id SERIAL PRIMARY KEY,company_id INT,token_prefix TEXT,token_hash TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),last_seen_at TIMESTAMPTZ,last_seen_ip TEXT,agent_version TEXT,revoked_at TIMESTAMPTZ);
   CREATE TABLE program_files(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,folder TEXT,stored_name TEXT,program_name TEXT,kind TEXT,size_bytes INT,sha256 TEXT,uploaded_by INT,note TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),deleted_at TIMESTAMPTZ,deleted_by INT,device_id INT,job_id BIGINT,gateway_token_id INT,delivery_status TEXT,delivery_message TEXT,delivered_at TIMESTAMPTZ);
   CREATE TABLE program_jobs(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,machine_serial TEXT,action VARCHAR(10) CHECK(action IN ('SEND','FETCH')),program_name TEXT NOT NULL,file_id BIGINT,backup_file_id BIGINT,overwrite BOOL DEFAULT FALSE,status TEXT DEFAULT 'QUEUED',message TEXT,requested_by INT,device_id INT,requested_at TIMESTAMPTZ DEFAULT NOW(),delivered_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,program_path TEXT);
   CREATE TABLE program_controller_files(machine_id INT PRIMARY KEY,files JSONB,reported_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE program_backup_requests(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,requested_by INT,requested_at TIMESTAMPTZ DEFAULT NOW(),file_id BIGINT,closed_at TIMESTAMPTZ,error_message TEXT);
   CREATE UNIQUE INDEX ON program_backup_requests(machine_id) WHERE closed_at IS NULL;
   INSERT INTO program_files(id,company_id,machine_id,folder,stored_name,program_name,kind,size_bytes,sha256,uploaded_by)VALUES(1,4,7,'own','own.nc','O7.nc','NEW',3,repeat('a',64),1),(2,4,10,'other','other.nc','O10.nc','NEW',3,repeat('b',64),2),(3,5,9,'foreign','foreign.nc','O9.nc','NEW',3,repeat('c',64),1);
   INSERT INTO program_jobs(company_id,machine_id,machine_serial,action,program_name,file_id,requested_by,program_path)VALUES(4,7,'VMC-7','SEND','O7.nc',1,1,'/programs'),(4,10,'Other plant','SEND','O10.nc',2,2,'/programs'),(5,9,'VMC-9','SEND','O9.nc',3,1,'/programs');
   INSERT INTO users(id,company_id,plant_id,username,is_active)VALUES(4,5,9,'Foreign technician',TRUE),(5,4,8,'Inactive technician',FALSE);
  `);
  for(const name of ['039_program_current.sql','040_program_commands.sql','059_program_sent_to_gateway.sql'])await pool.query(fs.readFileSync(path.join(repo,'src/migrations',name),'utf8'));
  await pool.query("UPDATE program_files SET folder='company-'||company_id||'/machine-'||machine_id");
  fs.mkdirSync(path.join(temp,'program-files','company-4','machine-7'),{recursive:true});
  fs.writeFileSync(path.join(temp,'program-files','company-4','machine-7','own.nc'),'M30');
  process.env.JWT_SECRET='isolated-plant-read-secret';
  const meter = require(path.join(repo,'src/dashboard/energy-meter.service'));
  await pool.query(`CREATE TABLE energy_meter_readings(machine_id INT,read_at TIMESTAMPTZ,${meter.READING_COLUMNS.map(c=>`${c} NUMERIC`).join(',')}); INSERT INTO energy_meter_readings(machine_id,read_at,kwh_total,kw_total,v_ll_avg)VALUES(7,NOW(),100,2,415),(10,NOW(),500,3,415)`);
  await pool.query(`CREATE FUNCTION time_bucket(INTERVAL,TIMESTAMPTZ) RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE AS 'SELECT date_bin($1,$2,TIMESTAMPTZ ''2000-01-01 00:00:00+00'')'`);
  const app=express();app.use(express.json());
  app.use('/api/dashboard',require(path.join(repo,'src/dashboard/dashboard.routes')));
  app.use('/api/reports',require(path.join(repo,'src/reports/report.routes')));
  app.use('/api/reports',require(path.join(repo,'src/reports/operator.report.routes')));
  app.use('/api/oee',require(path.join(repo,'src/oee/oee.routes')));
  app.use('/api/charts',require(path.join(repo,'src/charts/charts.routes')));
  app.use('/api/master',require(path.join(repo,'src/master/master.routes')));
  app.use('/api/programs',require(path.join(repo,'src/programs/program.routes')));
  app.use((e,_req,res,_next)=>res.status(e.status||500).json({message:e.message}));
  const placement=require(path.join(repo,'src/lib/machine-placement'));
  // The startup regression must accept valid tenants while excluding legacy
  // missing owners/unknown status. These rows exist only in this disposable DB.
  await pool.query("INSERT INTO machines(id,company_id,plant_id,is_active)VALUES(888,NULL,8,TRUE),(889,4,8,NULL)");
  const loaded=await placement.load(pool);assert.equal(loaded.excluded,2);
  assert.equal(placement.resolve({machine_id:888,company_id:4}),null);
  assert.equal(placement.resolve({machine_id:889,company_id:4}),null);
  assert.equal(placement.resolve({machine_id:7,company_id:4}).plant_id,8);
  await pool.query('DELETE FROM machines WHERE id IN (888,889)');
  server=http.createServer(app);io=new Server(server);const sockets=require(path.join(repo,'src/lib/socket-server'));sockets.attach(io,{db:pool});
  await new Promise((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  const modules=['factory','maintenance','preventive','periodic','alarms','downtime','operators','oee','energy'];
  const permissions=['page:dashboard:view','page:dashboard:live:view','page:charts:view','page:reports:view','page:reports:export','page:oee-reports:view','page:oee-reports:export','page:maintenance-report:view','page:maintenance-report:export','page:programs:view','page:programs:transfer','page:programs:fetch','page:programs:delete','page:machines:edit','machine.update',...modules.flatMap(m=>[`page:analytics-${m}:view`,`page:analytics-${m}:export`])];
  function token(id,roles=['MAINTENANCE']){return jwt.sign({user_id:id,company_id:5,plant_id:999,roles,permissions},process.env.JWT_SECRET);}
  async function get(route,id=1,roles){const response=await fetch(url+route,{headers:{authorization:`Bearer ${token(id,roles)}`}});const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}assert.equal(response.status,200,`${route}: ${raw}`);return body;}
  const today=(await pool.query("SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS day")).rows[0].day;
  for(const paged of ['', '?paged=1&per_page=100']){
   assert.deepEqual((await get('/api/dashboard'+paged)).machines.map(m=>m.machine_id),[7]);
   assert.deepEqual((await get('/api/dashboard'+paged,2)).machines.map(m=>m.machine_id),[10]);
   assert.equal((await get('/api/dashboard'+paged,1,['COMPANY_ADMIN'])).machines.length,4);
  }
  for(const route of [`/api/reports/production-data?date_from=${today}&date_to=${today}`,`/api/reports/oee-hourly-data?date_from=${today}&date_to=${today}`,`/api/reports/shift-oee-data?date_from=${today}&date_to=${today}`]){
   const own=await get(route),other=await get(route,2),admin=await get(route,1,['COMPANY_ADMIN']);
   assert.deepEqual(own.data.rows.map(r=>r.machine),['VMC-7']);assert.deepEqual(other.data.rows.map(r=>r.machine),['Other plant']);assert.equal(admin.data.rows.length,4);
   const named=await get(route+'&machine_id=10');assert.equal(named.data.rows.length,0);
  }
  const range=`?from=${today}&to=${today}&date=${today}`;
  for(const mod of modules){
   const own=await get('/api/dashboard/'+mod+range),other=await get('/api/dashboard/'+mod+range,2),admin=await get('/api/dashboard/'+mod+range,1,['COMPANY_ADMIN']);
   assert(!JSON.stringify(own).includes('Other plant'),`${mod} leaks other plant`);assert(!JSON.stringify(other).includes('VMC-7'),`${mod} leaks first plant`);
   assert(!JSON.stringify(admin).includes('VMC-9'),`${mod} leaks company`);
  }
  assert.equal((await get('/api/dashboard/factory'+range)).data.production.produced,111);
  assert.equal((await get('/api/dashboard/factory'+range,2)).data.production.produced,777);
  assert.equal((await get('/api/dashboard/factory'+range,1,['COMPANY_ADMIN'])).data.production.produced,2775);
  const forbidden=await fetch(url+'/api/dashboard/live/10',{headers:{authorization:`Bearer ${token(1)}`}});assert.equal(forbidden.status,404);
  assert.equal((await get('/api/dashboard/live/7')).data.machine.id,7);
  for (const panel of ['timeline','spindle','meter']) {
    assert.equal((await fetch(url+`/api/dashboard/live/10/${panel}`,{headers:{authorization:`Bearer ${token(1)}`}})).status,404);
    const own = await get(`/api/dashboard/live/7/${panel}`);assert(!JSON.stringify(own).includes('Other plant'));
  }
  assert.deepEqual((await get('/api/dashboard/energy/meter')).data.meters.map(m=>m.id),[7]);
  assert.deepEqual((await get('/api/reports/operator-performance')).data.map(r=>r.operator_id),[1]);
  assert.deepEqual((await get('/api/oee/reports')).data.map(r=>r.machine_id),[7]);
  assert(!String(await get(`/api/oee/export?from_date=${today}&to_date=${today}`)).includes('Other plant'));
  for(const type of ['production','hourly-oee','shift-oee']) {
    const response=await fetch(url+`/api/reports/${type}?date=${today}`,{headers:{authorization:`Bearer ${token(1)}`}});assert.equal(response.status,200);
    const ExcelJS=require('exceljs'),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const cells=JSON.stringify(workbook.worksheets[0].getSheetValues());assert(cells.includes('VMC-7'));assert(!cells.includes('Other plant'));assert(!cells.includes('VMC-9'));
  }
  for(const mod of ['alarms','downtime','operators','oee','energy','periodic']){const body=await get(`/api/dashboard/${mod}/export/csv${range}`);assert(!String(body).includes('Other plant'),`${mod} CSV leaks other plant`);}
  assert.deepEqual((await get('/api/reports/machines')).data.map(r=>r.id),[7]);
  assert.deepEqual((await get('/api/charts/meta')).data.machines.map(r=>r.id),[7]);
  for (const route of ['/api/charts/meta','/api/oee/meta']) {
    assert.deepEqual((await get(route)).data.shifts.map(r=>r.id).sort(),[1,3]);
    assert.deepEqual((await get(route,2)).data.shifts.map(r=>r.id).sort(),[1,4]);
    assert.deepEqual((await get(route,1,['COMPANY_ADMIN'])).data.shifts.map(r=>r.id).sort(),[1,3,4]);
  }
  assert.deepEqual((await get('/api/master/shifts')).data.map(r=>r.id).sort(),[1,3]);
  const badShift = await fetch(url+`/api/charts/data?machine_id=7&date=${today}&shift_id=4`,{headers:{authorization:`Bearer ${token(1)}`}});assert.equal(badShift.status,404);
  const badWindow = await fetch(url+`/api/dashboard/factory?date=${today}&shift_id=4`,{headers:{authorization:`Bearer ${token(1)}`}});assert.equal(badWindow.status,404);
  assert.deepEqual((await get('/api/oee/meta')).data.machines.map(r=>r.id),[7]);
  assert.equal((await get(`/api/charts/data?machine_id=7&date=${today}&shift_id=1`)).data.totalProduced,111);
  const badChart=await fetch(url+`/api/charts/data?machine_id=10&date=${today}&shift_id=1`,{headers:{authorization:`Bearer ${token(1)}`}});assert.equal(badChart.status,404);
  const scopeForWrite = require(path.join(repo,'src/lib/read-scope'));
  const periodic = require(path.join(repo,'src/dashboard/periodic.service'));
  await scopeForWrite.run({company_id:4,plant_id:8},async()=> {
    const schedule={id:1,company_id:4,machine_id:7,title:'Scoped schedule',frequency:'DAILY',next_due_at:new Date().toISOString(),grace_days:0};
    for(const assigned_user_id of [2,4,5])await assert.rejects(()=>periodic.upsertSchedule({...schedule,assigned_user_id}),e=>e.status===404);
    for(const assigned_user_id of [1,3])assert.equal((await periodic.upsertSchedule({...schedule,assigned_user_id})).assigned_user_id,assigned_user_id);
  });
  assert.deepEqual((await get('/api/programs/machines')).data.map(m=>m.id),[7]);
  assert.deepEqual((await get('/api/programs/machines',2)).data.map(m=>m.id),[10]);
  assert.equal((await get('/api/programs/machines',1,['COMPANY_ADMIN'])).data.length,4);
  // Program Transfer files are listed one machine at a time (21 Oct 2026)
  assert.deepEqual((await get('/api/programs/files?machine_id=7')).data.map(row=>row.machine_id),[7]);
  assert.deepEqual((await get('/api/programs/files?machine_id=10',2)).data.map(row=>row.machine_id),[10]);
  assert.equal((await get('/api/programs/files?machine_id=10',1,['COMPANY_ADMIN'])).data.length,1);
  assert.equal(await get('/api/programs/files/1/download'),'M30');
  for(const [method,route] of [['GET','/api/programs/files?machine_id=10'],['GET','/api/programs/files/2/download'],['DELETE','/api/programs/files/2'],['POST','/api/programs/machines/10/backup']]) {
   const result=await fetch(url+route,{method,headers:{authorization:`Bearer ${token(1)}`}});assert.equal(result.status,404,`${method} ${route}`);
  }
  assert.equal((await pool.query('SELECT deleted_at FROM program_files WHERE id=2')).rows[0].deleted_at,null);
  const quality=require(path.join(repo,'src/quality/quality.service'));
  await pool.query("UPDATE shifts SET start_time='08:15',end_time='16:00' WHERE id=3; INSERT INTO production_hourly(company_id,machine_id,shift_id,hour_start,run_seconds,idle_seconds,produced_qty)VALUES(4,7,3,'2026-05-06T02:30:00Z',900,1800,10),(5,7,3,'2026-05-06T02:30:00Z',900,1800,999)");
  const qualityArgs={company_id:4,machine_id:7,shift_id:3,date:'2026-05-06',rework_qty:0,user_id:1};
  await scopeForWrite.run({company_id:4,plant_id:8},async()=> {
   const writes=await Promise.all([3,4].map(reject_qty=>quality.upsertQualityEntryService({...qualityArgs,reject_qty})));
   assert.deepEqual(writes.map(w=>w.action).sort(),['created','updated']);
   assert.equal((await pool.query("SELECT count(*)::int n FROM quality_entries WHERE machine_id=7 AND shift_id=3 AND shift_date='2026-05-06'")).rows[0].n,1);
   // The first partial hour contributes 10, while the poisoned foreign-company
   // row contributes zero. The former implementation would see no production.
   await assert.rejects(()=>quality.upsertQualityEntryService({...qualityArgs,reject_qty:11}),e=>e.status===422);
   await assert.rejects(()=>quality.upsertQualityEntryService({...qualityArgs,reject_qty:1,machine_id:10}),e=>e.status===404);
   await assert.rejects(()=>quality.upsertQualityEntryService({...qualityArgs,reject_qty:1,date:'2026-02-31'}),e=>e.status===400);
   await pool.query("INSERT INTO quality_entries(machine_id,shift_id,shift_date,reject_qty,rework_qty)VALUES(7,3,'2026-05-06',1,0)");
   const before=(await pool.query("SELECT id,reject_qty,rework_qty FROM quality_entries WHERE machine_id=7 AND shift_id=3 AND shift_date='2026-05-06' ORDER BY id")).rows;
   await assert.rejects(()=>quality.upsertQualityEntryService({...qualityArgs,reject_qty:2}),e=>e.status===409&&e.code==='QUALITY_TOTALS_AMBIGUOUS');
   assert.deepEqual((await pool.query("SELECT id,reject_qty,rework_qty FROM quality_entries WHERE machine_id=7 AND shift_id=3 AND shift_date='2026-05-06' ORDER BY id")).rows,before);
  });
  const redisKeys=[...redisValues.keys()].filter(k=>k.startsWith('dash:'));assert(redisKeys.length>=3,'Dashboard caching exercised');
  const cache=require(path.join(repo,'src/dashboard/cache'));const scope=require(path.join(repo,'src/lib/read-scope'));
  const values=await Promise.all([scope.run({company_id:4,plant_id:8},()=>cache.remember('scope-probe',4,{},30,async()=>8)),scope.run({company_id:4,plant_id:10},()=>cache.remember('scope-probe',4,{},30,async()=>10)),scope.run({company_id:4,plant_id:8,roles:['COMPANY_ADMIN']},()=>cache.remember('scope-probe',4,{},30,async()=>null))]);assert.deepEqual(values,[8,10,null]);
  async function connected(id,roles){
   const c=socketClient(url,{auth:{token:token(id,roles)},transports:['websocket'],reconnection:false});clients.push(c);
   await new Promise((r,j)=>{c.on('connect',r);c.on('connect_error',j);});
   // Connection registration has a final revocation check. An invalid scope
   // request acknowledges only after that check, preserving the default feed.
   await new Promise((r,j)=>c.timeout(1000).emit('subscribeMachines',null,(error,result)=>{
    if(error)return j(error);if(result?.code!=='INVALID_SUBSCRIPTION')return j(new Error('Unexpected readiness probe result'));r();
   }));
   return c;
  }
  const a=await connected(1),b=await connected(2),admin=await connected(1,['COMPANY_ADMIN']);
  const received=[[],[],[]];[a,b,admin].forEach((c,i)=>c.on('machineUpdate',d=>received[i].push(d.machine_id)));
  a.emit('joinPlant',10);sockets.relay(io,JSON.stringify({company_id:4,plant_id:8,machine_id:7}));sockets.relay(io,JSON.stringify({company_id:4,plant_id:10,machine_id:10}));sockets.relay(io,JSON.stringify({company_id:5,plant_id:9,machine_id:9}));sockets.relay(io,JSON.stringify({company_id:4,plant_id:null,machine_id:100}));
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(received,[[7],[10],[7,10,100]]);
  const subscribe=(c,ids)=>new Promise((r,j)=>c.timeout(1000).emit('subscribeMachines',ids,(e,v)=>e?j(e):r(v)));
  assert.deepEqual(await subscribe(a,[10]),{ok:false,code:'FORBIDDEN'});assert.deepEqual(await subscribe(a,[7]),{ok:true});
  sockets.relay(io,JSON.stringify({company_id:4,plant_id:10,machine_id:10}));await new Promise(r=>setTimeout(r,100));assert.deepEqual(received[0],[7]);
  // Collector placement can lag a machine edit. Routing must use the API's
  // current authorized placement, rather than the plant in that old payload.
  sockets.relay(io,JSON.stringify({company_id:4,plant_id:10,machine_id:7}));
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(received[0],[7,7]);assert.deepEqual(received[1],[10,10]);
  const counts=received.map(list=>list.length);
  sockets.relay(io,JSON.stringify({company_id:4,plant_id:8,machine_id:9}));
  sockets.relay(io,JSON.stringify({company_id:4,plant_id:8,machine_id:123456}));
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(received.map(list=>list.length),counts);
  await pool.query('UPDATE machines SET plant_id=10 WHERE id=7');placement.upsert({id:7,company_id:4,plant_id:10,is_active:true});
  sockets.relay(io,JSON.stringify({company_id:4,plant_id:8,machine_id:7}));
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(received[0],[7,7]);assert.deepEqual(received[1],[10,10,7]);
  placement.upsert({id:7,company_id:4,plant_id:10,is_active:false});
  const afterMove=received.map(list=>list.length);sockets.relay(io,JSON.stringify({company_id:4,plant_id:8,machine_id:7}));
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(received.map(list=>list.length),afterMove);
  console.log('Plant isolation passed: actual PostgreSQL, JWT HTTP routes, legacy/paged fleet, detail, all 9 analytics dashboards, charts, OEE and production reports, CSV/XLSX exports, shared-shift dropdowns, periodic assignees, legacy program guards, concurrent quality saves/partial shift bounds/duplicate preservation, Redis cache separation and Socket.IO subscriptions. Server-derived company/plant defeats forged claims; company admins remain company-wide.');
 } finally {
  clients.forEach(c=>c.close());if(io)await new Promise(r=>io.close(r));if(server?.listening)await new Promise(r=>server.close(r));if(pool)await pool.end();
  if(started)execFileSync(path.join(pgBin,'pg_ctl'),['-D',path.join(temp,'data'),'-m','immediate','-w','stop'],{stdio:'pipe'});fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
