#!/usr/bin/env node
/* Isolated capacity fixture: actual MQTT admission/journal/flusher, PostgreSQL/
 * TimescaleDB, JWT auth/access, fleet SQL and Socket.IO. Never loads .env.
 * No existing URL or database is accepted. This is not a production capacity SLA. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const { Pool } = require('pg');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: socketClient } = require('socket.io-client');
const root = path.resolve(__dirname, '../..');
const collector = path.resolve(root, '../pms-backend');
const mqtt = require(path.join(collector, 'node_modules/mqtt'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-capacity-'));
const pgBin = '/opt/homebrew/bin';
const rounds = Number(process.argv[2] || 5);
const historyRows = Number(process.argv[3] || 1000000);
assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 30);
assert.ok(Number.isInteger(historyRows) && historyRows >= 0 && historyRows <= 5000000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (values, p) => values.length ? +[...values].sort((a,b)=>a-b)[Math.min(values.length-1, Math.floor(values.length*p))].toFixed(2) : null;
const inject = (file, exports) => { const id = require.resolve(path.join(root, file)); require.cache[id] = { id, filename:id, loaded:true, exports }; };
let pool, postgresStarted = false, broker, publisher, receiver, server, io, journal, flusher;
const clients = [];
const samplers = new Set();
const born = new Map(), committed = [], queryTimes = [], fleetTimes = [];
let liveLeaks = 0, liveEvents = 0, published = 0, failures = 0;
const freePort = () => new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));}); });
const connect = client => new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
(async()=>{
 try {
  execFileSync(path.join(pgBin,'initdb'), ['-D',path.join(directory,'data'),'-U','audit_fixture','-A','trust','--no-locale'], {stdio:'pipe'});
  execFileSync(path.join(pgBin,'pg_ctl'), ['-D',path.join(directory,'data'),'-l',path.join(directory,'postgres.log'),'-o',`-k ${directory} -p 55449 -c listen_addresses='' -c shared_preload_libraries=timescaledb`,'-w','start'],{stdio:'pipe'});
  postgresStarted=true;
  pool=new Pool({host:directory,port:55449,user:'audit_fixture',database:'postgres',max:20,statement_timeout:10000,connectionTimeoutMillis:5000});
  await pool.query('CREATE EXTENSION timescaledb');
  const versions=(await pool.query("SELECT current_setting('server_version') AS postgres,extversion AS timescale FROM pg_extension WHERE extname='timescaledb'")).rows[0];
  const load = file => import(pathToFileURL(path.join(collector,file)));
  const {TELEMETRY_COLUMNS,telemetryInsert}=await load('buffer.js');
  const json=new Set(['fan_status','extra_axes','apc_battery_status']),text=new Set(['machine_status','mode']);
  await pool.query(`CREATE TABLE companies(id INT PRIMARY KEY,is_active BOOLEAN DEFAULT TRUE);
   INSERT INTO companies VALUES(1),(2),(3);
   CREATE TABLE users(id INT PRIMARY KEY,username TEXT,company_id INT,plant_id INT,user_type TEXT,is_active BOOLEAN DEFAULT TRUE,auth_revision BIGINT DEFAULT 0);
   INSERT INTO users SELECT i,'Fixture-'||i,1+(i-1)%3,NULL,'company_admin',TRUE,0 FROM generate_series(1,100)i;
   CREATE TABLE machines(id INT PRIMARY KEY,company_id INT,plant_id INT,machine_serial_no TEXT,image_url TEXT,is_active BOOLEAN DEFAULT TRUE);
   INSERT INTO machines SELECT i,1+(i-1)%3,NULL,'CNC-'||i,NULL,TRUE FROM generate_series(1,1000)i;
   CREATE TABLE permissions(id INT PRIMARY KEY,permission_key TEXT); INSERT INTO permissions VALUES(1,'page:dashboard:view');
   CREATE TABLE company_permissions(company_id INT,permission_id INT);INSERT INTO company_permissions VALUES(1,1),(2,1),(3,1);
   CREATE TABLE telemetry_raw(${TELEMETRY_COLUMNS.map(c=>`${c} ${c==='received_at'?'TIMESTAMPTZ NOT NULL':c==='alarm'?'BOOLEAN':json.has(c)?'JSONB':text.has(c)?'TEXT':'DOUBLE PRECISION'}`).join(',')});
   SELECT create_hypertable('telemetry_raw','received_at',chunk_time_interval=>INTERVAL '1 day');
   CREATE INDEX telemetry_company_machine_time ON telemetry_raw(company_id,machine_id,received_at DESC);
   CREATE TABLE production_hourly(company_id INT,machine_id INT,shift_id INT,hour_start TIMESTAMPTZ,run_seconds INT,idle_seconds INT,manual_seconds INT,produced_qty INT,energy_kwh DOUBLE PRECISION,PRIMARY KEY(machine_id,shift_id,hour_start));
   CREATE TABLE ingest_checkpoint(collector_id TEXT PRIMARY KEY,last_seq BIGINT NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE machine_alarms(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,shift_id INT,alarm_type VARCHAR(50),alarm_code VARCHAR(50),severity VARCHAR(20),message TEXT,started_at TIMESTAMPTZ,created_at TIMESTAMPTZ,ended_at TIMESTAMPTZ,notification_continuity_started_at TIMESTAMPTZ);
   CREATE UNIQUE INDEX alarm_open ON machine_alarms(machine_id,COALESCE(alarm_code,alarm_type)) WHERE ended_at IS NULL;`);
  await pool.query('ALTER TABLE machines ADD UNIQUE(company_id,id); CREATE TABLE notifications(id BIGSERIAL PRIMARY KEY,company_id INT,user_id INT); CREATE ROLE machine_api_user NOLOGIN');
  for (const migration of ['043_ingest_gaps.sql','047_alarm_notifications.sql','048_alarm_notification_policies.sql']) {
   await pool.query(fs.readFileSync(path.join(root,'src/migrations',migration),'utf8'));
  }
  const seedAt=performance.now();
  await pool.query(`INSERT INTO telemetry_raw(machine_id,company_id,machine_status,alarm,received_at,device_time)
   SELECT 1+(g-1)%1000,1+((g-1)%1000)%3,'RUNNING',FALSE,NOW()-INTERVAL '2 hours'-(g%86400)*INTERVAL '1 second',EXTRACT(EPOCH FROM NOW())-7200-(g%86400) FROM generate_series(1,$1::INT)g`,[historyRows]);
  await pool.query('ANALYZE telemetry_raw; ANALYZE machines');
  const historySeedMs=Math.round(performance.now()-seedAt);
  console.error('Fixture database ready:', JSON.stringify(versions), 'history rows:', historyRows);
  const originalQuery = pool.query.bind(pool);
  pool.query = (...args) => { const start = performance.now(); return originalQuery(...args).finally(() => queryTimes.push(performance.now()-start)); };
  inject('src/db.js',pool);
  const cache=new Map();
  inject('src/redis.js',{get:async key=>cache.get(key)??null,set:async(key,value)=>{cache.set(key,value);return'OK';},del:async key=>cache.delete(key)});
  process.env.JWT_SECRET='local-capacity-fixture-only';
  const auth=require(path.join(root,'src/middleware/auth.middleware'));
  const access=require(path.join(root,'src/middleware/access.middleware'));
  const {fleetPage,parseFleetPage}=require(path.join(root,'src/dashboard/fleet-page'));
  const socketServer=require(path.join(root,'src/lib/socket-server'));
  const placements=require(path.join(root,'src/lib/machine-placement'));
  await placements.load(pool);
  const app=express();
  app.get('/api/dashboard',auth,access('page:dashboard:view'),async(req,res,next)=>{const start=performance.now();try{res.json(await fleetPage(req.user.company_id,parseFleetPage(req.query)));}catch(error){next(error);}finally{fleetTimes.push(performance.now()-start);}});
  app.use((error,req,res,next)=>res.status(500).json({error:error.message}));
  server=http.createServer(app);io=new Server(server);socketServer.attach(io,{db:pool});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const tokens=Array.from({length:100},(_,i)=>jwt.sign({user_id:i+1,company_id:999,roles:['COMPANY_ADMIN'],permissions:['page:dashboard:view'],auth_revision:'0'},process.env.JWT_SECRET,{expiresIn:'1h'}));
  await Promise.all(tokens.map(async(token,index)=>{
   const company=1+index%3,id=index+1;
   const client=socketClient(url,{auth:{token},transports:['websocket'],reconnection:false});clients.push(client);
   client.on('machineUpdate',event=>{liveEvents++;if(event.company_id!==company||event.machine_id!==id)liveLeaks++;});
   await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});
   await new Promise((resolve,reject)=>client.emit('subscribeMachines',[id],result=>result.ok?resolve():reject(Error('Subscription refused'))));
  }));
  console.error('Authenticated dashboard sockets ready:', clients.length);
  journal=(await load('src/lib/journal.js')).createJournal({dir:path.join(directory,'journal'),maxBytes:128*1024**2});journal.open();
  const writerPool = { query: (...args) => pool.query(...args), connect: async () => {
   const client = await pool.connect(); let batch = [];
   return { release: (...args) => client.release(...args), query: async (statement, values) => {
    const text = typeof statement === 'string' ? statement : statement.text;
    const parameters = values || statement.values || [];
    const at = performance.now();
    const result = await client.query(statement, values); queryTimes.push(performance.now()-at);
    if (/INSERT INTO telemetry_raw/.test(text)) {
     for (let i=0;i<parameters.length;i+=TELEMETRY_COLUMNS.length) batch.push(`${parameters[i+TELEMETRY_COLUMNS.indexOf('machine_id')]}:${parameters[i+TELEMETRY_COLUMNS.indexOf('parts_count')]}`);
    }
    if (text === 'COMMIT') { for (const key of batch) { if (born.has(key)) { committed.push(performance.now()-born.get(key)); born.delete(key); } } batch=[]; }
    if (text === 'ROLLBACK') batch=[];
    return result;
   }};
  }};
  flusher=(await load('src/lib/flusher.js')).createFlusher({pool:writerPool,journal,collectorId:'capacity-fixture',telemetryInsert,log:(level,message,detail)=>{if(level!=='info') console.error(message,JSON.stringify(detail));}});await flusher.start();
  const machineMap=new Map((await pool.query('SELECT * FROM machines')).rows.map(row=>[String(row.id),row]));
  const redis={isReady:true,multi:()=>{let message;return {setEx(){return this;},publish(channel,data){message=data;return this;},async exec(){socketServer.relay(io,message);return[];}};}};
  const acceptedAt=[];
  const processor=(await load('src/lib/message-processor.js')).createMessageProcessor({journal,redis,hydrate:async()=>null,lookupMachine:async key=>machineMap.get(key),
   shifts:{shiftFor:company=>company,shiftsOf:company=>[{id:company,start:0,end:86399}]},count:name=>{if(name==='accepted')acceptedAt.push(performance.now());}});
  const port=await freePort(),config=path.join(directory,'mosquitto.conf');
  fs.writeFileSync(config,`listener ${port} 127.0.0.1\nallow_anonymous true\nmax_queued_messages 20000\nmax_queued_bytes 134217728\nmessage_size_limit 65536\n`);
  broker=spawn('/opt/homebrew/sbin/mosquitto',['-c',config],{stdio:'ignore'});await wait(300);
  const brokerUrl=`mqtt://127.0.0.1:${port}`;
  receiver=mqtt.connect(brokerUrl,{clientId:'audit-collector',clean:false,reconnectPeriod:1000});
  (await load('src/lib/admission.js')).installAdmission(receiver,{process:processor.handleMessage,count:name=>{if(name==='admission_failed')failures++;}});
  await connect(receiver);await receiver.subscribeAsync('machines/+/telemetry',{qos:1});
  publisher=mqtt.connect(brokerUrl,{clientId:'audit-gateway',reconnectPeriod:1000});await connect(publisher);
  const counters=new Map(),results=[];
  for(const size of [50,100,500,1000]){
   const samples=[],lag=monitorEventLoopDelay({resolution:10});lag.enable();
   const at=performance.now(),cpu=process.cpuUsage(),expectedBefore=published,startAccepted=acceptedAt.length,liveBefore=liveEvents,commitBefore=committed.length,queryBefore=queryTimes.length,fleetBefore=fleetTimes.length;
   let rssPeak=process.memoryUsage().rss,poolWaitPeak=0,apiErrors=0,apiRequests=0,apiBytes=0;
   const sampleTimer=setInterval(()=>{rssPeak=Math.max(rssPeak,process.memoryUsage().rss);poolWaitPeak=Math.max(poolWaitPeak,pool.waitingCount);},50);
   samplers.add(sampleTimer);
   const deadline=performance.now()+rounds*1000;
   const viewers=Promise.all(tokens.map(async(token,index)=>{while(performance.now()<deadline){const requested=performance.now();try{
    const response=await fetch(url+'/api/dashboard?paged=1&per_page=25&company_id=999',{headers:{Authorization:`Bearer ${token}`}});
    const body=await response.text();apiBytes+=Buffer.byteLength(body);if(!response.ok){apiErrors++;}else{
     const data=JSON.parse(body);if(data.machines.some(m=>machineMap.get(String(m.id)).company_id!==1+index%3))liveLeaks++;
    }
   }catch{apiErrors++;}samples.push(performance.now()-requested);apiRequests++;await wait(Math.max(0,1000-(performance.now()-requested)));}}));
   const publication=[];
   for(let round=0;round<rounds;round++){
    await wait(Math.max(0,at+round*1000-performance.now()));
    for(let id=1;id<=size;id++){
     const count=(counters.get(id)||100)+1;counters.set(id,count);born.set(`${id}:${count}`,performance.now());published++;
     publication.push(publisher.publishAsync(`machines/${id}/telemetry`,JSON.stringify({time:Math.floor(Date.now()/1000),machine_status:'RUN',parts_count:count}),{qos:1}));
    }
   }
   await Promise.all(publication);await viewers;
   const offeredEnd=performance.now(),target=published,until=Date.now()+90000;
   let stored=0;
   while(Date.now()<until){stored=Number((await pool.query('SELECT COALESCE(SUM(produced_qty),0)::INT AS n FROM production_hourly')).rows[0].n);
    if (flusher.stats().retries) throw Error('Fixture writer failed; inspect diagnostic above');
    const accepted=acceptedAt.length;if(accepted>=target&&journal.stats().pending===0)break;await wait(100);}
   assert.equal(acceptedAt.length,target,'Every broker publication must reach durable admission');
   assert.equal(journal.stats().pending,0,'Accepted journal must drain');
   const expectedLiveEvents=Math.min(size,100)*rounds;
   const liveDeadline=Date.now()+3000;
   while(liveEvents-liveBefore<expectedLiveEvents&&Date.now()<liveDeadline)await wait(10);
   assert.equal(liveEvents-liveBefore,expectedLiveEvents,'Each subscribed machine must reach its dashboard');
   assert.equal(apiErrors,0,'Every dashboard HTTP request must succeed');
   const duration=performance.now()-at;clearInterval(sampleTimer);samplers.delete(sampleTimer);lag.disable();
   results.push({machines:size,offered_hz_per_machine:1,messages:target-expectedBefore,offered_window_seconds:rounds,offer_and_viewer_duration_ms:Math.round(offeredEnd-at),end_to_end_drain_ms:Math.round(duration),
    durable_messages_per_second:+((target-expectedBefore)*1000/duration).toFixed(1),backlog_at_offer_end:target-startAccepted-(acceptedAt.filter(time=>time<=offeredEnd).length-startAccepted),
    concurrent_viewers:100,api_poll_ms:1000,api_requests:apiRequests,api_errors:apiErrors,api_p50_ms:quantile(samples,.5),api_p95_ms:quantile(samples,.95),api_bytes:apiBytes,
    publish_to_commit_p95_ms:quantile(committed.slice(commitBefore),.95),aggregate_database_query_p95_ms:quantile(queryTimes.slice(queryBefore),.95),fleet_handler_p95_ms:quantile(fleetTimes.slice(fleetBefore),.95),peak_pool_waiters:poolWaitPeak,live_events:liveEvents-liveBefore,expected_live_events:expectedLiveEvents,node_fixture_cpu_seconds:+((process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1e6).toFixed(2),node_fixture_peak_rss_mb:+(rssPeak/1024**2).toFixed(1),event_loop_p99_ms:+(lag.percentile(99)/1e6).toFixed(2),hourly_parts_to_date:stored});
   console.error('Completed machine tier:', size, 'messages:', target-expectedBefore, 'drain_ms:',Math.round(duration));
  }
  const rows=Number((await pool.query('SELECT count(*)::INT AS n FROM telemetry_raw')).rows[0].n);
  assert.equal(rows,historyRows+published);assert.equal(liveLeaks,0);assert.equal(failures,0);
  console.log(JSON.stringify({fixture:'local synthetic; actual MQTT+journal+SQL+JWT+Socket.IO; Redis fanout/cache represented in memory; no real controller or browser rendering',versions,history_rows:historyRows,history_seed_ms:historySeedMs,connected_sockets:clients.length,foreign_events_or_rows:liveLeaks,admission_failures:failures,raw_rows:rows,expected_raw_rows:historyRows+published,journal:journal.stats(),results},null,2));
 }finally{
  for(const timer of samplers)clearInterval(timer);
  await publisher?.endAsync(true).catch(()=>{});await receiver?.endAsync(true).catch(()=>{});
  await flusher?.stop();journal?.close();clients.forEach(client=>client.disconnect());
  if(io)await new Promise(resolve=>io.close(resolve));if(server?.listening)await new Promise(resolve=>server.close(resolve));
  if(broker){broker.kill('SIGTERM');await new Promise(resolve=>broker.exitCode!==null?resolve():broker.once('exit',resolve));}
  await pool?.end();if(postgresStarted)execFileSync(path.join(pgBin,'pg_ctl'),['-D',path.join(directory,'data'),'-m','immediate','-w','stop'],{stdio:'pipe'});
  fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
